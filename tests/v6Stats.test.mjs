/**
 * v6Stats against hand-computed cases. Expected values are worked out in the
 * comments or come from published tables, not from running the code.
 */
import assert from 'node:assert';
import {
  bootstrapCI, calmar, cagr, deflatedSharpe, expectedMaxSharpe, inferPeriodsPerYear, maxDrawdown, mean, moments,
  normCdf, normInv, psr, seededRandom, sharpe, sortino, stdev, summarize, trialStats,
} from '../shared/trading/v6Stats.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('mean and sample stdev of 2,4,4,4,5,5,7,9', () => {
  const x = [2, 4, 4, 4, 5, 5, 7, 9];
  near(mean(x), 5);
  near(stdev(x), Math.sqrt(32 / 7)); // squared deviations sum to 32
});

test('sharpe: [0.01,0.02,0.03] daily is (0.02/0.01)*sqrt(365)', () => {
  near(sharpe([0.01, 0.02, 0.03], 365), 2 * Math.sqrt(365));
});

test('sharpe: zero variance is 0, not Infinity', () => {
  assert.strictEqual(sharpe([0.01, 0.01, 0.01], 365), 0);
});

test('sortino: [0.02,-0.01,0.02,-0.01] by hand', () => {
  // mean 0.005; downside sqrt((0.0001+0.0001)/4) = sqrt(0.00005)
  near(sortino([0.02, -0.01, 0.02, -0.01], 365), (0.005 / Math.sqrt(0.00005)) * Math.sqrt(365));
});

test('maxDrawdown: 100,120,60,90,130,65 is the 50% fall from both peaks', () => {
  near(maxDrawdown([100, 120, 60, 90, 130, 65]), 0.5);
  near(maxDrawdown([{ equity: 100 }, { equity: 75 }]), 0.25);
  assert.strictEqual(maxDrawdown([1, 2, 3]), 0);
});

test('cagr and calmar: doubling over 365 periods with a 25% drawdown', () => {
  const eq = new Array(366).fill(0).map((_, i) => 100 * 2 ** (i / 365));
  eq[100] = eq[99] * 0.75;
  near(cagr(eq, 365), 1);
  // the worst fall is eq[99] to eq[100], exactly 25%
  near(calmar(eq, 365), 1 / 0.25);
});

test('calmar: no drawdown gives 0, so it cannot win a comparison by accident', () => {
  assert.strictEqual(calmar([100, 101, 102], 365), 0);
});

test('normCdf matches published values', () => {
  near(normCdf(0), 0.5, 1e-14);
  near(normCdf(1), 0.8413447460685429, 1e-13);
  near(normCdf(1.96), 0.9750021048517795, 1e-13);
  near(normCdf(-3), 0.0013498980316300946, 1e-13);
});

test('normInv inverts normCdf, tails included', () => {
  near(normInv(0.975), 1.959963984540054, 1e-10);
  for (const p of [1e-9, 1e-4, 0.01, 0.3, 0.5, 0.9, 0.999, 1 - 1e-9]) near(normCdf(normInv(p)), p, 1e-12);
});

test('moments: symmetric sample has skew 0; [-1,1] has kurtosis 1', () => {
  near(moments([-2, -1, 0, 1, 2]).skew, 0);
  near(moments([-1, 1, -1, 1]).kurt, 1);
});

test('psr: hand case with zero skew and kurtosis 1', () => {
  // r alternates 0.03,-0.01 over T=100: mean 0.01, population sd 0.02, skew 0, kurt 1.
  const r = Array.from({ length: 100 }, (_, i) => (i % 2 ? -0.01 : 0.03));
  const sr = 0.01 / stdev(r);
  // the kurtosis term vanishes at kurt 1, so the denominator is exactly 1
  near(psr(r, 0), normCdf(sr * Math.sqrt(99)), 1e-12);
  near(psr(r, sr), 0.5, 1e-12);
});

test('psr: negative skew lowers confidence at the same Sharpe', () => {
  const sym = [], neg = [];
  for (let i = 0; i < 200; i++) { sym.push(i % 2 ? 0.02 : -0.01); neg.push(i % 10 === 0 ? -0.08 : 0.0133); }
  assert.ok(moments(neg).skew < -1);
  const srSym = mean(sym) / stdev(sym), srNeg = mean(neg) / stdev(neg);
  // scale the symmetric series onto the same Sharpe before comparing
  const scaled = sym.map((x) => x + (srNeg - srSym) * stdev(sym));
  near(mean(scaled) / stdev(scaled), srNeg, 1e-9);
  assert.ok(psr(neg, 0) < psr(scaled, 0));
});

test('expectedMaxSharpe: the Bailey & Lopez de Prado formula, N=100, V=1', () => {
  // (1-g) Z(0.99) + g Z(1 - 1/(100e)) with Z(0.99)=2.326348, Z(0.996321)=2.680 approx
  const g = 0.5772156649015329;
  const expected = (1 - g) * 2.3263478740408408 + g * normInv(1 - 1 / (100 * Math.E));
  near(expectedMaxSharpe(100, 1), expected, 1e-9);
  near(expectedMaxSharpe(100, 1), 0.42278 * 2.32635 + 0.57722 * 2.6803, 1e-3); // worked by hand: 2.5306
  near(expectedMaxSharpe(100, 4), 2 * expected, 1e-9);
});

test('expectedMaxSharpe: the approximation sits close to a simulated best of 100', () => {
  const rand = seededRandom(9);
  let total = 0;
  const reps = 5000;
  for (let i = 0; i < reps; i++) {
    let best = -Infinity;
    for (let k = 0; k < 100; k++) best = Math.max(best, normInv(rand() * 0.999998 + 0.000001));
    total += best;
  }
  near(total / reps, expectedMaxSharpe(100, 1), 0.05); // true value about 2.508; the formula runs about 1% high
});

test('deflatedSharpe: equals PSR at 1 trial, falls as trials grow', () => {
  const rand = seededRandom(5);
  const r = Array.from({ length: 1000 }, () => 0.002 + 0.02 * normInv(rand() * 0.998 + 0.001));
  near(deflatedSharpe(r, 1, 0.001), psr(r, 0), 1e-12);
  const v = 0.0004;
  const few = deflatedSharpe(r, 5, v), many = deflatedSharpe(r, 500, v);
  assert.ok(few > many, `${few} should exceed ${many}`);
  near(deflatedSharpe(r, 500, v), psr(r, expectedMaxSharpe(500, v)), 1e-12);
});

test('trialStats: mixed 1d and 4h trials pool on annual Sharpes, then convert to the judged period', () => {
  const mixed = [{ sharpe: 1, periodsPerYear: 365 }, { sharpe: 3, periodsPerYear: 2190 }];
  const annualVar = stdev([1, 3]) ** 2;
  assert.ok(Math.abs(trialStats(mixed, 365).trialSRVariance - annualVar / 365) < 1e-12);
  assert.ok(Math.abs(trialStats(mixed, 2190).trialSRVariance - annualVar / 2190) < 1e-12);
});

test('trialStats: converts annual Sharpes to per-period, counts failed trials', () => {
  const s = trialStats([{ sharpe: 1, periodsPerYear: 365 }, { sharpe: 3, periodsPerYear: 365 }, { sharpe: null }]);
  assert.strictEqual(s.trialCount, 3);
  assert.strictEqual(s.valid, 2);
  near(s.trialSRVariance, 2 / 365); // sample variance of 1,3 is 2; per-period divides by 365
});

test('bootstrapCI: same seed same answer, different seed differs', () => {
  const rand = seededRandom(1);
  const r = Array.from({ length: 300 }, () => (rand() - 0.48) * 0.02);
  const a = bootstrapCI(r, mean, { n: 300, seed: 7 }), b = bootstrapCI(r, mean, { n: 300, seed: 7 }), c = bootstrapCI(r, mean, { n: 300, seed: 8 });
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.lo, c.lo);
  assert.ok(a.lo < a.point && a.point < a.hi);
});

test('bootstrapCI: a constant series has a zero-width interval', () => {
  const ci = bootstrapCI(new Array(50).fill(0.01), mean, { n: 100, seed: 1 });
  near(ci.lo, 0.01, 1e-12);
  near(ci.hi, 0.01, 1e-12);
});

test('bootstrapCI: 90% interval of the mean covers about 90% on iid noise', () => {
  const rand = seededRandom(11);
  let covered = 0;
  const reps = 200;
  for (let i = 0; i < reps; i++) {
    const r = Array.from({ length: 250 }, () => normInv(rand() * 0.9998 + 0.0001));
    const ci = bootstrapCI(r, mean, { n: 300, blockLen: 1, seed: i + 1 });
    if (ci.lo <= 0 && 0 <= ci.hi) covered++;
  }
  assert.ok(covered / reps > 0.83 && covered / reps < 0.96, `coverage ${covered / reps}`);
});

test('bootstrapCI: blocks widen the interval on autocorrelated data, iid resampling understates it', () => {
  const rand = seededRandom(3);
  const r = [0];
  for (let i = 1; i < 1000; i++) r.push(0.9 * r[i - 1] + (rand() - 0.5) * 0.01);
  const iid = bootstrapCI(r, mean, { n: 400, blockLen: 1, seed: 1 });
  const blocked = bootstrapCI(r, mean, { n: 400, blockLen: 50, seed: 1 });
  assert.ok(blocked.hi - blocked.lo > 2 * (iid.hi - iid.lo));
});

test('inferPeriodsPerYear: 1d is 365, 4h is 2190', () => {
  const curve = (ms) => Array.from({ length: 10 }, (_, i) => ({ t: i * ms, equity: 1 }));
  assert.strictEqual(inferPeriodsPerYear(curve(86400000)), 365);
  assert.strictEqual(inferPeriodsPerYear(curve(14400000)), 2190);
});

test('summarize: profit shares are of the NET total; partials are not closed trades', () => {
  const day = 86400000, y = (Y, d) => Date.UTC(Y, 0, 1) + d * day;
  const curve = [{ t: y(2021, 0), equity: 100 }, { t: y(2021, 1), equity: 160 }, { t: y(2022, 0), equity: 120 }, { t: y(2022, 1), equity: 140 }];
  const trades = [
    { symbol: 'A', pnl: 30, positionPnl: 30, rMultiple: 1 , partial: true },
    { symbol: 'A', pnl: 30, positionPnl: 60, rMultiple: 2 },
    { symbol: 'B', pnl: -20, positionPnl: -20, rMultiple: -1 },
  ];
  const s = summarize(curve, trades, { periodsPerYear: 365 });
  near(s.profit, 40);
  assert.strictEqual(s.closedTrades, 2);
  near(s.winRate, 0.5);
  near(s.profitFactor, 3);
  near(s.avgR, 0.5);
  assert.strictEqual(s.topCoin, 'A');
  near(s.topCoinShare, 60 / 40); // above 100%: losers elsewhere make the winner matter more
  assert.strictEqual(s.topYear, '2021');
  near(s.topYearShare, 60 / 40);
  near(s.byYear[2022], -20);
});

test('summarize: no profit means no share to report', () => {
  const s = summarize([{ t: 0, equity: 100 }, { t: 86400000, equity: 90 }], [{ symbol: 'A', pnl: -10 }]);
  assert.strictEqual(s.topCoinShare, null);
  assert.strictEqual(s.topYearShare, null);
});

console.log(`\nv6Stats: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
