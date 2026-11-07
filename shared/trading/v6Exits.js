/**
 * V6 per-position exit plans. Pure: no clock, no I/O, inputs are never mutated.
 *
 * Differences from the legacy worker's exit block, each on purpose:
 *  - Stops are prices stored on the position, not a net-percent test, so a gap
 *    through the stop fills at the worse price instead of the stop.
 *  - One stop price holds hard stop, break-even and trail. It only ratchets, and
 *    that is enforced here against a floor kept in the plan, not by the caller.
 *  - A full OHLC bar and a tick (o=h=l=c) go down the same path.
 *
 * Within a bar the stop in force at the START of the bar is tested first, and any
 * ratchet earned on that bar applies from the NEXT bar. Moving the stop on the
 * bar's high and then testing it on the same bar's low would need an intrabar
 * order the bar does not contain.
 *
 * All Pct values are percent units: 0.10 means 0.10%.
 */

export const EXIT_PLAN_VERSION = 1;

/** Decision order when several triggers fire on one evaluation. First wins. */
export const EXIT_PRIORITY = Object.freeze([
  'hard_stop', 'breakeven_stop', 'trail_stop', 'no_stop',
  'time_stop', 'regime_exit', 'signal_exit',
  'take_profit', 'partial_take_profit',
]);

/** Flags that note a missing opinion rather than bad market data; dataOk stays true. */
const ADVISORY_FLAGS = new Set(['regime_missing', 'bad_regime', 'regime_baseline_set', 'bad_signal', 'signal_mismatch']);

const deepFreeze = (o) => {
  Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
};

/**
 * Pure data. Sweep by passing `config.overrides` (deep-merged, arrays replaced) or
 * a whole profile object to createExitPlan. Bars are bars of the strategy timeframe.
 * These defaults are round starting points. They have not been tested on market data.
 *
 *  hardStop.atrMult       stop distance if the position arrives with no usable stop
 *  hardStop.fallbackPct   same, when ATR is missing too
 *  breakEven.triggerR     best excursion, in R, that arms the break-even stop
 *  breakEven.bufferPct    added to the round-trip cost when placing the stop
 *  trail.atrMult          chandelier distance from the best price, in ATRs
 *  trail.activateR        best excursion, in R, before the trail starts
 *  trail.tightenFactor    multiplies atrMult while trails are tightened
 *  timeStop.bars/minR     after `bars`, leave if the open gain is under minR
 *  timeStop.maxBars       leave at this age regardless; null = no limit
 *  signalExit.onFlat/onOpposite   which strategy signals close the position
 *  regimeExit.action      'exit' closes on a CHANGE to an adverse regime; 'tighten'
 *                         tightens the trail for as long as the regime is adverse
 *  spikeGuard.atrMult     a new best price further than this many ATRs past the old one
 *                         does not ratchet until a following bar confirms it
 *  partials[]             { atR, fraction } fraction of the ORIGINAL position; sum <= 1
 *  minRewardRisk          for the signal gate's risk test
 */
// LOCAL CHANGE: values from docs/rebuild/research-r-exits.md (1d only; regime exit kept per contract, not isolated).
export const EXIT_PROFILES = deepFreeze({
  trend: {
    id: 'trend',
    minRewardRisk: 2,
    hardStop: { atrMult: 3, fallbackPct: 15 },
    breakEven: { enabled: false, triggerR: 1, bufferPct: 0.05 },
    trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 },
    spikeGuard: { enabled: true, atrMult: 6 },
    timeStop: { enabled: true, bars: 20, minR: 0, maxBars: null },
    signalExit: { enabled: true, onFlat: true, onOpposite: true },
    regimeExit: { enabled: true, action: 'exit' },
    partials: [],
  },
  swing: {
    id: 'swing',
    minRewardRisk: 1.5,
    hardStop: { atrMult: 2, fallbackPct: 10 },
    breakEven: { enabled: false, triggerR: 1, bufferPct: 0.05 },
    trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 },
    spikeGuard: { enabled: true, atrMult: 6 },
    timeStop: { enabled: true, bars: 20, minR: 0, maxBars: null },
    signalExit: { enabled: true, onFlat: true, onOpposite: true },
    regimeExit: { enabled: true, action: 'tighten' },
    partials: [],
  },
  revert: {
    id: 'revert',
    minRewardRisk: 1,
    hardStop: { atrMult: 2, fallbackPct: 8 },
    breakEven: { enabled: false, triggerR: 1, bufferPct: 0.05 },
    trail: { enabled: true, atrMult: 4, activateR: 1, tightenFactor: 0.5 },
    spikeGuard: { enabled: true, atrMult: 6 },
    timeStop: { enabled: true, bars: 10, minR: 0, maxBars: null },
    signalExit: { enabled: true, onFlat: true, onOpposite: true },
    regimeExit: { enabled: true, action: 'exit' },
    partials: [],
  },
});

const DEFAULT_PROFILE = 'swing';
const TIMEFRAME_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 24 * 3600e3 };
// Contract Tier 3, the dearest tier: an unknown cost must not understate break-even.
const DEFAULT_COSTS = { feePct: 0.10, slipPct: 0.25, stopSlipPct: 0.10 };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const px = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function toMs(x) {
  if (num(x) !== null) return x;
  if (typeof x === 'string' || x instanceof Date) {
    const ms = new Date(x).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** The value furthest in the protective direction: highest for a long, lowest for a short. */
function mostProtective(s, values) {
  const ok = values.filter((v) => px(v) !== null);
  if (!ok.length) return null;
  return s > 0 ? Math.max(...ok) : Math.min(...ok);
}

/** +1 long, -1 short, 0 unknown. An unlabelled side is inferred from where the stop sits. */
function sideSign(side, entry, stop) {
  if (side === 'long') return 1;
  if (side === 'short') return -1;
  if (px(entry) !== null && px(stop) !== null && entry !== stop) return stop < entry ? 1 : -1;
  return 0;
}

/** Makes a profile safe to run: bad sweep values disable a rule rather than corrupt it. */
function sanitizeProfile(p, warnings) {
  const out = JSON.parse(JSON.stringify(p));
  if (!(num(out.hardStop?.fallbackPct) > 0)) {
    out.hardStop = { ...out.hardStop, fallbackPct: EXIT_PROFILES[DEFAULT_PROFILE].hardStop.fallbackPct };
    warnings.push('bad_param_hardStop');
  }
  if (out.breakEven?.enabled && !(num(out.breakEven.triggerR) > 0)) {
    out.breakEven.enabled = false;
    warnings.push('bad_param_breakEven');
  }
  if (out.trail?.enabled && !(num(out.trail.atrMult) > 0)) {
    out.trail.enabled = false;
    warnings.push('bad_param_trail');
  }
  if (out.trail && !(num(out.trail.tightenFactor) > 0 && out.trail.tightenFactor <= 1)) {
    out.trail.tightenFactor = 0.5;
  }
  if (out.spikeGuard?.enabled && !(num(out.spikeGuard.atrMult) > 0)) {
    out.spikeGuard = { ...out.spikeGuard, atrMult: EXIT_PROFILES[DEFAULT_PROFILE].spikeGuard.atrMult };
    warnings.push('bad_param_spikeGuard');
  }
  if (out.timeStop?.enabled && !(num(out.timeStop.bars) > 0)) {
    out.timeStop.enabled = false;
    warnings.push('bad_param_timeStop');
  }

  const raw = Array.isArray(out.partials) ? out.partials : [];
  const valid = raw.filter((l) => num(l?.atR) > 0 && num(l?.fraction) > 0).sort((a, b) => a.atR - b.atR);
  if (valid.length !== raw.length) warnings.push('bad_param_partials');
  let left = 1;
  out.partials = [];
  for (const level of valid) {
    if (left <= 1e-9) { warnings.push('partials_capped'); break; }
    if (level.fraction > left + 1e-9) warnings.push('partials_capped');
    const fraction = Math.min(level.fraction, left);
    left -= fraction;
    out.partials.push({ atR: level.atR, fraction });
  }
  return out;
}

function resolveProfile(profile, positionProfile, overrides, warnings) {
  const named = typeof profile === 'string' ? profile : isObj(profile) ? profile.id : positionProfile;
  let base = EXIT_PROFILES[named];
  if (!base) {
    if (!isObj(profile)) warnings.push('unknown_profile');
    base = EXIT_PROFILES[DEFAULT_PROFILE];
  }
  const merged = deepMerge(deepMerge(base, isObj(profile) ? profile : {}), isObj(overrides) ? overrides : {});
  return sanitizeProfile(merged, warnings);
}

/** Round-trip cost in percent: fee and slippage both ways plus the extra slip a stop pays. */
function roundTripPct(costs) {
  const c = isObj(costs) ? costs : {};
  const pick = (k) => (num(c[k]) !== null && c[k] >= 0 ? c[k] : DEFAULT_COSTS[k]);
  return 2 * (pick('feePct') + pick('slipPct')) + pick('stopSlipPct');
}

/**
 * Builds the plan stored at position.exitPlan. JSON-safe by construction, so it
 * survives persistence. Never throws: problems land in plan.warnings.
 *
 * @param {object} args
 * @param {object} args.position  needs side, entryPrice; stopPrice or initialStopPrice
 * @param {string|object} [args.profile]  name or profile object; defaults to position.exitProfile
 * @param {number} [args.atr]
 * @param {string|object} [args.regime]  market regime at entry; config.regime also works
 * @param {object} [args.config]  { timeframe, barMs, costs: { feePct, slipPct, stopSlipPct }, overrides }
 */
export function createExitPlan({ position, profile, atr, regime, config } = {}) {
  const pos = isObj(position) ? position : {};
  const cfg = isObj(config) ? config : {};
  const warnings = [];
  const p = resolveProfile(profile, pos.exitProfile, cfg.overrides, warnings);

  const entry = px(pos.entryPrice);
  if (entry === null) warnings.push('bad_entry');
  const a = px(atr);
  const given = [pos.initialStopPrice, pos.stopPrice].find((v) => px(v) !== null) ?? null;
  const s = sideSign(pos.side, entry, given);
  if (s === 0) warnings.push('bad_side');

  // A stop on the profit side of entry is not a stop. Without entry it cannot be checked.
  let hardStop = given;
  if (entry !== null && (hardStop === null || s * (entry - hardStop) <= 0)) {
    warnings.push(hardStop === null ? 'no_stop_given' : 'stop_wrong_side');
    hardStop = null;
    if (s !== 0) {
      const dist = a !== null && num(p.hardStop.atrMult) > 0
        ? p.hardStop.atrMult * a
        : entry * (p.hardStop.fallbackPct / 100);
      const derived = entry - s * dist;
      hardStop = derived > 0 ? derived : entry * (1 - s * (p.hardStop.fallbackPct / 100));
    }
  }

  const riskPerUnit = entry !== null && hardStop !== null ? Math.abs(entry - hardStop) : null;
  const offsetPct = roundTripPct(cfg.costs) + (num(p.breakEven?.bufferPct) ?? 0);
  const breakEvenPrice = entry !== null && s !== 0 ? entry * (1 + (s * offsetPct) / 100) : null;

  let barMs = num(cfg.barMs) > 0 ? cfg.barMs : TIMEFRAME_MS[cfg.timeframe];
  if (!barMs) {
    if (cfg.timeframe !== undefined || cfg.barMs !== undefined) warnings.push('bad_timeframe');
    barMs = TIMEFRAME_MS['1d'];
  }

  const entryRegime = readRegime(regime ?? cfg.regime);
  const regimeAtEntry = entryRegime.hasBias ? entryRegime.bias : null;

  const partials = p.partials.map((l, i) => ({
    id: `p${i + 1}`,
    atR: l.atR,
    fraction: l.fraction,
    price: riskPerUnit !== null ? entry + s * l.atR * riskPerUnit : null,
  }));

  return {
    version: EXIT_PLAN_VERSION,
    profile: p.id ?? DEFAULT_PROFILE,
    side: s > 0 ? 'long' : s < 0 ? 'short' : null,
    entryPrice: entry,
    hardStopPrice: hardStop,
    riskPerUnit,
    breakEvenPrice,
    breakEvenOffsetPct: offsetPct,
    barMs,
    atrAtEntry: a,
    minRewardRisk: num(p.minRewardRisk),
    breakEven: p.breakEven,
    trail: p.trail,
    spikeGuard: p.spikeGuard,
    timeStop: p.timeStop,
    signalExit: p.signalExit,
    regimeExit: p.regimeExit,
    regimeAtEntry, // 1 bullish, 0 neutral, -1 bearish, null not known
    partials,
    warnings,
    // What evaluateExit needs to resume after a restart that is not already a
    // contract field on the position.
    state: {
      stopFloor: s !== 0 ? mostProtective(s, [hardStop, pos.stopPrice]) : hardStop,
      lastGoodPrice: entry,
      lastGoodAtr: a,
      partialsTaken: [],
      lastRegimeBias: regimeAtEntry,
      regimeExitLatched: false,
      pendingBest: null,
    },
  };
}

function loadPlan(position, atr, config, flags) {
  const plan = position.exitPlan;
  const usable = isObj(plan) && plan.version === EXIT_PLAN_VERSION && isObj(plan.state)
    && isObj(plan.breakEven) && isObj(plan.trail) && isObj(plan.timeStop)
    && isObj(plan.signalExit) && isObj(plan.regimeExit) && Array.isArray(plan.partials);
  if (usable) return plan;
  flags.push('plan_rebuilt');
  return createExitPlan({ position, profile: position.exitProfile, atr, config });
}

/** Keeps every usable price from the bar and judges whether the bar can be trusted. */
function readBar(bar, entryMs, flags) {
  const raw = isObj(bar) ? bar : {};
  let [o, h, l, c] = [px(raw.o), px(raw.h), px(raw.l), px(raw.c)];
  let afterEntry = true;

  // Highs and lows from before the fill never happened to this position.
  if (entryMs !== null && num(raw.t) !== null && raw.t < entryMs) {
    flags.push('bar_before_entry');
    [o, h, l] = [c, c, c];
    afterEntry = false;
  }

  const prices = [o, h, l, c].filter((v) => v !== null);
  const complete = prices.length === 4;
  const consistent = complete && h >= l && h >= Math.max(o, c) && l <= Math.min(o, c);
  if (!prices.length) flags.push('no_price');
  else if (!complete) flags.push('partial_bar');
  else if (!consistent) flags.push('inconsistent_bar');

  // One bad high would otherwise raise the stop for good, so only clean bars ratchet.
  return { o, h, l, c, prices, clean: afterEntry && complete && consistent };
}

const REGIME_WORDS = {
  bull: 1, bullish: 1, risk_on: 1, 'risk-on': 1, up: 1,
  bear: -1, bearish: -1, risk_off: -1, 'risk-off': -1, down: -1, crash: -1,
  neutral: 0, chop: 0, range: 0, sideways: 0,
};

/** Accepts a word, or { label|state|name|trend|bias, riskOn, riskOff, tightenTrails }. */
function readRegime(regime) {
  if (regime === null || regime === undefined) return { known: false, hasBias: false, missing: true, bias: 0, tighten: false };
  const word = isObj(regime)
    ? regime.label ?? regime.state ?? regime.name ?? regime.trend ?? regime.bias
    : regime;
  const tighten = isObj(regime) && regime.tightenTrails === true;
  if (isObj(regime) && (regime.riskOff === true || regime.riskOn === false)) return { known: true, hasBias: true, bias: -1, tighten };
  if (isObj(regime) && regime.riskOn === true) return { known: true, hasBias: true, bias: 1, tighten };
  const bias = typeof word === 'string' ? REGIME_WORDS[word.toLowerCase()] : undefined;
  return bias === undefined
    ? { known: tighten, hasBias: false, bias: 0, tighten }
    : { known: true, hasBias: true, bias, tighten };
}

/**
 * How far a clean bar may move the best price. A jump past the ATR limit is held as
 * pending, and only a LATER bar landing within the same limit of it, on either side,
 * makes it real. Merely passing the old best is not enough: a rally would then validate
 * a bad print, and so would a second, larger one.
 */
function guardBest({ s, prevBest, barBest, pending, barT, a, guard }) {
  const limit = guard.enabled && a !== null && prevBest !== null ? guard.atrMult * a : null;
  if (limit === null) return { best: mostProtective(s, [prevBest, barBest]), pending: null, suspect: false };

  let base = prevBest;
  let held = pending;
  if (pending && barT !== null && (num(pending.t) === null || barT > pending.t)) {
    if (Math.abs(pending.price - barBest) <= limit) base = mostProtective(s, [prevBest, pending.price]);
    held = null;
  }
  if (s * (barBest - base) > limit) return { best: base, pending: { price: barBest, t: barT }, suspect: true };
  return { best: mostProtective(s, [base, barBest]), pending: held, suspect: false };
}

function stopKind(s, stop, plan) {
  if (px(plan.hardStopPrice) !== null && s * (stop - plan.hardStopPrice) <= 0) return 'hard_stop';
  if (px(plan.breakEvenPrice) !== null
    && Math.abs(stop - plan.breakEvenPrice) <= plan.breakEvenPrice * 1e-12) return 'breakeven_stop';
  return 'trail_stop';
}

const STOP_LABEL = { hard_stop: 'Hard stop', breakeven_stop: 'Break-even stop', trail_stop: 'Trailing stop' };

function finish({ action, fraction, fractionOfOriginal, partialId, reasonCode, reason, newStop, stopChanged, fillHint, flags, update }) {
  const uniq = [...new Set(flags)];
  const dataOk = uniq.every((f) => ADVISORY_FLAGS.has(f));
  const problem = action === 'hold' && !dataOk;
  return {
    action,
    fraction: fraction ?? (action === 'exit' ? 1 : 0),
    fractionOfOriginal: fractionOfOriginal ?? null,
    reasonCode: problem ? 'hold_bad_data' : reasonCode,
    reason: problem ? `${reason} Data problem, position not fully assessed: ${uniq.join(', ')}.` : reason,
    newStop: newStop ?? null,
    stopChanged: !!stopChanged,
    fillHint: fillHint ?? null,
    flags: uniq,
    dataOk,
    update: update ?? null,
    // Top-level copies for callers that patch these two fields rather than `update`.
    exitPlan: update?.exitPlan ?? null,
    partialId: partialId ?? null,
  };
}

function evaluate({ position, bar, atr, signal, regime, t, config, after }) {
  const flags = [];
  if (!isObj(position)) {
    return finish({ action: 'hold', reasonCode: 'hold', reason: 'No position to evaluate.', flags: ['no_position'] });
  }

  const plan = loadPlan(position, atr, config, flags);
  const state = plan.state ?? {};
  const entry = px(position.entryPrice) ?? px(plan.entryPrice);
  const R = px(plan.riskPerUnit);

  // The floor, the hard stop and the recorded initial stop all cap how far a caller
  // can move position.stopPrice. A tighter stop from the caller is accepted.
  const stored = [state.stopFloor, plan.hardStopPrice, position.initialStopPrice];
  const given = px(position.stopPrice);
  const s = sideSign(position.side ?? plan.side, entry, given ?? px(plan.hardStopPrice));
  if (s === 0) {
    return finish({ action: 'hold', reasonCode: 'hold', reason: 'Position side is unknown.',
      newStop: given, flags: [...flags, 'bad_side'] });
  }
  const stop = mostProtective(s, [given, ...stored]);
  const floor = mostProtective(s, stored);
  if (given === null) flags.push('bad_stop');
  else if (floor !== null && s * (floor - given) > 0) flags.push('stop_loosened_ignored');

  const entryMs = toMs(position.entryTime);
  const b = readBar(bar, entryMs, flags);
  const lastGood = px(state.lastGoodPrice);
  const mark = b.c ?? lastGood;

  let a = px(atr);
  const guard = plan.spikeGuard ?? EXIT_PROFILES[DEFAULT_PROFILE].spikeGuard;
  if (a === null) {
    if (plan.trail.enabled || guard.enabled) flags.push('bad_atr');
    a = px(state.lastGoodAtr);
  }

  const clock = num(t) ?? (isObj(bar) ? num(bar.t) : null);
  let barsHeld;
  if (clock !== null && entryMs !== null && clock >= entryMs) {
    // Counted from the clock, not per call: the live worker evaluates every five
    // minutes, and a restart must not lose or repeat bars.
    barsHeld = Math.floor((clock - entryMs) / plan.barMs);
  } else {
    flags.push('bad_time');
    barsHeld = num(position.barsHeld) ?? 0;
  }

  const water = (pick, ...vals) => {
    const ok = vals.filter((v) => px(v) !== null);
    return ok.length ? pick(...ok) : null;
  };
  const prevBest = water(s > 0 ? Math.max : Math.min, s > 0 ? position.highWater : position.lowWater, entry);
  const pendingBest = isObj(state.pendingBest) && px(state.pendingBest.price) !== null ? state.pendingBest : null;
  const g = b.clean
    ? guardBest({ s, prevBest, barBest: s > 0 ? b.h : b.l, pending: pendingBest,
      barT: (isObj(bar) ? num(bar.t) : null) ?? clock, a, guard })
    : { best: prevBest, pending: pendingBest, suspect: false };
  if (g.suspect) flags.push('spike_unconfirmed');
  const worstWater = water(s > 0 ? Math.min : Math.max, s > 0 ? position.lowWater : position.highWater, entry,
    b.clean ? (s > 0 ? b.l : b.h) : null);
  const hw = s > 0 ? g.best : worstWater;
  const lw = s > 0 ? worstWater : g.best;

  const reg = readRegime(regime);
  const lastRegime = num(state.lastRegimeBias);
  if (plan.regimeExit.enabled) {
    if (reg.missing) flags.push('regime_missing');
    else if (!reg.known) flags.push('bad_regime');
    else if (reg.hasBias && lastRegime === null) flags.push('regime_baseline_set');
  }
  const adverse = reg.bias === -s;
  // Fires on the change, then stays latched while the regime stays adverse, so a bar
  // replayed after a restart repeats an exit that was decided but not yet filled.
  // Unknown regimes neither set nor clear anything.
  const regimeLatched = (adverse && lastRegime !== null && lastRegime !== reg.bias)
    || (state.regimeExitLatched === true && !(reg.hasBias && !adverse));

  const nextState = {
    ...state,
    lastGoodPrice: b.clean && !g.suspect ? b.c : lastGood,
    lastGoodAtr: px(atr) ?? px(state.lastGoodAtr),
    pendingBest: g.pending,
    lastRegimeBias: reg.hasBias ? reg.bias : lastRegime,
    regimeExitLatched: regimeLatched,
  };
  const update = (newStop, partialsTaken) => ({
    stopPrice: newStop,
    highWater: hw,
    lowWater: lw,
    barsHeld,
    partialsTaken: partialsTaken ?? position.partialsTaken ?? [],
    exitPlan: { ...plan, state: { ...nextState, stopFloor: newStop, ...(partialsTaken ? { partialsTaken } : {}) } },
  });

  // 1. No stop anywhere. "No stop = no trade", so leave if there is a price to leave at.
  if (stop === null) {
    if (mark === null) {
      return finish({ action: 'hold', reasonCode: 'hold', reason: 'No stop and no price.', flags, update: update(null) });
    }
    return finish({ action: 'exit', reasonCode: 'no_stop', reason: 'Position has no recoverable stop, closing it.',
      fillHint: { kind: 'next_open', price: null, refPrice: mark, gapped: false }, flags, update: update(null) });
  }

  // 2. The bar's range meets only the stop in force when the bar began, and its close
  // only the stop in force at the close. `after` is what followed the current stop.
  const worst = b.prices.length ? (s > 0 ? Math.min(...b.prices) : Math.max(...b.prices)) : lastGood;
  const barT = isObj(bar) ? num(bar.t) : null;
  const stopWhen = (at) => { const v = stopAt(position, at); return v === given ? stop : v; };
  const barStop = stopWhen(barT);
  const closeStop = stopWhen(barT === null ? null : barT + plan.barMs);
  const worstAfter = barStop !== stop ? px(s > 0 ? after?.l : after?.h) : null;
  const rangeHit = worst !== null && barStop !== null && s * (worst - barStop) <= 0;
  const closeHit = closeStop !== barStop && closeStop !== null && b.c !== null && s * (b.c - closeStop) <= 0;
  const afterHit = worstAfter !== null && s * (worstAfter - stop) <= 0;
  if (rangeHit || closeHit || afterHit) {
    if (!b.prices.length) flags.push('stop_on_last_good_price');
    const hit = rangeHit ? barStop : closeHit ? closeStop : stop;
    const ref = rangeHit ? b.o ?? b.c ?? worst : b.c ?? worstAfter;
    const fill = s > 0 ? Math.min(hit, ref) : Math.max(hit, ref);
    const gapped = fill !== hit;
    const kind = stopKind(s, hit, plan);
    return finish({
      action: 'exit', reasonCode: kind,
      reason: gapped
        ? `${STOP_LABEL[kind]} at ${hit}, price gapped through it to ${fill}.`
        : `${STOP_LABEL[kind]} hit at ${hit}.`,
      newStop: stop, stopChanged: given !== stop,
      fillHint: { kind: 'stop', price: fill, stopPrice: hit, gapped, gapPct: (Math.abs(fill - hit) / hit) * 100,
        ...(rangeHit ? {} : { laterPrice: ref }) },
      flags, update: update(stop),
    });
  }

  const tighten = (isObj(config) && config.tightenTrails === true) || reg.tighten
    || (plan.regimeExit.enabled && plan.regimeExit.action === 'tighten' && adverse);

  // 3. Ratchet. Takes effect from the next bar. The stop test above never looks at
  // the spike guard: leaving on a bad price is the safe direction.
  let newStop = stop;
  if (b.clean && !g.suspect) {
    const best = s > 0 ? hw : lw;
    const bestR = R !== null && entry !== null ? (s * (best - entry)) / R : null;
    const cands = [];
    if (plan.breakEven.enabled && bestR !== null && bestR >= plan.breakEven.triggerR
      && px(plan.breakEvenPrice) !== null && s * (best - plan.breakEvenPrice) > 0) {
      cands.push(plan.breakEvenPrice);
    }
    if (plan.trail.enabled && a !== null && (bestR === null || bestR >= (num(plan.trail.activateR) ?? 0))) {
      const mult = plan.trail.atrMult * (tighten ? plan.trail.tightenFactor : 1);
      cands.push(best - s * mult * a);
    }
    newStop = mostProtective(s, [stop, ...cands]);
  }
  const decided = { newStop, stopChanged: newStop !== given, flags, update: update(newStop) };
  const nextOpen = { kind: 'next_open', price: null, refPrice: mark, gapped: false };

  // 4. Time stop.
  const ts = plan.timeStop;
  if (ts.enabled) {
    if (num(ts.maxBars) !== null && barsHeld >= ts.maxBars) {
      return finish({ ...decided, action: 'exit', reasonCode: 'time_stop',
        reason: `Held ${barsHeld} bars, the limit for this profile.`, fillHint: nextOpen });
    }
    if (barsHeld >= ts.bars) {
      const gainR = R !== null && entry !== null && mark !== null ? (s * (mark - entry)) / R : null;
      if (gainR === null) flags.push('time_stop_unverified');
      else if (gainR < (num(ts.minR) ?? 0)) {
        return finish({ ...decided, action: 'exit', reasonCode: 'time_stop',
          reason: `After ${barsHeld} bars the trade is at ${gainR.toFixed(2)}R, short of the ${ts.minR}R it needed.`,
          fillHint: nextOpen });
      }
    }
  }

  // 5. Regime exit.
  if (plan.regimeExit.enabled && plan.regimeExit.action === 'exit' && adverse && regimeLatched) {
    return finish({ ...decided, action: 'exit', reasonCode: 'regime_exit',
      reason: `Market regime turned against this ${s > 0 ? 'long' : 'short'}.`, fillHint: nextOpen });
  }

  // 6. Signal exit.
  if (signal !== null && signal !== undefined) {
    const side = isObj(signal) ? signal.side : undefined;
    if (side !== 'long' && side !== 'short' && side !== 'flat') flags.push('bad_signal');
    else if (signal.symbol !== undefined && position.symbol !== undefined && signal.symbol !== position.symbol) {
      flags.push('signal_mismatch');
    } else if (plan.signalExit.enabled) {
      const flat = side === 'flat' && plan.signalExit.onFlat;
      const opposite = side === (s > 0 ? 'short' : 'long') && plan.signalExit.onOpposite;
      if (flat || opposite) {
        return finish({ ...decided, action: 'exit', reasonCode: 'signal_exit',
          reason: signal.reason || `Strategy signal is now ${side}.`, fillHint: nextOpen });
      }
    }
  }

  // 7. Partial take-profit. Fractions are of the original size, so the sum is checked
  // against what the position says it already sold.
  const onPosition = position.partialsTaken ?? [];
  if (!Array.isArray(onPosition)) {
    flags.push('bad_partials_state');
  } else if (b.clean && plan.partials.length) {
    // The plan's record is the full one. The position may hold only bare ids.
    const inPlan = Array.isArray(state.partialsTaken) ? state.partialsTaken : [];
    const planIds = new Set(inPlan.map((p) => p?.id));
    const takenRaw = [...inPlan, ...onPosition
      .map((p) => (typeof p === 'string' ? { id: p, fraction: plan.partials.find((l) => l.id === p)?.fraction ?? 0 } : p))
      .filter((p) => !planIds.has(p?.id))];
    const takenIds = new Set(takenRaw.map((p) => p?.id));
    const takenSum = Math.min(1, sum(takenRaw.map((p) => Math.max(0, num(p?.fraction) ?? 0))));
    const extreme = s > 0 ? b.h : b.l;
    let left = 1 - takenSum;
    const hits = [];
    for (const level of plan.partials) {
      if (takenIds.has(level.id) || px(level.price) === null || s * (extreme - level.price) < 0) continue;
      const fraction = Math.min(level.fraction, left);
      if (fraction <= 1e-9) continue;
      left -= fraction;
      hits.push({ ...level, fraction });
    }
    if (hits.length) {
      const sold = sum(hits.map((h) => h.fraction));
      const price = sum(hits.map((h) => h.fraction * h.price)) / sold;
      const taken = [...takenRaw, ...hits.map((h) => ({ id: h.id, atR: h.atR, fraction: h.fraction, price: h.price, t: clock }))];
      const closesAll = left <= 1e-9;
      return finish({
        ...decided,
        action: closesAll ? 'exit' : 'reduce',
        // `fraction` is of the CURRENT qty, so qty * fraction is always right.
        fraction: closesAll ? 1 : sold / (1 - takenSum),
        fractionOfOriginal: sold,
        partialId: hits.at(-1).id,
        reasonCode: closesAll ? 'take_profit' : 'partial_take_profit',
        reason: `Profit target at ${hits.at(-1).atR}R reached, taking ${(sold * 100).toFixed(0)}% of the original size.`,
        fillHint: { kind: 'target', price, refPrice: b.c, gapped: false },
        update: update(newStop, taken),
      });
    }
  }

  return finish({ ...decided, action: 'hold', reasonCode: 'hold', reason: 'No exit rule triggered.' });
}

/**
 * Decides what to do with one position on one bar or tick. Pure and idempotent:
 * re-running a bar after a restart gives the same answer.
 *
 * `bar` is a closed OHLC bar (simulator) or o=h=l=c (live). `t` is the decision
 * clock; bar.t is used if it is absent. `signal` is this strategy's Signal for the
 * symbol, null for no opinion. `regime` is a word or object, see readRegime.
 * `config.tightenTrails` applies the market breaker's tighter trail.
 * `after`, optional {h, l}: the range known to follow any stop moved during `bar`.
 *
 * Beyond the contract fields the result has `flags`, `dataOk`, `stopChanged`,
 * `fractionOfOriginal`, `partialId`, and `update`, the position fields to persist.
 * Use applyExitResult to merge it. A caller that applies only newStop and exitPlan
 * keeps the ratchet floor and partial record but not the water marks.
 *
 * @returns {{action:'hold'|'exit'|'reduce', fraction:number, fractionOfOriginal:?number,
 *   reasonCode:string, reason:string, newStop:?number, stopChanged:boolean,
 *   fillHint:?object, flags:string[], dataOk:boolean, update:?object,
 *   exitPlan:?object, partialId:?string}}
 */
export function evaluateExit(args) {
  try {
    return evaluate(isObj(args) ? args : {});
  } catch (e) {
    return finish({ action: 'hold', reasonCode: 'hold', reason: `Exit evaluation failed: ${e?.message}.`, flags: ['internal_error'] });
  }
}

/** The position to persist after a decision. qty stays with the ledger. */
/**
 * The stop in force at time t, the one rule for testing any price sample: a sample may
 * only meet the stop in force when it began. Null means t is older than anything known,
 * so test nothing. position.stopLog holds {t, stop} per change, oldest first, and
 * position.stopSetAt the time of the current stop; the entry counts if it never moved.
 * Thinning the log can return an older stop, which is looser, never a tighter one.
 */
export function stopAt(position, t) {
  const current = px(position?.stopPrice);
  const log = Array.isArray(position?.stopLog) ? position.stopLog : [];
  const setAt = num(position?.stopSetAt) ?? num(log.at(-1)?.t) ?? toMs(position?.entryTime);
  if (setAt === null || num(t) === null || t >= setAt) return current;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (num(log[i]?.t) !== null && log[i].t <= t) return px(log[i].stop);
  }
  return null;
}

const STOP_LOG_MAX = 48;

/** Position fields for a stop change at time t. The oldest entry always stays. */
export function recordStop(position, stop, t) {
  const from = num(position?.stopSetAt) ?? toMs(position?.entryTime);
  const old = px(position?.stopPrice);
  const known = Array.isArray(position?.stopLog) ? position.stopLog : [];
  const log = known.length ? [...known] : (from !== null && old !== null ? [{ t: from, stop: old }] : []);
  const at = Math.max(t, num(position?.stopSetAt) ?? -Infinity);
  if (log.at(-1)?.t === at) log.pop();
  log.push({ t: at, stop });
  if (log.length > STOP_LOG_MAX) log.splice(1, 1);
  return { stopSetAt: at, stopLog: log };
}

export function applyExitResult(position, result) {
  return result?.update ? { ...position, ...result.update } : position;
}
