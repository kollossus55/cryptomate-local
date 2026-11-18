// LOCAL CHANGE (research): daily trend-following vs buy-and-hold, walk-forward.
//   node scripts/trend-fetch.mjs  (once)   then   node scripts/trend-test.mjs
// Honesty rules: signal from the previous day's close, trade at the next day's
// open, 0.10% fee + 0.05% slippage per side on every traded dollar, a coin is
// only eligible once it has 200 days of history, no leverage, no shorting.
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('../data/research/candles-1d.json', import.meta.url)));
const DAY = 864e5, COST = 0.0015, WARM = 200, WIN_DAYS = 90, DRIFT = 0.25;

const days = data.BTCUSDT.map((c) => c.openTime);
const coins = Object.keys(data);
const idx = {};             // symbol -> Map(openTime -> candle index)
for (const s of coins) idx[s] = new Map(data[s].map((c, i) => [c.openTime, i]));

const closeAt = (s, i) => data[s][i].close;
function sma(s, i, n) { let a = 0; for (let k = i - n + 1; k <= i; k++) a += data[s][k].close; return a / n; }
// signal on candle index i (the last *closed* candle)
const SIG = {
  hold: () => true,
  sma: (n) => (s, i) => i >= n - 1 && closeAt(s, i) > sma(s, i, n),
  mom: (n) => (s, i) => i >= n && closeAt(s, i) > closeAt(s, i - n),
};

export const STRATS = [
  { name: 'BTC buy & hold', uni: ['BTCUSDT'], sig: SIG.hold },
  { name: 'Basket buy & hold', uni: coins, sig: SIG.hold },
  { name: 'BTC > 50d avg', uni: ['BTCUSDT'], sig: SIG.sma(50) },
  { name: 'BTC > 100d avg', uni: ['BTCUSDT'], sig: SIG.sma(100) },
  { name: 'BTC > 200d avg', uni: ['BTCUSDT'], sig: SIG.sma(200) },
  { name: 'BTC+ETH > 100d avg', uni: ['BTCUSDT', 'ETHUSDT'], sig: SIG.sma(100) },
  { name: 'Basket > 50d avg', uni: coins, sig: SIG.sma(50) },
  { name: 'Basket > 100d avg', uni: coins, sig: SIG.sma(100) },
  { name: 'Basket > 200d avg', uni: coins, sig: SIG.sma(200) },
  { name: 'Basket 30d mom', uni: coins, sig: SIG.mom(30) },
  { name: 'Basket 90d mom', uni: coins, sig: SIG.mom(90) },
  { name: 'Basket >100d & BTC>100d', uni: coins, sig: SIG.sma(100), btcGate: SIG.sma(100) },
];

function run(st) {
  const start = WARM;                       // first tradable BTC day
  const hold = {};                          // symbol -> units
  let cash = 10000, trades = 0, inMkt = 0, fees = 0;
  const eq = [];                            // equity at each day's open, from `start`
  for (let d = start; d < days.length; d++) {
    const t = days[d];
    const priceOpen = (s) => { const i = idx[s].get(t); return i === undefined ? null : data[s][i].open; };
    // value at open
    let value = cash;
    for (const [s, u] of Object.entries(hold)) { const p = priceOpen(s); if (p) value += u * p; }
    eq.push({ t, value });
    // targets from yesterday's close
    const bi = idx.BTCUSDT.get(days[d - 1]);
    const gateOn = !st.btcGate || st.btcGate('BTCUSDT', bi);
    const eligible = st.uni.filter((s) => { const i = idx[s].get(days[d - 1]); return i !== undefined && i >= WARM - 1 && priceOpen(s); });
    const on = eligible.filter((s) => { const i = idx[s].get(days[d - 1]); return (s === 'BTCUSDT' || gateOn) && st.sig(s, i); });
    const w = eligible.length ? 1 / eligible.length : 0;
    if (on.length) inMkt++;
    // rebalance: exit coins switched off, enter coins switched on, trim/top-up only past the drift band
    const sells = [], buys = [];
    for (const s of new Set([...Object.keys(hold), ...on])) {
      const p = priceOpen(s); if (!p) continue;
      const cur = (hold[s] || 0) * p, tgt = on.includes(s) ? w * value : 0;
      const changed = (cur > 0) !== (tgt > 0);
      if (!changed && Math.abs(cur - tgt) < DRIFT * tgt) continue;
      (tgt < cur ? sells : buys).push([s, p, tgt - cur, changed]);
    }
    for (const [s, p, diff, changed] of [...sells, ...buys]) {
      let amt = diff;
      if (amt > 0) amt = Math.min(amt, cash / (1 + COST));
      if (Math.abs(amt) < 1) continue;
      const fee = Math.abs(amt) * COST;
      hold[s] = (hold[s] || 0) + amt / p; cash -= amt + fee; fees += fee;
      if (changed) trades++;
      if (hold[s] * p < 1) delete hold[s];
    }
  }
  return { eq, trades, fees, timeInMarket: inMkt / (days.length - start) };
}

// ---------- reporting ----------
const results = STRATS.map((st) => ({ st, ...run(st) }));
const eq0 = results[0].eq;
const last = eq0.length - 1;
const windows = [];
for (let e = last; e - WIN_DAYS >= 0; e -= WIN_DAYS) windows.unshift([e - WIN_DAYS, e]);
const winRet = (r, [a, b]) => (r.eq[b].value / r.eq[a].value - 1) * 100;
const maxDD = (eq) => { let pk = 0, dd = 0; for (const { value } of eq) { pk = Math.max(pk, value); dd = Math.min(dd, value / pk - 1); } return dd * 100; };
const f = (v, d = 1) => v.toFixed(d);
const yrs = (eq0[last].t - eq0[0].t) / (365.25 * DAY);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

console.log(`\nDaily trend test ${iso(eq0[0].t)} .. ${iso(eq0[last].t)} (${f(yrs, 1)} yrs, ${windows.length} windows of ${WIN_DAYS}d), ${coins.length} coins\n`);
console.log('strategy'.padEnd(26), 'total%'.padStart(9), 'CAGR%'.padStart(7), 'maxDD%'.padStart(7), 'win>0'.padStart(6), 'beatBTC'.padStart(8), 'worst%'.padStart(7), 'inMkt'.padStart(6), 'trades'.padStart(7));
for (const r of results) {
  const wr = windows.map((w) => winRet(r, w));
  const bw = windows.map((w) => winRet(results[0], w));
  const tot = r.eq[last].value / r.eq[0].value;
  r.wr = wr;
  console.log(r.st.name.padEnd(26), f((tot - 1) * 100, 0).padStart(9), f((tot ** (1 / yrs) - 1) * 100).padStart(7), f(maxDD(r.eq)).padStart(7),
    `${wr.filter((x) => x > 0).length}/${wr.length}`.padStart(6), `${wr.filter((x, k) => x > bw[k]).length}/${wr.length}`.padStart(8),
    f(Math.min(...wr)).padStart(7), `${f(r.timeInMarket * 100, 0)}%`.padStart(6), String(r.trades).padStart(7));
}

console.log('\nper-window return % (BTC hold | basket hold | best rules)');
const show = [0, 1, 3, 5, 7, 11];
console.log('window'.padEnd(12), ...show.map((i) => results[i].st.name.slice(0, 14).padStart(15)));
windows.forEach((w, k) => console.log(iso(results[0].eq[w[0]].t).padEnd(12), ...show.map((i) => f(results[i].wr[k]).padStart(15))));

// Walk-forward: among the rule-based strategies (index >= 2), pick the one with the best
// compounded return over all earlier windows; never looks at the window being traded.
const cand = results.map((_, i) => i).filter((i) => i >= 2);
const comp = (xs) => xs.reduce((a, x) => a * (1 + x / 100), 1);
const picks = [];
for (let k = 4; k < windows.length; k++) {
  const best = cand.reduce((b, i) => (comp(results[i].wr.slice(0, k)) > comp(results[b].wr.slice(0, k)) ? i : b), cand[0]);
  picks.push({ k, best });
}
const wf = picks.map((p) => results[p.best].wr[p.k]), bh = picks.map((p) => results[0].wr[p.k]), bb = picks.map((p) => results[1].wr[p.k]);
const pickCount = {}; picks.forEach((p) => (pickCount[results[p.best].st.name] = (pickCount[results[p.best].st.name] || 0) + 1));
console.log(`\nwalk-forward from ${iso(results[0].eq[windows[4][0]].t)} (choose on earlier windows only):`);
console.log('  picked:', Object.entries(pickCount).map(([n, c]) => `${n} x${c}`).join(', '));
console.log(`  compounded: walk-forward ${f((comp(wf) - 1) * 100, 0)}%  | BTC hold ${f((comp(bh) - 1) * 100, 0)}%  | basket hold ${f((comp(bb) - 1) * 100, 0)}%`);
console.log(`  worst window: walk-forward ${f(Math.min(...wf))}%  | BTC hold ${f(Math.min(...bh))}%  | basket hold ${f(Math.min(...bb))}%`);

// Sub-periods: is the edge just the 2020-21 bull run?
const sub = (r, a, b) => { const e = r.eq.slice(windows[a][0], windows[b - 1][1] + 1); return { ret: (e.at(-1).value / e[0].value - 1) * 100, dd: maxDD(e) }; };
const periods = [[4, windows.length, 'since ' + iso(results[0].eq[windows[4][0]].t)], [windows.length - 9, windows.length, 'last 9 windows (legacy test span)']];
for (const [a, b, label] of periods) {
  console.log(`\n${label}:  return% / maxDD%`);
  for (const r of results) { const x = sub(r, a, b); console.log('  ' + r.st.name.padEnd(26), f(x.ret, 0).padStart(6), f(x.dd).padStart(7)); }
}
