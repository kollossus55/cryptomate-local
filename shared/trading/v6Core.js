/**
 * V6 core: the single decision path, shared by the simulator and the live worker.
 *
 * step() is pure: state and market in, intents out. It never fills anything and
 * never reads a clock. The order inside it is fixed by the contract:
 *   1. mark to market
 *   2. exits (stops, trails, time, regime, signal), never blocked by anything
 *   3. risk state update
 *   4. entries, only if the risk state allows:
 *      signals -> gate.preSize -> size -> gate.postSize -> intents
 *
 * The gate fails closed. No gate, a gate that throws, or a verdict that does not show
 * every check of its stage passing means no entry. The one exception is a market built
 * on the simulator's prepared history: see resolveGate. Exits never consult the gate.
 *
 * Time. `t` always means the DECISION CLOCK, in sim and live alike: at or after the
 * CLOSE of the last bar in market.bars, never a bar's open. In the simulator
 * t = bar.t + barMs. v6Exits counts bars held as floor((t - entryTime) / barMs), so a
 * position filled at the open of bar k has barsHeld 1 at the close of bar k.
 * market.barT is the OPEN time of the last closed bar, the same `t` bars carry.
 *
 * market.barMs and market.costFor must always be set: without them the exit engine
 * assumes daily bars and Tier 3 costs. A missing barMs raises an alarm every step.
 *
 * Fill modes on exit intents, read by whoever executes them:
 *   'stop'   a resting stop was touched inside the bar just closed. It fills inside
 *            that bar, at the worse of stop and open, plus stop slippage.
 *   'limit'  a resting target was touched, and the stop was not.
 *   'market' a decision taken at the close. It fills at the next bar's open.
 *
 * Units: v6Paper costs are PERCENT (0.10 = 0.10%), v6Risk costs are FRACTIONS
 * (0.001). market.costFor returns v6Paper's form; toRiskCosts converts for v6Risk.
 *
 * Thin books: an exit can fill partly. Whoever applies fills must then persist
 * exitRemainderPatch(fill) on the position, and step() re-emits the exit on every
 * call until the position is flat, whatever the bar or the signals say.
 */
import * as realExits from './v6Exits.js';
import { toRiskCosts } from './v6Paper.js';
import * as realRisk from './v6Risk.js';

// ---------- indicators ----------
// Each takes the bars so far and returns an array aligned with them, NaN until warm.
// Every value depends only on bars at or before its index, in one forward pass:
// the simulator computes these once over a whole series, relying on exactly that.
// tests/v6Core.test.mjs checks that truncating the bars never changes earlier values.

/** Simple moving average of a bar field. */
export function sma(bars, n, field = 'c') {
  const out = new Float64Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i][field];
    if (i >= n) sum -= bars[i - n][field];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first n values. */
export function ema(bars, n, field = 'c') {
  const out = new Float64Array(bars.length).fill(NaN);
  const k = 2 / (n + 1);
  let v = 0;
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i][field];
    if (i < n - 1) v += x;
    else if (i === n - 1) { v = (v + x) / n; out[i] = v; } else { v += k * (x - v); out[i] = v; }
  }
  return out;
}

/** Wilder's average true range, seeded with the mean of the first n true ranges. */
export function atr(bars, n = 14) {
  const out = new Float64Array(bars.length).fill(NaN);
  let v = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n - 1) v += tr;
    else if (i === n - 1) { v = (v + tr) / n; out[i] = v; } else { v = (v * (n - 1) + tr) / n; out[i] = v; }
  }
  return out;
}

/** Rate of change over n bars: 0.10 means +10%. */
export function roc(bars, n, field = 'c') {
  const out = new Float64Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) out[i] = bars[i][field] / bars[i - n][field] - 1;
  return out;
}

function rollingExtreme(bars, n, field, better) {
  const out = new Float64Array(bars.length).fill(NaN);
  const q = new Int32Array(bars.length);
  let head = 0, tail = 0;
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i][field];
    while (tail > head && !better(bars[q[tail - 1]][field], x)) tail--;
    q[tail++] = i;
    if (q[head] <= i - n) head++;
    if (i >= n - 1) out[i] = bars[q[head]][field];
  }
  return out;
}

/**
 * Highest high of the last n bars INCLUDING the current one. A close can never
 * exceed its own bar's high, so a breakout test must use lag 1:
 * c > ctx.ind(s, 'donchianHigh', 20, 1).
 */
export function donchianHigh(bars, n) { return rollingExtreme(bars, n, 'h', (a, b) => a > b); }
/** Lowest low of the last n bars including the current one. Use lag 1 for a breakdown test. */
export function donchianLow(bars, n) { return rollingExtreme(bars, n, 'l', (a, b) => a < b); }

/** Annualised standard deviation of log returns over the last n bars. */
export function realisedVol(bars, n = 30, periodsPerYear = 365) {
  const out = new Float64Array(bars.length).fill(NaN);
  let s = 0, s2 = 0;
  const lr = new Float64Array(bars.length);
  for (let i = 1; i < bars.length; i++) {
    const r = Math.log(bars[i].c / bars[i - 1].c);
    lr[i] = r; s += r; s2 += r * r;
    if (i > n) { s -= lr[i - n]; s2 -= lr[i - n] * lr[i - n]; }
    if (i >= n) {
      const v = (s2 - (s * s) / n) / (n - 1);
      out[i] = Math.sqrt(Math.max(0, v) * periodsPerYear);
    }
  }
  return out;
}

export const INDICATORS = { sma, ema, atr, roc, donchianHigh, donchianLow, realisedVol };

/** Indicator readers bound to the simulator's prepared series. See resolveGate. */
const PREPARED_HISTORY = new WeakSet();

/**
 * Builds ctx.ind(symbol, name, args, lag): an indicator value as of the last closed bar.
 *   ctx.ind('BTCUSDT', 'sma', 100)        latest 100-bar SMA
 *   ctx.ind('BTCUSDT', 'sma', 100, 1)     the same, one bar earlier
 *   ctx.ind('BTCUSDT', 'realisedVol', [30, 365])
 * `name` may also be your own function (bars, ...args) -> array. It is handed only
 * the bars visible now and recomputed every step, so it cannot look ahead, but it
 * is slower than the built-ins. A negative lag throws: that would be the future.
 *
 * @param {Map<string, object[]>} bars visible bars
 * @param {(symbol: string) => ({ bars: object[], cache: Map }|null)} [series] the
 *   simulator's full series. Built-ins are computed once over it; `bars` still
 *   bounds what can be read, so this is a speed-up and not a window on the future.
 */
export function createIndicatorAccess(bars, series) {
  const local = new Map();
  const custom = new Map();
  const ind = function ind(symbol, name, args = [], lag = 0) {
    if (!(lag >= 0)) throw new Error(`ind(${symbol}): lag must be >= 0, got ${lag}. A negative lag is the future.`);
    const visible = bars.get(symbol);
    const i = visible ? visible.length - 1 - lag : -1;
    if (i < 0) return NaN;
    const a = Array.isArray(args) ? args : [args];

    if (typeof name === 'function') {
      const key = `${symbol}|${a.join(',')}`;
      let perFn = custom.get(name);
      if (!perFn) custom.set(name, perFn = new Map());
      let hit = perFn.get(key);
      if (!hit || hit.len !== visible.length) {
        hit = { len: visible.length, values: name(visible, ...a) };
        perFn.set(key, hit);
      }
      return hit.values[i] ?? NaN;
    }

    const fn = INDICATORS[name];
    if (!fn) throw new Error(`Unknown indicator "${name}". Built-ins: ${Object.keys(INDICATORS).join(', ')}`);
    const key = `${name}:${a.join(',')}`;
    const full = series?.(symbol);
    if (full) {
      let values = full.cache.get(key);
      if (!values) full.cache.set(key, values = fn(full.bars, ...a));
      return values[i];
    }
    // Live path: a fresh array of closed bars each tick, so key the memo on its last bar.
    let entry = local.get(symbol);
    const lastT = visible[visible.length - 1].t;
    if (!entry || entry.len !== visible.length || entry.lastT !== lastT) {
      local.set(symbol, entry = { len: visible.length, lastT, values: new Map() });
    }
    let values = entry.values.get(key);
    if (!values) entry.values.set(key, values = fn(visible, ...a));
    return values[i];
  };
  if (series) PREPARED_HISTORY.add(ind);
  return ind;
}

// ---------- positions ----------

const dirOf = (side) => (side === 'short' ? -1 : 1);

/**
 * Value of a position at a price, matching v6Paper.ledgerEquity. Positions are fully
 * collateralised, so a short is its collateral plus the P&L. A planned position that
 * has no ledger entry yet falls back to its entry notional.
 */
export function positionValue(p, price) {
  const collateral = p.collateral ?? p.qty * p.entryPrice;
  return collateral + dirOf(p.side) * p.qty * (price - p.entryPrice);
}

/**
 * Which stop this bar touched, by order of events, or null. The range meets the stop in
 * force when the bar began, and the close the stop in force at the close.
 * laterPrice marks the second case: the bar's open came before that stop, so it cannot price the fill.
 */
function stopTouch(p, bar, barMs = 0) {
  const dir = dirOf(p.side);
  const barStop = realExits.stopAt(p, bar.t);
  if (barStop !== null && dir * ((dir > 0 ? bar.l : bar.h) - barStop) <= 0) return { stopPrice: barStop };
  const closeStop = realExits.stopAt(p, bar.t + barMs);
  if (closeStop !== null && closeStop !== barStop && dir * (bar.c - closeStop) <= 0) {
    return { stopPrice: closeStop, laterPrice: bar.c };
  }
  return null;
}

export function stopTouched(p, bar, barMs) {
  return stopTouch(p, bar, barMs) !== null;
}

/** The raw price a touched stop gets: the worse of the stop and the bar's open. Gaps are not forgiven. */
export function stopFillBase(p, bar) {
  return p.side === 'short' ? Math.max(p.stopPrice, bar.o) : Math.min(p.stopPrice, bar.o);
}

const REGIME_DAYS = 200;
const DAY_MS = 86400000;

/**
 * Regime from BTC's closed bars, for ctx.regime and regime exits.
 * `riskOn` is null until there are enough bars to say.
 */
export function computeRegime(ind, symbol = 'BTCUSDT', n = REGIME_DAYS, bars = null) {
  const v = ind(symbol, 'sma', n);
  const series = bars?.get(symbol);
  const c = series?.length ? series[series.length - 1].c : NaN;
  if (!Number.isFinite(v) || !Number.isFinite(c)) return { riskOn: null, label: 'unknown', btcClose: c, btcSma: v };
  const riskOn = c > v;
  return { riskOn, label: riskOn ? 'risk_on' : 'risk_off', btcClose: c, btcSma: v };
}

/** What the exit module needs, per strategy: its overrides, bar length and costs. */
export function exitConfigFor(strategy, config, market) {
  return {
    ...config.exits,
    overrides: strategy?.exitOverrides ?? config.exits?.overrides,
    barMs: market?.barMs ?? config.exits?.barMs,
  };
}

/**
 * The position patch after an exit fill, or null when nothing is left to chase.
 * A partial exit fill leaves a remainder, and the condition that caused the exit may
 * not fire again, so the intent to leave is stored on the position.
 */
export function exitRemainderPatch(fill) {
  if (fill?.type !== 'exit' || fill.status !== 'partial') return null;
  return { exitPending: { reasonCode: fill.reasonCode, reason: fill.reason } };
}

/**
 * Position fields for an entry fill, to go in fill.positionFields before applyFill.
 * Sim and live both call this, so stops and exit plans come from one place. The stop
 * distance applies to the actual fill, not the signal's reference price.
 */
export function entryPositionFields({ intent, fill, exitConfig, cost, modules = {} }) {
  const exits = modules.exits || realExits;
  const price = fill.price;
  const dist = intent.signal.stopDistancePct;
  const stopPrice = intent.side === 'short' ? price * (1 + dist) : price * (1 - dist);
  const fields = {
    stopPrice, initialStopPrice: stopPrice, highWater: price, lowWater: price, partialsTaken: [],
    exitProfile: intent.signal.exitProfile, barsHeld: 0,
    riskAtEntry: fill.qty * Math.abs(price - stopPrice), lastBarT: null, entryReason: intent.reason,
  };
  fields.exitPlan = exits.createExitPlan({
    position: { side: intent.side, entryPrice: price, ...fields },
    profile: fields.exitProfile, atr: intent.atr, config: { ...exitConfig, costs: cost, regime: intent.regime },
  });
  return fields;
}

/**
 * Benchmark sizing: a fixed weight of equity per position, no ladder or breakers. It
 * exists so buy-and-hold and legacy rules can be measured at full exposure, which
 * the real risk engine would never allow. Never use it to judge a candidate.
 * @param {{ weight?: number }} [opts]
 */
export function fullWeightRisk({ weight = 1 } = {}) {
  return {
    DEFAULT_RISK_CONFIG: {},
    initialRiskState: (equity, t) => ({ equity, t }),
    updateRiskState: (riskState, { t, equity }) => ({ riskState: { ...riskState, t, equity }, events: [] }),
    canEnter: () => ({ ok: true, reason: 'ok' }),
    riskDirectives: () => ({ entriesAllowed: true, sizeMultiplier: 1, flatten: false, tightenTrails: false }),
    sizeEntry({ signal, price, equity }) {
      const notional = equity * weight;
      return { qty: notional / price, notional, riskAmount: notional * signal.stopDistancePct, rejected: false, reason: 'full_weight' };
    },
  };
}

// ---------- the signal gate, as step sees it ----------

/** The seven checks, numbered as in the contract, and the stage each runs in. */
export const GATE_CHECKS = Object.freeze([
  { id: 'certificate', stage: 'preSize', label: 'Certificate' },
  { id: 'drift', stage: 'preSize', label: 'Forward drift' },
  { id: 'data', stage: 'preSize', label: 'Data' },
  { id: 'replay', stage: 'preSize', label: 'Cross-venue replay' },
  { id: 'liquidity', stage: 'postSize', label: 'Liquidity' },
  { id: 'history', stage: 'preSize', label: 'Historical' },
  { id: 'risk', stage: 'postSize', label: 'Risk' },
].map(Object.freeze));

/** These two say why a strategy is in shadow, so they cannot decide what it would have done. */
const SHADOW_IGNORES = new Set(['certificate', 'drift']);

/** For the simulator and tests only. The live worker must always pass a real gate. */
export const PASS_THROUGH_GATE = Object.freeze({
  modeFor: () => 'trade',
  preSize: () => ({ ok: true }),
  postSize: () => ({ ok: true }),
});

const PASSED = Object.freeze({ ok: true });

/**
 * The gate step will use. An explicit gate always wins. With none, only a market reading
 * the simulator's prepared history gets the pass-through, because v6Sim calls step without
 * a gate. createIndicatorAccess marks that history when it is given a series source, which
 * a worker has no reason to do. Everything else gets null, which refuses every entry.
 */
function resolveGate(gate, market) {
  if (gate) return gate;
  return PREPARED_HISTORY.has(market.ind) ? PASS_THROUGH_GATE : null;
}

function runGateStage(gate, stage, signal, ctx) {
  if (typeof gate?.[stage] !== 'function') return { ok: false, reason: 'No signal gate', blockedBy: 'no_gate', checks: [] };
  try {
    return gate[stage](signal, ctx) ?? { ok: false, reason: 'The signal gate gave no verdict', blockedBy: 'gate_error', checks: [] };
  } catch (err) {
    return { ok: false, reason: `Signal gate failed: ${err.message}`, blockedBy: 'gate_error', checks: [] };
  }
}

/** ok alone is not enough: a verdict must show each check of its stage passing. */
function stagePassed(gate, stage, verdict) {
  if (verdict?.ok !== true) return false;
  if (gate === PASS_THROUGH_GATE) return true;
  return GATE_CHECKS.every((c) => c.stage !== stage || verdict.checks?.find((x) => x.id === c.id)?.status === 'pass');
}

function gateMode(gate, strategy) {
  try { return gate?.modeFor?.(strategy) === 'shadow' ? 'shadow' : 'trade'; } catch { return 'trade'; }
}

/** All seven results in contract order. Anything the gate did not report is not_run, never a pass. */
function mergeChecks(...verdicts) {
  const reported = verdicts.flatMap((v) => (Array.isArray(v?.checks) ? v.checks : []));
  return GATE_CHECKS.map((c) => reported.find((x) => x.id === c.id) ?? { id: c.id, status: 'not_run', text: 'Not run', values: [] });
}

/** Shaped as a V6SignalTest row, so the worker can store it as it stands. */
function signalTestEvent({ t, market, strategy, signal, rank, batch, outcome, rejectCode, verdict, notTestedReason, pre, post }) {
  return {
    t, type: 'signal_test', bar_time: market.barT, symbol: signal.symbol, strategy_id: strategy.id, side: signal.side,
    reason: signal.reason ?? null, rank_in_batch: rank, batch_size: batch, outcome,
    reject_code: rejectCode ?? null, blocked_by: verdict?.blockedBy ?? null, blocked_text: verdict?.reason ?? null,
    not_tested_reason: notTestedReason ?? null, checks: mergeChecks(pre, post),
    exit_profile: signal.exitProfile ?? null, stop_distance_pct: signal.stopDistancePct ?? null, trade_id: null,
  };
}

// ---------- step ----------

function normalizeFill(decision, position, bar) {
  const hint = decision.fillHint;
  if (hint?.kind === 'stop') {
    const stopped = { ...position, stopPrice: hint.stopPrice ?? position.stopPrice };
    const seen = Number.isFinite(hint.laterPrice) ? { ...bar, o: hint.laterPrice } : bar;
    return { mode: 'stop', price: stopFillBase(stopped, seen), stopPrice: stopped.stopPrice, bar: seen };
  }
  if (hint?.kind === 'target' && Number.isFinite(hint.price)) return { mode: 'limit', price: hint.price, bar };
  return { mode: 'market', price: null };
}

/**
 * The one decision path.
 *
 * @param {object} a
 * @param {number} a.t decision time
 * @param {{ cash: number, quarantine?: { value: number, unknown: number } }} a.account
 * @param {Map<string, object>} a.positions
 * @param {{ bars: Map, prices: Map, health?: object, barT: number, barMs?: number,
 *           universeFor?: (strategy: object) => string[], ind?: Function,
 *           costFor?: (symbol: string, strategy: object) => object,
 *           periodsPerYear?: number, regime?: object, isNewBar?: boolean }} a.market
 *   isNewBar false means a live tick inside a bar already decided on: stops and
 *   exits still run on the live price, but no strategy is asked for new signals.
 * @param {object[]} a.strategies
 * @param {object} a.config { risk, exits, sizeMultipliers, volBars, correlationBars }
 * @param {{ preSize: Function, postSize: Function, modeFor?: Function, advanceShadow?: Function }} [a.gate]
 *   see v6SignalGate.createSignalGate. Without one, no entry happens.
 * @param {object} a.riskState
 * @param {{ risk?: object, exits?: object }} [a.modules] injectable, for benchmarks and tests
 * @returns {{ intents: object[], riskState: object, events: object[],
 *             updates: { symbol: string, patch: object }[], equity: number, shadow: ?object }}
 *   `updates` carries stop ratchets and bookkeeping for the caller to apply: the
 *   intent shape has no place for them, and step() must not mutate its inputs.
 *   `events` holds one `signal_test` per entry signal, except under the pass-through.
 *   `shadow` is { [strategyId]: { book, closed } } for v6SignalGate.recordShadowResult.
 */
export function step({ t, account, positions, market, strategies, config = {}, gate, riskState, modules = {} }) {
  const risk = modules.risk || realRisk;
  const exits = modules.exits || realExits;
  const riskConfig = config.risk || risk.DEFAULT_RISK_CONFIG;
  const tightenTrails = risk.riskDirectives(riskState).tightenTrails === true;
  const strategyById = new Map(strategies.map((s) => [s.id, s]));
  const events = [], intents = [], updates = [];
  const ind = market.ind || createIndicatorAccess(market.bars);
  // A 200-day span on any timeframe, as in v6Sim. Without barMs, bars are taken as daily (see the alarm below).
  const regimeBars = market.barMs > 0 ? Math.round((REGIME_DAYS * DAY_MS) / market.barMs) : REGIME_DAYS;
  const regime = market.regime ?? computeRegime(ind, 'BTCUSDT', regimeBars, market.bars);
  const isNewBar = market.isNewBar !== false;
  const activeGate = resolveGate(gate, market);
  const testing = activeGate !== PASS_THROUGH_GATE;
  if (!(market.barMs > 0)) events.push({ t, type: 'alarm', code: 'missing_bar_ms', message: 'market.barMs is not set: time stops will assume daily bars.' });

  // 1. Mark to market. A missing price means stale data: keep the last good one and say so.
  const marks = new Map();
  // Rows set aside by the ledger still count at their last known value.
  let equity = account.cash + (account.quarantine?.value ?? 0);
  for (const [symbol, p] of positions) {
    let price = market.prices.get(symbol);
    if (!Number.isFinite(price)) {
      price = p.lastPrice;
      events.push({ t, type: 'alarm', code: 'stale_price', symbol, message: `No fresh price for ${symbol}; using the last good price ${price}.` });
    }
    marks.set(symbol, price);
    equity += positionValue(p, price);
  }

  // Signals are read here but acted on in stages 2 and 4. A throwing strategy loses
  // its signals for this step and nothing else: it must never stop a position leaving.
  const universes = new Map();
  const universeOf = (strategy) => {
    let u = universes.get(strategy.id);
    if (!u) universes.set(strategy.id, u = eligibleUniverse(strategy, market));
    return u;
  };
  const signalsByStrategy = new Map();
  if (isNewBar) {
    for (const strategy of strategies) {
      let signals = [];
      try {
        signals = strategy.signals({
          t, barT: market.barT, bars: market.bars, params: strategy.params, positions, regime, ind,
          universe: universeOf(strategy),
        }) || [];
      } catch (err) {
        if (config.rethrowStrategyErrors) throw err;
        events.push({ t, type: 'alarm', code: 'strategy_error', strategyId: strategy.id, message: err.message });
      }
      signalsByStrategy.set(strategy.id, signals);
    }
  }

  // 2. Exits. Nothing above or below this block can veto one.
  const exiting = new Set();
  let projected = equity;
  for (const [symbol, p] of positions) {
    const closedBar = lastBar(market.bars, symbol);
    const mark = marks.get(symbol);
    // A closed bar counts once, and only if it began after the position existed.
    // Otherwise each later tick would re-test a ratcheted stop against the same old low.
    const fresh = closedBar && closedBar.t !== p.lastBarT && closedBar.t >= p.entryTime && isNewBar;
    const bar = fresh ? closedBar : { t, o: mark, h: mark, l: mark, c: mark, v: 0, qv: 0 };
    const signal = (signalsByStrategy.get(p.strategyId) || []).find((s) => s.symbol === symbol) || null;
    const atrNow = ind(symbol, 'atr', 14);

    let decision;
    try {
      decision = exits.evaluateExit({
        position: p, bar, atr: atrNow, signal, regime, t,
        config: {
          ...exitConfigFor(strategyById.get(p.strategyId), config, market),
          costs: market.costFor?.(symbol, strategyById.get(p.strategyId)), tightenTrails,
        },
      });
    } catch (err) {
      decision = { action: 'hold' };
      events.push({ t, type: 'alarm', code: 'exit_error', symbol, message: err.message });
    }

    // A backstop, not the normal path. v6Exits tests a stop at least as protective as
    // p.stopPrice before anything else, so with a working exit module this never fires
    // and hard_stop, breakeven_stop and trail_stop stay as it labelled them. It is for an
    // exit module that failed or a replacement that forgot. It has its own reason code
    // because it cannot know which kind of stop this was.
    const touch = stopTouch(p, bar, market.barMs);
    if (touch && decision?.fillHint?.kind !== 'stop') {
      decision = {
        ...decision, action: 'exit', fraction: 1, reasonCode: 'stop_guard',
        reason: `Stop ${touch.stopPrice} touched; the exit module did not report it.`,
        fillHint: { kind: 'stop', ...touch },
      };
      events.push({ t, type: 'alarm', code: 'stop_guard', symbol, message: decision.reason });
    }

    // The remainder of a part-filled exit leaves now, unless something better already fired.
    if (p.exitPending && decision?.action !== 'exit') {
      decision = { ...decision, action: 'exit', fraction: 1, ...p.exitPending, fillHint: { kind: 'next_open' } };
    }

    // decision.update holds the ratcheted stop, water marks and plan state. A new
    // stop binds from the next bar on: a trail derived from this bar's high cannot
    // catch this bar's low. Only ever accept a protective move, whoever proposed it.
    const patch = { ...decision?.update, lastPrice: mark };
    if (fresh) patch.lastBarT = closedBar.t;
    if (Number.isFinite(patch.stopPrice)) {
      const looser = p.side === 'short' ? patch.stopPrice > p.stopPrice : patch.stopPrice < p.stopPrice;
      if (looser) patch.stopPrice = p.stopPrice;
    } else delete patch.stopPrice;
    // A stop decided on a closed bar counts as set at that close, so it covers the whole
    // next bar, as in the simulator. A stop moved by a tick counts from the tick.
    if ((patch.stopPrice ?? p.stopPrice) !== p.stopPrice) {
      const setAt = fresh && market.barMs > 0 ? closedBar.t + market.barMs : t;
      Object.assign(patch, realExits.recordStop(p, patch.stopPrice, setAt));
    }
    updates.push({ symbol, patch });

    if (decision?.action === 'exit' || decision?.action === 'reduce') {
      const full = decision.action === 'exit' || !(decision.fraction < 1);
      const fill = normalizeFill(decision, p, bar);
      const qty = full ? p.qty : p.qty * decision.fraction;
      intents.push({
        type: full ? 'exit' : 'reduce', symbol, strategyId: p.strategyId, side: p.side, qty,
        reason: decision.reason, reasonCode: decision.reasonCode, refPrice: mark, fill,
      });
      if (full) exiting.add(symbol);
      if (fill.mode !== 'market') projected += qty * dirOf(p.side) * (fill.price - mark);
    }
  }

  // 3. Risk state. Uses equity after this step's in-bar fills, so a stop that fired
  // in this bar counts towards the drawdown ladder at once.
  const btcBars = market.bars.get(config.btcSymbol || 'BTCUSDT') || [];
  const updated = risk.updateRiskState(riskState, {
    t, equity: projected, btcBars, dataHealth: market.health, config: riskConfig,
    equityUnknown: account.quarantine?.unknown > 0,
    // Positions leaving in this step do not count: only an explicit 0 means flat.
    openPositions: positions.size - exiting.size,
  });
  let nextRisk = updated.riskState;
  events.push(...updated.events);

  // Only the directive flattens. A manual or fail-safe halt stops entries but must
  // not dump positions, so halt.active on its own is deliberately not the test.
  if (risk.riskDirectives(nextRisk).flatten) {
    for (const [symbol, p] of positions) {
      if (exiting.has(symbol)) continue;
      exiting.add(symbol);
      intents.push({
        type: 'exit', symbol, strategyId: p.strategyId, side: p.side, qty: p.qty,
        reason: 'Risk engine ordered flat', reasonCode: 'risk_flatten', refPrice: marks.get(symbol),
        fill: { mode: 'market', price: null },
      });
    }
  }

  // 4. Entries.
  if (!isNewBar) return { intents, riskState: nextRisk, events, updates, equity: projected, shadow: null };
  const allowed = risk.canEnter(nextRisk);
  const planned = new Map(positions);
  for (const symbol of exiting) planned.delete(symbol);
  // Cash the entries may spend: exits fill first, so their proceeds count.
  let spendable = account.cash;
  for (const intent of intents) {
    const price = intent.fill.mode === 'market' ? intent.refPrice : intent.fill.price;
    const p = positions.get(intent.symbol);
    spendable += positionValue(p, price) * (intent.qty / p.qty);
  }
  const volOf = (symbol) => ind(symbol, 'realisedVol', [config.volBars ?? 30, market.periodsPerYear ?? 365]);
  const correlations = new Map();
  const tailLogs = new Map();

  const shadowOpens = [];
  if (!activeGate && [...signalsByStrategy.values()].some((list) => list.some((x) => x.side === 'long' || x.side === 'short'))) {
    events.push({ t, type: 'alarm', code: 'no_gate', message: 'No signal gate was supplied, so every entry is refused.' });
  }

  for (const strategy of strategies) {
    const wanted = (signalsByStrategy.get(strategy.id) || [])
      .filter((s) => s.side === 'long' || s.side === 'short')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (!wanted.length) continue;
    const shadow = gateMode(activeGate, strategy) === 'shadow';
    const logTest = (signal, rank, fields) => {
      if (testing) events.push(signalTestEvent({ t, market, strategy, signal, rank, batch: wanted.length, ...fields }));
    };
    if (!allowed.ok) {
      events.push({ t, type: 'entries_blocked', code: 'risk', strategyId: strategy.id, message: allowed.reason, count: wanted.length, symbols: wanted.map((s) => s.symbol) });
      wanted.forEach((signal, i) => logTest(signal, i + 1, { outcome: 'not_tested', notTestedReason: allowed.reason }));
      continue;
    }
    const universe = new Set(universeOf(strategy));
    for (let i = 0; i < wanted.length; i++) {
      const signal = wanted[i];
      const rank = i + 1;
      const { symbol } = signal;
      const entryRejected = (code, message) => events.push({ t, type: 'entry_rejected', code, symbol, strategyId: strategy.id, message });
      const reject = (code, message, fields = {}) => {
        entryRejected(code, message);
        logTest(signal, rank, { outcome: 'rejected', rejectCode: code, ...fields });
      };
      // A shadow strategy holds nothing, so someone else's position does not stop it logging.
      if (!shadow && (positions.has(symbol) || planned.has(symbol))) continue;
      if (!universe.has(symbol)) { reject('not_in_universe', `${symbol} is not eligible at this bar`); continue; }
      if (!(signal.stopDistancePct > 0 && signal.stopDistancePct < 1)) { reject('no_stop', 'No stop means no trade'); continue; }
      if (signal.side === 'short' && !strategy.perp) { reject('short_on_spot', 'Shorts need a perp strategy'); continue; }
      const price = market.prices.get(symbol);
      if (!Number.isFinite(price)) { reject('no_price', 'No price'); continue; }

      const gateCtx = {
        t, strategy, market, positions: planned, heldAtSignal: positions, riskState: nextRisk, regime, ind,
        universe: universeOf(strategy), price,
      };
      const pre = testing ? runGateStage(activeGate, 'preSize', signal, gateCtx) : PASSED;
      if (!shadow && !stagePassed(activeGate, 'preSize', pre)) {
        entryRejected('gate', pre?.reason || 'Signal gate refused');
        logTest(signal, rank, { outcome: 'blocked', verdict: pre, pre });
        continue;
      }

      const book = [...planned.keys(), symbol];
      const cost = market.costFor?.(symbol, strategy);
      const costFractions = cost ? toRiskCosts(cost) : undefined;
      const configured = config.sizeMultipliers?.[strategy.id];
      const sized = risk.sizeEntry({
        // Perp shorts reach v6Risk as shorts and it refuses them (short_not_supported):
        // its loss allowance has no funding term, so there is no honest size yet.
        signal, price, equity: projected, positions: planned, riskState: nextRisk, config: riskConfig,
        volatility: new Map(book.map((s) => [s, volOf(s)])),
        correlations: extendCorrelations(correlations, tailLogs, book, market.bars, config.correlationBars ?? 60),
        // No default: a strategy with no multiplier fails closed in v6Risk, so nothing
        // can skip the half-risk start by omission. The lifecycle's figure is a ceiling
        // that config cannot raise.
        sizeMultiplier: pre.sizeMultiplier === undefined ? configured : Math.min(pre.sizeMultiplier, configured ?? pre.sizeMultiplier),
        prices: market.prices, cash: Math.max(0, spendable),
        ...(costFractions ? { costs: costFractions } : {}),
      });
      const sizeOk = !sized.rejected && sized.qty > 0;

      let post = PASSED;
      if (testing) {
        let exitPlan = null;
        if (sizeOk) {
          try {
            exitPlan = entryPositionFields({
              intent: { side: signal.side, signal, atr: ind(symbol, 'atr', 14), reason: signal.reason, regime },
              fill: { price, qty: sized.qty }, cost, modules, exitConfig: exitConfigFor(strategy, config, market),
            }).exitPlan;
          } catch { /* a null plan fails the risk check */ }
        }
        post = runGateStage(activeGate, 'postSize', signal, { ...gateCtx, sized, exitPlan, cost });
      }

      if (shadow) {
        logTest(signal, rank, { outcome: 'shadow', verdict: pre, pre, post });
        const wouldEnter = sizeOk && mergeChecks(pre, post).every((c) => SHADOW_IGNORES.has(c.id) || c.status === 'pass');
        if (wouldEnter) {
          shadowOpens.push({
            strategyId: strategy.id, symbol, side: signal.side, stopDistancePct: signal.stopDistancePct,
            exitProfile: signal.exitProfile, reason: signal.reason, barT: market.barT, atr: ind(symbol, 'atr', 14), regime,
          });
        }
        continue;
      }
      if (!sizeOk) {
        reject('sizing', sized.reason || 'Size is zero', { pre, post });
        // planned already drops this step's exits and counts its earlier entries.
        const noted = risk.noteEntryRejection?.(nextRisk, sized, { t, openPositions: planned.size });
        if (noted) {
          nextRisk = noted.riskState;
          events.push(...noted.events);
        }
        continue;
      }
      if (!stagePassed(activeGate, 'postSize', post)) {
        entryRejected('gate', post?.reason || 'Signal gate refused');
        logTest(signal, rank, { outcome: 'blocked', verdict: post, pre, post });
        continue;
      }

      intents.push({
        type: 'enter', symbol, strategyId: strategy.id, side: signal.side, qty: sized.qty,
        reason: signal.reason, reasonCode: 'signal', refPrice: price, fill: { mode: 'market', price: null },
        signal, atr: ind(symbol, 'atr', 14), regime,
      });
      logTest(signal, rank, { outcome: 'entered', pre, post });
      spendable -= sized.notional * (1 + (costFractions?.feePct ?? 0) + (costFractions?.slipPct ?? 0));
      // Later candidates in this step must see this one's risk and exposure.
      const stopPrice = signal.side === 'short' ? price * (1 + signal.stopDistancePct) : price * (1 - signal.stopDistancePct);
      planned.set(symbol, {
        symbol, strategyId: strategy.id, side: signal.side, qty: sized.qty, entryPrice: price, stopPrice,
        initialStopPrice: stopPrice, riskAtEntry: sized.riskAmount, lastPrice: price,
      });
    }
  }

  // Virtual trades for shadow strategies. Runs last, so it can never affect a real order.
  let shadowResult = null;
  if (typeof activeGate?.advanceShadow === 'function') {
    try {
      shadowResult = activeGate.advanceShadow({
        t, market, ind, regime, signalsByStrategy, strategyById, opens: shadowOpens, config, tightenTrails, modules,
      });
    } catch (err) {
      events.push({ t, type: 'alarm', code: 'shadow_error', message: err.message });
    }
  }
  return { intents, riskState: nextRisk, events, updates, equity: projected, shadow: shadowResult };
}

/** Pearson correlation of two symbols' close-to-close log returns over their last n shared bars. */
export function returnCorrelation(a, b, n = 60, logsA = null, logsB = null) {
  const lastA = a.length - 1, lastB = b.length - 1;
  let i = a.length - 1, j = b.length - 1, count = 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  while (i > 0 && j > 0 && count < n) {
    if (a[i].t > b[j].t) { i--; continue; }
    if (b[j].t > a[i].t) { j--; continue; }
    // A gap in either series would make this a multi-bar return, so skip the pair.
    if (a[i].t - a[i - 1].t === b[j].t - b[j - 1].t) {
      const x = lastA - i < (logsA?.length ?? 0) ? logsA[lastA - i] : Math.log(a[i].c / a[i - 1].c);
      const y = lastB - j < (logsB?.length ?? 0) ? logsB[lastB - j] : Math.log(b[j].c / b[j - 1].c);
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      count++;
    }
    i--; j--;
  }
  if (count < Math.min(n, 20)) return NaN;
  const cov = sxy - (sx * sy) / count;
  const vx = sxx - (sx * sx) / count, vy = syy - (sy * sy) / count;
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
}

/**
 * symbol -> symbol -> rho for v6Risk, filled in as candidates appear and shared across
 * one step, so each pair is computed once. v6Risk reads a pair with too little history
 * (NaN here) as rho 1, the cautious answer.
 */
function extendCorrelations(matrix, logs, symbols, bars, n) {
  const tail = (symbol) => {
    let r = logs.get(symbol);
    if (!r) {
      const list = bars.get(symbol) || [];
      const last = list.length - 1;
      r = new Float64Array(Math.max(0, Math.min(n, last)));
      for (let k = 0; k < r.length; k++) r[k] = Math.log(list[last - k].c / list[last - k - 1].c);
      logs.set(symbol, r);
    }
    return r;
  };
  for (const a of symbols) {
    let row = matrix.get(a);
    if (!row) matrix.set(a, row = new Map());
    for (const b of symbols) {
      if (a === b || row.has(b)) continue;
      const rho = returnCorrelation(bars.get(a) || [], bars.get(b) || [], n, tail(a), tail(b));
      row.set(b, rho);
      let other = matrix.get(b);
      if (!other) matrix.set(b, other = new Map());
      other.set(a, rho);
    }
  }
  return matrix;
}

function lastBar(bars, symbol) {
  const b = bars.get(symbol);
  return b && b.length ? b[b.length - 1] : null;
}

/** Symbols a strategy may trade now: in its universe, warmed up, and with a bar at barT. */
function eligibleUniverse(strategy, market) {
  const base = market.universeFor ? market.universeFor(strategy)
    : strategy.universe?.kind === 'fixed' ? strategy.universe.symbols : [];
  const warm = strategy.warmupBars || 0;
  return base.filter((s) => {
    const b = market.bars.get(s);
    return b && b.length >= warm && b.length > 0 && b[b.length - 1].t === market.barT;
  });
}
