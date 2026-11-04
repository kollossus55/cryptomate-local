// LOCAL CHANGE (research): walk-forward test of the legacy engine. Fetch first:
//   node scripts/walk-forward-fetch.mjs 4h   (then: node scripts/walk-forward.mjs 4h; node scripts/walk-forward-summary.mjs 4h)
// Data and results live in data/research/ (not committed).
//   node walk.mjs <interval> [variantIndex|all]
// Calendar-aligned 90-day windows (newest ends now), each with 200 bars of
// pre-window history so signals see what the live worker sees (200 candles).
// Writes results-<interval>-<variant>.json; summarise with summary.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
const { runBacktest } = await import('../shared/trading/backtest.js');

const IV = process.argv[2] || '4h';
const which = process.argv[3] ?? 'all';
const BAR = { '1h': 3600e3, '4h': 14400e3 }[IV];
const LOOK = 200, WIN_DAYS = 90;
export const VARIANTS = [
  { name: 'flat 10% (current)', takeProfitR: null },
  { name: 'TP 1.5x stop', takeProfitR: 1.5 },
  { name: 'TP 2x stop', takeProfitR: 2 },
  { name: 'TP 3x stop', takeProfitR: 3 },
];
const data = JSON.parse(readFileSync(new URL(`../data/research/candles-${IV}.json`, import.meta.url)));
const btc = data.BTCUSDT;
const first = btc[0].openTime + LOOK * BAR;
const last = btc[btc.length - 1].openTime + BAR;
const windows = [];
for (let end = last; end - WIN_DAYS * 864e5 >= first; end -= WIN_DAYS * 864e5) windows.unshift([end - WIN_DAYS * 864e5, end]);

const base = { initialCapital: 10000, minStrength: 60, stopLossPercent: 3, takeProfitPercent: 10, maxPositions: 5,
  exchange: 'okx', candleIntervalMs: BAR, warmupBars: LOOK, signalLookback: LOOK };

const list = which === 'all' ? VARIANTS.map((_, i) => i) : [Number(which)];
for (const vi of list) {
  const v = VARIANTS[vi];
  const rows = [];
  for (const [ws, we] of windows) {
    const slice = new Map();
    for (const [s, c] of Object.entries(data)) {
      if (s === 'BTCUSDT') continue;
      const i0 = c.findIndex((x) => x.openTime >= ws);
      if (i0 === -1) continue;
      const from = Math.max(0, i0 - LOOK);
      const part = c.slice(from, c.findIndex((x) => x.openTime >= we) === -1 ? c.length : c.findIndex((x) => x.openTime >= we));
      if (part.length > LOOK + 10) slice.set(s, part);
    }
    const t0 = Date.now();
    const r = runBacktest(slice, { ...base, takeProfitR: v.takeProfitR });
    const m = r.metrics || {};
    const bi0 = btc.findIndex((x) => x.openTime >= ws), bi1 = btc.findIndex((x) => x.openTime >= we);
    const btcRet = (btc[(bi1 === -1 ? btc.length : bi1) - 1].close / btc[bi0].open - 1) * 100;
    rows.push({ start: new Date(ws).toISOString().slice(0, 10), end: new Date(we).toISOString().slice(0, 10), coins: slice.size,
      trades: m.totalTrades ?? 0, winRate: m.winRate ?? null, ret: m.totalReturn ?? m.totalReturnPercent ?? 0, pf: m.profitFactor ?? null,
      dd: m.maxDrawdown ?? null, btcRet, secs: Math.round((Date.now() - t0) / 1000), error: r.error || null });
    console.log(IV, v.name, rows.at(-1).start, 'trades', rows.at(-1).trades, 'ret', rows.at(-1).ret?.toFixed?.(2), `${rows.at(-1).secs}s`);
  }
  writeFileSync(new URL(`../data/research/results-${IV}-${vi}.json`, import.meta.url), JSON.stringify({ variant: v, rows }));
}
