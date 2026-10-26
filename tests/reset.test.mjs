/**
 * Reset and snapshot tests.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  EntityStore, snapshotEntities, resetTradingData, RESET_CLEARS, RESET_KEEPS,
} from '../server/entityStore.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function seeded() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-reset-'));
  const store = new EntityStore(dir);

  store.create('Portfolio', {
    available_balance: 4321, total_balance: 8765,
    positions: [{ asset_symbol: 'INJUSDT', quantity: 10, avg_entry_price: 30 }],
    total_trades: 17, total_profit_loss: -1234,
  });
  store.create('AutoTradingSettings', {
    is_enabled: true, min_confidence: 70, max_trades_per_day: 20,
    trades_today: 9, daily_loss: 450, assets_traded_today: ['INJUSDT', 'TIAUSDT'],
    daily_counters_date: '2026-10-02', daily_start_equity: 9000,
    circuit_breaker_triggered_at: '2026-10-02T10:00:00Z',
    run_lock_until: null,
  });
  store.create('ExchangeConnection', { exchange_name: 'okx', encrypted_api_key: 'cipher' });
  store.create('AISignalConfig', { name: 'Indicator-Led' });
  store.create('TradingPreferences', { theme: 'dark' });
  store.create('BacktestResult', { name: 'run 1', total_return: 12 });
  for (let i = 0; i < 5; i++) store.create('Trade', { asset_symbol: 'INJUSDT', trade_type: 'buy' });
  for (let i = 0; i < 3; i++) store.create('Notification', { title: 'filled' });
  store.create('SignalOutcome', { symbol: 'INJUSDT', won: true });
  store.create('AIAdvisorInsight', { text: 'old insight' });

  return { dir, store };
}

console.log('\nSnapshot');

test('copies every entity file and reports where', () => {
  const { dir, store } = seeded();
  const result = snapshotEntities(store);
  assert.ok(existsSync(result.path), 'snapshot folder not created');
  assert.ok(result.files > 0, 'no files copied');
  const copied = readdirSync(result.path);
  assert.ok(copied.includes('Trade.json'), 'Trade.json not in the snapshot');
  assert.ok(copied.includes('Portfolio.json'));
  rmSync(dir, { recursive: true, force: true });
});

test('snapshot is taken outside the entities folder, so a reset cannot wipe it', () => {
  const { dir, store } = seeded();
  const result = snapshotEntities(store);
  assert.ok(!result.path.startsWith(store.dir), 'snapshot written inside entities/');
  rmSync(dir, { recursive: true, force: true });
});

console.log('\nReset');

test('clears exactly the collections it says it will', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  for (const name of RESET_CLEARS) {
    assert.strictEqual(store.list(name, {}).length, 0, `${name} was not cleared`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('keeps settings, exchange connection and configuration', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });

  // The things whose loss would turn a reset into a reinstall.
  assert.strictEqual(store.list('ExchangeConnection', {}).length, 1, 'exchange connection lost');
  assert.strictEqual(store.list('AISignalConfig', {}).length, 1, 'signal config lost');
  assert.strictEqual(store.list('TradingPreferences', {}).length, 1, 'preferences lost');
  assert.strictEqual(store.list('BacktestResult', {}).length, 1, 'backtests lost');
  assert.strictEqual(store.list('AutoTradingSettings', {}).length, 1, 'settings lost');
  rmSync(dir, { recursive: true, force: true });
});

test('the encrypted API key survives untouched', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  const conn = store.list('ExchangeConnection', {})[0];
  assert.strictEqual(conn.encrypted_api_key, 'cipher');
  rmSync(dir, { recursive: true, force: true });
});

test('portfolio returns to the starting balance with no positions', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { startingBalance: 10000, log: quiet });
  const p = store.list('Portfolio', {})[0];
  assert.strictEqual(p.available_balance, 10000);
  assert.strictEqual(p.total_balance, 10000);
  assert.deepStrictEqual(p.positions, []);
  assert.strictEqual(p.total_trades, 0);
  assert.strictEqual(p.total_profit_loss, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a custom starting balance is honoured', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { startingBalance: 2500, log: quiet });
  assert.strictEqual(store.list('Portfolio', {})[0].available_balance, 2500);
  rmSync(dir, { recursive: true, force: true });
});

test('daily counters and the circuit breaker are cleared', () => {
  // Otherwise a stale daily_loss could halt trading on a freshly reset account.
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  const s = store.list('AutoTradingSettings', {})[0];
  assert.strictEqual(s.trades_today, 0);
  assert.strictEqual(s.daily_loss, 0);
  assert.deepStrictEqual(s.assets_traded_today, []);
  assert.strictEqual(s.circuit_breaker_triggered_at, null);
  assert.strictEqual(s.daily_start_equity, null);
  rmSync(dir, { recursive: true, force: true });
});

test('trading settings themselves are NOT changed', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  const s = store.list('AutoTradingSettings', {})[0];
  assert.strictEqual(s.is_enabled, true, 'auto-trading was switched off');
  assert.strictEqual(s.min_confidence, 70, 'threshold was changed');
  assert.strictEqual(s.max_trades_per_day, 20, 'trade cap was changed');
  rmSync(dir, { recursive: true, force: true });
});

test('reports what it deleted', () => {
  const { dir, store } = seeded();
  const result = resetTradingData(store, { log: quiet });
  assert.strictEqual(result.cleared.Trade, 5);
  assert.strictEqual(result.cleared.Notification, 3);
  assert.strictEqual(result.portfoliosReset, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('running it twice is harmless', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  const second = resetTradingData(store, { log: quiet });
  assert.deepStrictEqual(second.cleared, {}, 'second run reported deletions that were already gone');
  assert.strictEqual(store.list('Portfolio', {})[0].available_balance, 10000);
  rmSync(dir, { recursive: true, force: true });
});

test('the clear and keep lists do not overlap', () => {
  // A name in both would make the behaviour depend on ordering.
  const overlap = RESET_CLEARS.filter((n) => RESET_KEEPS.includes(n));
  assert.deepStrictEqual(overlap, [], `in both lists: ${overlap.join(', ')}`);
});

test('reset survives a reload from disk', () => {
  const { dir, store } = seeded();
  resetTradingData(store, { log: quiet });
  const reopened = new EntityStore(dir);
  assert.strictEqual(reopened.list('Trade', {}).length, 0, 'trades came back after reload');
  assert.strictEqual(reopened.list('Portfolio', {})[0].available_balance, 10000);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${'-'.repeat(52)}\n${passed} passed, ${failed} failed\n${'-'.repeat(52)}\n`);
process.exit(failed > 0 ? 1 : 0);
