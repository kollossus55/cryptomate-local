// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
/**
 * V6 derivatives and cross-venue research store: Binance USDT-M perp bars and
 * funding, plus OKX/Bybit spot bars. Node-only (reads files), like v6Bars.js.
 *
 * Layout under data/research/v6/:
 *   derivs/{dev,holdout}/{funding,1d,4h,oi}/<SYMBOL>.json
 *   venues/{dev,holdout}/<venue>/{1d,4h}/<SYMBOL>.json
 * Bar rows are [t,o,h,l,c,v,qv]; funding rows are [t,rate,mark] plus a type
 * string when the exchange tagged the event as anything but 'Regular'.
 *
 * The holdout lock matches contract sections 2 and 5. It is implemented here
 * rather than imported so this module does not depend on v6Bars.js.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOLDOUT_START = Date.UTC(2025, 0, 1);
export const HOLDOUT_TOKEN_SHA256 = '132e23ac759b080970d2f5035f03ec0eda73ec6cc6ae312b3b1fe9066e60d817';
export const DEV_END = HOLDOUT_START - 1;
export const HOUR_MS = 3600e3;
export const TIMEFRAME_MS = { '1d': 24 * HOUR_MS, '4h': 4 * HOUR_MS };
export const VENUES = ['okx', 'bybit'];

/** True only when token hashes to the contract's holdout digest. */
export function holdoutUnlocked(token = process.env.V6_HOLDOUT_UNLOCK) {
  if (!token) return false;
  return createHash('sha256').update(String(token)).digest('hex') === HOLDOUT_TOKEN_SHA256;
}

function toMs(value, name, endOfDay) {
  let ms = NaN;
  if (typeof value === 'number') ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') {
    ms = Date.parse(value);
    // An inclusive `to: '2024-12-31'` means that whole day, as in the contract's DEV definition.
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) ms += 24 * HOUR_MS - 1;
  }
  // NaN and Infinity would compare false against the lock, so they must never get that far.
  if (!Number.isFinite(ms)) throw new TypeError(`${name} is not a valid time: ${String(value)}`);
  return ms;
}

/**
 * Normalises a query range and enforces the lock. `to` is inclusive. An omitted
 * `to` always means the end of DEV, even when unlocked: reading holdout rows has
 * to be asked for explicitly.
 * @returns {{from:number,to:number}}
 */
export function resolveRange({ from, to } = {}) {
  const lo = from === undefined || from === null ? 0 : toMs(from, 'from', false);
  const hi = to === undefined || to === null ? DEV_END : toMs(to, 'to', true);
  if (lo > hi) throw new RangeError(`from is after to (${lo} > ${hi}); an omitted to means the end of DEV`);
  if (hi >= HOLDOUT_START && !holdoutUnlocked()) {
    throw new Error('HOLDOUT LOCKED: range reaches 2025-01-01 or later. Only the final validator may read it.');
  }
  return { from: lo, to: hi };
}

function findDataRoot() {
  // Walks up so generated copies under base44/functions/*/shared/ resolve too.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'data', 'research', 'v6');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('data/research/v6 not found above v6Derivs.js');
    dir = parent;
  }
}

function assertSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) throw new TypeError('symbols must be a non-empty array');
  // Symbols become path segments, so '../holdout/x' must not be able to step round the lock.
  for (const s of symbols) if (!/^[A-Z0-9]+$/.test(s)) throw new TypeError(`bad symbol: ${String(s)}`);
}

function assertTimeframe(timeframe) {
  if (!TIMEFRAME_MS[timeframe]) throw new TypeError(`timeframe must be 1d or 4h, got ${String(timeframe)}`);
}

function readRows(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

/** Reads one symbol across the split, opening holdout files only if the range needs them. */
function storedRows(devFile, holdoutFile, { from, to }) {
  const dev = from <= DEV_END ? readRows(devFile) : [];
  if (dev.length && dev[dev.length - 1][0] >= HOLDOUT_START) {
    throw new Error(`corrupt store: holdout-dated row in ${devFile}`);
  }
  return to >= HOLDOUT_START ? dev.concat(readRows(holdoutFile)) : dev;
}

const inRange = (rows, { from, to }) => rows.filter((r) => r[0] >= from && r[0] <= to);
const toBar = ([t, o, h, l, c, v, qv]) => ({ t, o, h, l, c, v, qv });

/**
 * Binance keeps serving a delisted perp for months or years after it stopped
 * trading: flat zero-volume bars, and funding events at a default 0.01%. A
 * simulator reading those would hold a dead coin at a stale price and never hit
 * the delist exit, so the tail is cut at the last bar that actually traded.
 */
export function trimDeadTail(rows) {
  let end = rows.length;
  while (end > 0 && !(rows[end - 1][6] > 0)) end--;
  return end === rows.length ? rows : rows.slice(0, end);
}

/**
 * Funding events per symbol. `rate` is the raw per-event rate (0.0001 = 0.01%),
 * NOT annualised and NOT per 8h: the interval differs by coin and over time, so
 * charge each event as it occurs. Longs pay when rate > 0. `mark` is null on
 * events where Binance did not record it. Binance also records default-rate
 * events before a perp's first trade and after its last, so events outside the
 * span of its traded daily bars are dropped unless `raw` is set. A perp with no
 * daily bars therefore returns nothing without `raw`.
 * @returns {Map<string, {t:number,rate:number,mark:number|null,type?:string}[]>}
 */
export function loadFunding({ symbols, from, to, raw = false, dataRoot = findDataRoot() }) {
  assertSymbols(symbols);
  const range = resolveRange({ from, to });
  const out = new Map();
  for (const s of symbols) {
    let rows = storedRows(
      path.join(dataRoot, 'derivs', 'dev', 'funding', `${s}.json`),
      path.join(dataRoot, 'derivs', 'holdout', 'funding', `${s}.json`), range);
    if (!raw) {
      const daily = storedRows(
        path.join(dataRoot, 'derivs', 'dev', '1d', `${s}.json`),
        path.join(dataRoot, 'derivs', 'holdout', '1d', `${s}.json`), range);
      const live = trimDeadTail(daily);
      const start = live.length ? live[0][0] : Infinity;
      const until = live.length ? live[live.length - 1][0] + TIMEFRAME_MS['1d'] : -Infinity;
      rows = rows.filter((r) => r[0] >= start && r[0] <= until);
    }
    const kept = inRange(rows, range);
    if (kept.length) out.set(s, kept.map(([t, rate, mark, type]) => (type ? { t, rate, mark, type } : { t, rate, mark })));
  }
  return out;
}

/**
 * Binance USDT-M perp bars. Symbols are perp names, so 1000PEPEUSDT, not PEPEUSDT.
 * The dead tail after delisting is dropped unless `raw` is set.
 * @returns {Map<string, {t:number,o:number,h:number,l:number,c:number,v:number,qv:number}[]>}
 */
export function loadPerpBars({ symbols, timeframe, from, to, raw = false, dataRoot = findDataRoot() }) {
  assertSymbols(symbols);
  assertTimeframe(timeframe);
  const range = resolveRange({ from, to });
  const out = new Map();
  for (const s of symbols) {
    const rows = storedRows(
      path.join(dataRoot, 'derivs', 'dev', timeframe, `${s}.json`),
      path.join(dataRoot, 'derivs', 'holdout', timeframe, `${s}.json`), range);
    const kept = inRange(raw ? rows : trimDeadTail(rows), range);
    if (kept.length) out.set(s, kept.map(toBar));
  }
  return out;
}

/** Second-venue spot bars, keyed by the plain spot symbol (PEPEUSDT). As in loadBars, coins with no rows are left out. */
export function loadVenueBars(venue, { symbols, timeframe, from, to, dataRoot = findDataRoot() }) {
  if (!VENUES.includes(venue)) throw new TypeError(`unknown venue: ${String(venue)}`);
  assertSymbols(symbols);
  assertTimeframe(timeframe);
  const range = resolveRange({ from, to });
  const out = new Map();
  for (const s of symbols) {
    const kept = inRange(storedRows(
      path.join(dataRoot, 'venues', 'dev', venue, timeframe, `${s}.json`),
      path.join(dataRoot, 'venues', 'holdout', venue, timeframe, `${s}.json`), range), range);
    if (kept.length) out.set(s, kept.map(toBar));
  }
  return out;
}

/**
 * Daily open interest for the short list in fetch-derivs.mjs: the last 5-minute
 * sample of each UTC day. `oi` is in coins, `oiValue` in USDT.
 * @returns {Map<string, {t:number,oi:number,oiValue:number}[]>}
 */
export function loadOpenInterest({ symbols, from, to, dataRoot = findDataRoot() }) {
  assertSymbols(symbols);
  const range = resolveRange({ from, to });
  const out = new Map();
  for (const s of symbols) {
    const kept = inRange(storedRows(
      path.join(dataRoot, 'derivs', 'dev', 'oi', `${s}.json`),
      path.join(dataRoot, 'derivs', 'holdout', 'oi', `${s}.json`), range), range);
    if (kept.length) out.set(s, kept.map(([t, oi, oiValue]) => ({ t, oi, oiValue })));
  }
  return out;
}

/**
 * Splits a perp name into its spot equivalent and contract multiplier:
 * 1000PEPEUSDT trades 1000 PEPE per unit, so its price is 1000x spot.
 */
export function perpToSpot(symbol) {
  const m = symbol.match(/^(1000000|1000|1M)(?=[A-Z])(.+)$/);
  if (!m) return { spot: symbol, multiplier: 1 };
  return { spot: m[2], multiplier: m[1] === '1000' ? 1000 : 1e6 };
}

/**
 * Exchange funding stamps carry jitter around the hour (1599235200006). Events
 * are scheduled on whole hours, so snap to the nearest one.
 */
export function alignFundingTime(ms) {
  return Math.round(ms / HOUR_MS) * HOUR_MS;
}

/** Raw /fapi/v1/fundingRate rows -> sorted store rows, aligned, one per time. */
export function normalizeFunding(raw) {
  const byTime = new Map();
  for (const r of raw) {
    const t = alignFundingTime(Number(r.fundingTime));
    const mark = r.markPrice === '' || r.markPrice === undefined ? null : Number(r.markPrice);
    const row = [t, Number(r.fundingRate), mark];
    if (r.rateType && r.rateType !== 'Regular') row.push(r.rateType);
    byTime.set(t, row);
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

/** Keeps only bars fully closed by `now`, on the timeframe grid, sorted and unique. */
export function closedBars(rows, timeframe, now) {
  assertTimeframe(timeframe);
  const ms = TIMEFRAME_MS[timeframe];
  const byTime = new Map();
  for (const r of rows) if (r[0] % ms === 0 && r[0] + ms <= now) byTime.set(r[0], r);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

/** Splits store rows on the holdout boundary by their t (first element). */
export function splitAtHoldout(rows) {
  return {
    dev: rows.filter((r) => r[0] < HOLDOUT_START),
    holdout: rows.filter((r) => r[0] >= HOLDOUT_START),
  };
}

/**
 * Funding interval regimes in a series of events: runs of the same gap, with
 * outage-sized gaps (over 8h) reported separately rather than as a regime.
 * @returns {{regimes:{hours:number,from:number,to:number,events:number}[],gaps:{from:number,to:number}[]}}
 */
export function fundingIntervals(rows) {
  const regimes = [];
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const hours = (rows[i].t - rows[i - 1].t) / HOUR_MS;
    if (hours > 8) { gaps.push({ from: rows[i - 1].t, to: rows[i].t }); continue; }
    const last = regimes[regimes.length - 1];
    if (last && last.hours === hours) { last.to = rows[i].t; last.events++; }
    else regimes.push({ hours, from: rows[i - 1].t, to: rows[i].t, events: 1 });
  }
  return { regimes, gaps };
}
