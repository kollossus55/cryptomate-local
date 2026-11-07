/**
 * Exit engine tests: every trigger, ratchet, priority, partials, restart, short-side
 * mirror, gap fills, bad data.
 */
import assert from 'node:assert';
import {
  EXIT_PROFILES, EXIT_PRIORITY, createExitPlan, evaluateExit, applyExitResult, stopAt, recordStop,
} from '../shared/trading/v6Exits.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const DAY = 24 * 3600e3;
const T0 = Date.UTC(2024, 0, 1);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? 'value'}: ${a} vs ${b}`);

// LOCAL CHANGE: the shipped profiles turn break-even and partials off (research-r-exits.md).
// The rules still exist, so rule tests pin these values rather than lose that coverage.
const BE_ON = { enabled: true, triggerR: 1, bufferPct: 0.05 };
const FEATURES = {
  trend: { breakEven: BE_ON, timeStop: { enabled: true, bars: 40, minR: 0, maxBars: null } },
  swing: { breakEven: BE_ON, trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 },
    timeStop: { enabled: true, bars: 20, minR: 0.5, maxBars: 60 }, partials: [{ atR: 2, fraction: 0.5 }] },
  revert: { breakEven: BE_ON, trail: { enabled: true, atrMult: 2, activateR: 1, tightenFactor: 0.5 },
    timeStop: { enabled: true, bars: 5, minR: 0.25, maxBars: 10 },
    partials: [{ atR: 1, fraction: 0.5 }, { atR: 2, fraction: 0.5 }] },
};

/**
 * Entry 100, stop 90 (R = 10) unless told otherwise. Short mirrors to stop 110.
 * Rule tests use round bars far above 6 ATRs of 2, so the spike guard is off unless
 * `guard: true`. The property tests and the spike guard section turn it on.
 */
function mk({ side = 'long', profile = 'swing', entry = 100, stop, atr = 2, overrides, costs, timeframe = '1d', regime = 'neutral', guard = false } = {}) {
  const st = stop ?? (side === 'long' ? entry - 10 : entry + 10);
  const position = {
    symbol: 'BTCUSDT', strategyId: 's', side, qty: 1, entryPrice: entry, entryTime: T0, entryFees: 0.1,
    stopPrice: st, initialStopPrice: st, highWater: entry, lowWater: entry, partialsTaken: [],
    exitProfile: profile, barsHeld: 0, riskAtEntry: 10,
  };
  position.exitPlan = createExitPlan({ position, profile, atr,
    config: { overrides: { ...FEATURES[profile], spikeGuard: { enabled: guard }, ...overrides }, costs, timeframe, regime } });
  return position;
}
const bar = (o, h, l, c, day = 1) => ({ t: T0 + day * DAY, o, h, l, c, v: 1, qv: 1 });
const tick = (p, day = 1) => bar(p, p, p, p, day);
const ev = (position, b, rest = {}) => evaluateExit({ position, bar: b, atr: 2, regime: 'neutral', t: b?.t, ...rest });
/** Same price path reflected around entry, for short-side tests. */
const flip = (b, e = 100) => ({ ...b, o: 2 * e - b.o, h: 2 * e - b.l, l: 2 * e - b.h, c: 2 * e - b.c });
/** Isolates one rule by switching the others off. */
const QUIET = {
  breakEven: { enabled: false }, trail: { enabled: false }, timeStop: { enabled: false },
  signalExit: { enabled: false }, regimeExit: { enabled: false }, partials: [],
};
const only = (over) => ({ ...QUIET, ...over });

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

console.log('profiles and plans');

test('three profiles exist, are frozen data, and JSON round-trips unchanged', () => {
  assert.deepStrictEqual(Object.keys(EXIT_PROFILES), ['trend', 'swing', 'revert']);
  for (const p of Object.values(EXIT_PROFILES)) {
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.trail));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), p);
    for (const k of ['hardStop', 'breakEven', 'trail', 'spikeGuard', 'timeStop', 'signalExit', 'regimeExit', 'partials']) assert.ok(k in p, k);
  }
});

test('shipped profiles match the exit research: no break-even, no partials, 4 ATR trail', () => {
  const want = { trend: [3, 20], swing: [2, 20], revert: [2, 10] };
  for (const [id, [stop, bars]] of Object.entries(want)) {
    const p = EXIT_PROFILES[id];
    assert.strictEqual(p.hardStop.atrMult, stop);
    assert.strictEqual(p.breakEven.enabled, false);
    assert.strictEqual(p.trail.enabled, true);
    assert.strictEqual(p.trail.atrMult, 4);
    assert.deepStrictEqual({ ...p.timeStop }, { enabled: true, bars, minR: 0, maxBars: null });
    assert.strictEqual(p.partials.length, 0);
    assert.strictEqual(p.regimeExit.enabled, true);
  }
});

test('every plan carries all rules from the moment it opens, long and short', () => {
  for (const profile of Object.keys(EXIT_PROFILES)) for (const side of ['long', 'short']) {
    const plan = mk({ profile, side }).exitPlan;
    assert.strictEqual(plan.profile, profile);
    assert.strictEqual(plan.riskPerUnit, 10);
    assert.deepStrictEqual(plan.warnings, []);
    assert.ok(plan.breakEven && plan.trail.enabled && plan.timeStop.enabled);
    assert.ok(plan.signalExit.enabled && plan.regimeExit.enabled);
  }
});

test('profile parameters sweep through config.overrides without touching the original', () => {
  const p = mk({ profile: 'trend', overrides: { trail: { atrMult: 5 }, timeStop: { bars: 20 } } });
  assert.strictEqual(p.exitPlan.trail.atrMult, 5);
  assert.strictEqual(p.exitPlan.trail.activateR, 1);
  assert.strictEqual(p.exitPlan.timeStop.bars, 20);
  assert.strictEqual(EXIT_PROFILES.trend.trail.atrMult, 4);
});

test('a whole custom profile object is accepted', () => {
  const custom = JSON.parse(JSON.stringify(EXIT_PROFILES.swing));
  custom.id = 'sweep_7';
  custom.trail.atrMult = 2;
  const position = mk();
  const plan = createExitPlan({ position, profile: custom, atr: 2 });
  assert.strictEqual(plan.profile, 'sweep_7');
  assert.strictEqual(plan.trail.atrMult, 2);
});

test('bad sweep values disable the rule and warn instead of corrupting it', () => {
  const plan = mk({ overrides: { trail: { atrMult: NaN }, timeStop: { bars: -1 } } }).exitPlan;
  assert.strictEqual(plan.trail.enabled, false);
  assert.strictEqual(plan.timeStop.enabled, false);
  assert.ok(plan.warnings.includes('bad_param_trail') && plan.warnings.includes('bad_param_timeStop'));
});

test('createExitPlan derives a stop when none is given, or the given one is on the wrong side', () => {
  const noStop = { side: 'long', entryPrice: 100 };
  assert.strictEqual(createExitPlan({ position: noStop, profile: 'swing', atr: 3 }).hardStopPrice, 94);
  assert.strictEqual(createExitPlan({ position: noStop, profile: 'swing' }).hardStopPrice, 90);
  const wrong = createExitPlan({ position: { side: 'long', entryPrice: 100, stopPrice: 105 }, profile: 'swing', atr: 3 });
  assert.strictEqual(wrong.hardStopPrice, 94);
  assert.ok(wrong.warnings.includes('stop_wrong_side'));
  assert.strictEqual(createExitPlan({ position: { side: 'short', entryPrice: 100 }, profile: 'swing', atr: 3 }).hardStopPrice, 106);
});

test('createExitPlan does not throw on nonsense', () => {
  for (const a of [undefined, {}, { position: null }, { position: { side: 'long' } }, { position: {}, profile: 'nope', config: 7 }]) {
    const plan = createExitPlan(a);
    assert.ok(plan.warnings.length > 0);
    JSON.stringify(plan);
  }
});

console.log('triggers');

test('hard stop fires on the bar low, fills at the stop', () => {
  const r = ev(mk(), bar(95, 96, 89, 94));
  assert.strictEqual(r.action, 'exit');
  assert.strictEqual(r.reasonCode, 'hard_stop');
  assert.strictEqual(r.fraction, 1);
  assert.strictEqual(r.fillHint.price, 90);
  assert.strictEqual(r.fillHint.gapped, false);
});

test('hard stop fires on a tick at exactly the stop', () => {
  const r = ev(mk(), tick(90));
  assert.strictEqual(r.reasonCode, 'hard_stop');
  assert.strictEqual(r.fillHint.price, 90);
});

test('no trigger: holds with the stop unchanged', () => {
  const r = ev(mk(), bar(100, 102, 98, 101));
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.reasonCode, 'hold');
  assert.strictEqual(r.newStop, 90);
  assert.strictEqual(r.stopChanged, false);
  assert.strictEqual(r.dataOk, true);
});

test('break-even arms at +1R, above entry by the full round-trip cost', () => {
  const p = mk({ overrides: only({ breakEven: { enabled: true, triggerR: 1, bufferPct: 0.05 } }) });
  assert.strictEqual(ev(p, bar(100, 109.9, 99, 105)).newStop, 90);
  const r = ev(p, bar(100, 110, 99, 105));
  close(r.newStop, p.exitPlan.breakEvenPrice);
  assert.ok(r.newStop > 100);
  const next = applyExitResult(p, r);
  const hit = ev(next, bar(102, 103, 100, 101, 2));
  assert.strictEqual(hit.reasonCode, 'breakeven_stop');
});

test('break-even offset covers fees and slippage at every contract tier', () => {
  for (const [feePct, slipPct] of [[0.10, 0.03], [0.10, 0.08], [0.10, 0.25]]) {
    const costs = { feePct, slipPct, stopSlipPct: 0.10 };
    const f = feePct / 100, sl = slipPct / 100, ss = 0.001;
    const L = mk({ costs }).exitPlan.breakEvenPrice;
    assert.ok(L * (1 - sl - ss) * (1 - f) > 100 * (1 + sl) * (1 + f), `long ${slipPct}`);
    const S = mk({ costs, side: 'short' }).exitPlan.breakEvenPrice;
    assert.ok(S * (1 + sl + ss) * (1 + f) < 100 * (1 - sl) * (1 - f), `short ${slipPct}`);
  }
});

test('unknown costs fall back to the dearest tier', () => {
  assert.strictEqual(mk().exitPlan.breakEvenOffsetPct, 2 * 0.35 + 0.10 + 0.05);
});

test('a position whose R is smaller than its costs does not set a stop above the best price', () => {
  const p = mk({ stop: 99.9, overrides: only({ breakEven: { enabled: true, triggerR: 1, bufferPct: 0.05 } }) });
  const r = ev(p, bar(100, 100.2, 100, 100.1));
  assert.strictEqual(r.newStop, 99.9);
});

test('chandelier trail follows the high by atrMult ATRs after activation', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } }) });
  assert.strictEqual(ev(p, bar(100, 109, 99, 105)).newStop, 90);
  const r = ev(p, bar(100, 120, 99, 115));
  assert.strictEqual(r.newStop, 114);
  const hit = ev(applyExitResult(p, r), bar(116, 117, 113, 115, 2));
  assert.strictEqual(hit.reasonCode, 'trail_stop');
  assert.strictEqual(hit.fillHint.price, 114);
});

test('a ratchet earned on a bar does not apply to that same bar', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } }) });
  const r = ev(p, bar(100, 120, 100, 101));
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.newStop, 114);
});

test('market breaker tightens the trail via config or regime', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 } }) });
  const b = bar(100, 120, 99, 115);
  assert.strictEqual(ev(p, b).newStop, 112);
  assert.strictEqual(ev(p, b, { config: { tightenTrails: true } }).newStop, 116);
  assert.strictEqual(ev(p, b, { regime: { label: 'neutral', tightenTrails: true } }).newStop, 116);
});

test('time stop: leaves when it has not worked, stays when it has', () => {
  const over = only({ timeStop: { enabled: true, bars: 5, minR: 0.5, maxBars: null } });
  const p = mk({ overrides: over });
  assert.strictEqual(ev(p, bar(100, 102, 99, 101, 4)).action, 'hold');
  const r = ev(p, bar(100, 102, 99, 101, 5));
  assert.strictEqual(r.reasonCode, 'time_stop');
  assert.strictEqual(r.fillHint.kind, 'next_open');
  assert.strictEqual(ev(p, bar(100, 106, 99, 105, 5)).action, 'hold');
});

test('time stop maxBars leaves even a winner', () => {
  const p = mk({ overrides: only({ timeStop: { enabled: true, bars: 5, minR: 0, maxBars: 10 } }) });
  assert.strictEqual(ev(p, bar(130, 131, 129, 130, 9)).action, 'hold');
  assert.strictEqual(ev(p, bar(130, 131, 129, 130, 10)).reasonCode, 'time_stop');
});

test('time stop counts the clock, so repeated 5-minute ticks do not age the position', () => {
  let p = mk({ overrides: only({ timeStop: { enabled: true, bars: 5, minR: 0.5, maxBars: null } }) });
  for (let i = 1; i <= 500; i++) {
    const r = evaluateExit({ position: p, bar: { t: T0 + i * 300e3, o: 100, h: 100, l: 100, c: 100 }, atr: 2, regime: 'neutral', t: T0 + i * 300e3 });
    assert.strictEqual(r.action, 'hold');
    p = applyExitResult(p, r);
  }
  assert.strictEqual(p.barsHeld, 1);
});

test('time stop honours the timeframe', () => {
  const p = mk({ timeframe: '4h', overrides: only({ timeStop: { enabled: true, bars: 6, minR: 0.5, maxBars: null } }) });
  assert.strictEqual(ev(p, tick(100, 1)).reasonCode, 'time_stop');
});

test('signal exit: flat and opposite close, same side does not, per-rule switches work', () => {
  const p = mk({ overrides: only({ signalExit: { enabled: true, onFlat: true, onOpposite: true } }) });
  const b = bar(100, 102, 99, 101);
  const flat = ev(p, b, { signal: { symbol: 'BTCUSDT', side: 'flat', reason: 'Below the 100-day average' } });
  assert.strictEqual(flat.reasonCode, 'signal_exit');
  assert.strictEqual(flat.reason, 'Below the 100-day average');
  assert.strictEqual(ev(p, b, { signal: { side: 'short' } }).reasonCode, 'signal_exit');
  assert.strictEqual(ev(p, b, { signal: { side: 'long' } }).action, 'hold');
  assert.strictEqual(ev(p, b, { signal: null }).action, 'hold');
  const s = mk({ side: 'short', overrides: only({ signalExit: { enabled: true, onFlat: true, onOpposite: true } }) });
  assert.strictEqual(ev(s, flip(b), { signal: { side: 'long' } }).reasonCode, 'signal_exit');
  const off = mk({ overrides: only({ signalExit: { enabled: true, onFlat: true, onOpposite: false } }) });
  assert.strictEqual(ev(off, b, { signal: { side: 'short' } }).action, 'hold');
});

test("another coin's signal cannot close this position", () => {
  const p = mk({ overrides: only({ signalExit: { enabled: true, onFlat: true, onOpposite: true } }) });
  const r = ev(p, bar(100, 102, 99, 101), { signal: { symbol: 'ETHUSDT', side: 'flat' } });
  assert.strictEqual(r.action, 'hold');
  assert.ok(r.flags.includes('signal_mismatch'));
});

test('regime exit closes a long on bear, a short on bull, and neither on neutral', () => {
  const over = only({ regimeExit: { enabled: true, action: 'exit' } });
  const b = bar(100, 102, 99, 101);
  const L = mk({ overrides: over }), S = mk({ side: 'short', overrides: over });
  assert.strictEqual(ev(L, b, { regime: 'bear' }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(L, b, { regime: { riskOff: true } }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(L, b, { regime: 'bull' }).action, 'hold');
  assert.strictEqual(ev(S, flip(b), { regime: 'bull' }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(S, flip(b), { regime: 'bear' }).action, 'hold');
  assert.strictEqual(ev(L, b, { regime: 'neutral' }).action, 'hold');
});

test('regime action tighten narrows the trail and does not exit', () => {
  const p = mk({ overrides: only({
    regimeExit: { enabled: true, action: 'tighten' },
    trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 },
  }) });
  const r = ev(p, bar(100, 120, 99, 115), { regime: 'bear' });
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.newStop, 116);
});

test('partial take-profit reduces, records itself, and never repeats', () => {
  const p = mk({ overrides: only({ partials: [{ atR: 2, fraction: 0.5 }] }) });
  const b = bar(100, 121, 99, 118);
  const r = ev(p, b);
  assert.strictEqual(r.action, 'reduce');
  assert.strictEqual(r.reasonCode, 'partial_take_profit');
  assert.strictEqual(r.fraction, 0.5);
  assert.strictEqual(r.fillHint.price, 120);
  const next = applyExitResult(p, r);
  assert.strictEqual(next.partialsTaken.length, 1);
  assert.strictEqual(ev(next, b).action, 'hold');
});

test('partial fraction is of current qty, so the sold amounts match the plan', () => {
  const p0 = mk({ overrides: only({ partials: [{ atR: 1, fraction: 0.25 }, { atR: 2, fraction: 0.25 }] }) });
  const a = ev(p0, bar(100, 111, 99, 108));
  assert.strictEqual(a.fraction, 0.25);
  const p1 = { ...applyExitResult(p0, a), qty: 0.75 };
  const b = ev(p1, bar(108, 121, 107, 118, 2));
  close(b.fraction * p1.qty, 0.25);
  close(b.fractionOfOriginal, 0.25);
});

test('final partial closes the position as take_profit', () => {
  const p0 = mk({ profile: 'revert' });
  const a = ev(p0, bar(100, 111, 99, 108));
  assert.strictEqual(a.action, 'reduce');
  // Low stays above the 107 trail set by the first bar; touching it would be a stop.
  const b = ev(applyExitResult(p0, a), bar(108, 121, 107.5, 118, 2));
  assert.strictEqual(b.action, 'exit');
  assert.strictEqual(b.reasonCode, 'take_profit');
  assert.strictEqual(b.fraction, 1);
});

test('two levels crossed in one bar become one reduce at the blended price', () => {
  const p = mk({ overrides: only({ partials: [{ atR: 1, fraction: 0.2 }, { atR: 2, fraction: 0.2 }] }) });
  const r = ev(p, bar(100, 125, 99, 122));
  close(r.fraction, 0.4);
  close(r.fillHint.price, 115);
  assert.strictEqual(r.update.partialsTaken.length, 2);
});

test('partials sum to at most 100%: over-specified levels are capped in the plan', () => {
  const plan = mk({ overrides: { partials: [{ atR: 1, fraction: 0.7 }, { atR: 2, fraction: 0.7 }, { atR: 3, fraction: 0.5 }] } }).exitPlan;
  close(plan.partials.reduce((a, l) => a + l.fraction, 0), 1);
  assert.strictEqual(plan.partials.length, 2);
  assert.ok(plan.warnings.includes('partials_capped'));
});

test('property: random partial ladders and paths never sell more than 100%', () => {
  const r = rng(11);
  for (let run = 0; run < 300; run++) {
    const levels = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({ atR: 0.5 + Math.floor(r() * 8) / 2, fraction: 0.05 + r() * 0.6 }));
    let p = mk({ overrides: only({ partials: levels }) });
    let sold = 0, price = 100;
    for (let i = 1; i <= 40; i++) {
      const next = price * (1 + (r() - 0.45) * 0.1);
      const res = ev(p, bar(price, Math.max(price, next) * 1.01, Math.max(Math.min(price, next) * 0.99, 90.01), next, i));
      price = Math.max(next, 91);
      if (res.action === 'reduce' || res.reasonCode === 'take_profit') sold += res.fractionOfOriginal;
      if (res.action === 'exit') break;
      p = applyExitResult(p, res);
    }
    assert.ok(sold <= 1 + 1e-9, `sold ${sold}`);
  }
});

test('a tampered partialsTaken total still cannot oversell', () => {
  const p = mk({ overrides: only({ partials: [{ atR: 1, fraction: 0.5 }] }) });
  const r = ev({ ...p, partialsTaken: [{ id: 'old', fraction: 1 }] }, bar(100, 111, 99, 108));
  assert.strictEqual(r.action, 'hold');
});

test('partials do not repeat for a caller that persists only exitPlan and partialId', () => {
  const partialPatch = (p, r) => ({
    ...p,
    ...(r.exitPlan ? { exitPlan: r.exitPlan } : {}),
    ...(r.partialId !== null ? { partialsTaken: [...p.partialsTaken, r.partialId] } : {}),
  });
  const p0 = mk({ overrides: only({ partials: [{ atR: 1, fraction: 0.25 }, { atR: 2, fraction: 0.25 }, { atR: 3, fraction: 0.25 }] }) });
  const a = ev(p0, bar(100, 125, 99, 122));
  close(a.fractionOfOriginal, 0.5);
  const p1 = partialPatch(p0, a);
  assert.deepStrictEqual(p1.partialsTaken, ['p2']);
  assert.strictEqual(ev(p1, bar(122, 125, 120, 122, 2)).action, 'hold');
  const b = ev(p1, bar(122, 131, 120, 128, 3));
  assert.strictEqual(b.action, 'reduce');
  close(b.fractionOfOriginal, 0.25);
  close(b.fraction, 0.5);
  const bareId = ev({ ...p0, partialsTaken: ['p1'] }, bar(100, 111, 99, 108));
  assert.strictEqual(bareId.action, 'hold');
});

test('fillHint.kind matches what v6Core reads for each exit type', () => {
  assert.strictEqual(ev(mk(), tick(85)).fillHint.kind, 'stop');
  assert.strictEqual(ev(mk({ profile: 'revert' }), bar(100, 111, 99, 108)).fillHint.kind, 'target');
  assert.strictEqual(ev(mk({ profile: 'trend' }), tick(100), { signal: { side: 'flat' } }).fillHint.kind, 'next_open');
});

test('regime accepts the shape v6Core.computeRegime produces', () => {
  const over = only({ regimeExit: { enabled: true, action: 'exit' } });
  const L = mk({ overrides: over }), S = mk({ side: 'short', overrides: over });
  assert.strictEqual(ev(L, tick(100), { regime: { riskOn: false, label: 'risk_off' } }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(L, tick(100), { regime: { riskOn: true, label: 'risk_on' } }).action, 'hold');
  assert.strictEqual(ev(S, tick(100), { regime: { riskOn: true } }).reasonCode, 'regime_exit');
  const unknown = ev(L, tick(100), { regime: { riskOn: null, label: 'unknown' } });
  assert.strictEqual(unknown.action, 'hold');
  assert.ok(unknown.flags.includes('bad_regime'));
});

console.log('ratchet');

test('property: stop never loosens over random bars, ATRs and regimes, long and short', () => {
  const r = rng(42);
  for (const side of ['long', 'short']) for (const profile of Object.keys(EXIT_PROFILES)) {
    for (let run = 0; run < 200; run++) {
      const s = side === 'long' ? 1 : -1;
      let p = mk({ side, profile, guard: true, overrides: { timeStop: { enabled: false }, partials: [] } });
      let price = 100, prev = p.stopPrice;
      for (let i = 1; i <= 60; i++) {
        const next = price * (1 + (r() - 0.5) * 0.08);
        const b = bar(price, Math.max(price, next) * (1 + r() * 0.02), Math.min(price, next) * (1 - r() * 0.02), next, i);
        const atr = r() < 0.1 ? NaN : 0.2 + r() * 10;
        const regime = ['bull', 'neutral', 'bear', undefined][Math.floor(r() * 4)];
        const res = evaluateExit({ position: p, bar: b, atr, regime: profile === 'swing' ? regime : 'neutral', t: b.t,
          config: { tightenTrails: r() < 0.1 } });
        assert.ok(s * (res.newStop - prev) >= 0, `${side}/${profile} stop ${prev} -> ${res.newStop}`);
        prev = res.newStop;
        if (res.action === 'exit') break;
        p = applyExitResult(p, res);
        price = next;
      }
    }
  }
});

test('property: a caller loosening the stop is overruled, on the same bar', () => {
  const r = rng(7);
  for (const side of ['long', 'short']) {
    const s = side === 'long' ? 1 : -1;
    for (let run = 0; run < 200; run++) {
      const p0 = mk({ side, overrides: { timeStop: { enabled: false }, partials: [], regimeExit: { enabled: false } } });
      const up = bar(100, 100 + 30, 100 - 2, 100 + 25);
      const p1 = applyExitResult(p0, ev(p0, s > 0 ? up : flip(up)));
      const stop = p1.stopPrice;
      assert.ok(s * (stop - p0.stopPrice) > 0);
      const loose = { ...p1, stopPrice: stop - s * (1 + r() * 30) };
      const hold = ev(loose, tick(stop + s * 1, 2));
      assert.strictEqual(hold.newStop, stop);
      assert.ok(hold.flags.includes('stop_loosened_ignored'));
      assert.strictEqual(hold.dataOk, false);
      const hit = ev(loose, tick(stop - s * 0.5, 2));
      assert.strictEqual(hit.action, 'exit');
      assert.strictEqual(hit.newStop, stop);
    }
  }
});

test('a stale floor cannot be undone by dropping the stop below the initial stop', () => {
  const p = mk();
  const r = ev({ ...p, stopPrice: 50, exitPlan: { ...p.exitPlan, state: { ...p.exitPlan.state, stopFloor: 40 } } }, tick(100));
  assert.strictEqual(r.newStop, 90);
});

test('a caller tightening the stop is accepted', () => {
  const r = ev({ ...mk(), stopPrice: 95 }, tick(100));
  assert.strictEqual(r.newStop, 95);
  assert.ok(!r.flags.includes('stop_loosened_ignored'));
});

test('falling ATR ratchets, rising ATR does not widen', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 0, tightenFactor: 0.5 } }) });
  const a = ev(p, bar(100, 120, 99, 118), { atr: 2 });
  assert.strictEqual(a.newStop, 114);
  const b = ev(applyExitResult(p, a), bar(118, 119, 115, 118, 2), { atr: 5 });
  assert.strictEqual(b.newStop, 114);
});

console.log('priority');

test('EXIT_PRIORITY names the hard stop first', () => {
  assert.strictEqual(EXIT_PRIORITY[0], 'hard_stop');
});

test('stop beats target on a bar that touches both (contract rule)', () => {
  const p = mk({ overrides: only({ partials: [{ atR: 1, fraction: 0.5 }] }) });
  const r = ev(p, bar(100, 111, 89, 100));
  assert.strictEqual(r.reasonCode, 'hard_stop');
  assert.deepStrictEqual(r.update.partialsTaken, []);
});

test('all triggers at once: each is peeled away in the documented order', () => {
  const over = {
    partials: [{ atR: 1, fraction: 0.5 }],
    timeStop: { enabled: true, bars: 5, minR: 5, maxBars: null },
    regimeExit: { enabled: true, action: 'exit' },
  };
  const args = { regime: 'bear', signal: { side: 'flat' } };
  const p = mk({ profile: 'trend', overrides: over });
  assert.strictEqual(ev(p, bar(100, 111, 89, 100, 9), args).reasonCode, 'hard_stop');
  assert.strictEqual(ev(p, bar(100, 111, 95, 100, 9), args).reasonCode, 'time_stop');
  assert.strictEqual(ev(p, bar(100, 111, 95, 100, 2), args).reasonCode, 'regime_exit');
  assert.strictEqual(ev(p, bar(100, 111, 95, 100, 2), { signal: args.signal }).reasonCode, 'signal_exit');
  assert.strictEqual(ev(p, bar(100, 111, 95, 100, 2)).reasonCode, 'partial_take_profit');
});

test('a full exit also keeps the ratchet it earned, in case the exit fill is delayed', () => {
  const p = mk({ profile: 'trend' });
  const r = ev(p, bar(100, 120, 99, 118), { signal: { side: 'flat' } });
  assert.strictEqual(r.reasonCode, 'signal_exit');
  assert.ok(r.newStop > 90);
});

test('stop kinds are labelled by where the stop sits', () => {
  const p = mk({ profile: 'trend', overrides: { trail: { atrMult: 4 } } });
  const be = applyExitResult(p, ev(p, bar(100, 110, 99, 105), { atr: 100 }));
  assert.strictEqual(ev(be, tick(100, 2), { atr: 100 }).reasonCode, 'breakeven_stop');
  const tr = applyExitResult(p, ev(p, bar(100, 130, 99, 125)));
  assert.strictEqual(ev(tr, tick(120, 2)).reasonCode, 'trail_stop');
});

console.log('gaps');

test('long gapping through the stop fills at the open, not the stop', () => {
  const r = ev(mk(), bar(80, 85, 78, 84));
  assert.strictEqual(r.reasonCode, 'hard_stop');
  assert.strictEqual(r.fillHint.price, 80);
  assert.strictEqual(r.fillHint.stopPrice, 90);
  assert.strictEqual(r.fillHint.gapped, true);
  close(r.fillHint.gapPct, (10 / 90) * 100);
});

test('short gapping through the stop fills at the open, not the stop', () => {
  const r = ev(mk({ side: 'short' }), bar(120, 122, 115, 116));
  assert.strictEqual(r.fillHint.price, 120);
  assert.strictEqual(r.fillHint.gapped, true);
});

test('a tick through the stop fills at the tick', () => {
  const r = ev(mk(), tick(70));
  assert.strictEqual(r.fillHint.price, 70);
  assert.strictEqual(r.fillHint.gapped, true);
});

test('trail stops gap too', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } }) });
  const next = applyExitResult(p, ev(p, bar(100, 120, 99, 118)));
  const r = ev(next, bar(105, 106, 100, 102, 2));
  assert.strictEqual(r.reasonCode, 'trail_stop');
  assert.strictEqual(r.fillHint.price, 105);
});

console.log('bar and tick agree');

test('a tick path and the same path as flat bars give identical decisions', () => {
  const r = rng(3);
  const toBar = (p, i) => bar(p, p, p, p, i);
  for (let run = 0; run < 50; run++) {
    let a = mk({ profile: 'trend' }), b = JSON.parse(JSON.stringify(a)), price = 100;
    for (let i = 1; i <= 30; i++) {
      price *= 1 + (r() - 0.48) * 0.06;
      const ra = ev(a, toBar(price, i));
      const rb = evaluateExit({ position: b, bar: { t: T0 + i * DAY, o: price, h: price, l: price, c: price }, atr: 2, regime: 'neutral', t: T0 + i * DAY });
      assert.strictEqual(ra.reasonCode, rb.reasonCode);
      assert.strictEqual(ra.newStop, rb.newStop);
      if (ra.action === 'exit') break;
      a = applyExitResult(a, ra);
      b = applyExitResult(b, rb);
    }
  }
});

console.log('restart');

test('property: JSON round-trip after every bar changes nothing', () => {
  const r = rng(99);
  for (const side of ['long', 'short']) for (const profile of Object.keys(EXIT_PROFILES)) {
    for (let run = 0; run < 50; run++) {
      let mem = mk({ side, profile, guard: true }), disk = JSON.parse(JSON.stringify(mem)), price = 100;
      for (let i = 1; i <= 50; i++) {
        const next = price * (1 + (r() - 0.5) * 0.06);
        const b = bar(price, Math.max(price, next) * 1.01, Math.min(price, next) * 0.99, next, i);
        const inputs = { bar: b, atr: 1 + r() * 3, regime: 'neutral', t: b.t };
        const rm = evaluateExit({ position: mem, ...inputs });
        const rd = evaluateExit({ position: disk, ...inputs });
        assert.deepStrictEqual(rd, rm);
        if (rm.action === 'exit') break;
        mem = applyExitResult(mem, rm);
        disk = JSON.parse(JSON.stringify(applyExitResult(disk, rd)));
        price = next;
      }
    }
  }
});

test('re-running the same bar after a restart changes nothing', () => {
  const p = mk({ profile: 'trend' });
  const b = bar(100, 125, 99, 120);
  const once = applyExitResult(p, ev(p, b));
  const twice = applyExitResult(once, ev(once, b));
  assert.deepStrictEqual(twice, once);
});

test('a position with no plan (older record) gets one rebuilt, flagged', () => {
  const { exitPlan, ...bare } = mk({ profile: 'trend' });
  const r = ev(bare, tick(100));
  assert.ok(r.flags.includes('plan_rebuilt'));
  assert.strictEqual(r.update.exitPlan.profile, 'trend');
  assert.strictEqual(ev(bare, tick(89)).reasonCode, 'hard_stop');
});

test('evaluateExit does not mutate its inputs', () => {
  const p = deepFreeze(mk({ profile: 'revert' }));
  const b = deepFreeze(bar(100, 125, 99, 120));
  assert.strictEqual(ev(p, b).action, 'exit');
});

console.log('mirror symmetry');

test('property: a short on the reflected path mirrors a long exactly', () => {
  const r = rng(2024);
  for (const profile of Object.keys(EXIT_PROFILES)) for (let run = 0; run < 200; run++) {
    let L = mk({ profile, guard: true }), S = mk({ profile, side: 'short', guard: true }), price = 100;
    for (let i = 1; i <= 50; i++) {
      const next = price * (1 + (r() - 0.48) * 0.05);
      const b = bar(price, Math.max(price, next) * 1.01, Math.min(price, next) * 0.99, next, i);
      const atr = 1 + r() * 3;
      const [regL, regS] = r() < 0.03 ? ['bear', 'bull'] : ['neutral', 'neutral'];
      const [sigL, sigS] = r() < 0.02 ? [{ side: 'short' }, { side: 'long' }] : [null, null];
      const rl = evaluateExit({ position: L, bar: b, atr, regime: regL, signal: sigL, t: b.t });
      const rs = evaluateExit({ position: S, bar: flip(b), atr, regime: regS, signal: sigS, t: b.t });
      assert.strictEqual(rs.action, rl.action);
      assert.strictEqual(rs.reasonCode, rl.reasonCode);
      close(rs.fraction, rl.fraction, 'fraction');
      close(rs.newStop, 200 - rl.newStop, 'stop');
      if (rl.fillHint?.price != null) close(rs.fillHint.price, 200 - rl.fillHint.price, 'fill');
      if (rl.action === 'exit') break;
      L = applyExitResult(L, rl);
      S = applyExitResult(S, rs);
      price = next;
      if (price >= 195) break;
    }
  }
});

console.log('regime changes');

const REGIME_ONLY = only({ regimeExit: { enabled: true, action: 'exit' } });
/** Runs ticks at 100 through a list of regimes, restarting from JSON each time. */
function regimeRun(p0, regimes) {
  let p = p0;
  return regimes.map((regime, i) => {
    const r = ev(p, tick(100, i + 1), { regime });
    p = JSON.parse(JSON.stringify(applyExitResult(p, r)));
    return r.reasonCode;
  });
}

test('the regime at entry is recorded in the plan and seeds the last seen regime', () => {
  const plan = mk({ regime: 'bear' }).exitPlan;
  assert.strictEqual(plan.regimeAtEntry, -1);
  assert.strictEqual(plan.state.lastRegimeBias, -1);
  assert.strictEqual(mk({ regime: { riskOn: true, label: 'risk_on' } }).exitPlan.regimeAtEntry, 1);
  assert.strictEqual(mk({ regime: { riskOn: null, label: 'unknown' } }).exitPlan.regimeAtEntry, null);
});

test('the entry regime can be passed as a top-level argument, as v6Core does', () => {
  const position = { side: 'long', entryPrice: 100, stopPrice: 90 };
  const plan = createExitPlan({ position, profile: 'trend', atr: 2, regime: { riskOn: false, label: 'risk_off' } });
  assert.strictEqual(plan.regimeAtEntry, -1);
  assert.strictEqual(plan.state.lastRegimeBias, -1);
});

test('a long opened in an adverse regime is not closed for that regime alone', () => {
  const codes = regimeRun(mk({ regime: 'bear', overrides: REGIME_ONLY }), ['bear', 'bear', 'bear']);
  assert.deepStrictEqual(codes, ['hold', 'hold', 'hold']);
});

test('it exits once the regime improves and later turns adverse again', () => {
  const p = mk({ regime: 'bear', overrides: REGIME_ONLY });
  assert.deepStrictEqual(regimeRun(p, ['bear', 'bull', 'bull', 'bear']), ['hold', 'hold', 'hold', 'regime_exit']);
  assert.deepStrictEqual(regimeRun(p, ['neutral', 'bear']), ['hold', 'regime_exit']);
});

test('short side mirrors: opened in bull stays, improves, then bull again exits', () => {
  const p = mk({ side: 'short', regime: 'bull', overrides: REGIME_ONLY });
  assert.deepStrictEqual(regimeRun(p, ['bull', 'bear', 'bull']), ['hold', 'hold', 'regime_exit']);
});

test('unknown never triggers an exit and never counts as a change', () => {
  const unknown = { riskOn: null, label: 'unknown' };
  const bad = mk({ regime: 'bear', overrides: REGIME_ONLY });
  assert.deepStrictEqual(regimeRun(bad, [unknown, 'bear', unknown, 'bear']), ['hold', 'hold', 'hold', 'hold']);
  const good = mk({ regime: 'bull', overrides: REGIME_ONLY });
  assert.deepStrictEqual(regimeRun(good, [unknown, unknown]), ['hold', 'hold']);
  assert.deepStrictEqual(regimeRun(good, [unknown, 'bear']), ['hold', 'regime_exit']);
  assert.deepStrictEqual(regimeRun(good, [undefined, 'martian', 'bear']), ['hold', 'hold', 'regime_exit']);
});

test('an exit decided but not yet filled repeats on replay, and lapses if the regime improves', () => {
  const p0 = mk({ overrides: REGIME_ONLY });
  const first = ev(p0, tick(100), { regime: 'bear' });
  assert.strictEqual(first.reasonCode, 'regime_exit');
  const p1 = JSON.parse(JSON.stringify(applyExitResult(p0, first)));
  assert.strictEqual(ev(p1, tick(100), { regime: 'bear' }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(p1, tick(100), { regime: { riskOn: null, label: 'unknown' } }).action, 'hold');
  const better = applyExitResult(p1, ev(p1, tick(100, 2), { regime: 'neutral' }));
  assert.strictEqual(better.exitPlan.state.regimeExitLatched, false);
  assert.strictEqual(ev(better, tick(100, 3), { regime: 'neutral' }).action, 'hold');
});

test('with no entry regime recorded, the first one seen is the baseline, flagged as advisory', () => {
  const p = mk({ regime: null, overrides: REGIME_ONLY });
  const r = ev(p, tick(100), { regime: 'bear' });
  assert.strictEqual(r.action, 'hold');
  assert.ok(r.flags.includes('regime_baseline_set'));
  assert.strictEqual(r.dataOk, true);
  const next = applyExitResult(p, r);
  assert.strictEqual(next.exitPlan.state.lastRegimeBias, -1);
  assert.ok(!ev(next, tick(100, 2), { regime: 'bear' }).flags.includes('regime_baseline_set'));
});

test('the regime is remembered even on a bar that ends in another exit path or bad data', () => {
  const p = mk({ regime: 'bear', overrides: REGIME_ONLY });
  const r = ev(p, null, { regime: 'bull', t: T0 + DAY });
  assert.strictEqual(r.update.exitPlan.state.lastRegimeBias, 1);
  assert.strictEqual(ev(applyExitResult(p, r), tick(100, 2), { regime: 'bear' }).reasonCode, 'regime_exit');
});

test('tighten follows the level of the regime, including one adverse at entry', () => {
  const p = mk({ regime: 'bear', overrides: only({
    regimeExit: { enabled: true, action: 'tighten' },
    trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 },
  }) });
  assert.strictEqual(ev(p, bar(100, 120, 99, 115), { regime: 'bear' }).newStop, 116);
});

console.log('spike guard');

const TRAIL = { trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } };
const BE = { breakEven: { enabled: true, triggerR: 1, bufferPct: 0.05 } };
const guarded = (extra = {}) => mk({ guard: true, ...extra, overrides: only({ ...TRAIL, ...BE, ...extra.overrides }) });

test('default limit is 6 ATRs in every profile', () => {
  for (const p of Object.values(EXIT_PROFILES)) assert.deepStrictEqual({ ...p.spikeGuard }, { enabled: true, atrMult: 6 });
});

test('a high over the limit moves neither trail nor break-even, and is flagged', () => {
  const p = guarded();
  const r = ev(p, bar(100, 112.01, 99, 101));
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.reasonCode, 'hold_bad_data');
  assert.strictEqual(r.newStop, 90);
  assert.strictEqual(r.update.highWater, 100);
  assert.ok(r.flags.includes('spike_unconfirmed'));
  assert.strictEqual(r.dataOk, false);
});

test('a high exactly at the limit is accepted', () => {
  const r = ev(guarded(), bar(100, 112, 99, 111));
  assert.strictEqual(r.update.highWater, 112);
  assert.strictEqual(r.newStop, 106);
  assert.deepStrictEqual(r.flags, []);
});

test('the limit is measured from the previous high-water mark, not from entry', () => {
  const p = applyExitResult(guarded(), ev(guarded(), bar(100, 112, 99, 111)));
  const r = ev(p, bar(111, 124, 110, 122, 2));
  assert.strictEqual(r.update.highWater, 124);
  assert.ok(!r.flags.includes('spike_unconfirmed'));
});

test('a false spike is dropped when the next bar does not confirm it', () => {
  const p = guarded();
  const a = ev(p, bar(100, 1e9, 99, 101));
  const p1 = JSON.parse(JSON.stringify(applyExitResult(p, a)));
  assert.strictEqual(p1.exitPlan.state.pendingBest.price, 1e9);
  const b = ev(p1, bar(101, 103, 100, 102, 2));
  assert.strictEqual(b.update.highWater, 103);
  assert.strictEqual(b.newStop, 90);
  assert.strictEqual(b.update.exitPlan.state.pendingBest, null);
  assert.deepStrictEqual(b.flags, []);
});

test('a real jump is accepted when the following bar reaches the same area, across a restart', () => {
  const p = guarded();
  const p1 = JSON.parse(JSON.stringify(applyExitResult(p, ev(p, bar(100, 130, 99, 128)))));
  assert.strictEqual(p1.stopPrice, 90);
  const b = ev(p1, bar(128, 129, 125, 127, 2));
  assert.strictEqual(b.update.highWater, 130);
  assert.strictEqual(b.newStop, 124);
  assert.deepStrictEqual(b.flags, []);
});

test('short side mirrors the guard on new lows', () => {
  const p = guarded({ side: 'short' });
  const a = ev(p, bar(100, 101, 70, 72));
  assert.strictEqual(a.newStop, 110);
  assert.strictEqual(a.update.lowWater, 100);
  assert.ok(a.flags.includes('spike_unconfirmed'));
  const b = ev(applyExitResult(p, a), bar(72, 75, 71, 73, 2));
  assert.strictEqual(b.update.lowWater, 70);
  assert.strictEqual(b.newStop, 76);
});

test('a bar cannot confirm itself when replayed', () => {
  const p = guarded();
  const b = bar(100, 130, 99, 128);
  const once = applyExitResult(p, ev(p, b));
  const r = ev(once, b);
  assert.strictEqual(r.newStop, 90);
  assert.strictEqual(r.update.highWater, 100);
  assert.deepStrictEqual(applyExitResult(once, r), once);
});

test('a rally elsewhere cannot validate a bad print', () => {
  const p = guarded();
  const p1 = applyExitResult(p, ev(p, bar(100, 1e9, 99, 101)));
  const r = ev(p1, bar(101, 111, 100, 110, 2));
  assert.strictEqual(r.update.highWater, 111);
  assert.ok(r.newStop < 112);
});

test('a second, larger spike does not confirm the first, and takes its place as pending', () => {
  const p = guarded();
  const p1 = applyExitResult(p, ev(p, bar(100, 130, 99, 128)));
  const r = ev(p1, bar(128, 1e9, 127, 129, 2));
  assert.strictEqual(r.update.highWater, 100);
  assert.strictEqual(r.newStop, 90);
  assert.ok(r.flags.includes('spike_unconfirmed'));
  assert.strictEqual(r.update.exitPlan.state.pendingBest.price, 1e9);
});

test('a rally running past a pending high within the limit confirms it and extends it', () => {
  const p = guarded();
  const p1 = applyExitResult(p, ev(p, bar(100, 130, 99, 128)));
  const r = ev(p1, bar(128, 135, 127, 134, 2));
  assert.strictEqual(r.update.highWater, 135);
  assert.strictEqual(r.newStop, 129);
  assert.deepStrictEqual(r.flags, []);
});

test('an unusable bar neither confirms nor clears a pending high', () => {
  const p = guarded();
  const p1 = applyExitResult(p, ev(p, bar(100, 130, 99, 128)));
  const r = ev(p1, { t: T0 + 2 * DAY, o: NaN, h: NaN, l: NaN, c: NaN });
  assert.strictEqual(r.update.exitPlan.state.pendingBest.price, 130);
});

test('stop hits stay unfiltered: a spike bar still fires the stop', () => {
  const r = ev(guarded(), bar(100, 1e9, 85, 101));
  assert.strictEqual(r.reasonCode, 'hard_stop');
  const s = ev(guarded({ side: 'short' }), bar(100, 115, 1, 99));
  assert.strictEqual(s.reasonCode, 'hard_stop');
});

test('stop hits stay unfiltered: an implausible price on the losing side still exits', () => {
  const long = ev(guarded(), tick(0.01));
  assert.strictEqual(long.reasonCode, 'hard_stop');
  assert.strictEqual(long.fillHint.price, 0.01);
  const short = ev(guarded({ side: 'short' }), tick(1e9));
  assert.strictEqual(short.reasonCode, 'hard_stop');
});

test('the multiple is configurable, the guard can be off, and a bad multiple falls back with a warning', () => {
  const wide = guarded({ overrides: { spikeGuard: { enabled: true, atrMult: 20 } } });
  assert.strictEqual(ev(wide, bar(100, 130, 99, 128)).update.highWater, 130);
  const off = guarded({ overrides: { spikeGuard: { enabled: false } } });
  assert.strictEqual(ev(off, bar(100, 1e9, 99, 128)).update.highWater, 1e9);
  const plan = guarded({ overrides: { spikeGuard: { enabled: true, atrMult: -1 } } }).exitPlan;
  assert.strictEqual(plan.spikeGuard.atrMult, 6);
  assert.ok(plan.warnings.includes('bad_param_spikeGuard'));
});

test('with ATR missing, the guard uses the last good ATR and flags it', () => {
  const r = ev(guarded(), bar(100, 130, 99, 128), { atr: NaN });
  assert.strictEqual(r.newStop, 90);
  assert.ok(r.flags.includes('bad_atr') && r.flags.includes('spike_unconfirmed'));
});

test('the guard covers ratcheting only: a spike can still reach a partial target', () => {
  const p = mk({ guard: true, overrides: only({ partials: [{ atR: 1, fraction: 0.5 }] }) });
  const r = ev(p, bar(100, 1e9, 99, 101));
  assert.strictEqual(r.action, 'reduce');
  assert.strictEqual(r.fillHint.price, 110);
  assert.ok(r.flags.includes('spike_unconfirmed'));
});

test('property: isolated false prints never reach the stop, long or short', () => {
  const r = rng(77);
  for (const side of ['long', 'short']) {
    const s = side === 'long' ? 1 : -1;
    for (let run = 0; run < 200; run++) {
      let p = mk({ side, profile: 'trend', guard: true, overrides: { timeStop: { enabled: false } } });
      let price = 100;
      for (let i = 1; i <= 60; i++) {
        const next = price * (1 + (r() - 0.5) * 0.02);
        let b = bar(price, Math.max(price, next) * 1.002, Math.min(price, next) * 0.998, next, i);
        if (i % 2 === 0 && r() < 0.3) b = s > 0 ? { ...b, h: 1e9 } : { ...b, l: 1e-6 };
        const res = ev(p, b);
        if (res.action === 'exit') break;
        p = applyExitResult(p, res);
        price = next;
        assert.ok(s > 0 ? p.stopPrice < price * 1.2 && p.highWater < 1e6 : p.stopPrice > price * 0.8 && p.lowWater > 1, `${side} stop ${p.stopPrice} at ${price}`);
      }
    }
  }
});

console.log('bad data');

const BAD = [NaN, undefined, null, Infinity, -1, 0, 'abc'];

test('never throws on any junk argument', () => {
  const p = mk();
  const junk = [undefined, null, 0, 'x', [], {}, NaN];
  assert.strictEqual(evaluateExit().action, 'hold');
  for (const position of [...junk, p]) for (const b of junk) for (const atr of junk) for (const regime of junk) {
    const r = evaluateExit({ position, bar: b, atr, regime, signal: regime, t: atr, config: b });
    assert.ok(['hold', 'exit', 'reduce'].includes(r.action));
  }
});

test('a getter that throws is contained and flagged', () => {
  const r = evaluateExit({ position: { get side() { throw new Error('boom'); } }, bar: tick(100) });
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.reasonCode, 'hold_bad_data');
  assert.ok(r.flags.includes('internal_error'));
});

test('bad ATR: hard stop still fires from the stored stop', () => {
  for (const atr of BAD) {
    const r = ev(mk(), bar(95, 96, 89, 94), { atr });
    assert.strictEqual(r.reasonCode, 'hard_stop');
    assert.strictEqual(r.fillHint.price, 90);
  }
});

test('bad ATR on a hold is flagged, and the trail keeps working on the last good ATR', () => {
  const p = mk({ overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } }) });
  for (const atr of BAD) {
    const r = ev(p, bar(100, 120, 99, 118), { atr });
    assert.strictEqual(r.action, 'hold');
    assert.strictEqual(r.reasonCode, 'hold_bad_data');
    assert.strictEqual(r.dataOk, false);
    assert.ok(r.flags.includes('bad_atr'));
    assert.strictEqual(r.newStop, 114);
  }
});

test('bad ATR with no last good ATR freezes the trail, never loosens it', () => {
  const p = mk({ atr: NaN, overrides: only({ trail: { enabled: true, atrMult: 3, activateR: 1, tightenFactor: 0.5 } }) });
  const r = ev(p, bar(100, 120, 99, 118), { atr: NaN });
  assert.strictEqual(r.newStop, 90);
  assert.ok(r.flags.includes('bad_atr'));
});

test('any single good price on a broken bar can still fire the stop', () => {
  for (const b of [
    { t: T0 + DAY, o: NaN, h: NaN, l: 85, c: NaN },
    { t: T0 + DAY, o: NaN, h: NaN, l: NaN, c: 85 },
    { t: T0 + DAY, l: 85 },
  ]) {
    const r = ev(mk(), b);
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.reasonCode, 'hard_stop');
    assert.strictEqual(r.dataOk, false);
    assert.ok(r.flags.includes('partial_bar'));
  }
});

test('broken short bar fires too, and the fill uses the worse known price', () => {
  const r = ev(mk({ side: 'short' }), { t: T0 + DAY, c: 115 });
  assert.strictEqual(r.reasonCode, 'hard_stop');
  assert.strictEqual(r.fillHint.price, 115);
});

test('no price at all: holds, flagged, keeps the stop', () => {
  for (const b of [null, undefined, {}, { o: NaN, h: NaN, l: NaN, c: NaN }, { o: 0, h: -1, l: 'x', c: null }]) {
    const r = ev(mk(), b, { t: T0 + DAY });
    assert.strictEqual(r.action, 'hold');
    assert.strictEqual(r.reasonCode, 'hold_bad_data');
    assert.ok(r.flags.includes('no_price'));
    assert.strictEqual(r.newStop, 90);
    assert.match(r.reason, /no_price/);
  }
});

test('no price but the last good price is through a tightened stop: exits on it, flagged', () => {
  const p = mk();
  const seen = applyExitResult(p, ev(p, tick(95)));
  const r = ev({ ...seen, stopPrice: 96 }, null, { t: T0 + 2 * DAY });
  assert.strictEqual(r.action, 'exit');
  assert.strictEqual(r.fillHint.price, 95);
  assert.ok(r.flags.includes('stop_on_last_good_price'));
});

test('no price does not block a time, regime or signal exit', () => {
  const b = { t: T0 + 2 * DAY, o: NaN, h: NaN, l: NaN, c: NaN };
  const sig = ev(mk({ profile: 'trend' }), b, { signal: { side: 'flat' } });
  assert.strictEqual(sig.reasonCode, 'signal_exit');
  assert.strictEqual(sig.fillHint.refPrice, 100);
  assert.ok(sig.flags.includes('no_price'));
  assert.strictEqual(ev(mk({ profile: 'trend' }), b, { regime: 'bear' }).reasonCode, 'regime_exit');
  assert.strictEqual(ev(mk({ profile: 'revert' }), { ...b, t: T0 + 10 * DAY }).reasonCode, 'time_stop');
});

test('an inconsistent bar never ratchets the stop or takes profit', () => {
  const p = mk({ profile: 'revert' });
  const r = ev(p, bar(100, 99, 120, 110));
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.newStop, 90);
  assert.strictEqual(r.update.highWater, 100);
  assert.ok(r.flags.includes('inconsistent_bar'));
  const spike = ev(mk({ profile: 'trend' }), { t: T0 + DAY, o: 100, h: NaN, l: 99, c: 1e9 });
  assert.strictEqual(spike.newStop, 90);
});

test('an inconsistent bar still fires the stop on its lowest price', () => {
  const r = ev(mk(), bar(100, 80, 95, 96));
  assert.strictEqual(r.action, 'exit');
});

test('a bad stopPrice falls back to the stored stop', () => {
  for (const stopPrice of BAD) {
    const r = ev({ ...mk(), stopPrice }, bar(95, 96, 89, 94));
    assert.strictEqual(r.reasonCode, 'hard_stop');
    assert.ok(r.flags.includes('bad_stop'));
    const h = ev({ ...mk(), stopPrice }, tick(100));
    assert.strictEqual(h.reasonCode, 'hold_bad_data');
    assert.strictEqual(h.newStop, 90);
  }
});

test('a corrupt plan is rebuilt from the position, and the stop still works', () => {
  for (const exitPlan of [null, 'x', { version: 99 }, { version: 1 }]) {
    const r = ev({ ...mk(), exitPlan }, tick(85));
    assert.strictEqual(r.reasonCode, 'hard_stop');
    assert.ok(r.flags.includes('plan_rebuilt'));
  }
});

test('stop gone everywhere: derived from entry when it can be, so the position stays protected', () => {
  const p = { ...mk(), stopPrice: NaN, initialStopPrice: null, exitPlan: null };
  const r = ev(p, tick(100));
  assert.strictEqual(r.newStop, 96);
  assert.ok(r.flags.includes('bad_stop') && r.flags.includes('plan_rebuilt'));
});

test('no stop and no entry: closes if there is a price, flagged hold if not', () => {
  const p = { side: 'long', entryTime: T0, stopPrice: NaN, exitProfile: 'swing' };
  const r = ev(p, tick(100));
  assert.strictEqual(r.action, 'exit');
  assert.strictEqual(r.reasonCode, 'no_stop');
  const none = ev(p, null, { t: T0 + DAY });
  assert.strictEqual(none.action, 'hold');
  assert.strictEqual(none.reasonCode, 'hold_bad_data');
});

test('bad side is flagged, and inferred from the stop when possible', () => {
  const p = mk();
  assert.strictEqual(ev({ ...p, side: 'buy', exitPlan: { ...p.exitPlan, side: null } }, tick(85)).action, 'exit');
  const r = ev({ side: 'x', stopPrice: NaN }, tick(100));
  assert.strictEqual(r.reasonCode, 'hold_bad_data');
  assert.ok(r.flags.includes('bad_side'));
});

test('bad clock: falls back to stored barsHeld and flags it', () => {
  const p = { ...mk({ overrides: only({ timeStop: { enabled: true, bars: 5, minR: 0.5, maxBars: null } }) }), barsHeld: 7 };
  const r = evaluateExit({ position: p, bar: { o: 100, h: 100, l: 100, c: 100 }, atr: 2, regime: 'neutral', t: NaN });
  assert.strictEqual(r.reasonCode, 'time_stop');
  assert.ok(r.flags.includes('bad_time'));
});

test('entryTime as an ISO string works (entities store dates that way)', () => {
  const p = { ...mk({ overrides: only({ timeStop: { enabled: true, bars: 5, minR: 0.5, maxBars: null } }) }), entryTime: new Date(T0).toISOString() };
  assert.strictEqual(ev(p, tick(100, 5)).reasonCode, 'time_stop');
});

test('a bar from before entry cannot fire the stop on its wick', () => {
  const p = { ...mk(), entryTime: T0 + 2 * DAY };
  const r = ev(p, bar(100, 101, 80, 100, 1), { t: T0 + 3 * DAY });
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.reasonCode, 'hold_bad_data');
  assert.ok(r.flags.includes('bar_before_entry'));
});

test('missing regime is flagged when the profile relies on it, without failing dataOk', () => {
  const r = ev(mk({ profile: 'trend' }), tick(100), { regime: undefined });
  assert.strictEqual(r.action, 'hold');
  assert.ok(r.flags.includes('regime_missing'));
  assert.strictEqual(r.dataOk, true);
  assert.ok(ev(mk({ profile: 'trend' }), tick(100), { regime: 'martian' }).flags.includes('bad_regime'));
});

test('malformed signal is flagged, not acted on', () => {
  const r = ev(mk(), tick(100), { signal: { side: 'sideways' } });
  assert.strictEqual(r.action, 'hold');
  assert.ok(r.flags.includes('bad_signal'));
});

test('corrupt partialsTaken blocks further partials rather than risk a repeat sale', () => {
  const r = ev({ ...mk({ profile: 'revert' }), partialsTaken: 'oops' }, bar(100, 111, 99, 108));
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.reasonCode, 'hold_bad_data');
  assert.ok(r.flags.includes('bad_partials_state'));
});

test('property: every hold on bad data carries a flag', () => {
  const r = rng(5);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 3000; i++) {
    const side = pick(['long', 'short']);
    const p = mk({ side, profile: pick(['trend', 'swing', 'revert']) });
    const v = () => pick([...BAD, 100, 101, 99]);
    const b = { t: T0 + DAY, o: v(), h: v(), l: v(), c: v() };
    const atr = pick([...BAD, 2]);
    const res = evaluateExit({ position: { ...p, stopPrice: pick([p.stopPrice, NaN]) }, bar: b, atr, regime: 'neutral', t: b.t });
    const prices = [b.o, b.h, b.l, b.c];
    const barBad = prices.some((x) => !(typeof x === 'number' && Number.isFinite(x) && x > 0))
      || !(b.h >= b.l && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c));
    const atrBad = !(typeof atr === 'number' && Number.isFinite(atr) && atr > 0);
    if (res.action === 'hold' && (barBad || atrBad)) {
      assert.strictEqual(res.dataOk, false);
      assert.strictEqual(res.reasonCode, 'hold_bad_data');
      assert.ok(res.flags.length > 0);
    }
  }
});

// Review item 1: order of events between a stop and the bar that tests it.
{
  const moved = (stop, prior, over = {}) => ({ ...mk({ overrides: only({}) }), stopPrice: stop, stopSetAt: T0 + DAY + 1000,
    ...(prior === undefined ? {} : { stopLog: [{ t: T0, stop: prior }, { t: T0 + DAY + 1000, stop }] }), ...over });

  test('a stop moved during the bar ignores the range but meets the close', () => {
    const p = moved(134, 90);
    assert.strictEqual(ev(p, bar(100, 151, 99, 148)).action, 'hold');
    const r = ev(p, bar(100, 151, 99, 120));
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.fillHint.stopPrice, 134);
    close(r.fillHint.price, 120);
    close(r.fillHint.laterPrice, 120);
  });

  test('the stop in force at the bar start still meets the whole range', () => {
    const r = ev(moved(134, 99.5), bar(100, 151, 99, 148));
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.fillHint.stopPrice, 99.5);
    assert.strictEqual(r.fillHint.laterPrice, undefined);
  });

  test('a tick after the move tests the moved stop', () => {
    const r = ev(moved(134, 90, { stopSetAt: T0 + DAY - 1 }), tick(133));
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.fillHint.stopPrice, 134);
  });

  test('prices known to come after the move count, when a caller has them', () => {
    const r = ev(moved(134, 90), bar(100, 151, 99, 148), { after: { h: 148, l: 133 } });
    assert.strictEqual(r.action, 'exit');
    close(r.fillHint.price, 134);
  });

  test('no stop clock means the current stop meets the whole bar, as before', () => {
    const p = moved(134, undefined, { stopSetAt: undefined });
    close(ev(p, bar(100, 151, 99, 148)).fillHint.stopPrice, 134);
  });
}

// Retest item 1: a bar older than the stop, after stopPrior has been cleared.
for (const [tf, ms] of [['1h', 3600e3], ['4h', 4 * 3600e3], ['1d', DAY]]) {
  const setAt = T0 + DAY + ms;
  const p = { ...mk({ overrides: only({}) }), stopPrice: 139.5, stopSetAt: setAt };
  const daily = (l, c) => ({ ...bar(100, 151, l, c), t: setAt - 1 });

  test(`${tf}: a bar that began before the ratchet cannot test the stop on its range`, () => {
    assert.strictEqual(stopAt(p, setAt - 1), null);
    assert.strictEqual(ev(p, daily(101, 150)).action, 'hold');
    close(ev(p, daily(101, 120)).fillHint.price, 120);
  });

  test(`${tf}: a bar beginning at or after the ratchet meets the stop`, () => {
    assert.strictEqual(stopAt(p, setAt), 139.5);
    const b = { ...bar(145, 151, 139, 148), t: setAt };
    assert.strictEqual(ev(p, b).fillHint.stopPrice, 139.5);
  });
}

test('a short mirrors the unknown case, and a bar before entry tests nothing', () => {
  const p = { ...mk({ side: 'short', overrides: only({}) }), stopPrice: 60, stopSetAt: T0 + DAY + 1 };
  assert.strictEqual(ev(p, bar(100, 110, 50, 52)).action, 'hold');
  assert.strictEqual(stopAt(mk({ overrides: only({}) }), T0 - 1), null);
});

// Stop history: one rule for every price sample.
{
  const start = { side: 'long', entryTime: 1000, stopPrice: 90 };
  const after = (p, stop, t) => ({ ...p, stopPrice: stop, ...recordStop(p, stop, t) });

  test('stopAt walks the history, and every sample meets the stop of its own time', () => {
    const p = after(after(after(start, 100, 2000), 110, 3000), 120, 4000);
    assert.deepStrictEqual([999, 1000, 1999, 2000, 2500, 3000, 3999, 4000, 9000].map((t) => stopAt(p, t)),
      [null, 90, 90, 100, 100, 110, 110, 120, 120]);
  });

  test('the history survives a restart', () => {
    const p = after(after(start, 100, 2000), 110, 3000);
    assert.strictEqual(stopAt(JSON.parse(JSON.stringify(p)), 2500), 100);
  });

  test('no history: only samples from stopSetAt on can test; no clock at all means the current stop', () => {
    const p = { stopPrice: 100, stopSetAt: 5000, entryTime: 1000 };
    assert.strictEqual(stopAt(p, 4999), null);
    assert.strictEqual(stopAt(p, 5000), 100);
    assert.strictEqual(stopAt({ stopPrice: 100 }, 1), 100);
    assert.strictEqual(stopAt({ stopPrice: 100, entryTime: 10 }, null), 100);
  });

  test('the cap keeps the oldest entry and never answers with a tighter stop', () => {
    let p = start;
    for (let i = 1; i <= 500; i += 1) p = after(p, 90 + i, 1000 + i * 100);
    assert.ok(p.stopLog.length <= 48);
    assert.deepStrictEqual(p.stopLog[0], { t: 1000, stop: 90 });
    for (let i = 0; i <= 500; i += 1) assert.ok(stopAt(p, 1000 + i * 100) <= 90 + i, 'looser or equal');
    assert.strictEqual(stopAt(p, 1000 + 500 * 100), 590);
    assert.strictEqual(stopAt(p, 999), null);
  });

  test('a move at the same time replaces, and time never runs backwards', () => {
    const p = after(after(start, 100, 2000), 105, 2000);
    assert.deepStrictEqual(p.stopLog, [{ t: 1000, stop: 90 }, { t: 2000, stop: 105 }]);
    assert.strictEqual(after(p, 110, 1500).stopSetAt, 2000);
  });

  test('a short reads the same history', () => {
    const p = after({ side: 'short', entryTime: 1000, stopPrice: 110 }, 100, 2000);
    assert.strictEqual(stopAt(p, 1500), 110);
    assert.strictEqual(stopAt(p, 2500), 100);
  });
}

// A bar published late: its close came before a stop the ticks set meanwhile.
for (const [tf, ms] of [['1h', 3600e3], ['4h', 4 * 3600e3], ['1d', DAY]]) {
  const barT = T0 + DAY;
  const closeT = barT + ms;
  const late = (over = {}) => ({ ...mk({ timeframe: tf, overrides: only({}) }), stopPrice: 115.92, stopSetAt: closeT + 900000,
    stopLog: [{ t: T0, stop: 90 }, { t: closeT + 900000, stop: 115.92 }], ...over });
  const b = (c, l = 99) => ({ ...bar(100, 127, l, c), t: barT });

  test(`${tf}: a close before the stop was set does not meet it`, () => {
    assert.strictEqual(ev(late(), b(100)).action, 'hold');
  });

  test(`${tf}: that close still meets the stop in force at the time`, () => {
    const r = ev(late(), b(89, 95));
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.fillHint.stopPrice, 90);
  });

  test(`${tf}: a stop set before the close meets the close`, () => {
    const setAt = closeT - 1000;
    const r = ev(late({ stopSetAt: setAt, stopLog: [{ t: T0, stop: 90 }, { t: setAt, stop: 115.92 }] }), b(100));
    assert.strictEqual(r.fillHint.stopPrice, 115.92);
    close(r.fillHint.price, 100);
  });
}

test('a short mirrors the late close', () => {
  const p = { ...mk({ side: 'short', overrides: only({}) }), stopPrice: 84, stopSetAt: T0 + 2 * DAY + 900000,
    stopLog: [{ t: T0, stop: 110 }, { t: T0 + 2 * DAY + 900000, stop: 84 }] };
  assert.strictEqual(ev(p, bar(100, 101, 73, 100)).action, 'hold');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
