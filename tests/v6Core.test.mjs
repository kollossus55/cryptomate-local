/**
 * v6Core: indicators, the fixed order inside step, and its integration with the real
 * v6Risk, v6Exits and v6Paper modules. Nothing here is stubbed unless the test says so.
 */
import assert from 'node:assert';
import {
  INDICATORS, atr, createIndicatorAccess, donchianHigh, donchianLow, ema, entryPositionFields, exitRemainderPatch,
  GATE_CHECKS, PASS_THROUGH_GATE, fullWeightRisk, positionValue, realisedVol, returnCorrelation, roc, sma, step as rawStep,
  stopTouched,
} from '../shared/trading/v6Core.js';
import { evaluateExit } from '../shared/trading/v6Exits.js';
import { applyFill, costFor, createLedger, positionsBySymbol, simulateFill, toRiskCosts, updatePosition } from '../shared/trading/v6Paper.js';
import * as REAL_RISK from '../shared/trading/v6Risk.js';
import { DEFAULT_RISK_CONFIG, canEnter, humanReEnable, initialRiskState, manualHalt, riskDirectives, updateRiskState } from '../shared/trading/v6Risk.js';

// step refuses every entry without a gate. Most tests here are about the rest of step, so
// they use the pass-through unless they name a gate. The gate's own tests are at the end.
const step = (args) => rawStep({ gate: PASS_THROUGH_GATE, ...args });

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

const DAY = 86400000;
const T0 = Date.UTC(2023, 0, 1);

function series(n, { start = 100, drift = 0.001, seed = 1 } = {}) {
  let x = seed, c = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const r = (x / 2147483648 - 0.5) * 0.04 + drift;
    const o = c;
    c = o * (1 + r);
    out.push({ t: T0 + i * DAY, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1000, qv: 1e8 });
  }
  return out;
}

/** A market as the sim or the worker would hand it to step. */
function marketOf(barsBySymbol, extra = {}) {
  const bars = new Map(Object.entries(barsBySymbol));
  const prices = new Map([...bars].map(([s, b]) => [s, b.at(-1).c]));
  return {
    bars, prices, barMs: DAY, periodsPerYear: 365, health: { ok: true }, barT: bars.get('BTCUSDT').at(-1).t,
    costFor: (symbol) => costFor(symbol, /^(BTC|ETH)/.test(symbol) ? 1 : 3),
    ...extra,
  };
}

const closeOf = (bars) => bars.at(-1).t + DAY;
const longSignal = (symbol, stop = 0.1) => ({ strategyId: 's', symbol, side: 'long', score: 0.5, stopDistancePct: stop, exitProfile: 'trend', reason: 'test', meta: {} });
const strategy = (signals, extra = {}) => ({ id: 's', timeframe: '1d', params: {}, universe: { kind: 'fixed', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] }, warmupBars: 0, signals, ...extra });
const FULL = { sizeMultipliers: { s: 1 } };

/** A real position, built the way the simulator builds one. */
function held(symbol, { price = 100, qty = 10, entryTime, stopPct = 0.1, profile = 'trend', overrides } = {}) {
  const intent = { type: 'enter', symbol, strategyId: 's', side: 'long', qty, signal: { stopDistancePct: stopPct, exitProfile: profile }, atr: 2, reason: 'test', regime: { label: 'risk_on' } };
  const cost = costFor(symbol, 1);
  const fill = simulateFill({ intent, bar: { t: entryTime, o: price, h: price, l: price, c: price }, cost, t: entryTime });
  fill.positionFields = entryPositionFields({ intent, fill, cost, exitConfig: { barMs: DAY, overrides } });
  return fill;
}
function ledgerWith(fills, cash = 100000) {
  let l = createLedger({ cash, t: T0 });
  for (const f of fills) l = applyFill(l, f);
  return l;
}
function warmRisk(equity, t, config = DEFAULT_RISK_CONFIG, btcBars = series(30)) {
  return updateRiskState(initialRiskState(equity, t), { t, equity, btcBars, dataHealth: { ok: true }, config }).riskState;
}

console.log('indicators');

test('sma, roc: hand values', () => {
  const b = [1, 2, 3, 4, 5].map((c) => ({ c }));
  assert.ok(Number.isNaN(sma(b, 3)[1]));
  near(sma(b, 3)[2], 2);
  near(sma(b, 3)[4], 4);
  near(roc(b, 2)[4], 5 / 3 - 1);
  assert.ok(Number.isNaN(roc(b, 2)[1]));
});

test('ema: seeded by the SMA, then k = 2/(n+1)', () => {
  const b = [2, 4, 6, 8].map((c) => ({ c }));
  near(ema(b, 3)[2], 4);
  near(ema(b, 3)[3], 4 + 0.5 * (8 - 4));
});

test('atr: Wilder smoothing, gaps count through the prior close', () => {
  const b = [{ h: 11, l: 9, c: 10 }, { h: 12, l: 10, c: 11 }, { h: 20, l: 18, c: 19 }, { h: 19, l: 17, c: 18 }];
  // true ranges 2, 2, 9 (20 - prior close 11), 2
  near(atr(b, 3)[2], 13 / 3);
  near(atr(b, 3)[3], ((13 / 3) * 2 + 2) / 3);
});

test('donchian: the window includes the current bar and drops the old one', () => {
  const b = [5, 3, 4, 2, 1].map((x) => ({ h: x, l: x }));
  assert.deepStrictEqual([...donchianHigh(b, 3)].slice(2), [5, 4, 4]);
  assert.deepStrictEqual([...donchianLow(b, 3)].slice(2), [3, 2, 1]);
});

test('realisedVol: matches a direct calculation', () => {
  const b = series(50);
  const n = 20, i = 40;
  const lr = [];
  for (let k = i - n + 1; k <= i; k++) lr.push(Math.log(b[k].c / b[k - 1].c));
  const m = lr.reduce((a, x) => a + x, 0) / n;
  const v = lr.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  near(realisedVol(b, n)[i], Math.sqrt(v * 365), 1e-10);
});

test('every built-in is causal: truncating the bars never changes an earlier value', () => {
  const b = series(300);
  const cases = { sma: [20], ema: [20], atr: [14], roc: [10], donchianHigh: [20], donchianLow: [20], realisedVol: [30] };
  assert.deepStrictEqual(Object.keys(cases).sort(), Object.keys(INDICATORS).sort());
  for (const [name, args] of Object.entries(cases)) {
    const full = INDICATORS[name](b, ...args);
    for (const cut of [25, 60, 150, 299]) {
      const part = INDICATORS[name](b.slice(0, cut), ...args);
      for (let i = 0; i < cut; i++) assert.ok(Object.is(part[i], full[i]), `${name} differs at ${i} with cut ${cut}`);
    }
  }
});

test('ind: the simulator path and the live path return identical values', () => {
  const b = series(200);
  const visible = new Map([['X', b.slice(0, 120)]]);
  const cache = new Map();
  const sim = createIndicatorAccess(visible, () => ({ bars: b, cache }));
  const live = createIndicatorAccess(visible);
  for (const [name, args] of [['sma', 50], ['atr', 14], ['realisedVol', [30, 365]]]) {
    assert.strictEqual(sim('X', name, args), live('X', name, args));
    assert.strictEqual(sim('X', name, args, 3), live('X', name, args, 3));
  }
});

test('ind: full-series values stay unreachable past the visible bars', () => {
  const b = series(200);
  const visible = new Map([['X', b.slice(0, 120)]]);
  const ind = createIndicatorAccess(visible, () => ({ bars: b, cache: new Map() }));
  assert.throws(() => ind('X', 'sma', 10, -1), /future/);
  near(ind('X', 'sma', 10), sma(b.slice(0, 120), 10)[119]);
});

test('ind: a custom function only ever receives the visible bars', () => {
  const b = series(50);
  const visible = new Map([['X', b.slice(0, 10)]]);
  let seen = 0;
  const ind = createIndicatorAccess(visible, () => ({ bars: b, cache: new Map() }));
  ind('X', (bars) => { seen = bars.length; return bars.map((x) => x.c); });
  assert.strictEqual(seen, 10);
});

test('returnCorrelation: a series with itself is 1, against its negative is -1', () => {
  const a = series(100);
  const inv = a.map((x) => ({ ...x, c: 1e4 / x.c }));
  near(returnCorrelation(a, a, 60), 1, 1e-9);
  near(returnCorrelation(a, inv, 60), -1, 1e-9);
  assert.ok(Number.isNaN(returnCorrelation(a.slice(0, 5), a.slice(0, 5), 60)));
});

console.log('step: order and exits');

test('exits come before entries, and exits are emitted first', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t })]);
  const out = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }), SOLUSDT: series(40, { seed: 3 }) }),
    strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), side: 'flat' }, longSignal('SOLUSDT')])],
    config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc),
  });
  assert.deepStrictEqual(out.intents.map((i) => `${i.type}:${i.symbol}`), ['exit:ETHUSDT', 'enter:SOLUSDT']);
  assert.strictEqual(out.intents[0].reasonCode, 'signal_exit');
  assert.strictEqual(out.intents[0].fill.mode, 'market');
});

test('step does not mutate its inputs', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: btc.at(-3).o, entryTime: btc.at(-3).t })]);
  const positions = positionsBySymbol(l);
  const before = JSON.stringify([...positions]);
  const riskState = warmRisk(100000, t - 1, undefined, btc);
  const riskBefore = JSON.stringify(riskState);
  step({ t, account: { cash: l.cash }, positions, market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [])], config: FULL, riskState });
  assert.strictEqual(JSON.stringify([...positions]), before);
  assert.strictEqual(JSON.stringify(riskState), riskBefore);
});

test('exits are never blocked: a manual halt, a closed gate and bad data all let a flat signal out', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t })]);
  const halted = manualHalt(warmRisk(100000, t - 1, undefined, btc), { t: t - 1, by: 'test' }).riskState;
  const out = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l),
    market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) }, { health: { ok: false, reason: 'stale' } }),
    strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), side: 'flat' }, longSignal('SOLUSDT')])],
    gate: { check: () => ({ ok: false, reason: 'closed' }) }, config: FULL, riskState: halted,
  });
  assert.deepStrictEqual(out.intents.map((i) => `${i.type}:${i.symbol}`), ['exit:ETHUSDT']);
});

test('a stale price raises an alarm and the exit still runs on the last good price', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t })]);
  const market = marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) });
  market.prices.delete('ETHUSDT');
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market, strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), side: 'flat' }])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.ok(out.events.some((e) => e.code === 'stale_price'));
  assert.strictEqual(out.intents[0].type, 'exit');
  assert.strictEqual(out.intents[0].refPrice, positionsBySymbol(l).get('ETHUSDT').lastPrice);
});

test('a throwing strategy loses its signals, not its stops', () => {
  const btc = series(40);
  const last = btc.at(-1);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: last.l * 1.05, entryTime: last.t, stopPct: 0.02 })]);
  const out = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }),
    strategies: [strategy(() => { throw new Error('boom'); })], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc),
  });
  assert.ok(out.events.some((e) => e.code === 'strategy_error'));
  assert.strictEqual(out.intents[0].fill.mode, 'stop');
});

console.log('fill hints and stop labels (paper-ledger, exit-engine)');

test('fillHint.kind stop: intent is a stop fill at the worse of stop and open', () => {
  const btc = series(40);
  const last = { ...btc.at(-1), o: 90, h: 91, l: 85, c: 88 };
  const bars = [...btc.slice(0, -1), last];
  const t = closeOf(bars);
  const l = ledgerWith([held('BTCUSDT', { price: 100, entryTime: last.t - DAY, stopPct: 0.05 })]);
  const p = positionsBySymbol(l).get('BTCUSDT');
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: bars }), strategies: [strategy(() => [])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, bars) });
  const [intent] = out.intents;
  assert.strictEqual(intent.fill.mode, 'stop');
  assert.strictEqual(intent.fill.price, 90);
  assert.strictEqual(intent.fill.stopPrice, p.stopPrice);
  assert.strictEqual(intent.reasonCode, 'hard_stop');
});

test('fillHint.kind target: a partial target is a limit fill at its price, not a market fill', () => {
  const btc = series(40);
  const last = { ...btc.at(-1), o: 100, h: 125, l: 99, c: 120 };
  const bars = [...btc.slice(0, -1), last];
  const t = closeOf(bars);
  const overrides = { partials: [{ atR: 2, fraction: 0.5 }], signalExit: { enabled: false }, regimeExit: { enabled: false } };
  const l = ledgerWith([held('BTCUSDT', { price: 100, entryTime: last.t, stopPct: 0.1, overrides })]);
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: bars }), strategies: [strategy(() => [], { exitOverrides: overrides })], config: FULL, riskState: warmRisk(100000, t - 1, undefined, bars) });
  const [intent] = out.intents;
  assert.strictEqual(intent.type, 'reduce');
  assert.strictEqual(intent.reasonCode, 'partial_take_profit');
  assert.strictEqual(intent.fill.mode, 'limit');
  const p = positionsBySymbol(l).get('BTCUSDT');
  near(intent.fill.price, p.entryPrice + 2 * (p.entryPrice - p.stopPrice));
  near(intent.qty, p.qty * 0.5);
});

test('stop labels survive step: trail_stop and breakeven_stop are not rewritten as hard_stop', () => {
  const btc = series(40);
  const run = (stopPrice, floorMove) => {
    const last = { ...btc.at(-1), o: 130, h: 131, l: stopPrice - 1, c: stopPrice };
    const bars = [...btc.slice(0, -1), last];
    const t = closeOf(bars);
    let l = ledgerWith([held('BTCUSDT', { price: 100, entryTime: last.t - 10 * DAY, stopPct: 0.1 })]);
    const p = positionsBySymbol(l).get('BTCUSDT');
    l = updatePosition(l, 'BTCUSDT', { stopPrice: floorMove(p), highWater: 135 });
    const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: bars }), strategies: [strategy(() => [])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, bars) });
    return out;
  };
  const trail = run(120, () => 120);
  assert.strictEqual(trail.intents[0].reasonCode, 'trail_stop');
  assert.ok(!trail.events.some((e) => e.code === 'stop_guard'));
  const be = run(100, (p) => p.exitPlan.breakEvenPrice);
  assert.strictEqual(be.intents[0].reasonCode, 'breakeven_stop');
  assert.ok(!be.events.some((e) => e.code === 'stop_guard'));
});

test('stop guard: fires only when the exit module misses a touched stop, and says so', () => {
  const btc = series(40);
  const last = { ...btc.at(-1), o: 100, h: 101, l: 80, c: 85 };
  const bars = [...btc.slice(0, -1), last];
  const t = closeOf(bars);
  const l = ledgerWith([held('BTCUSDT', { price: 100, entryTime: last.t, stopPct: 0.1 })]);
  const args = { t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: bars }), strategies: [strategy(() => [])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, bars) };
  const real = step(args);
  assert.strictEqual(real.intents[0].reasonCode, 'hard_stop');
  assert.ok(!real.events.some((e) => e.code === 'stop_guard'));

  for (const broken of [{ evaluateExit: () => ({ action: 'hold' }) }, { evaluateExit: () => { throw new Error('bug'); } }]) {
    const out = step({ ...args, modules: { exits: broken } });
    assert.strictEqual(out.intents[0].reasonCode, 'stop_guard');
    assert.strictEqual(out.intents[0].fill.mode, 'stop');
    assert.ok(out.events.some((e) => e.code === 'stop_guard'));
  }
});

test('stop guard leaves valid non-stop decisions alone when no stop was touched', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: btc.at(-1).c, entryTime: btc.at(-3).t, stopPct: 0.2 })]);
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [{ ...longSignal('BTCUSDT'), side: 'flat' }])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.intents[0].reasonCode, 'signal_exit');
  assert.ok(!out.events.some((e) => e.code === 'stop_guard'));
});

test('a stop can never be loosened through step, by any module', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: btc.at(-1).c, entryTime: btc.at(-3).t, stopPct: 0.1 })]);
  const p = positionsBySymbol(l).get('BTCUSDT');
  const out = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [])], config: FULL,
    riskState: warmRisk(100000, t - 1, undefined, btc),
    modules: { exits: { evaluateExit: () => ({ action: 'hold', update: { stopPrice: p.stopPrice * 0.5 } }) } },
  });
  assert.strictEqual(out.updates[0].patch.stopPrice, p.stopPrice);
});

test('a thin book: a part-filled exit is re-emitted every step until the position is flat', () => {
  const btc = series(40);
  const t = closeOf(btc);
  let l = ledgerWith([held('ETHUSDT', { price: 100, entryTime: btc.at(-5).t, qty: 10 })]);
  const eth = series(40, { seed: 2 });
  const market = marketOf({ BTCUSDT: btc, ETHUSDT: eth }, { isNewBar: false });
  const riskState = warmRisk(100000, t - 1, undefined, btc);
  const strategies = [strategy(() => [])];
  const book = (qty) => ({ asks: [[101, 100]], bids: [[100, qty]], t });
  const cost = costFor('ETHUSDT', 1);

  const first = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), riskState, config: FULL,
    market: { ...market, isNewBar: true }, strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), side: 'flat', reason: 'turned' }])],
  });
  let intent = first.intents[0];
  assert.strictEqual(intent.reasonCode, 'signal_exit');
  const rounds = [];
  for (let round = 0; round < 5 && positionsBySymbol(l).has('ETHUSDT'); round++) {
    const fill = simulateFill({ intent, book: book(4), cost, t: t + round });
    l = applyFill(l, fill);
    rounds.push(fill.status);
    const patch = exitRemainderPatch(fill);
    if (patch && positionsBySymbol(l).has('ETHUSDT')) l = updatePosition(l, 'ETHUSDT', patch);
    if (!positionsBySymbol(l).has('ETHUSDT')) break;
    // a later tick: no new bar, no signal, nothing else would fire
    const again = step({ t: t + 300000 * (round + 1), account: { cash: l.cash }, positions: positionsBySymbol(l), market, strategies, config: FULL, riskState });
    assert.strictEqual(again.intents.length, 1, 'the remainder must be re-emitted');
    intent = again.intents[0];
    assert.strictEqual(intent.type, 'exit');
    assert.strictEqual(intent.reasonCode, 'signal_exit');
    near(intent.qty, positionsBySymbol(l).get('ETHUSDT').qty);
  }
  assert.deepStrictEqual(rounds, ['partial', 'partial', 'filled']);
  assert.strictEqual(positionsBySymbol(l).has('ETHUSDT'), false);
});

test('exitRemainderPatch: only a partial exit leaves a remainder to chase', () => {
  assert.strictEqual(exitRemainderPatch({ type: 'exit', status: 'filled' }), null);
  assert.strictEqual(exitRemainderPatch({ type: 'reduce', status: 'partial' }), null);
  assert.deepStrictEqual(exitRemainderPatch({ type: 'exit', status: 'partial', reasonCode: 'x', reason: 'y' }), { exitPending: { reasonCode: 'x', reason: 'y' } });
});

console.log('clock, barMs, regime (exit-engine)');

test('t is the bar close: a fill at the open of bar k is barsHeld 1 at the close of bar k', () => {
  const btc = series(40);
  const last = btc.at(-1);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: last.o, entryTime: last.t, stopPct: 0.5 })]);
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.updates[0].patch.barsHeld, 1);
});

test('the same holding period gives the same barsHeld on a live tick after the close', () => {
  const btc = series(40);
  const last = btc.at(-1);
  const close = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: last.o, entryTime: last.t, stopPct: 0.5 })]);
  const args = { account: { cash: l.cash }, positions: positionsBySymbol(l), strategies: [strategy(() => [])], config: FULL, riskState: warmRisk(100000, close - 1, undefined, btc) };
  const sim = step({ ...args, t: close, market: marketOf({ BTCUSDT: btc }) });
  const live = step({ ...args, t: close + 5 * 60000, market: marketOf({ BTCUSDT: btc }, { isNewBar: false }) });
  assert.strictEqual(sim.updates[0].patch.barsHeld, live.updates[0].patch.barsHeld);
});

test('barMs reaches the exit engine: a 4h time stop counts 4h bars', () => {
  const H4 = 4 * 3600000;
  const btc = series(40).map((b, i) => ({ ...b, t: T0 + i * H4 }));
  const overrides = { timeStop: { enabled: true, bars: 100, minR: 0, maxBars: 6 }, signalExit: { enabled: false }, regimeExit: { enabled: false }, breakEven: { enabled: false }, trail: { enabled: false } };
  const t = btc.at(-1).t + H4;
  const entry = btc.at(-6).t; // exactly six 4h bars ago, one day in clock terms
  const intent = { type: 'enter', symbol: 'BTCUSDT', strategyId: 's', side: 'long', qty: 1, signal: { stopDistancePct: 0.9, exitProfile: 'trend' }, atr: 2, reason: 'x' };
  const cost = costFor('BTCUSDT', 1);
  const fill = simulateFill({ intent, bar: { t: entry, o: 100, h: 100, l: 100, c: 100 }, cost, t: entry });
  fill.positionFields = entryPositionFields({ intent, fill, cost, exitConfig: { barMs: H4, overrides } });
  const l = ledgerWith([fill]);
  const out = step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }, { barMs: H4 }),
    strategies: [strategy(() => [], { timeframe: '4h', exitOverrides: overrides })], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc),
  });
  assert.strictEqual(out.intents[0]?.reasonCode, 'time_stop');
});

test('a missing market.barMs raises an alarm', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const out = step({ t, account: { cash: 1000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }, { barMs: undefined }), strategies: [], config: FULL, riskState: warmRisk(1000, t - 1, undefined, btc) });
  assert.ok(out.events.some((e) => e.code === 'missing_bar_ms'));
});

test('the current regime reaches every evaluateExit and the plan records it at entry', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('BTCUSDT', { price: btc.at(-1).c, entryTime: btc.at(-3).t, stopPct: 0.5 })]);
  const seen = [];
  const regime = { label: 'risk_off', riskOn: false };
  step({
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc }, { regime }), strategies: [strategy(() => [])], config: FULL,
    riskState: warmRisk(100000, t - 1, undefined, btc), modules: { exits: { evaluateExit: (a) => { seen.push(a); return evaluateExit(a); } } },
  });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].regime, regime);
  assert.strictEqual(positionsBySymbol(l).get('BTCUSDT').exitPlan.regimeAtEntry, 1);
});

test('an entry intent carries the regime it was decided in', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const regime = { label: 'risk_on', riskOn: true };
  const out = step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }, { regime }), strategies: [strategy(() => [longSignal('BTCUSDT')])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.intents[0].regime, regime);
});

test('costs reach the exit plan: break-even offset uses the real tier, not a default', () => {
  const offset = (tier) => {
    const intent = { type: 'enter', symbol: 'SOLUSDT', strategyId: 's', side: 'long', qty: 1, signal: { stopDistancePct: 0.1, exitProfile: 'trend' }, atr: 2 };
    const cost = costFor('SOLUSDT', tier);
    const fill = simulateFill({ intent, bar: { t: T0, o: 100, h: 100, l: 100, c: 100 }, cost, t: T0 });
    return entryPositionFields({ intent, fill, cost, exitConfig: { barMs: DAY } }).exitPlan.breakEvenOffsetPct;
  };
  assert.ok(offset(3) > offset(2));
});

console.log('risk integration (risk-engine, paper-ledger)');

test('costs: sizeEntry gets per-symbol fractions from toRiskCosts', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const seen = [];
  const spy = { ...fullWeightRisk(), sizeEntry: (a) => { seen.push(a); return { qty: 1, notional: 100, riskAmount: 1, rejected: false }; } };
  step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc, SOLUSDT: series(40, { seed: 3 }) }), strategies: [strategy(() => [longSignal('BTCUSDT'), longSignal('SOLUSDT')])], config: FULL, riskState: {}, modules: { risk: spy } });
  const by = Object.fromEntries(seen.map((a) => [a.signal.symbol, a.costs]));
  assert.deepStrictEqual(by.BTCUSDT, toRiskCosts(costFor('BTCUSDT', 1)));
  assert.deepStrictEqual(by.SOLUSDT, toRiskCosts(costFor('SOLUSDT', 3)));
  near(by.BTCUSDT.feePct, 0.001);
  near(by.BTCUSDT.slipPct, 0.0003);
});

test('costs: with the real v6Risk a cheap tier is sized bigger than an expensive one', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const size = (tier) => {
    const out = step({
      t, account: { cash: 100000 }, positions: new Map(),
      market: marketOf({ BTCUSDT: btc, SOLUSDT: series(40, { seed: 3 }) }, { costFor: (s) => costFor(s, tier) }),
      strategies: [strategy(() => [longSignal('SOLUSDT', 0.02)])], config: { ...FULL, risk: { ...DEFAULT_RISK_CONFIG, maxPositionPct: 0.25 } }, riskState: warmRisk(100000, t - 1, undefined, btc),
    });
    return out.intents[0].qty;
  };
  assert.ok(size(2) > size(3));
});

test('config.risk undefined: defaults apply and entries are NOT blocked by input_fault', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const out = step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [longSignal('BTCUSDT')])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.riskState.fault, null);
  assert.strictEqual(out.intents.filter((i) => i.type === 'enter').length, 1);
});

test('no size multiplier fails closed: no entry, and the reason says why', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const out = step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [longSignal('BTCUSDT')])], config: {}, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.intents.length, 0);
  assert.ok(out.events.some((e) => e.code === 'sizing' && /size_multiplier/.test(e.message)));
});

test('a 0.5 multiplier halves the entry', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const size = (m) => step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [longSignal('BTCUSDT')])], config: { sizeMultipliers: { s: m } }, riskState: warmRisk(100000, t - 1, undefined, btc) }).intents[0].qty;
  near(size(0.5), size(1) / 2, 1e-9);
});

test('perp shorts are refused in sizing with a clear reason; spot shorts earlier', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const args = { t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }), config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) };
  const short = { ...longSignal('BTCUSDT'), side: 'short' };
  const perp = step({ ...args, strategies: [strategy(() => [short], { perp: true })] });
  assert.strictEqual(perp.intents.length, 0);
  assert.ok(perp.events.some((e) => e.code === 'sizing' && e.message === 'short_not_supported'));
  const spot = step({ ...args, strategies: [strategy(() => [short])] });
  assert.ok(spot.events.some((e) => e.code === 'short_on_spot'));
});

test('no stop, no trade', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const out = step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }), strategies: [strategy(() => [{ ...longSignal('BTCUSDT'), stopDistancePct: undefined }])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc) });
  assert.strictEqual(out.intents.length, 0);
  assert.ok(out.events.some((e) => e.code === 'no_stop'));
});

test('sizing sees the entries already planned in this step', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const seen = [];
  const spy = { ...fullWeightRisk(), sizeEntry: (a) => { seen.push(a.positions.size); return { qty: 1, notional: 100, riskAmount: 1, rejected: false }; } };
  step({ t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }), SOLUSDT: series(40, { seed: 3 }) }), strategies: [strategy(() => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((s) => longSignal(s)))], config: FULL, riskState: {}, modules: { risk: spy } });
  assert.deepStrictEqual(seen, [0, 1, 2]);
});

test('-20% through step: everything exits, entries stop, the halt persists until humanReEnable', () => {
  const btc = series(40);
  let t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { price: 100, qty: 300, entryTime: btc.at(-5).t, stopPct: 0.5 }), held('SOLUSDT', { price: 100, qty: 300, entryTime: btc.at(-5).t, stopPct: 0.5 })]);
  const eq0 = l.cash + 60000;
  const mk = (px) => marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }), SOLUSDT: series(40, { seed: 3 }) }, { prices: new Map([['BTCUSDT', btc.at(-1).c], ['ETHUSDT', px], ['SOLUSDT', px]]), isNewBar: true });
  const strategies = [strategy(() => [longSignal('BTCUSDT')])];
  let riskState = warmRisk(eq0, t - 1, undefined, btc);

  // 60% of equity falling 35% is about -21%
  const crash = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: mk(65), strategies, config: FULL, riskState });
  const exits = crash.intents.filter((i) => i.type === 'exit');
  assert.deepStrictEqual(exits.map((i) => i.symbol).sort(), ['ETHUSDT', 'SOLUSDT']);
  assert.ok(exits.every((i) => i.reasonCode === 'risk_flatten'));
  assert.strictEqual(crash.intents.filter((i) => i.type === 'enter').length, 0);
  assert.strictEqual(canEnter(crash.riskState).ok, false);
  riskState = crash.riskState;

  // Flat, recovered, days later: still halted.
  t += 3 * DAY;
  const later = step({ t, account: { cash: eq0 }, positions: new Map(), market: mk(100), strategies, config: FULL, riskState });
  assert.strictEqual(later.intents.length, 0);
  assert.strictEqual(canEnter(later.riskState).ok, false);

  const back = humanReEnable(later.riskState, { t, equity: eq0, by: 'test', confirm: true });
  assert.ok(back.ok);
  const bars = series(40).map((b) => ({ ...b, t: b.t + 3 * DAY }));
  const resumed = step({ t: closeOf(bars), account: { cash: eq0 }, positions: new Map(), market: marketOf({ BTCUSDT: bars }), strategies, config: FULL, riskState: back.riskState });
  assert.strictEqual(resumed.intents.filter((i) => i.type === 'enter').length, 1);
});

test('a manual halt without flatten stops entries but does NOT dump positions', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { price: 100, entryTime: btc.at(-5).t, stopPct: 0.5 })]);
  const riskState = manualHalt(warmRisk(100000, t - 1, undefined, btc), { t: t - 1, by: 'test' }).riskState;
  const eth = series(40, { seed: 2 }).map((b) => ({ ...b, l: b.c, o: b.c, h: b.c }));
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc, ETHUSDT: eth }), strategies: [strategy(() => [longSignal('BTCUSDT')])], config: FULL, riskState });
  assert.strictEqual(out.intents.length, 0);
});

test('a manual halt WITH flatten exits everything', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { price: 100, entryTime: btc.at(-5).t, stopPct: 0.5 })]);
  const riskState = manualHalt(warmRisk(100000, t - 1, undefined, btc), { t: t - 1, by: 'test', flatten: true }).riskState;
  const out = step({ t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) }), strategies: [strategy(() => [])], config: FULL, riskState });
  assert.deepStrictEqual(out.intents.map((i) => i.reasonCode), ['risk_flatten']);
});

test('positionValue agrees with collateral plus P&L, long and short', () => {
  near(positionValue({ side: 'long', qty: 2, entryPrice: 100, collateral: 200 }, 110), 220);
  near(positionValue({ side: 'short', qty: 2, entryPrice: 100, collateral: 200 }, 110), 180);
  near(positionValue({ side: 'long', qty: 2, entryPrice: 100 }, 90), 180);
});

console.log('signal gate in step');

const PRE = GATE_CHECKS.filter((c) => c.stage === 'preSize').map((c) => c.id);
const POST = GATE_CHECKS.filter((c) => c.stage === 'postSize').map((c) => c.id);
const allPass = (ids, extra = {}) => ({ ok: true, checks: ids.map((id) => ({ id, status: 'pass', text: 'ok', values: [{ label: 'x', value: 1, limit: 2 }] })), ...extra });
const openGate = (over = {}) => ({ preSize: () => allPass(PRE), postSize: () => allPass(POST), ...over });
function entryArgs(over = {}) {
  const btc = series(40);
  const t = closeOf(btc);
  return {
    t, account: { cash: 100000 }, positions: new Map(), market: marketOf({ BTCUSDT: btc }),
    strategies: [strategy(() => [longSignal('BTCUSDT')])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc), ...over,
  };
}
const entries = (out) => out.intents.filter((i) => i.type === 'enter');
const rowsOf = (out) => out.events.filter((e) => e.type === 'signal_test');

test('no gate at all: no entry, an alarm, and a blocked row', () => {
  const out = rawStep(entryArgs());
  assert.strictEqual(entries(out).length, 0);
  assert.ok(out.events.some((e) => e.type === 'alarm' && e.code === 'no_gate'));
  assert.strictEqual(rowsOf(out)[0].outcome, 'blocked');
  assert.strictEqual(rowsOf(out)[0].blocked_by, 'no_gate');
});

const BAD_GATES = {
  'an empty object': {},
  'the old check-only shape': { check: () => ({ ok: true }) },
  'preSize only': { preSize: () => allPass(PRE) },
  'postSize only': { postSize: () => allPass(POST) },
  'preSize throws': openGate({ preSize: () => { throw new Error('boom'); } }),
  'postSize throws': openGate({ postSize: () => { throw new Error('boom'); } }),
  'preSize returns nothing': openGate({ preSize: () => undefined }),
  'postSize returns nothing': openGate({ postSize: () => undefined }),
  'ok is merely truthy': openGate({ preSize: () => ({ ...allPass(PRE), ok: 'yes' }) }),
  'ok with no checks shown': openGate({ preSize: () => ({ ok: true }) }),
  'ok with a check missing': openGate({ preSize: () => allPass(PRE.slice(1)) }),
  'ok with a check not_run': openGate({ postSize: () => ({ ok: true, checks: POST.map((id) => ({ id, status: 'not_run' })) }) }),
  'ok with a failed check': openGate({ postSize: () => ({ ok: true, checks: POST.map((id) => ({ id, status: 'fail' })) }) }),
  'a refusal before sizing': openGate({ preSize: () => ({ ok: false, reason: 'no', checks: [] }) }),
  'a refusal after sizing': openGate({ postSize: () => ({ ok: false, reason: 'no', checks: [] }) }),
};
for (const [name, gate] of Object.entries(BAD_GATES)) {
  test(`no entry with ${name}`, () => {
    assert.strictEqual(entries(rawStep(entryArgs({ gate }))).length, 0);
  });
}

test('a gate that clears both stages does allow the entry, so the refusals above mean something', () => {
  const out = rawStep(entryArgs({ gate: openGate() }));
  assert.strictEqual(entries(out).length, 1);
  assert.strictEqual(rowsOf(out)[0].outcome, 'entered');
});

test('every entry passes preSize, then sizing, then postSize, in that order', () => {
  const log = [];
  const realSize = (a) => { log.push(`size:${a.signal.symbol}`); return { qty: 1, notional: 100, riskAmount: 1, rejected: false, reason: 'x' }; };
  const stub = { ...fullWeightRisk(), sizeEntry: realSize };
  const gate = {
    preSize: (s) => { log.push(`pre:${s.symbol}`); return allPass(PRE); },
    postSize: (s, ctx) => { log.push(`post:${s.symbol}:${ctx.sized.qty}`); return allPass(POST); },
  };
  const out = rawStep(entryArgs({
    gate, modules: { risk: stub },
    market: marketOf({ BTCUSDT: series(40), ETHUSDT: series(40, { seed: 2 }) }),
    strategies: [strategy(() => [longSignal('BTCUSDT'), longSignal('ETHUSDT')])],
  }));
  assert.deepStrictEqual(log, ['pre:BTCUSDT', 'size:BTCUSDT', 'post:BTCUSDT:1', 'pre:ETHUSDT', 'size:ETHUSDT', 'post:ETHUSDT:1']);
  assert.strictEqual(entries(out).length, 2);
});

test('a refused preSize never reaches sizing', () => {
  let sized = 0;
  const stub = { ...fullWeightRisk(), sizeEntry: () => { sized++; return { qty: 1 }; } };
  rawStep(entryArgs({ gate: openGate({ preSize: () => ({ ok: false, checks: [] }) }), modules: { risk: stub } }));
  assert.strictEqual(sized, 0);
});

test('postSize receives the size and an exit plan carrying the profile minimum', () => {
  let seen;
  rawStep(entryArgs({ gate: openGate({ postSize: (s, ctx) => { seen = ctx; return allPass(POST); } }) }));
  assert.ok(seen.sized.qty > 0);
  assert.strictEqual(seen.exitPlan.minRewardRisk, 2);
  assert.ok(seen.exitPlan.hardStopPrice > 0);
});

test('a refused postSize leaves room for the next candidate', () => {
  const gate = openGate({ postSize: (s) => (s.symbol === 'BTCUSDT' ? { ok: false, reason: 'thin', checks: [] } : allPass(POST)) });
  const alone = rawStep(entryArgs({ gate: openGate(), market: marketOf({ BTCUSDT: series(40), ETHUSDT: series(40, { seed: 2 }) }), strategies: [strategy(() => [longSignal('ETHUSDT')])] }));
  const out = rawStep(entryArgs({
    gate, market: marketOf({ BTCUSDT: series(40), ETHUSDT: series(40, { seed: 2 }) }),
    strategies: [strategy(() => [{ ...longSignal('BTCUSDT'), score: 0.9 }, longSignal('ETHUSDT')])],
  }));
  assert.deepStrictEqual(entries(out).map((i) => i.symbol), ['ETHUSDT']);
  near(entries(out)[0].qty, entries(alone)[0].qty);
});

test('the row keeps all seven results with values and limits, in contract order', () => {
  const row = rowsOf(rawStep(entryArgs({ gate: openGate() })))[0];
  assert.deepStrictEqual(row.checks.map((c) => c.id), ['certificate', 'drift', 'data', 'replay', 'liquidity', 'history', 'risk']);
  assert.ok(row.checks.every((c) => c.status === 'pass' && c.values[0].limit === 2));
  for (const key of ['t', 'bar_time', 'symbol', 'strategy_id', 'side', 'reason', 'rank_in_batch', 'batch_size', 'outcome', 'reject_code', 'blocked_by', 'blocked_text', 'not_tested_reason', 'exit_profile', 'stop_distance_pct', 'trade_id']) {
    assert.ok(key in row, `row has no ${key}`);
  }
});

test('a preSize refusal shows checks 5 and 7 as not_run, never as a pass', () => {
  const fail = { ok: false, reason: 'Data: stale', blockedBy: 'data', checks: PRE.map((id) => ({ id, status: id === 'data' ? 'fail' : 'pass', text: '', values: [] })) };
  const row = rowsOf(rawStep(entryArgs({ gate: openGate({ preSize: () => fail }) })))[0];
  assert.strictEqual(row.outcome, 'blocked');
  assert.strictEqual(row.blocked_by, 'data');
  assert.strictEqual(row.blocked_text, 'Data: stale');
  assert.deepStrictEqual(row.checks.filter((c) => c.status === 'not_run').map((c) => c.id), POST);
});

test('sizing refusal is a rejected row, not a blocked one', () => {
  const stub = { ...fullWeightRisk(), sizeEntry: () => ({ qty: 0, rejected: true, reason: 'below_min_notional' }) };
  const out = rawStep(entryArgs({ gate: openGate(), modules: { risk: stub } }));
  assert.strictEqual(entries(out).length, 0);
  assert.strictEqual(rowsOf(out)[0].outcome, 'rejected');
  assert.strictEqual(rowsOf(out)[0].reject_code, 'sizing');
});

test('rejected before the tests: the row says so and all seven are not_run', () => {
  const row = rowsOf(rawStep(entryArgs({ gate: openGate(), strategies: [strategy(() => [{ ...longSignal('BTCUSDT'), stopDistancePct: undefined }])] })))[0];
  assert.strictEqual(row.outcome, 'rejected');
  assert.strictEqual(row.reject_code, 'no_stop');
  assert.ok(row.checks.every((c) => c.status === 'not_run'));
});

test('entries off: one not_tested row per coin, the gate is not asked, symbols are on the event', () => {
  let asked = 0;
  const args = entryArgs({
    gate: openGate({ preSize: () => { asked++; return allPass(PRE); } }),
    market: marketOf({ BTCUSDT: series(40), ETHUSDT: series(40, { seed: 2 }) }),
    strategies: [strategy(() => [longSignal('BTCUSDT'), longSignal('ETHUSDT')])],
  });
  args.riskState = manualHalt(args.riskState, { t: args.t - 1, by: 'test' }).riskState;
  const out = rawStep(args);
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(rowsOf(out).map((r) => `${r.symbol}:${r.outcome}`), ['BTCUSDT:not_tested', 'ETHUSDT:not_tested']);
  assert.deepStrictEqual(out.events.find((e) => e.type === 'entries_blocked').symbols, ['BTCUSDT', 'ETHUSDT']);
});

test('the lifecycle multiplier is a ceiling config cannot raise', () => {
  const qty = (mult, gateMult) => entries(rawStep(entryArgs({
    gate: openGate({ preSize: () => allPass(PRE, { sizeMultiplier: gateMult }) }), config: { sizeMultipliers: { s: mult } },
  })))[0].qty;
  near(qty(1, 0.5), qty(0.5, 1), 1e-9);
  assert.ok(qty(1, 0.5) < qty(1, 1));
});

test('no exit waits for the gate: stop, flat signal and risk flatten all run under a throwing gate', () => {
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t })]);
  const throwing = { modeFor() { throw new Error('boom'); }, preSize() { throw new Error('boom'); }, postSize() { throw new Error('boom'); }, advanceShadow() { throw new Error('boom'); } };
  const args = {
    t, account: { cash: l.cash }, positions: positionsBySymbol(l), market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) }),
    strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), side: 'flat' }])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc),
  };
  const open = rawStep({ ...args, gate: openGate() });
  for (const gate of [undefined, throwing, {}]) {
    const out = rawStep({ ...args, gate });
    assert.deepStrictEqual(out.intents, open.intents);
    assert.deepStrictEqual(out.updates, open.updates);
  }
});

test('a tick inside a bar: the gate is not called, exits run, shadow is null', () => {
  let calls = 0;
  const count = () => { calls++; return { ok: false, checks: [] }; };
  const btc = series(40);
  const t = closeOf(btc);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t, overrides: {} })]);
  const positions = positionsBySymbol(l);
  const stopped = new Map([...positions].map(([s, p]) => [s, { ...p, stopPrice: 1e9 }]));
  const out = rawStep({
    t: t + 300000, account: { cash: l.cash }, positions: stopped, market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) }, { isNewBar: false }),
    strategies: [strategy(() => [longSignal('BTCUSDT')])], config: FULL, riskState: warmRisk(100000, t - 1, undefined, btc),
    gate: { modeFor: () => 'trade', preSize: count, postSize: count, advanceShadow: count },
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.shadow, null);
  assert.deepStrictEqual(out.intents.map((i) => i.type), ['exit']);
});

test('shadow: no intent even from a gate that says yes, cash and later entries untouched', () => {
  const shadowOnly = strategy(() => [longSignal('BTCUSDT')], { id: 'shadowed' });
  const real = strategy(() => [longSignal('ETHUSDT')], { id: 's' });
  const market = () => marketOf({ BTCUSDT: series(40), ETHUSDT: series(40, { seed: 2 }) });
  const config = { sizeMultipliers: { s: 1, shadowed: 1 } };
  const opens = [];
  const gate = openGate({
    modeFor: (s) => (s.id === 'shadowed' ? 'shadow' : 'trade'),
    advanceShadow: (a) => { opens.push(...a.opens); return { shadowed: { book: a.opens, closed: [] } }; },
  });
  const both = rawStep(entryArgs({ gate, market: market(), config, strategies: [shadowOnly, real] }));
  const alone = rawStep(entryArgs({ gate, market: market(), config, strategies: [real] }));
  assert.deepStrictEqual(entries(both).map((i) => i.strategyId), ['s']);
  near(entries(both)[0].qty, entries(alone)[0].qty);
  assert.deepStrictEqual(rowsOf(both).map((r) => r.outcome), ['shadow', 'entered']);
  assert.strictEqual(opens.length, 1);
  assert.strictEqual(both.shadow.shadowed.book[0].symbol, 'BTCUSDT');
});

test('shadow ignores certificate and drift when deciding what it would have done, and nothing else', () => {
  const lifecycleFails = { ok: false, checks: PRE.map((id) => ({ id, status: id === 'certificate' || id === 'drift' ? 'fail' : 'pass', text: '', values: [] })) };
  const dataFails = { ok: false, checks: PRE.map((id) => ({ id, status: id === 'data' ? 'fail' : 'pass', text: '', values: [] })) };
  const opened = (pre) => {
    let opens = null;
    rawStep(entryArgs({ gate: openGate({ modeFor: () => 'shadow', preSize: () => pre, advanceShadow: (a) => { opens = a.opens; return {}; } }) }));
    return opens.length;
  };
  assert.strictEqual(opened(lifecycleFails), 1);
  assert.strictEqual(opened(dataFails), 0);
});

console.log('needs review, through step');

/**
 * Equity 6% under its high, lost slowly so no day or week limit is tripped: rung 1 only.
 * The minimum order is above any size this account can reach.
 */
const DUST_RISK = { ...DEFAULT_RISK_CONFIG, minNotional: 1e6 };
function dustArgs(over = {}) {
  const btc = series(40);
  const t = closeOf(btc);
  let riskState = warmRisk(1000, t - 21 * DAY, DUST_RISK, btc);
  for (const [back, equity] of [[14, 980], [7, 960], [1, 940]]) {
    riskState = updateRiskState(riskState, { t: t - back * DAY, equity, btcBars: btc, dataHealth: { ok: true }, config: DUST_RISK }).riskState;
  }
  return {
    t, account: { cash: 940 }, positions: new Map(), market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }) }),
    strategies: [strategy(() => [longSignal('BTCUSDT')])], config: { ...FULL, risk: DUST_RISK }, riskState, ...over,
  };
}
const flatExit = (symbol) => ({ ...longSignal(symbol), side: 'flat' });

test('a below-minimum rejection on a flat rung sets review, end to end', () => {
  const out = step(dustArgs());
  assert.strictEqual(out.riskState.rung, 1);
  assert.strictEqual(out.intents.length, 0);
  assert.ok(out.events.some((e) => e.type === 'entry_rejected' && e.message === 'below_min_notional'));
  assert.strictEqual(riskDirectives(out.riskState).needsReview, true);
  assert.strictEqual(out.riskState.review.reason, 'flat_entries_too_small');
});

test('the same rejection with a position held does not set review', () => {
  const btc = series(40);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t, qty: 0.001 })], 940);
  const out = step(dustArgs({ account: { cash: l.cash }, positions: positionsBySymbol(l) }));
  assert.strictEqual(out.riskState.rung, 1);
  assert.ok(out.events.some((e) => e.message === 'below_min_notional'));
  assert.strictEqual(riskDirectives(out.riskState).needsReview, false);
});

test('a position leaving in this step does not count, so the book is flat', () => {
  const btc = series(40);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t, qty: 0.001 })], 940);
  const out = step(dustArgs({
    account: { cash: l.cash }, positions: positionsBySymbol(l),
    strategies: [strategy(() => [flatExit('ETHUSDT'), longSignal('BTCUSDT')])],
  }));
  assert.deepStrictEqual(out.intents.map((i) => i.type), ['exit']);
  assert.strictEqual(out.riskState.review.reason, 'flat_entries_too_small');
});

test('an entry planned earlier in this step means the book is not flat', () => {
  let calls = 0;
  const sizeEntry = (a) => (++calls === 1
    ? { qty: 1, notional: 50, riskAmount: 1, rejected: false, reason: 'x' }
    : REAL_RISK.sizeEntry({ ...a, positions: new Map() }));
  const out = step(dustArgs({
    modules: { risk: { ...REAL_RISK, sizeEntry } },
    strategies: [strategy(() => [{ ...longSignal('ETHUSDT'), score: 0.9 }, longSignal('BTCUSDT')])],
  }));
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(out.intents.map((i) => i.symbol), ['ETHUSDT']);
  assert.ok(out.events.some((e) => e.message === 'below_min_notional'));
  assert.strictEqual(riskDirectives(out.riskState).needsReview, false);
});

test('a shadow rejection never raises a review: nothing real was refused', () => {
  const gate = { modeFor: () => 'shadow', preSize: () => ({ ok: false, checks: [] }), postSize: () => ({ ok: false, checks: [] }) };
  const out = rawStep(dustArgs({ gate }));
  assert.strictEqual(out.riskState.rung, 1);
  assert.ok(out.events.some((e) => e.type === 'signal_test' && e.outcome === 'shadow'), 'the signal reached the shadow log');
  assert.strictEqual(riskDirectives(out.riskState).needsReview, false);
});

test('updateRiskState is told the open count, net of this step\'s exits', () => {
  const btc = series(40);
  const l = ledgerWith([held('ETHUSDT', { entryTime: btc.at(-5).t, qty: 0.001 }), held('SOLUSDT', { entryTime: btc.at(-5).t, qty: 0.001 })], 940);
  const seen = [];
  const updateRiskStateSpy = (s, input) => { seen.push(input.openPositions); return REAL_RISK.updateRiskState(s, input); };
  step(dustArgs({
    account: { cash: l.cash }, positions: positionsBySymbol(l),
    market: marketOf({ BTCUSDT: btc, ETHUSDT: series(40, { seed: 2 }), SOLUSDT: series(40, { seed: 3 }) }),
    strategies: [strategy(() => [flatExit('ETHUSDT')])], modules: { risk: { ...REAL_RISK, updateRiskState: updateRiskStateSpy } },
  }));
  assert.deepStrictEqual(seen, [1]);
});

test('a risk module without noteEntryRejection still works', () => {
  const stub = { ...fullWeightRisk(), sizeEntry: () => ({ qty: 0, rejected: true, reason: 'below_min_notional' }) };
  assert.strictEqual(step(dustArgs({ modules: { risk: stub } })).intents.length, 0);
});

console.log('regime span');

/** 4h BTC: a long fall, then a rally that clears the last 200 bars but not the last 200 days. */
function fourHourBtc(n) {
  const H4 = DAY / 6;
  return Array.from({ length: n }, (_, i) => {
    const fromEnd = n - 1 - i;
    const c = fromEnd < 200 ? 125 - fromEnd * 0.125 : 100 + (fromEnd - 200) * 0.1;
    return { t: T0 + i * H4, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000, qv: 1e8 };
  });
}
function regimeSeen(bars, barMs) {
  const t = bars.at(-1).t + barMs;
  let seen = null;
  step({
    t, account: { cash: 1000 }, positions: new Map(), market: marketOf({ BTCUSDT: bars }, { barMs }),
    strategies: [strategy((ctx) => { seen = ctx.regime; return []; })], config: FULL, riskState: warmRisk(1000, t - 1, undefined, bars),
  });
  return seen;
}

test('on 4h bars the regime average spans 200 days, which is 1200 bars', () => {
  const bars = fourHourBtc(1300);
  const seen = regimeSeen(bars, DAY / 6);
  const last = bars.slice(-1200).reduce((a, b) => a + b.c, 0) / 1200;
  near(seen.btcSma, last);
  assert.strictEqual(seen.label, 'risk_off');
  const last200 = bars.slice(-200).reduce((a, b) => a + b.c, 0) / 200;
  assert.ok(bars.at(-1).c > last200, 'a 200-bar average would have said risk_on');
});

test('4h history shorter than 200 days gives an unknown regime, not a shorter average', () => {
  const seen = regimeSeen(fourHourBtc(1000), DAY / 6);
  assert.strictEqual(seen.label, 'unknown');
  assert.strictEqual(seen.riskOn, null);
});

test('on daily bars the span stays 200 bars', () => {
  const bars = series(260);
  const seen = regimeSeen(bars, DAY);
  near(seen.btcSma, bars.slice(-200).reduce((a, b) => a + b.c, 0) / 200);
});

test('a supplied regime still wins over the fallback', () => {
  const bars = series(40);
  const t = closeOf(bars);
  let seen = null;
  const regime = { riskOn: true, label: 'risk_on', btcClose: 1, btcSma: 1 };
  step({
    t, account: { cash: 1000 }, positions: new Map(), market: marketOf({ BTCUSDT: bars }, { regime }),
    strategies: [strategy((ctx) => { seen = ctx.regime; return []; })], config: FULL, riskState: warmRisk(1000, t - 1, undefined, bars),
  });
  assert.deepStrictEqual(seen, regime);
});

// Review item 1: ticks ratchet a stop inside a bar, then the bar closes with an earlier low.
{
  const bars = series(40);
  const last = bars.at(-1);
  const closed = { ...last, o: 100, h: 151, l: 99, c: 148 };
  const withBar = (b) => [...bars.slice(0, -1), b];
  const tickT = last.t + DAY / 2;
  const run = (p, b, opts = {}) => step({
    t: closeOf(bars), account: { cash: 1000 }, positions: new Map([['ETHUSDT', p]]),
    market: marketOf({ ETHUSDT: withBar(b), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', b.c]]), ...opts }),
    strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)),
  });
  const position = (over) => {
    const base = ledgerWith([held('ETHUSDT', { price: 100, entryTime: last.t, stopPct: 0.1 })]).positions[0];
    const { stopPrior = base.stopPrice, ...rest } = over ?? {};
    const stopPrice = rest.stopPrice ?? 134;
    const stopSetAt = rest.stopSetAt ?? tickT;
    return { ...base, ...rest, stopPrice, stopSetAt, stopLog: [{ t: last.t, stop: stopPrior }, { t: stopSetAt, stop: stopPrice }] };
  };
  const fakeExits = { evaluateExit: () => ({ action: 'hold', reasonCode: 'hold', fraction: 0, update: null }) };

  test('a stop ratcheted inside a bar is not tested against that bar\'s earlier low', () => {
    const out = run(position(), closed);
    assert.strictEqual(out.intents.length, 0, JSON.stringify(out.intents.map((i) => i.reasonCode)));
    assert.ok(!out.events.some((e) => e.code === 'stop_guard'));
  });

  test('the core backstop follows the same order of events', () => {
    const guarded = step({
      t: closeOf(bars), account: { cash: 1000 }, positions: new Map([['ETHUSDT', position()]]),
      market: marketOf({ ETHUSDT: withBar(closed), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', 148]]) }),
      strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)), modules: { exits: fakeExits },
    });
    assert.strictEqual(guarded.intents.length, 0);
  });

  test('a stop in force when the bar began still meets the whole bar', () => {
    const out = run(position({ stopPrice: 134, stopPrior: 99.5 }), closed);
    assert.strictEqual(out.intents.length, 1);
    assert.strictEqual(out.intents[0].fill.stopPrice, 99.5);
    const old = run(position({ stopPrice: 134, stopSetAt: last.t, stopPrior: 90 }), closed);
    assert.strictEqual(old.intents[0].fill.stopPrice, 134, 'set at the bar start, so the low counts');
    near(old.intents[0].fill.price, 100);
  });

  test('a close below a stop moved during the bar exits at the close, not the old open', () => {
    const b = { ...closed, c: 120 };
    const out = run(position(), b);
    assert.strictEqual(out.intents.length, 1);
    assert.strictEqual(out.intents[0].fill.stopPrice, 134);
    near(out.intents[0].fill.price, 120);
    const guarded = step({
      t: closeOf(bars), account: { cash: 1000 }, positions: new Map([['ETHUSDT', position()]]),
      market: marketOf({ ETHUSDT: withBar(b), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', 120]]) }),
      strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)), modules: { exits: fakeExits },
    });
    assert.strictEqual(guarded.intents[0].reasonCode, 'stop_guard');
    near(guarded.intents[0].fill.price, 120);
  });

  test('a short mirrors it', () => {
    const p = position({ side: 'short', instrument: 'perp', stopPrice: 66, stopPrior: 110 });
    const b = { ...closed, o: 100, h: 101, l: 50, c: 52 };
    const out = step({
      t: closeOf(bars), account: { cash: 1000 }, positions: new Map([['ETHUSDT', p]]),
      market: marketOf({ ETHUSDT: withBar(b), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', 52]]) }),
      strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)), modules: { exits: fakeExits },
    });
    assert.strictEqual(out.intents.length, 0, 'the high came before the stop');
  });

  test('the clock: a tick stamps its time, a close stamps the close, and a stop that holds logs nothing', () => {
    const tick = step({
      t: closeOf(bars) + 1000, account: { cash: 1000 }, positions: new Map([['ETHUSDT', { ...position(), stopPrice: 90, stopSetAt: undefined, stopLog: undefined }]]),
      market: marketOf({ ETHUSDT: withBar(closed), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', 148]]), isNewBar: false }),
      strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)),
      modules: { exits: { evaluateExit: () => ({ action: 'hold', update: { stopPrice: 120 } }) } },
    }).updates[0].patch;
    assert.strictEqual(tick.stopSetAt, closeOf(bars) + 1000);
    assert.deepStrictEqual(tick.stopLog, [{ t: last.t, stop: 90 }, { t: closeOf(bars) + 1000, stop: 120 }]);
    const moves = { evaluateExit: () => ({ action: 'hold', update: { stopPrice: 140 } }) };
    const closeArgs = (p) => ({
      t: closeOf(bars) + 60000, account: { cash: 1000 }, positions: new Map([['ETHUSDT', p]]),
      market: marketOf({ ETHUSDT: withBar(closed), BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', 148]]) }),
      strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)), modules: { exits: moves },
    });
    assert.strictEqual(step(closeArgs(position())).updates[0].patch.stopSetAt, closeOf(bars), 'set at the close, not the wall clock');
    const late = step(closeArgs(position({ stopSetAt: closeOf(bars) + 1000 }))).updates[0].patch;
    assert.strictEqual(late.stopSetAt, closeOf(bars) + 1000, 'a tick after the close keeps its younger time');
    assert.strictEqual(run(position(), closed, {}).updates[0].patch.stopLog?.length ?? 3, 3);
  });
}

// Retest items 1 and 3.
{
  const bars = series(40);
  const last = bars.at(-1);
  const go = (p, b, account, modules = {}) => step({
    t: closeOf(bars), account, positions: new Map([['ETHUSDT', p]]),
    market: marketOf({ ETHUSDT: [...bars.slice(0, -1), b], BTCUSDT: series(40) }, { prices: new Map([['ETHUSDT', b.c]]) }),
    strategies: [strategy([])], config: {}, riskState: warmRisk(2000, closeOf(bars)), modules,
  });
  const base = () => ledgerWith([held('ETHUSDT', { price: 100, entryTime: last.t, stopPct: 0.1 })]).positions[0];

  test('the backstop tests nothing on a bar older than a cleared stop', () => {
    const p = { ...base(), stopPrice: 139.5, stopSetAt: last.t + 1000 };
    const b = { ...last, o: 100, h: 151, l: 101, c: 150 };
    const out = go(p, b, { cash: 1000 }, { exits: { evaluateExit: () => ({ action: 'hold', update: null }) } });
    assert.strictEqual(out.intents.length, 0);
  });

  test('a quarantined value counts in equity, and an unknown one reaches the risk engine', () => {
    let seen;
    const spy = { ...REAL_RISK, updateRiskState: (s, input) => { seen = input; return REAL_RISK.updateRiskState(s, input); } };
    const b = { ...last, o: 100, h: 101, l: 99, c: 100 };
    const out = go(base(), b, { cash: 1000, quarantine: { value: 500, unknown: 1 } }, { risk: spy });
    near(seen.equity, 1000 + 500 + base().qty * 100);
    assert.strictEqual(seen.equityUnknown, true);
    assert.strictEqual(out.intents.length, 0);
  });
}

test('the backstop keeps a late bar\'s close away from a stop set after it', () => {
  const t = 1000000;
  const p = { side: 'long', entryTime: 0, stopPrice: 115.92, stopSetAt: t + DAY + 900000,
    stopLog: [{ t: 0, stop: 90 }, { t: t + DAY + 900000, stop: 115.92 }] };
  const b = { t, o: 100, h: 127, l: 99, c: 100 };
  assert.strictEqual(stopTouched(p, b, DAY), false);
  assert.strictEqual(stopTouched(p, { ...b, l: 89, c: 89 }, DAY), true);
  const earlier = { ...p, stopSetAt: t + 1000, stopLog: [{ t: 0, stop: 90 }, { t: t + 1000, stop: 115.92 }] };
  assert.strictEqual(stopTouched(earlier, b, DAY), true, 'set before the close, so the close meets it');
});

console.log(`\nv6Core: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
