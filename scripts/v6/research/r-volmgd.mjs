// Volatility-managed exposure to an equal-risk point-in-time basket. Research only, DEV data only.
//   node scripts/v6/research/r-volmgd.mjs wf <top20|top10|top20crash>
//   node scripts/v6/research/r-volmgd.mjs control <top20|top10>
//   node scripts/v6/research/r-volmgd.mjs side <top20|top10>
//   node scripts/v6/research/r-volmgd.mjs report
// Pre-registration and results: docs/rebuild/research-r-volmgd.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import { DEFAULT_RISK_CONFIG, clampRiskConfig } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { calmar, maxDrawdown, returnsFromEquity, sharpe } from '../../../shared/trading/v6Stats.js';
import { SIGNAL_ONLY_EXITS, defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-volmgd';
const FAMILY = 'vol-managed-basket';
const DAY = 86400e3;
const LR_DAYS = 365;
const COIN_VOL_DAYS = 30;
const MAX_STOP = 0.25;
const MIN_STOP = 0.02;
const BAND = 2;
const CRASH_DAYS = 30;
const CRASH_LOG_RET = -0.25;
const PIT_FLOOR_DAYS = 200;

export const VARIANTS = Object.freeze({
  top20: { n: 20, crash: false },
  top10: { n: 10, crash: false },
  top20crash: { n: 20, crash: true },
});

export const GRID = Object.freeze({ volN: [20, 60], sMin: [0, 0.5], stopK: [3, 5] });

/**
 * Equal-weight basket of today's universe over the last LR_DAYS days, from closed bars only.
 * Returns daily log returns in time order.
 */
function basketReturns(ctx) {
  const start = ctx.barT - (LR_DAYS - 1) * DAY;
  const sum = new Map();
  const cnt = new Map();
  for (const symbol of ctx.universe) {
    const bars = ctx.bars.get(symbol);
    if (!bars) continue;
    for (let i = Math.max(1, bars.length - LR_DAYS - 1); i < bars.length; i++) {
      const b = bars[i];
      const prev = bars[i - 1];
      if (b.t < start || b.t - prev.t !== DAY || !(b.c > 0) || !(prev.c > 0)) continue;
      sum.set(b.t, (sum.get(b.t) || 0) + Math.log(b.c / prev.c));
      cnt.set(b.t, (cnt.get(b.t) || 0) + 1);
    }
  }
  return [...sum.keys()].sort((a, b) => a - b).map((t) => sum.get(t) / cnt.get(t));
}

const annStd = (xs) => {
  if (xs.length < 10) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt((xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) * 365);
};

/**
 * @param {{ variant: string, control?: boolean }} spec control forces the scale to 1 (static equal-risk basket)
 * @returns {(params: object) => object} strategy factory
 */
export function volFactory({ variant, control = false }) {
  const v = VARIANTS[variant];
  const id = `r-volmgd-${variant}${control ? '-static' : ''}`;
  return (params) => {
    const merged = { volN: 60, sMin: 0, stopK: 3, ...params };
    const cache = new Map(); // per strategy instance, so a lookahead audit rebuild starts empty
    const state = (ctx) => {
      const key = `${ctx.barT}|${ctx.universe.join(',')}`;
      if (cache.has(key)) return cache.get(key);
      const r = basketReturns(ctx);
      const sigS = annStd(r.slice(-ctx.params.volN));
      const sigL = annStd(r);
      const s = control ? 1 : Math.min(1, (sigL / sigS) ** 2);
      const crash = v.crash && r.slice(-CRASH_DAYS).reduce((a, b) => a + b, 0) < CRASH_LOG_RET;
      const out = { s, sigS, sigL, crash };
      cache.set(key, out);
      return out;
    };
    return defineStrategy({
      id, name: `Vol-managed ${variant}${control ? ' (static control)' : ''}`, timeframe: '1d', params: merged,
      universe: { kind: 'top', n: v.n }, warmupBars: PIT_FLOOR_DAYS, slowAllocator: true, exitOverrides: SIGNAL_ONLY_EXITS,
      signals(ctx) {
        const p = ctx.params;
        const held = [...ctx.positions.values()].filter((x) => x.strategyId === id);
        const listed = new Set(ctx.universe);
        const base = { strategyId: id, exitProfile: 'trend', meta: {} };
        const out = [];
        const { s, sigS, sigL, crash } = ctx.universe.length ? state(ctx) : { s: NaN };
        const off = !(s > 0) || s < p.sMin || crash;
        const why = crash ? 'basket 30d crash filter' : `vol scale ${Number.isFinite(s) ? s.toFixed(2) : 'n/a'} below ${p.sMin}`;
        const stopFor = (symbol) => {
          const dailyVol = ctx.ind(symbol, 'realisedVol', [COIN_VOL_DAYS, 365]) / Math.sqrt(365);
          if (!(dailyVol > 0)) return NaN;
          return Math.min(MAX_STOP, Math.max(MIN_STOP, (p.stopK * dailyVol) / s));
        };
        for (const pos of held) {
          const flat = (reason) => out.push({ ...base, symbol: pos.symbol, side: 'flat', score: 0.5, reason });
          if (off) { flat(`${pos.symbol}: ${why}`); continue; }
          if (!listed.has(pos.symbol)) { flat(`${pos.symbol} left the top ${v.n}`); continue; }
          const dNow = stopFor(pos.symbol);
          const dEntry = 1 - pos.initialStopPrice / pos.entryPrice;
          if (dNow > 0 && dEntry > 0 && (dNow / dEntry > BAND || dEntry / dNow > BAND)) {
            flat(`${pos.symbol} rebalance: target stop ${(dNow * 100).toFixed(1)}% vs ${(dEntry * 100).toFixed(1)}% at entry`);
          }
        }
        if (off) return out;
        const heldSet = new Set(held.map((x) => x.symbol));
        ctx.universe.forEach((symbol, i) => {
          if (heldSet.has(symbol) || ctx.positions.has(symbol)) return;
          const d = stopFor(symbol);
          if (!(d > 0)) return;
          out.push({
            ...base, symbol, side: 'long', score: 1 - i / (ctx.universe.length + 1), stopDistancePct: d,
            reason: `Equal-risk basket, vol scale ${s.toFixed(2)} (basket vol ${(sigS * 100).toFixed(0)}% vs ${(sigL * 100).toFixed(0)}% long-run)`,
          });
        });
        return out;
      },
    });
  };
}

/** Holds the point-in-time list as it changes. A benchmark, not a candidate. */
function rollingHold(n) {
  const id = 'r-volmgd-rolling-hold';
  return defineStrategy({
    id, name: `Hold the top ${n}`, timeframe: '1d', universe: { kind: 'top', n }, exitOverrides: SIGNAL_ONLY_EXITS,
    signals(ctx) {
      const listed = new Set(ctx.universe);
      const base = { strategyId: id, score: 0.5, exitProfile: 'trend', reason: 'Rolling hold', meta: {} };
      return [
        ...ctx.universe.filter((s) => !ctx.positions.has(s)).map((symbol) => ({ ...base, symbol, side: 'long', stopDistancePct: 0.999 })),
        ...[...ctx.positions.keys()].filter((s) => !listed.has(s)).map((symbol) => ({ ...base, symbol, side: 'flat' })),
      ];
    },
  });
}

/** Set only for candidates that pass every DEV criterion. Empty is a valid outcome. */
export const FROZEN_CANDIDATES = Object.freeze([]);

// ---------- runner ----------

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmpDir = join(here, '../../../data/tmp/r-volmgd');
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const readLines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl')
  .flatMap((f) => readLines(join(trialDir, f)));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const OOS_FROM = Date.UTC(2020, 0, 1);
const WF = { from: Date.UTC(2018, 0, 1), trainDays: 730, testDays: 180 };

function setupFor(n) {
  return {
    bars: prepareMarket(loadBars({ timeframe: '1d' })), costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse,
    config: {
      risk: clampRiskConfig({
        ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.05 / n, maxOpenRiskPct: 0.05, maxPositionPct: 0.20,
        maxClusterPct: 0.50, volTargetAnnual: 0.20, maxGrossExposurePct: 1.0,
      }),
    },
  };
}

function logTrial(strategyId, trial, note) {
  mkdirSync(trialDir, { recursive: true });
  const seen = existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : [];
  if (seen.includes(`${strategyId}|${JSON.stringify(trial.params)}`)) return;
  if (seen.length >= 50) throw new Error('Trial budget of 50 reached');
  const line = trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() });
  appendFileSync(trialFile, `${JSON.stringify(line)}\n`);
}

const yearly = (s) => Object.fromEntries(Object.entries(s.logReturnByYear).map(([y, v]) => [y, Math.exp(v) - 1]));
const brief = (s) => ({
  sharpe: s.sharpe, calmar: s.calmar, totalReturn: s.totalReturn, cagr: s.cagr, maxDrawdown: s.maxDrawdown, exposure: s.exposure,
  closedTrades: s.closedTrades, positionChanges: s.positionChanges, volatility: s.volatility, topCoin: s.topCoin,
  topCoinShare: s.topCoinShare, topYear: s.topYear, topYearShare: s.topYearShare, simReEnables: s.simReEnables, years: yearly(s),
});

function runWalkForward(variant) {
  const setup = setupFor(VARIANTS[variant].n);
  const factory = volFactory({ variant });
  const id = factory({}).id;
  const started = performance.now();
  const result = walkForward({ ...setup, ...WF, strategyFactory: factory, grid: GRID });
  for (const trial of result.trials) logTrial(id, trial, `wf ${variant}`);
  const center = result.plateau?.params ?? result.trials[0].params;
  const audit = auditLookahead({ ...setup, rebuild: () => factory(center), from: Date.UTC(2023, 0, 1), cuts: 3 });
  const verdict = checkDevCriteria(result, { trials: allTrials() });
  const exits = {};
  for (const t of result.oos.trades) exits[t.reasonCode] = (exits[t.reasonCode] || 0) + 1;
  const out = {
    id, variant, audit: audit.ok, auditCuts: audit.cuts, pass: verdict.pass && audit.ok, criteria: verdict.criteria, report: verdict.report,
    picks: result.picks.map((p) => ({ test: new Date(p.testFrom).toISOString().slice(0, 10), params: p.params, trainScore: p.trainScore })),
    oos: brief(result.summary), costs: result.oos.costs, stress2x: brief(result.stress2x.summary), benchmark: brief(result.benchmark.summary),
    benchmarkSymbols: result.benchmark.symbols, plateau: result.plateau,
    trials: result.trials.map((t) => ({ params: t.params, sharpe: t.sharpe, maxDrawdown: t.maxDrawdown, totalReturn: t.totalReturn })),
    bySymbol: result.summary.bySymbol, exits,
  };
  writeFileSync(join(tmpDir, `wf-${variant}.json`), JSON.stringify(out, null, 1));
  console.log(`=== ${id}: ${((performance.now() - started) / 1000).toFixed(0)}s, audit ${audit.ok ? 'clean' : 'FAILED'}`);
  console.log(`picks ${out.picks.map((p) => JSON.stringify(p.params)).join(' ')}`);
  console.log(`OOS ret ${pct(out.oos.totalReturn)} Sh ${out.oos.sharpe.toFixed(2)} DD ${pct(out.oos.maxDrawdown)} exp ${pct(out.oos.exposure)} trades ${out.oos.closedTrades} chg ${out.oos.positionChanges}`);
  console.log(`exits ${JSON.stringify(exits)}`);
  console.log(`fixed ${out.trials.map((t) => `${JSON.stringify(t.params)} ${t.sharpe.toFixed(2)}`).join(' | ')}`);
  console.log(verdict.report);
}

function simBrief(setup, strategy, extra = {}) {
  const r = runSim({ ...setup, strategies: [strategy], from: OOS_FROM, collectEvents: false, ...extra });
  return { r, s: r.summary };
}

function runControl(variant) {
  const setup = setupFor(VARIANTS[variant].n);
  const strategy = volFactory({ variant, control: true })({ volN: 60, sMin: 0, stopK: 3 });
  const { r, s } = simBrief(setup, strategy);
  logTrial(strategy.id, {
    params: strategy.params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades,
    maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn, simReEnables: s.simReEnables, regimeExits: s.regimeExits,
  }, `static control ${variant}, fixed params, 2020-2024`);
  writeFileSync(join(tmpDir, `control-${variant}.json`), JSON.stringify({ oos: brief(s), costs: r.costs }, null, 1));
  console.log(`${strategy.id}: ret ${pct(s.totalReturn)} Sh ${s.sharpe.toFixed(2)} Calmar ${s.calmar.toFixed(2)} DD ${pct(s.maxDrawdown)} exp ${pct(s.exposure)} trades ${s.closedTrades}`);
}

/** Rolling hold of the same list, and that hold scaled to the strategy's average exposure. Not trials. */
function runSide(variant) {
  const n = VARIANTS[variant].n;
  const setup = setupFor(n);
  const { r, s } = simBrief(setup, rollingHold(n), { modules: { risk: fullWeightRisk({ weight: 1 / n }) } });
  console.log(`rolling hold top${n}: ret ${pct(s.totalReturn)} Sh ${s.sharpe.toFixed(2)} Calmar ${s.calmar.toFixed(2)} DD ${pct(s.maxDrawdown)}`);
  const rets = returnsFromEquity(r.equity);
  const file = join(tmpDir, `wf-${variant}.json`);
  if (!existsSync(file)) return;
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const curve = [1];
  for (const x of rets) curve.push(curve.at(-1) * (1 + x * run.oos.exposure));
  console.log(`hold at ${pct(run.oos.exposure)}: Sh ${sharpe(rets, 365).toFixed(2)} Calmar ${calmar(curve, 365).toFixed(2)} DD ${pct(maxDrawdown(curve))} ret ${pct(curve.at(-1) - 1)}`
    + ` | strategy Sh ${run.oos.sharpe.toFixed(2)} Calmar ${run.oos.calmar.toFixed(2)} DD ${pct(run.oos.maxDrawdown)} ret ${pct(run.oos.totalReturn)}`);
}

function runReport() {
  const trials = allTrials();
  console.log(`my trials ${trials.filter((t) => t.agent === AGENT).length}, global ${trials.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(tmpDir, { recursive: true });
  const [mode, variant] = process.argv.slice(2);
  if (mode === 'report') runReport();
  else if (!VARIANTS[variant]) throw new Error(`Unknown variant ${variant}`);
  else if (mode === 'wf') runWalkForward(variant);
  else if (mode === 'control') runControl(variant);
  else if (mode === 'side') runSide(variant);
  else throw new Error(`Unknown mode ${mode}`);
}
