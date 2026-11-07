// Breakout research (agent r-breakout). Pre-registration: docs/rebuild/research-r-breakout.md
//   node scripts/v6/research/r-breakout.mjs run W1 [W2 ...]     walk-forward, audit, criteria, diagnostics
//   node scripts/v6/research/r-breakout.mjs reserve             declared ablations and random-entry control
// DEV bars through loadBars only. Importing this file runs nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { auditLookahead, checkDevCriteria, gridCombos, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-breakout';
const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmpDir = join(here, '../../../data/tmp', AGENT);
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);

const BARS_PER_DAY = { '1d': 1, '4h': 6 };
const PPY = { '1d': 365, '4h': 2190 };
const STOP_ATR = { trend: 3, swing: 2 };
const MAX_STOP = 0.25;
const UNIVERSE_N = 30;

/** BTC above its 200-DAY average. ctx.regime is a 200-BAR average, so it is 33 days on 4h. */
function riskOn(ctx, tf) {
  const btc = ctx.bars.get('BTCUSDT');
  if (!btc?.length) return false;
  const avg = ctx.ind('BTCUSDT', 'sma', 200 * BARS_PER_DAY[tf]);
  return Number.isFinite(avg) && btc[btc.length - 1].c > avg;
}

/** The filter on top of the fresh breakout. Reads bars before the breakout bar (lag 1). */
const FILTERS = {
  donchian: () => true,
  squeeze(ctx, symbol, p, tf) {
    const k = tf === '4h' ? 2 : 1;
    const short = ctx.ind(symbol, 'realisedVol', [10 * k, PPY[tf]], 1);
    const long = ctx.ind(symbol, 'realisedVol', [100 * k, PPY[tf]], 1);
    return long > 0 && short / long < p.squeeze;
  },
  volume(ctx, symbol, p) {
    const bars = ctx.bars.get(symbol);
    const avg = ctx.ind(symbol, 'sma', [20, 'qv'], 1);
    return avg > 0 && bars[bars.length - 1].qv / avg >= p.volMult;
  },
};

/**
 * @param {'donchian'|'squeeze'|'volume'} family
 * @param {'1d'|'4h'} timeframe
 * @returns {(params: object) => object} strategy factory.
 *   params: n, exit, topN, regime ('btc200'|'none'), squeeze | volMult
 */
export function breakoutFactory(family, timeframe) {
  const id = `brk_${family}_${timeframe}`;
  return (params) => defineStrategy({
    id, name: `Breakout ${family} ${timeframe}`, timeframe, params: { regime: 'btc200', topN: UNIVERSE_N, ...params },
    // Always 30: walkForward's fold switcher keeps the first strategy's universe, so a
    // topN in the universe field would be ignored after the first fold.
    universe: { kind: 'top', n: UNIVERSE_N }, warmupBars: Math.max(params.n + 2, 110 * (timeframe === '4h' ? 2 : 1)),
    signals(ctx) {
      const p = ctx.params;
      if (p.regime !== 'none' && !riskOn(ctx, timeframe)) return [];
      const out = [];
      for (const symbol of ctx.universe.slice(0, p.topN)) {
        const bars = ctx.bars.get(symbol);
        const close = bars[bars.length - 1].c;
        const level = ctx.ind(symbol, 'donchianHigh', p.n, 1);
        const prior = ctx.ind(symbol, 'donchianHigh', p.n, 2);
        if (!(close > level) || !(bars[bars.length - 2].c <= prior)) continue;
        if (!FILTERS[family](ctx, symbol, p, timeframe)) continue;
        const atr = ctx.ind(symbol, 'atr', 14);
        if (!(atr > 0)) continue;
        out.push({
          strategyId: id, symbol, side: 'long', exitProfile: p.exit,
          score: Math.min(1, (close - level) / atr / 3),
          stopDistancePct: Math.min(MAX_STOP, (STOP_ATR[p.exit] * atr) / close),
          reason: `Fresh ${p.n}-bar closing high (${family}), market risk-on`,
          meta: { level },
        });
      }
      return out;
    },
  });
}

/** One config for every trial, at HARD_CEILINGS. Pre-registered. */
export const RISK_AT_CEILINGS = Object.freeze({
  riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, volTargetAnnual: 0.20, maxClusterPct: 0.50,
  ladderHalfPct: 0.075, ladderQuarterPct: 0.125, ladderNoEntryPct: 0.175, ladderHaltPct: 0.20,
  dailyLossPct: 0.03, weeklyLossPct: 0.06,
});

const RUNS = {
  W1: { family: 'donchian', tf: '1d', grid: { n: [20, 50, 100], exit: ['trend', 'swing'], topN: [20, 30] } },
  W2: { family: 'donchian', tf: '4h', grid: { n: [50, 100, 200], exit: ['trend', 'swing'] }, fixed: { topN: 30 } },
  W3: { family: 'squeeze', tf: '1d', grid: { n: [20, 50], squeeze: [0.6, 0.8], exit: ['trend', 'swing'] }, fixed: { topN: 30 } },
  W4: { family: 'squeeze', tf: '4h', grid: { n: [50, 100], exit: ['trend', 'swing'] }, fixed: { topN: 30, squeeze: 0.7 } },
  W5: { family: 'volume', tf: '1d', grid: { n: [20, 50], volMult: [1.5, 2], exit: ['trend', 'swing'] }, fixed: { topN: 30 } },
  W6: { family: 'volume', tf: '4h', grid: { n: [50, 100], exit: ['trend', 'swing'] }, fixed: { topN: 30, volMult: 2 } },
};

/** At most 2, exact parameters. Empty means nothing qualified. */
export const FROZEN_CANDIDATES = Object.freeze([]);

// ---------- research harness below; nothing above reads a file ----------

const WF = { from: Date.UTC(2018, 2, 1), trainDays: 730, testDays: 180, minTrainTrades: 20 };
const day = (t) => new Date(t).toISOString().slice(0, 10);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Bars for the coins that were ever in the top 30, plus BTC. Strategies only read universe
 * coins and BTC, so the rest changes nothing except run time. Membership is point in time.
 */
function loadMarket(tf) {
  const ever = new Set(['BTCUSDT']);
  for (let t = Date.UTC(2018, 0, 1); t < Date.UTC(2025, 0, 1); t += 86400000) {
    for (const s of pointInTimeUniverse(t, { topN: UNIVERSE_N, timeframe: tf })) ever.add(s);
  }
  return prepareMarket(loadBars({ timeframe: tf, symbols: [...ever] }));
}

function setupFor(market, config = { risk: RISK_AT_CEILINGS }) {
  return { bars: market, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config };
}

function barIndex(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
  return list[lo]?.t === t ? lo : -1;
}

/** Signal-level study, before any sizing. Same signals(), positions never open. */
function eventStudy(strategy, market, from, to, tf) {
  const events = [], base = [];
  const recorder = defineStrategy({
    ...strategy,
    signals(ctx) {
      for (const s of strategy.signals({ ...ctx, params: strategy.params })) events.push({ t: ctx.barT, symbol: s.symbol, level: s.meta.level });
      if (strategy.params.regime === 'none' || riskOn(ctx, tf)) for (const symbol of ctx.universe.slice(0, strategy.params.topN)) base.push({ t: ctx.barT, symbol });
      return [];
    },
  });
  runSim({ ...setupFor(market), strategies: [recorder], from, to, collectEvents: false });
  const k = BARS_PER_DAY[tf];
  const horizons = [5, 10, 20];
  const fwd = ({ t, symbol }) => {
    const list = market.series.get(symbol).bars;
    const i = barIndex(list, t);
    if (i < 0 || !list[i + 1]) return null;
    const entry = list[i + 1].o;
    const c = costFor(symbol, tierFor(symbol, t + 1));
    const cost = 2 * (c.feePct + c.slipPct) / 100;
    return { i, list, r: horizons.map((h) => (list[i + h * k] ? list[i + h * k].c / entry - 1 - cost : null)) };
  };
  const monthOf = (t) => day(t).slice(0, 7);
  const sums = horizons.map(() => new Map());
  const add = (hi, month, slot, x) => {
    let m = sums[hi].get(month);
    if (!m) sums[hi].set(month, m = { e: 0, en: 0, b: 0, bn: 0 });
    m[slot] += x; m[`${slot}n`]++;
  };
  let falseN = 0, counted = 0;
  const evR = horizons.map(() => []);
  for (const e of events) {
    const f = fwd(e);
    if (!f) continue;
    counted++;
    let failed = false;
    for (let j = f.i + 1; j <= f.i + 5 * k && j < f.list.length; j++) if (f.list[j].c < e.level) { failed = true; break; }
    if (failed) falseN++;
    f.r.forEach((x, hi) => { if (x !== null) { evR[hi].push(x); add(hi, monthOf(e.t), 'e', x); } });
  }
  const baseMean = horizons.map(() => ({ s: 0, n: 0 }));
  for (const b of base) {
    const f = fwd(b);
    if (!f) continue;
    f.r.forEach((x, hi) => { if (x !== null) { baseMean[hi].s += x; baseMean[hi].n++; add(hi, monthOf(b.t), 'b', x); } });
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
  return {
    events: counted, falseRate: counted ? falseN / counted : null,
    horizons: horizons.map((h, hi) => {
      const ex = [...sums[hi].values()].filter((m) => m.en && m.bn).map((m) => m.e / m.en - m.b / m.bn);
      const mu = mean(ex);
      const sd = Math.sqrt(mean(ex.map((x) => (x - mu) ** 2)) * ex.length / Math.max(1, ex.length - 1));
      return {
        days: h, n: evR[hi].length, meanNet: mean(evR[hi]), medianNet: median(evR[hi]),
        baseNet: baseMean[hi].n ? baseMean[hi].s / baseMean[hi].n : null,
        monthlyExcess: mu, months: ex.length, tStat: sd > 0 ? mu / (sd / Math.sqrt(ex.length)) : null,
      };
    }),
  };
}

/** How much of the result rests on a few trades. Whole positions, partials folded in. */
function concentration(trades) {
  const closed = trades.filter((tr) => !tr.partial).map((tr) => ({ ...tr, p: tr.positionPnl ?? tr.pnl }));
  const sorted = [...closed].sort((a, b) => b.p - a.p);
  const net = closed.reduce((a, b) => a + b.p, 0);
  const gross = closed.filter((x) => x.p > 0).reduce((a, b) => a + b.p, 0);
  const top = (k) => sorted.slice(0, k).reduce((a, b) => a + b.p, 0);
  const tenth = Math.max(1, Math.round(closed.length / 10));
  const rs = closed.map((x) => x.rMultiple).filter(Number.isFinite).sort((a, b) => a - b);
  const reasons = {};
  for (const x of closed) {
    const r = reasons[x.reasonCode] ??= { n: 0, pnl: 0 };
    r.n++; r.pnl += x.p;
  }
  return {
    trades: closed.length, net, gross, top1: top(1), top5: top(5), top10: top(10),
    top10pctShareOfGross: gross > 0 ? top(tenth) / gross : null,
    netWithoutTop5: net - top(5), netWithoutTop10: net - top(10),
    medianR: rs[rs.length >> 1] ?? null, bestR: rs[rs.length - 1] ?? null, worstR: rs[0] ?? null,
    lostHalfR: rs.length ? rs.filter((r) => r <= -0.5).length / rs.length : null,
    best: sorted.slice(0, 5).map((x) => ({ symbol: x.symbol, entry: day(x.entryTime), pnl: Math.round(x.p), r: x.rMultiple, bars: x.barsHeld })),
    reasons,
  };
}

function logTrials(result, { strategyId, family, tf, fixed, note }) {
  mkdirSync(trialDir, { recursive: true });
  const logged = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
  for (const trial of result.trials) {
    const params = { ...fixed, ...trial.params };
    if (logged.has(`${strategyId}|${JSON.stringify(params)}`)) continue;
    appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family, strategyId, timeframe: tf, trial: { ...trial, params }, note, ts: new Date().toISOString() }))}\n`);
  }
}

function allTrials() {
  return readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').flatMap((f) => readLines(join(trialDir, f)));
}

function evaluate(name, run, market, { note, config } = {}) {
  const { family, tf, grid, fixed = {} } = run;
  const factory = (p) => breakoutFactory(family, tf)({ ...fixed, ...p });
  const setup = setupFor(market, config);
  const started = performance.now();
  const result = walkForward({ ...setup, ...WF, strategyFactory: factory, grid });
  console.log(`[${name}] walk-forward ${((performance.now() - started) / 1000).toFixed(0)}s, ${result.picks.length} folds, ${result.combos} combos`);
  logTrials(result, { strategyId: `brk_${family}_${tf}`, family: `breakout-${family}`, tf, fixed, note });

  const center = result.plateau?.params ?? gridCombos(grid)[0];
  const audit = auditLookahead({ ...setup, rebuild: () => factory(center), from: Date.UTC(2021, 0, 1), cuts: 3 });
  const verdict = checkDevCriteria(result, { trials: allTrials() });
  const { span } = result;
  const studies = gridCombos(grid).map((p) => ({ params: p, study: eventStudy(factory(p), market, span.from, span.to, tf) }));
  const fixedRun = runSim({ ...setup, strategies: [factory(center)], from: span.from, to: span.to });
  const s = result.summary, f = fixedRun.summary;
  const lastFill = result.oos.fills.at(-1);
  const trim = ({ bySymbol, ...rest }) => rest;
  const out = {
    name, family, tf, fixed, grid, note: note ?? null, span,
    picks: result.picks.map((p) => ({ test: day(p.testFrom), params: p.params, train: p.trainScore })),
    summary: trim(s), costs: result.oos.costs, audit: { ok: audit.ok, cuts: audit.cuts }, criteria: verdict.criteria, pass: verdict.pass, report: verdict.report,
    plateau: result.plateau, trials: result.trials, benchmark: result.benchmark ? trim(result.benchmark.summary) : null,
    stress2x: result.stress2x ? trim(result.stress2x.summary) : null, lastFill: lastFill ? day(lastFill.t) : null,
    concentration: concentration(result.oos.trades), studies,
    center, fixedRun: { summary: trim(f), costs: fixedRun.costs, concentration: concentration(fixedRun.trades), lastFill: fixedRun.fills.at(-1) ? day(fixedRun.fills.at(-1).t) : null },
  };
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, `${name}.json`), JSON.stringify(out, null, 1));
  console.log(`[${name}] audit ${audit.ok ? 'clean' : `FAILED ${JSON.stringify(audit.cuts.filter((c) => !c.ok))}`}`);
  console.log(`[${name}] OOS ${pct(s.totalReturn)}, Sharpe ${s.sharpe.toFixed(2)}, DD ${pct(s.maxDrawdown)}, ${s.closedTrades} trades, exposure ${pct(s.exposure)}, last fill ${out.lastFill}`);
  console.log(verdict.report);
  return out;
}

/** Stable pseudo-random number in [0, 1) from a symbol, a bar time and a seed. */
function hash01(symbol, t, seed) {
  let h = 2166136261 ^ seed;
  for (const ch of `${symbol}|${t}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Control: identical universe, regime, stop, exits and sizing, but the entry is a coin flip. */
function placeboStrategy({ rate, seed, exit, topN }) {
  const id = 'brk_placebo_1d';
  return defineStrategy({
    id, name: 'Breakout placebo 1d', timeframe: '1d', params: { rate, seed, exit, topN },
    universe: { kind: 'top', n: UNIVERSE_N }, warmupBars: 110,
    signals(ctx) {
      if (!riskOn(ctx, '1d')) return [];
      const out = [];
      for (const symbol of ctx.universe.slice(0, topN)) {
        if (hash01(symbol, ctx.barT, seed) >= rate) continue;
        const bars = ctx.bars.get(symbol);
        const close = bars[bars.length - 1].c;
        const atr = ctx.ind(symbol, 'atr', 14);
        if (!(atr > 0)) continue;
        out.push({
          strategyId: id, symbol, side: 'long', exitProfile: exit, score: hash01(symbol, ctx.barT, seed + 1),
          stopDistancePct: Math.min(MAX_STOP, (STOP_ATR[exit] * atr) / close), reason: 'Placebo entry', meta: {},
        });
      }
      return out;
    },
  });
}

/** Declared reserve runs: fixed parameters over the OOS span, each logged as a trial. */
function reserve() {
  const span = { from: Date.UTC(2020, 1, 29), to: Date.UTC(2024, 11, 31) };
  const d1 = loadMarket('1d');
  const results = [];
  const go = (label, strategy, market, family, tf, params, note, config) => {
    const run = runSim({ ...setupFor(market, config), strategies: [strategy], ...span, collectEvents: false });
    const s = run.summary;
    const trial = { params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn };
    logTrials({ trials: [trial] }, { strategyId: strategy.id, family, tf, fixed: {}, note });
    const { bySymbol, eventCounts, ...rest } = s;
    results.push({ label, params, summary: rest, costs: run.costs, concentration: concentration(run.trades) });
    console.log(`${label}: Sharpe ${s.sharpe.toFixed(2)}, return ${pct(s.totalReturn)}, DD ${pct(s.maxDrawdown)}, ${s.closedTrades} trades, exposure ${pct(s.exposure)}, by year ${Object.entries(s.byYear).map(([y, v]) => `${y} ${v.toFixed(0)}`).join(' ')}`);
  };
  const core = { n: 50, exit: 'swing', topN: 30 };
  go('A1 Donchian 1d, regime off', breakoutFactory('donchian', '1d')({ ...core, regime: 'none' }), d1, 'breakout-donchian', '1d', { ...core, regime: 'none' }, 'reserve: regime ablation');
  go('A3 Donchian 1d, default risk', breakoutFactory('donchian', '1d')(core), d1, 'breakout-donchian', '1d', { ...core, risk: 'default' }, 'reserve: default risk config', {});
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = { rate: 0.04, seed, exit: 'swing', topN: 30 };
    go(`P${seed} placebo`, placeboStrategy(p), d1, 'breakout-placebo', '1d', p, 'reserve: random-entry control');
  }
  const h4 = loadMarket('4h');
  const sq = { n: 100, exit: 'trend', topN: 30, squeeze: 0.7 };
  go('A2 Squeeze 4h, regime off', breakoutFactory('squeeze', '4h')({ ...sq, regime: 'none' }), h4, 'breakout-squeeze', '4h', { ...sq, regime: 'none' }, 'reserve: regime ablation');
  writeFileSync(join(tmpDir, 'reserve.json'), JSON.stringify(results, null, 1));
}

function main() {
  const [cmd, ...names] = process.argv.slice(2);
  if (cmd === 'reserve') return reserve();
  if (cmd !== 'run') throw new Error('usage: run W1 [W2 ...] | reserve');
  const markets = {};
  for (const name of names) {
    const run = RUNS[name];
    if (!run) throw new Error(`Unknown run ${name}`);
    markets[run.tf] ??= loadMarket(run.tf);
    evaluate(name, run, markets[run.tf]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
