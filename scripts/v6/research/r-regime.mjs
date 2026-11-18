// Market regime research. A regime is a filter, not a strategy: see docs/rebuild/research-r-regime.md.
//   node scripts/v6/research/r-regime.mjs run <shard> <shards>   walk-forward jobs, resumable
//   node scripts/v6/research/r-regime.mjs finalize               trial log, diagnostics, report
// DEV bars only, through loadBars.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOLDOUT_START, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { createExitPlan, evaluateExit } from '../../../shared/trading/v6Exits.js';
import { clampRiskConfig, DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { maxDrawdown, sharpe } from '../../../shared/trading/v6Stats.js';
import { defineStrategy, SIGNAL_ONLY_EXITS } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-regime';
const FAMILY = 'market-regime';
const BTC = 'BTCUSDT';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRIAL_DIR = join(ROOT, 'data/research/v6');
const TMP = join(ROOT, 'data/tmp', AGENT);
const FROM = Date.UTC(2018, 8, 1);
const TRAIN_DAYS = 730;
const TEST_DAYS = 180;
const BREADTH_TOP_N = 50;
const BREADTH_MIN_COINS = 5;

// ---------- detectors: regime(ctx) -> 'risk_on' | 'neutral' | 'risk_off' | 'unknown' ----------

/** BTC close against its n-day SMA, with a neutral band either side. */
export function trendRegime({ n, band = 0.03 }) {
  return (ctx) => {
    const series = ctx.bars.get(BTC);
    const avg = ctx.ind(BTC, 'sma', n);
    if (!series?.length || !Number.isFinite(avg)) return 'unknown';
    const ratio = series[series.length - 1].c / avg;
    return ratio > 1 + band ? 'risk_on' : ratio < 1 - band ? 'risk_off' : 'neutral';
  };
}

/** Share of the universe closing above its own n-day SMA. ctx.regimeUniverse wins over ctx.universe. */
export function breadthRegime({ n, hi = 0.6, lo = 0.4 }) {
  return (ctx) => {
    let above = 0, seen = 0;
    for (const symbol of ctx.regimeUniverse ?? ctx.universe) {
      const series = ctx.bars.get(symbol);
      const avg = ctx.ind(symbol, 'sma', n);
      if (!series?.length || !Number.isFinite(avg)) continue;
      seen++;
      if (series[series.length - 1].c > avg) above++;
    }
    if (seen < BREADTH_MIN_COINS) return 'unknown';
    const share = above / seen;
    return share >= hi ? 'risk_on' : share < lo ? 'risk_off' : 'neutral';
  };
}

/** BTC 30d realised vol against its own 180d level. */
export function volRegime({ off }) {
  return (ctx) => {
    const ratio = ctx.ind(BTC, 'realisedVol', [30, 365]) / ctx.ind(BTC, 'realisedVol', [180, 365]);
    if (!Number.isFinite(ratio)) return 'unknown';
    return ratio >= off ? 'risk_off' : ratio < off / 1.25 ? 'risk_on' : 'neutral';
  };
}

/** BTC close below its 365-day high. */
export function drawdownRegime({ off }) {
  return (ctx) => {
    const series = ctx.bars.get(BTC);
    const high = ctx.ind(BTC, 'donchianHigh', 365);
    if (!series?.length || !Number.isFinite(high)) return 'unknown';
    const dd = 1 - series[series.length - 1].c / high;
    return dd >= off ? 'risk_off' : dd < 0.75 * off ? 'risk_on' : 'neutral';
  };
}

export const DETECTORS = {
  T: { name: 'BTC trend', build: trendRegime, grid: { n: [50, 100, 200] } },
  B: { name: 'Breadth', build: breadthRegime, grid: { n: [50, 100, 200] } },
  V: { name: 'Realised vol', build: volRegime, grid: { off: [1.25, 1.5, 2.0] } },
  D: { name: 'BTC drawdown', build: drawdownRegime, grid: { off: [0.2, 0.3, 0.5] } },
};

/** The point-in-time breadth universe. The last close of the run is the holdout's first instant. */
function regimeUniverse(ctx) {
  if (ctx.t >= HOLDOUT_START) return [];
  return pointInTimeUniverse(ctx.t, { topN: BREADTH_TOP_N }).filter((s) => {
    const b = ctx.bars.get(s);
    return b?.length && b[b.length - 1].t === ctx.barT;
  });
}

// ---------- reference entries ----------

const REFS = {
  hold: {
    universe: { kind: 'fixed', symbols: [BTC, 'ETHUSDT'] }, warmupBars: 1,
    exitsOff: SIGNAL_ONLY_EXITS,
    exitsEngine: { ...SIGNAL_ONLY_EXITS, regimeExit: { enabled: true, action: 'exit' } },
    signals: (ctx, id) => ctx.universe.map((symbol) => ({
      strategyId: id, symbol, side: 'long', score: 0.5, stopDistancePct: 0.2, exitProfile: 'trend', reason: 'Hold while allowed', meta: {},
    })),
  },
  mom: {
    universe: { kind: 'top', n: 20 }, warmupBars: 31,
    exitsOff: { regimeExit: { enabled: false } }, exitsEngine: undefined,
    signals(ctx, id) {
      const symbols = new Set(ctx.universe);
      for (const [symbol, p] of ctx.positions) if (p.strategyId === id) symbols.add(symbol);
      const out = [];
      for (const symbol of symbols) {
        const r = ctx.ind(symbol, 'roc', 30);
        if (!Number.isFinite(r)) continue;
        out.push({
          strategyId: id, symbol, side: r > 0 ? 'long' : 'flat', score: Math.max(0, Math.min(1, r)), stopDistancePct: 0.15,
          exitProfile: 'trend', reason: '30d momentum', meta: {},
        });
      }
      return out;
    },
  },
  dip: {
    universe: { kind: 'top', n: 20 }, warmupBars: 6,
    exitsOff: { regimeExit: { enabled: false } }, exitsEngine: undefined,
    signals(ctx, id) {
      const out = [];
      for (const symbol of ctx.universe) {
        const r = ctx.ind(symbol, 'roc', 5);
        if (r < -0.15) {
          out.push({
            strategyId: id, symbol, side: 'long', score: Math.min(1, -r), stopDistancePct: 0.1,
            exitProfile: 'revert', reason: '5d fall over 15%', meta: {},
          });
        }
      }
      return out;
    },
  },
};

/** What a label does to one strategy's signals. risk_off closes, as the exit engine would. */
export function applyRegime(signals, label, ctx, id) {
  if (label === 'risk_on') return signals;
  const kept = signals.filter((s) => s.side === 'flat');
  if (label !== 'risk_off') return kept;
  const flat = [];
  for (const [symbol, p] of ctx.positions) {
    if (p.strategyId !== id) continue;
    flat.push({ strategyId: id, symbol, side: 'flat', score: 0, stopDistancePct: 0.1, exitProfile: p.exitProfile, reason: 'Regime is risk_off', meta: {} });
  }
  return flat;
}

/** family: 'none' unfiltered, 'engine' default SMA200 regime exit left on, or a DETECTORS key. */
export function makeStrategy(refKey, family, params = {}) {
  const ref = REFS[refKey];
  const id = `rr-${refKey}-${family}`;
  const detector = DETECTORS[family]?.build(params);
  return defineStrategy({
    id, name: `${refKey} with ${family} regime`, timeframe: '1d', params, universe: ref.universe, warmupBars: ref.warmupBars,
    exitOverrides: family === 'engine' ? ref.exitsEngine : ref.exitsOff,
    signals(ctx) {
      const raw = ref.signals(ctx, id);
      if (!detector) return raw;
      return applyRegime(raw, detector(family === 'B' ? { ...ctx, regimeUniverse: regimeUniverse(ctx) } : ctx), ctx, id);
    },
  });
}

/** Empty: no detector met the freeze rule in docs/rebuild/research-r-regime.md. */
export const FROZEN_CANDIDATES = [];

// ---------- running ----------

const CONFIG = {
  risk: clampRiskConfig({
    ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, maxClusterPct: 0.5, volTargetAnnual: 0.2,
  }),
};
const setupFor = (bars) => ({ bars, config: CONFIG, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse });

const JOBS = Object.keys(REFS).flatMap((ref) => ['none', 'engine', ...Object.keys(DETECTORS)].map((family) => ({ ref, family })));
const jobFile = ({ ref, family }) => join(TMP, `job-${ref}-${family}.json`);

function yearly(equity) {
  const out = {};
  let prev = equity[0].equity;
  for (const e of equity) {
    const y = new Date(e.t).getUTCFullYear();
    out[y] = (out[y] ?? 1) * (e.equity / prev);
    prev = e.equity;
  }
  return Object.fromEntries(Object.entries(out).map(([y, v]) => [y, v - 1]));
}

function runJob(job, market) {
  const started = performance.now();
  const { ref, family } = job;
  const grid = DETECTORS[family]?.grid ?? {};
  const setup = setupFor(market);
  const factory = (params) => makeStrategy(ref, family, params);
  const r = walkForward({ ...setup, strategyFactory: factory, grid, from: FROM, trainDays: TRAIN_DAYS, testDays: TEST_DAYS });
  const params = r.plateau?.params ?? r.picks.find((p) => p.params)?.params ?? {};
  const audit = auditLookahead({ ...setup, rebuild: () => factory(params), from: Date.UTC(2023, 0, 1), cuts: 3 });
  const exits = {};
  for (const tr of r.oos.trades) if (!tr.partial) exits[tr.reasonCode] = (exits[tr.reasonCode] ?? 0) + 1;
  const { eventCounts, ...summary } = r.summary;
  const out = {
    ...job, params, picks: r.picks.map((p) => ({ testFrom: p.testFrom, params: p.params, trainScore: p.trainScore })),
    span: r.span, summary, eventCounts, exits, costs: r.oos.costs, yearly: yearly(r.oos.equity),
    equity: r.oos.equity.map((e) => ({ t: e.t, equity: e.equity, gross: e.gross })),
    stress2x: r.stress2x?.summary ?? null, benchmark: r.benchmark ? { summary: r.benchmark.summary, n: r.benchmark.symbols.length } : null,
    plateau: r.plateau, trials: r.trials, strategy: r.strategy, audit: { ok: audit.ok, cuts: audit.cuts.filter((c) => !c.ok) },
  };
  writeFileSync(jobFile(job), JSON.stringify(out));
  console.log(`${ref}/${family}: ${((performance.now() - started) / 1000).toFixed(0)}s  Sharpe ${r.summary.sharpe.toFixed(2)}  audit ${audit.ok ? 'clean' : 'FAILED'}`);
}

function runShard(shard, shards) {
  mkdirSync(TMP, { recursive: true });
  const todo = JOBS.filter((job, i) => i % shards === shard && !existsSync(jobFile(job)));
  console.log(`shard ${shard}/${shards}: ${todo.length} jobs`);
  if (!todo.length) return;
  const market = prepareMarket(loadBars({ timeframe: '1d' }));
  for (const job of todo) runJob(job, market);
}

// ---------- diagnostics ----------

/** Labels for every bar, from the same ctx the simulator hands a strategy. */
function labelSeries(family, params, market) {
  const detector = DETECTORS[family].build(params);
  const labels = new Map();
  const recorder = defineStrategy({
    id: 'rr-recorder', name: 'Label recorder', timeframe: '1d', universe: { kind: 'fixed', symbols: [BTC] },
    signals(ctx) {
      labels.set(ctx.barT, detector(family === 'B' ? { ...ctx, regimeUniverse: regimeUniverse(ctx) } : ctx));
      return [];
    },
  });
  runSim({ ...setupFor(market), strategies: [recorder], from: FROM, collectEvents: false });
  return labels;
}

/** held[i] = in the market after the close of day i. Neutral and unknown keep the last state. */
function inMarket(labels) {
  let state = 0;
  return labels.map((l) => {
    if (l === 'risk_on') state = 1;
    else if (l === 'risk_off') state = 0;
    return state;
  });
}

function flipStats(labels, years) {
  const spells = [];
  let changes = 0, toOff = 0, run = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === labels[i - 1]) { run++; continue; }
    changes++;
    if (labels[i] === 'risk_off') toOff++;
    spells.push(run);
    run = 1;
  }
  spells.push(run);
  const sorted = [...spells].sort((a, b) => a - b);
  const held = inMarket(labels);
  let toggles = 0;
  for (let i = 1; i < held.length; i++) if (held[i] !== held[i - 1]) toggles++;
  const share = (l) => labels.filter((x) => x === l).length / labels.length;
  return {
    changesPerYear: changes / years, toRiskOffPerYear: toOff / years, togglesPerYear: toggles / years,
    medianSpell: sorted[sorted.length >> 1], shortSpellShare: spells.filter((s) => s <= 5).length / spells.length,
    on: share('risk_on'), neutral: share('neutral'), off: share('risk_off'), unknown: share('unknown'),
  };
}

/** Runs labels through the real exit engine: open a long at each risk_on, count regime_exit. */
function engineRegimeExits(times, labels) {
  const DAY = 86400000;
  let position = null, fired = 0;
  const flags = new Set();
  const bar = { o: 100, h: 100, l: 100, c: 100, v: 1, qv: 1 };
  labels.forEach((label, i) => {
    const t = times[i];
    if (!position) {
      if (label !== 'risk_on') return;
      position = {
        symbol: BTC, strategyId: 'x', side: 'long', qty: 1, entryPrice: 100, entryTime: t, entryFees: 0, stopPrice: 50, initialStopPrice: 50,
        highWater: 100, lowWater: 100, partialsTaken: [], exitProfile: 'trend', barsHeld: 0, riskAtEntry: 50,
      };
      position.exitPlan = createExitPlan({
        position, profile: 'trend', atr: 2,
        config: { regime: label, overrides: { timeStop: { enabled: false }, trail: { enabled: false }, breakEven: { enabled: false } } },
      });
      return;
    }
    const r = evaluateExit({ position, bar: { ...bar, t }, atr: 2, regime: label, signal: null, t: t + DAY, config: {} });
    for (const f of r.flags ?? []) flags.add(f);
    if (r.reasonCode === 'regime_exit') { fired++; position = null; } else position = { ...position, ...r.update };
  });
  return { fired, flags: [...flags] };
}

/** A daily return stream held only while held[i-1], charged cost on each switch. */
function masked(rets, held, costPerSide) {
  const out = new Float64Array(rets.length);
  for (let i = 1; i < rets.length; i++) {
    out[i] = held[i - 1] ? rets[i] : 0;
    if (i >= 2 && held[i - 1] !== held[i - 2]) out[i] -= costPerSide;
  }
  return out;
}
const curve = (rets) => {
  let v = 1;
  return Array.from(rets, (r) => (v *= 1 + r));
};

function timing(rets, held, costPerSide) {
  const m = masked(rets, held, costPerSide);
  const s = sharpe(Array.from(m), 365);
  const n = rets.length;
  const base = sharpe(Array.from(rets), 365);
  const baseDd = maxDrawdown(curve(rets));
  const dd = maxDrawdown(curve(m));
  let upAll = 0, upMissed = 0, downAll = 0, downAvoided = 0, inDays = 0, forgone = 1;
  for (let i = 1; i < n; i++) {
    const r = rets[i];
    if (held[i - 1]) inDays++; else forgone *= 1 + r;
    if (r > 0) { upAll += r; if (!held[i - 1]) upMissed += r; } else { downAll -= r; if (!held[i - 1]) downAvoided -= r; }
  }
  // Every circular shift keeps time in market and flip count but destroys the timing.
  let beat = 0, ddBeat = 0, count = 0;
  for (let k = 30; k < n - 30; k++) {
    const shifted = new Array(n);
    for (let i = 0; i < n; i++) shifted[i] = held[(i + k) % n];
    const p = masked(rets, shifted, costPerSide);
    if (sharpe(Array.from(p), 365) >= s) beat++;
    if (maxDrawdown(curve(p)) <= dd) ddBeat++;
    count++;
  }
  const tim = inDays / (n - 1);
  return {
    timeInMarket: tim, baseSharpe: base, sharpe: s, baseDd, dd, constExposureDd: baseDd * tim, ddAvoided: baseDd - dd,
    upMissed: upMissed / upAll, downAvoided: downAvoided / downAll, returnForgone: forgone - 1,
    placeboP: (beat + 1) / (count + 1), placeboDdP: (ddBeat + 1) / (count + 1), placebos: count,
  };
}

/** Next-day return by today's label: does the label sort the future, or just the past? */
function byLabel(labels, rets) {
  const out = {};
  for (const label of ['risk_on', 'neutral', 'risk_off']) {
    const x = [];
    for (let i = 1; i < rets.length; i++) if (labels[i - 1] === label) x.push(rets[i]);
    if (x.length < 2) { out[label] = { days: x.length }; continue; }
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - 1));
    out[label] = { days: x.length, annualMean: mean * 365, annualVol: sd * Math.sqrt(365), sharpe: (mean / sd) * Math.sqrt(365), t: (mean / sd) * Math.sqrt(x.length) };
  }
  return out;
}

/** Equal-weight daily return of the point-in-time top 20, membership fixed at the prior close. */
function ewStream(times, market) {
  const closeAt = new Map();
  const closeOf = (symbol) => {
    let m = closeAt.get(symbol);
    if (!m) closeAt.set(symbol, m = new Map(market.series.get(symbol)?.bars.map((b) => [b.t, b.c]) ?? []));
    return m;
  };
  const rets = new Float64Array(times.length);
  for (let i = 1; i < times.length; i++) {
    // Decided at the close of day i-1, which is the open time of day i.
    const list = pointInTimeUniverse(times[i], { topN: 20 });
    let sum = 0, n = 0;
    for (const s of list) {
      const a = closeOf(s).get(times[i - 1]), b = closeOf(s).get(times[i]);
      if (a > 0 && b > 0) { sum += b / a - 1; n++; }
    }
    rets[i] = n ? sum / n : 0;
  }
  return rets;
}

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function finalize() {
  const jobs = JOBS.map((job) => {
    if (!existsSync(jobFile(job))) throw new Error(`Missing ${job.ref}/${job.family}: run the shards first`);
    return JSON.parse(readFileSync(jobFile(job), 'utf8'));
  });

  const trialFile = join(TRIAL_DIR, `trials-${AGENT}.jsonl`);
  const logged = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
  for (const job of jobs) {
    const strategyId = `rr-${job.ref}-${job.family}`;
    for (const trial of job.trials) {
      if (logged.has(`${strategyId}|${JSON.stringify(trial.params)}`)) continue;
      appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, ts: new Date().toISOString() }))}\n`);
    }
  }
  const trials = readdirSync(TRIAL_DIR).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(TRIAL_DIR, f)));

  const market = prepareMarket(loadBars({ timeframe: '1d' }));
  const span = jobs[0].span;
  const btc = market.series.get(BTC).bars.filter((b) => b.t >= FROM);
  const allTimes = btc.map((b) => b.t);
  const btcAll = Float64Array.from(btc, (b, i) => (i ? b.c / btc[i - 1].c - 1 : 0));
  const ewAll = ewStream(allTimes, market);
  const oosStart = allTimes.findIndex((t) => t >= span.from);
  const times = allTimes.slice(oosStart);
  const years = times.length / 365;
  const streams = { btc: { rets: btcAll.slice(oosStart), cost: 0.0013 }, ew20: { rets: ewAll.slice(oosStart), cost: 0.0018 } };
  const baseline = Object.fromEntries(Object.keys(REFS).map((ref) => [ref, jobs.find((j) => j.ref === ref && j.family === 'none')]));
  for (const ref of Object.keys(REFS)) {
    const eq = baseline[ref].equity;
    const byT = new Map(eq.map((e, i) => [e.t, i ? e.equity / eq[i - 1].equity - 1 : 0]));
    streams[`engine_${ref}`] = { rets: Float64Array.from(times, (t) => byT.get(t) ?? 0), cost: 0 };
  }

  const detectors = [];
  for (const [family, d] of Object.entries(DETECTORS)) {
    const [key, values] = Object.entries(d.grid)[0];
    for (const value of values) {
      const params = { [key]: value };
      const series = labelSeries(family, params, market);
      const labelsAll = allTimes.map((t) => series.get(t) ?? 'unknown');
      const labels = labelsAll.slice(oosStart);
      const held = inMarket(labelsAll).slice(oosStart);
      const row = {
        family, params, flips: flipStats(labels, years), flipsAllDev: flipStats(labelsAll, allTimes.length / 365),
        engine: engineRegimeExits(times, labels), timing: {}, byLabel: {},
      };
      for (const [name, s] of Object.entries(streams)) row.timing[name] = timing(s.rets, held, s.cost);
      row.byLabel.btc = byLabel(labels, streams.btc.rets);
      row.byLabel.ew20 = byLabel(labels, streams.ew20.rets);
      row.timingAllDev = timing(ewAll, inMarket(labelsAll), 0.0018);
      row.byLabelAllDev = byLabel(labelsAll, ewAll);
      row.real = Object.fromEntries(Object.keys(REFS).map((ref) => {
        const job = jobs.find((j) => j.ref === ref && j.family === family);
        const trial = job.trials.find((tr) => JSON.stringify(tr.params) === JSON.stringify(params));
        return [ref, { sharpe: trial.sharpe, maxDrawdown: trial.maxDrawdown, totalReturn: trial.totalReturn, closedTrades: trial.closedTrades }];
      }));
      detectors.push(row);
      console.log(`diagnosed ${family} ${JSON.stringify(params)}`);
    }
  }

  // Freeze rule F1-F5, on the parameters walk-forward picked most across the three entries.
  const verdicts = Object.keys(DETECTORS).map((family) => {
    const counts = new Map();
    for (const j of jobs.filter((x) => x.family === family)) {
      for (const p of j.picks) if (p.params) counts.set(JSON.stringify(p.params), (counts.get(JSON.stringify(p.params)) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const params = JSON.parse(ranked[0][0]);
    const row = detectors.find((d) => d.family === family && JSON.stringify(d.params) === JSON.stringify(params));
    const gains = Object.keys(REFS).map((ref) => {
      const b = baseline[ref].summary;
      return { ref, base: b.sharpe, filtered: row.real[ref].sharpe, gain: row.real[ref].sharpe - b.sharpe, dd: row.real[ref].maxDrawdown, ddCap: b.maxDrawdown * row.timing.btc.timeInMarket };
    });
    const f1 = gains.filter((g) => g.gain > 0).length >= 2 && gains.every((g) => g.gain >= -0.1);
    const f2 = gains.filter((g) => g.dd < g.ddCap).length >= 2;
    const f3 = row.timing.ew20.placeboP <= 0.05;
    const f4 = row.flips.changesPerYear <= 12 && row.flips.medianSpell >= 10;
    const f5 = jobs.filter((j) => j.family === family).every((j) => j.audit.ok);
    return { family, params, pickCounts: ranked, gains, f1, f2, f3, f4, f5, pass: f1 && f2 && f3 && f4 && f5 };
  });

  const devCriteria = {};
  for (const job of jobs) {
    const result = {
      oos: { summary: job.summary, equity: job.equity }, stress2x: job.stress2x ? { summary: job.stress2x } : null,
      plateau: job.plateau, benchmark: job.benchmark, strategy: job.strategy,
    };
    devCriteria[`${job.ref}/${job.family}`] = checkDevCriteria(result, { trials });
  }

  const slim = jobs.map(({ equity, ...rest }) => rest);
  writeFileSync(join(TMP, 'report.json'), JSON.stringify({ span, years, globalTrials: trials.length, jobs: slim, detectors, verdicts, devCriteria }, null, 1));
  console.log(`report written, ${trials.length} global trials, freeze candidates: ${verdicts.filter((v) => v.pass).map((v) => v.family).join(',') || 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'run') runShard(Number(a), Number(b));
  else if (mode === 'finalize') finalize();
  else console.log('usage: r-regime.mjs run <shard> <shards> | finalize');
}
