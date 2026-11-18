// Four catalogue ideas (C1-C5), event-study gate first. Research only, DEV data only.
//   node scripts/v6/research/r-catalogue.mjs study      event study, 20 cells, 20 trials
// Pre-registration and results: docs/rebuild/research-r-catalogue.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DAY_MS, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { loadFunding, loadPerpBars } from '../../../shared/trading/v6Derivs.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { trialRecord } from '../../../shared/trading/v6Sim.js';

const AGENT = 'r-catalogue';
const FAMILY = 'catalogue';
const FROM = Date.UTC(2020, 0, 1);
const DEV_TO = Date.UTC(2024, 11, 31, 23);
const LAST_BAR = Date.UTC(2024, 11, 31);
const SPLIT = Date.UTC(2023, 0, 1);
const MAX_TRIALS = 50;
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
  for (let t = FROM - 40 * D; t <= LAST_BAR; t += D) for (const s of uni(20, t)) set.add(s);
  const symbols = [...set];
  const toIndex = (m) => { const out = new Map(); for (const [s, bars] of m) { const x = new Map(); for (const b of bars) x.set(b.t, b); out.set(s, x); } return out; };
  const spot = toIndex(loadBars({ symbols, timeframe: '1d', from: FROM - 400 * D, to: DEV_TO }));
  const perpRaw = new Map();
  for (const s of symbols) {
    try { const m = loadPerpBars({ symbols: [s], timeframe: '1d', from: FROM - 400 * D, to: DEV_TO }); if (m.get(s)?.length) perpRaw.set(s, m.get(s)); } catch { /* no perp under this symbol */ }
  }
  const perp = toIndex(perpRaw);
  const funding = loadFunding({ symbols: [...perp.keys()], from: FROM - 10 * D, to: DEV_TO });
  console.log(`data: ${symbols.length} symbols ever in the top 20, ${perp.size} with a same-symbol perp`);
  return { symbols, spot, perp, funding };
}

// ---------- study ----------

function runStudy() {
  const { symbols, spot, perp, funding } = loadAll();
  const days = []; for (let t = FROM; t <= LAST_BAR; t += D) days.push(t);
  const rtSpot = (s, t) => { const c = costFor(s, tierFor(s, t)); return 2 * (c.feePct + c.slipPct) / 100; };
  const rtPerp = (s, t) => { const c = costFor(s, tierFor(s, t), { instrument: 'perp' }); return 2 * (c.feePct + c.slipPct) / 100; };
  const closeRet = (m, s, t) => { const a = m.get(s)?.get(t - D), b = m.get(s)?.get(t); return a && b && a.c > 0 ? b.c / a.c - 1 : null; };
  const rets = (m, s, endT, n) => { const out = []; for (let t = endT - (n - 1) * D; t <= endT; t += D) { const r = closeRet(m, s, t); if (r === null) return null; out.push(r); } return out; };
  // Sum of funding rates on (fromT, toT]; a short receives it, a long pays it.
  const fundSum = (s, fromT, toT) => { let x = 0; for (const r of funding.get(s) ?? []) if (r.t > fromT && r.t <= toT) x += r.rate; return x; };
  const hold = (m, s, entryT, exitT) => { const a = m.get(s)?.get(entryT), b = m.get(s)?.get(exitT); return a && b && a.o > 0 ? b.c / a.o - 1 : null; };

  // Per-coin unconditional mean daily close-to-close return over DEV days in the top 20.
  const driftOf = (m) => {
    const acc = new Map();
    for (const t of days) for (const s of uni(20, t)) { const r = closeRet(m, s, t); if (r !== null) { const a = acc.get(s) ?? []; a.push(r); acc.set(s, a); } }
    return new Map([...acc].map(([s, a]) => [s, mean(a)]));
  };
  const driftSpot = driftOf(spot), driftPerp = driftOf(perp);

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
    logTrial(`r-catalogue-study-${effect}`, {
      params, sharpe: Number.isFinite(r.netSharpeAnn) ? r.netSharpeAnn : 0, periodsPerYear: blocksPerYear, nObs: bl.length, closedTrades: events.length,
      maxDrawdown: null, totalReturn: null,
    }, `event study ${effect} gross ${pct(r.meanGross)} cost ${pct(r.meanCost)} excess t ${r.tExcessBlocks.toFixed(2)}`);
    console.log(`${effect.padEnd(6)} ${JSON.stringify(params).padEnd(24)} n=${String(events.length).padStart(5)} gross ${pct(r.meanGross).padStart(8)} cost ${pct(r.meanCost)} net ${pct(r.meanNet).padStart(8)} `
      + `excess ${pct(r.meanExcess).padStart(8)} t ${r.tExcessBlocks.toFixed(2).padStart(5)} halves ${pct(h1)}/${pct(h2)} netSR ${r.netSharpeAnn.toFixed(2).padStart(5)} ${r.pass ? 'PASS' : 'FAIL'}`);
  };

  // C1 / C2: overreaction continuation.
  for (const k of [2, 3]) for (const h of [1, 5]) {
    const c1 = [], c2 = [];
    const busy1 = new Map(), busy2 = new Map();
    for (const T of days) {
      const entryT = T + D, exitT = T + h * D;
      if (exitT > LAST_BAR) break;
      for (const s of uni(20, entryT)) {
        const r = closeRet(spot, s, T); const past = rets(spot, s, T - D, 30);
        if (r === null || !past) continue;
        const sig = sd(past);
        if (r > k * sig && !(busy1.get(s) >= entryT)) {
          const g = hold(spot, s, entryT, exitT);
          if (g !== null) { c1.push({ t: entryT, gross: g, cost: rtSpot(s, entryT), excess: g - h * driftSpot.get(s) }); busy1.set(s, exitT); }
        }
        if (r < -k * sig && perp.has(s) && !(busy2.get(s) >= entryT)) {
          const pr = hold(perp, s, entryT, exitT);
          if (pr !== null) {
            const g = -pr + fundSum(s, entryT, exitT + D);
            c2.push({ t: entryT, gross: g, cost: rtPerp(s, entryT), excess: g + h * (driftPerp.get(s) ?? 0) });
            busy2.set(s, exitT);
          }
        }
      }
    }
    judge('C1', { k, h }, c1, 7);
    judge('C2', { k, h }, c2, 7);
  }

  // C3 / C4: pairs among the top 10; same events, C4 needs both perps.
  for (const Z of [1.5, 2]) for (const F of [90, 180]) {
    const c3 = [], c4 = [];
    const openUntil = new Map();
    const logRatio = (a, b, t) => { const x = spot.get(a)?.get(t), y = spot.get(b)?.get(t); return x && y ? Math.log(x.c / y.c) : null; };
    const zAt = (a, b, endT) => {
      const xs = []; for (let t = endT - (F - 1) * D; t <= endT; t += D) { const v = logRatio(a, b, t); if (v === null) return null; xs.push(v); }
      const s = sd(xs); return s > 0 ? (xs[xs.length - 1] - mean(xs)) / s : null;
    };
    for (const T of days) {
      const entryT = T + D;
      if (entryT > LAST_BAR) break;
      const u = uni(10, entryT);
      for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
        const key = `${u[i]}|${u[j]}`;
        if (openUntil.get(key) >= entryT) continue;
        const ra = rets(spot, u[i], T, F), rb = rets(spot, u[j], T, F);
        if (!ra || !rb || !(corr(ra, rb) >= 0.8)) continue;
        const z = zAt(u[i], u[j], T);
        if (z === null || Math.abs(z) < Z) continue;
        const [cheap, rich] = z <= -Z ? [u[i], u[j]] : [u[j], u[i]];
        let exitT = null;
        for (let d = 0; d < 20; d++) {
          const t = entryT + d * D;
          if (t > LAST_BAR) break;
          exitT = t;
          const zc = zAt(cheap, rich, t);
          if (zc !== null && zc >= 0) break;
        }
        if (exitT === null) continue;
        openUntil.set(key, exitT);
        const days_ = Math.round((exitT - entryT) / D) + 1;
        const g3 = hold(spot, cheap, entryT, exitT);
        if (g3 !== null) c3.push({ t: entryT, gross: g3, cost: rtSpot(cheap, entryT), excess: g3 - days_ * driftSpot.get(cheap) });
        if (perp.has(cheap) && perp.has(rich)) {
          const pl = hold(perp, cheap, entryT, exitT), ps = hold(perp, rich, entryT, exitT);
          if (pl !== null && ps !== null) {
            const g4 = pl - ps + fundSum(rich, entryT, exitT + D) - fundSum(cheap, entryT, exitT + D);
            c4.push({ t: entryT, gross: g4, cost: rtPerp(cheap, entryT) + rtPerp(rich, entryT), excess: g4 });
          }
        }
      }
    }
    judge('C3', { Z, F }, c3, 28);
    judge('C4', { Z, F }, c4, 28);
  }

  // C5: correlation-filtered momentum / reversal, Mondays.
  for (const L of [30, 90]) {
    const ls = [], lo = [];
    let prevLong = new Set(), prevShort = new Set(), prevLongLO = new Set();
    for (const T of days) {
      if (new Date(T).getUTCDay() !== 1 || T < FROM + 130 * D) continue;
      const nextT = T + 7 * D;
      if (nextT > LAST_BAR) break;
      const last = T - D;
      const u = uni(20, T).filter((s) => perp.get(s)?.get(T) && perp.get(s)?.get(nextT) && spot.get(s)?.get(T) && spot.get(s)?.get(nextT) && spot.get(s)?.get(last - L * D));
      const r120 = new Map(u.map((s) => [s, rets(spot, s, last, 120)]));
      const v = u.filter((s) => r120.get(s));
      if (v.length < 12) continue;
      const avgCorr = (n) => { const xs = []; for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) xs.push(corr(r120.get(v[i]).slice(-n), r120.get(v[j]).slice(-n))); return mean(xs.filter(Number.isFinite)); };
      const momentum = avgCorr(20) > avgCorr(120);
      const ranked = [...v].sort((a, b) => spot.get(b).get(last).c / spot.get(b).get(last - L * D).c - spot.get(a).get(last).c / spot.get(a).get(last - L * D).c);
      const top = ranked.slice(0, 4), bottom = ranked.slice(-4);
      const longs = momentum ? top : bottom, shorts = momentum ? bottom : top;
      const pOpen = (s, t) => perp.get(s).get(t).o, sOpen = (s, t) => spot.get(s).get(t).o;
      const legL = mean(longs.map((s) => pOpen(s, nextT) / pOpen(s, T) - 1 - fundSum(s, T, nextT)));
      const legS = mean(shorts.map((s) => -(pOpen(s, nextT) / pOpen(s, T) - 1) + fundSum(s, T, nextT)));
      const changed = (now, prev) => now.filter((s) => !prev.has(s));
      // Each leg is 4 equal slots; a changed slot costs one round trip on a quarter of the leg.
      const costLS = [...changed(longs, prevLong), ...changed(shorts, prevShort)].reduce((acc, s) => acc + rtPerp(s, T) / 4, 0);
      ls.push({ t: T, gross: legL + legS, cost: costLS, excess: legL + legS });
      const gLO = mean(longs.map((s) => sOpen(s, nextT) / sOpen(s, T) - 1));
      const ch = changed(longs, prevLongLO);
      const costLO = ch.length ? mean(ch.map((s) => rtSpot(s, T))) * ch.length / 4 : 0;
      lo.push({ t: T, gross: gLO, cost: costLO, excess: gLO - mean(longs.map((s) => 7 * driftSpot.get(s))) });
      prevLong = new Set(longs); prevShort = new Set(shorts); prevLongLO = new Set(longs);
    }
    judge('C5-LS', { L, leg: 'LS' }, ls, 7);
    judge('C5-LO', { L, leg: 'LO' }, lo, 7);
  }

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'study.json'), JSON.stringify(results, null, 1));
  console.log(`\npassing cells: ${results.filter((r) => r.pass).map((r) => `${r.effect} ${JSON.stringify(r.params)}`).join(', ') || 'none'}`);
}

// Nothing passed the event-study gate (2026-11-13), so nothing is frozen.
export const FROZEN_CANDIDATES = [];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'study') runStudy();
  else console.log('usage: node scripts/v6/research/r-catalogue.mjs study   (DUMP=1 also writes each cell events to data/tmp/r-catalogue)');
}
