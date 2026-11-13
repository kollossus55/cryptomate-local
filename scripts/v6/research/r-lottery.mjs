// Lottery effect (catalogue #103/#110): low MAX / low skew long, weekly. Research only, DEV data only.
//   node scripts/v6/research/r-lottery.mjs study      event study, 8 cells, 8 trials
// Pre-registration and results: docs/rebuild/research-r-lottery.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DAY_MS, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { loadFunding, loadPerpBars } from '../../../shared/trading/v6Derivs.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { trialRecord } from '../../../shared/trading/v6Sim.js';

const AGENT = 'r-lottery';
const FAMILY = 'lottery';
const FROM = Date.UTC(2020, 0, 1);
const DEV_TO = Date.UTC(2024, 11, 31, 23);
const LAST_BAR = Date.UTC(2024, 11, 31);
const SPLIT = Date.UTC(2023, 0, 1);
const MAX_TRIALS = 8;
const D = DAY_MS;

const here = dirname(fileURLToPath(import.meta.url));
const trialDir = join(here, '../../../data/research/v6');
const trialFile = join(trialDir, `trials-${AGENT}.jsonl`);
const tmpDir = join(here, '../../../data/tmp', AGENT);

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
const pct = (x, d = 3) => `${(x * 100).toFixed(d)}%`;
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
};
const readLines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function logTrial(strategyId, trial, note) {
  mkdirSync(trialDir, { recursive: true });
  const lines = existsSync(trialFile) ? readLines(trialFile) : [];
  if (lines.some((l) => `${l.strategyId}|${JSON.stringify(l.params)}` === `${strategyId}|${JSON.stringify(trial.params)}`)) return;
  if (lines.length >= MAX_TRIALS) throw new Error(`Trial budget of ${MAX_TRIALS} reached`);
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family: FAMILY, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
}

// ---------- data ----------

const uniMemo = new Map();
const uni = (n, t) => { const k = `${n}|${t}`; if (!uniMemo.has(k)) uniMemo.set(k, pointInTimeUniverse(t, { topN: n, timeframe: '1d' })); return uniMemo.get(k); };

function loadAll() {
  const set = new Set();
  for (let t = FROM - 40 * D; t <= LAST_BAR; t += D) for (const s of uni(30, t)) set.add(s);
  const symbols = [...set];
  const toIndex = (m) => { const out = new Map(); for (const [s, bars] of m) { const x = new Map(); for (const b of bars) x.set(b.t, b); out.set(s, x); } return out; };
  const spot = toIndex(loadBars({ symbols, timeframe: '1d', from: FROM - 400 * D, to: DEV_TO }));
  const perpRaw = new Map();
  for (const s of symbols) {
    try { const m = loadPerpBars({ symbols: [s], timeframe: '1d', from: FROM - 400 * D, to: DEV_TO }); if (m.get(s)?.length) perpRaw.set(s, m.get(s)); } catch { /* no perp under this symbol */ }
  }
  const perp = toIndex(perpRaw);
  const funding = loadFunding({ symbols: [...perp.keys()], from: FROM - 10 * D, to: DEV_TO });
  console.log(`data: ${symbols.length} symbols ever in the top 30, ${perp.size} with a same-symbol perp`);
  return { symbols, spot, perp, funding };
}

// ---------- study ----------

const skew = (a) => { const m = mean(a), s = sd(a); return s > 0 ? a.reduce((x, v) => x + ((v - m) / s) ** 3, 0) / a.length : NaN; };
const max5 = (a) => mean([...a].sort((x, y) => y - x).slice(0, 5));
const SIGNALS = { MAX: max5, SKEW: skew };

function runStudy() {
  const { spot, perp, funding } = loadAll();
  const days = []; for (let t = FROM; t <= LAST_BAR; t += D) days.push(t);
  const rtSpot = (s, t) => { const c = costFor(s, tierFor(s, t)); return 2 * (c.feePct + c.slipPct) / 100; };
  const rtPerp = (s, t) => { const c = costFor(s, tierFor(s, t), { instrument: 'perp' }); return 2 * (c.feePct + c.slipPct) / 100; };
  const closeRet = (m, s, t) => { const a = m.get(s)?.get(t - D), b = m.get(s)?.get(t); return a && b && a.c > 0 ? b.c / a.c - 1 : null; };
  const rets = (m, s, endT, n) => { const out = []; for (let t = endT - (n - 1) * D; t <= endT; t += D) { const r = closeRet(m, s, t); if (r === null) return null; out.push(r); } return out; };
  const fundSum = (s, fromT, toT) => { let x = 0; for (const r of funding.get(s) ?? []) if (r.t > fromT && r.t <= toT) x += r.rate; return x; };

  const results = [];
  const judge = (effect, params, events, blockDays) => {
    const blocks = new Map();
    for (const e of events) { const k = Math.floor((e.t - FROM) / (blockDays * D)); const b = blocks.get(k) ?? { ex: [], net: [], t: e.t }; b.ex.push(e.excess); b.net.push(e.gross - e.cost); blocks.set(k, b); }
    const bl = [...blocks.values()];
    const exB = bl.map((b) => mean(b.ex)), netB = bl.map((b) => mean(b.net));
    const half = (pred) => { const x = events.filter(pred).map((e) => e.excess); return x.length ? mean(x) : NaN; };
    const h1 = half((e) => e.t < SPLIT), h2 = half((e) => e.t >= SPLIT);
    const g = events.map((e) => e.gross), c = events.map((e) => e.cost), ex = events.map((e) => e.excess);
    const blocksPerYear = 365 / blockDays;
    const r = {
      effect, params, n: events.length, blocks: bl.length, meanGross: mean(g), meanCost: mean(c), meanNet: mean(g) - mean(c),
      meanExcess: mean(ex), tExcessBlocks: tstat(exB), half1: h1, half2: h2,
      netSharpeAnn: mean(netB) / sd(netB) * Math.sqrt(blocksPerYear),
    };
    r.gate = { grossBeatsCost: r.meanGross > r.meanCost, excessT2: r.meanExcess > 0 && r.tExcessBlocks >= 2, bothHalves: h1 > 0 && h2 > 0 };
    r.pass = events.length >= 30 && Object.values(r.gate).every(Boolean);
    results.push(r);
    if (process.env.DUMP) { mkdirSync(tmpDir, { recursive: true }); writeFileSync(join(tmpDir, `events-${effect}-${Object.values(params).join("_")}.json`), JSON.stringify(events)); }
    logTrial(`r-lottery-study-${effect}`, {
      params, sharpe: Number.isFinite(r.netSharpeAnn) ? r.netSharpeAnn : 0, periodsPerYear: blocksPerYear, nObs: bl.length, closedTrades: events.length,
      maxDrawdown: null, totalReturn: null,
    }, `event study ${effect} gross ${pct(r.meanGross)} cost ${pct(r.meanCost)} excess t ${r.tExcessBlocks.toFixed(2)}`);
    console.log(`${effect.padEnd(6)} ${JSON.stringify(params).padEnd(24)} n=${String(events.length).padStart(5)} gross ${pct(r.meanGross).padStart(8)} cost ${pct(r.meanCost)} net ${pct(r.meanNet).padStart(8)} `
      + `excess ${pct(r.meanExcess).padStart(8)} t ${r.tExcessBlocks.toFixed(2).padStart(5)} halves ${pct(h1)}/${pct(h2)} netSR ${r.netSharpeAnn.toFixed(2).padStart(5)} ${r.pass ? 'PASS' : 'FAIL'}`);
  };

  const changedCost = (now, prev, rt, T) => now.filter((s) => !prev.has(s)).reduce((acc, s) => acc + rt(s, T) / now.length, 0);

  for (const [sig, fn] of Object.entries(SIGNALS)) for (const L of [30, 90]) {
    const lo = [], ls = [];
    let pLO = new Set(), pL = new Set(), pS = new Set();
    for (const T of days) {
      if (new Date(T).getUTCDay() !== 1 || T < FROM + 100 * D) continue;
      const nextT = T + 7 * D;
      if (nextT > LAST_BAR) break;
      const score = new Map();
      for (const s of uni(30, T)) {
        if (!spot.get(s)?.get(T) || !spot.get(s)?.get(nextT)) continue;
        const r = rets(spot, s, T - D, L); if (!r) continue;
        const v = fn(r); if (Number.isFinite(v)) score.set(s, v);
      }
      const sOpen = (s) => spot.get(s).get(nextT).o / spot.get(s).get(T).o - 1;
      const pRet = (s) => perp.get(s).get(nextT).o / perp.get(s).get(T).o - 1;
      const rank = (set) => [...set].sort((a, b) => score.get(a) - score.get(b));
      // LO: all eligible spot coins.
      const all = rank(score.keys());
      if (all.length >= 10) {
        const k = Math.max(4, Math.floor(all.length / 5));
        const low = all.slice(0, k);
        const g = mean(low.map(sOpen));
        lo.push({ t: T, gross: g, cost: changedCost(low, pLO, rtSpot, T), excess: g - mean(all.map(sOpen)) });
        pLO = new Set(low);
      }
      // LS: eligible coins that also have a perp at both opens.
      const pe = rank([...score.keys()].filter((s) => perp.get(s)?.get(T) && perp.get(s)?.get(nextT)));
      if (pe.length >= 10) {
        const k = Math.max(4, Math.floor(pe.length / 5));
        const low = pe.slice(0, k), high = pe.slice(-k);
        const g = mean(low.map((s) => pRet(s) - fundSum(s, T, nextT))) + mean(high.map((s) => -pRet(s) + fundSum(s, T, nextT)));
        ls.push({ t: T, gross: g, cost: changedCost(low, pL, rtPerp, T) + changedCost(high, pS, rtPerp, T), excess: g });
        pL = new Set(low); pS = new Set(high);
      }
    }
    judge(`${sig}-LO`, { L, leg: 'LO' }, lo, 28);
    judge(`${sig}-LS`, { L, leg: 'LS' }, ls, 28);
  }

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'study.json'), JSON.stringify(results, null, 1));
  console.log(`\npassing cells: ${results.filter((r) => r.pass).map((r) => `${r.effect} ${JSON.stringify(r.params)}`).join(', ') || 'none'}`);
}

export const FROZEN_CANDIDATES = [];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'study') runStudy();
  else console.log('usage: node scripts/v6/research/r-lottery.mjs study   (DUMP=1 also writes each cell events to data/tmp/r-lottery)');
}
