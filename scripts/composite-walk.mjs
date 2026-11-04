// LOCAL CHANGE (research): walk-forward study of the SP500-AI composite.
//   node scripts/composite-walk.mjs <4h|1h|1d> <variantIndex|all>
//   node scripts/composite-walk.mjs <iv> summary
// Uses runBacktest (same scoreAsset as live) with ONLY the composite enabled,
// next-bar-open fills, ATR stop (2x, 3% floor, skip >12%), OKX costs, and the
// live "bearish confluence exit" modelled by signalExitBelow.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const { runBacktest } = await import('../shared/trading/backtest.js');

const IV = process.argv[2] || '4h';
const which = process.argv[3] ?? 'all';
const BAR = { '1h': 3600e3, '4h': 14400e3, '1d': 864e5 }[IV];
const LOOK = 200, WIN_DAYS = 90;
const MEMBERS = ['ha', 'ssl', 'cmo', 'airsi', 'tmo', 'mf'];
const score = (k, n) => Math.round(5 + (90 * k) / n);   // compositeComponent's scale()

// m = voting members, enter = votes needed to buy, exitBelow = sell when votes fall below this
const V = (name, m, enter, exitBelow, tp = 10) => ({ name, m, enter, exitBelow, tp });
export const VARIANTS = [
  V('LIVE: HA only', ['ha'], 1, 1),
  V('All 6: buy 4+, sell <3', MEMBERS, 4, 3),
  V('All 6: buy 6/6, sell <3', MEMBERS, 6, 3),
  V('All 6: buy 5+, sell <4', MEMBERS, 5, 4),
  V('All 6: buy 6/6, sell <4, no TP', MEMBERS, 6, 4, 1000),
  V('All 6: buy 6/6, sell <3, no TP', MEMBERS, 6, 3, 1000),
  V('HA+SSL+CMO: 3/3, sell <2', ['ha', 'ssl', 'cmo'], 3, 2),
  V('HA+SSL+CMO: 3/3, sell <2, no TP', ['ha', 'ssl', 'cmo'], 3, 2, 1000),
  V('SSL only', ['ssl'], 1, 1),
  V('CMO only', ['cmo'], 1, 1),
  V('RSI only', ['airsi'], 1, 1),
  V('TMO only', ['tmo'], 1, 1),
  V('Money Flow only', ['mf'], 1, 1),
];

function indicatorsFor(m) {
  const ind = { rsi: false, macd: false, bollinger: false, ema: false, stoch: false, supply_demand: false, sp500ai: true };
  for (const k of MEMBERS) ind[`sp500ai_${k}`] = m.includes(k);
  return ind;
}

const file = (vi) => new URL(`../data/research/composite-${IV}-${vi}.json`, import.meta.url);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const comp = (xs) => (xs.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100;

if (which === 'summary') {
  const res = VARIANTS.map((_, i) => (existsSync(file(i)) ? JSON.parse(readFileSync(file(i))) : null)).filter(Boolean);
  const n = res[0].rows.length;
  console.log(`\nSP500-AI composite, ${IV}, ${n} windows of ${WIN_DAYS}d (${res[0].rows[0].start} .. ${res[0].rows.at(-1).end}), ${res[0].rows.at(-1).coins} coins at end\n`);
  console.log('variant'.padEnd(34), 'compound%'.padStart(10), 'win>0'.padStart(6), 'worst%'.padStart(7), 'best%'.padStart(6), 'trades'.padStart(7), 'win%'.padStart(5), 'avgDD%'.padStart(7));
  for (const r of res) {
    const rets = r.rows.map((x) => x.ret), tr = r.rows.reduce((a, x) => a + x.trades, 0);
    const wins = r.rows.reduce((a, x) => a + (x.winRate ?? 0) * x.trades / 100, 0);
    console.log(r.variant.name.padEnd(34), f(comp(rets)).padStart(10), `${rets.filter((x) => x > 0).length}/${n}`.padStart(6), f(Math.min(...rets)).padStart(7),
      f(Math.max(...rets)).padStart(6), String(tr).padStart(7), f((100 * wins) / Math.max(1, tr), 0).padStart(5), f(r.rows.reduce((a, x) => a + (x.dd ?? 0), 0) / n).padStart(7));
  }
  console.log('\nper window (BTC%, then return% per variant index):');
  console.log('start'.padEnd(11), 'BTC'.padStart(6), ...res.map((_, i) => String(i).padStart(6)));
  for (let k = 0; k < n; k++) console.log(res[0].rows[k].start.padEnd(11), f(res[0].rows[k].btcRet).padStart(6), ...res.map((r) => f(r.rows[k].ret).padStart(6)));
  // Walk-forward: from window 3 on, trade the variant with the best compounded return over earlier windows only.
  const picks = [];
  for (let k = 2; k < n; k++) {
    let best = 0;
    res.forEach((r, i) => { if (comp(r.rows.slice(0, k).map((x) => x.ret)) > comp(res[best].rows.slice(0, k).map((x) => x.ret))) best = i; });
    picks.push({ k, best });
  }
  console.log('\nwalk-forward (choose on earlier windows only):');
  for (const p of picks) console.log(`  ${res[0].rows[p.k].start}  ${res[p.best].variant.name.padEnd(34)} ${f(res[p.best].rows[p.k].ret).padStart(7)}%   live ${f(res[0].rows[p.k].ret).padStart(7)}%   BTC ${f(res[0].rows[p.k].btcRet).padStart(6)}%`);
  console.log(`  compounded: walk-forward ${f(comp(picks.map((p) => res[p.best].rows[p.k].ret)))}%  | live config ${f(comp(picks.map((p) => res[0].rows[p.k].ret)))}%  | BTC hold ${f(comp(picks.map((p) => res[0].rows[p.k].btcRet)))}%`);
  process.exit(0);
}

const data = JSON.parse(readFileSync(new URL(`../data/research/candles-${IV}.json`, import.meta.url)));
const btc = data.BTCUSDT;
const first = btc[0].openTime + LOOK * BAR, lastT = btc.at(-1).openTime + BAR;
const windows = [];
for (let end = lastT; end - WIN_DAYS * 864e5 >= first; end -= WIN_DAYS * 864e5) windows.unshift([end - WIN_DAYS * 864e5, end]);
const includeBtc = IV === '1d';   // daily set is large caps incl. BTC; intraday sets are alts only

for (const vi of which === 'all' ? VARIANTS.map((_, i) => i) : [Number(which)]) {
  const v = VARIANTS[vi], n = v.m.length;
  const cfg = { initialCapital: 10000, stopLossPercent: 3, takeProfitPercent: v.tp, maxPositions: 5, exchange: 'okx',
    candleIntervalMs: BAR, warmupBars: LOOK, signalLookback: LOOK, indicators: indicatorsFor(v.m),
    minStrength: Math.max(55, score(v.enter, n)), signalExitBelow: score(v.exitBelow, n) };
  const rows = [];
  for (const [ws, we] of windows) {
    const slice = new Map();
    for (const [s, c] of Object.entries(data)) {
      if (s === 'BTCUSDT' && !includeBtc) continue;
      const i0 = c.findIndex((x) => x.openTime >= ws);
      if (i0 === -1) continue;
      const i1 = c.findIndex((x) => x.openTime >= we);
      const part = c.slice(Math.max(0, i0 - LOOK), i1 === -1 ? c.length : i1);
      if (part.length > LOOK + 10) slice.set(s, part);
    }
    const r = runBacktest(slice, cfg);
    const m = r.metrics || {};
    const bi0 = btc.findIndex((x) => x.openTime >= ws), bi1 = btc.findIndex((x) => x.openTime >= we);
    rows.push({ start: new Date(ws).toISOString().slice(0, 10), end: new Date(we).toISOString().slice(0, 10), coins: slice.size,
      trades: m.totalTrades ?? 0, winRate: m.winRate ?? null, ret: m.totalReturn ?? m.totalReturnPercent ?? 0, dd: m.maxDrawdown ?? null,
      btcRet: (btc[(bi1 === -1 ? btc.length : bi1) - 1].close / btc[bi0].open - 1) * 100, exits: r.metrics?.exitBreakdown ?? null });
    console.log(IV, vi, v.name, rows.at(-1).start, 'trades', rows.at(-1).trades, 'ret', f(rows.at(-1).ret, 2));
  }
  writeFileSync(file(vi), JSON.stringify({ variant: v, rows }));
}
