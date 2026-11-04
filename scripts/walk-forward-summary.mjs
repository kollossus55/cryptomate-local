// Summarise walk-forward results:  node summary.mjs <interval>
import { readFileSync } from 'node:fs';
const IV = process.argv[2] || '4h';
const res = [0, 1, 2, 3].map((i) => JSON.parse(readFileSync(new URL(`../data/research/results-${IV}-${i}.json`, import.meta.url))));
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const n = res[0].rows.length;

console.log(`\n${IV}: ${n} windows of 90 days. Return % per window (trades, win%)\n`);
console.log('window'.padEnd(24), 'coins', 'BTC%'.padStart(6), ...res.map((r) => r.variant.name.padStart(22)));
for (let k = 0; k < n; k++) {
  const w = res[0].rows[k];
  console.log(`${w.start}..${w.end}`.padEnd(24), String(w.coins).padStart(5), f(w.btcRet).padStart(6),
    ...res.map((r) => `${f(r.rows[k].ret).padStart(7)} (${String(r.rows[k].trades).padStart(3)}, ${f(r.rows[k].winRate, 0).padStart(2)}%)`.padStart(22)));
}
const comp = (rets) => (rets.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100;
console.log('\ncompounded, all windows'.padEnd(37), ...res.map((r) => f(comp(r.rows.map((x) => x.ret))).padStart(22)));
console.log('windows positive'.padEnd(37), ...res.map((r) => `${r.rows.filter((x) => x.ret > 0).length}/${n}`.padStart(22)));
console.log('worst window'.padEnd(37), ...res.map((r) => f(Math.min(...r.rows.map((x) => x.ret))).padStart(22)));

// Walk-forward selection: in window k (k >= 2) use the variant with the best
// summed return over windows 0..k-1. Never looks at window k itself.
const picks = [];
for (let k = 2; k < n; k++) {
  let best = 0, bestSum = -Infinity;
  res.forEach((r, i) => { const s = r.rows.slice(0, k).reduce((a, x) => a + x.ret, 0); if (s > bestSum) { bestSum = s; best = i; } });
  picks.push({ k, best, ret: res[best].rows[k].ret, base: res[0].rows[k].ret });
}
console.log('\nwalk-forward (choose on earlier windows only), windows 3..' + n);
for (const p of picks) console.log(`  ${res[0].rows[p.k].start}  chose ${res[p.best].variant.name.padEnd(20)} ${f(p.ret).padStart(7)}%   vs current ${f(p.base).padStart(7)}%`);
console.log(`  compounded: walk-forward ${f(comp(picks.map((p) => p.ret)))}%  vs current ${f(comp(picks.map((p) => p.base)))}%`);
