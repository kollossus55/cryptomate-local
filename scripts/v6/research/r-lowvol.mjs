// Cross-sectional low-volatility / low-beta research (agent r-lowvol). Pre-registration: docs/rebuild/research-r-lowvol.md
//   node scripts/v6/research/r-lowvol.mjs stage1 | stage2 | quintiles
// DEV bars only, through loadBars. Importing this file runs nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLDOUT_START, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { clampRiskConfig, DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { defineStrategy, SIGNAL_ONLY_EXITS } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-lowvol';
const FAMILY = 'cross-sectional-low-volatility';
const ID = 'lowvol';
const DAY = 86400000;
const BTC = 'BTCUSDT';

export const DEFAULTS = Object.freeze({
  metric: 'vol', L: 30, K: 5, rebal: 7, gateN: 200, topN: 30, stopAtr: 3, bufferMult: 2, exits: 'signal', invert: false,
});

export const GRID = Object.freeze({ metric: ['vol', 'beta'], L: [30, 90], K: [3, 5], rebal: [7, 28], gateN: [0, 200] });

/** Ceilings for sizing and the ladder, identical to r-xsmom; breakers and costs stay at their defaults. */
export const RISK_CONFIG = clampRiskConfig({
  ...DEFAULT_RISK_CONFIG,
  riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, volTargetAnnual: 0.20, maxClusterPct: 0.50,
  maxStopDistancePct: 0.30, ladderHalfPct: 0.075, ladderQuarterPct: 0.125, ladderNoEntryPct: 0.175,
  ladderHaltPct: 0.20, dailyLossPct: 0.03, weeklyLossPct: 0.06,
});

/** OLS beta of daily log returns on BTC over the last L bars, matched by bar time. Visible bars only. */
function betaToBtc(ctx, symbol, L) {
  if (symbol === BTC) return 1;
  const a = ctx.bars.get(symbol), b = ctx.bars.get(BTC);
  if (!a || !b || a.length < L + 1 || b.length < L + 2) return NaN;
  const btcAt = new Map();
  for (const x of b.slice(-(L + 40))) btcAt.set(x.t, x.c);
  const xs = [], ys = [];
  const tail = a.slice(-(L + 1));
  for (let i = 1; i < tail.length; i++) {
    const b0 = btcAt.get(tail[i - 1].t), b1 = btcAt.get(tail[i].t);
    if (!(b0 > 0 && b1 > 0 && tail[i - 1].c > 0 && tail[i].c > 0)) continue;
    // Only consecutive daily bars count, so a gap is not read as a one-day move.
    if (tail[i].t - tail[i - 1].t !== DAY) continue;
    xs.push(Math.log(b1 / b0)); ys.push(Math.log(tail[i].c / tail[i - 1].c));
  }
  if (xs.length < 0.8 * L) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let cov = 0, vx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  return vx > 0 ? cov / vx : NaN;
}

/** Best first: lowest risk, or highest with `invert` (control). `volume` keeps the volume order. */
function ranked(ctx, p) {
  const out = [];
  ctx.universe.forEach((symbol, volumeRank) => {
    const bars = ctx.bars.get(symbol);
    if (bars?.at(-1)?.t !== ctx.barT) return;
    let risk;
    if (p.metric === 'vol') risk = ctx.ind(symbol, 'realisedVol', [p.L, 365]);
    else if (p.metric === 'beta') risk = betaToBtc(ctx, symbol, p.L);
    else if (p.metric === 'volume') risk = volumeRank;
    if (!Number.isFinite(risk)) return;
    out.push({ symbol, score: p.invert ? -risk : risk, risk });
  });
  return out.sort((a, b) => a.score - b.score || (a.symbol < b.symbol ? -1 : 1));
}

function gateState(ctx, p) {
  if (!(p.gateN > 0)) return true;
  const avg = ctx.ind(BTC, 'sma', p.gateN);
  const close = ctx.bars.get(BTC)?.at(-1)?.c;
  return Number.isFinite(avg) && Number.isFinite(close) ? close > avg : null;
}

/** @param {Partial<typeof DEFAULTS> & { majors?: boolean }} params */
export function lowvol(params = {}) {
  const merged = { ...DEFAULTS, ...params };
  const universe = merged.majors ? { kind: 'fixed', symbols: [BTC, 'ETHUSDT'] } : { kind: 'top', n: merged.topN };
  return defineStrategy({
    id: ID, name: 'Cross-sectional low volatility', timeframe: '1d', params: merged, grid: GRID, warmupBars: 200,
    universe, slowAllocator: true,
    ...(merged.exits === 'signal' ? { exitOverrides: SIGNAL_ONLY_EXITS } : {}),
    signals(ctx) {
      const p = ctx.params;
      const flat = (symbol, reason) => ({ strategyId: ID, symbol, side: 'flat', score: 0, exitProfile: 'trend', reason, meta: {} });
      const gate = gateState(ctx, p);
      if (gate === null) return [];
      if (gate === false) return [...ctx.positions.keys()].map((s) => flat(s, `BTC is at or below its ${p.gateN}-day average`));
      if (Math.floor(ctx.barT / DAY) % p.rebal !== 0) return [];

      const list = ranked(ctx, p);
      const rankOf = new Map(list.map((r, i) => [r.symbol, i]));
      const signals = [];
      let kept = 0;
      for (const symbol of ctx.positions.keys()) {
        const i = rankOf.get(symbol);
        if (i === undefined) signals.push(flat(symbol, 'Left the ranked universe'));
        else if (i >= p.K * p.bufferMult) signals.push(flat(symbol, `Risk rank fell to ${i + 1}`));
        else kept++;
      }
      let slots = p.K - kept;
      for (let i = 0; i < Math.min(p.K, list.length) && slots > 0; i++) {
        const { symbol, risk } = list[i];
        if (ctx.positions.has(symbol)) continue;
        const close = ctx.bars.get(symbol).at(-1).c;
        const atrPct = ctx.ind(symbol, 'atr', 14) / close;
        if (!Number.isFinite(atrPct)) continue;
        slots--;
        signals.push({
          strategyId: ID, symbol, side: 'long', score: 1 - i / list.length, exitProfile: 'trend',
          stopDistancePct: Math.min(0.30, Math.max(0.08, p.stopAtr * atrPct)),
          reason: `${p.invert ? 'Highest' : 'Lowest'} ${p.L}-day ${p.metric}: rank ${i + 1} of ${list.length}`, meta: { rank: i + 1, risk },
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
const allTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').flatMap((f) => readLines(join(trialDir, f)));
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

const WF = { from: Date.UTC(2019, 0, 1), trainDays: 730, testDays: 180, minTrainTrades: 10 };
const OOS_FROM = Date.UTC(2021, 0, 1);
const MAX_TRIALS = 50;

function logTrial(trial, note) {
  const params = { ...DEFAULTS, ...trial.params };
  const lines = existsSync(trialFile) ? readLines(trialFile) : [];
  if (lines.some((l) => JSON.stringify(l.params) === JSON.stringify(params))) return;
  if (lines.length >= MAX_TRIALS) throw new Error('Trial budget of 50 is spent');
  const line = trialRecord({ agent: AGENT, family: FAMILY, strategyId: ID, timeframe: '1d', trial: { ...trial, params }, note, ts: new Date().toISOString() });
  appendFileSync(trialFile, `${JSON.stringify(line)}\n`);
}

function describe(run) {
  const s = run.summary;
  const years = {};
  let prev = run.equity[0].equity;
  for (const e of run.equity) {
    const y = new Date(e.t).getUTCFullYear();
    years[y] = (years[y] ?? 1) * (e.equity / prev);
    prev = e.equity;
  }
  const reasons = {}, tiers = { 1: 0, 2: 0, 3: 0 }, held = {};
  for (const t of run.trades) if (!t.partial) { reasons[t.reasonCode] = (reasons[t.reasonCode] || 0) + 1; held[t.symbol] = (held[t.symbol] || 0) + 1; }
  let turnover = 0;
  for (const f of run.fills) {
    const notional = f.qty * f.price;
    turnover += notional;
    tiers[tierFor(f.symbol, Math.min(f.t, HOLDOUT_START - 1))] += notional;
  }
  const avgEquity = run.equity.reduce((a, e) => a + e.equity, 0) / run.equity.length;
  return {
    totalReturn: s.totalReturn, cagr: s.cagr, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, calmar: s.calmar,
    closedTrades: s.closedTrades, positionChanges: s.positionChanges, winRate: s.winRate, profitFactor: s.profitFactor, exposure: s.exposure,
    simReEnables: s.simReEnables, stuckAtEnd: s.stuckAtEnd,
    years: Object.fromEntries(Object.entries(years).map(([y, v]) => [y, +(v - 1).toFixed(4)])),
    costs: run.costs, reasons, turnoverPerYear: turnover / avgEquity / (run.equity.length / 365),
    tierShare: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, +(v / (turnover || 1)).toFixed(3)])),
    topCoin: s.topCoin, topCoinShare: s.topCoinShare, topYear: s.topYear, topYearShare: s.topYearShare,
    mostTraded: Object.entries(held).sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

function setup() {
  const bars = prepareMarket(loadBars({ timeframe: '1d' }));
  return { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk: RISK_CONFIG } };
}

const short = (d) => `Sharpe ${d.sharpe.toFixed(2)} ret ${pct(d.totalReturn)} dd ${pct(d.maxDrawdown)} n ${d.closedTrades} pc ${d.positionChanges} expo ${pct(d.exposure)} ${JSON.stringify(d.years)}`;

function stage1() {
  const base = setup();
  const started = performance.now();
  const r = walkForward({ ...base, ...WF, strategyFactory: lowvol, grid: GRID });
  console.log(`walk-forward ${((performance.now() - started) / 1000).toFixed(0)}s, ${r.picks.length} folds, ${r.trials.length} trials`);
  for (const t of r.trials) logTrial(t, 'stage1');
  for (const p of r.picks) console.log(`  ${new Date(p.testFrom).toISOString().slice(0, 10)} ${JSON.stringify(p.params)} train ${p.trainScore?.toFixed(2)}`);
  console.log('trials by Sharpe (fixed params over OOS; diagnosis only):');
  for (const t of [...r.trials].sort((a, b) => b.sharpe - a.sharpe).slice(0, 8)) {
    console.log(`  ${t.sharpe.toFixed(2)} dd ${pct(t.maxDrawdown)} ret ${pct(t.totalReturn)} n ${t.closedTrades} ${JSON.stringify(t.params)}`);
  }
  const center = r.plateau?.params ?? {};
  const audit = auditLookahead({ ...base, rebuild: () => lowvol(center), from: OOS_FROM, cuts: 4 });
  console.log(`audit (rebuild) ${audit.ok ? 'clean' : JSON.stringify(audit.cuts)}`);
  const trials = allTrials();
  const verdict = checkDevCriteria(r, { trials });
  console.log(`global trials ${trials.length}`);
  console.log(verdict.report);
  const out = {
    center, plateau: r.plateau, picks: r.picks, oos: describe(r.oos), stress2x: describe(r.stress2x), benchmark: r.benchmark && describe(r.benchmark),
    audit: audit.ok, globalTrials: trials.length, criteria: verdict.criteria, pass: verdict.pass, trials: r.trials,
  };
  writeFileSync(join(tmpDir, 'stage1.json'), JSON.stringify(out, null, 1));
  console.log('OOS', short(out.oos));
  console.log('2x ', short(out.stress2x));
  if (out.benchmark) console.log('B&H', short(out.benchmark));
}

const asTrial = (params, s) => ({ params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn });

function stage2() {
  const base = setup();
  const { center } = JSON.parse(readFileSync(join(tmpDir, 'stage1.json'), 'utf8'));
  const variants = {
    center: {}, top20: { topN: 20 }, top50: { topN: 50 }, stop2: { stopAtr: 2 }, stop5: { stopAtr: 5 }, rebal14: { rebal: 14 },
    noBuffer: { bufferMult: 1 }, trendExits: { exits: 'trend' },
    highvol: { invert: true }, volume: { metric: 'volume' }, majors: { majors: true, K: 2 },
  };
  const rows = {};
  for (const [name, change] of Object.entries(variants)) {
    const params = { ...center, ...change };
    const run = runSim({ ...base, strategies: [lowvol(params)], from: OOS_FROM, collectEvents: false });
    if (name !== 'center') logTrial(asTrial(params, run.summary), `stage2 ${name}`);
    rows[name] = describe(run);
    console.log(`${name.padEnd(10)} ${short(rows[name])}`);
  }
  writeFileSync(join(tmpDir, 'stage2.json'), JSON.stringify(rows, null, 1));
}

/** Diagnosis only, no sim and no parameter choice: weekly forward return by trailing 30-day vol quintile. */
function quintiles() {
  const raw = loadBars({ timeframe: '1d' });
  const L = 30, H = 7, N = 30;
  const index = new Map([...raw].map(([s, b]) => [s, new Map(b.map((x, i) => [x.t, i]))]));
  const acc = {};
  for (let t = OOS_FROM; t < Date.UTC(2024, 11, 1); t += H * DAY) {
    const rows = [];
    for (const symbol of pointInTimeUniverse(t + DAY, { topN: N, timeframe: '1d' })) {
      const b = raw.get(symbol), i = index.get(symbol).get(t);
      if (i === undefined || i < L) continue;
      let s = 0, s2 = 0;
      for (let k = i - L + 1; k <= i; k++) { const r = Math.log(b[k].c / b[k - 1].c); s += r; s2 += r * r; }
      const vol = Math.sqrt(Math.max(0, (s2 - (s * s) / L) / (L - 1)));
      const end = Math.min(i + H, b.length - 1);
      const dead = b.length - 1 < i + H;
      rows.push({ vol, fwd: (b[end].c * (dead ? 0.9 : 1)) / b[i].c - 1 });
    }
    if (rows.length < 15) continue;
    rows.sort((a, b) => a.vol - b.vol);
    const y = new Date(t).getUTCFullYear();
    const q = rows.length / 5;
    for (let k = 0; k < 5; k++) {
      const part = rows.slice(Math.round(k * q), Math.round((k + 1) * q));
      const m = part.reduce((a, r) => a + r.fwd, 0) / part.length;
      for (const key of [y, 'all']) ((acc[key] ??= [[], [], [], [], []])[k]).push(m);
    }
  }
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const sd = (x) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };
  for (const [key, q] of Object.entries(acc)) {
    const spread = q[0].map((v, i) => v - q[4][i]);
    const m = mean(spread);
    const tstat = m / (sd(spread) / Math.sqrt(spread.length));
    const ratio = q.map((x) => (mean(x) / sd(x)).toFixed(2));
    console.log(`${key}: mean ${q.map((x) => pct(mean(x), 2)).join(' ')} | mean/sd ${ratio.join(' ')} | Q1-Q5 ${pct(m, 2)} t ${tstat.toFixed(2)} n ${spread.length}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(tmpDir, { recursive: true });
  ({ stage1, stage2, quintiles })[process.argv[2] ?? 'stage1']();
}
