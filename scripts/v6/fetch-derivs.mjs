#!/usr/bin/env node
/**
 * Fetches Binance USDT-M perp history: 1d and 4h klines and funding events, for
 * every perp obtainable (live, settled, and archive-only delisted symbols).
 * Public endpoints only. Rows go to derivs/dev or derivs/holdout by t. Holdout
 * rows are written unread: this script logs row counts for them, never content.
 *
 *   node scripts/v6/fetch-derivs.mjs              fetch everything, resumable
 *   node scripts/v6/fetch-derivs.mjs --dev-only   skip the holdout stages
 *   node scripts/v6/fetch-derivs.mjs --symbols=BTCUSDT,ETHUSDT
 *   node scripts/v6/fetch-derivs.mjs --backfill   merge archive klines where REST lost them
 *   node scripts/v6/fetch-derivs.mjs --oi         daily open interest, 10 majors only
 *   node scripts/v6/fetch-derivs.mjs --report     DEV-only coverage and funding tables
 *
 * Writes data/research/v6/READY-derivs.flag once DEV funding and 1d load.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { loadBars } from '../../shared/trading/v6Bars.js';
import {
  DEV_END, HOLDOUT_START, HOUR_MS, TIMEFRAME_MS, VENUES, closedBars, fundingIntervals, loadFunding, loadOpenInterest,
  loadPerpBars, loadVenueBars, normalizeFunding, splitAtHoldout,
} from '../../shared/trading/v6Derivs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V6 = path.join(ROOT, 'data', 'research', 'v6');
const STORE = path.join(V6, 'derivs');
const MANIFEST = path.join(STORE, 'manifest.json');
const FAPI = 'https://fapi.binance.com';
const ARCHIVE = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const VISION = 'https://data.binance.vision';
const DAY_MS = 24 * HOUR_MS;
const OI_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT'];

const args = process.argv.slice(2);
const devOnly = args.includes('--dev-only');
const symbolArg = args.find((a) => a.startsWith('--symbols='))?.slice(10).split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Smooth pacer: each caller reserves the next slot, so bursts never form. */
function pacer(perMinute) {
  let next = 0;
  return async (cost = 1) => {
    const now = Date.now();
    const slot = Math.max(next, now);
    next = slot + (cost * 60000) / perMinute;
    if (slot > now) await sleep(slot - now);
  };
}
// Published: 2400 weight/min overall and 500 per 5 min on fundingRate. We use well
// under both, because other agents share this IP.
const klinePace = pacer(900);
const fundingPace = pacer(70);
const oiPace = pacer(600); // static files on a CDN, no published limit
let pauseUntil = 0;

async function getJson(url, pace, cost) {
  for (let attempt = 0; attempt < 7; attempt++) {
    await pace(cost);
    if (Date.now() < pauseUntil) await sleep(pauseUntil - Date.now());
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      console.log(`  network error (${e.message}), retrying`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const used = Number(res.headers.get('x-mbx-used-weight-1m') || 0);
    if (used > 1500) { pauseUntil = Date.now() + 30000; console.log(`  used weight ${used}, pausing 30s`); }
    if (res.status === 418) {
      console.error(`418 from Binance (IP ban), Retry-After ${res.headers.get('retry-after')}. Stopping; rerun resumes.`);
      saveManifest();
      process.exit(2);
    }
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 60) * 1000;
      pauseUntil = Date.now() + wait;
      console.log(`  429, pausing ${wait / 1000}s`);
      continue;
    }
    if (res.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    const body = await res.json();
    // -1121 unknown to REST, -1122 listed but not yet trading: neither has history.
    if (res.status === 400 && (body.code === -1121 || body.code === -1122)) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  }
  throw new Error(`gave up on ${url}`);
}

async function archiveSymbols(prefix) {
  const out = [];
  let marker = '';
  for (;;) {
    const res = await fetch(`${ARCHIVE}?prefix=${prefix}&delimiter=/&marker=${marker}`, { signal: AbortSignal.timeout(30000) });
    const xml = await res.text();
    for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) out.push(m[1].slice(prefix.length, -1));
    const next = xml.match(/<NextMarker>([^<]+)</);
    if (!next) return out;
    marker = next[1];
  }
}

/** Union of exchangeInfo USDT perps and the archive, which still lists many delisted ones. */
async function allSymbols() {
  const info = await getJson(`${FAPI}/fapi/v1/exchangeInfo`, klinePace, 1);
  const perps = info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT');
  const tradfi = new Set(info.symbols.filter((s) => s.contractType === 'TRADIFI_PERPETUAL').map((s) => s.symbol));
  const archived = [
    ...await archiveSymbols('data/futures/um/monthly/klines/'),
    ...await archiveSymbols('data/futures/um/monthly/fundingRate/'),
  ].filter((s) => /^[A-Z0-9]+USDT$/.test(s) && !tradfi.has(s));
  return [...new Set([...perps.map((s) => s.symbol), ...archived])].sort();
}

// Holdout progress sits in its own file: a row count there says which coins
// survived past 2024, which DEV research must not be able to read off the manifest.
const HOLDOUT_MANIFEST = path.join(STORE, 'holdout', 'manifest.json');
const readManifest = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).items : {});
const manifest = { items: { ...readManifest(MANIFEST), ...readManifest(HOLDOUT_MANIFEST) } };
function writeManifest(file, keep) {
  mkdirSync(path.dirname(file), { recursive: true });
  const items = Object.fromEntries(Object.entries(manifest.items).filter(([k]) => keep(k)));
  writeFileSync(`${file}.tmp`, JSON.stringify({ items }));
  renameSync(`${file}.tmp`, file);
}
function saveManifest() {
  writeManifest(MANIFEST, (k) => k.startsWith('dev/'));
  writeManifest(HOLDOUT_MANIFEST, (k) => k.startsWith('holdout/'));
}

function writeRows(split, dataset, symbol, rows) {
  const dir = path.join(STORE, split, dataset);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${symbol}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(rows));
  renameSync(`${file}.tmp`, file);
}

async function fetchKlines(symbol, timeframe, start, end) {
  const rows = [];
  let from = start;
  for (;;) {
    const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=1000&startTime=${from}&endTime=${end}`;
    const page = await getJson(url, klinePace, 5);
    if (!page || page.length === 0) break;
    for (const k of page) rows.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
    if (page.length < 1000) break;
    from = page[page.length - 1][0] + 1;
  }
  return rows;
}

async function fetchFundingRaw(symbol, start, end) {
  const rows = [];
  let from = start;
  for (;;) {
    const url = `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1000&startTime=${from}&endTime=${end}`;
    const page = await getJson(url, fundingPace, 1);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < 1000) break;
    from = page[page.length - 1].fundingTime + 1;
  }
  return rows;
}

// startTime=0 reads as "not set" and returns the NEWEST rows, which from a DEV
// query would be holdout data, so DEV starts at 1. Holdout funding backs up an
// hour so a stamp just before midnight that aligns forward onto 2025-01-01 is kept.
async function fetchItem(split, dataset, symbol) {
  const dev = split === 'dev';
  const now = Date.now();
  let rows;
  if (dataset === 'funding') {
    const raw = await fetchFundingRaw(symbol, dev ? 1 : HOLDOUT_START - HOUR_MS, dev ? DEV_END : now);
    rows = splitAtHoldout(normalizeFunding(raw))[split];
  } else {
    const raw = await fetchKlines(symbol, dataset, dev ? 1 : HOLDOUT_START, dev ? DEV_END : now);
    rows = splitAtHoldout(closedBars(raw, dataset, now))[split];
  }
  if (rows.length) writeRows(split, dataset, symbol, rows);
  const entry = { done: true, rows: rows.length };
  if (dev && rows.length) { entry.first = rows[0][0]; entry.last = rows[rows.length - 1][0]; }
  manifest.items[`${split}/${dataset}/${symbol}`] = entry;
}

async function stage(split, dataset, symbols, workers) {
  const todo = symbols.filter((s) => !manifest.items[`${split}/${dataset}/${s}`]?.done);
  console.log(`[${split}/${dataset}] ${todo.length} to fetch, ${symbols.length - todo.length} already done`);
  let next = 0, finished = 0, failed = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < todo.length) {
      const symbol = todo[next++];
      try {
        await fetchItem(split, dataset, symbol);
      } catch (e) {
        failed++;
        console.log(`  ${split}/${dataset}/${symbol} failed: ${e.message}`);
      }
      if (++finished % 25 === 0 || finished === todo.length) {
        saveManifest();
        console.log(`[${split}/${dataset}] ${finished}/${todo.length} (${failed} failed)`);
      }
    }
  }));
  return failed;
}

/** Extracts the one CSV from a single-entry zip, via the central directory. */
function unzipSingle(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(body) : body).toString('utf8');
}

/** Last 5-minute open interest sample of one UTC day, or null when the file is absent. */
async function oiForDay(symbol, day) {
  const url = `${VISION}/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await oiPace();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = unzipSingle(Buffer.from(await res.arrayBuffer())).trim().split(/\r?\n/);
      const cols = lines[lines.length - 1].split(',');
      const t = Date.parse(`${cols[0].replace(' ', 'T')}Z`);
      return Number.isFinite(t) && cols[2] ? [t, +cols[2], +cols[3]] : null;
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  return null;
}

/**
 * Daily open interest for OI_SYMBOLS from the public metrics archive. The REST
 * endpoint only reaches back 30 days, and the archive is one file per symbol per
 * day, so this is deliberately a short list rather than every perp.
 */
async function fetchOpenInterest() {
  const days = [];
  for (let t = Date.UTC(2020, 8, 1); t + 2 * DAY_MS < Date.now(); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  for (const symbol of OI_SYMBOLS) {
    if (manifest.items[`dev/oi/${symbol}`]?.done && manifest.items[`holdout/oi/${symbol}`]?.done) continue;
    const wanted = devOnly ? days.filter((d) => Date.parse(d) < HOLDOUT_START) : days;
    const rows = [];
    let next = 0, finished = 0;
    await Promise.all([0, 1, 2].map(async () => {
      while (next < wanted.length) {
        const row = await oiForDay(symbol, wanted[next++]);
        if (row) rows.push(row);
        if (++finished % 500 === 0) console.log(`[oi/${symbol}] ${finished}/${wanted.length}`);
      }
    }));
    rows.sort((a, b) => a[0] - b[0]);
    const split = splitAtHoldout(rows);
    for (const part of devOnly ? ['dev'] : ['dev', 'holdout']) {
      if (split[part].length) writeRows(part, 'oi', symbol, split[part]);
      const entry = { done: true, rows: split[part].length };
      if (part === 'dev' && split.dev.length) { entry.first = split.dev[0][0]; entry.last = split.dev.at(-1)[0]; }
      manifest.items[`${part}/oi/${symbol}`] = entry;
    }
    saveManifest();
    console.log(`[oi/${symbol}] done, ${split.dev.length} DEV days`);
  }
}

/** Monthly archive CSV -> store rows. Older files have no header row. */
function parseArchiveKlines(csv) {
  const rows = [];
  for (const line of csv.trim().split(/\r?\n/)) {
    const k = line.split(',');
    const t = Number(k[0]);
    if (Number.isFinite(t)) rows.push([t, +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
  }
  return rows;
}

async function archiveMonths(symbol, timeframe) {
  const prefix = `data/futures/um/monthly/klines/${symbol}/${timeframe}/`;
  await oiPace();
  const res = await fetch(`${ARCHIVE}?prefix=${prefix}`, { signal: AbortSignal.timeout(30000) });
  const xml = await res.text();
  return [...xml.matchAll(/<Key>[^<]*-(\d{4}-\d{2})\.zip<\/Key>/g)].map((m) => m[1]);
}

async function archiveKlines(symbol, timeframe, month) {
  const url = `${VISION}/data/futures/um/monthly/klines/${symbol}/${timeframe}/${symbol}-${timeframe}-${month}.zip`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await oiPace();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseArchiveKlines(unzipSingle(Buffer.from(await res.arrayBuffer())));
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  return [];
}

function storedFile(split, dataset, symbol) {
  const file = path.join(STORE, split, dataset, `${symbol}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

/**
 * REST klines have lost the history of some perps that were delisted or relisted
 * (SXPUSDT is unknown to REST, ICPUSDT starts 16 months late), while their funding
 * survives. The monthly archive still holds many of them, so any perp whose archive
 * starts before its stored bars gets merged in. REST rows win on overlap.
 */
async function backfillFromArchive() {
  const symbols = await allSymbols();
  const now = Date.now();
  const log = [];
  let checked = 0;
  for (const symbol of symbols) {
    if (++checked % 100 === 0) console.log(`[backfill] ${checked}/${symbols.length} checked`);
    const months = await archiveMonths(symbol, '1d');
    const firstMonth = months.filter((m) => m < '2025-01').sort()[0];
    if (!firstMonth) continue;
    const firstStored = manifest.items[`dev/1d/${symbol}`]?.first;
    if (firstStored !== undefined && firstMonth >= day(firstStored).slice(0, 7)) continue;
    for (const timeframe of ['1d', '4h']) {
      const wanted = await archiveMonths(symbol, timeframe);
      const archived = [];
      for (const month of wanted) archived.push(...await archiveKlines(symbol, timeframe, month));
      const parts = splitAtHoldout(closedBars(archived, timeframe, now));
      for (const split of ['dev', 'holdout']) {
        const rest = storedFile(split, timeframe, symbol);
        const merged = closedBars([...parts[split], ...rest], timeframe, now);
        if (merged.length === rest.length) continue;
        writeRows(split, timeframe, symbol, merged);
        const entry = { done: true, rows: merged.length, archiveRows: merged.length - rest.length };
        if (split === 'dev') {
          entry.first = merged[0][0];
          entry.last = merged[merged.length - 1][0];
          log.push(`${symbol} ${timeframe}: +${entry.archiveRows} DEV bars, now from ${day(entry.first)}`);
          console.log(`[backfill] ${log[log.length - 1]}`);
        }
        manifest.items[`${split}/${timeframe}/${symbol}`] = entry;
      }
    }
    saveManifest();
  }
  saveManifest();
  console.log(`[backfill] finished, ${log.length} DEV series extended`);
}

const day = (t) => new Date(t).toISOString().slice(0, 10);
const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const devSymbols = (rel) => {
  const dir = path.join(V6, rel);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
};
const medianOf = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

/** Annualised sum of funding and the time-weighted share negative, over `rows`. */
function fundingStats(rows) {
  if (rows.length < 2) return null;
  let sum = 0, negative = 0, total = 0;
  rows.forEach((r, i) => {
    sum += r.rate;
    const gap = Math.min((i + 1 < rows.length ? rows[i + 1].t - r.t : r.t - rows[i - 1].t), 8 * HOUR_MS);
    total += gap;
    if (r.rate < 0) negative += gap;
  });
  return { annual: (sum * 365 * DAY_MS) / total, negative: negative / total };
}

/** Markdown tables for docs/rebuild/data-derivs.md. DEV only: every read goes through the locked loaders. */
function devReport() {
  const out = [];
  const say = (line = '') => out.push(line);
  const fundingNames = devSymbols('derivs/dev/funding');
  const barNames = devSymbols('derivs/dev/1d');
  const rawBars = loadPerpBars({ symbols: barNames, timeframe: '1d', raw: true });
  const bars = loadPerpBars({ symbols: barNames, timeframe: '1d' });
  const rawFunding = loadFunding({ symbols: fundingNames, raw: true });
  const funding = loadFunding({ symbols: fundingNames });

  const lastDay = HOLDOUT_START - DAY_MS;
  const dead = [...bars].filter(([, r]) => r.at(-1).t < lastDay);
  let tailBars = 0, tailFunding = 0;
  for (const [s, r] of rawBars) tailBars += r.length - (bars.get(s)?.length ?? 0);
  for (const [s, r] of rawFunding) tailFunding += r.length - (funding.get(s)?.length ?? 0);
  let gapCount = 0, gapSymbols = 0, midZero = 0, badOhlc = 0;
  const gapList = [];
  for (const [s, r] of bars) {
    let found = false;
    r.forEach((b, i) => {
      if (i && b.t - r[i - 1].t > DAY_MS) { gapCount++; found = true; gapList.push(`${s} ${day(r[i - 1].t)}..${day(b.t)}`); }
      if (b.qv === 0) midZero++;
      if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.l <= 0) badOhlc++;
    });
    if (found) gapSymbols++;
  }
  say('## Perp coverage (DEV)');
  say();
  say('| Item | Value |');
  say('|---|---|');
  say(`| Perps with DEV funding files | ${fundingNames.length} |`);
  say(`| Perps with DEV 1d files | ${barNames.length} |`);
  say(`| Perps with real trading in DEV (after dead tail cut) | ${bars.size} |`);
  say(`| First 1d bar | ${day(Math.min(...[...bars.values()].map((r) => r[0].t)))} |`);
  say(`| Perps whose last traded bar is before 2024-12-31 | ${dead.length} |`);
  say(`| Dead-tail 1d bars cut by the loader | ${tailBars} |`);
  say(`| Dead-tail funding events cut by the loader | ${tailFunding} |`);
  say(`| Missing-day gaps in 1d | ${gapCount} across ${gapSymbols} perps |`);
  say(`| Zero-volume 1d bars inside a live span | ${midZero} |`);
  say(`| 1d bars failing OHLC sanity | ${badOhlc} |`);
  say(`| Funding files with no 1d file | ${fundingNames.filter((s) => !barNames.includes(s)).join(' ') || 'none'} |`);
  say();
  if (gapList.length) say(`1d gaps, first 40: ${gapList.slice(0, 40).join('; ')}`);
  say();
  say(`Delisted in DEV: ${dead.map(([s, r]) => `${s} ${day(r.at(-1).t)}`).join(', ')}`);
  say();

  say('## Funding intervals (DEV)');
  say();
  const histogram = {};
  const changed = [];
  let outages = 0, outageSymbols = 0, nullMarks = 0, events = 0, typed = 0, maxAbs = [0, ''];
  const outageList = [];
  for (const [s, rows] of funding) {
    const { regimes, gaps } = fundingIntervals(rows);
    const distinct = [...new Set(regimes.filter((r) => r.events >= 3).map((r) => r.hours))];
    for (const h of distinct) histogram[h] = (histogram[h] || 0) + 1;
    if (distinct.length > 1 || (distinct.length === 1 && distinct[0] !== 8)) {
      const sustained = regimes.filter((r) => r.events >= 3);
      changed.push(`${s}: ${sustained.map((r) => `${r.hours}h from ${day(r.from)}`).join(', ')}`);
    }
    if (gaps.length) { outages += gaps.length; outageSymbols++; for (const g of gaps) outageList.push(`${s} ${day(g.from)}..${day(g.to)}`); }
    for (const r of rows) {
      events++;
      if (r.mark === null) nullMarks++;
      if (r.type) typed++;
      if (Math.abs(r.rate) > maxAbs[0]) maxAbs = [Math.abs(r.rate), `${s} ${day(r.t)} ${r.rate}`];
    }
  }
  say(`Perps per sustained interval (3+ events in a row; one perp can appear twice): ${JSON.stringify(histogram)}.`);
  say(`Events: ${events}. Mark price missing on ${pct(nullMarks / events)}. Non-Regular type on ${typed}. Largest single rate: ${maxAbs[1]}.`);
  say(`Gaps over 8h: ${outages} across ${outageSymbols} perps. First 30: ${outageList.slice(0, 30).join('; ')}`);
  say();
  say(`Perps not on a constant 8h (${changed.length}), first 60:`);
  say();
  for (const line of changed.slice(0, 60)) say(`- ${line}`);
  say();

  say('## Funding by year (DEV)');
  say();
  const ranked = [...bars]
    .filter(([s, r]) => r.at(-1).t === lastDay && r.length >= 200 && !/^(USDC|BTCDOM|DEFI)USDT$/.test(s))
    .map(([s, r]) => ({ s, qv: medianOf(r.slice(-30).map((b) => b.qv)) }))
    .sort((a, b) => b.qv - a.qv).map((x) => x.s);
  const names = ['BTCUSDT', 'ETHUSDT', ...ranked.filter((s) => s !== 'BTCUSDT' && s !== 'ETHUSDT').slice(0, 8)];
  const years = [2019, 2020, 2021, 2022, 2023, 2024];
  const inYear = (rows, y) => rows.filter((r) => new Date(r.t).getUTCFullYear() === y);
  say('Mean annualised funding, long pays when positive. Alts are the top 8 by 30-day median perp quote volume at 2024-12-31, so this list carries that date\'s hindsight for earlier years. Blank means the perp had under 2 events that year; 2019 starts on 2019-09-10.');
  say();
  say(`| Perp | ${years.join(' | ')} |`);
  say(`|---|${years.map(() => '---').join('|')}|`);
  for (const s of names) say(`| ${s} | ${years.map((y) => { const x = fundingStats(inYear(funding.get(s) ?? [], y)); return x ? pct(x.annual) : ''; }).join(' | ')} |`);
  const cross = years.map((y) => [...funding.values()].map((r) => fundingStats(inYear(r, y))).filter(Boolean));
  say(`| Median perp | ${cross.map((c) => (c.length ? pct(medianOf(c.map((x) => x.annual))) : '')).join(' | ')} |`);
  say(`| Perps counted | ${cross.map((c) => c.length).join(' | ')} |`);
  say();
  say('Share of time funding was negative (time-weighted by interval):');
  say();
  say(`| Perp | ${years.join(' | ')} |`);
  say(`|---|${years.map(() => '---').join('|')}|`);
  for (const s of names) say(`| ${s} | ${years.map((y) => { const x = fundingStats(inYear(funding.get(s) ?? [], y)); return x ? pct(x.negative) : ''; }).join(' | ')} |`);
  say(`| Median perp | ${cross.map((c) => (c.length ? pct(medianOf(c.map((x) => x.negative))) : '')).join(' | ')} |`);
  say();

  const coinsFile = path.join(V6, 'venues', 'coins.json');
  if (existsSync(coinsFile)) {
    const coins = JSON.parse(readFileSync(coinsFile, 'utf8'));
    say('## Second venues (DEV, spot)');
    say();
    say(`${coins.length} coins. Agreement is |venue close / (perp close / multiplier) - 1| on shared 1d bars.`);
    say();
    say('| Venue | tf | Coins with rows | Earliest | Median first bar | Gaps | Median abs diff | p99 abs diff |');
    say('|---|---|---|---|---|---|---|---|');
    const flagged = [], missing = {};
    for (const venue of VENUES) {
      for (const timeframe of ['1d', '4h']) {
        const loaded = loadVenueBars(venue, { symbols: coins.map((c) => c.spot), timeframe });
        if (!loaded.size) continue;
        let gaps = 0;
        const diffs = [];
        for (const [spot, rows] of loaded) {
          rows.forEach((b, i) => { if (i && b.t - rows[i - 1].t > TIMEFRAME_MS[timeframe]) gaps++; });
          if (timeframe !== '1d') continue;
          const coin = coins.find((c) => c.spot === spot);
          const perp = new Map((bars.get(coin.perp) ?? []).map((b) => [b.t, b.c / coin.multiplier]));
          const mine = rows.filter((b) => perp.has(b.t)).map((b) => Math.abs(b.c / perp.get(b.t) - 1));
          diffs.push(...mine);
          const med = medianOf(mine);
          const p99 = [...mine].sort((a, b) => a - b)[Math.floor(mine.length * 0.99)];
          if (med > 0.01 || p99 > 0.05) flagged.push(`${venue} ${spot}: median ${pct(med, 2)}, p99 ${pct(p99, 1)} over ${mine.length} days`);
        }
        if (timeframe === '1d') missing[venue] = coins.filter((c) => !loaded.has(c.spot)).map((c) => c.spot);
        const firsts = [...loaded.values()].map((r) => r[0].t);
        diffs.sort((a, b) => a - b);
        say(`| ${venue} | ${timeframe} | ${loaded.size} | ${day(Math.min(...firsts))} | ${day(medianOf(firsts))} | ${gaps} | ${diffs.length ? pct(medianOf(diffs), 3) : ''} | ${diffs.length ? pct(diffs[Math.floor(diffs.length * 0.99)], 2) : ''} |`);
      }
    }
    say();
    say(`No rows: ${Object.entries(missing).map(([v, m]) => `${v}: ${m.join(' ') || 'none'}`).join('; ')}`);
    say();
    say(`Coins disagreeing with the perp by over 1% median or 5% p99: ${flagged.join('; ') || 'none'}`);
    say();
    say('## Binance spot store check (DEV, 1d close)');
    say();
    say('| Compared with spot store | Coins | Days | Median abs diff | p99 abs diff |');
    say('|---|---|---|---|---|');
    const spotBars = loadBars({ symbols: coins.map((c) => c.spot), timeframe: '1d' });
    const spotFlags = [];
    const compare = (label, seriesFor) => {
      const diffs = [];
      let used = 0;
      for (const coin of coins) {
        const spot = spotBars.get(coin.spot);
        const other = seriesFor(coin);
        if (!spot || !other) continue;
        const mine = spot.filter((b) => other.has(b.t)).map((b) => Math.abs(b.c / other.get(b.t) - 1));
        if (!mine.length) continue;
        used++;
        diffs.push(...mine);
        const sorted = [...mine].sort((a, b) => a - b);
        const p99 = sorted[Math.floor(mine.length * 0.99)];
        if (medianOf(mine) > 0.01 || p99 > 0.05) spotFlags.push(`${label} ${coin.spot}: median ${pct(medianOf(mine), 2)}, p99 ${pct(p99, 1)}`);
      }
      diffs.sort((a, b) => a - b);
      if (diffs.length) say(`| ${label} | ${used} | ${diffs.length} | ${pct(medianOf(diffs), 3)} | ${pct(diffs[Math.floor(diffs.length * 0.99)], 2)} |`);
    };
    compare('Binance perp', (c) => (bars.has(c.perp) ? new Map(bars.get(c.perp).map((b) => [b.t, b.c / c.multiplier])) : null));
    for (const venue of VENUES) {
      const loaded = loadVenueBars(venue, { symbols: coins.map((c) => c.spot), timeframe: '1d' });
      compare(venue, (c) => (loaded.has(c.spot) ? new Map(loaded.get(c.spot).map((b) => [b.t, b.c])) : null));
    }
    say();
    say(`Flagged: ${spotFlags.join('; ') || 'none'}`);
    say();
  }

  const oi = loadOpenInterestSafe();
  if (oi.size) {
    say('## Open interest (DEV)');
    say();
    say('| Perp | Days | First | Last |');
    say('|---|---|---|---|');
    for (const [s, r] of oi) say(`| ${s} | ${r.length} | ${day(r[0].t)} | ${day(r.at(-1).t)} |`);
    say();
  }
  writeFileSync(path.join(ROOT, 'data', 'tmp', 'data-derivs', 'report.md'), `${out.join('\n')}\n`);
  console.log('report written to data/tmp/data-derivs/report.md');
}

function loadOpenInterestSafe() {
  const names = devSymbols('derivs/dev/oi');
  return names.length ? loadOpenInterest({ symbols: names }) : new Map();
}

function writeReadyFlag() {
  const funding = loadFunding({ symbols: ['BTCUSDT'] }).get('BTCUSDT');
  const bars = loadPerpBars({ symbols: ['BTCUSDT'], timeframe: '1d' }).get('BTCUSDT');
  if (!funding.length || !bars.length) throw new Error('DEV load check failed: BTCUSDT empty');
  const count = (d) => Object.keys(manifest.items)
    .filter((k) => k.startsWith(`dev/${d}/`) && manifest.items[k].rows > 0).length;
  writeFileSync(path.join(V6, 'READY-derivs.flag'), `${JSON.stringify({
    at: new Date().toISOString(), fundingSymbols: count('funding'), bars1dSymbols: count('1d'),
    btcFundingRows: funding.length, btcBars1d: bars.length,
  })}\n`);
  console.log('READY-derivs.flag written');
}

if (args.includes('--report')) {
  devReport();
  process.exit(0);
}
if (args.includes('--backfill')) {
  await backfillFromArchive();
  process.exit(0);
}
if (args.includes('--oi')) {
  await fetchOpenInterest();
  process.exit(0);
}

const listed = await allSymbols();
const symbols = symbolArg || listed;
console.log(`${symbols.length} symbols`);

let fundingDevFailed = null, barsDevFailed = null;
const maybeReady = () => {
  if (fundingDevFailed === 0 && barsDevFailed === 0 && !symbolArg) writeReadyFlag();
};
const fundingLane = (async () => {
  fundingDevFailed = await stage('dev', 'funding', symbols, 2);
  maybeReady();
  return fundingDevFailed + (devOnly ? 0 : await stage('holdout', 'funding', symbols, 2));
})();
const klineLane = (async () => {
  barsDevFailed = await stage('dev', '1d', symbols, 2);
  maybeReady();
  let failed = barsDevFailed + await stage('dev', '4h', symbols, 2);
  if (!devOnly) {
    failed += await stage('holdout', '1d', symbols, 2);
    failed += await stage('holdout', '4h', symbols, 2);
  }
  return failed;
})();
const failures = (await fundingLane) + (await klineLane);
saveManifest();
console.log(failures ? `finished with ${failures} failures; rerun to retry them` : 'finished, no failures');
process.exit(failures ? 1 : 0);
