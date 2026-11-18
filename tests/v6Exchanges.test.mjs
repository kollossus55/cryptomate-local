/**
 * V6 market hub tests. Every test runs on a mocked fetch and a fake clock, so
 * nothing here touches the network.
 */
import assert from 'node:assert';
import {
  EXCHANGES, TIMEFRAMES, MAX_TIMEOUT_MS, createMarketHub, parseSymbol, venueSymbol, classifyBase,
  normalizeBars, normalizeBook, estimateSlippage, convertQuote, median,
} from '../shared/trading/v6Exchanges.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const DAY = TIMEFRAMES['1d'];
const H4 = TIMEFRAMES['4h'];
const H1 = TIMEFRAMES['1h'];
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // midday, so today's daily bar is forming
const TODAY = Date.UTC(2026, 5, 15);

function clock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** Routes by hostname to a handler; records every URL. */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    const venue = Object.values(EXCHANGES).find((v) => new URL(v.baseUrl).host === u.host);
    const handler = routes[venue.id];
    if (!handler) throw new Error(`network down: ${venue.id}`);
    return handler(u, init);
  };
  fetchImpl.calls = calls;
  fetchImpl.count = (id) => calls.filter((c) => c.startsWith(EXCHANGES[id].baseUrl)).length;
  return fetchImpl;
}

const hubWith = (routes, { enabled, priorities, config, c = clock() } = {}) => {
  const fetchImpl = router(routes);
  const hub = createMarketHub({ enabled, priorities, fetchImpl, now: c.now, sleep: c.sleep, config });
  return { hub, fetchImpl, c };
};

// Native answers, one per venue, in the venue's own layout.
const ohlc = (i) => ({ o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 10 });
const dayTimes = (n, end = TODAY) => Array.from({ length: n }, (_, i) => end - (n - 1 - i) * DAY); // ends with the forming bar

const nativeBars = {
  binance: (ts) => ts.map((t, i) => { const b = ohlc(i); return [t, `${b.o}`, `${b.h}`, `${b.l}`, `${b.c}`, `${b.v}`, t + DAY - 1, '1000']; }),
  okx: (ts) => ({ code: '0', data: ts.slice().reverse().map((t) => { const b = ohlc(ts.indexOf(t)); return [`${t}`, `${b.o}`, `${b.h}`, `${b.l}`, `${b.c}`, `${b.v}`, '1000', '1000', t === TODAY ? '0' : '1']; }) }),
  bybit: (ts) => ({ retCode: 0, result: { list: ts.slice().reverse().map((t) => { const b = ohlc(ts.indexOf(t)); return [`${t}`, `${b.o}`, `${b.h}`, `${b.l}`, `${b.c}`, `${b.v}`, '1000']; }) }, time: NOW }),
  kraken: (ts) => ({ error: [], result: { XXBTZUSD: ts.map((t, i) => { const b = ohlc(i); return [t / 1000, `${b.o}`, `${b.h}`, `${b.l}`, `${b.c}`, '100', `${b.v}`, 5]; }), last: 1 } }),
  coinbase: (ts) => ts.slice().reverse().map((t) => { const b = ohlc(ts.indexOf(t)); return [t / 1000, b.l, b.h, b.o, b.c, b.v]; }),
  kucoin: (ts) => ({ code: '200000', data: ts.slice().reverse().map((t) => { const b = ohlc(ts.indexOf(t)); return [`${t / 1000}`, `${b.o}`, `${b.c}`, `${b.h}`, `${b.l}`, `${b.v}`, '1000']; }) }),
  gate: (ts) => ts.map((t, i) => { const b = ohlc(i); return [`${t / 1000}`, '1000', `${b.c}`, `${b.h}`, `${b.l}`, `${b.o}`, `${b.v}`, t === TODAY ? 'false' : 'true']; }),
  bitget: (ts) => ({ code: '00000', data: ts.map((t, i) => { const b = ohlc(i); return [`${t}`, `${b.o}`, `${b.h}`, `${b.l}`, `${b.c}`, `${b.v}`, '1000', '1000']; }) }),
};

const nativeTicker = {
  binance: (p, ts = NOW) => ({ bidPrice: `${p - 0.5}`, askPrice: `${p + 0.5}`, lastPrice: `${p}`, quoteVolume: '1000', closeTime: ts }),
  okx: (p, ts = NOW) => ({ code: '0', data: [{ bidPx: `${p - 0.5}`, askPx: `${p + 0.5}`, last: `${p}`, volCcy24h: '1000', ts: `${ts}` }] }),
  bybit: (p, ts = NOW) => ({ retCode: 0, time: ts, result: { list: [{ bid1Price: `${p - 0.5}`, ask1Price: `${p + 0.5}`, lastPrice: `${p}`, turnover24h: '1000' }] } }),
  kraken: (p) => ({ error: [], result: { XXBTZUSD: { a: [`${p + 0.5}`], b: [`${p - 0.5}`], c: [`${p}`], v: ['1', '10'], p: ['1', `${p}`] } } }),
  coinbase: (p, ts = NOW) => ({ bid: `${p - 0.5}`, ask: `${p + 0.5}`, price: `${p}`, volume: '10', time: new Date(ts).toISOString() }),
  kucoin: (p, ts = NOW) => ({ code: '200000', data: { buy: `${p - 0.5}`, sell: `${p + 0.5}`, last: `${p}`, volValue: '1000', time: ts } }),
  gate: (p) => [{ highest_bid: `${p - 0.5}`, lowest_ask: `${p + 0.5}`, last: `${p}`, quote_volume: '1000' }],
  bitget: (p, ts = NOW) => ({ code: '00000', data: [{ bidPr: `${p - 0.5}`, askPr: `${p + 0.5}`, lastPr: `${p}`, quoteVolume: '1000', ts: `${ts}` }] }),
};

/** USD venues answer USDT/USD peg queries separately from BTC queries. */
const isPegQuery = (u) => /USDT(-|)USD/.test(u.href) && !/BTC/.test(u.href);
const pegTicker = {
  kraken: (p) => ({ error: [], result: { USDTZUSD: { a: [`${p + 0.0001}`], b: [`${p - 0.0001}`], c: [`${p}`], v: ['1', '10'], p: ['1', `${p}`] } } }),
  coinbase: (p, ts = NOW) => ({ bid: `${p - 0.0001}`, ask: `${p + 0.0001}`, price: `${p}`, volume: '10', time: new Date(ts).toISOString() }),
};

/** Ticker routes for a price per venue, plus the peg on USD venues. */
function tickerRoutes(prices, peg = 1, tsFor = {}) {
  const routes = {};
  for (const [id, price] of Object.entries(prices)) {
    routes[id] = (u) => {
      if (EXCHANGES[id].pegSource && isPegQuery(u)) return json(pegTicker[id](peg));
      return json(nativeTicker[id](price, tsFor[id] ?? NOW));
    };
  }
  return routes;
}

console.log('symbol mapping');

await test('parseSymbol accepts the common spellings and rejects other quotes', () => {
  for (const s of ['BTCUSDT', 'BTC-USDT', 'btc/usdt', 'BTC_USDT', 'BTC']) assert.equal(parseSymbol(s).symbol, 'BTCUSDT');
  assert.deepEqual(parseSymbol('ETHUSD'), { base: 'ETH', quote: 'USD', symbol: 'ETHUSD' });
  assert.equal(parseSymbol('USDTUSD').base, 'USDT');
  for (const s of ['BTCUSDC', 'BTC-EUR', 'BTC/USDC', '', 'A-B-C', null]) {
    assert.throws(() => parseSymbol(s), (e) => e.code === 'unsupported', `should reject ${s}`);
  }
});

await test('venueSymbol maps each venue, with USD venues on their USD market', () => {
  const want = {
    binance: ['BTCUSDT', 'USDT'], okx: ['BTC-USDT', 'USDT'], bybit: ['BTCUSDT', 'USDT'], kraken: ['XBTUSD', 'USD'],
    coinbase: ['BTC-USD', 'USD'], kucoin: ['BTC-USDT', 'USDT'], gate: ['BTC_USDT', 'USDT'], bitget: ['BTCUSDT', 'USDT'],
  };
  for (const [id, [native, quote]] of Object.entries(want)) {
    assert.deepEqual(venueSymbol(id, 'BTCUSDT'), { native, quote }, id);
  }
  assert.equal(venueSymbol('kraken', 'DOGEUSDT').native, 'XDGUSD');
  assert.equal(venueSymbol('kraken', 'ETHUSDT').native, 'ETHUSD');
});

await test('the peg pair exists only on USD venues', () => {
  assert.equal(venueSymbol('binance', 'USDTUSD'), null);
  assert.equal(venueSymbol('coinbase', 'USDTUSD').native, 'USDT-USD');
  assert.equal(venueSymbol('kraken', 'USDTUSD').native, 'USDTUSD');
});

console.log('bar normalisation');

for (const id of Object.keys(EXCHANGES)) {
  await test(`${id}: bars come back oldest first, closed only, columns in the right place`, async () => {
    const times = dayTimes(4);
    const { hub, fetchImpl } = hubWith({ [id]: () => json(nativeBars[id](times)) }, { enabled: [id] });
    const bars = await hub.bars('BTCUSDT', '1d', 3);
    assert.deepEqual(bars.map((b) => b.t), times.slice(0, 3), 'forming bar dropped, order normalised');
    const b = bars[2];
    assert.deepEqual([b.o, b.h, b.l, b.c, b.v], [102, 112, 92, 107, 10]);
    assert.ok(b.qv > 0);
    assert.deepEqual(Object.keys(b), ['t', 'o', 'h', 'l', 'c', 'v', 'qv']);
    assert.equal(bars.meta.venue, id);
    assert.equal(bars.meta.stale, false);
    assert.equal(fetchImpl.calls.length, 1);
  });
}

await test('daily requests ask OKX and Bitget for the UTC variant, not Hong Kong midnight', async () => {
  const { hub, fetchImpl } = hubWith({
    okx: () => json(nativeBars.okx(dayTimes(3))),
    bitget: () => json(nativeBars.bitget(dayTimes(3))),
  }, { enabled: ['okx', 'bitget'] });
  await hub.bars('BTCUSDT', '1d', 2, { venue: 'okx' });
  await hub.bars('BTCUSDT', '1d', 2, { venue: 'bitget' });
  assert.match(fetchImpl.calls[0], /bar=1Dutc/);
  assert.match(fetchImpl.calls[1], /granularity=1Dutc/);
});

await test('a daily bar off the UTC grid is refused, then the next venue serves', async () => {
  const hk = dayTimes(3).map((t) => t - 8 * H1);
  const { hub } = hubWith({
    okx: () => json(nativeBars.okx(hk)),
    bybit: () => json(nativeBars.bybit(dayTimes(3))),
  }, { enabled: ['okx', 'bybit'], priorities: ['okx', 'bybit'] });
  const bars = await hub.bars('BTCUSDT', '1d', 2);
  assert.equal(bars.meta.venue, 'bybit');
  assert.equal(bars.meta.errors[0].code, 'malformed');
  assert.match(hub.health().find((h) => h.venue === 'okx').lastError, /off the 1d UTC grid/);
});

await test('closed filter: venue flag beats clock, and the grace period holds a just-ended bar', () => {
  const row = (t, closed) => ({ t, ...ohlc(0), qv: 1, closed });
  const last = TODAY - DAY;
  assert.equal(normalizeBars([row(last, false)], '1d', NOW).bars.length, 0, 'venue says open');
  assert.equal(normalizeBars([row(last, undefined)], '1d', NOW).bars.length, 1, 'clock says closed');
  assert.equal(normalizeBars([row(TODAY, undefined)], '1d', NOW).bars.length, 0, 'forming');
  assert.equal(normalizeBars([row(last, undefined)], '1d', TODAY + 1000).bars.length, 0, 'inside the grace period');
  assert.equal(normalizeBars([row(last, undefined)], '1d', TODAY + 5000).bars.length, 1, 'grace elapsed');
});

await test('impossible rows are dropped and counted; duplicates collapse', () => {
  const good = { t: TODAY - DAY, ...ohlc(0), qv: 1 };
  const { bars, dropped } = normalizeBars([
    good, { ...good }, { ...good, t: TODAY - 2 * DAY, h: 1 }, { ...good, t: TODAY - 3 * DAY, c: NaN }, { ...good, t: NaN },
  ], '1d', NOW);
  assert.equal(bars.length, 1);
  assert.equal(dropped, 3);
});

await test('coinbase 4h is built from 1h candles on the UTC grid', async () => {
  const c = clock(Date.UTC(2026, 5, 15, 13, 0, 0)); // 12:00 bar is forming
  const end = Date.UTC(2026, 5, 15, 12);
  const { hub, fetchImpl } = hubWith({
    coinbase: (u) => {
      assert.equal(u.searchParams.get('granularity'), '3600');
      const start = Date.parse(u.searchParams.get('start'));
      const stop = Date.parse(u.searchParams.get('end'));
      const rows = [];
      for (let t = start; t <= stop; t += H1) rows.unshift([t / 1000, 90 + (t / H1) % 4, 110 + (t / H1) % 4, 100, 101, 1]);
      return json(rows);
    },
  }, { enabled: ['coinbase'], c });
  const bars = await hub.bars('BTCUSDT', '4h', 2);
  assert.deepEqual(bars.map((b) => b.t), [end - 2 * H4, end - H4]);
  assert.equal(bars[0].v, 4, 'four hours of volume');
  assert.ok(bars[0].h >= 110 && bars[0].l <= 93);
  assert.equal(bars.meta.gaps, 0);
  assert.equal(fetchImpl.calls.length, 1);
});

await test('a long coinbase 4h request pages through the 300-candle cap', async () => {
  const { hub, fetchImpl } = hubWith({
    coinbase: (u) => {
      const start = Date.parse(u.searchParams.get('start'));
      const stop = Date.parse(u.searchParams.get('end'));
      assert.ok((stop - start) / H1 < 300, 'page within the cap');
      const rows = [];
      for (let t = start; t <= stop; t += H1) rows.unshift([t / 1000, 90, 110, 100, 101, 1]);
      return json(rows);
    },
  }, { enabled: ['coinbase'] });
  const bars = await hub.bars('BTCUSDT', '4h', 200);
  assert.equal(bars.length, 200);
  assert.equal(bars.meta.gaps, 0);
  assert.ok(fetchImpl.calls.length >= 3);
});

await test('gaps are counted', async () => {
  const times = dayTimes(6).filter((_, i) => i !== 2);
  const { hub } = hubWith({ binance: () => json(nativeBars.binance(times)) }, { enabled: ['binance'] });
  assert.equal((await hub.bars('BTCUSDT', '1d', 4)).meta.gaps, 1);
});

console.log('failover and breaker');

await test('failover walks the priority order past a dead venue', async () => {
  const { hub } = hubWith({
    binance: () => json({}, 500),
    bybit: () => json(nativeBars.bybit(dayTimes(3))),
  }, { enabled: ['binance', 'okx', 'bybit'], priorities: ['binance', 'okx', 'bybit'] });
  const bars = await hub.bars('BTCUSDT', '1d', 2);
  assert.equal(bars.meta.venue, 'bybit');
  assert.deepEqual(bars.meta.errors.map((e) => e.venue), ['binance', 'okx']);
});

await test('per-job priorities are honoured and unlisted venues still serve last', async () => {
  const { hub } = hubWith({
    binance: () => json(nativeBars.binance(dayTimes(3))),
    okx: () => json(nativeBars.okx(dayTimes(3))),
  }, { enabled: ['binance', 'okx'], priorities: { bars: ['okx'] } });
  assert.equal((await hub.bars('BTCUSDT', '1d', 2)).meta.venue, 'okx');
});

await test('{ venue } means that venue only: no silent failover', async () => {
  const { hub, fetchImpl } = hubWith({
    binance: () => json(nativeBars.binance(dayTimes(3))),
    okx: () => json({}, 500),
  }, { enabled: ['binance', 'okx'] });
  await assert.rejects(hub.bars('BTCUSDT', '1d', 2, { venue: 'okx' }), (e) => e.code === 'all_venues_failed');
  assert.equal(fetchImpl.count('binance'), 0);
});

await test('a venue that cannot serve the length is skipped; one that can is used', async () => {
  const { hub, fetchImpl } = hubWith({
    okx: () => json(nativeBars.okx(dayTimes(3))),
    binance: () => json(nativeBars.binance(dayTimes(502))),
  }, { enabled: ['okx', 'binance'], priorities: ['okx', 'binance'] });
  const bars = await hub.bars('BTCUSDT', '1d', 500);
  assert.equal(bars.meta.venue, 'binance');
  assert.equal(bars.length, 500);
  assert.equal(fetchImpl.count('okx'), 0);
});

await test('breaker opens after 3 failures, stops traffic, probes after cooldown, closes on success', async () => {
  let up = false;
  const c = clock();
  const { hub, fetchImpl } = hubWith({
    binance: () => (up ? json(nativeTicker.binance(100, c.now())) : json({}, 503)),
  }, { enabled: ['binance'], c });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(hub.ticker('BTCUSDT'));
    c.advance(3000);
  }
  let h = hub.health()[0];
  assert.equal(h.breaker, 'open');
  assert.equal(h.ok, false);
  assert.equal(fetchImpl.calls.length, 3);

  await assert.rejects(hub.ticker('BTCUSDT'), (e) => e.errors[0].code === 'breaker_open');
  assert.equal(fetchImpl.calls.length, 3, 'open breaker sends nothing');

  c.advance(31e3);
  await assert.rejects(hub.ticker('BTCUSDT')); // failed probe doubles the cooldown
  assert.equal(fetchImpl.calls.length, 4);
  h = hub.health()[0];
  assert.equal(h.breaker, 'open');
  assert.ok(h.retryInMs > 31e3 && h.retryInMs <= 60e3, `cooldown doubled, got ${h.retryInMs}`);

  up = true;
  c.advance(61e3);
  const t = await hub.ticker('BTCUSDT');
  assert.equal(t.venue, 'binance');
  h = hub.health()[0];
  assert.equal(h.breaker, 'closed');
  assert.equal(h.ok, true);
  assert.equal(h.consecutiveFailures, 0);
});

await test('half-open allows one probe, not a stampede', async () => {
  let release;
  let slow = false;
  const c = clock();
  const { hub, fetchImpl } = hubWith({
    binance: async () => {
      if (!slow) return json({}, 503);
      await new Promise((r) => { release = r; });
      return json(nativeBars.binance(dayTimes(3)));
    },
  }, { enabled: ['binance'], c });
  for (let i = 0; i < 3; i++) await assert.rejects(hub.book('BTCUSDT', 5));
  c.advance(31e3);
  slow = true;
  const probe = hub.bars('BTCUSDT', '1d', 2);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(hub.book('BTCUSDT', 5), (e) => e.errors[0].code === 'breaker_open');
  assert.equal(fetchImpl.calls.length, 4);
  release();
  await probe;
  assert.equal(hub.health()[0].breaker, 'closed');
});

await test('asking for an unlisted coin never trips the breaker', async () => {
  const c = clock();
  const { hub } = hubWith({ binance: () => json({ code: -1121, msg: 'Invalid symbol.' }, 400) }, { enabled: ['binance'], c });
  for (let i = 0; i < 6; i++) {
    await assert.rejects(hub.ticker(`NOPE${i}USDT`), (e) => e.errors[0].code === 'not_listed');
  }
  const h = hub.health()[0];
  assert.equal(h.breaker, 'closed');
  assert.equal(h.failures, 0);
});

await test('each venue\'s "no such pair" answer is recognised', async () => {
  const answers = {
    binance: () => json({ code: -1121, msg: 'Invalid symbol.' }, 400),
    okx: () => json({ code: '51001', data: [], msg: 'x' }),
    bybit: () => json({ retCode: 10001, retMsg: 'Not supported symbols', result: {} }),
    kraken: () => json({ error: ['EQuery:Unknown asset pair'] }),
    coinbase: () => json({ message: 'NotFound' }, 404),
    kucoin: () => json({ code: '200000', data: { last: null, buy: null, sell: null } }),
    gate: () => json({ label: 'INVALID_CURRENCY', message: 'Invalid currency NOPE' }, 400),
    bitget: () => json({ code: '40034', msg: 'Parameter does not exist', data: null }, 400),
  };
  for (const [id, answer] of Object.entries(answers)) {
    const { hub } = hubWith({ [id]: answer }, { enabled: [id] });
    await assert.rejects(hub.ticker('NOPEUSDT', { venue: id }), (e) => e.errors[0].code === 'not_listed', id);
  }
  const { hub } = hubWith({ kucoin: () => json({ msg: 'Unsupported trading pair.', code: '400100' }) }, { enabled: ['kucoin'] });
  await assert.rejects(hub.bars('NOPEUSDT', '1d', 2), (e) => e.errors[0].code === 'not_listed');
});

await test('not-listed answers are remembered instead of re-asked', async () => {
  const { hub, fetchImpl } = hubWith({ binance: () => json({ code: -1121 }, 400) }, { enabled: ['binance'] });
  await assert.rejects(hub.ticker('NOPEUSDT'));
  await assert.rejects(hub.ticker('NOPEUSDT'));
  assert.equal(fetchImpl.calls.length, 1);
});

await test('429 opens at once and honours Retry-After', async () => {
  const { hub, fetchImpl, c } = hubWith({ binance: () => json({}, 429, { 'Retry-After': '120' }) }, { enabled: ['binance'] });
  await assert.rejects(hub.ticker('BTCUSDT'));
  const h = hub.health()[0];
  assert.equal(h.breaker, 'open');
  assert.equal(h.rateLimited, 1);
  assert.equal(h.retryInMs, 120e3);
  c.advance(119e3);
  await assert.rejects(hub.ticker('BTCUSDT'));
  assert.equal(fetchImpl.calls.length, 1, 'no calls inside Retry-After');
});

await test('418 and 451 get long cooldowns', async () => {
  const banned = hubWith({ binance: () => json({}, 418) }, { enabled: ['binance'] });
  await assert.rejects(banned.hub.ticker('BTCUSDT'));
  assert.equal(banned.hub.health()[0].retryInMs, 5 * 60e3);
  const blocked = hubWith({ binance: () => json({}, 451) }, { enabled: ['binance'] });
  await assert.rejects(blocked.hub.ticker('BTCUSDT'));
  assert.equal(blocked.hub.health()[0].retryInMs, 30 * 60e3);
});

await test('rate limits reported in a 200 body also open the breaker', async () => {
  const { hub } = hubWith({ kraken: () => json({ error: ['EGeneral:Too many requests'] }) }, { enabled: ['kraken'] });
  await assert.rejects(hub.ticker('BTCUSD'));
  assert.equal(hub.health()[0].breaker, 'open');
});

await test('timeout fires even when fetch ignores abort, and counts as a failure', async () => {
  const fetchImpl = () => new Promise(() => {});
  const c = clock();
  const hub = createMarketHub({ enabled: ['binance'], fetchImpl, now: c.now, sleep: c.sleep, config: { timeoutMs: 15 } });
  await assert.rejects(hub.ticker('BTCUSDT'), (e) => e.errors[0].code === 'timeout');
  assert.equal(hub.health()[0].failures, 1);
});

await test('timeout cannot be configured past the 8s ceiling', async () => {
  assert.equal(MAX_TIMEOUT_MS, 8000);
  let seen = null;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { seen = ms; return realSetTimeout(fn, 0, ...rest); };
  try {
    const hub = createMarketHub({ enabled: ['binance'], fetchImpl: () => new Promise(() => {}), config: { timeoutMs: 60000 } });
    await assert.rejects(hub.ticker('BTCUSDT'));
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(seen, 8000);
});

await test('non-JSON (a WAF page) counts as a failure, not a crash', async () => {
  const { hub } = hubWith({ binance: () => json('<html>nope</html>') }, { enabled: ['binance'] });
  await assert.rejects(hub.ticker('BTCUSDT'), (e) => e.errors[0].code === 'malformed');
  assert.equal(hub.health()[0].failures, 1);
});

await test('rate limiter books one slot per interval on a host', async () => {
  const sleeps = [];
  const c = { now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } }; // clock held still
  const { hub } = hubWith({ kraken: () => json(nativeTicker.kraken(100)) }, { enabled: ['kraken'], c });
  await Promise.all(['AAAUSD', 'BBBUSD', 'CCCUSD'].map((s) => hub.ticker(s)));
  assert.deepEqual(sleeps, [2000, 4000], 'kraken is paced at one call per 2s');
});

await test('no more than 4 requests are in flight per host', async () => {
  let active = 0, peak = 0;
  const c = { now: () => NOW, sleep: async () => {} };
  const { hub } = hubWith({
    binance: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active--;
      return json(nativeTicker.binance(100));
    },
  }, { enabled: ['binance'], c, config: { maxQueueWaitMs: 60e3 } });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => hub.ticker(`C${i}USDT`)));
  assert.equal(results.length, 12);
  assert.equal(peak, 4);
});

await test('an overlong local queue fails over and does not blame the venue', async () => {
  const c = { now: () => NOW, sleep: async () => {} };
  const { hub } = hubWith({ kraken: () => json(nativeTicker.kraken(100)) }, { enabled: ['kraken'], c, config: { maxQueueWaitMs: 3000 } });
  const r = await Promise.allSettled(['A', 'B', 'C', 'D', 'E'].map((b) => hub.ticker(`${b}USD`)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
  assert.ok(r.some((x) => x.status === 'rejected' && x.reason.errors[0].code === 'local_throttle'));
  assert.equal(hub.health()[0].failures, 0);
});

console.log('cache');

await test('ticker TTL caches, then refreshes; concurrent callers share one request', async () => {
  const { hub, fetchImpl, c } = hubWith({ binance: () => json(nativeTicker.binance(100)) }, { enabled: ['binance'] });
  await Promise.all([hub.ticker('BTCUSDT'), hub.ticker('BTCUSDT'), hub.ticker('BTCUSDT')]);
  assert.equal(fetchImpl.calls.length, 1);
  c.advance(1000);
  await hub.ticker('BTCUSDT');
  assert.equal(fetchImpl.calls.length, 1);
  c.advance(1500);
  await hub.ticker('BTCUSDT');
  assert.equal(fetchImpl.calls.length, 2);
});

await test('fresh bars cache until the next bar closes, and mutating a result is harmless', async () => {
  const c = clock();
  const { hub, fetchImpl } = hubWith({ binance: () => json(nativeBars.binance(dayTimes(4, Math.floor(c.now() / DAY) * DAY))) }, { enabled: ['binance'], c });
  const first = await hub.bars('BTCUSDT', '1d', 3);
  first[0].c = -1;
  c.advance(6 * H1);
  const second = await hub.bars('BTCUSDT', '1d', 3);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(second[0].c > 0);
  c.advance(7 * H1);
  await hub.bars('BTCUSDT', '1d', 3);
  assert.equal(fetchImpl.calls.length, 2);
});

console.log('stale detection');

await test('stale bars fail over to a fresh venue', async () => {
  const old = dayTimes(4, TODAY - 3 * DAY);
  const { hub } = hubWith({
    binance: () => json(nativeBars.binance(old)),
    bybit: () => json(nativeBars.bybit(dayTimes(4))),
  }, { enabled: ['binance', 'bybit'], priorities: ['binance', 'bybit'] });
  const bars = await hub.bars('BTCUSDT', '1d', 3);
  assert.equal(bars.meta.venue, 'bybit');
  assert.equal(bars.meta.stale, false);
  assert.equal(bars.meta.errors[0].code, 'stale');
  assert.equal(hub.health().find((h) => h.venue === 'binance').staleHits, 1);
});

await test('when every venue is stale, the freshest is returned and flagged', async () => {
  const { hub } = hubWith({
    binance: () => json(nativeBars.binance(dayTimes(4, TODAY - 5 * DAY))),
    bybit: () => json(nativeBars.bybit(dayTimes(4, TODAY - 3 * DAY))),
  }, { enabled: ['binance', 'bybit'], priorities: ['binance', 'bybit'] });
  const bars = await hub.bars('BTCUSDT', '1d', 3);
  assert.equal(bars.meta.venue, 'bybit');
  assert.equal(bars.meta.stale, true);
});

await test('just after a close, a venue gets a lag allowance before it counts as stale', async () => {
  // Yesterday's bar closed at TODAY, but this venue's newest closed bar is the day before.
  const notYetPublished = () => json(nativeBars.binance(dayTimes(4, TODAY - 2 * DAY)));
  const c = clock(TODAY + 60e3);
  const { hub } = hubWith({ binance: notYetPublished }, { enabled: ['binance'], c });
  assert.equal((await hub.bars('BTCUSDT', '1d', 3)).meta.stale, false);
  c.advance(10 * 60e3);
  const late = hubWith({ binance: notYetPublished }, { enabled: ['binance'], c });
  assert.equal((await late.hub.bars('BTCUSDT', '1d', 3)).meta.stale, true);
});

await test('total outage serves last good bars, flagged, so exits still have data', async () => {
  let up = true;
  const c = clock();
  const { hub } = hubWith({
    binance: () => (up ? json(nativeBars.binance(dayTimes(4))) : json({}, 503)),
  }, { enabled: ['binance'], c });
  await hub.bars('BTCUSDT', '1d', 3);
  up = false;
  c.advance(DAY);
  const bars = await hub.bars('BTCUSDT', '1d', 3);
  assert.equal(bars.length, 3);
  assert.equal(bars.meta.stale, true);
  assert.equal(bars.meta.lastGood, true);
});

await test('nothing ever fetched means throw, not an empty array', async () => {
  const { hub } = hubWith({ binance: () => json({}, 503) }, { enabled: ['binance'] });
  await assert.rejects(hub.bars('BTCUSDT', '1d', 3), (e) => e.code === 'all_venues_failed');
});

await test('a stale feed timestamp fails ticker over; a quiet last-trade time does not', async () => {
  const { hub } = hubWith({
    okx: () => json(nativeTicker.okx(100, NOW - 120e3)),
    bybit: () => json(nativeTicker.bybit(101)),
  }, { enabled: ['okx', 'bybit'], priorities: ['okx', 'bybit'] });
  assert.equal((await hub.ticker('BTCUSDT')).venue, 'bybit');

  const quiet = hubWith({ binance: () => json(nativeTicker.binance(100, NOW - 120e3)) }, { enabled: ['binance'] });
  assert.equal((await quiet.hub.ticker('BTCUSDT')).stale, false);
  const dead = hubWith({ binance: () => json(nativeTicker.binance(100, NOW - 20 * 60e3)) }, { enabled: ['binance'] });
  assert.equal((await dead.hub.ticker('BTCUSDT')).stale, true);
});

await test('total outage serves last good ticker, flagged', async () => {
  let up = true;
  const c = clock();
  const { hub } = hubWith({
    binance: () => (up ? json(nativeTicker.binance(100)) : json({}, 503)),
  }, { enabled: ['binance'], c });
  await hub.ticker('BTCUSDT');
  up = false;
  c.advance(5000);
  const t = await hub.ticker('BTCUSDT');
  assert.equal(t.stale, true);
  assert.equal(t.lastGood, true);
  assert.equal(t.price, 100);
});

console.log('consensus');

const USDT_VENUES = ['binance', 'okx', 'bybit', 'kucoin', 'gate', 'bitget'];

await test('median over agreeing venues', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 100.1, bybit: 100.2 }), { enabled: ['binance', 'okx', 'bybit'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, true);
  assert.equal(r.price, 100.1);
  assert.equal(r.venues.length, 3);
  assert.equal(r.reason, null);
  assert.equal(r.disagreement, false);
  assert.ok(r.spreadPct > 0.19 && r.spreadPct < 0.21);
});

await test('one bad venue is named and excluded; price is unaffected', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 100.1, bybit: 100.05, kucoin: 137 }), { enabled: ['binance', 'okx', 'bybit', 'kucoin'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, true);
  assert.equal(r.price, 100.05);
  assert.equal(r.reason, 'outlier_excluded');
  assert.equal(r.disagreement, true);
  assert.deepEqual(r.outliers.map((o) => o.venue), ['kucoin']);
  assert.ok(!r.venues.includes('kucoin'));
  assert.ok(r.rawSpreadPct > 30);
  assert.ok(r.spreadPct < 0.2);
});

await test('two venues that disagree cannot be resolved, so ok is false', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 103 }), { enabled: ['binance', 'okx'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'venues_disagree');
  assert.equal(r.disagreement, true);
});

await test('an even split has no majority, so nobody is trusted', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 100, bybit: 110, kucoin: 110 }), { enabled: ['binance', 'okx', 'bybit', 'kucoin'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, false);
  assert.equal(r.disagreement, true);
});

await test('two venues agreeing while the rest scatter is not a majority', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 90, okx: 100, bybit: 100.1, kucoin: 110, gate: 120 }), { enabled: ['binance', 'okx', 'bybit', 'kucoin', 'gate'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_majority');
  assert.equal(r.venues.length, 2);
  assert.equal(r.disagreement, true);
});

await test('one healthy venue is not a consensus', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100 }), { enabled: ['binance', 'okx'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_venues');
  assert.equal(r.price, 100);
  assert.equal(r.disagreement, false);
});

await test('stale venues do not vote', async () => {
  const { hub } = hubWith(
    tickerRoutes({ binance: 100, okx: 150, bybit: 100.1 }, 1, { okx: NOW - 120e3 }),
    { enabled: ['binance', 'okx', 'bybit'] },
  );
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, true);
  assert.deepEqual(r.excluded.map((e) => [e.venue, e.reason]), [['okx', 'stale']]);
  assert.equal(r.outliers.length, 0);
});

await test('a breaker-open venue is skipped and reported', async () => {
  const c = clock();
  const routes = tickerRoutes({ binance: 100, bybit: 100.1 });
  routes.okx = () => json({}, 503);
  const { hub, fetchImpl } = hubWith(routes, { enabled: ['binance', 'okx', 'bybit'], c });
  for (let i = 0; i < 3; i++) { await hub.consensusPrice('BTCUSDT'); c.advance(3000); }
  const before = fetchImpl.count('okx');
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(fetchImpl.count('okx'), before);
  assert.equal(r.ok, true);
  assert.equal(r.excluded.find((e) => e.venue === 'okx').reason, 'breaker_open');
});

await test('an alt missing from some venues is judged only on venues that list it', async () => {
  const routes = tickerRoutes({ binance: 2, okx: 2.001 });
  routes.bybit = () => json({ retCode: 10001, retMsg: 'Not supported symbols', result: {} });
  const { hub } = hubWith(routes, { enabled: ['binance', 'okx', 'bybit'] });
  const r = await hub.consensusPrice('ABCUSDT', { tolerancePct: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.excluded[0].reason, 'not_listed');
});

await test('lastGood reports the most recent agreed price after a failure', async () => {
  let split = false;
  const c = clock();
  const routes = {
    binance: () => json(nativeTicker.binance(100, c.now())),
    okx: () => json(nativeTicker.okx(split ? 120 : 100.05, c.now())),
  };
  const { hub } = hubWith(routes, { enabled: ['binance', 'okx'], c });
  const good = await hub.consensusPrice('BTCUSDT');
  split = true;
  c.advance(10e3);
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, false);
  assert.equal(r.lastGood.price, good.price);
  assert.equal(r.lastGood.ageMs, 10e3);
});

console.log('peg adjustment');

await test('without adjustment USD venues look wrong during a depeg; with it they agree', async () => {
  // USDT at 0.97: BTC is 97 USD = 100 USDT. A raw comparison sees a 3% gap.
  const peg = 0.97;
  const { hub } = hubWith(
    tickerRoutes({ binance: 100, okx: 100.02, bybit: 99.98, kraken: 97, coinbase: 97.01 }, peg),
    { enabled: ['binance', 'okx', 'bybit', 'kraken', 'coinbase'] },
  );
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.venues.length, 5);
  assert.equal(r.outliers.length, 0);
  assert.ok(Math.abs(r.price - 100) < 0.03, `price ${r.price}`);
  assert.equal(r.basis.ok, true);
  assert.ok(Math.abs(r.basis.basis - 0.97) < 1e-6);
  assert.equal(r.basis.deviationPct, -3);
  assert.equal(r.pegAlarm, true);
  const kraken = r.quotes.find((q) => q.venue === 'kraken');
  assert.equal(kraken.adjusted, true);
  assert.equal(kraken.rawPrice, 97);
  assert.ok(Math.abs(kraken.price - 100) < 1e-6);
  assert.equal(r.quotes.find((q) => q.venue === 'binance').adjusted, false);
});

await test('a USD-quoted request converts the other way', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 100, kraken: 97, coinbase: 97 }, 0.97), { enabled: ['binance', 'okx', 'kraken', 'coinbase'] });
  const r = await hub.consensusPrice('BTCUSD');
  assert.equal(r.ok, true);
  assert.equal(r.quote, 'USD');
  assert.ok(Math.abs(r.price - 97) < 1e-6);
  assert.equal(r.quotes.find((q) => q.venue === 'binance').adjusted, true);
});

await test('no alarm at the small live basis, but it is still applied', async () => {
  const { hub } = hubWith(tickerRoutes({ binance: 100, okx: 100, kraken: 99.89, coinbase: 99.89 }, 0.9989), { enabled: ['binance', 'okx', 'kraken', 'coinbase'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.pegAlarm, false);
  assert.ok(r.spreadPct < 0.001, `spread ${r.spreadPct}`);
});

await test('basis unavailable: USD venues sit out; nothing is compared 1:1', async () => {
  const routes = tickerRoutes({ binance: 100, okx: 100.01 });
  routes.kraken = (u) => (isPegQuery(u) ? json({}, 503) : json(nativeTicker.kraken(97)));
  routes.coinbase = (u) => (isPegQuery(u) ? json({}, 503) : json(nativeTicker.coinbase(97)));
  const { hub } = hubWith(routes, { enabled: ['binance', 'okx', 'kraken', 'coinbase'] });
  const r = await hub.consensusPrice('BTCUSDT');
  assert.equal(r.ok, true);
  assert.deepEqual(r.venues.sort(), ['binance', 'okx']);
  assert.deepEqual(r.excluded.map((e) => e.reason), ['no_basis', 'no_basis']);
  assert.equal(r.basis.ok, false);
  assert.equal(r.basis.reason, 'peg_unavailable');
});

await test('basis sources that disagree are not averaged', async () => {
  const routes = {
    kraken: (u) => (isPegQuery(u) ? json(pegTicker.kraken(0.97)) : json(nativeTicker.kraken(97))),
    coinbase: (u) => (isPegQuery(u) ? json(pegTicker.coinbase(1.0)) : json(nativeTicker.coinbase(97))),
    binance: () => json(nativeTicker.binance(100)),
  };
  const { hub } = hubWith(routes, { enabled: ['binance', 'kraken', 'coinbase'] });
  const b = await hub.usdtBasis();
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'peg_sources_disagree');
});

await test('one basis source is enough; last good basis survives a short outage', async () => {
  let up = true;
  const c = clock();
  const routes = {
    kraken: (u) => (up ? json(pegTicker.kraken(0.99)) : json({}, 503)),
    coinbase: () => json({}, 503),
  };
  const { hub } = hubWith(routes, { enabled: ['kraken', 'coinbase'], c });
  const b = await hub.usdtBasis();
  assert.equal(b.ok, true);
  assert.equal(b.sources.length, 1);
  up = false;
  c.advance(60e3);
  const held = await hub.usdtBasis();
  assert.equal(held.ok, true);
  assert.equal(held.stale, true);
  c.advance(11 * 60e3);
  assert.equal((await hub.usdtBasis()).ok, false);
});

await test('ticker failover to a USD venue converts into the asked-for quote', async () => {
  const { hub } = hubWith({
    binance: () => json({}, 503),
    kraken: (u) => (isPegQuery(u) ? json(pegTicker.kraken(0.97)) : json(nativeTicker.kraken(97))),
  }, { enabled: ['binance', 'kraken'], priorities: ['binance', 'kraken'] });
  const t = await hub.ticker('BTCUSDT');
  assert.equal(t.venue, 'kraken');
  assert.equal(t.quote, 'USDT');
  assert.equal(t.venueQuote, 'USD');
  assert.equal(t.basisAdjusted, true);
  assert.ok(Math.abs(t.price - 100) < 1e-6);
  assert.equal(t.rawPrice, 97);
});

await test('USD venue with no basis is refused for ticker rather than passed off as USDT', async () => {
  const { hub } = hubWith({ kraken: (u) => (isPegQuery(u) ? json({}, 503) : json(nativeTicker.kraken(97))) }, { enabled: ['kraken'] });
  await assert.rejects(hub.ticker('BTCUSDT'), (e) => e.errors[0].code === 'no_basis');
});

await test('USD bars are never rescaled, and say what they are', async () => {
  const { hub } = hubWith({ coinbase: () => json(nativeBars.coinbase(dayTimes(3))) }, { enabled: ['coinbase'] });
  const bars = await hub.bars('BTCUSDT', '1d', 2);
  assert.equal(bars.meta.quote, 'USD');
  assert.equal(bars.meta.quoteMismatch, true);
  assert.equal(bars[0].c, 105);
});

await test('convertQuote refuses to guess', () => {
  assert.equal(convertQuote(100, 'USDT', 'USDT', null), 100);
  assert.ok(Math.abs(convertQuote(97, 'USD', 'USDT', 0.97) - 100) < 1e-9);
  assert.ok(Math.abs(convertQuote(100, 'USDT', 'USD', 0.97) - 97) < 1e-9);
  assert.throws(() => convertQuote(100, 'USD', 'USDT', null), (e) => e.code === 'no_basis');
});

console.log('order book');

const nativeBook = {
  binance: () => ({ bids: [['99', '2'], ['98', '3']], asks: [['101', '1'], ['102', '4']] }),
  okx: () => ({ code: '0', data: [{ bids: [['99', '2', '0', '1'], ['98', '3', '0', '1']], asks: [['101', '1', '0', '1'], ['102', '4', '0', '1']], ts: `${NOW}` }] }),
  bybit: () => ({ retCode: 0, result: { b: [['99', '2'], ['98', '3']], a: [['101', '1'], ['102', '4']], ts: NOW } }),
  kraken: () => ({ error: [], result: { XXBTZUSD: { bids: [['99', '2', NOW / 1000], ['98', '3', NOW / 1000]], asks: [['101', '1', NOW / 1000], ['102', '4', NOW / 1000]] } } }),
  coinbase: () => ({ bids: [['99', '2', 1], ['98', '3', 1]], asks: [['101', '1', 1], ['102', '4', 1]], time: new Date(NOW).toISOString() }),
  kucoin: () => ({ code: '200000', data: { bids: [['99', '2'], ['98', '3']], asks: [['101', '1'], ['102', '4']], time: NOW } }),
  gate: () => ({ bids: [['99', '2'], ['98', '3']], asks: [['101', '1'], ['102', '4']], update: NOW }),
  bitget: () => ({ code: '00000', data: { bids: [['99', '2'], ['98', '3']], asks: [['101', '1'], ['102', '4']], ts: `${NOW}` } }),
};

for (const id of Object.keys(EXCHANGES)) {
  await test(`${id}: book normalises to numeric [price, qty], best first`, async () => {
    const routes = {
      [id]: (u) => (EXCHANGES[id].pegSource && isPegQuery(u) ? json(pegTicker[id](1)) : json(nativeBook[id]())),
    };
    const { hub } = hubWith(routes, { enabled: [id] });
    const b = await hub.book('BTCUSDT', 2);
    assert.deepEqual(b.bids, [[99, 2], [98, 3]]);
    assert.deepEqual(b.asks, [[101, 1], [102, 4]]);
    assert.equal(b.mid, 100);
    assert.equal(b.spreadPct, 2);
    assert.equal(b.venue, id);
  });
}

await test('normalizeBook sorts, trims to depth, drops empty levels', () => {
  const b = normalizeBook({ bids: [['98', '1'], ['99', '1'], ['97', '0']], asks: [['102', '1'], ['101', '1']] }, 1);
  assert.deepEqual(b, { bids: [[99, 1]], asks: [[101, 1]] });
});

await test('crossed or empty book fails over without blaming the venue', async () => {
  const { hub } = hubWith({
    okx: () => json({ code: '0', data: [{ bids: [['102', '1']], asks: [['101', '1']], ts: `${NOW}` }] }),
    binance: () => json(nativeBook.binance()),
  }, { enabled: ['okx', 'binance'], priorities: ['okx', 'binance'] });
  assert.equal((await hub.book('BTCUSDT', 2)).venue, 'binance');
  assert.equal(hub.health().find((h) => h.venue === 'okx').failures, 0);
});

await test('a stale book is skipped; there is no last-good book', async () => {
  const old = { code: '0', data: [{ bids: [['99', '1']], asks: [['101', '1']], ts: `${NOW - 60e3}` }] };
  const { hub } = hubWith({ okx: () => json(old) }, { enabled: ['okx'] });
  await assert.rejects(hub.book('BTCUSDT', 2), (e) => e.errors[0].code === 'stale');
});

await test('USD book levels convert into the asked-for quote; sizes do not', async () => {
  const { hub } = hubWith({
    kraken: (u) => (isPegQuery(u) ? json(pegTicker.kraken(0.5001)) : json(nativeBook.kraken())),
  }, { enabled: ['kraken'] });
  const b = await hub.book('BTCUSDT', 2);
  assert.equal(b.basisAdjusted, true);
  assert.ok(Math.abs(b.bids[0][0] - 99 / 0.5001) < 1e-6);
  assert.equal(b.bids[0][1], 2);
});

await test('short book reports truncated; depth is clamped to the venue maximum', async () => {
  const { hub, fetchImpl } = hubWith({ bitget: () => json(nativeBook.bitget()) }, { enabled: ['bitget'] });
  const b = await hub.book('BTCUSDT', 500);
  assert.equal(b.truncated, true);
  assert.match(fetchImpl.calls[0], /limit=150/);
});

await test('estimateSlippage walks the book and flags an incomplete fill', () => {
  const book = { bids: [[99, 2], [98, 3]], asks: [[101, 1], [102, 4]] };
  const small = estimateSlippage(book, 'buy', 101);
  assert.equal(small.avgPrice, 101);
  assert.equal(small.slippagePct, 1);
  assert.equal(small.complete, true);
  const walk = estimateSlippage(book, 'buy', 101 + 102);
  assert.ok(walk.avgPrice > 101 && walk.avgPrice < 102);
  assert.equal(walk.levels, 2);
  const sell = estimateSlippage(book, 'sell', 99);
  assert.equal(sell.slippagePct, 1, 'cost is positive on both sides');
  const huge = estimateSlippage(book, 'buy', 1e6);
  assert.equal(huge.complete, false);
  assert.equal(huge.filledNotional, 101 + 408);
});

console.log('universe');

await test('classifyBase keeps real tokens that merely look excluded', () => {
  for (const b of ['BTC', 'ETH', 'JUP', 'SYRUP', 'UP', 'WLD', 'WIF', 'WOO', 'XLM', 'XTZ', 'TRX', 'SUI', '1INCH', 'DOWN']) {
    assert.equal(classifyBase(b), null, b);
  }
  for (const b of ['USDT', 'USDC', 'FDUSD', 'PYUSD', 'RLUSD', 'USD1', 'USDX9', 'EURC', 'DAI', 'CRVUSD', 'EUR', 'XUSD', 'U']) assert.equal(classifyBase(b), 'stablecoin', b);
  for (const b of ['WBTC', 'WETH', 'STETH', 'WSTETH', 'CBBTC', 'PAXG', 'XAUT', 'JITOSOL']) assert.equal(classifyBase(b), 'wrapped', b);
  for (const b of ['BTC3L', 'ETH5S', 'BTCUP', 'ETHDOWN', 'ETHBULL', 'XRPBEAR']) assert.equal(classifyBase(b), 'leveraged', b);
  assert.equal(classifyBase('XAAPL', new Set(['XAAPL'])), 'non_crypto');
  assert.equal(classifyBase('NVDAX'), 'non_crypto', 'static backstop when tags are unreachable');
});

const allRoutes = () => ({
  binance: () => json([
    { symbol: 'BTCUSDT', lastPrice: '100', quoteVolume: '9000000', count: 5 },
    { symbol: 'SOLUSDT', lastPrice: '10', quoteVolume: '6000000', count: 5 },
    { symbol: 'USDCUSDT', lastPrice: '1', quoteVolume: '99000000', count: 5 },
    { symbol: 'WBTCUSDT', lastPrice: '100', quoteVolume: '50000000', count: 5 },
    { symbol: 'DEADUSDT', lastPrice: '1', quoteVolume: '50000000', count: 0 },
    { symbol: 'BTCEUR', lastPrice: '90', quoteVolume: '50000000', count: 5 },
  ]),
  okx: (u) => (/instruments/.test(u.pathname)
    ? json({ code: '0', data: [{ instCategory: '3', baseCcy: 'XAAPL' }, { instCategory: '1', baseCcy: 'BTC' }] })
    : json({ code: '0', data: [
      { instId: 'BTC-USDT', last: '100', volCcy24h: '4000000' },
      { instId: 'XAAPL-USDT', last: '200', volCcy24h: '70000000' },
      { instId: 'BTC-EUR', last: '90', volCcy24h: '70000000' },
    ] })),
  gate: () => json([
    { currency_pair: 'BTC5L_USDT', last: '3', quote_volume: '80000000' },
    { currency_pair: 'THIN_USDT', last: '3', quote_volume: '100' },
  ]),
  kraken: (u) => (/AssetPairs/.test(u.pathname)
    ? json({ error: [], result: {
      XXBTZUSD: { wsname: 'XBT/USD', status: 'online' },
      XXDGZUSD: { wsname: 'XDG/USD', status: 'online' },
      OLDUSD: { wsname: 'OLD/USD', status: 'delisted' },
    } })
    : json({ error: [], result: {
      XXBTZUSD: { c: ['100'], v: ['1', '20000'], p: ['1', '100'] },
      XXDGZUSD: { c: ['0.1'], v: ['1', '100000000'], p: ['1', '0.1'] },
      OLDUSD: { c: ['1'], v: ['1', '100000000'], p: ['1', '1'] },
    } })),
  coinbase: () => json({
    'BTC-USD': { stats_24hour: { last: '100', volume: '10000' } },
    'SOL-USD': { stats_24hour: { last: '10', volume: '100000' } },
    'BTC-EUR': { stats_24hour: { last: '90', volume: '100000000' } },
  }),
});

await test('universe merges volume across venues and quote spellings, excludes the junk', async () => {
  const { hub } = hubWith(allRoutes(), { enabled: ['binance', 'okx', 'gate', 'kraken', 'coinbase'] });
  const u = await hub.universe({ topN: 10, minQuoteVolume: 5e6, minVenues: 1 });
  assert.deepEqual(u.map((r) => r.symbol), ['BTCUSDT', 'DOGEUSDT', 'SOLUSDT']);
  const btc = u[0];
  assert.equal(btc.quoteVolume, 9e6 + 4e6 + 2e6 + 1e6);
  assert.deepEqual(btc.venues, ['binance', 'okx', 'kraken', 'coinbase']);
  assert.equal(u[1].quoteVolume, 1e7, 'Kraken XDG is mapped back to DOGE');
  assert.equal(u[2].quoteVolume, 6e6 + 1e6);
  assert.equal(u.meta.excluded.stablecoin, 1);
  assert.equal(u.meta.excluded.wrapped, 1);
  assert.equal(u.meta.excluded.leveraged, 1);
  assert.equal(u.meta.excluded.non_crypto, 1);
});

await test('universe honours topN and minVenues, and survives a venue being down', async () => {
  const routes = allRoutes();
  delete routes.coinbase;
  const { hub } = hubWith(routes, { enabled: ['binance', 'okx', 'kraken', 'coinbase'] });
  const u = await hub.universe({ topN: 1, minQuoteVolume: 1e6, minVenues: 1 });
  assert.equal(u.length, 1);
  assert.deepEqual(u.meta.failed.map((f) => f.venue), ['coinbase']);
  const both = await hub.universe({ topN: 10, minQuoteVolume: 1e6, minVenues: 2 });
  assert.deepEqual(both.map((r) => r.base), ['BTC']);
});

/** Bitget answers symbols and tickers on two paths. */
const bitgetRoute = (symbols, tickers) => (u) => json({ code: '00000', data: /public\/symbols/.test(u.pathname) ? symbols : tickers });

await test('default minVenues keeps a single-venue coin out, whatever volume it claims', async () => {
  const { hub } = hubWith(allRoutes(), { enabled: ['binance', 'okx', 'gate', 'kraken', 'coinbase'] });
  assert.deepEqual((await hub.universe({ topN: 10 })).map((r) => r.base), ['BTC', 'SOL']);
});

await test('Bitget r-tokens go, without taking the real coin an uppercased name collides with', async () => {
  const { hub } = hubWith({
    bitget: bitgetRoute(
      [
        { symbol: 'RQQQUSDT', baseCoin: 'rQQQ', status: 'online' },
        { symbol: 'RAYUSDT', baseCoin: 'RAY', status: 'online' },
        { symbol: 'OLDUSDT', baseCoin: 'OLD', status: 'halt' },
      ],
      [
        { symbol: 'RQQQUSDT', lastPr: '660', quoteVolume: '9000000000' },
        { symbol: 'RAYUSDT', lastPr: '2', quoteVolume: '8000000' },
        { symbol: 'OLDUSDT', lastPr: '2', quoteVolume: '8000000' },
      ],
    ),
  }, { enabled: ['bitget'] });
  assert.deepEqual((await hub.universe({ minVenues: 1 })).map((r) => r.base), ['RAY']);
});

await test('with no Bitget symbol list its tickers are refused, not admitted unfiltered', async () => {
  const { hub } = hubWith({
    bitget: (u) => (/public\/symbols/.test(u.pathname) ? json({}, 503) : json({ code: '00000', data: [{ symbol: 'RQQQUSDT', lastPr: '660', quoteVolume: '9000000000' }] })),
    binance: () => json([{ symbol: 'SOLUSDT', lastPrice: '10', quoteVolume: '6000000', count: 5 }]),
  }, { enabled: ['bitget', 'binance'] });
  const u = await hub.universe({ minVenues: 1 });
  assert.deepEqual(u.map((r) => r.base), ['SOL']);
  assert.deepEqual(u.meta.failed.map((x) => x.venue), ['bitget']);
});

await test('a stock tag from one venue removes that base from every venue', async () => {
  const { hub } = hubWith({
    bybit: (u) => (/instruments-info/.test(u.pathname)
      ? json({ retCode: 0, result: { list: [{ baseCoin: 'NEWSTOCKX', symbolType: 'xstocks' }, { baseCoin: 'SOL', symbolType: '' }] } })
      : json({ retCode: 0, result: { list: [{ symbol: 'SOLUSDT', lastPrice: '10', turnover24h: '6000000' }] } })),
    kucoin: (u) => (/v2\/symbols/.test(u.pathname)
      ? json({ code: '200000', data: [{ baseCurrency: 'OTHERX', market: 'Stocks' }, { baseCurrency: 'SOL', market: 'USDS' }] })
      : json({ code: '200000', data: { ticker: [{ symbol: 'NEWSTOCKX-USDT', last: '100', volValue: '9000000' }, { symbol: 'OTHERX-USDT', last: '100', volValue: '9000000' }] } })),
    gate: (u) => (/currency_pairs/.test(u.pathname)
      ? json([{ base: 'THIRDX', base_name: 'Some xStock' }, { base: 'SOL', base_name: 'Solana' }])
      : json([{ currency_pair: 'THIRDX_USDT', last: '100', quote_volume: '9000000' }, { currency_pair: 'SOL_USDT', last: '10', quote_volume: '6000000' }])),
  }, { enabled: ['bybit', 'kucoin', 'gate'] });
  const u = await hub.universe({ minVenues: 1 });
  assert.deepEqual(u.map((r) => r.base), ['SOL']);
  assert.equal(u.meta.excluded.non_crypto, 3);
});

await test('same ticker on another project is not merged', async () => {
  const { hub } = hubWith({
    binance: () => json([{ symbol: 'ABCUSDT', lastPrice: '1', quoteVolume: '9000000', count: 5 }]),
    gate: () => json([{ currency_pair: 'ABC_USDT', last: '40', quote_volume: '50000000' }]),
    bitget: bitgetRoute([{ symbol: 'ABCUSDT', baseCoin: 'ABC', status: 'online' }], [{ symbol: 'ABCUSDT', lastPr: '1.01', quoteVolume: '8000000' }]),
  }, { enabled: ['binance', 'gate', 'bitget'] });
  const [abc] = await hub.universe({ topN: 5, minQuoteVolume: 1e6 });
  assert.equal(abc.quoteVolume, 17e6);
  assert.deepEqual(abc.droppedVenues, ['gate']);
  assert.equal(abc.priceConflict, true);
});

await test('with only two venues in conflict, the bigger stands and the row is flagged', async () => {
  const { hub } = hubWith({
    binance: () => json([{ symbol: 'ABCUSDT', lastPrice: '1', quoteVolume: '9000000', count: 5 }]),
    gate: () => json([{ currency_pair: 'ABC_USDT', last: '40', quote_volume: '50000000' }]),
  }, { enabled: ['binance', 'gate'] });
  const [abc] = await hub.universe({ topN: 5, minQuoteVolume: 1e6, minVenues: 1 });
  assert.deepEqual(abc.venues, ['gate']);
  assert.equal(abc.priceConflict, true);
});

await test('universe throws when no venue answers', async () => {
  const { hub } = hubWith({}, { enabled: ['binance', 'gate'] });
  await assert.rejects(hub.universe(), (e) => e.code === 'all_venues_failed');
});

await test('bulk tickers are cached between universe calls', async () => {
  const { hub, fetchImpl, c } = hubWith(allRoutes(), { enabled: ['binance'] });
  await hub.universe({ minVenues: 1 });
  c.advance(60e3);
  await hub.universe({ minVenues: 1 });
  assert.equal(fetchImpl.calls.length, 1);
  c.advance(5 * 60e3);
  await hub.universe({ minVenues: 1 });
  assert.equal(fetchImpl.calls.length, 2);
});

console.log('safety and portability');

await test('health has one row per venue in the contract shape', async () => {
  const { hub } = hubWith({ binance: () => json(nativeTicker.binance(100)) }, { enabled: ['binance', 'okx'] });
  await hub.ticker('BTCUSDT');
  const rows = hub.health();
  assert.deepEqual(rows.map((r) => r.venue), ['binance', 'okx']);
  for (const k of ['ok', 'latencyMs', 'lastError', 'lastOk']) assert.ok(k in rows[0], k);
  assert.equal(rows[0].lastOk, NOW);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].status, 'ok');
});

await test('a venue nobody has tried is unknown, never healthy', () => {
  const { hub } = hubWith({}, { enabled: ['binance'] });
  const [h] = hub.health();
  assert.equal(h.ok, false);
  assert.equal(h.status, 'unknown');
});

await test('health status separates blocked, rate limited, error and slow', async () => {
  const status = async (route, c = clock()) => {
    const { hub } = hubWith({ binance: route }, { enabled: ['binance'], c });
    await hub.ticker('BTCUSDT').catch(() => {});
    return hub.health()[0].status;
  };
  assert.equal(await status(() => json({}, 451)), 'blocked');
  assert.equal(await status(() => json({}, 429)), 'rate_limited');
  assert.equal(await status(() => json({}, 503)), 'error');
  const c = clock();
  assert.equal(await status(() => { c.advance(1500); return json(nativeTicker.binance(100, c.now())); }, c), 'slow');
});

await test('unknown venues and bad arguments are refused early', async () => {
  assert.throws(() => createMarketHub({ enabled: ['mtgox'] }), (e) => e.code === 'unsupported');
  const { hub } = hubWith({});
  await assert.rejects(hub.bars('BTCUSDT', '5m', 10), (e) => e.code === 'unsupported');
  await assert.rejects(hub.bars('BTCUSDT', '1d', 0), (e) => e.code === 'unsupported');
  await assert.rejects(hub.bars('BTCUSDT', '1d', 5, { venue: 'mtgox' }), (e) => e.code === 'unsupported');
});

await test('source has no keys, signing, Deno APIs or banned imports', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../shared/trading/v6Exchanges.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bimport\b/, 'no imports at all');
  assert.doesNotMatch(code, /Deno\.|process\.|require\(/);
  assert.doesNotMatch(code, /apiKey|api_key|secret|passphrase|hmac|createHmac|signature|X-MBX|OK-ACCESS|Authorization/i);
  assert.doesNotMatch(code, /liveOrderExecution|executeApprovedTrade|liveTradingControl|okxExchange/);
});

await test('every URL the adapters build is a GET on a public path', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return json({}, 503); };
  const c = clock();
  const hub = createMarketHub({ fetchImpl, now: c.now, sleep: c.sleep });
  await Promise.allSettled([hub.consensusPrice('BTCUSDT'), hub.bars('BTCUSDT', '1d', 2), hub.book('BTCUSDT', 5), hub.universe()]);
  assert.ok(seen.length >= 8);
  for (const { url, init } of seen) {
    assert.equal(init.method, undefined, 'default GET');
    assert.deepEqual(Object.keys(init.headers), ['Accept']);
    assert.doesNotMatch(url, /account|order(?!book|_book)|trade|wallet|asset\/|private/i, url);
  }
});

await test('median handles odd, even and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
