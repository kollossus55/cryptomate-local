// LOCAL CHANGE (research): cache daily candles for liquid large-cap coins since 2020.
//   node scripts/trend-fetch.mjs      -> data/research/candles-1d.json
import { writeFileSync, mkdirSync } from 'node:fs';
const { fetchHistoricalCandles } = await import('../shared/trading/marketData.js');
mkdirSync(new URL('../data/research/', import.meta.url), { recursive: true });

// Large caps that were already big and liquid in 2020-21 (limits, but does not remove, survivorship bias).
export const MAJORS = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'DOGE', 'ADA', 'LINK', 'AVAX', 'LTC',
  'TRX', 'DOT', 'BCH', 'XLM', 'UNI', 'ATOM', 'ETC', 'FIL', 'NEAR', 'AAVE'];
const start = Date.UTC(2020, 0, 1), end = Date.now();
const out = {};
for (const b of MAJORS) {
  const s = `${b}USDT`;
  try {
    const c = (await fetchHistoricalCandles(s, '1d', start, end)).sort((a, z) => a.openTime - z.openTime);
    if (c.length > 250) out[s] = c;
    console.log(s, c.length, c[0] ? new Date(c[0].openTime).toISOString().slice(0, 10) : '-');
  } catch (e) { console.log(s, 'failed', e.message); }
}
writeFileSync(new URL('../data/research/candles-1d.json', import.meta.url), JSON.stringify(out));
console.log('saved', Object.keys(out).length);
