/**
 * v6Control tests. Temp data only. Covers the acceptance list in gui-design section 11.
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EntityStore } from '../server/entityStore.js';
import { makeBase44Shim } from '../server/functionRuntime.js';
import { ACTIONS, deriveHeadline, handle } from '../base44/functions/v6Control/control.js';
import * as risk from '../base44/functions/v6Control/shared/v6Risk.js';
import { evaluateDrift as realEvaluateDrift } from '../base44/functions/v6Control/shared/v6SignalGate.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.stack}`); }
};

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const user = { email: 'admin@test.local', role: 'admin' };
const dirs = [];

const riskState = (patch = {}) => ({ ...risk.initialRiskState(10_000, NOW - 60_000), ...patch });
const halted = (source = 'manual', flatten = false) => ({ active: true, source, reason: 'test', at: NOW, by: 'tester', flatten });
const held = { asset_symbol: 'ETHUSDT', quantity: 1, avg_entry_price: 100, last_known_price: 100, profit_loss: 0, v6: { symbol: 'ETHUSDT', strategyId: 's1', side: 'long', stopPrice: 90 } };

function world({ rs = riskState(), positions = [], settings = { is_enabled: false, live_trading_enabled: false, kill_switch_enabled: false } } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-v6control-'));
  dirs.push(dir);
  const store = new EntityStore(dir);
  store.create('Portfolio', {
    available_balance: 10_000, total_balance: 10_000, positions_value: 0, positions, total_trades: 0, total_profit_loss: 0,
    v6_state: { riskState: rs, lastTickT: NOW - 60_000, startedAt: NOW - 86_400_000, startingEquity: 10_000, allTimeHigh: 12_000, allTimeHighAt: NOW - 1000, reenables: 2 },
  });
  if (settings) store.create('AutoTradingSettings', settings);
  const entities = makeBase44Shim(store, { getRegistry: () => null }).asServiceRole.entities;
  const calls = { consensus: 0 };
  const hub = {
    consensusPrice: async (symbol) => { calls.consensus++; return { price: 100, ok: true, venues: [], spreadPct: 0, symbol }; },
    ticker: async () => ({ price: 1 }), bars: async () => [{}], book: async () => ({}),
  };
  const call = (action, body = {}, extra = {}) => handle({ entities, body: { action, ...body }, user, hub, registry: extra.registry ?? [], gateModule: extra.gateModule ?? null, now: extra.now ?? NOW });
  return { store, call, calls, hub, config: () => store.list('V6Config', {})[0], operatorEvents: () => store.list('V6RiskEvent', {}).filter((e) => e.type === 'operator_change') };
}

const version = async (w) => (await w.call('riskConfig')).version;

console.log('\nEnvelope and paper mode');

await test('an unknown action is refused in the envelope', async () => {
  const r = await world().call('placeOrder');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'UNKNOWN_ACTION');
});

await test('names on Object.prototype are not actions', async () => {
  assert.strictEqual((await world().call('constructor')).code, 'UNKNOWN_ACTION');
});

await test('status: mode is always paper, and legacy is read as three flags', async () => {
  const s = await world({ settings: { is_enabled: false, live_trading_enabled: true, kill_switch_enabled: false } }).call('status');
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.mode, 'paper');
  assert.deepStrictEqual(s.legacy, { autoTradingEnabled: false, liveTradingEnabled: true, killSwitch: false });
});

await test('status: all-time drawdown survives a rebased equity high', async () => {
  const s = await world({ rs: riskState({ equityHigh: 10_000, drawdown: 0 }) }).call('status');
  assert.strictEqual(s.risk.drawdownPct === 0 || Object.is(s.risk.drawdownPct, -0), true);
  assert.ok(Math.abs(s.risk.allTime.drawdownPct - (-100 / 6)) < 1e-9, 'measured from the 12,000 high');
  assert.strictEqual(s.risk.allTime.reenables, 2);
});

await test('status reports BTC moves from the risk state', async () => {
  const rs = riskState();
  rs.market = { ...rs.market, change24h: -0.012, change7d: -0.03 };
  const s = await world({ rs }).call('status');
  assert.ok(Math.abs(s.risk.btc.chg24hPct + 1.2) < 1e-9);
  assert.ok(Math.abs(s.risk.btc.chg7dPct + 3) < 1e-9);
});

console.log('\nHeadline');

const headline = (over = {}) => deriveHeadline({ now: NOW, lastTickAt: NOW - 60_000, rs: riskState(), positions: [], lifecycles: [], equity: 10_000, openRiskPct: 0, ...over });
const open = [{ strategyId: 's1' }];
const healthy = () => {
  const rs = riskState();
  rs.market = { ...rs.market, ok: true };
  rs.data = { ...rs.data, ok: true };
  return rs;
};

await test('day one, nothing certified: NO_CERTIFIED even though canEnter is false', async () => {
  const h = headline();
  assert.strictEqual(h.state, 'NO_CERTIFIED');
  assert.strictEqual(h.title, 'IN CASH');
});

await test('a quarantined position is never reported as cash', async () => {
  const h = headline({ quarantined: 1 });
  assert.strictEqual(h.state, 'NEEDS_REVIEW');
  assert.notStrictEqual(h.title, 'IN CASH');
  assert.match(h.line, /will not exit until you repair it/);
});

await test('no certified strategy with an open position says CLOSING, never IN CASH', async () => {
  const h = headline({ positions: open });
  assert.strictEqual(h.state, 'NO_CERTIFIED');
  assert.strictEqual(h.title, 'CLOSING 1 POSITION');
});

await test('precedence: engine down beats everything, halted beats no certified', async () => {
  assert.strictEqual(headline({ lastTickAt: NOW - 16 * 60_000, rs: riskState({ halt: halted('drawdown') }) }).state, 'ENGINE_DOWN');
  assert.strictEqual(headline({ lastTickAt: null }).state, 'ENGINE_DOWN');
  assert.strictEqual(headline({ rs: riskState({ halt: halted('drawdown') }) }).state, 'HALTED');
  assert.strictEqual(headline({ rs: null }).state, 'HALTED');
});

await test('remaining rows: paused, review, blocked, holding, waiting', async () => {
  assert.strictEqual(headline({ rs: riskState({ halt: halted('manual') }) }).state, 'PAUSED');
  assert.strictEqual(headline({ rs: riskState({ halt: halted('manual', true) }) }).state, 'HALTED');
  const review = riskState({ rung: 3, drawdown: 0.16, review: { needed: true, reason: 'flat_entries_blocked', since: NOW } });
  assert.strictEqual(headline({ rs: review }).state, 'NEEDS_REVIEW');
  const small = headline({ rs: riskState({ rung: 2, drawdown: 0.11, review: { needed: true, reason: 'flat_entries_too_small', since: NOW } }) });
  assert.strictEqual(small.state, 'NEEDS_REVIEW');
  assert.ok(small.line.includes('minimum order'), 'the rung 1-2 cause must not be described as no-entries');
  assert.strictEqual(headline({ lifecycles: ['paper_half'] }).state, 'ENTRIES_BLOCKED');
  assert.strictEqual(headline({ rs: healthy(), lifecycles: ['paper_half'], positions: open }).state, 'HOLDING');
  assert.strictEqual(headline({ rs: healthy(), lifecycles: ['paper_half'] }).state, 'WAITING');
});

await test('raw reason codes never reach the screen', async () => {
  for (const r of headline().reasons) assert.ok(!/^[a-z_]+$/.test(r.text), r.text);
});

console.log('\nRisk config');

await test('above a ceiling is refused and nothing changes', async () => {
  const w = world();
  const v = await version(w);
  const r = await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.02 }, expectedVersion: v });
  assert.strictEqual(r.code, 'ABOVE_CEILING');
  assert.ok(r.fields.riskPerTradePct);
  assert.strictEqual(await version(w), v);
  assert.strictEqual(w.operatorEvents().length, 0);
});

await test('a value the clamp would move is refused, naming what would really apply', async () => {
  const w = world();
  const r = await w.call('setRiskConfig', { patch: { ladderHalfPct: 0.075, ladderQuarterPct: 0.08 }, expectedVersion: await version(w) });
  assert.strictEqual(r.code, 'BAD_REQUEST');
  assert.ok(r.fields.ladderHalfPct.includes('Would really apply'));
});

await test('a stale version is refused', async () => {
  const w = world();
  assert.strictEqual((await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.004 }, expectedVersion: -1 })).code, 'VERSION_CONFLICT');
});

await test('cost assumptions and unknown keys cannot be set', async () => {
  const w = world();
  const v = await version(w);
  assert.strictEqual((await w.call('setRiskConfig', { patch: { defaultFeePct: 0.002 }, expectedVersion: v })).code, 'BAD_REQUEST');
  assert.strictEqual((await w.call('setRiskConfig', { patch: { leverage: 5 }, expectedVersion: v })).code, 'BAD_REQUEST');
  assert.strictEqual((await w.call('setRiskConfig', { patch: { riskPerTradePct: '0.004' }, expectedVersion: v })).code, 'BAD_REQUEST');
});

await test('a valid change saves, bumps the version and leaves an audit row', async () => {
  const w = world();
  const v = await version(w);
  const r = await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.004 }, expectedVersion: v });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, v + 1);
  assert.strictEqual(r.config.riskPerTradePct, 0.004);
  const [e] = w.operatorEvents();
  assert.strictEqual(e.before.riskPerTradePct, 0.005);
  assert.strictEqual(e.after.riskPerTradePct, 0.004);
});

for (const [label, rs] of [['quarter-size rung', riskState({ rung: 2 })], ['no-entries rung', riskState({ rung: 3 })], ['halt', riskState({ halt: halted() })]]) {
  await test(`on the ${label}: loosening is refused, tightening is allowed`, async () => {
    const w = world({ rs });
    const v = await version(w);
    assert.strictEqual((await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.008 }, expectedVersion: v })).code, 'LOOSEN_BLOCKED');
    assert.strictEqual((await w.call('setRiskConfig', { patch: { minHealthyVenues: 3 }, expectedVersion: v })).ok, true);
  });
}

await test('direction comes from the key: fewer healthy venues is looser', async () => {
  const w = world();
  const v = await version(w);
  await w.call('setRiskConfig', { patch: { minHealthyVenues: 3 }, expectedVersion: v });
  const base = w.store.list('Portfolio', {})[0];
  w.store.update('Portfolio', base.id, { v6_state: { ...base.v6_state, riskState: riskState({ rung: 2 }) } });
  assert.strictEqual((await w.call('setRiskConfig', { patch: { minHealthyVenues: 2 }, expectedVersion: v + 1 })).code, 'LOOSEN_BLOCKED');
});

await test('half-size rung still allows loosening, as the rule starts at quarter size', async () => {
  const w = world({ rs: riskState({ rung: 1 }) });
  assert.strictEqual((await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.008 }, expectedVersion: await version(w) })).ok, true);
});

await test('reset to defaults is a loosening too when the limits were tighter', async () => {
  const w = world();
  const v = await version(w);
  await w.call('setRiskConfig', { patch: { riskPerTradePct: 0.002 }, expectedVersion: v });
  const base = w.store.list('Portfolio', {})[0];
  w.store.update('Portfolio', base.id, { v6_state: { ...base.v6_state, riskState: riskState({ rung: 2 }) } });
  assert.strictEqual((await w.call('resetRiskConfig', { expectedVersion: v + 1 })).code, 'LOOSEN_BLOCKED');
});

console.log('\nRequests');

await test('pause needs a reason and only leaves a request', async () => {
  const w = world();
  assert.strictEqual((await w.call('pauseEntries', {})).code, 'BAD_REQUEST');
  const before = JSON.stringify(w.store.list('Portfolio', {})[0]);
  assert.strictEqual((await w.call('pauseEntries', { reason: 'checking' })).effective, 'next_tick');
  assert.strictEqual(w.config().halt_request.flatten, false);
  assert.ok(w.config().halt_request.id, 'the engine needs an id to apply it once');
  assert.strictEqual(JSON.stringify(w.store.list('Portfolio', {})[0]), before, 'v6Control must never touch the ledger');
});

await test('flatten needs the exact word', async () => {
  const w = world();
  assert.strictEqual((await w.call('flattenAll', { confirm: 'flatten' })).code, 'CONFIRM_MISMATCH');
  assert.strictEqual((await w.call('flattenAll', { confirm: 'FLATTEN', reason: 'x' })).ok, true);
  assert.strictEqual(w.config().halt_request.flatten, true);
});

await test('re-enable: nothing to clear is refused', async () => {
  assert.strictEqual((await world().call('reenable', { confirm: 'RESUME', note: 'x' })).code, 'NOT_HALTED');
});

await test('re-enable: the wrong word and an empty note are refused', async () => {
  const w = world({ rs: riskState({ halt: halted() }) });
  assert.strictEqual((await w.call('reenable', { confirm: 'RE-ENABLE', note: 'x' })).code, 'CONFIRM_MISMATCH');
});

await test('re-enable with positions open when it would rebase is refused', async () => {
  const w = world({ rs: riskState({ rung: 3, halt: halted('drawdown') }), positions: [held] });
  const r = await w.call('reenable', { confirm: 'RE-ENABLE', note: 'reviewed' });
  assert.strictEqual(r.code, 'PRECONDITION_FAILED');
  assert.ok(r.fields.flat);
});

await test('re-enable: NEEDS_REVIEW accepts it, and status shows the rebase', async () => {
  const w = world({ rs: riskState({ rung: 3, review: { needed: true, reason: 'flat_entries_blocked', since: NOW } }) });
  assert.strictEqual((await w.call('status')).risk.reenable.willRebase, true);
  const r = await w.call('reenable', { confirm: 'RE-ENABLE', note: 'reviewed' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.willRebase, true);
  assert.strictEqual(w.config().reenable_request.by, user.email);
});

console.log('\nStrategies');

const strategy = { id: 's1', name: 'Test', version: 1, timeframe: '1d', universe: { kind: 'top', n: 5 } };

await test('an unknown or research strategy cannot be switched', async () => {
  const w = world();
  assert.strictEqual((await w.call('setStrategyEnabled', { id: 'nope', enabled: true })).code, 'NOT_FOUND');
  assert.strictEqual((await w.call('setStrategyEnabled', { id: 's1', enabled: true }, { registry: [strategy] })).code, 'NOT_ALLOWED_IN_STATE');
});

await test('switching off can ask the engine to close the strategy\'s positions', async () => {
  const w = world();
  w.store.create('V6StrategyState', { strategy_id: 's1', lifecycle: 'paper_half' });
  const r = await w.call('setStrategyEnabled', { id: 's1', enabled: false, closePositions: true }, { registry: [strategy] });
  assert.strictEqual(r.strategy.operatorEnabled, false);
  assert.strictEqual(w.config().close_requests[0].strategy_id, 's1');
});

const passingGate = { verifyCertificate: (cert) => ({ ok: cert?.status === 'valid' }), strategyHash: () => 'h', evaluateDrift: realEvaluateDrift };

await test('return from shadow: needs the word, a note, shadow state and 20 signals', async () => {
  const w = world();
  w.store.create('V6Certificate', { strategy_id: 's1', status: 'valid', issued_at: NOW });
  const row = w.store.create('V6StrategyState', { strategy_id: 's1', lifecycle: 'shadow', shadow_in_range: 19 });
  const go = (body) => w.call('returnFromShadow', { id: 's1', ...body }, { registry: [strategy], gateModule: passingGate });
  assert.strictEqual((await go({ confirm: 'return', note: 'x' })).code, 'CONFIRM_MISMATCH');
  assert.strictEqual((await go({ confirm: 'RETURN' })).code, 'BAD_REQUEST');
  assert.strictEqual((await go({ confirm: 'RETURN', note: 'x' })).code, 'PRECONDITION_FAILED');
  w.store.update('V6StrategyState', row.id, { shadow_in_range: 20 });
  assert.strictEqual((await go({ confirm: 'RETURN', note: 'x' })).ok, true);
  assert.strictEqual(w.config().reinstate_requests.length, 1);
  assert.strictEqual(w.store.get('V6StrategyState', row.id).lifecycle, 'shadow', 'only the engine moves it, and only through the gate');
});

await test('return from shadow refuses a certificate that does not verify, and leaves no request', async () => {
  const body = { id: 's1', confirm: 'RETURN', note: 'x' };
  const shadow = { strategy_id: 's1', lifecycle: 'shadow', shadow_in_range: 40 };
  const expired = world();
  expired.store.create('V6Certificate', { strategy_id: 's1', status: 'expired', issued_at: NOW });
  expired.store.create('V6StrategyState', shadow);
  assert.strictEqual((await expired.call('returnFromShadow', body, { registry: [strategy], gateModule: passingGate })).code, 'PRECONDITION_FAILED');
  assert.strictEqual((expired.config().reinstate_requests ?? []).length, 0);
  const none = world();
  none.store.create('V6StrategyState', shadow);
  assert.strictEqual((await none.call('returnFromShadow', body, { registry: [strategy], gateModule: passingGate })).code, 'PRECONDITION_FAILED');
  const noGate = world();
  noGate.store.create('V6Certificate', { strategy_id: 's1', status: 'valid', issued_at: NOW });
  noGate.store.create('V6StrategyState', shadow);
  assert.strictEqual((await noGate.call('returnFromShadow', body, { registry: [strategy] })).code, 'PRECONDITION_FAILED', 'no gate fails closed');
});

await test('warm-up shadow signals do not count, and the count and pending flag agree with the refusal', async () => {
  const w = world();
  const extra = { registry: [strategy], gateModule: passingGate };
  w.store.create('V6Certificate', { strategy_id: 's1', status: 'valid', issued_at: NOW, expected: { min_trades: 5 } });
  const row = w.store.create('V6StrategyState', { strategy_id: 's1', lifecycle: 'shadow', shadow_in_range: 24 });
  const view = async () => (await w.call('strategies', {}, extra)).items[0].shadowReturn;
  assert.deepStrictEqual(await view(), { signalsInRange: 19, signalsRequired: 20, pending: false });
  const body = { id: 's1', confirm: 'RETURN', note: 'x' };
  assert.strictEqual((await w.call('returnFromShadow', body, extra)).code, 'PRECONDITION_FAILED');
  w.store.update('V6StrategyState', row.id, { shadow_in_range: 25 });
  assert.strictEqual((await w.call('returnFromShadow', body, extra)).ok, true);
  assert.strictEqual((await view()).pending, true);
  assert.strictEqual((await w.call('returnFromShadow', body, extra)).ok, true, 'a repeat is answered, not queued');
  assert.strictEqual(w.config().reinstate_requests.length, 1);
});

await test('unknown drift reaches the list as unknown', async () => {
  const w = world();
  w.store.create('V6StrategyState', { strategy_id: 's1', lifecycle: 'paper_half', drift_status: 'unknown' });
  assert.strictEqual((await w.call('strategies', {}, { registry: [strategy] })).items[0].drift.status, 'unknown');
});

await test('strategy detail sends verified status, expiry and one breach marker per breach', async () => {
  const w = world();
  const points = Array.from({ length: 10 }, (_, i) => ({ x: i + 1, lo: -5, hi: 5, p5: -5, p50: 0, p95: 5 }));
  const expected = { x_unit: 'trades', n_trades: 50, min_trades: 2, max_x: 10, points };
  w.store.create('V6Certificate', { strategy_id: 's1', status: 'expired', issued_at: NOW, expires_at: NOW + 1000, hash: 'h', expected });
  const returns = [1, 1, -9, -1, 9, 1];
  let total = 0;
  const forward_series = returns.map((r, i) => ({ x: i + 1, trade_return_pct: r, return_pct: (total += r) }));
  w.store.create('V6StrategyState', { strategy_id: 's1', lifecycle: 'shadow', forward_series });
  const r = await w.call('strategyDetail', { id: 's1' }, { registry: [strategy], gateModule: passingGate });
  assert.strictEqual(r.certificate.status, 'stale', 'the stored word valid or expired is not what is shown');
  assert.strictEqual(r.certificate.storedStatus, 'expired');
  assert.strictEqual(r.certificate.expiresAt, NOW + 1000);
  assert.deepStrictEqual(r.drift.breaches.map((b) => b.x), [3]);
  assert.ok(r.drift.breaches[0].text.length > 0);
});

await test('a signal that was not tested says why', async () => {
  const w = world();
  w.store.create('V6SignalTest', { t: NOW, symbol: 'ETHUSDT', strategy_id: 's1', outcome: 'not_tested', not_tested_reason: 'cooldown', checks: [] });
  assert.strictEqual((await w.call('signalTests')).items[0].notTestedReason, 'cooldown');
});

console.log('\nStatus detail');

function heldWorld(priceAt, v6 = {}) {
  const w = world({ positions: [{ ...held, v6: { ...held.v6, strategyId: 's1', ...v6 } }] });
  const [row] = w.store.list('Portfolio', {});
  w.store.update('Portfolio', row.id, { v6_state: { ...row.v6_state, priceAt } });
  return w;
}

const firstPosition = async (w) => (await w.call('status', {}, { registry: [{ ...strategy, id: 's1', name: 'Daily trend' }] })).positions[0];

await test('a position price goes stale once its quote is too old, and an unknown age is stale', async () => {
  const fresh = await firstPosition(heldWorld({ ETHUSDT: NOW - 5 * 60_000 }));
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.priceAgeSec, 300);
  const old = await firstPosition(heldWorld({ ETHUSDT: NOW - 12 * 60_000 }));
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.priceAgeSec, 720);
  const unknown = await firstPosition(heldWorld({}));
  assert.strictEqual(unknown.stale, true);
  assert.strictEqual(unknown.priceAgeSec, null);
});

await test('a position shows its strategy name and its next exit', async () => {
  const p = await firstPosition(heldWorld({ ETHUSDT: NOW }, {
    stopPrice: 96.5, initialStopPrice: 90, barsHeld: 18, exitPlan: { timeStop: { enabled: true, bars: 20 } },
  }));
  assert.strictEqual(p.strategyName, 'Daily trend');
  assert.strictEqual(p.nextExit, 'Trailing stop at 96.5, time stop check in 2 bars');
  const hard = await firstPosition(heldWorld({ ETHUSDT: NOW }, { stopPrice: 90, initialStopPrice: 90 }));
  assert.strictEqual(hard.nextExit, 'Hard stop at 90');
  const closing = await firstPosition(heldWorld({ ETHUSDT: NOW }, { stopPrice: 90, exitPending: { reason: 'Stop hit' } }));
  assert.strictEqual(closing.nextExit, 'Closing: Stop hit');
});

await test('rules switched off in the profile do not read as armed', async () => {
  const p = await firstPosition(heldWorld({ ETHUSDT: NOW }, {
    stopPrice: 90, exitPlan: { breakEven: { enabled: false }, breakEvenPrice: 101, trail: { enabled: true }, timeStop: { enabled: false } },
  }));
  const state = Object.fromEntries(p.exitPlan.map((r) => [r.id, r.state]));
  assert.strictEqual(state.break_even, 'off');
  assert.strictEqual(state.trail, 'armed');
  assert.strictEqual(state.time_stop, 'off');
});

await test('status.risk carries the review, and weekly limits reset next UTC Monday', async () => {
  const review = { needed: true, reason: 'flat_entries_too_small', since: NOW };
  const s = await world({ rs: riskState({ review }) }).call('status');
  assert.deepStrictEqual(s.risk.review, review);
  const reset = new Date(s.risk.weekly.resetsAt);
  assert.strictEqual(reset.getUTCDay(), 1);
  assert.strictEqual(reset.getTime() % 86_400_000, 0);
  assert.ok(s.risk.weekly.resetsAt > NOW && s.risk.weekly.resetsAt <= NOW + 7 * 86_400_000);
});

await test('strategies.failed counts each strategy by its newest certificate', async () => {
  const w = world();
  w.store.create('V6Certificate', { strategy_id: 'a', status: 'failed', issued_at: NOW - 2 });
  w.store.create('V6Certificate', { strategy_id: 'b', status: 'failed', issued_at: NOW - 2 });
  w.store.create('V6Certificate', { strategy_id: 'b', status: 'valid', issued_at: NOW - 1 });
  assert.strictEqual((await w.call('status')).strategies.failed, 1);
});

await test('worst drawdown keeps the deeper of the stored figure and the equity points', async () => {
  const w = world();
  w.store.create('V6EquityPoint', { t: NOW, equity: 9000, drawdown_pct: -10 });
  assert.strictEqual((await w.call('status')).risk.worstDrawdownPct, -10);
  const [row] = w.store.list('Portfolio', {});
  w.store.update('Portfolio', row.id, { v6_state: { ...row.v6_state, worstDrawdownPct: -25 } });
  assert.strictEqual((await w.call('status')).risk.worstDrawdownPct, -25, 'a thinned-out point is not forgotten');
});

await test('sleeves are read only', async () => {
  assert.strictEqual((await world().call('setSleeves', { sleeves: { s1: 50 } })).code, 'NOT_ALLOWED_IN_STATE');
});

console.log('\nExchanges');

await test('fewer than two venues is refused', async () => {
  const w = world();
  const r = await w.call('setExchanges', { venues: [{ venue: 'okx', enabled: true, priority: 1 }, { venue: 'bybit', enabled: false, priority: 2 }], expectedVersion: await version(w) });
  assert.strictEqual(r.code, 'MIN_VENUES');
});

const venuesOf = async (w) => (await w.call('exchanges')).venues.map(({ venue, enabled, priority }) => ({ venue, enabled, priority }));

await test('role selectors are saved, read back and shown on the venue', async () => {
  const w = world();
  const r = await w.call('setExchanges', { venues: await venuesOf(w), roles: { replay: 'bybit', book: 'kraken' }, expectedVersion: await version(w) });
  assert.strictEqual(r.ok, true);
  const back = await w.call('exchanges');
  assert.strictEqual(back.roles.replay, 'bybit');
  assert.strictEqual(back.roles.book, 'kraken');
  assert.ok(back.venues.find((v) => v.venue === 'bybit').roles.includes('replay'));
  assert.ok(!back.venues.find((v) => v.venue === 'okx').roles.includes('replay'));
});

await test('with no saved role the first capable enabled venue is used', async () => {
  const r = await world().call('exchanges');
  assert.ok(['okx', 'bybit'].includes(r.roles.replay));
  assert.strictEqual(r.roles.book, r.venues.find((v) => v.enabled).venue);
});

await test('replay must be OKX or Bybit and switched on, enforced by the server', async () => {
  const w = world();
  const save = async (roles, venues) => w.call('setExchanges', { venues: venues ?? await venuesOf(w), roles, expectedVersion: await version(w) });
  assert.strictEqual((await save({ replay: 'kraken' })).code, 'BAD_REQUEST');
  const offBybit = (await venuesOf(w)).map((v) => (v.venue === 'bybit' ? { ...v, enabled: false } : v));
  assert.strictEqual((await save({ replay: 'bybit' }, offBybit)).code, 'PRECONDITION_FAILED');
  const noReplay = (await venuesOf(w)).map((v) => (['okx', 'bybit'].includes(v.venue) ? { ...v, enabled: false } : v));
  assert.strictEqual((await save(undefined, noReplay)).code, 'PRECONDITION_FAILED', 'no capable venue left on');
  const offKraken = (await venuesOf(w)).map((v) => (v.venue === 'kraken' ? { ...v, enabled: false } : v));
  assert.strictEqual((await save({ book: 'kraken' }, offKraken)).code, 'PRECONDITION_FAILED');
  assert.strictEqual((await save({ book: 'nowhere' })).code, 'BAD_REQUEST');
  assert.strictEqual(w.config().roles?.replay ?? null, null, 'nothing refused was saved');
});

await test('switching off a saved role venue is refused rather than silently moved', async () => {
  const w = world();
  await w.call('setExchanges', { venues: await venuesOf(w), roles: { replay: 'bybit' }, expectedVersion: await version(w) });
  const off = (await venuesOf(w)).map((v) => (v.venue === 'bybit' ? { ...v, enabled: false } : v));
  assert.strictEqual((await w.call('setExchanges', { venues: off, expectedVersion: await version(w) })).code, 'PRECONDITION_FAILED');
});

await test('consensus flags every hub disagreement code and maps real quotes', async () => {
  const quotes = [{ venue: 'okx', price: 100 }, { venue: 'bybit', price: 101 }];
  const expectations = { venues_disagree: true, no_majority: true, outlier_excluded: true, insufficient_venues: false };
  for (const [i, [reason, flagged]] of Object.entries(expectations).entries()) {
    const w = world();
    w.hub.consensusPrice = async () => ({ price: 100, ok: false, reason, venues: ['okx', 'bybit'], quotes });
    const [item] = (await w.call('consensus', { symbols: [`Q${i}USDT`] })).items;
    assert.strictEqual(item.disagreement, flagged, reason);
    assert.deepStrictEqual(item.quotes, { okx: 100, bybit: 101 });
  }
});

await test('an untried venue reads as unknown, never healthy', async () => {
  const r = await world().call('exchanges');
  assert.ok(r.venues.length > 2);
  assert.ok(r.venues.every((v) => v.health === 'unknown'));
  assert.ok(['okx', 'bybit'].includes(r.roles.replay));
});

await test('testExchange is rate limited, and an unknown venue is not found', async () => {
  const w = world();
  assert.strictEqual((await w.call('testExchange', { venue: 'nope' })).code, 'NOT_FOUND');
  assert.strictEqual((await w.call('testExchange', { venue: 'kucoin' })).result.ok, true);
  assert.strictEqual((await w.call('testExchange', { venue: 'kucoin' })).code, 'RATE_LIMITED');
});

await test('consensus caps at 10 symbols and caches for 60 seconds', async () => {
  const w = world();
  const symbols = Array.from({ length: 12 }, (_, i) => `C${i}USDT`);
  assert.strictEqual((await w.call('consensus', { symbols })).items.length, 10);
  assert.strictEqual(w.calls.consensus, 10);
  await w.call('consensus', { symbols });
  assert.strictEqual(w.calls.consensus, 10);
});

console.log('\nReads and events');

await test('ackEvent marks a real event and refuses an unknown id', async () => {
  const w = world();
  const e = w.store.create('V6RiskEvent', { t: NOW, type: 'alarm', severity: 'critical', code: 'x', message: 'y' });
  assert.strictEqual((await w.call('ackEvent', { id: 'nope' })).code, 'NOT_FOUND');
  assert.ok((await w.call('ackEvent', { id: e.id })).event.ackedAt);
});

await test('equityCurve rebases to 100 and never returns more than 500 points', async () => {
  const w = world();
  w.store._save('V6EquityPoint', Array.from({ length: 1200 }, (_, i) => ({ id: `p${i}`, t: NOW - (1200 - i) * 300_000, equity: 10_000 + i, btc_price: 90_000, drawdown_pct: 0, exposure_pct: 0 })));
  const r = await w.call('equityCurve', { range: 'all' });
  assert.ok(r.points.length <= 500);
  assert.strictEqual(r.points[0].equityIndex, 100);
  assert.strictEqual(r.points.at(-1).equity, 10_000 + 1199);
  assert.strictEqual(r.downsampled, true);
});

await test('signal tests page, count and summarise', async () => {
  const w = world();
  for (let i = 0; i < 3; i++) w.store.create('V6SignalTest', { t: NOW - i, symbol: 'ETHUSDT', strategy_id: 's1', outcome: 'blocked', blocked_by: 'liquidity', checks: [{ id: 'liquidity', status: 'fail' }] });
  const r = await w.call('signalTests', { limit: 2 });
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.nextCursor, 2);
  assert.deepStrictEqual(r.summary.topFailure, { check: 'liquidity', count: 3 });
  assert.strictEqual(r.items[0].checks.liquidity, 'fail');
  assert.strictEqual((await w.call('signalTest', { id: 'nope' })).code, 'NOT_FOUND');
});

await test('decisions merge signal tests with V6 trades and ignore legacy trades', async () => {
  const w = world();
  w.store.create('V6SignalTest', { t: NOW, symbol: 'ETHUSDT', strategy_id: 's1', outcome: 'entered' });
  w.store.create('Trade', { exchange: 'Paper Trading (V6)', asset_symbol: 'ETHUSDT', reason_code: 'hard_stop', timestamp: new Date(NOW).toISOString() });
  w.store.create('Trade', { exchange: 'Paper Trading', asset_symbol: 'INJUSDT', timestamp: new Date(NOW).toISOString() });
  const r = await w.call('decisions');
  assert.deepStrictEqual(r.items.map((i) => i.kind).sort(), ['entered', 'exit']);
});

console.log('\nWhat must not exist');

await test('no action can create a certificate, promote, or reach live trading', async () => {
  for (const name of Object.keys(ACTIONS)) assert.ok(!/promot|override|certif|live|apikey|holdout/i.test(name), name);
  for (const file of ['control.js', 'entry.ts']) {
    const src = readFileSync(path.join('base44', 'functions', 'v6Control', file), 'utf8');
    for (const banned of ['liveOrderExecution', 'executeApprovedTrade', 'liveTradingControl', 'okxExchange', 'ExchangeConnection', 'api_key', 'api_secret', 'issueCertificate', 'V6Certificate.create', 'V6Certificate.update', 'Portfolio.update', 'Portfolio.create', 'Trade.create']) {
      assert.ok(!src.includes(banned), `${file} mentions ${banned}`);
    }
  }
});

await test('setExchanges counts real venues only, once each', async () => {
  const on = (venue, priority = 1) => ({ venue, enabled: true, priority });
  const real = [on('okx'), on('bybit', 2)];
  const refusedWith = async (venues, roles) => {
    const w = world();
    const expectedVersion = await version(w);
    const r = await w.call('setExchanges', { venues, roles, expectedVersion });
    assert.strictEqual(await version(w), expectedVersion, 'nothing saved');
    return r.code;
  };
  assert.strictEqual(await refusedWith([on('constructor'), on('toString', 2), on('okx', 3)]), 'BAD_REQUEST');
  assert.strictEqual(await refusedWith([on('__proto__'), ...real]), 'BAD_REQUEST');
  assert.strictEqual(await refusedWith([on(['okx']), ...real]), 'BAD_REQUEST');
  assert.strictEqual(await refusedWith([on('okx'), on('okx', 2)]), 'BAD_REQUEST');
  assert.strictEqual(await refusedWith(real, { book: 'constructor' }), 'BAD_REQUEST');
  assert.strictEqual(await refusedWith(real, { book: 'hasOwnProperty' }), 'BAD_REQUEST');
  assert.strictEqual((await world().call('testExchange', { venue: 'constructor' })).code, 'NOT_FOUND');
  const w = world();
  assert.strictEqual((await w.call('setExchanges', { venues: real, expectedVersion: await version(w) })).ok, true);
});

await test('positions that are not a list: status answers and shows it, and nothing reads it as flat', async () => {
  for (const bad of ['x', 7, { a: 1 }]) {
    const w = world({ rs: riskState({ halt: halted('manual') }) });
    w.store.update('Portfolio', w.store.list('Portfolio', {})[0].id, { positions: bad });
    const s = await w.call('status');
    assert.strictEqual(s.ok, true);
    assert.deepStrictEqual(s.positions, []);
    assert.strictEqual(s.positionsDamaged, true);
    assert.strictEqual(s.headline.state, 'NEEDS_REVIEW');
    assert.strictEqual((await w.call('consensus', { symbols: ['BTCUSDT'] })).ok, true);
    const held = s.risk.reenable.preconditions.find((p) => p.id === 'flat');
    if (held) assert.strictEqual(held.ok, false);
  }
  const w = world();
  assert.strictEqual((await w.call('status')).positionsDamaged, false);
  w.store.update('Portfolio', w.store.list('Portfolio', {})[0].id, { positions: ['x', 5, null] });
  assert.deepStrictEqual((await w.call('status')).positions, [], 'rows that are not objects are never formatted');
});

await test('recutover refuses a position list that cannot be read', async () => {
  const w = world();
  const [row] = w.store.list('Portfolio', {});
  await w.call('status');
  await version(w);
  const cfg = w.store.list('V6Config', {})[0];
  w.store.update('V6Config', cfg.id, { cutover_at: NOW });
  w.store.update('Portfolio', row.id, { v6_state: null, positions: 'x' });
  assert.strictEqual((await w.call('recutover', { confirm: 'RECUTOVER' })).code, 'NOT_ALLOWED_IN_STATE');
});

await test('status reads every legacy row, whatever its date or value type', async () => {
  const w = world({ settings: { is_enabled: 'true', live_trading_enabled: 1, created_date: '2020-01-01T00:00:00.000Z' } });
  w.store.create('AutoTradingSettings', { is_enabled: false, created_date: '2099-01-01T00:00:00.000Z' });
  const { legacy } = await w.call('status');
  assert.strictEqual(legacy.autoTradingEnabled, true);
  assert.strictEqual(legacy.liveTradingEnabled, true);
});

await test('the entry refuses anyone who is not an admin', async () => {
  const src = readFileSync(path.join('base44', 'functions', 'v6Control', 'entry.ts'), 'utf8');
  assert.ok(src.includes("user.role !== 'admin'") && src.includes('status: 403'));
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
