// Worked example of the V6 research harness. Copy it for a candidate:
//   node scripts/v6/harness-example.mjs [agent]
// DEV bars only: loadBars refuses the holdout. The strategy here is a demonstration and
// is not expected to qualify.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, pointInTimeUniverse, tierFor } from '../../shared/trading/v6Bars.js';
import { auditLookahead, checkDevCriteria, trialRecord, walkForward } from '../../shared/trading/v6Sim.js';
import { defineStrategy } from '../../shared/trading/v6Strategies.js';

const agent = process.argv[2] || 'example';
const trialDir = join(dirname(fileURLToPath(import.meta.url)), '../../data/research/v6');
const FAMILY = 'example-momentum';

// 1. A strategy factory: params in, frozen strategy out. Read data only through ctx:
//    ctx.bars and ctx.ind end at t, so the future is not there to see.
const momentum = (params) => defineStrategy({
  id: 'example-momentum', name: 'Example momentum', timeframe: '1d', params, warmupBars: 100,
  universe: { kind: 'top', n: 20 },
  signals(ctx) {
    return ctx.universe.map((symbol) => ({
      strategyId: 'example-momentum', symbol, score: 0.5, exitProfile: 'trend', meta: {},
      side: ctx.ind(symbol, 'roc', ctx.params.n) > 0 ? 'long' : 'flat',
      stopDistancePct: 0.15, // a fraction; every entry needs a stop
      reason: `${ctx.params.n}d momentum`,
    }));
  },
});

// 2. Point-in-time inputs. All symbols are loaded because the top 20 changes over time,
//    and dead coins must stay in. BTC is needed by v6Risk or entries fail closed.
const bars = loadBars({ timeframe: '1d' });
const setup = { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse };

// 3. Walk-forward: parameters are picked on train windows only, and the out-of-sample
//    result is one continuous run. Extras add the 2x cost run, benchmark and plateau.
const grid = { n: [20, 30, 45, 60, 90] };
const started = performance.now();
const result = walkForward({
  ...setup, strategyFactory: momentum, grid, from: Date.UTC(2020, 0, 1), trainDays: 730, testDays: 180,
});
console.log(`walk-forward: ${((performance.now() - started) / 1000).toFixed(1)}s, ${result.picks.length} folds`);
for (const p of result.picks) {
  console.log(`  ${new Date(p.testFrom).toISOString().slice(0, 10)}  n=${p.params?.n ?? 'none (cash)'}  train score ${p.trainScore?.toFixed(2) ?? '-'}`);
}

// 4. Log every trial, failures included: D2 deflates by the count across ALL agents.
mkdirSync(trialDir, { recursive: true });
const trialFile = join(trialDir, `trials-${agent}.jsonl`);
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const logged = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
for (const trial of result.trials) {
  // Rerunning identical params is not a new trial, so it must not inflate the count.
  if (logged.has(`example-momentum|${JSON.stringify(trial.params)}`)) continue;
  const line = trialRecord({ agent, family: FAMILY, strategyId: 'example-momentum', timeframe: '1d', trial, ts: new Date().toISOString() });
  appendFileSync(trialFile, `${JSON.stringify(line)}\n`);
}

// 5. Audit, then judge. The audit reruns on cut-off data and compares bit for bit.
//    Pass `rebuild` instead of `strategy` if the strategy is built from the data.
const audit = auditLookahead({ ...setup, strategy: momentum(result.plateau?.params ?? { n: 30 }), from: Date.UTC(2023, 0, 1), cuts: 3 });
console.log(`lookahead audit: ${audit.ok ? 'clean' : `FAILED ${JSON.stringify(audit.cuts.filter((c) => !c.ok))}`}`);

const trials = readdirSync(trialDir).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(trialDir, f)));
const verdict = checkDevCriteria(result, { trials });
const s = result.summary;
console.log(`OOS: return ${(s.totalReturn * 100).toFixed(1)}%, Sharpe ${s.sharpe.toFixed(2)}, max drawdown ${(s.maxDrawdown * 100).toFixed(1)}%, ${s.closedTrades} closed trades, exposure ${(s.exposure * 100).toFixed(0)}%`);
console.log(`costs: fees ${result.oos.costs.fees.toFixed(0)}, slippage ${result.oos.costs.slippage.toFixed(0)}, stop gaps ${result.oos.costs.stopGap.toFixed(0)}, delisting ${result.oos.costs.delistHaircut.toFixed(0)}`);
console.log(verdict.report);
