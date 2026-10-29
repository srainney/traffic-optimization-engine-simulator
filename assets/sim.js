// Traffic Optimization Engine — simulation model (no DOM access).
//
// Each sender type has one MPS budget: the downstream egress shared by all
// of its carriers. Capacity is split hierarchically, work-conserving:
//
//   sender-type MPS ─► Traffic Shaping service levels (by SL weight; one group if off)
//                   ─► Multi-Tenancy tiers inside each level (by tier weight; one tier if None/Even)
//                   ─► the tier's subaccounts on that level (equal split; one shared FIFO if None)
//                   ─► egress to the message's destination carrier queue
//
// Each carrier has its own queue, drained at the carrier's own MPS limit
// (scaled down while the carrier is degraded, 0 during an outage). A carrier
// backing up never slows the sender-type queues or the other carriers.
//
// At every level, a node's share is its weight over the summed weights of the
// siblings that are currently *sending* (an active stream or messages waiting).
// With SL weights 50/30/20 and SL1 + SL3 both backlogged, SL1 gets
// 50/70 = 71.4% and SL3 20/70 = 28.6%; a lone sender gets 100%. Each level's
// share is then split between its tiers: with tiers 60/30/10 all sending on
// every level, SL1's 50 MPS gives Tier 1 30, Tier 2 15 and Tier 3 5.
//
// Nothing is reserved: capacity a node can't use (its queue ran dry) goes to
// nodes that still have messages waiting, siblings first, then up the
// hierarchy, split by the same weights. The sender type's egress stays at its
// full MPS while anything is queued.
//
// A lane's "alloc" is the maximum it could achieve at this moment: what it
// would get if it had unlimited messages waiting, given what every other lane
// is actually sending right now. It is never a guarantee; egress never exceeds it.

const SENDER_TYPES = [
  { id: 'shortcode', label: 'Short Code', defaultMps: 100 },
  { id: 'alpha', label: 'Alphanumeric', defaultMps: 30 },
  { id: 'longcode', label: 'Long Code', defaultMps: 20 },
];

const carrierName = i => `Carrier ${i + 1}`;

const CARRIER_COUNT = 3;
const TIER_COUNT = 3;

// Default MessageIntent → Service Level mapping, per Twilio docs.
const INTENTS = [
  { id: 'otp', sl: 1 },
  { id: 'notifications', sl: 1 },
  { id: 'fraud', sl: 1 },
  { id: 'security', sl: 1 },
  { id: 'customercare', sl: 2 },
  { id: 'delivery', sl: 2 },
  { id: 'education', sl: 2 },
  { id: 'events', sl: 2 },
  { id: 'polling', sl: 3 },
  { id: 'announcements', sl: 3 },
  { id: 'marketing', sl: 3 },
  { id: '', sl: 3, label: '(no intent)', fixed: true },
];

class Queue {
  constructor() { this.items = []; this.head = 0; }
  get length() { return this.items.length - this.head; }
  push(x) { this.items.push(x); }
  at(i) { return this.items[this.head + i]; }
  shift() {
    const x = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return x;
  }
}

// Weighted max-min fair split of `capacity` across nodes {w, d}, never giving
// a node more than its demand d; sets n.extra. Whatever one node can't use is
// re-split among the others, which is how unused capacity moves to busy lanes.
function waterfill(nodes, capacity) {
  for (const n of nodes) n.extra = 0;
  let remaining = capacity;
  let open = nodes.filter(n => n.d > 1e-9);
  while (remaining > 1e-9 && open.length) {
    const W = open.reduce((sum, n) => sum + Math.max(n.w, 1e-6), 0);
    let spent = 0;
    for (const n of open) {
      const give = Math.min((remaining * Math.max(n.w, 1e-6)) / W, n.d - n.extra);
      n.extra += give;
      spent += give;
    }
    remaining -= spent;
    open = open.filter(n => n.d - n.extra > 1e-9);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

function summarize(latencies) {
  const s = latencies.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    avg: s.length ? sum / s.length : 0,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    max: s.length ? s[s.length - 1] : 0,
  };
}

const RATE_TAU = 1; // seconds, smoothing for the (internal) measured rates

class Simulation {
  constructor(cfg) {
    this.cfg = cfg;
    this.t = 0;
    this.nextId = 0;
    this.onArrive = null;
    this.onDepart = null; // message left its lane for a carrier queue
    this.onDeliver = null; // carrier accepted the message
    this.inCarrier = 0;

    this.queues = [];
    this.byKey = {};
    for (const st of SENDER_TYPES) {
      const cq = this.buildSenderQueue(st.id);
      this.queues.push(cq);
      this.byKey[st.id] = cq;
    }

    this.streams = [];
    cfg.subaccounts.forEach((sa, si) => {
      for (const s of sa.streams) {
        const cq = this.byKey[s.senderType];
        const leaf = cq.leafOf[cfg.ts.enabled ? this.serviceLevelFor(s.intent) : 0][si];
        if (leaf) this.streams.push({ ...s, sub: si, acc: 0, cq, leaf });
      }
    });
    this.endOfTraffic = this.streams.reduce((m, s) => Math.max(m, s.start + s.duration), 0);

    this.queuedBySL = [0, 0, 0, 0];
    this.latBySL = [[], [], [], []];
    this.latBySub = cfg.subaccounts.map(() => []);
    this.sentBySub = cfg.subaccounts.map(() => 0);
    this.timeline = [];
    this.nextSample = 0;
    this.sample();
  }

  buildSenderQueue(stId) {
    const { cfg } = this;
    const cq = {
      stId, mps: cfg.senderTypes[stId].mps, groups: [], leafOf: {}, rate: 0, inRate: 0, tickIn: 0, inNow: 0, outNow: 0, delivered: 0,
      carriers: Array.from({ length: CARRIER_COUNT }, (_, ci) => ({
        ci, q: new Queue(), credit: 0, delivered: 0, rate: 0, tick: 0, inNow: 0, outNow: 0, limitNow: 0,
        ...(cfg.senderTypes[stId].carriers?.[ci] || {}),
      })),
    };
    const subs = cfg.subaccounts.map((_, i) => i).filter(i => (cfg.subaccounts[i].senderTypes || [stId]).includes(stId));
    const levels = cfg.ts.enabled ? [1, 2, 3] : [0];

    for (const sl of levels) {
      const makeTenant = sub => ({ sub, w: 1, leaf: { sl, q: new Queue(), credit: 0, rate: 0, inRate: 0, tickIn: 0, inNow: 0, outNow: 0, sending: false, allocMps: 0 } });
      let tiers;
      if (cfg.mt.mode === 'none') {
        tiers = [{ w: 1, idx: -1, tenants: [makeTenant(-1)] }];
      } else if (cfg.mt.mode === 'even') {
        tiers = [{ w: 1, idx: -1, tenants: subs.map(makeTenant) }];
      } else {
        tiers = cfg.mt.tiers
          .map((tier, ti) => ({ w: tier.weight, idx: ti, tenants: subs.filter(x => cfg.subaccounts[x].tier === ti).map(makeTenant) }))
          .filter(tier => tier.tenants.length);
      }
      const group = { sl, w: sl ? cfg.ts.weights[sl - 1] : 1, tiers, rate: 0 };
      cq.groups.push(group);
      const bySub = {};
      for (const tier of tiers) for (const t of tier.tenants) {
        if (t.sub === -1) for (const x of subs) bySub[x] = t.leaf;
        else bySub[t.sub] = t.leaf;
      }
      cq.leafOf[sl] = bySub;
    }
    return cq;
  }

  serviceLevelFor(intent) {
    if (!intent) return 3;
    return this.cfg.ts.mapping[intent] || 3;
  }

  // Traffic is spread evenly across the sender type's carriers.
  pickCarrier() {
    return Math.floor(Math.random() * CARRIER_COUNT);
  }

  emit(stream) {
    const ci = this.pickCarrier();
    const { cq, leaf } = stream;
    const sl = this.serviceLevelFor(stream.intent);
    const m = { id: this.nextId++, sub: stream.sub, intent: stream.intent, sl, ci, t0: this.t };
    leaf.q.push(m);
    leaf.tickIn++;
    cq.tickIn++;
    this.queuedBySL[sl]++;
    this.sentBySub[stream.sub]++;
    if (this.onArrive) this.onArrive(m, cq, leaf);
  }

  // Weighted split of `mps` across lanes, in rate space: Traffic Shaping
  // first (Service Levels by SL weight), then Multi-Tenancy inside each
  // level (tiers by tier weight; Even = one tier), then the tier's
  // subaccounts on that level, equally. demandOf(t) is the MPS a lane would
  // take this instant (Infinity if backlogged). Unused capacity at any step
  // is re-split among siblings that still want more. Returns a Map lane → MPS.
  rateSplit(cq, mps, demandOf) {
    for (const g of cq.groups) {
      g.d = 0;
      for (const tier of g.tiers) {
        tier.d = 0;
        for (const t of tier.tenants) { t.d = demandOf(t); tier.d += t.d; }
        g.d += tier.d;
      }
    }
    const out = new Map();
    waterfill(cq.groups, mps);
    for (const g of cq.groups) {
      waterfill(g.tiers, g.extra);
      for (const tier of g.tiers) {
        waterfill(tier.tenants, tier.extra);
        for (const t of tier.tenants) out.set(t, t.extra);
      }
    }
    return out;
  }

  serve(cq, dt) {
    const budget = cq.mps * dt;
    const tickDemand = t => Math.max(0, t.leaf.q.length - t.leaf.credit);
    const lanes = cq.groups.flatMap(g => g.tiers.flatMap(tier => tier.tenants));

    // 1. Live egress readout (MPS). A backlogged lane can take any amount; a
    //    lane that is keeping up only needs its current ingress. Recomputed
    //    every tick, so when a level stops sending its share moves at once.
    const nowDemand = t => (tickDemand(t) > t.leaf.inNow * dt + 1 ? Infinity : t.leaf.inNow);
    const now = this.rateSplit(cq, cq.mps, nowDemand);
    cq.outNow = 0;
    for (const t of lanes) { t.leaf.outNow = now.get(t); cq.outNow += t.leaf.outNow; }
    for (const c of cq.carriers) c.inNow = cq.outNow / cq.carriers.length;

    // 2. Alloc: the most each sending lane could achieve right now, i.e. its
    //    split if it alone had unlimited demand and everyone else kept
    //    sending as they are.
    for (const t of lanes) {
      const sending = t.leaf.sending || t.leaf.q.length > 0;
      if (!sending) { t.leaf.allocMps = 0; continue; }
      if (nowDemand(t) === Infinity) { t.leaf.allocMps = t.leaf.outNow; continue; }
      t.leaf.allocMps = this.rateSplit(cq, cq.mps, x => (x === t ? Infinity : nowDemand(x))).get(t);
    }

    // 3. Egress: the same weights applied to what is actually waiting, top
    //    down. A node that can't use its full share passes the rest to its
    //    siblings first (same tier on the level, then same level), then up the hierarchy.
    const grant = this.rateSplit(cq, budget, tickDemand);
    for (const t of lanes) t.served = this.drain(t.leaf, grant.get(t), cq);

    let cqServed = 0;
    for (const g of cq.groups) {
      let gServed = 0;
      for (const tier of g.tiers) {
        for (const t of tier.tenants) {
          const { leaf } = t;
          if (!leaf.q.length) leaf.credit = 0;
          leaf.rate += (t.served / dt - leaf.rate) * (dt / RATE_TAU);
          leaf.inRate += (leaf.tickIn / dt - leaf.inRate) * (dt / RATE_TAU);
          leaf.tickIn = 0;
          gServed += t.served;
        }
      }
      g.rate += (gServed / dt - g.rate) * (dt / RATE_TAU);
      cqServed += gServed;
    }
    cq.rate += (cqServed / dt - cq.rate) * (dt / RATE_TAU);
    cq.inRate += (cq.tickIn / dt - cq.inRate) * (dt / RATE_TAU);
    cq.tickIn = 0;
    // Carrier queues drain independently at their own (status-adjusted) limit.
    for (const c of cq.carriers) {
      c.limitNow = this.carrierLimit(cq, c);
      c.credit += c.limitNow * dt;
      let n = 0;
      while (c.credit >= 1 - 1e-9 && c.q.length) {
        c.credit -= 1;
        this.deliver(c.q.shift(), cq, c);
        n++;
      }
      if (!c.q.length) c.credit = 0;
      c.outNow = c.q.length ? c.limitNow : Math.min(c.limitNow, c.inNow);
      c.rate += (c.tick / dt - c.rate) * (dt / RATE_TAU);
      c.tick = 0;
    }
  }

  // Deliver up to `amount` messages' worth of capacity from a lane; fractional
  // capacity carries over as credit. Returns messages delivered.
  drain(leaf, amount, cq) {
    leaf.credit += amount;
    let n = 0;
    while (leaf.credit >= 1 - 1e-9 && leaf.q.length) {
      leaf.credit -= 1;
      this.toCarrier(leaf.q.shift(), cq, leaf);
      n++;
    }
    return n;
  }

  // A carrier's MPS right now: its limit, scaled by its status during the
  // incident window (degraded = pct% of limit, outage = 0).
  carrierLimit(cq, c) {
    const limit = c.mps ?? cq.mps;
    const inWindow = this.t >= (c.from ?? 0) && this.t < (c.to ?? Infinity);
    if (!inWindow || !c.status || c.status === 'healthy') return limit;
    if (c.status === 'outage') return 0;
    return (limit * (c.pct ?? 20)) / 100;
  }

  // Message leaves its Service Level / tier lane and joins its carrier's queue.
  toCarrier(m, cq, leaf) {
    const c = cq.carriers[m.ci];
    c.q.push(m);
    this.inCarrier++;
    if (this.onDepart) this.onDepart(m, cq, leaf);
  }

  // Carrier accepts the message: it's delivered. Wait includes carrier queueing.
  deliver(m, cq, c) {
    const wait = this.t - m.t0;
    this.queuedBySL[m.sl]--;
    this.inCarrier--;
    this.latBySL[m.sl].push(wait);
    this.latBySub[m.sub].push(wait);
    cq.delivered++;
    c.delivered++;
    c.tick++;
    if (this.onDeliver) this.onDeliver(m, cq, c);
  }

  step(dt) {
    for (const s of this.streams) { s.leaf.sending = false; s.leaf.inNow = 0; s.cq.inNow = 0; }
    for (const s of this.streams) {
      if (this.t >= s.start && this.t < s.start + s.duration && s.rate > 0) {
        s.leaf.sending = true;
        s.leaf.inNow += s.rate;
        s.cq.inNow += s.rate;
        s.acc += s.rate * dt;
        while (s.acc >= 1) { s.acc -= 1; this.emit(s); }
      }
    }
    this.t += dt;
    for (const cq of this.queues) this.serve(cq, dt);
    if (this.t >= this.nextSample) this.sample();
  }

  sample() {
    this.timeline.push({ t: this.t, q: this.queuedBySL.slice(1) });
    this.nextSample += 0.25;
  }

  get totalQueued() { return this.queuedBySL[1] + this.queuedBySL[2] + this.queuedBySL[3]; }

  get done() { return this.t >= this.endOfTraffic && this.totalQueued === 0; }

  summary() {
    return {
      bySL: [1, 2, 3].map(sl => summarize(this.latBySL[sl])),
      bySub: this.latBySub.map(summarize),
    };
  }
}
