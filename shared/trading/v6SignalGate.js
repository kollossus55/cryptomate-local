/**
 * V6 signal gate: "test any signals before trading". Interface: docs/rebuild/signal-gate.md.
 *
 * Seven checks stand between a signal and an entry, split around sizing:
 *   preSize   1 certificate  2 forward drift  3 data  4 cross-venue replay  6 historical
 *   postSize  5 liquidity  7 risk
 * Every check runs and reports its values and limits, so the GUI can show all of them.
 * Anything missing or malformed is a failed check. The gate is only ever asked about
 * entries: exits never reach it.
 *
 * Pure and synchronous. All data is passed in, and this module must not import v6Bars or
 * v6Exchanges: the live path never loads the research store.
 *
 * A pass allows a trade. It says nothing about whether that trade will win.
 */
import { GATE_CHECKS, createIndicatorAccess, entryPositionFields, exitConfigFor } from './v6Core.js';
import { applyExitResult, evaluateExit } from './v6Exits.js';
import { STOP_EXTRA_SLIP_PCT, walkBook } from './v6Paper.js';
import { seededRandom } from './v6Stats.js';

/** Last DEV millisecond. Restated from v6Bars, which does I/O; a test keeps the two equal. */
export const DEV_END = Date.UTC(2025, 0, 1) - 1;

export const CERT_FORMAT = 'v6-cert-1';
export const HISTORY_FORMAT = 'v6-signal-history-1';
export const CERT_TTL_DAYS = 180;
export const LIFECYCLES = Object.freeze(['research', 'certified', 'paper_half', 'paper_full', 'shadow']);

// Contract values, deliberately not in config: no setting may shorten them.
export const FORWARD_TRADES_TO_FULL = 20;
export const SHADOW_SIGNALS_TO_RETURN = 20;
export const HALF_RISK = 0.5;

const MIN_BAND_TRADES = 30;
const MAX_SERIES = 1000;
const SMALL_SAMPLE = 10;
const DAY_MS = 86400000;

export const DEFAULT_GATE_CONFIG = Object.freeze({
  maxBarAgeMs: 30 * 60000,          // since the bar's close; a few missed 5-minute ticks
  gapWindowBars: 60,
  minConsensusVenues: 2,
  maxConsensusSpreadPct: 0.5,
  replayVenues: Object.freeze(['okx', 'bybit']),
  replayMinOverlapBars: 20,
  replayMaxPriceMismatchPct: 2,     // same coin: well under 1%. A ticker collision: far above
  // DEV, 117 venue-coin pairs over 300 days. Bybit ZEC and DASH: about zero volume, worst day 98.6%
  // and 29.5% off. Every other pair: thinnest day $5.5k, worst day 5.8% off.
  replayGrossPriceMismatchPct: 20,  // any one bar this far off makes the venue unusable
  replayMinVenueQuotePerDay: 1000,  // median and latest bar, scaled to a day
  maxBookAgeMs: 30000,
});

const DEV_CRITERIA = Object.freeze([
  ['D1', 'Sharpe and bootstrap CI', 'Sharpe >= 0.80, 90% CI low > 0'],
  ['D2', 'Deflated Sharpe', '>= 0.90 on the global trial count'],
  ['D3', 'Max drawdown', '<= 30%'],
  ['D4', 'Sample size', '>= 100 closed trades, or >= 30 position-changes'],
  ['D5', 'Double costs', 'Profitable at 2x costs'],
  ['D6', 'Parameter plateau', 'Neighbours keep >= 50% of the Sharpe'],
  ['D7', 'Concentration', 'Coin <= 35%, year <= 60% of profit'],
  ['D8', 'Against buy and hold', 'Better Calmar or Sharpe'],
]);

const HOLDOUT_CRITERIA = Object.freeze([
  ['H1', 'Holdout Sharpe', '>= 0.50', (h) => [h.sharpe], (h) => h.sharpe >= 0.5],
  ['H2', 'Holdout max drawdown', '<= 25%', (h) => [h.maxDrawdown], (h) => h.maxDrawdown <= 0.25],
  ['H3', 'Holdout total return', '> 0', (h) => [h.totalReturn], (h) => h.totalReturn > 0],
  ['H4', 'Holdout drawdown against BTC', 'Smaller than BTC buy and hold', (h) => [h.maxDrawdown, h.btcMaxDrawdown], (h) => h.maxDrawdown < h.btcMaxDrawdown],
]);

const CRITERIA_IDS = Object.freeze([...DEV_CRITERIA.map((c) => c[0]), ...HOLDOUT_CRITERIA.map((c) => c[0])]);

const CERT_FIELDS = Object.freeze([
  'format', 'cert_id', 'strategy_id', 'strategy_version', 'hash', 'status', 'issued_at', 'expires_at',
  'issuer', 'trial_count', 'holdout_clean', 'criteria', 'expected',
]);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const lookup = (m, key) => (m instanceof Map ? m.get(key) : isObj(m) ? m[key] : undefined);
const round = (x, d = 6) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const val = (label, value, limit = null) => ({ label, value, limit });
const check = (id, pass, text, values = []) => ({ id, status: pass ? 'pass' : 'fail', text, values });
const notRun = (id, text) => ({ id, status: 'not_run', text, values: [] });
const labelOf = (id) => GATE_CHECKS.find((c) => c.id === id)?.label ?? id;
const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- hashing ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string as hex. Written out because the gate is synchronous and crypto.subtle is not. */
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const codeOf = (fn) => String(fn).replace(/\r\n/g, '\n');

/** JSON with sorted keys, stable across a JSON round trip: NaN and Infinity become null, as JSON makes them. */
export function canonicalJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'function') return JSON.stringify(codeOf(v));
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Hash of what makes a strategy behave as it does: signals() source, params and settings.
 * Function source does not include what it calls, so a strategy using module-level helpers
 * must list them in `codeDeps`, or a helper could change without the hash noticing.
 */
export function strategyHash(strategy) {
  const s = strategy;
  if (typeof s?.signals !== 'function') throw new Error('strategyHash needs a strategy with signals()');
  return sha256(canonicalJson({
    id: s.id, version: s.version, timeframe: s.timeframe, universe: s.universe, params: s.params,
    warmupBars: s.warmupBars, exitOverrides: s.exitOverrides, perp: Boolean(s.perp), slowAllocator: Boolean(s.slowAllocator),
    code: codeOf(s.signals), deps: (s.codeDeps || []).map(codeOf),
  }));
}

// ---------- drift band ----------

/**
 * The range forward results should stay in, from bootstrapped backtest trade outcomes.
 * Resampling is in blocks because trades of one strategy tend to lose together.
 *
 * Two stages: each path first resamples the backtest's trades, then draws from that
 * resample. The backtest's mean is only an estimate, and with one stage the band treats
 * it as exact: measured on 150-trade samples, 18.9% of healthy strategies were demoted.
 *
 * p5 and p95 are for the chart. lo and hi are the breach limits, set wider: the monitor
 * looks after every trade, and a healthy strategy would soon cross a 5% line on one of
 * those looks. lo and hi are tuned so that about `alpha` of bootstrapped paths ever leave.
 *
 * @param {number[]} returnsPct net percent per trade, as tradeOutcomes gives
 */
export function buildExpectedBand(returnsPct, { maxX = 100, nBoot = 2000, blockLen = 5, alpha = 0.05, minTrades = 5, seed = 1 } = {}) {
  if (!Array.isArray(returnsPct) || returnsPct.length < MIN_BAND_TRADES || !returnsPct.every(Number.isFinite)) {
    throw new Error(`The expected band needs at least ${MIN_BAND_TRADES} finite trade returns`);
  }
  const n = returnsPct.length;
  const rand = seededRandom(seed);
  const paths = new Float64Array(nBoot * maxX);
  const pool = new Float64Array(n);
  const walk = (source, length, visit) => {
    let idx = Math.floor(rand() * n);
    for (let x = 0; x < length; x++) {
      if (x > 0) idx = rand() < 1 / blockLen ? Math.floor(rand() * n) : (idx + 1) % n;
      visit(source[idx], x);
    }
  };
  for (let b = 0; b < nBoot; b++) {
    walk(returnsPct, n, (r, x) => { pool[x] = r; });
    let cum = 0;
    walk(pool, maxX, (r, x) => { cum += r; paths[b * maxX + x] = cum; });
  }
  const sorted = Array.from({ length: maxX }, (_, x) => {
    const col = new Float64Array(nBoot);
    for (let b = 0; b < nBoot; b++) col[b] = paths[b * maxX + x];
    return col.sort();
  });
  const at = (col, q) => col[Math.min(nBoot - 1, Math.max(0, Math.floor(q * nBoot)))];
  const leaveRate = (q) => {
    let left = 0;
    for (let b = 0; b < nBoot; b++) {
      for (let x = minTrades - 1; x < maxX; x++) {
        const v = paths[b * maxX + x];
        if (v < at(sorted[x], q / 2) || v > at(sorted[x], 1 - q / 2)) { left++; break; }
      }
    }
    return left / nBoot;
  };
  const levels = [0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
  const q = levels.find((level) => leaveRate(level) <= alpha) ?? levels[levels.length - 1];
  return {
    x_unit: 'trades', n_trades: n, n_boot: nBoot, block_len: blockLen, seed, alpha, quantile: q, min_trades: minTrades, max_x: maxX,
    points: sorted.map((col, x) => ({
      x: x + 1, p5: round(at(col, 0.05)), p50: round(at(col, 0.5)), p95: round(at(col, 0.95)),
      lo: round(at(col, q / 2)), hi: round(at(col, 1 - q / 2)),
    })),
  };
}

const bandUsable = (e) => isObj(e) && Array.isArray(e.points) && e.points.length > 0 && e.points.length === e.max_x
  && e.min_trades >= 1 && e.points.every((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));

/**
 * Compares a run of trade returns with the band. Past the band's end, the latest max_x
 * trades are compared with its last point.
 * @returns {{ status: 'unknown'|'warming'|'inside'|'breach', ok: boolean, n: number, cumulative: ?number, lo: ?number, hi: ?number, note: string }}
 */
export function evaluateDrift(expected, returnsPct) {
  const empty = { n: 0, cumulative: null, lo: null, hi: null };
  if (!bandUsable(expected)) return { ...empty, status: 'unknown', ok: false, note: 'No usable expected range' };
  if (!Array.isArray(returnsPct) || !returnsPct.every(Number.isFinite)) return { ...empty, status: 'unknown', ok: false, note: 'Forward results are unreadable' };
  const n = returnsPct.length;
  if (n < expected.min_trades) {
    return { ...empty, n, status: 'warming', ok: true, note: `${n} of ${expected.min_trades} trades needed before the range applies` };
  }
  const window = returnsPct.slice(-expected.max_x);
  const cumulative = round(window.reduce((a, x) => a + x, 0));
  const { lo, hi } = expected.points[window.length - 1];
  const inside = cumulative >= lo && cumulative <= hi;
  return {
    n, cumulative, lo, hi, status: inside ? 'inside' : 'breach', ok: inside,
    note: `Cumulative ${cumulative}% over ${window.length} trades, expected ${lo}% to ${hi}%`,
  };
}

// ---------- certificates ----------

const sealOf = (cert) => sha256(canonicalJson(Object.fromEntries(CERT_FIELDS.map((f) => [f, cert[f]]))));

function devRows(devCriteria) {
  return DEV_CRITERIA.map(([id, label, needs]) => {
    const row = lookup(devCriteria, id);
    const status = !isObj(row) ? 'not_run' : row.pass === true ? 'pass' : 'fail';
    return { id, group: 'dev', label, needs, result: row?.detail || null, value: row?.value ?? null, status };
  });
}

function holdoutRows(holdout) {
  return HOLDOUT_CRITERIA.map(([id, label, needs, inputs, passes]) => {
    const ran = isObj(holdout) && inputs(holdout).every(Number.isFinite);
    const status = !ran ? 'not_run' : passes(holdout) ? 'pass' : 'fail';
    return { id, group: 'holdout', label, needs, result: null, value: ran ? inputs(holdout)[0] : null, status };
  });
}

/**
 * Builds a certificate. For the final validator's script only: nothing in the GUI, the
 * worker or v6Control may call it. A failed candidate gets a certificate too, with status
 * 'failed', so the GUI can show why the engine holds cash.
 *
 * H1-H4 are judged here against the frozen thresholds, from the numbers. D1-D8 arrive
 * judged, from v6Sim.checkDevCriteria.
 *
 * @param {object} a
 * @param {object} a.strategy the exact strategy object the engine will run
 * @param {object} a.devCriteria checkDevCriteria(...).criteria
 * @param {{ sharpe: number, maxDrawdown: number, totalReturn: number, btcMaxDrawdown: number }} [a.holdout] drawdowns as fractions
 * @param {number[]} [a.tradeReturnsPct] DEV out-of-sample net trade returns; required to pass
 * @param {number} a.issuedAt
 * @param {number} a.trialCount global trial count
 * @param {boolean} a.holdoutClean false for rules earlier research already saw on the holdout
 * @param {string} a.issuer
 */
export function issueCertificate({ strategy, devCriteria, holdout, tradeReturnsPct, issuedAt, ttlDays = CERT_TTL_DAYS, trialCount, holdoutClean, issuer, band = {} }) {
  if (!Number.isFinite(issuedAt)) throw new Error('issueCertificate needs issuedAt');
  if (typeof issuer !== 'string' || !issuer.trim()) throw new Error('issueCertificate needs an issuer');
  if (typeof holdoutClean !== 'boolean') throw new Error('issueCertificate needs holdoutClean');
  if (!(trialCount >= 1)) throw new Error('issueCertificate needs the global trial count');
  if (!(ttlDays > 0)) throw new Error('issueCertificate needs a positive ttlDays');

  const hash = strategyHash(strategy);
  const criteria = [...devRows(devCriteria), ...holdoutRows(holdout)];
  const status = criteria.every((c) => c.status === 'pass') ? 'valid' : 'failed';
  const body = {
    format: CERT_FORMAT, cert_id: `${strategy.id}-${hash.slice(0, 12)}-${issuedAt}`, strategy_id: strategy.id,
    strategy_version: strategy.version, hash, status, issued_at: issuedAt, expires_at: issuedAt + ttlDays * DAY_MS,
    issuer, trial_count: trialCount, holdout_clean: holdoutClean, criteria,
    expected: status === 'valid' ? buildExpectedBand(tradeReturnsPct, band) : null,
  };
  return { ...body, seal: sealOf(body) };
}

/** The seal shows a stored certificate was not edited. Anyone with this code can recompute one, so it does not prove who issued it. */
const sealOk = (cert) => isObj(cert) && typeof cert.seal === 'string' && cert.seal === sealOf(cert);

/** @returns {{ ok: boolean, code: string, reason: string }} */
export function verifyCertificate(cert, strategy, t) {
  const no = (code, reason) => ({ ok: false, code, reason });
  if (!isObj(cert)) return no('missing', 'No certificate');
  if (cert.format !== CERT_FORMAT) return no('bad_format', 'Unknown certificate format');
  if (!sealOk(cert)) return no('bad_seal', 'Certificate was altered: the seal does not match');
  if (cert.status !== 'valid') return no('not_valid_status', `Certificate status is ${cert.status}`);
  const rows = Array.isArray(cert.criteria) ? cert.criteria : [];
  if (!CRITERIA_IDS.every((id) => rows.find((c) => c.id === id)?.status === 'pass')) return no('criteria_not_passed', 'Not every criterion D1-D8, H1-H4 passed');
  if (!bandUsable(cert.expected)) return no('bad_format', 'Certificate has no expected range');
  if (typeof strategy?.signals !== 'function') return no('wrong_strategy', 'No strategy to compare with');
  if (cert.strategy_id !== strategy.id) return no('wrong_strategy', `Certificate is for ${cert.strategy_id}`);
  if (cert.strategy_version !== strategy.version) return no('wrong_version', `Certificate is for version ${cert.strategy_version}`);
  if (cert.hash !== strategyHash(strategy)) return no('hash_mismatch', 'Strategy code or parameters changed since certification');
  if (!Number.isFinite(t) || !Number.isFinite(cert.issued_at) || !Number.isFinite(cert.expires_at)) return no('expired', 'Certificate dates cannot be read');
  if (t < cert.issued_at) return no('not_yet_valid', 'Certificate is dated in the future');
  if (t >= cert.expires_at) return no('expired', 'Certificate has expired');
  return { ok: true, code: 'ok', reason: `${cert.hash.slice(0, 4)}...${cert.hash.slice(-3)} matches code` };
}

// ---------- lifecycle ----------

const stateOk = (s) => isObj(s) && LIFECYCLES.includes(s.lifecycle) && Array.isArray(s.forward_series)
  && Number.isInteger(s.forward_trades) && s.forward_trades >= 0 && Array.isArray(s.shadow_series) && Array.isArray(s.shadow_book);

export function initialStrategyState({ strategy }) {
  return {
    strategy_id: strategy.id, version: strategy.version ?? 1, lifecycle: 'research', size_multiplier: 0,
    forward_trades: 0, forward_series: [], drift_status: 'warming', drift_note: null, demoted_at: null, demotion_reason: null,
    shadow_series: [], shadow_in_range: 0, shadow_book: [], transitions: [],
  };
}

/** Reads the lifecycle, never the stored figure, and treats a full-risk state short of 20 trades as half. */
export function sizeMultiplierFor(state) {
  if (!stateOk(state)) return 0;
  if (state.lifecycle === 'paper_full') return state.forward_trades >= FORWARD_TRADES_TO_FULL ? 1 : HALF_RISK;
  return state.lifecycle === 'paper_half' || state.lifecycle === 'shadow' ? HALF_RISK : 0;
}

function moved(state, to, { t, by = 'engine', reason }) {
  const next = { ...state, lifecycle: to, transitions: [...state.transitions, { t, from: state.lifecycle, to, by, reason }] };
  next.size_multiplier = to === 'shadow' ? 0 : sizeMultiplierFor(next);
  return next;
}

/** The forward steps a certificate allows: research -> certified -> paper_half, one per call. Never leaves shadow. */
export function advanceLifecycle(state, { strategy, certificate, t }) {
  if (!stateOk(state)) return { state, events: [] };
  if (state.lifecycle !== 'research' && state.lifecycle !== 'certified') return { state, events: [] };
  if (!verifyCertificate(certificate, strategy, t).ok) return { state, events: [] };
  const to = state.lifecycle === 'research' ? 'certified' : 'paper_half';
  return {
    state: moved(state, to, { t, reason: 'Valid certificate' }),
    events: [{ t, type: 'strategy_lifecycle', code: `strategy_${to}`, strategyId: state.strategy_id, severity: 'info', message: `${state.strategy_id} moved to ${to}.` }],
  };
}

/** Into shadow, from any state: drift, or a failed candidate logging signals only. */
export function demoteToShadow(state, { t, reason }) {
  if (!stateOk(state) || state.lifecycle === 'shadow') return { state, events: [] };
  const next = {
    ...moved(state, 'shadow', { t, reason }), demoted_at: t, demotion_reason: reason,
    shadow_series: [], shadow_in_range: 0, shadow_book: [],
  };
  return {
    state: next,
    events: [{ t, type: 'strategy_lifecycle', code: 'strategy_demoted', strategyId: state.strategy_id, severity: 'warning', message: `${state.strategy_id} moved to shadow: ${reason}` }],
  };
}

/**
 * Adds one closed real trade, then runs the drift monitor. Only paper states count: a
 * position opened before a demotion and closing after it is not forward evidence.
 * A trade already recorded under this tradeId is ignored, so a restart cannot count it twice.
 */
export function recordForwardTrade(state, { returnPct, t, tradeId = null }, { certificate } = {}) {
  if (!stateOk(state) || (state.lifecycle !== 'paper_half' && state.lifecycle !== 'paper_full')) return { state, events: [] };
  if (tradeId !== null && state.forward_series.some((p) => p.trade_id === tradeId)) return { state, events: [] };
  if (!Number.isFinite(returnPct)) {
    return { state: { ...state, drift_status: 'unknown', drift_note: 'A forward trade had no readable return' }, events: [] };
  }
  const x = state.forward_trades + 1;
  const previous = state.forward_series[state.forward_series.length - 1]?.return_pct ?? 0;
  const point = { x, return_pct: round(previous + returnPct), trade_return_pct: returnPct, t, trade_id: tradeId };
  const forward_series = [...state.forward_series, point].slice(-MAX_SERIES);
  const expected = sealOk(certificate) ? certificate.expected : null;
  const drift = evaluateDrift(expected, forward_series.map((p) => p.trade_return_pct));
  const next = { ...state, forward_trades: x, forward_series, drift_status: drift.status, drift_note: drift.note };

  if (drift.status === 'breach') return demoteToShadow(next, { t, reason: `Forward results left the expected range. ${drift.note}` });
  if (next.lifecycle === 'paper_half' && x >= FORWARD_TRADES_TO_FULL && drift.ok) {
    return {
      state: moved(next, 'paper_full', { t, reason: `${x} forward trades complete` }),
      events: [{ t, type: 'strategy_lifecycle', code: 'strategy_full_risk', strategyId: state.strategy_id, severity: 'info', message: `${state.strategy_id} moved to full risk after ${x} forward trades.` }],
    };
  }
  return { state: next, events: [] };
}

/**
 * Stores what step returned for one shadow strategy and counts outcomes inside the range.
 * Only a closed virtual trade has a result to compare, so that is what counts as a
 * forward shadow signal. Leaving the range restarts the count.
 */
export function recordShadowResult(state, result, { certificate } = {}) {
  if (!stateOk(state) || state.lifecycle !== 'shadow' || !isObj(result)) return { state };
  const book = Array.isArray(result.book) ? result.book : state.shadow_book;
  const expected = sealOk(certificate) ? certificate.expected : null;
  let series = state.shadow_series;
  for (const outcome of Array.isArray(result.closed) ? result.closed : []) {
    if (!Number.isFinite(outcome?.returnPct)) continue;
    const trial = [...series, outcome.returnPct].slice(-MAX_SERIES);
    const drift = evaluateDrift(expected, trial);
    series = drift.ok ? trial : [];
  }
  return { state: { ...state, shadow_book: book, shadow_series: series, shadow_in_range: series.length } };
}

/** The only way out of shadow. A human action, never called by the engine. Restarts at half risk. */
export function returnFromShadow(state, { t, by, confirm, strategy, certificate } = {}) {
  const refuse = (reason) => ({ ok: false, reason, state, events: [] });
  if (confirm !== true) return refuse('not_confirmed');
  if (typeof by !== 'string' || !by.trim()) return refuse('no_human_named');
  if (!Number.isFinite(t)) return refuse('invalid_clock');
  if (!stateOk(state) || state.lifecycle !== 'shadow') return refuse('not_in_shadow');
  if (!verifyCertificate(certificate, strategy, t).ok) return refuse('invalid_certificate');
  if (!(state.shadow_in_range >= SHADOW_SIGNALS_TO_RETURN)) return refuse('not_enough_shadow_signals');
  const next = {
    ...moved(state, 'paper_half', { t, by, reason: `Human return after ${state.shadow_in_range} shadow signals in range` }),
    forward_trades: 0, forward_series: [], drift_status: 'warming', drift_note: null, demoted_at: null, demotion_reason: null,
    shadow_series: [], shadow_in_range: 0, shadow_book: [],
  };
  next.size_multiplier = HALF_RISK;
  return {
    ok: true, reason: 'ok', state: next,
    events: [{ t, type: 'strategy_lifecycle', code: 'strategy_returned', strategyId: state.strategy_id, severity: 'warning', message: `${by} returned ${state.strategy_id} to paper at half risk.`, data: { by } }],
  };
}

// ---------- trade outcomes and the history table ----------

/**
 * One outcome per position from trade rows, which split a position across partial exits.
 * returnPct is net percent on the position's notional, so it does not depend on size.
 * Positions not yet flat are left out.
 */
export function tradeOutcomes(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.strategyId}|${r.symbol}|${r.entryTime}`;
    const g = groups.get(key) ?? { pnl: 0, qty: 0, final: null, first: r };
    g.pnl += r.pnl;
    g.qty += r.qty;
    if (!r.partial) g.final = r;
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.final).map((g) => ({
    symbol: g.first.symbol, strategyId: g.first.strategyId, side: g.first.side, entryTime: g.first.entryTime, exitTime: g.final.exitTime,
    returnPct: (g.pnl / (g.first.entryPrice * g.qty)) * 100, rMultiple: g.final.rMultiple,
  }));
}

/**
 * One strategy's entry in the history table: per symbol and side, its DEV outcomes.
 * Throws on anything past DEV, because the holdout must not reach the live table.
 */
export function buildHistoryEntry({ strategy, trades }) {
  const outcomes = tradeOutcomes(trades);
  const symbols = {};
  let from = Infinity, to = -Infinity;
  for (const o of outcomes) {
    if (o.exitTime > DEV_END || o.entryTime > DEV_END) throw new Error(`A ${o.symbol} trade falls past the DEV period`);
    from = Math.min(from, o.entryTime);
    to = Math.max(to, o.exitTime);
    ((symbols[o.symbol] ??= {})[o.side] ??= []).push(o);
  }
  for (const bySide of Object.values(symbols)) {
    for (const [side, list] of Object.entries(bySide)) {
      const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
      const rs = list.map((o) => o.rMultiple).filter(Number.isFinite);
      const wins = rs.filter((r) => r > 0);
      bySide[side] = {
        n: list.length, expectancyPct: round(mean(list.map((o) => o.returnPct))), expectancyR: rs.length ? round(mean(rs)) : null,
        avgWinR: rs.length ? (wins.length ? round(mean(wins)) : 0) : null, winRate: round(list.filter((o) => o.returnPct > 0).length / list.length),
      };
    }
  }
  return { hash: strategyHash(strategy), version: strategy.version, from: outcomes.length ? from : null, to: outcomes.length ? to : null, symbols };
}

export function emptyHistoryTable({ generatedAt }) {
  return { format: HISTORY_FORMAT, generated_at: generatedAt, dev_end: DEV_END, strategies: {} };
}

/** The history row for a signal, or the plain reason there is none. */
function findHistory(history, strategy, signal) {
  if (!isObj(history) || history.format !== HISTORY_FORMAT) return { problem: 'No signal history table' };
  if (!(history.dev_end <= DEV_END)) return { problem: 'History table reaches past the DEV period' };
  const entry = history.strategies?.[strategy.id];
  if (!isObj(entry)) return { problem: `No history for ${strategy.id}` };
  if (entry.hash !== strategyHash(strategy)) return { problem: 'History was built from different code or parameters' };
  if (Number.isFinite(entry.to) && entry.to > DEV_END) return { problem: 'History entry reaches past the DEV period' };
  const row = entry.symbols?.[signal.symbol]?.[signal.side];
  if (!isObj(row) || !(row.n >= 1) || !Number.isFinite(row.expectancyPct)) return { problem: `No DEV history for ${signal.symbol} ${signal.side}` };
  return { row };
}

// ---------- the seven checks ----------

/** Check 1. Also where lifecycle is enforced, so a shadow strategy can never pass preSize. */
export function checkCertificate({ state, certificate, strategy, t }) {
  if (!stateOk(state)) return check('certificate', false, 'Strategy state is missing or unreadable');
  if (state.lifecycle === 'shadow') return check('certificate', false, 'Strategy is in shadow, logged only', [val('lifecycle', state.lifecycle)]);
  if (state.lifecycle !== 'paper_half' && state.lifecycle !== 'paper_full') {
    return check('certificate', false, `Strategy is ${state.lifecycle}, not paper trading`, [val('lifecycle', state.lifecycle)]);
  }
  const v = verifyCertificate(certificate, strategy, t);
  return check('certificate', v.ok, v.reason, [
    val('lifecycle', state.lifecycle), val('code', v.code), val('expires', certificate?.expires_at ?? null), val('hash', certificate?.hash ?? null),
  ]);
}

/** Check 2. Recomputed from the series, so a state that missed its demotion still fails. */
export function checkDrift({ state, certificate }) {
  if (!stateOk(state)) return check('drift', false, 'Strategy state is missing or unreadable');
  if (state.lifecycle === 'shadow') return check('drift', false, state.demotion_reason || 'Strategy is in shadow');
  if (state.drift_status === 'unknown' || state.drift_status === 'breach') return check('drift', false, state.drift_note || `Drift status is ${state.drift_status}`);
  const d = evaluateDrift(certificate?.expected, state.forward_series.map((p) => p.trade_return_pct));
  return check('drift', d.ok, d.note, [val('forward trades', d.n), val('cumulative %', d.cumulative, d.lo === null ? null : `${d.lo} to ${d.hi}`), val('status', d.status)]);
}

/** Check 3. consensus.ok is required on its own: consensus.price is set even when it is false. */
export function checkData({ signal, t, market, consensus, config = DEFAULT_GATE_CONFIG }) {
  const bars = market?.bars?.get?.(signal.symbol);
  const barMs = market?.barMs;
  if (!Array.isArray(bars) || bars.length < 2) return check('data', false, 'No bars');
  if (!(barMs > 0)) return check('data', false, 'Bar length unknown');
  if (bars.meta?.stale || bars.meta?.lastGood) return check('data', false, 'Bars are stale');
  if (bars.meta?.quoteMismatch) return check('data', false, 'Bars are in a different quote currency');

  const last = bars[bars.length - 1];
  const ageMs = t - (last.t + barMs);
  const window = bars.slice(-config.gapWindowBars);
  let gaps = 0;
  for (let i = 1; i < window.length; i++) if (window[i].t - window[i - 1].t !== barMs) gaps++;
  const priced = [last.o, last.h, last.l, last.c].every((x) => x > 0);
  const venues = Array.isArray(consensus?.venues) ? consensus.venues.length : consensus?.venues;
  const spread = consensus?.spreadPct;
  const values = [
    val('bar age ms', ageMs, config.maxBarAgeMs), val('gaps', gaps, 0),
    val('consensus ok', consensus?.ok ?? null, true), val('venues', venues ?? null, config.minConsensusVenues),
    val('spread %', spread ?? null, config.maxConsensusSpreadPct),
  ];
  const fail = (text) => check('data', false, text, values);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > config.maxBarAgeMs) return fail('Last bar is not fresh');
  if (last.t !== market.barT) return fail('Last bar is not the bar being decided on');
  if (!priced) return fail('Last bar has a bad price');
  if (gaps > 0) return fail(`${gaps} gaps in the last ${window.length} bars`);
  if (!isObj(consensus)) return fail('No consensus price');
  if (consensus.ok !== true) return fail(`Exchanges do not agree: ${consensus.reason ?? 'consensus not ok'}`);
  if (!(venues >= config.minConsensusVenues)) return fail('Too few exchanges');
  if (!Number.isFinite(spread) || spread > config.maxConsensusSpreadPct) return fail('Exchange prices are too far apart');
  return check('data', true, `Bars fresh, ${venues} exchanges agree`, values);
}

/**
 * Check 4. Runs the same strategy function on the second venue's bars. Prices are compared
 * first: a venue can list a different project under the same ticker, and an agreeing
 * signal from that coin would mean nothing.
 */
export function checkReplay({ signal, strategy, ctx, replay, config = DEFAULT_GATE_CONFIG }) {
  const { market, t } = ctx;
  const { symbol } = signal;
  const candidates = (Array.isArray(replay) ? replay : [replay]).filter((r) => isObj(r) && Array.isArray(r.bars));
  const refused = [];
  // The first usable venue decides. A disagreement is evidence, so no other venue is tried after one.
  for (const candidate of candidates) {
    const usable = assessReplayVenue(candidate, { symbol, strategy, market, config });
    if (!usable.ok) { refused.push(usable); continue; }
    const { venue, bars } = candidate;
    const replayBars = new Map(market.bars);
    replayBars.set(symbol, bars);
    const again = strategy.signals({
      t, barT: market.barT, bars: replayBars, params: strategy.params, positions: ctx.heldAtSignal ?? ctx.positions,
      regime: ctx.regime, ind: createIndicatorAccess(replayBars), universe: ctx.universe,
    }) || [];
    const side = again.find((x) => x.symbol === symbol)?.side ?? null;
    const values = [...usable.values, val('replay side', side, signal.side)];
    return check('replay', side === signal.side, side === signal.side ? `${venue} replay agrees` : `${venue} replay says ${side ?? 'nothing'}`, values);
  }
  const why = refused.length ? refused.map((r) => r.reason).join('; ') : 'no replay bars';
  return check('replay', false, `Replay unknown: ${why}`, [val('replay status', 'unknown', 'usable venue'), ...refused.flatMap((r) => r.values)]);
}

/** Can this venue's bars count as evidence at all? Says nothing about what they show. */
function assessReplayVenue({ venue, bars }, { symbol, strategy, market, config }) {
  const primary = market.bars.get(symbol);
  const base = [val('venue', venue ?? null, config.replayVenues.join(' or '))];
  const no = (reason, values = base) => ({ ok: false, reason, values });
  if (!config.replayVenues.includes(venue)) return no(`${venue} is not a replay venue`);
  if (primary?.meta?.venue === venue) return no(`Replay venue ${venue} is also the bar source`);
  if (bars.meta?.stale || bars.meta?.lastGood || bars.meta?.quoteMismatch) return no(`${venue} bars are stale or in another quote`);
  if (bars[bars.length - 1]?.t !== market.barT) return no(`${venue} bars do not reach the bar being decided on`);
  if (bars.length < (strategy.warmupBars || 1)) return no(`${venue} has ${bars.length} bars, the strategy needs ${strategy.warmupBars}`);

  const theirs = new Map(bars.map((b) => [b.t, b]));
  const shared = (primary || []).filter((b) => theirs.has(b.t) && b.c > 0);
  const diffs = shared.map((b) => (Math.abs(theirs.get(b.t).c - b.c) / b.c) * 100);
  if (diffs.length < config.replayMinOverlapBars) return no(`Only ${diffs.length} ${venue} bars overlap`);

  const perDay = DAY_MS / (market.barMs > 0 ? market.barMs : DAY_MS);
  const quote = shared.map((b) => theirs.get(b.t).qv * perDay);
  const volume = round(Math.min(medianOf(quote), quote[quote.length - 1]), 2);
  const mismatch = round(Math.max(medianOf(diffs), diffs[diffs.length - 1]), 4);
  const worst = round(Math.max(...diffs), 4);
  const values = [
    ...base,
    val('price mismatch %', Number.isFinite(mismatch) ? mismatch : null, config.replayMaxPriceMismatchPct),
    val('worst bar mismatch %', Number.isFinite(worst) ? worst : null, config.replayGrossPriceMismatchPct),
    val('venue quote volume per day', Number.isFinite(volume) ? volume : null, config.replayMinVenueQuotePerDay),
    val('bars compared', diffs.length, config.replayMinOverlapBars),
  ];
  if (quote.some((q) => !Number.isFinite(q))) return no(`${venue} has no usable volume`, values);
  if (!(volume >= config.replayMinVenueQuotePerDay)) return no(`${venue} volume is near zero, so its prices mean nothing`, values);
  if (!(mismatch <= config.replayMaxPriceMismatchPct)) return no(`${venue} price is ${mismatch}% away: possibly a different coin`, values);
  if (!(worst <= config.replayGrossPriceMismatchPct)) return no(`${venue} had a bar ${worst}% away: its history is not reliable`, values);
  return { ok: true, values };
}

/** Check 5. The cost budget is what the backtest assumed: live cost above it voids the evidence. */
export function checkLiquidity({ signal, sized, book, cost, t, config = DEFAULT_GATE_CONFIG }) {
  if (!isObj(sized) || sized.rejected || !(sized.qty > 0)) return notRun('liquidity', 'Not run: no size');
  const budget = cost?.slipPct;
  if (!(budget > 0)) return check('liquidity', false, 'No cost budget');
  const bids = book?.bids, asks = book?.asks;
  if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) return check('liquidity', false, 'No order book');
  if (book.stale) return check('liquidity', false, 'Order book is stale');
  const ageMs = t - book.t;
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > config.maxBookAgeMs) return check('liquidity', false, 'Order book is too old', [val('age ms', Number.isFinite(ageMs) ? ageMs : null, config.maxBookAgeMs)]);

  const bid = bids[0][0], ask = asks[0][0];
  if (!(bid > 0 && ask > bid)) return check('liquidity', false, 'Order book is crossed or empty');
  const mid = (bid + ask) / 2;
  const spreadPct = round(((ask - bid) / mid) * 100, 4);
  const spreadLimit = 2 * budget; // half the spread is paid on each side
  const levels = signal.side === 'short' ? bids : asks;
  const walked = walkBook(levels, sized.qty);
  const depth = round(levels.reduce((a, [p, q]) => a + p * q, 0), 2);
  const costPct = walked.vwap === null ? null : round((signal.side === 'short' ? mid - walked.vwap : walked.vwap - mid) / mid * 100, 4);
  const values = [val('spread %', spreadPct, spreadLimit), val('depth', depth, round(sized.notional, 2)), val('cost %', costPct, budget)];
  if (spreadPct > spreadLimit) return check('liquidity', false, `Spread ${spreadPct}% is above the ${spreadLimit}% budget`, values);
  if (walked.shortfallQty > 0) return check('liquidity', false, 'Visible depth does not cover the order', values);
  if (!(costPct <= budget)) return check('liquidity', false, `Cost ${costPct}% is above the ${budget}% budget`, values);
  return check('liquidity', true, `Cost ${costPct}% within the ${budget}% budget`, values);
}

/** Check 6. Reads the precomputed table. Zero expectancy passes: the contract says not negative. */
export function checkHistory({ signal, strategy, history }) {
  const { row, problem } = findHistory(history, strategy, signal);
  if (problem) return check('history', false, problem);
  const note = row.n < SMALL_SAMPLE ? ', small sample' : '';
  const values = [val('expectancy % net', row.expectancyPct, 0), val('expectancy R', row.expectancyR), val('n', row.n)];
  return check('history', row.expectancyPct >= 0, `Expectancy ${row.expectancyPct}% net, n = ${row.n} on DEV${note}`, values);
}

/**
 * Check 7. A trend exit has no fixed target, so reward is measured, not assumed: the
 * average winning trade in R on this symbol's DEV history.
 */
export function checkRisk({ signal, strategy, sized, exitPlan, history }) {
  if (!(signal.stopDistancePct > 0 && signal.stopDistancePct < 1)) return check('risk', false, 'No stop');
  if (!isObj(sized) || sized.rejected || !(sized.qty > 0)) return check('risk', false, `Sizing refused it: ${sized?.reason ?? 'no size'}`);
  if (!isObj(exitPlan) || !(exitPlan.hardStopPrice > 0)) return check('risk', false, 'No exit plan with a stop');
  const warnings = exitPlan.warnings || [];
  if (warnings.includes('no_stop_given') || warnings.includes('stop_wrong_side')) return check('risk', false, 'The exit plan could not use the signal\'s stop');
  const need = exitPlan.minRewardRisk;
  if (!(need > 0)) return check('risk', false, 'Exit plan has no minimum reward:risk');
  const { row, problem } = findHistory(history, strategy, signal);
  const reward = row?.avgWinR;
  const values = [val('reward:risk', Number.isFinite(reward) ? reward : null, need), val('size limit', sized.limit ?? sized.reason ?? null), val('stop %', round(signal.stopDistancePct * 100, 2))];
  if (problem || !Number.isFinite(reward)) return check('risk', false, problem || 'No measured reward:risk', values);
  return check('risk', reward >= need, `Reward:risk ${reward} against a minimum of ${need}`, values);
}

// ---------- shadow book ----------

const DEFAULT_SHADOW_COST = Object.freeze({ feePct: 0.10, slipPct: 0.25 });

/**
 * Moves one shadow strategy's virtual trades on by a bar, through the real exit plans.
 * A virtual trade fills at the next bar's open and pays the cost model both ways, so its
 * result is comparable with a backtest trade. Exits decided at a close use that close,
 * where a real one would wait for the next open.
 * @returns {{ book: object[], closed: { symbol: string, returnPct: number, reasonCode: string, t: number }[] }}
 */
export function advanceShadowBook(book, { t, market, ind, regime, signals = [], strategy, opens = [], config = {}, tightenTrails = false, modules = {} }) {
  const evaluate = modules.exits?.evaluateExit ?? evaluateExit;
  const next = [], closed = [];
  for (const held of book) {
    let v = held;
    const series = market.bars.get(v.symbol);
    const bar = series?.[series.length - 1];
    const waiting = v.pending ? !(bar?.t > v.barT) : bar?.t === v.position.lastBarT;
    if (!bar || waiting) { next.push(v); continue; }

    const cost = market.costFor?.(v.symbol, strategy) ?? DEFAULT_SHADOW_COST;
    const dir = v.side === 'short' ? -1 : 1;
    if (v.pending) {
      const price = bar.o * (1 + (dir * cost.slipPct) / 100);
      const fields = entryPositionFields({
        intent: { side: v.side, signal: { stopDistancePct: v.stopDistancePct, exitProfile: v.exitProfile }, atr: v.atr, reason: v.reason, regime: v.regime },
        fill: { price, qty: 1 }, cost, modules, exitConfig: exitConfigFor(strategy, config, market),
      });
      v = {
        symbol: v.symbol, strategyId: v.strategyId, side: v.side, pending: false, remaining: 1, realisedPct: 0,
        position: { symbol: v.symbol, strategyId: v.strategyId, side: v.side, qty: 1, entryPrice: price, entryTime: bar.t, ...fields },
      };
    }

    const decision = evaluate({
      position: v.position, bar, atr: ind(v.symbol, 'atr', 14), signal: signals.find((s) => s.symbol === v.symbol) ?? null, regime, t,
      config: { ...exitConfigFor(strategy, config, market), costs: cost, tightenTrails },
    });
    if (decision.action === 'exit' || decision.action === 'reduce') {
      const hint = decision.fillHint;
      const stop = hint?.kind === 'stop';
      const base = stop ? (hint.price ?? Math.min(v.position.stopPrice, bar.o)) : hint?.kind === 'target' ? hint.price : bar.c;
      const exitPrice = base * (1 - (dir * (cost.slipPct + (stop ? STOP_EXTRA_SLIP_PCT : 0))) / 100);
      const pct = (dir * (exitPrice - v.position.entryPrice) / v.position.entryPrice) * 100 - 2 * cost.feePct;
      const part = decision.action === 'exit' ? v.remaining : v.remaining * decision.fraction;
      v = { ...v, realisedPct: v.realisedPct + part * pct, remaining: v.remaining - part };
      if (decision.action === 'exit' || v.remaining <= 1e-9) {
        closed.push({ symbol: v.symbol, returnPct: v.realisedPct, reasonCode: decision.reasonCode, t });
        continue;
      }
    }
    next.push({ ...v, position: { ...applyExitResult(v.position, decision), lastBarT: bar.t } });
  }
  for (const o of opens) if (!next.some((v) => v.symbol === o.symbol)) next.push({ ...o, pending: true });
  return { book: next, closed };
}

// ---------- the gate ----------

function guarded(id, fn) {
  try {
    return fn();
  } catch (err) {
    return check(id, false, `Check failed to run: ${err.message}`);
  }
}

function verdictOf(stage, checks, sizeMultiplier) {
  const failed = checks.find((c) => c.status !== 'pass');
  return {
    ok: !failed, stage, reason: failed ? `${labelOf(failed.id)}: ${failed.text}` : 'ok',
    blockedBy: failed?.id ?? null, checks, sizeMultiplier,
  };
}

/**
 * Builds the object step takes as `gate`, for one tick. Missing data fails closed.
 * @param {object} a
 * @param {Map|object} a.states strategyId -> V6StrategyState
 * @param {Map|object} a.certificates strategyId -> V6Certificate
 * @param {{ consensus?: Map, replay?: Map, books?: Map, history?: object }} [a.data]
 * @param {object} [a.config] overrides of DEFAULT_GATE_CONFIG
 */
export function createSignalGate({ states, certificates, data = {}, config = {} } = {}) {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };
  const stateOf = (strategy) => lookup(states, strategy?.id);
  const certOf = (strategy) => lookup(certificates, strategy?.id);
  return {
    modeFor(strategy) {
      return stateOf(strategy)?.lifecycle === 'shadow' ? 'shadow' : 'trade';
    },

    preSize(signal, ctx) {
      const { strategy, t, market } = ctx;
      const state = stateOf(strategy), certificate = certOf(strategy);
      return verdictOf('preSize', [
        guarded('certificate', () => checkCertificate({ state, certificate, strategy, t })),
        guarded('drift', () => checkDrift({ state, certificate })),
        guarded('data', () => checkData({ signal, t, market, consensus: lookup(data.consensus, signal.symbol), config: cfg })),
        guarded('replay', () => checkReplay({ signal, strategy, ctx, replay: lookup(data.replay, signal.symbol), config: cfg })),
        guarded('history', () => checkHistory({ signal, strategy, history: data.history })),
      ], sizeMultiplierFor(state));
    },

    postSize(signal, ctx) {
      const { strategy, t, sized, exitPlan, cost } = ctx;
      return verdictOf('postSize', [
        guarded('liquidity', () => checkLiquidity({ signal, sized, book: lookup(data.books, signal.symbol), cost, t, config: cfg })),
        guarded('risk', () => checkRisk({ signal, strategy, sized, exitPlan, history: data.history })),
      ], sizeMultiplierFor(stateOf(strategy)));
    },

    advanceShadow({ t, market, ind, regime, signalsByStrategy, strategyById, opens, config: stepConfig, tightenTrails, modules }) {
      const out = {};
      for (const [id, strategy] of strategyById) {
        const state = stateOf(strategy);
        if (state?.lifecycle !== 'shadow') continue;
        out[id] = advanceShadowBook(state.shadow_book || [], {
          t, market, ind, regime, signals: signalsByStrategy.get(id) || [], strategy, opens: opens.filter((o) => o.strategyId === id),
          config: stepConfig, tightenTrails, modules,
        });
      }
      return out;
    },
  };
}
