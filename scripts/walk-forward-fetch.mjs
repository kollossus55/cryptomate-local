// Cache ~900 days of candles for today's top 40 crypto alts + BTC, per interval.
// Usage: node fetch.mjs 4h | 1h
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../data/research/', import.meta.url), { recursive: true });
const { fetchUniverse, fetchHistoricalCandles } = await import('../shared/trading/marketData.js');
const IV = process.argv[2] || '4h';
const DAYS = 900, TOP = 40;
const universe = await fetchUniverse({ topN: TOP + 5, minQuoteVolume24h: 400_000 });
const symbols = ['BTCUSDT', ...universe.map((u) => u.symbol).filter((s) => s !== 'BTCUSDT').slice(0, TOP)];
const end = Date.now(), start = end - DAYS * 86400e3;
const out = {};
let i = 0;
async function worker() {
  while (i < symbols.length) {
    const s = symbols[i++];
    try {
      const c = await fetchHistoricalCandles(s, IV, start, end);
      if (c.length > 300) out[s] = c;
      console.log(`${s} ${c.length} bars from ${c[0] ? new Date(c[0].openTime).toISOString().slice(0, 10) : '-'}`);
    } catch (e) { console.log(`${s} failed: ${e.message}`); }
  }
}
await Promise.all([worker(), worker()]);
writeFileSync(new URL(`../data/research/candles-${IV}.json`, import.meta.url), JSON.stringify(out));
console.log('saved', IV, Object.keys(out).length, 'symbols');
