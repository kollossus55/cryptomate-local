#!/usr/bin/env node
/**
 * Builds the table check 6 and check 7 read: per strategy, symbol and side, the DEV-period
 * expectancy net of costs. The engine reads this small file so the live path never loads
 * the research store.
 *
 *   node scripts/v6/build-signal-history.mjs
 *   node scripts/v6/build-signal-history.mjs --module=scripts/v6/research/x.mjs
 *   node scripts/v6/build-signal-history.mjs --reference=btcAboveSma --out=data/tmp/me/table.json
 *
 * Strategies come from STRATEGIES, plus --module (a file exporting `strategies`) and
 * --reference (a name in REFERENCE_STRATEGIES). A strategy whose hash is already in the
 * table is skipped, so a rerun resumes. --force rebuilds.
 *
 * DEV only: it reads through loadBars up to DEV_END and refuses to run with the holdout
 * unlocked. Each coin's result must not depend on what else the portfolio held, so it runs
 * at a small fixed weight rather than through the risk engine's limits. These are per-trade
 * figures, not portfolio results.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEV_END, listSymbols, loadBars, pointInTimeUniverse, tierFor } from '../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../shared/trading/v6Core.js';
import { HISTORY_FORMAT, buildHistoryEntry, emptyHistoryTable, strategyHash } from '../../shared/trading/v6SignalGate.js';
import { runSim } from '../../shared/trading/v6Sim.js';
import { REFERENCE_STRATEGIES, STRATEGIES } from '../../shared/trading/v6Strategies.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WEIGHT = 0.02;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const out = resolve(ROOT, args.out || 'data/v6/signal-history.json');

if (process.env.V6_HOLDOUT_UNLOCK) {
  console.error('Refusing to run with V6_HOLDOUT_UNLOCK set: this table must come from DEV data only.');
  process.exit(1);
}

const strategies = [...STRATEGIES];
if (args.reference) {
  const make = REFERENCE_STRATEGIES[args.reference];
  if (!make) throw new Error(`No reference strategy ${args.reference}`);
  strategies.push(make());
}
if (args.module) {
  const mod = await import(pathToFileURL(resolve(ROOT, args.module)).href);
  if (!Array.isArray(mod.strategies)) throw new Error(`${args.module} does not export strategies`);
  strategies.push(...mod.strategies);
}

function save(table) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(table));
  renameSync(`${out}.tmp`, out);
}

const stored = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
const table = stored?.format === HISTORY_FORMAT ? stored : emptyHistoryTable({ generatedAt: Date.now() });
table.generated_at = Date.now();

if (!strategies.length) console.log('No strategies to process. STRATEGIES is empty, so the table stays empty and check 6 blocks every entry.');

for (const strategy of strategies) {
  if (strategy.perp) throw new Error(`${strategy.id} is a perp strategy: this script has no funding data yet`);
  const hash = strategyHash(strategy);
  if (!args.force && table.strategies[strategy.id]?.hash === hash) {
    console.log(`${strategy.id}: already built, skipping`);
    continue;
  }
  const started = performance.now();
  const symbols = strategy.universe.kind === 'fixed'
    ? [...new Set([...strategy.universe.symbols, 'BTCUSDT'])]
    : listSymbols({ timeframe: strategy.timeframe });
  console.log(`${strategy.id}: loading ${symbols.length} symbols`);
  const bars = loadBars({ symbols, timeframe: strategy.timeframe, to: DEV_END });
  const result = runSim({
    strategies: [strategy], bars, to: DEV_END, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse,
    // closeOut off: a forced sale at the end of the data is not an outcome of the signal.
    modules: { risk: fullWeightRisk({ weight: WEIGHT }) }, collectEvents: false, closeOut: false,
  });
  table.strategies[strategy.id] = buildHistoryEntry({ strategy, trades: result.trades });
  save(table);
  const count = Object.keys(table.strategies[strategy.id].symbols).length;
  console.log(`${strategy.id}: ${result.trades.length} trade rows across ${count} symbols, ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

save(table);
console.log(`Wrote ${out}: ${Object.keys(table.strategies).length} strategies`);
