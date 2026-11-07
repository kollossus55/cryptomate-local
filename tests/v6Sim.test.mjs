/**
 * v6Sim adversarial tests. These try to catch the simulator lying: seeing the future,
 * filling at prices that were not available, or losing money in the accounts.
 * Real v6Risk, v6Exits and v6Paper throughout, unless a test says it uses fullWeightRisk.
 */
import assert from 'node:assert';
import { createIndicatorAccess, fullWeightRisk, step } from '../shared/trading/v6Core.js';
import { auditLookahead, checkDevCriteria, gridCombos, prepareMarket, runSim, trialRecord, walkForward } from '../shared/trading/v6Sim.js';
import { SIGNAL_ONLY_EXITS, btcAboveSma, buyAndHold, defineStrategy } from '../shared/trading/v6Strategies.js';
import * as REAL_RISK from '../shared/trading/v6Risk.js';
import { seededRandom, summarize } from '../shared/trading/v6Stats.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

const DAY = 86400000;
const T0 = Date.UTC(2022, 0, 1);
const dayT = (i) => T0 + i * DAY;
const tier1 = () => 1;
const FEE = 0.001, SLIP = 0.0003, STOP_SLIP = 0.001; // Tier 1 per side, plus the stop's extra

/** Bars from [o,h,l,c] rows. */
const rows = (list, t0 = T0) => list.map(([o, h, l, c], i) => ({ t: t0 + i * DAY, o, h, l, c, v: 1, qv: 1e9 }));
const flat = (n, p = 100) => rows(Array.from({ length: n }, () => [p, p, p, p]));

function walk(n, { seed = 1, drift = 0.0008, vol = 0.03, start = 100, t0 = T0 } = {}) {
  const r = seededRandom(seed);
  let c = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = c * (1 + (r() - 0.5) * vol * 0.3);
    c = o * (1 + (r() - 0.5) * 2 * vol + drift);
    const h = Math.max(o, c) * (1 + r() * vol * 0.5), l = Math.min(o, c) * (1 - r() * vol * 0.5);
    out.push({ t: t0 + i * DAY, o, h, l, c, v: 1000, qv: 1e8 * (1 + r()) });
  }
  return out;
}

/**
 * Scripted strategy: plan maps a bar index to a side. Fixed exits, so each test
 * isolates one rule. Run with fullWeightRisk unless real sizing is the point.
 */
function scripted(plan, { symbol = 'BTCUSDT', stopPct = 0.1, exitOverrides = SIGNAL_ONLY_EXITS, id = 's', perp = false } = {}) {
  return defineStrategy({
    id, name: id, timeframe: '1d', universe: { kind: 'fixed', symbols: [symbol] }, exitOverrides, perp,
    signals(ctx) {
      const side = plan[ctx.bars.get(symbol).length - 1];
      return side ? [{ strategyId: id, symbol, side, score: 0.5, stopDistancePct: stopPct, exitProfile: 'trend', reason: `plan ${side}`, meta: {} }] : [];
    },
  });
}
const half = { risk: fullWeightRisk({ weight: 0.5 }) };
const run = (strategy, bars, extra = {}) => runSim({ strategies: [strategy], bars: bars instanceof Map ? bars : new Map([['BTCUSDT', bars]]), costs: { tierFn: tier1 }, modules: half, ...extra });

/** A breakout rule across several coins, through the real risk and exit engines. */
const momentum = (params = { n: 20 }) => defineStrategy({
  id: 'mom', name: 'mom', timeframe: '1d', params, warmupBars: 40, grid: { n: [10, 20, 40] },
  universe: { kind: 'fixed', symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'] },
  signals(ctx) {
    return ctx.universe.map((symbol) => ({
      strategyId: 'mom', symbol, side: ctx.ind(symbol, 'roc', ctx.params.n) > 0 ? 'long' : 'flat', score: 0.5,
      stopDistancePct: 0.1, exitProfile: 'trend', reason: 'roc', meta: {},
    }));
  },
});
const coins = (n = 500, t0 = T0) => new Map(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'].map((s, i) => [s, walk(n, { seed: i + 1, t0 })]));
const fillKey = (f) => `${f.t}|${f.symbol}|${f.type}|${f.qty}|${f.price}`;

console.log('(a) future changes cannot alter the past');

test('a price spike at bar 300 changes no fill and no equity point before it', () => {
  const base = coins();
  const spiked = new Map([...base].map(([s, b]) => [s, b.map((x, i) => (i >= 300 ? { ...x, o: x.o * 50, h: x.h * 50, l: x.l * 50, c: x.c * 50 } : { ...x }))]));
  const a = runSim({ strategies: [momentum()], bars: base, from: dayT(60), costs: { tierFn: tier1 } });
  const b = runSim({ strategies: [momentum()], bars: spiked, from: dayT(60), costs: { tierFn: tier1 } });
  assert.ok(a.fills.length > 20, 'the run must trade for this test to mean anything');
  const before = (r) => r.fills.filter((f) => f.t < dayT(300)).map(fillKey);
  assert.deepStrictEqual(before(a), before(b));
  for (let i = 0; a.equity[i].t < dayT(300); i++) assert.strictEqual(a.equity[i].equity, b.equity[i].equity);
  assert.notStrictEqual(a.equity.at(-1).equity, b.equity.at(-1).equity, 'the spike must matter afterwards, or nothing was tested');
});

test('removing the future entirely changes nothing before the cut, at any cut', () => {
  const audit = auditLookahead({ strategy: momentum(), bars: coins(), from: dayT(60), costs: { tierFn: tier1 }, cuts: 8 });
  assert.ok(audit.ok, JSON.stringify(audit.cuts.filter((c) => !c.ok)));
  assert.strictEqual(audit.cuts.length, 8);
});

console.log('(b) a strategy that tries to peek');

test('ctx.bars holds nothing past t: every peek comes back empty', () => {
  const bars = coins(120);
  const checks = { steps: 0 };
  const peek = defineStrategy({
    id: 'peek', name: 'peek', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] },
    signals(ctx) {
      const b = ctx.bars.get('BTCUSDT');
      const last = b[b.length - 1];
      assert.strictEqual(last.t, ctx.barT);
      assert.strictEqual(ctx.t, last.t + DAY);
      assert.strictEqual(b[b.length], undefined);
      assert.strictEqual(b.at(b.length), undefined);
      assert.ok(b.every((x) => x.t + DAY <= ctx.t), 'every bar must be closed at t');
      assert.ok(b.slice(-5).every((x) => x.t <= ctx.barT));
      for (const v of ctx.bars.values()) assert.ok(!v.length || v[v.length - 1].t <= ctx.barT);
      assert.ok(!('series' in ctx) && !('calendar' in ctx) && !('market' in ctx));
      checks.steps++;
      return [];
    },
  });
  run(peek, bars, { from: dayT(50), modules: {} });
  assert.strictEqual(checks.steps, 70);
});

test('a negative indicator lag throws instead of reading tomorrow', () => {
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: (ctx) => { ctx.ind('BTCUSDT', 'sma', 5, -1); return []; } });
  assert.throws(() => run(s, walk(30), { from: dayT(10) }), /future/);
});

test('indicator values at t match a calculation from visible bars only', () => {
  const bars = walk(100);
  const s = defineStrategy({
    id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] },
    signals(ctx) {
      const b = ctx.bars.get('BTCUSDT');
      if (b.length >= 20) near(ctx.ind('BTCUSDT', 'sma', 20), b.slice(-20).reduce((a, x) => a + x.c, 0) / 20, 1e-9);
      return [];
    },
  });
  run(s, bars, { from: dayT(5) });
});

test('bars are frozen: a strategy cannot rewrite history', () => {
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: (ctx) => { ctx.bars.get('BTCUSDT').at(-1).c = 1; return []; } });
  assert.throws(() => run(s, walk(30), { from: dayT(5) }), /read only|Cannot assign/);
});

test('a strategy that alters the bars array is caught', () => {
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: (ctx) => { ctx.bars.get('BTCUSDT').pop(); return []; } });
  assert.throws(() => run(s, walk(30), { from: dayT(5) }), /altered/);
});

test('the limit of the audit: a closure over the full data passes unless rebuilt from the cut data', () => {
  const bars = coins(300);
  const rule = (data) => {
    const closes = data.get('BTCUSDT').map((b) => b.c);
    const mean = closes.reduce((a, x) => a + x, 0) / closes.length;
    return defineStrategy({
      id: 'fs', name: 'fs', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, exitOverrides: SIGNAL_ONLY_EXITS,
      signals: (ctx) => [{ strategyId: 'fs', symbol: 'BTCUSDT', side: ctx.bars.get('BTCUSDT').at(-1).c > mean ? 'long' : 'flat', score: 1, stopDistancePct: 0.5, exitProfile: 'trend', reason: 'x', meta: {} }],
    });
  };
  const args = { bars, from: dayT(30), costs: { tierFn: tier1 }, modules: half, cuts: 6 };
  assert.strictEqual(auditLookahead({ ...args, strategy: rule(bars) }).ok, true, 'if this starts failing, update docs/rebuild/core-sim.md');
  assert.strictEqual(auditLookahead({ ...args, rebuild: rule }).ok, false, 'a full-sample mean must fail the audit');
  assert.strictEqual(auditLookahead({ ...args, rebuild: () => btcAboveSma({ n: 20 }) }).ok, true);
});

console.log('(c) fills');

test('a signal at the close of bar k fills at the open of k+1, not at the signal close', () => {
  const bars = rows([[100, 101, 99, 100], [100, 101, 99, 100], [130, 131, 129, 130], [130, 131, 129, 130]]);
  const r = run(scripted({ 1: 'long' }), bars);
  const entry = r.fills[0];
  assert.strictEqual(entry.t, dayT(2));
  assert.strictEqual(entry.rawPrice, 130);
  near(entry.price, 130 * (1 + SLIP));
});

test('no signal on the last bar can fill: there is no next open', () => {
  const r = run(scripted({ 2: 'long' }), flat(3));
  assert.strictEqual(r.fills.length, 0);
});

test('an entry sized at the close survives an upward gap without overdrawing cash', () => {
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [200, 200, 200, 200], [200, 200, 200, 200]]);
  const r = run(scripted({ 1: 'long' }), bars, { modules: { risk: fullWeightRisk({ weight: 1 }) } });
  assert.ok(r.fills[0].qty < 100 && r.fills[0].qty > 49);
  assert.ok(r.equity.every((e) => e.cash >= 0));
});

test('the stop comes from the fill price, not the signal close', () => {
  // gap up to 200, stop 10%: 180 rather than 90, so the bar touching 170 stops it
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [200, 200, 170, 190], [190, 190, 190, 190]]);
  const r = run(scripted({ 1: 'long' }), bars);
  assert.strictEqual(r.trades[0].reasonCode, 'hard_stop');
  assert.strictEqual(r.trades[0].exitTime, dayT(2));
});

console.log('(d) stop gaps');

test('a gap through the stop fills at the open, the worse price, plus stop slippage', () => {
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 99, 100], [70, 75, 65, 72], [72, 72, 72, 72]]);
  const r = run(scripted({ 1: 'long' }), bars);
  const exit = r.fills.find((f) => f.type === 'exit');
  assert.strictEqual(exit.kind, 'stop');
  assert.strictEqual(exit.rawPrice, 70);
  near(exit.price, 70 * (1 - SLIP - STOP_SLIP));
  assert.strictEqual(exit.t, dayT(3));
  const stop = 100 * (1 + SLIP) * 0.9;
  near(r.costs.stopGap, (stop - 70) * exit.qty);
});

test('a touch without a gap fills at the stop price, not the bar low', () => {
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 99, 100], [100, 100, 60, 95], [95, 95, 95, 95]]);
  const r = run(scripted({ 1: 'long' }), bars);
  const exit = r.fills.find((f) => f.type === 'exit');
  const stop = 100 * (1 + SLIP) * 0.9;
  near(exit.rawPrice, stop);
  near(exit.price, stop * (1 - SLIP - STOP_SLIP));
});

test('a stop can fire on the entry bar itself', () => {
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 80, 95], [95, 95, 95, 95]]);
  const r = run(scripted({ 1: 'long' }), bars);
  assert.strictEqual(r.trades[0].exitTime, dayT(2));
  assert.strictEqual(r.fills[1].kind, 'stop');
});

test('a stop ratcheted on a bar does not catch that same bar', () => {
  const overrides = { ...SIGNAL_ONLY_EXITS, breakEven: { enabled: true, triggerR: 1, bufferPct: 0.05 } };
  // bar 3 runs to +30% (arms break-even) then dips to 101: above the old stop, below the new one
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 99, 100], [100, 130, 100, 120], [120, 121, 90, 100], [100, 100, 100, 100]]);
  const r = run(scripted({ 1: 'long' }, { exitOverrides: overrides }), bars);
  const trade = r.trades[0];
  assert.strictEqual(trade.reasonCode, 'breakeven_stop');
  assert.strictEqual(trade.exitTime, dayT(4), 'it may only fire on the bar after the ratchet');
});

console.log('(e) both touched');

test('a bar touching stop and target counts the stop first: no target fill, a full loss', () => {
  const overrides = { ...SIGNAL_ONLY_EXITS, partials: [{ atR: 1, fraction: 0.5 }] };
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 99, 100], [100, 150, 50, 100], [100, 100, 100, 100]]);
  const r = run(scripted({ 1: 'long' }, { exitOverrides: overrides }), bars);
  assert.strictEqual(r.fills.filter((f) => f.kind === 'target').length, 0);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].reasonCode, 'hard_stop');
  assert.ok(r.trades[0].pnl < 0);
});

test('a target alone fills at its own price with slippage, and the rest stays open', () => {
  const overrides = { ...SIGNAL_ONLY_EXITS, partials: [{ atR: 1, fraction: 0.5 }] };
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 101, 99, 100], [100, 150, 99, 140], [140, 140, 140, 140]]);
  const r = run(scripted({ 1: 'long' }, { exitOverrides: overrides }), bars);
  const target = r.fills.find((f) => f.kind === 'target');
  const entry = 100 * (1 + SLIP);
  near(target.rawPrice, entry * 1.1);
  near(target.price, entry * 1.1 * (1 - SLIP));
  near(target.qty, r.fills[0].qty / 2);
  assert.strictEqual(r.trades.filter((t) => !t.partial).length, 1, 'the close-out closes the remainder');
  assert.strictEqual(r.trades.filter((t) => t.partial).length, 1);
});

console.log('(f) equity');

test('equity = cash + marked positions at every step, rebuilt independently from the fills', () => {
  const bars = coins();
  const r = runSim({ strategies: [momentum()], bars, from: dayT(60), costs: { tierFn: tier1 } });
  assert.ok(r.fills.length > 20);
  let cash = 10000;
  const qty = new Map(), last = new Map();
  let f = 0;
  r.equity.forEach((point, i) => {
    const isLast = i === r.equity.length - 1;
    while (f < r.fills.length && r.fills[f].t <= point.t) {
      const x = r.fills[f++];
      const signed = x.action === 'buy' ? 1 : -1;
      cash -= signed * x.qty * x.price + x.fee;
      qty.set(x.symbol, (qty.get(x.symbol) || 0) + signed * x.qty);
    }
    let value = cash;
    for (const [s, q] of qty) {
      const b = bars.get(s).find((x) => x.t === point.t);
      if (b) last.set(s, b.c);
      value += q * last.get(s);
    }
    if (!isLast) {
      near(point.cash, cash, 1e-6);
      near(point.equity, value, 1e-6);
      near(point.equity, point.cash + point.gross, 1e-6);
    }
  });
  while (f < r.fills.length) {
    const x = r.fills[f++];
    cash -= (x.action === 'buy' ? 1 : -1) * x.qty * x.price + x.fee;
  }
  near(r.equity.at(-1).equity, cash, 1e-6);
});

test('the equity curve has one point per bar from `from`, starting at the initial equity', () => {
  const r = run(scripted({ 20: 'long' }), walk(60), { from: dayT(10), config: { initialEquity: 5000 } });
  assert.strictEqual(r.equity.length, 50);
  assert.strictEqual(r.equity[0].t, dayT(10));
  assert.strictEqual(r.equity[0].equity, 5000);
});

test('shared cash: two strategies draw on one account', () => {
  const bars = new Map([['BTCUSDT', flat(10)], ['ETHUSDT', flat(10, 50)]]);
  const a = scripted({ 1: 'long' }, { symbol: 'BTCUSDT', id: 'a' });
  const b = scripted({ 1: 'long' }, { symbol: 'ETHUSDT', id: 'b' });
  const r = runSim({ strategies: [a, b], bars, costs: { tierFn: tier1 }, modules: { risk: fullWeightRisk({ weight: 0.7 }) } });
  const spent = r.fills.filter((f) => f.type === 'enter').reduce((s, f) => s + f.qty * f.price + f.fee, 0);
  assert.ok(spent <= 10000 + 1e-6, `spent ${spent}`);
  assert.strictEqual(r.fills.filter((f) => f.type === 'enter').length, 2);
  assert.ok(r.equity.every((e) => e.cash >= 0));
});

console.log('(g) costs reconcile');

test('fees, P&L and the ledger agree to the cent', () => {
  const r = runSim({ strategies: [momentum()], bars: coins(), from: dayT(60), costs: { tierFn: tier1 } });
  assert.ok(r.trades.length > 10);
  const feeSum = r.fills.reduce((s, f) => s + f.fee, 0);
  near(feeSum, r.costs.fees, 1e-8);
  near(feeSum, r.ledger.fees, 1e-8);
  const pnl = r.trades.reduce((s, t) => s + t.pnl, 0);
  near(10000 + pnl, r.equity.at(-1).equity, 1e-6);
  near(r.ledger.realized, pnl, 1e-6);
  near(r.ledger.cash, r.equity.at(-1).equity, 1e-6);
  assert.strictEqual(r.ledger.positions.length, 0);
  const slip = r.fills.reduce((s, f) => s + Math.abs(f.price - f.rawPrice) * f.qty, 0);
  near(slip, r.costs.slippage, 1e-8);
});

test('2x stress doubles fee and slippage on every fill', () => {
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const plan = { 1: 'long', 2: 'flat' };
  const one = run(scripted(plan), bars);
  const two = run(scripted(plan), bars, { costs: { tierFn: tier1, stress: 2 } });
  near(one.fills[0].price, 100 * (1 + SLIP));
  near(two.fills[0].price, 100 * (1 + 2 * SLIP));
  near(two.fills[0].fee / (two.fills[0].qty * two.fills[0].price), 2 * FEE);
});

test('per-tier slippage: 0.03%, 0.08%, 0.25% from the tier function', () => {
  const entry = (tier) => run(scripted({ 1: 'long' }, { symbol: 'SOLUSDT' }), new Map([['SOLUSDT', flat(5)]]), { costs: { tierFn: () => tier } }).fills[0].price;
  near(entry(2), 100 * 1.0008);
  near(entry(3), 100 * 1.0025);
  const btc = run(scripted({ 1: 'long' }), flat(5), { costs: {} }).fills[0].price;
  near(btc, 100 * 1.0003);
});

test('tier is read as of the decision: tierFn never gets a t after the fill', () => {
  const seen = [];
  run(scripted({ 1: 'long', 3: 'flat' }), flat(6), { costs: { tierFn: (s, t) => { seen.push(t); return 1; } } });
  assert.ok(seen.length && seen.every((t) => t <= dayT(6)));
});

test('with no tierFn an unknown coin is costed as Tier 3, never cheaper', () => {
  const r = run(scripted({ 1: 'long' }, { symbol: 'SOLUSDT' }), new Map([['SOLUSDT', flat(5)]]), { costs: {} });
  near(r.fills[0].price, 100 * 1.0025);
});

console.log('(h) a hand-computed three-trade example');

test('three trades reproduce the hand calculation exactly', () => {
  // Weight 50% of equity, sized on the decision close. Tier 1: slip 0.03%, fee 0.10%.
  const bars = rows([
    [100, 100, 100, 100], // 0
    [100, 100, 100, 100], // 1  signal long
    [100, 112, 100, 110], // 2  trade 1 fills at the open, 100
    [110, 112, 109, 110], // 3  signal flat
    [120, 121, 119, 120], // 4  trade 1 exits at the open, 120
    [120, 121, 119, 120], // 5  signal long
    [125, 126, 124, 125], // 6  trade 2 fills at the open, 125
    [100, 104, 95, 100],  // 7  gap below the 10% stop: stopped at the open, 100
    [100, 100, 100, 100], // 8  signal long
    [100, 101, 99, 100],  // 9  trade 3 fills at the open, 100
    [100, 100, 85, 90],   // 10 stop touched without a gap
    [90, 90, 90, 90],     // 11
  ]);
  const r = run(scripted({ 1: 'long', 3: 'flat', 5: 'long', 8: 'long' }), bars);
  assert.strictEqual(r.trades.length, 3);

  let cash = 10000;
  // Trade 1. Equity 10000, qty 5000/100 = 50.
  const q1 = 50, in1 = 100 * 1.0003, out1 = 120 * 0.9997;
  const pnl1 = q1 * (out1 - in1) - q1 * in1 * FEE - q1 * out1 * FEE;
  cash += pnl1;
  near(r.trades[0].pnl, pnl1);
  near(r.trades[0].exitPrice, out1);
  assert.strictEqual(r.trades[0].reasonCode, 'signal_exit');

  // Trade 2. Decided at bar 5 on equity = cash, close 120.
  const q2 = (cash * 0.5) / 120, in2 = 125 * 1.0003, out2 = 100 * (1 - 0.0003 - 0.001);
  const pnl2 = q2 * (out2 - in2) - q2 * in2 * FEE - q2 * out2 * FEE;
  cash += pnl2;
  near(r.trades[1].qty, q2);
  near(r.trades[1].pnl, pnl2);
  near(r.trades[1].exitPrice, out2);
  assert.strictEqual(r.trades[1].reasonCode, 'hard_stop');

  // Trade 3. Close 100. Stop = 10% under the fill.
  const q3 = (cash * 0.5) / 100, in3 = 100 * 1.0003, stop3 = in3 * 0.9, out3 = stop3 * (1 - 0.0003 - 0.001);
  const pnl3 = q3 * (out3 - in3) - q3 * in3 * FEE - q3 * out3 * FEE;
  cash += pnl3;
  near(r.trades[2].pnl, pnl3);
  near(r.trades[2].exitPrice, out3);

  near(r.equity.at(-1).equity, cash);
  // On paper: 50 x (119.964 - 100.03) = 996.70, less fees 5.0015 + 5.9982 = 985.70.
  near(pnl1, 985.70, 0.01);
  near(r.equity.at(-1).equity, 10000 + r.trades.reduce((s, t) => s + t.pnl, 0));
});

console.log('delisting');

test('a dead coin exits at last close minus 10%, after the grace period, with the fee', () => {
  const dead = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 80]]);
  const bars = new Map([['BTCUSDT', flat(20)], ['XUSDT', dead]]);
  const r = runSim({ strategies: [scripted({ 1: 'long' }, { symbol: 'XUSDT', stopPct: 0.9 })], bars, costs: { tierFn: () => 3 }, modules: half });
  const exit = r.fills.find((f) => f.type === 'exit');
  assert.strictEqual(exit.kind, 'delist');
  near(exit.price, 80 * 0.9);
  near(exit.fee, exit.qty * exit.price * FEE);
  assert.strictEqual(r.trades[0].reasonCode, 'delisted');
  // Last bar is day 3, closing at day 4. The grace is 3 days, so noticed at day 8.
  assert.strictEqual(exit.t, dayT(8));
  near(r.costs.delistHaircut, exit.qty * 8);
});

test('a short gap in the data is not a delisting', () => {
  const list = flat(20, 100).filter((_, i) => i !== 5 && i !== 6);
  const bars = new Map([['BTCUSDT', flat(20)], ['XUSDT', list]]);
  const r = runSim({ strategies: [scripted({ 1: 'long' }, { symbol: 'XUSDT', stopPct: 0.9 })], bars, costs: { tierFn: () => 3 }, modules: half });
  assert.ok(!r.fills.some((f) => f.kind === 'delist'));
  assert.strictEqual(r.trades[0].reasonCode, 'end_of_sim');
});

test('delisting leaks nothing: the same bars cut short before the death look alive', () => {
  const dead = walk(100, { seed: 4 });
  const long = new Map([['BTCUSDT', walk(200)], ['XUSDT', dead]]);
  const s = () => scripted({ 50: 'long' }, { symbol: 'XUSDT', stopPct: 0.9 });
  const a = runSim({ strategies: [s()], bars: long, costs: { tierFn: () => 3 }, modules: half, closeOut: false });
  assert.ok(a.fills.some((f) => f.kind === 'delist'));
  const audit = auditLookahead({ strategy: s(), bars: long, costs: { tierFn: () => 3 }, modules: half, cuts: 6 });
  assert.ok(audit.ok, JSON.stringify(audit.cuts));
});

test('a coin that ends at the end of the data is alive, not delisted', () => {
  const r = run(scripted({ 1: 'long' }), flat(10));
  assert.strictEqual(r.trades[0].reasonCode, 'end_of_sim');
});

console.log('perps');

const perpBars = () => rows(Array.from({ length: 6 }, () => [100, 100, 100, 100]));

test('perp: 0.05% fee, and a long pays positive funding at each event while held', () => {
  const funding = new Map([['BTCUSDT', [
    { t: dayT(1) + 8 * 3600e3, rate: 0.5 }, // before the entry: not charged
    { t: dayT(2), rate: 0.5 },              // the instant of the entry fill: not charged
    { t: dayT(2) + 8 * 3600e3, rate: 0.001 },
    { t: dayT(3), rate: 0.002, mark: 110 },
    { t: dayT(4), rate: 0.003 },            // the instant of the exit fill: still held, charged
    { t: dayT(4) + 3600e3, rate: 0.5 },     // after the exit: not charged
  ]]]);
  const r = run(scripted({ 1: 'long', 3: 'flat' }, { perp: true }), perpBars(), { costs: { tierFn: tier1, funding } });
  const q = r.fills[0].qty;
  near(r.fills[0].fee, q * r.fills[0].price * 0.0005);
  near(r.costs.funding, q * (100 * 0.001 + 110 * 0.002 + 100 * 0.003));
  near(r.trades[0].funding, r.costs.funding);
  near(r.ledger.realized, r.trades[0].pnl);
  near(r.equity.at(-1).equity, 10000 + r.trades[0].pnl);
});

test('perp: a long receives negative funding', () => {
  const funding = new Map([['BTCUSDT', [{ t: dayT(2) + 3600e3, rate: -0.001 }]]]);
  const r = run(scripted({ 1: 'long', 3: 'flat' }, { perp: true }), perpBars(), { costs: { tierFn: tier1, funding } });
  near(r.costs.funding, -r.fills[0].qty * 100 * 0.001);
});

test('perp: a short receives positive funding and profits from a fall (benchmark sizing)', () => {
  const funding = new Map([['BTCUSDT', [{ t: dayT(2) + 3600e3, rate: 0.001 }]]]);
  const bars = rows([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [80, 80, 80, 80], [80, 80, 80, 80], [80, 80, 80, 80]]);
  const r = run(scripted({ 1: 'short', 3: 'flat' }, { perp: true, stopPct: 0.5 }), bars, { costs: { tierFn: tier1, funding } });
  const f = r.fills[0];
  assert.strictEqual(f.action, 'sell');
  near(f.price, 100 * (1 - SLIP));
  assert.strictEqual(r.fills[1].action, 'buy');
  near(r.costs.funding, -f.qty * 100 * 0.001);
  assert.ok(r.trades[0].pnl > 0);
});

test('perp: missing funding is an error, never silently zero', () => {
  assert.throws(() => run(scripted({ 1: 'long', 3: 'flat' }, { perp: true }), perpBars()), /funding/);
});

test('funding on a spot strategy: none charged', () => {
  const funding = new Map([['BTCUSDT', [{ t: dayT(2) + 3600e3, rate: 0.5 }]]]);
  const r = run(scripted({ 1: 'long', 3: 'flat' }), perpBars(), { costs: { tierFn: tier1, funding } });
  assert.strictEqual(r.costs.funding, 0);
});

test('perp shorts through the real risk engine are refused, so nothing fills', () => {
  const bars = walk(60);
  const funding = new Map([['BTCUSDT', []]]);
  const r = run(scripted({ 45: 'short' }, { perp: true }), bars, { costs: { tierFn: tier1, funding }, modules: {}, from: dayT(30) });
  assert.strictEqual(r.fills.length, 0);
  assert.ok(r.events.some((e) => e.message === 'short_not_supported'));
});

console.log('universe');

test("a 'top' universe without a universeFn refuses to run", () => {
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'top', n: 5 }, signals: () => [] });
  assert.throws(() => run(s, flat(5)), /survivorship/);
});

test('universeFn is asked at the decision time, and never past the last fillable close', () => {
  const seen = [];
  const bars = flat(10);
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'top', n: 5 }, signals: (ctx) => { assert.deepStrictEqual(ctx.universe, ctx.barT === dayT(8) ? [] : ['BTCUSDT']); return []; } });
  run(s, bars, { from: dayT(1), to: dayT(8), universeFn: (t, o) => { seen.push(t); assert.strictEqual(o.topN, 5); return ['BTCUSDT']; } });
  assert.strictEqual(seen[0], dayT(2)); // first decision: the close of bar 1
  assert.strictEqual(Math.max(...seen), dayT(8)); // the close of bar 7; bar 8's decision can never fill
});

test('the holdout boundary: nothing asks the store about the instant the data ends', () => {
  const end = dayT(30);
  const guard = (t) => { if (t >= end) throw new Error('holdout'); return ['BTCUSDT']; };
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'top', n: 5 }, signals: () => [] });
  run(s, walk(30), { universeFn: guard, costs: { tierFn: (sym, t) => { guard(t); return 1; } } });
  const held = scripted({ 3: 'long' });
  run(held, walk(30), { costs: { tierFn: (sym, t) => { guard(t); return 1; } } });
});

test('a coin out of the universe cannot be entered, and one that leaves can still exit', () => {
  const inUniverse = (t) => (t <= dayT(3) ? ['BTCUSDT'] : []);
  const s = defineStrategy({
    id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'top', n: 1 }, exitOverrides: SIGNAL_ONLY_EXITS,
    signals: (ctx) => {
      const i = ctx.bars.get('BTCUSDT').length - 1;
      const sig = (side) => [{ strategyId: 'x', symbol: 'BTCUSDT', side, score: 1, stopDistancePct: 0.5, exitProfile: 'trend', reason: 'x', meta: {} }];
      if (i === 1) return sig('long');
      if (i === 5) return sig('flat');
      if (i === 7) return sig('long');
      return [];
    },
  });
  const r = run(s, flat(12), { universeFn: inUniverse });
  assert.deepStrictEqual(r.fills.map((f) => `${f.type}@${(f.t - T0) / DAY}`), ['enter@2', 'exit@6']);
  assert.ok(r.events.some((e) => e.code === 'not_in_universe'));
});

test('warmupBars: no signal is acted on before the history exists', () => {
  const s = btcAboveSma({ n: 50, stopPct: 0.5 });
  const r = run(s, walk(120, { drift: 0.01 }), { from: dayT(5) });
  assert.ok(r.fills.length > 0);
  assert.ok(r.fills[0].t >= dayT(50));
});

test('decisions run on 1d or 4h only', () => {
  assert.throws(() => defineStrategy({ id: 'x', name: 'x', timeframe: '1h', universe: { kind: 'fixed', symbols: ['A'] }, signals: () => [] }), /1d or 4h/);
});

test('a strategy on the wrong timeframe for the bars refuses to run', () => {
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '4h', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: () => [] });
  assert.throws(() => run(s, flat(5)), /4h/);
});

test('unsorted or bad bars are rejected up front', () => {
  assert.throws(() => prepareMarket(new Map([['A', [{ t: 2, o: 1, h: 1, l: 1, c: 1 }, { t: 1, o: 1, h: 1, l: 1, c: 1 }]]])), /ascending/);
  assert.throws(() => prepareMarket(new Map([['A', [{ t: 1, o: 1, h: 1, l: 1, c: NaN }, { t: 2, o: 1, h: 1, l: 1, c: 1 }]]])), /bad prices/);
});

console.log('drawdown ladder end to end');

test('-20% through runSim: all positions exit, entries stop, the halt holds to the end', () => {
  // Eight coins held at the real risk engine's sizes, then a slow bleed in everything
  // that stays inside each stop, so only the portfolio halt can act. Full-size weights
  // are needed to reach -20%, so raise the caps to their ceilings.
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT', 'LTCUSDT', 'DOTUSDT', 'BNBUSDT'];
  const n = 200;
  const up = Array.from({ length: 120 }, (_, i) => 100 * 1.001 ** i);
  const closes = [...up];
  while (closes.length < n) closes.push(closes.at(-1) * 0.965);
  const series = (k) => closes.map((c, i) => {
    const w = 1 + 0.01 * Math.sin(i * 1.3 + k);
    return { t: dayT(i), o: c * w, h: c * w * 1.002, l: c * w * 0.998, c: c * w, v: 1, qv: 1e9 };
  });
  const bars = new Map(symbols.map((s, k) => [s, series(k)]));
  const holders = defineStrategy({
    id: 'h', name: 'h', timeframe: '1d', universe: { kind: 'fixed', symbols }, warmupBars: 40, exitOverrides: SIGNAL_ONLY_EXITS,
    signals: (ctx) => ctx.universe.map((symbol) => ({ strategyId: 'h', symbol, side: 'long', score: 0.5, stopDistancePct: 0.25, exitProfile: 'trend', reason: 'hold', meta: {} })),
  });
  const r = runSim({ strategies: [holders], bars, costs: { tierFn: tier1 }, from: dayT(45), modules: { risk: bleedRisk() }, simReEnable: false });
  const flatten = r.fills.filter((f) => f.reasonCode === 'risk_flatten');
  assert.ok(flatten.length > 0, `expected a flatten, got ${JSON.stringify(r.summary.eventCounts)}`);
  const haltT = flatten[0].t;
  assert.ok(r.summary.halted);
  assert.ok(r.fills.filter((f) => f.t >= haltT).every((f) => f.type === 'exit'), 'no entry after the halt');
  const after = r.equity.filter((e) => e.t >= haltT);
  assert.strictEqual(after.at(-1).open, 0);
  assert.ok(after.slice(1).every((e) => e.open === 0), 'still flat, right to the end');
  assert.ok(r.summary.maxDrawdown >= 0.2);
  assert.ok(r.summary.eventCounts.drawdown_halt === 1);
});

/** The real v6Risk with sizing swapped for a fixed 12%, so the ladder can actually be reached. */
function bleedRisk() {
  return { ...REAL_RISK, sizeEntry: ({ price, equity, signal }) => ({ qty: (equity * 0.12) / price, notional: equity * 0.12, riskAmount: equity * 0.12 * signal.stopDistancePct, rejected: false, reason: 'test' }) };
}

test('the real engine: a stop too wide for v6Risk is refused and the reason is counted', () => {
  const r = run(scripted({ 45: 'long' }, { stopPct: 0.9 }), walk(60), { modules: {}, from: dayT(30) });
  assert.strictEqual(r.fills.length, 0);
  assert.strictEqual(r.summary.eventCounts.sizing, 1);
});

test('the real engine: with no BTC series, entries fail closed', () => {
  const bars = new Map([['SOLUSDT', walk(60)]]);
  const r = runSim({ strategies: [scripted({ 45: 'long' }, { symbol: 'SOLUSDT' })], bars, costs: { tierFn: tier1 }, from: dayT(30) });
  assert.strictEqual(r.fills.length, 0);
});

test('the sim passes an explicit multiplier, and it scales real entries', () => {
  const size = (config) => runSim({ strategies: [momentum()], bars: coins(120), from: dayT(60), costs: { tierFn: tier1 }, config }).fills[0].qty;
  near(size({ sizeMultipliers: { mom: 0.5 } }), size({}) / 2, 1e-9);
});

console.log('simulated re-enable');

/** Crash on a schedule: everything held falls, sits flat, then trends again. */
function crashBars(symbols, crashes) {
  const closes = [100];
  for (let i = 1; i < 400; i++) closes.push(closes[i - 1] * (crashes.some(([a, b]) => i >= a && i < b) ? 0.93 : 1.002));
  return new Map(symbols.map((s) => [s, closes.map((c, i) => ({ t: dayT(i), o: c, h: c * 1.001, l: c * 0.999, c, v: 1, qv: 1e9 }))]));
}
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT', 'LTCUSDT', 'DOTUSDT', 'BNBUSDT'];
const holdAll = () => defineStrategy({
  id: 'h', name: 'h', timeframe: '1d', universe: { kind: 'fixed', symbols: SYMS }, warmupBars: 40, exitOverrides: SIGNAL_ONLY_EXITS,
  signals: (ctx) => ctx.universe.map((symbol) => ({ strategyId: 'h', symbol, side: 'long', score: 0.5, stopDistancePct: 0.25, exitProfile: 'trend', reason: 'hold', meta: {} })),
});
const crashRun = (extra) => runSim({ strategies: [holdAll()], bars: crashBars(SYMS, [[100, 104], [220, 224]]), costs: { tierFn: tier1 }, from: dayT(45), modules: { risk: bleedRisk() }, ...extra });

test('without it a halted sim stays flat for good; with it trading resumes after the cooling-off', () => {
  const off = crashRun({ simReEnable: false });
  const haltT = off.fills.find((f) => f.reasonCode === 'risk_flatten').t;
  assert.ok(off.fills.filter((f) => f.t > haltT).every((f) => f.type === 'exit'));
  assert.strictEqual(off.summary.simReEnables, 0);

  const on = crashRun({ simReEnable: { afterDays: 30 } });
  const first = on.summary.reEnables[0];
  assert.ok(on.summary.simReEnables >= 1);
  assert.strictEqual(first.rung, 4);
  assert.ok(first.t - on.fills.find((f) => f.reasonCode === 'risk_flatten').t >= 29 * DAY);
  const resumed = on.fills.find((f) => f.type === 'enter' && f.t > first.t);
  assert.ok(resumed, 'entries must resume');
  assert.ok(resumed.t > first.t && resumed.t <= first.t + 2 * DAY);
  assert.strictEqual(on.summary.eventCounts.sim_re_enable, on.summary.simReEnables);
});

test('it is the default for research, and the cooling-off length is honoured', () => {
  const byDefault = crashRun({});
  assert.deepStrictEqual(byDefault.summary.reEnables, crashRun({ simReEnable: { afterDays: 30 } }).summary.reEnables);
  assert.ok(crashRun({ simReEnable: { afterDays: 60 } }).summary.reEnables[0].t - byDefault.summary.reEnables[0].t >= 29 * DAY);
});

test('max drawdown keeps accumulating across a re-enable, and D3 uses it', () => {
  const r = crashRun({});
  assert.ok(r.summary.simReEnables >= 2, 'two crashes, two re-enables');
  assert.ok(r.riskState.drawdown < r.summary.maxDrawdown, 'the risk engine rebased; the report must not');
  let peak = -Infinity, worst = 0;
  for (const e of r.equity) { peak = Math.max(peak, e.equity); worst = Math.max(worst, 1 - e.equity / peak); }
  near(r.summary.maxDrawdown, worst);
  assert.ok(worst > 0.2 + 0.05, `two halts should stack past one rung, got ${worst}`);
  near(r.summary.reEnables.at(-1).drawdownFromPeak, 1 - r.summary.reEnables.at(-1).equity / Math.max(...r.equity.map((e) => e.equity).slice(0, 1 + r.equity.findIndex((e) => e.t + DAY >= r.summary.reEnables.at(-1).t))));
  const g = goodResult();
  g.oos.summary = { ...g.oos.summary, maxDrawdown: r.summary.maxDrawdown, simReEnables: r.summary.simReEnables };
  const d3 = checkDevCriteria(g, { trialCount: 10, trialSRVariance: 1e-5 }).criteria.D3;
  assert.strictEqual(d3.value, `${(r.summary.maxDrawdown * 100).toFixed(1)}%`);
  assert.ok(/re-enables/.test(d3.detail));
});

test('a manual halt is never cleared by the stand-in human', () => {
  const halting = { ...REAL_RISK, initialRiskState: (e, t) => REAL_RISK.manualHalt(REAL_RISK.initialRiskState(e, t), { t, by: 'test' }).riskState };
  const r = run(scripted({ 60: 'long' }), walk(200), { from: dayT(45), modules: { risk: halting } });
  assert.strictEqual(r.summary.simReEnables, 0);
  assert.strictEqual(r.fills.length, 0);
});

test('re-enabling leaks nothing: the audit stays clean across one', () => {
  const audit = auditLookahead({ strategy: holdAll(), bars: crashBars(SYMS, [[100, 104]]), costs: { tierFn: tier1 }, from: dayT(45), modules: { risk: bleedRisk() }, cuts: 6 });
  assert.ok(audit.ok, JSON.stringify(audit.cuts.filter((c) => !c.ok)));
});

test('a run ending on a blocking rung says so, with or without a formal halt', () => {
  const stuck = crashRun({ simReEnable: false });
  assert.strictEqual(stuck.summary.stuckAtEnd.rung, 4);
  assert.strictEqual(stuck.summary.stuckAtEnd.name, 'flatten_and_halt');
  assert.ok(stuck.summary.stuckAtEnd.days > 100);
  // A softer crash reaches the no-entries rung only, then the book goes flat: the freeze
  // r-trend and r-breakout saw. Not halted, and still stuck.
  const selling = defineStrategy({ ...holdAll(), signals: (ctx) => holdAll().signals(ctx).map((s) => ({ ...s, side: ctx.bars.get('BTCUSDT').length >= 106 ? 'flat' : 'long' })) });
  const soft = runSim({ strategies: [selling], bars: crashBars(SYMS, [[100, 103]]), costs: { tierFn: tier1 }, from: dayT(45), modules: { risk: bleedRisk() }, simReEnable: false });
  assert.strictEqual(soft.summary.halted, false);
  assert.strictEqual(soft.summary.stuckAtEnd.rung, 3);
  assert.strictEqual(soft.summary.stuckAtEnd.name, 'no_new_entries');
  const freed = runSim({ strategies: [holdAll()], bars: crashBars(SYMS, [[100, 103]]), costs: { tierFn: tier1 }, from: dayT(45), modules: { risk: bleedRisk() } });
  assert.strictEqual(freed.summary.stuckAtEnd, null);
  assert.strictEqual(crashRun({}).summary.stuckAtEnd, null);
  const g = goodResult();
  g.oos.summary = { ...g.oos.summary, stuckAtEnd: { rung: 3, name: 'no_new_entries', days: 90 } };
  assert.ok(/STUCK at the end: rung no_new_entries for 90 days/.test(checkDevCriteria(g, {}).report));
});

console.log('regime hook');

test('the regime window is 200 days on 4h too, not 200 bars', () => {
  const H4 = 4 * 3600000;
  // Long fall, then a 60-day rise: above the 33-day mean, below the 200-day one.
  const closes = Array.from({ length: 2000 }, (_, i) => (i < 1640 ? 1000 * 0.999 ** i : 1000 * 0.999 ** 1640 * 1.001 ** (i - 1640)));
  const bars = closes.map((c, i) => ({ t: T0 + i * H4, o: c, h: c, l: c, c, v: 1, qv: 1e9 }));
  const seen = [];
  const s = defineStrategy({ id: 'x', name: 'x', timeframe: '4h', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: (ctx) => { seen.push(ctx.regime); return []; } });
  runSim({ strategies: [s], bars: new Map([['BTCUSDT', bars]]), from: T0 + 1300 * H4, costs: { tierFn: tier1 } });
  const last = seen.at(-1);
  const mean = (n) => closes.slice(1999 - n + 1).reduce((a, x) => a + x, 0) / n;
  assert.ok(last.btcClose > mean(200) && last.btcClose < mean(1200), 'the case must separate the two windows');
  near(last.btcSma, mean(1200), 1e-6);
  assert.strictEqual(last.label, 'risk_off');
  assert.strictEqual(seen[0].label, 'risk_off');
});

test('regimeFn reaches ctx.regime and exits, and sees the universe; the default is unchanged', () => {
  const seen = [];
  const s = defineStrategy({
    id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'top', n: 2 }, exitOverrides: { ...SIGNAL_ONLY_EXITS, regimeExit: { enabled: true, action: 'exit' } },
    signals: (ctx) => { seen.push(ctx.regime); return ctx.bars.get('BTCUSDT').length === 31 ? [{ strategyId: 'x', symbol: 'BTCUSDT', side: 'long', score: 1, stopDistancePct: 0.5, exitProfile: 'trend', reason: 'x', meta: {} }] : []; },
  });
  const universes = [];
  const regimeFn = ({ barT, universe, bars, defaultRegime }) => {
    universes.push(universe);
    assert.strictEqual(bars.get('BTCUSDT').at(-1).t, barT);
    assert.strictEqual(defaultRegime.label, 'unknown');
    return barT >= dayT(40) ? { label: 'risk_off', riskOn: false } : { label: 'risk_on', riskOn: true };
  };
  const r = run(s, flat(60), { from: dayT(10), universeFn: () => ['BTCUSDT'], config: { regimeFn } });
  assert.strictEqual(seen[35].label, 'risk_off');
  assert.deepStrictEqual(universes[0], ['BTCUSDT']);
  assert.strictEqual(r.trades[0].reasonCode, 'regime_exit');
  assert.strictEqual(r.trades[0].exitTime, dayT(41));
  assert.strictEqual(r.summary.regimeExits, 1);
  near(r.summary.regimeExitPnl, r.trades[0].pnl);
  assert.throws(() => run(s, flat(60), { from: dayT(10), universeFn: () => ['BTCUSDT'], config: { regimeFn: () => null } }), /must return a regime/);
});

test('the default regime is still BTC above its 200d average, and its exits are counted', () => {
  const closes = Array.from({ length: 320 }, (_, i) => (i < 260 ? 100 * 1.002 ** i : 100 * 1.002 ** 260 * 0.99 ** (i - 259)));
  const bars = rows(closes.map((c) => [c, c * 1.001, c * 0.999, c]));
  const s = defineStrategy({
    id: 'x', name: 'x', timeframe: '1d', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, exitOverrides: { ...SIGNAL_ONLY_EXITS, regimeExit: { enabled: true, action: 'exit' } },
    signals: (ctx) => (ctx.bars.get('BTCUSDT').length === 230 ? [{ strategyId: 'x', symbol: 'BTCUSDT', side: 'long', score: 1, stopDistancePct: 0.9, exitProfile: 'trend', reason: 'x', meta: {} }] : []),
  });
  const r = run(s, bars, { from: dayT(201) });
  assert.strictEqual(r.summary.regimeExits, 1);
  assert.strictEqual(r.trades[0].reasonCode, 'regime_exit');
});

console.log('walk-forward');

test('gridCombos: a full cross product in a fixed order', () => {
  assert.deepStrictEqual(gridCombos({ a: [1, 2], b: [3] }), [{ a: 1, b: 3 }, { a: 2, b: 3 }]);
  assert.deepStrictEqual(gridCombos({}), [{}]);
});

const wfArgs = (bars) => ({
  strategyFactory: momentum, grid: { n: [10, 20, 40] }, bars, trainDays: 200, testDays: 100, from: T0, costs: { tierFn: tier1 },
});

test('folds: train ends before test starts, and tests tile the span without overlap', () => {
  const wf = walkForward({ ...wfArgs(coins(600)), extras: false });
  assert.ok(wf.picks.length >= 3);
  wf.picks.forEach((p, i) => {
    assert.ok(p.trainTo < p.testFrom);
    assert.strictEqual(p.testFrom - p.trainFrom, 200 * DAY);
    if (i) assert.strictEqual(p.testFrom, wf.picks[i - 1].testTo + 1);
  });
  assert.strictEqual(wf.oos.equity[0].t, wf.picks[0].testFrom);
});

test('a change in the last test window cannot change any earlier pick', () => {
  const base = coins(600);
  const a = walkForward({ ...wfArgs(base), extras: false });
  const last = a.picks.at(-1);
  const poisoned = new Map([...base].map(([s, b]) => [s, b.map((x) => (x.t >= last.testFrom ? { ...x, o: x.o * 9, h: x.h * 9, l: x.l * 9, c: x.c * 9 } : { ...x }))]));
  const b = walkForward({ ...wfArgs(poisoned), extras: false });
  assert.deepStrictEqual(a.picks.map((p) => p.params), b.picks.map((p) => p.params));
  assert.deepStrictEqual(a.picks.map((p) => p.trainScore), b.picks.map((p) => p.trainScore));
  const before = (r) => r.oos.fills.filter((f) => f.t < last.testFrom).map(fillKey);
  assert.deepStrictEqual(before(a), before(b));
});

test('params really switch at fold boundaries, using only the pick for that fold', () => {
  const seen = new Map();
  const factory = (p) => defineStrategy({
    id: 'sw', name: 'sw', timeframe: '1d', params: p, universe: { kind: 'fixed', symbols: ['BTCUSDT'] },
    signals(ctx) { seen.set(ctx.barT, ctx.params.n); return []; },
  });
  const bars = walk(300);
  const wf = walkForward({ strategyFactory: factory, grid: { n: [1, 2] }, bars: new Map([['BTCUSDT', bars]]), trainDays: 100, testDays: 50, from: T0, extras: false, objective: 'closedTrades' });
  for (const p of wf.picks) assert.strictEqual(seen.get(p.testFrom), p.params.n);
});

test('a position carries across a fold boundary: no made-up round trip', () => {
  const bars = new Map([['BTCUSDT', walk(400, { drift: 0.02, vol: 0.005 })]]);
  const wf = walkForward({ strategyFactory: (p) => btcAboveSma({ ...p, stopPct: 0.5 }), grid: { n: [20] }, bars, trainDays: 100, testDays: 50, from: T0, costs: { tierFn: tier1 }, extras: false, modules: half });
  assert.ok(wf.picks.length >= 4);
  assert.strictEqual(wf.oos.trades.length, 1, `expected one held trade, got ${wf.oos.trades.length}`);
});

/** A strategy whose universe and warmup come from the grid, recording what each fold got. */
function foldRecorder(seen) {
  return (p) => defineStrategy({
    id: 'g', name: 'g', timeframe: '1d', params: p, universe: { kind: 'top', n: p.topN }, warmupBars: p.warm ?? 0,
    signals(ctx) { seen.set(ctx.barT, { topN: ctx.params.topN, universe: ctx.universe }); return []; },
  });
}
const nCoins = (t, { topN }) => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'].slice(0, topN);

test('universe.n in a grid takes effect in every fold of the out-of-sample run', () => {
  const seen = new Map();
  const bars = coins(500);
  const wf = walkForward({ strategyFactory: foldRecorder(seen), grid: { topN: [1, 3] }, bars, trainDays: 100, testDays: 100, from: T0, universeFn: nCoins, extras: false, objective: 'closedTrades' });
  for (const p of wf.picks) {
    const got = seen.get(p.testFrom);
    assert.strictEqual(got.universe.length, p.params.topN);
  }
  // Switch the schedule by hand across two values through a factory that alternates by fold.
  const log = [];
  const alternating = (p) => defineStrategy({
    id: 'alt', name: 'alt', timeframe: '1d', params: p, universe: { kind: 'top', n: p.topN },
    signals(ctx) { log.push([ctx.barT, ctx.params.topN, ctx.universe.length]); return ctx.params.topN === 1 && ctx.bars.get('BTCUSDT').length < 250 ? [{ strategyId: 'alt', symbol: 'BTCUSDT', side: 'long', score: 1, stopDistancePct: 0.1, exitProfile: 'trend', reason: 'x', meta: {} }] : []; },
  });
  const wf2 = walkForward({ strategyFactory: alternating, grid: { topN: [3, 1] }, bars, trainDays: 100, testDays: 100, from: T0, universeFn: nCoins, costs: { tierFn: tier1 }, extras: false, modules: half, objective: 'closedTrades' });
  const distinct = new Set(wf2.picks.map((p) => p.params.topN));
  assert.strictEqual(distinct.size, 2, 'the test needs both values picked');
  const oosStart = wf2.picks[0].testFrom;
  for (const [barT, topN, n] of log.filter(([barT]) => barT >= oosStart).slice(-300)) assert.strictEqual(n, barT === bars.get('BTCUSDT').at(-1).t ? 0 : topN);
});

test('warmup is the fold own value: a long lookback waits for its own history', () => {
  const young = walk(220, { seed: 3, t0: dayT(280) });
  const bars = new Map([['BTCUSDT', walk(500)], ['SOLUSDT', young]]);
  const log = new Map();
  const factory = (p) => defineStrategy({
    id: 'w', name: 'w', timeframe: '1d', params: p, universe: { kind: 'fixed', symbols: ['BTCUSDT', 'SOLUSDT'] }, warmupBars: p.warm,
    signals(ctx) {
      log.set(ctx.barT, { warm: ctx.params.warm, sol: ctx.universe.includes('SOLUSDT') });
      return ctx.params.warm === 5 && ctx.bars.get('BTCUSDT').length < 200 ? [{ strategyId: 'w', symbol: 'BTCUSDT', side: 'long', score: 1, stopDistancePct: 0.1, exitProfile: 'trend', reason: 'x', meta: {} }] : [];
    },
  });
  const wf = walkForward({ strategyFactory: factory, grid: { warm: [100, 5] }, bars, trainDays: 100, testDays: 100, from: T0, costs: { tierFn: tier1 }, extras: false, modules: half, objective: 'closedTrades' });
  assert.ok(new Set(wf.picks.map((p) => p.params.warm)).size === 2, 'the test needs both values picked');
  const listed = dayT(280);
  for (const [barT, { warm, sol }] of log) {
    const age = (barT - listed) / DAY + 1;
    if (barT >= wf.picks[0].testFrom && age > 0) assert.strictEqual(sol, age >= warm, `age ${age}, warm ${warm}`);
  }
});

test('a grid changing something the switcher cannot switch throws, it is never ignored', () => {
  const base = { name: 'x', universe: { kind: 'fixed', symbols: ['BTCUSDT'] }, signals: () => [] };
  const bars300 = new Map([['BTCUSDT', walk(300)]]);
  const go = (factory, grid) => walkForward({ strategyFactory: factory, grid, bars: bars300, trainDays: 100, testDays: 50, from: T0, extras: false });
  assert.throws(() => go((p) => defineStrategy({ ...base, id: 'x', timeframe: p.tf }), { tf: ['1d', '4h'] }), /strategy\.timeframe/);
  assert.throws(() => go((p) => defineStrategy({ ...base, id: 'x', timeframe: '1d', perp: p.perp }), { perp: [true, false] }), /strategy\.perp/);
  assert.throws(() => go((p) => defineStrategy({ ...base, id: `x${p.n}`, timeframe: '1d' }), { n: [1, 2] }), /strategy\.id/);
  assert.throws(() => go((p) => defineStrategy({ ...base, id: 'x', timeframe: '1d', slowAllocator: p.s }), { s: [true, false] }), /strategy\.slowAllocator/);
  go((p) => defineStrategy({ ...base, id: 'x', timeframe: '1d', params: p, warmupBars: p.n }), { n: [1, 2] });
});

test('nothing qualifies in training: that fold sits in cash', () => {
  const wf = walkForward({ ...wfArgs(coins(400)), minTrainTrades: 1e9, extras: false });
  assert.ok(wf.picks.every((p) => p.params === null));
  assert.strictEqual(wf.oos.fills.length, 0);
});

test('extras: 2x run, benchmark and one trial per grid point', () => {
  const wf = walkForward(wfArgs(coins(600)));
  assert.strictEqual(wf.trials.length, 3);
  assert.ok(wf.stress2x.costs.stress === 2);
  assert.ok(wf.stress2x.summary.totalReturn < wf.summary.totalReturn);
  assert.deepStrictEqual(wf.benchmark.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']);
  assert.ok(wf.benchmark.summary.exposure > 0.9, 'the benchmark holds full exposure');
  const line = trialRecord({ agent: 'a', family: 'f', strategyId: 'mom', timeframe: '1d', trial: wf.trials[0], ts: 1 });
  assert.strictEqual(line.params.n, 10);
  assert.ok(Number.isFinite(line.sharpe) && line.periodsPerYear === 365);
});

console.log('checkDevCriteria');

/** A synthetic result that passes everything, to flip one criterion at a time. */
function goodResult() {
  const r = seededRandom(4);
  const equity = [];
  let e = 10000;
  const years = [2019, 2020, 2021, 2022, 2023];
  for (let i = 0; i < 1825; i++) {
    e *= 1 + 0.0012 + (r() - 0.5) * 0.012;
    equity.push({ t: Date.UTC(years[0], 0, 1) + i * DAY, equity: e });
  }
  const trades = [];
  const pool = ['A', 'B', 'C', 'D', 'E'];
  const each = (e - 10000) / 150;
  for (let i = 0; i < 150; i++) trades.push({ symbol: pool[i % 5], pnl: each, positionPnl: each, rMultiple: 1 });
  const summary = summarizeFor(equity, trades);
  const bench = summarizeFor(equity.map((p, i) => ({ t: p.t, equity: 10000 * (1 + 0.1 * Math.sin(i / 50)) })), []);
  return {
    oos: { equity, trades, summary },
    stress2x: { summary: { totalReturn: 0.5 } },
    benchmark: { summary: bench },
    plateau: { params: { n: 20 }, sharpe: 2, neighbours: [{ params: { n: 10 }, sharpe: 1.5 }, { params: { n: 40 }, sharpe: 1.2 }] },
    strategy: { slowAllocator: false },
  };
}
function summarizeFor(equity, trades) { return summarize(equity, trades, { periodsPerYear: 365 }); }
const OK_CTX = { trialCount: 10, trialSRVariance: 1e-5 };

test('all eight pass on a clean result, and the report never promises winning', () => {
  const c = checkDevCriteria(goodResult(), OK_CTX);
  assert.ok(c.pass, c.report);
  assert.deepStrictEqual(Object.keys(c.criteria), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']);
  assert.ok(/never a promise/.test(c.report));
});

test('D2 fails, not passes, when trial data is missing', () => {
  const a = checkDevCriteria(goodResult(), {});
  assert.strictEqual(a.criteria.D2.pass, false);
  assert.strictEqual(a.pass, false);
  assert.strictEqual(checkDevCriteria(goodResult(), { trialCount: 50 }).criteria.D2.pass, false);
});

test('D2 tightens as global trials grow', () => {
  const r = goodResult();
  const per = (r.oos.summary.sharpe / Math.sqrt(365)) ** 2;
  const few = Number(checkDevCriteria(r, { trialCount: 2, trialSRVariance: per / 4 }).criteria.D2.value);
  const many = Number(checkDevCriteria(r, { trialCount: 5000, trialSRVariance: per / 4 }).criteria.D2.value);
  assert.ok(many < few);
});

test('raw trial lines can stand in for the two numbers', () => {
  const trials = Array.from({ length: 20 }, (_, i) => ({ sharpe: i / 10, periodsPerYear: 365 }));
  assert.ok(/20 trials/.test(checkDevCriteria(goodResult(), { trials }).criteria.D2.detail));
});

test('each criterion fails on its own when its condition breaks', () => {
  const flip = (fn) => { const r = goodResult(); fn(r); return checkDevCriteria(r, OK_CTX).criteria; };
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, sharpe: 0.7 }; }).D1.pass, false);
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, maxDrawdown: 0.31 }; }).D3.pass, false);
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, closedTrades: 99 }; }).D4.pass, false);
  assert.strictEqual(flip((r) => { r.stress2x.summary.totalReturn = -0.01; }).D5.pass, false);
  assert.strictEqual(flip((r) => { r.stress2x = null; }).D5.pass, false);
  assert.strictEqual(flip((r) => { r.plateau.neighbours[1].sharpe = 0.9; }).D6.pass, false);
  assert.strictEqual(flip((r) => { r.plateau.neighbours = []; }).D6.pass, false);
  assert.strictEqual(flip((r) => { r.plateau = null; }).D6.pass, false);
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, topCoinShare: 0.36 }; }).D7.pass, false);
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, topYearShare: 0.61 }; }).D7.pass, false);
  assert.strictEqual(flip((r) => { r.oos.summary = { ...r.oos.summary, profit: -1 }; }).D7.pass, false);
  assert.strictEqual(flip((r) => { r.benchmark.summary = { sharpe: 99, calmar: 99 }; }).D8.pass, false);
  assert.strictEqual(flip((r) => { r.benchmark = null; }).D8.pass, false);
});

test('D4: a slow allocator is judged on position-changes, at 30', () => {
  const r = goodResult();
  r.oos.summary = { ...r.oos.summary, closedTrades: 5, positionChanges: 30 };
  assert.strictEqual(checkDevCriteria(r, { ...OK_CTX, slowAllocator: true }).criteria.D4.pass, true);
  r.oos.summary.positionChanges = 29;
  assert.strictEqual(checkDevCriteria(r, { ...OK_CTX, slowAllocator: true }).criteria.D4.pass, false);
  assert.strictEqual(checkDevCriteria(r, OK_CTX).criteria.D4.pass, false);
});

test('D1: a Sharpe over 0.8 with a CI touching zero still fails', () => {
  const r = goodResult();
  const noisy = seededRandom(8);
  let e = 10000;
  r.oos.equity = Array.from({ length: 120 }, (_, i) => { e *= 1 + 0.002 + (noisy() - 0.5) * 0.08; return { t: i * DAY, equity: e }; });
  r.oos.summary = { ...r.oos.summary, sharpe: 0.9 };
  assert.strictEqual(checkDevCriteria(r, OK_CTX).criteria.D1.pass, false);
});

console.log('reference strategies and speed');

test('buy and hold of one coin matches the price change less two sides of costs', () => {
  const bars = walk(100);
  const r = run(buyAndHold(), bars, { modules: { risk: fullWeightRisk({ weight: 0.99 }) } });
  const f = r.fills[0];
  const expected = 10000 - f.qty * f.price - f.fee + f.qty * bars.at(-1).c * (1 - SLIP) * (1 - FEE);
  near(r.equity.at(-1).equity, expected, 1e-6);
  assert.strictEqual(r.trades.length, 1);
});

test('determinism: the same inputs give the identical result', () => {
  const a = runSim({ strategies: [momentum()], bars: coins(), from: dayT(60), costs: { tierFn: tier1 } });
  const b = runSim({ strategies: [momentum()], bars: coins(), from: dayT(60), costs: { tierFn: tier1 } });
  assert.deepStrictEqual(a.fills, b.fills);
  assert.deepStrictEqual(a.equity, b.equity);
});

test('speed: 20 coins, 5 years, daily, real risk and exits, under 2 seconds', () => {
  const symbols = Array.from({ length: 20 }, (_, i) => (i ? `C${i}USDT` : 'BTCUSDT'));
  const bars = new Map(symbols.map((s, i) => [s, walk(1825 + 200, { seed: i + 1 })]));
  const s = defineStrategy({
    id: 'sp', name: 'sp', timeframe: '1d', universe: { kind: 'fixed', symbols }, warmupBars: 60,
    signals: (ctx) => ctx.universe.map((symbol) => ({ strategyId: 'sp', symbol, side: ctx.ind(symbol, 'roc', 30) > 0 ? 'long' : 'flat', score: 0.5, stopDistancePct: 0.15, exitProfile: 'trend', reason: 'x', meta: {} })),
  });
  const t0 = performance.now();
  const r = runSim({ strategies: [s], bars, from: dayT(200), costs: {} });
  const ms = performance.now() - t0;
  console.log(`        ${ms.toFixed(0)}ms, ${r.trades.length} trades`);
  assert.ok(r.trades.length > 50);
  assert.ok(ms < 2000, `${ms}ms`);
});

console.log('signal gate in the simulator');

test('runSim gets the pass-through: it trades, and logs no signal tests', () => {
  const r = runSim({ strategies: [buyAndHold({ symbols: ['BTCUSDT'] })], bars: new Map([['BTCUSDT', walk(60)]]), modules: { risk: fullWeightRisk({ weight: 0.5 }) } });
  assert.ok(r.trades.length >= 1);
  assert.ok(!r.events.some((e) => e.type === 'signal_test' || e.code === 'no_gate'));
});

test('the pass-through is tied to the prepared history: the same step on a plain market refuses', () => {
  const bars = walk(60);
  const t = bars.at(-1).t + DAY;
  const args = (ind) => ({
    t, account: { cash: 10000 }, positions: new Map(), strategies: [buyAndHold({ symbols: ['BTCUSDT'] })], config: { sizeMultipliers: { buy_and_hold: 1 } },
    riskState: {}, modules: { risk: fullWeightRisk({ weight: 0.5 }) },
    market: { bars: new Map([['BTCUSDT', bars]]), prices: new Map([['BTCUSDT', bars.at(-1).c]]), barMs: DAY, barT: bars.at(-1).t, health: { ok: true }, ind },
  });
  const visible = new Map([['BTCUSDT', bars]]);
  const prepared = createIndicatorAccess(visible, () => null);
  assert.strictEqual(step(args(prepared)).intents.length, 1);
  assert.strictEqual(step(args(createIndicatorAccess(visible))).intents.length, 0);
  assert.strictEqual(step(args(undefined)).intents.length, 0);
  assert.strictEqual(step({ ...args(prepared), gate: { preSize: () => ({ ok: false }), postSize: () => ({ ok: false }) } }).intents.length, 0);
});

console.log(`\nv6Sim: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
