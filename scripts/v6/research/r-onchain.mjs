// Sentiment and on-chain timing of BTC/ETH (H1-H3), event-study gate. Research only, DEV data only.
//   node scripts/v6/research/r-onchain.mjs study      event study, 6 cells, 6 trials
// Pre-registration and results: docs/rebuild/research-r-onchain.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DAY_MS, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { trialRecord } from '../../../shared/trading/v6Sim.js';

const AGENT = 'r-onchain';
const FAMILY = 'onchain';
const FROM = Date.UTC(2018, 2, 1);
const DEV_TO = Date.UTC(2024, 11, 31, 23);
const LAST_BAR = Date.UTC(2024, 11, 31);
const SPLIT = Date.UTC(2021, 7, 1);
const MAX_TRIALS = 6;
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

const dayOf = (ms) => Math.floor(ms / D) * D;
const ocDir = join(here, '../../../data/research/onchain');
const readJson = (f) => JSON.parse(readFileSync(join(ocDir, f), 'utf8'));

// Every series is cut at DEV_TO so no holdout-period value is ever read.
function loadOnchain() {
  const keep = (m) => new Map([...m].filter(([t]) => t <= DEV_TO));
  const fng = keep(new Map(readJson('fng.json').data.map((r) => [dayOf(Number(r.timestamp) * 1000), Number(r.value)])));
  const stables = keep(new Map(readJson('stables.json').map((r) => [dayOf(Number(r.date) * 1000), Number(r.totalCirculatingUSD.peggedUSD)])));
  const net = keep(new Map(readJson('cm-btc-flows.json').data.map((r) => [dayOf(Date.parse(r.time)), Number(r.FlowOutExNtv) - Number(r.FlowInExNtv)])));
  console.log(`on-chain: fng ${fng.size} days, stables ${stables.size}, btc flows ${net.size}`);
  return { fng, stables, net };
}

// ---------- study ----------

function runStudy() {
  const { fng, stables, net } = loadOnchain();
  const toIndex = (m) => { const out = new Map(); for (const [s, bars] of m) out.set(s, new Map(bars.map((b) => [b.t, b]))); return out; };
  const spot = toIndex(loadBars({ symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '1d', from: FROM - 60 * D, to: DEV_TO }));
  const days = []; for (let t = FROM; t <= LAST_BAR; t += D) days.push(t);
  const rt = (s, t) => { const c = costFor(s, tierFor(s, t)); return 2 * (c.feePct + c.slipPct) / 100; };
  const closeRet = (s, t) => { const a = spot.get(s).get(t - D), b = spot.get(s).get(t); return a && b ? b.c / a.c - 1 : null; };
  const drift = new Map(['BTCUSDT', 'ETHUSDT'].map((s) => [s, mean(days.map((t) => closeRet(s, t)).filter((x) => x !== null))]));
  const openRet = (s, t) => { const a = spot.get(s).get(t), b = spot.get(s).get(t + D); return a && b ? b.o / a.o - 1 : null; };
  console.log(`drift per day: BTC ${pct(drift.get('BTCUSDT'))}, ETH ${pct(drift.get('ETHUSDT'))}`);

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
    logTrial(`r-onchain-study-${effect}`, {
      params, sharpe: Number.isFinite(r.netSharpeAnn) ? r.netSharpeAnn : 0, periodsPerYear: blocksPerYear, nObs: bl.length, closedTrades: events.length,
      maxDrawdown: null, totalReturn: null,
    }, `event study ${effect} gross ${pct(r.meanGross)} cost ${pct(r.meanCost)} excess t ${r.tExcessBlocks.toFixed(2)}`);
    console.log(`${effect.padEnd(6)} ${JSON.stringify(params).padEnd(24)} n=${String(events.length).padStart(5)} gross ${pct(r.meanGross).padStart(8)} cost ${pct(r.meanCost)} net ${pct(r.meanNet).padStart(8)} `
      + `excess ${pct(r.meanExcess).padStart(8)} t ${r.tExcessBlocks.toFixed(2).padStart(5)} halves ${pct(h1)}/${pct(h2)} netSR ${r.netSharpeAnn.toFixed(2).padStart(5)} ${r.pass ? 'PASS' : 'FAIL'}`);
  };

  // H1: buy fear. Signal stamped day T is known at the end of T; enter at the open of T+1.
  for (const [s, name] of [['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH']]) for (const h of [10, 30]) {
    const ev = []; let busy = -Infinity;
    for (const T of days) {
      const entryT = T + D, exitT = T + h * D;
      if (exitT > LAST_BAR) break;
      if (entryT <= busy || !(fng.get(T) <= 20)) continue;
      const a = spot.get(s).get(entryT), b = spot.get(s).get(exitT);
      if (!a || !b) continue;
      const g = b.c / a.o - 1;
      ev.push({ t: entryT, gross: g, cost: rt(s, entryT), excess: g - h * drift.get(s) });
      busy = exitT;
    }
    judge(`H1-${name}`, { coin: name, h }, ev, 28);
  }

  // H2 / H3: daily regime holds. Signal on day d sets the position over day d+1 (open to next open).
  const regime = (effect, params, coins, on) => {
    const ev = []; let held = false;
    for (const T of days) {
      const d = T - D;
      const sig = on(d);
      if (sig === null) { held = false; continue; }
      if (!sig) { held = false; continue; }
      const rs = coins.map((s) => openRet(s, T));
      if (rs.some((r) => r === null)) { held = false; continue; }
      const g = mean(rs);
      ev.push({ t: T, gross: g, cost: held ? 0 : mean(coins.map((s) => rt(s, T))), excess: g - mean(coins.map((s) => drift.get(s))) });
      held = true;
    }
    console.log(`${effect}: in the market ${ev.length} of ${days.length} days, ${ev.filter((e) => e.cost > 0).length} entries`);
    judge(effect, params, ev, 28);
  };
  regime('H2', { lookback: 30, basket: 'BTC+ETH' }, ['BTCUSDT', 'ETHUSDT'], (d) => {
    const a = stables.get(d), b = stables.get(d - 30 * D);
    return a && b ? a > b : null;
  });
  regime('H3', { window: 7, coin: 'BTC' }, ['BTCUSDT'], (d) => {
    let x = 0; for (let i = 0; i < 7; i++) { const v = net.get(d - i * D); if (!Number.isFinite(v)) return null; x += v; }
    return x > 0;
  });

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'study.json'), JSON.stringify(results, null, 1));
  console.log(`\npassing cells: ${results.filter((r) => r.pass).map((r) => `${r.effect} ${JSON.stringify(r.params)}`).join(', ') || 'none'}`);
}

export const FROZEN_CANDIDATES = [];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'study') runStudy();
  else console.log('usage: node scripts/v6/research/r-onchain.mjs study');
}
