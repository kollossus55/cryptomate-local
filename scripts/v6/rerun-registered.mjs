// Re-measures the registered research runs on the fixed harness:
//   node scripts/v6/rerun-registered.mjs [--only r-xsmom,r-trend] [--list] [--finalize] [--fresh]
//
// Each family's script runs unchanged, with file access redirected, so:
//   - nothing is added to data/research/v6/trials-*.jsonl: these are re-measurements of
//     trials already counted, not new trials. Their lines go to data/research/v6/remeasure/
//     tagged remeasure: true, in a folder the trial readers do not scan.
//   - each script's data/tmp/<agent>/ becomes data/tmp/remeasure/<agent>/, so resumable
//     scripts start clean and the original results stay untouched.
//   - any other write throws.
// At most 3 processes run at once. A finished task is skipped on resume; --fresh starts over.
//
// D2 is computed by the finalize step alone, for every run, from the complete trial set,
// so a verdict does not depend on the order runs happened in. D1-D8 thresholds are the
// frozen ones. Outputs: data/research/v6/remeasure/verdicts.jsonl and report.txt.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflatedSharpe, trialStats } from '../../shared/trading/v6Stats.js';

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '../..');
const slash = (p) => resolve(String(p)).replace(/\\/g, '/');
const ROOT = slash(root);
const TRIALS = `${ROOT}/data/research/v6`;
const OUT = `${TRIALS}/remeasure`;
const TMP = `${ROOT}/data/tmp/remeasure`;
const MAX_WORKERS = 3;
const D2_FLOOR = 0.90;

/** Every command that produced a logged trial or a verdict, in each family's own order. */
const FAMILIES = {
  'r-breakout': [['run', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'], ['reserve']],
  'r-carry': [['carry'], ['overlay']],
  'r-exits': [['job', 'random:1'], ['job', 'random:2'], ['job', 'random:3'], ['job', 'random:4'], ['job', 'random:5'], ['job', 'breakout'], ['job', 'dip']],
  'r-regime': [['run', '0', '1'], ['finalize']],
  'r-revert': [['E1'], ['E2'], ['E3'], ['E4'], ['E5'], ['E6'], ['reserve', 'E2']],
  'r-risk': [['sweep'], ['study'], ['wf']],
  'r-trend': ['btc', 'btceth', 'top10'].flatMap((u) => [['wf', u], ['side', u], ['matched', u]]),
  'r-xsmom': [['stage1'], ['stage2']],
};

const taskName = (agent, args) => `${agent} ${args.join(' ')}`;
const fileSafe = (name) => name.replace(/[^\w.-]+/g, '_');

// ---------- child: redirect file access, then let the family script run ----------

function installRedirects(agent, task) {
  const real = { ...fs };
  const trialPath = (p) => /\/data\/research\/v6\/trials-[^/]*\.jsonl$/.test(slash(p));
  const moved = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return p;
    const s = slash(p instanceof URL ? fileURLToPath(p) : p);
    const m = s.match(/\/data\/tmp\/(r-[^/]+)(\/.*)?$/);
    return m ? `${TMP}/${m[1]}${m[2] ?? ''}` : p;
  };
  const writable = (p) => {
    const s = slash(p);
    if (!s.startsWith(`${TMP}/`) && !s.startsWith(`${OUT}/`)) throw new Error(`rerun-registered: refused a write outside the remeasure folders: ${s}`);
    return s;
  };
  fs.existsSync = (p) => (trialPath(p) ? false : real.existsSync(moved(p))); // an empty log, so nothing is skipped as already logged
  fs.readFileSync = (p, ...a) => real.readFileSync(moved(p), ...a);
  fs.readdirSync = (p, ...a) => real.readdirSync(moved(p), ...a);
  fs.mkdirSync = (p, ...a) => real.mkdirSync(moved(p), ...a);
  fs.writeFileSync = (p, ...a) => real.writeFileSync(writable(moved(p)), ...a);
  fs.appendFileSync = (p, data, ...a) => {
    if (!trialPath(p)) return real.appendFileSync(writable(moved(p)), data, ...a);
    const lines = String(data).split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), remeasure: true, task }));
    return real.appendFileSync(`${OUT}/trials-${agent}.jsonl`, `${lines.join('\n')}\n`);
  };
  syncBuiltinESMExports();
  const sink = `${OUT}/oos-${agent}.jsonl`;
  globalThis.__v6CriteriaSink = (rec) => real.appendFileSync(sink, `${JSON.stringify({ agent, task, ...rec })}\n`);
}

if (process.env.V6_REMEASURE_AGENT) installRedirects(process.env.V6_REMEASURE_AGENT, process.env.V6_REMEASURE_TASK);

// ---------- finalize: D2 from the whole trial set, then the verdicts ----------

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const trialKey = (agent, l) => `${agent}|${l.strategyId}|${JSON.stringify(l.params)}`;

function finalize() {
  const files = fs.readdirSync(TRIALS).filter((f) => /^trials-.*\.jsonl$/.test(f) && f !== 'trials-example.jsonl').sort();
  const oos = fs.readdirSync(OUT).filter((f) => /^oos-.*\.jsonl$/.test(f)).sort().flatMap((f) => readLines(`${OUT}/${f}`));

  // Measurements of each logged trial. Logged lines define WHICH trials exist. The same
  // params can be several trials told apart by note (reserve runs), so the note is tried
  // first. Without one, repeats are averaged: r-exits logs the mean over its seeds.
  const fresh = new Map();
  const add = (key, t) => {
    const row = fresh.get(key) ?? { sharpes: [], simReEnables: undefined };
    if (Number.isFinite(t.sharpe)) row.sharpes.push(t.sharpe);
    if (t.simReEnables !== undefined) row.simReEnables = Math.max(row.simReEnables ?? 0, t.simReEnables);
    fresh.set(key, row);
  };
  for (const f of fs.readdirSync(OUT).filter((x) => /^trials-.*\.jsonl$/.test(x)).sort()) {
    for (const l of readLines(`${OUT}/${f}`)) {
      add(`${trialKey(l.agent, l)}|${l.note}`, l);
      add(trialKey(l.agent, l), l);
    }
  }
  for (const r of oos) for (const t of r.trials) add(trialKey(r.agent, { strategyId: r.strategy?.id, params: t.params }), t);
  const logged = files.flatMap((f) => readLines(`${TRIALS}/${f}`));
  let matched = 0, frozen = 0, untracked = 0;
  const perAgent = {};
  const finalSet = logged.map((l) => {
    const found = fresh.get(`${trialKey(l.agent, l)}|${l.note}`) ?? fresh.get(trialKey(l.agent, l));
    const now = found?.sharpes.length ? { sharpe: found.sharpes.reduce((a, x) => a + x, 0) / found.sharpes.length, simReEnables: found.simReEnables } : null;
    const row = perAgent[l.agent] ??= { logged: 0, remeasured: 0, frozen: 0, moved: 0, sharpeShift: 0 };
    row.logged++;
    if (!now) return l;
    matched++;
    row.remeasured++;
    if (now.simReEnables > 0) { frozen++; row.frozen++; }
    if (now.simReEnables === undefined) untracked++;
    const shift = Math.abs(now.sharpe - l.sharpe);
    if (shift > 0.01) row.moved++;
    row.sharpeShift = Math.max(row.sharpeShift, shift);
    return { ...l, sharpe: now.sharpe };
  });

  const verdicts = oos.map((r) => {
    const { trialCount, trialSRVariance } = trialStats(finalSet, r.periodsPerYear);
    const dsr = trialSRVariance > 0 ? deflatedSharpe(r.rets, trialCount, trialSRVariance) : null;
    const d2 = dsr !== null && dsr >= D2_FLOOR;
    const others = Object.entries(r.criteria).filter(([id]) => id !== 'D2');
    const s = r.summary;
    return {
      agent: r.agent, task: r.task, strategy: r.strategy?.id ?? null, sharpe: s.sharpe, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn,
      closedTrades: s.closedTrades, simReEnables: s.simReEnables, regimeExits: s.regimeExits, regimeExitPnl: s.regimeExitPnl, stuckAtEnd: s.stuckAtEnd,
      dsr, trialCount, pass: d2 && others.every(([, c]) => c.pass),
      failed: [...others.filter(([, c]) => !c.pass).map(([id]) => id), ...(d2 ? [] : ['D2'])].sort(),
    };
  }).sort((a, b) => `${a.agent}|${a.task}|${a.strategy}`.localeCompare(`${b.agent}|${b.task}|${b.strategy}`));
  fs.writeFileSync(`${OUT}/verdicts.jsonl`, verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');

  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
  const report = [
    `Harness re-measurement. Not new trials. D2 uses all ${logged.length} logged trials (example excluded); ${matched} re-measured, ${frozen} of those needed a simulated re-enable, meaning the old harness froze them; ${untracked} do not report re-enables, so that count is a floor.`,
    '', 'agent         logged  re-measured  frozen  sharpe moved >0.01  largest shift',
    ...Object.entries(perAgent).sort().map(([a, r]) => `${a.padEnd(13)} ${String(r.logged).padStart(6)}  ${String(r.remeasured).padStart(11)}  ${String(r.frozen).padStart(6)}  ${String(r.moved).padStart(18)}  ${r.sharpeShift.toFixed(2)}`),
    '', 'OOS runs:',
    ...verdicts.map((v) => `${v.pass ? 'PASS' : 'FAIL'}  ${v.task.padEnd(26)} ${String(v.strategy).padEnd(20)} Sharpe ${v.sharpe?.toFixed(2)}  DD ${pct(v.maxDrawdown)}  ret ${pct(v.totalReturn)}  trades ${v.closedTrades}  DSR ${v.dsr?.toFixed(3) ?? 'n/a'}  re-enables ${v.simReEnables}  regime exits ${v.regimeExits}${v.stuckAtEnd ? `  STUCK ${v.stuckAtEnd.name}` : ''}  failed ${v.failed.join(',') || '-'}`),
  ].join('\n');
  fs.writeFileSync(`${OUT}/report.txt`, `${report}\n`);
  console.log(report);
}

// ---------- orchestrator ----------

function runTask(agent, args) {
  const task = taskName(agent, args);
  const log = join(TMP, 'logs', `${fileSafe(task)}.log`);
  return new Promise((done) => {
    const out = fs.openSync(log, 'w');
    const child = spawn(process.execPath, ['--import', pathToFileURL(self).href, join(root, 'scripts/v6/research', `${agent}.mjs`), ...args], {
      cwd: root, stdio: ['ignore', out, out], env: { ...process.env, V6_REMEASURE_AGENT: agent, V6_REMEASURE_TASK: task },
    });
    child.on('close', (code) => { fs.closeSync(out); done(code); });
  });
}

async function main() {
  const flags = process.argv.slice(2);
  const onlyAt = flags.indexOf('--only');
  const only = onlyAt >= 0 ? flags[onlyAt + 1].split(',') : Object.keys(FAMILIES);
  for (const a of only) if (!FAMILIES[a]) throw new Error(`Unknown family ${a}`);
  if (flags.includes('--list')) {
    for (const a of only) for (const args of FAMILIES[a]) console.log(taskName(a, args));
    return;
  }
  if (flags.includes('--finalize')) return finalize();
  if (flags.includes('--fresh')) for (const dir of [OUT, TMP]) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of [OUT, join(TMP, 'logs'), join(TMP, 'done')]) fs.mkdirSync(dir, { recursive: true });

  // A family's tasks run in order, because later stages read earlier ones.
  const queues = only.map((agent) => ({ agent, tasks: [...FAMILIES[agent]] }));
  const failures = [];
  const worker = async () => {
    for (;;) {
      const q = queues.find((x) => x.tasks.length && !x.busy);
      if (!q) return;
      q.busy = true;
      while (q.tasks.length) {
        const args = q.tasks.shift();
        const task = taskName(q.agent, args);
        const mark = join(TMP, 'done', `${fileSafe(task)}.ok`);
        if (fs.existsSync(mark)) continue;
        const started = Date.now();
        console.log(`start ${task}`);
        const code = await runTask(q.agent, args);
        console.log(`${code === 0 ? 'done ' : 'FAILED'} ${task} (${((Date.now() - started) / 60000).toFixed(1)} min)`);
        if (code === 0) fs.writeFileSync(mark, '');
        else failures.push(task);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_WORKERS, queues.length) }, worker));
  finalize();
  if (failures.length) { console.error(`Failed: ${failures.join('; ')}`); process.exit(1); }
}

if (!process.env.V6_REMEASURE_AGENT && process.argv[1] && slash(process.argv[1]) === slash(self)) await main();
