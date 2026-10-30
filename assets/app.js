// Traffic Optimization Engine — UI, animation and charts.

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const fmtInt = x => Math.round(x).toLocaleString();
const SL_NAMES = ['FIFO', 'Service Level 1', 'Service Level 2', 'Service Level 3'];
const SL_SHAPES = ['', '●', '■', '▲'];

// ---------------------------------------------------------------- state

// Even Multi-Tenancy plots one line per subaccount (up to 6). Sky blue is left
// out because it's too close to purple-blue in one chart; F uses a light
// neutral. D, E and F are also dashed so no subaccount relies on color alone.
const SUB_COLORS = ['var(--tier-1)', 'var(--tier-2)', 'var(--tier-3)', 'var(--series-2)', 'var(--series-3)', 'var(--sub-6)'];
const SUB_DASH = [null, null, null, '6 3', '2 3', '9 3 2 3'];
const MAX_SUBACCOUNTS = SUB_COLORS.length;
const subLetter = i => String.fromCharCode(65 + i);

const defaultCarrier = () => ({ status: 'healthy', from: 0, to: null });

function defaultCarriers() {
  const out = {};
  for (const st of SENDER_TYPES) {
    out[st.id] = { mps: st.defaultMps, carriers: Array.from({ length: CARRIER_COUNT }, defaultCarrier) };
  }
  return out;
}

// Older saved presets have no per-carrier settings; fill them in.
function withCarriers(senderTypes) {
  const out = { ...defaultCarriers(), ...senderTypes };
  for (const st of SENDER_TYPES) {
    const cfg = out[st.id];
    cfg.carriers = Array.from({ length: CARRIER_COUNT }, (_, i) => {
      const { status, from, to } = { ...defaultCarrier(), ...(cfg.carriers?.[i] || {}) };
      return { status, from, to };
    });
  }
  return out;
}

function defaultMapping() {
  const m = {};
  for (const i of INTENTS) if (!i.fixed) m[i.id] = i.sl;
  return m;
}

const PRESETS = {
  blast: {
    label: 'Marketing blast + OTP burst',
    subaccounts: [
      { name: 'Bank Alerts', tier: 0, senderTypes: ['shortcode', 'longcode'] },
      { name: 'Retail Promo', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Support Desk', tier: 2, senderTypes: ['shortcode', 'longcode'] },
    ],
    streams: [
      { sub: 1, senderType: 'shortcode', intent: 'marketing', rate: 320, start: 0, duration: 15 },
      { sub: 2, senderType: 'shortcode', intent: 'customercare', rate: 40, start: 2, duration: 12 },
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 60, start: 4, duration: 8 },
      { sub: 2, senderType: 'longcode', intent: 'customercare', rate: 15, start: 0, duration: 12 },
      { sub: 0, senderType: 'longcode', intent: 'fraud', rate: 10, start: 5, duration: 6 },
    ],
  },
  neighbor: {
    label: 'Noisy neighbor subaccount',
    subaccounts: [
      { name: 'Tenant A', tier: 0, senderTypes: ['longcode'] },
      { name: 'Tenant B', tier: 1, senderTypes: ['longcode'] },
      { name: 'Tenant C (noisy)', tier: 2, senderTypes: ['longcode'] },
    ],
    streams: [
      { sub: 2, senderType: 'longcode', intent: 'announcements', rate: 80, start: 0, duration: 12 },
      { sub: 0, senderType: 'longcode', intent: 'notifications', rate: 8, start: 2, duration: 10 },
      { sub: 1, senderType: 'longcode', intent: 'delivery', rate: 8, start: 2, duration: 10 },
    ],
  },
  mixed: {
    label: 'Mixed sender types',
    subaccounts: [
      { name: 'Auth Service', tier: 0, senderTypes: ['shortcode', 'alpha'] },
      { name: 'Logistics', tier: 1, senderTypes: ['alpha', 'longcode'] },
      { name: 'Growth', tier: 2, senderTypes: ['shortcode'] },
    ],
    streams: [
      { sub: 2, senderType: 'shortcode', intent: 'marketing', rate: 250, start: 0, duration: 12 },
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 50, start: 3, duration: 8 },
      { sub: 1, senderType: 'alpha', intent: 'delivery', rate: 60, start: 0, duration: 12 },
      { sub: 0, senderType: 'alpha', intent: 'security', rate: 20, start: 4, duration: 6 },
      { sub: 1, senderType: 'longcode', intent: 'delivery', rate: 30, start: 0, duration: 10 },
    ],
  },
  grid9: {
    label: '9 queues: 3 tiers × 3 Service Levels (steady)',
    ts: 'weighted', mt: 'weighted',
    subaccounts: [
      { name: 'Bank', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Retailer', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Startup', tier: 2, senderTypes: ['shortcode'] },
    ],
    streams: [
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 45, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'delivery', rate: 27, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'marketing', rate: 18, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'notifications', rate: 23, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'customercare', rate: 14, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'announcements', rate: 9, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'security', rate: 8, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'events', rate: 5, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'polling', rate: 3, start: 0, duration: 20 },
    ],
  },
  grid9waves: {
    label: '9 queues: tiers and levels starting and stopping in waves',
    ts: 'weighted', mt: 'weighted',
    subaccounts: [
      { name: 'Bank', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Retailer', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Startup', tier: 2, senderTypes: ['shortcode'] },
    ],
    streams: [
      // 0–30 s: SL 3 marketing from every tier (the baseline load)
      { sub: 0, senderType: 'shortcode', intent: 'marketing', rate: 45, start: 0, duration: 30 },
      { sub: 1, senderType: 'shortcode', intent: 'announcements', rate: 25, start: 0, duration: 30 },
      { sub: 2, senderType: 'shortcode', intent: 'polling', rate: 12, start: 0, duration: 30 },
      // 5–20 s: SL 2 joins, staggered by tier
      { sub: 0, senderType: 'shortcode', intent: 'delivery', rate: 40, start: 5, duration: 15 },
      { sub: 1, senderType: 'shortcode', intent: 'customercare', rate: 25, start: 7, duration: 11 },
      { sub: 2, senderType: 'shortcode', intent: 'events', rate: 10, start: 9, duration: 7 },
      // 12–16 s: short SL 1 bursts from every tier
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 60, start: 12, duration: 4 },
      { sub: 1, senderType: 'shortcode', intent: 'notifications', rate: 35, start: 12.5, duration: 3 },
      { sub: 2, senderType: 'shortcode', intent: 'security', rate: 15, start: 13, duration: 2 },
    ],
  },
  sharedTiers: {
    label: 'Shared tiers: 5 subaccounts, 2 per tier, all Service Levels',
    ts: 'weighted', mt: 'weighted',
    subaccounts: [
      { name: 'Bank East', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Bank West', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Retail US', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Retail EU', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Startup', tier: 2, senderTypes: ['shortcode'] },
    ],
    streams: [
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 22, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'fraud', rate: 22, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'notifications', rate: 12, start: 0, duration: 20 },
      { sub: 3, senderType: 'shortcode', intent: 'notifications', rate: 12, start: 0, duration: 20 },
      { sub: 4, senderType: 'shortcode', intent: 'security', rate: 8, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'delivery', rate: 12, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'delivery', rate: 12, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'customercare', rate: 8, start: 0, duration: 20 },
      { sub: 3, senderType: 'shortcode', intent: 'customercare', rate: 8, start: 0, duration: 20 },
      { sub: 4, senderType: 'shortcode', intent: 'events', rate: 6, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'marketing', rate: 10, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'marketing', rate: 10, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'announcements', rate: 8, start: 0, duration: 20 },
      { sub: 3, senderType: 'shortcode', intent: 'announcements', rate: 8, start: 0, duration: 20 },
      { sub: 4, senderType: 'shortcode', intent: 'polling', rate: 4, start: 0, duration: 20 },
    ],
  },
  carrierOutage: {
    label: 'Carrier outage: Carrier 2 down 6–14 s, 9 queues',
    ts: 'weighted', mt: 'weighted',
    carriers: { shortcode: [{}, { status: 'outage', from: 6, to: 14 }, {}] },
    subaccounts: [
      { name: 'Bank', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Retailer', tier: 1, senderTypes: ['shortcode'] },
      { name: 'Startup', tier: 2, senderTypes: ['shortcode'] },
    ],
    streams: [
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 38, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'delivery', rate: 23, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'marketing', rate: 15, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'notifications', rate: 19, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'customercare', rate: 12, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'announcements', rate: 8, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'security', rate: 7, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'events', rate: 4, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'polling', rate: 3, start: 0, duration: 20 },
    ],
  },
  evenGrid: {
    label: 'Even Multi-Tenancy: 3 subaccounts × 3 Service Levels',
    ts: 'weighted', mt: 'even',
    subaccounts: [
      { name: 'Subaccount 1', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Subaccount 2', tier: 0, senderTypes: ['shortcode'] },
      { name: 'Subaccount 3', tier: 0, senderTypes: ['shortcode'] },
    ],
    streams: [
      { sub: 0, senderType: 'shortcode', intent: 'otp', rate: 30, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'otp', rate: 30, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'delivery', rate: 15, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'delivery', rate: 15, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'delivery', rate: 15, start: 0, duration: 20 },
      { sub: 0, senderType: 'shortcode', intent: 'marketing', rate: 15, start: 0, duration: 20 },
      { sub: 1, senderType: 'shortcode', intent: 'marketing', rate: 15, start: 0, duration: 20 },
      { sub: 2, senderType: 'shortcode', intent: 'marketing', rate: 12, start: 6, duration: 8 },
    ],
  },
};

const state = {
  preset: 'blast',
  ts: { mode: 'none', weights: [50, 30, 20], mapping: defaultMapping() },
  mt: { mode: 'none', tiers: [{ weight: 60 }, { weight: 30 }, { weight: 10 }] },
  subaccounts: [],
  senderTypes: defaultCarriers(),
  streams: [],
  stTab: 'shortcode',
};

// Saved presets live in localStorage as { [id]: { label, config } }, where
// config is a full snapshot of the scenario (unlike the built-ins, which only
// carry subaccounts and streams).
const USER_PRESETS_KEY = 'toe-sim-presets-v1';
const clone = x => JSON.parse(JSON.stringify(x));
const isUserPreset = key => key.startsWith('user:');

function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(USER_PRESETS_KEY)) || {}; } catch { return {}; }
}

function saveUserPresets(presets) {
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
}

function snapshot() {
  return clone({ ts: state.ts, mt: state.mt, subaccounts: state.subaccounts, senderTypes: state.senderTypes, streams: state.streams });
}

function applyPreset(key) {
  state.preset = key;
  if (isUserPreset(key)) {
    const c = clone(loadUserPresets()[key].config);
    state.ts = { ...c.ts, mapping: { ...defaultMapping(), ...c.ts.mapping } };
    state.mt = { ...c.mt, tiers: Array.from({ length: TIER_COUNT }, (_, i) => c.mt.tiers[i] || { weight: 10 }) };
    state.subaccounts = c.subaccounts.slice(0, MAX_SUBACCOUNTS);
    c.streams = c.streams.filter(st => st.sub < MAX_SUBACCOUNTS);
    state.senderTypes = withCarriers(c.senderTypes);
    state.streams = c.streams.filter(st => state.senderTypes[st.senderType]);
  } else {
    const p = PRESETS[key];
    state.ts = { mode: p.ts || 'none', weights: [50, 30, 20], mapping: defaultMapping() };
    state.mt = { mode: p.mt || 'none', tiers: [{ weight: 60 }, { weight: 30 }, { weight: 10 }] };
    state.senderTypes = defaultCarriers();
    for (const [stId, list] of Object.entries(p.carriers || {})) {
      list.forEach((c, i) => Object.assign(state.senderTypes[stId].carriers[i], c));
    }
    state.subaccounts = p.subaccounts.map(s => ({ ...s, senderTypes: s.senderTypes.slice() }));
    state.streams = p.streams.map(s => ({ ...s }));
  }
  state.stTab = state.streams[0]?.senderType || 'shortcode';
}

function renderPresetSelect() {
  const user = Object.entries(loadUserPresets()).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const opt = (k, label) => el('option', { value: k, selected: k === state.preset }, label);
  const groups = [el('optgroup', { label: 'Built-in' }, Object.entries(PRESETS).map(([k, p]) => opt(k, p.label)))];
  if (user.length) groups.push(el('optgroup', { label: 'Saved' }, user.map(([k, p]) => opt(k, p.label))));
  $('#preset').replaceChildren(...groups);
  const mine = isUserPreset(state.preset);
  $('#preset-update').disabled = !mine;
  $('#preset-delete').disabled = !mine;
}

// ---------------------------------------------------------------- controls

function numInput(value, onChange, { min = 0, max, step = 1 } = {}) {
  return el('input', {
    type: 'number', value, min, max, step,
    oninput: e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, v)); },
  });
}

function select(options, value, onChange) {
  const s = el('select', { onchange: e => onChange(e.target.value) });
  for (const [v, label] of options) s.append(el('option', { value: v, selected: String(v) === String(value) }, label));
  return s;
}

function setSeg(container, mode) {
  for (const b of container.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  }
}

function pctOf(values, i) {
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  return sum > 0 ? (100 * Math.max(0, values[i])) / sum : 0;
}

function renderTrafficShaping() {
  setSeg($('#ts-mode'), state.ts.mode);
  const on = state.ts.mode === 'weighted';
  $('#ts-hint').innerHTML = on
    ? 'Each message gets a Service Level from its <code>MessageIntent</code>. Traffic Shaping applies <b>first</b>: the levels with messages waiting split the sender type\'s throughput by weight, so SL1 + SL3 at 50/30/20 gives 71.4 / 28.6. Multi-Tenancy then splits each level\'s share between subaccounts. Throughput a level isn\'t using goes to the levels that still have messages waiting.'
    : 'All messages share one first-in, first-out queue per sender type, whatever their <code>MessageIntent</code>. Messages are still colored by the Service Level they <i>would</i> get.';

  const box = $('#ts-weights');
  box.replaceChildren();
  box.hidden = !on;
  const refreshPct = () => box.querySelectorAll('.pct').forEach((p, i) => { p.textContent = `${fmt(pctOf(state.ts.weights, i), 0)}%`; });
  [0, 1, 2].forEach(i => {
    const range = el('input', { type: 'range', min: 0, max: 100, value: state.ts.weights[i] });
    const num = numInput(state.ts.weights[i], v => { state.ts.weights[i] = v; range.value = v; refreshPct(); }, { max: 100 });
    range.addEventListener('input', () => { state.ts.weights[i] = +range.value; num.value = range.value; refreshPct(); });
    box.append(el('div', { class: 'weight-row' },
      el('span', { class: 'swatch', style: `background: var(--series-${i + 1})` }),
      el('span', {}, `SL ${i + 1} ${SL_SHAPES[i + 1]}`), range, num, el('span', { class: 'pct' })));
  });
  refreshPct();

  const map = $('#ts-mapping');
  map.replaceChildren();
  for (const it of INTENTS) {
    map.append(el('code', {}, it.label || it.id));
    map.append(it.fixed
      ? el('span', { class: 'hint', style: 'margin:0' }, 'SL 3')
      : select([[1, 'SL 1'], [2, 'SL 2'], [3, 'SL 3']], state.ts.mapping[it.id], v => { state.ts.mapping[it.id] = +v; renderStreams(); }));
  }
}

function renderMultiTenancy() {
  setSeg($('#mt-mode'), state.mt.mode);
  const hints = {
    none: 'Within each Service Level, all subaccounts share one first-in, first-out queue, so a high-volume subaccount can crowd out the others.',
    even: 'Applied after Traffic Shaping: within each Service Level, the subaccounts sending on that level split its throughput equally.',
    weighted: 'Applied after Traffic Shaping: within each Service Level, the tiers sending on that level split its throughput by tier weight, and the tier\'s subaccounts on that level share the tier\'s portion equally. With tiers at 60/30/10 all sending, SL1\'s 50 MPS (at 50/30/20) gives Tier 1 30, Tier 2 15 and Tier 3 5.',
  };
  $('#mt-hint').textContent = hints[state.mt.mode];

  const tiersBox = $('#mt-tiers');
  tiersBox.replaceChildren();
  const weighted = state.mt.mode === 'weighted';
  if (weighted) {
    const refreshPct = () => tiersBox.querySelectorAll('.pct').forEach((p, i) => { p.textContent = `${fmt(pctOf(state.mt.tiers.map(t => t.weight), i), 0)}%`; });
    state.mt.tiers.forEach((tier, i) => {
      const range = el('input', { type: 'range', min: 0, max: 100, value: tier.weight });
      const num = numInput(tier.weight, v => { tier.weight = v; range.value = v; refreshPct(); }, { max: 100 });
      range.addEventListener('input', () => { tier.weight = +range.value; num.value = range.value; refreshPct(); });
      tiersBox.append(el('div', { class: 'tier-row' }, el('span', {}, `Tier ${i + 1}`), range, num, el('span', { class: 'pct' })));
    });
    refreshPct();
  }

  const subs = $('#subaccounts');
  subs.replaceChildren();
  const full = state.subaccounts.length >= MAX_SUBACCOUNTS;
  $('#add-sub').disabled = full;
  $('#add-sub').textContent = full ? `Maximum of ${MAX_SUBACCOUNTS} subaccounts` : '+ Add subaccount';
  state.subaccounts.forEach((sa, i) => {
    const row = el('div', { class: `sub-row${weighted ? '' : ' no-tier'}` },
      el('span', { class: 'shape' }, String.fromCharCode(65 + i)),
      el('input', { type: 'text', value: sa.name, 'aria-label': 'Subaccount name', oninput: e => { sa.name = e.target.value; renderStreams(); } }));
    if (weighted) {
      row.append(select(state.mt.tiers.map((_, ti) => [ti, `Tier ${ti + 1}`]), sa.tier, v => { sa.tier = +v; }));
    }
    row.append(el('button', {
      type: 'button', class: 'icon-btn', title: 'Remove subaccount', disabled: state.subaccounts.length <= 1,
      onclick: () => {
        state.subaccounts.splice(i, 1);
        state.streams = state.streams.filter(s => s.sub !== i).map(s => ({ ...s, sub: s.sub > i ? s.sub - 1 : s.sub }));
        renderMultiTenancy(); renderStreams();
      },
    }, '×'));
    const chips = el('div', { class: 'chips' }, SENDER_TYPES.map(st => {
      const on = sa.senderTypes.includes(st.id);
      return el('label', { class: `chip${on ? ' on' : ''}` },
        el('input', {
          type: 'checkbox', checked: on,
          onchange: e => {
            if (e.target.checked) sa.senderTypes.push(st.id);
            else if (sa.senderTypes.length > 1) {
              sa.senderTypes = sa.senderTypes.filter(x => x !== st.id);
              const fallback = SENDER_TYPES.find(t => sa.senderTypes.includes(t.id)).id;
              for (const str of state.streams) if (str.sub === i && str.senderType === st.id) str.senderType = fallback;
            }
            renderMultiTenancy(); renderStreams(); renderCarriers();
          },
        }), st.label, st.note ? el('span', { class: 'chip-note', title: `Long Code ${st.note}` }, '*') : null);
    }));
    subs.append(el('div', { class: 'sub-block' }, row, chips));
  });
}

function renderCarriers() {
  const tabs = $('#st-tabs');
  tabs.replaceChildren();
  const used = new Set(state.streams.map(s => s.senderType));
  for (const st of SENDER_TYPES) {
    tabs.append(el('button', {
      type: 'button', class: st.id === state.stTab ? 'on' : '', title: used.has(st.id) ? 'Has traffic' : '',
      onclick: () => { state.stTab = st.id; renderCarriers(); },
    }, st.label, used.has(st.id) ? el('span', { class: 'dot' }) : null));
  }

  const cfg = state.senderTypes[state.stTab];
  const stDef = SENDER_TYPES.find(s => s.id === state.stTab);
  const label = stDef.label;
  const field = el('label', {}, `${label} egress MPS`, numInput(cfg.mps, v => { cfg.mps = v; }, { min: 0, step: 1 }));
  const cards = cfg.carriers.map((c, i) => {
    const status = select([['healthy', '✓ Healthy'], ['degraded', '▲ Degraded'], ['outage', '✕ Outage']], c.status, v => { c.status = v; renderCarriers(); });
    const card = el('div', { class: `carrier-card ${c.status}` },
      el('div', { class: 'carrier-card-head' }, el('b', {}, carrierName(i)), status));
    if (c.status !== 'healthy') {
      const row = el('div', { class: 'carrier-incident' });
      row.append(
        el('label', {}, 'From (s)', numInput(c.from, v => { c.from = v; }, { min: 0, step: 0.5 })),
        el('label', {}, 'Until (s)', el('input', {
          type: 'number', min: 0, step: 0.5, value: c.to ?? '', placeholder: 'end',
          oninput: e => { const v = parseFloat(e.target.value); c.to = Number.isFinite(v) ? v : null; },
        })));
      card.append(row);
    }
    return card;
  });
  $('#carriers').replaceChildren(field,
    stDef.note ? el('p', { class: 'hint st-note' }, `${label} ${stDef.note}. US and Canada A2P 10DLC traffic isn't part of Traffic Shaping or Multi-Tenancy.`) : null,
    el('p', { class: 'hint' }, 'Each carrier has its own queue, drained at the carrier\'s own rate. The customer\'s MPS, Traffic Shaping and Multi-Tenancy don\'t change carrier rates. A degraded carrier (slowed) or an outage (stopped) only backs up that carrier\'s queue; the other carriers and the Service Level / tier queues keep moving.'),
    ...cards);
}

function renderStreams() {
  const box = $('#streams');
  box.replaceChildren();
  state.streams.forEach((s, i) => {
    const sl = s.intent ? state.ts.mapping[s.intent] || 3 : 3;
    const tag = el('div', { class: 'sl-tag' },
      el('span', { class: 'swatch', style: `background: var(--series-${sl})` }),
      `${SL_SHAPES[sl]} ${SL_NAMES[sl]}${state.ts.mode === 'weighted' ? '' : ' (ignored: Traffic Shaping is off)'}`);
    box.append(el('div', { class: 'stream' },
      el('button', { type: 'button', class: 'icon-btn x', title: 'Remove stream', onclick: () => { state.streams.splice(i, 1); renderStreams(); renderCarriers(); } }, '×'),
      el('label', {}, 'Subaccount', select(state.subaccounts.map((sa, si) => [si, `${String.fromCharCode(65 + si)} · ${sa.name}`]), s.sub, v => {
        s.sub = +v;
        const allowed = state.subaccounts[s.sub].senderTypes;
        if (!allowed.includes(s.senderType)) s.senderType = SENDER_TYPES.find(t => allowed.includes(t.id)).id;
        renderStreams(); renderCarriers();
      })),
      el('label', {}, 'Sender type', select(SENDER_TYPES.filter(st => state.subaccounts[s.sub].senderTypes.includes(st.id)).map(st => [st.id, st.note ? `${st.label} (${st.note})` : st.label]), s.senderType, v => { s.senderType = v; state.stTab = v; renderCarriers(); })),
      el('label', {}, 'MessageIntent', select(INTENTS.map(it => [it.id, it.label || it.id]), s.intent, v => { s.intent = v; renderStreams(); })),
      el('label', {}, 'Rate (msg/s)', numInput(s.rate, v => { s.rate = v; }, { min: 0 })),
      el('label', {}, 'Start (s)', numInput(s.start, v => { s.start = v; }, { min: 0, step: 0.5 })),
      el('label', {}, 'Duration (s)', numInput(s.duration, v => { s.duration = v; }, { min: 0, step: 0.5 })),
      tag));
  });
}

function renderAll() {
  renderPresetSelect();
  renderTrafficShaping();
  renderMultiTenancy();
  renderCarriers();
  renderStreams();
  renderLegend();
}

function renderLegend() {
  const items = [1, 2, 3].map(sl => el('span', { class: 'item' },
    el('span', { class: 'swatch', style: `background: var(--series-${sl})` }),
    `${SL_SHAPES[sl]} SL ${sl}: ${INTENTS.filter(i => !i.fixed && state.ts.mapping[i.id] === sl).map(i => i.id).join(', ') || '–'}${sl === 3 ? ', (none)' : ''}`));
  $('#legend').replaceChildren(...items, el('span', { class: 'sep' }),
    el('span', { class: 'item' }, 'Lane = queue · head of queue on the right · dot = message, colored by priority · in = messages arriving per second, out = MPS leaving the queue, alloc = the most MPS the queue could reach right now'));
}

$('#preset').addEventListener('change', e => { applyPreset(e.target.value); renderAll(); renderResults(); });
$('#preset-save').addEventListener('click', () => {
  const label = prompt('Name for this preset:', isUserPreset(state.preset) ? `${loadUserPresets()[state.preset].label} copy` : '')?.trim();
  if (!label) return;
  const presets = loadUserPresets();
  const existing = Object.keys(presets).find(k => presets[k].label === label);
  if (existing && !confirm(`A preset named "${label}" already exists. Replace it?`)) return;
  const key = existing || `user:${Date.now().toString(36)}`;
  presets[key] = { label, config: snapshot() };
  saveUserPresets(presets);
  state.preset = key;
  renderPresetSelect();
});
$('#preset-update').addEventListener('click', () => {
  const presets = loadUserPresets();
  if (!presets[state.preset]) return;
  presets[state.preset].config = snapshot();
  saveUserPresets(presets);
  const b = $('#preset-update');
  b.textContent = 'Saved ✓';
  setTimeout(() => { b.textContent = 'Update'; }, 1200);
});
$('#preset-delete').addEventListener('click', () => {
  const presets = loadUserPresets();
  if (!presets[state.preset] || !confirm(`Delete preset "${presets[state.preset].label}"?`)) return;
  delete presets[state.preset];
  saveUserPresets(presets);
  applyPreset(Object.keys(PRESETS)[0]);
  renderAll();
});
$('#ts-mode').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode; if (!m) return;
  state.ts.mode = m; renderTrafficShaping(); renderStreams(); renderResults();
});
$('#mt-mode').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode; if (!m) return;
  state.mt.mode = m; renderMultiTenancy(); renderResults();
});
$('#add-sub').addEventListener('click', () => {
  if (state.subaccounts.length >= MAX_SUBACCOUNTS) return;
  state.subaccounts.push({ name: `Subaccount ${state.subaccounts.length + 1}`, tier: TIER_COUNT - 1, senderTypes: ['shortcode'] });
  renderMultiTenancy(); renderStreams();
});
$('#add-stream').addEventListener('click', () => {
  const allowed = state.subaccounts[0].senderTypes;
  const senderType = allowed.includes(state.stTab) ? state.stTab : allowed[0];
  state.streams.push({ sub: 0, senderType, intent: 'otp', rate: 20, start: 0, duration: 10 });
  renderStreams(); renderCarriers();
});

// ---------------------------------------------------------------- simulation lifecycle

let sim = null;
let running = false;
let lastFrame = 0;
let flying = [];
let lastChart = 0;
const SUBSTEP = 0.02;

function buildConfig() {
  return {
    ts: { enabled: state.ts.mode === 'weighted', weights: state.ts.weights.slice(), mapping: { ...state.ts.mapping } },
    mt: { mode: state.mt.mode, tiers: state.mt.tiers.map(t => ({ weight: t.weight })) },
    subaccounts: state.subaccounts.map(s => ({ ...s, streams: state.streams.filter(st => state.subaccounts[st.sub] === s) })),
    senderTypes: JSON.parse(JSON.stringify(state.senderTypes)),
  };
}

function startSim() {
  sim = new Simulation(buildConfig());
  sim.onDepart = (m, cq) => {
    if (m.x == null) return;
    const boxes = layout.carrierBox.get(cq);
    if (!boxes || flying.length > 600) return;
    const g = boxes[m.ci];
    // Land at the current tail of that carrier's queue (head is on the right).
    const depth = Math.min(cq.carriers[m.ci].q.length, Math.floor((g.qx1 - g.qx0) / 7));
    flying.push({ sl: m.sl, x0: layout.laneEnd, y0: m.y, x1: g.qx1 - 4 - depth * 7, y1: g.y + g.h - 10, t: 0 });
  };
  flying = [];
  $('#stage-empty').hidden = true;
  $('#config').disabled = true;
  computeLayout();
}

function setRunning(r) {
  running = r;
  const b = $('#btn-start');
  if (running) b.textContent = '❚❚ Pause';
  else if (sim && sim.done) b.textContent = '▶ Run again';
  else if (sim) b.textContent = '▶ Resume';
  else b.textContent = '▶ Start simulation';
  if (running) { lastFrame = performance.now(); requestAnimationFrame(frame); }
}

$('#btn-start').addEventListener('click', () => {
  if (running) return setRunning(false);
  if (!sim || sim.done) startSim();
  setRunning(true);
});

$('#btn-reset').addEventListener('click', () => {
  sim = null; flying = [];
  setRunning(false);
  $('#config').disabled = false;
  $('#stage-empty').hidden = false;
  computeLayout(); draw(0); renderStats(); renderDepthChart(); renderLatency();
});

function frame(now) {
  if (!running) return;
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const speed = +$('#speed').value;
  let simDt = dtReal * speed;
  let steps = 0;
  while (simDt > 1e-9 && steps < 500 && !sim.done) {
    sim.step(Math.min(SUBSTEP, simDt));
    simDt -= SUBSTEP;
    steps++;
  }
  draw(dtReal);
  renderStats();
  if (now - lastChart > 250 || sim.done) {
    lastChart = now;
    renderDepthChart();
    renderLatency();
  }
  if (sim.done) {
    if (!sim.finished) {
      sim.finished = true;
      sim.sample();
      renderDepthChart(); renderLatency();
    }
    // Keep animating until the last in-flight messages land in their carrier.
    if (flying.length) { requestAnimationFrame(frame); return; }
    setRunning(false);
    draw(0);
    return;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- stage (canvas)

const canvas = $('#stage');
const ctx = canvas.getContext('2d');
let colors = {};
const layout = { rows: [], height: 240, width: 800, carrierBox: new Map(), hits: [] };

function readColors() {
  const cs = getComputedStyle($('.viz-root'));
  const v = n => cs.getPropertyValue(n).trim();
  colors = {
    surface: v('--surface-1'), surface2: v('--surface-2'), text: v('--text-primary'), text2: v('--text-secondary'),
    muted: v('--text-muted'), grid: v('--grid'), axis: v('--axis'), good: v('--good'), accent: v('--accent'),
    healthy: v('--good'), degraded: v('--warning'), outage: v('--critical'),
    sl: ['#898781', v('--series-1'), v('--series-2'), v('--series-3')],
  };
}
readColors();

const LANE_H = 18;
const HEAD_H = 28;
const ROW_PAD = 14;
const DOT_GAP = 10;
const CBOX_H = 40;
const CBOX_W = 300;
const CBOX_GAP = 6;

function computeLayout() {
  const W = $('#stage-wrap').clientWidth;
  layout.width = W;
  layout.rows = [];
  layout.carrierBox = new Map();
  if (!sim) { layout.height = 240; sizeCanvas(); return; }
  const usedTypes = new Set(sim.streams.map(s => s.senderType));
  let y = 10;
  for (const cq of sim.queues) {
    if (!usedTypes.has(cq.stId)) continue;
    const lanes = [];
    for (const group of cq.groups) for (const tier of group.tiers) for (const t of tier.tenants) lanes.push({ group, tier, tenant: t, leaf: t.leaf });
    const nc = cq.carriers.length;
    const h = HEAD_H + Math.max(lanes.length * LANE_H, nc * CBOX_H + (nc - 1) * CBOX_GAP) + ROW_PAD;
    const row = { cq, y, h, lanes };
    layout.rows.push(row);
    layout.carrierBox.set(cq, cq.carriers.map((_, ci) => {
      const x = W - CBOX_W - 16;
      return { x, y: y + HEAD_H + ci * (CBOX_H + CBOX_GAP), w: CBOX_W, h: CBOX_H, qx0: x + 10, qx1: x + CBOX_W - 12 };
    }));
    y += h + 8;
  }
  layout.height = Math.max(240, y + 4);
  sizeCanvas();
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', () => { computeLayout(); draw(0); renderDepthChart(); });

function shape(sl, x, y, r) {
  ctx.beginPath();
  if (sl === 2) ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
  else if (sl === 3) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

const STATUS_CHIP = { healthy: '✓ Healthy', degraded: '▲ Degraded', outage: '✕ Outage' };

function carrierStatusNow(c) {
  if (!c.status || c.status === 'healthy') return 'healthy';
  const inWindow = sim.t >= (c.from ?? 0) && sim.t < (c.to ?? Infinity);
  return inWindow ? c.status : 'healthy';
}

function laneLabel(cq, lane) {
  const parts = [lane.leaf.sl ? `SL ${lane.leaf.sl}` : 'All levels'];
  const mode = sim.cfg.mt.mode;
  if (mode === 'weighted') parts.push(`Tier ${lane.tier.idx + 1}`);
  if (mode === 'none') parts.push('FIFO (all subaccounts)');
  else parts.push(`${String.fromCharCode(65 + lane.tenant.sub)} · ${sim.cfg.subaccounts[lane.tenant.sub].name}`);
  return parts.join(' · ');
}


function draw(dtReal) {
  const W = layout.width;
  ctx.clearRect(0, 0, W, layout.height);
  if (!sim) return;
  layout.hits = [];
  const labelW = Math.min(240, W * 0.26);
  const x0 = labelW + 16;
  const x1 = W - CBOX_W - 230;
  layout.laneEnd = W - CBOX_W - 24;
  const maxDots = Math.max(1, Math.floor((x1 - x0 - 52) / DOT_GAP));
  const ease = dtReal > 0 ? Math.min(1, dtReal * 12) : 1;

  for (const row of layout.rows) {
    const { cq } = row;
    const st = SENDER_TYPES.find(s => s.id === cq.stId);
    const queued = row.lanes.reduce((s, l) => s + l.leaf.q.length, 0);

    ctx.fillStyle = colors.surface2;
    ctx.beginPath(); ctx.roundRect(6, row.y, W - 12, row.h, 8); ctx.fill();

    ctx.fillStyle = colors.text;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const title = `${st.label}${st.note ? ` (${st.note})` : ''} egress`;
    ctx.fillText(title, 16, row.y + 14);
    const titleEnd = 16 + ctx.measureText(title).width;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = colors.text2;
    const qx = Math.max(x0, titleEnd + 14);
    ctx.fillText(`${fmtInt(queued)} queued`, qx, row.y + 14);

    // shared egress meter: one MPS budget feeds every carrier
    const util = cq.mps > 0 ? Math.min(1, cq.outNow / cq.mps) : 0;
    const mx = qx + 110; const mw = Math.max(40, x1 - mx - 150);
    ctx.fillStyle = colors.grid;
    ctx.beginPath(); ctx.roundRect(mx, row.y + 12, mw, 4, 2); ctx.fill();
    ctx.fillStyle = colors.accent;
    if (util > 0.005) { ctx.beginPath(); ctx.roundRect(mx, row.y + 12, mw * util, 4, 2); ctx.fill(); }
    ctx.fillStyle = colors.text;
    ctx.fillText(`in ${fmt(cq.inNow, 0)} · out ${fmt(cq.outNow, 0)} / ${fmtInt(cq.mps)} MPS`, mx + mw + 10, row.y + 14);
    layout.hits.push({ x: 6, y: row.y, w: x1 + 70, h: HEAD_H - 4, kind: 'egress', cq, row });

    row.lanes.forEach((lane, li) => {
      const ly = row.y + HEAD_H + li * LANE_H + LANE_H / 2;
      ctx.fillStyle = colors.text2;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(truncate(laneLabel(cq, lane), labelW - 16), labelW + 4, ly);
      ctx.textAlign = 'left';

      // lane track
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(x1, ly); ctx.stroke();

      // messages: head of queue sits at x1, tail grows left
      const q = lane.leaf.q;
      const n = Math.min(q.length, maxDots);
      for (let i = 0; i < n; i++) {
        const m = q.at(i);
        const tx = x1 - 6 - i * DOT_GAP;
        if (m.x == null) { m.x = x0 - 10; m.y = ly; }
        m.x += (tx - m.x) * ease;
        m.y = ly;
        ctx.fillStyle = colors.sl[m.sl];
        shape(m.sl, m.x, ly, 4);
      }
      if (q.length > maxDots) {
        ctx.fillStyle = colors.text2;
        ctx.fillText(`+${fmtInt(q.length - maxDots)}`, x0 + 2, ly);
      }

      // live rate for this lane
      ctx.fillStyle = colors.text2;
      ctx.fillText(`in ${fmt(lane.leaf.inNow, 1)} · out ${fmt(lane.leaf.outNow, 1)} · alloc ${fmt(lane.leaf.allocMps, 1)}`, x1 + 10, ly);
      layout.hits.push({ x: 6, y: ly - LANE_H / 2, w: x1 + 180, h: LANE_H, kind: 'lane', cq, lane });
    });

    // carrier queues: each carrier drains its own queue at its own limit
    layout.carrierBox.get(cq).forEach((g, ci) => {
      const c = cq.carriers[ci];
      const status = carrierStatusNow(c);
      ctx.fillStyle = colors.surface;
      ctx.strokeStyle = status === 'healthy' ? colors.axis : colors[status];
      ctx.lineWidth = status === 'healthy' ? 1 : 2;
      ctx.beginPath(); ctx.roundRect(g.x, g.y, g.w, g.h, 6); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.text;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(carrierName(ci), g.x + 10, g.y + 12);
      const chip = STATUS_CHIP[status];
      ctx.font = '600 11px system-ui, sans-serif';
      const cw = ctx.measureText(chip).width + 12;
      const chipX = g.x + 76;
      ctx.fillStyle = colors[status];
      ctx.beginPath(); ctx.roundRect(chipX, g.y + 4, cw, 16, 8); ctx.fill();
      ctx.fillStyle = status === 'degraded' ? '#0b0b0b' : '#ffffff';
      ctx.fillText(chip, chipX + 6, g.y + 12);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = colors.text2;
      ctx.textAlign = 'right';
      ctx.fillText(`${fmtInt(c.q.length)} queued`, g.x + g.w - 10, g.y + 12);

      // carrier queue track: head on the right, tail grows left; backlog count at the far left
      const ty = g.y + g.h - 10;
      const tx0 = g.qx0;
      ctx.textAlign = 'left';
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(tx0, ty); ctx.lineTo(g.qx1, ty); ctx.stroke();
      const cap = Math.max(1, Math.floor((g.qx1 - tx0) / 7));
      const n = Math.min(c.q.length, cap);
      for (let i = 0; i < n; i++) {
        const m = c.q.at(i);
        ctx.fillStyle = colors.sl[m.sl];
        shape(m.sl, g.qx1 - 4 - i * 7, ty, 3);
      }
      layout.hits.push({ x: g.x, y: g.y, w: g.w, h: g.h, kind: 'carrier', cq, ci });
    });
  }

  // messages in flight from queue head to carrier
  const next = [];
  for (const f of flying) {
    f.t += dtReal / 0.35;
    if (f.t >= 1) continue;
    const k = f.t * f.t * (3 - 2 * f.t);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.sl[f.sl];
    shape(f.sl, f.x0 + (f.x1 - f.x0) * k, f.y0 + (f.y1 - f.y0) * k, 4);
    next.push(f);
  }
  ctx.globalAlpha = 1;
  flying = dtReal > 0 ? next : flying;
}

function truncate(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxW) text = text.slice(0, -1);
  return `${text}…`;
}

// stage hover tooltip
const tip = $('#tooltip');
function showTip(e, title, rows) {
  tip.replaceChildren(el('div', { class: 'tt-title' }, title),
    ...rows.map(([k, v]) => el('div', { class: 'tt-row' }, el('span', {}, k), el('b', {}, v))));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14; let y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

canvas.addEventListener('mousemove', e => {
  if (!sim) return hideTip();
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left; const y = e.clientY - rect.top;
  const hit = layout.hits.slice().reverse().find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
  if (!hit) return hideTip();
  const stLabel = SENDER_TYPES.find(s => s.id === hit.cq.stId).label;
  if (hit.kind === 'lane') {
    const q = hit.lane.leaf.q;
    const oldest = q.length ? sim.t - q.at(0).t0 : 0;
    showTip(e, laneLabel(hit.cq, hit.lane), [
      ['Sender type', stLabel],
      ['Queued', fmtInt(q.length)],
      ['Oldest wait', `${fmt(oldest, 2)} s`],
      ['Ingress', `${fmt(hit.lane.leaf.inNow, 1)} msg/s`],
      ['Egress', `${fmt(hit.lane.leaf.outNow, 1)} MPS`],
      ['Max achievable now', `${fmt(hit.lane.leaf.allocMps, 1)} MPS`],
    ]);
  } else if (hit.kind === 'egress') {
    const queued = hit.row.lanes.reduce((s, l) => s + l.leaf.q.length, 0);
    showTip(e, `${stLabel} egress`, [
      ['Capacity (all carriers)', `${fmtInt(hit.cq.mps)} MPS`],
      ['Ingress', `${fmt(hit.cq.inNow, 1)} msg/s`],
      ['Egress', `${fmt(hit.cq.outNow, 1)} MPS`],
      ['Delivered', fmtInt(hit.cq.delivered)],
      ['Queued', fmtInt(queued)],
    ]);
  } else {
    const c = hit.cq.carriers[hit.ci];
    const status = carrierStatusNow(c);
    const oldest = c.q.length ? sim.t - c.q.at(0).t0 : 0;
    showTip(e, `${carrierName(hit.ci)} · ${stLabel}`, [
      ['Status', STATUS_CHIP[status]],
      ['Queued at carrier', fmtInt(c.q.length)],
      ['Oldest wait', `${fmt(oldest, 2)} s`],
      ['Delivered', fmtInt(c.delivered)],
    ]);
  }
});
canvas.addEventListener('mouseleave', hideTip);

// ---------------------------------------------------------------- stats

function renderStats() {
  const delivered = sim ? sim.queues.reduce((s, q) => s + q.delivered, 0) : 0;
  const sent = sim ? sim.nextId : 0;
  const atCarrier = sim ? sim.inCarrier : 0;
  const tiles = [
    ['Simulated time', sim ? `${fmt(sim.t, 1)} s` : '0.0 s'],
    ['Messages sent', fmtInt(sent)],
    ['Waiting in Twilio queues', fmtInt(sim ? sim.totalQueued - atCarrier : 0)],
    ['Waiting at carriers', fmtInt(atCarrier)],
    ['Delivered by carriers', fmtInt(delivered)],
  ];
  const box = $('#stats');
  if (box.children.length !== tiles.length) {
    box.replaceChildren(...tiles.map(() => el('div', { class: 'stat' }, el('div', { class: 'k' }), el('div', { class: 'v' }))));
  }
  tiles.forEach(([k, v], i) => {
    box.children[i].firstChild.textContent = k;
    box.children[i].lastChild.textContent = v;
  });
}

// ---------------------------------------------------------------- depth chart (SVG)

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw));
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// Line charts of messages waiting over time. Each chart only populates when its
// feature actually splits throughput; otherwise it explains why it's empty.

const CHARTS = {
  sl: {
    box: $('#depth-chart'), aria: 'Messages waiting in queue over time, by Service Level',
    on: cfg => cfg.ts.enabled,
    off: 'Traffic Shaping is set to None, so Service Levels don\'t affect throughput. Set it to Weighted to see this chart.',
    series: () => [0, 1, 2].map(i => ({ color: `var(--series-${i + 1})`, label: `SL ${i + 1}`, tip: `${SL_SHAPES[i + 1]} SL ${i + 1}`, value: d => d.q[i] })),
  },
  mt: {
    box: $('#tier-chart'),
    on: cfg => cfg.mt.mode !== 'none',
    off: 'Multi-Tenancy is set to None, so subaccounts share one queue per Service Level. Set it to Even or Weighted to see this chart.',
    aria: 'Messages waiting in queue over time, by Multi-Tenancy tier or subaccount',
    series: cfg => (cfg.mt.mode === 'weighted'
      ? [0, 1, 2].map(i => ({ color: `var(--tier-${i + 1})`, label: `Tier ${i + 1}`, tip: `Tier ${i + 1}`, value: d => d.tier[i] }))
      : cfg.subaccounts.slice(0, MAX_SUBACCOUNTS).map((sa, i) => ({
        color: SUB_COLORS[i], dash: SUB_DASH[i], label: subLetter(i), tip: `${subLetter(i)} · ${sa.name}`, value: d => d.sub[i] ?? 0,
      }))),
  },
};

// Settings that apply to the current run, or to the next run if none is active.
const activeCfg = () => (sim ? sim.cfg : buildConfig());

// Charts and tables follow the current modes even before a run starts.
function renderResults() { if (!sim) { renderDepthChart(); renderLatency(); } }

function renderDepthChart() {
  const even = activeCfg().mt.mode === 'even';
  $('#mt-chart-title').textContent = `Messages waiting in queue, by ${even ? 'subaccount (Even Multi-Tenancy)' : 'Multi-Tenancy tier'}`;
  $('#mt-table-title').textContent = `Time spent in queue, by ${even ? 'subaccount' : 'Multi-Tenancy tier'}`;
  for (const c of Object.values(CHARTS)) renderLineChart(c);
}

function renderLineChart(c) {
  const box = c.box;
  if (!c.on(activeCfg())) { c.geom = null; box.innerHTML = `<div class="chart-off">${c.off}</div>`; return; }
  const W = box.clientWidth; const H = box.clientHeight;
  const m = { l: 44, r: 52, t: 8, b: 24 };
  const data = sim ? sim.timeline : [];
  const list = c.series(activeCfg());
  const tMax = Math.max(sim ? sim.endOfTraffic : 10, data.length ? data[data.length - 1].t : 0, 1);
  const yMax = Math.max(1, ...data.map(d => Math.max(...list.map(se => se.value(d)))));
  const yt = niceTicks(Math.max(yMax, 4));
  const xt = niceTicks(tMax, 6);
  const X = t => m.l + (t / xt[xt.length - 1]) * (W - m.l - m.r);
  const Y = v => H - m.b - (v / yt[yt.length - 1]) * (H - m.t - m.b);
  c.geom = { X, Y, m, W, H, data, list, xMax: xt[xt.length - 1] };

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.aria}">`;
  for (const v of yt) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    s += `<text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmtInt(v)}</text>`;
  }
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)" stroke-width="1"/>`;
  for (const v of xt) s += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${fmt(v, v % 1 ? 1 : 0)}s</text>`;

  if (data.length > 1) {
    const ends = [];
    list.forEach((se, i) => {
      const pts = data.map(d => `${X(d.t).toFixed(1)},${Y(se.value(d)).toFixed(1)}`).join(' ');
      const dash = se.dash ? ` stroke-dasharray="${se.dash}"` : '';
      s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="2"${dash} stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = data[data.length - 1];
      ends.push({ i, y: Y(se.value(last)), x: X(last.t) });
    });
    // Direct labels at line ends: kept above the x-axis labels and nudged apart.
    const floor = H - m.b - 4;
    ends.sort((a, b) => b.y - a.y);
    ends[0].y = Math.min(ends[0].y, floor);
    for (let k = 1; k < ends.length; k++) if (ends[k - 1].y - ends[k].y < 12) ends[k].y = ends[k - 1].y - 12;
    for (const e of ends) s += `<text class="series-label" x="${e.x + 6}" y="${e.y + 4}">${list[e.i].label}</text>`;
  }
  s += '<line class="xhair" y1="0" y2="0" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>';
  s += '<g class="xhair-dots"></g>';
  s += `<rect x="${m.l}" y="${m.t}" width="${Math.max(0, W - m.l - m.r)}" height="${Math.max(0, H - m.t - m.b)}" fill="transparent"/>`;
  s += '</svg>';
  box.innerHTML = s;
}

for (const c of Object.values(CHARTS)) {
  const hide = () => {
    const xh = c.box.querySelector('.xhair'); if (xh) xh.setAttribute('visibility', 'hidden');
    const d = c.box.querySelector('.xhair-dots'); if (d) d.innerHTML = '';
    hideTip();
  };
  c.box.addEventListener('mousemove', e => {
    const g = c.geom;
    if (!g || g.data.length < 2) return;
    const rect = c.box.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < g.m.l || px > g.W - g.m.r) { hide(); return; }
    const t = ((px - g.m.l) / (g.W - g.m.l - g.m.r)) * g.xMax;
    let best = g.data[0];
    for (const d of g.data) if (Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
    const xh = c.box.querySelector('.xhair');
    xh.setAttribute('x1', g.X(best.t)); xh.setAttribute('x2', g.X(best.t));
    xh.setAttribute('y1', g.m.t); xh.setAttribute('y2', g.H - g.m.b);
    xh.setAttribute('visibility', 'visible');
    c.box.querySelector('.xhair-dots').innerHTML = g.list.map(se =>
      `<circle cx="${g.X(best.t)}" cy="${g.Y(se.value(best))}" r="4" fill="${se.color}" stroke="var(--surface-1)" stroke-width="2"/>`).join('');
    showTip(e, `t = ${fmt(best.t, 2)} s`, g.list.map(se => [se.tip, fmtInt(se.value(best))]));
  });
  c.box.addEventListener('mouseleave', hide);
}

// ---------------------------------------------------------------- latency table

function renderLatency() {
  const box = $('#latency-table');
  const mtBox = $('#tier-latency-table');
  const subBox = $('#sub-latency-table');
  const cfg = activeCfg();
  const tsOn = cfg.ts.enabled;
  const mtMode = cfg.mt.mode;
  const weighted = mtMode === 'weighted';
  const offTs = '<p class="table-off">Not shown: Traffic Shaping is set to None, so Service Levels don\'t affect throughput.</p>';
  const offMt = '<p class="table-off">Not shown: Multi-Tenancy is set to None, so subaccounts share one queue per Service Level.</p>';
  if (!sim) {
    const wait = '<p class="hint">Results appear here while the simulation runs.</p>';
    box.innerHTML = tsOn ? wait : offTs;
    mtBox.innerHTML = mtMode !== 'none' ? wait : offMt;
    subBox.innerHTML = '<p class="hint">Per-subaccount results appear here while the simulation runs.</p>';
    return;
  }
  const sum = sim.summary();
  const allMax = Math.max(1e-6, ...(tsOn ? sum.bySL.map(r => r.p95) : []), ...(weighted ? sum.byTier.map(r => r.p95) : []), ...sum.bySub.map(r => r.p95));
  const frac = v => Math.min(100, Math.round((v / allMax) * 100));
  const bar = v => `<span class="bar-cell"><span class="num">${fmt(v, 2)} s</span><span class="track"><i style="width:${frac(v)}%"></i></span></span>`;
  const cells = r => `<td>${fmtInt(r.count)}</td><td>${fmt(r.avg, 2)} s</td><td>${fmt(r.p50, 2)} s</td><td>${bar(r.p95)}</td><td>${fmt(r.max, 2)} s</td>`;
  const row = (label, r) => `<tr><td class="l">${label}</td>${cells(r)}</tr>`;
  const swatch = color => `<span class="swatch" style="background:${color}"></span>`;
  const slLabel = sl => `${swatch(`var(--series-${sl})`)} ${SL_SHAPES[sl]} SL ${sl}`;
  const tierWeights = sim.cfg.mt.tiers.map(t => t.weight);
  const tierLabel = i => `${swatch(`var(--tier-${i + 1})`)} Tier ${i + 1} <span class="muted">· ${fmt(pctOf(tierWeights, i), 0)}%</span>`;
  const subLabel = i => `${swatch(SUB_COLORS[i])} <b>${subLetter(i)}</b> · ${escapeHtml(sim.cfg.subaccounts[i].name)}`;
  const head = '<table class="fixed summary"><colgroup><col class="c-label"><col class="c-count"><col class="c-time"><col class="c-time"><col class="c-p95"><col class="c-time"></colgroup>'
    + '<thead><tr><th></th><th>Delivered</th><th>Avg</th><th>p50</th><th>p95</th><th>Max</th></tr></thead><tbody>';
  const table = rows => `${head}${rows.join('')}</tbody></table>`;

  box.innerHTML = tsOn ? table(sum.bySL.map((r, i) => row(slLabel(i + 1), r))) : offTs;
  if (weighted) mtBox.innerHTML = table(sum.byTier.map((r, i) => row(tierLabel(i), r)));
  else if (mtMode === 'even') mtBox.innerHTML = table(sum.bySub.map((r, i) => row(subLabel(i), r)));
  else mtBox.innerHTML = offMt;

  // Full-width table: a row per subaccount and sender type; each Service Level is a column group.
  const parts = ['subaccount', 'sender type', ...(weighted ? ['tier'] : []), ...(tsOn ? ['Service Level'] : [])];
  $('#sub-latency-title').textContent = `Time spent in queue by ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const order = sim.cfg.subaccounts.map((_, i) => i)
    .sort((a, b) => (weighted ? sim.cfg.subaccounts[a].tier - sim.cfg.subaccounts[b].tier : 0) || a - b);
  const groups = [['All messages', null], ...(tsOn ? [1, 2, 3].map(sl => [slLabel(sl), sl]) : [])];
  const short = r => r.count
    ? `<td class="g-start">${fmtInt(r.count)}</td><td>${fmt(r.avg, 2)} s</td><td>${bar(r.p95)}</td>`
    : '<td class="g-start empty">–</td><td class="empty">–</td><td class="empty">–</td>';
  const groupCols = '<col class="c-count"><col class="c-time"><col class="c-p95">';
  let t = `<table class="fixed sub-latency${weighted ? ' has-tier' : ''}"><colgroup><col class="c-sub"><col class="c-st">${weighted ? '<col class="c-tier">' : ''}${groupCols.repeat(groups.length)}</colgroup>`
    + '<thead><tr><th rowspan="2" class="l">Subaccount</th><th rowspan="2" class="l">Sender type</th>';
  if (weighted) t += '<th rowspan="2" class="l">Tier</th>';
  t += groups.map(([label]) => `<th colspan="3" class="g-start g-head">${label}</th>`).join('') + '</tr><tr>';
  t += groups.map(() => '<th class="g-start" title="Messages delivered">Msgs</th><th>Avg</th><th>p95</th>').join('') + '</tr></thead><tbody>';
  let lastTier = null;
  for (const i of order) {
    const sa = sim.cfg.subaccounts[i];
    const stRows = sum.bySubST[i];
    const rows = stRows.length > 1
      ? [...stRows.map(r => ({ label: SENDER_TYPES.find(st => st.id === r.stId).label, all: r.all, sl: r.sl })), { label: 'Total', all: sum.bySub[i], sl: sum.bySubSL[i], total: true }]
      : stRows.length === 1
        ? [{ label: SENDER_TYPES.find(st => st.id === stRows[0].stId).label, all: stRows[0].all, sl: stRows[0].sl }]
        : [{ label: '–', all: sum.bySub[i], sl: sum.bySubSL[i] }];
    const tierBreak = weighted && lastTier !== null && sa.tier !== lastTier;
    lastTier = sa.tier;
    rows.forEach((r, k) => {
      const cls = [k === 0 ? 'sub-first' : 'sub-cont', k === 0 && tierBreak ? 'tier-break' : '', r.total ? 'sub-total' : ''].filter(Boolean).join(' ');
      t += `<tr class="${cls}">`;
      t += k === 0 ? `<td rowspan="${rows.length}" class="l" title="${escapeHtml(sa.name)}"><b>${subLetter(i)}</b> · ${escapeHtml(sa.name)}</td>` : '';
      t += `<td class="l">${r.total ? '<b>Total</b>' : r.label}</td>`;
      if (weighted) t += k === 0 ? `<td rowspan="${rows.length}" class="l">Tier ${sa.tier + 1} <span class="muted">· ${fmt(pctOf(tierWeights, sa.tier), 0)}%</span></td>` : '';
      t += short(r.all);
      if (tsOn) r.sl.forEach(x => { t += short(x); });
      t += '</tr>';
    });
  }
  subBox.innerHTML = `${t}</tbody></table>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- boot

applyPreset(state.preset);
renderAll();
computeLayout();
renderStats();
renderDepthChart();
renderLatency();

// ?ts=weighted&mt=even&autostart — handy for sharing a scenario link.
const params = new URLSearchParams(location.search);
if (params.get('ts')) { state.ts.mode = params.get('ts'); renderTrafficShaping(); renderStreams(); }
if (params.get('mt')) { state.mt.mode = params.get('mt'); renderMultiTenancy(); }
if (params.has('autostart')) { startSim(); setRunning(true); }
