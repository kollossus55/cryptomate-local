// Cross-sectional momentum research (agent r-xsmom). Pre-registration: docs/rebuild/research-r-xsmom.md
//   node scripts/v6/research/r-xsmom.mjs stage1 | stage2 | ranks | diag
// DEV bars only, through loadBars. Importing this file runs nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLDOUT_START, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { clampRiskConfig, DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-xsmom';
const FAMILY = 'cross-sectional-momentum';
const ID = 'xsmom';
const DAY = 86400000;
const BTC = 'BTCUSDT';

export const DEFAULTS = Object.freeze({
  L: 50, metric: 'ret', K: 5, rebal: 7, topN: 30, gateN: 200, profile: 'trend',
  stopAtr: 3, minQv: 0, skip: 0, bufferMult: 2, phase: 0,
});

export const GRID = Object.freeze({ L: [20, 50, 100], metric: ['ret', 'radj'], K: [3, 5, 10], rebal: [7, 28] });

/** Ceilings for sizing and the ladder; breakers and costs stay at their defaults. */
export const RISK_CONFIG = clampRiskConfig({
  ...DEFAULT_RISK_CONFIG,
  riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, volTargetAnnual: 0.20, maxClusterPct: 0.50,
  maxStopDistancePct: 0.30, ladderHalfPct: 0.075, ladderQuarterPct: 0.125, ladderNoEntryPct: 0.175,
  ladderHaltPct: 0.20, dailyLossPct: 0.03, weeklyLossPct: 0.06,
});

const medianQv = (bars, n = 30) => {
  const q = bars.slice(-n).map((b) => b.qv).sort((a, b) => a - b);
  return q[q.length >> 1];
};

/** Best first. Reads ctx only. `control` ignores momentum and keeps the volume order. */
function ranked(ctx, p) {
  const out = [];
  ctx.universe.forEach((symbol, volumeRank) => {
    const ret = ctx.ind(symbol, 'roc', p.L, p.skip);
    if (!Number.isFinite(ret)) return;
    if (p.minQv > 0 && medianQv(ctx.bars.get(symbol)) < p.minQv) return;
    let score = ret;
    if (p.metric === 'radj') {
      const vol = ctx.ind(symbol, 'realisedVol', [p.L, 365], p.skip);
      if (!(vol > 0)) return;
      score = ret / vol;
    } else if (p.metric === 'control') score = -volumeRank;
    out.push({ symbol, score, ret });
  });
  return out.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));
}

function gateState(ctx, p) {
  if (!(p.gateN > 0)) return true;
  const avg = ctx.ind(BTC, 'sma', p.gateN);
  const close = ctx.bars.get(BTC)?.at(-1)?.c;
  return Number.isFinite(avg) && Number.isFinite(close) ? close > avg : null;
}

/** @param {Partial<typeof DEFAULTS>} params */
export function xsmom(params = {}) {
  const merged = { ...DEFAULTS, ...params };
  return defineStrategy({
    id: ID, name: 'Cross-sectional momentum', timeframe: '1d', params: merged, grid: GRID, warmupBars: 200,
    universe: { kind: 'top', n: merged.topN },
    signals(ctx) {
      const p = ctx.params;
      const flat = (symbol, reason) => ({ strategyId: ID, symbol, side: 'flat', score: 0, exitProfile: p.profile, reason, meta: {} });
      const gate = gateState(ctx, p);
      if (gate === null) return [];
      if (gate === false) return [...ctx.positions.keys()].map((s) => flat(s, `BTC is at or below its ${p.gateN}-day average`));
      if ((Math.floor(ctx.barT / DAY) + p.phase) % p.rebal !== 0) return [];

      const list = ranked(ctx, p);
      const absolute = p.metric !== 'control';
      const rankOf = new Map(list.map((r, i) => [r.symbol, i]));
      const signals = [];
      let kept = 0;
      for (const symbol of ctx.positions.keys()) {
        const i = rankOf.get(symbol);
        if (i === undefined) signals.push(flat(symbol, 'Left the ranked universe'));
        else if (i >= p.K * p.bufferMult) signals.push(flat(symbol, `Rank fell to ${i + 1}`));
        else if (absolute && list[i].ret <= 0) signals.push(flat(symbol, `Trailing ${p.L}-day return turned negative`));
        else kept++;
      }
      let slots = p.K - kept;
      for (let i = 0; i < Math.min(p.K, list.length) && slots > 0; i++) {
        const { symbol, ret } = list[i];
        if (ctx.positions.has(symbol) || (absolute && ret <= 0)) continue;
        const close = ctx.bars.get(symbol).at(-1).c;
        const atrPct = ctx.ind(symbol, 'atr', 14) / close;
        if (!Number.isFinite(atrPct)) continue;
        slots--;
        signals.push({
          strategyId: ID, symbol, side: 'long', score: 1 - i / list.length, exitProfile: p.profile,
          stopDistancePct: Math.min(0.30, Math.max(0.08, p.stopAtr * atrPct)),
          reason: `Rank ${i + 1} of ${list.length} on ${p.L}-day ${p.metric}`, meta: { rank: i + 1, ret },
        });
      }
      return signals;
    },
  });
}

/** At most 2. Empty until something qualifies; empty is a valid outcome. */
export const FROZEN_CANDIDATES = Object.freeze([]);

// ---------- research driver ----------

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmpDir = join(here, '../../../data/tmp', AGENT);
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(trialDir, f)));
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

const WF = { from: Date.UTC(2019, 0, 1), trainDays: 730, testDays: 180, minTrainTrades: 20 };
const OOS_FROM = Date.UTC(2021, 0, 1);

function logTrial(trial, note) {
  // phase was added after stage 1: leaving a zero out keeps reruns matching the logged lines.
  const { phase, ...rest } = { ...DEFAULTS, ...trial.params };
  const params = phase ? { ...rest, phase } : rest;
  const seen = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => JSON.stringify(l.params)) : []);
  if (seen.has(JSON.stringify(params))) return;
  const line = trialRecord({ agent: AGENT, family: FAMILY, strategyId: ID, timeframe: '1d', trial: { ...trial, params }, note, ts: new Date().toISOString() });
  appendFileSync(trialFile, `${JSON.stringify(line)}\n`);
}

/** Everything the report needs beyond D1-D8. */
function describe(run) {
  const s = run.summary;
  const years = {};
  let prev = run.equity[0].equity;
  for (const e of run.equity) {
    const y = new Date(e.t).getUTCFullYear();
    years[y] = (years[y] ?? 1) * (e.equity / prev);
    prev = e.equity;
  }
  const reasons = {}, tiers = { 1: 0, 2: 0, 3: 0 };
  for (const t of run.trades) if (!t.partial) reasons[t.reasonCode] = (reasons[t.reasonCode] || 0) + 1;
  let turnover = 0;
  for (const f of run.fills) {
    const notional = f.qty * f.price;
    turnover += notional;
    tiers[tierFor(f.symbol, Math.min(f.t, HOLDOUT_START - 1))] += notional;
  }
  const avgEquity = run.equity.reduce((a, e) => a + e.equity, 0) / run.equity.length;
  const delisted = run.trades.filter((t) => t.reasonCode === 'delisted').map((t) => ({ symbol: t.symbol, pnl: +t.pnl.toFixed(1) }));
  return {
    totalReturn: s.totalReturn, cagr: s.cagr, sharpe: s.sharpe, volatility: s.volatility, maxDrawdown: s.maxDrawdown, calmar: s.calmar,
    closedTrades: s.closedTrades, winRate: s.winRate, profitFactor: s.profitFactor, avgR: s.avgR, exposure: s.exposure, halted: s.halted,
    years: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, +(v - 1).toFixed(4)])),
    costs: run.costs, reasons, delisted, turnoverPerYear: turnover / avgEquity / (run.equity.length / 365),
    tierShare: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, +(v / (turnover || 1)).toFixed(3)])),
    topCoin: s.topCoin, topCoinShare: s.topCoinShare, topYear: s.topYear, topYearShare: s.topYearShare,
    eventCounts: s.eventCounts,
  };
}

function setup() {
  const bars = prepareMarket(loadBars({ timeframe: '1d' }));
  return { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk: RISK_CONFIG } };
}

function stage1() {
  const base = setup();
  const started = performance.now();
  const r = walkForward({ ...base, ...WF, strategyFactory: xsmom, grid: GRID });
  console.log(`walk-forward ${((performance.now() - started) / 1000).toFixed(0)}s, ${r.picks.length} folds, ${r.trials.length} trials`);
  for (const t of r.trials) logTrial(t, 'stage1');
  for (const p of r.picks) console.log(`  ${new Date(p.testFrom).toISOString().slice(0, 10)} ${JSON.stringify(p.params)} train ${p.trainScore?.toFixed(2)}`);
  console.log('trials by Sharpe:');
  for (const t of [...r.trials].sort((a, b) => b.sharpe - a.sharpe)) {
    console.log(`  ${t.sharpe.toFixed(2)} dd ${pct(t.maxDrawdown)} ret ${pct(t.totalReturn)} n ${t.closedTrades} ${JSON.stringify(t.params)}`);
  }
  const center = r.plateau?.params ?? {};
  const audit = auditLookahead({ ...base, rebuild: () => xsmom(center), from: OOS_FROM, cuts: 4 });
  console.log(`audit (rebuild) ${audit.ok ? 'clean' : JSON.stringify(audit.cuts)}`);
  const verdict = checkDevCriteria(r, { trials: allTrials() });
  console.log(verdict.report);
  const out = {
    center, plateau: r.plateau, picks: r.picks, oos: describe(r.oos), stress2x: describe(r.stress2x), benchmark: r.benchmark && describe(r.benchmark),
    audit: audit.ok, criteria: verdict.criteria, pass: verdict.pass, trials: r.trials,
  };
  writeFileSync(join(tmpDir, 'stage1.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, trials: undefined, picks: undefined }, null, 1));
}

const asTrial = (params, s) => ({ params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn });

function stage2() {
  const base = setup();
  const { center } = JSON.parse(readFileSync(join(tmpDir, 'stage1.json'), 'utf8'));
  const variants = {
    center: {}, gate100: { gateN: 100 }, gateOff: { gateN: 0 }, top20: { topN: 20 }, top50: { topN: 50 }, swing: { profile: 'swing' },
    liq50m: { minQv: 50e6 }, stop2: { stopAtr: 2 }, stop4: { stopAtr: 4 }, rebal14: { rebal: 14 }, skip7: { skip: 7 },
    noBuffer: { bufferMult: 1 }, control: { metric: 'control' },
  };
  const rows = {};
  for (const [name, change] of Object.entries(variants)) {
    const params = { ...center, ...change };
    const run = runSim({ ...base, strategies: [xsmom(params)], from: OOS_FROM, collectEvents: false });
    if (name !== 'center') logTrial(asTrial(params, run.summary), `stage2 ${name}`);
    const d = rows[name] = describe(run);
    console.log(`${name.padEnd(9)} Sharpe ${d.sharpe.toFixed(2)} ret ${pct(d.totalReturn)} dd ${pct(d.maxDrawdown)} n ${d.closedTrades} expo ${pct(d.exposure)} turn ${d.turnoverPerYear.toFixed(1)}x t3 ${pct(d.tierShare[3], 0)} halted ${d.halted} ${JSON.stringify(d.years)}`);
  }
  writeFileSync(join(tmpDir, 'stage2.json'), JSON.stringify(rows, null, 1));
}

/** Diagnosis only, no sim and no parameter choice: forward return by trailing-return rank. */
function ranks() {
  const raw = loadBars({ timeframe: '1d' });
  const { center } = JSON.parse(readFileSync(join(tmpDir, 'stage1.json'), 'utf8'));
  const L = center.L ?? DEFAULTS.L, H = center.rebal ?? 7, N = 30;
  const index = new Map([...raw].map(([s, b]) => [s, new Map(b.map((x, i) => [x.t, i]))]));
  const acc = {};
  for (let t = OOS_FROM; t < Date.UTC(2024, 11, 1); t += H * DAY) {
    const rows = [];
    for (const symbol of pointInTimeUniverse(t + DAY, { topN: N, timeframe: '1d' })) {
      const b = raw.get(symbol), i = index.get(symbol).get(t);
      if (i === undefined || i < L) continue;
      const end = Math.min(i + H, b.length - 1);
      const dead = b.length - 1 < i + H; // a coin that dies early counts at its last close, minus the haircut
      rows.push({ past: b[i].c / b[i - L].c - 1, fwd: (b[end].c * (dead ? 0.9 : 1)) / b[i].c - 1 });
    }
    if (rows.length < 15) continue;
    rows.sort((a, b) => b.past - a.past);
    const y = new Date(t).getUTCFullYear();
    const q = rows.length / 5;
    for (let k = 0; k < 5; k++) {
      const part = rows.slice(Math.round(k * q), Math.round((k + 1) * q));
      const m = part.reduce((a, r) => a + r.fwd, 0) / part.length;
      for (const key of [y, 'all']) ((acc[key] ??= [[], [], [], [], []])[k]).push(m);
    }
  }
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  for (const [key, q] of Object.entries(acc)) {
    const spread = q[0].map((v, i) => v - q[4][i]);
    const m = mean(spread);
    const tstat = m / (Math.sqrt(mean(spread.map((v) => (v - m) ** 2))) / Math.sqrt(spread.length));
    console.log(`${key}: ${q.map((x) => pct(mean(x), 2)).join(' ')} Q1-Q5 ${pct(m, 2)} t ${tstat.toFixed(2)} n ${spread.length}`);
  }
}

/** Why walk-forward and fixed parameters differ, and whether the weekday of the rebalance matters. Phases are logged trials. */
function diag() {
  const base = setup();
  const { center, picks } = JSON.parse(readFileSync(join(tmpDir, 'stage1.json'), 'utf8'));
  const from = picks[0].testFrom;
  const built = picks.map((p) => xsmom(p.params));
  const proto = built[0];
  const scheduled = defineStrategy({
    ...proto,
    signals(ctx) {
      let i = 0;
      while (i + 1 < picks.length && picks[i + 1].testFrom <= ctx.barT) i++;
      return built[i].signals({ ...ctx, params: built[i].params });
    },
  });
  const runs = { scheduled: runSim({ ...base, strategies: [scheduled], from }), center: runSim({ ...base, strategies: [xsmom(center)], from }) };
  for (const [name, run] of Object.entries(runs)) {
    console.log(name, 'return', pct(run.summary.totalReturn), 'Sharpe', run.summary.sharpe.toFixed(2), 'dd', pct(run.summary.maxDrawdown), 'exposure', pct(run.summary.exposure));
    for (const p of picks) {
      const part = run.equity.filter((e) => e.t >= p.testFrom && e.t <= p.testTo);
      if (part.length < 2) continue;
      const expo = part.reduce((a, e) => a + e.gross / e.equity, 0) / part.length;
      const trades = run.trades.filter((t) => t.exitTime >= p.testFrom && t.exitTime <= p.testTo && !t.partial).length;
      console.log('  ', new Date(p.testFrom).toISOString().slice(0, 10), pct(part.at(-1).equity / part[0].equity - 1), 'expo', pct(expo), 'trades', trades, 'equity', part.at(-1).equity.toFixed(0));
    }
    for (const e of run.events.filter((x) => (x.code || x.type) === 'ladder_changed')) console.log('   ladder', new Date(e.t).toISOString().slice(0, 10), e.message ?? JSON.stringify(e));
  }
  for (const phase of [2, 4]) {
    const params = { ...center, phase };
    const run = runSim({ ...base, strategies: [xsmom(params)], from: OOS_FROM, collectEvents: false });
    logTrial(asTrial(params, run.summary), `post-hoc diagnostic phase ${phase}`);
    const d = describe(run);
    console.log('phase', phase, 'Sharpe', d.sharpe.toFixed(2), 'ret', pct(d.totalReturn), 'dd', pct(d.maxDrawdown), JSON.stringify(d.years));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(tmpDir, { recursive: true });
  ({ stage1, stage2, ranks, diag })[process.argv[2] ?? 'stage1']();
}
