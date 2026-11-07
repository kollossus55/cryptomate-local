#!/usr/bin/env node
/**
 * Live smoke probe of the V6 market hub: BTC bars, ticker and book on every venue,
 * then the cross-venue reads. Public endpoints only, about 100 requests in total.
 *
 * Bars are reported by SHAPE only (count, timestamps, gaps). Recent bars fall in
 * the locked holdout period, so this script never prints or stores their prices.
 *
 *   node scripts/v6/exchange-probe.mjs                  3 rounds, human readable
 *   node scripts/v6/exchange-probe.mjs --rounds=1
 *   node scripts/v6/exchange-probe.mjs --json=<path>    also write the results
 */
import { writeFileSync } from 'node:fs';
import { EXCHANGES, TIMEFRAMES, createMarketHub, estimateSlippage, median } from '../../shared/trading/v6Exchanges.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const ROUNDS = Number(arg('rounds', 3));
const JSON_PATH = arg('json', null);
const SYMBOL = 'BTCUSDT';

const iso = (t) => (t === null || t === undefined ? 'none' : new Date(t).toISOString().replace('.000Z', 'Z'));

async function timed(fn) {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - start), value };
  } catch (err) {
    return { ms: Math.round(performance.now() - start), error: `${err.code ?? 'error'}: ${err.message}` };
  }
}

function barShape(r, timeframe) {
  if (r.error) return { error: r.error };
  const bars = r.value;
  const tf = TIMEFRAMES[timeframe];
  const last = bars[bars.length - 1];
  const expected = Math.floor(Date.now() / tf) * tf - tf;
  return {
    count: bars.length,
    lastOpen: iso(last?.t),
    isLatestClosed: last?.t === expected,
    onUtcGrid: bars.every((b) => b.t % tf === 0),
    ascending: bars.every((b, i) => i === 0 || b.t > bars[i - 1].t),
    gaps: bars.meta.gaps,
    stale: bars.meta.stale,
    quote: bars.meta.quote,
    ms: r.ms,
  };
}

async function probeVenue(hub, id) {
  const out = { venue: id };
  for (const tf of ['1d', '4h', '1h']) {
    out[`bars${tf}`] = barShape(await timed(() => hub.bars(SYMBOL, tf, 5, { venue: id })), tf);
  }
  const long = await timed(() => hub.bars(SYMBOL, '1d', 200, { venue: id }));
  out.bars200 = long.error ? { error: long.error } : { count: long.value.length, gaps: long.value.meta.gaps, ms: long.ms };

  const t = await timed(() => hub.ticker(SYMBOL, { venue: id }));
  out.ticker = t.error ? { error: t.error } : {
    price: t.value.price, rawPrice: t.value.rawPrice, venueQuote: t.value.venueQuote, basisAdjusted: t.value.basisAdjusted,
    spreadBps: t.value.bid ? ((t.value.ask - t.value.bid) / t.value.price) * 1e4 : null,
    ageMs: t.value.ageMs, tsKind: t.value.tsKind, stale: t.value.stale, quoteVolume24h: t.value.quoteVolume24h, ms: t.ms,
  };

  const b = await timed(() => hub.book(SYMBOL, 50, { venue: id }));
  out.book = b.error ? { error: b.error } : {
    bids: b.value.bids.length, asks: b.value.asks.length, spreadPct: b.value.spreadPct, ageMs: b.value.ageMs, stale: b.value.stale, ms: b.ms,
    slip100k: estimateSlippage(b.value, 'buy', 100e3),
  };
  return out;
}

const ids = Object.keys(EXCHANGES);
const rounds = [];
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`round ${round}/${ROUNDS}`);
  // One hub per round so figures are real round trips, not cache hits. It must be
  // ONE hub: each hub paces itself, so parallel hubs add up to a rate-limit breach.
  const hub = createMarketHub();
  rounds.push(await Promise.all(ids.map((id) => probeVenue(hub, id))));
  await new Promise((r) => setTimeout(r, 5000));
}

const med = (id, pick) => median(rounds.map((r) => pick(r.find((x) => x.venue === id))).filter(Number.isFinite));
const fmt = (x, dp = 0) => (x === null || x === undefined ? '-' : Number(x).toFixed(dp));

console.log('\nper venue, median of rounds (latest round for shape)');
const summary = ids.map((id) => {
  const last = rounds[rounds.length - 1].find((x) => x.venue === id);
  return {
    venue: id,
    barsMs: med(id, (x) => x.bars1d.ms), bars4hMs: med(id, (x) => x.bars4h.ms),
    tickerMs: med(id, (x) => x.ticker.ms), bookMs: med(id, (x) => x.book.ms),
    bars1d: last.bars1d, bars4h: last.bars4h, bars1h: last.bars1h, bars200: last.bars200, ticker: last.ticker, book: last.book,
  };
});
for (const s of summary) {
  console.log(`${s.venue.padEnd(9)} 1d ${fmt(s.barsMs).padStart(5)}ms  4h ${fmt(s.bars4hMs).padStart(5)}ms  ticker ${fmt(s.tickerMs).padStart(5)}ms  book ${fmt(s.bookMs).padStart(5)}ms`);
  for (const tf of ['1d', '4h', '1h']) {
    const b = s[`bars${tf}`];
    console.log(b.error
      ? `  ${tf} FAIL ${b.error}`
      : `  ${tf} count=${b.count} last=${b.lastOpen} latestClosed=${b.isLatestClosed} grid=${b.onUtcGrid} asc=${b.ascending} gaps=${b.gaps} stale=${b.stale} quote=${b.quote}`);
  }
  console.log(s.bars200.error ? `  200 bars FAIL ${s.bars200.error}` : `  200 bars count=${s.bars200.count} gaps=${s.bars200.gaps} ${s.bars200.ms}ms`);
  console.log(s.ticker.error
    ? `  ticker FAIL ${s.ticker.error}`
    : `  ticker price=${fmt(s.ticker.price, 2)} raw=${fmt(s.ticker.rawPrice, 2)} ${s.ticker.venueQuote} adjusted=${s.ticker.basisAdjusted} spread=${fmt(s.ticker.spreadBps, 3)}bps age=${s.ticker.ageMs ?? 'n/a'}ms ts=${s.ticker.tsKind} vol24h=$${fmt((s.ticker.quoteVolume24h ?? 0) / 1e6, 0)}M`);
  console.log(s.book.error
    ? `  book FAIL ${s.book.error}`
    : `  book levels=${s.book.bids}/${s.book.asks} spread=${fmt(s.book.spreadPct, 5)}% age=${s.book.ageMs ?? 'n/a'}ms buy$100k: slip=${fmt(s.book.slip100k.slippagePct, 4)}% complete=${s.book.slip100k.complete}`);
}

console.log('\ncross-venue');
const hub = createMarketHub();
const basis = await timed(() => hub.usdtBasis());
console.log('basis', JSON.stringify(basis.value ?? basis.error), `${basis.ms}ms`);

const consensus = {};
for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'BTCUSD']) {
  const r = await timed(() => hub.consensusPrice(symbol));
  const c = r.value;
  consensus[symbol] = c ? {
    ok: c.ok, reason: c.reason, price: c.price, venues: c.venues.length, spreadPct: c.spreadPct, rawSpreadPct: c.rawSpreadPct,
    outliers: c.outliers, excluded: c.excluded.map((e) => `${e.venue}:${e.reason}`), ms: r.ms,
  } : { error: r.error };
  console.log(symbol, JSON.stringify(consensus[symbol]));
}

const uni = await timed(() => hub.universe({ topN: 40, minQuoteVolume: 5e6 }));
let universe = null;
if (uni.error) console.log('universe FAIL', uni.error);
else {
  universe = {
    ms: uni.ms, meta: uni.value.meta,
    rows: uni.value.map((r) => ({ symbol: r.symbol, volM: Math.round(r.quoteVolume / 1e6), venues: r.venues.length, conflict: r.priceConflict, dropped: r.droppedVenues })),
  };
  console.log(`universe ${uni.ms}ms venues=${uni.value.meta.venues.length} failed=${JSON.stringify(uni.value.meta.failed)} excluded=${JSON.stringify(uni.value.meta.excluded)}`);
  for (const r of universe.rows) console.log(`  ${r.symbol.padEnd(14)} $${String(r.volM).padStart(6)}M  venues=${r.venues}${r.conflict ? `  conflict, dropped ${r.dropped}` : ''}`);
  const single = await hub.universe({ topN: 40, minQuoteVolume: 5e6, minVenues: 1 });
  console.log(`with minVenues=1 the top 40 would add: ${single.filter((r) => r.venues.length === 1).map((r) => `${r.base}(${r.venues[0]})`).join(' ') || 'nothing'}`);
}

console.log('\nhealth');
const health = hub.health();
for (const h of health) console.log(`  ${h.venue.padEnd(9)} ok=${h.ok} breaker=${h.breaker} latency=${h.latencyMs}ms status=${h.status} requests=${h.requests} failures=${h.failures} rateLimited=${h.rateLimited}${h.lastError ? ` last=${h.lastError}` : ''}`);

if (JSON_PATH) {
  writeFileSync(JSON_PATH, JSON.stringify({ at: new Date().toISOString(), summary, basis: basis.value, consensus, universe, health }, null, 2));
  console.log(`\nwrote ${JSON_PATH}`);
}

const failures = summary.flatMap((s) => ['bars1d', 'bars4h', 'bars1h', 'bars200', 'ticker', 'book'].filter((k) => s[k].error).map((k) => `${s.venue}.${k}`));
console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nall venues answered bars, ticker and book');
process.exit(failures.length ? 1 : 0);
