// r-flush: buy spot after a confirmed forced-liquidation flush, exit on a time stop.
// Pre-registration and results: docs/rebuild/research-r-flush.md.
//   node scripts/v6/research/r-flush.mjs all      event study (E0) + E1-E3, then verdicts
// DEV only: loadBars and the derivs loaders refuse the holdout without the token.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { loadFunding, loadOpenInterest, perpToSpot } from '../../../shared/trading/v6Derivs.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { clampRiskConfig, DEFAULT_RISK_CONFIG } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, prepareMarket, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { defineStrategy } from '../../../shared/trading/v6Strategies.js';

const AGENT = 'r-flush';
const FAMILY = 'liquidation-flush-long';
const BTC = 'BTCUSDT';
const DAY = 86400000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const V6 = join(ROOT, 'data/research/v6');
const TMP = join(ROOT, 'data/tmp/r-flush');
const DEV_END = Date.UTC(2024, 11, 31, 23, 59, 59, 999);

const WINDOW = 3;          // bars in the flush window
const STOP_ATR = 2;
const MIN_STOP = 0.01;
const MAX_STOP = 0.20;
export const OI_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT'];

/** Set after the runs. Empty means nothing qualified. */
export const FROZEN_CANDIDATES = [];

export const RISK = clampRiskConfig({
  ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, volTargetAnnual: 0.20,
  btcDrop24hPct: 0.10, btcDrop7dPct: 0.20,
});

// ---------- derivatives, point in time ----------

/** Index of the last row with t < before, or -1. Rows sorted by t. */
function lastIdxBefore(rows, before) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < before) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/** OI (coins) and 8h-normalised funding, keyed by spot symbol. */
export function loadDerivs() {
  const oi = new Map();
  for (const [s, rows] of loadOpenInterest({ symbols: OI_SYMBOLS, to: DEV_END })) oi.set(s, rows.map((r) => ({ t: r.t, oi: r.oi })));
  const perps = readdirSync(join(V6, 'derivs/dev/funding')).map((f) => f.replace(/\.json$/, ''));
  const bySpot = new Map();
  for (const p of perps) {
    const { spot, multiplier } = perpToSpot(p);
    // Prefer the 1x contract when both exist.
    if (!bySpot.has(spot) || multiplier === 1) bySpot.set(spot, p);
  }
  const raw = loadFunding({ symbols: [...bySpot.values()], to: DEV_END });
  const funding = new Map();
  for (const [spot, perp] of bySpot) {
    const ev = raw.get(perp);
    if (!ev?.length) continue;
    const rows = [];
    for (let i = 0; i < ev.length; i++) {
      const gapH = i ? (ev[i].t - ev[i - 1].t) / 3600000 : 8;
      const h = gapH > 0.5 && gapH <= 8.5 ? Math.round(gapH) : 8;
      rows.push({ t: ev[i].t, r8: (ev[i].rate * 8) / h });
    }
    funding.set(spot, rows);
  }
  return { oi, funding };
}

/** The same data with nothing at or after `until`: for auditLookahead's rebuild. */
export function cutDerivs(d, until) {
  const cut = (m) => new Map([...m].map(([k, rows]) => [k, rows.filter((r) => r.t < until)]));
  return { oi: cut(d.oi), funding: cut(d.funding) };
}

// ---------- the event ----------

/** Simple average true range of n bars ending at index i. */
export function atrAt(bars, i, n = 14) {
  if (i < n) return NaN;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / n;
}

function oiConfirmed(rows, tClose, oiDrop) {
  if (!rows?.length) return false;
  const a = lastIdxBefore(rows, tClose), b = lastIdxBefore(rows, tClose - WINDOW * DAY);
  if (a < 0 || b < 0) return false;
  // Stale samples prove nothing about this window.
  if (rows[a].t < tClose - DAY || rows[b].t < tClose - (WINDOW + 1) * DAY) return false;
  return rows[a].oi / rows[b].oi - 1 <= -oiDrop;
}

function fundConfirmed(rows, tClose, fundHi) {
  if (!rows?.length) return false;
  let hi = -Infinity;
  for (let k = lastIdxBefore(rows, tClose - WINDOW * DAY); k >= 0 && rows[k].t >= tClose - 10 * DAY; k--) hi = Math.max(hi, rows[k].r8);
  if (!(hi >= fundHi)) return false;
  let n = 0, sum = 0;
  for (let k = lastIdxBefore(rows, tClose); k >= 0 && rows[k].t >= tClose - DAY; k--) { n++; sum += rows[k].r8; }
  return n > 0 && sum / n < 0;
}

/** Is the flush condition true at the close of bars[i]? mode: oi | fund | either | drop. */
export function flushAt(bars, i, symbol, p, mode, d) {
  if (i < 14 + WINDOW + 1) return false;
  const ref = bars[i - WINDOW];
  if (bars[i].t - ref.t !== WINDOW * DAY) return false;
  const atr = atrAt(bars, i - WINDOW);
  if (!(atr > 0)) return false;
  if (!(bars[i].c / ref.c - 1 <= (-p.dropAtr * atr) / ref.c)) return false;
  if (mode === 'drop') return true;
  const tClose = bars[i].t + DAY;
  const o = mode !== 'fund' && oiConfirmed(d.oi.get(symbol), tClose, p.oiDrop);
  if (o) return true;
  return mode !== 'oi' && fundConfirmed(d.funding.get(symbol), tClose, p.fundHi);
}

/** True on the first close of a flush: holds now, not at either of the two closes before. */
export function newFlush(bars, i, symbol, p, mode, d) {
  return flushAt(bars, i, symbol, p, mode, d) && !flushAt(bars, i - 1, symbol, p, mode, d) && !flushAt(bars, i - 2, symbol, p, mode, d);
}

const eligible = (mode, d, symbol) => (mode === 'fund' ? d.funding.has(symbol) : d.oi.has(symbol));

/**
 * @param {{ id: string, mode: 'oi'|'fund'|'either', derivs: object, universe?: object, fixed?: object }} spec
 */
export function flushFactory({ id, mode, derivs, universe = { kind: 'top', n: 20 }, fixed = {} }) {
  return (params) => {
    const p = { oiDrop: 0.10, fundHi: 0.0003, stopAtr: STOP_ATR, ...fixed, ...params };
    return defineStrategy({
      id, name: `Liquidation flush (${mode})`, timeframe: '1d', universe, params: p, warmupBars: 30,
      exitOverrides: { timeStop: { enabled: true, bars: p.H, minR: 0, maxBars: p.H } },
      signals(ctx) {
        const out = [];
        for (const symbol of ctx.universe) {
          if (ctx.positions.has(symbol) || !eligible(mode, derivs, symbol)) continue;
          const bars = ctx.bars.get(symbol);
          if (!bars?.length || bars[bars.length - 1].t + DAY !== ctx.t) continue;
          const i = bars.length - 1;
          if (!newFlush(bars, i, symbol, p, mode, derivs)) continue;
          const c = bars[i].c;
          const stop = Math.max(MIN_STOP, (p.stopAtr * atrAt(bars, i)) / c);
          if (!(stop <= MAX_STOP)) continue;
          const drop = 1 - c / bars[i - WINDOW].c;
          out.push({
            strategyId: id, symbol, side: 'long', score: Math.min(1, drop * 3), stopDistancePct: stop, exitProfile: 'revert',
            reason: `Liquidation flush: down ${(drop * 100).toFixed(1)}% in ${WINDOW} days with leverage unwinding (${mode})`, meta: { stop },
          });
        }
        return out;
      },
    });
  };
}

// ---------- experiments (fixed in the pre-registration) ----------

export const EXPERIMENTS = {
  E1: { mode: 'oi', from: Date.UTC(2021, 0, 1), grid: { dropAtr: [2, 3], oiDrop: [0.10, 0.20], H: [3, 7] } },
  E2: { mode: 'fund', from: Date.UTC(2020, 0, 1), grid: { dropAtr: [2, 3], fundHi: [0.0003, 0.0006], H: [3, 7] } },
  E3: { mode: 'either', from: Date.UTC(2021, 0, 1), grid: { dropAtr: [2, 3], H: [3, 7] } },
};
const WF = { trainDays: 365, testDays: 180, minTrainTrades: 10 };
const idOf = (name, e) => `flush-${e.mode}-${name}`;

function marketSymbols(topN) {
  const names = new Set([BTC, 'ETHUSDT']);
  for (let t = Date.UTC(2019, 0, 1); t <= Date.UTC(2024, 11, 31); t += DAY) for (const s of pointInTimeUniverse(t, { topN, timeframe: '1d' })) names.add(s);
  return [...names];
}

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allTrials = () => readdirSync(V6).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').flatMap((f) => readLines(join(V6, f)));
const trialFile = join(V6, `trials-${AGENT}.jsonl`);
function logTrial(strategyId, trial, note) {
  const lines = existsSync(trialFile) ? readLines(trialFile) : [];
  if (lines.some((l) => `${l.strategyId}|${JSON.stringify(l.params)}` === `${strategyId}|${JSON.stringify(trial.params)}`)) return;
  if (lines.length >= 50) throw new Error('trial budget of 50 is used up');
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
}

// ---------- E0: event study ----------

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function eventStudy(bars, derivs) {
  const H = [1, 3, 5, 10];
  const p = { dropAtr: 2, oiDrop: 0.10, fundHi: 0.0003 };
  const sets = {};
  const add = (name, ret, year) => {
    const s = sets[name] ??= { n: 0, byYear: {}, h: Object.fromEntries(H.map((h) => [h, []])) };
    s.n++; s.byYear[year] = (s.byYear[year] ?? 0) + 1;
    for (const h of H) if (ret[h] !== null) s.h[h].push(ret[h]);
  };
  const uniMemo = new Map();
  const inTop20 = (s, t) => { let u = uniMemo.get(t); if (!u) uniMemo.set(t, u = new Set(pointInTimeUniverse(t, { topN: 20, timeframe: '1d' }))); return u.has(s); };
  for (const [symbol, list] of bars) {
    const hasOi = derivs.oi.has(symbol), hasF = derivs.funding.has(symbol);
    if (!hasOi && !hasF) continue;
    const oiStart = hasOi ? derivs.oi.get(symbol)[0].t : Infinity;
    for (let i = 20; i < list.length - 1; i++) {
      const tClose = list[i].t + DAY;
      if (tClose < Date.UTC(2020, 0, 1) || !inTop20(symbol, tClose)) continue;
      const c = costFor(symbol, tierFor(symbol, tClose));
      const rt = (2 * (c.feePct + c.slipPct)) / 100;
      const entry = list[i + 1].o;
      const ret = {};
      for (const h of H) ret[h] = i + h < list.length && list[i + h].t === list[i].t + h * DAY ? list[i + h].c / entry - 1 - rt : null;
      const year = new Date(tClose).getUTCFullYear();
      const oiSpan = hasOi && tClose > oiStart + 5 * DAY;
      if (oiSpan) {
        add('all-days OI10', ret, year);
        if (newFlush(list, i, symbol, p, 'drop', derivs)) add('drop-only OI10 (control)', ret, year);
        if (newFlush(list, i, symbol, p, 'oi', derivs)) add('oi flush OI10', ret, year);
        if (newFlush(list, i, symbol, { ...p, dropAtr: 3 }, 'drop', derivs)) add('drop-only 3ATR OI10 (control)', ret, year);
        if (newFlush(list, i, symbol, { ...p, dropAtr: 3 }, 'oi', derivs)) add('oi flush 3ATR OI10', ret, year);
      }
      if (hasF) {
        add('all-days perps', ret, year);
        if (newFlush(list, i, symbol, p, 'drop', derivs)) add('drop-only perps (control)', ret, year);
        if (newFlush(list, i, symbol, p, 'fund', derivs)) add('fund flush perps', ret, year);
      }
    }
  }
  const table = Object.entries(sets).map(([name, s]) => ({
    name, n: s.n, byYear: s.byYear,
    ...Object.fromEntries(H.map((h) => [`h${h}`, { mean: mean(s.h[h]), median: median(s.h[h]), win: mean(s.h[h].map((x) => (x > 0 ? 1 : 0))), n: s.h[h].length }])),
  }));
  return table;
}

// ---------- run ----------

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '-');
const yearly = (s) => Object.fromEntries(Object.entries(s.logReturnByYear ?? {}).map(([y, l]) => [y, Math.expm1(l)]));

function main() {
  mkdirSync(TMP, { recursive: true });
  const derivs = loadDerivs();
  const bars = prepareMarket(loadBars({ symbols: marketSymbols(20), timeframe: '1d' }));
  const rawBars = new Map([...bars.series].map(([s, v]) => [s, v.bars]));
  const setup = { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: { risk: RISK } };
  console.log(`${bars.series.size} symbols, OI ${derivs.oi.size}, funding ${derivs.funding.size}`);

  // E0
  const es = eventStudy(rawBars, derivs);
  for (const r of es) console.log(`${r.name.padEnd(32)} n=${String(r.n).padStart(5)}  h1 ${pct(r.h1.mean)}  h3 ${pct(r.h3.mean)} (med ${pct(r.h3.median)}, win ${pct(r.h3.win)})  h5 ${pct(r.h5.mean)}  h10 ${pct(r.h10.mean)}`);
  const e0Factory = flushFactory({ id: 'flush-eventstudy-E0', mode: 'oi', derivs });
  const e0 = runSim({ ...setup, strategies: [e0Factory({ dropAtr: 2, H: 3 })], from: Date.UTC(2020, 8, 1), to: DEV_END });
  const s0 = e0.summary;
  logTrial('flush-eventstudy-E0', { params: { dropAtr: 2, oiDrop: 0.10, H: 3 }, sharpe: s0.sharpe, periodsPerYear: s0.periodsPerYear, nObs: s0.periods, closedTrades: s0.closedTrades, maxDrawdown: s0.maxDrawdown, totalReturn: s0.totalReturn, simReEnables: s0.simReEnables, regimeExits: s0.regimeExits }, 'E0 event study fixed-param sim');
  console.log(`E0 sim: Sharpe ${s0.sharpe.toFixed(2)}, ret ${pct(s0.totalReturn)}, trades ${s0.closedTrades}, blocked ${JSON.stringify(s0.eventCounts ?? {}).slice(0, 200)}`);
  writeFileSync(join(TMP, 'E0.json'), JSON.stringify({ eventStudy: es, sim: { ...s0, yearly: yearly(s0) } }, null, 1));

  // E1-E3: run and log all first, then judge with the complete global trial count.
  const results = {};
  for (const [name, e] of Object.entries(EXPERIMENTS)) {
    const id = idOf(name, e);
    const factory = flushFactory({ id, mode: e.mode, derivs });
    const t0 = performance.now();
    const wf = walkForward({ ...setup, ...WF, from: e.from, strategyFactory: factory, grid: e.grid });
    for (const tr of wf.trials) logTrial(id, tr, name);
    const center = wf.plateau?.params ?? wf.trials[0].params;
    const rebuild = (cut) => flushFactory({ id, mode: e.mode, derivs: cutDerivs(derivs, cut.get(BTC).at(-1).t + DAY) })(center);
    const audit = auditLookahead({ ...setup, rebuild, from: Date.UTC(2023, 0, 1), cuts: 3 });
    results[name] = { e, id, wf, center, audit, seconds: (performance.now() - t0) / 1000 };
    console.log(`${name} done ${results[name].seconds.toFixed(0)}s, OOS trades ${wf.summary.closedTrades}, Sharpe ${wf.summary.sharpe.toFixed(2)}, audit ${audit.ok ? 'clean' : 'FAILED'}`);
  }
  const trials = allTrials();
  console.log(`global trial count ${trials.length}`);
  for (const [name, r] of Object.entries(results)) {
    const v = checkDevCriteria(r.wf, { trials });
    const s = r.wf.summary;
    const out = {
      name, id: r.id, audit: { ok: r.audit.ok, bad: r.audit.cuts.filter((c) => !c.ok) }, center: r.center,
      picks: r.wf.picks.map((p) => ({ from: new Date(p.testFrom).toISOString().slice(0, 10), params: p.params, train: p.trainScore })),
      verdict: { pass: v.pass, criteria: v.criteria, report: v.report },
      oos: { totalReturn: s.totalReturn, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, calmar: s.calmar, closedTrades: s.closedTrades, exposure: s.exposure,
        winRate: s.winRate, profitFactor: s.profitFactor, yearly: yearly(s), topCoin: s.topCoin, topCoinShare: s.topCoinShare, topYear: s.topYear,
        topYearShare: s.topYearShare, eventCounts: s.eventCounts, regimeExits: s.regimeExits, regimeExitPnl: s.regimeExitPnl, simReEnables: s.simReEnables },
      costs: r.wf.oos.costs, stress2x: r.wf.stress2x.summary.totalReturn,
      benchmark: { sharpe: r.wf.benchmark?.summary.sharpe, calmar: r.wf.benchmark?.summary.calmar, maxDrawdown: r.wf.benchmark?.summary.maxDrawdown },
      trials: r.wf.trials,
    };
    writeFileSync(join(TMP, `${name}.json`), JSON.stringify(out, null, 1));
    console.log(`\n== ${name} (${r.id}) pass=${v.pass}`);
    console.log(v.report);
  }
}

if (process.argv[2] === 'all') main();
