// LOCAL CHANGE: cross-exchange gap logger (research only, places no orders).
//
// One run checks every coin on every enabled venue at the same moment and records, per coin,
// the best "buy on the cheapest venue, sell on the dearest" result for a given trade size,
// after standard taker fees. It reads public order books only; it never touches the paper
// ledger, the engine or any API key. Run every 2 minutes by the app scheduler (server/scheduler.js, job arbLogger).
//
//   node scripts/v6/arb-logger.mjs            one run, appends to data/research/arb/gaps-YYYY-MM-DD.jsonl
//   node scripts/v6/arb-logger.mjs --summary  summarise everything logged so far

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarketHub, estimateSlippage } from '../../shared/trading/v6Exchanges.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'data', 'research', 'arb');
// No end date: it runs while the app runs (about 3 MB of data a day). Remove the arbLogger job in server/scheduler.js to stop it.
const END = Infinity;

// Standard (non-VIP) spot taker fees. Withdrawal and rebalancing costs are NOT included,
// so a "net positive" gap here is an upper bound on what could be captured.
export const FEE = { binance: 0.001, okx: 0.001, bybit: 0.001, kraken: 0.004, coinbase: 0.006, kucoin: 0.001, gate: 0.002, bitget: 0.001 };
export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX', 'TRX', 'SUI', 'PEPE', 'WIF', 'TON', 'LTC', 'DOT', 'NEAR'];
export const SIZES = [1000, 5000];

async function venueQuote(hub, coin, venue) {
  try {
    const book = await hub.book(`${coin}/USDT`, 50, { venue });
    const out = { venue };
    for (const n of SIZES) {
      const buy = estimateSlippage(book, 'buy', n);
      const sell = estimateSlippage(book, 'sell', n);
      out[n] = buy.complete && sell.complete ? { buy: buy.avgPrice, sell: sell.avgPrice } : null;
    }
    return out;
  } catch {
    return null;
  }
}

export function bestGap(quotes, n) {
  let best = null;
  let positivePairs = 0;
  for (const a of quotes) for (const b of quotes) {
    if (a === b || !a[n] || !b[n]) continue;
    const gross = b[n].sell / a[n].buy - 1;
    const net = gross - FEE[a.venue] - FEE[b.venue];
    if (net > 0) positivePairs++;
    if (!best || net > best.net) best = { buy: a.venue, sell: b.venue, gross, net };
  }
  return best && { ...best, positivePairs };
}

async function runOnce() {
  if (Date.now() > END) { console.log('arb-logger: past end date, nothing to do'); return; }
  mkdirSync(OUT, { recursive: true });
  const hub = createMarketHub({});
  const t = new Date().toISOString();
  const lines = [];
  for (const coin of COINS) {
    const quotes = (await Promise.all(Object.keys(FEE).map((v) => venueQuote(hub, coin, v)))).filter(Boolean);
    const row = { t, coin, venues: quotes.length };
    for (const n of SIZES) row[n] = bestGap(quotes, n);
    lines.push(JSON.stringify(row));
  }
  appendFileSync(join(OUT, `gaps-${t.slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
}

function summary() {
  const rows = [];
  for (const f of readdirSync(OUT).filter((x) => /^gaps-.*\.jsonl$/.test(x)).sort()) {
    for (const l of readFileSync(join(OUT, f), 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
  }
  if (!rows.length) { console.log('no data yet'); return; }
  const runs = new Set(rows.map((r) => r.t)).size;
  console.log(`${runs} runs, ${rows.length} coin checks, ${rows[0].t} to ${rows.at(-1).t}`);
  for (const n of SIZES) {
    const ok = rows.filter((r) => r[n]);
    const pos = ok.filter((r) => r[n].net > 0);
    const sumNet = pos.reduce((s, r) => s + r[n].net * n, 0);
    console.log(`\n$${n}: ${pos.length} of ${ok.length} checks net-positive after taker fees; summed net if every one were caught: $${sumNet.toFixed(2)}`);
    const byCoin = {};
    for (const r of pos) (byCoin[r.coin] ??= []).push(r[n].net);
    for (const [c, v] of Object.entries(byCoin).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${c.padEnd(5)} ${String(v.length).padStart(4)} times, best ${(Math.max(...v) * 100).toFixed(3)}%`);
    }
    for (const r of [...pos].sort((a, b) => b[n].net - a[n].net).slice(0, 5)) {
      console.log(`  top: ${r.t} ${r.coin} ${r[n].buy}->${r[n].sell} gross ${(r[n].gross * 100).toFixed(3)}% net ${(r[n].net * 100).toFixed(3)}%`);
    }
  }
}

if (process.argv.includes('--summary')) summary();
else await runOnce();
