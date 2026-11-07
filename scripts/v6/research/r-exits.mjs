// Exit-rule research. Pre-registration and results: docs/rebuild/research-r-exits.md
//   node scripts/v6/research/r-exits.mjs job <random:SEED|breakout|dip> [1d|4h] [only=id,id] [diag]
//   node scripts/v6/research/r-exits.mjs report [log]    tables to data/tmp/r-exits/report.md
//   node scripts/v6/research/r-exits.mjs confirm [log]   the five reserved trials
// A job writes to data/tmp/r-exits/. This file exports no tradable strategy of its own:
// its output is RECOMMENDED_EXIT_PROFILES, values for a human to copy into v6Exits.js.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { seededRandom } from '../../../shared/trading/v6Stats.js';
import { defineStrategy } from '../../../shared/trading/v6Strategies.js';

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const tmp = join(here, '../../../data/tmp/r-exits');

const FROM = Date.UTC(2018, 6, 1);
const MIN_STOP = 0.006, MAX_STOP = 0.29;
const DIAG_RISK = 0.0015;
const RANDOM_P_PER_DAY = 0.02;
export const SEEDS = [1, 2, 3, 4, 5];

// ---------- exit configs ----------

const mk = ({ stop = 2, be = null, chand = 4, time = 20, partial = null }) => ({
  stopAtr: stop,
  profile: 'swing',
  overrides: {
    breakEven: { enabled: be !== null, triggerR: be ?? 1, bufferPct: 0.05 },
    trail: { enabled: chand !== null, atrMult: chand ?? 4, activateR: 1, tightenFactor: 0.5 },
    spikeGuard: { enabled: true, atrMult: 6 },
    timeStop: { enabled: time !== null, bars: time ?? 20, minR: 0, maxBars: null },
    signalExit: { enabled: true, onFlat: true, onOpposite: true },
    regimeExit: { enabled: false, action: 'exit' },
    partials: partial ? [{ atR: partial, fraction: 0.5 }] : [],
  },
});

export const CONFIGS = {
  C: mk({}),
  stop1: mk({ stop: 1 }), stop1_5: mk({ stop: 1.5 }), stop3: mk({ stop: 3 }), stop4: mk({ stop: 4 }),
  be0_5: mk({ be: 0.5 }), be1: mk({ be: 1 }), be2: mk({ be: 2 }),
  chOff: mk({ chand: null }), ch2: mk({ chand: 2 }), ch3: mk({ chand: 3 }), ch6: mk({ chand: 6 }),
  tOff: mk({ time: null }), t10: mk({ time: 10 }), t40: mk({ time: 40 }),
  p1: mk({ partial: 1 }), p2: mk({ partial: 2 }),
  bare: mk({ chand: null, time: null }),
  bare_be1: mk({ chand: null, time: null, be: 1 }),
  full: mk({ be: 1, partial: 2 }),
  ph_trend: { stopAtr: 3, profile: 'trend', overrides: undefined },
  ph_swing: { stopAtr: 2, profile: 'swing', overrides: undefined },
  ph_revert: { stopAtr: 2, profile: 'revert', overrides: undefined },
  // Reserved confirmation trials, chosen after the grid results.
  trendRec: mk({ stop: 3, chand: 6, time: 40 }),
  t120: mk({ time: 120 }),
};
const CONFIRM_ONLY = ['trendRec', 't120'];

export const SUBSETS = {
  random: Object.keys(CONFIGS).filter((id) => !CONFIRM_ONLY.includes(id)),
  breakout: ['C', 'stop1_5', 'stop3', 'be1', 'be2', 'chOff', 'ch3', 'ch6', 'tOff', 't40', 'p2', 'bare', 'ph_trend', 'ph_swing'],
  dip: ['C', 'be1', 'chOff', 'ch2', 't10', 'p1', 'bare', 'ph_revert'],
};

// ---------- entries ----------

/** Pure hash to [0, 1). Depends on nothing but its arguments, so it cannot look ahead. */
function hash01(seed, symbol, t) {
  let h = Math.imul(seed, 2654435761) >>> 0;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 16777619) >>> 0;
  const hi = Math.floor(t / 4294967296), lo = t >>> 0;
  h = Math.imul(h ^ lo, 2246822519) >>> 0;
  h = Math.imul(h ^ hi, 3266489917) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489917) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const last = (ctx, symbol) => { const b = ctx.bars.get(symbol); return b[b.length - 1]; };

const ENTRIES = {
  random: (ctx, symbol, { seed, p }) => hash01(seed, symbol, ctx.barT) < p,
  breakout: (ctx, symbol) => last(ctx, symbol).c > ctx.ind(symbol, 'donchianHigh', 20, 1),
  dip: (ctx, symbol) => {
    const { c } = last(ctx, symbol);
    return c < ctx.ind(symbol, 'donchianLow', 5, 1) && c > ctx.ind(symbol, 'sma', 100);
  },
};

/** params = { cfg } selects the exit config; entry and seed are fixed per factory. */
export const exitTestStrategy = ({ entry, seed = 1, timeframe = '1d', configs = CONFIGS }) => (params) => {
  const cfg = configs[params.cfg];
  if (!cfg) throw new Error(`Unknown exit config ${params.cfg}`);
  const fires = ENTRIES[entry];
  const p = RANDOM_P_PER_DAY / (timeframe === '4h' ? 6 : 1);
  return defineStrategy({
    id: `exit-${entry}`, name: `Exit test on ${entry} entries`, timeframe, params, warmupBars: 120,
    universe: { kind: 'top', n: 20 }, exitOverrides: cfg.overrides,
    signals(ctx) {
      const out = [];
      for (const symbol of ctx.universe) {
        if (ctx.positions.has(symbol) || !fires(ctx, symbol, { seed, p })) continue;
        const a = ctx.ind(symbol, 'atr', 14);
        const { c } = last(ctx, symbol);
        if (!(a > 0)) continue;
        const dist = Math.min(MAX_STOP, Math.max(MIN_STOP, (cfg.stopAtr * a) / c));
        out.push({
          strategyId: `exit-${entry}`, symbol, side: 'long', score: hash01(seed + 7, symbol, ctx.barT),
          stopDistancePct: dist, exitProfile: cfg.profile, reason: `${entry} test entry`,
          meta: { clamped: dist === MAX_STOP },
        });
      }
      return out;
    },
  });
};

// ---------- sizing ----------

const realConfig = { risk: { ...DEFAULT_RISK_CONFIG, maxStopDistancePct: 0.30 } };

/** DIAGNOSIS ONLY: constant money at risk per trade and no ladder, so the sample never stops. */
function equalRisk() {
  return {
    ...fullWeightRisk(),
    sizeEntry({ signal, price, equity, costs }) {
      const c = costs ?? { feePct: 0.001, slipPct: 0.0025 };
      const budget = signal.stopDistancePct + 2 * c.feePct + 2 * c.slipPct + 0.001;
      const notional = (equity * DIAG_RISK) / budget;
      return { qty: notional / price, notional, riskAmount: notional * signal.stopDistancePct, rejected: false, reason: 'equal_risk' };
    },
  };
}

// ---------- per-position records ----------

const lowerT = (bars, t) => {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; }
  return lo;
};

function shuffled(xs, seed) {
  const a = xs.slice();
  let n = 0;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, 'shuffle', ++n) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Folds partial rows into one record per position, adding peak, trough and the placebo. */
function positionsOf(trades, bars, barMs) {
  const dataEnd = Math.max(...[...bars.values()].map((b) => b[b.length - 1].t)) - 3 * 24 * 3600e3;
  const groups = new Map();
  for (const tr of trades) {
    const key = `${tr.symbol}|${tr.entryTime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tr);
  }
  const rows = [];
  for (const list of groups.values()) {
    const end = list[list.length - 1];
    if (end.partial) continue;
    const series = bars.get(end.symbol);
    const qty = list.reduce((a, r) => a + r.qty, 0);
    const notional = qty * end.entryPrice;
    const pnl = list.reduce((a, r) => a + r.pnl, 0);
    const exitPx = list.reduce((a, r) => a + r.qty * r.exitPrice, 0) / qty;
    let peak = end.entryPrice, trough = end.entryPrice;
    for (let i = lowerT(series, end.entryTime); i < series.length && series[i].t <= end.exitTime; i++) {
      peak = Math.max(peak, series[i].h);
      trough = Math.min(trough, series[i].l);
    }
    const dist = (end.positionPnl / end.rMultiple) / notional;
    const c = costFor(end.symbol, tierFor(end.symbol, end.entryTime), { stress: 1, instrument: 'spot' });
    const round = (2 * (c.feePct + c.slipPct)) / 100;
    rows.push({
      sym: end.symbol, et: end.entryTime, xt: end.exitTime,
      bars: Math.max(1, Math.round((end.exitTime - end.entryTime) / barMs)),
      netPct: pnl / notional, dist, budget: dist + round + 0.001, round,
      peakPct: peak / end.entryPrice - 1, troughPct: trough / end.entryPrice - 1, exitPct: exitPx / end.entryPrice - 1,
      reason: end.reasonCode, partial: list.length > 1,
    });
  }
  // Same entries, the same holding times dealt out at random, no stop, plain costs.
  const dealt = shuffled(rows.map((r) => r.bars), 12345);
  rows.forEach((r, n) => {
    const series = bars.get(r.sym);
    const i = lowerT(series, r.et);
    const j = i + dealt[n] - 1;
    // Past the end of the series is only a death if the coin stopped before the data did.
    const dead = j >= series.length && series[series.length - 1].t < dataEnd;
    r.placeboPct = (series[Math.min(j, series.length - 1)].c * (dead ? 0.9 : 1)) / series[i].o - 1 - r.round;
    r.re = r.netPct / r.budget;
  });
  return rows;
}

// ---------- job ----------

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readTrials = () => readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(trialDir, f)));

function job(spec, timeframe, only, diagOnly = false) {
  const [entry, seedText] = spec.split(':');
  const seed = Number(seedText ?? 1);
  const ids = only ?? SUBSETS[entry];
  mkdirSync(tmp, { recursive: true });
  const tag = `${timeframe}-${entry}-${seed}${only ? '-confirm' : ''}`;
  const bars = loadBars({ timeframe });
  const barMs = timeframe === '4h' ? 4 * 3600e3 : 24 * 3600e3;
  const setup = { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: realConfig };
  const factory = exitTestStrategy({ entry, seed, timeframe });
  const started = performance.now();
  const say = (m) => console.log(`[${tag}] ${((performance.now() - started) / 1000).toFixed(0)}s ${m}`);

  const diag = {};
  for (const id of ids) {
    const run = runSim({
      ...setup, config: {}, strategies: [factory({ cfg: id })], from: FROM, collectEvents: false, modules: { risk: equalRisk() },
    });
    diag[id] = positionsOf(run.trades, bars, barMs);
    say(`diag ${id}: ${diag[id].length} positions`);
  }
  writeFileSync(join(tmp, `diag-${tag}.json`), JSON.stringify(diag));
  if (diagOnly) return;

  const wf = walkForward({
    ...setup, strategyFactory: factory, grid: { cfg: ids }, from: FROM, trainDays: 730, testDays: 180, minTrainTrades: 30,
  });
  say(`walk-forward done, ${wf.picks.length} folds`);
  const audit = auditLookahead({
    ...setup, rebuild: () => factory({ cfg: ids[0] }), from: Date.UTC(2022, 0, 1), to: Date.UTC(2024, 11, 30), cuts: 3,
  });
  say(`lookahead audit ${audit.ok ? 'clean' : 'FAILED'}`);
  const s = wf.summary;
  const yearEnd = {};
  for (const e of wf.oos.equity) yearEnd[new Date(e.t).getUTCFullYear()] = e.equity;
  const years = {};
  let prev = wf.oos.equity[0].equity;
  for (const [y, v] of Object.entries(yearEnd)) { years[y] = v / prev - 1; prev = v; }
  writeFileSync(join(tmp, `wf-${tag}.json`), JSON.stringify({
    tag, entry, seed, timeframe, ids, trials: wf.trials,
    picks: wf.picks.map((p) => ({ testFrom: p.testFrom, cfg: p.params?.cfg ?? null, trainScore: p.trainScore })),
    oos: { ...s, costs: wf.oos.costs, years, lastEntry: wf.oos.fills.filter((f) => f.type === 'enter').at(-1)?.t ?? null },
    stress2x: wf.stress2x.summary.totalReturn,
    benchmark: { sharpe: wf.benchmark?.summary.sharpe, calmar: wf.benchmark?.summary.calmar, totalReturn: wf.benchmark?.summary.totalReturn },
    audit: { ok: audit.ok, cuts: audit.cuts }, criteria: checkDevCriteria(wf, { trials: readTrials() }),
  }));
  say(`OOS return ${(s.totalReturn * 100).toFixed(1)}%, Sharpe ${s.sharpe.toFixed(2)}, maxDD ${(s.maxDrawdown * 100).toFixed(1)}%, exposure ${(s.exposure * 100).toFixed(1)}%`);
}

// ---------- reports ----------

function report(shouldLog) {

  const trialFile = join(tmp, '../../research/v6/trials-r-exits.jsonl');
  const YEARS = 6.5;
  const files = readdirSync(tmp);
  const mean = (x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  const pc = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '-');
  const month = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

  function load(entry, tf = '1d') {
    const out = {};
    for (const file of files.filter((n) => n.startsWith(`diag-${tf}-${entry}-`) && !n.includes('confirm'))) {
      const seed = file.match(/-(\d+)\.json$/)[1];
      const d = JSON.parse(readFileSync(join(tmp, file), 'utf8'));
      for (const [id, rows] of Object.entries(d)) (out[id] ??= []).push(...rows.map((r) => ({ ...r, seed })));
    }
    return out;
  }

  /** Ratio-of-sums bootstrap over calendar months: trades in one month are not independent. */
  function clusterCI(pairs, value, seed = 1) {
    const by = new Map();
    for (const p of pairs) {
      const m = month(p.t);
      const c = by.get(m) ?? { s: 0, n: 0 };
      c.s += value(p); c.n += 1;
      by.set(m, c);
    }
    const cl = [...by.values()];
    const rand = seededRandom(seed);
    const stats = [];
    for (let b = 0; b < 2000; b++) {
      let s = 0, n = 0;
      for (let i = 0; i < cl.length; i++) { const c = cl[Math.floor(rand() * cl.length)]; s += c.s; n += c.n; }
      stats.push(s / n);
    }
    stats.sort((a, b) => a - b);
    return { est: pairs.reduce((a, p) => a + value(p), 0) / pairs.length, lo: stats[100], hi: stats[1899] };
  }

  function stats(rows, seeds) {
    const res = rows.map((r) => r.re).sort((a, b) => a - b);
    const losers = rows.filter((r) => r.re < 0);
    const k = Math.max(1, Math.floor(res.length * 0.05));
    const reached = rows.filter((r) => r.peakPct >= r.dist);
    const ci = clusterCI(rows.map((r) => ({ t: r.et, v: r.re })), (p) => p.v);
    const tim = clusterCI(rows.map((r) => ({ t: r.et, v: r.netPct - r.placeboPct })), (p) => p.v);
    const k1 = Math.max(1, Math.floor(res.length * 0.01));
    const trimmed = mean(res.slice(0, res.length - k1));
    const pos = res.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const top1 = res.slice(res.length - k1).reduce((a, b) => a + b, 0) / (pos || 1);
    const months = new Map();
    for (const r of rows) { const key = `${r.seed}|${month(r.xt)}`; months.set(key, (months.get(key) || 0) + r.re); }
    const worstBySeed = {};
    for (const [key, v] of months) { const s0 = key.split('|')[0]; worstBySeed[s0] = Math.min(worstBySeed[s0] ?? 0, v); }
    const worstMonth = mean(Object.values(worstBySeed));
    const reasons = {};
    for (const r of rows) reasons[r.reason] = (reasons[r.reason] || 0) + 1 / rows.length;
    return {
      n: rows.length / seeds, re: ci.est, lo: ci.lo, hi: ci.hi, med: res[res.length >> 1],
      win: rows.filter((r) => r.re > 0).length / rows.length,
      avgLoss: mean(losers.map((r) => r.re)), avgLossPct: mean(losers.map((r) => r.netPct)),
      cvar: mean(res.slice(0, k)), worst: res[0], worstPct: Math.min(...rows.map((r) => r.netPct)),
      over: rows.filter((r) => r.re < -1.25).length / rows.length,
      perYear: res.reduce((a, b) => a + b, 0) / seeds / YEARS,
      bars: mean(rows.map((r) => r.bars)), dist: mean(rows.map((r) => r.dist)),
      clamp: rows.filter((r) => r.dist > 0.2895).length / rows.length,
      gbFrac: mean(reached.map((r) => (r.peakPct - r.exitPct) / r.peakPct)),
      gbRe: mean(reached.map((r) => (r.peakPct - r.exitPct) / r.budget)),
      reach: reached.length / rows.length,
      timing: tim, reasons, trimmed, top1, worstMonth,
    };
  }

  function paired(a, b) {
    const idx = new Map(b.map((r) => [`${r.seed}|${r.sym}|${r.et}`, r]));
    const out = [];
    for (const r of a) { const o = idx.get(`${r.seed}|${r.sym}|${r.et}`); if (o) out.push({ t: r.et, a: r, b: o }); }
    return out;
  }

  function pairRow(label, a, b) {
    const p = paired(a, b);
    const ci = clusterCI(p, (x) => x.a.re - x.b.re);
    const cap = (v) => Math.min(v, 10);
    const cc = clusterCI(p, (x) => cap(x.a.re) - cap(x.b.re));
    const part = (lo, hi) => {
      const q = p.filter((x) => x.t >= Date.UTC(lo, 0, 1) && x.t < Date.UTC(hi, 0, 1));
      return q.length ? mean(q.map((x) => x.a.re - x.b.re)) : NaN;
    };
    const tag = ci.lo > 0 ? 'better' : ci.hi < 0 ? 'WORSE' : 'n.s.';
    return `| ${label} | ${p.length} | ${f(ci.est, 3)} | [${f(ci.lo, 3)}, ${f(ci.hi, 3)}] | ${tag} | ${f(cc.est, 3)} [${f(cc.lo, 3)}, ${f(cc.hi, 3)}] | ${f(part(2018, 2021), 3)} | ${f(part(2021, 2023), 3)} | ${f(part(2023, 2025), 3)} |`;
  }

  const out = [];
  const P = (s) => out.push(s);
  const COMPARE = [
    ['stop1', 'C'], ['stop1_5', 'C'], ['stop3', 'C'], ['stop4', 'C'],
    ['be0_5', 'C'], ['be1', 'C'], ['be2', 'C'], ['bare_be1', 'bare'],
    ['chOff', 'C'], ['ch2', 'C'], ['ch3', 'C'], ['ch6', 'C'], ['tOff', 'bare'],
    ['tOff', 'C'], ['t10', 'C'], ['t40', 'C'], ['chOff', 'bare'],
    ['p1', 'C'], ['p2', 'C'], ['C', 'bare'], ['full', 'C'],
    ['ph_trend', 'C'], ['ph_swing', 'C'], ['ph_revert', 'C'], ['ph_trend', 'bare'], ['ph_swing', 'bare'],
  ];

  for (const entry of ['random', 'breakout', 'dip']) {
    const d = load(entry);
    const seeds = entry === 'random' ? 5 : 1;
    P(`\n## ${entry} (diagnostic, equal risk, 2018-07 to 2024-12, ${seeds} seed(s); n is per seed)\n`);
    P('| cfg | n | mean Re | 90% CI | median | win | avg loss Re | avg loss % | CVaR5 Re | worst Re | worst % | past -1.25 | Re/yr | bars | stop dist | clamped | reach 1R | give-back % of peak | give-back Re | timing vs placebo | CI |');
    P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [id, rows] of Object.entries(d)) {
      const s = stats(rows, seeds);
      P(`| ${id} | ${f(s.n, 0)} | ${f(s.re, 3)} | [${f(s.lo, 3)}, ${f(s.hi, 3)}] | ${f(s.med)} | ${pc(s.win, 0)} | ${f(s.avgLoss)} | ${pc(s.avgLossPct)} | ${f(s.cvar)} | ${f(s.worst)} | ${pc(s.worstPct, 0)} | ${pc(s.over)} | ${f(s.perYear, 1)} | ${f(s.bars, 1)} | ${pc(s.dist)} | ${pc(s.clamp, 0)} | ${pc(s.reach, 0)} | ${pc(s.gbFrac, 0)} | ${f(s.gbRe)} | ${pc(s.timing.est, 2)} | [${pc(s.timing.lo, 2)}, ${pc(s.timing.hi, 2)}] |`);
    }
    P('\nRobustness (added after seeing the first table, not pre-registered):\n');
    P('| cfg | mean Re | mean without top 1% of trades | top 1% share of gross wins | worst month sum Re | timing vs placebo | CI |');
    P('|---|---|---|---|---|---|---|');
    for (const [id, rows] of Object.entries(d)) {
      const s = stats(rows, seeds);
      P(`| ${id} | ${f(s.re, 3)} | ${f(s.trimmed, 3)} | ${pc(s.top1, 0)} | ${f(s.worstMonth, 1)} | ${pc(s.timing.est, 2)} | [${pc(s.timing.lo, 2)}, ${pc(s.timing.hi, 2)}] |`);
    }
    P('\nExit mix:\n');
    for (const [id, rows] of Object.entries(d)) {
      const s = stats(rows, seeds);
      P(`- ${id}: ${Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pc(v, 0)}`).join(', ')}`);
    }
    P('\nPaired, A minus B, shared entries:\n');
    P('| A vs B | pairs | d mean Re | 90% CI | call | capped at +10 Re | 2018-20 | 2021-22 | 2023-24 |');
    P('|---|---|---|---|---|---|---|---|---|');
    for (const [a, b] of COMPARE) if (d[a] && d[b]) P(pairRow(`${a} vs ${b}`, d[a], d[b]));

    P('\nBreak-even clipping (trades that left on the break-even stop, against the same entry without it):\n');
    P('| cfg vs ref | share of trades on BE stop | their mean Re | same entries in ref | ref ended better | ref ended at +1R or more | ref lost |');
    P('|---|---|---|---|---|---|---|');
    for (const [a, b] of [['be0_5', 'C'], ['be1', 'C'], ['be2', 'C'], ['bare_be1', 'bare']]) {
      if (!d[a] || !d[b]) continue;
      const p = paired(d[a].filter((r) => r.reason === 'breakeven_stop'), d[b]);
      if (!p.length) continue;
      P(`| ${a} vs ${b} | ${pc(p.length / d[a].length, 0)} | ${f(mean(p.map((x) => x.a.re)))} | ${f(mean(p.map((x) => x.b.re)))} | ${pc(mean(p.map((x) => +(x.b.re > x.a.re))), 0)} | ${pc(mean(p.map((x) => +(x.b.netPct >= x.b.dist))), 0)} | ${pc(mean(p.map((x) => +(x.b.re < 0))), 0)} |`);
    }
    P('\nStops hit, against the same entry with the 2 ATR stop:\n');
    for (const a of ['stop1', 'stop1_5']) {
      if (!d[a]) continue;
      const p = paired(d[a].filter((r) => r.reason === 'hard_stop'), d.C);
      P(`- ${a}: ${pc(p.length / d[a].length, 0)} of trades hit the hard stop. In C those entries averaged ${f(mean(p.map((x) => x.b.re)))} Re, and ${pc(mean(p.map((x) => +(x.b.re > 0))), 0)} ended in profit.`);
    }
    for (const a of ['p1', 'p2']) {
      if (!d[a]) continue;
      const p = paired(d[a].filter((r) => r.partial), d.C);
      P(`- ${a}: ${pc(p.length / d[a].length, 0)} of trades took the partial. Those trades: ${f(mean(p.map((x) => x.a.re)))} Re with it, ${f(mean(p.map((x) => x.b.re)))} Re without.`);
    }
  }

  P('\n## Real v6Risk walk-forward (OOS 2020-07 on), fixed configs\n');
  const wf = {};
  for (const file of files.filter((n) => n.startsWith('wf-1d-') && !n.includes('confirm'))) {
    const w = JSON.parse(readFileSync(join(tmp, file), 'utf8'));
    (wf[w.entry] ??= []).push(w);
  }
  for (const [entry, runs] of Object.entries(wf)) {
    P(`\n### ${entry}: ${runs.length} run(s), audit ${runs.every((r) => r.audit.ok) ? 'clean' : 'FAILED'}\n`);
    P('| cfg | Sharpe | sd | return | max DD | trades | re-enables |');
    P('|---|---|---|---|---|---|---|');
    for (const id of runs[0].ids) {
      const ts = runs.map((r) => r.trials.find((x) => x.params.cfg === id));
      const sd = Math.sqrt(mean(ts.map((t) => (t.sharpe - mean(ts.map((u) => u.sharpe))) ** 2)));
      P(`| ${id} | ${f(mean(ts.map((t) => t.sharpe)))} | ${f(sd)} | ${pc(mean(ts.map((t) => t.totalReturn)))} | ${pc(mean(ts.map((t) => t.maxDrawdown)))} | ${f(mean(ts.map((t) => t.closedTrades)), 0)} | ${f(mean(ts.map((t) => t.simReEnables ?? NaN)), 1)} |`);
    }
    P('\nWalk-forward picked-config OOS:\n');
    for (const r of runs) {
      const o = r.oos;
      P(`- ${r.tag}: return ${pc(o.totalReturn)}, Sharpe ${f(o.sharpe)}, max DD ${pc(o.maxDrawdown)}, ${o.closedTrades} trades, exposure ${pc(o.exposure)}, 2x cost ${pc(r.stress2x)}, last entry ${o.lastEntry ? new Date(o.lastEntry).toISOString().slice(0, 10) : '-'}, costs fees ${f(o.costs.fees, 0)} slip ${f(o.costs.slippage, 0)} gaps ${f(o.costs.stopGap, 0)} delist ${f(o.costs.delistHaircut, 0)}; years ${Object.entries(o.years).map(([y, v]) => `${y} ${pc(v)}`).join(' ')}; picks ${r.picks.map((p) => p.cfg).join(' ')}; benchmark Sharpe ${f(r.benchmark.sharpe)}`);
    }
    P('\nD1-D8 (first run):\n```\n' + runs[0].criteria.report + '\n```');
  }
  writeFileSync(join(tmp, 'report.md'), out.join('\n'));

  if (shouldLog) {
    const seen = new Set(existsSync(trialFile) ? readFileSync(trialFile, 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return `${j.strategyId}|${j.timeframe}|${j.params.cfg}`; }) : []);
    let added = 0;
    for (const [entry, runs] of Object.entries(wf)) {
      for (const id of runs[0].ids) {
        const strategyId = `exit-${entry}`;
        if (seen.has(`${strategyId}|1d|${id}`)) continue;
        const ts = runs.map((r) => r.trials.find((x) => x.params.cfg === id));
        const avg = (k) => mean(ts.map((t) => t[k]));
        const trial = { params: { cfg: id }, sharpe: avg('sharpe'), periodsPerYear: ts[0].periodsPerYear, nObs: ts[0].nObs, closedTrades: Math.round(avg('closedTrades')), maxDrawdown: avg('maxDrawdown'), totalReturn: avg('totalReturn') };
        const note = runs.length > 1 ? `mean of ${runs.length} random-entry seeds, one parameter set; seed Sharpes ${ts.map((t) => t.sharpe.toFixed(2)).join(' ')}` : null;
        appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: 'r-exits', family: 'exit-rules', strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
        added++;
      }
    }
    console.log('trials added', added);
  }
  console.log('report lines', out.length);

}

function confirmReport(shouldLog) {
  const trialFile = join(tmp, '../../research/v6/trials-r-exits.jsonl');
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const groups = {};
  for (const n of readdirSync(tmp).filter((x) => x.startsWith('wf-') && x.includes('confirm'))) {
    const w = JSON.parse(readFileSync(join(tmp, n), 'utf8'));
    (groups[`${w.timeframe}|${w.entry}`] ??= []).push(w);
  }
  const logged = new Set(readFileSync(trialFile, 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return `${j.strategyId}|${j.timeframe}|${j.params.cfg}`; }));
  for (const [g, runs] of Object.entries(groups)) {
    const [tf, entry] = g.split('|');
    for (const id of runs[0].ids) {
      const ts = runs.map((r) => r.trials.find((t) => t.params.cfg === id));
      const a = (k) => mean(ts.map((t) => t[k]));
      console.log(g, id, 'Sharpe', a('sharpe').toFixed(2), 'seeds', ts.map((t) => t.sharpe.toFixed(2)).join(' '), 'ret', (a('totalReturn') * 100).toFixed(1), 'dd', (a('maxDrawdown') * 100).toFixed(1), 'trades', a('closedTrades').toFixed(0));
      if (shouldLog && !logged.has(`exit-${entry}|${tf}|${id}`)) {
        const trial = { params: { cfg: id }, sharpe: a('sharpe'), periodsPerYear: ts[0].periodsPerYear, nObs: ts[0].nObs, closedTrades: Math.round(a('closedTrades')), maxDrawdown: a('maxDrawdown'), totalReturn: a('totalReturn') };
        const note = `reserved confirmation trial${runs.length > 1 ? `; mean of ${runs.length} random-entry seeds` : ''}`;
        appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: 'r-exits', family: 'exit-rules', strategyId: `exit-${entry}`, timeframe: tf, trial, note, ts: new Date().toISOString() }))}\n`);
      }
    }
    console.log('  audit', runs.every((r) => r.audit.ok) ? 'clean' : 'FAILED', 'exposure', runs.map((r) => (r.oos.exposure * 100).toFixed(1)).join(' '), 'costs fees/slip/gap', runs.map((r) => `${r.oos.costs.fees.toFixed(0)}/${r.oos.costs.slippage.toFixed(0)}/${r.oos.costs.stopGap.toFixed(0)}`).join(' '), 'lastEntry', runs.map((r) => new Date(r.oos.lastEntry).toISOString().slice(0, 10)).join(' '));
  }
  const d = (n) => JSON.parse(readFileSync(join(tmp, n), 'utf8'));
  const show = (label, rows) => { const s = rows.map((r) => r.re).sort((a, b) => a - b); const l = rows.filter((r) => r.re < 0); const k = Math.max(1, Math.floor(s.length * 0.01)); const hit = rows.filter((r) => r.peakPct >= r.dist); console.log(label, 'n', rows.length, 'meanRe', mean(s).toFixed(3), 'trim', mean(s.slice(0, s.length - k)).toFixed(3), 'win', (rows.filter((r) => r.re > 0).length / rows.length).toFixed(2), 'avgLossRe', mean(l.map((r) => r.re)).toFixed(2), 'avgLoss%', (mean(l.map((r) => r.netPct)) * 100).toFixed(1), 'bars', mean(rows.map((r) => r.bars)).toFixed(1), 'gb%', (mean(hit.map((r) => (r.peakPct - r.exitPct) / r.peakPct)) * 100).toFixed(0), 'dist', (mean(rows.map((r) => r.dist)) * 100).toFixed(1)); };
  for (const n of readdirSync(tmp).filter((x) => x.startsWith('diag-') && x.includes('confirm')).sort()) {
    const j = d(n);
    for (const [id, rows] of Object.entries(j)) show(`${n.slice(5, -5)} ${id}`, rows);
  }

}

export const FROZEN_CANDIDATES = [];

/**
 * Recommended EXIT_PROFILES values, 1d only. Each is a config that was run as written:
 * trend = stop3, swing = C, revert = t10. Not validated on 4h. Values marked untested in
 * docs/rebuild/research-r-exits.md stay at the placeholder. Regime exit is off because it
 * was off in every tested config, not because it was shown to be bad.
 * hardStop.atrMult only applies when a position arrives with no stop, so a strategy must
 * also send stopDistancePct = atrMult x ATR(14) / close to get the tested stop.
 */
const recommended = (id, minRewardRisk, fallbackPct, cfgId) => {
  const { stopAtr, overrides } = CONFIGS[cfgId];
  return { id, minRewardRisk, hardStop: { atrMult: stopAtr, fallbackPct }, ...overrides };
};
export const RECOMMENDED_EXIT_PROFILES = Object.freeze({
  trend: recommended('trend', 2, 15, 'stop3'),
  swing: recommended('swing', 1.5, 10, 'C'),
  revert: recommended('revert', 1, 8, 't10'),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, spec, ...rest] = process.argv.slice(2);
  if (cmd === 'job') {
    const only = rest.find((x) => x.startsWith('only='))?.slice(5).split(',') ?? null;
    job(spec, rest.find((x) => x === '1d' || x === '4h') ?? '1d', only, rest.includes('diag'));
  } else if (cmd === 'report') {
    report(spec === 'log');
  } else if (cmd === 'confirm') {
    confirmReport(spec === 'log');
  } else {
    console.log('usage: job <spec> [1d|4h] [only=a,b] [diag] | report [log] | confirm [log]');
  }
}
