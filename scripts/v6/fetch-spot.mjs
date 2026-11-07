#!/usr/bin/env node
/**
 * V6 spot data: discover every Binance USDT pair ever listed, download klines, clean them.
 *
 *   node scripts/v6/fetch-spot.mjs --discover
 *   node scripts/v6/fetch-spot.mjs --fetch --phase dev --tf 1d,4h
 *   node scripts/v6/fetch-spot.mjs --build --phase dev --tf 1d
 *   node scripts/v6/fetch-spot.mjs --fetch --phase holdout --tf 1d,4h,1h --refresh   (extend to the latest closed bar)
 *
 * Public endpoints only. Resumable: raw files are appended page by page, and a
 * rerun continues from each file's last bar. Holdout bars are written and counted,
 * never printed. Output layout is described in shared/trading/v6Bars.js.
 */
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLDOUT_START, TF_MS, isExcludedSymbol } from '../../shared/trading/v6Bars.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE = path.join(ROOT, 'data', 'research', 'v6');
const API = 'https://data-api.binance.vision/api/v3';
const BUCKET = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const CONCURRENCY = 3;
const WEIGHT_CEILING = 2400; // published limit is 6000 per minute per IP
const ROW_BYTES = 56;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}

// One shared pause for all workers, so a rate-limit signal stops everything at once.
let pausedUntil = 0;
let usedWeight = 0;
async function politeGet(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      log('network error, retrying:', e.message);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const w = Number(res.headers.get('x-mbx-used-weight-1m'));
    if (w) {
      usedWeight = w;
      if (w >= WEIGHT_CEILING) pausedUntil = Math.max(pausedUntil, (Math.floor(Date.now() / 60000) + 1) * 60000 + 1000);
    }
    if (res.status === 429 || res.status === 418) {
      const retry = Number(res.headers.get('retry-after')) || 60;
      pausedUntil = Date.now() + (retry + 5) * 1000;
      log(`HTTP ${res.status}: pausing all workers for ${retry + 5}s`);
      if (res.status === 418) { log('IP ban signal, stopping.'); process.exit(3); }
      continue;
    }
    if (res.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    return res;
  }
  throw new Error(`gave up on ${url}`);
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  }));
}

async function bucketPairs() {
  const out = [];
  let marker = '';
  for (;;) {
    const q = `delimiter=/&prefix=data/spot/monthly/klines/&max-keys=1000${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`;
    const xml = await (await politeGet(`${BUCKET}?${q}`)).text();
    for (const m of xml.matchAll(/<Prefix>data\/spot\/monthly\/klines\/([^/<]+)\/<\/Prefix>/g)) out.push(m[1]);
    const nm = xml.match(/<NextMarker>([^<]+)</);
    if (!nm) return out;
    marker = nm[1];
  }
}

/** Finds pairs from three sources. The result sits under holdout/ because today's status is future information. */
async function discover() {
  const info = await (await politeGet(`${API}/exchangeInfo`)).json();
  const bucket = await bucketPairs();
  const status = new Map(info.symbols.filter((s) => s.quoteAsset === 'USDT').map((s) => [s.symbol, s.status]));
  const fromBucket = bucket.filter((s) => s.endsWith('USDT') && !status.has(s));
  log(`exchangeInfo USDT pairs ${status.size}, extra in bucket ${fromBucket.length}`);

  // A coin may have lost its USDT pair from both lists yet still answer on klines (NBTUSDT
  // does), so probe every base asset known from any other quote currency.
  const QUOTES = ['USDT', 'BTC', 'ETH', 'BNB', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'TRY', 'EUR', 'BRL', 'AUD', 'GBP',
    'RUB', 'PAX', 'USDS', 'BIDR', 'IDRT', 'UAH', 'NGN', 'ZAR', 'DAI', 'VAI', 'BKRW', 'XRP', 'TRX', 'DOGE', 'DOT',
    'JPY', 'MXN', 'PLN', 'RON', 'ARS', 'COP', 'CZK', 'USDP', 'AEUR', 'EURI', 'BVND', 'GYEN', 'USD1'];
  const bases = new Set(info.symbols.map((s) => s.baseAsset));
  for (const s of bucket) {
    const q = QUOTES.find((x) => s.endsWith(x) && s.length > x.length);
    if (q) bases.add(s.slice(0, -q.length));
  }
  const known = new Set([...status.keys(), ...fromBucket]);
  const candidates = [...bases].map((b) => `${b}USDT`).filter((s) => !known.has(s) && /^[A-Z0-9]+$/.test(s));
  log(`probing ${candidates.length} other base assets for a hidden USDT pair`);
  const fromProbe = [];
  await pool(candidates, async (s) => {
    const res = await politeGet(`${API}/klines?symbol=${s}&interval=1d&limit=1&startTime=0`);
    if (res.ok && (await res.json()).length) fromProbe.push(s);
  });
  log(`hidden pairs found by probing: ${fromProbe.length} ${fromProbe.join(' ')}`);

  const all = [...known, ...fromProbe].sort();
  const symbols = all.filter((s) => !isExcludedSymbol(s));
  writeJsonAtomic(path.join(STORE, 'holdout', 'discovery.json'), {
    at: new Date().toISOString(), exchangeInfoPairs: status.size, bucketOnly: fromBucket, probedOnly: fromProbe,
    probed: candidates.length, excluded: all.filter(isExcludedSymbol),
    symbols: symbols.map((s) => ({ symbol: s, status: status.get(s) ?? 'UNLISTED' })),
  });
  log(`discovered ${all.length} USDT pairs, ${symbols.length} after exclusions`);
}

const rawFile = (phase, tf, symbol) => path.join(STORE, phase, 'raw', tf, `${symbol}.bin`);

/** Trims a torn last row left by a crash and returns the last bar time, or null. */
function resumePoint(file) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const whole = size - (size % ROW_BYTES);
  const fd = openSync(file, 'r+');
  try {
    if (whole !== size) ftruncateSync(fd, whole);
    if (!whole) return null;
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, whole - ROW_BYTES);
    return buf.readDoubleLE(0);
  } finally { closeSync(fd); }
}

async function fetchSymbol(symbol, tf, phase) {
  const file = rawFile(phase, tf, symbol);
  mkdirSync(path.dirname(file), { recursive: true });
  const last = resumePoint(file);
  const end = phase === 'dev' ? HOLDOUT_START - 1 : Date.now();
  let start = last !== null ? last + TF_MS[tf] : phase === 'dev' ? 0 : HOLDOUT_START;
  for (;;) {
    const res = await politeGet(`${API}/klines?symbol=${symbol}&interval=${tf}&limit=1000&startTime=${start}&endTime=${end}`);
    if (!res.ok) throw new Error(`${symbol} ${tf}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const rows = await res.json();
    const closed = rows.filter((k) => k[6] < Date.now());
    if (closed.length) {
      const buf = Buffer.alloc(closed.length * ROW_BYTES);
      closed.forEach((k, i) => {
        [k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]].forEach((x, j) => buf.writeDoubleLE(x, i * ROW_BYTES + j * 8));
      });
      appendFileSync(file, buf);
      start = closed.at(-1)[0] + TF_MS[tf];
    }
    if (rows.length < 1000) return;
  }
}

async function fetchAll(tfs, phase) {
  const { symbols } = JSON.parse(readFileSync(path.join(STORE, 'holdout', 'discovery.json')));
  for (const tf of tfs) {
    const statePath = path.join(STORE, phase, 'raw', `state-${tf}.json`);
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {};
    const todo = symbols.map((s) => s.symbol).filter((s) => flag('refresh') || !state[s]);
    log(`${phase} ${tf}: ${todo.length} symbols to fetch of ${symbols.length}`);
    let done = 0, failed = 0;
    await pool(todo, async (s) => {
      try { await fetchSymbol(s, tf, phase); state[s] = true; }
      catch (e) { failed++; log('FAILED', e.message); }
      if (++done % 50 === 0) { writeJsonAtomic(statePath, state); log(`${phase} ${tf}: ${done}/${todo.length}, weight ${usedWeight}`); }
    });
    writeJsonAtomic(statePath, state);
    log(`${phase} ${tf}: finished, ${failed} failed`);
  }
}

function readRaw(part, tf, symbol) {
  const file = rawFile(part, tf, symbol);
  if (!existsSync(file)) return [];
  const buf = readFileSync(file);
  const f = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % ROW_BYTES)));
  const bars = [];
  for (let i = 0; i < f.length; i += 7) bars.push({ t: f[i], o: f[i + 1], h: f[i + 2], l: f[i + 3], c: f[i + 4], v: f[i + 5], qv: f[i + 6] });
  return bars;
}

function writeBars(file, bars) {
  mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(bars.length * ROW_BYTES);
  bars.forEach((b, i) => [b.t, b.o, b.h, b.l, b.c, b.v, b.qv].forEach((x, j) => buf.writeDoubleLE(x, i * ROW_BYTES + j * 8)));
  writeFileSync(`${file}.tmp`, buf);
  renameSync(`${file}.tmp`, file);
}

/**
 * Finds breaks in a pair's daily series. Binance does not back-adjust klines, so across a
 * trading halt a token swap shows up as an exact power-of-ten price step (a redenomination:
 * same coin, holders kept their value), and a reused ticker shows up as any other huge step
 * (a different coin). Left alone, both would read as enormous fake returns.
 */
function detectEvents(daily) {
  const events = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1], bar = daily[i];
    if ((bar.t - prev.t) / TF_MS['1d'] - 1 < 3) continue;
    const ratio = bar.o / prev.c, log = Math.log10(ratio), power = Math.round(log);
    if (power !== 0 && Math.abs(ratio / 10 ** power - 1) <= 0.12) events.push({ t: bar.t, kind: 'redenomination', factor: 10 ** power, ratio });
    else if (Math.abs(log) >= 1.5) events.push({ t: bar.t, kind: 'relisted_as_new_coin', ratio });
  }
  return events;
}

/** Puts prices on the post-swap scale. Holdout events scale forward so DEV never depends on them. */
function applyRedenominations(bars, events) {
  const out = bars.map((b) => ({ ...b }));
  for (const e of events.filter((x) => x.kind === 'redenomination')) {
    const dev = e.t < HOLDOUT_START;
    const scale = dev ? e.factor : 1 / e.factor;
    for (const b of out) {
      if (dev ? b.t >= e.t : b.t < e.t) continue;
      if (!dev && b.t < HOLDOUT_START) continue;
      b.o *= scale; b.h *= scale; b.l *= scale; b.c *= scale; b.v /= scale;
    }
  }
  return out;
}

function cleanBars(bars, tf, stats) {
  const seen = new Set();
  const out = [];
  for (const b of [...bars].sort((x, y) => x.t - y.t)) {
    if (seen.has(b.t)) { stats.duplicates++; continue; }
    seen.add(b.t);
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) { stats.droppedNonPositive++; continue; }
    if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) {
      stats.ohlcRepaired++;
      b.h = Math.max(b.h, b.o, b.c);
      b.l = Math.min(b.l, b.o, b.c);
    }
    out.push(b);
  }
  // A dead pair can print empty bars after trading stopped; death is the last real trade.
  while (out.length && out.at(-1).v === 0) { out.pop(); stats.trailingZeroStripped++; }
  return out;
}

/** Bars are flagged, not altered: these are real prints we cannot prove wrong, and clipping them flatters stops. */
function flagBars(bars, tf) {
  const flags = [];
  bars.forEach((b, i) => {
    const kinds = [];
    if (b.v === 0) kinds.push('zero_volume');
    const spike = b.h / Math.max(b.o, b.c) > 4 || b.l / Math.min(b.o, b.c) < 0.25;
    if (spike) kinds.push(i === 0 ? 'listing_spike' : 'wick');
    if (i && b.t - bars[i - 1].t > TF_MS[tf]) kinds.push('gap_before');
    if (kinds.length) flags.push({ t: b.t, kinds });
  });
  return flags;
}

function buildPart(part, tf, symbols) {
  const flags = {}, eventsOut = {};
  const totals = { bars: 0, duplicates: 0, droppedNonPositive: 0, ohlcRepaired: 0, trailingZeroStripped: 0 };
  for (const symbol of symbols) {
    const devDaily = readRaw('dev', '1d', symbol);
    const daily = part === 'dev' ? devDaily : devDaily.concat(readRaw('holdout', '1d', symbol));
    const events = detectEvents(daily);
    const inPart = events.filter((e) => (part === 'dev') === (e.t < HOLDOUT_START));
    if (inPart.length) eventsOut[symbol] = inPart;
    const raw = readRaw(part, tf, symbol);
    if (!raw.length) continue;
    const scaled = applyRedenominations(raw, events);
    const cuts = events.filter((e) => e.kind === 'relisted_as_new_coin').map((e) => e.t);
    const segments = new Map();
    for (const b of scaled) {
      const k = cuts.filter((c) => c <= b.t).length;
      if (!segments.has(k)) segments.set(k, []);
      segments.get(k).push(b);
    }
    for (const [k, bars] of segments) {
      const id = k ? `${symbol}~${k + 1}` : symbol;
      const clean = cleanBars(bars, tf, totals);
      // VENUSDT printed one empty bar months after its swap: a ghost, not a tradable coin.
      if (!clean.length || (k && clean.reduce((a, b) => a + b.qv, 0) < 1000)) continue;
      totals.bars += clean.length;
      writeBars(path.join(STORE, part, tf, `${id}.bin`), clean);
      const f = flagBars(clean, tf);
      if (f.length) flags[id] = f;
    }
  }
  writeJsonAtomic(path.join(STORE, part, `flags-${tf}.json`), flags);
  writeJsonAtomic(path.join(STORE, part, `events-${tf}.json`), eventsOut);
  writeJsonAtomic(path.join(STORE, part, `build-${tf}.json`), { at: new Date().toISOString(), ...totals });
  // Holdout results stay quiet: row counts only.
  log(`built ${part} ${tf}: ${totals.bars} bars`);
  if (part === 'dev') log(JSON.stringify(totals), `events on ${Object.keys(eventsOut).length} pairs`);
}

function buildAll(tfs, phase) {
  const { symbols } = JSON.parse(readFileSync(path.join(STORE, 'holdout', 'discovery.json')));
  for (const tf of tfs) buildPart(phase, tf, symbols.map((s) => s.symbol));
}

const tfs = opt('tf', '1d,4h').split(',');
const phase = opt('phase', 'dev');
if (flag('discover')) await discover();
if (flag('fetch')) await fetchAll(tfs, phase);
if (flag('build')) buildAll(tfs, phase);
