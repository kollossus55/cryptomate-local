/**
 * v6Derivs tests: the holdout lock, funding time alignment, no future rows, dead
 * tails, and (when the store exists) checks on real DEV files. Holdout files are
 * only ever fixtures here: the real ones are never opened.
 */
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEV_END, HOLDOUT_START, HOLDOUT_TOKEN_SHA256, HOUR_MS, alignFundingTime, closedBars, fundingIntervals, holdoutUnlocked,
  loadFunding, loadOpenInterest, loadPerpBars, loadVenueBars, normalizeFunding, perpToSpot, resolveRange, splitAtHoldout, trimDeadTail,
} from '../shared/trading/v6Derivs.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

delete process.env.V6_HOLDOUT_UNLOCK;
const DAY = 24 * HOUR_MS;

const root = mkdtempSync(path.join(tmpdir(), 'v6derivs-'));
const put = (rel, rows) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rows));
};
const bar = (t, qv = 100) => [t, 1, 2, 0.5, 1.5, 10, qv];
const lastDevDay = HOLDOUT_START - DAY;
put('derivs/dev/1d/AAAUSDT.json', [bar(lastDevDay - DAY), bar(lastDevDay)]);
put('derivs/holdout/1d/AAAUSDT.json', [bar(HOLDOUT_START)]);
put('derivs/dev/funding/AAAUSDT.json', [[lastDevDay, 0.0001, 1], [HOLDOUT_START - 8 * HOUR_MS, 0.0002, 1]]);
put('derivs/holdout/funding/AAAUSDT.json', [[HOLDOUT_START, 0.9, 1]]);
put('venues/dev/okx/1d/AAAUSDT.json', [bar(lastDevDay)]);
put('venues/holdout/okx/1d/AAAUSDT.json', [bar(HOLDOUT_START)]);
const q = { symbols: ['AAAUSDT'], dataRoot: root };

console.log('holdout lock');
test('constants match the contract', () => {
  assert.equal(HOLDOUT_START, Date.UTC(2025, 0, 1));
  assert.equal(HOLDOUT_TOKEN_SHA256, '132e23ac759b080970d2f5035f03ec0eda73ec6cc6ae312b3b1fe9066e60d817');
});
test('all loaders refuse a range past DEV', () => {
  assert.throws(() => loadOpenInterest({ ...q, to: HOLDOUT_START }), /HOLDOUT LOCKED/);
  assert.throws(() => loadFunding({ ...q, to: HOLDOUT_START }), /HOLDOUT LOCKED/);
  assert.throws(() => loadPerpBars({ ...q, timeframe: '1d', to: '2025-01-02' }), /HOLDOUT LOCKED/);
  assert.throws(() => loadVenueBars('okx', { ...q, timeframe: '1d', to: new Date(HOLDOUT_START) }), /HOLDOUT LOCKED/);
});
test('the last DEV millisecond and day are allowed', () => {
  assert.equal(resolveRange({ to: DEV_END }).to, DEV_END);
  assert.equal(resolveRange({ to: '2024-12-31' }).to, DEV_END);
});
test('a holdout-only range is refused', () => {
  assert.throws(() => loadFunding({ ...q, from: HOLDOUT_START, to: HOLDOUT_START + DAY }), /HOLDOUT LOCKED/);
});
test('an omitted to stops at DEV and never returns holdout rows', () => {
  assert.equal(loadPerpBars({ ...q, timeframe: '1d' }).get('AAAUSDT').length, 2);
  assert.ok(loadFunding(q).get('AAAUSDT').every((r) => r.t < HOLDOUT_START));
  assert.ok(loadVenueBars('okx', { ...q, timeframe: '1d' }).get('AAAUSDT').every((r) => r.t < HOLDOUT_START));
});
test('unparseable or infinite bounds throw rather than slip past the lock', () => {
  for (const to of [NaN, Infinity, 'soon', {}]) assert.throws(() => loadFunding({ ...q, to }), TypeError);
  for (const from of [NaN, -Infinity]) assert.throws(() => loadFunding({ ...q, from }), TypeError);
});
test('a wrong token does not unlock', () => {
  process.env.V6_HOLDOUT_UNLOCK = 'not-the-token';
  try {
    assert.equal(holdoutUnlocked(), false);
    assert.throws(() => loadFunding({ ...q, to: HOLDOUT_START }), /HOLDOUT LOCKED/);
  } finally { delete process.env.V6_HOLDOUT_UNLOCK; }
});
test('a symbol cannot path-traverse into the holdout folder', () => {
  assert.throws(() => loadFunding({ ...q, symbols: ['../../holdout/funding/AAAUSDT'] }), /bad symbol/);
});
test('a DEV file holding a holdout-dated row is treated as corrupt', () => {
  put('derivs/dev/1d/BADUSDT.json', [bar(HOLDOUT_START)]);
  assert.throws(() => loadPerpBars({ ...q, symbols: ['BADUSDT'], timeframe: '1d' }), /corrupt store/);
});

console.log('funding alignment');
test('jitter either side of the hour snaps to it', () => {
  assert.equal(alignFundingTime(1599235200006), 1599235200000);
  assert.equal(alignFundingTime(1599235200000 - 40), 1599235200000);
});
test('normalizeFunding aligns, sorts, de-duplicates, and maps a blank mark to null', () => {
  const t = 1599235200000;
  const rows = normalizeFunding([
    { fundingTime: t + 8 * HOUR_MS, fundingRate: '0.0002', markPrice: '5', rateType: 'Regular' },
    { fundingTime: t + 6, fundingRate: '0.0001', markPrice: '' },
    { fundingTime: t + 2, fundingRate: '0.0003', markPrice: '', rateType: 'Other' },
  ]);
  assert.deepEqual(rows, [[t, 0.0003, null, 'Other'], [t + 8 * HOUR_MS, 0.0002, 5]]);
});
test('a stamp just before midnight lands on the holdout side of the split', () => {
  const [row] = normalizeFunding([{ fundingTime: HOLDOUT_START - 5, fundingRate: '0.1', markPrice: '1' }]);
  assert.equal(splitAtHoldout([row]).dev.length, 0);
});
test('fundingIntervals separates regimes from outages', () => {
  const t0 = Date.UTC(2023, 0, 1);
  const rows = [0, 8, 16, 20, 24, 72].map((h) => ({ t: t0 + h * HOUR_MS }));
  const { regimes, gaps } = fundingIntervals(rows);
  assert.deepEqual(regimes.map((r) => [r.hours, r.events]), [[8, 2], [4, 2]]);
  assert.equal(gaps.length, 1);
});

console.log('no future rows');
test('closedBars drops the bar still open at now', () => {
  const t = Date.UTC(2024, 5, 1);
  const rows = [bar(t), bar(t + DAY), bar(t + 2 * DAY)];
  assert.deepEqual(closedBars(rows, '1d', t + 2 * DAY + 1).map((r) => r[0]), [t, t + DAY]);
  assert.equal(closedBars(rows, '1d', t + 2 * DAY).length, 2);
  assert.equal(closedBars(rows, '1d', t + 3 * DAY).length, 3);
});
test('closedBars drops off-grid bars, such as a Hong Kong midnight daily', () => {
  const t = Date.UTC(2024, 5, 1);
  assert.equal(closedBars([bar(t - 8 * HOUR_MS)], '1d', t + 9 * DAY).length, 0);
});
test('splitAtHoldout keeps the 2024-12-31 bar in DEV and 2025-01-01 in holdout', () => {
  const { dev, holdout } = splitAtHoldout([bar(lastDevDay), bar(HOLDOUT_START)]);
  assert.deepEqual([dev.length, holdout.length], [1, 1]);
  assert.equal(holdout[0][0], HOLDOUT_START);
});
test('loaders honour an inclusive to', () => {
  const rows = loadPerpBars({ ...q, timeframe: '1d', to: lastDevDay - DAY }).get('AAAUSDT');
  assert.deepEqual(rows.map((r) => r.t), [lastDevDay - DAY]);
});

console.log('dead tails and symbols');
test('flat zero-volume bars after delisting are cut, mid-life ones kept', () => {
  const t = Date.UTC(2022, 0, 1);
  const rows = [bar(t), bar(t + DAY, 0), bar(t + 2 * DAY), bar(t + 3 * DAY, 0), bar(t + 4 * DAY, 0)];
  assert.deepEqual(trimDeadTail(rows).map((r) => r[0]), [t, t + DAY, t + 2 * DAY]);
  assert.equal(trimDeadTail([bar(t, 0)]).length, 0);
});
test('funding after the last traded bar is dropped, and raw keeps it', () => {
  const t = Date.UTC(2022, 0, 1);
  put('derivs/dev/1d/DEADUSDT.json', [bar(t), bar(t + DAY, 0), bar(t + 2 * DAY, 0)]);
  put('derivs/dev/funding/DEADUSDT.json', [[t + 8 * HOUR_MS, 0.0001, 1], [t + DAY, 0.0001, 1], [t + 2 * DAY, 0.0001, null]]);
  const args = { ...q, symbols: ['DEADUSDT'] };
  assert.equal(loadFunding(args).get('DEADUSDT').length, 2);
  assert.equal(loadFunding({ ...args, raw: true }).get('DEADUSDT').length, 3);
  assert.equal(loadPerpBars({ ...args, timeframe: '1d' }).get('DEADUSDT').length, 1);
});
test('funding before the first traded bar, or with no bars at all, is dropped', () => {
  const t = Date.UTC(2022, 0, 10);
  put('derivs/dev/1d/LATEUSDT.json', [bar(t)]);
  put('derivs/dev/funding/LATEUSDT.json', [[t - DAY, 0.0001, null], [t + 8 * HOUR_MS, 0.0002, 1]]);
  put('derivs/dev/funding/NOBARSUSDT.json', [[t, 0.0001, null]]);
  assert.deepEqual(loadFunding({ ...q, symbols: ['LATEUSDT'] }).get('LATEUSDT').map((r) => r.rate), [0.0002]);
  assert.equal(loadFunding({ ...q, symbols: ['NOBARSUSDT'] }).has('NOBARSUSDT'), false);
  assert.equal(loadFunding({ ...q, symbols: ['NOBARSUSDT'], raw: true }).get('NOBARSUSDT').length, 1);
});
test('perpToSpot reads multipliers without touching 1INCH', () => {
  assert.deepEqual(perpToSpot('1000PEPEUSDT'), { spot: 'PEPEUSDT', multiplier: 1000 });
  assert.deepEqual(perpToSpot('1000000MOGUSDT'), { spot: 'MOGUSDT', multiplier: 1e6 });
  assert.deepEqual(perpToSpot('1MBABYDOGEUSDT'), { spot: 'BABYDOGEUSDT', multiplier: 1e6 });
  assert.deepEqual(perpToSpot('1INCHUSDT'), { spot: '1INCHUSDT', multiplier: 1 });
  assert.deepEqual(perpToSpot('BTCUSDT'), { spot: 'BTCUSDT', multiplier: 1 });
});

rmSync(root, { recursive: true, force: true });

console.log('real DEV store');
const V6 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'research', 'v6');
const devDirs = [
  ['derivs/dev/funding', null], ['derivs/dev/oi', 'oi'], ['derivs/dev/1d', '1d'], ['derivs/dev/4h', '4h'],
  ...['okx', 'bybit'].flatMap((v) => [[`venues/dev/${v}/1d`, '1d'], [`venues/dev/${v}/4h`, '4h']]),
];
for (const [rel, timeframe] of devDirs) {
  const dir = path.join(V6, rel);
  if (!existsSync(dir)) { console.log(`  SKIP  ${rel} (not fetched yet)`); continue; }
  test(`${rel}: ascending, aligned, nothing at or past 2025-01-01`, () => {
    const step = { '1d': DAY, '4h': 4 * HOUR_MS, oi: 300e3 }[timeframe] ?? HOUR_MS;
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const rows = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i][0];
        assert.ok(t < HOLDOUT_START, `${name} row at ${t} is past DEV`);
        assert.equal(t % step, 0, `${name} row at ${t} off grid`);
        if (i) assert.ok(t > rows[i - 1][0], `${name} not ascending at ${t}`);
      }
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
