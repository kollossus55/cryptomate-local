#!/usr/bin/env node
/**
 * Fetches OKX and Bybit SPOT daily and 4h bars for the cross-venue replay test.
 * Public endpoints only. Rows go to venues/{dev,holdout}/<venue>/<tf>/ by t, and
 * holdout rows are written unread: only row counts are logged for them.
 *
 * The coin list must not use today's rankings, so it is the union of the top N
 * by trailing 30-day median perp quote volume at each DEV year end, read through
 * the locked loader. It needs the DEV 1d perp store from fetch-derivs.mjs.
 *
 *   node scripts/v6/fetch-venues.mjs            select coins and fetch, resumable
 *   node scripts/v6/fetch-venues.mjs --list     print the coin list and stop
 *   node scripts/v6/fetch-venues.mjs --top=30 --dev-only
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOLDOUT_START, TIMEFRAME_MS, VENUES, closedBars, loadPerpBars, perpToSpot, splitAtHoldout,
} from '../../shared/trading/v6Derivs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V6 = path.join(ROOT, 'data', 'research', 'v6');
const STORE = path.join(V6, 'venues');
const MANIFEST = path.join(STORE, 'manifest.json');

const args = process.argv.slice(2);
const devOnly = args.includes('--dev-only');
const TOP = Number(args.find((a) => a.startsWith('--top='))?.slice(6) || 30);
const CHECKPOINTS = [2020, 2021, 2022, 2023, 2024].map((y) => Date.UTC(y, 11, 31));
const MIN_HISTORY_DAYS = 200;
// Stablecoins, plus Binance's synthetic index perps, which have no spot market.
const EXCLUDED = /^(USDC|BUSD|TUSD|USDP|DAI|FDUSD|EUR|GBP|USDE|BTCDOM|DEFI|FOOTBALL|BLUEBIRD)USDT$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function selectCoins() {
  const manifest = JSON.parse(readFileSync(path.join(V6, 'derivs', 'manifest.json'), 'utf8'));
  const perps = Object.keys(manifest.items)
    .filter((k) => k.startsWith('dev/1d/') && manifest.items[k].rows > 0)
    .map((k) => k.slice(7))
    .filter((s) => !EXCLUDED.test(s));
  const bars = loadPerpBars({ symbols: perps, timeframe: '1d' });
  const firstSeen = new Map();
  for (const t of CHECKPOINTS) {
    const ranked = [];
    for (const [symbol, rows] of bars) {
      const upto = rows.filter((b) => b.t <= t);
      if (upto.length < MIN_HISTORY_DAYS || upto[upto.length - 1].t < t) continue;
      ranked.push({ symbol, qv: median(upto.slice(-30).map((b) => b.qv)) });
    }
    ranked.sort((a, b) => b.qv - a.qv);
    for (const { symbol } of ranked.slice(0, TOP)) if (!firstSeen.has(symbol)) firstSeen.set(symbol, t);
  }
  return [...firstSeen.keys()].map((perp) => ({ perp, ...perpToSpot(perp) }));
}

function pacer(perMinute) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(next, now);
    next = slot + 60000 / perMinute;
    if (slot > now) await sleep(slot - now);
  };
}

/** Each returns { rows, retry } so that one loop owns backoff for both venues. */
const ADAPTERS = {
  okx: {
    // Published 20 requests per 2s on history-candles (600/min); this is 40% of that.
    pace: pacer(240),
    bar: { '1d': '1Dutc', '4h': '4H' }, // plain 1D is cut on Hong Kong midnight, not UTC
    url(spot, timeframe, before) {
      const inst = `${spot.replace(/USDT$/, '')}-USDT`;
      return `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${this.bar[timeframe]}&limit=100&after=${before}`;
    },
    parse(body) {
      if (body.code === '50011') return { retry: true };
      if (body.code === '51001' || body.code === '51000') return { rows: [] }; // instrument unknown
      if (body.code !== '0') throw new Error(`okx ${body.code} ${body.msg}`);
      return { rows: body.data.filter((k) => k[8] === '1').map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]) };
    },
    pageSize: 100,
  },
  bybit: {
    // Published 600 requests per 5s per IP.
    pace: pacer(120),
    interval: { '1d': 'D', '4h': '240' },
    url(spot, timeframe, before) {
      return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${spot}&interval=${this.interval[timeframe]}&end=${before - 1}&limit=1000`;
    },
    parse(body) {
      if (body.retCode === 10006) return { retry: true };
      if (body.retCode === 10001) return { rows: [] }; // symbol unknown
      if (body.retCode !== 0) throw new Error(`bybit ${body.retCode} ${body.retMsg}`);
      return { rows: body.result.list.map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[6]]) };
    },
    pageSize: 1000,
  },
};

async function getPage(adapter, url) {
  for (let attempt = 0; attempt < 7; attempt++) {
    await adapter.pace();
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      console.log(`  network error (${e.message}), retrying`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      console.log(`  HTTP ${res.status}, backing off`);
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    const parsed = adapter.parse(await res.json());
    if (parsed.retry) { await sleep(5000 * 2 ** attempt); continue; }
    return parsed.rows;
  }
  throw new Error(`gave up on ${url}`);
}

/** Both venues page backwards from a cursor, so this walks down to `floor`. */
async function fetchBack(adapter, spot, timeframe, start, floor) {
  const rows = [];
  let before = start;
  for (;;) {
    const page = await getPage(adapter, adapter.url(spot, timeframe, before));
    if (page.length === 0) break;
    rows.push(...page);
    const oldest = Math.min(...page.map((r) => r[0]));
    if (oldest <= floor || oldest >= before) break;
    before = oldest;
  }
  return rows;
}

// Holdout progress sits apart so row counts there cannot be read during DEV work.
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

async function fetchItem(venue, split, timeframe, spot) {
  const dev = split === 'dev';
  const now = Date.now();
  const raw = await fetchBack(ADAPTERS[venue], spot, timeframe, dev ? HOLDOUT_START : now, dev ? 0 : HOLDOUT_START);
  const rows = splitAtHoldout(closedBars(raw, timeframe, now))[split];
  if (rows.length) {
    const dir = path.join(STORE, split, venue, timeframe);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${spot}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(rows));
    renameSync(`${file}.tmp`, file);
  }
  const entry = { done: true, rows: rows.length, offGrid: raw.filter((r) => r[0] % TIMEFRAME_MS[timeframe]).length };
  if (dev && rows.length) { entry.first = rows[0][0]; entry.last = rows[rows.length - 1][0]; }
  manifest.items[`${split}/${venue}/${timeframe}/${spot}`] = entry;
}

async function runVenue(venue, spots) {
  let failures = 0;
  const stages = [['dev', '1d'], ['dev', '4h']];
  if (!devOnly) stages.push(['holdout', '1d'], ['holdout', '4h']);
  for (const [split, timeframe] of stages) {
    const label = `${split}/${venue}/${timeframe}`;
    const todo = spots.filter((s) => !manifest.items[`${label}/${s}`]?.done);
    console.log(`[${label}] ${todo.length} to fetch`);
    let next = 0, finished = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < todo.length) {
        const spot = todo[next++];
        try {
          await fetchItem(venue, split, timeframe, spot);
        } catch (e) {
          failures++;
          console.log(`  ${label}/${spot} failed: ${e.message}`);
        }
        if (++finished % 10 === 0 || finished === todo.length) {
          saveManifest();
          console.log(`[${label}] ${finished}/${todo.length}`);
        }
      }
    }));
  }
  return failures;
}

const coins = selectCoins();
console.log(`${coins.length} coins: ${coins.map((c) => c.perp).join(' ')}`);
if (args.includes('--list')) process.exit(0);
mkdirSync(STORE, { recursive: true });
writeFileSync(path.join(STORE, 'coins.json'), JSON.stringify(coins, null, 1));
const spots = coins.map((c) => c.spot);
const results = await Promise.all(VENUES.map((v) => runVenue(v, spots)));
const failures = results.reduce((a, b) => a + b, 0);
saveManifest();
console.log(failures ? `finished with ${failures} failures; rerun to retry them` : 'finished, no failures');
process.exit(failures ? 1 : 0);
