// Long-only mean reversion inside uptrends. Hypothesis, grid and results:
// docs/rebuild/research-r-revert.md
//   node scripts/v6/research/r-revert.mjs E1          one experiment (E1..E6)
//   node scripts/v6/research/r-revert.mjs reserve E2  the six robustness trials on E2's pick
// DEV bars only. Importing this file runs nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { clampRiskConfig, DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-revert';
const FAMILY = 'mean-reversion-long';
const BTC = 'BTCUSDT';
const DAY = 86400000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRIAL_DIR = join(ROOT, 'data/research/v6');
const TMP = join(ROOT, 'data/tmp/r-revert');

const MIN_STOP = 0.01;
const MAX_STOP = 0.20;

/** Wilder RSI from a fixed tail of closes: cheap per step, and the same in sim and live. */
export function rsiTail(bars, n) {
  const start = bars.length - Math.max(60, 12 * n);
  if (start < 1) return NaN;
  let up = 0, down = 0;
  for (let i = start; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i < start + n) { up += g / n; down += l / n; } else { up = (up * (n - 1) + g) / n; down = (down * (n - 1) + l) / n; }
  }
  if (up + down === 0) return 50;
  return (100 * up) / (up + down);
}

const TRIGGERS = {
  rsi(ctx, symbol, bars, p) {
    const r = rsiTail(bars, p.rsiLen);
    return r < p.rsiMax ? { score: 1 - r / 100, why: `RSI(${p.rsiLen}) ${r.toFixed(0)} under ${p.rsiMax}` } : null;
  },
  dist(ctx, symbol, bars, p, atr) {
    const c = bars[bars.length - 1].c;
    const z = (ctx.ind(symbol, 'sma', p.maN) - c) / atr;
    return z > p.distAtr ? { score: Math.min(1, z / 5), why: `${z.toFixed(1)} ATR under its ${p.maN}-bar average` } : null;
  },
  capit(ctx, symbol, bars, p) {
    const b = bars[bars.length - 1], prev = bars[bars.length - 2];
    const drop = (prev.c - b.c) / ctx.ind(symbol, 'atr', 14, 1);
    const vol = b.qv / ctx.ind(symbol, 'sma', [p.volBars, 'qv'], 1);
    return drop >= p.dropAtr && vol >= p.volMult
      ? { score: Math.min(1, drop / 5), why: `fell ${drop.toFixed(1)} ATR on ${vol.toFixed(1)}x volume` } : null;
  },
};

/**
 * @param {{ mode: 'rsi'|'dist'|'capit', timeframe: '1d'|'4h', id: string, universe?: object }} spec
 * @returns {(params: object) => object} strategy factory
 */
export function revertFactory({ mode, timeframe, id, universe = { kind: 'top', n: 20 } }) {
  const defaults = {
    stopAtr: 2, exitMa: timeframe === '1d' ? 5 : 12, volBars: timeframe === '1d' ? 20 : 120, signalExit: true,
  };
  const trigger = TRIGGERS[mode];
  return (params) => defineStrategy({
    id, name: `Revert ${mode} ${timeframe}`, timeframe, universe, params: { ...defaults, ...params },
    warmupBars: timeframe === '1d' ? 241 : 1441,
    signals(ctx) {
      const p = ctx.params;
      const out = [];
      if (p.signalExit) {
        for (const symbol of ctx.positions.keys()) {
          const bars = ctx.bars.get(symbol);
          const c = bars?.[bars.length - 1]?.c;
          if (c > ctx.ind(symbol, 'sma', p.exitMa)) {
            out.push({ strategyId: id, symbol, side: 'flat', score: 0, exitProfile: 'revert', reason: `Back above its ${p.exitMa}-bar average`, meta: {} });
          }
        }
      }
      const btc = ctx.bars.get(BTC);
      if (!(btc?.length && btc[btc.length - 1].c > ctx.ind(BTC, 'sma', p.trendN))) return out;
      const slopeLag = p.trendN / 5;
      for (const symbol of ctx.universe) {
        if (ctx.positions.has(symbol)) continue;
        const bars = ctx.bars.get(symbol);
        const c = bars[bars.length - 1].c;
        const avg = ctx.ind(symbol, 'sma', p.trendN);
        if (!(c > avg && avg > ctx.ind(symbol, 'sma', p.trendN, slopeLag))) continue;
        const atr = ctx.ind(symbol, 'atr', 14);
        if (!(atr > 0)) continue;
        const stop = Math.max(MIN_STOP, (p.stopAtr * atr) / c);
        if (stop > MAX_STOP) continue;
        const hit = trigger(ctx, symbol, bars, p, atr);
        if (!hit) continue;
        out.push({
          strategyId: id, symbol, side: 'long', score: hit.score, stopDistancePct: stop, exitProfile: 'revert',
          reason: `Dip in an uptrend: ${hit.why}`, meta: { stop },
        });
      }
      return out;
    },
  });
}

/** Set after the runs. Empty means nothing qualified. */
export const FROZEN_CANDIDATES = [];

export const RISK = clampRiskConfig({
  ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, volTargetAnnual: 0.20,
});

export const EXPERIMENTS = {
  E1: { mode: 'rsi', timeframe: '1d', grid: { rsiLen: [2, 4], rsiMax: [10, 20], trendN: [100, 200] } },
  E2: { mode: 'dist', timeframe: '1d', grid: { maN: [5, 10], distAtr: [1, 2], trendN: [100, 200] } },
  E3: { mode: 'capit', timeframe: '1d', grid: { volMult: [2, 3], dropAtr: [1.5, 2.5], trendN: [100, 200] } },
  E4: { mode: 'rsi', timeframe: '4h', grid: { rsiLen: [4, 8], rsiMax: [15, 25], trendN: [600, 1200] } },
  E5: { mode: 'dist', timeframe: '4h', grid: { maN: [12, 30], distAtr: [1.5, 2.5], trendN: [600, 1200] } },
  E6: { mode: 'capit', timeframe: '4h', grid: { volMult: [2, 3], dropAtr: [1.5, 2.5], trendN: [600] } },
};

const WF = { from: Date.UTC(2018, 5, 1), trainDays: 730, testDays: 180, minTrainTrades: 20 };
const idOf = (name, e) => `revert-${e.mode}-${e.timeframe}-${name}`;

/** Every coin that was ever in the top N on some day. Each run still asks the universe point in time. */
function marketFor(timeframe, topN) {
  const names = new Set([BTC, 'ETHUSDT']);
  for (let t = Date.UTC(2018, 0, 1); t <= Date.UTC(2024, 11, 31); t += DAY) {
    for (const s of pointInTimeUniverse(t, { topN, timeframe })) names.add(s);
  }
  return prepareMarket(loadBars({ symbols: [...names], timeframe }));
}

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(TRIAL_DIR).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(TRIAL_DIR, f)));
const trialFile = join(TRIAL_DIR, `trials-${AGENT}.jsonl`);

function logTrial(strategyId, timeframe, trial, note) {
  const seen = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
  if (seen.has(`${strategyId}|${JSON.stringify(trial.params)}`)) return;
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe, trial, note, ts: new Date().toISOString() }))}\n`);
}

/** Worst-case view of a run. A mean-reversion win rate says nothing without this. */
export function tailReport(run) {
  const closed = run.trades.filter((tr) => !tr.partial);
  const rs = closed.map((tr) => tr.rMultiple).filter(Number.isFinite).sort((a, b) => a - b);
  const wins = closed.filter((tr) => tr.positionPnl > 0), losses = closed.filter((tr) => tr.positionPnl <= 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const eq = run.equity;
  const span = Math.round((7 * DAY) / (eq[1].t - eq[0].t));
  let worstBar = { r: 0 }, worst7 = 0, peak = -Infinity, peakT = 0, dd = { v: 0 };
  for (let i = 0; i < eq.length; i++) {
    if (i) {
      const r = eq[i].equity / eq[i - 1].equity - 1;
      if (r < worstBar.r) worstBar = { r, t: eq[i].t };
    }
    if (i >= span) worst7 = Math.min(worst7, eq[i].equity / eq[i - span].equity - 1);
    if (eq[i].equity > peak) { peak = eq[i].equity; peakT = eq[i].t; }
    const d = 1 - eq[i].equity / peak;
    if (d > dd.v) dd = { v: d, from: peakT, to: eq[i].t };
  }
  let streak = 0, maxStreak = 0;
  for (const tr of closed) { streak = tr.positionPnl > 0 ? 0 : streak + 1; maxStreak = Math.max(maxStreak, streak); }
  const byExit = {};
  for (const tr of closed) {
    const e = byExit[tr.reasonCode] ??= { n: 0, pnl: 0 };
    e.n++; e.pnl += tr.positionPnl;
  }
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  const worstFill = [...run.trades].sort((a, b) => a.exitPrice / a.entryPrice - b.exitPrice / b.entryPrice)[0];
  const worstR = closed.filter((tr) => Number.isFinite(tr.rMultiple)).sort((a, b) => a.rMultiple - b.rMultiple)[0];
  const sortedLoss = [...closed].sort((a, b) => a.positionPnl - b.positionPnl);
  return {
    trades: closed.length, winRate: run.summary.winRate, profitFactor: run.summary.profitFactor, avgR: run.summary.avgR,
    avgWinR: avg(wins.map((tr) => tr.rMultiple)), avgLossR: avg(losses.map((tr) => tr.rMultiple)),
    worstR: worstR ? { r: worstR.rMultiple, symbol: worstR.symbol, exit: day(worstR.exitTime), code: worstR.reasonCode } : null,
    p1R: rs[Math.floor(rs.length * 0.01)] ?? null, p5R: rs[Math.floor(rs.length * 0.05)] ?? null,
    worstPricePct: worstFill ? { pct: worstFill.exitPrice / worstFill.entryPrice - 1, symbol: worstFill.symbol, exit: day(worstFill.exitTime) } : null,
    worseThanMinus12R: closed.filter((tr) => tr.rMultiple < -1.2).length,
    worst10LossSum: sortedLoss.slice(0, 10).reduce((x, tr) => x + tr.positionPnl, 0),
    worstBarEquity: { pct: worstBar.r, day: day(worstBar.t) }, worst7Days: worst7,
    maxDrawdown: { pct: dd.v, from: day(dd.from), to: day(dd.to) }, maxLosingStreak: maxStreak, byExit,
    exposure: run.summary.exposure, avgBarsHeld: run.summary.avgBarsHeld, halted: run.summary.halted,
  };
}

const yearly = (s) => Object.fromEntries(Object.entries(s.logReturnByYear).map(([y, l]) => [y, Math.expm1(l)]));

function runExperiment(name) {
  const e = EXPERIMENTS[name];
  const id = idOf(name, e);
  const started = performance.now();
  const bars = marketFor(e.timeframe, 20);
  console.log(`${name}: ${bars.series.size} symbols loaded`);
  const setup = { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk: RISK } };
  const factory = revertFactory({ mode: e.mode, timeframe: e.timeframe, id });
  const result = walkForward({ ...setup, ...WF, strategyFactory: factory, grid: e.grid });
  for (const trial of result.trials) logTrial(id, e.timeframe, trial, name);
  const center = result.plateau?.params ?? null;
  const audit = auditLookahead({ ...setup, rebuild: () => factory(center ?? result.trials[0].params), from: Date.UTC(2023, 0, 1), cuts: 3 });
  const verdict = checkDevCriteria(result, { trials: allTrials() });
  const s = result.summary;
  const out = {
    name, id, seconds: (performance.now() - started) / 1000, audit: { ok: audit.ok, bad: audit.cuts.filter((c) => !c.ok) },
    picks: result.picks.map((p) => ({ from: new Date(p.testFrom).toISOString().slice(0, 10), params: p.params, train: p.trainScore })),
    center, verdict: { pass: verdict.pass, criteria: verdict.criteria, report: verdict.report },
    oos: {
      totalReturn: s.totalReturn, cagr: s.cagr, sharpe: s.sharpe, sortino: s.sortino, vol: s.volatility, maxDrawdown: s.maxDrawdown,
      calmar: s.calmar, closedTrades: s.closedTrades, yearly: yearly(s), topCoin: s.topCoin, topCoinShare: s.topCoinShare,
      topYear: s.topYear, topYearShare: s.topYearShare, eventCounts: s.eventCounts,
    },
    costs: result.oos.costs, tail: tailReport(result.oos), stress2x: result.stress2x.summary.totalReturn,
    benchmark: { sharpe: result.benchmark?.summary.sharpe, calmar: result.benchmark?.summary.calmar, maxDrawdown: result.benchmark?.summary.maxDrawdown, totalReturn: result.benchmark?.summary.totalReturn },
    trials: result.trials,
  };
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, `${name}.json`), JSON.stringify(out, null, 1));
  console.log(verdict.report);
  console.log(`audit ${audit.ok ? 'clean' : 'FAILED'}; ${out.seconds.toFixed(0)}s`);
}

function runReserve(name) {
  const e = EXPERIMENTS[name];
  const base = JSON.parse(readFileSync(join(TMP, `${name}.json`), 'utf8'));
  const from = WF.from + WF.trainDays * DAY;
  const variants = [
    ['stop15', { stopAtr: 1.5 }, {}, 20],
    ['stop3', { stopAtr: 3 }, {}, 20],
    ['majors', {}, { universe: { kind: 'fixed', symbols: [BTC, 'ETHUSDT'] } }, 20],
    ['top50', {}, { universe: { kind: 'top', n: 50 } }, 50],
    ['defaultRisk', {}, { risk: DEFAULT_RISK_CONFIG }, 20],
    ['noSignalExit', { signalExit: false }, {}, 20],
  ];
  const results = {};
  const markets = new Map();
  for (const [tag, extra, opt, topN] of variants) {
    if (!markets.has(topN)) markets.set(topN, marketFor(e.timeframe, topN));
    const id = `${idOf(name, e)}-${tag}`;
    const factory = revertFactory({ mode: e.mode, timeframe: e.timeframe, id, universe: opt.universe });
    const params = { ...base.center, ...extra };
    const run = runSim({
      strategies: [factory(params)], bars: markets.get(topN), from, costs: { tierFn: tierFor },
      universeFn: pointInTimeUniverse, config: { risk: opt.risk ?? RISK }, collectEvents: false,
    });
    const s = run.summary;
    logTrial(id, e.timeframe, {
      params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades,
      maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn,
    }, `reserve ${tag}`);
    results[tag] = { sharpe: s.sharpe, totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown, trades: s.closedTrades, yearly: yearly(s), tail: tailReport(run) };
    console.log(tag, s.sharpe.toFixed(2), (s.totalReturn * 100).toFixed(1), (s.maxDrawdown * 100).toFixed(1), s.closedTrades);
  }
  writeFileSync(join(TMP, `reserve-${name}.json`), JSON.stringify(results, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'reserve') runReserve(arg);
  else if (EXPERIMENTS[cmd]) runExperiment(cmd);
  else { console.error('usage: r-revert.mjs E1..E6 | reserve <E>'); process.exit(1); }
}
