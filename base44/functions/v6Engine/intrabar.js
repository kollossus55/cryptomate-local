/**
 * 5-minute bars for held coins, so a wick between two polls is not missed.
 *
 * The market hub only serves 1h, 4h and 1d, so this small public-data reader lives
 * beside the worker until the hub gains a 5m timeframe. Public endpoints only, no keys.
 * One request per held coin on a normal tick, tried venue by venue. After an outage it
 * pages back through the whole gap, up to MAX_PAGES requests; the engine covers whatever
 * is older than that from hourly and daily bars. A venue that answers 429, 418, 403 or
 * 451 is left alone for a cooldown.
 */

const COOLDOWN_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
const FIVE_MIN_MS = 5 * 60_000;
const MAX_PAGES = 12;

const num = (v) => Number(v);
const base = (symbol) => symbol.replace(/USDT$/, '');

const VENUES = [
  {
    id: 'okx',
    pageSize: 100,
    // history-candles reaches further back than candles; 'after' means older than.
    url: (symbol, end, limit) => `https://www.okx.com/api/v5/market/history-candles?instId=${base(symbol)}-USDT&bar=5m&limit=${limit}&after=${end}`,
    parse: (body) => (body?.data ?? []).map((r) => ({ t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) })),
  },
  {
    id: 'bybit',
    pageSize: 1000,
    url: (symbol, end, limit) => `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=5&limit=${limit}&end=${end}`,
    parse: (body) => (body?.result?.list ?? []).map((r) => ({ t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) })),
  },
  {
    id: 'binance',
    pageSize: 1000,
    url: (symbol, end, limit) => `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}&endTime=${end}`,
    parse: (body) => (Array.isArray(body) ? body : []).map((r) => ({ t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) })),
  },
];

/**
 * @returns {(symbol: string, fromMs: number, toMs: number) => Promise<object[]|null>}
 *   Bars overlapping the window, oldest first, or null when no venue answered. The
 *   first bar can start after fromMs if a venue stopped answering part way back.
 */
export function createIntrabarReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const coolUntil = new Map();

  return async function intrabar(symbol, fromMs, toMs) {
    for (const venue of VENUES) {
      if ((coolUntil.get(venue.id) ?? 0) > now()) continue;
      const byTime = new Map();
      let end = toMs;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const limit = Math.min(venue.pageSize, Math.ceil((end - fromMs) / FIVE_MIN_MS) + 2);
          const res = await fetchImpl(venue.url(symbol, end, limit), { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if ([403, 418, 429, 451].includes(res.status)) { coolUntil.set(venue.id, now() + COOLDOWN_MS); break; }
          if (!res.ok) break;
          const rows = venue.parse(await res.json()).filter((b) => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite));
          if (!rows.length) break;
          for (const b of rows) if (b.t + FIVE_MIN_MS > fromMs && b.t <= toMs) byTime.set(b.t, b);
          const oldest = Math.min(...rows.map((b) => b.t));
          // The second test stops a venue that ignores the paging from looping on one page.
          if (oldest <= fromMs || oldest >= end) break;
          end = oldest;
        }
      } catch {
        // Keep what the earlier pages gave. Having no wick data is reported by the caller.
      }
      if (byTime.size) return [...byTime.values()].sort((a, b) => a.t - b.t);
    }
    return null;
  };
}
