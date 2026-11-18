/**
 * V6 multi-venue public market-data hub.
 *
 * Public, unauthenticated endpoints only: there is no signing code and no API
 * key anywhere in this file, and there must never be one. Everything is plain
 * fetch + ESM, so it runs unchanged in Node, Deno and the browser.
 *
 * Canonical symbols are Binance-style: BTCUSDT (or BTCUSD for a USD price).
 * Every result is expressed in the quote that was ASKED for. A venue that only
 * has the other quote is converted through the measured USDT/USD basis, or is
 * skipped when the basis cannot be measured. hub.bars() is the one exception:
 * past bars cannot be converted with today's basis, so they stay in the venue's
 * quote and say so in `bars.meta`.
 *
 * This hub serves LIVE data only and has no date range on purpose. Research
 * must use v6Bars.loadBars(), which enforces the holdout lock.
 *
 * Measured quirks and the reasoning behind the default priorities are in
 * docs/rebuild/exchanges.md.
 */

export const HOUR_MS = 3600e3;
export const TIMEFRAMES = { '1h': HOUR_MS, '4h': 4 * HOUR_MS, '1d': 24 * HOUR_MS };

/** Hard ceiling from the contract: no request may wait longer than this. */
export const MAX_TIMEOUT_MS = 8000;

export const DEFAULT_HUB_CONFIG = {
  timeoutMs: 6000,
  failureThreshold: 3,        // consecutive failures before the breaker opens
  cooldownMs: 30e3,           // first open; doubles on each failed probe
  maxCooldownMs: 15 * 60e3,
  rateLimitCooldownMs: 60e3,  // 429 without a Retry-After
  banCooldownMs: 5 * 60e3,    // 418: Binance's "you ignored the 429s" response
  geoBlockCooldownMs: 30 * 60e3, // 403/451: will not fix itself in seconds
  maxQueueWaitMs: 5000,       // local throttle: past this, fail over instead of waiting
  maxConcurrentPerVenue: 4,
  tickerTtlMs: 2000,
  bookTtlMs: 1000,
  basisTtlMs: 30e3,
  maxBasisAgeMs: 10 * 60e3,   // last good basis stays usable this long
  universeTtlMs: 5 * 60e3,
  staleBarsTtlMs: 30e3,
  notListedTtlMs: 10 * 60e3,
  closeGraceMs: 5000,         // a bar is not final the instant its period ends
  barLagMs: 3 * 60e3,         // venues may publish the just-closed bar a little late
  maxFeedAgeMs: 60e3,         // quote carrying a feed timestamp
  maxTradeAgeMs: 15 * 60e3,   // quote carrying a last-trade timestamp: quiet is not dead
  maxBookAgeMs: 30e3,
  tolerancePct: 0.5,          // consensus: allowed distance between venues
  minVenues: 2,
  pegAlarmPct: 0.5,
  pegSourceTolerancePct: 0.25,
  universeConflictPct: 10,
  latencyWarnMs: 1000,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * code is one of: not_listed, rate_limited, geo_blocked, http, timeout, network,
 * malformed, upstream, bad_data, breaker_open, local_throttle, unsupported,
 * no_basis, all_venues_failed.
 */
export class MarketDataError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const fail = (code, message, extra) => new MarketDataError(code, message, extra);

// These say something about one symbol or about our own pacing, not about the
// venue. Tripping the breaker on them would take a healthy venue out of service
// because somebody asked for a coin it does not list.
const VENUE_ALIVE_CODES = new Set(['not_listed', 'bad_data']);
const NEUTRAL_CODES = new Set(['local_throttle', 'unsupported', 'no_basis']);

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/**
 * Accepts BTCUSDT, BTC-USDT, BTC/USDT, BTC_USDT, BTCUSD or a bare BTC (= USDT).
 * USDT is checked first so BTCUSDT is not read as "BTCUSDT quoted in nothing".
 * @returns {{ base: string, quote: 'USDT'|'USD', symbol: string }}
 */
export function parseSymbol(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('unsupported', `Bad symbol: ${input}`);
  const text = input.trim().toUpperCase();
  const parts = text.split(/[-/_]/);
  let base = text;
  let quote = 'USDT';
  if (parts.length === 2) [base, quote] = parts;
  else if (parts.length > 2) throw fail('unsupported', `Bad symbol: ${input}`);
  else if (text.endsWith('USDT') && text.length > 4) base = text.slice(0, -4);
  else if (text.endsWith('USD') && text.length > 3) { base = text.slice(0, -3); quote = 'USD'; }
  else if (text.endsWith('USDC') && text.length > 4) quote = 'USDC';
  if (quote !== 'USDT' && quote !== 'USD') throw fail('unsupported', `Only USDT and USD quotes are supported: ${input}`);
  if (!/^[A-Z0-9]+$/.test(base) || base === quote) throw fail('unsupported', `Bad symbol: ${input}`);
  return { base, quote, symbol: `${base}${quote}` };
}

/** Kraken still uses its pre-ISO names for these two. */
const KRAKEN_BASE = { BTC: 'XBT', DOGE: 'XDG' };
const KRAKEN_BASE_REVERSE = { XBT: 'BTC', XDG: 'DOGE' };

// ---------------------------------------------------------------------------
// Universe exclusions
// ---------------------------------------------------------------------------

const STABLE_BASES = new Set([
  'USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDG', 'RLUSD', 'PYUSD', 'USDS', 'USD1',
  'USAT', 'USDE', 'USDP', 'USDD', 'GUSD', 'FRAX', 'FRXUSD', 'LUSD', 'SUSD', 'CRVUSD', 'GHO',
  'EURC', 'EURT', 'EURS', 'EURI', 'EURCV', 'EURR', 'AEUR', 'TGBP', 'XSGD', 'USTC', 'UST',
  'MIM', 'DOLA', 'ALUSD', 'BOLD', 'USR', 'USDF', 'USDQ', 'USX', 'AUDD', 'BRZ', 'TRYB', 'MXNB', 'U',
  'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'TRY', 'BRL', 'MXN', 'ZAR', 'PLN', 'ARS', 'IDR', 'UAH', 'NGN', 'SGD',
]);

// A list and not a W* rule: WLD, WIF, WOO, WAVES and WBT are real, unwrapped assets.
const WRAPPED_BASES = new Set([
  'WBTC', 'WETH', 'WBNB', 'WSOL', 'WAVAX', 'WMATIC', 'WPOL', 'WFTM', 'WTRX', 'WCRO', 'WHBAR',
  'CBBTC', 'TBTC', 'BTCB', 'HBTC', 'RENBTC', 'LBTC', 'SOLVBTC', 'FBTC', 'UNIBTC', 'ENZOBTC', 'KBTC', 'XBTC',
  'STETH', 'WSTETH', 'RETH', 'CBETH', 'WBETH', 'BETH', 'WEETH', 'EETH', 'EZETH', 'RSETH', 'METH', 'SWETH', 'OETH', 'FRXETH', 'SFRXETH', 'LSETH',
  'BNSOL', 'JITOSOL', 'MSOL', 'STSOL', 'BBSOL', 'JUPSOL', 'SSOL', 'HSOL',
  'STBTC', 'SAVAX', 'STMATIC', 'SLISBNB', 'ANKRETH',
  'PAXG', 'XAUT', 'KAU', 'KAG', 'XAUM', 'DGX',
]);

// Backstop for when venue tags are unreachable. The tags in universe() are the real source.
const TOKENISED_STOCKS = new Set([
  'AAPLX', 'AMZNX', 'COINX', 'CRCLX', 'GOOGLX', 'HOODX', 'METAX', 'MSTRX', 'NVDAX', 'SPCXX', 'SPYX', 'QQQX', 'TSLAX',
]);

// Binance's old leveraged tokens were <MAJOR>UP/DOWN. A bare UP suffix cannot be
// used: JUP, SYRUP and UP itself are real tokens (marketData.js's rule drops them).
const LEVERAGED_UPDOWN = /^(BTC|ETH|BNB|XRP|ADA|DOT|LINK|LTC|TRX|XLM|FIL|SXP|AAVE|SUSHI|UNI|BCH|EOS|XTZ|YFI|1INCH)(UP|DOWN)$/;
const LEVERAGED_NL = /^[A-Z0-9]+[2-9][LS]$/;   // BTC3L, ETH5S (Gate, KuCoin, Bybit)
const LEVERAGED_BULLBEAR = /^[A-Z0-9]{2,}(BULL|BEAR)$/;

/**
 * Why a base must stay out of a trading universe, or null if it may stay in.
 * @param {string} base
 * @param {Set<string>} [nonCrypto] bases a venue tags as tokenised stock/commodity
 * @returns {'stablecoin'|'wrapped'|'leveraged'|'non_crypto'|null}
 */
export function classifyBase(base, nonCrypto) {
  if (typeof base !== 'string' || !base) return 'non_crypto';
  if (STABLE_BASES.has(base) || /^USD[A-Z0-9]*$/.test(base) || /^[A-Z0-9]+USD$/.test(base)) return 'stablecoin';
  if (WRAPPED_BASES.has(base)) return 'wrapped';
  if (LEVERAGED_UPDOWN.test(base) || LEVERAGED_NL.test(base) || LEVERAGED_BULLBEAR.test(base)) return 'leveraged';
  if (TOKENISED_STOCKS.has(base) || (nonCrypto && nonCrypto.has(base))) return 'non_crypto';
  return null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
const isPos = (x) => Number.isFinite(x) && x > 0;

export function median(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const round = (x, dp = 4) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : null);

const spreadPctOf = (prices) => {
  if (prices.length < 2) return 0;
  const m = median(prices);
  return ((Math.max(...prices) - Math.min(...prices)) / m) * 100;
};

/** USD <-> USDT. `basis` is the USD price of one USDT. */
export function convertQuote(price, from, to, basis) {
  if (from === to) return price;
  if (!isPos(basis)) throw fail('no_basis', `Cannot convert ${from} to ${to} without a basis`);
  return from === 'USD' ? price / basis : price * basis;
}

/**
 * Cost of taking `notional` (in quote units) from one side of a normalised book.
 * slippagePct is measured from the mid and is positive when it costs you. When
 * the book is too thin, complete is false and the figures cover only what filled.
 */
export function estimateSlippage(book, side, notional) {
  const levels = side === 'buy' ? book.asks : book.bids;
  const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
  let remaining = notional, qty = 0, spent = 0, used = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, price * size);
    spent += take;
    qty += take / price;
    remaining -= take;
    used++;
  }
  const avgPrice = qty > 0 ? spent / qty : null;
  const slippagePct = avgPrice === null ? null : ((side === 'buy' ? avgPrice - mid : mid - avgPrice) / mid) * 100;
  return { avgPrice, slippagePct, filledNotional: spent, complete: remaining <= 1e-9, levels: used };
}

/**
 * Raw venue rows -> Bar[]: oldest first, deduped, closed only.
 * `closed: false` from a venue beats the clock. Rows with impossible prices are
 * dropped; a row off the timeframe grid rejects the whole answer, because that
 * means the venue changed its session boundary and every bar would be mislabelled.
 */
export function normalizeBars(rows, timeframe, now, closeGraceMs = DEFAULT_HUB_CONFIG.closeGraceMs) {
  const tfMs = TIMEFRAMES[timeframe];
  const byTime = new Map();
  let dropped = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.t)) { dropped++; continue; }
    if (r.t % tfMs !== 0) throw fail('malformed', `Bar ${r.t} is off the ${timeframe} UTC grid`);
    const valid = isPos(r.o) && isPos(r.h) && isPos(r.l) && isPos(r.c) && Number.isFinite(r.v) && r.v >= 0
      && r.h >= r.l && r.h >= Math.max(r.o, r.c) && r.l <= Math.min(r.o, r.c);
    if (!valid) { dropped++; continue; }
    byTime.set(r.t, r);
  }
  const bars = [...byTime.values()]
    .filter((r) => r.closed !== false && r.t + tfMs + closeGraceMs <= now)
    .sort((a, b) => a.t - b.t)
    .map(({ t, o, h, l, c, v, qv }) => ({ t, o, h, l, c, v, qv: Number.isFinite(qv) ? qv : c * v }));
  return { bars, dropped };
}

/** Bids high to low, asks low to high, numbers only, no empty levels. */
export function normalizeBook(raw, depth) {
  const side = (levels, dir) => (levels || [])
    .map((l) => [num(l[0]), num(l[1])])
    .filter(([p, q]) => isPos(p) && isPos(q))
    .sort((a, b) => (a[0] - b[0]) * dir)
    .slice(0, depth);
  const bids = side(raw.bids, -1);
  const asks = side(raw.asks, 1);
  if (!bids.length || !asks.length) throw fail('bad_data', 'Empty order book');
  if (bids[0][0] >= asks[0][0]) throw fail('bad_data', `Crossed book ${bids[0][0]} >= ${asks[0][0]}`);
  return { bids, asks };
}

/** Attach metadata without changing what the array is: bars[i] stays a plain Bar. */
const withMeta = (array, meta) => Object.defineProperty(array, 'meta', { value: meta, enumerable: false });

// ---------------------------------------------------------------------------
// Venue adapters
// ---------------------------------------------------------------------------

const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** Picks the smallest allowed size that still covers `depth`. */
const atLeast = (sizes, depth) => sizes.find((s) => s >= depth) ?? sizes[sizes.length - 1];

const rowsOf = (x, what) => {
  if (!Array.isArray(x)) throw fail('malformed', `${what}: expected an array`);
  return x;
};

/** Each adapter returns raw rows in the venue's own order; the hub normalises them. */
const binance = {
  id: 'binance', name: 'Binance', baseUrl: 'https://api.binance.com', quote: 'USDT',
  dailyBoundary: 'UTC 00:00', barOrder: 'oldest-first', minIntervalMs: 200, maxBars: 1000, maxDepth: 1000,
  mapBase: (b) => `${b}USDT`,
  classify(status, body) {
    if (body?.code === -1121) return fail('not_listed', 'binance: invalid symbol');
    return null;
  },
  async bars({ get, native, timeframe, limit }) {
    const rows = await get(`/api/v3/klines?${qs({ symbol: native, interval: timeframe, limit })}`);
    return rowsOf(rows, 'binance klines').map((k) => ({
      t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]), qv: num(k[7]),
    }));
  },
  async ticker({ get, native }) {
    const t = await get(`/api/v3/ticker/24hr?${qs({ symbol: native })}`);
    return { bid: num(t.bidPrice), ask: num(t.askPrice), last: num(t.lastPrice), quoteVolume: num(t.quoteVolume), ts: num(t.closeTime), tsKind: 'trade' };
  },
  async book({ get, native, depth }) {
    const b = await get(`/api/v3/depth?${qs({ symbol: native, limit: atLeast([5, 10, 20, 50, 100, 500, 1000], depth) })}`);
    return { bids: b.bids, asks: b.asks, ts: null };
  },
  async allTickers({ get }) {
    const rows = await get('/api/v3/ticker/24hr');
    return rowsOf(rows, 'binance tickers')
      .filter((t) => t.symbol.endsWith('USDT') && Number(t.count) !== 0)
      .map((t) => ({ base: t.symbol.slice(0, -4), quote: 'USDT', price: num(t.lastPrice), quoteVolume: num(t.quoteVolume) }));
  },
};

const OKX_BAR = { '1h': '1H', '4h': '4H', '1d': '1Dutc' }; // plain 1D closes at Hong Kong midnight

const okxData = (body, what) => rowsOf(body?.data, `okx ${what}`);

const okx = {
  id: 'okx', name: 'OKX', baseUrl: 'https://www.okx.com', quote: 'USDT',
  dailyBoundary: 'UTC 00:00 via bar=1Dutc (plain 1D is Hong Kong midnight, 16:00 UTC)',
  barOrder: 'newest-first', minIntervalMs: 200, maxBars: 300, maxDepth: 400,
  mapBase: (b) => `${b}-USDT`,
  classify(status, body) {
    if (body?.code === '51001') return fail('not_listed', 'okx: instrument does not exist');
    if (body?.code === '50011') return fail('rate_limited', 'okx: rate limit', { hard: true });
    if (body?.code !== undefined && body.code !== '0') return fail('upstream', `okx ${body.code}: ${body.msg}`);
    return null;
  },
  async bars({ get, native, timeframe, limit }) {
    const body = await get(`/api/v5/market/candles?${qs({ instId: native, bar: OKX_BAR[timeframe], limit })}`);
    return okxData(body, 'candles').map((k) => ({
      t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]), qv: num(k[7]),
      closed: k[8] === undefined ? undefined : k[8] === '1',
    }));
  },
  async ticker({ get, native }) {
    const t = okxData(await get(`/api/v5/market/ticker?${qs({ instId: native })}`), 'ticker')[0];
    if (!t) throw fail('not_listed', 'okx: empty ticker');
    return { bid: num(t.bidPx), ask: num(t.askPx), last: num(t.last), quoteVolume: num(t.volCcy24h), ts: num(t.ts), tsKind: 'feed' };
  },
  async book({ get, native, depth }) {
    const b = okxData(await get(`/api/v5/market/books?${qs({ instId: native, sz: depth })}`), 'books')[0];
    if (!b) throw fail('not_listed', 'okx: empty book');
    return { bids: b.bids, asks: b.asks, ts: num(b.ts) };
  },
  async allTickers({ get }) {
    return okxData(await get('/api/v5/market/tickers?instType=SPOT'), 'tickers')
      .map((t) => { const [base, quote] = t.instId.split('-'); return { base, quote, price: num(t.last), quoteVolume: num(t.volCcy24h) }; })
      .filter((t) => t.quote === 'USDT' || t.quote === 'USD');
  },
  /** OKX tags tokenised stocks (3) and commodities (4); name rules would hit XLM, XTZ. */
  async nonCryptoBases({ get }) {
    const rows = okxData(await get('/api/v5/public/instruments?instType=SPOT'), 'instruments');
    return rows.filter((i) => i.instCategory && String(i.instCategory) !== '1').map((i) => i.baseCcy).filter(Boolean);
  },
};

const BYBIT_INTERVAL = { '1h': '60', '4h': '240', '1d': 'D' };

const bybit = {
  id: 'bybit', name: 'Bybit', baseUrl: 'https://api.bybit.com', quote: 'USDT',
  dailyBoundary: 'UTC 00:00', barOrder: 'newest-first', minIntervalMs: 200, maxBars: 1000, maxDepth: 200,
  mapBase: (b) => `${b}USDT`,
  classify(status, body) {
    if (body?.retCode === 10001) return fail('not_listed', `bybit: ${body.retMsg}`);
    if (body?.retCode === 10006 || body?.retCode === 10018) return fail('rate_limited', `bybit: ${body.retMsg}`, { hard: true });
    if (body?.retCode !== undefined && body.retCode !== 0) return fail('upstream', `bybit ${body.retCode}: ${body.retMsg}`);
    return null;
  },
  async bars({ get, native, timeframe, limit }) {
    const body = await get(`/v5/market/kline?${qs({ category: 'spot', symbol: native, interval: BYBIT_INTERVAL[timeframe], limit })}`);
    return rowsOf(body?.result?.list, 'bybit kline').map((k) => ({
      t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]), qv: num(k[6]),
    }));
  },
  async ticker({ get, native }) {
    const body = await get(`/v5/market/tickers?${qs({ category: 'spot', symbol: native })}`);
    const t = rowsOf(body?.result?.list, 'bybit tickers')[0];
    if (!t) throw fail('not_listed', 'bybit: empty ticker');
    return { bid: num(t.bid1Price), ask: num(t.ask1Price), last: num(t.lastPrice), quoteVolume: num(t.turnover24h), ts: num(body.time), tsKind: 'feed' };
  },
  async book({ get, native, depth }) {
    const body = await get(`/v5/market/orderbook?${qs({ category: 'spot', symbol: native, limit: depth })}`);
    const r = body?.result;
    if (!r) throw fail('malformed', 'bybit orderbook');
    return { bids: r.b, asks: r.a, ts: num(r.ts) };
  },
  async allTickers({ get }) {
    const body = await get('/v5/market/tickers?category=spot');
    return rowsOf(body?.result?.list, 'bybit tickers')
      .filter((t) => t.symbol.endsWith('USDT'))
      .map((t) => ({ base: t.symbol.slice(0, -4), quote: 'USDT', price: num(t.lastPrice), quoteVolume: num(t.turnover24h) }));
  },
  async nonCryptoBases({ get }) {
    const body = await get('/v5/market/instruments-info?category=spot&limit=1000');
    return rowsOf(body?.result?.list, 'bybit instruments').filter((i) => i.symbolType === 'xstocks').map((i) => i.baseCoin);
  },
};

const KRAKEN_INTERVAL = { '1h': 60, '4h': 240, '1d': 1440 };

/** Kraken renames pairs in responses (XBTUSD -> XXBTZUSD), so take the only data key. */
const krakenFirst = (body, what) => {
  const key = Object.keys(body?.result ?? {}).find((k) => k !== 'last');
  if (!key) throw fail('malformed', `kraken ${what}: no result`);
  return body.result[key];
};

const kraken = {
  id: 'kraken', name: 'Kraken', baseUrl: 'https://api.kraken.com', quote: 'USD', pegSource: true,
  // 1 request/s still drew EGeneral:Too many requests in live probing, hence 2s.
  dailyBoundary: 'UTC 00:00', barOrder: 'oldest-first', minIntervalMs: 2000, maxBars: 720, maxDepth: 500,
  mapBase: (b) => `${KRAKEN_BASE[b] ?? b}USD`,
  classify(status, body) {
    const errors = Array.isArray(body?.error) ? body.error : [];
    if (!errors.length) return null;
    const text = errors.join('; ');
    if (/Unknown asset pair/.test(text)) return fail('not_listed', 'kraken: unknown pair');
    if (/Too many requests|Rate limit/i.test(text)) return fail('rate_limited', `kraken: ${text}`, { hard: true });
    return fail('upstream', `kraken: ${text}`);
  },
  async bars({ get, native, timeframe, limit, now }) {
    // No limit parameter, and the newest row is always the forming bar.
    const since = Math.floor((now - (limit + 1) * TIMEFRAMES[timeframe]) / 1000);
    const body = await get(`/0/public/OHLC?${qs({ pair: native, interval: KRAKEN_INTERVAL[timeframe], since })}`);
    return rowsOf(krakenFirst(body, 'OHLC'), 'kraken OHLC').map((k) => {
      const v = num(k[6]);
      const vwap = num(k[5]);
      return { t: num(k[0]) * 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v, qv: (vwap > 0 ? vwap : num(k[4])) * v };
    });
  },
  async ticker({ get, native }) {
    const t = krakenFirst(await get(`/0/public/Ticker?${qs({ pair: native })}`), 'Ticker');
    return { bid: num(t.b?.[0]), ask: num(t.a?.[0]), last: num(t.c?.[0]), quoteVolume: num(t.v?.[1]) * num(t.p?.[1]), ts: null, tsKind: 'none' };
  },
  async book({ get, native, depth }) {
    const b = krakenFirst(await get(`/0/public/Depth?${qs({ pair: native, count: depth })}`), 'Depth');
    const stamps = [...(b.bids ?? []), ...(b.asks ?? [])].map((l) => num(l[2])).filter(Number.isFinite);
    return { bids: b.bids, asks: b.asks, ts: stamps.length ? Math.max(...stamps) * 1000 : null };
  },
  async allTickers({ get, memo }) {
    const pairs = await memo('kraken|assetpairs', HOUR_MS, () => get('/0/public/AssetPairs'));
    const all = await get('/0/public/Ticker');
    const out = [];
    for (const [key, t] of Object.entries(all?.result ?? {})) {
      const info = pairs?.result?.[key];
      if (!info || info.status !== 'online' || !info.wsname) continue;
      const [rawBase, quote] = info.wsname.split('/');
      if (quote !== 'USD' && quote !== 'USDT') continue;
      out.push({ base: KRAKEN_BASE_REVERSE[rawBase] ?? rawBase, quote, price: num(t.c?.[0]), quoteVolume: num(t.v?.[1]) * num(t.p?.[1]) });
    }
    return out;
  },
};

const COINBASE_GRANULARITY = { '1h': 3600, '1d': 86400 }; // 4h is not offered: see aggregate below
const COINBASE_PAGE = 300;

const coinbaseRow = (k) => ({
  t: num(k[0]) * 1000, l: num(k[1]), h: num(k[2]), o: num(k[3]), c: num(k[4]), v: num(k[5]),
  // Coinbase reports base volume only, so quote volume is an estimate.
  qv: num(k[5]) * ((num(k[1]) + num(k[2]) + num(k[3]) + num(k[4])) / 4),
});

/** 1h rows -> 4h rows on the UTC grid. An hour with no trades has no row. */
function aggregateTo4h(rows) {
  const groups = new Map();
  for (const r of rows.slice().sort((a, b) => a.t - b.t)) {
    const t = Math.floor(r.t / TIMEFRAMES['4h']) * TIMEFRAMES['4h'];
    const g = groups.get(t);
    if (!g) groups.set(t, { ...r, t });
    else {
      g.h = Math.max(g.h, r.h); g.l = Math.min(g.l, r.l); g.c = r.c;
      g.v += r.v; g.qv += r.qv;
    }
  }
  return [...groups.values()];
}

const coinbase = {
  id: 'coinbase', name: 'Coinbase Exchange', baseUrl: 'https://api.exchange.coinbase.com', quote: 'USD', pegSource: true,
  dailyBoundary: 'UTC 00:00', barOrder: 'newest-first', minIntervalMs: 350, maxBars: 300, maxDepth: 1000, qvEstimated: true,
  mapBase: (b) => `${b}-USD`,
  classify(status, body) {
    if (status === 404) return fail('not_listed', 'coinbase: product not found');
    return null;
  },
  async bars({ get, native, timeframe, limit, now }) {
    if (timeframe !== '4h') {
      const rows = await get(`/products/${native}/candles?${qs({ granularity: COINBASE_GRANULARITY[timeframe] })}`);
      return rowsOf(rows, 'coinbase candles').map(coinbaseRow);
    }
    // Whole 4h groups only, so the oldest bar is never built from a partial window.
    const span = TIMEFRAMES['4h'];
    const end = Math.floor(now / span) * span;
    let cursor = end - limit * span;
    const hours = [];
    while (cursor < end) {
      const stop = Math.min(cursor + COINBASE_PAGE * HOUR_MS, end);
      const rows = await get(`/products/${native}/candles?${qs({
        granularity: 3600, start: new Date(cursor).toISOString(), end: new Date(stop - 1000).toISOString(),
      })}`);
      hours.push(...rowsOf(rows, 'coinbase candles').map(coinbaseRow));
      cursor = stop;
    }
    return aggregateTo4h(hours);
  },
  async ticker({ get, native }) {
    const t = await get(`/products/${native}/ticker`);
    return { bid: num(t.bid), ask: num(t.ask), last: num(t.price), quoteVolume: num(t.volume) * num(t.price), ts: Date.parse(t.time), tsKind: 'trade' };
  },
  async book({ get, native }) {
    // level=2 has no size parameter and returns about 1 MB for BTC. level=1 is top of book only.
    const b = await get(`/products/${native}/book?level=2`);
    return { bids: b.bids, asks: b.asks, ts: Date.parse(b.time) };
  },
  async allTickers({ get }) {
    const stats = await get('/products/stats');
    const out = [];
    for (const [id, s] of Object.entries(stats ?? {})) {
      const [base, quote] = id.split('-');
      if (quote !== 'USD' && quote !== 'USDT') continue;
      const price = num(s?.stats_24hour?.last);
      out.push({ base, quote, price, quoteVolume: num(s?.stats_24hour?.volume) * price });
    }
    return out;
  },
};

const KUCOIN_TYPE = { '1h': '1hour', '4h': '4hour', '1d': '1day' };

const kucoin = {
  id: 'kucoin', name: 'KuCoin', baseUrl: 'https://api.kucoin.com', quote: 'USDT',
  dailyBoundary: 'UTC 00:00', barOrder: 'newest-first', minIntervalMs: 250, maxBars: 1500, maxDepth: 100,
  mapBase: (b) => `${b}-USDT`,
  classify(status, body) {
    if (body?.code === '400100') return fail('not_listed', `kucoin: ${body.msg}`);
    if (body?.code === '429000') return fail('rate_limited', 'kucoin: rate limit', { hard: true });
    if (body?.code !== undefined && body.code !== '200000') return fail('upstream', `kucoin ${body.code}: ${body.msg}`);
    return null;
  },
  async bars({ get, native, timeframe, limit, now }) {
    const tf = TIMEFRAMES[timeframe];
    const endAt = Math.floor(now / 1000);
    const startAt = Math.floor((now - (limit + 1) * tf) / 1000);
    const body = await get(`/api/v1/market/candles?${qs({ type: KUCOIN_TYPE[timeframe], symbol: native, startAt, endAt })}`);
    // Column order is open, CLOSE, high, low: not the usual OHLC.
    return rowsOf(body?.data, 'kucoin candles').map((k) => ({
      t: num(k[0]) * 1000, o: num(k[1]), c: num(k[2]), h: num(k[3]), l: num(k[4]), v: num(k[5]), qv: num(k[6]),
    }));
  },
  async ticker({ get, native }) {
    const body = await get(`/api/v1/market/stats?${qs({ symbol: native })}`);
    const t = body?.data;
    // An unknown pair here is HTTP 200, code 200000, every field null.
    if (!t || t.last === null || t.last === undefined) throw fail('not_listed', 'kucoin: no such pair');
    return { bid: num(t.buy), ask: num(t.sell), last: num(t.last), quoteVolume: num(t.volValue), ts: num(t.time), tsKind: 'feed' };
  },
  async book({ get, native, depth }) {
    const body = await get(`/api/v1/market/orderbook/level2_${atLeast([20, 100], depth)}?${qs({ symbol: native })}`);
    if (!body?.data) throw fail('not_listed', 'kucoin: no such pair');
    return { bids: body.data.bids, asks: body.data.asks, ts: num(body.data.time) };
  },
  async allTickers({ get }) {
    const body = await get('/api/v1/market/allTickers');
    return rowsOf(body?.data?.ticker, 'kucoin tickers')
      .filter((t) => t.symbol.endsWith('-USDT'))
      .map((t) => ({ base: t.symbol.slice(0, -5), quote: 'USDT', price: num(t.last), quoteVolume: num(t.volValue) }));
  },
  async nonCryptoBases({ get }) {
    const body = await get('/api/v2/symbols');
    return rowsOf(body?.data, 'kucoin symbols').filter((i) => i.market === 'Stocks').map((i) => i.baseCurrency);
  },
};

const gate = {
  id: 'gate', name: 'Gate', baseUrl: 'https://api.gateio.ws', quote: 'USDT',
  dailyBoundary: 'UTC 00:00', barOrder: 'oldest-first', minIntervalMs: 200, maxBars: 1000, maxDepth: 100,
  mapBase: (b) => `${b}_USDT`,
  classify(status, body) {
    if (/^INVALID_CURRENCY/.test(body?.label ?? '')) return fail('not_listed', `gate: ${body.message}`);
    if (body?.label === 'TOO_MANY_REQUESTS') return fail('rate_limited', 'gate: rate limit', { hard: true });
    return null;
  },
  async bars({ get, native, timeframe, limit }) {
    const rows = await get(`/api/v4/spot/candlesticks?${qs({ currency_pair: native, interval: timeframe, limit })}`);
    // t, quote volume, close, high, low, open, base volume, window closed.
    return rowsOf(rows, 'gate candlesticks').map((k) => ({
      t: num(k[0]) * 1000, qv: num(k[1]), c: num(k[2]), h: num(k[3]), l: num(k[4]), o: num(k[5]), v: num(k[6]),
      closed: k[7] === undefined ? undefined : String(k[7]) === 'true',
    }));
  },
  async ticker({ get, native }) {
    const t = rowsOf(await get(`/api/v4/spot/tickers?${qs({ currency_pair: native })}`), 'gate tickers')[0];
    if (!t) throw fail('not_listed', 'gate: empty ticker');
    return { bid: num(t.highest_bid), ask: num(t.lowest_ask), last: num(t.last), quoteVolume: num(t.quote_volume), ts: null, tsKind: 'none' };
  },
  async book({ get, native, depth }) {
    const b = await get(`/api/v4/spot/order_book?${qs({ currency_pair: native, limit: depth })}`);
    return { bids: b.bids, asks: b.asks, ts: num(b.update) };
  },
  async allTickers({ get }) {
    return rowsOf(await get('/api/v4/spot/tickers'), 'gate tickers')
      .filter((t) => t.currency_pair.endsWith('_USDT'))
      .map((t) => ({ base: t.currency_pair.slice(0, -5), quote: 'USDT', price: num(t.last), quoteVolume: num(t.quote_volume) }));
  },
  async nonCryptoBases({ get }) {
    const rows = rowsOf(await get('/api/v4/spot/currency_pairs'), 'gate pairs');
    return rows.filter((p) => /xstock|tokeni[sz]ed/i.test(p.base_name ?? '')).map((p) => p.base);
  },
};

const BITGET_GRANULARITY = { '1h': '1h', '4h': '4h', '1d': '1Dutc' }; // plain 1day closes at UTC+8 midnight

const bitget = {
  id: 'bitget', name: 'Bitget', baseUrl: 'https://api.bitget.com', quote: 'USDT',
  dailyBoundary: 'UTC 00:00 via granularity=1Dutc (plain 1day is UTC+8 midnight, 16:00 UTC)',
  barOrder: 'oldest-first', minIntervalMs: 200, maxBars: 1000, maxDepth: 150,
  mapBase: (b) => `${b}USDT`,
  classify(status, body) {
    if (body?.code === '40034') return fail('not_listed', `bitget: ${body.msg}`);
    if (body?.code === '429') return fail('rate_limited', 'bitget: rate limit', { hard: true });
    if (body?.code !== undefined && body.code !== '00000') return fail('upstream', `bitget ${body.code}: ${body.msg}`);
    return null;
  },
  async bars({ get, native, timeframe, limit }) {
    const body = await get(`/api/v2/spot/market/candles?${qs({ symbol: native, granularity: BITGET_GRANULARITY[timeframe], limit })}`);
    return rowsOf(body?.data, 'bitget candles').map((k) => ({
      t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]), qv: num(k[7]),
    }));
  },
  async ticker({ get, native }) {
    const t = rowsOf((await get(`/api/v2/spot/market/tickers?${qs({ symbol: native })}`))?.data, 'bitget tickers')[0];
    if (!t) throw fail('not_listed', 'bitget: empty ticker');
    return { bid: num(t.bidPr), ask: num(t.askPr), last: num(t.lastPr), quoteVolume: num(t.quoteVolume), ts: num(t.ts), tsKind: 'feed' };
  },
  async book({ get, native, depth }) {
    const body = await get(`/api/v2/spot/market/orderbook?${qs({ symbol: native, type: 'step0', limit: depth })}`);
    if (!body?.data) throw fail('malformed', 'bitget orderbook');
    return { bids: body.data.bids, asks: body.data.asks, ts: num(body.data.ts) };
  },
  async allTickers({ get, memo }) {
    // Most Bitget markets are tokenised US equities (baseCoin rQQQ, rNVDA) reporting
    // billions in volume. Only the case of baseCoin marks them, and tickers are
    // uppercase, so this cannot be a shared base rule: rAY would remove the real RAY.
    // No symbol list means no ticker list: better to lose Bitget than admit them.
    const symbols = await memo('bitget|symbols', 24 * HOUR_MS, () => get('/api/v2/spot/public/symbols'));
    const tradable = new Set(rowsOf(symbols?.data, 'bitget symbols')
      .filter((i) => i.status === 'online' && !/^r[A-Z0-9]/.test(i.baseCoin))
      .map((i) => i.symbol));
    return rowsOf((await get('/api/v2/spot/market/tickers'))?.data, 'bitget tickers')
      .filter((t) => t.symbol.endsWith('USDT') && tradable.has(t.symbol))
      .map((t) => ({ base: t.symbol.slice(0, -4), quote: 'USDT', price: num(t.lastPr), quoteVolume: num(t.quoteVolume) }));
  },
};

export const EXCHANGES = { binance, okx, bybit, kraken, coinbase, kucoin, gate, bitget };

/** Reasoning and measurements: docs/rebuild/exchanges.md. */
export const DEFAULT_PRIORITIES = {
  // Binance first: the research bar store is Binance, so live bars match the backtests.
  bars: ['binance', 'okx', 'bybit', 'kucoin', 'bitget', 'gate', 'kraken', 'coinbase'],
  ticker: ['binance', 'okx', 'bybit', 'kucoin', 'bitget', 'gate', 'coinbase', 'kraken'],
  // OKX first: best measured depth, and unlike Binance its book carries a timestamp.
  // Coinbase last: its only full book is about 1 MB per call.
  book: ['okx', 'binance', 'kucoin', 'bybit', 'bitget', 'kraken', 'gate', 'coinbase'],
};

/**
 * Native market a venue would use for a canonical symbol, or null when it has
 * none. A USD venue answers a USDT request from its deep USD market, not its
 * thin USDT one; the hub then converts the price.
 * @returns {{ native: string, quote: 'USDT'|'USD' } | null}
 */
export function venueSymbol(venueId, symbol) {
  const venue = EXCHANGES[venueId];
  if (!venue) throw fail('unsupported', `Unknown venue: ${venueId}`);
  const { base } = parseSymbol(symbol);
  if (base === 'USDT' && venue.quote !== 'USD') return null;
  return { native: venue.mapBase(base), quote: venue.quote };
}

// ---------------------------------------------------------------------------
// Rate limiter and breaker
// ---------------------------------------------------------------------------

function createLimiter({ minIntervalMs, maxConcurrent, maxWaitMs }, now, sleep) {
  let nextSlot = 0;
  let active = 0;
  const waiting = [];
  return {
    async acquire() {
      const t = now();
      const wait = Math.max(0, nextSlot - t);
      if (wait > maxWaitMs) throw fail('local_throttle', `Local queue is ${wait}ms deep`);
      nextSlot = Math.max(t, nextSlot) + minIntervalMs;
      if (wait > 0) await sleep(wait);
      if (active >= maxConcurrent) await new Promise((resolve) => waiting.push(resolve));
      else active++;
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

function newVenueState(cfg) {
  return {
    breaker: 'closed', probing: false, openUntil: 0, cooldownMs: cfg.cooldownMs, consecutiveFailures: 0,
    requests: 0, failures: 0, rateLimited: 0, staleHits: 0, opened: 0,
    latencyMs: null, lastLatencyMs: null, lastOk: null, lastError: null, lastErrorCode: null, lastErrorAt: null,
  };
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string[]|{bars?:string[],ticker?:string[],book?:string[]}} [options.priorities]
 *   One order for everything, or an order per job. Enabled venues left out go last.
 * @param {string[]} [options.enabled] venues to use; default all
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {Partial<typeof DEFAULT_HUB_CONFIG>} [options.config]
 */
export function createMarketHub({ priorities, enabled, fetchImpl, now = () => Date.now(), sleep, config } = {}) {
  const cfg = { ...DEFAULT_HUB_CONFIG, ...config };
  cfg.timeoutMs = Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS);
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const venues = enabled ? [...enabled] : Object.keys(EXCHANGES);
  for (const id of venues) if (!EXCHANGES[id]) throw fail('unsupported', `Unknown venue: ${id}`);

  const orderFor = (job) => {
    const preferred = Array.isArray(priorities) ? priorities : priorities?.[job] ?? DEFAULT_PRIORITIES[job];
    const listed = preferred.filter((id) => venues.includes(id));
    return [...listed, ...venues.filter((id) => !listed.includes(id))];
  };

  const state = Object.fromEntries(venues.map((id) => [id, newVenueState(cfg)]));
  const limiters = Object.fromEntries(venues.map((id) => [id, createLimiter({
    minIntervalMs: EXCHANGES[id].minIntervalMs,
    maxConcurrent: cfg.maxConcurrentPerVenue,
    maxWaitMs: cfg.maxQueueWaitMs,
  }, now, doSleep)]));

  // --- breaker -------------------------------------------------------------

  const breakerAllows = (s) => {
    if (s.breaker === 'closed') return true;
    if (s.breaker === 'open') {
      if (now() < s.openUntil) return false;
      s.breaker = 'half_open';
      s.probing = false;
    }
    if (s.probing) return false; // one probe at a time, not a stampede on recovery
    s.probing = true;
    return true;
  };

  const breakerSuccess = (s) => {
    s.breaker = 'closed';
    s.probing = false;
    s.consecutiveFailures = 0;
    s.cooldownMs = cfg.cooldownMs;
    s.openUntil = 0;
  };

  const openBreaker = (s, ms) => {
    if (s.breaker !== 'open') s.opened++;
    s.breaker = 'open';
    s.probing = false;
    s.openUntil = Math.max(s.openUntil, now() + ms);
  };

  const breakerFailure = (s, err) => {
    s.consecutiveFailures++;
    if (err.hard) {
      openBreaker(s, Math.max(err.retryAfterMs ?? 0, err.cooldownMs ?? cfg.rateLimitCooldownMs));
    } else if (s.breaker === 'half_open') {
      s.cooldownMs = Math.min(s.cooldownMs * 2, cfg.maxCooldownMs);
      openBreaker(s, s.cooldownMs);
    } else if (s.consecutiveFailures >= cfg.failureThreshold) {
      openBreaker(s, s.cooldownMs);
    }
  };

  // --- transport -----------------------------------------------------------

  /** The race matters: a fetch that ignores its abort signal must still time out. */
  async function request(url) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(fail('timeout', `Timed out after ${cfg.timeoutMs}ms`));
      }, cfg.timeoutMs);
    });
    const attempt = (async () => {
      const res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      const text = await res.text();
      return { res, text };
    })();
    attempt.catch(() => {}); // the loser of the race must not surface as unhandled
    try {
      return await Promise.race([attempt, timeout]);
    } catch (err) {
      if (err instanceof MarketDataError) throw err;
      throw fail('network', err?.message ?? String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  const retryAfterMs = (res) => {
    const secs = Number(res.headers?.get?.('Retry-After'));
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
  };

  const getterFor = (id) => async (path) => {
    const venue = EXCHANGES[id];
    const s = state[id];
    const limiter = limiters[id];
    await limiter.acquire();
    const started = now();
    s.requests++;
    try {
      const { res, text } = await request(venue.baseUrl + path);
      const elapsed = now() - started;
      s.lastLatencyMs = elapsed;
      s.latencyMs = s.latencyMs === null ? elapsed : Math.round(s.latencyMs * 0.8 + elapsed * 0.2);

      if (res.status === 429 || res.status === 418) {
        throw fail('rate_limited', `${id}: HTTP ${res.status}`, {
          hard: true,
          retryAfterMs: retryAfterMs(res),
          cooldownMs: res.status === 418 ? cfg.banCooldownMs : cfg.rateLimitCooldownMs,
        });
      }
      if (res.status === 451 || res.status === 403) {
        throw fail('geo_blocked', `${id}: HTTP ${res.status}`, { hard: true, cooldownMs: cfg.geoBlockCooldownMs });
      }
      let body = null;
      try { body = JSON.parse(text); } catch { /* handled below */ }
      const classified = venue.classify(res.status, body);
      if (classified) throw classified;
      if (!res.ok) throw fail('http', `${id}: HTTP ${res.status}`);
      if (body === null) throw fail('malformed', `${id}: response is not JSON`);
      return body;
    } finally {
      limiter.release();
    }
  };

  /** Runs one venue operation behind its breaker and keeps the health stats. */
  async function withVenue(id, fn) {
    const s = state[id];
    if (!breakerAllows(s)) {
      throw fail('breaker_open', `${id}: breaker open for ${Math.max(0, s.openUntil - now())}ms`);
    }
    try {
      const result = await fn(getterFor(id));
      s.lastOk = now();
      breakerSuccess(s);
      return result;
    } catch (err) {
      const e = err instanceof MarketDataError ? err : fail('malformed', `${id}: ${err?.message ?? err}`);
      if (VENUE_ALIVE_CODES.has(e.code)) {
        s.lastOk = now();
        breakerSuccess(s);
      } else if (NEUTRAL_CODES.has(e.code)) {
        s.probing = false;
      } else {
        s.failures++;
        if (e.code === 'rate_limited') s.rateLimited++;
        s.lastError = `${e.code}: ${e.message}`;
        s.lastErrorCode = e.code;
        s.lastErrorAt = now();
        breakerFailure(s, e);
      }
      throw e;
    }
  }

  // --- cache ---------------------------------------------------------------

  const cache = new Map();
  const inflight = new Map();

  const prune = () => {
    if (cache.size < 5000) return;
    const t = now();
    for (const [key, entry] of cache) if (t >= entry.expires) cache.delete(key);
  };

  /** TTL cache that also joins concurrent callers onto one request. */
  async function memo(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() < hit.expires) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      try {
        const value = await load();
        const ms = typeof ttl === 'function' ? ttl(value) : ttl;
        cache.set(key, { value, expires: now() + ms });
        prune();
        return value;
      } catch (err) {
        if (err.code === 'not_listed') cache.set(key, { error: err, expires: now() + cfg.notListedTtlMs });
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  }

  const describeErrors = (errors) => errors.map((e) => `${e.venue}: ${e.message}`).join(' | ');

  // --- per-venue reads -----------------------------------------------------

  function venueBars(id, symbol, timeframe, limit) {
    const map = venueSymbol(id, symbol);
    if (!map) return Promise.reject(fail('not_listed', `${id} has no market for ${symbol}`));
    const tf = TIMEFRAMES[timeframe];
    const venue = EXCHANGES[id];
    const ttl = (r) => (r.stale
      ? cfg.staleBarsTtlMs
      : (Math.floor(now() / tf) + 1) * tf + cfg.closeGraceMs - now());

    return memo(`bars|${id}|${map.native}|${timeframe}|${limit}`, ttl, () => withVenue(id, async (get) => {
      const fetchCount = Math.min(limit + 2, venue.maxBars); // room for the forming bar
      const t = now();
      const rows = await venue.bars({ get, native: map.native, timeframe, limit: fetchCount, now: t });
      const { bars, dropped } = normalizeBars(rows, timeframe, t, cfg.closeGraceMs);
      const tail = bars.slice(-limit);
      const expectedLast = Math.floor((t - cfg.barLagMs) / tf) * tf - tf;
      const lastT = tail.length ? tail[tail.length - 1].t : null;
      const stale = lastT === null || lastT < expectedLast;
      if (stale) state[id].staleHits++;
      let gaps = 0;
      for (let i = 1; i < tail.length; i++) gaps += Math.round((tail[i].t - tail[i - 1].t) / tf) - 1;
      return { bars: tail, venue: id, quote: map.quote, stale, lastT, expectedLast, gaps, dropped, truncated: limit + 2 > venue.maxBars };
    }));
  }

  function venueTicker(id, symbol) {
    const map = venueSymbol(id, symbol);
    if (!map) return Promise.reject(fail('not_listed', `${id} has no market for ${symbol}`));
    const venue = EXCHANGES[id];
    return memo(`ticker|${id}|${map.native}`, cfg.tickerTtlMs, () => withVenue(id, async (get) => {
      const raw = await venue.ticker({ get, native: map.native });
      const t = now();
      const hasBook = isPos(raw.bid) && isPos(raw.ask) && raw.bid < raw.ask;
      const mid = hasBook ? (raw.bid + raw.ask) / 2 : raw.last;
      if (!isPos(mid)) throw fail('bad_data', `${id}: ticker has no usable price`);
      const hasTs = Number.isFinite(raw.ts);
      const ageMs = hasTs ? Math.max(0, t - raw.ts) : null;
      const maxAge = raw.tsKind === 'trade' ? cfg.maxTradeAgeMs : cfg.maxFeedAgeMs;
      const stale = hasTs && ageMs > maxAge;
      if (stale) state[id].staleHits++;
      return {
        venue: id, quote: map.quote, native: map.native, price: mid,
        last: isPos(raw.last) ? raw.last : null, bid: hasBook ? raw.bid : null, ask: hasBook ? raw.ask : null,
        quoteVolume24h: Number.isFinite(raw.quoteVolume) ? raw.quoteVolume : null,
        t: hasTs ? raw.ts : t, tsKind: hasTs ? raw.tsKind : 'none', ageMs, stale,
      };
    }));
  }

  function venueBook(id, symbol, depth) {
    const map = venueSymbol(id, symbol);
    if (!map) return Promise.reject(fail('not_listed', `${id} has no market for ${symbol}`));
    const venue = EXCHANGES[id];
    const asked = Math.min(depth, venue.maxDepth);
    return memo(`book|${id}|${map.native}|${asked}`, cfg.bookTtlMs, () => withVenue(id, async (get) => {
      const raw = await venue.book({ get, native: map.native, depth: asked });
      const t = now();
      const { bids, asks } = normalizeBook(raw, asked);
      const hasTs = Number.isFinite(raw.ts);
      const ageMs = hasTs ? Math.max(0, t - raw.ts) : null;
      const stale = hasTs && ageMs > cfg.maxBookAgeMs;
      if (stale) state[id].staleHits++;
      return { venue: id, quote: map.quote, bids, asks, t: hasTs ? raw.ts : t, ageMs, stale };
    }));
  }

  // --- USDT/USD basis ------------------------------------------------------

  let lastBasis = null;

  /**
   * USD price of one USDT, measured directly on venues with a USDT/USD market.
   * If those venues disagree there is no way to tell which is right, so the
   * basis is not usable and USD venues drop out of comparisons.
   */
  async function usdtBasis() {
    return memo('basis', cfg.basisTtlMs, async () => {
      const peggers = venues.filter((id) => EXCHANGES[id].pegSource);
      const results = await Promise.allSettled(peggers.map((id) => venueTicker(id, 'USDTUSD')));
      const sources = results
        .filter((r) => r.status === 'fulfilled' && !r.value.stale && r.value.price > 0.5 && r.value.price < 1.5)
        .map((r) => ({ venue: r.value.venue, price: r.value.price }));
      const t = now();
      const prices = sources.map((s) => s.price);
      if (prices.length && spreadPctOf(prices) <= cfg.pegSourceTolerancePct) {
        const basis = median(prices);
        lastBasis = {
          ok: true, basis, deviationPct: round((basis - 1) * 100), sources, t, stale: false, reason: null,
          alarm: Math.abs(basis - 1) * 100 > cfg.pegAlarmPct,
        };
        return lastBasis;
      }
      const reason = prices.length ? 'peg_sources_disagree' : 'peg_unavailable';
      if (reason === 'peg_unavailable' && lastBasis && t - lastBasis.t <= cfg.maxBasisAgeMs) {
        return { ...lastBasis, stale: true, reason: 'peg_last_good' };
      }
      return { ok: false, basis: null, deviationPct: null, sources, t, stale: false, reason, alarm: false };
    });
  }

  const quotesDiffer = (quote) => venues.some((id) => EXCHANGES[id].quote !== quote);

  // --- public API ----------------------------------------------------------

  const lastGoodBars = new Map();
  const lastGoodTicker = new Map();
  const lastGoodPrice = new Map();

  const eligibleBars = (id, limit, explicit) => explicit || limit + 2 <= EXCHANGES[id].maxBars;

  /**
   * Closed bars, oldest first, from the first healthy venue with fresh data.
   * Pass { venue } to read exactly one venue with no failover (cross-venue replay).
   * Returns Bar[] with a non-enumerable `.meta`:
   * { venue, quote, stale, lastT, expectedLast, gaps, dropped, truncated, quoteMismatch, lastGood, errors }.
   * A USD venue's bars stay in USD: today's basis says nothing about old bars.
   * All venues stale: the freshest answer, meta.stale = true.
   * All venues down: the last good answer, meta.stale = true, meta.lastGood = true.
   * Nothing ever fetched: throws.
   */
  async function bars(symbol, timeframe, limit, { venue } = {}) {
    const { symbol: canon, quote } = parseSymbol(symbol);
    if (!TIMEFRAMES[timeframe]) throw fail('unsupported', `Unsupported timeframe: ${timeframe}`);
    if (!Number.isInteger(limit) || limit < 1) throw fail('unsupported', `Bad limit: ${limit}`);
    if (venue && !venues.includes(venue)) throw fail('unsupported', `Venue not enabled: ${venue}`);

    const finish = (r, extra = {}) => withMeta(r.bars.map((b) => ({ ...b })), {
      venue: r.venue, quote: r.quote, stale: r.stale, lastT: r.lastT, expectedLast: r.expectedLast,
      gaps: r.gaps, dropped: r.dropped, truncated: r.truncated, quoteMismatch: r.quote !== quote,
      lastGood: false, errors: [], ...extra,
    });

    const errors = [];
    let freshestStale = null;
    for (const id of venue ? [venue] : orderFor('bars')) {
      if (!eligibleBars(id, limit, Boolean(venue))) {
        errors.push({ venue: id, code: 'unsupported', message: `serves fewer than ${limit} bars` });
        continue;
      }
      try {
        const r = await venueBars(id, canon, timeframe, limit);
        if (!r.stale) {
          lastGoodBars.set(`${canon}|${timeframe}|${limit}`, r);
          return finish(r, { errors });
        }
        errors.push({ venue: id, code: 'stale', message: `last bar ${r.lastT}, expected ${r.expectedLast}` });
        if (r.bars.length && (!freshestStale || r.lastT > freshestStale.lastT)) freshestStale = r;
      } catch (err) {
        errors.push({ venue: id, code: err.code, message: err.message });
      }
    }
    if (freshestStale) return finish(freshestStale, { errors });
    const good = !venue && lastGoodBars.get(`${canon}|${timeframe}|${limit}`);
    if (good) return finish(good, { stale: true, lastGood: true, errors });
    throw fail('all_venues_failed', `No bars for ${canon} ${timeframe}: ${describeErrors(errors)}`, { errors });
  }

  /** Rewrites a venue answer into the requested quote, or throws no_basis. */
  async function inQuote(result, quote) {
    if (result.quote === quote) return { adjusted: false, factor: 1, basis: null };
    const b = await usdtBasis();
    if (!b.ok) throw fail('no_basis', `USDT/USD basis unusable (${b.reason})`);
    return { adjusted: true, factor: convertQuote(1, result.quote, quote, b.basis), basis: b.basis };
  }

  /**
   * Best current quote in the requested currency, with failover. Falls back to a
   * stale venue, then to the last good quote (stale: true, lastGood: true) so an
   * exit always has a price; check `stale` before using it for an entry.
   */
  async function ticker(symbol, { venue } = {}) {
    const { symbol: canon, quote } = parseSymbol(symbol);
    if (venue && !venues.includes(venue)) throw fail('unsupported', `Venue not enabled: ${venue}`);
    const errors = [];
    let staleResult = null;
    for (const id of venue ? [venue] : orderFor('ticker')) {
      try {
        const r = await venueTicker(id, canon);
        const { adjusted, factor, basis } = await inQuote(r, quote);
        const scale = (x) => (x === null ? null : x * factor);
        const out = {
          ...r, symbol: canon, quote, price: r.price * factor, last: scale(r.last), bid: scale(r.bid), ask: scale(r.ask),
          venueQuote: r.quote, rawPrice: r.price, basisAdjusted: adjusted, basis, lastGood: false,
        };
        if (!r.stale) {
          lastGoodTicker.set(canon, out);
          return out;
        }
        errors.push({ venue: id, code: 'stale', message: `quote is ${r.ageMs}ms old` });
        staleResult ??= out;
      } catch (err) {
        errors.push({ venue: id, code: err.code, message: err.message });
      }
    }
    if (staleResult) return staleResult;
    const good = !venue && lastGoodTicker.get(canon);
    if (good) return { ...good, stale: true, lastGood: true, ageMs: now() - good.t };
    throw fail('all_venues_failed', `No ticker for ${canon}: ${describeErrors(errors)}`, { errors });
  }

  /**
   * Normalised depth for slippage estimates: { venue, symbol, quote, bids, asks,
   * mid, spreadPct, t, ageMs, stale, truncated, basisAdjusted }. Levels are
   * [price, baseQty]; prices are in the requested quote. There is no last-good
   * fallback, because an old book says nothing about today's slippage.
   */
  async function book(symbol, depth = 50, { venue } = {}) {
    const { symbol: canon, quote } = parseSymbol(symbol);
    if (!Number.isInteger(depth) || depth < 1) throw fail('unsupported', `Bad depth: ${depth}`);
    if (venue && !venues.includes(venue)) throw fail('unsupported', `Venue not enabled: ${venue}`);
    const errors = [];
    for (const id of venue ? [venue] : orderFor('book')) {
      try {
        const r = await venueBook(id, canon, depth);
        if (r.stale) {
          errors.push({ venue: id, code: 'stale', message: `book is ${r.ageMs}ms old` });
          continue;
        }
        const { adjusted, factor, basis } = await inQuote(r, quote);
        const scale = (levels) => levels.map(([p, q]) => [p * factor, q]);
        const bids = scale(r.bids);
        const asks = scale(r.asks);
        const mid = (bids[0][0] + asks[0][0]) / 2;
        return {
          ...r, symbol: canon, quote, bids, asks, mid, spreadPct: ((asks[0][0] - bids[0][0]) / mid) * 100,
          truncated: Math.min(bids.length, asks.length) < depth, venueQuote: r.quote, basisAdjusted: adjusted, basis,
        };
      } catch (err) {
        errors.push({ venue: id, code: err.code, message: err.message });
      }
    }
    throw fail('all_venues_failed', `No book for ${canon}: ${describeErrors(errors)}`, { errors });
  }

  /**
   * Median mid across healthy venues, in the requested quote.
   *
   * ok means at least minVenues fresh venues agree within tolerancePct. With three
   * or more venues an outlier is named and dropped; with exactly two a split cannot
   * be attributed, so ok is false. `price` is still the best available figure when
   * ok is false, for marking only: entries must require ok. `lastGood` is the most
   * recent agreed price.
   */
  async function consensusPrice(symbol, { tolerancePct = cfg.tolerancePct, minVenues = cfg.minVenues } = {}) {
    const { symbol: canon, quote } = parseSymbol(symbol);
    const [settled, basis] = await Promise.all([
      Promise.allSettled(orderFor('ticker').map((id) => venueTicker(id, canon))),
      quotesDiffer(quote) ? usdtBasis() : Promise.resolve(null),
    ]);

    const excluded = [];
    const quotes = [];
    settled.forEach((r, i) => {
      const id = orderFor('ticker')[i];
      if (r.status === 'rejected') {
        // Not listing a coin is not a health event, so it is not a disagreement either.
        excluded.push({ venue: id, reason: r.reason.code, message: r.reason.message });
        return;
      }
      const q = r.value;
      if (q.stale) { excluded.push({ venue: id, reason: 'stale', ageMs: q.ageMs }); return; }
      if (q.quote !== quote && !basis?.ok) { excluded.push({ venue: id, reason: 'no_basis' }); return; }
      const price = q.quote === quote ? q.price : convertQuote(q.price, q.quote, quote, basis.basis);
      quotes.push({ venue: id, price, rawPrice: q.price, quote: q.quote, adjusted: q.quote !== quote, ageMs: q.ageMs });
    });

    const allPrices = quotes.map((q) => q.price);
    const firstMedian = median(allPrices);
    const devPct = (p) => (Math.abs(p - firstMedian) / firstMedian) * 100;

    let kept = quotes;
    let outliers = [];
    if (quotes.length >= 3) {
      kept = quotes.filter((q) => devPct(q.price) <= tolerancePct);
      outliers = quotes.filter((q) => devPct(q.price) > tolerancePct)
        .map((q) => ({ venue: q.venue, price: q.price, deviationPct: round(((q.price - firstMedian) / firstMedian) * 100) }));
    }
    const keptPrices = kept.map((q) => q.price);
    const spreadPct = spreadPctOf(keptPrices);

    let ok = false;
    let reason = null;
    if (quotes.length < minVenues) reason = 'insufficient_venues';
    else if (kept.length < minVenues) reason = 'venues_disagree';
    else if (kept.length * 2 <= quotes.length) reason = 'no_majority';
    else if (spreadPct > tolerancePct) reason = 'venues_disagree';
    else {
      ok = true;
      if (outliers.length) reason = 'outlier_excluded';
    }

    const t = now();
    const price = keptPrices.length ? median(keptPrices) : firstMedian;
    if (ok) lastGoodPrice.set(canon, { price, t });
    const good = lastGoodPrice.get(canon);

    return {
      symbol: canon, quote, price, ok, reason,
      venues: kept.map((q) => q.venue),
      spreadPct: round(spreadPct),
      rawSpreadPct: round(spreadPctOf(allPrices)),
      disagreement: outliers.length > 0 || reason === 'venues_disagree' || reason === 'no_majority',
      outliers, excluded, quotes,
      basis: basis ? { basis: basis.basis, deviationPct: basis.deviationPct, ok: basis.ok, stale: basis.stale, reason: basis.reason, sources: basis.sources } : null,
      pegAlarm: Boolean(basis?.alarm),
      lastGood: good ? { ...good, ageMs: t - good.t } : null,
      t,
    };
  }

  /**
   * Current top coins by 24h USD-equivalent volume summed across venues, with
   * stablecoins, wrapped/pegged, leveraged and tokenised assets removed. For the
   * LIVE engine only: research universes must be point in time (v6Bars).
   *
   * Different projects can share a ticker on different venues, so a venue priced
   * far from the others for the same base is not merged. minVenues defaults to 2
   * because a coin on one venue can never pass the signal gate's price check, and
   * self-reported single-venue volume is the least trustworthy number here.
   * Result array carries `.meta = { venues, failed, excluded }`.
   */
  async function universe({ topN = 50, minQuoteVolume = 5e6, minVenues = cfg.minVenues } = {}) {
    const load = async () => {
      const failed = [];
      const nonCrypto = new Set();
      const tasks = venues.map((id) => memo(`all|${id}`, cfg.universeTtlMs, () => withVenue(id, (get) => EXCHANGES[id].allTickers({ get, memo })))
        .then((rows) => ({ id, rows }))
        .catch((err) => { failed.push({ venue: id, code: err.code, message: err.message }); return null; }));
      for (const id of venues.filter((v) => EXCHANGES[v].nonCryptoBases)) {
        tasks.push(memo(`noncrypto|${id}`, 24 * HOUR_MS, () => withVenue(id, (get) => EXCHANGES[id].nonCryptoBases({ get })))
          .then((bases) => { bases.forEach((b) => nonCrypto.add(b)); return null; })
          .catch(() => null)); // classifyBase's static rules still apply without it
      }
      const sets = (await Promise.all(tasks)).filter(Boolean);
      if (!sets.length) throw fail('all_venues_failed', `No venue returned tickers: ${describeErrors(failed)}`, { errors: failed });
      return { sets, failed, nonCrypto };
    };
    const { sets, failed, nonCrypto } = await load();

    const merged = new Map(); // base -> Map<venue, { quoteVolume, price }>
    const excluded = { stablecoin: 0, wrapped: 0, leveraged: 0, non_crypto: 0 };
    const counted = new Set();
    for (const { id, rows } of sets) {
      for (const r of rows) {
        const why = classifyBase(r.base, nonCrypto);
        if (why) {
          if (!counted.has(r.base)) { counted.add(r.base); excluded[why]++; }
          continue;
        }
        if (!isPos(r.price) || !Number.isFinite(r.quoteVolume) || r.quoteVolume <= 0) continue;
        if (!merged.has(r.base)) merged.set(r.base, new Map());
        const perVenue = merged.get(r.base);
        const prior = perVenue.get(id);
        // A venue can list both USD and USDT: sum the volume, price from the bigger market.
        if (!prior) perVenue.set(id, { quoteVolume: r.quoteVolume, price: r.price, top: r.quoteVolume });
        else {
          prior.quoteVolume += r.quoteVolume;
          if (r.quoteVolume > prior.top) { prior.top = r.quoteVolume; prior.price = r.price; }
        }
      }
    }

    const rows = [];
    for (const [base, perVenue] of merged) {
      let entries = [...perVenue.entries()];
      const mid = median(entries.map(([, e]) => e.price));
      const off = (e) => (Math.abs(e.price - mid) / mid) * 100 > cfg.universeConflictPct;
      let priceConflict = false;
      let dropped = [];
      if (entries.length === 2 && off(entries[0][1])) {
        priceConflict = true; // no majority: keep the bigger market, flag the row
        entries.sort((a, b) => b[1].quoteVolume - a[1].quoteVolume);
        dropped = [entries[1][0]];
        entries = [entries[0]];
      } else if (entries.length >= 3) {
        dropped = entries.filter(([, e]) => off(e)).map(([id]) => id);
        if (dropped.length) {
          priceConflict = true;
          entries = entries.filter(([id]) => !dropped.includes(id));
        }
      }
      if (!entries.length) continue;
      const quoteVolume = entries.reduce((sum, [, e]) => sum + e.quoteVolume, 0);
      if (quoteVolume < minQuoteVolume || entries.length < minVenues) continue;
      entries.sort((a, b) => b[1].quoteVolume - a[1].quoteVolume);
      rows.push({
        symbol: `${base}USDT`, base, quoteVolume,
        venues: entries.map(([id]) => id),
        byVenue: Object.fromEntries(entries.map(([id, e]) => [id, e.quoteVolume])),
        price: median(entries.map(([, e]) => e.price)),
        priceConflict, droppedVenues: dropped,
      });
    }
    rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
    return withMeta(rows.slice(0, topN), { venues: sets.map((s) => s.id), failed, excluded });
  }

  const statusOf = (s) => {
    if (s.requests === 0 && s.breaker === 'closed') return 'unknown';
    if (s.breaker !== 'closed') {
      if (s.lastErrorCode === 'geo_blocked') return 'blocked';
      if (s.lastErrorCode === 'rate_limited') return 'rate_limited';
      return 'error';
    }
    if (s.consecutiveFailures > 0 || s.lastOk === null) return 'error';
    return s.latencyMs > cfg.latencyWarnMs ? 'slow' : 'ok';
  };

  /**
   * One row per venue; suitable for V6ExchangeHealth. ok needs a real success on
   * this hub: an untried venue is 'unknown', not healthy. Health lives in memory,
   * so keep one long-lived hub per process.
   */
  function health() {
    const t = now();
    return venues.map((id) => {
      const s = state[id];
      const open = s.breaker === 'open' && t < s.openUntil;
      return {
        venue: id,
        ok: s.breaker === 'closed' && s.lastOk !== null,
        status: statusOf(s),
        breaker: open ? 'open' : s.breaker === 'open' ? 'half_open' : s.breaker,
        latencyMs: s.latencyMs, lastLatencyMs: s.lastLatencyMs,
        lastOk: s.lastOk, lastError: s.lastError, lastErrorCode: s.lastErrorCode, lastErrorAt: s.lastErrorAt,
        requests: s.requests, failures: s.failures, consecutiveFailures: s.consecutiveFailures,
        rateLimited: s.rateLimited, staleHits: s.staleHits, timesOpened: s.opened,
        retryInMs: open ? s.openUntil - t : 0,
      };
    });
  }

  return { bars, ticker, book, consensusPrice, usdtBasis, universe, health };
}
