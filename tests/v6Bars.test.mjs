/**
 * V6 bar store tests: holdout lock, point-in-time universe, no future leakage,
 * delisting visibility. Fixture tests always run; real-data checks run when the store exists.
 */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as bars from '../shared/trading/v6Bars.js';

const { HOLDOUT_START, DEV_END, DAY_MS, loadBars, pointInTimeUniverse, tierFor, symbolInfo, listSymbols,
  isExcludedSymbol, configureBarStore, medianQuoteVolume, barFlags } = bars;

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'v6bars-'));
const day = (y, m, d) => Date.UTC(y, m - 1, d);

function writeSeries(dir, part, symbol, from, to, qv = () => 1e6) {
  const rows = [];
  for (let t = from; t <= to; t += DAY_MS) rows.push(t, 10, 11, 9, 10, 100, qv(t));
  const target = path.join(dir, part, '1d');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, `${symbol}.bin`), Buffer.from(new Float64Array(rows).buffer));
}

/** Writes one coin's life, split at the boundary the way the fetcher does. */
function writeCoin(dir, symbol, from, to, qv) {
  if (from < HOLDOUT_START) writeSeries(dir, 'dev', symbol, from, Math.min(to, HOLDOUT_START - DAY_MS), qv);
  if (to >= HOLDOUT_START) writeSeries(dir, 'holdout', symbol, Math.max(from, HOLDOUT_START), to, qv);
}

function makeFixture(dir, { cutoff = Infinity } = {}) {
  const end = (t) => Math.min(t, cutoff);
  writeCoin(dir, 'BTCUSDT', day(2023, 1, 1), end(day(2025, 6, 1)), () => 9e9);
  writeCoin(dir, 'DEADUSDT', day(2023, 1, 1), end(day(2024, 6, 1)), () => 8e7);
  writeCoin(dir, 'LATEUSDT', day(2024, 1, 1), end(day(2025, 3, 1)), () => 5e6);
  writeCoin(dir, 'YOUNGUSDT', day(2024, 6, 1), end(day(2025, 6, 1)), () => 1e8);
  writeCoin(dir, 'USDCUSDT', day(2023, 1, 1), end(day(2025, 6, 1)), () => 2e10);
  writeCoin(dir, 'THINUSDT', day(2023, 1, 1), end(day(2025, 6, 1)), () => 0);
  // Its volume explodes only after 2024-03-01, so an earlier ranking must not know that.
  writeCoin(dir, 'PUMPUSDT', day(2023, 1, 1), end(day(2025, 6, 1)), (t) => (t >= day(2024, 3, 1) ? 7e9 : 1e3));
  if (cutoff === Infinity) writeSeries(dir, 'holdout', 'NEWUSDT', day(2025, 2, 1), day(2025, 6, 1), () => 1e9);
}

const fixture = path.join(tmp, 'store');
makeFixture(fixture);
configureBarStore({ dir: fixture });
delete process.env.V6_HOLDOUT_UNLOCK;

console.log('holdout lock');
await test('loadBars throws for any `to` past DEV', () => {
  for (const to of [HOLDOUT_START, HOLDOUT_START + 1, day(2026, 1, 1), Infinity]) {
    assert.throws(() => loadBars({ timeframe: '1d', to }), /holdout/);
  }
});
await test('loadBars throws for `from` past DEV, and fails closed on a bad `to`', () => {
  assert.throws(() => loadBars({ timeframe: '1d', from: HOLDOUT_START }), /holdout/);
  assert.throws(() => loadBars({ timeframe: '1d', to: '2026-01-01' }), TypeError);
  assert.throws(() => loadBars({ timeframe: '1d', to: NaN }), TypeError);
});
await test('a wrong token does not unlock', () => {
  process.env.V6_HOLDOUT_UNLOCK = 'guess';
  assert.throws(() => loadBars({ timeframe: '1d', to: HOLDOUT_START }), /holdout/);
  delete process.env.V6_HOLDOUT_UNLOCK;
});
await test('universe and tiers refuse holdout dates, while BTC tier needs no data', () => {
  assert.throws(() => pointInTimeUniverse(HOLDOUT_START), /holdout/);
  assert.throws(() => tierFor('DEADUSDT', HOLDOUT_START), /holdout/);
  assert.throws(() => medianQuoteVolume('DEADUSDT', HOLDOUT_START), /holdout/);
  assert.strictEqual(tierFor('BTCUSDT', HOLDOUT_START), 1);
});
await test('default range stops at DEV and never returns a holdout bar', () => {
  const m = loadBars({ timeframe: '1d' });
  for (const b of m.values()) assert.ok(b.at(-1).t <= DEV_END);
  assert.strictEqual(loadBars({ timeframe: '1d', to: DEV_END }).get('BTCUSDT').at(-1).t, day(2024, 12, 31));
});
await test('coins listed in the holdout do not exist in the locked view', () => {
  assert.ok(!listSymbols().includes('NEWUSDT'));
  assert.strictEqual(symbolInfo('NEWUSDT'), null);
  assert.strictEqual(loadBars({ symbols: ['NEWUSDT'], timeframe: '1d' }).size, 0);
});

console.log('point-in-time universe');
await test('a coin enters only on reaching 200 closed daily bars', () => {
  const first = day(2024, 6, 1);
  // The 200th bar opens at first + 199 days and is closed at first + 200 days.
  assert.ok(!pointInTimeUniverse(first + 200 * DAY_MS - 1).includes('YOUNGUSDT'));
  assert.ok(pointInTimeUniverse(first + 200 * DAY_MS).includes('YOUNGUSDT'));
});
await test('stablecoins and coins with no volume are never eligible', () => {
  const u = pointInTimeUniverse(day(2024, 3, 1));
  assert.ok(!u.includes('USDCUSDT'));
  assert.ok(!u.includes('THINUSDT'));
});
await test('ranking follows trailing median volume, and topN truncates it', () => {
  const t = day(2024, 2, 1);
  assert.deepStrictEqual(pointInTimeUniverse(t), ['BTCUSDT', 'DEADUSDT', 'PUMPUSDT']);
  assert.deepStrictEqual(pointInTimeUniverse(t, { topN: 1 }), ['BTCUSDT']);
});
await test('callers cannot corrupt the cached ranking', () => {
  const t = day(2024, 2, 1);
  pointInTimeUniverse(t).length = 0;
  assert.strictEqual(pointInTimeUniverse(t).length, 3);
});
await test('tiers use the volume known at the time', () => {
  assert.strictEqual(tierFor('ETHUSDT', day(2024, 2, 1)), 1);
  assert.strictEqual(tierFor('DEADUSDT', day(2024, 2, 1)), 2);
  assert.strictEqual(tierFor('PUMPUSDT', day(2024, 2, 1)), 3);
  assert.strictEqual(tierFor('PUMPUSDT', day(2024, 5, 1)), 2);
  assert.strictEqual(tierFor('NOSUCHUSDT', day(2024, 2, 1)), 3);
});

console.log('no future leakage');
await test('universe and tier at t are identical when all later data is deleted', () => {
  const dates = [day(2023, 9, 1), day(2024, 2, 1), day(2024, 3, 10), day(2024, 7, 1), day(2024, 12, 1)];
  const full = dates.map((t) => [pointInTimeUniverse(t), tierFor('PUMPUSDT', t), medianQuoteVolume('PUMPUSDT', t)]);
  dates.forEach((t, i) => {
    const cut = path.join(tmp, `cut${i}`);
    makeFixture(cut, { cutoff: t - DAY_MS }); // last bar closes exactly at t
    configureBarStore({ dir: cut });
    assert.deepStrictEqual([pointInTimeUniverse(t), tierFor('PUMPUSDT', t), medianQuoteVolume('PUMPUSDT', t)], full[i]);
  });
  configureBarStore({ dir: fixture });
});
await test('the bar still open at t has no effect on the ranking', () => {
  // Volume jumps on 2024-03-01. Mid-day that bar is open, so the median must not move at all.
  const before = medianQuoteVolume('PUMPUSDT', day(2024, 3, 1));
  assert.strictEqual(medianQuoteVolume('PUMPUSDT', day(2024, 3, 1) + DAY_MS - 1), before);
});

console.log('delisting');
await test('a dead coin appears before its death and not after', () => {
  assert.ok(pointInTimeUniverse(day(2024, 6, 1)).includes('DEADUSDT'));
  assert.ok(pointInTimeUniverse(day(2024, 6, 2)).includes('DEADUSDT'));
  assert.ok(!pointInTimeUniverse(day(2024, 6, 3)).includes('DEADUSDT'));
  assert.ok(!pointInTimeUniverse(day(2024, 12, 1)).includes('DEADUSDT'));
});
await test('symbolInfo exposes the last bar and last close for the delisting rule', () => {
  const i = symbolInfo('DEADUSDT');
  assert.strictEqual(i.delisted, true);
  assert.strictEqual(i.deathKind, 'delisted');
  assert.strictEqual(i.lastBarT, day(2024, 6, 1));
  assert.strictEqual(i.lastClose, 10);
});
await test('a coin that dies in the holdout looks alive in the locked view', () => {
  const i = symbolInfo('LATEUSDT');
  assert.strictEqual(i.delisted, false);
  assert.strictEqual(i.lastBarT, day(2024, 12, 31));
});

console.log('unlocked view (private copy of the module with a test token hash)');
await test('the right token opens the holdout, and DEV answers do not change', async () => {
  const src = readFileSync(fileURLToPath(new URL('../shared/trading/v6Bars.js', import.meta.url)), 'utf8');
  const hash = createHash('sha256').update('test-token').digest('hex');
  assert.ok(src.includes(bars.HOLDOUT_TOKEN_SHA256));
  const copy = path.join(tmp, 'v6BarsCopy.mjs');
  writeFileSync(copy, src.replace(bars.HOLDOUT_TOKEN_SHA256, hash));
  const m = await import(pathToFileURL(copy).href);
  m.configureBarStore({ dir: fixture });
  const t = day(2024, 7, 1);
  const lockedUniverse = m.pointInTimeUniverse(t);
  assert.strictEqual(m.symbolInfo('LATEUSDT').delisted, false);
  process.env.V6_HOLDOUT_UNLOCK = 'test-token';
  try {
    assert.ok(m.loadBars({ symbols: ['BTCUSDT'], timeframe: '1d' }).get('BTCUSDT').at(-1).t === day(2025, 6, 1));
    assert.deepStrictEqual(m.pointInTimeUniverse(t), lockedUniverse);
    const late = m.symbolInfo('LATEUSDT');
    assert.strictEqual(late.delisted, true);
    assert.strictEqual(late.lastBarT, day(2025, 3, 1));
    assert.ok(m.listSymbols().includes('NEWUSDT'));
  } finally { delete process.env.V6_HOLDOUT_UNLOCK; }
  assert.throws(() => m.loadBars({ timeframe: '1d', to: HOLDOUT_START }), /holdout/);
});

console.log('holdout end and forward view');
await test('an unlocked holdout stops at HOLDOUT_END (2026-11-13), whatever the file holds', async () => {
  const src = readFileSync(fileURLToPath(new URL('../shared/trading/v6Bars.js', import.meta.url)), 'utf8');
  const hash = createHash('sha256').update('test-token').digest('hex');
  const copy = path.join(tmp, 'v6BarsEnd.mjs');
  writeFileSync(copy, src.replace(bars.HOLDOUT_TOKEN_SHA256, hash));
  const m = await import(pathToFileURL(copy).href);
  const dir = path.join(tmp, 'store-end');
  writeSeries(dir, 'dev', 'BTCUSDT', day(2024, 1, 1), day(2024, 12, 31), () => 9e9);
  writeSeries(dir, 'holdout', 'BTCUSDT', day(2025, 1, 1), day(2027, 1, 1), () => 9e9);
  m.configureBarStore({ dir });
  process.env.V6_HOLDOUT_UNLOCK = 'test-token';
  try {
    assert.strictEqual(m.loadBars({ symbols: ['BTCUSDT'], timeframe: '1d' }).get('BTCUSDT').at(-1).t, day(2026, 11, 13));
    assert.strictEqual(m.loadBars({ symbols: ['BTCUSDT'], timeframe: '1d', to: Infinity }).get('BTCUSDT').at(-1).t, day(2026, 11, 13));
    assert.throws(() => m.loadBars({ timeframe: '1d', to: m.FORWARD_START }), /forward test/);
    assert.throws(() => m.pointInTimeUniverse(day(2026, 12, 1)), /forward test/);
  } finally { delete process.env.V6_HOLDOUT_UNLOCK; }
});

await test('the forward view reads only its own folder and is left by configureBarStore', () => {
  const dir = path.join(tmp, 'store-fwd');
  writeSeries(dir, 'dev', 'DEVONLYUSDT', day(2023, 1, 1), day(2024, 12, 31));
  writeSeries(dir, 'holdout', 'HOLDONLYUSDT', day(2025, 1, 1), day(2026, 6, 1));
  writeSeries(dir, 'forward', 'BTCUSDT', day(2025, 8, 1), day(2026, 12, 20), () => 9e9);
  writeSeries(dir, 'forward', 'FWDUSDT', day(2025, 8, 1), day(2026, 12, 20), () => 1e8);
  bars.openForwardView({ dir });
  try {
    assert.ok(bars.isForwardView());
    assert.deepStrictEqual(bars.listSymbols(), ['BTCUSDT', 'FWDUSDT']);
    assert.strictEqual(loadBars({ timeframe: '1d' }).get('BTCUSDT').at(-1).t, day(2026, 12, 20));
    assert.deepStrictEqual(pointInTimeUniverse(day(2026, 12, 1)), ['BTCUSDT', 'FWDUSDT']);
  } finally { configureBarStore({ dir: fixture }); }
  assert.ok(!bars.isForwardView());
  assert.throws(() => loadBars({ timeframe: '1d', to: HOLDOUT_START }), /holdout/);
});

await test('no research script opens the forward view', () => {
  const dir = fileURLToPath(new URL('../scripts/v6/research/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    assert.ok(!readFileSync(path.join(dir, f), 'utf8').includes('openForwardView'), f);
  }
});

console.log('exclusions');
await test('stable, wrapped, leveraged and tokenised tokens are excluded; real coins are not', () => {
  for (const s of ['USDCUSDT', 'USTUSDT', 'WBTCUSDT', 'PAXGUSDT', 'BTCUPUSDT', 'ETHDOWNUSDT', 'BNBBULLUSDT', 'XRPBEARUSDT', 'BEARUSDT', 'AAPLBUSDT']) {
    assert.ok(isExcludedSymbol(s), s);
  }
  for (const s of ['BTCUSDT', 'JUPUSDT', 'SUPERUSDT', 'LUNAUSDT~2', 'BNBUSDT', 'WIFUSDT']) assert.ok(!isExcludedSymbol(s), s);
});

configureBarStore();
if (existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'research', 'v6', 'dev', '1d', 'BTCUSDT.bin'))) {
  console.log('real DEV store');
  await test('every universe member has 200 closed bars and traded, on weekly samples', () => {
    const all = loadBars({ timeframe: '1d' });
    for (let t = day(2018, 6, 1); t <= day(2024, 12, 31); t += 7 * DAY_MS) {
      for (const s of pointInTimeUniverse(t)) {
        const closed = all.get(s).filter((b) => b.t + DAY_MS <= t);
        assert.ok(closed.length >= 200, `${s} had ${closed.length} bars at ${t}`);
        assert.strictEqual(closed.at(-1).t, Math.floor(t / DAY_MS) * DAY_MS - DAY_MS, `${s} did not trade`);
        assert.ok(!isExcludedSymbol(s), s);
      }
    }
  });
  await test('old LUNA is in the universe before its 2022 collapse and gone after', () => {
    assert.ok(pointInTimeUniverse(day(2022, 3, 1), { topN: 30 }).includes('LUNAUSDT'));
    assert.ok(!pointInTimeUniverse(day(2022, 6, 15)).includes('LUNAUSDT'));
    assert.ok(symbolInfo('LUNAUSDT').delisted);
  });
  await test('the reused LUNA ticker is a separate coin, not a +2,000,000% bar', () => {
    assert.ok(symbolInfo('LUNAUSDT').lastBarT < symbolInfo('LUNAUSDT~2').firstBarT);
  });
  await test('redenominations are back-adjusted: no 5x step across any swap', () => {
    for (const s of ['BNXUSDT', 'BTCSTUSDT', 'COCOSUSDT', 'DREPUSDT', 'QUICKUSDT', 'STRAXUSDT', 'SUNUSDT', 'VIDTUSDT']) {
      for (const tf of ['1d', '4h']) {
        const b = loadBars({ symbols: [s], timeframe: tf }).get(s);
        for (let i = 1; i < b.length; i++) {
          const r = b[i].o / b[i - 1].c;
          assert.ok(r < 5 && r > 0.2, `${s} ${tf} step ${r} at ${b[i].t}`);
        }
      }
    }
  });
  await test('no stored DEV bar reaches the holdout, on any timeframe present', () => {
    for (const timeframe of ['1d', '4h']) {
      for (const b of loadBars({ timeframe }).values()) assert.ok(b.at(-1).t < HOLDOUT_START);
    }
  });
  await test('a migrated pair is told apart from a real delisting, and flags load', () => {
    assert.strictEqual(symbolInfo('MATICUSDT').deathKind, 'migrated');
    assert.strictEqual(symbolInfo('MATICUSDT').migratedTo, 'POLUSDT');
    assert.strictEqual(symbolInfo('BTCUSDT').delisted, false);
    assert.ok(barFlags('LINKUSDT').some((f) => f.kinds.includes('wick')));
  });
} else {
  console.log('  SKIP  real DEV store not present');
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
