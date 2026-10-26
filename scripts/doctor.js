#!/usr/bin/env node
/**
 * Diagnostics — `npm run doctor`
 *
 * Prints what is actually installed and wired, so "it should be fixed" can be
 * checked rather than assumed. Reads nothing from the network and changes
 * nothing on disk, so it is safe to run while the server is up.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const info = (m) => console.log(`        ${m}`);

console.log('\nCryptoMate diagnostics\n');
console.log(`Folder: ${ROOT}\n`);

let problems = 0;

// ── Build marker ──────────────────────────────────────────────────────────
console.log('Build');
const indexSrc = existsSync(path.join(ROOT, 'server/index.js'))
  ? readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  : '';
const buildMatch = indexSrc.match(/const BUILD = '([^']+)'/);
if (buildMatch) ok(buildMatch[1]);
else { bad('no build marker in server/index.js — this is an older build'); problems++; }

// ── SDK shim surface ──────────────────────────────────────────────────────
// This is the thing that broke twice: a namespace the backend functions call
// that the local shim does not provide shows up only at run time, as
// "Cannot read properties of undefined".
console.log('\nSDK shim surface');
register('./loaderHooks.js', pathToFileURL(path.join(ROOT, 'server/')).href);

try {
  const { EntityStore } = await import(`${pathToFileURL(path.join(ROOT, 'server/entityStore.js')).href}`);
  const { makeBase44Shim } = await import(`${pathToFileURL(path.join(ROOT, 'server/functionRuntime.js')).href}`);

  const store = new EntityStore(path.join(ROOT, 'data'));
  const client = makeBase44Shim(store, { getRegistry: () => null });

  // Every path the backend functions actually use.
  const required = [
    ['entities', client.entities],
    ['functions', client.functions],
    ['functions.invoke', client.functions?.invoke],
    ['integrations.Core.InvokeLLM', client.integrations?.Core?.InvokeLLM],
    ['auth.me', client.auth?.me],
    ['asServiceRole.entities', client.asServiceRole?.entities],
    ['asServiceRole.functions.invoke', client.asServiceRole?.functions?.invoke],
    ['asServiceRole.integrations.Core.InvokeLLM', client.asServiceRole?.integrations?.Core?.InvokeLLM],
  ];

  for (const [name, value] of required) {
    if (value) ok(name);
    else { bad(`${name} is MISSING — functions calling it will fail at run time`); problems++; }
  }
} catch (err) {
  bad(`could not load the shim: ${err.message}`);
  problems++;
}

// ── Backend functions ─────────────────────────────────────────────────────
console.log('\nBackend functions');
try {
  const { FunctionRegistry } = await import(`${pathToFileURL(path.join(ROOT, 'server/functionRuntime.js')).href}`);
  const registry = new FunctionRegistry({
    functionsDir: path.join(ROOT, 'base44', 'functions'),
    store: null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const { loaded, failed } = await registry.loadAll();
  if (failed.length === 0) ok(`${loaded.length} loaded, none failed`);
  else {
    bad(`${failed.length} failed to load`);
    for (const [name, reason] of failed) info(`${name}: ${reason}`);
    problems++;
  }
  for (const needed of ['tradingScheduler', 'autoTradingWorker', 'altcoinScannerWorker']) {
    if (registry.has(needed)) ok(needed);
    else { bad(`${needed} is not loaded — trading cannot run`); problems++; }
  }
} catch (err) {
  bad(`could not load functions: ${err.message}`);
  problems++;
}

// ── Trading configuration ─────────────────────────────────────────────────
// The settings that silently produce zero trades.
console.log('\nTrading configuration');
try {
  const { EntityStore } = await import(`${pathToFileURL(path.join(ROOT, 'server/entityStore.js')).href}`);
  const store = new EntityStore(path.join(ROOT, 'data'));
  const all = store.list('AutoTradingSettings', {});

  if (all.length === 0) {
    info('no AutoTradingSettings record yet — open Auto-Trading in the UI and save your settings');
  }

  for (const s of all) {
    info(`account: ${s.created_by}`);
    if (!s.is_enabled) { bad('auto-trading is DISABLED'); problems++; }
    else ok('auto-trading enabled');

    if (s.kill_switch_enabled) { bad('kill switch is ON — nothing will trade'); problems++; }
    if (s.execution_mode === 'browser') { bad("execution_mode is 'browser' — the server scheduler skips this account"); problems++; }

    const aiMode = s.ai_confirmation_mode || 'off';
    const llmConfigured = Boolean(process.env.LLM_PROVIDER && process.env.LLM_API_KEY);
    if (aiMode === 'auto' && !llmConfigured) {
      bad("AI confirmation is 'auto' with no LLM configured — this gate fails closed, so EVERY trade is rejected");
      info("fix: set LLM_PROVIDER and LLM_API_KEY in .env, or set AI confirmation to 'off'");
      problems++;
    } else if (aiMode === 'auto') {
      ok(`AI confirmation 'auto' with ${process.env.LLM_PROVIDER} configured`);
    } else if (aiMode === 'manual') {
      info("AI confirmation is 'manual' — trades wait for approval in the UI and will not execute on their own");
    } else {
      ok("AI confirmation 'off'");
    }

    if (s.live_trading_enabled) {
      info('LIVE TRADING is enabled — real orders');
    } else {
      ok('paper trading (simulated fills)');
    }

    info(`entry threshold ${s.min_confidence ?? 70}/100, max ${s.max_open_positions ?? 5} positions, ` +
         `${s.trades_today ?? 0}/${s.max_trades_per_day ?? 10} trades today`);
  }
} catch (err) {
  bad(`could not read settings: ${err.message}`);
  problems++;
}

console.log(`\n${'-'.repeat(56)}`);
console.log(problems === 0
  ? '  No problems found.'
  : `  ${problems} problem${problems === 1 ? '' : 's'} found — see FAIL lines above.`);
console.log(`${'-'.repeat(56)}\n`);

process.exit(problems > 0 ? 1 : 0);
