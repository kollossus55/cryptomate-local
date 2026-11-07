/**
 * v6Engine tests with a mocked hub. All data lives in throwaway temp folders, and the
 * test-only certificates and strategies below exist nowhere the production engine reads.
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EntityStore, entityApiReadOnly, resetTradingData, V6_TRADE_EXCHANGE } from '../server/entityStore.js';
import { makeBase44Shim } from '../server/functionRuntime.js';
import { defaultConfig, drainOutbox, FIVE_MIN_MS, NO_CONSENSUS_MAX_MS, rangedExits, runCycle, TF_MS, wickSummary } from '../base44/functions/v6Engine/engine.js';
import { createIntrabarReader } from '../base44/functions/v6Engine/intrabar.js';
import { handle as handleControl } from '../base44/functions/v6Control/control.js';
import * as realGate from '../base44/functions/v6Engine/shared/v6SignalGate.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.stack}`); }
};

const DAY = TF_MS['1d'];
const START = Date.UTC(2026, 10, 5, 0, 7, 0);
const BAR_CLOSE = Date.UTC(2026, 10, 5);
const dirs = [];

// Bars with a small wobble, so ATR, volatility and correlation have something to read.
function series(tf, price, now, limit) {
  const ms = TF_MS[tf];
  const lastOpen = Math.floor((now - 60_000) / ms) * ms - ms;
  const out = [];
  for (let i = limit - 1; i >= 0; i--) {
    const t = lastOpen - i * ms;
    // Realistic daily moves, or v6Risk refuses the volatility as implausible. Hourly stays
    // small so the BTC breaker is only tripped by a test that means to.
    const c = price * (1 + (tf === '1h' ? 0.002 : 0.03) * Math.sin(i * 1.7));
    out.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000, qv: 1e8 });
  }
  return out;
}

function makeHub(clock, initial = {}) {
  const hub = {
    prices: { BTCUSDT: 90_000, ETHUSDT: 100, ...initial }, down: false, silent: new Set(), depth: 1e6, noBook: false,
    async bars(symbol, tf, limit) {
      if (hub.down) throw new Error('all_venues_failed');
      return series(tf, hub.prices[symbol], clock.now, limit);
    },
    async consensusPrice(symbol) {
      if (hub.down || hub.silent.has(symbol)) throw new Error('all_venues_failed');
      return { price: hub.prices[symbol], ok: true, reason: null, venues: 3, spreadPct: 0.01 };
    },
    async book(symbol) {
      if (hub.down || hub.noBook) throw new Error('all_venues_failed');
      const p = hub.prices[symbol];
      return { t: clock.now, bids: [[p * 0.9995, hub.depth]], asks: [[p * 1.0005, hub.depth]] };
    },
    async universe() { return []; },
    health: () => ['okx', 'bybit', 'kraken'].map((venue) => ({ venue, ok: !hub.down, status: hub.down ? 'down' : 'ok' })),
  };
  return hub;
}

const longSignal = (symbol) => ({ symbol, side: 'long', score: 1, stopDistancePct: 0.1, exitProfile: 'trend', reason: 'test signal' });

function testStrategy({ symbols = ['ETHUSDT'], calls = { n: 0 } } = {}) {
  return {
    id: 'test_strategy', name: 'Test only', version: 1, timeframe: '1d', params: {}, warmupBars: 0,
    universe: { kind: 'fixed', symbols },
    signals(ctx) { calls.n++; return ctx.universe.map(longSignal); },
  };
}

// Stands in for the real gate where a test is about the engine, not about the seven checks.
function stubGate(seen = {}) {
  // Core wants every check of a stage shown as passed: ok alone is refused.
  const checks = ['certificate', 'drift', 'data', 'replay', 'liquidity', 'history', 'risk'].map((id) => ({ id, status: 'pass', text: 'stub', values: [] }));
  const pass = { ok: true, stage: 'x', reason: null, blockedBy: null, checks, sizeMultiplier: 1 };
  return {
    verifyCertificate: (c) => (c?.status === 'valid' ? { ok: true, code: 'ok' } : { ok: false, code: c ? 'bad_seal' : 'missing' }),
    initialStrategyState: ({ strategy }) => ({ strategy_id: strategy.id, lifecycle: 'paper_half', size_multiplier: 0.5, forward_trades: 0 }),
    createSignalGate: ({ data }) => ({
      modeFor: () => 'trade',
      preSize: () => pass,
      postSize: (signal, ctx) => {
        seen.t = ctx.t;
        seen.book = data.books?.get(signal.symbol);
        return pass;
      },
    }),
    recordForwardTrade: (state, trade) => { seen.forward = trade; return { state: { ...state, forward_trades: state.forward_trades + 1 }, events: [] }; },
    recordShadowResult: (state) => ({ state }),
    advanceLifecycle: (state) => ({ state, events: [] }),
    returnFromShadow: (state) => ({ ok: true, state, events: [] }),
  };
}

async function world({ portfolio = { available_balance: 10_000, total_balance: 10_000, positions_value: 0, positions: [], total_trades: 0, total_profit_loss: 0 }, settings = { is_enabled: false }, certified = false, strategy, gate } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-v6engine-'));
  dirs.push(dir);
  const store = new EntityStore(dir);
  if (portfolio) store.create('Portfolio', portfolio);
  store.create('AutoTradingSettings', settings);
  const E = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
  const clock = { now: START };
  const hub = makeHub(clock);
  const w = {
    store, E, clock, hub, wicks: {}, barCache: new Map(), seen: {},
    strategies: strategy ? [strategy] : [],
    gateModule: gate,
    hooks: {},
    run(extra = {}) {
      return runCycle({
        entities: E, hub, now: () => clock.now, registry: w.strategies, gateModule: w.gateModule, history: null, barCache: w.barCache, hooks: w.hooks,
        intrabar: async (symbol, from, to) => (typeof w.wicks[symbol] === 'function' ? w.wicks[symbol](from, to) : symbol in w.wicks ? w.wicks[symbol] : [{ t: to - FIVE_MIN_MS, o: hub.prices[symbol], h: hub.prices[symbol], l: hub.prices[symbol], c: hub.prices[symbol] }]),
        ...extra,
      });
    },
    tick(n = 1) { clock.now += n * FIVE_MIN_MS; },
    account: () => store.list('Portfolio', {})[0],
    trades: () => store.list('Trade', {}),
    riskEvents: (code) => store.list('V6RiskEvent', {}).filter((e) => e.code === code),
  };
  if (certified) store.create('V6Certificate', { strategy_id: 'test_strategy', status: 'valid', issued_at: START });
  return w;
}

const certifiedWorld = async (opts = {}) => {
  const seen = {};
  const w = await world({ certified: true, strategy: testStrategy(opts), gate: stubGate(seen), ...opts.world });
  w.seen = seen;
  return w;
};

/** An engine with one open ETH position, entered on the first tick. */
async function holding(opts) {
  const w = await certifiedWorld(opts);
  const r = await w.run();
  assert.strictEqual(r.held, 1, 'setup: the entry did not fill');
  return w;
}

const position = (w) => w.account().positions[0];

function assertReconciled(w, start = 10_000) {
  const a = w.account();
  const open = a.positions.reduce((s, p) => s + p.profit_loss, 0);
  assert.ok(Math.abs(start + a.total_profit_loss + open - a.total_balance) < 1e-6, `identity broke: ${start} + ${a.total_profit_loss} + ${open} != ${a.total_balance}`);
  const realized = w.trades().reduce((s, t) => s + (t.profit_loss ?? 0), 0);
  assert.ok(Math.abs(realized - a.total_profit_loss) < 1e-6, `Trade rows ${realized} != realized ${a.total_profit_loss}`);
  assert.strictEqual(w.trades().length, a.total_trades, 'Trade rows differ from total_trades');
}

console.log('\nCash with no certificate');

await test('no certificate: job runs, stays in cash, records why once', async () => {
  const w = await world({ gate: realGate });
  const r = await w.run();
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(r.cashCode, 'no_strategies');
  w.tick();
  await w.run();
  assert.strictEqual(w.trades().length, 0);
  assert.strictEqual(w.account().positions.length, 0);
  assert.strictEqual(w.riskEvents('no_strategies').length, 1, 'the reason should be stored when it changes, not every tick');
  assert.strictEqual(w.store.list('V6EquityPoint', {}).length, 2);
});

await test('a forged certificate fails the real check and the account stays in cash', async () => {
  const calls = { n: 0 };
  const w = await world({ gate: realGate, strategy: testStrategy({ calls }), certified: true });
  const r = await w.run();
  assert.strictEqual(r.cashCode, 'no_certified');
  assert.strictEqual(calls.n, 0, 'an uncertified strategy must not even be asked for signals');
  assert.strictEqual(w.trades().length, 0);
});

await test('no gate module: nothing runs, and exits are unaffected by the missing module', async () => {
  const w = await holding();
  w.gateModule = null;
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  const r = await w.run();
  assert.strictEqual(r.cashCode, 'gate_unavailable');
  assert.strictEqual(r.held, 0, 'the stop must still fire');
});

console.log('\nCutover');

await test('refuses to start on an account with legacy positions, and changes nothing', async () => {
  const portfolio = { available_balance: 5000, total_balance: 6000, positions_value: 1000, total_trades: 3, total_profit_loss: 0, positions: [{ asset_symbol: 'INJUSDT', quantity: 10, avg_entry_price: 100 }] };
  const w = await world({ portfolio, gate: realGate });
  const before = JSON.stringify(w.account());
  const r = await w.run();
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(r.code, 'not_flat');
  assert.strictEqual(JSON.stringify(w.account()), before, 'the Portfolio row must not change');
  assert.strictEqual(w.riskEvents('not_flat').length, 1);
  w.tick();
  await w.run();
  assert.strictEqual(w.riskEvents('not_flat').length, 1, 'one alarm a day, not one per tick');
});

await test('legacy cannot be hidden from the engine by value type or by newer rows', async () => {
  for (const value of ['true', 1, 'false', {}]) {
    const w = await world({ settings: { is_enabled: value }, gate: realGate });
    assert.strictEqual((await w.run()).code, 'legacy_enabled', JSON.stringify(value));
  }
  const w = await world({ settings: { is_enabled: true, created_date: '2020-01-01T00:00:00.000Z' }, gate: realGate });
  for (let i = 0; i < 8; i++) w.store.create('AutoTradingSettings', { is_enabled: false, created_date: '2099-01-01T00:00:00.000Z' });
  assert.strictEqual((await w.run()).code, 'legacy_enabled');
  assert.strictEqual(w.account().v6_state, undefined);
});

await test('off stays off: false, null, 0 and an empty string do not read as legacy on', async () => {
  for (const value of [false, null, 0, '']) {
    const w = await world({ settings: { is_enabled: value }, gate: realGate });
    assert.notStrictEqual((await w.run()).code, 'legacy_enabled', JSON.stringify(value));
  }
});

await test('a position list that is not a list refuses cutover instead of crashing', async () => {
  const w = await world({ gate: realGate });
  w.store.update('Portfolio', w.account().id, { positions: 'x' });
  assert.strictEqual((await w.run()).code, 'not_flat');
  assert.strictEqual(w.account().v6_state, undefined);
});

await test('decoy rows after cutover: entries blocked, exits continue', async () => {
  const w = await holding();
  w.store.create('AutoTradingSettings', { is_enabled: 'true', created_date: '2020-01-01T00:00:00.000Z' });
  for (let i = 0; i < 6; i++) w.store.create('AutoTradingSettings', { is_enabled: false, created_date: '2099-01-01T00:00:00.000Z' });
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  const r = await w.run();
  assert.strictEqual(r.held, 0, 'the stop must still fire');
  assert.strictEqual(r.cashCode, 'legacy_enabled');
});

await test('refuses to start while legacy auto-trading is on', async () => {
  const w = await world({ settings: { is_enabled: true }, gate: realGate });
  assert.strictEqual((await w.run()).code, 'legacy_enabled');
  assert.strictEqual(w.account().v6_state, undefined);
});

await test('a flat account keeps its real balance and history at cutover', async () => {
  const w = await world({ gate: realGate, portfolio: { available_balance: 9680.07, total_balance: 9680.07, positions_value: 0, positions: [], total_trades: 41, total_profit_loss: -319.93 } });
  await w.run();
  const a = w.account();
  assert.strictEqual(a.available_balance, 9680.07);
  assert.strictEqual(a.total_profit_loss, -319.93);
  assert.strictEqual(a.total_trades, 41);
  assert.strictEqual(a.v6_state.startingEquity, 9680.07);
});

await test('legacy switched back on after cutover: entries blocked, exits continue', async () => {
  const w = await holding();
  const settings = w.store.list('AutoTradingSettings', {})[0];
  w.store.update('AutoTradingSettings', settings.id, { is_enabled: true });
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  const r = await w.run();
  assert.strictEqual(r.held, 0, 'the stop must still fire');
  const alarms = w.riskEvents('legacy_enabled').filter((e) => e.type === 'alarm');
  assert.strictEqual(alarms.length, 1);
  assert.strictEqual(alarms[0].severity, 'critical');
});

await test('the real gate runs in the cycle: a failed check blocks the entry and all seven results are kept', async () => {
  const w = await certifiedWorld();
  w.gateModule = { ...w.gateModule, createSignalGate: realGate.createSignalGate };
  const r = await w.run();
  assert.strictEqual(r.held, 0);
  assert.strictEqual(w.trades().length, 0);
  const [row] = w.store.list('V6SignalTest', {});
  assert.strictEqual(row.outcome, 'blocked');
  assert.deepStrictEqual(row.checks.map((c) => c.id), ['certificate', 'drift', 'data', 'replay', 'liquidity', 'history', 'risk']);
});

await test('a flat account stuck on the no-entries rung is flagged for review', async () => {
  const w = await world({ gate: realGate });
  await w.run();
  const a = w.account();
  const riskState = { ...a.v6_state.riskState, equityHigh: 12_000 };
  w.store.update('Portfolio', a.id, { v6_state: { ...a.v6_state, riskState } });
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.riskState.rung, 3);
  assert.strictEqual(w.account().v6_state.riskState.review.needed, true);
});

console.log('\nFull cycle');

await test('a new bar produces one entry through the ledger, in legacy and V6 shapes', async () => {
  const w = await holding();
  const p = position(w);
  assert.strictEqual(p.asset_symbol, 'ETHUSDT');
  assert.strictEqual(p.v6.strategyId, 'test_strategy');
  assert.ok(p.v6.stopPrice > 0 && p.v6.exitPlan, 'an entry is born with its stop and exit plan');
  assert.strictEqual(p.v6.entryTime, BAR_CLOSE, 'same t convention as the simulator: the decision close');
  const [trade] = w.trades();
  assert.strictEqual(trade.exchange, 'Paper Trading (V6)');
  assert.strictEqual(trade.strategy_id, 'test_strategy');
  assert.strictEqual(w.account().v6_state.outbox.length, 0);
  const tests = w.store.list('V6SignalTest', {});
  assert.strictEqual(tests.length, 1);
  assert.strictEqual(tests[0].outcome, 'entered');
  assert.strictEqual(tests[0].trade_id, trade.id);
  assert.strictEqual(w.store.list('V6ExchangeHealth', {}).length, 3);
  assertReconciled(w);
});

await test('strategies are asked once per closed bar, not once per tick', async () => {
  const calls = { n: 0 };
  const w = await certifiedWorld({ calls });
  await w.run();
  const after = calls.n;
  for (let i = 0; i < 5; i++) { w.tick(); await w.run(); }
  assert.ok(after >= 1);
  assert.strictEqual(calls.n, after, 'in-bar ticks must not produce signals');
  w.clock.now = START + DAY;
  await w.run();
  assert.ok(calls.n > after, 'the next closed bar must be decided on');
});

await test('the gate is timed against the wall clock, so a fresh book is not refused as old', async () => {
  const w = await certifiedWorld();
  w.clock.now = START + 41 * 60_000;
  await w.run();
  assert.ok(w.seen.book, 'the book was not prefetched for the gate');
  assert.ok(Math.abs(w.seen.t - w.seen.book.t) <= 30_000, `t is ${w.seen.t - w.seen.book.t} ms from the book`);
});

await test('an entry with no order book is skipped, not filled at a guess', async () => {
  const w = await certifiedWorld();
  w.hub.noBook = true;
  const r = await w.run();
  assert.strictEqual(r.held, 0);
  assert.strictEqual(w.trades().length, 0);
  assert.strictEqual(w.riskEvents('no_book').length, 1);
});

console.log('\nRestart mid-cycle');

await test('a crash before the commit applies nothing, and the rerun enters once', async () => {
  const w = await certifiedWorld();
  w.hooks.beforeCommit = () => { throw new Error('power cut'); };
  await assert.rejects(w.run(), /power cut/);
  assert.strictEqual(w.account().v6_state, undefined);
  assert.strictEqual(w.trades().length, 0);
  w.hooks = {};
  const r = await w.run();
  assert.strictEqual(r.held, 1);
  assert.strictEqual(w.trades().length, 1);
  assertReconciled(w);
});

await test('a crash after the commit cannot double-apply: the rows are finished, the fill is not repeated', async () => {
  const w = await certifiedWorld();
  w.hooks.afterCommit = () => { throw new Error('power cut'); };
  await assert.rejects(w.run(), /power cut/);
  assert.strictEqual(w.account().positions.length, 1, 'the commit landed');
  assert.strictEqual(w.trades().length, 0, 'the crash came before the rows');
  w.hooks = {};
  w.barCache = new Map();
  w.tick();
  await w.run();
  assert.strictEqual(w.trades().length, 1, 'rows finished exactly once');
  assert.strictEqual(w.account().positions.length, 1);
  assert.strictEqual(w.account().v6_state.outbox.length, 0);
  assertReconciled(w);
});

await test('draining an outbox twice writes each row once', async () => {
  const w = await world({ gate: realGate });
  const outbox = [{ entity: 'Trade', id: 'v6t-a', data: { asset_symbol: 'ETHUSDT', exchange: V6_TRADE_EXCHANGE } }, { entity: 'V6ExchangeHealth', id: 'v6h-okx', upsert: true, data: { venue: 'okx' } }];
  await drainOutbox(w.E, outbox);
  await drainOutbox(w.E, outbox);
  assert.strictEqual(w.trades().length, 1);
  assert.strictEqual(w.store.list('V6ExchangeHealth', {}).length, 1);
});

await test('a request consumed before a crash is not applied a second time', async () => {
  const w = await holding();
  const cfg = w.store.list('V6Config', {})[0];
  w.store.update('V6Config', cfg.id, { halt_request: { id: 'r1', at: START, by: 'tester', reason: 'test', flatten: true } });
  w.hooks.afterCommit = () => { throw new Error('power cut'); };
  w.tick();
  await assert.rejects(w.run(), /power cut/);
  w.hooks = {};
  w.tick();
  await w.run();
  assert.strictEqual(w.store.list('V6Config', {})[0].halt_request, null);
  assert.strictEqual(w.riskEvents('manual_halt').length, 1);
});

console.log('\nRun lock');

await test('overlapping cycles in one process: the second is skipped', async () => {
  const w = await world({ gate: realGate });
  const [a, b] = await Promise.all([w.run(), w.run()]);
  assert.deepStrictEqual([a.status, b.status].sort(), ['ran', 'skipped']);
});

await test('a live lease from another process blocks; a dead one is taken over', async () => {
  const w = await world({ gate: realGate });
  await w.run();
  const cfg = w.store.list('V6Config', {})[0];
  w.tick();
  w.store.update('V6Config', cfg.id, { engine_lease: { pid: process.pid + 1, until: w.clock.now + 60_000 } });
  assert.strictEqual((await w.run({ isAlive: () => true })).status, 'skipped');
  assert.strictEqual((await w.run({ isAlive: () => false })).status, 'ran');
  assert.strictEqual(w.store.list('V6Config', {})[0].engine_lease, null);
});

console.log('\nExits');

await test('a wick between polls is caught: the stop fires though the price recovered', async () => {
  const w = await holding();
  const stop = position(w).v6.stopPrice;
  w.tick();
  w.wicks.ETHUSDT = [{ t: w.clock.now - FIVE_MIN_MS, o: 99, h: 100, l: stop * 0.98, c: 100 }];
  const r = await w.run();
  assert.strictEqual(r.held, 0);
  const exit = w.trades().find((t) => t.trade_type === 'sell');
  assert.strictEqual(exit.reason_code, 'hard_stop');
  assert.ok(exit.price <= stop && exit.price > stop * 0.98, `fill ${exit.price} should be near the stop ${stop}, not the recovered mark`);
  assertReconciled(w);
});

await test('a gap through the stop fills at the gap, not at the stop', async () => {
  const w = await holding();
  const stop = position(w).v6.stopPrice;
  const gap = stop * 0.9;
  w.tick();
  w.wicks.ETHUSDT = [{ t: w.clock.now - FIVE_MIN_MS, o: gap, h: gap, l: gap * 0.99, c: 100 }];
  await w.run();
  const exit = w.trades().find((t) => t.trade_type === 'sell');
  assert.ok(exit.price <= gap, `fill ${exit.price} should be no better than the gap ${gap}`);
});

await test('with no 5-minute data the stop is checked at the mark, and that is reported', async () => {
  const w = await holding();
  w.tick();
  w.wicks.ETHUSDT = null;
  const r = await w.run();
  assert.strictEqual(r.held, 1);
  assert.strictEqual(w.riskEvents('wick_unavailable').length, 1);
});

await test('a pause stops entries and never a stop', async () => {
  const w = await holding();
  const cfg = w.store.list('V6Config', {})[0];
  w.store.update('V6Config', cfg.id, { halt_request: { id: 'p1', at: START, by: 'tester', reason: 'test', flatten: false } });
  w.tick();
  await w.run();
  assert.strictEqual(position(w).asset_symbol, 'ETHUSDT', 'a pause alone must not sell');
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  assert.strictEqual((await w.run()).held, 0);
});

await test('a held coin that leaves the universe is still managed', async () => {
  const w = await holding();
  w.strategies = [testStrategy({ symbols: ['BTCUSDT'] })];
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  await w.run();
  assert.ok(w.trades().some((t) => t.asset_symbol === 'ETHUSDT' && t.trade_type === 'sell'));
});

await test('all venues down with an open position: marked at last price, alarm raised, exit still fills', async () => {
  const w = await holding();
  const mark = position(w).last_known_price;
  w.hub.down = true;
  w.wicks.ETHUSDT = null;
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(r.held, 1);
  assert.strictEqual(position(w).last_known_price, mark);
  const alarm = w.riskEvents('all_venues_down');
  assert.strictEqual(alarm.length, 1);
  assert.strictEqual(alarm[0].severity, 'critical');
  assert.strictEqual(w.account().v6_state.noQuoteSince.ETHUSDT, undefined, 'a network outage must not start the delist clock');

  const cfg = w.store.list('V6Config', {})[0];
  w.store.update('V6Config', cfg.id, { halt_request: { id: 'f1', at: START, by: 'tester', reason: 'test', flatten: true } });
  w.tick();
  assert.strictEqual((await w.run()).held, 0, 'exits must not need a live venue');
  assert.strictEqual(w.trades().find((t) => t.trade_type === 'sell').fill_method, 'tier_fallback');
  assertReconciled(w);
});

await test('a coin no venue quotes for three days while BTC is fine exits as delisted', async () => {
  const w = await holding();
  w.hub.silent.add('ETHUSDT');
  w.tick();
  assert.strictEqual((await w.run()).held, 1, 'within the grace period it stays');
  w.clock.now += 3 * DAY + 2 * FIVE_MIN_MS;
  await w.run();
  const exit = w.trades().find((t) => t.trade_type === 'sell');
  assert.strictEqual(exit.reason_code, 'delisted');
  assertReconciled(w);
});

await test('a partial exit keeps leaving: the remainder is re-emitted until flat', async () => {
  const w = await holding();
  const qty = position(w).quantity;
  w.hub.depth = qty * 0.4;
  const cfg = w.store.list('V6Config', {})[0];
  w.store.update('V6Config', cfg.id, { halt_request: { id: 'f2', at: START, by: 'tester', reason: 'test', flatten: true } });
  w.tick();
  await w.run();
  assert.ok(Math.abs(position(w).quantity - qty * 0.6) < 1e-9, 'only the book depth should fill');
  assert.ok(position(w).v6.exitPending, 'the intent to leave must be stored');
  assertReconciled(w);
  w.hub.depth = 1e6;
  w.tick();
  assert.strictEqual((await w.run()).held, 0);
  const sold = w.trades().filter((t) => t.trade_type === 'sell').reduce((s, t) => s + t.quantity, 0);
  assert.ok(Math.abs(sold - qty) < 1e-9, 'every unit leaves exactly once');
  assertReconciled(w);
});

await test('a closed trade reaches the drift monitor once, as a return on notional', async () => {
  const w = await holding();
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  await w.run();
  assert.ok(w.seen.forward, 'recordForwardTrade was not called');
  assert.ok(w.seen.forward.returnPct < 0);
  assert.strictEqual(w.store.list('V6StrategyState', {})[0].forward_trades, 1);
});

console.log('\nAccounting');

await test('after a round trip, Portfolio, ledger and Trade rows agree', async () => {
  const w = await holding();
  for (let i = 0; i < 3; i++) { w.tick(); await w.run(); assertReconciled(w); }
  w.tick();
  w.hub.prices.ETHUSDT = 80;
  await w.run();
  assertReconciled(w);
  const a = w.account();
  assert.strictEqual(a.positions.length, 0);
  assert.ok(Math.abs(a.total_balance - a.available_balance) < 1e-9, 'flat means equity is cash');
  assert.ok(a.total_profit_loss < 0);
});

await test('drawdown is measured from the all-time high, which a re-enable cannot reset', async () => {
  const w = await holding();
  w.tick();
  w.hub.prices.ETHUSDT = 85;
  await w.run();
  const dd = w.store.list('V6EquityPoint', {}).at(-1).drawdown_pct;
  assert.ok(dd < 0);
  assert.strictEqual(w.account().v6_state.allTimeHigh, 10_000);
});

console.log('\nPaper only');

await test('engine sources import nothing live and cannot issue a certificate', async () => {
  for (const file of ['engine.js', 'intrabar.js', 'entry.ts']) {
    const src = readFileSync(path.join('base44', 'functions', 'v6Engine', file), 'utf8');
    for (const banned of ['liveOrderExecution', 'executeApprovedTrade', 'liveTradingControl', 'okxExchange', 'ExchangeConnection', 'api_key', 'api_secret', 'issueCertificate', 'PASS_THROUGH_GATE']) {
      assert.ok(!src.includes(banned), `${file} mentions ${banned}`);
    }
  }
});

console.log('\nHub field mapping and venue roles');

await test('health rows store the hub retry countdown, and rate limiting only while it applies', async () => {
  const w = await world();
  w.hub.health = () => [
    { venue: 'okx', ok: false, status: 'rate_limited', breaker: 'open', rateLimited: 3, retryInMs: 60_000, consecutiveFailures: 2 },
    { venue: 'bybit', ok: true, status: 'ok', breaker: 'closed', rateLimited: 3, retryInMs: 0 },
  ];
  await w.run();
  const row = (venue) => w.store.list('V6ExchangeHealth', {}).find((h) => h.venue === venue);
  assert.strictEqual(row('okx').retry_until, w.clock.now + 60_000);
  assert.strictEqual(row('okx').rate_limited, true);
  assert.strictEqual(row('bybit').retry_until, null);
  assert.strictEqual(row('bybit').rate_limited, false, 'a past rate limit is not a current one');
});

function capture(w) {
  const seen = { books: [], data: null };
  const { createSignalGate } = w.gateModule;
  w.gateModule = { ...w.gateModule, createSignalGate: (args) => { if (args.data?.replay?.size) seen.data = args.data; return createSignalGate(args); } };
  const { book } = w.hub;
  w.hub.book = async (symbol, depth, opts) => { seen.books.push(opts?.venue ?? null); return book(symbol, depth, opts); };
  return seen;
}

await test('both replay venues reach the gate, the operator choice first, and the chosen book venue is read', async () => {
  const w = await certifiedWorld();
  w.store.create('V6Config', { ...defaultConfig(), roles: { replay: 'bybit', book: 'kraken' } });
  const seen = capture(w);
  await w.run();
  assert.deepStrictEqual(seen.data.replay.get('ETHUSDT').map((c) => c.venue), ['bybit', 'okx']);
  assert.ok(seen.books.length > 0 && seen.books.every((v) => v === 'kraken'));
});

await test('an exit falls back to any venue when the chosen book venue is down', async () => {
  const w = await holding();
  const [cfg] = w.store.list('V6Config', {});
  w.store.update('V6Config', cfg.id, { roles: { book: 'kraken' } });
  const { book } = w.hub;
  const asked = [];
  w.hub.book = async (symbol, depth, opts) => {
    asked.push(opts?.venue ?? null);
    if (opts?.venue === 'kraken') throw new Error('venue_down');
    return book(symbol, depth, opts);
  };
  w.store.update('V6Config', cfg.id, { close_requests: [{ id: 'c1', at: START, by: 'tester', strategy_id: 'test_strategy' }] });
  w.tick();
  await w.run();
  assert.strictEqual(w.account().positions.length, 0, 'the close filled');
  assert.deepStrictEqual(asked.slice(0, 2), ['kraken', null]);
});

await test('one replay venue failing leaves the other for the gate', async () => {
  const w = await certifiedWorld();
  const seen = capture(w);
  const { bars } = w.hub;
  w.hub.bars = async (symbol, tf, limit, opts) => {
    if (opts?.venue === 'okx') throw new Error('venue_down');
    return bars(symbol, tf, limit, opts);
  };
  await w.run();
  assert.deepStrictEqual(seen.data.replay.get('ETHUSDT').map((c) => c.venue), ['bybit']);
});

await test('warm-up shadow signals are taken off before the gate decides a return', async () => {
  const w = await certifiedWorld();
  const [cert] = w.store.list('V6Certificate', {});
  w.store.update('V6Certificate', cert.id, { expected: { min_trades: 5 } });
  w.store.create('V6StrategyState', { id: 'v6st-test', strategy_id: 'test_strategy', lifecycle: 'shadow', shadow_in_range: 24 });
  w.store.create('V6Config', { ...defaultConfig(), reinstate_requests: [{ id: 'r1', at: START, by: 'tester', strategy_id: 'test_strategy' }] });
  let given = null;
  w.gateModule = { ...w.gateModule, returnFromShadow: (state) => { given = state.shadow_in_range; return { ok: false, reason: 'not_enough_shadow_signals', state, events: [] }; } };
  await w.run();
  assert.strictEqual(given, 19);
  assert.strictEqual(w.riskEvents('reinstate_refused').length, 1);
  assert.strictEqual(w.store.list('V6StrategyState', {}).find((s) => s.strategy_id === 'test_strategy').shadow_in_range, 24, 'a refusal leaves the stored count alone');
});

await test('held coins record when they were quoted, and a failed quote lets the age grow', async () => {
  const w = await holding();
  const quoted = w.clock.now;
  assert.strictEqual(w.account().v6_state.priceAt.ETHUSDT, quoted, 'a fill counts as priced on its tick');
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.priceAt.ETHUSDT, w.clock.now);
  const last = w.clock.now;
  w.hub.down = true;
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.priceAt.ETHUSDT, last, 'all venues down does not refresh it');
});

await test('worst drawdown is measured from the all-time high, and a re-enable rebase does not reset it', async () => {
  const w = await world({ gate: realGate });
  await w.run();
  const row = w.account();
  // A rebase moves the risk engine's equityHigh down to equity. The all-time high must not follow.
  const rebased = { ...row.v6_state, allTimeHigh: 12_500, riskState: { ...row.v6_state.riskState, equityHigh: 10_000, drawdown: 0 } };
  w.store.update('Portfolio', row.id, { v6_state: rebased });
  w.tick();
  await w.run();
  const state = w.account().v6_state;
  assert.strictEqual(state.allTimeHigh, 12_500);
  assert.strictEqual(state.worstDrawdownPct, -20);
  const points = w.store.list('V6EquityPoint', {}).sort((a, b) => a.t - b.t);
  assert.strictEqual(points.at(-1).drawdown_pct, -20);
});

console.log('\nV6 records on the server');

function ledgerStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-v6store-'));
  dirs.push(dir);
  const store = new EntityStore(dir);
  const v6 = store.create('Trade', { exchange: V6_TRADE_EXCHANGE, asset_symbol: 'ETHUSDT' });
  const old = store.create('Trade', { exchange: 'Paper Trading', asset_symbol: 'ETHUSDT' });
  const noExchange = store.create('Trade', { asset_symbol: 'ETHUSDT' });
  const row = store.create('Portfolio', { total_balance: 123, v6_ledger: { cash: 123 }, v6_state: { seq: 1 } });
  return { store, v6, old, noExchange, row };
}

await test('the store refuses any delete that reaches a V6 trade or ledger, and removes nothing', async () => {
  const { store, v6, row } = ledgerStore();
  const refused = (fn) => assert.throws(fn, (e) => e.status === 403);
  refused(() => store.delete('Trade', v6.id));
  refused(() => store.deleteMany('Trade', { asset_symbol: 'ETHUSDT' }));
  refused(() => store.deleteMany('TRADE', { asset_symbol: 'ETHUSDT' }));
  refused(() => store.delete('Portfolio', row.id));
  assert.strictEqual(store.list('Trade', {}).length, 3);
  assert.strictEqual(store.list('Portfolio', {}).length, 1);
});

await test('the scoped legacy delete removes legacy trades and keeps V6 trades', async () => {
  const { store, v6 } = ledgerStore();
  assert.strictEqual(store.deleteMany('Trade', { exchange: { $ne: V6_TRADE_EXCHANGE } }).count, 2);
  assert.deepStrictEqual(store.list('Trade', {}).map((t) => t.id), [v6.id]);
});

await test('the Trading page reset is scoped and stops before writing the portfolio', async () => {
  const src = readFileSync(path.join('src', 'pages', 'Trading.jsx'), 'utf8');
  assert.ok(!src.includes('Trade.deleteMany({})'));
  assert.ok(src.includes('Trade.deleteMany({ exchange: { $ne: V6_EXCHANGE } })'));
  const guard = src.indexOf('if (await v6RecordExists()) throw new Error(V6_RESET_REFUSED)');
  assert.ok(guard > 0 && guard < src.indexOf('base44.entities.Portfolio.update(portfolio.id, {\n          total_balance: paperBaseAmount'.replace('\n', src.includes('\r\n') ? '\r\n' : '\n')));
});

await test('a legacy reset keeps V6 trades, the ledger row and V6 entities', async () => {
  const { store, v6, row } = ledgerStore();
  store.create('V6RiskEvent', { code: 'kept' });
  const result = resetTradingData(store, {});
  assert.deepStrictEqual(store.list('Trade', {}).map((t) => t.id), [v6.id]);
  assert.strictEqual(store.get('Portfolio', row.id).total_balance, 123);
  assert.strictEqual(result.v6PortfoliosKept, 1);
  assert.strictEqual(store.list('V6RiskEvent', {}).length, 1);
});

await test('the entity API cannot write certificates or strategy state, in any letter case', async () => {
  for (const name of ['V6Certificate', 'V6StrategyState', 'v6certificate', 'V6STRATEGYSTATE']) assert.ok(entityApiReadOnly(name), name);
  assert.ok(!entityApiReadOnly('Trade'));
  const src = readFileSync(path.join('server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const route = src.indexOf("segments[1] === 'entities'");
  const guard = src.indexOf('assertEntityApiWrite(store, {');
  assert.ok(route > 0 && guard > route && guard < src.indexOf("if (req.method === 'POST' && tail === 'bulk')"), 'guard sits before every write route');
});

await test('no gate config can be written through v6Control and no app code can seal a certificate', async () => {
  for (const file of ['v6Engine/engine.js', 'v6Engine/entry.ts', 'v6Control/control.js', 'v6Control/entry.ts']) {
    const src = readFileSync(path.join('base44', 'functions', file), 'utf8');
    assert.ok(!src.includes('issueCertificate') && !src.includes('PASS_THROUGH_GATE'), file);
    assert.ok(!src.includes('DEFAULT_GATE_CONFIG'), file);
  }
});

// --- Review regressions. Each block is built from data/tmp/review-sec or review-core.

const entityFile = (w, name) => path.join(w.store.dir, `${name}.json`);
const silently = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};
// Damages a file on disk and restarts the store, as a crash or a bad edit would.
function damage(w, name, { dropGoodCopy = false } = {}) {
  writeFileSync(entityFile(w, name), '[{"id": "x", truncated');
  if (dropGoodCopy) rmSync(`${entityFile(w, name)}.good`, { force: true });
  const store = new EntityStore(path.dirname(w.store.dir));
  return { store, E: makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities };
}
const sells = (store) => store.list('Trade', {}).filter((t) => t.trade_type === 'sell');
const patchState = (w, patch) => {
  const a = w.account();
  w.store.update('Portfolio', a.id, { v6_state: { ...a.v6_state, ...patch } });
};
const config = (w) => w.store.list('V6Config', {})[0];
const openPosition = (w) => w.account().positions.length;

await test('an empty Portfolio file beside a full good copy is restored, and exits run', async () => {
  const w = await holding();
  const seq = w.account().v6_state.seq;
  await silently(async () => {
    writeFileSync(entityFile(w, 'Portfolio'), '[]');
    const store = new EntityStore(path.dirname(w.store.dir));
    const E = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
    w.hub.prices.ETHUSDT = 50;
    w.tick();
    const r = await w.run({ entities: E });
    assert.strictEqual(r.status, 'ran');
    assert.strictEqual(r.held, 0);
    const [row] = store.list('Portfolio', {});
    assert.strictEqual(row.v6_state.seq, seq + 1);
    assert.strictEqual(store.list('V6RiskEvent', {}).filter((e) => e.code === 'store_restored' && e.data?.why === 'empty').length, 1);
  });
});

await test('a deliberate delete stays deleted: both files are empty, so nothing comes back', async () => {
  const w = await world({ gate: realGate });
  const { store } = w;
  store.delete('Portfolio', w.account().id);
  const again = new EntityStore(path.dirname(store.dir));
  assert.deepStrictEqual(again.list('Portfolio', {}), []);
});

console.log('\nEngine state the outside cannot steer');

await test('only the engine\'s own rows drain from an outbox, and a bad entry stops nothing', async () => {
  const w = await holding();
  w.store.create('AutoTradingSettings', { id: 'arm', is_enabled: false });
  patchState(w, { outbox: [
    { entity: 'V6Certificate', id: 'forged', upsert: true, data: { strategy_id: 'test_strategy', status: 'valid' } },
    { entity: 'AutoTradingSettings', id: 'arm', upsert: true, data: { live_trading_enabled: true } },
    { entity: 'Trade', id: 'not-v6', data: { asset_symbol: 'ETHUSDT', exchange: 'Something else' } },
    { entity: 'bad name', id: 'x', upsert: true, data: {} },
    null,
  ] });
  w.hub.prices.ETHUSDT = 50;
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(r.held, 0, 'the stop must still fill');
  assert.ok(!w.store.get('V6Certificate', 'forged'));
  assert.strictEqual(w.store.get('AutoTradingSettings', 'arm').live_trading_enabled, undefined);
  assert.ok(!w.store.get('Trade', 'not-v6'));
  assert.strictEqual(w.riskEvents('outbox_rejected').length, 1);
});

await test('an outbox that is not a list raises the alarm and the cycle runs', async () => {
  const w = await holding();
  patchState(w, { outbox: 'poison' });
  w.tick();
  assert.strictEqual((await w.run()).status, 'ran');
  assert.strictEqual(w.riskEvents('outbox_rejected').length, 1);
});

await test('a lease the engine could not have written is ignored, whichever process it names', async () => {
  const w = await holding();
  for (const lease of [{ pid: 4, at: 0, until: 4e12 }, { pid: 'x', until: w.clock.now + 1000 }, { pid: 4, until: Infinity }, 'junk']) {
    w.store.update('V6Config', config(w).id, { engine_lease: lease });
    w.tick();
    assert.strictEqual((await w.run({ isAlive: () => true })).status, 'ran', JSON.stringify(lease));
  }
  assert.ok(w.riskEvents('lease_invalid').length >= 1);
});

await test('a lease inside its bounds from a live process is still respected', async () => {
  const w = await holding();
  w.tick();
  w.store.update('V6Config', config(w).id, { engine_lease: { pid: 4, at: w.clock.now, until: w.clock.now + 60_000 } });
  assert.strictEqual((await w.run({ isAlive: () => true })).status, 'skipped');
});

await test('negative cash on the row cannot stop an exit, and the ledger is put back', async () => {
  const w = await holding();
  const cash = w.account().available_balance;
  w.store.update('Portfolio', w.account().id, { available_balance: -1 });
  w.hub.prices.ETHUSDT = 50;
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(r.held, 0);
  assert.ok(w.account().available_balance > cash, 'cash comes from the engine record plus the sale');
  assertReconciled(w);
});

await test('a balance edit is undone, and its alarm holds entries until acknowledged', async () => {
  const w = await holding({ symbols: ['ETHUSDT'] });
  const before = w.account().available_balance;
  w.store.update('Portfolio', w.account().id, { available_balance: 900_000, total_balance: 900_000 });
  w.tick();
  assert.strictEqual((await w.run()).cashCode, 'foreign_change');
  assert.strictEqual(w.account().available_balance, before, 'the edit must not become the balance');
  for (let i = 0; i < 3; i++) {
    w.tick();
    assert.strictEqual((await w.run()).cashCode, 'foreign_change', 'the row looks clean now, and the alarm must stay');
  }
  w.store.update('V6Config', config(w).id, { foreign_ack_request: { id: 'ack1' } });
  w.tick();
  assert.notStrictEqual((await w.run()).cashCode, 'foreign_change');
  assert.strictEqual(config(w).foreign_ack_request, null);
});

await test('an edit that arrives with the acknowledgement keeps the alarm up', async () => {
  const w = await holding();
  w.store.update('Portfolio', w.account().id, { total_trades: 77 });
  w.tick();
  await w.run();
  w.store.update('Portfolio', w.account().id, { total_trades: 78 });
  w.store.update('V6Config', config(w).id, { foreign_ack_request: { id: 'ack2' } });
  w.tick();
  assert.strictEqual((await w.run()).cashCode, 'foreign_change');
});

await test('a second Portfolio row raises the alarm and blocks entries, and V6 stays on its account', async () => {
  const w = await holding();
  const mine = w.account();
  w.store.create('Portfolio', { id: 'evil', created_date: '2099-01-01T00:00:00.000Z', available_balance: 777, total_balance: 777, positions: [], v6_ledger: { capital: 777 }, v6_state: { ...mine.v6_state, seq: 9999 } });
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.cashCode, 'multiple_portfolios');
  assert.strictEqual(r.seq, mine.v6_state.seq + 1, 'the engine must not move to the newer row');
  assert.strictEqual(w.store.get('Portfolio', 'evil').v6_state.seq, 9999);
  assert.strictEqual(config(w).portfolio_id, mine.id);
});

await test('cutover is refused while more than one Portfolio row exists', async () => {
  const w = await world();
  w.store.create('Portfolio', { available_balance: 5, total_balance: 5, positions: [] });
  const r = await w.run();
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(r.code, 'multiple_portfolios');
});

await test('a lost v6_state does not re-cut-over: it stops, and only the operator action restarts it', async () => {
  const w = await world();
  await w.run();
  const a = w.account();
  w.store.update('Portfolio', a.id, { v6_state: null, v6_ledger: null });
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.status, 'stopped');
  assert.strictEqual(r.code, 'state_missing');
  assert.strictEqual(w.account().v6_state, null);
  w.store.update('V6Config', config(w).id, { recutover_request: { id: 'rc', by: 'operator' } });
  w.tick();
  assert.strictEqual((await w.run()).status, 'ran');
  assert.ok(w.account().v6_state);
  assert.strictEqual(config(w).recutover_request, null);
});

console.log('\nDamaged files');

await test('a corrupt Portfolio is restored from its good copy, exits run, entries wait for an acknowledgement', async () => {
  const w = await holding();
  const seq = w.account().v6_state.seq;
  const { store, E } = damage(w, 'Portfolio');
  w.hub.prices.ETHUSDT = 95;
  w.tick();
  const r = await silently(() => w.run({ entities: E }));
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(r.seq, seq + 1, 'never a fresh account');
  assert.strictEqual(r.held, 1);
  assert.strictEqual(r.cashCode, 'store_restored');
  const events = store.list('V6RiskEvent', {}).filter((e) => e.type === 'store_restored');
  assert.strictEqual(events.length, 1, 'one event to acknowledge, not one per tick');
  const [event] = events;
  assert.strictEqual(event.severity, 'critical');
  store.update('V6RiskEvent', event.id, { acked_at: new Date().toISOString() });
  w.tick();
  assert.notStrictEqual((await w.run({ entities: E })).cashCode, 'store_restored');
});

await test('a corrupt Portfolio with no good copy stops for a human and never reads as an empty account', async () => {
  const w = await holding();
  const { store, E } = damage(w, 'Portfolio', { dropGoodCopy: true });
  w.tick();
  const r = await silently(() => w.run({ entities: E }));
  assert.strictEqual(r.status, 'stopped');
  assert.strictEqual(r.code, 'portfolio_unreadable');
  assert.throws(() => store.list('Portfolio', {}), /unreadable/);
  assert.throws(() => store.create('Portfolio', { available_balance: 1 }), /unreadable/);
  assert.ok(readFileSync(entityFile(w, 'Portfolio'), 'utf8').includes('truncated'), 'the damaged file stays for repair');
  assert.strictEqual(store.list('V6RiskEvent', {}).filter((e) => e.code === 'portfolio_unreadable').length, 1);
});

await test('a deleted Portfolio file with its good copy gone stops; it does not start a new account', async () => {
  const w = await holding();
  rmSync(entityFile(w, 'Portfolio'));
  rmSync(`${entityFile(w, 'Portfolio')}.good`);
  const store = new EntityStore(path.dirname(w.store.dir));
  const E = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
  w.tick();
  const r = await w.run({ entities: E });
  assert.strictEqual(r.code, 'portfolio_missing');
  assert.strictEqual(store.list('Portfolio', {}).length, 0);
});

for (const name of ['V6Certificate', 'AutoTradingSettings', 'V6Config', 'V6EquityPoint', 'V6RiskEvent', 'V6StrategyState', 'Trade']) {
  await test(`an unreadable ${name} with no good copy holds entries and the stop still fills`, async () => {
    const w = await holding();
    if (name === 'V6EquityPoint' || name === 'V6RiskEvent' || name === 'Trade') w.store.create(name, { id: 'seed' });
    const { store, E } = damage(w, name, { dropGoodCopy: true });
    w.hub.prices.ETHUSDT = 50;
    w.tick();
    const r = await silently(() => w.run({ entities: E }));
    assert.strictEqual(r.status, 'ran');
    assert.strictEqual(r.held, 0, 'the position must close');
    assert.strictEqual(store.list('Portfolio', {})[0].positions.length, 0);
    // The first tick finds a damaged log only when it writes, so the next one holds entries.
    w.tick();
    const next = await silently(() => w.run({ entities: E }));
    assert.strictEqual(next.status, 'ran');
    assert.strictEqual(next.cashCode, 'store_unreadable');
    assert.strictEqual(next.held, 0, 'nothing new while a file is damaged');
    assert.ok(store.list('Portfolio', {})[0].v6_state.lastCycle.store_faults.length >= 1);
  });
}

await test('rows that could not be written are kept and land once the file is repaired', async () => {
  const w = await holding();
  w.store.create('Trade', { id: 'seed' });
  const { store, E } = damage(w, 'Trade');
  w.hub.prices.ETHUSDT = 50;
  w.tick();
  await silently(() => w.run({ entities: E }));
  assert.strictEqual(store.list('Portfolio', {})[0].v6_state.outbox.filter((o) => o.entity === 'Trade').length, 1);
  writeFileSync(entityFile(w, 'Trade'), '[]');
  w.tick();
  await silently(() => w.run({ entities: E }));
  assert.strictEqual(sells(store).length, 1);
  assert.strictEqual(store.list('Portfolio', {})[0].v6_state.outbox.length, 0);
});

await test('a file holding valid JSON that is not a list counts as damaged', async () => {
  const w = await world();
  writeFileSync(entityFile(w, 'CommitteeDecision'), '{"not":"a list"}');
  const store = new EntityStore(path.dirname(w.store.dir));
  await silently(async () => assert.throws(() => store.list('CommitteeDecision', {}), /unreadable/));
});

await test('lost strategy state resolves to shadow and never promotes', async () => {
  const w = await holding();
  rmSync(entityFile(w, 'V6StrategyState'));
  rmSync(`${entityFile(w, 'V6StrategyState')}.good`);
  const store = new EntityStore(path.dirname(w.store.dir));
  const E = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
  w.tick();
  await w.run({ entities: E });
  const row = store.list('V6StrategyState', {})[0];
  assert.strictEqual(row.lifecycle, 'shadow');
  assert.strictEqual(row.size_multiplier, 0);
  assert.strictEqual(store.list('V6RiskEvent', {}).filter((e) => e.code === 'strategy_state_lost').length, 1);
  const full = { ...row, forward_series: [], forward_trades: 0, shadow_series: [], shadow_book: [] };
  assert.strictEqual(realGate.advanceLifecycle(full, { strategy: w.strategies[0], certificate: null, t: w.clock.now }).state.lifecycle, 'shadow');
});

await test('a shadow strategy stays in shadow when its row reappears as something better', async () => {
  const w = await holding();
  const row = w.store.list('V6StrategyState', {})[0];
  w.store.update('V6StrategyState', row.id, { lifecycle: 'shadow', size_multiplier: 0 });
  w.tick();
  await w.run();
  w.store.update('V6StrategyState', row.id, { lifecycle: 'paper_full', size_multiplier: 1 });
  w.tick();
  await w.run();
  assert.strictEqual(w.store.list('V6StrategyState', {})[0].lifecycle, 'shadow');
});

await test('a strategy certified after cutover starts normally: only state that existed can be lost', async () => {
  const w = await certifiedWorld();
  await w.run();
  const late = { ...testStrategy(), id: 'late_strategy' };
  w.strategies.push(late);
  w.tick();
  await w.run();
  assert.strictEqual(w.riskEvents('strategy_state_lost').length, 0);
});

console.log('\nExits whatever the entry state');

const flatSignalStrategy = (flag) => ({
  ...testStrategy(),
  signals(ctx) { return ctx.universe.map((s) => (flag.flat ? { symbol: s, side: 'flat', reason: 'test flat' } : longSignal(s))); },
});

const exitBlockers = {
  'legacy on': (w) => w.store.update('AutoTradingSettings', w.store.list('AutoTradingSettings', {})[0].id, { is_enabled: true }),
  'certificate gone': (w) => { for (const c of w.store.list('V6Certificate', {})) w.store.delete('V6Certificate', c.id); },
  'operator off': (w) => w.store.update('V6Config', config(w).id, { strategies: { test_strategy: { operator_enabled: false } } }),
  'balance edit': (w) => w.store.update('Portfolio', w.account().id, { total_trades: 77 }),
  'gate missing': (w) => { w.gateModule = null; },
};

for (const [name, block] of Object.entries(exitBlockers)) {
  await test(`a signal exit still fires with ${name}`, async () => {
    const flag = { flat: false };
    const w = await certifiedWorld({ world: { strategy: flatSignalStrategy(flag) } });
    assert.strictEqual((await w.run()).held, 1);
    block(w);
    flag.flat = true;
    w.clock.now += DAY;
    const r = await w.run();
    assert.strictEqual(r.held, 0, 'the strategy said flat, and the position must close');
    assert.strictEqual(sells(w.store)[0].reason_code ?? sells(w.store)[0].exit_reason_code, 'signal_exit');
  });

  await test(`regime is still read for held positions with ${name}`, async () => {
    const w = await holding();
    block(w);
    w.clock.now += DAY;
    await w.run();
    assert.ok(w.account().v6_state.regime['1d'], 'no regime means the regime exit can never fire');
  });
}

await test('a strategy blocked from entering can close a position but cannot open one', async () => {
  const w = await holding();
  exitBlockers['operator off'](w);
  const flat = w.strategies[0];
  w.strategies[0] = { ...flat, signals: (ctx) => ctx.universe.map((s) => ({ symbol: s, side: 'short', score: 1, stopDistancePct: 0.1, exitProfile: 'trend', reason: 'test reversal' })) };
  w.clock.now += DAY;
  const r = await w.run();
  assert.ok(r.held === 0 || w.account().positions[0].position_side !== 'short');
  assert.strictEqual(w.trades().filter((t) => t.trade_type === 'sell' && t.profit_loss === undefined).length, 0, 'no short entry');
});

console.log('\nPrices without consensus');

const noConsensus = (w, price) => {
  const real = w.hub.consensusPrice;
  w.hub.consensusPrice = async (s) => (s === 'ETHUSDT' ? { price, ok: false, reason: 'venues_disagree', venues: ['okx'], spreadPct: 99 } : real(s));
  return () => { w.hub.consensusPrice = real; };
};

await test('an unconfirmed print neither fires a stop nor moves the mark', async () => {
  const w = await holding();
  const mark = position(w).current_price ?? position(w).v6.lastPrice;
  noConsensus(w, 50);
  w.wicks.ETHUSDT = [{ t: w.clock.now, o: 100, h: 100, l: 50, c: 50 }];
  w.tick();
  const r = await w.run();
  assert.strictEqual(r.held, 1, 'one venue saying 50 must not sell the position');
  assert.strictEqual(position(w).v6.lastPrice, mark);
  assert.strictEqual(w.riskEvents('no_consensus').length, 1);
});

const pastTheBound = async (w) => { for (let i = 0; i < 6; i++) { w.tick(); await w.run(); } };

await test('past the bound a low print with a healthy book sells nothing', async () => {
  const w = await holding();
  const stop = position(w).v6.stopPrice;
  noConsensus(w, 50);
  await pastTheBound(w);
  assert.strictEqual(w.account().positions.length, 1);
  assert.strictEqual(sells(w.store).length, 0);
  assert.strictEqual(position(w).v6.stopPrice, stop);
  assert.strictEqual(w.riskEvents('no_consensus_long').length, 1);
});

await test('past the bound a high print moves no stop and no equity high, and the next tick sells nothing', async () => {
  const w = await holding();
  const before = position(w).v6;
  const { allTimeHigh, riskState: { equityHigh } } = w.account().v6_state;
  const restore = noConsensus(w, 300);
  await pastTheBound(w);
  assert.strictEqual(position(w).v6.stopPrice, before.stopPrice);
  assert.ok(position(w).v6.lastPrice <= before.lastPrice);
  assert.strictEqual(w.account().v6_state.allTimeHigh, allTimeHigh);
  assert.strictEqual(w.account().v6_state.riskState.equityHigh, equityHigh);
  restore();
  w.tick();
  await w.run();
  assert.strictEqual(sells(w.store).length, 0);
});

await test('a real crash with no consensus exits on the book, priced from the book', async () => {
  const w = await holding();
  const start = w.clock.now;
  w.hub.prices.ETHUSDT = 50;
  noConsensus(w, 45);
  for (let i = 1; i <= 6 && w.account().positions.length; i++) { w.tick(); await w.run(); }
  assert.strictEqual(w.account().positions.length, 0);
  assert.ok(w.clock.now - start <= NO_CONSENSUS_MAX_MS + 2 * FIVE_MIN_MS, 'exits promptly');
  const [sold] = sells(w.store);
  assert.ok(sold.price > 45 && sold.price <= 50, `filled at ${sold.price}, the print was 45 and the book 50`);
});

// Every third answer agrees at 95, above the stop, while the book sits wherever the test puts it.
const flapping = (w, every = 3) => {
  const real = w.hub.consensusPrice;
  let i = 0;
  w.hub.consensusPrice = async (s) => {
    if (s !== 'ETHUSDT') return real(s);
    return ++i % every === 0 ? { price: 95, ok: true, reason: null } : { price: 60, ok: false, reason: 'venues_disagree' };
  };
};
const flatAt = (w, px) => { w.wicks.ETHUSDT = (from, to) => [{ t: to - FIVE_MIN_MS, o: px, h: px, l: px, c: px }]; };

await test('an ok tick does not reset the bound: the book crossed the stop, so the exit comes on time', async () => {
  const w = await holding();
  const start = w.clock.now;
  w.hub.prices.ETHUSDT = 60;
  flatAt(w, 95);
  flapping(w);
  for (let i = 0; i < 12 && w.account().positions.length; i++) { w.tick(); await w.run(); }
  assert.strictEqual(w.account().positions.length, 0);
  assert.ok(w.clock.now - start <= NO_CONSENSUS_MAX_MS + 2 * FIVE_MIN_MS, `closed after ${(w.clock.now - start) / 60000} minutes`);
  assert.ok(sells(w.store)[0].price <= 60, 'priced from the book');
  assert.deepStrictEqual(w.account().v6_state.bookCrossSince, {});
});

await test('a brief safe-side book does not restart the bound: book 60 with 91 every third tick still exits', async () => {
  for (const every of [3, 4]) {
    const w = await holding();
    const start = w.clock.now;
    const stop = position(w).v6.stopPrice;
    assert.ok(stop > 60 && stop < 91);
    flatAt(w, 95);
    noConsensus(w, 95);
    let i = 0;
    for (let k = 0; k < 12 && w.account().positions.length; k++) {
      w.hub.prices.ETHUSDT = ++i % every === 0 ? 91 : 60;
      w.tick();
      await w.run();
    }
    assert.strictEqual(w.account().positions.length, 0, `every ${every}`);
    assert.ok(w.clock.now - start <= NO_CONSENSUS_MAX_MS + 3 * FIVE_MIN_MS, `closed after ${(w.clock.now - start) / 60000} minutes`);
    assert.ok(sells(w.store)[0].price <= 60, 'priced from the book');
    assert.deepStrictEqual(w.account().v6_state.bookSafeSince, {});
  }
});

await test('the book safe for a whole bound ends it, and a new cross starts it again', async () => {
  const w = await holding();
  flatAt(w, 95);
  flapping(w);
  w.hub.prices.ETHUSDT = 60;
  w.tick();
  await w.run();
  const first = w.account().v6_state.bookCrossSince.ETHUSDT;
  assert.ok(first > 0, 'the cross starts the clock');
  w.tick();
  await w.run();
  w.tick();
  await w.run(); // the ok tick
  assert.strictEqual(w.account().v6_state.bookCrossSince.ETHUSDT, first, 'ok ticks do not touch it');
  w.hub.prices.ETHUSDT = 100;
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.bookCrossSince.ETHUSDT, first, 'one safe book does not clear it');
  for (let i = 0; i < 3; i++) { w.tick(); await w.run(); }
  assert.strictEqual(w.account().v6_state.bookCrossSince.ETHUSDT, undefined, 'a whole bound on the safe side clears it');
  assert.deepStrictEqual(w.account().v6_state.bookSafeSince, {});
  assert.strictEqual(w.account().positions.length, 1);
  w.hub.prices.ETHUSDT = 60;
  w.tick();
  await w.run();
  assert.ok(w.account().v6_state.bookCrossSince.ETHUSDT > first);
  assert.strictEqual(w.account().positions.length, 1, 'the bound starts over');
});

await test('losing the book does not end the bound', async () => {
  const w = await holding();
  flatAt(w, 95);
  noConsensus(w, 60);
  w.hub.prices.ETHUSDT = 60;
  w.tick();
  await w.run();
  const first = w.account().v6_state.bookCrossSince.ETHUSDT;
  w.hub.noBook = true;
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.bookCrossSince.ETHUSDT, first);
});

await test('no consensus and no book: alarm, then exit at the worst quote, and the event says so', async () => {
  const w = await holding();
  const real = w.hub.consensusPrice;
  w.hub.consensusPrice = async (s) => (s === 'ETHUSDT' ? { price: 60, ok: false, reason: 'venues_disagree', quotes: [{ venue: 'okx', price: 60 }, { venue: 'bybit', price: 55 }] } : real(s));
  w.hub.noBook = true;
  await pastTheBound(w);
  assert.strictEqual(w.account().positions.length, 0);
  assert.ok(w.riskEvents('no_consensus_no_book').length >= 1);
  const [sold] = sells(w.store);
  assert.ok(sold.price <= 55 && sold.price > 50, `filled at ${sold.price}`);
  const [told] = w.riskEvents('exit_worst_quote');
  assert.ok(told.message.includes('worst price any venue reported') && told.message.includes('55'));
});

await test('no book and a high print: no ratchet, no sale', async () => {
  const w = await holding();
  const before = position(w).v6;
  noConsensus(w, 300);
  w.hub.noBook = true;
  await pastTheBound(w);
  assert.strictEqual(w.account().positions.length, 1);
  assert.strictEqual(position(w).v6.stopPrice, before.stopPrice);
  assert.strictEqual(position(w).v6.lastPrice, before.lastPrice);
});

await test('a wick inside the unconfirmed window is read back as soon as consensus returns', async () => {
  const w = await holding();
  const windowStart = w.clock.now;
  const stop = position(w).v6.stopPrice;
  assert.ok(stop > 70);
  const wickAt = windowStart + FIVE_MIN_MS;
  w.wicks.ETHUSDT = (from, to) => [{ t: wickAt, o: 100, h: 100, l: 70, c: 100 }, { t: to - FIVE_MIN_MS, o: 100, h: 100, l: 100, c: 100 }].filter((b) => b.t + FIVE_MIN_MS > from);
  const restore = noConsensus(w, 70);
  for (let i = 0; i < 2; i++) { w.tick(); await w.run(); }
  assert.strictEqual(w.account().positions.length, 1, 'held while unconfirmed');
  restore();
  w.tick();
  await w.run();
  assert.strictEqual(w.account().positions.length, 0, 'sold on the first confirmed tick');
  assert.ok(sells(w.store)[0].price <= stop);
  assert.deepStrictEqual(w.account().v6_state.wickFrom, {});
});

await test('a window with no wick in it costs nothing once read back', async () => {
  const w = await holding();
  const restore = noConsensus(w, 70);
  for (let i = 0; i < 2; i++) { w.tick(); await w.run(); }
  restore();
  w.tick();
  await w.run();
  assert.strictEqual(w.account().positions.length, 1);
  assert.deepStrictEqual(w.account().v6_state.wickFrom, {});
});

await test('the bound ending with venues still apart does not make a wick evidence', async () => {
  const w = await holding();
  w.wicks.ETHUSDT = [{ t: w.clock.now, o: 100, h: 100, l: 50, c: 100 }];
  noConsensus(w, 50);
  await pastTheBound(w);
  assert.strictEqual(w.account().positions.length, 1, 'the book is at 100');
});

await test('a held coin whose strategy code is gone raises an event, and its stop still runs', async () => {
  const w = await holding();
  w.strategies = [];
  w.tick();
  await w.run();
  const [told] = w.riskEvents('strategy_code_missing');
  assert.ok(told.message.includes('signal exits cannot run'));
  w.hub.prices.ETHUSDT = 50;
  w.tick();
  assert.strictEqual((await w.run()).held, 0);
});

await test('a fallen book closes the position once the bound passes, so an exit never waits longer than that', async () => {
  const w = await holding();
  noConsensus(w, 50);
  w.hub.book = async () => ({ t: w.clock.now, bids: [[50, 1e6]], asks: [[50.1, 1e6]] });
  let at = null;
  const start = w.clock.now;
  for (let i = 1; i <= 6 && at === null; i++) {
    w.tick();
    if ((await w.run()).held === 0) at = w.clock.now - start;
  }
  assert.ok(at !== null, 'the position must close');
  assert.ok(at <= NO_CONSENSUS_MAX_MS + 2 * FIVE_MIN_MS, `closed after ${at / 60000} minutes`);
  assert.strictEqual(w.riskEvents('no_consensus_long').length, 1);
});

await test('agreement before the bound clears the count', async () => {
  const w = await holding();
  const restore = noConsensus(w, 50);
  w.tick();
  await w.run();
  restore();
  w.tick();
  await w.run();
  assert.deepStrictEqual(w.account().v6_state.noConsensusSince, {});
});

await test('a real crash, with every venue agreeing, exits on the same tick', async () => {
  const w = await holding();
  w.hub.prices.ETHUSDT = 50;
  w.tick();
  assert.strictEqual((await w.run()).held, 0);
});

console.log('\nStops moved inside a bar');

await test('a wick below a stop moved during the bar is passed on as what came after', async () => {
  const seen = [];
  const inner = { evaluateExit: (a) => { seen.push(a); return { action: 'hold' }; } };
  const position = { symbol: 'ETHUSDT', side: 'long' };
  rangedExits(inner, new Map([['ETHUSDT', { low: 88, high: 103 }]]), new Set()).evaluateExit({ position, bar: { l: 95, h: 101 } });
  assert.deepStrictEqual(seen[0].after, { h: 103, l: 88 });
  assert.strictEqual(seen[0].bar.l, 88);
});

console.log('\nQuarantined rows');

const brokenRow = { asset_symbol: 'BADUSDT', quantity: -1, avg_entry_price: 1 };

await test('a quarantined row raises its own alarm every hour, holds entries, and survives the commit', async () => {
  const w = await holding();
  const a = w.account();
  const positions = [...a.positions, brokenRow];
  w.store.update('Portfolio', a.id, { positions, v6_state: { ...a.v6_state, record: { ...a.v6_state.record, positions } } });
  w.tick();
  const r = await w.run();
  const alarms = () => w.riskEvents('position_quarantined').filter((e) => e.type === 'alarm');
  assert.strictEqual(r.cashCode, 'position_quarantined');
  assert.strictEqual(alarms().length, 1);
  assert.strictEqual(alarms()[0].severity, 'critical');
  assert.ok(w.account().positions.some((p) => p.asset_symbol === 'BADUSDT'), 'written back as it came');
  w.clock.now += 3_600_000 + 1;
  await w.run();
  assert.strictEqual(alarms().length, 2);
});

await test('a quarantined row counts as open, so a human re-enable cannot treat the account as flat', async () => {
  const src = readFileSync(new URL('../base44/functions/v6Engine/engine.js', import.meta.url), 'utf8');
  const sites = src.match(/openPositions: [^,}]+/g);
  assert.ok(sites.length >= 3);
  for (const s of sites) assert.match(s, /quarantined/);
});

await test('quarantine alarms on the first run too, where other adoption warnings are ignored', async () => {
  const w = await world({ portfolio: { available_balance: 10_000, total_balance: 10_000, positions_value: 0, positions: [null], total_trades: 0, total_profit_loss: 0 } });
  const r = await w.run();
  assert.strictEqual(r.status, 'ran');
  assert.strictEqual(w.riskEvents('position_quarantined').filter((e) => e.type === 'alarm').length, 1);
  assert.strictEqual(w.account().v6_state.quarantined.length, 1);
  const status = await handleControl({ entities: w.E, body: { action: 'status' }, user: { email: 'x' }, now: w.clock.now });
  assert.strictEqual(status.quarantinedPositions.length, 1, 'status must show it');
  assert.strictEqual(status.positions.length, 0, 'and must not try to format it');
  assert.strictEqual(status.risk.canEnter, false);
});

console.log('\nGaps and memory');

await test('a stop touched in a gap the 5-minute reader cannot reach still fires, and says so', async () => {
  const w = await holding();
  const stop = position(w).trailing_stop_price;
  const realBars = w.hub.bars;
  // The reader serves its last hundred bars only; the touch is on a daily bar before them.
  w.wicks.ETHUSDT = [{ t: w.clock.now + 3 * DAY - 100 * FIVE_MIN_MS, o: 100, h: 101, l: 99, c: 100 }];
  w.hub.bars = async (s, tf, n, o) => {
    const bars = await realBars(s, tf, n, o);
    if (s !== 'ETHUSDT' || tf !== '1d') return bars;
    return bars.map((b, i) => (i === bars.length - 2 ? { ...b, l: 70 } : { ...b, l: Math.max(b.l, stop + 1) }));
  };
  w.barCache.clear();
  w.clock.now += 3 * DAY;
  const r = await w.run();
  assert.strictEqual(r.held, 0, 'the stop was touched during the outage');
  assert.ok(sells(w.store)[0].price <= stop, 'filled no better than the stop');
  assert.strictEqual(w.riskEvents('gap_fill').length, 1);
  assert.strictEqual(w.riskEvents('gap_coarse').length, 1);
});

await test('a gap never sells on a low from before the stop was ratcheted', async () => {
  const w = await holding();
  const entered = w.clock.now;
  for (const price of [112, 125, 138, 150]) {
    w.hub.prices.ETHUSDT = price;
    w.clock.now += 4 * 3_600_000;
    await w.run();
  }
  const stop = position(w).trailing_stop_price;
  assert.ok(stop > 120, 'setup: the stop has ratcheted');
  const realBars = w.hub.bars;
  // The bar holding the ratchet dipped early, below today's stop but above the one it began with.
  w.hub.bars = async (s, tf, n, o) => {
    const bars = await realBars(s, tf, n, o);
    return s === 'ETHUSDT' && tf === '1d' ? bars.map((b, i) => (i === bars.length - 1 ? { ...b, o: 100, h: 151, l: 99, c: 148 } : b)) : bars;
  };
  w.barCache.clear();
  w.hub.prices.ETHUSDT = 148;
  w.clock.now = entered - (entered % DAY) + DAY + 7 * 60_000;
  w.wicks.ETHUSDT = [{ t: w.clock.now - FIVE_MIN_MS, o: 148, h: 148, l: 147.5, c: 148 }];
  assert.strictEqual((await w.run()).held, 1, 'the market is at 148, far above the stop');
  assert.strictEqual(w.riskEvents('gap_fill').length, 0);
});

// A window that spans a daily close: the stop moves inside it, on a closed bar.
const windowOverAClose = async () => {
  const w = await holding();
  const close = w.clock.now - (w.clock.now % DAY) + DAY;
  flatAt(w, 130);
  for (const [price, hours] of [[112, 6], [120, 10], [130, 14]]) {
    w.hub.prices.ETHUSDT = price;
    w.clock.now = close - DAY + hours * 3_600_000;
    await w.run();
  }
  w.clock.now = close - 30 * 60_000;
  await w.run();
  const before = position(w).v6.stopPrice;
  const restore = noConsensus(w, 160);
  w.clock.now = close - 25 * 60_000;
  await w.run();
  w.clock.now = close - 20 * 60_000;
  await w.run();
  w.hub.prices.ETHUSDT = 170;
  const realBars = w.hub.bars;
  w.hub.bars = async (s, tf, n, o) => {
    const bars = await realBars(s, tf, n, o);
    return s === 'ETHUSDT' && tf === '1d' ? bars.map((b, i) => (i === bars.length - 1 ? { ...b, o: 100, h: 175, l: 99.5, c: 170 } : b)) : bars;
  };
  w.barCache.clear();
  w.clock.now = close + 7 * 60_000;
  await w.run();
  const after = position(w).v6.stopPrice;
  assert.ok(after > before, `setup: the close moved the stop, ${before} to ${after}`);
  const low = (at) => { w.wicks.ETHUSDT = (from, to) => [{ t: close - 20 * 60_000, o: 170, h: 170, l: at, c: 170 }, { t: to - FIVE_MIN_MS, o: 170, h: 170, l: 170, c: 170 }]; };
  return { w, before, after, restore, low };
};

await test('read-back: a low under today\'s stop but above the stop of its time sells nothing', async () => {
  const { w, before, after, restore, low } = await windowOverAClose();
  low((before + after) / 2);
  restore();
  w.tick();
  assert.strictEqual((await w.run()).held, 1);
  assert.strictEqual(sells(w.store).length, 0);
});

await test('read-back: a low through the stop of its time sells, priced from that stop', async () => {
  const { w, before, restore, low } = await windowOverAClose();
  low(before - 2);
  restore();
  w.tick();
  assert.strictEqual((await w.run()).held, 0);
  assert.ok(sells(w.store)[0].price <= before, `filled at ${sells(w.store)[0].price}, the stop then was ${before}`);
});

await test('every sample meets the stop of its own time, and an unknown time tests nothing', async () => {
  const position = { side: 'long', stopPrice: 134, stopSetAt: 1000, entryTime: 100, stopLog: [{ t: 100, stop: 90 }, { t: 500, stop: 113 }, { t: 1000, stop: 134 }] };
  const sample = (t, l) => ({ t, o: 170, h: 170, l, c: 170 });
  assert.strictEqual(wickSummary(position, []), null);
  assert.strictEqual(wickSummary(position, [sample(600, 126)]).low, null, 'above the 113 of its time');
  assert.strictEqual(wickSummary(position, [sample(200, 100)]).low, null, 'above the 90 of its time');
  assert.strictEqual(wickSummary(position, [sample(600, 110)]).touchStop, 113);
  assert.strictEqual(wickSummary(position, [sample(1100, 130)]).touchStop, 134);
  const mixed = wickSummary(position, [sample(600, 126), sample(1100, 130)]);
  assert.strictEqual(mixed.low, 130, 'a low that touched nothing is not carried along');
  assert.strictEqual(wickSummary(position, [sample(50, 1)]).low, null, 'older than anything known');
  const short = { side: 'short', stopPrice: 70, stopSetAt: 1000, stopLog: [{ t: 100, stop: 90 }, { t: 1000, stop: 70 }] };
  assert.strictEqual(wickSummary(short, [{ t: 600, o: 60, h: 80, l: 60, c: 60 }]).high, null);
  assert.strictEqual(wickSummary(short, [{ t: 50, o: 60, h: 99, l: 60, c: 60 }]).high, null, 'unknown on the short side too');
  assert.strictEqual(wickSummary(short, [{ t: 1100, o: 60, h: 71, l: 60, c: 60 }]).touchStop, 70);
});

await test('a range with no touch reaches the exit module as the plain bar', async () => {
  const seen = [];
  const inner = { evaluateExit: (a) => { seen.push(a); return { action: 'hold' }; } };
  const summary = { low: null, high: null, touchOpen: null, touchStop: null, coarseTouch: false };
  rangedExits(inner, new Map([['ETHUSDT', summary]]), new Set()).evaluateExit({ position: { symbol: 'ETHUSDT', side: 'long' }, bar: { l: 95, h: 101 } });
  assert.strictEqual(seen[0].bar.l, 95);
  assert.strictEqual(seen[0].after, undefined);
});

await test('a gap with no touch leaves the position alone', async () => {
  const w = await holding();
  w.wicks.ETHUSDT = [{ t: w.clock.now + DAY - 100 * FIVE_MIN_MS, o: 100, h: 101, l: 99, c: 100 }];
  w.clock.now += DAY;
  assert.strictEqual((await w.run()).held, 1);
  assert.strictEqual(w.riskEvents('gap_fill').length, 0);
});

await test('the reader pages back through a whole outage, and a normal tick costs one request', async () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const urls = [];
  // okx serves 100 bars older than 'after', newest first.
  const fetchImpl = async (url) => {
    urls.push(url);
    const end = Number(new URL(url).searchParams.get('after'));
    const limit = Number(new URL(url).searchParams.get('limit'));
    const rows = Array.from({ length: limit }, (_, i) => {
      const t = end - (i + 1) * FIVE_MIN_MS;
      return [t, 100, 100, t === now - 30 * 3_600_000 ? 70 : 99, 100];
    });
    return new Response(JSON.stringify({ data: rows }));
  };
  const read = createIntrabarReader({ fetchImpl, now: () => now });
  const bars = await read('ETHUSDT', now - 40 * 3_600_000, now);
  assert.ok(bars[0].t <= now - 40 * 3_600_000 + FIVE_MIN_MS, 'reaches the start of the gap');
  assert.strictEqual(Math.min(...bars.map((b) => b.l)), 70);
  assert.strictEqual(new Set(bars.map((b) => b.t)).size, bars.length);
  urls.length = 0;
  await read('ETHUSDT', now - FIVE_MIN_MS, now);
  assert.strictEqual(urls.length, 1);
});

await test('a closed position leaves no missing-quote memory behind', async () => {
  const w = await holding();
  w.hub.silent.add('ETHUSDT');
  w.tick();
  await w.run();
  assert.ok(w.account().v6_state.noQuoteSince.ETHUSDT);
  w.wicks.ETHUSDT = [{ t: w.clock.now, o: 80, h: 80, l: 70, c: 75 }];
  w.tick();
  assert.strictEqual((await w.run()).held, 0);
  assert.deepStrictEqual(w.account().v6_state.noQuoteSince, {});
});

await test('entity names in any case reach one cache and one file', async () => {
  const w = await world();
  const { store } = w;
  store.list('tRADE', {});
  store.create('Trade', { id: 't1' });
  assert.strictEqual(store.list('TRADE', {}).length, 1);
  store.deleteMany('tRaDe', { id: 'nomatch' });
  assert.strictEqual(JSON.parse(readFileSync(entityFile(w, 'Trade'), 'utf8')).length, 1);
  assert.strictEqual(store.canonicalName('v6cONFIG'), 'V6Config');
});

console.log('\nDrawdown floor (CONTRACT section 6, 2026-11-07)');

const ADMIN = { email: 'admin@test.local', role: 'admin' };
const control = (w, action, body = {}) => handleControl({ entities: w.E, body: { action, ...body }, user: ADMIN, hub: w.hub, now: w.clock.now });
const cash = (amount) => ({ available_balance: amount, total_balance: amount, positions_value: 0, positions: [], total_trades: 0, total_profit_loss: 0 });
const v6Config = (w) => w.store.list('V6Config', {})[0];
const requestOf = (w, key, extra = {}) => w.store.update('V6Config', v6Config(w).id, { [key]: { id: `${key}-${w.clock.now}`, at: w.clock.now, by: 'admin@test.local', ...extra } });

/** A flat account at 7,000 whose floor reference is 10,000: exactly 30% down. */
async function atTheFloor() {
  const w = await world({ gate: realGate, portfolio: cash(7000) });
  await w.run();
  patchState(w, { allTimeHigh: 10_000, floorHigh: 10_000 });
  w.tick();
  await w.run();
  return w;
}

await test('floor: exactly -30% from the all-time high halts, flattening, with a critical floor_breached', async () => {
  const w = await atTheFloor();
  const state = w.account().v6_state;
  assert.strictEqual(state.floorBreach.equity, 7000);
  assert.strictEqual(state.floorBreach.reference, 10_000);
  assert.deepStrictEqual([state.riskState.halt.active, state.riskState.halt.flatten, state.riskState.halt.source], [true, true, 'floor']);
  const [e] = w.riskEvents('floor_breached');
  assert.strictEqual(e.severity, 'critical');
  assert.strictEqual(e.sticky, true);
  w.tick();
  await w.run();
  assert.strictEqual(w.riskEvents('floor_breached').length, 1, 'recorded once, not every run');

  const above = await world({ gate: realGate, portfolio: cash(7000.01) });
  await above.run();
  patchState(above, { allTimeHigh: 10_000, floorHigh: 10_000 });
  above.tick();
  await above.run();
  assert.strictEqual(above.account().v6_state.floorBreach ?? null, null, 'one cent above the floor is not the floor');
  assert.strictEqual(above.account().v6_state.riskState.halt.active, false);
});

await test('floor: a one-bar jump past it closes the position the same run, though its stop was not touched', async () => {
  const w = await holding();
  const p = position(w);
  const before = w.account().total_balance;
  // 3 dollars per coin above the floor, then a 7 dollar fall: the stop at 90 is not reached.
  patchState(w, { floorHigh: (before - p.quantity * 3) / 0.7 });
  w.tick();
  w.hub.prices.ETHUSDT = 93;
  const r = await w.run();
  assert.strictEqual(r.held, 0, 'the floor flatten must close it');
  const state = w.account().v6_state;
  assert.ok(state.floorBreach.equity < state.floorBreach.reference * 0.7, 'the breach is recorded past the level');
  assert.strictEqual(state.riskState.halt.source, 'floor');
  assert.strictEqual(sells(w.store).length, 1);
  assert.ok(sells(w.store)[0].price > 90, 'filled near 93, not at the stop');
  assertReconciled(w);
});

await test('floor: the flatten still runs with stale prices, when no venue answers', async () => {
  const w = await holding();
  patchState(w, { floorHigh: w.account().total_balance / 0.69 });
  w.hub.down = true;
  w.tick();
  const r = await w.run();
  assert.ok(w.account().v6_state.floorBreach, 'reached on the last good price');
  assert.strictEqual(r.held, 0, 'exits are never blocked');
  assertReconciled(w);
});

await test('floor: a normal re-enable does not clear it, in the engine or in v6Control', async () => {
  const w = await atTheFloor();
  const refused = await control(w, 'reenable', { confirm: 'RE-ENABLE', note: 'try' });
  assert.strictEqual(refused.code, 'FLOOR_BREACHED');
  const status = await control(w, 'status');
  assert.strictEqual(status.risk.floor.breached, true);
  assert.strictEqual(status.risk.reenable.preconditions.find((c) => c.id === 'floor').ok, false);
  // A request written past the control, straight into the config, is refused by the engine.
  requestOf(w, 'reenable_request');
  w.tick();
  await w.run();
  const state = w.account().v6_state;
  assert.strictEqual(state.riskState.halt.active, true);
  assert.ok(state.floorBreach);
  assert.ok(w.riskEvents('reenable_refused').some((e) => e.message.includes('floor_breached')));
  assert.strictEqual(v6Config(w).reenable_request, null, 'the refused request is consumed');
  assert.strictEqual(state.reenables ?? 0, 0);
});

await test('floor: a reset refused by the engine changes nothing (positions open)', async () => {
  const w = await holding();
  patchState(w, { floorBreach: { at: w.clock.now, equity: 1, reference: 2 }, floorHigh: 20_000 });
  requestOf(w, 'floor_reset_request', { note: 'x' });
  w.tick();
  await w.run();
  // The request is read before the run's exits, while the position is still open.
  const state = w.account().v6_state;
  assert.ok(w.riskEvents('floor_reset_refused').some((e) => e.message.includes('not_flat')));
  assert.ok(state.floorBreach, 'still breached');
  assert.strictEqual(state.floorHigh, 20_000);
  assert.strictEqual(w.account().positions.length, 0, 'the held breach flattened it in the same run');
  assert.strictEqual(v6Config(w).floor_reset_request, null, 'consumed, so a later flat run does not apply it');
});

await test('floor: resetFloor on a flat halted account moves the reference and records the old high, equity and user', async () => {
  const w = await atTheFloor();
  const r = await control(w, 'resetFloor', { confirm: 'FLOOR', note: 'reviewed the losses' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  w.tick();
  await w.run();
  const state = w.account().v6_state;
  assert.strictEqual(state.floorHigh, 7000);
  assert.strictEqual(state.floorBreach, null);
  assert.strictEqual(state.riskState.halt.active, true, 'still halted until a re-enable');
  const [e] = w.riskEvents('floor_reset');
  assert.deepStrictEqual([e.data.oldHigh, e.data.equity, e.data.by, e.sticky], [10_000, 7000, 'admin@test.local', true]);
  assert.strictEqual(state.allTimeHigh, 10_000, 'the all-time high is untouched');
  const { willRebase } = (await control(w, 'status')).risk.reenable;
  const back = await control(w, 'reenable', { confirm: willRebase ? 'RE-ENABLE' : 'RESUME', note: 'ok' });
  assert.strictEqual(back.ok, true, JSON.stringify(back));
  w.tick();
  await w.run();
  assert.strictEqual(w.account().v6_state.riskState.halt.active, false);
});

await test('floor: a breach survives a restart and a reloaded store', async () => {
  const w = await atTheFloor();
  const store = new EntityStore(path.dirname(w.store.dir));
  const E2 = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
  w.tick();
  await w.run({ entities: E2 });
  const state = store.list('Portfolio', {})[0].v6_state;
  assert.strictEqual(state.floorBreach.reference, 10_000);
  assert.strictEqual(state.floorHigh, 10_000);
  assert.deepStrictEqual([state.riskState.halt.active, state.riskState.halt.source], [true, 'floor']);
});

await test('floor: there is no config field for it, and a risk config cannot move it', async () => {
  const w = await atTheFloor();
  const cfg = v6Config(w);
  w.store.update('V6Config', cfg.id, { risk: { ...cfg.risk, ladderHaltPct: 0.5, floorPct: 0.9 }, floorPct: 0.9 });
  const status = await control(w, 'status');
  assert.strictEqual(status.risk.floor.pct, -30);
  assert.ok(!JSON.stringify((await control(w, 'riskConfig'))).includes('floor'), 'not offered as a setting');
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
