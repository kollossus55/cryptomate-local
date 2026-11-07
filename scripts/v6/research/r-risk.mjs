// r-risk: are the v6Risk defaults calibrated, or do they starve strategies?
//   node scripts/v6/research/r-risk.mjs sweep | wf | study
// Findings: docs/rebuild/research-r-risk.md. This family freezes no strategy; its output
// is RECOMMENDED_RISK_CONFIG. The reference strategies are measuring tools, not candidates.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import * as realRisk from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { seededRandom } from '../../../shared/trading/v6Stats.js';
import { btcAboveSma, defineStrategy } from '../../../shared/trading/v6Strategies.js';

const { DEFAULT_RISK_CONFIG, clampRiskConfig } = realRisk;
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const AGENT = 'r-risk';
const FAMILY = 'portfolio-risk-settings';
const trialFile = join(root, 'data/research/v6/trials-r-risk.jsonl');
const runDir = join(root, 'data/tmp/r-risk/runs');
const FROM = Date.UTC(2018, 6, 1);
const DAY = 86400000;

// ---------- reference strategies ----------

const atrStop = (ctx, symbol, close) => {
  const a = ctx.ind(symbol, 'atr', 14);
  return Number.isFinite(a) ? Math.min(0.25, Math.max(0.05, (3 * a) / close)) : null;
};
const closeOf = (ctx, symbol) => {
  const b = ctx.bars.get(symbol);
  return b?.length ? b[b.length - 1].c : NaN;
};

export const refBtcSma = () => btcAboveSma({ n: 100, stopPct: 0.20 });

export const refMom20 = ({ n = 30 } = {}) => defineStrategy({
  id: 'ref_mom20', name: 'Reference: top 20 momentum', timeframe: '1d', params: { n }, warmupBars: 100,
  universe: { kind: 'top', n: 20 },
  signals(ctx) {
    const out = [];
    for (const symbol of new Set([...ctx.universe, ...ctx.positions.keys()])) {
      const r = ctx.ind(symbol, 'roc', ctx.params.n);
      if (!Number.isFinite(r)) continue;
      out.push({
        strategyId: 'ref_mom20', symbol, side: r > 0 ? 'long' : 'flat', score: Math.min(1, Math.max(0, r)),
        stopDistancePct: 0.15, exitProfile: 'trend', reason: `${ctx.params.n}d momentum`, meta: {},
      });
    }
    return out;
  },
});

export const refBrk20 = ({ n = 50 } = {}) => defineStrategy({
  id: 'ref_brk20', name: 'Reference: top 20 breakout', timeframe: '1d', params: { n }, warmupBars: 100,
  universe: { kind: 'top', n: 20 },
  signals(ctx) {
    if (ctx.regime?.riskOn !== true) return [];
    const out = [];
    for (const symbol of ctx.universe) {
      const c = closeOf(ctx, symbol);
      const high = ctx.ind(symbol, 'donchianHigh', ctx.params.n, 1);
      const stop = atrStop(ctx, symbol, c);
      if (!(c > high) || stop === null) continue;
      out.push({
        strategyId: 'ref_brk20', symbol, side: 'long', score: Math.min(1, c / high - 1),
        stopDistancePct: stop, exitProfile: 'trend', reason: `Close above ${ctx.params.n}d high`, meta: {},
      });
    }
    return out;
  },
});

/** FNV-1a to [0,1): a fixed coin flip per symbol and bar, using nothing about prices. */
const coin = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 4294967296;
};

export const refRand20 = ({ p = 0.02 } = {}) => defineStrategy({
  id: 'ref_rand20', name: 'Control: top 20 random entries', timeframe: '1d', params: { p }, warmupBars: 100,
  universe: { kind: 'top', n: 20 },
  signals(ctx) {
    const out = [];
    for (const symbol of ctx.universe) {
      if (coin(`${symbol}|${ctx.barT}`) >= ctx.params.p) continue;
      const stop = atrStop(ctx, symbol, closeOf(ctx, symbol));
      if (stop === null) continue;
      out.push({
        strategyId: 'ref_rand20', symbol, side: 'long', score: 0.5, stopDistancePct: stop,
        exitProfile: 'trend', reason: 'Random control entry', meta: {},
      });
    }
    return out;
  },
});

const REFS = { R1: refBtcSma, R2: refMom20, R3: refBrk20, R4: refRand20 };

// ---------- configurations ----------

const MAX = { riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, volTargetAnnual: 0.20 };
const CONFIGS = {
  A: {},
  B: { riskPerTradePct: 0.0025 },
  C: { riskPerTradePct: 0.01 },
  D: { riskPerTradePct: 0.01, maxOpenRiskPct: 0.05 },
  E: MAX,
  F: { ...MAX, volTargetAnnual: 0.10 },
  H: { ...MAX, ladderHalfPct: 0.075, ladderQuarterPct: 0.125, ladderNoEntryPct: 0.175, ladderHaltPct: 0.20 },
  I: { ...MAX, ladderHalfPct: 0.03, ladderQuarterPct: 0.06, ladderNoEntryPct: 0.09, ladderHaltPct: 0.12 },
  J: MAX, K: MAX, L: MAX, M: MAX,
  // Added after the first sweep, from the 4 spare trials: sizing with the rung-3 stick removed,
  // and the window behind core-sim's 2% figure.
  N: {}, X: {},
};
const MODES = { J: { noLadder: true }, K: { noBreaker: true }, L: { noPeriod: true }, M: { reEnableDays: 30 }, N: { noLadder: true } };

export const FROZEN_CANDIDATES = [];
// The defaults, deliberately: no tested setting passed the pre-registered rules, on the frozen
// or the fixed harness (doc section 0), and default
// size with the ladder off already draws down 19-29% on two of three references.
export const RECOMMENDED_RISK_CONFIG = Object.freeze({ ...DEFAULT_RISK_CONFIG });

const riskConfig = (overrides) => {
  const clamped = clampRiskConfig({ ...DEFAULT_RISK_CONFIG, ...overrides });
  for (const [k, v] of Object.entries(overrides)) {
    if (clamped[k] !== v) throw new Error(`${k}=${v} is outside HARD_CEILINGS`);
  }
  return clamped;
};

/**
 * Real v6Risk with a recorder. With no mode it is a pure pass-through, so sizing is
 * unchanged. A mode neutralises one rule, for what-is-it-worth diagnosis only.
 */
function recordingRisk(mode = {}) {
  const log = { accepted: {}, rejected: {}, belowMinBy: {}, notionalPct: [], notional: [], series: [], reEnables: [] };
  let stuckSince = null;
  const risk = {
    ...realRisk,
    updateRiskState(rs, input) {
      const prev = mode.noLadder && input.equity > 0 ? { ...rs, equityHigh: input.equity, drawdown: 0, rung: 0 } : rs;
      const out = realRisk.updateRiskState(prev, input);
      let s = out.riskState;
      if (mode.noBreaker) s = { ...s, market: { ...s.market, tripped: false, reason: null } };
      if (mode.noPeriod) s = { ...s, day: { ...s.day, tripped: false }, week: { ...s.week, tripped: false } };
      if (mode.reEnableDays) {
        if (s.rung >= 3) stuckSince ??= input.t; else stuckSince = null;
        if (stuckSince !== null && input.t - stuckSince >= mode.reEnableDays * DAY) {
          const r = realRisk.humanReEnable(s, { t: input.t, equity: input.equity, by: 'sim-policy', confirm: true });
          if (r.ok) { log.reEnables.push({ t: input.t, equity: input.equity, fromRung: s.rung }); s = r.riskState; stuckSince = null; }
        }
      }
      log.series.push([input.t, s.rung, s.market.tripped ? 1 : 0, s.day.tripped || s.week.tripped ? 1 : 0, s.halt.active ? 1 : 0]);
      return { ...out, riskState: s };
    },
    sizeEntry(args) {
      const r = realRisk.sizeEntry(args);
      if (r.rejected) {
        log.rejected[r.reason] = (log.rejected[r.reason] || 0) + 1;
        if (r.reason === 'below_min_notional') log.belowMinBy[r.limit] = (log.belowMinBy[r.limit] || 0) + 1;
      } else {
        log.accepted[r.limit] = (log.accepted[r.limit] || 0) + 1;
        log.notional.push(r.notional);
        log.notionalPct.push(r.notional / args.equity);
      }
      return r;
    },
  };
  return { risk, log };
}

// ---------- metrics ----------

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function curveStats(equity) {
  let peak = -Infinity, under = 0, sq = 0, inMkt = 0, grossIn = 0, open = 0;
  const gross = [];
  const yearEnd = {};
  for (const e of equity) {
    peak = Math.max(peak, e.equity);
    const dd = 1 - e.equity / peak;
    if (dd > 0.001) under++;
    sq += dd * dd;
    const g = e.gross / e.equity;
    gross.push(g);
    open += e.open;
    if (e.open > 0) { inMkt++; grossIn += g; }
    yearEnd[new Date(e.t).getUTCFullYear()] = e.equity;
  }
  const byYear = {};
  let prev = equity[0].equity;
  for (const [y, v] of Object.entries(yearEnd)) { byYear[y] = v / prev - 1; prev = v; }
  return {
    timeInMarket: inMkt / equity.length, exposureWhenIn: inMkt ? grossIn / inMkt : 0, exposureP95: quantile(gross, 0.95),
    exposureMax: Math.max(...gross), avgOpen: open / equity.length, underwater: under / equity.length,
    ulcer: Math.sqrt(sq / equity.length), byYear,
  };
}

function record(key, ref, cfgName, run, log, extra = {}) {
  const s = run.summary;
  const out = {
    key, ref, config: cfgName, ...extra,
    totalReturn: s.totalReturn, cagr: s.cagr, sharpe: s.sharpe, sortino: s.sortino, volatility: s.volatility, maxDrawdown: s.maxDrawdown, calmar: s.calmar,
    closedTrades: s.closedTrades, winRate: s.winRate, avgR: s.avgR, avgBarsHeld: s.avgBarsHeld, exposure: s.exposure, halted: s.halted,
    costs: run.costs, eventCounts: s.eventCounts, ...curveStats(run.equity),
    equity: run.equity.map((e) => [e.t, e.equity, e.gross, e.open]),
  };
  if (log) {
    const blocked = {};
    for (const e of run.events) if (e.type === 'entries_blocked') blocked[e.message] = (blocked[e.message] || 0) + 1;
    const n = log.series.length || 1;
    const rungDays = [0, 0, 0, 0, 0];
    for (const r of log.series) rungDays[r[1]]++;
    Object.assign(out, {
      accepted: log.accepted, rejected: log.rejected, belowMinBy: log.belowMinBy, blockedDays: blocked,
      rungShare: rungDays.map((d) => d / n), breakerShare: log.series.filter((r) => r[2]).length / n,
      periodShare: log.series.filter((r) => r[3]).length / n, haltShare: log.series.filter((r) => r[4]).length / n,
      medianNotionalPct: quantile(log.notionalPct, 0.5), medianNotional: quantile(log.notional, 0.5), minNotionalSeen: log.notional.length ? Math.min(...log.notional) : null,
      underTen: log.notional.filter((x) => x < 10).length, under25: log.notional.filter((x) => x < 25).length, under100: log.notional.filter((x) => x < 100).length,
      reEnables: log.reEnables, series: log.series,
      ladderEvents: run.events.filter((e) => e.type === 'ladder_changed' || e.type === 'drawdown_halt').map((e) => ({ t: e.t, type: e.type, ...e.data })),
      entries: run.trades.filter((tr) => !tr.partial).map((tr) => [tr.symbol, tr.entryTime, tr.positionPnl, tr.rMultiple, tr.reasonCode]),
    });
  }
  return out;
}

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function logTrial({ strategyId, trial, note }) {
  mkdirSync(dirname(trialFile), { recursive: true });
  const seen = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
  if (seen.has(`${strategyId}|${JSON.stringify(trial.params)}`)) return;
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
}

// ---------- the sweep ----------

function planned() {
  const list = [];
  const add = (ref, config, initialEquity = 10000) => list.push({ ref, config, initialEquity });
  for (const ref of ['R2', 'R3']) for (const c of 'ABCDEFHIJKL') add(ref, c);
  for (const c of 'AEHIJK') add('R4', c);
  for (const c of 'AE') add('R1', c);
  for (const eq of [1000, 1000000]) { add('R3', 'A', eq); add('R3', 'E', eq); add('R2', 'A', eq); }
  for (const ref of ['R2', 'R3']) add(ref, 'M');
  for (const ref of ['R2', 'R3']) add(ref, 'FW');
  for (const ref of ['R2', 'R3', 'R4']) add(ref, 'N');
  list.push({ ref: 'R2', config: 'X', initialEquity: 10000, from: Date.UTC(2022, 0, 1) });
  return list;
}

function sweep(market) {
  mkdirSync(runDir, { recursive: true });
  const costs = { tierFn: tierFor };
  const plan = planned();
  console.log(`${plan.length} runs planned`);
  for (const [i, { ref, config, initialEquity, from = FROM }] of plan.entries()) {
    const key = `${ref}-${config}-${initialEquity}`;
    const file = join(runDir, `${key}.json`);
    if (existsSync(file)) continue;
    const started = performance.now();
    const strategy = REFS[ref]();
    let run, log = null, cfgParams;
    if (config === 'FW') {
      // Diagnosis only: 5% of equity per coin, no limits. Never a result.
      run = runSim({ strategies: [strategy], bars: market, from, config: { initialEquity }, costs, universeFn: pointInTimeUniverse, modules: { risk: fullWeightRisk({ weight: 0.05 }) } });
      cfgParams = { fullWeight: 0.05 };
    } else {
      const rec = recordingRisk(MODES[config]);
      log = rec.log;
      cfgParams = CONFIGS[config];
      run = runSim({ strategies: [strategy], bars: market, from, config: { initialEquity, risk: riskConfig(cfgParams) }, costs, universeFn: pointInTimeUniverse, modules: { risk: rec.risk } });
    }
    writeFileSync(file, JSON.stringify(record(key, ref, config, run, log, { initialEquity })));
    const s = run.summary;
    logTrial({
      strategyId: strategy.id,
      trial: { params: { config, initialEquity, ...(from === FROM ? {} : { from }), ...cfgParams }, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn },
      note: MODES[config] || config === 'FW' ? 'diagnosis only, not a result' : null,
    });
    console.log(`${i + 1}/${plan.length} ${key.padEnd(22)} ret ${(s.totalReturn * 100).toFixed(1)}% sh ${s.sharpe.toFixed(2)} dd ${(s.maxDrawdown * 100).toFixed(1)}% exp ${(s.exposure * 100).toFixed(1)}% trades ${s.closedTrades} ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
}

// ---------- studies: read saved runs, add no parameter sets, so they are not trials ----------

const loadRun = (key) => JSON.parse(readFileSync(join(runDir, `${key}.json`), 'utf8'));
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** First crossing of each threshold in each drawdown episode, and what the same curve did next. */
function shadowLadder(equity, thresholds = [0.05, 0.10, 0.15, 0.20]) {
  const out = [];
  let high = -Infinity, hit = new Set();
  const at = (i) => (i < equity.length ? equity[i][1] : null);
  for (let i = 0; i < equity.length; i++) {
    const eq = equity[i][1];
    if (eq > high) { high = eq; hit = new Set(); continue; }
    for (const th of thresholds) {
      if (hit.has(th) || 1 - eq / high < th) continue;
      hit.add(th);
      const fwd = (d) => (at(i + d) === null ? null : at(i + d) / eq - 1);
      let low = eq, recovered = null;
      for (let j = i; j < equity.length; j++) {
        if (j <= i + 365) low = Math.min(low, equity[j][1]);
        if (recovered === null && equity[j][1] >= high) recovered = j - i;
      }
      out.push({ th, date: iso(equity[i][0]), f30: fwd(30), f90: fwd(90), f180: fwd(180), f365: fwd(365), worstNext365: low / eq - 1, daysToHigh: recovered });
    }
  }
  return out;
}

/** Stationary block bootstrap of daily returns: chance a path of `days` reaches each drawdown. */
function bootstrapRungs(equity, days, { paths = 2000, block = 20, seed = 7 } = {}) {
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i][1] / equity[i - 1][1] - 1);
  const rand = seededRandom(seed);
  const counts = { 0.05: 0, 0.10: 0, 0.15: 0, 0.20: 0 };
  for (let p = 0; p < paths; p++) {
    let idx = Math.floor(rand() * rets.length), eq = 1, high = 1, worst = 0;
    for (let d = 0; d < days; d++) {
      eq *= 1 + rets[idx];
      high = Math.max(high, eq);
      worst = Math.max(worst, 1 - eq / high);
      idx = rand() < 1 / block ? Math.floor(rand() * rets.length) : (idx + 1) % rets.length;
    }
    for (const th of Object.keys(counts)) if (worst >= Number(th)) counts[th]++;
  }
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / paths]));
}

/** Breaker episodes from the real engine on BTC alone, so they do not depend on any strategy. */
function breakerEpisodes(bars, barMs) {
  let rs = realRisk.initialRiskState(10000, bars[0].t);
  const episodes = [];
  let open = null, days = 0;
  for (let i = 50; i < bars.length; i++) {
    const t = bars[i].t + barMs;
    rs = realRisk.updateRiskState(rs, { t, equity: 10000, btcBars: bars.slice(Math.max(0, i - 60), i + 1), dataHealth: { ok: true }, config: DEFAULT_RISK_CONFIG }).riskState;
    if (t < FROM) continue;
    days += rs.market.tripped ? barMs / DAY : 0;
    if (rs.market.tripped && !open) open = { start: t, reason: rs.market.reason, price: bars[i].c };
    if (!rs.market.tripped && open) { episodes.push({ ...open, end: t }); open = null; }
  }
  if (open) episodes.push({ ...open, end: null });
  return { episodes, days };
}

function breakerStudy(market) {
  const daily = market.series.get('BTCUSDT').bars;
  // Measured from the close that tripped the breaker, on that episode's own bars. Anchoring a
  // 4h trip on the prior daily close would put part of the crash inside the "after" window.
  const forwardOn = (bars, barMs) => {
    const closeAt = new Map(bars.map((b) => [b.t + barMs, b.c]));
    return (t, d) => {
      const a = closeAt.get(t), b = closeAt.get(t + d * DAY);
      return a && b ? b / a - 1 : null;
    };
  };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const horizons = [1, 3, 7, 14, 30];
  const summary = (times, forward) => Object.fromEntries(horizons.map((d) => {
    const xs = times.map((t) => forward(t, d)).filter((x) => x !== null);
    return [`d${d}`, { mean: mean(xs), median: quantile(xs, 0.5), up: mean(xs.map((x) => (x > 0 ? 1 : 0))), n: xs.length }];
  }));
  const allDays = daily.filter((b) => b.t >= FROM).map((b) => b.t + DAY);
  const d1 = breakerEpisodes(daily, DAY);
  const fwd1d = forwardOn(daily, DAY);
  const h4bars = loadBars({ symbols: ['BTCUSDT'], timeframe: '4h' }).get('BTCUSDT');
  const h4 = breakerEpisodes(h4bars, 4 * 3600000);

  // Top-20 basket, point in time, equal weight: what a long-only book would have bought.
  const basket = (t, d) => {
    const xs = [];
    for (const symbol of pointInTimeUniverse(t, { topN: 20, timeframe: '1d' })) {
      const list = market.series.get(symbol)?.bars;
      if (!list) continue;
      const day = Math.floor(t / DAY) * DAY;
      const a = list.find((b) => b.t === day - DAY), z = list.find((b) => b.t === day - DAY + d * DAY);
      if (a && z) xs.push(z.c / a.c - 1);
    }
    return xs.length ? mean(xs) : null;
  };
  const basketMean = (times, d) => mean(times.map((t) => basket(t, d)).filter((x) => x !== null));
  const sample = allDays.filter((_, i) => i % 7 === 0);
  const starts = d1.episodes.map((e) => e.start);
  return {
    daily: { episodes: d1.episodes.length, days: d1.days, list: d1.episodes.map((e) => `${iso(e.start)} ${e.reason} to ${e.end ? iso(e.end) : 'end'}`), after: summary(starts, fwd1d) },
    fourHour: { episodes: h4.episodes.length, days: h4.days, after: summary(h4.episodes.map((e) => e.start), forwardOn(h4bars, 4 * 3600000)) },
    unconditional: summary(allDays, fwd1d),
    basket: { after7: basketMean(starts, 7), after30: basketMean(starts, 30), all7: basketMean(sample, 7), all30: basketMean(sample, 30) },
  };
}

/** Entries the breaker would have blocked, read from the run where it was neutralised. */
function blockedEntries(ref) {
  const on = new Set(loadRun(`${ref}-A-10000`).series.filter((r) => r[2]).map((r) => r[0]));
  const trades = loadRun(`${ref}-K-10000`).entries;
  const part = (list) => {
    const rs = list.map((e) => e[3]).filter(Number.isFinite);
    return { n: list.length, pnl: list.reduce((a, e) => a + e[2], 0), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
  };
  return { blocked: part(trades.filter((e) => on.has(e[1]))), rest: part(trades.filter((e) => !on.has(e[1]))) };
}

function sizingRule() {
  const get = (ref, c) => { const f = join(runDir, `${ref}-${c}-10000.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  return [...'ABCDEF'].map((c) => {
    const rows = ['R2', 'R3', 'R4'].map((ref) => get(ref, c));
    const known = rows.filter(Boolean);
    const sharpeOk = ['R2', 'R3'].every((ref) => get(ref, c).sharpe >= get(ref, 'A').sharpe - 0.10);
    return {
      config: c, r4Run: rows[2] !== null, worstDD: Math.max(...known.map((r) => r.maxDrawdown)),
      ddOk: known.every((r) => r.maxDrawdown <= 0.15), halted: known.some((r) => r.halted), sharpeOk,
      pass: rows[2] !== null && known.every((r) => r.maxDrawdown <= 0.15 && !r.halted) && sharpeOk,
    };
  });
}

/** The smallest account where a rung does not refuse every entry: the deadlock line. */
function minEquityTable(cfg = DEFAULT_RISK_CONFIG) {
  const cost = 2 * 0.001 + 2 * 0.0025 + cfg.stopGapSlipPct; // Tier 3 loss allowance, 0.8%
  const rows = [];
  for (const stop of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    const line = { stop };
    for (const [name, mult] of [['full', 1], ['half', 0.5], ['quarter', 0.25], ['quarterPaperHalf', 0.125]]) {
      line[name] = (cfg.minNotional * (stop + cost)) / (cfg.riskPerTradePct * mult);
    }
    rows.push(line);
  }
  return rows;
}

function study(market) {
  const out = { shadow: {}, boot: {}, reEnable: {}, blocked: {} };
  for (const key of ['R2-N', 'R3-N', 'R4-N', 'R2-J', 'R3-J', 'R4-J', 'R2-FW', 'R3-FW']) {
    const r = loadRun(`${key}-10000`);
    out.shadow[key] = shadowLadder(r.equity);
    out.boot[key] = { y1: bootstrapRungs(r.equity, 365), y3: bootstrapRungs(r.equity, 1095) };
  }
  for (const ref of ['R2', 'R3']) {
    const r = loadRun(`${ref}-M-10000`);
    out.reEnable[ref] = { list: r.reEnables.map((e) => ({ date: iso(e.t), equity: e.equity, fromRung: e.fromRung })), totalReturn: r.totalReturn, sharpe: r.sharpe, maxDrawdown: r.maxDrawdown };
  }
  for (const ref of ['R2', 'R3', 'R4']) out.blocked[ref] = blockedEntries(ref);
  out.breaker = breakerStudy(market);
  out.sizing = sizingRule();
  out.minEquity = minEquityTable();
  writeFileSync(join(root, 'data/tmp/r-risk/study.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}

function wf(market) {
  const cfg = riskConfig(RECOMMENDED_RISK_CONFIG);
  const setup = { bars: market, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk: cfg } };
  const trialDir = dirname(trialFile);
  const jobs = [['ref_mom20', refMom20, { n: [20, 30, 60] }, 30], ['ref_brk20', refBrk20, { n: [20, 50, 100] }, 50]];
  const report = {};
  for (const [id, factory, grid, base] of jobs) {
    const result = walkForward({ ...setup, strategyFactory: factory, grid, from: FROM, trainDays: 730, testDays: 180 });
    for (const trial of result.trials) logTrial({ strategyId: id, trial: { ...trial, params: { config: 'WF-recommended', ...trial.params } }, note: 'walkForward fixed-parameter OOS run' });
    const audit = auditLookahead({ ...setup, rebuild: () => factory({ n: base }), from: FROM, cuts: 3 });
    const trials = readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(trialDir, f)));
    const verdict = checkDevCriteria(result, { trials });
    const s = result.summary;
    const flat = result.oos.equity.filter((e) => e.open === 0).length / result.oos.equity.length;
    report[id] = {
      picks: result.picks.map((p) => `${iso(p.testFrom)} n=${p.params?.n ?? 'cash'}`), audit: audit.ok, auditDetail: audit.cuts.filter((c) => !c.ok),
      totalReturn: s.totalReturn, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, exposure: s.exposure, closedTrades: s.closedTrades, flatShare: flat,
      rung: result.oos.riskState.rung, costs: result.oos.costs, byYear: curveStats(result.oos.equity).byYear, trialCount: trials.length, report: verdict.report, pass: verdict.pass,
      benchmark: result.benchmark?.summary ? { totalReturn: result.benchmark.summary.totalReturn, sharpe: result.benchmark.summary.sharpe, maxDrawdown: result.benchmark.summary.maxDrawdown } : null,
    };
    console.log(id, JSON.stringify(report[id], null, 1));
  }
  writeFileSync(join(root, 'data/tmp/r-risk/wf.json'), JSON.stringify(report, null, 1));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const mode = process.argv[2] || 'sweep';
  const started = performance.now();
  const market = prepareMarket(loadBars({ timeframe: '1d' }));
  console.log(`bars loaded: ${market.series.size} symbols, ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (mode === 'sweep') sweep(market);
  else if (mode === 'study') study(market);
  else if (mode === 'wf') wf(market);
  else if (mode === 'smoke') {
    const rec = recordingRisk();
    const run = runSim({ strategies: [refBrk20()], bars: market, from: Date.UTC(2019, 0, 1), to: Date.UTC(2019, 2, 1), config: { risk: riskConfig({}) }, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, modules: { risk: rec.risk } });
    console.log('smoke ok', run.equity.length, 'bars', rec.log.series.length, 'risk ticks');
  }
}
