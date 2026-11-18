/**
 * V6 risk engine tests: every limit, exact thresholds, failing closed on bad input,
 * ladder hysteresis, restart round-trips, unbreakable ceilings, multiplier order,
 * and UTC period rollover.
 */
import assert from 'node:assert';
import * as risk from '../shared/trading/v6Risk.js';

const {
  DEFAULT_RISK_CONFIG, HARD_CEILINGS, LADDER_RUNGS, clampRiskConfig, initialRiskState, updateRiskState,
  canEnter, sizeEntry, manualHalt, humanReEnable, riskDirectives, utcDayKey, utcWeekKey,
  noteEntryRejection, reEnablePreview,
} = risk;

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} to be near ${b}`);

const HOUR = 3_600_000, DAY = 24 * HOUR;
// Thursday. The week containing it starts Monday 2026-11-02.
const T0 = Date.UTC(2026, 10, 5, 12);
const CFG = DEFAULT_RISK_CONFIG;
const OK = { ok: true };

/** Flat hourly BTC bars ending at t, with the given closes pinned at hours-ago offsets. */
function btc(t, { now = 100, ago24 = 100, ago7d = 100 } = {}) {
  const lastT = Math.floor(t / HOUR) * HOUR - HOUR;
  const bars = [];
  for (let i = 200; i >= 0; i--) {
    const c = i === 0 ? now : i === 24 ? ago24 : i === 168 ? ago7d : 100;
    bars.push({ t: lastT - i * HOUR, o: c, h: c, l: c, c, v: 1, qv: 1 });
  }
  return bars;
}
/** One tick with calm defaults; override what the test is about. */
const tick = (s, equity, t, over = {}) =>
  updateRiskState(s, { t, equity, btcBars: btc(t), dataHealth: OK, config: CFG, ...over });
const ready = (equity = 10000, t = T0) => tick(initialRiskState(equity, t), equity, t).riskState;
/** Walk equity through a path, one minute per step, staying inside the same day. */
const walk = (s, path, t = T0) => path.reduce((st, e, i) => tick(st, e, t + (i + 1) * 60_000).riskState, s);
/** A state at this drawdown, with period baselines moved so only the ladder is in play. */
const reachRung = (dd) => {
  const start = ready();
  const t = T0 + HOUR;
  const s = JSON.parse(JSON.stringify(start));
  s.day.startEquity = s.week.startEquity = 10000 * (1 - dd);
  return tick(s, 10000 * (1 - dd), t).riskState;
};

const signal = (over = {}) => ({ strategyId: 's', symbol: 'SOLUSDT', side: 'long', stopDistancePct: 0.05, ...over });
const position = (symbol, value, over = {}) => ({
  symbol, strategyId: 's', side: 'long', qty: value / 100, entryPrice: 100, stopPrice: 95, highWater: 100, ...over,
});
const size = (over = {}) => sizeEntry({
  signal: signal(), price: 100, equity: 10000, positions: [], riskState: ready(), config: CFG,
  volatility: 0.8, correlations: {}, sizeMultiplier: 1, ...over,
});
// Default costs: Tier 3 fee 0.10%, slip 0.25%, stop gap 0.10%.
const COST_DRAG = 2 * 0.001 + 2 * 0.0025 + 0.001;
const fullSize = 10000 * 0.005 / (0.05 + COST_DRAG);

console.log('\nconfig and ceilings');

test('contract defaults and ceilings', () => {
  assert.equal(CFG.riskPerTradePct, 0.005);
  assert.equal(HARD_CEILINGS.riskPerTradePct.max, 0.01);
  assert.equal(CFG.maxOpenRiskPct, 0.03);
  assert.equal(HARD_CEILINGS.maxOpenRiskPct.max, 0.05);
  assert.equal(CFG.maxPositionPct, 0.20);
  assert.equal(HARD_CEILINGS.maxGrossExposurePct.max, 1.0);
  assert.equal(CFG.maxClusterPct, 0.40);
  assert.deepEqual([CFG.ladderHalfPct, CFG.ladderQuarterPct, CFG.ladderNoEntryPct, CFG.ladderHaltPct], [0.05, 0.10, 0.15, 0.20]);
  assert.deepEqual([CFG.dailyLossPct, CFG.weeklyLossPct, CFG.btcDrop24hPct, CFG.btcDrop7dPct], [0.02, 0.04, 0.08, 0.15]);
  assert.ok(CFG.volTargetAnnual >= 0.15 && CFG.volTargetAnnual <= 0.20);
  assert.equal(CFG.stopGapSlipPct, 0.001);
});

test('every default sits inside its ceiling, and clamping the defaults changes nothing', () => {
  for (const [k, { min, max }] of Object.entries(HARD_CEILINGS)) {
    assert.ok(CFG[k] >= min && CFG[k] <= max, k);
  }
  assert.deepEqual(clampRiskConfig(CFG), { ...CFG });
});

test('every key is clamped to both ends of its range', () => {
  for (const [k, { min, max }] of Object.entries(HARD_CEILINGS)) {
    assert.ok(clampRiskConfig({ [k]: 1e12 })[k] <= max, `${k} high`);
    assert.ok(clampRiskConfig({ [k]: -1e12 })[k] >= Math.min(min, CFG[k]) - 1e-12 || k.startsWith('ladder') || k === 'dailyLossPct', `${k} low`);
  }
});

test('unusable values fall back to the default; unknown keys and garbage are dropped', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5', {}, [], true]) {
    assert.equal(clampRiskConfig({ riskPerTradePct: bad }).riskPerTradePct, 0.005, String(bad));
  }
  for (const bad of [undefined, null, 7, 'x', []]) assert.deepEqual(clampRiskConfig(bad), { ...CFG });
  const hostile = clampRiskConfig(JSON.parse('{"__proto__":{"riskPerTradePct":1},"leverage":10}'));
  assert.equal(hostile.riskPerTradePct, 0.005);
  assert.equal(hostile.leverage, undefined);
});

test('random configs never leave the ceilings and always keep the ladder ordered', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 3000; i++) {
    const raw = {};
    for (const k of Object.keys(HARD_CEILINGS)) raw[k] = (rand() - 0.3) * 10 ** Math.floor(rand() * 6 - 3);
    const c = clampRiskConfig(raw);
    for (const [k, { min, max }] of Object.entries(HARD_CEILINGS)) {
      assert.ok(c[k] <= max + 1e-12 && c[k] >= min - 1e-12, `${k}=${c[k]}`);
    }
    assert.ok(c.ladderHalfPct < c.ladderQuarterPct && c.ladderQuarterPct < c.ladderNoEntryPct && c.ladderNoEntryPct < c.ladderHaltPct);
    assert.ok(c.ladderHalfPct - c.ladderRecoveryPct > 0, 'release level must be reachable');
    assert.ok(c.dailyLossPct <= c.weeklyLossPct);
  }
});

test('a raw over-limit config passed to sizeEntry cannot beat the ceilings', () => {
  const loose = Object.fromEntries(Object.keys(HARD_CEILINGS).map((k) => [k, 1e9]));
  const r = size({ config: { ...loose, minNotional: 10, stopGapSlipPct: 0.001, defaultFeePct: 0.001, defaultSlipPct: 0.0025 },
    signal: signal({ stopDistancePct: 0.02 }), volatility: 0.2 });
  assert.equal(r.rejected, false);
  assert.ok(r.riskAmount <= 10000 * 0.01 + 1e-9, 'risk per trade above ceiling');
  assert.ok(r.notional <= 10000 * 0.25 + 1e-9, 'position above ceiling');
});

test('a raw over-limit config passed to updateRiskState cannot loosen the halt', () => {
  const loose = { ladderHaltPct: 0.9, ladderNoEntryPct: 0.8, dailyLossPct: 0.9, weeklyLossPct: 0.9 };
  const { riskState: s } = tick(ready(), 7900, T0 + 60_000, { config: loose });
  assert.equal(s.halt.active, true);
  assert.equal(s.day.tripped, true);
});

test('defaults are frozen', () => {
  assert.ok(Object.isFrozen(CFG) && Object.isFrozen(HARD_CEILINGS) && Object.isFrozen(HARD_CEILINGS.riskPerTradePct));
});

console.log('\ndrawdown ladder');

test('initial state blocks entries until the first update has seen data', () => {
  assert.deepEqual(canEnter(initialRiskState(10000, T0)).reasons, ['market_data_unknown', 'data_unhealthy']);
  assert.deepEqual(canEnter(ready()), { ok: true, reason: 'ok', reasons: [] });
});

test('each rung trips at exactly its threshold and not a cent before', () => {
  const cases = [[0.05, 1], [0.10, 2], [0.15, 3], [0.20, 4]];
  for (const [dd, rung] of cases) {
    assert.equal(reachRung(dd).rung, rung, `at ${dd}`);
    assert.equal(reachRung(dd - 0.0001).rung, rung - 1, `just under ${dd}`);
  }
});

test('thresholds hold at float-awkward equity levels', () => {
  for (const high of [10000, 12345.67, 999.99, 3.3]) {
    const start = tick(initialRiskState(high, T0), high, T0).riskState;
    const c = JSON.parse(JSON.stringify(start));
    c.day.startEquity = c.week.startEquity = high * 0.95;
    assert.equal(tick(c, high * 0.95, T0 + 60_000).riskState.rung, 1, `high ${high}`);
  }
});

test('rung multipliers and entry blocks', () => {
  assert.deepEqual(LADDER_RUNGS.map((r) => r.sizeMultiplier), [1, 0.5, 0.25, 0, 0]);
  assert.equal(canEnter(reachRung(0.05)).ok, true);
  assert.equal(canEnter(reachRung(0.10)).ok, true);
  assert.equal(canEnter(reachRung(0.15)).reason, 'drawdown_no_entries');
  assert.equal(canEnter(reachRung(0.20)).reason, 'halted');
});

test('the drawdown is measured from the equity high, which ratchets up only', () => {
  const s = walk(ready(), [10500, 11000, 10800]);
  assert.equal(s.equityHigh, 11000);
  near(s.drawdown, 200 / 11000);
});

test('a jump past several rungs lands on the deepest one', () => {
  const s = reachRung(0.17);
  assert.equal(s.rung, 3);
});

test('hysteresis: oscillating around a threshold does not flicker', () => {
  let s = reachRung(0.05);
  let changes = 0;
  for (let i = 1; i <= 200; i++) {
    const equity = i % 2 ? 9510 : 9490; // 4.9% / 5.1%, either side of the threshold
    const r = tick(s, equity, T0 + HOUR + i * 60_000);
    s = r.riskState;
    changes += r.events.filter((e) => e.type === 'ladder_changed').length;
    assert.equal(s.rung, 1);
  }
  assert.equal(changes, 0);
});

test('hysteresis: release at exactly threshold minus recovery, not before', () => {
  const s = reachRung(0.05);
  assert.equal(tick(s, 9599, T0 + 2 * HOUR).riskState.rung, 1, '4.01% holds');
  assert.equal(tick(s, 9600, T0 + 2 * HOUR).riskState.rung, 0, '4.00% releases');
});

test('hysteresis: recovery steps up one band at a time and works on every rung', () => {
  const s = reachRung(0.17);
  assert.equal(tick(s, 8599, T0 + 2 * HOUR).riskState.rung, 3, '14.01% still inside the band');
  assert.equal(tick(s, 8600, T0 + 2 * HOUR).riskState.rung, 2, '14.00% is the release level');
  assert.equal(tick(s, 9100, T0 + 2 * HOUR).riskState.rung, 1);
  assert.equal(tick(s, 9700, T0 + 2 * HOUR).riskState.rung, 0);
});

test('hysteresis: worsening is immediate even inside the band', () => {
  const s = reachRung(0.05);
  assert.equal(tick(s, 9000, T0 + 2 * HOUR).riskState.rung, 2);
});

test('a new equity high clears every rung below the halt', () => {
  assert.equal(tick(reachRung(0.12), 10001, T0 + 2 * HOUR).riskState.rung, 0);
});

test('the halt rung flattens, and raises the event once', () => {
  const r = tick(ready(), 8000, T0 + 60_000);
  assert.equal(r.riskState.rung, 4);
  assert.equal(riskDirectives(r.riskState).flatten, true);
  assert.equal(r.events.filter((e) => e.type === 'drawdown_halt').length, 1);
  assert.equal(tick(r.riskState, 7900, T0 + 120_000).events.filter((e) => e.type === 'drawdown_halt').length, 0);
});

console.log('\nhalt');

test('halt never auto-clears: recovery, new highs, rollovers, restarts', () => {
  let s = tick(ready(), 8000, T0 + 60_000).riskState;
  for (let d = 1; d <= 60; d++) {
    s = JSON.parse(JSON.stringify(tick(s, 8000 + d * 500, T0 + d * DAY).riskState));
    assert.equal(s.halt.active, true, `day ${d}`);
    assert.equal(s.rung, 4, `rung on day ${d}`);
    assert.equal(canEnter(s).reason, 'halted');
  }
  assert.ok(s.equity > 10000);
});

test('manual halt blocks entries, keeps positions unless asked, and does not auto-clear', () => {
  const { riskState: s } = manualHalt(ready(), { t: T0, by: 'alice', reason: 'going on holiday' });
  assert.equal(canEnter(s).reason, 'halted');
  assert.equal(riskDirectives(s).flatten, false);
  assert.equal(s.halt.source, 'manual');
  assert.equal(riskDirectives(manualHalt(ready(), { t: T0, flatten: true }).riskState).flatten, true);
  assert.equal(tick(s, 20000, T0 + 30 * DAY).riskState.halt.active, true);
});

test('manual halt with bad arguments still halts', () => {
  for (const args of [undefined, {}, { t: NaN }]) assert.equal(canEnter(manualHalt(ready(), args).riskState).reason, 'halted');
  assert.equal(canEnter(manualHalt(null, {}).riskState).ok, false);
});

test('a manual halt upgrades to flatten if the ladder then reaches the halt rung', () => {
  const { riskState: s } = manualHalt(ready(), { t: T0, by: 'alice' });
  const after = tick(s, 7900, T0 + 60_000).riskState;
  assert.equal(riskDirectives(after).flatten, true);
});

test('re-enable needs confirm, a named human, a clock and equity', () => {
  const s = tick(ready(), 8000, T0 + 60_000).riskState;
  const good = { t: T0 + DAY, equity: 8000, by: 'alice', confirm: true };
  for (const [over, reason] of [[{ confirm: undefined }, 'not_confirmed'], [{ confirm: 'yes' }, 'not_confirmed'],
    [{ by: '' }, 'no_human_named'], [{ by: '  ' }, 'no_human_named'], [{ by: undefined }, 'no_human_named'],
    [{ t: NaN }, 'invalid_clock'], [{ equity: 0 }, 'invalid_equity'], [{ equity: NaN }, 'invalid_equity'],
    [{ t: T0 - DAY }, 'clock_regression']]) {
    const r = humanReEnable(s, { ...good, ...over });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(r.riskState, s);
  }
  assert.equal(humanReEnable(s).ok, false);
});

test('re-enable from the halt rebases the high, or the next tick would halt again', () => {
  const s = tick(ready(), 8000, T0 + 60_000).riskState;
  const r = humanReEnable(s, { t: T0 + 2 * DAY, equity: 8000, by: 'alice', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.riskState.halt.active, false);
  assert.equal(r.riskState.equityHigh, 8000);
  const next = tick(r.riskState, 8000, T0 + 2 * DAY + 60_000).riskState;
  assert.equal(next.halt.active, false);
  assert.equal(next.rung, 0);
  assert.equal(next.lastReEnable.by, 'alice');
  assert.equal(canEnter(next).reason, 'weekly_loss_limit', 'the -20% week is still latched on Saturday');
  assert.equal(canEnter(tick(next, 8000, Date.UTC(2026, 10, 9)).riskState).ok, true, 'and clears on Monday');
});

test('the no-entries rung can be cleared by a human when flat equity could never recover', () => {
  const s = reachRung(0.16);
  assert.equal(tick(s, 8400, T0 + 30 * DAY).riskState.rung, 3, 'stuck while flat');
  const r = humanReEnable(s, { t: T0 + 30 * DAY, equity: 8400, by: 'alice', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.riskState.rung, 0);
});

test('re-enabling a manual halt on a low rung keeps the drawdown size cut', () => {
  const s = manualHalt(reachRung(0.07), { t: T0 + 2 * HOUR, by: 'alice' }).riskState;
  const r = humanReEnable(s, { t: T0 + 3 * HOUR, equity: 9300, by: 'alice', confirm: true });
  assert.equal(r.riskState.rung, 1);
  assert.equal(r.riskState.equityHigh, 10000);
});

test('re-enable leaves daily, weekly, market and data blocks alone', () => {
  const s = tick(ready(), 8000, T0 + 60_000).riskState;
  const r = humanReEnable(s, { t: T0 + 2 * 60_000, equity: 8000, by: 'alice', confirm: true });
  assert.equal(canEnter(r.riskState).reason, 'daily_loss_limit');
});

test('re-enable with nothing to clear is refused', () => {
  assert.equal(humanReEnable(ready(), { t: T0 + 1, equity: 10000, by: 'alice', confirm: true }).reason, 'nothing_to_clear');
});

console.log('\nflat on a rung (deadlock)');

const ALICE = { by: 'alice', confirm: true };
/** Sit at this equity after a fall from 10,000, on whatever rung that is. */
const atEquity = (equity, high = 10000) => {
  const s = JSON.parse(JSON.stringify(tick(initialRiskState(high, T0), high, T0).riskState));
  s.day.startEquity = s.week.startEquity = equity;
  return tick(s, equity, T0 + HOUR, { openPositions: 0 }).riskState;
};
const stopAt = (stopDistancePct) => signal({ stopDistancePct });
/** Size an entry on a flat book at this equity. */
const flatSize = (riskState, equity, stop, sizeMultiplier) =>
  size({ riskState, equity, signal: stopAt(stop), sizeMultiplier });
/** Stuck state: the entry was refused as dust, and the engine has recorded it. */
const stuck = (equity, stop, sizeMultiplier, high) => {
  const s = atEquity(equity, high);
  const sized = flatSize(s, equity, stop, sizeMultiplier);
  assert.equal(sized.reason, 'below_min_notional');
  return noteEntryRejection(s, sized, { t: T0 + HOUR, openPositions: 0 }).riskState;
};

test('the $10,000 case: quarter rung, paper(half), wide stop is refused every entry', () => {
  const s = atEquity(8800);
  assert.equal(s.rung, 2);
  assert.equal(canEnter(s).ok, true, 'the ladder allows entries; only the size stops them');
  for (const stop of [0.22, 0.25]) {
    const r = flatSize(s, 8800, stop, 0.5);
    assert.equal(r.rejected, true, `stop ${stop}`);
    assert.equal(r.reason, 'below_min_notional');
    assert.equal(r.limit, 'drawdown_ladder_and_half_risk');
  }
});

test('the $10,000 case: exact edges of the rung', () => {
  // Exactly -15% is already the next rung, so the quarter rung starts just above 8,500.
  assert.equal(atEquity(8500).rung, 3);
  assert.equal(atEquity(8501).rung, 2);
  assert.equal(atEquity(9000).rung, 2);
  // 25% stops are refused across the whole quarter rung.
  assert.equal(flatSize(atEquity(8501), 8501, 0.25, 0.5).reason, 'below_min_notional');
  assert.equal(flatSize(atEquity(9000), 9000, 0.25, 0.5).reason, 'below_min_notional');
  // A stop of exactly 20% still clears $25 here: the true edge is about 20.5% to 21.7%.
  assert.equal(flatSize(atEquity(8501), 8501, 0.20, 0.5).rejected, false);
  assert.equal(flatSize(atEquity(8501), 8501, 0.205, 0.5).reason, 'below_min_notional');
  assert.equal(flatSize(atEquity(9000), 9000, 0.21, 0.5).rejected, false);
  assert.equal(flatSize(atEquity(9000), 9000, 0.218, 0.5).reason, 'below_min_notional');
});

test('the $10,000 case: stuck for good without a human, reported, and cleared by one', () => {
  let s = stuck(8800, 0.25, 0.5);
  assert.equal(s.rung, 2);
  assert.equal(riskDirectives(s).needsReview, true);
  assert.equal(s.review.reason, 'flat_entries_too_small');
  assert.equal(s.review.since, T0 + HOUR);

  // Sixty flat days through rollovers and restarts: nothing clears it.
  for (let d = 1; d <= 60; d++) {
    s = JSON.parse(JSON.stringify(tick(s, 8800, T0 + d * DAY, { openPositions: 0 }).riskState));
    assert.equal(s.rung, 2, `day ${d}`);
    assert.equal(riskDirectives(s).needsReview, true, `day ${d}`);
    assert.equal(flatSize(s, 8800, 0.25, 0.5).reason, 'below_min_notional');
  }

  const t = T0 + 61 * DAY;
  const r = humanReEnable(s, { t, equity: 8800, ...ALICE, openPositions: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.riskState.rung, 0);
  assert.equal(r.riskState.equityHigh, 8800);
  assert.equal(r.riskState.lastReEnable.fromRung, 2);
  assert.equal(r.riskState.lastReEnable.rebased, true);
  assert.equal(riskDirectives(r.riskState).needsReview, false);

  const next = tick(r.riskState, 8800, t + 60_000, { openPositions: 0 }).riskState;
  assert.equal(next.rung, 0, 'no re-trip on the next tick');
  const entry = flatSize(next, 8800, 0.25, 0.5);
  assert.equal(entry.rejected, false);
  near(entry.notional, 8800 * 0.005 * 0.5 / (0.25 + COST_DRAG));
});

test('the $1,000 case: half rung, half size below the minimum order', () => {
  const s = stuck(950, 0.15, 1, 1000);
  assert.equal(s.rung, 1);
  assert.equal(riskDirectives(s).needsReview, true);
  const r = humanReEnable(s, { t: T0 + DAY, equity: 950, ...ALICE, openPositions: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.riskState.rung, 0);
  assert.equal(flatSize(tick(r.riskState, 950, T0 + DAY + 1).riskState, 950, 0.15, 1).rejected, false);
});

test('flat alone cannot shed a size cut on rungs 1 and 2', () => {
  for (const [equity, rung] of [[9400, 1], [8800, 2]]) {
    const s = atEquity(equity);
    assert.equal(s.rung, rung);
    const r = humanReEnable(s, { t: T0 + 2 * HOUR, equity, ...ALICE, openPositions: 0 });
    assert.equal(r.ok, false, `rung ${rung}`);
    assert.equal(r.reason, 'nothing_to_clear');
    assert.equal(r.riskState, s);
  }
});

test('rungs 3 and 4 clear as before, with or without the position count', () => {
  for (const [equity, rung] of [[8400, 3], [7900, 4]]) {
    for (const openPositions of [0, undefined, 2]) {
      const s = atEquity(equity);
      assert.equal(s.rung, rung);
      const r = humanReEnable(s, { t: T0 + 2 * HOUR, equity, ...ALICE, openPositions });
      assert.equal(r.ok, true, `rung ${rung}`);
      assert.equal(r.riskState.rung, 0);
      assert.equal(r.riskState.equityHigh, equity);
      assert.equal(r.riskState.halt.active, false);
    }
  }
});

test('the deadlock clears only with an explicit zero positions', () => {
  const s = stuck(8800, 0.25, 0.5);
  const base = { t: T0 + 2 * HOUR, equity: 8800, ...ALICE };
  for (const openPositions of [1, 7, undefined, null, NaN, -1, '0', 0.5, false]) {
    const r = humanReEnable(s, { ...base, openPositions });
    assert.equal(r.ok, false, String(openPositions));
    assert.equal(r.reason, 'nothing_to_clear');
    assert.equal(r.riskState, s);
  }
  assert.equal(humanReEnable(s, { ...base, openPositions: 0 }).ok, true);
});

test('only the below-minimum review counts: other or stale flags do not clear a low rung', () => {
  const base = { t: T0 + 2 * HOUR, equity: 8800, ...ALICE, openPositions: 0 };
  const forged = JSON.parse(JSON.stringify(atEquity(8800)));
  forged.review = { needed: true, reason: 'flat_entries_blocked', since: T0 };
  assert.equal(humanReEnable(forged, base).reason, 'nothing_to_clear');
  const normal = JSON.parse(JSON.stringify(ready()));
  normal.review = { needed: true, reason: 'flat_entries_too_small', since: T0 };
  assert.equal(humanReEnable(normal, { ...base, t: T0 + 1 }).reason, 'nothing_to_clear');
  const lowered = JSON.parse(JSON.stringify(stuck(8800, 0.25, 0.5)));
  lowered.review.needed = false;
  assert.equal(humanReEnable(lowered, base).reason, 'nothing_to_clear');

  // A position opened, so that deadlock is over; flat again needs a fresh rejection.
  const traded = tick(stuck(8800, 0.25, 0.5), 8800, T0 + DAY, { openPositions: 1 }).riskState;
  const flatAgain = tick(traded, 8800, T0 + 2 * DAY, { openPositions: 0 }).riskState;
  const later = { ...base, t: T0 + 3 * DAY };
  assert.equal(humanReEnable(flatAgain, later).reason, 'nothing_to_clear');
  const noted = noteEntryRejection(flatAgain, flatSize(flatAgain, 8800, 0.25, 0.5), { t: T0 + 3 * DAY, openPositions: 0 }).riskState;
  assert.equal(humanReEnable(noted, later).ok, true);
});

test('a blocked-rung flag does not outlive the rung, so a real rejection can still be recorded', () => {
  const blocked = atEquity(8400);
  assert.equal(blocked.review.reason, 'flat_entries_blocked');
  const up = tick(blocked, 8800, T0 + DAY, { openPositions: 0 }).riskState;
  assert.equal(up.rung, 2);
  assert.equal(riskDirectives(up).needsReview, false);
  const noted = noteEntryRejection(up, flatSize(up, 8800, 0.25, 0.5), { t: T0 + DAY, openPositions: 0 }).riskState;
  assert.equal(noted.review.reason, 'flat_entries_too_small');
});

test('flat re-enable still needs confirm and a named human', () => {
  const s = stuck(8800, 0.25, 0.5);
  const base = { t: T0 + DAY, equity: 8800, openPositions: 0 };
  assert.equal(humanReEnable(s, { ...base, by: 'alice' }).reason, 'not_confirmed');
  assert.equal(humanReEnable(s, { ...base, confirm: true }).reason, 'no_human_named');
  assert.equal(humanReEnable(s, { ...base, ...ALICE, equity: NaN }).reason, 'invalid_equity');
});

test('rung 0 still has nothing to clear, flat or not', () => {
  assert.equal(humanReEnable(ready(), { t: T0 + 1, equity: 10000, ...ALICE, openPositions: 0 }).reason, 'nothing_to_clear');
});

test('a manual halt on a low rung keeps the size cut, flat or not, unless deadlocked', () => {
  const s = manualHalt(atEquity(9300), { t: T0 + 2 * HOUR, by: 'alice' }).riskState;
  const base = { t: T0 + 3 * HOUR, equity: 9300, ...ALICE };
  for (const openPositions of [2, 0, undefined]) {
    const r = humanReEnable(s, { ...base, openPositions });
    assert.equal(r.ok, true);
    assert.equal(r.riskState.halt.active, false);
    assert.equal(r.riskState.rung, 1);
    assert.equal(r.riskState.equityHigh, 10000);
    assert.equal(r.riskState.lastReEnable.rebased, false);
  }
  const dead = manualHalt(stuck(8800, 0.25, 0.5), { t: T0 + 2 * HOUR, by: 'alice' }).riskState;
  assert.equal(humanReEnable(dead, { ...base, equity: 8800, openPositions: 0 }).riskState.rung, 0);
  assert.equal(humanReEnable(dead, { ...base, equity: 8800, openPositions: 1 }).riskState.rung, 2);
});

test('the flat re-enable leaves daily, weekly, market and data blocks in place', () => {
  const fell = tick(stuck(8800, 0.25, 0.5), 8620, T0 + 2 * HOUR, { openPositions: 0 }).riskState;
  assert.equal(fell.rung, 2);
  assert.equal(fell.day.tripped, true);
  const r = humanReEnable(fell, { t: T0 + 3 * HOUR, equity: 8620, ...ALICE, openPositions: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(canEnter(r.riskState).reasons, ['daily_loss_limit']);
  assert.equal(size({ riskState: r.riskState }).rejected, true);
});

test('the fix loosens nothing: config, ceilings and sizing at each rung are untouched', () => {
  const s = stuck(8800, 0.25, 0.5);
  const before = clampRiskConfig(CFG);
  const r = humanReEnable(s, { t: T0 + DAY, equity: 8800, ...ALICE, openPositions: 0 }).riskState;
  assert.deepEqual(clampRiskConfig(CFG), before);
  assert.equal(CFG.minNotional, 25);
  assert.equal(HARD_CEILINGS.minNotional.min, 10);
  // Still refused at the same stop on the same rung: review changes nothing about size.
  assert.equal(flatSize(s, 8800, 0.25, 0.5).reason, 'below_min_notional');
  // The ladder works from the new high: 5% below 8,800 halves again.
  const after = tick(tick(r, 8800, T0 + DAY + 1).riskState, 8360, T0 + DAY + 2).riskState;
  assert.equal(after.rung, 1);
});

test('review does not change entries: the rung still allows a tighter stop', () => {
  const s = stuck(8800, 0.25, 0.5);
  assert.equal(canEnter(s).ok, true);
  assert.equal(riskDirectives(s).entriesAllowed, true);
  assert.equal(flatSize(s, 8800, 0.10, 0.5).rejected, false);
});

test('review goes when a position opens or the rung is gone, and never lifts the rung itself', () => {
  const s = stuck(8800, 0.25, 0.5);
  const opened = tick(s, 8800, T0 + DAY, { openPositions: 1 });
  assert.equal(riskDirectives(opened.riskState).needsReview, false);
  assert.equal(opened.riskState.rung, 2);
  assert.equal(opened.events.filter((e) => e.type === 'review_cleared').length, 1);
  assert.equal(riskDirectives(tick(s, 10001, T0 + DAY, { openPositions: 0 }).riskState).needsReview, false);
});

test('review holds when the position count is unknown or junk', () => {
  const s = stuck(8800, 0.25, 0.5);
  for (const openPositions of [undefined, null, NaN, -1, '1', 1.5]) {
    assert.equal(riskDirectives(tick(s, 8800, T0 + DAY, { openPositions }).riskState).needsReview, true, String(openPositions));
  }
});

test('only a flat dust rejection on a rung raises review', () => {
  const s = atEquity(8800);
  const dust = flatSize(s, 8800, 0.25, 0.5);
  const at = { t: T0 + HOUR };
  const none = (state, sized, o) => assert.equal(noteEntryRejection(state, sized, o).riskState, state);
  none(s, dust, { ...at, openPositions: 3 });
  none(s, dust, { ...at, openPositions: undefined });
  none(s, dust, undefined);
  none(s, { rejected: true, reason: 'stop_too_wide' }, { ...at, openPositions: 0 });
  none(s, flatSize(s, 8800, 0.05, 1), { ...at, openPositions: 0 });
  for (const junk of [undefined, null, 5, 'x', {}]) none(s, junk, { ...at, openPositions: 0 });
  none(atEquity(10000), dust, { ...at, openPositions: 0 });
  for (const junk of [undefined, null, 'x', {}]) none(junk, dust, { ...at, openPositions: 0 });
});

test('noteEntryRejection raises one event, keeps the first date, and does not mutate', () => {
  const s = atEquity(8800);
  const dust = flatSize(s, 8800, 0.25, 0.5);
  const before = JSON.stringify(s);
  const first = noteEntryRejection(s, dust, { t: T0 + HOUR, openPositions: 0 });
  assert.equal(JSON.stringify(s), before);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'review_needed');
  const again = noteEntryRejection(first.riskState, dust, { t: T0 + DAY, openPositions: 0 });
  assert.equal(again.events.length, 0);
  assert.equal(again.riskState.review.since, T0 + HOUR);
  assert.equal(noteEntryRejection(s, dust, { t: NaN, openPositions: 0 }).riskState.review.since, s.t);
});

test('flat on the no-entries and halt rungs raises review from the tick itself', () => {
  for (const equity of [8400, 7900]) {
    const r = tick(ready(), equity, T0 + 60_000, { openPositions: 0 });
    assert.equal(riskDirectives(r.riskState).needsReview, true);
    assert.equal(r.riskState.review.reason, 'flat_entries_blocked');
    assert.equal(r.events.filter((e) => e.type === 'review_needed').length, 1);
    assert.equal(tick(r.riskState, equity, T0 + 120_000, { openPositions: 0 }).events.filter((e) => e.type === 'review_needed').length, 0);
  }
  assert.equal(riskDirectives(tick(ready(), 8400, T0 + 60_000, { openPositions: 2 }).riskState).needsReview, false);
  assert.equal(riskDirectives(tick(ready(), 8400, T0 + 60_000).riskState).needsReview, false, 'unknown is not flat');
});

test('flat on rungs 0 to 2 alone is not a review: no signals yet is not a deadlock', () => {
  assert.equal(riskDirectives(tick(ready(), 10000, T0 + 1, { openPositions: 0 }).riskState).needsReview, false);
  assert.equal(riskDirectives(atEquity(9400)).needsReview, false);
  assert.equal(riskDirectives(atEquity(8800)).needsReview, false);
});

test('reEnablePreview agrees with humanReEnable at every rung and position count', () => {
  const dead = stuck(8800, 0.25, 0.5);
  for (const equity of [10000, 9400, 8800, 8400, 7900]) {
    for (const openPositions of [undefined, 0, 2]) {
      for (const state of [atEquity(equity), manualHalt(atEquity(equity), { t: T0 + 2 * HOUR }).riskState,
        dead, manualHalt(dead, { t: T0 + 2 * HOUR }).riskState]) {
        const p = reEnablePreview(state, { openPositions });
        const r = humanReEnable(state, { t: T0 + 3 * HOUR, equity, ...ALICE, openPositions });
        assert.equal(r.ok, p.allowed);
        assert.equal(r.reason, p.reason);
        if (r.ok) assert.equal(r.riskState.lastReEnable.rebased, p.willRebase);
      }
    }
  }
  assert.equal(reEnablePreview(null).allowed, true);
  assert.deepEqual(reEnablePreview(atEquity(8800), { openPositions: 0 }), { allowed: false, reason: 'nothing_to_clear', willRebase: false });
  assert.deepEqual(reEnablePreview(dead, { openPositions: 0 }), { allowed: true, reason: 'ok', willRebase: true });
  assert.equal(reEnablePreview(dead).allowed, false);
});

test('a state stored before the review field still loads, and review round-trips', () => {
  const old = JSON.parse(JSON.stringify(atEquity(8800)));
  delete old.review;
  assert.equal(canEnter(old).ok, true);
  assert.equal(riskDirectives(old).needsReview, false);
  assert.equal(tick(old, 8800, T0 + DAY, { openPositions: 0 }).riskState.review.needed, false);
  assert.equal(humanReEnable(old, { t: T0 + DAY, equity: 8800, ...ALICE, openPositions: 0 }).reason, 'nothing_to_clear');
  const noted = noteEntryRejection(old, flatSize(old, 8800, 0.25, 0.5), { t: T0 + DAY, openPositions: 0 }).riskState;
  assert.equal(noted.review.needed, true);
  assert.equal(humanReEnable(noted, { t: T0 + DAY, equity: 8800, ...ALICE, openPositions: 0 }).ok, true);

  const s = stuck(8800, 0.25, 0.5);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  const corrupt = JSON.parse(JSON.stringify(s));
  corrupt.review = 'yes';
  assert.equal(canEnter(corrupt).reason, 'risk_state_invalid');
  assert.equal(riskDirectives(corrupt).needsReview, true);
});

console.log('\ndaily and weekly limits');

test('daily limit trips at exactly -2% and not before', () => {
  assert.equal(tick(ready(), 9801, T0 + 60_000).riskState.day.tripped, false);
  const r = tick(ready(), 9800, T0 + 60_000);
  assert.equal(r.riskState.day.tripped, true);
  assert.equal(canEnter(r.riskState).reason, 'daily_loss_limit');
});

test('daily limit stays until the day rolls, even if equity recovers', () => {
  let s = tick(ready(), 9800, T0 + 60_000).riskState;
  s = tick(s, 10500, T0 + 2 * HOUR).riskState;
  assert.equal(canEnter(s).reason, 'daily_loss_limit');
  const lastMs = Date.UTC(2026, 10, 5, 23, 59, 59, 999);
  assert.equal(tick(s, 10500, lastMs).riskState.day.tripped, true, '23:59:59.999 UTC is the same day');
  const r = tick(s, 10500, Date.UTC(2026, 10, 6));
  assert.equal(r.riskState.day.tripped, false, '00:00:00.000 UTC is the next day');
  assert.equal(r.events.filter((e) => e.type === 'day_limit_cleared').length, 1);
  assert.equal(canEnter(r.riskState).ok, true);
});

test('weekly limit trips at exactly -4% without the daily limit, and rolls on Monday UTC', () => {
  // Three days of about -1.4% each: never a daily breach, a weekly one by Sunday.
  let s = ready();
  const levels = [[1, 9860], [2, 9720], [3, 9600]];
  for (const [d, eq] of levels) s = tick(s, eq, T0 + d * DAY).riskState;
  assert.equal(s.day.tripped, false);
  assert.equal(s.week.tripped, true);
  assert.equal(canEnter(s).reason, 'weekly_loss_limit');
  assert.equal(tick(s, 9600, Date.UTC(2026, 11 - 1, 8, 23, 59)).riskState.week.tripped, true, 'Sunday night');
  assert.equal(tick(s, 9600, Date.UTC(2026, 11 - 1, 9)).riskState.week.tripped, false, 'Monday 00:00 UTC');
});

test('just under the weekly limit does not trip it', () => {
  let s = ready();
  for (const [d, eq] of [[1, 9860], [2, 9720], [3, 9601]]) s = tick(s, eq, T0 + d * DAY).riskState;
  assert.equal(s.week.tripped, false);
});

test('period keys are UTC, and weeks start Monday', () => {
  assert.equal(utcDayKey(Date.UTC(2026, 10, 5, 23, 59, 59)), '2026-11-05');
  assert.equal(utcDayKey(Date.UTC(2026, 10, 6)), '2026-11-06');
  assert.equal(utcWeekKey(Date.UTC(2026, 10, 2)), '2026-11-02');
  assert.equal(utcWeekKey(Date.UTC(2026, 10, 8, 23, 59)), '2026-11-02');
  assert.equal(utcWeekKey(Date.UTC(2026, 10, 9)), '2026-11-09');
  assert.equal(utcWeekKey(Date.UTC(2027, 0, 1)), '2026-12-28', 'across a year end');
  assert.equal(utcWeekKey(0), '1969-12-29');
});

test('rollover takes the last equity seen as the new baseline', () => {
  const s = walk(ready(), [9900]);
  const r = tick(s, 9700, Date.UTC(2026, 10, 6)).riskState;
  assert.equal(r.day.startEquity, 9900);
  assert.equal(r.day.tripped, true, 'the 2.02% fall across the boundary still counts');
});

test('a process down over a rollover does not lose the loss', () => {
  const s = JSON.parse(JSON.stringify(ready()));
  const r = tick(s, 9500, T0 + 3 * DAY).riskState;
  assert.equal(r.day.tripped, true);
});

console.log('\nmarket breaker');

const marketTick = (s, t, bars) => tick(s, 10000, t, { btcBars: btc(t, bars) });

test('24h breaker trips at exactly -8%, not at -7.99%', () => {
  const t = T0 + HOUR;
  assert.equal(marketTick(ready(), t, { now: 92.01 }).riskState.market.tripped, false);
  const { riskState: s } = marketTick(ready(), t, { now: 92 });
  assert.equal(s.market.tripped, true);
  assert.equal(s.market.reason, 'btc_drop_24h');
  assert.equal(canEnter(s).reason, 'market_breaker');
  assert.equal(riskDirectives(s).tightenTrails, true);
});

test('7d breaker trips at exactly -15%, not at -14.99%', () => {
  const t = T0 + HOUR;
  assert.equal(marketTick(ready(), t, { now: 85.01, ago24: 85.01 }).riskState.market.tripped, false);
  // ago24 = now, so only the 7d window sees the fall.
  const bars = (now) => btc(t, { now, ago24: now, ago7d: 100 });
  assert.equal(tick(ready(), 10000, t, { btcBars: bars(85.01) }).riskState.market.tripped, false);
  const s = tick(ready(), 10000, t, { btcBars: bars(85) }).riskState;
  assert.equal(s.market.tripped, true);
  assert.equal(s.market.reason, 'btc_drop_7d');
});

test('works on daily bars, using the bar 24h and 7d before the last', () => {
  const t = Date.UTC(2026, 10, 6, 0, 30);
  const bars = [];
  for (let i = 10; i >= 1; i--) bars.push({ t: Date.UTC(2026, 10, 6) - i * DAY, c: i === 1 ? 92 : 100 });
  const s = tick(ready(), 10000, t, { btcBars: bars }).riskState;
  assert.equal(s.fault, null);
  assert.equal(s.market.ok, true);
  near(s.market.change24h, -0.08);
  assert.equal(s.market.tripped, true);
});

test('breaker stays through the cooldown, then needs recovery past the band', () => {
  const t = T0 + HOUR;
  const s = marketTick(ready(), t, { now: 92 }).riskState;
  assert.equal(marketTick(s, t + 23 * HOUR, { now: 100 }).riskState.market.tripped, true, 'cooldown not over');
  assert.equal(marketTick(s, t + 24 * HOUR, { now: 92.5 }).riskState.market.tripped, true, '-7.5% is inside the band');
  assert.equal(marketTick(s, t + 24 * HOUR, { now: 93 }).riskState.market.tripped, false, '-7% clears');
});

test('a fresh breach restarts the cooldown', () => {
  const t = T0 + HOUR;
  let s = marketTick(ready(), t, { now: 92 }).riskState;
  s = marketTick(s, t + 20 * HOUR, { now: 91 }).riskState;
  assert.equal(marketTick(s, t + 25 * HOUR, { now: 100 }).riskState.market.tripped, true);
  assert.equal(marketTick(s, t + 44 * HOUR, { now: 100 }).riskState.market.tripped, false);
});

test('missing, stale, short, future, gappy or broken BTC bars block entries', () => {
  const t = T0 + HOUR;
  const good = btc(t);
  const gappy = good.filter((b) => b.t > good.at(-1).t - 20 * HOUR || b.t < good.at(-1).t - 30 * HOUR);
  const cases = {
    undefined, null: null, empty: [], one: good.slice(-1), notArray: 'x',
    stale: btc(t - 3 * HOUR),
    short: good.slice(-100),
    future: btc(t + 3 * HOUR),
    gappy,
    nan: [...good.slice(0, -1), { ...good.at(-1), c: NaN }],
    zero: [...good.slice(0, -1), { ...good.at(-1), c: 0 }],
    reversed: [...good].reverse(),
  };
  for (const [name, btcBars] of Object.entries(cases)) {
    const s = tick(ready(), 10000, t, { btcBars }).riskState;
    assert.equal(s.market.ok, false, name);
    assert.equal(canEnter(s).reason, 'market_data_unknown', name);
  }
});

test('a tripped breaker does not clear while BTC data is unknown', () => {
  const t = T0 + HOUR;
  const s = marketTick(ready(), t, { now: 92 }).riskState;
  assert.equal(tick(s, 10000, t + 48 * HOUR, { btcBars: null }).riskState.market.tripped, true);
});

test('a known breach still trips when the other window is unknown', () => {
  const t = T0 + HOUR;
  const s = tick(ready(), 10000, t, { btcBars: btc(t, { now: 92 }).slice(-100) }).riskState;
  assert.equal(s.market.tripped, true);
  assert.equal(s.market.ok, false);
});

console.log('\ndata-health gate');

test('unhealthy, unknown or too few venues block entries; health returning reopens', () => {
  for (const dataHealth of [undefined, null, {}, { ok: false }, { ok: 'true' }, { ok: 1 }, [], [{ ok: true }],
    [{ ok: true }, { ok: false }], 'ok']) {
    const s = tick(ready(), 10000, T0 + 1, { dataHealth }).riskState;
    assert.equal(canEnter(s).reason, 'data_unhealthy', JSON.stringify(dataHealth));
  }
  const blocked = tick(ready(), 10000, T0 + 1, { dataHealth: { ok: false, reason: 'venues_disagree' } });
  assert.equal(blocked.riskState.data.reason, 'venues_disagree');
  assert.equal(blocked.events.filter((e) => e.type === 'data_gate_closed').length, 1);
  const open = tick(blocked.riskState, 10000, T0 + 2, { dataHealth: [{ ok: true }, { ok: true }, { ok: false }] });
  assert.equal(canEnter(open.riskState).ok, true);
});

test('bad data cannot set a false equity high', () => {
  const s = tick(ready(), 1e6, T0 + 1, { dataHealth: { ok: false } }).riskState;
  assert.equal(s.equityHigh, 10000);
});

test('the ladder and limits still run while data is unhealthy', () => {
  const s = tick(ready(), 8000, T0 + 1, { dataHealth: { ok: false } }).riskState;
  assert.equal(s.halt.active, true);
  assert.equal(riskDirectives(s).flatten, true);
});

console.log('\nrestart safety');

test('state round-trips through JSON exactly at every stage', () => {
  const states = [
    initialRiskState(10000, T0), initialRiskState(NaN, T0), ready(), reachRung(0.07), reachRung(0.2),
    marketTick(ready(), T0 + HOUR, { now: 92 }).riskState, tick(ready(), 9800, T0 + 1).riskState,
    tick(ready(), 10000, T0 + 1, { btcBars: null, dataHealth: null }).riskState,
    tick(ready(), NaN, T0 + 1).riskState, manualHalt(ready(), { t: T0, by: 'a' }).riskState,
  ];
  for (const s of states) assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
});

test('a restart on every tick behaves the same as an uninterrupted run', () => {
  const path = [];
  for (let i = 0; i < 24 * 12; i++) path.push(10000 * (1 + 0.09 * Math.sin(i / 7) - i / 2500));
  let plain = ready();
  let restarted = ready();
  path.forEach((equity, i) => {
    const t = T0 + (i + 1) * HOUR;
    plain = tick(plain, equity, t).riskState;
    restarted = JSON.parse(JSON.stringify(tick(JSON.parse(JSON.stringify(restarted)), equity, t).riskState));
  });
  assert.deepStrictEqual(restarted, plain);
  assert.ok(plain.rung > 0, 'the path should have reached the ladder');
});

test('a restart mid-day keeps the baseline and the latch', () => {
  let s = tick(ready(), 9800, T0 + 1).riskState;
  s = JSON.parse(JSON.stringify(s));
  const r = tick(s, 10200, T0 + 2 * HOUR).riskState;
  assert.equal(r.day.startEquity, 10000);
  assert.equal(r.day.tripped, true);
});

test('a restart inside the cooldown keeps the market breaker', () => {
  const t = T0 + HOUR;
  const s = JSON.parse(JSON.stringify(marketTick(ready(), t, { now: 92 }).riskState));
  assert.equal(marketTick(s, t + HOUR, { now: 100 }).riskState.market.tripped, true);
});

test('updateRiskState does not mutate its input', () => {
  const s = ready();
  const before = JSON.stringify(s);
  tick(s, 8000, T0 + DAY);
  assert.equal(JSON.stringify(s), before);
  Object.freeze(s);
  assert.doesNotThrow(() => tick(s, 8000, T0 + DAY));
  manualHalt(s, { t: T0 });
  assert.equal(JSON.stringify(s), before);
});

console.log('\nfailing closed');

const JUNK = [undefined, null, NaN, Infinity, -Infinity, 0, -1, '', 'abc', {}, [], true];

test('canEnter: anything that is not a valid state is a no, without throwing', () => {
  for (const s of JUNK) assert.deepEqual(canEnter(s).ok, false, String(s));
  assert.equal(canEnter().ok, false);
  for (const damage of [
    (s) => { s.version = 99; }, (s) => { delete s.halt; }, (s) => { s.halt.active = 'false'; }, (s) => { s.rung = 9; },
    (s) => { s.rung = NaN; }, (s) => { delete s.day; }, (s) => { s.data = null; }, (s) => { s.market.ok = 1; },
    (s) => { s.equityHigh = 'x'; }, (s) => { s.day.startEquity = 'x'; }, (s) => { s.week.startEquity = -1; },
  ]) {
    const s = JSON.parse(JSON.stringify(ready()));
    damage(s);
    assert.equal(canEnter(s).reason, 'risk_state_invalid', damage.toString());
  }
});

test('a corrupt or missing stored state halts and needs a human, it is not reset', () => {
  for (const s of JUNK) {
    const r = tick(s, 10000, T0 + 1);
    assert.equal(r.riskState.halt.active, true, String(s));
    assert.equal(r.riskState.halt.source, 'fail_safe');
    assert.equal(riskDirectives(r.riskState).flatten, false, 'an unreadable state must not dump positions');
    assert.equal(r.events[0].type, 'risk_state_corrupt');
    assert.equal(tick(r.riskState, 10000, T0 + DAY).riskState.halt.active, true);
    assert.equal(canEnter(tick(r.riskState, 10000, T0 + DAY).riskState).ok, false);
  }
  const fixed = humanReEnable(tick(null, 10000, T0).riskState, { t: T0 + 1, equity: 10000, by: 'alice', confirm: true });
  assert.equal(fixed.ok, true);
  assert.equal(canEnter(tick(fixed.riskState, 10000, T0 + 2).riskState).ok, true);
  assert.equal(humanReEnable('garbage', { t: T0 + 1, equity: 10000, by: 'alice', confirm: true }).ok, true);
});

test('initialRiskState with bad inputs refuses entries for good', () => {
  for (const [e, t] of [[NaN, T0], [0, T0], [-5, T0], [undefined, T0], [10000, NaN], [10000, undefined], [10000, -1], ['1', T0]]) {
    const s = initialRiskState(e, t);
    assert.equal(canEnter(s).ok, false);
    assert.equal(canEnter(tick(s, 10000, T0 + 1).riskState).ok, false);
  }
});

test('updateRiskState: bad equity blocks entries, leaves the ladder alone, and heals', () => {
  for (const equity of JUNK.filter((v) => !(Number.isFinite(v) && v > 0) && v !== Infinity)) {
    const r = tick(ready(), equity, T0 + 1);
    assert.equal(canEnter(r.riskState).reason, 'input_fault', String(equity));
    assert.equal(r.riskState.equity, 10000);
    assert.equal(r.riskState.halt.active, false);
    assert.equal(canEnter(tick(r.riskState, 10000, T0 + 2).riskState).ok, true);
  }
  assert.equal(canEnter(tick(ready(), Infinity, T0 + 1).riskState).reason, 'input_fault');
});

test('updateRiskState: a bad or backward clock changes nothing and blocks entries', () => {
  for (const t of [undefined, null, NaN, Infinity, -1, 'x', 1e20]) {
    const s = updateRiskState(ready(), { t, equity: 5000, btcBars: [], dataHealth: OK, config: CFG }).riskState;
    assert.equal(s.fault, 'invalid_clock', String(t));
    assert.equal(s.equity, 10000);
    assert.equal(canEnter(s).reason, 'input_fault');
  }
  const back = tick(ready(), 5000, T0 - DAY).riskState;
  assert.equal(back.fault, 'clock_regression');
  assert.equal(back.day.key, utcDayKey(T0), 'a backward clock must not rewind the period');
  assert.equal(canEnter(tick(back, 10000, T0 + 1).riskState).ok, true);
});

test('updateRiskState: junk input objects do not crash', () => {
  for (const input of JUNK) assert.equal(canEnter(updateRiskState(ready(), input).riskState).ok, false);
  assert.equal(canEnter(updateRiskState(ready()).riskState).ok, false);
  assert.equal(canEnter(updateRiskState().riskState).ok, false);
});

test('updateRiskState: a missing config blocks entries but still catches a halt', () => {
  for (const config of [undefined, null, 'x', 5, []]) {
    assert.equal(canEnter(tick(ready(), 10000, T0 + 1, { config }).riskState).reason, 'input_fault');
  }
  assert.equal(tick(ready(), 8000, T0 + 1, { config: undefined }).riskState.halt.active, true);
});

test('sizeEntry: each required input, when junk, rejects with no size', () => {
  const fields = {
    signal: JUNK, price: JUNK, equity: JUNK, positions: [undefined, null, NaN, 0, 'x', {}, true], riskState: JUNK,
    config: [undefined, null, NaN, 0, 'x', [], true], volatility: [undefined, null, NaN, Infinity, 0, -1, 'x', {}, []],
    correlations: [undefined, null, NaN, 0, -1, 'x', [], true], sizeMultiplier: JUNK,
  };
  for (const [field, values] of Object.entries(fields)) {
    for (const v of values) {
      const r = size({ [field]: v });
      assert.equal(r.rejected, true, `${field}=${String(v)}`);
      assert.equal(r.qty, 0);
      assert.equal(r.notional, 0);
      assert.equal(r.riskAmount, 0);
      assert.equal(typeof r.reason, 'string');
    }
  }
});

test('sizeEntry: junk in the signal fields rejects', () => {
  for (const v of [undefined, null, NaN, Infinity, 0, -0.05, 'x', {}]) {
    assert.equal(size({ signal: signal({ stopDistancePct: v }) }).rejected, true, String(v));
  }
  for (const v of [undefined, null, '', 5]) assert.equal(size({ signal: signal({ symbol: v }) }).reason, 'invalid_signal');
  for (const v of [undefined, null, 'flat', 'buy', 1]) assert.equal(size({ signal: signal({ side: v }) }).reason, 'not_an_entry');
});

test('sizeEntry: no stop means no trade', () => {
  assert.equal(size({ signal: signal({ stopDistancePct: undefined }) }).reason, 'no_stop');
});

test('sizeEntry: an unreadable open position blocks new risk', () => {
  for (const bad of [null, 5, {}, position('X', 100, { qty: NaN }), position('X', 100, { qty: 0 }),
    position('X', 100, { stopPrice: undefined }), position('X', 100, { entryPrice: -1 }), position('X', 100, { symbol: undefined })]) {
    assert.equal(size({ positions: [bad] }).reason, 'invalid_positions', JSON.stringify(bad));
  }
});

test('sizeEntry: bad optional inputs reject, undefined ones use the cautious default', () => {
  for (const costs of [null, {}, { feePct: NaN, slipPct: 0.001 }, { feePct: 0.001 }, { feePct: 0, slipPct: 0.001 }, { feePct: -1, slipPct: 1 }]) {
    assert.equal(size({ costs }).reason, 'invalid_costs', JSON.stringify(costs));
  }
  for (const cash of [NaN, -1, null, 'x', Infinity]) assert.equal(size({ cash }).reason, 'invalid_cash', String(cash));
  near(size().notional, fullSize);
});

test('sizeEntry: a hostile argument that throws is a rejection, not a crash', () => {
  const r = size({ positions: [new Proxy({}, { get() { throw new Error('boom'); } })] });
  assert.equal(r.rejected, true);
  assert.equal(sizeEntry().rejected, true);
  assert.equal(sizeEntry(null).rejected, true);
});

test('sizeEntry: every entry block in canEnter also blocks sizing', () => {
  const blocked = [reachRung(0.15), reachRung(0.20), tick(ready(), 9800, T0 + 1).riskState,
    marketTick(ready(), T0 + HOUR, { now: 92 }).riskState, tick(ready(), 10000, T0 + 1, { dataHealth: null }).riskState,
    manualHalt(ready(), { t: T0 }).riskState, initialRiskState(10000, T0)];
  for (const riskState of blocked) {
    const r = size({ riskState });
    assert.equal(r.rejected, true);
    assert.equal(r.reason, canEnter(riskState).reason);
    assert.equal(r.limit, 'can_enter');
  }
});

console.log('\nsizing');

test('risk per trade: loss at the stop, costs included, is exactly 0.5% of equity', () => {
  const r = size();
  assert.equal(r.rejected, false);
  assert.equal(r.reason, 'risk_per_trade');
  near(r.riskAmount, 50);
  near(r.notional, fullSize);
  near(r.qty * 100, r.notional);
});

test('costs and stop-gap slip shrink the size against a costless calculation', () => {
  const r = size();
  assert.ok(r.notional < 10000 * 0.005 / 0.05);
  near(r.lossPerNotional, 0.05 + 0.002 + 0.005 + 0.001);
  const tier1 = size({ costs: { feePct: 0.001, slipPct: 0.0003 } });
  near(tier1.lossPerNotional, 0.05 + 0.002 + 0.0006 + 0.001);
  assert.ok(tier1.notional > r.notional);
});

test('the realised loss on a worst-case stop fill stays within the risk amount', () => {
  const fee = 0.001, slip = 0.0025, gap = 0.001, stop = 0.05;
  const r = size();
  const fill = 100 * (1 + slip);
  const exit = 100 * (1 - stop) * (1 - slip - gap);
  const loss = r.qty * (fill - exit) + r.qty * fill * fee + r.qty * exit * fee;
  assert.ok(loss <= r.riskAmount, `loss ${loss} > budget ${r.riskAmount}`);
  assert.ok(loss > r.riskAmount * 0.97, 'the allowance should not be wildly padded');
});

test('stop distance limits apply at the exact boundary', () => {
  assert.equal(size({ signal: signal({ stopDistancePct: 0.005 }) }).rejected, false);
  assert.equal(size({ signal: signal({ stopDistancePct: 0.0049 }) }).reason, 'stop_too_tight');
  assert.equal(size({ signal: signal({ stopDistancePct: 0.25 }) }).rejected, false);
  assert.equal(size({ signal: signal({ stopDistancePct: 0.2501 }) }).reason, 'stop_too_wide');
  assert.equal(size({ signal: signal({ stopDistancePct: 5 }) }).reason, 'stop_too_wide', 'percent passed by mistake');
});

test('max position caps a tight stop at 20% of equity', () => {
  const r = size({ signal: signal({ stopDistancePct: 0.005 }), costs: { feePct: 0.0001, slipPct: 0.0001 } });
  assert.equal(r.reason, 'max_position');
  near(r.notional, 2000);
});

test('max position counts what is already held in the same symbol', () => {
  const r = size({ positions: [position('SOLUSDT', 1900, { stopPrice: 99.9 })],
    correlations: { SOLUSDT: {} }, volatility: { SOLUSDT: 0.3 } });
  assert.equal(r.reason, 'max_position');
  near(r.notional, 100);
});

test('open risk: room is what is left under 3%, at exactly the cap the entry is rejected', () => {
  // held(x) builds a position whose open risk, exit costs included, is exactly x.
  const corr = { SOLUSDT: { BTCUSDT: 0, ETHUSDT: 0 }, BTCUSDT: { ETHUSDT: 0 } };
  const exitCost = 0.001 + 0.0025 + 0.001;
  const held = (risk) => position('BTCUSDT', 1000, { stopPrice: 100 - (risk / 10 - 100 * exitCost) });
  const r = size({ positions: [held(290)], correlations: corr });
  assert.equal(r.reason, 'open_risk');
  near(r.riskAmount, 10);
  const full = size({ positions: [held(300)], correlations: corr });
  assert.equal(full.rejected, true);
  assert.equal(full.reason, 'below_min_notional');
  assert.equal(full.limit, 'open_risk');
});

test('open risk uses the live price: a position up a lot has more to give back', () => {
  const corr = { SOLUSDT: { BTCUSDT: 0 } };
  const p = position('BTCUSDT', 1000, { stopPrice: 99 });
  const low = size({ positions: [p], correlations: corr, prices: { BTCUSDT: 100 } });
  const high = size({ positions: [p], correlations: corr, prices: new Map([['BTCUSDT', 124]]) });
  assert.equal(low.reason, 'risk_per_trade');
  assert.equal(high.reason, 'open_risk');
});

test('with no live price, the highest known price is used, never a stale low one', () => {
  const corr = { SOLUSDT: { BTCUSDT: 0 } };
  const p = position('BTCUSDT', 1000, { stopPrice: 99, highWater: 124 });
  assert.equal(size({ positions: [p], correlations: corr }).reason, 'open_risk');
});

test('gross exposure: room is what is left under 100%, measured at the fill', () => {
  const syms = ['A', 'B', 'C', 'D', 'E'];
  const corr = { SOLUSDT: Object.fromEntries(syms.map((s) => [s, 0])) };
  for (const a of syms) corr[a] = Object.fromEntries(syms.map((s) => [s, 0]));
  const held = syms.map((s) => position(s, 1980, { stopPrice: 99.99 }));
  const r = size({ positions: held, correlations: corr, volatility: new Map([['SOLUSDT', 0.1], ...syms.map((s) => [s, 0.1])]),
    config: { ...CFG, volTargetAnnual: 0.20 } });
  assert.equal(r.reason, 'gross_exposure');
  near(r.notional * (1 + 0.001 + 0.0025), 100);
  const atCap = syms.map((s) => position(s, 2000, { stopPrice: 99.99 }));
  const none = size({ positions: atCap, correlations: corr, volatility: new Map([['SOLUSDT', 0.1], ...syms.map((s) => [s, 0.1])]) });
  assert.equal(none.rejected, true);
});

test('cluster: correlated holdings share one 40% cap; uncorrelated ones do not count', () => {
  const held = [position('A', 1900, { stopPrice: 99.99 }), position('B', 1980, { stopPrice: 99.99 }), position('C', 2000, { stopPrice: 99.99 })];
  const corr = { SOLUSDT: { A: 0.8, B: 0.7, C: 0.69 }, A: { B: 0, C: 0 }, B: { C: 0 } };
  const vols = { SOLUSDT: 0.1, A: 0.1, B: 0.1, C: 0.1 };
  const r = size({ positions: held, correlations: corr, volatility: vols });
  assert.equal(r.reason, 'cluster');
  near(r.notional * (1 + 0.001 + 0.0025), 120);
});

test('cluster: a negative correlation counts by size, and an unknown pair counts as correlated', () => {
  const held = [position('A', 2000, { stopPrice: 99.99 }), position('B', 2000, { stopPrice: 99.99 })];
  const vols = { SOLUSDT: 0.1, A: 0.1, B: 0.1 };
  const neg = size({ positions: held, correlations: { SOLUSDT: { A: -0.9, B: 0.9 }, A: { B: 0 } }, volatility: vols });
  assert.equal(neg.rejected, true);
  assert.equal(neg.limit, 'cluster');
  const unknown = size({ positions: held, correlations: { A: { B: 0 } }, volatility: vols });
  assert.equal(unknown.limit, 'cluster');
  const nan = size({ positions: held, correlations: new Map([['SOLUSDT', new Map([['A', NaN], ['B', NaN]])]]), volatility: vols });
  assert.equal(nan.limit, 'cluster');
});

test('correlations can be looked up in either direction, Map or object', () => {
  const held = [position('A', 2000, { stopPrice: 99.99 }), position('B', 2000, { stopPrice: 99.99 })];
  const vols = { SOLUSDT: 0.1, A: 0.1, B: 0.1 };
  const reversed = { A: { SOLUSDT: 0.1, B: 0 }, B: { SOLUSDT: 0.1 } };
  assert.equal(size({ positions: held, correlations: reversed, volatility: vols }).reason, 'risk_per_trade');
});

test('vol target: a lone position is capped at target / asset vol', () => {
  const r = size({ signal: signal({ stopDistancePct: 0.01 }), volatility: 4 });
  assert.equal(r.reason, 'vol_target');
  near(r.notional, 10000 * 0.18 / 4);
});

test('vol target: projected portfolio vol lands exactly on target, correlation included', () => {
  const rho = 0.5, vA = 0.6, vC = 2, wA = 0.1;
  const r = size({ positions: [position('A', 1000, { stopPrice: 99.99 })], signal: signal({ stopDistancePct: 0.01 }),
    volatility: { SOLUSDT: vC, A: vA }, correlations: { SOLUSDT: { A: rho } } });
  assert.equal(r.reason, 'vol_target');
  const w = r.notional / 10000;
  near(Math.sqrt((wA * vA) ** 2 + (w * vC) ** 2 + 2 * rho * wA * vA * w * vC), 0.18, 1e-9);
});

test('vol target: a book already at target rejects, and it never sizes up', () => {
  const held = [position('A', 2000, { stopPrice: 99.99 })];
  const at = size({ positions: held, volatility: { SOLUSDT: 0.8, A: 0.9 }, correlations: { SOLUSDT: { A: 0 } } });
  assert.equal(at.rejected, true);
  assert.equal(at.limit, 'vol_target');
  near(size({ volatility: 0.15 }).notional, fullSize);
});

test('vol target: a held position with no known vol is assumed at least as wild as the default', () => {
  const held = [position('A', 2000, { stopPrice: 99.99 })];
  const r = size({ positions: held, volatility: { SOLUSDT: 0.8 }, correlations: { SOLUSDT: { A: 0 } } });
  assert.equal(r.rejected, true);
  assert.equal(r.limit, 'vol_target');
});

test('a daily vol passed by mistake is refused rather than read as a calm asset', () => {
  assert.equal(size({ volatility: 0.04 }).reason, 'volatility_implausible');
  assert.equal(size({ volatility: 0.10 }).rejected, false);
});

test('cash: never spends more than is available, fees included', () => {
  const r = size({ cash: 200 });
  assert.equal(r.reason, 'cash');
  near(r.notional * (1 + 0.001 + 0.0025), 200);
  assert.equal(size({ cash: 0 }).limit, 'cash');
  assert.equal(size({ cash: 1e9 }).reason, 'risk_per_trade');
});

test('min notional: exact minimum passes, a cent under is rejected, never shrunk to dust', () => {
  const cfg = { ...CFG, minNotional: 100 };
  const atMin = size({ cash: 100 * (1 + 0.001 + 0.0025), config: cfg });
  assert.equal(atMin.rejected, false);
  near(atMin.notional, 100);
  const under = size({ cash: 99.99, config: cfg });
  assert.equal(under.rejected, true);
  assert.equal(under.reason, 'below_min_notional');
  assert.equal(under.limit, 'cash');
  assert.equal(under.qty, 0);
});

test('a tiny account is rejected rather than taking a dust position', () => {
  assert.equal(size({ equity: 20, signal: signal({ stopDistancePct: 0.2 }) }).reason, 'below_min_notional');
});

test('shorts and flats are not entries here', () => {
  assert.equal(size({ signal: signal({ side: 'short' }) }).reason, 'short_not_supported');
  assert.equal(size({ signal: signal({ side: 'flat' }) }).reason, 'not_an_entry');
});

test('positions may be a Map or an array', () => {
  const p = position('A', 1000);
  const corr = { SOLUSDT: { A: 0 } };
  assert.deepEqual(size({ positions: new Map([['A', p]]), correlations: corr }), size({ positions: [p], correlations: corr }));
});

console.log('\nmultipliers');

test('ladder multipliers apply on their own', () => {
  const half = size({ riskState: reachRung(0.05) });
  assert.equal(half.reason, 'drawdown_ladder');
  near(half.notional, fullSize * 0.5);
  near(size({ riskState: reachRung(0.10) }).notional, fullSize * 0.25);
});

test('half-risk applies on its own', () => {
  const r = size({ sizeMultiplier: 0.5 });
  assert.equal(r.reason, 'half_risk');
  near(r.notional, fullSize * 0.5);
  near(r.riskAmount, 25);
});

test('multipliers compose: ladder x half-risk', () => {
  for (const [dd, m] of [[0.05, 0.25], [0.10, 0.125]]) {
    const r = size({ riskState: reachRung(dd), sizeMultiplier: 0.5 });
    assert.equal(r.reason, 'drawdown_ladder_and_half_risk');
    assert.equal(r.multiplier, m);
    near(r.notional, fullSize * m);
  }
});

test('a size multiplier above 1 never sizes up, and cannot cancel a ladder cut', () => {
  near(size({ sizeMultiplier: 3 }).notional, fullSize);
  near(size({ sizeMultiplier: 2, riskState: reachRung(0.05) }).notional, fullSize * 0.5);
  near(size({ sizeMultiplier: 4, riskState: reachRung(0.10) }).notional, fullSize * 0.25);
});

test('half size halves a capped position too: multipliers come after the position cap', () => {
  const tight = { signal: signal({ stopDistancePct: 0.005 }), costs: { feePct: 0.0001, slipPct: 0.0001 } };
  near(size(tight).notional, 2000);
  near(size({ ...tight, sizeMultiplier: 0.5 }).notional, 1000);
});

test('portfolio caps come after multipliers: a multiplier cannot be used to win back room', () => {
  const r = size({ riskState: reachRung(0.05), cash: 100 });
  assert.equal(r.reason, 'cash');
  near(r.notional * (1 + 0.001 + 0.0025), 100);
});

test('the decision trace lists the steps in the documented order', () => {
  const r = size({ riskState: reachRung(0.05), cash: 1e6 });
  assert.deepEqual(r.trace.map((x) => x.limit),
    ['risk_per_trade', 'max_position', 'drawdown_ladder', 'vol_target', 'open_risk', 'gross_exposure', 'cluster', 'cash']);
  assert.doesNotThrow(() => JSON.stringify(r));
});

console.log('\nexits are never gated');

test('nothing exported takes an exit or can veto one', () => {
  for (const name of Object.keys(risk)) assert.ok(!/exit/i.test(name), name);
  const states = [reachRung(0.15), reachRung(0.20), tick(ready(), 9800, T0 + 1).riskState,
    marketTick(ready(), T0 + HOUR, { now: 92 }).riskState, tick(ready(), 10000, T0 + 1, { dataHealth: null }).riskState,
    tick(ready(), NaN, T0 + 1).riskState, manualHalt(ready(), { t: T0 }).riskState, null, 'garbage'];
  for (const s of states) {
    assert.deepEqual(Object.keys(riskDirectives(s)).sort(), ['entriesAllowed', 'flatten', 'needsReview', 'sizeMultiplier', 'tightenTrails']);
    assert.equal(riskDirectives(s).entriesAllowed, false);
  }
});

test('every block leaves the state in a shape that only ever asks for more exits', () => {
  const halted = tick(ready(), 8000, T0 + 1).riskState;
  assert.equal(riskDirectives(halted).flatten, true);
  assert.equal(riskDirectives(marketTick(ready(), T0 + HOUR, { now: 92 }).riskState).tightenTrails, true);
  assert.equal(riskDirectives(null).tightenTrails, true);
});

test('flatten stays set through a restart until the human re-enables', () => {
  const s = JSON.parse(JSON.stringify(tick(ready(), 8000, T0 + 1).riskState));
  assert.equal(riskDirectives(tick(s, 8000, T0 + DAY).riskState).flatten, true);
  const r = humanReEnable(s, { t: T0 + DAY, equity: 8000, by: 'alice', confirm: true });
  assert.equal(riskDirectives(r.riskState).flatten, false);
});

// Review item 9: equity highs seen while data is unhealthy.
{
  const bad = { ok: false, reason: 'x' };
  const upd = (s, t, equity, dataHealth) => risk.updateRiskState(s, { t: T0 + t, equity, btcBars: btc(T0 + t), dataHealth, config: risk.clampRiskConfig({}), openPositions: 1 });
  const run = (steps) => {
    let s = risk.initialRiskState(10000, T0);
    const events = [];
    steps.forEach(([equity, health], i) => {
      const o = upd(s, i + 1, equity, health);
      s = o.riskState;
      events.push(...o.events);
    });
    return { s, events };
  };
  const ok = { ok: true };

  test('a high held through an outage is recovered when data returns', () => {
    const { s, events } = run([[13000, bad], [13100, bad], [10000, ok]]);
    assert.strictEqual(s.equityHigh, 13000);
    near(s.drawdown, 3000 / 13000);
    assert.ok(s.rung >= 3, `rung ${s.rung}`);
    assert.ok(events.some((e) => e.type === 'equity_high_recovered'));
    assert.strictEqual(s.outage, null);
  });

  test('a lone print during an outage sets no high, and is reported', () => {
    const { s, events } = run([[10100, bad], [13000, bad], [10100, bad], [10000, ok]]);
    assert.strictEqual(s.equityHigh, 10100);
    assert.strictEqual(s.rung, 0);
    assert.ok(events.some((e) => e.type === 'equity_high_unconfirmed'));
  });

  test('the p3 repro: one print then a healthy read cannot be told from a bad print', () => {
    const { s, events } = run([[13000, bad], [10000, ok]]);
    assert.strictEqual(s.equityHigh, 10000);
    assert.ok(events.some((e) => e.type === 'equity_high_unconfirmed'));
  });

  test('the high stays held across an outage, and old states without the field stay valid', () => {
    const { s } = run([[11000, bad], [11000, bad], [9000, bad]]);
    assert.strictEqual(s.equityHigh, 10000, 'not applied while data is bad');
    const { outage, ...older } = s;
    const o = upd(older, 9, 10000, ok);
    assert.strictEqual(o.riskState.fault ?? null, null);
    assert.strictEqual(upd(s, 9, 10000, ok).riskState.equityHigh, 11000);
  });
}

// Retest item 3: an unknown part of the book must not act on the ladder.
{
  const cfg = risk.clampRiskConfig({});
  const upd = (s, i, equity, equityUnknown) => risk.updateRiskState(s, { t: T0 + i, equity, btcBars: btc(T0 + i), dataHealth: { ok: true }, config: cfg, openPositions: 1, equityUnknown });

  test('frozen: a 40% hole neither steps the ladder nor flattens, and entries are held', () => {
    const o = upd(risk.initialRiskState(10000, T0), 1, 6000, true);
    assert.strictEqual(o.riskState.rung, 0);
    assert.strictEqual(risk.riskDirectives(o.riskState).flatten, false);
    assert.strictEqual(o.riskState.equity, 10000);
    assert.ok(o.events.some((e) => e.type === 'equity_frozen' && e.severity === 'critical'));
    assert.ok(risk.canEnter(o.riskState).reasons.includes('equity_unknown'));
  });

  test('unfrozen: the ladder is live again, and a real fall steps it', () => {
    const s = upd(risk.initialRiskState(10000, T0), 1, 6000, true).riskState;
    const clear = upd(s, 2, 10000, false);
    assert.ok(clear.events.some((e) => e.type === 'equity_unfrozen'));
    assert.strictEqual(clear.riskState.rung, 0);
    assert.ok(!risk.canEnter(clear.riskState).reasons.includes('equity_unknown'));
    assert.ok(upd(clear.riskState, 3, 7000, false).riskState.rung >= 3);
  });

  test('a known quarantined value leaves the freeze off, so a real fall steps the ladder', () => {
    const o = upd(risk.initialRiskState(10000, T0), 1, 7000, false);
    assert.ok(o.riskState.rung >= 3);
    assert.strictEqual(o.riskState.equityFrozen, undefined);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
