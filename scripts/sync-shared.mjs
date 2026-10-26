#!/usr/bin/env node
/**
 * Regenerates the function directories' copies of /shared/trading.
 *
 * Every trading function imports its own copy of the trading library
 * (base44/functions/<name>/shared/*.js), because Deno-style functions are
 * normally self-contained folders that get copied over from Base44 as a unit.
 * The copies are GENERATED — editing one directly creates divergence, which is
 * exactly how the old code drifted. This script brings them back in line.
 *
 * The script itself was recreated 2026-10-26 (the original was lost in the
 * port) after the generated copies had drifted by blank lines alone — which is
 * another reason to regenerate rather than hand-patch copies.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'shared', 'trading');

const FUNCTION_DIRS = ['autoTradingWorker', 'altcoinScannerWorker', 'technicalAnalysis'];

const header =
  '// GENERATED FILE — DO NOT EDIT.\n' +
  '// Copied from /shared/trading by scripts/sync-shared.mjs.\n' +
  '// Edit the source in /shared/trading and re-run: npm run sync:functions\n';

if (!existsSync(SRC)) {
  console.error(`Source folder missing: ${SRC}`);
  process.exit(1);
}

const sources = readdirSync(SRC).filter((f) => f.endsWith('.js'));
let errors = 0;

for (const dir of FUNCTION_DIRS) {
  const destDir = path.join(ROOT, 'base44', 'functions', dir, 'shared');
  if (!existsSync(destDir)) {
    console.error(`Missing destination folder (skipping): ${destDir}`);
    errors++;
    continue;
  }
  for (const file of sources) {
    const body = readFileSync(path.join(SRC, file), 'utf8');
    // A destination file that is NOT also a source file is not ours to replace
    // (the folders may carry local-only modules); report it so nobody blindly
    // assumes the trees are identical.
    const destPath = path.join(destDir, file);
    try {
      statSync(destPath);
    } catch {
      console.log(`  note: ${file} exists only in shared/trading — not present in ${dir}/shared (not copied)`);
      continue;
    }
    writeFileSync(destPath, header + body, 'utf8');
    console.log(`synced ${dir}/shared/${file}`);
  }
}

// A generated copy no longer backed by any source is drift-in-waiting.
for (const dir of FUNCTION_DIRS) {
  const destDir = path.join(ROOT, 'base44', 'functions', dir, 'shared');
  for (const f of readdirSync(destDir)) {
    if (!f.endsWith('.js')) continue;
    if (!sources.includes(f)) console.warn(`WARN: ${dir}/shared/${f} has no /shared/trading counterpart — local-only or orphaned`);
  }
}

console.log(errors ? `done with ${errors} error(s)` : 'done');
process.exit(errors ? 1 : 0);
