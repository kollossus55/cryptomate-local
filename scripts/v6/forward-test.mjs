// LOCAL CHANGE (2026-11-13): forward test of four near-miss strategies. Research only: it never
// touches Portfolio, the engine, a certificate or an API key, and places no orders.
// Pre-registration, frozen candidates and the review rule: docs/rebuild/forward-test.md.
//
//   node scripts/v6/forward-test.mjs           one run: fetch new closed bars, log new fills (hourly, app scheduler)
//   node scripts/v6/forward-test.mjs --status  coverage and fill counts; never returns or prices
//   node scripts/v6/forward-test.mjs review    the scorecard; refuses before 2027-05-14
//
// Bars go to data/research/v6-forward/forward/<tf>/<SYMBOL>.bin in the v6 store format, read through
// v6Bars' forward view, which never opens dev or holdout files.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DAY_MS, FORWARD_REVIEW, FORWARD_START, TF_MS, isExcludedSymbol, loadBars, openForwardView, pointInTimeUniverse, tierFor,
} from '../../shared/trading/v6Bars.js';
import { DEFAULT_RISK_CONFIG, clampRiskConfig } from '../../shared/trading/v6Risk.js';
import { prepareMarket, runSim } from '../../shared/trading/v6Sim.js';
import { calmar, maxDrawdown, returnsFromEquity, sharpe } from '../../shared/trading/v6Stats.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STORE = join(ROOT, 'data', 'research', 'v6-forward');
const API = 'https://data-api.binance.vision/api/v3';
const ROW = 7;
export const TIMEFRAMES = ['1d', '4h'];
/** Indicator history only. 450 days covers the 365-day lookback plus the universe's 200-day floor. */
export const WARMUP_FROM = FORWARD_START - 450 * DAY_MS;
export const TRACK_TOP = 60;

/** SHA-256 of each research script at pre-registration. A change stops the run. */
export const FROZEN_HASHES = Object.freeze({
  'r-risk.mjs': '5a1dca6553278d3f7eda014f3783ff5832c72d873bc53a6e5764f213583738fa',
  'r-exits.mjs': 'f1b74ad2a14840ffa7e8a67809486061894887a1c547c0847d1b231a03934e1f',
  'r-trend.mjs': 'ae112214823ce5ccb8bb9ce91faa314bbd1b3e5cf83951b77b44928450731e63',
  'r-breakout.mjs': 'b15459df04c0467a06965f92706149a6c6589f3b54a7b129a2431a03fb82b89f',
});

const researchFile = (name) => join(ROOT, 'scripts', 'v6', 'research', name);

export function checkFrozen(hashes = FROZEN_HASHES) {
  const changed = Object.entries(hashes)
    .filter(([name, want]) => createHash('sha256').update(readFileSync(researchFile(name))).digest('hex') !== want)
    .map(([name]) => name);
  if (changed.length) throw new Error(`Frozen strategy code changed: ${changed.join(', ')}. The forward test stops; see docs/rebuild/forward-test.md.`);
}

/** The four pre-registered candidates, built from the research code exactly as frozen. */
export async function candidates() {
  checkFrozen();
  const load = (name) => import(pathToFileURL(researchFile(name)).href);
  const [rr, re, rt, rb] = await Promise.all(['r-risk.mjs', 'r-exits.mjs', 'r-trend.mjs', 'r-breakout.mjs'].map(load));
  return [
    { id: 'F1', timeframe: '1d', strategy: rr.refBrk20({ n: 20 }), config: { risk: clampRiskConfig({ ...DEFAULT_RISK_CONFIG, ...rr.RECOMMENDED_RISK_CONFIG }) } },
    { id: 'F2', timeframe: '1d', strategy: re.exitTestStrategy({ entry: 'breakout', seed: 1, timeframe: '1d' })({ cfg: 'ph_trend' }), config: { risk: { ...DEFAULT_RISK_CONFIG, maxStopDistancePct: 0.30 } } },
    {
      id: 'F3', timeframe: '1d', symbols: ['BTCUSDT', 'ETHUSDT'],
      strategy: rt.trendFactory({ rule: 'tsmom', universe: 'btceth' })({ L: 365 }),
      // r-trend's riskConfig('btceth'), which the module does not export.
      config: { risk: clampRiskConfig({ ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxPositionPct: 0.25, maxClusterPct: 0.50, volTargetAnnual: 0.20 }) },
    },
    { id: 'F4', timeframe: '4h', strategy: rb.breakoutFactory('donchian', '4h')({ n: 200, exit: 'trend', topN: 30 }), config: { risk: rb.RISK_AT_CEILINGS } },
  ];
}

// ---------- files ----------

const paths = (dir) => ({
  bars: (tf, symbol) => join(dir, 'forward', tf, `${symbol}.bin`),
  tracked: join(dir, 'tracked.json'),
  state: join(dir, 'state.json'),
  runs: join(dir, 'runs.jsonl'),
  log: (id) => join(dir, 'log', `${id}.jsonl`),
});

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
  renameSync(`${file}.tmp`, file);
}

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Open time of the last stored bar, or null. Reads only the file's last row. */
export function lastBarT(file) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  if (size < ROW * 8) return null;
  const buf = readFileSync(file);
  return buf.readDoubleLE(Math.floor(size / (ROW * 8) - 1) * ROW * 8);
}

/** Binance kline rows -> store rows, closed bars after `after` only, oldest first. */
export function closedRows(klines, { now, after = -Infinity }) {
  return klines
    .filter((k) => Number(k[6]) < now && Number(k[0]) > after)
    .map((k) => [Number(k[0]), +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
}

function appendRows(file, rows) {
  if (!rows.length) return;
  mkdirSync(dirname(file), { recursive: true });
  const buf = Buffer.alloc(rows.length * ROW * 8);
  rows.forEach((r, i) => r.forEach((x, j) => buf.writeDoubleLE(x, (i * ROW + j) * 8)));
  appendFileSync(file, buf);
}

/** Top USDT pairs by 24h quote volume, after the v6 exclusions. */
export function topSymbols(tickers, n = TRACK_TOP) {
  return tickers
    .filter((x) => /USDT$/.test(x.symbol) && !isExcludedSymbol(x.symbol) && Number(x.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume) || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, n)
    .map((x) => x.symbol);
}

// ---------- network ----------

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status === 418) throw Object.assign(new Error(`rate limited (${res.status})`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw last;
}

async function fetchBars(file, symbol, tf, now) {
  const tfMs = TF_MS[tf];
  let last = lastBarT(file);
  // The bar after `last` closes at last + 2 bars; nothing to fetch before that.
  if (last !== null && last + 2 * tfMs > now) return 0;
  let added = 0;
  for (let page = 0; page < 10; page++) {
    const start = last === null ? WARMUP_FROM : last + tfMs;
    const klines = await getJson(`${API}/klines?symbol=${symbol}&interval=${tf}&limit=1000&startTime=${start}&endTime=${now}`);
    const rows = closedRows(klines, { now, after: last ?? -Infinity });
    appendRows(file, rows);
    added += rows.length;
    if (rows.length) last = rows.at(-1)[0];
    if (klines.length < 1000) break;
  }
  return added;
}

// ---------- simulation ----------

function simulate(c, { to = Infinity, closeOut = false } = {}) {
  const raw = loadBars({ timeframe: c.timeframe, ...(c.symbols ? { symbols: c.symbols } : {}) });
  return runSim({
    strategies: [c.strategy], bars: prepareMarket(raw), from: FORWARD_START, to, config: c.config,
    costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, closeOut, collectEvents: false,
  });
}

const fillKey = (f) => `${f.t}|${f.symbol}|${f.type}|${f.side}|${f.qty}|${f.price}`;

/** Latest closed bar for a timeframe in the store, read from BTC, or null. */
function latestBar(p, tf) {
  return lastBarT(p.bars(tf, 'BTCUSDT'));
}

// ---------- one run ----------

/** offline: skip the network and simulate what the store holds (tests use synthetic stores). */
export async function runOnce({ dir = STORE, now = Date.now(), offline = false } = {}) {
  const p = paths(dir);
  const state = readJson(p.state, { sims: {} });
  const run = { at: new Date(now).toISOString(), added: 0, newFills: {}, drift: {}, errors: [] };

  // 1. Tracked coins, refreshed once a UTC day. Never shrinks.
  const tracked = readJson(p.tracked, { symbols: {} });
  const today = new Date(now).toISOString().slice(0, 10);
  if (!offline && tracked.day !== today) {
    const top = topSymbols(await getJson(`${API}/ticker/24hr`));
    for (const s of ['BTCUSDT', 'ETHUSDT', ...top]) tracked.symbols[s] ??= { addedAt: today };
    tracked.day = today;
    writeJson(p.tracked, tracked);
  }

  // 2. New closed bars.
  fetching: for (const tf of offline ? [] : TIMEFRAMES) {
    for (const symbol of Object.keys(tracked.symbols)) {
      try { run.added += await fetchBars(p.bars(tf, symbol), symbol, tf, now); }
      catch (e) {
        run.errors.push(`${symbol} ${tf}: ${e.message}`);
        if (e.fatal) break fetching; // rate limited: stop, the next hourly run resumes
      }
    }
  }

  // 3. Re-run each candidate whose timeframe has a new closed bar; log new fills.
  openForwardView({ dir });
  const list = await candidates();
  for (const c of list) {
    const latest = latestBar(p, c.timeframe);
    const sim = (state.sims[c.id] ??= { lastBarT: null, fills: 0 });
    if (latest === null || latest < FORWARD_START + TF_MS[c.timeframe]) continue; // fewer than two forward bars
    if (sim.lastBarT !== null && latest <= sim.lastBarT) continue;
    try {
      const result = simulate(c);
      const logged = readLines(p.log(c.id));
      const seen = new Set(logged.map(fillKey));
      const rerun = new Set(result.fills.map(fillKey));
      // Fills at or before the previous run's last bar were logged then. A re-run that disagrees (a
      // fill that appeared or vanished in the past) is counted as drift, never written into the log.
      // A decision on that last bar fills at the next bar's open, so it is new, not drift.
      const boundary = sim.lastBarT === null ? -Infinity : sim.lastBarT;
      const unseen = result.fills.filter((f) => !seen.has(fillKey(f)));
      const drift = unseen.filter((f) => f.t <= boundary).length + logged.filter((f) => !rerun.has(fillKey(f))).length;
      if (drift) run.drift[c.id] = drift;
      const fresh = unseen.filter((f) => f.t > boundary);
      mkdirSync(dirname(p.log(c.id)), { recursive: true });
      for (const f of fresh) appendFileSync(p.log(c.id), `${JSON.stringify({ ...f, loggedAt: run.at, barT: latest })}\n`);
      run.newFills[c.id] = fresh.length;
      sim.lastBarT = latest;
      sim.fills = logged.length + fresh.length;
    } catch (e) {
      run.errors.push(`${c.id}: ${e.message}`);
    }
  }
  writeJson(p.state, state);
  mkdirSync(dir, { recursive: true });
  appendFileSync(p.runs, `${JSON.stringify(run)}\n`);
  return run;
}

// ---------- status (no returns, no prices) ----------

export function status({ dir = STORE, now = Date.now() } = {}) {
  const p = paths(dir);
  const tracked = readJson(p.tracked, { symbols: {} });
  const state = readJson(p.state, { sims: {} });
  const runs = readLines(p.runs);
  const iso = (t) => (t === null || t === undefined ? '-' : new Date(t).toISOString().slice(0, 16).replace('T', ' '));
  const lastDay = runs.filter((r) => Date.parse(r.at) > now - DAY_MS);
  return {
    trackedCoins: Object.keys(tracked.symbols).length,
    latestBar: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, iso(latestBar(p, tf))])),
    candidates: Object.fromEntries(Object.entries(state.sims).map(([id, s]) => [id, { simulatedTo: iso(s.lastBarT), fillsLogged: s.fills }])),
    runs: runs.length,
    lastRun: runs.at(-1)?.at ?? null,
    errorsLast24h: lastDay.reduce((n, r) => n + r.errors.length, 0),
    driftLast24h: lastDay.reduce((n, r) => n + Object.values(r.drift ?? {}).reduce((a, b) => a + b, 0), 0),
    reviewOpens: new Date(FORWARD_REVIEW).toISOString().slice(0, 10),
  };
}

// ---------- review (pre-registered, locked until FORWARD_REVIEW) ----------

export const SUPPORT_RULE = Object.freeze({ minReturn: 0, minSharpe: 0.5, maxDrawdown: 0.15, minClosedTrades: 10 });

export async function review({ dir = STORE, now = Date.now() } = {}) {
  if (now < FORWARD_REVIEW) {
    throw new Error(`The forward review opens on ${new Date(FORWARD_REVIEW).toISOString().slice(0, 10)}. Nothing is computed before then.`);
  }
  const p = paths(dir);
  openForwardView({ dir });
  const to = FORWARD_REVIEW - 1;
  const btc = loadBars({ timeframe: '1d', symbols: ['BTCUSDT'], from: FORWARD_START, to }).get('BTCUSDT') ?? [];
  const btcEq = btc.map((b) => b.c);
  const hold = { totalReturn: btcEq.length > 1 ? btcEq.at(-1) / btcEq[0] - 1 : 0, sharpe: sharpe(returnsFromEquity(btcEq)), calmar: calmar(btcEq), maxDrawdown: maxDrawdown(btcEq) };
  const out = { window: [new Date(FORWARD_START).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10)], btcHold: hold, candidates: {} };
  for (const c of await candidates()) {
    const r = simulate(c, { to, closeOut: true });
    const s = r.summary;
    const logged = new Set(readLines(p.log(c.id)).filter((f) => f.t < FORWARD_REVIEW).map(fillKey));
    const rerun = r.fills.filter((f) => f.kind !== 'close_out');
    const unmatched = rerun.filter((f) => !logged.has(fillKey(f))).length + Math.max(0, logged.size - rerun.length);
    const checks = {
      positiveReturn: s.totalReturn > SUPPORT_RULE.minReturn,
      sharpe: s.sharpe >= SUPPORT_RULE.minSharpe,
      drawdown: s.maxDrawdown <= SUPPORT_RULE.maxDrawdown,
      beatsBtcHold: s.sharpe > hold.sharpe || s.calmar > hold.calmar,
      enoughTrades: s.closedTrades >= SUPPORT_RULE.minClosedTrades,
      matchesLiveLog: unmatched === 0,
    };
    out.candidates[c.id] = {
      totalReturn: s.totalReturn, sharpe: s.sharpe, calmar: s.calmar, maxDrawdown: s.maxDrawdown, closedTrades: s.closedTrades,
      unmatchedFills: unmatched, checks, forwardSupport: Object.values(checks).every(Boolean),
    };
  }
  appendFileSync(p.runs, `${JSON.stringify({ at: new Date().toISOString(), review: true })}\n`);
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  try {
    if (cmd === '--status') console.log(JSON.stringify(status(), null, 1));
    else if (cmd === 'review') console.log(JSON.stringify(await review(), null, 1));
    else {
      const run = await runOnce();
      // Counts only, so the scheduler's console never shows a result.
      console.log(`forward-test: +${run.added} bars, new fills ${JSON.stringify(run.newFills)}, errors ${run.errors.length}`);
      if (run.errors.length) console.error(run.errors.slice(0, 5).join('\n'));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
