/**
 * Strategy lab tests: daily-bar timing, the trend rule, the composite rule,
 * stops, sizing limits, paper accounting, and the market exposure account.
 */
import assert from 'node:assert';
import {
  LAB_STRATEGIES, LAB_START_CAPITAL, DAY_MS, DAILY_BAR_OFFSET_MS,
  latestClosedDailyBar, newLabAccount, runLabStep, compositeVotes, accountEquity,
  EXPOSURE_RULES, volumeSnapshot, recordVolumeSnapshot, screenDue, volumeCandidates, applyScreen, exposureTargets,
} from '../shared/trading/strategyLab.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const trend = LAB_STRATEGIES.find((s) => s.id === 'trend_btc_eth');
const composite = LAB_STRATEGIES.find((s) => s.id === 'composite_daily');
const T0 = Date.UTC(2026, 0, 1) + DAILY_BAR_OFFSET_MS;

/** Daily candles following a list of closes, small deterministic wiggle. */
function series(closes, start = T0) {
  return closes.map((c, i) => {
    const w = 1 + 0.004 * Math.sin(i * 1.7);
    const open = i ? closes[i - 1] : c;
    return { openTime: start + i * DAY_MS, closeTime: start + (i + 1) * DAY_MS - 1, open,
      high: Math.max(open, c) * 1.01 * w, low: Math.min(open, c) * 0.99 / w, close: c, volume: 1e4, quoteVolume: 5e9 };
  });
}
const ramp = (n, from, step) => Array.from({ length: n }, (_, i) => from * (1 + step) ** i);
/** Realistic uptrend: three +3% days then a -2.5% day (a smooth ramp pins RSI/MFI at 100, which the composite rejects as exhaustion). */
const choppy = (n, from) => { const c = [from]; for (let i = 1; i < n; i++) c.push(c[i - 1] * (i % 4 === 0 ? 0.975 : 1.03)); return c; };
const nowAfter = (candles) => candles.at(-1).closeTime + 3600e3;
function marketOf(map) {
  const candles = new Map(Object.entries(map));
  const prices = new Map([...candles].map(([s, c]) => [s, c.at(-1).close]));
  return { candles, prices };
}

test('latestClosedDailyBar follows the 16:00 UTC OKX daily close', () => {
  assert.strictEqual(latestClosedDailyBar(Date.UTC(2026, 10, 4, 17)), Date.UTC(2026, 10, 3, 16));
  assert.strictEqual(latestClosedDailyBar(Date.UTC(2026, 10, 4, 15)), Date.UTC(2026, 10, 2, 16));
});

test('trend: both coins above their 100-day average -> half the account in each', () => {
  const btc = series(ramp(150, 50000, 0.004)), eth = series(ramp(150, 3000, 0.004));
  const acct = newLabAccount(trend, { now: T0, btcPrice: 50000 });
  const { trades, decided } = runLabStep({ account: acct, strategy: trend, market: marketOf({ BTCUSDT: btc, ETHUSDT: eth }), now: nowAfter(btc) });
  assert.ok(decided);
  assert.strictEqual(trades.length, 2);
  for (const t of trades) assert.ok(Math.abs(t.quote_amount - LAB_START_CAPITAL / 2) < 60, `bought ${t.quote_amount}`);
  assert.ok(acct.cash >= 0 && acct.cash < 100);
});

test('trend: decides once per closed bar — a second tick on the same bar trades nothing', () => {
  const btc = series(ramp(150, 50000, 0.004)), eth = series(ramp(150, 3000, 0.004));
  const acct = newLabAccount(trend, { now: T0 });
  const m = marketOf({ BTCUSDT: btc, ETHUSDT: eth });
  runLabStep({ account: acct, strategy: trend, market: m, now: nowAfter(btc) });
  const again = runLabStep({ account: acct, strategy: trend, market: m, now: nowAfter(btc) + 3600e3 });
  assert.strictEqual(again.trades.length, 0);
  assert.strictEqual(again.decided, false);
  assert.strictEqual(acct.equity_history.length, 1);
});

test('trend: close drops below the average -> sells to cash, P&L booked', () => {
  const up = ramp(150, 50000, 0.004);
  const acct = newLabAccount(trend, { now: T0 });
  const b1 = series(up), e1 = series(ramp(150, 3000, 0.004));
  runLabStep({ account: acct, strategy: trend, market: marketOf({ BTCUSDT: b1, ETHUSDT: e1 }), now: nowAfter(b1) });
  const down = [...up, ...ramp(40, up.at(-1), -0.02).slice(1)];
  const b2 = series(down), e2 = series([...ramp(150, 3000, 0.004), ...ramp(40, 3000 * 1.004 ** 149, -0.02).slice(1)]);
  const { trades } = runLabStep({ account: acct, strategy: trend, market: marketOf({ BTCUSDT: b2, ETHUSDT: e2 }), now: nowAfter(b2) });
  assert.strictEqual(trades.filter((t) => t.side === 'sell').length, 2);
  assert.strictEqual(Object.keys(acct.positions).length, 0);
  assert.ok(Math.abs(acct.cash - (LAB_START_CAPITAL + acct.realized_pnl)) < 1e-6, 'cash = start + realised P&L');
});

test('trend: a coin without 100 days of history is not traded', () => {
  const btc = series(ramp(150, 50000, 0.004)), eth = series(ramp(60, 3000, 0.004), T0 + 90 * DAY_MS);
  const acct = newLabAccount(trend, { now: T0 });
  const { trades } = runLabStep({ account: acct, strategy: trend, market: marketOf({ BTCUSDT: btc, ETHUSDT: eth }), now: nowAfter(btc) });
  assert.deepStrictEqual(trades.map((t) => t.symbol), ['BTCUSDT']);
  assert.ok(trades[0].quote_amount > 9000, 'only eligible coin gets the whole weight');
});

test('composite: a choppy uptrend gets all six votes', () => {
  const v = compositeVotes(series(choppy(220, 100)));
  assert.strictEqual(v.total, 6);
  assert.strictEqual(v.bullCount, 6, `bullish: ${v.bullish.join(', ')}`);
});

test('composite: buys 6/6 coins with an ATR stop, risk-sized and capped at 10% of equity', () => {
  const map = { BTCUSDT: series(choppy(220, 50000)) };
  for (const s of ['ETHUSDT', 'SOLUSDT', 'XRPUSDT']) map[s] = series(choppy(220, 10));
  const acct = newLabAccount(composite, { now: T0 });
  const { trades } = runLabStep({ account: acct, strategy: composite, market: marketOf(map), now: nowAfter(map.BTCUSDT) });
  assert.strictEqual(trades.length, 4);
  for (const t of trades) {
    assert.ok(t.quote_amount <= LAB_START_CAPITAL * 0.1 + 1e-6, `size ${t.quote_amount}`);
    assert.ok(t.stop_percent >= 3 && t.stop_percent <= 12);
    assert.ok(t.stop_price < t.price);
  }
});

test('composite: never more than 5 positions', () => {
  const map = { BTCUSDT: series(choppy(220, 50000)) };
  for (const s of ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT']) map[s] = series(choppy(220, 10));
  const acct = newLabAccount(composite, { now: T0 });
  runLabStep({ account: acct, strategy: composite, market: marketOf(map), now: nowAfter(map.BTCUSDT) });
  assert.strictEqual(Object.keys(acct.positions).length, 5);
});

test('composite: stop is checked every tick at the live price, even between daily decisions', () => {
  const map = { BTCUSDT: series(choppy(220, 50000)) };
  const acct = newLabAccount(composite, { now: T0 });
  const m = marketOf(map);
  runLabStep({ account: acct, strategy: composite, market: m, now: nowAfter(map.BTCUSDT) });
  const pos = acct.positions.BTCUSDT;
  assert.ok(pos);
  const crash = { candles: m.candles, prices: new Map([['BTCUSDT', pos.stop_price * 0.98]]) };
  const { trades, decided } = runLabStep({ account: acct, strategy: composite, market: crash, now: nowAfter(map.BTCUSDT) + 2 * 3600e3 });
  assert.strictEqual(decided, false);
  assert.strictEqual(trades.length, 1);
  assert.match(trades[0].reason, /Stop hit/);
  assert.ok(trades[0].pnl < 0);
});

test('composite: sells when fewer than 3 of 6 stay bullish', () => {
  const up = choppy(220, 50000);
  const acct = newLabAccount(composite, { now: T0 });
  const b1 = series(up);
  runLabStep({ account: acct, strategy: composite, market: marketOf({ BTCUSDT: b1 }), now: nowAfter(b1) });
  acct.positions.BTCUSDT.stop_price = 1; // isolate the signal exit from the stop
  const b2 = series([...up, ...ramp(12, up.at(-1), -0.015).slice(1)]);
  const { trades } = runLabStep({ account: acct, strategy: composite, market: marketOf({ BTCUSDT: b2 }), now: nowAfter(b2) });
  assert.strictEqual(trades.length, 1);
  assert.match(trades[0].reason, /below 3/);
});

test('accounting: equity = cash + positions at market, fees reduce equity', () => {
  const btc = series(ramp(150, 50000, 0.004)), eth = series(ramp(150, 3000, 0.004));
  const acct = newLabAccount(trend, { now: T0 });
  const m = marketOf({ BTCUSDT: btc, ETHUSDT: eth });
  runLabStep({ account: acct, strategy: trend, market: m, now: nowAfter(btc) });
  assert.ok(Math.abs(accountEquity(acct, m.prices) - acct.last_equity) < 1e-6);
  assert.ok(acct.last_equity < LAB_START_CAPITAL && acct.last_equity > LAB_START_CAPITAL * 0.99);
  assert.ok(acct.total_fees > 0);
});

// ---------- market exposure account ----------

const exposure = LAB_STRATEGIES.find((s) => s.id === 'exposure_screened');
const R = EXPOSURE_RULES;
/** Daily closes with a given daily vol: deterministic +/- steps. */
const wobble = (n, from, dailyVol, phase = 0) => {
  const c = [from];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(dailyVol * (((i + phase) % 2) ? 1 : -1)));
  return c;
};
const goodCheck = (now) => ({ firstBinanceBar: now - 2000 * DAY_MS, okxCostPct: 0.02, okxCandles: 200, okxPrice: 1 });

test('exposure: the strategy uses the pre-registered rules and adds no coins to the fixed lab universe', () => {
  assert.strictEqual(exposure.kind, 'exposure');
  assert.deepStrictEqual(exposure.universe, []);
  assert.strictEqual(R.minVenues, 4); assert.strictEqual(R.minVolumeUsd, 100e6); assert.strictEqual(R.historyDays, 1095);
  assert.strictEqual(R.maxCostPct, 0.10); assert.strictEqual(R.maxMembers, 15); assert.strictEqual(R.volTarget, 0.20);
  assert.strictEqual(R.floorFraction, 0.70);
  assert.ok(Object.isFrozen(R));
});

test('exposure: a snapshot keeps coins on 4+ venues with agreeing prices and $10M+ volume', () => {
  const v = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  const vols = volumeSnapshot([
    { base: 'BTC', venues: v(8), quoteVolume: 5e9 },
    { base: 'THREE', venues: v(3), quoteVolume: 5e9 },
    { base: 'CONFLICT', venues: v(6), quoteVolume: 5e9, priceConflict: true },
    { base: 'SMALL', venues: v(6), quoteVolume: 9e6 },
  ]);
  assert.deepStrictEqual(Object.keys(vols), ['BTC']);
});

test('exposure: volume median counts a missing day as zero and keeps the last 30 snapshots', () => {
  const a = newLabAccount(exposure, { now: T0 });
  for (let d = 0; d < 40; d++) {
    // Of the last 30 days, X is present on 16 and Y on only 14.
    const vols = {};
    if (d >= 24) vols.X = 200e6;
    if (d >= 26) vols.Y = 900e6;
    recordVolumeSnapshot(a, T0 + d * DAY_MS, vols);
  }
  assert.strictEqual(a.volume_log.length, 30);
  assert.deepStrictEqual(volumeCandidates(a).map((c) => c.base), ['X']);
  // Recording the same bar again replaces it rather than adding a day.
  recordVolumeSnapshot(a, T0 + 39 * DAY_MS, { X: 1 });
  assert.strictEqual(a.volume_log.length, 30);
});

test('exposure: the screen applies C4 to C6, caps at 15 by volume, and asks for a rebalance', () => {
  const now = T0 + 100 * DAY_MS;
  const a = newLabAccount(exposure, { now: T0 });
  const cands = Array.from({ length: 20 }, (_, i) => ({ base: `C${i}`, medianVolume: 1e9 - i * 1e6 }));
  const checks = new Map(cands.map((c) => [c.base, goodCheck(now)]));
  checks.set('C0', { ...goodCheck(now), firstBinanceBar: now - 1000 * DAY_MS }); // under 3 years
  checks.set('C1', { ...goodCheck(now), firstBinanceBar: null });                // not on Binance
  checks.set('C2', { ...goodCheck(now), okxCostPct: 0.11 });                     // book too thin
  checks.set('C3', { ...goodCheck(now), okxCandles: 59 });                       // too little OKX history
  applyScreen(a, cands, checks, { bar: now, now });
  assert.strictEqual(a.members.length, 15);
  assert.strictEqual(a.members[0], 'C4USDT');
  assert.ok(!a.members.includes('C19USDT'));
  const fails = Object.fromEntries(a.screen_log[0].rows.map((r) => [r.base, r.failed.join(',')]));
  assert.deepStrictEqual([fails.C0, fails.C1, fails.C2, fails.C3, fails.C19], ['C4', 'C4', 'C5', 'C6', 'cap']);
  assert.strictEqual(a.rebalance_pending, true);
  assert.ok(!screenDue(a, now + 90 * DAY_MS));
  assert.ok(screenDue(a, now + 91 * DAY_MS));
});

test('exposure: weights are inverse to vol and scaled to the 20% target, never over 100%', () => {
  const calm = series(wobble(80, 100, 0.01)), wild = series(wobble(80, 100, 0.04));
  const t = exposureTargets(['AUSDT', 'BUSDT'], new Map([['AUSDT', calm], ['BUSDT', wild]]));
  const wa = t.weights.get('AUSDT'), wb = t.weights.get('BUSDT');
  assert.ok(Math.abs(wa / wb - 4) < 0.05, `ratio ${wa / wb}`);
  // Basket vol after scaling is the target.
  assert.ok(Math.abs(t.basketVol * t.scale - 0.20) < 1e-9);
  // A very calm basket is not levered up.
  const quiet = exposureTargets(['AUSDT'], new Map([['AUSDT', series(wobble(80, 100, 0.001))]]));
  assert.strictEqual(quiet.scale, 1);
  assert.ok(Math.abs(quiet.weights.get('AUSDT') - 1) < 1e-12);
  // Two coins moving exactly opposite: zero basket vol, finite weights, no leverage.
  const hedged = exposureTargets(['AUSDT', 'BUSDT'], new Map([['AUSDT', calm], ['BUSDT', series(wobble(80, 100, 0.01, 1))]]));
  assert.strictEqual(hedged.scale, 1);
  assert.ok([...hedged.weights.values()].every(Number.isFinite));
  assert.ok(Math.abs([...hedged.weights.values()].reduce((x, y) => x + y, 0) - 1) < 1e-9);
  // A member without 61 candles gets no weight.
  const short = exposureTargets(['AUSDT', 'BUSDT'], new Map([['AUSDT', calm], ['BUSDT', series(wobble(40, 100, 0.02))]]));
  assert.deepStrictEqual([...short.weights.keys()], ['AUSDT']);
});

function exposureMarket(map) {
  const btc = map.BTCUSDT || series(wobble(80, 50000, 0.02));
  return marketOf({ ...map, BTCUSDT: btc });
}

test('exposure: first decision buys the targets; within the band and before 7 days nothing trades', () => {
  const a = newLabAccount(exposure, { now: T0 });
  a.members = ['BTCUSDT', 'ETHUSDT'];
  const m = exposureMarket({ BTCUSDT: series(wobble(80, 50000, 0.02)), ETHUSDT: series(wobble(80, 3000, 0.03)) });
  const now = nowAfter(m.candles.get('BTCUSDT'));
  const first = runLabStep({ account: a, strategy: exposure, market: m, now });
  assert.ok(first.decided);
  assert.strictEqual(first.trades.length, 2);
  assert.ok(first.trades.every((t) => t.side === 'buy'));
  // Correlated coins, basket vol well above 20%: invested share = the vol scale (less fees).
  const gross = Object.values(a.positions).reduce((s, p) => s + p.quantity * m.prices.get(p.symbol), 0);
  assert.ok(a.last_targets.scale < 1);
  assert.ok(Math.abs(gross / a.last_equity - a.last_targets.scale) < 0.01, `gross ${gross / a.last_equity} vs scale ${a.last_targets.scale}`);
  // Next day: a decision runs, but no rebalance is due.
  const m2 = exposureMarket({ BTCUSDT: series(wobble(81, 50000, 0.02)), ETHUSDT: series(wobble(81, 3000, 0.03)) });
  const next = runLabStep({ account: a, strategy: exposure, market: m2, now: nowAfter(m2.candles.get('BTCUSDT')) });
  assert.ok(next.decided);
  assert.strictEqual(next.trades.length, 0);
  // Seven days on, small drifts sit inside the 25% band.
  const m3 = exposureMarket({ BTCUSDT: series(wobble(87, 50000, 0.02)), ETHUSDT: series(wobble(87, 3000, 0.03)) });
  const week = runLabStep({ account: a, strategy: exposure, market: m3, now: nowAfter(m3.candles.get('BTCUSDT')) });
  assert.strictEqual(week.trades.length, 0);
  assert.strictEqual(a.last_rebalance_bar, m3.candles.get('BTCUSDT').at(-1).openTime);
});

test('exposure: a coin that leaves the universe is sold, sells before buys', () => {
  const a = newLabAccount(exposure, { now: T0 });
  a.members = ['BTCUSDT', 'ETHUSDT'];
  const m = exposureMarket({ BTCUSDT: series(wobble(80, 50000, 0.02)), ETHUSDT: series(wobble(80, 3000, 0.03)), SOLUSDT: series(wobble(80, 100, 0.03)) });
  runLabStep({ account: a, strategy: exposure, market: m, now: nowAfter(m.candles.get('BTCUSDT')) });
  a.members = ['BTCUSDT', 'SOLUSDT'];
  a.rebalance_pending = true;
  const m2 = exposureMarket({ BTCUSDT: series(wobble(81, 50000, 0.02)), ETHUSDT: series(wobble(81, 3000, 0.03)), SOLUSDT: series(wobble(81, 100, 0.03)) });
  const { trades } = runLabStep({ account: a, strategy: exposure, market: m2, now: nowAfter(m2.candles.get('BTCUSDT')) });
  const eth = trades.find((t) => t.symbol === 'ETHUSDT');
  assert.ok(eth && eth.side === 'sell');
  assert.match(eth.reason, /left the universe/);
  assert.ok(!a.positions.ETHUSDT);
  assert.ok(a.positions.SOLUSDT);
  assert.strictEqual(trades[0].side, 'sell');
});

test('exposure: a held coin with no price is left alone', () => {
  const a = newLabAccount(exposure, { now: T0 });
  a.members = ['BTCUSDT', 'ETHUSDT'];
  const m = exposureMarket({ BTCUSDT: series(wobble(80, 50000, 0.02)), ETHUSDT: series(wobble(80, 3000, 0.03)) });
  runLabStep({ account: a, strategy: exposure, market: m, now: nowAfter(m.candles.get('BTCUSDT')) });
  const qty = a.positions.ETHUSDT.quantity;
  a.members = ['BTCUSDT'];
  a.rebalance_pending = true;
  const m2 = exposureMarket({ BTCUSDT: series(wobble(81, 50000, 0.02)), ETHUSDT: series(wobble(81, 3000, 0.03)) });
  m2.prices.delete('ETHUSDT');
  const { trades } = runLabStep({ account: a, strategy: exposure, market: m2, now: nowAfter(m2.candles.get('BTCUSDT')) });
  assert.ok(!trades.some((t) => t.symbol === 'ETHUSDT'));
  assert.strictEqual(a.positions.ETHUSDT.quantity, qty);
});

test('exposure: at the floor it sells everything between decisions and never buys again', () => {
  const a = newLabAccount(exposure, { now: T0 });
  a.members = ['BTCUSDT'];
  const m = exposureMarket({ BTCUSDT: series(wobble(80, 50000, 0.001)) });
  const now = nowAfter(m.candles.get('BTCUSDT'));
  runLabStep({ account: a, strategy: exposure, market: m, now });
  assert.ok(a.positions.BTCUSDT);
  // Fully invested (quiet coin, scale 1): a 31% drop takes equity under $7,000.
  const crash = { candles: m.candles, prices: new Map([['BTCUSDT', m.prices.get('BTCUSDT') * 0.69]]) };
  const hit = runLabStep({ account: a, strategy: exposure, market: crash, now: now + 3600e3 });
  assert.strictEqual(hit.decided, false);
  assert.strictEqual(hit.trades.length, 1);
  assert.match(hit.trades[0].reason, /Floor/);
  assert.ok(a.floored_at);
  assert.strictEqual(Object.keys(a.positions).length, 0);
  // Recovery and a new bar: still nothing.
  a.rebalance_pending = true;
  const m2 = exposureMarket({ BTCUSDT: series(wobble(90, 50000, 0.001)) });
  const later = runLabStep({ account: a, strategy: exposure, market: m2, now: nowAfter(m2.candles.get('BTCUSDT')) });
  assert.strictEqual(later.trades.length, 0);
});

test('exposure: an empty membership decides without trading (holds cash)', () => {
  const a = newLabAccount(exposure, { now: T0 });
  const m = exposureMarket({});
  const r = runLabStep({ account: a, strategy: exposure, market: m, now: nowAfter(m.candles.get('BTCUSDT')) });
  assert.ok(r.decided);
  assert.strictEqual(r.trades.length, 0);
  assert.strictEqual(a.cash, LAB_START_CAPITAL);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
