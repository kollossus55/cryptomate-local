// Calendar and intraday seasonality, long or cash. Research only, DEV data only.
//   node scripts/v6/research/r-season.mjs study            event study, E1-E4, 1h bars (4 trials)
//   node scripts/v6/research/r-season.mjs wf <E1|E2|E3|E4> walk-forward one gated effect
//   node scripts/v6/research/r-season.mjs report
// Pre-registration and results: docs/rebuild/research-r-season.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DAY_MS, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { DEFAULT_RISK_CONFIG, clampRiskConfig } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { SIGNAL_ONLY_EXITS, defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-season';
const FAMILY = 'seasonality';
const HOUR = 3600000;
const MAX_STOP = 0.15;
const STOP_K = 3;
const STUDY_N = 15;
const FROM = Date.UTC(2018, 0, 1);
const DEV_TO = Date.UTC(2024, 11, 31, 23);
const SPLIT = Date.UTC(2022, 0, 1);
const WF = { from: FROM, trainDays: 730, testDays: 180 };
const MAX_TRIALS = 30;

// ---------- window definitions (shared by the study and the strategies) ----------

const lastDayOfMonth = (t) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() === d.getUTCDate();
};
const FLAT_DAYS = { sun: [0], satsun: [6, 0], frisatsun: [5, 6, 0] };

/** Is the bar opening at `t` inside the effect's held window? */
export function inWindow(effect, p, t) {
  const d = new Date(t);
  if (effect === 'E1') { const h = d.getUTCHours(); return h >= 12 && h < 12 + p.len; }
  if (effect === 'E2') { const h = d.getUTCHours(); return h < p.len; }
  if (effect === 'E3') return !FLAT_DAYS[p.flat].includes(d.getUTCDay());
  if (effect === 'E4') return lastDayOfMonth(t) || d.getUTCDate() <= p.post;
  throw new Error(`Unknown effect ${effect}`);
}

export const EFFECTS = Object.freeze({
  E1: { name: 'US session from 12:00 UTC', timeframe: '4h', grid: { topN: [10, 20], len: [4, 8, 12] }, study: { len: 8 } },
  E2: { name: 'Asia session from 00:00 UTC', timeframe: '4h', grid: { topN: [10, 20], len: [4, 8, 12] }, study: { len: 8 } },
  E3: { name: 'Weekdays only', timeframe: '1d', grid: { topN: [10, 20], flat: ['sun', 'satsun', 'frisatsun'] }, study: { flat: 'satsun' } },
  E4: { name: 'Turn of month', timeframe: '1d', grid: { topN: [10, 20], post: [2, 3, 4] }, study: { post: 3 } },
});

/**
 * @param {'E1'|'E2'|'E3'|'E4'} effect
 * @returns {(params: object) => object} strategy factory
 */
export function seasonFactory(effect) {
  const { name, timeframe } = EFFECTS[effect];
  const barMs = timeframe === '4h' ? 4 * HOUR : DAY_MS;
  const perDay = DAY_MS / barMs;
  const id = `r-season-${effect}`;
  return (params) => defineStrategy({
    id, name, timeframe, params, universe: { kind: 'top', n: params.topN },
    // Constant across the grid, so every fold has the same warmup.
    warmupBars: 31 * perDay,
    exitOverrides: SIGNAL_ONLY_EXITS,
    signals(ctx) {
      const next = ctx.barT + barMs; // the bar the decision fills into
      const hold = inWindow(effect, ctx.params, next);
      const held = [...ctx.positions.values()].filter((x) => x.strategyId === id).map((x) => x.symbol);
      const out = [];
      for (const symbol of new Set([...ctx.universe, ...held])) {
        const bars = ctx.bars.get(symbol);
        if (bars?.at(-1)?.t !== ctx.barT) continue;
        const base = { strategyId: id, symbol, score: 0.5, exitProfile: 'trend', meta: {} };
        if (!hold || !ctx.universe.includes(symbol)) {
          if (ctx.positions.has(symbol)) out.push({ ...base, side: 'flat', reason: `${name}: window closed` });
          continue;
        }
        if (ctx.positions.has(symbol)) continue;
        const dailyVol = ctx.ind(symbol, 'realisedVol', [30 * perDay, 365 * perDay]) / Math.sqrt(365);
        if (!(dailyVol > 0)) continue;
        out.push({ ...base, side: 'long', stopDistancePct: Math.min(MAX_STOP, STOP_K * dailyVol), reason: `${name}: window open` });
      }
      return out;
    },
  });
}

/** Set only for candidates that pass every DEV criterion. Empty is a valid outcome. */
export const FROZEN_CANDIDATES = Object.freeze([]);

// ---------- runner ----------

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmpDir = join(here, '../../../data/tmp/r-season');
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const readLines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').flatMap((f) => readLines(join(trialDir, f)));
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));

function logTrial(strategyId, timeframe, trial, note) {
  mkdirSync(trialDir, { recursive: true });
  const lines = existsSync(trialFile) ? readLines(trialFile) : [];
  if (lines.some((l) => `${l.strategyId}|${JSON.stringify(l.params)}|${l.note}` === `${strategyId}|${JSON.stringify(trial.params)}|${note}`)) return;
  if (lines.length >= MAX_TRIALS) throw new Error(`Trial budget of ${MAX_TRIALS} reached`);
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe, trial, note, ts: new Date().toISOString() }))}\n`);
}

/** Every symbol that is ever in the point-in-time top N on a DEV day. */
function everListed(topN, timeframe) {
  const set = new Set();
  for (let d = FROM - 40 * DAY_MS; d <= DEV_TO; d += DAY_MS) for (const s of pointInTimeUniverse(d, { topN, timeframe })) set.add(s);
  return [...set];
}

// ---------- step 1: event study ----------

function windowInstances(effect, p) {
  const out = [];
  for (let d = FROM; d + DAY_MS <= DEV_TO; d += DAY_MS) {
    const dt = new Date(d);
    if (effect === 'E1') out.push({ s: d + 12 * HOUR, e: d + (12 + p.len) * HOUR });
    else if (effect === 'E2') out.push({ s: d, e: d + p.len * HOUR });
    else if (effect === 'E3' && dt.getUTCDay() === 1) out.push({ s: d, e: d + (7 - FLAT_DAYS[p.flat].length) * DAY_MS });
    else if (effect === 'E4' && lastDayOfMonth(d)) out.push({ s: d, e: d + (1 + p.post) * DAY_MS });
    else if (effect === 'ALL') out.push({ s: d, e: d + DAY_MS });
  }
  return out.filter((w) => w.e - HOUR <= DEV_TO);
}

function runStudy() {
  const symbols = everListed(STUDY_N, '1h');
  console.log(`study: ${symbols.length} symbols ever in the top ${STUDY_N}`);
  const raw = loadBars({ symbols, timeframe: '1h', from: FROM - 2 * DAY_MS, to: DEV_TO });
  const close = new Map();
  for (const [s, bars] of raw) { const m = new Map(); for (const b of bars) m.set(b.t, b.c); close.set(s, m); }
  const uniMemo = new Map();
  const uniAt = (t) => { const d = t - (t % DAY_MS); if (!uniMemo.has(d)) uniMemo.set(d, pointInTimeUniverse(d, { topN: STUDY_N, timeframe: '1h' })); return uniMemo.get(d); };
  const rtCost = (s, t) => { const c = costFor(s, tierFor(s, t)); return 2 * (c.feePct + c.slipPct) / 100; };

  // Basket return over [s, e): close of the bar before s to close of the bar before e.
  const basket = ({ s, e }) => {
    const rets = [], costs = [];
    for (const sym of uniAt(s)) {
      const a = close.get(sym)?.get(s - HOUR), b = close.get(sym)?.get(e - HOUR);
      if (!(a > 0 && b > 0)) continue;
      rets.push(b / a - 1); costs.push(rtCost(sym, s));
    }
    return rets.length >= 5 ? { s, gross: mean(rets), cost: mean(costs), n: rets.length } : null;
  };

  const daily = windowInstances('ALL', {}).map(basket).filter(Boolean);
  const muHour = mean(daily.map((x) => x.gross)) / 24;
  console.log(`unconditional basket drift ${pct(muHour * 24)} per day over ${daily.length} days`);

  const results = {};
  for (const effect of ['E1', 'E2', 'E3', 'E4']) {
    const p = EFFECTS[effect].study;
    const inst = windowInstances(effect, p).map((w) => ({ ...w, r: basket(w) })).filter((w) => w.r);
    const hours = (inst[0].e - inst[0].s) / HOUR;
    const gross = inst.map((w) => w.r.gross);
    const cost = inst.map((w) => w.r.cost);
    const net = inst.map((w) => w.r.gross - w.r.cost);
    const excess = gross.map((g) => g - hours * muHour);
    const half = (pred) => { const x = inst.filter(pred).map((w) => w.r.gross - hours * muHour); return { mean: mean(x), t: tstat(x), n: x.length }; };
    const h1 = half((w) => w.s < SPLIT), h2 = half((w) => w.s >= SPLIT);
    const perYear = inst.length / ((DEV_TO - FROM) / (365 * DAY_MS));
    const sharpeAnn = mean(net) / sd(net) * Math.sqrt(perYear);
    const gate = { grossBeatsCost: mean(gross) > mean(cost), excessT2: mean(excess) > 0 && tstat(excess) >= 2, sameSignHalves: Math.sign(h1.mean) === Math.sign(h2.mean) && h1.mean > 0 };
    const r = {
      effect, params: p, hours, instances: inst.length, meanGross: mean(gross), tGross: tstat(gross), meanCost: mean(cost), meanNet: mean(net),
      meanExcess: mean(excess), tExcess: tstat(excess), half1: h1, half2: h2, netSharpeAnn: sharpeAnn, gate, pass: Object.values(gate).every(Boolean),
    };
    results[effect] = r;
    logTrial(`r-season-study-${effect}`, '1h', {
      params: { ...p, topN: STUDY_N }, sharpe: sharpeAnn, periodsPerYear: perYear, nObs: inst.length, closedTrades: inst.length,
      maxDrawdown: null, totalReturn: net.reduce((acc, x) => acc * (1 + x), 1) - 1,
    }, `event study ${effect} 2018-2024 gross ${pct(r.meanGross)} cost ${pct(r.meanCost)} excess t ${r.tExcess.toFixed(2)}`);
    console.log(`${effect} ${hours}h n=${inst.length} gross ${pct(r.meanGross)} (t ${r.tGross.toFixed(2)}) cost ${pct(r.meanCost)} net ${pct(r.meanNet)} `
      + `excess ${pct(r.meanExcess)} (t ${r.tExcess.toFixed(2)}) halves ${pct(h1.mean)}/${pct(h2.mean)} netSR ${sharpeAnn.toFixed(2)} gate ${r.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(gate)}`);
  }
  writeFileSync(join(tmpDir, 'study.json'), JSON.stringify({ muHour, results }, null, 1));
}

// ---------- step 2: walk-forward ----------

function runWF(effect) {
  const study = JSON.parse(readFileSync(join(tmpDir, 'study.json'), 'utf8')).results[effect];
  if (!study?.pass) throw new Error(`${effect} did not pass the pre-registered gate; walk-forward not allowed`);
  const { timeframe, grid } = EFFECTS[effect];
  const symbols = everListed(20, timeframe);
  const setup = {
    bars: prepareMarket(loadBars({ symbols, timeframe, to: DEV_TO })), costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse,
    config: {
      risk: clampRiskConfig({ ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, maxClusterPct: 0.5, volTargetAnnual: 0.2 }),
      ...(timeframe === '4h' ? { volBars: 180 } : {}),
    },
  };
  const factory = seasonFactory(effect);
  const result = walkForward({ ...setup, ...WF, strategyFactory: factory, grid });
  for (const trial of result.trials) logTrial(`r-season-${effect}`, timeframe, trial, `wf ${effect} fixed params 2020-2024`);
  const center = result.plateau?.params ?? result.trials[0].params;
  const audit = auditLookahead({ ...setup, rebuild: () => factory(center), from: Date.UTC(2023, 0, 1), cuts: 3 });
  const verdict = checkDevCriteria(result, { trials: allTrials() });
  const s = result.summary, c = result.oos.costs;
  console.log(`${effect}: audit ${audit.ok ? 'clean' : 'FAILED'}, picks ${result.picks.map((p) => JSON.stringify(p.params)).join(' ')}`);
  console.log(`OOS return ${pct(s.totalReturn, 1)} Sharpe ${s.sharpe.toFixed(2)} DD ${pct(s.maxDrawdown, 1)} exposure ${pct(s.exposure, 1)} trades ${s.closedTrades} costs ${JSON.stringify(c)}`);
  console.log(`fixed ${result.trials.map((t) => `${JSON.stringify(t.params)} ${t.sharpe.toFixed(2)}`).join(' | ')}`);
  console.log(verdict.report);
  writeFileSync(join(tmpDir, `wf-${effect}.json`), JSON.stringify({
    effect, audit: audit.ok, pass: verdict.pass && audit.ok, criteria: verdict.criteria, picks: result.picks.map((p) => p.params),
    oos: { sharpe: s.sharpe, totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown, exposure: s.exposure, closedTrades: s.closedTrades, years: s.logReturnByYear, topCoin: s.topCoin, topCoinShare: s.topCoinShare },
    costs: c, trials: result.trials, plateau: result.plateau, stress2x: result.stress2x.summary.totalReturn,
    benchmark: { sharpe: result.benchmark.summary.sharpe, calmar: result.benchmark.summary.calmar },
  }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(tmpDir, { recursive: true });
  const [mode, effect] = process.argv.slice(2);
  if (mode === 'study') runStudy();
  else if (mode === 'wf') runWF(effect);
  else if (mode === 'report') console.log(`my trials ${allTrials().filter((t) => t.agent === AGENT).length}, global ${allTrials().length}`);
  else throw new Error(`Unknown mode ${mode}`);
}
