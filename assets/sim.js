// Traffic Optimization Engine — simulation model (no DOM access).
//
// Each sender type has one MPS budget: the downstream egress shared by all
// of its carriers. Capacity is split hierarchically, work-conserving:
//
//   sender-type MPS ─► Traffic Shaping service levels (by SL weight; one group if off)
//                   ─► Multi-Tenancy tiers (by tier weight; one tier if None/Even)
//                   ─► subaccounts in the tier (even split; one shared FIFO if None)
//                   ─► egress to the message's destination carrier queue
//
// At every level, a node's share is its weight over the summed weights of the
// siblings that are currently *sending* (an active stream or messages waiting).
// The share does not depend on send rate: with SL weights 50/30/20 and SL1 +
// SL3 sending, SL1 is allocated 50/70 = 71.4% and SL3 20/70 = 28.6%, even if
// SL1 only sends 1 msg/s. A node that stops sending drops out and its share
// is split among the remaining senders; a lone sender gets 100%.
//
// Allocation is a guarantee, not a cap: capacity a sending node doesn't use
// (its queue ran dry) is lent to nodes that still have messages waiting —
// siblings first, then up the hierarchy — split by the same weights. So a
// node's egress can exceed its allocation while it borrows, and the sender
// type's egress stays at its full MPS while anything is queued.

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

// Split `capacity` across sending nodes {w, active} in proportion to weight;
// sets n.alloc (0 for nodes that aren't sending).
function weightedShare(nodes, capacity) {
  const W = nodes.reduce((sum, n) => sum + (n.active ? Math.max(n.w, 1e-6) : 0), 0);
  for (const n of nodes) n.alloc = n.active && W > 0 ? (capacity * Math.max(n.w, 1e-6)) / W : 0;
}

// Weighted max-min fair split of `capacity` across nodes {w, d}, never giving
// a node more than its demand d; sets n.extra. Whatever one node can't use is
// re-split among the others, which is how unused share gets lent.
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
    this.onDepart = null;

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
      carriers: Array.from({ length: CARRIER_COUNT }, () => ({ delivered: 0, rate: 0, tick: 0 })),
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

  serve(cq, dt) {
    for (const g of cq.groups) {
      g.active = false;
      for (const tier of g.tiers) {
        tier.active = false;
        for (const t of tier.tenants) {
          t.active = t.leaf.sending || t.leaf.q.length > 0;
          tier.active = tier.active || t.active;
        }
        g.active = g.active || tier.active;
      }
    }
    // 1. Allocation (what each node is guaranteed): weight over the summed
    //    weights of sending siblings. Independent of send rate; shown in the UI.
    const budget = cq.mps * dt;
    weightedShare(cq.groups, budget);
    for (const g of cq.groups) {
      weightedShare(g.tiers, g.alloc);
      for (const tier of g.tiers) {
        weightedShare(tier.tenants, tier.alloc);
        for (const t of tier.tenants) t.leaf.allocMps = t.alloc / dt;
      }
    }

    // 2a. Live egress readout (MPS): the same weighted split in rate space. A
    //     backlogged lane can take any amount; a lane that is keeping up only
    //     needs its current ingress. Recomputed every tick, so when a level
    //     stops sending its share moves to the others immediately.
    const tickDemand = t => Math.max(0, t.leaf.q.length - t.leaf.credit);
    for (const g of cq.groups) {
      g.d = 0;
      for (const tier of g.tiers) {
        tier.d = 0;
        for (const t of tier.tenants) {
          t.d = tickDemand(t) > t.leaf.inNow * dt + 1 ? Infinity : t.leaf.inNow;
          tier.d += t.d;
        }
        g.d += tier.d;
      }
    }
    waterfill(cq.groups, cq.mps);
    cq.outNow = 0;
    for (const g of cq.groups) {
      waterfill(g.tiers, g.extra);
      for (const tier of g.tiers) {
        waterfill(tier.tenants, tier.extra);
        for (const t of tier.tenants) { t.leaf.outNow = t.extra; cq.outNow += t.extra; }
      }
    }

    // 2b. Egress: the same weights applied to what is actually waiting, top
    //    down. A node that can't use its full share passes the rest to its
    //    siblings first (same tier, then same SL), then up the hierarchy.
    for (const g of cq.groups) {
      g.d = 0;
      for (const tier of g.tiers) {
        tier.d = 0;
        for (const t of tier.tenants) { t.d = tickDemand(t); tier.d += t.d; }
        g.d += tier.d;
      }
    }
    waterfill(cq.groups, budget);
    for (const g of cq.groups) {
      waterfill(g.tiers, g.extra);
      for (const tier of g.tiers) {
        waterfill(tier.tenants, tier.extra);
        for (const t of tier.tenants) t.served = this.drain(t.leaf, t.extra, cq);
      }
    }

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
    for (const c of cq.carriers) {
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
      this.deliver(leaf.q.shift(), cq, leaf);
      n++;
    }
    return n;
  }

  deliver(m, cq, leaf) {
    const wait = this.t - m.t0;
    this.queuedBySL[m.sl]--;
    this.latBySL[m.sl].push(wait);
    this.latBySub[m.sub].push(wait);
    cq.delivered++;
    cq.carriers[m.ci].delivered++;
    cq.carriers[m.ci].tick++;
    if (this.onDepart) this.onDepart(m, cq, leaf);
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
