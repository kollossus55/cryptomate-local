/**
 * V6 research bar store: loader, holdout lock, point-in-time universe, cost tiers.
 *
 * Files are written by scripts/v6/fetch-spot.mjs, one per timeframe and symbol:
 *   data/research/v6/dev/<tf>/<SYMBOL>.bin       bars with t <  HOLDOUT_START
 *   data/research/v6/holdout/<tf>/<SYMBOL>.bin   bars with t >= HOLDOUT_START
 * A .bin is little-endian Float64 rows of [t,o,h,l,c,v,qv]: exact prices, and far
 * faster to load than JSON, which matters for repeated research runs.
 *
 * Everything here is scoped to a "view". Locked, the view ends at DEV_END and
 * no holdout file is opened, so a coin that died in 2025 looks alive, and a coin
 * listed in 2025 does not exist. Delisting info must not leak the future either.
 *
 * Bar objects are cached and shared between callers: treat them as read-only.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const HOLDOUT_START = Date.UTC(2025, 0, 1);
export const HOLDOUT_TOKEN_SHA256 = '132e23ac759b080970d2f5035f03ec0eda73ec6cc6ae312b3b1fe9066e60d817';
export const DEV_END = HOLDOUT_START - 1;
export const DAY_MS = 86400000;
export const TF_MS = { '1h': 3600000, '4h': 14400000, '1d': DAY_MS };
export const MIN_HISTORY_DAYS = 200;
export const VOLUME_WINDOW_DAYS = 30;
export const TIER2_MIN_QUOTE_VOLUME = 50e6;
const TIER1 = new Set(['BTCUSDT', 'ETHUSDT']);
const ROW = 7;
/** A coin whose last bar is this close to the end of the data is alive, not dead. */
const DEATH_GRACE_MS = 3 * DAY_MS;

const STABLE_OR_FIAT = ['AEUR', 'AUD', 'BFUSD', 'BKRW', 'BUSD', 'DAI', 'EUR', 'EURI', 'FDUSD', 'FRAX', 'GBP',
  'KGST', 'PAX', 'RLUSD', 'RWUSD', 'SUSD', 'TUSD', 'U', 'USD1', 'USDC', 'USDE', 'USDP', 'USDS', 'USDSB',
  'USDSOLD', 'UST', 'USTC', 'XUSD'];
const WRAPPED_OR_PEGGED = ['BETH', 'BNSOL', 'PAXG', 'WBETH', 'WBTC', 'WNXM', 'XAUT'];
// Binance tokenised equities and ETFs: they track a stock, not a crypto market.
const TOKENISED_STOCKS = ('AAOIB AAPLB ADBEB AGPUB ALABB AMATB AMCB AMDB AMZNB APPB ARMB ASMLB ASTSB AVGOB AXTIB ' +
  'BABAB BMNRB BNCB BOTB BRKBB BSPB CBRSB COHRB COINB CRCLB CRDOB CRMB CRWDB CRWVB CYPHB DELLB DJTB DRAMB EWYB ' +
  'FLNCB FWDIB GEVB GLWB GMEB GOOGLB GPROB HIMSB HOODB HPEB IBMB INTCB INTWB IRENB JPMB KORUB KSTRB LITEB LLYB ' +
  'MDBB METAB MRNAB MRVLB MSFTB MSTRB MUB MUUB MVLLB NBISB NFLXB NOKB NVDAB ORCLB PDDB PENGB PLTRB PYPLB QCOMB ' +
  'QNTB QQQB RDDTB RKLBB SECZB SHAZB SKDDB SKHYB SKUUB SMCIB SMHB SNDKB SNXXB SOXLB SOXSB SPCXB SPYB SQQQB STXB ' +
  'TMFB TQQQB TSLAB TSMB USARB USDEB UVXYB VSTB WDCB WENB').split(' ');
const EXCLUDED_BASES = new Set([...STABLE_OR_FIAT, ...WRAPPED_OR_PEGGED, ...TOKENISED_STOCKS, 'BULL', 'BEAR']);
// Suffix matching alone would catch real coins such as JUP or SUPER, so require a known underlying.
const LEVERAGED_UNDERLYINGS = new Set(['1INCH', 'AAVE', 'ADA', 'BCH', 'BNB', 'BTC', 'DOT', 'EOS', 'ETH', 'FIL',
  'LINK', 'LTC', 'SUSHI', 'SXP', 'TRX', 'UNI', 'XLM', 'XRP', 'XTZ', 'YFI']);

/** Base asset of a store id: 'LUNAUSDT~2' -> 'LUNA'. */
export function baseOf(symbol) {
  return symbol.split('~')[0].replace(/USDT$/, '');
}

/** True for stablecoins, fiat, wrapped/pegged tokens, tokenised stocks and leveraged tokens. */
export function isExcludedSymbol(symbol) {
  const base = baseOf(symbol);
  if (EXCLUDED_BASES.has(base)) return true;
  const m = base.match(/^(.+?)(UP|DOWN|BULL|BEAR)$/);
  return Boolean(m && LEVERAGED_UNDERLYINGS.has(m[1]));
}

/**
 * Pairs that ended because the token moved to a new ticker or contract, not because it
 * failed, so the simulator may choose not to apply the delisting haircut. Written from
 * general knowledge, not checked against each announcement. Swap ratios are often not 1:1,
 * so never splice the two price series. Only consulted once the pair is dead in the view.
 */
export const MIGRATIONS = {
  AGIXUSDT: 'FETUSDT', BCCUSDT: 'BCHABCUSDT', BCHABCUSDT: 'BCHUSDT', BTTUSDT: 'BTTCUSDT', BZRXUSDT: 'OOKIUSDT',
  COCOSUSDT: 'COMBOUSDT', EPSUSDT: 'EPXUSDT', ERDUSDT: 'EGLDUSDT', FTMUSDT: 'SUSDT', GALUSDT: 'GUSDT',
  KEEPUSDT: 'TUSDT', KLAYUSDT: 'KAIAUSDT', LENDUSDT: 'AAVEUSDT', MATICUSDT: 'POLUSDT', MCUSDT: 'BEAMXUSDT',
  NANOUSDT: 'XNOUSDT', NPXSUSDT: 'PUNDIXUSDT', NUUSDT: 'TUSDT', OCEANUSDT: 'FETUSDT', POLYUSDT: 'POLYXUSDT',
  RNDRUSDT: 'RENDERUSDT', STRATUSDT: 'STRAXUSDT', TOMOUSDT: 'VICUSDT', VENUSDT: 'VETUSDT', XZCUSDT: 'FIROUSDT',
};

let storeDirOverride = null;
const barCache = new Map();
const listCache = new Map();
const indexCache = new Map();
const dataEndCache = new Map();

/** Points the store at another folder (tests use a fixture) and drops every cache. */
export function configureBarStore({ dir = null } = {}) {
  storeDirOverride = dir;
  clearBarCache();
}

export function clearBarCache() {
  for (const c of [barCache, listCache, indexCache, dataEndCache]) c.clear();
}

// Walks up rather than using a fixed depth: sync-shared.mjs copies this file into function folders.
function storeDir() {
  if (storeDirOverride) return storeDirOverride;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'data', 'research', 'v6');
    if (existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return path.join(process.cwd(), 'data', 'research', 'v6');
    dir = up;
  }
}

export function isHoldoutUnlocked() {
  const token = process.env.V6_HOLDOUT_UNLOCK;
  if (!token) return false;
  return createHash('sha256').update(token).digest('hex') === HOLDOUT_TOKEN_SHA256;
}

function assertAllowed(t, what) {
  if (typeof t !== 'number' || Number.isNaN(t)) throw new TypeError(`${what} must be a time in ms, got ${t}`);
  if (t >= HOLDOUT_START && !isHoldoutUnlocked()) {
    throw new Error(`${what} reaches into the locked holdout (2025-01-01 onward). Research runs stop at DEV_END.`);
  }
}

function assertTimeframe(timeframe) {
  if (!TF_MS[timeframe]) throw new Error(`Unknown timeframe ${timeframe}. Use 1d, 4h or 1h.`);
}

const viewParts = () => (isHoldoutUnlocked() ? ['dev', 'holdout'] : ['dev']);
const barFile = (part, timeframe, symbol) => path.join(storeDir(), part, timeframe, `${symbol}.bin`);

function readPart(part, timeframe, symbol) {
  const key = `${part}/${timeframe}/${symbol}`;
  const cached = barCache.get(key);
  if (cached) return cached;
  const file = barFile(part, timeframe, symbol);
  const bars = [];
  if (existsSync(file)) {
    const buf = readFileSync(file);
    const f = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    for (let i = 0; i + ROW <= f.length; i += ROW) {
      bars.push({ t: f[i], o: f[i + 1], h: f[i + 2], l: f[i + 3], c: f[i + 4], v: f[i + 5], qv: f[i + 6] });
    }
  }
  barCache.set(key, bars);
  return bars;
}

function viewBars(timeframe, symbol) {
  const dev = readPart('dev', timeframe, symbol);
  return isHoldoutUnlocked() ? dev.concat(readPart('holdout', timeframe, symbol)) : dev;
}

/** First index with bars[i].t >= t. */
function lowerBound(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Every symbol with bars for this timeframe in the current view, sorted. */
export function listSymbols({ timeframe = '1d' } = {}) {
  assertTimeframe(timeframe);
  const key = `${viewParts().join('+')}/${timeframe}`;
  if (!listCache.has(key)) {
    const names = new Set();
    for (const part of viewParts()) {
      const dir = path.join(storeDir(), part, timeframe);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) if (f.endsWith('.bin')) names.add(f.slice(0, -4));
    }
    listCache.set(key, [...names].sort());
  }
  return [...listCache.get(key)];
}

/**
 * Closed bars with from <= t <= to, keyed by symbol. Symbols with no bars in range are
 * left out. Omitting `to` means the end of the current view.
 * @param {{symbols?: string[], timeframe: string, from?: number, to?: number}} q
 * @returns {Map<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number,qv:number}>>}
 */
export function loadBars({ symbols, timeframe, from = 0, to } = {}) {
  assertTimeframe(timeframe);
  const end = to === undefined ? (isHoldoutUnlocked() ? Infinity : DEV_END) : Number(to);
  const start = Number(from);
  assertAllowed(end, 'loadBars `to`');
  assertAllowed(start, 'loadBars `from`');
  const out = new Map();
  for (const symbol of symbols ?? listSymbols({ timeframe })) {
    const bars = viewBars(timeframe, symbol);
    const slice = bars.slice(lowerBound(bars, start), lowerBound(bars, end + 1));
    if (slice.length) out.set(symbol, slice);
  }
  return out;
}

function median(sorted) {
  const n = sorted.length, m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * Daily liquidity index for the current view, built once. Row d describes what was known
 * once day d had closed, so nothing can see an unclosed day. Days with no bar count as
 * zero volume in the median: a coin that barely trades must not look liquid.
 */
function universeIndex() {
  const key = viewParts().join('+');
  if (indexCache.has(key)) return indexCache.get(key);
  const symbols = listSymbols({ timeframe: '1d' }).filter((s) => !isExcludedSymbol(s));
  const series = symbols.map((s) => viewBars('1d', s));
  let day0 = Infinity, dayN = -Infinity;
  for (const bars of series) {
    if (!bars.length) continue;
    day0 = Math.min(day0, Math.floor(bars[0].t / DAY_MS));
    dayN = Math.max(dayN, Math.floor(bars.at(-1).t / DAY_MS));
  }
  const nDays = Number.isFinite(day0) ? dayN - day0 + 1 : 0;
  const rows = Array.from({ length: nDays }, () => []);
  const medians = new Map();
  const window = new Float64Array(VOLUME_WINDOW_DAYS);
  symbols.forEach((symbol, si) => {
    const bars = series[si];
    if (!bars.length) return;
    const qv = new Float64Array(nDays);
    const traded = new Uint8Array(nDays);
    for (const b of bars) {
      const d = Math.floor(b.t / DAY_MS) - day0;
      qv[d] = b.qv;
      traded[d] = 1;
    }
    const med = new Float64Array(nDays);
    const first = Math.floor(bars[0].t / DAY_MS) - day0;
    const last = Math.min(nDays - 1, Math.floor(bars.at(-1).t / DAY_MS) - day0 + VOLUME_WINDOW_DAYS);
    let seen = 0;
    for (let d = first; d <= last; d++) {
      seen += traded[d];
      for (let k = 0; k < VOLUME_WINDOW_DAYS; k++) window[k] = d - k >= 0 ? qv[d - k] : 0;
      med[d] = median(window.slice().sort());
      if (traded[d] && seen >= MIN_HISTORY_DAYS && med[d] > 0) rows[d].push(symbol);
    }
    medians.set(symbol, med);
  });
  rows.forEach((row, d) => {
    row.sort((a, b) => medians.get(b)[d] - medians.get(a)[d] || (a < b ? -1 : 1));
  });
  const index = { day0, nDays, rows, medians };
  indexCache.set(key, index);
  return index;
}

/** Row of the last day fully closed at time t, or -1 when no such day exists. */
function closedDayRow(index, t) {
  const d = Math.floor(t / DAY_MS) - 1 - index.day0;
  return d >= 0 && d < index.nDays ? d : -1;
}

/**
 * Coins eligible at time t, most liquid first: >= 200 closed daily bars, traded on the last
 * closed day, ranked by trailing 30-day median quote volume. Uses only days closed by t.
 * @param {number} t
 * @param {{topN?: number, timeframe?: string}} [opts]
 * @returns {string[]}
 */
export function pointInTimeUniverse(t, { topN, timeframe = '1d' } = {}) {
  assertTimeframe(timeframe);
  assertAllowed(t, 'pointInTimeUniverse t');
  const index = universeIndex();
  const row = closedDayRow(index, t);
  if (row < 0) return [];
  let list = index.rows[row];
  if (timeframe !== '1d') {
    const has = new Set(listSymbols({ timeframe }));
    list = list.filter((s) => has.has(s));
  }
  return list.slice(0, topN ?? list.length);
}

/**
 * Trailing 30-day median daily quote volume at time t, in USDT. Zero when unknown.
 * @returns {number}
 */
export function medianQuoteVolume(symbol, t) {
  assertAllowed(t, 'medianQuoteVolume t');
  const index = universeIndex();
  const row = closedDayRow(index, t);
  return row < 0 ? 0 : index.medians.get(symbol)?.[row] ?? 0;
}

/** Cost tier from CONTRACT section 2. A coin with too little data counts as tier 3. */
export function tierFor(symbol, t) {
  if (TIER1.has(symbol)) return 1;
  return medianQuoteVolume(symbol, t) >= TIER2_MIN_QUOTE_VOLUME ? 2 : 3;
}

/**
 * Quality flags for one symbol in the current view: [{ t, kinds }], where kinds holds
 * 'wick', 'listing_spike', 'zero_volume' or 'gap_before'. Flagged bars are left unaltered.
 */
export function barFlags(symbol, { timeframe = '1d' } = {}) {
  assertTimeframe(timeframe);
  const out = [];
  for (const part of viewParts()) {
    const key = `flags/${part}/${timeframe}`;
    if (!barCache.has(key)) {
      const file = path.join(storeDir(), part, `flags-${timeframe}.json`);
      barCache.set(key, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
    }
    out.push(...(barCache.get(key)[symbol] ?? []));
  }
  return out;
}

/** End of the current view: the locked boundary, or the newest bar on disk when unlocked. */
function dataEnd(timeframe) {
  if (!isHoldoutUnlocked()) return HOLDOUT_START;
  if (dataEndCache.has(timeframe)) return dataEndCache.get(timeframe);
  let end = HOLDOUT_START;
  const dir = path.join(storeDir(), 'holdout', timeframe);
  const buf = Buffer.alloc(8);
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.endsWith('.bin')) continue;
    const fd = openSync(path.join(dir, f), 'r');
    try {
      const { size } = fstatSync(fd);
      if (size >= ROW * 8) {
        readSync(fd, buf, 0, 8, size - ROW * 8);
        end = Math.max(end, buf.readDoubleLE(0) + TF_MS[timeframe]);
      }
    } finally { closeSync(fd); }
  }
  dataEndCache.set(timeframe, end);
  return end;
}

/**
 * Listing facts for the simulator's delisting rule, limited to the current view. When
 * `delisted` is true the coin's last tradable price is `lastClose` at the close of
 * `lastBarT`. `deathKind` is 'delisted', 'migrated' (see MIGRATIONS) or null while alive.
 * @returns {null | {symbol:string, timeframe:string, firstBarT:number, lastBarT:number, lastClose:number,
 *   barCount:number, delisted:boolean, deathKind:string|null, migratedTo:string|null}}
 */
export function symbolInfo(symbol, { timeframe = '1d' } = {}) {
  assertTimeframe(timeframe);
  const bars = viewBars(timeframe, symbol);
  if (!bars.length) return null;
  const last = bars.at(-1);
  const delisted = last.t + TF_MS[timeframe] + DEATH_GRACE_MS < dataEnd(timeframe);
  const migratedTo = delisted ? MIGRATIONS[symbol] ?? null : null;
  return {
    symbol, timeframe, firstBarT: bars[0].t, lastBarT: last.t, lastClose: last.c, barCount: bars.length,
    delisted, deathKind: delisted ? (migratedTo ? 'migrated' : 'delisted') : null, migratedTo,
  };
}
