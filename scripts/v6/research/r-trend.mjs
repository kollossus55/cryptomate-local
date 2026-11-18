// Time-series trend on large coins, long or cash. Research only, DEV data only.
//   node scripts/v6/research/r-trend.mjs wf <btc|btceth|top10>
//   node scripts/v6/research/r-trend.mjs side <btc|btceth|top10>
//   node scripts/v6/research/r-trend.mjs matched <btc|btceth|top10>
//   node scripts/v6/research/r-trend.mjs report
// Pre-registration and results: docs/rebuild/research-r-trend.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import { DEFAULT_RISK_CONFIG, clampRiskConfig } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { calmar, maxDrawdown, returnsFromEquity, sharpe } from '../../../shared/trading/v6Stats.js';
import { SIGNAL_ONLY_EXITS, buyAndHold, defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-trend';
const FAMILY = 'ts-trend';
const LOOKBACKS = [30, 90, 180, 365];
const MAX_STOP = 0.25;
const PIT_FLOOR_DAYS = 200;

export const UNIVERSES = Object.freeze({
  btc: { kind: 'fixed', symbols: ['BTCUSDT'] },
  btceth: { kind: 'fixed', symbols: ['BTCUSDT', 'ETHUSDT'] },
  top10: { kind: 'top', n: 10 },
});

// 4h keeps the daily rule: same horizons in days, and the profile's bar-counted exits rescaled.
const EXITS_4H = { trail: { atrMult: 10 }, spikeGuard: { atrMult: 15 }, timeStop: { bars: 240 } };

function trendState(ctx, symbol, p, perDay) {
  if (p.rule === 'sma') return { up: ctx.bars.get(symbol).at(-1).c > ctx.ind(symbol, 'sma', p.n * perDay), score: 0.5 };
  if (p.rule === 'tsmom') return { up: ctx.ind(symbol, 'roc', p.L * perDay) > 0, score: 0.5 };
  // NaN > 0 is false, so a lookback without enough history is a down vote.
  const votes = LOOKBACKS.filter((d) => ctx.ind(symbol, 'roc', d * perDay) > 0).length;
  return { up: votes >= p.k, score: votes / LOOKBACKS.length };
}

/**
 * @param {{ rule: 'sma'|'tsmom'|'blend', universe: string, timeframe?: string, exits?: string, suffix?: string }} spec
 * @returns {(params: object) => object} strategy factory
 */
export function trendFactory({ rule, universe, timeframe = '1d', exits = 'trend', suffix = '' }) {
  const perDay = timeframe === '4h' ? 6 : 1;
  const ppy = 365 * perDay;
  const id = `r-trend-${rule}-${universe}${suffix}`;
  const fixedUniverse = UNIVERSES[universe].kind === 'fixed';
  const exitOverrides = exits === 'signal' ? SIGNAL_ONLY_EXITS : perDay > 1 ? EXITS_4H : undefined;
  return (params) => {
    const merged = { rule, stopK: 4, ...params };
    return defineStrategy({
      id, name: `Trend ${rule} on ${universe}`, timeframe, params: merged, universe: UNIVERSES[universe],
      // Constant across the grid: walk-forward keeps the first pick's warmup for every fold.
      warmupBars: PIT_FLOOR_DAYS * perDay,
      slowAllocator: fixedUniverse,
      ...(exitOverrides ? { exitOverrides } : {}),
      signals(ctx) {
        const p = ctx.params;
        const held = [...ctx.positions.values()].filter((x) => x.strategyId === id).map((x) => x.symbol);
        const out = [];
        for (const symbol of new Set([...ctx.universe, ...held])) {
          const bars = ctx.bars.get(symbol);
          if (bars?.at(-1)?.t !== ctx.barT) continue;
          const { up, score } = trendState(ctx, symbol, p, perDay);
          const base = { strategyId: id, symbol, score, exitProfile: 'trend', meta: {} };
          if (!up) {
            out.push({ ...base, side: 'flat', reason: `${symbol} trend is not up` });
            continue;
          }
          if (!ctx.universe.includes(symbol)) continue; // held, left the list, trend intact: no opinion
          const dailyVol = ctx.ind(symbol, 'realisedVol', [30 * perDay, ppy]) / Math.sqrt(365);
          if (!(dailyVol > 0)) continue;
          out.push({
            ...base, side: 'long', stopDistancePct: Math.min(MAX_STOP, p.stopK * dailyVol),
            reason: `${symbol} trend is up (${rule})`,
          });
        }
        return out;
      },
    });
  };
}

/** Holds the point-in-time list as it changes. A benchmark, not a candidate. */
function rollingHold(n, timeframe = '1d') {
  const id = 'r-trend-rolling-hold';
  return defineStrategy({
    id, name: `Hold the top ${n}`, timeframe, universe: { kind: 'top', n }, exitOverrides: SIGNAL_ONLY_EXITS,
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
const tmpDir = join(here, '../../../data/tmp/r-trend');
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const readLines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(trialDir, f)));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const FROM = Date.UTC(2018, 0, 1);
const OOS_FROM = Date.UTC(2020, 0, 1);
const FULL_FROM = Date.UTC(2018, 6, 1);
const WF = { from: FROM, trainDays: 730, testDays: 180 };

function riskConfig(universe) {
  return clampRiskConfig({
    ...DEFAULT_RISK_CONFIG, riskPerTradePct: universe === 'top10' ? 0.005 : 0.01,
    maxOpenRiskPct: 0.05, maxPositionPct: 0.25, maxClusterPct: 0.50, volTargetAnnual: 0.20,
  });
}

function setupFor(universe, timeframe = '1d') {
  const u = UNIVERSES[universe];
  const raw = loadBars({ timeframe, ...(u.kind === 'fixed' ? { symbols: u.symbols } : {}) });
  return {
    bars: prepareMarket(raw), costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse,
    config: { risk: riskConfig(universe), ...(timeframe === '4h' ? { volBars: 180 } : {}) },
  };
}

function logTrial(strategyId, timeframe, trial, note) {
  mkdirSync(trialDir, { recursive: true });
  const seen = existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : [];
  if (seen.includes(`${strategyId}|${JSON.stringify(trial.params)}`)) return;
  const line = trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe, trial, note, ts: new Date().toISOString() });
  appendFileSync(trialFile, `${JSON.stringify(line)}\n`);
}

const yearly = (s) => Object.fromEntries(Object.entries(s.logReturnByYear).map(([y, v]) => [y, Math.exp(v) - 1]));
const brief = (s) => ({
  sharpe: s.sharpe, calmar: s.calmar, totalReturn: s.totalReturn, cagr: s.cagr, maxDrawdown: s.maxDrawdown, exposure: s.exposure,
  closedTrades: s.closedTrades, positionChanges: s.positionChanges, winRate: s.winRate, avgBarsHeld: s.avgBarsHeld,
  volatility: s.volatility, topCoin: s.topCoin, topCoinShare: s.topCoinShare, topYear: s.topYear, topYearShare: s.topYearShare,
  halted: s.halted, years: yearly(s),
});

function holdBenchmarks(universe, setup, from) {
  const u = UNIVERSES[universe];
  const sim = (strategy, weight) => brief(runSim({
    ...setup, strategies: [strategy], from, modules: { risk: fullWeightRisk({ weight }) }, collectEvents: false,
  }).summary);
  if (u.kind === 'fixed') return { hold: sim(buyAndHold({ symbols: u.symbols }), 1 / u.symbols.length) };
  return { rollingHold: sim(rollingHold(u.n), 1 / u.n) };
}

function runWalkForward(universe, setup, rule, grid) {
  const factory = trendFactory({ rule, universe });
  const id = factory({}).id;
  const started = performance.now();
  const result = walkForward({ ...setup, ...WF, strategyFactory: factory, grid });
  for (const trial of result.trials) logTrial(id, '1d', trial, `wf ${universe} ${rule}`);
  const center = result.plateau?.params ?? result.trials[0].params;
  const audit = auditLookahead({ ...setup, rebuild: () => factory(center), from: Date.UTC(2023, 0, 1), cuts: 3 });
  const verdict = checkDevCriteria(result, { trials: allTrials() });
  const exits = {};
  for (const t of result.oos.trades) exits[t.reasonCode] = (exits[t.reasonCode] || 0) + 1;
  const out = {
    id, universe, rule, grid, audit: audit.ok, auditCuts: audit.cuts, pass: verdict.pass && audit.ok, criteria: verdict.criteria, report: verdict.report,
    picks: result.picks.map((p) => ({ test: new Date(p.testFrom).toISOString().slice(0, 10), params: p.params, trainScore: p.trainScore })),
    oos: brief(result.summary), costs: result.oos.costs, stress2x: brief(result.stress2x.summary), benchmark: brief(result.benchmark.summary),
    benchmarkSymbols: result.benchmark.symbols, plateau: result.plateau, trials: result.trials,
    bySymbol: result.summary.bySymbol, events: result.summary.eventCounts, exits,
  };
  console.log(`\n=== ${id}: ${((performance.now() - started) / 1000).toFixed(0)}s, audit ${audit.ok ? 'clean' : 'FAILED'}`);
  console.log(`picks ${out.picks.map((p) => JSON.stringify(p.params)).join(' ')}`);
  console.log(`OOS return ${pct(out.oos.totalReturn)}, Sharpe ${out.oos.sharpe.toFixed(2)}, DD ${pct(out.oos.maxDrawdown)}, exposure ${pct(out.oos.exposure)}, trades ${out.oos.closedTrades}`);
  console.log(`exits ${JSON.stringify(exits)}`);
  console.log(`fixed ${result.trials.map((t) => `${JSON.stringify(t.params)} ${t.sharpe.toFixed(2)}`).join(' | ')}`);
  console.log(verdict.report);
  return out;
}

function runMain(universe) {
  const setup = setupFor(universe);
  const blendGrid = universe === 'top10' ? { k: [2, 3, 4], stopK: [3, 4, 6] } : { k: [2, 3, 4] };
  const runs = [
    runWalkForward(universe, setup, 'sma', { n: [50, 100, 200] }),
    runWalkForward(universe, setup, 'tsmom', { L: [30, 90, 180, 365] }),
    runWalkForward(universe, setup, 'blend', blendGrid),
  ];
  const holds = holdBenchmarks(universe, setup, OOS_FROM);
  console.log(`holds ${JSON.stringify(holds)}`);
  writeFileSync(join(tmpDir, `wf-${universe}.json`), JSON.stringify({ runs, holds }, null, 1));
}

function fixedRun(name, universe, setup, spec, simArgs, timeframe = '1d') {
  const strategy = trendFactory({ rule: 'blend', universe, timeframe, ...spec })({ k: 3, stopK: 4 });
  const { summary: s, costs } = runSim({ ...setup, strategies: [strategy], collectEvents: false, ...simArgs });
  logTrial(strategy.id, timeframe, {
    params: strategy.params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods,
    closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn,
  }, `diagnostic ${name} ${universe}`);
  console.log(`${universe} ${name}: return ${pct(s.totalReturn)}, Sharpe ${s.sharpe.toFixed(2)}, DD ${pct(s.maxDrawdown)}, exposure ${pct(s.exposure)}, trades ${s.closedTrades}`);
  return { name, ...brief(s), costs };
}

function runSide(universe) {
  const setup = setupFor(universe);
  const n = UNIVERSES[universe].symbols?.length ?? UNIVERSES[universe].n;
  const out = {
    signalExits: fixedRun('signal-exits', universe, setup, { exits: 'signal', suffix: '-sigexit' }, { from: OOS_FROM }),
    fullWeight: fixedRun('full-weight', universe, setup, { suffix: '-fullweight' }, { from: OOS_FROM, modules: { risk: fullWeightRisk({ weight: 1 / n }) } }),
    fullSpan: fixedRun('full-span', universe, setup, { suffix: '-fullspan' }, { from: FULL_FROM }),
    holdsFullSpan: holdBenchmarks(universe, setup, FULL_FROM),
  };
  console.log(`holds full span ${JSON.stringify(out.holdsFullSpan)}`);
  out.fourHour = fixedRun('4h', universe, setupFor(universe, '4h'), { suffix: '-4h' }, { from: OOS_FROM }, '4h');
  writeFileSync(join(tmpDir, `side-${universe}.json`), JSON.stringify(out, null, 1));
}

/** The hold scaled to a strategy's average exposure, rest in cash. Separates timing from simply holding less. */
function runMatched(universe) {
  const setup = setupFor(universe);
  const u = UNIVERSES[universe];
  const n = u.symbols?.length ?? u.n;
  const strategy = u.kind === 'fixed' ? buyAndHold({ symbols: u.symbols }) : rollingHold(u.n);
  const { equity } = runSim({ ...setup, strategies: [strategy], from: OOS_FROM, modules: { risk: fullWeightRisk({ weight: 1 / n }) }, collectEvents: false });
  const rets = returnsFromEquity(equity);
  const { runs } = JSON.parse(readFileSync(join(tmpDir, `wf-${universe}.json`), 'utf8'));
  for (const run of runs) {
    const curve = [1];
    for (const r of rets) curve.push(curve.at(-1) * (1 + r * run.oos.exposure));
    console.log(`${run.id}: strategy Sharpe ${run.oos.sharpe.toFixed(2)} Calmar ${run.oos.calmar.toFixed(2)} DD ${pct(run.oos.maxDrawdown)} return ${pct(run.oos.totalReturn)}`
      + ` | hold at ${pct(run.oos.exposure)}: Sharpe ${sharpe(rets, 365).toFixed(2)} Calmar ${calmar(curve, 365).toFixed(2)} DD ${pct(maxDrawdown(curve))} return ${pct(curve.at(-1) - 1)}`);
  }
}

function runReport() {
  const trials = allTrials();
  console.log(`my trials ${trials.filter((t) => t.agent === AGENT).length}, global ${trials.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(tmpDir, { recursive: true });
  const [mode, universe] = process.argv.slice(2);
  if (mode === 'report') runReport();
  else if (!UNIVERSES[universe]) throw new Error(`Unknown universe ${universe}`);
  else if (mode === 'wf') runMain(universe);
  else if (mode === 'side') runSide(universe);
  else if (mode === 'matched') runMatched(universe);
  else throw new Error(`Unknown mode ${mode}`);
}
