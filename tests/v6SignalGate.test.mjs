/**
 * v6SignalGate. The fixture passes all seven checks through the real v6Core.step, v6Risk
 * and v6Exits. Each test then breaks one input and shows that exactly that check fails.
 */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_END as BARS_DEV_END } from '../shared/trading/v6Bars.js';
import { step } from '../shared/trading/v6Core.js';
import { applyFill, costFor, createLedger, positionsBySymbol, simulateFill } from '../shared/trading/v6Paper.js';
import { entryPositionFields } from '../shared/trading/v6Core.js';
import * as REAL_RISK from '../shared/trading/v6Risk.js';
import { DEFAULT_RISK_CONFIG, initialRiskState, updateRiskState } from '../shared/trading/v6Risk.js';
import { seededRandom } from '../shared/trading/v6Stats.js';
import { defineStrategy } from '../shared/trading/v6Strategies.js';
import {
  DEV_END, FORWARD_TRADES_TO_FULL, HALF_RISK, SHADOW_SIGNALS_TO_RETURN, advanceLifecycle, buildExpectedBand, buildHistoryEntry,
  canonicalJson, checkRisk, createSignalGate, demoteToShadow, emptyHistoryTable, evaluateDrift, initialStrategyState, issueCertificate,
  recordForwardTrade, recordShadowResult, returnFromShadow, sha256, sizeMultiplierFor, strategyHash, tradeOutcomes, verifyCertificate,
  checkReplay,
} from '../shared/trading/v6SignalGate.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);
const N = 40;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const clone = (x) => JSON.parse(JSON.stringify(x));
const keepMeta = (bars, meta) => Object.defineProperty(bars, 'meta', { value: meta, enumerable: false });

/** Rising, with alternating days so realised volatility is believable. The last day is up. */
const makeBars = (scale = 1) => Array.from({ length: N }, (_, i) => {
  const c = 100 * scale * 1.004 ** i * (1 + (i % 2 ? 0.02 : -0.02));
  return { t: T0 + i * DAY, o: c * 0.99, h: c * 1.01, l: c * 0.98, c, v: 1000, qv: 1e9 };
});

const STRATEGY = defineStrategy({
  id: 'up_day', name: 'Up day', timeframe: '1d', params: { n: 5 }, warmupBars: 10, universe: { kind: 'fixed', symbols: ['BTCUSDT'] },
  signals(ctx) {
    return ctx.universe.map((symbol) => {
      const b = ctx.bars.get(symbol);
      const up = b.at(-1).c > ctx.ind(symbol, 'sma', ctx.params.n);
      return { strategyId: 'up_day', symbol, side: up ? 'long' : 'flat', score: 0.5, stopDistancePct: 0.1, exitProfile: 'trend', reason: 'test', meta: {} };
    });
  },
});

const DEV_OK = Object.fromEntries(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'].map((id) => [id, { pass: true, value: 'fine', threshold: 'x', detail: '' }]));
const HOLDOUT_OK = { sharpe: 1, maxDrawdown: 0.1, totalReturn: 0.2, btcMaxDrawdown: 0.5 };
function draws(n, { mean = 1, sd = 5, seed = 1 } = {}) {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => mean + sd * (r() + r() + r() + r() - 2) * Math.sqrt(3));
}
const RETURNS = draws(150);
const issue = (over = {}) => issueCertificate({
  strategy: STRATEGY, devCriteria: DEV_OK, holdout: HOLDOUT_OK, tradeReturnsPct: RETURNS, issuedAt: T0, trialCount: 40, holdoutClean: true, issuer: 'test', ...over,
});
const CERT = issue();

function paperState(strategy = STRATEGY, certificate = CERT, t = T0 + DAY) {
  let s = initialStrategyState({ strategy });
  s = advanceLifecycle(s, { strategy, certificate, t }).state;
  return advanceLifecycle(s, { strategy, certificate, t }).state;
}

const rows = (list) => list.map(([win, i]) => ({
  symbol: 'BTCUSDT', strategyId: 'up_day', side: 'long', qty: 1, entryPrice: 100, entryTime: Date.UTC(2023, 0, 1) + i * DAY,
  exitTime: Date.UTC(2023, 0, 2) + i * DAY, pnl: win, rMultiple: win / 5, partial: false,
}));
const historyWith = (trades, strategy = STRATEGY) => ({
  ...emptyHistoryTable({ generatedAt: T0 }), strategies: { [strategy.id]: buildHistoryEntry({ strategy, trades }) },
});
const HISTORY = historyWith(rows([[20, 0], [-5, 1], [15, 2], [-5, 3]]));

function fixture() {
  const bars = makeBars();
  const last = bars.at(-1);
  const t = last.t + DAY;
  const p = last.c;
  return {
    t, bars, strategy: STRATEGY,
    states: { up_day: paperState() }, certificates: { up_day: clone(CERT) },
    data: {
      consensus: new Map([['BTCUSDT', { price: p, ok: true, venues: ['binance', 'okx', 'bybit'], spreadPct: 0.02, reason: null }]]),
      replay: new Map([['BTCUSDT', { venue: 'okx', bars: makeBars(1.001) }]]),
      books: new Map([['BTCUSDT', { bids: [[p * 0.99999, 1e6]], asks: [[p * 1.00001, 1e6]], t }]]),
      history: clone(HISTORY),
    },
    config: {},
    marketExtra: {},
  };
}

function marketFor(f) {
  const bars = new Map([['BTCUSDT', f.bars]]);
  return {
    bars, prices: new Map([['BTCUSDT', f.bars.at(-1).c]]), barMs: DAY, periodsPerYear: 365, health: { ok: true }, barT: f.bars.at(-1).t,
    costFor: (symbol) => costFor(symbol, 1), ...f.marketExtra,
  };
}

function run(f, over = {}) {
  const riskState = updateRiskState(initialRiskState(100000, f.t - 1), { t: f.t - 1, equity: 100000, btcBars: f.bars, dataHealth: { ok: true }, config: DEFAULT_RISK_CONFIG }).riskState;
  const out = step({
    t: f.t, account: { cash: 100000 }, positions: new Map(), market: marketFor(f), strategies: [f.strategy], config: { sizeMultipliers: { [f.strategy.id]: 1 } }, riskState,
    gate: createSignalGate({ states: f.states, certificates: f.certificates, data: f.data, config: f.config }), ...over,
  });
  return { out, row: out.events.find((e) => e.type === 'signal_test'), enters: out.intents.filter((i) => i.type === 'enter') };
}

const statusOf = (row) => Object.fromEntries(row.checks.map((c) => [c.id, c.status]));
const PRE = ['certificate', 'drift', 'data', 'replay', 'history'];
const POST = ['liquidity', 'risk'];

/** The named check fails, no entry happens, and every other check that ran still passes. */
function failsOnly(id, mutate) {
  const f = fixture();
  mutate(f);
  const { row, enters } = run(f);
  assert.strictEqual(enters.length, 0, 'an entry happened');
  assert.strictEqual(row.outcome, 'blocked');
  assert.strictEqual(row.blocked_by, id);
  const s = statusOf(row);
  assert.strictEqual(s[id], 'fail');
  for (const other of PRE) if (other !== id) assert.strictEqual(s[other], 'pass', `${other} should still pass: ${row.checks.find((c) => c.id === other).text}`);
  if (PRE.includes(id)) for (const later of POST) assert.strictEqual(s[later], 'not_run');
  else for (const other of POST) if (other !== id) assert.strictEqual(s[other], 'pass', `${other} should still pass`);
  return row.checks.find((c) => c.id === id);
}

console.log('the fixture');

test('all seven pass and the entry happens at half risk', () => {
  const f = fixture();
  const { row, enters } = run(f);
  assert.strictEqual(enters.length, 1);
  assert.strictEqual(row.outcome, 'entered');
  assert.ok(row.checks.every((c) => c.status === 'pass'), JSON.stringify(row.checks.filter((c) => c.status !== 'pass')));
  const full = fixture();
  full.states.up_day = { ...full.states.up_day, lifecycle: 'paper_full', forward_trades: 20 };
  const fullQty = run(full).enters[0].qty;
  assert.ok(Math.abs(enters[0].qty / fullQty - HALF_RISK) < 1e-9, `${enters[0].qty} vs ${fullQty}`);
});

test('every check reports values with limits', () => {
  const { row } = run(fixture());
  for (const id of ['data', 'replay', 'liquidity', 'history', 'risk']) {
    const c = row.checks.find((x) => x.id === id);
    assert.ok(c.values.some((v) => v.limit !== null && v.limit !== undefined), `${id} shows no limit`);
  }
});

console.log('check 1: certificate');

test('a tampered stored certificate fails', () => failsOnly('certificate', (f) => { f.certificates.up_day.criteria[0].status = 'fail'; f.certificates.up_day.status = 'valid'; }));
test('a certificate past its expiry fails', () => failsOnly('certificate', (f) => { f.certificates.up_day = issue({ ttlDays: 1 }); }));
test('no certificate fails check 1, and check 2 too, because the expected range lives in it', () => {
  const f = fixture();
  f.certificates = {};
  const { row, enters } = run(f);
  assert.strictEqual(enters.length, 0);
  assert.strictEqual(row.blocked_by, 'certificate');
  assert.deepStrictEqual([statusOf(row).certificate, statusOf(row).drift, statusOf(row).data], ['fail', 'fail', 'pass']);
});

console.log('check 2: forward drift');

test('forward results below the range fail even if the state missed its demotion', () => failsOnly('drift', (f) => {
  f.states.up_day = { ...f.states.up_day, forward_trades: 8, forward_series: Array.from({ length: 8 }, (_, i) => ({ x: i + 1, trade_return_pct: -40, return_pct: -40 * (i + 1) })) };
}));
test('an unknown drift status fails', () => failsOnly('drift', (f) => { f.states.up_day = { ...f.states.up_day, drift_status: 'unknown' }; }));

console.log('check 3: data');

test('consensus.ok false fails even with a price and a tight spread', () => {
  const c = failsOnly('data', (f) => { f.data.consensus.set('BTCUSDT', { price: 100, ok: false, venues: ['a', 'b'], spreadPct: 0.01, reason: 'no_majority' }); });
  assert.match(c.text, /no_majority/);
});
test('consensus.ok merely truthy fails', () => failsOnly('data', (f) => { f.data.consensus.get('BTCUSDT').ok = 'true'; }));
test('one venue fails', () => failsOnly('data', (f) => { f.data.consensus.get('BTCUSDT').venues = ['okx']; }));
test('a wide consensus spread fails', () => failsOnly('data', (f) => { f.data.consensus.get('BTCUSDT').spreadPct = 0.6; }));
test('a stale bar fails', () => failsOnly('data', (f) => { f.t += 31 * 60000; f.data.books.get('BTCUSDT').t = f.t; }));
test('a bar flagged stale by the hub fails', () => failsOnly('data', (f) => { keepMeta(f.bars, { stale: true }); }));
test('a gap fails', () => failsOnly('data', (f) => {
  f.bars = [...f.bars.slice(0, 20), ...f.bars.slice(21)];
  const replay = f.data.replay.get('BTCUSDT');
  replay.bars = replay.bars.slice(0, 20).concat(replay.bars.slice(21));
}));

console.log('check 4: cross-venue replay');

test('a replay that disagrees fails', () => {
  const c = failsOnly('replay', (f) => {
    f.config = { replayMaxPriceMismatchPct: 20 };
    const r = f.data.replay.get('BTCUSDT').bars;
    r[r.length - 1] = { ...r.at(-1), c: r.at(-2).c * 0.9 };
  });
  assert.match(c.text, /says flat/);
});
test('a ticker collision fails on price even though its signal agrees', () => {
  const c = failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', { venue: 'bybit', bars: makeBars(1.4) }); });
  assert.match(c.text, /different coin/);
  assert.ok(c.values.find((v) => v.label === 'price mismatch %').value > 30);
});

/** Venue bars built from the fixture's own, with changes to the volume or to single bars. */
const venueBars = (over = {}, scale = 1.001) => makeBars(scale).map((b) => ({ ...b, qv: 1e6, ...over }));
const statusValue = (c) => c.values.find((v) => v.label === 'replay status')?.value;
const passingRow = (f) => run(f).row.checks.find((x) => x.id === 'replay');

test('ZEC on Bybit: 1.11 against 56.27 at no volume is unusable, whichever way it would have voted', () => {
  const primary = makeBars().map((b, i, all) => ({ ...b, c: 56.27 * (1 + (i - all.length + 1) * 0.001) }));
  const bybit = primary.map((b) => ({ ...b, c: 1.11, qv: 0 }));
  const market = { bars: new Map([['ZECUSDT', primary]]), barT: primary.at(-1).t, barMs: DAY };
  const signal = { symbol: 'ZECUSDT', side: 'long' };
  for (const vote of ['long', 'flat', null]) {
    let asked = 0;
    const strategy = { warmupBars: 5, params: {}, signals: () => { asked++; return vote ? [{ symbol: 'ZECUSDT', side: vote }] : []; } };
    const c = checkReplay({ signal, strategy, ctx: { market, t: market.barT + DAY }, replay: { venue: 'bybit', bars: bybit } });
    assert.strictEqual(c.status, 'fail');
    assert.strictEqual(statusValue(c), 'unknown');
    assert.strictEqual(asked, 0, 'the strategy never saw those bars');
    assert.match(c.text, /Replay unknown: bybit/);
  }
});
test('near-zero volume is unusable even when price and signal agree', () => {
  const c = failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', { venue: 'bybit', bars: venueBars({ qv: 0.5 }) }); });
  assert.strictEqual(statusValue(c), 'unknown');
  assert.match(c.text, /near zero/);
});
test('a venue that goes thin on the latest bar is unusable', () => {
  const bars = venueBars();
  bars[bars.length - 1] = { ...bars.at(-1), qv: 0 };
  assert.strictEqual(statusValue(failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', { venue: 'bybit', bars }); })), 'unknown');
});
test('missing volume is unusable, not assumed fine', () => {
  const bars = venueBars().map(({ qv, ...b }) => b);
  const c = failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', { venue: 'okx', bars }); });
  assert.match(c.text, /no usable volume/);
});
test('one gross bar inside the window is unusable, though the median and latest bars look fine', () => {
  const bars = venueBars();
  bars[30] = { ...bars[30], c: bars[30].c * 1.3 };
  const c = failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', { venue: 'bybit', bars }); });
  assert.strictEqual(statusValue(c), 'unknown');
  assert.match(c.text, /not reliable/);
});
test('the thinnest healthy market in DEV stays usable', () => {
  const f = fixture();
  f.data.replay.set('BTCUSDT', { venue: 'bybit', bars: venueBars({ qv: 5500 }) });
  assert.strictEqual(passingRow(f).status, 'pass');
});
test('volume is judged per day, so short bars are not called thin', () => {
  const H4 = DAY / 6;
  const primary = makeBars();
  const strategy = { warmupBars: 5, params: {}, signals: () => [{ symbol: 'BTCUSDT', side: 'long' }] };
  const market = { bars: new Map([['BTCUSDT', primary]]), barT: primary.at(-1).t, barMs: H4 };
  const at = (qv) => checkReplay({ signal: { symbol: 'BTCUSDT', side: 'long' }, strategy, ctx: { market, t: market.barT + H4 }, replay: { venue: 'okx', bars: venueBars({ qv }) } }).status;
  assert.strictEqual(at(300), 'pass');
  assert.strictEqual(at(100), 'fail');
});
test('an unusable Bybit falls through to a usable OKX', () => {
  const f = fixture();
  f.data.replay.set('BTCUSDT', [{ venue: 'bybit', bars: venueBars({ qv: 0 }) }, { venue: 'okx', bars: venueBars() }]);
  const c = passingRow(f);
  assert.strictEqual(c.status, 'pass');
  assert.strictEqual(c.values.find((v) => v.label === 'venue').value, 'okx');
});
test('a usable venue that disagrees fails: the next venue is not asked', () => {
  const disagrees = venueBars();
  disagrees[disagrees.length - 1] = { ...disagrees.at(-1), c: disagrees.at(-2).c * 0.9 };
  const c = failsOnly('replay', (f) => {
    f.config = { replayMaxPriceMismatchPct: 20 };
    f.data.replay.set('BTCUSDT', [{ venue: 'okx', bars: disagrees }, { venue: 'bybit', bars: venueBars() }]);
  });
  assert.match(c.text, /okx replay says flat/);
  assert.strictEqual(statusValue(c), undefined, 'a disagreement is a result, not an unknown');
});
test('no usable venue among several reports unknown and names each', () => {
  const c = failsOnly('replay', (f) => { f.data.replay.set('BTCUSDT', [{ venue: 'bybit', bars: venueBars({ qv: 0 }) }, { venue: 'okx', bars: venueBars({}, 1.4) }]); });
  assert.strictEqual(statusValue(c), 'unknown');
  assert.match(c.text, /bybit volume.*okx price/);
});
test('an unusable venue keeps the seven-check shape', () => {
  const f = fixture();
  f.data.replay.set('BTCUSDT', { venue: 'bybit', bars: venueBars({ qv: 0 }) });
  const { row } = run(f);
  assert.deepStrictEqual(row.checks.map((x) => x.id), ['certificate', 'drift', 'data', 'replay', 'liquidity', 'history', 'risk']);
  assert.strictEqual(row.blocked_by, 'replay');
});
test('Coinbase is not a replay venue', () => failsOnly('replay', (f) => { f.data.replay.get('BTCUSDT').venue = 'coinbase'; }));
test('the bar source cannot replay itself', () => failsOnly('replay', (f) => { keepMeta(f.bars, { venue: 'okx' }); }));
test('replay bars that stop short fail', () => failsOnly('replay', (f) => { f.data.replay.get('BTCUSDT').bars.pop(); }));
test('too little overlap fails', () => failsOnly('replay', (f) => { f.data.replay.get('BTCUSDT').bars.splice(0, N - 12); }));
test('fewer replay bars than warmup fails', () => failsOnly('replay', (f) => { f.data.replay.get('BTCUSDT').bars.splice(0, N - 5); }));
test('a strategy that throws on the replay fails the check and nothing else', () => {
  const f = fixture();
  let calls = 0;
  const flaky = { ...STRATEGY, signals(ctx) { if (++calls > 1) throw new Error('replay broke'); return STRATEGY.signals(ctx); } };
  f.strategy = flaky;
  f.certificates.up_day = issue({ strategy: flaky });
  f.states.up_day = paperState(flaky, f.certificates.up_day);
  f.data.history = historyWith(rows([[20, 0], [-5, 1]]), flaky);
  const { row, enters } = run(f);
  assert.strictEqual(enters.length, 0);
  assert.strictEqual(row.blocked_by, 'replay');
  assert.match(row.checks.find((c) => c.id === 'replay').text, /replay broke/);
});

console.log('check 5: liquidity');

const reprice = (f, spreadPct) => {
  const p = f.bars.at(-1).c;
  f.data.books.set('BTCUSDT', { bids: [[p * (1 - spreadPct / 200), 1e6]], asks: [[p * (1 + spreadPct / 200), 1e6]], t: f.t });
};
test('a wide spread fails', () => { assert.match(failsOnly('liquidity', (f) => reprice(f, 0.2)).text, /Spread/); });
test('thin depth fails', () => { assert.match(failsOnly('liquidity', (f) => { f.data.books.get('BTCUSDT').asks[0][1] = 0.001; }).text, /depth/); });
test('walking the book past the cost budget fails', () => {
  assert.match(failsOnly('liquidity', (f) => {
    const b = f.data.books.get('BTCUSDT');
    b.asks = [[b.asks[0][0], 0.0001], [b.asks[0][0] * 1.01, 1e6]];
  }).text, /Cost/);
});
test('a stale book fails', () => failsOnly('liquidity', (f) => { f.data.books.get('BTCUSDT').stale = true; }));
test('an old book fails', () => failsOnly('liquidity', (f) => { f.data.books.get('BTCUSDT').t = f.t - 31000; }));
test('a crossed book fails', () => failsOnly('liquidity', (f) => { const b = f.data.books.get('BTCUSDT'); [b.bids, b.asks] = [b.asks, b.bids]; }));

console.log('check 6: historical');

test('negative expectancy fails', () => failsOnly('history', (f) => { f.data.history = historyWith(rows([[10, 0], [-20, 1]])); }));
test('zero expectancy passes', () => {
  const f = fixture();
  f.data.history = historyWith(rows([[15, 0], [-15, 1]]));
  assert.strictEqual(statusOf(run(f).row).history, 'pass');
});
test('a low n is flagged and the result stands', () => {
  const { row } = run(fixture());
  assert.match(row.checks.find((c) => c.id === 'history').text, /small sample/);
  assert.strictEqual(statusOf(row).history, 'pass');
});
test('history built from other code or parameters fails', () => failsOnly('history', (f) => { f.data.history.strategies.up_day.hash = 'f'.repeat(64); }));
test('a table reaching past DEV fails', () => failsOnly('history', (f) => { f.data.history.strategies.up_day.to = DEV_END + 1; }));
test('a table claiming a later DEV end fails', () => failsOnly('history', (f) => { f.data.history.dev_end = DEV_END + 1; }));
test('a coin with no DEV history fails', () => failsOnly('history', (f) => { delete f.data.history.strategies.up_day.symbols.BTCUSDT; }));
test('the builder refuses a trade past DEV', () => {
  assert.throws(() => buildHistoryEntry({ strategy: STRATEGY, trades: [{ ...rows([[1, 0]])[0], exitTime: DEV_END + 1 }] }), /past the DEV/);
});

console.log('check 7: risk');

test('reward:risk under the exit plan minimum fails', () => {
  const c = failsOnly('risk', (f) => { f.data.history = historyWith(rows([[5, 0], [-1, 1]])); });
  assert.strictEqual(c.values[0].limit, 2);
});
test('the minimum comes from exitPlan.minRewardRisk, not a fixed number', () => {
  const args = { signal: { symbol: 'BTCUSDT', side: 'long', stopDistancePct: 0.1 }, strategy: STRATEGY, sized: { qty: 1 }, history: HISTORY };
  const plan = (minRewardRisk) => ({ hardStopPrice: 90, minRewardRisk, warnings: [] });
  assert.strictEqual(checkRisk({ ...args, exitPlan: plan(3) }).status, 'pass');
  assert.strictEqual(checkRisk({ ...args, exitPlan: plan(4) }).status, 'fail');
});
test('a plan without the minimum, a stop, or at all fails', () => {
  const args = { signal: { symbol: 'BTCUSDT', side: 'long', stopDistancePct: 0.1 }, strategy: STRATEGY, sized: { qty: 1 }, history: HISTORY };
  for (const exitPlan of [null, { hardStopPrice: 90, warnings: [] }, { minRewardRisk: 1, warnings: [] }, { hardStopPrice: 90, minRewardRisk: 1, warnings: ['stop_wrong_side'] }]) {
    assert.strictEqual(checkRisk({ ...args, exitPlan }).status, 'fail');
  }
});
test('refused sizing fails check 7, stays a rejection, and liquidity is not_run', () => {
  const f = fixture();
  const refuses = { ...REAL_RISK, sizeEntry: () => ({ qty: 0, notional: 0, riskAmount: 0, rejected: true, reason: 'below_min_notional' }) };
  const { row, enters } = run(f, { modules: { risk: refuses } });
  assert.strictEqual(enters.length, 0);
  assert.strictEqual(row.outcome, 'rejected');
  assert.strictEqual(row.reject_code, 'sizing');
  assert.strictEqual(statusOf(row).risk, 'fail');
  assert.strictEqual(statusOf(row).liquidity, 'not_run');
});

console.log('fail closed on every missing input');

const MISSING = {
  'consensus map': ['data', (f) => { delete f.data.consensus; }],
  'consensus for this coin': ['data', (f) => { f.data.consensus.clear(); }],
  'replay map': ['replay', (f) => { delete f.data.replay; }],
  'replay for this coin': ['replay', (f) => { f.data.replay.clear(); }],
  'replay bars': ['replay', (f) => { delete f.data.replay.get('BTCUSDT').bars; }],
  'order books': ['liquidity', (f) => { delete f.data.books; }],
  'book for this coin': ['liquidity', (f) => { f.data.books.clear(); }],
  'book timestamp': ['liquidity', (f) => { delete f.data.books.get('BTCUSDT').t; }],
  'book asks': ['liquidity', (f) => { delete f.data.books.get('BTCUSDT').asks; }],
  'history table': ['history', (f) => { delete f.data.history; }],
  'history for this strategy': ['history', (f) => { f.data.history.strategies = {}; }],
};
for (const [name, [id, mutate]] of Object.entries(MISSING)) {
  test(`no ${name}`, () => {
    const f = fixture();
    mutate(f);
    const { row, enters } = run(f);
    assert.strictEqual(enters.length, 0);
    assert.strictEqual(statusOf(row)[id], 'fail');
  });
}
const noEntry = (mutate, over) => {
  const f = fixture();
  mutate(f);
  const { row, enters } = run(f, over);
  assert.strictEqual(enters.length, 0);
  return row;
};
test('no data object at all', () => { noEntry((f) => { f.data = {}; }); });
test('no strategy state', () => { assert.strictEqual(statusOf(noEntry((f) => { f.states = {}; })).certificate, 'fail'); });
test('corrupt strategy state', () => { assert.strictEqual(statusOf(noEntry((f) => { f.states.up_day = { lifecycle: 'paper_full' }; })).certificate, 'fail'); });
test('unknown lifecycle', () => { assert.strictEqual(statusOf(noEntry((f) => { f.states.up_day.lifecycle = 'live'; })).certificate, 'fail'); });
test('research and certified cannot enter', () => {
  for (const lifecycle of ['research', 'certified']) noEntry((f) => { f.states.up_day.lifecycle = lifecycle; });
});
test('no barMs', () => { assert.strictEqual(statusOf(noEntry((f) => { f.marketExtra = { barMs: undefined }; })).data, 'fail'); });
test('no cost model', () => {
  const row = noEntry((f) => { f.marketExtra = { costFor: undefined }; });
  assert.strictEqual(statusOf(row).liquidity, 'fail');
});
test('createSignalGate with nothing refuses', () => {
  const f = fixture();
  assert.strictEqual(run(f, { gate: createSignalGate() }).enters.length, 0);
});

console.log('exits');

function heldPosition(f) {
  const entryTime = f.bars.at(-5).t;
  const intent = { type: 'enter', symbol: 'BTCUSDT', strategyId: 'up_day', side: 'long', qty: 1, signal: { stopDistancePct: 0.1, exitProfile: 'trend' }, atr: 2, reason: 'test', regime: { label: 'risk_on' } };
  const cost = costFor('BTCUSDT', 1);
  const fill = simulateFill({ intent, bar: { t: entryTime, o: 100, h: 100, l: 100, c: 100 }, cost, t: entryTime });
  fill.positionFields = entryPositionFields({ intent, fill, cost, exitConfig: { barMs: DAY } });
  return applyFill(createLedger({ cash: 100000, t: T0 }), fill);
}

test('a demoted strategy with no data at all still exits its position, as an open gate would', () => {
  const f = fixture();
  const ledger = heldPosition(f);
  const flat = { ...STRATEGY, signals: () => [{ strategyId: 'up_day', symbol: 'BTCUSDT', side: 'flat' }] };
  const args = { account: { cash: ledger.cash }, positions: positionsBySymbol(ledger) };
  const open = run({ ...f, strategy: flat }, args).out;
  assert.deepStrictEqual(open.intents.map((i) => i.type), ['exit']);
  const shut = fixture();
  shut.strategy = flat;
  shut.states.up_day = demoteToShadow(shut.states.up_day, { t: shut.t, reason: 'drift' }).state;
  shut.data = {};
  shut.certificates = {};
  assert.deepStrictEqual(run(shut, args).out.intents, open.intents);
});

console.log('hashing');

test('sha256 matches node:crypto, across block boundaries and non-ASCII', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'café ✓']) {
    assert.strictEqual(sha256(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});
test('the hash moves with code, params, exit settings and declared helpers', () => {
  const base = strategyHash(STRATEGY);
  assert.strictEqual(strategyHash({ ...STRATEGY }), base);
  assert.notStrictEqual(strategyHash({ ...STRATEGY, params: { n: 6 } }), base);
  assert.notStrictEqual(strategyHash({ ...STRATEGY, signals: (ctx) => [ctx] }), base);
  assert.notStrictEqual(strategyHash({ ...STRATEGY, exitOverrides: { trail: { enabled: false } } }), base);
  assert.notStrictEqual(strategyHash({ ...STRATEGY, codeDeps: [() => 1] }), strategyHash({ ...STRATEGY, codeDeps: [() => 2] }));
});
test('line endings do not change the hash', () => {
  const lf = { ...STRATEGY, signals: { toString: () => 'a\nb' } };
  assert.strictEqual(canonicalJson({ a: 1, b: [NaN, undefined] }), canonicalJson(clone({ b: [NaN, undefined], a: 1 })));
  assert.throws(() => strategyHash(lf));
  const fn = () => 1;
  const crlf = () => 1;
  crlf.toString = () => 'x\r\ny';
  fn.toString = () => 'x\ny';
  assert.strictEqual(strategyHash({ ...STRATEGY, signals: fn }), strategyHash({ ...STRATEGY, signals: crlf }));
});
test('DEV_END matches v6Bars', () => assert.strictEqual(DEV_END, BARS_DEV_END));

console.log('certificates');

const verify = (cert, strategy = STRATEGY, t = T0 + DAY) => verifyCertificate(cert, strategy, t);

test('a good certificate verifies, and survives a JSON round trip', () => {
  assert.strictEqual(verify(CERT).code, 'ok');
  assert.strictEqual(verify(clone(CERT)).code, 'ok');
});
test('store fields added around a certificate do not break it', () => {
  assert.strictEqual(verify({ ...clone(CERT), id: 'row1', created_date: 'x' }).code, 'ok');
});
test('editing any field breaks the seal', () => {
  const edits = {
    status: (c) => { c.status = 'failed'; }, hash: (c) => { c.hash = 'a'.repeat(64); }, expires_at: (c) => { c.expires_at += DAY; },
    criteria: (c) => { c.criteria[2].value = 'other'; }, band: (c) => { c.expected.points[10].lo = -9999; }, trials: (c) => { c.trial_count = 1; },
    holdout_clean: (c) => { c.holdout_clean = false; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const c = clone(CERT);
    edit(c);
    assert.strictEqual(verify(c).code, 'bad_seal', name);
  }
});
test('wrong code, params, id or version is refused', () => {
  assert.strictEqual(verify(CERT, { ...STRATEGY, params: { n: 6 } }).code, 'hash_mismatch');
  assert.strictEqual(verify(CERT, { ...STRATEGY, signals: () => [] }).code, 'hash_mismatch');
  assert.strictEqual(verify(CERT, { ...STRATEGY, id: 'other' }).code, 'wrong_strategy');
  assert.strictEqual(verify(CERT, { ...STRATEGY, version: 2 }).code, 'wrong_version');
});
test('expiry is exact, and a future date or missing clock is refused', () => {
  assert.strictEqual(verify(CERT, STRATEGY, CERT.expires_at - 1).code, 'ok');
  assert.strictEqual(verify(CERT, STRATEGY, CERT.expires_at).code, 'expired');
  assert.strictEqual(verify(CERT, STRATEGY, T0 - 1).code, 'not_yet_valid');
  assert.strictEqual(verifyCertificate(CERT, STRATEGY, undefined).code, 'expired');
});
test('every one of D1-D8 and H1-H4 is held in the certificate', () => {
  assert.deepStrictEqual(CERT.criteria.map((c) => c.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'H1', 'H2', 'H3', 'H4']);
  assert.ok(CERT.criteria.every((c) => c.group && c.label && c.needs && c.status === 'pass'));
});
test('one failed or missing D row gives a failed certificate, which is refused', () => {
  for (const devCriteria of [{ ...DEV_OK, D5: { pass: false } }, Object.fromEntries(Object.entries(DEV_OK).filter(([k]) => k !== 'D2'))]) {
    const c = issue({ devCriteria });
    assert.strictEqual(c.status, 'failed');
    assert.strictEqual(c.expected, null);
    assert.strictEqual(verify(c).code, 'not_valid_status');
  }
});
test('H1-H4 are judged here against the frozen thresholds', () => {
  const bad = { H1: { sharpe: 0.49 }, H2: { maxDrawdown: 0.26, btcMaxDrawdown: 0.5 }, H3: { totalReturn: 0 }, H4: { maxDrawdown: 0.2, btcMaxDrawdown: 0.2 } };
  for (const [id, change] of Object.entries(bad)) {
    const c = issue({ holdout: { ...HOLDOUT_OK, ...change } });
    assert.strictEqual(c.status, 'failed', id);
    assert.strictEqual(c.criteria.find((r) => r.id === id).status, 'fail', id);
  }
});
test('no holdout result gives not_run rows and a failed certificate', () => {
  const c = issue({ holdout: undefined });
  assert.strictEqual(c.status, 'failed');
  assert.ok(c.criteria.filter((r) => r.group === 'holdout').every((r) => r.status === 'not_run'));
});
test('a re-sealed certificate with a failed row is still refused', () => {
  const c = clone(CERT);
  c.criteria[2].status = 'fail';
  const { seal, ...body } = c;
  c.seal = sha256(canonicalJson(body));
  assert.notStrictEqual(c.seal, seal);
  assert.strictEqual(verify(c).code, 'criteria_not_passed');
});
test('issuing needs its inputs, and a pass needs enough trades for a band', () => {
  assert.throws(() => issue({ issuer: '' }), /issuer/);
  assert.throws(() => issue({ issuedAt: undefined }), /issuedAt/);
  assert.throws(() => issue({ trialCount: 0 }), /trial/);
  assert.throws(() => issue({ holdoutClean: undefined }), /holdoutClean/);
  assert.throws(() => issue({ tradeReturnsPct: [1, 2, 3] }), /trade returns/);
});
test('no app code can issue a certificate or use the pass-through', () => {
  const hits = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'shared' || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name) && /issueCertificate|PASS_THROUGH_GATE/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  for (const dir of ['src', 'server', 'base44']) walk(join(ROOT, dir));
  assert.deepStrictEqual(hits, []);
});
test('the gate module does not import the research store or the exchange hub', () => {
  const src = readFileSync(join(ROOT, 'shared/trading/v6SignalGate.js'), 'utf8');
  assert.ok(!/from '.*(v6Bars|v6Exchanges|v6Sim|node:)/.test(src));
});

console.log('drift monitor');

const BAND = CERT.expected;

test('the band has chart percentiles, and breach limits outside them', () => {
  const p = BAND.points[49];
  assert.ok(p.lo < p.p5 && p.p5 < p.p50 && p.p50 < p.p95 && p.p95 < p.hi);
  const sampleMean = RETURNS.reduce((a, x) => a + x, 0) / RETURNS.length;
  assert.ok(Math.abs(p.p50 - 50 * sampleMean) < 10, `median ${p.p50} after 50 trades of sample mean ${sampleMean}`);
});
test('the band is deterministic for a seed', () => {
  assert.deepStrictEqual(buildExpectedBand(RETURNS), BAND);
});
test('a healthy strategy is rarely demoted over 100 trades, across different backtest samples', () => {
  // Several backtests, because the band is built from one sample whose mean is itself uncertain.
  let demoted = 0, runs = 0;
  for (const backtest of [1, 11, 21, 31, 41, 51, 61, 71]) {
    const band = buildExpectedBand(draws(150, { seed: backtest }));
    for (let seed = 1000; seed < 1200; seed++) {
      const fresh = draws(100, { seed: seed + backtest * 7919 });
      runs++;
      for (let n = band.min_trades; n <= 100; n++) {
        if (evaluateDrift(band, fresh.slice(0, n)).status === 'breach') { demoted++; break; }
      }
    }
  }
  console.log(`        false demotion rate ${(demoted / runs * 100).toFixed(1)}% (target about ${BAND.alpha * 100}%)`);
  assert.ok(demoted / runs <= 0.12, `${demoted} of ${runs}`);
});
test('a strategy that lost its edge is caught, across the same backtest samples', () => {
  let caught = 0, runs = 0;
  const lags = [];
  for (const backtest of [1, 11, 21, 31, 41, 51, 61, 71]) {
    const band = buildExpectedBand(draws(150, { seed: backtest }));
    for (let seed = 2000; seed < 2100; seed++) {
      const fresh = draws(100, { mean: -1, seed: seed + backtest * 7919 });
      runs++;
      for (let n = band.min_trades; n <= 100; n++) {
        if (evaluateDrift(band, fresh.slice(0, n)).status === 'breach') { caught++; lags.push(n); break; }
      }
    }
  }
  lags.sort((x, y) => x - y);
  console.log(`        caught ${(caught / runs * 100).toFixed(1)}%, median after ${lags[lags.length >> 1]} trades`);
  assert.ok(caught / runs >= 0.8, `${caught} of ${runs}`);
});
test('results far above the range also count as outside it', () => {
  assert.strictEqual(evaluateDrift(BAND, Array(10).fill(60)).status, 'breach');
});
test('before min_trades it is warming and allowed, past the band it rolls', () => {
  assert.strictEqual(evaluateDrift(BAND, []).status, 'warming');
  assert.strictEqual(evaluateDrift(BAND, [-90, -90]).ok, true);
  const long = [...Array(200).fill(-5), ...Array(100).fill(1)];
  assert.strictEqual(evaluateDrift(BAND, long).status, 'inside');
});
test('no band or an unreadable series is unknown and not ok', () => {
  for (const [e, r] of [[null, []], [{}, []], [BAND, null], [BAND, [1, NaN]]]) assert.deepStrictEqual([evaluateDrift(e, r).status, evaluateDrift(e, r).ok], ['unknown', false]);
});

console.log('lifecycle');

const forward = (state, returns, certificate = CERT, from = 0) => {
  let s = state;
  const events = [];
  returns.forEach((returnPct, i) => {
    const r = recordForwardTrade(s, { returnPct, t: T0 + (from + i) * DAY, tradeId: `t${from + i}` }, { certificate });
    s = r.state;
    events.push(...r.events);
  });
  return { state: s, events };
};

test('research -> certified -> paper_half needs a valid certificate at each step', () => {
  let s = initialStrategyState({ strategy: STRATEGY });
  assert.strictEqual(advanceLifecycle(s, { strategy: STRATEGY, certificate: null, t: T0 + DAY }).state.lifecycle, 'research');
  assert.strictEqual(advanceLifecycle(s, { strategy: STRATEGY, certificate: issue({ holdout: undefined }), t: T0 + DAY }).state.lifecycle, 'research');
  s = advanceLifecycle(s, { strategy: STRATEGY, certificate: CERT, t: T0 + DAY }).state;
  assert.strictEqual(s.lifecycle, 'certified');
  assert.strictEqual(sizeMultiplierFor(s), 0);
  s = advanceLifecycle(s, { strategy: STRATEGY, certificate: CERT, t: T0 + DAY }).state;
  assert.strictEqual(s.lifecycle, 'paper_half');
  assert.strictEqual(sizeMultiplierFor(s), HALF_RISK);
});
test('half risk holds until exactly 20 forward trades, then full', () => {
  const flat = Array(FORWARD_TRADES_TO_FULL - 1).fill(1);
  const before = forward(paperState(), flat);
  assert.strictEqual(before.state.lifecycle, 'paper_half');
  const after = forward(before.state, [1], CERT, FORWARD_TRADES_TO_FULL - 1);
  assert.strictEqual(after.state.lifecycle, 'paper_full');
  assert.strictEqual(sizeMultiplierFor(after.state), 1);
  assert.ok(after.events.some((e) => e.code === 'strategy_full_risk'));
});
test('a full-risk state short of 20 trades is treated as half', () => {
  assert.strictEqual(sizeMultiplierFor({ ...paperState(), lifecycle: 'paper_full', forward_trades: 19 }), HALF_RISK);
});
test('a breach demotes automatically and blocks entries', () => {
  const { state, events } = forward(paperState(), Array(8).fill(-40));
  assert.strictEqual(state.lifecycle, 'shadow');
  assert.strictEqual(state.size_multiplier, 0);
  assert.strictEqual(state.drift_status, 'breach');
  assert.ok(state.demoted_at && state.demotion_reason);
  assert.ok(events.some((e) => e.code === 'strategy_demoted'));
  assert.strictEqual(createSignalGate({ states: { up_day: state }, certificates: { up_day: CERT } }).modeFor(STRATEGY), 'shadow');
});
test('a breach on trade 20 demotes rather than promotes', () => {
  const s = forward(paperState(), [...Array(19).fill(1), 9000]).state;
  assert.strictEqual(s.lifecycle, 'shadow');
});
test('a replayed trade id is not counted twice', () => {
  const a = forward(paperState(), [1, 2]).state;
  const b = recordForwardTrade(a, { returnPct: 2, t: T0, tradeId: 't1' }, { certificate: CERT }).state;
  assert.strictEqual(b.forward_trades, 2);
});
test('a tampered certificate cannot move the band: drift goes unknown and check 2 fails', () => {
  const bad = clone(CERT);
  bad.expected.points.forEach((p) => { p.lo = -1e9; p.hi = 1e9; });
  const s = forward(paperState(), Array(8).fill(-40), bad).state;
  assert.strictEqual(s.drift_status, 'unknown');
  const f = fixture();
  f.states.up_day = s;
  assert.strictEqual(statusOf(run(f).row).drift, 'fail');
});
test('an unreadable trade return makes drift unknown, not silently fine', () => {
  assert.strictEqual(recordForwardTrade(paperState(), { returnPct: NaN, t: T0 }, { certificate: CERT }).state.drift_status, 'unknown');
});
test('a trade closing after demotion is not forward evidence', () => {
  const s = forward(paperState(), Array(8).fill(-40)).state;
  assert.strictEqual(forward(s, [1, 1], CERT, 50).state.forward_trades, s.forward_trades);
});

console.log('shadow and the way back');

const demoted = () => forward(paperState(), Array(8).fill(-40)).state;
const inRange = (state, n, certificate = CERT) => {
  let s = state;
  for (let i = 0; i < n; i++) s = recordShadowResult(s, { book: [], closed: [{ symbol: 'BTCUSDT', returnPct: 1 }] }, { certificate }).state;
  return s;
};
const human = (state, over = {}) => returnFromShadow(state, { t: T0 + 50 * DAY, by: 'kollossus55', confirm: true, strategy: STRATEGY, certificate: CERT, ...over });

test('nothing automatic leaves shadow, however many signals are in range', () => {
  const s = inRange(demoted(), 40);
  assert.strictEqual(advanceLifecycle(s, { strategy: STRATEGY, certificate: CERT, t: T0 + 50 * DAY }).state.lifecycle, 'shadow');
  assert.strictEqual(forward(s, [1, 1, 1], CERT, 100).state.lifecycle, 'shadow');
  assert.strictEqual(recordShadowResult(s, { book: [], closed: [{ returnPct: 1 }] }, { certificate: CERT }).state.lifecycle, 'shadow');
});
test('a human return is refused at 19 and allowed at 20', () => {
  const short = human(inRange(demoted(), SHADOW_SIGNALS_TO_RETURN - 1));
  assert.deepStrictEqual([short.ok, short.reason], [false, 'not_enough_shadow_signals']);
  assert.strictEqual(short.state.lifecycle, 'shadow');
  assert.strictEqual(human(inRange(demoted(), SHADOW_SIGNALS_TO_RETURN)).ok, true);
});
test('the return restarts at half risk with a clean forward count', () => {
  const r = human(inRange(demoted(), 20));
  assert.strictEqual(r.state.lifecycle, 'paper_half');
  assert.strictEqual(sizeMultiplierFor(r.state), HALF_RISK);
  assert.strictEqual(r.state.forward_trades, 0);
  assert.deepStrictEqual(r.state.forward_series, []);
  assert.strictEqual(r.state.drift_status, 'warming');
  assert.strictEqual(r.state.transitions.at(-1).by, 'kollossus55');
});
test('a human return needs confirmation, a name, a clock and a valid certificate', () => {
  const s = inRange(demoted(), 20);
  assert.strictEqual(human(s, { confirm: 'yes' }).reason, 'not_confirmed');
  assert.strictEqual(human(s, { by: ' ' }).reason, 'no_human_named');
  assert.strictEqual(human(s, { t: undefined }).reason, 'invalid_clock');
  assert.strictEqual(human(s, { certificate: null }).reason, 'invalid_certificate');
  assert.strictEqual(human(s, { t: CERT.expires_at }).reason, 'invalid_certificate');
  assert.strictEqual(human(paperState()).reason, 'not_in_shadow');
});
test('leaving the range restarts the shadow count', () => {
  let s = inRange(demoted(), 15);
  assert.strictEqual(s.shadow_in_range, 15);
  s = recordShadowResult(s, { book: [], closed: [{ returnPct: -500 }] }, { certificate: CERT }).state;
  assert.strictEqual(s.shadow_in_range, 0);
});
test('a failed candidate in shadow can never count its way out', () => {
  const s = inRange(demoteToShadow(initialStrategyState({ strategy: STRATEGY }), { t: T0, reason: 'failed candidate' }).state, 30, null);
  assert.strictEqual(s.shadow_in_range, 0);
  assert.strictEqual(human(s, { certificate: issue({ holdout: undefined }) }).reason, 'invalid_certificate');
});

const shadowFixture = () => {
  const f = fixture();
  f.states.up_day = demoted();
  return f;
};
const nextBar = (f, change) => {
  const last = f.bars.at(-1);
  const c = last.c * (1 + change);
  return { t: last.t + DAY, o: last.c, h: Math.max(last.c, c) * 1.001, l: Math.min(last.c, c) * 0.999, c, v: 1000, qv: 1e9 };
};
const roll = (f, bar) => {
  f.bars = [...f.bars, bar];
  f.t = bar.t + DAY;
  const p = bar.c;
  f.data.books.set('BTCUSDT', { bids: [[p * 0.99999, 1e6]], asks: [[p * 1.00001, 1e6]], t: f.t });
  const r = f.data.replay.get('BTCUSDT');
  r.bars = [...r.bars, { ...bar, c: bar.c * 1.001 }];
};

test('shadow logs the would-be trade with all seven results and takes no position', () => {
  const f = shadowFixture();
  const { row, enters, out } = run(f);
  assert.strictEqual(enters.length, 0);
  assert.strictEqual(out.intents.length, 0);
  assert.strictEqual(row.outcome, 'shadow');
  const s = statusOf(row);
  assert.deepStrictEqual([s.certificate, s.drift], ['fail', 'fail']);
  for (const id of ['data', 'replay', 'liquidity', 'history', 'risk']) assert.strictEqual(s[id], 'pass', id);
  assert.match(row.checks[0].text, /shadow/);
  assert.strictEqual(out.shadow.up_day.book.length, 1);
  assert.strictEqual(out.shadow.up_day.book[0].pending, true);
});
test('preSize refuses a shadow strategy even if step were to ask it directly', () => {
  const f = shadowFixture();
  const gate = createSignalGate({ states: f.states, certificates: f.certificates, data: f.data });
  const market = marketFor(f);
  const v = gate.preSize({ symbol: 'BTCUSDT', side: 'long', stopDistancePct: 0.1 }, { t: f.t, strategy: STRATEGY, market, positions: new Map(), universe: ['BTCUSDT'], regime: null });
  assert.strictEqual(v.ok, false);
});
test('a shadow signal with bad data opens no virtual trade', () => {
  const f = shadowFixture();
  f.data.consensus.get('BTCUSDT').ok = false;
  const { row, out } = run(f);
  assert.strictEqual(row.outcome, 'shadow');
  assert.strictEqual(out.shadow.up_day.book.length, 0);
});
test('a virtual trade fills at the next open, survives a restart, and closes at its stop net of costs', () => {
  const f = shadowFixture();
  let state = f.states.up_day;
  const advance = () => {
    f.states.up_day = state;
    const { out } = run(f);
    state = clone(recordShadowResult(state, out.shadow.up_day, { certificate: CERT }).state);
    return out;
  };
  advance();
  assert.strictEqual(state.shadow_book[0].pending, true);

  const fillBar = nextBar(f, 0.01);
  roll(f, fillBar);
  advance();
  const open = state.shadow_book.find((v) => !v.pending);
  assert.ok(open, 'the virtual trade should have filled');
  const slip = costFor('BTCUSDT', 1).slipPct;
  assert.ok(Math.abs(open.position.entryPrice - fillBar.o * (1 + slip / 100)) < 1e-9);
  assert.ok(open.position.exitPlan.hardStopPrice < open.position.entryPrice);

  const crash = nextBar(f, -0.3);
  roll(f, crash);
  const before = state.shadow_in_range;
  const out = advance();
  const closed = out.shadow.up_day.closed;
  assert.strictEqual(closed.length, 1);
  assert.match(closed[0].reasonCode, /stop/);
  assert.ok(closed[0].returnPct < -10 - 0.2, `${closed[0].returnPct}`);
  assert.strictEqual(state.shadow_in_range, before + 1);
  assert.ok(!state.shadow_book.some((v) => v.symbol === 'BTCUSDT' && !v.pending));
});

console.log('restart');

test('state and certificate through JSON give the same verdict', () => {
  const f = fixture();
  const a = run(f).row;
  f.states = clone(f.states);
  f.certificates = clone(f.certificates);
  f.data.history = clone(f.data.history);
  const b = run(f).row;
  assert.deepStrictEqual(b.checks, a.checks);
  assert.strictEqual(b.outcome, 'entered');
});
test('every lifecycle state survives JSON unchanged in meaning', () => {
  const states = [
    initialStrategyState({ strategy: STRATEGY }), paperState(), forward(paperState(), Array(20).fill(1)).state, demoted(), inRange(demoted(), 20),
  ];
  for (const s of states) {
    const again = clone(s);
    assert.deepStrictEqual(again, s);
    assert.strictEqual(sizeMultiplierFor(again), sizeMultiplierFor(s));
  }
  assert.strictEqual(human(clone(inRange(demoted(), 20))).ok, true);
});
test('a forward series picks up after a restart with the same result as without one', () => {
  const returns = draws(30, { seed: 7 });
  const straight = forward(paperState(), returns).state;
  const part = clone(forward(paperState(), returns.slice(0, 13)).state);
  const resumed = forward(part, returns.slice(13), clone(CERT), 13).state;
  assert.deepStrictEqual(resumed, straight);
});

console.log('trade outcomes');

test('a position closed in parts is one outcome, on its whole notional', () => {
  const part = { symbol: 'X', strategyId: 's', side: 'long', entryTime: 1, entryPrice: 100, exitTime: 2, qty: 5, pnl: 50, rMultiple: 0.5, partial: true };
  const rest = { ...part, exitTime: 3, qty: 5, pnl: 10, rMultiple: 1.2, partial: false };
  const [o, ...others] = tradeOutcomes([part, rest]);
  assert.strictEqual(others.length, 0);
  assert.ok(Math.abs(o.returnPct - 6) < 1e-9);
  assert.strictEqual(o.rMultiple, 1.2);
  assert.strictEqual(o.exitTime, 3);
});
test('a position not yet flat is left out', () => {
  assert.deepStrictEqual(tradeOutcomes([{ symbol: 'X', strategyId: 's', side: 'long', entryTime: 1, entryPrice: 100, exitTime: 2, qty: 5, pnl: 50, partial: true }]), []);
});

console.log(`\nv6SignalGate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
