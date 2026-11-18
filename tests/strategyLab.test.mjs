/**
 * Strategy lab tests: daily-bar timing, the trend rule, the composite rule,
 * stops, sizing limits, and paper accounting.
 */
import assert from 'node:assert';
import {
  LAB_STRATEGIES, LAB_START_CAPITAL, DAY_MS, DAILY_BAR_OFFSET_MS,
  latestClosedDailyBar, newLabAccount, runLabStep, compositeVotes, accountEquity,
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
