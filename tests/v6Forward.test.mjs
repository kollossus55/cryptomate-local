/**
 * Forward test runner: frozen code check, append-only fill log, drift detection, review lock.
 * Uses synthetic stores only; never reads the real forward store or the network.
 */
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAY_MS, FORWARD_REVIEW, FORWARD_START, configureBarStore } from '../shared/trading/v6Bars.js';
import { seededRandom } from '../shared/trading/v6Stats.js';
import * as fwd from '../scripts/v6/forward-test.mjs';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.stack).split('\n').slice(0, 3).join('\n        ')}`); }
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'v6fwd-'));
const H4 = 4 * 3600e3;
const IDS = ['F1', 'F2', 'F3', 'F4'];

/** Random walks with an upward drift, 1d and 4h, from the warmup start to `end`. Same seed, same path. */
function writeStore(dir, end, { seed = 7, coins = 26 } = {}) {
  const symbols = ['BTCUSDT', 'ETHUSDT', ...Array.from({ length: coins }, (_, i) => `C${i}USDT`)];
  symbols.forEach((symbol, k) => {
    for (const [tf, step] of [['4h', H4], ['1d', DAY_MS]]) {
      const rnd = seededRandom(seed * 1000 + k);
      const scale = Math.sqrt(step / DAY_MS);
      const rows = [];
      let price = 100;
      for (let t = fwd.WARMUP_FROM; t + step <= end; t += step) {
        const r = 0.0015 * (step / DAY_MS) + 0.06 * (rnd() - 0.5) * scale;
        const o = price, c = price * (1 + r);
        const qv = (symbol === 'BTCUSDT' ? 9e9 : 1e9 / (k + 1)) * (step / DAY_MS);
        rows.push(t, o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c, 1000, qv);
        price = c;
      }
      const target = path.join(dir, 'forward', tf);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, `${symbol}.bin`), Buffer.from(new Float64Array(rows).buffer));
    }
  });
  writeFileSync(path.join(dir, 'tracked.json'), JSON.stringify({ day: 'synthetic', symbols: Object.fromEntries(symbols.map((s) => [s, {}])) }));
}

const lines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const logOf = (dir, id) => path.join(dir, 'log', `${id}.jsonl`);
const textOf = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

console.log('frozen code');
await test('the frozen research scripts still match their pre-registered hashes', () => fwd.checkFrozen());
await test('a changed hash stops the run', () => {
  assert.throws(() => fwd.checkFrozen({ ...fwd.FROZEN_HASHES, 'r-risk.mjs': '0'.repeat(64) }), /Frozen strategy code changed: r-risk.mjs/);
});
await test('four candidates with the pre-registered parameters', async () => {
  const list = await fwd.candidates();
  assert.deepStrictEqual(list.map((c) => `${c.id}:${c.timeframe}:${c.strategy.id}`),
    ['F1:1d:ref_brk20', 'F2:1d:exit-breakout', 'F3:1d:r-trend-tsmom-btceth', 'F4:4h:brk_donchian_4h']);
  assert.deepStrictEqual(list[0].strategy.params, { n: 20 });
  assert.deepStrictEqual(list[1].strategy.params, { cfg: 'ph_trend' });
  assert.strictEqual(list[2].strategy.params.L, 365);
  assert.deepStrictEqual(list[3].strategy.params, { regime: 'btc200', topN: 30, n: 200, exit: 'trend' });
  assert.strictEqual(list[1].config.risk.maxStopDistancePct, 0.30);
});

console.log('bars');
await test('only closed bars after the last stored one are kept', () => {
  const k = (t, closeTime) => [t, '1', '2', '0.5', '1.5', '10', closeTime, '99'];
  assert.deepStrictEqual(fwd.closedRows([k(1, 50), k(2, 150), k(3, 250)], { now: 200, after: 1 }), [[2, 1, 2, 0.5, 1.5, 10, 99]]);
});
await test('tracking takes USDT pairs by volume and skips stablecoins and dead pairs', () => {
  const tickers = [{ symbol: 'USDCUSDT', quoteVolume: '9e12' }, { symbol: 'BTCUSDT', quoteVolume: '5e9' }, { symbol: 'ETHBTC', quoteVolume: '9e12' },
    { symbol: 'SOLUSDT', quoteVolume: '1e9' }, { symbol: 'DEADUSDT', quoteVolume: '0' }];
  assert.deepStrictEqual(fwd.topSymbols(tickers), ['BTCUSDT', 'SOLUSDT']);
});

console.log('runs (synthetic store, offline)');
const dir = path.join(tmp, 'store');
await test('before the forward window nothing is simulated', async () => {
  writeStore(dir, FORWARD_START);
  const run = await fwd.runOnce({ dir, now: FORWARD_START, offline: true });
  assert.deepStrictEqual(run.newFills, {});
  assert.deepStrictEqual(run.errors, []);
});
let firstCount = 0;
await test('all four candidates simulate, and fills come from the forward window only', async () => {
  writeStore(dir, FORWARD_START + 90 * DAY_MS);
  const run = await fwd.runOnce({ dir, now: FORWARD_START + 90 * DAY_MS, offline: true });
  assert.deepStrictEqual(run.errors, []);
  assert.deepStrictEqual(Object.keys(run.newFills).sort(), IDS);
  const all = IDS.flatMap((id) => lines(logOf(dir, id)));
  assert.ok(all.length > 0, 'the synthetic uptrend should trigger something');
  assert.ok(all.every((f) => f.t >= FORWARD_START), 'no fill before the forward start');
  firstCount = all.length;
});
await test('a repeat with no new bar logs nothing', async () => {
  const run = await fwd.runOnce({ dir, now: FORWARD_START + 90 * DAY_MS + 3600e3, offline: true });
  assert.deepStrictEqual(run.newFills, {});
  assert.deepStrictEqual(run.drift, {});
});
await test('new bars only append; the past log is unchanged and no drift is reported', async () => {
  const before = IDS.map((id) => textOf(logOf(dir, id)));
  writeStore(dir, FORWARD_START + 150 * DAY_MS);
  const run = await fwd.runOnce({ dir, now: FORWARD_START + 150 * DAY_MS, offline: true });
  assert.deepStrictEqual(run.errors, []);
  assert.deepStrictEqual(run.drift, {}, JSON.stringify(run));
  IDS.forEach((id, i) => assert.ok(textOf(logOf(dir, id)).startsWith(before[i]), id));
  assert.ok(IDS.flatMap((id) => lines(logOf(dir, id))).length >= firstCount);
});
await test('rewritten history is reported as drift and not written into the log', async () => {
  const before = IDS.map((id) => lines(logOf(dir, id)).length);
  writeStore(dir, FORWARD_START + 151 * DAY_MS, { seed: 99 });
  const run = await fwd.runOnce({ dir, now: FORWARD_START + 151 * DAY_MS, offline: true });
  assert.ok(Object.values(run.drift).some((n) => n > 0), JSON.stringify(run));
  IDS.forEach((id, i) => {
    const after = lines(logOf(dir, id));
    assert.ok(after.slice(before[i]).every((f) => f.t > FORWARD_START + 149 * DAY_MS), `${id} back-dated a fill`);
  });
});
await test('status shows counts only, never returns or prices', () => {
  const s = JSON.stringify(fwd.status({ dir }));
  assert.ok(!/return|sharpe|price|equity|pnl/i.test(s), s);
});

console.log('review');
await test('the review refuses before 2027-05-14', async () => {
  await assert.rejects(fwd.review({ dir, now: FORWARD_REVIEW - 1 }), /opens on 2027-05-14/);
});
await test('on the review date it applies every pre-registered check', async () => {
  const d2 = path.join(tmp, 'store2');
  writeStore(d2, FORWARD_REVIEW + DAY_MS);
  await fwd.runOnce({ dir: d2, now: FORWARD_REVIEW + DAY_MS, offline: true });
  const r = await fwd.review({ dir: d2, now: FORWARD_REVIEW });
  assert.deepStrictEqual(r.window, ['2026-11-14', '2027-05-13']);
  assert.deepStrictEqual(Object.keys(r.candidates), IDS);
  for (const c of Object.values(r.candidates)) {
    assert.deepStrictEqual(Object.keys(c.checks), ['positiveReturn', 'sharpe', 'drawdown', 'beatsBtcHold', 'enoughTrades', 'matchesLiveLog']);
    assert.strictEqual(c.forwardSupport, Object.values(c.checks).every(Boolean));
    assert.strictEqual(c.unmatchedFills, 0, 'a single live run and the review re-run must agree');
  }
});

configureBarStore({ dir: null });
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
