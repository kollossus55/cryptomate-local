// Equal-risk ensemble of three registered sleeves on one account. Research only, DEV data only.
//   node scripts/v6/research/r-ensemble.mjs picks     per-sleeve walk-forward picks (train only)
//   node scripts/v6/research/r-ensemble.mjs main      ensemble OOS, 2x costs, benchmark, audits, criteria
//   node scripts/v6/research/r-ensemble.mjs plateau   D6 joint-grid neighbours, then criteria again
//   node scripts/v6/research/r-ensemble.mjs report
// Pre-registration and results: docs/rebuild/research-r-ensemble.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import { DEFAULT_RISK_CONFIG, clampRiskConfig } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, gridCombos, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { returnsFromEquity } from '../../../shared/trading/v6Stats.js';
import { buyAndHold } from '../../../shared/trading/v6Strategies.js';
import { trendFactory } from './r-trend.mjs';
import { makeStrategy } from './r-regime.mjs';
import { breakoutFactory, RISK_AT_CEILINGS } from './r-breakout.mjs';

const AGENT = 'r-ensemble';
const FAMILY = 'ensemble';
const DAY = 86400000;

// r-trend btceth and r-regime use the same values.
const MAJORS_RISK = clampRiskConfig({
  ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, maxClusterPct: 0.50, volTargetAnnual: 0.20,
});

/** Pre-registered, in priority order. Do not edit after the first run. */
export const SLEEVES = Object.freeze([
  { key: 'trend', factory: trendFactory({ rule: 'tsmom', universe: 'btceth' }), grid: { L: [30, 90, 180, 365] }, risk: MAJORS_RISK, minTrainTrades: 0 },
  { key: 'hold', factory: (p) => makeStrategy('hold', 'T', p), grid: { n: [50, 100, 200] }, risk: MAJORS_RISK, minTrainTrades: 0 },
  { key: 'breakout', factory: breakoutFactory('donchian', '1d'), grid: { n: [20, 50, 100], exit: ['trend', 'swing'], topN: [20, 30] }, risk: RISK_AT_CEILINGS, minTrainTrades: 20 },
]);
const COMBINED_RISK = MAJORS_RISK;
const WF = { from: Date.UTC(2018, 8, 1), trainDays: 730, testDays: 180 };
const MAX_FULL_NEIGHBOURS = 40;

/** Set only for candidates that pass every DEV criterion. Empty is a valid outcome. */
export const FROZEN_CANDIDATES = Object.freeze([]);

// ---------- helpers ----------

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmpDir = join(here, '../../../data/tmp/r-ensemble');
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const readLines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// The re-measurement's convention: the example file is a demo, not a trial.
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').flatMap((f) => readLines(join(trialDir, f)));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

function loadMarket() {
  const ever = new Set(['BTCUSDT', 'ETHUSDT']);
  for (let t = Date.UTC(2018, 0, 1); t < Date.UTC(2025, 0, 1); t += DAY) for (const s of pointInTimeUniverse(t, { topN: 30 })) ever.add(s);
  return prepareMarket(loadBars({ timeframe: '1d', symbols: [...ever] }));
}
const setup = (market, risk) => ({ bars: market, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk } });

/** Same switcher as walkForward's scheduledStrategy: parameters change at fold boundaries. */
function scheduled(sleeve, picks) {
  const starts = picks.map((p) => p.testFrom);
  const segs = picks.map((p) => (p.params ? sleeve.factory(p.params) : null));
  const base = sleeve.factory(picks.find((p) => p.params)?.params ?? gridCombos(sleeve.grid)[0]);
  let current = segs[0];
  return {
    ...base,
    atBar(barT) { const i = lowerBound(starts, barT + 1) - 1; current = i >= 0 ? segs[i] : null; },
    get universe() { return (current ?? base).universe; },
    get warmupBars() { return (current ?? base).warmupBars; },
    get exitOverrides() { return current?.exitOverrides; },
    signals(ctx) { return current ? current.signals({ ...ctx, params: current.params }) : []; },
  };
}

function logTrial(strategyId, s, params, note) {
  mkdirSync(trialDir, { recursive: true });
  const seen = existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : [];
  if (seen.includes(`${strategyId}|${JSON.stringify(params)}`)) return;
  if (seen.length >= 50) throw new Error('Trial cap of 50 reached');
  const trial = { params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn, simReEnables: s.simReEnables, regimeExits: s.regimeExits };
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
}

const yearly = (s) => Object.fromEntries(Object.entries(s.logReturnByYear).map(([y, v]) => [y, +(Math.exp(v) - 1).toFixed(4)]));
const brief = (s) => ({ sharpe: s.sharpe, calmar: s.calmar, totalReturn: s.totalReturn, maxDrawdown: s.maxDrawdown, exposure: s.exposure, closedTrades: s.closedTrades, topCoin: s.topCoin, topCoinShare: s.topCoinShare, topYear: s.topYear, topYearShare: s.topYearShare, simReEnables: s.simReEnables, years: yearly(s) });
const byStrategy = (trades) => { const o = {}; for (const t of trades) o[t.strategyId] = (o[t.strategyId] ?? 0) + t.pnl; return o; };
const sizeMult = (strategies) => Object.fromEntries(strategies.map((s) => [s.id, 1]));
function corr(a, b) {
  const n = Math.min(a.length, b.length); let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

function runCombined(market, strategies, from, to, extra = {}) {
  return runSim({ ...setup(market, COMBINED_RISK), strategies, from, to, config: { risk: COMBINED_RISK, sizeMultipliers: sizeMult(strategies) }, ...extra });
}

/** auditLookahead's cut rule, for several strategies at once (auditLookahead takes one). */
function auditCombined(market, build, from, to, cuts = 3) {
  const full = runCombined(market, build(), from, to, { closeOut: false, collectEvents: false });
  const n = full.equity.length;
  const out = [];
  for (let i = 0; i < cuts; i++) {
    const cut = full.equity[2 + Math.floor((0.1 + 0.8 * ((i + 0.5) / cuts)) * (n - 3))].t;
    const truncated = new Map();
    for (const [symbol, s] of market.series) { const bars = s.bars.filter((b) => b.t <= cut); if (bars.length) truncated.set(symbol, bars); }
    const part = runCombined(prepareMarket(truncated), build(), from, cut, { closeOut: false, collectEvents: false });
    const key = (f) => `${f.t}|${f.symbol}|${f.type}|${f.qty}|${f.price}`;
    const exp = full.fills.filter((f) => f.t <= cut);
    let detail = part.fills.length !== exp.length ? `${part.fills.length} vs ${exp.length} fills` : null;
    for (let j = 0; !detail && j < exp.length; j++) if (key(part.fills[j]) !== key(exp[j])) detail = `fill ${j} differs`;
    for (let j = 0; !detail && j < part.equity.length; j++) if (part.equity[j].equity !== full.equity[j].equity) detail = `equity differs at ${j}`;
    out.push({ cut: new Date(cut).toISOString().slice(0, 10), ok: !detail, detail });
  }
  return { ok: out.every((c) => c.ok), cuts: out };
}

function mostPicked(picks) {
  const c = new Map();
  for (const p of picks) if (p.params) { const k = JSON.stringify(p.params); c.set(k, (c.get(k) ?? 0) + 1); }
  let best = null, n = -1;
  for (const [k, v] of c) if (v >= n) { best = k; n = v; }
  return JSON.parse(best);
}

// ---------- modes ----------

function runPicks(market) {
  const out = {};
  for (const sl of SLEEVES) {
    const t0 = performance.now();
    const r = walkForward({ ...setup(market, sl.risk), ...WF, strategyFactory: sl.factory, grid: sl.grid, minTrainTrades: sl.minTrainTrades, extras: false });
    out[sl.key] = r.picks.map((p) => ({ testFrom: p.testFrom, params: p.params, trainScore: p.trainScore }));
    console.log(`${sl.key} ${((performance.now() - t0) / 1000).toFixed(0)}s picks ${out[sl.key].map((p) => JSON.stringify(p.params)).join(' ')}`);
  }
  writeFileSync(join(tmpDir, 'picks.json'), JSON.stringify(out, null, 1));
}

const loadPicks = () => JSON.parse(readFileSync(join(tmpDir, 'picks.json'), 'utf8'));
const span = (picks) => ({ from: picks.trend[0].testFrom, to: Date.UTC(2024, 11, 31) });

function buildResult(market, picks, plateau) {
  const { from, to } = span(picks);
  const build = () => SLEEVES.map((sl) => scheduled(sl, picks[sl.key]));
  const oos = runCombined(market, build(), from, to);
  const stress2x = runCombined(market, build(), from, to, { collectEvents: false, costs: { tierFn: tierFor, stress: 2 } });
  const k = lowerBound(market.calendar, from);
  const symbols = pointInTimeUniverse(market.calendar[k], { topN: 30 }).filter((s) => (market.series.get(s)?.bars ?? []).some((b) => b.t <= market.calendar[k]));
  const benchmark = runSim({ ...setup(market, COMBINED_RISK), strategies: [buyAndHold({ symbols })], from, to, modules: { risk: fullWeightRisk({ weight: 1 / symbols.length }) }, collectEvents: false });
  return { oos, picks, summary: oos.summary, stress2x, benchmark, plateau, strategy: { id: 'r-ensemble-E1', slowAllocator: false }, build, from, to };
}

function runMain(market) {
  const picks = loadPicks();
  const res = buildResult(market, picks, null);
  const { from, to, oos } = res;
  logTrial('r-ensemble-E1', oos.summary, { ensemble: 'E1', sleeves: SLEEVES.map((s) => s.key), weights: [1, 1, 1] }, 'walk-forward OOS, pre-registered');

  // Sleeves alone, same folds and config: diagnostics, logged.
  const alone = {};
  const rets = {};
  for (const sl of SLEEVES) {
    const r = runCombined(market, [scheduled(sl, picks[sl.key])], from, to, { collectEvents: false });
    logTrial(`r-ensemble-alone-${sl.key}`, r.summary, { sleeve: sl.key, wf: true }, 'diagnostic: sleeve alone on ensemble folds and config');
    alone[sl.key] = brief(r.summary);
    rets[sl.key] = returnsFromEquity(r.equity);
  }
  const correlations = {};
  for (let i = 0; i < SLEEVES.length; i++) for (let j = i + 1; j < SLEEVES.length; j++) {
    const a = SLEEVES[i].key, b = SLEEVES[j].key;
    correlations[`${a}-${b}`] = +corr(rets[a], rets[b]).toFixed(3);
  }

  const auditSleeves = SLEEVES.map((sl) => ({ key: sl.key, ...auditLookahead({ ...setup(market, COMBINED_RISK), config: { risk: COMBINED_RISK, sizeMultipliers: { [sl.factory(gridCombos(sl.grid)[0]).id]: 1 } }, rebuild: () => scheduled(sl, picks[sl.key]), from: Date.UTC(2023, 0, 1), cuts: 3 }) }));
  const auditAll = auditCombined(market, res.build, Date.UTC(2023, 0, 1), to, 3);
  const verdict = checkDevCriteria(res, { trials: allTrials() });
  const out = {
    span: { from: new Date(from).toISOString().slice(0, 10), to: '2024-12-31' },
    oos: brief(oos.summary), byStrategy: byStrategy(oos.trades), bySymbol: oos.summary.bySymbol, costs: oos.costs,
    stress2x: brief(res.stress2x.summary), benchmark: brief(res.benchmark.summary), alone, correlations,
    audit: { sleeves: auditSleeves.map((a) => ({ key: a.key, ok: a.ok })), combined: auditAll }, criteria: verdict.criteria,
  };
  writeFileSync(join(tmpDir, 'main.json'), JSON.stringify(out, null, 1));
  console.log(`OOS ${pct(out.oos.totalReturn)} Sharpe ${out.oos.sharpe.toFixed(2)} DD ${pct(out.oos.maxDrawdown)} exp ${pct(out.oos.exposure)} trades ${out.oos.closedTrades}`);
  console.log(`byStrategy ${JSON.stringify(Object.fromEntries(Object.entries(out.byStrategy).map(([k, v]) => [k, Math.round(v)])))} corr ${JSON.stringify(correlations)}`);
  console.log(`alone ${Object.entries(alone).map(([k, v]) => `${k} S${v.sharpe.toFixed(2)}`).join(' ')} audit sleeves ${auditSleeves.map((a) => a.ok).join(',')} combined ${auditAll.ok}`);
  console.log(`years ${JSON.stringify(out.oos.years)}`);
  console.log(verdict.report);
}

function neighbourCombos(center) {
  const dims = SLEEVES.flatMap((sl) => Object.keys(sl.grid).map((k) => ({ sl: sl.key, k, values: sl.grid[k] })));
  const c = dims.map((d) => d.values.indexOf(center[d.sl][d.k]));
  let combos = [[]];
  dims.forEach((d, i) => {
    const opts = [c[i] - 1, c[i], c[i] + 1].filter((x) => x >= 0 && x < d.values.length);
    combos = combos.flatMap((cb) => opts.map((o) => [...cb, o]));
  });
  const toParams = (idx) => { const p = Object.fromEntries(SLEEVES.map((sl) => [sl.key, {}])); dims.forEach((d, i) => { p[d.sl][d.k] = d.values[idx[i]]; }); return p; };
  const full = combos.filter((cb) => cb.some((x, i) => x !== c[i])).map(toParams);
  const axis = combos.filter((cb) => cb.filter((x, i) => x !== c[i]).length === 1).map(toParams);
  return { full, axis };
}

function runPlateau(market) {
  const picks = loadPicks();
  const { from, to } = span(picks);
  const center = Object.fromEntries(SLEEVES.map((sl) => [sl.key, mostPicked(picks[sl.key])]));
  const { full, axis } = neighbourCombos(center);
  const partial = full.length > MAX_FULL_NEIGHBOURS;
  const list = partial ? axis : full;
  console.log(`centre ${JSON.stringify(center)}; ${full.length} full neighbours, running ${list.length}${partial ? ' (axis only: D6 partial)' : ''}`);
  const fixedRun = (p, tag) => {
    const strategies = SLEEVES.map((sl) => sl.factory(p[sl.key]));
    const s = runCombined(market, strategies, from, to, { collectEvents: false }).summary;
    logTrial('r-ensemble-fixed', s, p, tag);
    return { params: p, sharpe: s.sharpe };
  };
  const self = fixedRun(center, 'D6 centre, fixed params over OOS');
  const neighbours = list.map((p) => fixedRun(p, 'D6 neighbour, fixed params over OOS'));
  const plateau = { params: center, sharpe: self.sharpe, neighbours, partial };
  const res = buildResult(market, picks, plateau);
  const verdict = checkDevCriteria(res, { trials: allTrials() });
  if (partial) verdict.criteria.D6 = { ...verdict.criteria.D6, pass: false, detail: `${verdict.criteria.D6.detail}; axis neighbours only, so D6 cannot pass` };
  writeFileSync(join(tmpDir, 'plateau.json'), JSON.stringify({ plateau, criteria: verdict.criteria }, null, 1));
  console.log(`centre S${self.sharpe.toFixed(2)} neighbours ${neighbours.map((n) => n.sharpe.toFixed(2)).join(' ')}`);
  console.log(verdict.report);
}

function runReport() {
  const t = allTrials();
  console.log(`my trials ${t.filter((x) => x.agent === AGENT).length}, global ${t.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(tmpDir, { recursive: true });
  const mode = process.argv[2];
  if (mode === 'report') runReport();
  else {
    const market = loadMarket();
    if (mode === 'picks') runPicks(market);
    else if (mode === 'main') runMain(market);
    else if (mode === 'plateau') runPlateau(market);
    else throw new Error(`Unknown mode ${mode}`);
  }
}
