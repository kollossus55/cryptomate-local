// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
/**
 * V6 statistics: performance ratios, seeded bootstrap, PSR and Deflated Sharpe.
 *
 * Pure, no I/O. Units matter here, so to be explicit:
 *  - `returns` are simple per-period returns (0.01 = +1%).
 *  - sharpe/sortino/calmar take periodsPerYear and return ANNUALISED ratios.
 *    Crypto trades every day, so daily data uses 365 and 4h data uses 2190.
 *  - psr/deflatedSharpe work in PER-PERIOD Sharpe units, as in the papers.
 *    `benchmarkSR` and `trialSRVariance` must be per-period too: divide an
 *    annual Sharpe by sqrt(periodsPerYear), an annual variance by periodsPerYear.
 *    trialStats() does this conversion from logged annual Sharpes.
 *  - maxDrawdown returns a positive fraction (0.30 = a 30% peak-to-trough fall).
 *
 * References: Bailey & Lopez de Prado, "The Sharpe Ratio Efficient Frontier"
 * (2012) for PSR, "The Deflated Sharpe Ratio" (2014) for DSR; Politis & Romano
 * (1994) for the stationary bootstrap.
 */

export const EULER_GAMMA = 0.5772156649015329;
export const DAY_MS = 86400000;

// ---------- basic moments ----------

export function mean(xs) {
  const n = xs.length;
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += xs[i];
  return s / n;
}

/** Sample standard deviation (n-1). */
export function stdev(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) { const d = xs[i] - m; s += d * d; }
  return Math.sqrt(s / (n - 1));
}

/** Population skewness and (non-excess) kurtosis: a normal gives { skew: 0, kurt: 3 }. */
export function moments(xs) {
  const n = xs.length;
  const m = mean(xs);
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m, d2 = d * d;
    m2 += d2; m3 += d2 * d; m4 += d2 * d2;
  }
  m2 /= n; m3 /= n; m4 /= n;
  if (!(m2 > 0)) return { skew: 0, kurt: 3 };
  return { skew: m3 / m2 ** 1.5, kurt: m4 / (m2 * m2) };
}

// ---------- ratios ----------

/** Annualised Sharpe with a zero risk-free rate. Zero variance returns 0, never Infinity. */
export function sharpe(returns, periodsPerYear = 365) {
  const sd = stdev(returns);
  if (!(sd > 0)) return 0;
  return (mean(returns) / sd) * Math.sqrt(periodsPerYear);
}

/** Annualised Sortino: downside deviation is taken against 0 over ALL periods. */
export function sortino(returns, periodsPerYear = 365) {
  const n = returns.length;
  if (n < 2) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) if (returns[i] < 0) s += returns[i] * returns[i];
  const dd = Math.sqrt(s / n);
  if (!(dd > 0)) return 0;
  return (mean(returns) / dd) * Math.sqrt(periodsPerYear);
}

/** Accepts numbers or { equity } points. */
function equityValues(equity) {
  if (!equity.length) return [];
  if (typeof equity[0] === 'number') return equity;
  return equity.map((p) => p.equity);
}

/** Largest peak-to-trough fall, as a positive fraction. */
export function maxDrawdown(equity) {
  const v = equityValues(equity);
  let peak = -Infinity, dd = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] > peak) peak = v[i];
    else if (peak > 0) { const d = 1 - v[i] / peak; if (d > dd) dd = d; }
  }
  return dd;
}

/** Compound annual growth rate of an equity series sampled every period. */
export function cagr(equity, periodsPerYear = 365) {
  const v = equityValues(equity);
  if (v.length < 2 || !(v[0] > 0)) return 0;
  const end = v[v.length - 1];
  if (!(end > 0)) return -1;
  return (end / v[0]) ** (periodsPerYear / (v.length - 1)) - 1;
}

/** CAGR / max drawdown. No drawdown returns 0 rather than Infinity so it can never win a comparison by accident. */
export function calmar(equity, periodsPerYear = 365) {
  const dd = maxDrawdown(equity);
  if (!(dd > 0)) return 0;
  return cagr(equity, periodsPerYear) / dd;
}

export function returnsFromEquity(equity) {
  const v = equityValues(equity);
  const out = new Array(Math.max(0, v.length - 1));
  for (let i = 1; i < v.length; i++) out[i - 1] = v[i - 1] > 0 ? v[i] / v[i - 1] - 1 : 0;
  return out;
}

// ---------- normal distribution ----------

/** Standard normal CDF. West (2005) double-precision form of Hart's algorithm. */
export function normCdf(x) {
  const a = Math.abs(x);
  let c = 0;
  if (a <= 37) {
    const e = Math.exp(-a * a / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-02 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-02 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Inverse normal CDF: Acklam's rational approximation plus one Halley step against normCdf. */
export function normInv(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425;
  let x;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5, r = q * q;
    x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

// ---------- bootstrap ----------

/** mulberry32: small, fast, seedable. Same seed gives the same stream on every platform. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileSorted(sorted, q) {
  const h = (sorted.length - 1) * q;
  const i = Math.floor(h), f = h - i;
  return i + 1 < sorted.length ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/**
 * Bootstrap confidence interval that respects autocorrelation by resampling blocks.
 * method 'stationary' (default) draws geometric block lengths with mean blockLen and
 * wraps the series; 'block' uses fixed-length circular blocks.
 * alpha 0.10 gives a two-sided 90% interval, the one criterion D1 asks for.
 * @returns {{ lo, hi, point, se, n, blockLen, alpha, seed }}
 */
export function bootstrapCI(returns, statFn, { n = 2000, blockLen = 20, alpha = 0.10, seed = 1, method = 'stationary' } = {}) {
  const N = returns.length;
  const point = statFn(returns);
  if (N < 2) return { lo: NaN, hi: NaN, point, se: NaN, n: 0, blockLen, alpha, seed };
  const rand = seededRandom(seed);
  const p = 1 / Math.max(1, blockLen);
  const sample = new Float64Array(N);
  const stats = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let i = 0;
    if (method === 'stationary') {
      let idx = Math.floor(rand() * N);
      for (;;) {
        sample[i++] = returns[idx];
        if (i >= N) break;
        idx = rand() < p ? Math.floor(rand() * N) : (idx + 1 === N ? 0 : idx + 1);
      }
    } else {
      while (i < N) {
        let idx = Math.floor(rand() * N);
        for (let k = 0; k < blockLen && i < N; k++) {
          sample[i++] = returns[idx];
          idx = idx + 1 === N ? 0 : idx + 1;
        }
      }
    }
    stats[b] = statFn(sample);
  }
  const sorted = Float64Array.from(stats).sort();
  return {
    lo: quantileSorted(sorted, alpha / 2),
    hi: quantileSorted(sorted, 1 - alpha / 2),
    point, se: stdev(stats), n, blockLen, alpha, seed,
  };
}

// ---------- PSR / DSR ----------

/**
 * Probabilistic Sharpe Ratio: the probability that the true per-period Sharpe
 * exceeds benchmarkSR, allowing for track length, skew and fat tails.
 *   PSR = Phi( (SR - SR*) sqrt(T-1) / sqrt(1 - g3 SR + (g4-1)/4 SR^2) )
 * benchmarkSR is PER-PERIOD (see the file header).
 */
export function psr(returns, benchmarkSR = 0) {
  const T = returns.length;
  if (T < 3) return 0;
  const sd = stdev(returns);
  if (!(sd > 0)) return 0;
  const sr = mean(returns) / sd;
  const { skew, kurt } = moments(returns);
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(denom > 0)) return 0;
  return normCdf((sr - benchmarkSR) * Math.sqrt(T - 1) / Math.sqrt(denom));
}

/**
 * Expected maximum Sharpe across `trialCount` unskilled trials with the given
 * variance of per-period Sharpes. This is the bar DSR measures against.
 *   SR0 = sqrt(V) ( (1-g) Z^-1(1 - 1/N) + g Z^-1(1 - 1/(N e)) )
 */
export function expectedMaxSharpe(trialCount, trialSRVariance) {
  if (!(trialCount > 1) || !(trialSRVariance > 0)) return 0;
  const N = trialCount;
  return Math.sqrt(trialSRVariance) * (
    (1 - EULER_GAMMA) * normInv(1 - 1 / N) + EULER_GAMMA * normInv(1 - 1 / (N * Math.E))
  );
}

/**
 * Deflated Sharpe: PSR against the expected best-of-N-by-luck Sharpe.
 * trialCount is the GLOBAL trial count over all agents. trialSRVariance is PER-PERIOD.
 * With one trial or no variance there is nothing to deflate, so this equals psr(returns, 0).
 * @returns {number} probability in 0..1
 */
export function deflatedSharpe(returns, trialCount, trialSRVariance) {
  return psr(returns, expectedMaxSharpe(trialCount, trialSRVariance));
}

/**
 * Global trial statistics from logged trials.
 * @param {{ sharpe: number, periodsPerYear?: number }[]} trials annual Sharpes as logged
 * @returns {{ trialCount, trialSRVariance, annualSharpeMean, annualSharpeStdev, valid }}
 * trialCount counts every line, including failures with no usable Sharpe. The
 * variance only uses finite Sharpes. LOCAL FIX: spread is taken on ANNUAL Sharpes, the
 * one unit all timeframes share, then converted once to the period of the run being
 * judged. Pooling per-period values mixed 1d and 4h units and misjudged both.
 */
export function trialStats(trials, defaultPeriodsPerYear = 365) {
  const ann = [];
  for (const tr of trials) if (Number.isFinite(tr?.sharpe)) ann.push(tr.sharpe);
  const sd = stdev(ann) / Math.sqrt(defaultPeriodsPerYear);
  return {
    trialCount: trials.length,
    trialSRVariance: Number.isFinite(sd) ? sd * sd : 0,
    annualSharpeMean: mean(ann),
    annualSharpeStdev: stdev(ann),
    valid: ann.length,
  };
}

// ---------- summary ----------

/** Periods per year from the median spacing of t, so 1d gives 365 and 4h gives 2190. */
export function inferPeriodsPerYear(equityCurve, fallback = 365) {
  if (!equityCurve || equityCurve.length < 3 || typeof equityCurve[0] === 'number') return fallback;
  const n = Math.min(equityCurve.length - 1, 64);
  const gaps = [];
  for (let i = 1; i <= n; i++) gaps.push(equityCurve[i].t - equityCurve[i - 1].t);
  gaps.sort((a, b) => a - b);
  const g = gaps[gaps.length >> 1];
  return g > 0 ? Math.round((365 * DAY_MS) / g) : fallback;
}

/** Sum of the given key by a grouping function, plus the biggest group's share of the net total. */
function shareOfTotal(groups, total) {
  let top = null, topVal = -Infinity;
  for (const [k, v] of Object.entries(groups)) if (v > topVal) { top = k; topVal = v; }
  return { top, share: total > 0 && top !== null ? topVal / total : null };
}

/**
 * One-stop summary of an equity curve ([{ t, equity }] or numbers) and closed trades.
 * Shares for criterion D7 are of NET total profit, so big losers elsewhere push
 * the share up, and they are null when there is no profit to share.
 * A trade record with partial:true is a piece of a position, so it adds to
 * pnl and to per-coin profit but not to the closed-trade count.
 */
export function summarize(equityCurve, trades = [], { periodsPerYear } = {}) {
  const ppy = periodsPerYear || inferPeriodsPerYear(equityCurve);
  const v = equityValues(equityCurve);
  const rets = returnsFromEquity(v);
  const first = v[0] ?? 0, last = v[v.length - 1] ?? 0;
  const profit = last - first;

  const closed = trades.filter((tr) => !tr.partial);
  let gross = 0, loss = 0, wins = 0, rSum = 0, rN = 0, held = 0;
  const bySymbol = {};
  for (const tr of trades) bySymbol[tr.symbol] = (bySymbol[tr.symbol] || 0) + tr.pnl;
  for (const tr of closed) {
    const p = tr.positionPnl ?? tr.pnl;
    if (p > 0) { gross += p; wins++; } else loss -= p;
    if (Number.isFinite(tr.rMultiple)) { rSum += tr.rMultiple; rN++; }
    held += tr.barsHeld || 0;
  }

  const byYear = {}, logByYear = {};
  if (equityCurve.length && typeof equityCurve[0] === 'object') {
    for (let i = 1; i < equityCurve.length; i++) {
      const y = new Date(equityCurve[i].t).getUTCFullYear();
      byYear[y] = (byYear[y] || 0) + (v[i] - v[i - 1]);
      if (v[i] > 0 && v[i - 1] > 0) logByYear[y] = (logByYear[y] || 0) + Math.log(v[i] / v[i - 1]);
    }
  }
  const coin = shareOfTotal(bySymbol, profit);
  const year = shareOfTotal(byYear, profit);

  return {
    periodsPerYear: ppy,
    periods: rets.length,
    startEquity: first,
    endEquity: last,
    profit,
    totalReturn: first > 0 ? last / first - 1 : 0,
    cagr: cagr(v, ppy),
    volatility: rets.length > 1 ? stdev(rets) * Math.sqrt(ppy) : 0,
    sharpe: sharpe(rets, ppy),
    sortino: sortino(rets, ppy),
    maxDrawdown: maxDrawdown(v),
    calmar: calmar(v, ppy),
    closedTrades: closed.length,
    winRate: closed.length ? wins / closed.length : 0,
    profitFactor: loss > 0 ? gross / loss : (gross > 0 ? Infinity : 0),
    avgR: rN ? rSum / rN : null,
    avgBarsHeld: closed.length ? held / closed.length : 0,
    bySymbol,
    byYear,
    logReturnByYear: logByYear,
    topCoin: coin.top,
    topCoinShare: coin.share,
    topYear: year.top,
    topYearShare: year.share,
  };
}
