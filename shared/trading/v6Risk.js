/**
 * V6 portfolio risk engine. Pure: the clock, equity and market data are passed in.
 *
 * Decides whether NEW ENTRIES may happen and how big they may be. It has no say
 * over exits: nothing here can stop a position leaving. Its only influence on
 * exits is to ask for more of them (riskDirectives: flatten, tightenTrails).
 *
 * Failing closed: an input that cannot be read means no entry, never a throw and
 * never a default that lets a trade through.
 *
 * UNITS: every *Pct value, here and in the arguments, is a FRACTION (0.005 = 0.5%).
 * This includes signal.stopDistancePct and costs.feePct / costs.slipPct. A caller
 * that passes percent numbers by mistake gets a rejection or a smaller size, never a
 * bigger one. Volatilities are annualised fractions (0.8 = 80% a year).
 *
 * Plain-English table of every limit: docs/rebuild/risk-engine.md.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SCHEMA_VERSION = 1;
// Absorbs float noise so that "exactly at the threshold" behaves as exactly at it:
// 1 - 0.95 is 0.050000000000000044, and 0.92 - 1 misses -0.08 the other way.
const EPS = 1e-12;
const LADDER_MIN_GAP = 0.01;
const BTC_BAR_GRACE_MS = HOUR_MS;
const REVIEW_MESSAGES = Object.freeze({
  flat_entries_blocked: 'No positions and no new entries allowed, so this cannot recover by itself. A human must review it.',
  flat_entries_too_small: 'No positions, and entries at this reduced size fall below the minimum order, so this cannot recover by itself. A human must review it.',
});
// A daily vol of 0.04 passed where an annual one belongs would be read as a very
// calm asset and sized up. Nothing tradable is calmer than this per year.
const MIN_PLAUSIBLE_ANNUAL_VOL = 0.10;

/** Ladder rungs, indexed by riskState.rung. */
export const LADDER_RUNGS = Object.freeze([
  Object.freeze({ rung: 0, name: 'normal', sizeMultiplier: 1 }),
  Object.freeze({ rung: 1, name: 'half_size', sizeMultiplier: 0.5 }),
  Object.freeze({ rung: 2, name: 'quarter_size', sizeMultiplier: 0.25 }),
  Object.freeze({ rung: 3, name: 'no_new_entries', sizeMultiplier: 0 }),
  Object.freeze({ rung: 4, name: 'flatten_and_halt', sizeMultiplier: 0 }),
]);

export const DEFAULT_RISK_CONFIG = Object.freeze({
  riskPerTradePct: 0.005,
  maxOpenRiskPct: 0.03,
  maxPositionPct: 0.20,
  maxGrossExposurePct: 1.0,
  maxClusterPct: 0.40,
  clusterCorrelation: 0.70,
  volTargetAnnual: 0.18,
  assumedVolAnnual: 1.0,
  ladderHalfPct: 0.05,
  ladderQuarterPct: 0.10,
  ladderNoEntryPct: 0.15,
  ladderHaltPct: 0.20,
  ladderRecoveryPct: 0.01,
  dailyLossPct: 0.02,
  weeklyLossPct: 0.04,
  btcDrop24hPct: 0.08,
  btcDrop7dPct: 0.15,
  marketRecoveryPct: 0.01,
  marketCooldownHours: 24,
  minHealthyVenues: 2,
  minNotional: 25,
  minStopDistancePct: 0.005,
  maxStopDistancePct: 0.25,
  defaultFeePct: 0.001,
  defaultSlipPct: 0.0025,
  stopGapSlipPct: 0.001,
});

/**
 * Allowed range per setting, both ends enforced. For most keys `max` is the loose
 * end. For the cost, recovery, cooldown, assumed-vol and minimum-size settings a
 * smaller number is the riskier one, so `min` is what protects the account.
 */
export const HARD_CEILINGS = Object.freeze({
  riskPerTradePct: Object.freeze({ min: 0.0005, max: 0.01 }),
  maxOpenRiskPct: Object.freeze({ min: 0.005, max: 0.05 }),
  maxPositionPct: Object.freeze({ min: 0.01, max: 0.25 }),
  maxGrossExposurePct: Object.freeze({ min: 0.10, max: 1.0 }),
  maxClusterPct: Object.freeze({ min: 0.05, max: 0.50 }),
  clusterCorrelation: Object.freeze({ min: 0.50, max: 0.90 }),
  volTargetAnnual: Object.freeze({ min: 0.05, max: 0.20 }),
  assumedVolAnnual: Object.freeze({ min: 0.80, max: 3.0 }),
  ladderHalfPct: Object.freeze({ min: 0.01, max: 0.075 }),
  ladderQuarterPct: Object.freeze({ min: 0.02, max: 0.125 }),
  ladderNoEntryPct: Object.freeze({ min: 0.03, max: 0.175 }),
  ladderHaltPct: Object.freeze({ min: 0.04, max: 0.20 }),
  ladderRecoveryPct: Object.freeze({ min: 0.005, max: 0.03 }),
  dailyLossPct: Object.freeze({ min: 0.005, max: 0.03 }),
  weeklyLossPct: Object.freeze({ min: 0.01, max: 0.06 }),
  btcDrop24hPct: Object.freeze({ min: 0.03, max: 0.10 }),
  btcDrop7dPct: Object.freeze({ min: 0.05, max: 0.20 }),
  marketRecoveryPct: Object.freeze({ min: 0.005, max: 0.02 }),
  marketCooldownHours: Object.freeze({ min: 6, max: 72 }),
  minHealthyVenues: Object.freeze({ min: 2, max: 5 }),
  minNotional: Object.freeze({ min: 10, max: 1000 }),
  minStopDistancePct: Object.freeze({ min: 0.002, max: 0.02 }),
  maxStopDistancePct: Object.freeze({ min: 0.05, max: 0.30 }),
  defaultFeePct: Object.freeze({ min: 0.001, max: 0.01 }),
  defaultSlipPct: Object.freeze({ min: 0.0025, max: 0.02 }),
  stopGapSlipPct: Object.freeze({ min: 0.001, max: 0.02 }),
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositive = (v) => Number.isFinite(v) && v > 0;
// 8.64e15 is the largest time a Date can hold; past it the period keys would throw.
const isClock = (v) => Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const isBaseline = (v) => v === null || isPositive(v);

/**
 * The only route from GUI settings to engine settings. Every entry point runs its
 * config through this, so a raw over-limit object cannot bypass it. Unknown keys are
 * dropped, unusable values fall back to the default, and numbers are clamped.
 */
export function clampRiskConfig(cfg) {
  const src = isObject(cfg) ? cfg : {};
  const out = {};
  for (const [key, { min, max }] of Object.entries(HARD_CEILINGS)) {
    const raw = Object.hasOwn(src, key) ? src[key] : undefined;
    const value = Number.isFinite(raw) ? raw : DEFAULT_RISK_CONFIG[key];
    out[key] = Math.min(max, Math.max(min, value));
  }
  out.minHealthyVenues = Math.ceil(out.minHealthyVenues);

  // Keep the ladder in order by tightening downward from the halt. The per-key
  // minimums sit one gap apart, so this cannot push a rung below its own minimum.
  out.ladderNoEntryPct = Math.min(out.ladderNoEntryPct, out.ladderHaltPct - LADDER_MIN_GAP);
  out.ladderQuarterPct = Math.min(out.ladderQuarterPct, out.ladderNoEntryPct - LADDER_MIN_GAP);
  out.ladderHalfPct = Math.min(out.ladderHalfPct, out.ladderQuarterPct - LADDER_MIN_GAP);
  // A release level at or below zero could never be reached, even at a new high.
  out.ladderRecoveryPct = Math.min(out.ladderRecoveryPct, out.ladderHalfPct / 2);
  out.dailyLossPct = Math.min(out.dailyLossPct, out.weeklyLossPct);
  return out;
}

/** UTC day key, e.g. '2026-11-05'. */
export function utcDayKey(t) {
  return new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** UTC week key: the date of that week's Monday. */
export function utcWeekKey(t) {
  const day = Math.floor(t / DAY_MS);
  // Day 0 (1970-01-01) was a Thursday, three days after a Monday.
  const monday = day - ((((day + 3) % 7) + 7) % 7);
  return new Date(monday * DAY_MS).toISOString().slice(0, 10);
}

const noReview = () => ({ needed: false, reason: null, since: null });

function baseState(t, equity) {
  return {
    version: SCHEMA_VERSION,
    t,
    equity,
    equityHigh: equity,
    drawdown: 0,
    rung: 0,
    day: { key: t === null ? null : utcDayKey(t), startEquity: equity, tripped: false },
    week: { key: t === null ? null : utcWeekKey(t), startEquity: equity, tripped: false },
    // Unknown until the first update has looked: entries stay shut until then.
    market: { ok: false, tripped: false, reason: 'not_evaluated', change24h: null, change7d: null, lastBreachT: null },
    data: { ok: false, reason: 'not_evaluated' },
    fault: null,
    halt: { active: false, source: null, reason: null, at: null, by: null, flatten: false },
    review: noReview(),
    lastReEnable: null,
  };
}

/** Halted without a flatten: we cannot read the account, so we must not guess at it. */
function failSafeState(t, reason) {
  const s = baseState(isClock(t) ? t : null, null);
  s.halt = { active: true, source: 'fail_safe', reason, at: s.t, by: null, flatten: false };
  return s;
}

/** Plain JSON. Store it as is. Call once, when no stored state exists at all. */
export function initialRiskState(equity, t) {
  if (!isPositive(equity) || !isClock(t)) return failSafeState(t, 'invalid_initial_state');
  return baseState(t, equity);
}

function isValidRiskState(s) {
  return isObject(s)
    && s.version === SCHEMA_VERSION
    && Number.isInteger(s.rung) && s.rung >= 0 && s.rung < LADDER_RUNGS.length
    && (s.t === null || isClock(s.t))
    && isBaseline(s.equity) && isBaseline(s.equityHigh)
    && isObject(s.day) && typeof s.day.tripped === 'boolean' && isBaseline(s.day.startEquity)
    && isObject(s.week) && typeof s.week.tripped === 'boolean' && isBaseline(s.week.startEquity)
    && isObject(s.market) && typeof s.market.tripped === 'boolean' && typeof s.market.ok === 'boolean'
    && isObject(s.data) && typeof s.data.ok === 'boolean'
    && isObject(s.halt) && typeof s.halt.active === 'boolean' && typeof s.halt.flatten === 'boolean'
    // Absent on states stored before this field existed; those must not read as corrupt.
    && (s.review === undefined || (isObject(s.review) && typeof s.review.needed === 'boolean'))
    && (s.outage === undefined || s.outage === null || isObject(s.outage));
}

function assessData(health, cfg) {
  if (Array.isArray(health)) {
    const healthy = health.filter((v) => v?.ok === true).length;
    return healthy >= cfg.minHealthyVenues
      ? { ok: true, reason: null }
      : { ok: false, reason: `healthy_venues_${healthy}_of_${cfg.minHealthyVenues}` };
  }
  if (health?.ok === true) return { ok: true, reason: null };
  return { ok: false, reason: typeof health?.reason === 'string' ? health.reason : 'data_health_unknown' };
}

const isBar = (b) => isObject(b) && isClock(b.t) && isPositive(b.c);

/** Close-to-close changes over 24h and 7d. Each is null when it cannot be trusted. */
function btcChanges(bars, t) {
  const unknown = { change24h: null, change7d: null };
  if (!Array.isArray(bars) || bars.length < 2) return unknown;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!isBar(last) || !isBar(prev)) return unknown;
  const timeframe = last.t - prev.t;
  if (timeframe <= 0 || last.t > t) return unknown;
  // Stale bars must not read as a calm market.
  if (t - (last.t + timeframe) > timeframe + BTC_BAR_GRACE_MS) return unknown;

  const changeOver = (ms) => {
    const target = last.t - ms;
    for (let i = bars.length - 2; i >= 0; i--) {
      const bar = bars[i];
      if (!isBar(bar)) return null;
      if (bar.t <= target) {
        // A hole in the data would quietly stretch the window.
        return bar.t < target - timeframe ? null : (last.c - bar.c) / bar.c;
      }
    }
    return null;
  };
  return { change24h: changeOver(DAY_MS), change7d: changeOver(7 * DAY_MS) };
}

function updateMarket(s, { t, btcBars, cfg, emit }) {
  const { change24h, change7d } = btcChanges(btcBars, t);
  const known = change24h !== null && change7d !== null;
  const m = s.market;
  const wasOk = m.ok;
  const hit24 = change24h !== null && -change24h >= cfg.btcDrop24hPct - EPS;
  const hit7 = change7d !== null && -change7d >= cfg.btcDrop7dPct - EPS;
  m.change24h = change24h;
  m.change7d = change7d;
  m.ok = known;

  if (hit24 || hit7) {
    m.lastBreachT = t;
    if (!m.tripped) {
      m.tripped = true;
      emit('market_breaker_tripped', 'warning',
        `BTC fell past the breaker (${hit24 ? '24h' : '7d'}). No new entries, trails tightened.`, { change24h, change7d });
    }
    m.reason = hit24 ? 'btc_drop_24h' : 'btc_drop_7d';
  } else if (m.tripped && known) {
    const recovered = -change24h <= cfg.btcDrop24hPct - cfg.marketRecoveryPct + EPS
      && -change7d <= cfg.btcDrop7dPct - cfg.marketRecoveryPct + EPS;
    const cooled = t - m.lastBreachT >= cfg.marketCooldownHours * HOUR_MS;
    if (recovered && cooled) {
      m.tripped = false;
      m.reason = null;
      emit('market_breaker_cleared', 'info', 'BTC recovered and the cooldown has passed.', { change24h, change7d });
    }
  } else if (!m.tripped) {
    m.reason = known ? null : 'btc_data_unavailable';
  }
  if (wasOk && !known) {
    emit('market_data_unavailable', 'warning', 'BTC history is missing or stale. No new entries until it returns.', {});
  }
}

function rollPeriod(period, key, baseline, label, emit) {
  if (period.key === key) return;
  if (period.tripped) emit(`${label}_limit_cleared`, 'info', `New UTC ${label}: the ${label} loss limit has reset.`, { key });
  period.key = key;
  period.startEquity = baseline;
  period.tripped = false;
}

function checkPeriod(period, equity, limit, label, emit) {
  const loss = (period.startEquity - equity) / period.startEquity;
  if (!period.tripped && loss >= limit - EPS) {
    period.tripped = true;
    emit(`${label}_limit_tripped`, 'warning',
      `Lost ${(loss * 100).toFixed(2)}% this ${label}. No new entries until the UTC ${label} rolls.`, { loss, limit });
  }
}

/**
 * Worsening is immediate. Improving needs the drawdown to clear the rung's threshold
 * by ladderRecoveryPct, so equity sitting on a threshold cannot flip the size every
 * tick. The halt rung never improves here: only humanReEnable leaves it.
 */
function nextRung(prev, drawdown, cfg) {
  if (prev === 4) return 4;
  const thresholds = [cfg.ladderHalfPct, cfg.ladderQuarterPct, cfg.ladderNoEntryPct, cfg.ladderHaltPct];
  const reached = thresholds.filter((x) => drawdown >= x - EPS).length;
  const held = thresholds.filter((x) => drawdown > x - cfg.ladderRecoveryPct + EPS).length;
  return Math.max(reached, Math.min(prev, held));
}

/**
 * A lone print during bad data must not set a false high, which would hold the ladder
 * down for good. Nor may a real rally during the outage be forgotten. So the outage
 * keeps the highest level equity held on two readings running, and only that counts
 * when data returns. Equity alone cannot tell a single true print from a bad one, so a
 * lone peak is dropped and reported.
 */
function trackHigh(s, equity, emit) {
  if (s.equityHigh === null) { s.equityHigh = equity; return; }
  const o = s.outage ?? null;
  if (!s.data.ok) {
    const held = o ? Math.min(o.last, equity) : null;
    s.outage = { last: equity, held: Math.max(o?.held ?? 0, held ?? 0), peak: Math.max(o?.peak ?? 0, equity) };
    return;
  }
  s.outage = null;
  if (o && o.held > s.equityHigh && o.held > equity) {
    emit('equity_high_recovered', 'warning', `Equity high ${o.held} held through the data outage; it now counts.`, { high: o.held });
  }
  const high = Math.max(s.equityHigh, equity, o?.held ?? 0);
  if (o && o.peak > high) {
    emit('equity_high_unconfirmed', 'warning', `Equity touched ${o.peak} once during the data outage. Not counted as a high.`, { peak: o.peak });
  }
  s.equityHigh = high;
}

/**
 * Part of the book has no known value, so a fall in equity may be nothing but that gap.
 * No equity reading counts until it clears: the ladder, the high and the day and week
 * baselines all stay at their last trusted values, and entries are held.
 */
function setEquityFrozen(s, frozen, emit) {
  if (Boolean(s.equityFrozen) === frozen) return;
  s.equityFrozen = frozen;
  if (frozen) emit('equity_frozen', 'critical', 'Part of the book has no known value. The ladder is frozen, entries are held.', {});
  else emit('equity_unfrozen', 'info', 'The whole book has a value again. The ladder is live.', {});
}

function updateEquity(s, { t, equity, cfg, emit }) {
  // The last equity seen, not the first of the new period: a loss across the boundary
  // or during downtime must not vanish from the books by being taken as the baseline.
  const baseline = isPositive(s.equity) ? s.equity : equity;
  rollPeriod(s.day, utcDayKey(t), baseline, 'day', emit);
  rollPeriod(s.week, utcWeekKey(t), baseline, 'week', emit);
  s.day.startEquity ??= baseline;
  s.week.startEquity ??= baseline;

  trackHigh(s, equity, emit);
  s.equity = equity;
  s.drawdown = Math.max(0, (s.equityHigh - equity) / s.equityHigh);

  const rung = nextRung(s.rung, s.drawdown, cfg);
  if (rung !== s.rung) {
    emit('ladder_changed', rung > s.rung ? 'warning' : 'info',
      `Drawdown ${(s.drawdown * 100).toFixed(2)}%: ladder now ${LADDER_RUNGS[rung].name}.`,
      { from: s.rung, to: rung, drawdown: s.drawdown });
    s.rung = rung;
  }
  if (s.rung === 4 && !(s.halt.active && s.halt.flatten)) {
    s.halt = { active: true, source: 'drawdown', reason: 'drawdown_halt', at: t, by: null, flatten: true };
    emit('drawdown_halt', 'critical',
      `Drawdown ${(s.drawdown * 100).toFixed(2)}%: flatten everything and halt until a human re-enables.`, { drawdown: s.drawdown });
  }

  checkPeriod(s.day, equity, cfg.dailyLossPct, 'day', emit);
  checkPeriod(s.week, equity, cfg.weeklyLossPct, 'week', emit);
}

function raiseReview(s, reason, t, emit) {
  s.review = { needed: true, reason, since: t };
  emit('review_needed', 'warning', REVIEW_MESSAGES[reason], { reason, rung: s.rung });
}

/**
 * The flag is a report, not a block, and it clears no rung. It stays up for as long as
 * the book is flat on a rung; it goes only when a position opens or the rung is gone.
 */
function updateReview(s, openPositions, t, emit) {
  s.review ??= noReview();
  if (s.review.needed) {
    // A blocked-rung flag left behind on a lower rung would otherwise stop a real
    // below-minimum rejection from being recorded.
    const outgrown = s.review.reason === 'flat_entries_blocked' && s.rung < 3;
    if (s.rung === 0 || outgrown || (Number.isInteger(openPositions) && openPositions > 0)) {
      s.review = noReview();
      emit('review_cleared', 'info', 'No longer stuck: the book is trading or the ladder is back to normal.', {});
    }
  } else if (openPositions === 0 && s.rung >= 3) {
    raiseReview(s, 'flat_entries_blocked', t, emit);
  }
}

function setFault(s, fault, emit) {
  if (fault === s.fault) return;
  if (fault) emit('input_fault', 'warning', `Risk inputs unusable (${fault}). No new entries.`, { fault });
  else emit('input_fault_cleared', 'info', 'Risk inputs are usable again.', { was: s.fault });
  s.fault = fault;
}

function update(prev, input) {
  const { t, equity, btcBars, dataHealth, config, openPositions, equityUnknown } = isObject(input) ? input : {};
  const events = [];

  if (!isValidRiskState(prev)) {
    // Never rebuild a clean state here: that would silently lift a halt we can no
    // longer read. A human looks at it instead.
    const riskState = failSafeState(t, 'risk_state_corrupt');
    events.push({ type: 'risk_state_corrupt', t: riskState.t, severity: 'critical',
      message: 'Stored risk state is unreadable. Halted until a human re-enables.', data: {} });
    return { riskState, events };
  }

  const s = JSON.parse(JSON.stringify(prev));
  const validClock = isClock(t) && (s.t === null || t >= s.t);
  const emit = (type, severity, message, data) =>
    events.push({ type, t: validClock ? t : s.t, severity, message, data });

  if (!validClock) {
    setFault(s, isClock(t) ? 'clock_regression' : 'invalid_clock', emit);
    return { riskState: s, events };
  }
  s.t = t;

  // A missing config still evaluates limits (at defaults), so a halt is not missed.
  const cfg = clampRiskConfig(config);
  const wasDataOk = s.data.ok;
  s.data = assessData(dataHealth, cfg);
  if (wasDataOk !== s.data.ok) {
    if (s.data.ok) emit('data_gate_opened', 'info', 'Data is healthy again.', {});
    else emit('data_gate_closed', 'warning', `Data unhealthy (${s.data.reason}). No new entries; exits continue.`, {});
  }
  updateMarket(s, { t, btcBars, cfg, emit });
  setEquityFrozen(s, equityUnknown === true, emit);
  if (isPositive(equity) && !s.equityFrozen) updateEquity(s, { t, equity, cfg, emit });
  updateReview(s, openPositions, t, emit);

  let fault = null;
  if (!isPositive(equity)) fault = 'invalid_equity';
  else if (!isObject(config)) fault = 'invalid_config';
  setFault(s, fault, emit);
  return { riskState: s, events };
}

/**
 * Advance the risk state by one tick. Returns a new state; the input is not changed.
 * dataHealth is { ok, reason } or hub.health()'s venue array. btcBars should be 1h or
 * 4h: a daily series only sees a crash once the day has closed. openPositions is the
 * count of open positions; left out, it counts as unknown, and nothing is read as flat.
 */
export function updateRiskState(riskState, input) {
  try {
    return update(riskState, input);
  } catch {
    const safe = failSafeState(input?.t, 'risk_update_failed');
    return { riskState: safe, events: [{ type: 'risk_state_corrupt', t: safe.t, severity: 'critical',
      message: 'Risk update failed. Halted until a human re-enables.', data: {} }] };
  }
}

/** ENTRIES only. Exits never consult this. `reasons` lists every block in force. */
export function canEnter(riskState) {
  if (!isValidRiskState(riskState)) return { ok: false, reason: 'risk_state_invalid', reasons: ['risk_state_invalid'] };
  const s = riskState;
  const reasons = [];
  if (s.halt.active || s.rung === 4) reasons.push('halted');
  if (s.fault) reasons.push('input_fault');
  if (s.equityFrozen) reasons.push('equity_unknown');
  if (s.rung === 3) reasons.push('drawdown_no_entries');
  if (s.day.tripped) reasons.push('daily_loss_limit');
  if (s.week.tripped) reasons.push('weekly_loss_limit');
  if (s.market.tripped) reasons.push('market_breaker');
  if (!s.market.ok) reasons.push('market_data_unknown');
  if (!s.data.ok) reasons.push('data_unhealthy');
  return { ok: reasons.length === 0, reason: reasons[0] ?? 'ok', reasons };
}

/**
 * What the engine should do beyond entries. These can only add exits. There is
 * deliberately no field that holds an exit back.
 */
export function riskDirectives(riskState) {
  if (!isValidRiskState(riskState)) {
    return { entriesAllowed: false, sizeMultiplier: 0, flatten: false, tightenTrails: true, needsReview: true };
  }
  return {
    entriesAllowed: canEnter(riskState).ok,
    sizeMultiplier: LADDER_RUNGS[riskState.rung].sizeMultiplier,
    flatten: riskState.halt.active && riskState.halt.flatten,
    tightenTrails: riskState.market.tripped,
    needsReview: riskState.review?.needed === true,
  };
}

/**
 * Human pressed halt. Bad arguments still halt: a stop request must not be lost over
 * a missing field. flatten: true also closes everything.
 */
export function manualHalt(riskState, { t, reason, by, flatten = false } = {}) {
  const at = isClock(t) ? t : null;
  const s = isValidRiskState(riskState)
    ? JSON.parse(JSON.stringify(riskState))
    : failSafeState(t, 'risk_state_corrupt');
  s.halt = {
    active: true,
    source: s.halt.source ?? 'manual',
    reason: s.halt.reason ?? (typeof reason === 'string' && reason ? reason : 'manual_halt'),
    at: s.halt.at ?? at,
    by: s.halt.by ?? (typeof by === 'string' ? by : null),
    flatten: s.halt.flatten || flatten === true,
  };
  return { riskState: s, events: [{ type: 'manual_halt', t: at, severity: 'critical',
    message: `Halted by hand${s.halt.flatten ? ', flattening' : ''}. Only a human re-enable clears this.`, data: { by: s.halt.by } }] };
}

/**
 * Call after sizeEntry refuses an entry. sizeEntry is pure, so this is how a dust
 * rejection reaches the state. On a flat book every cap has full room, so
 * below_min_notional means the reduced size itself is too small: no position can open,
 * equity cannot move, and the rung cannot recover. Blocks nothing and changes no limit.
 * With positions open the same rejection is just a full book, and is ignored.
 */
export function noteEntryRejection(riskState, sized, { t, openPositions } = {}) {
  if (!isValidRiskState(riskState) || sized?.reason !== 'below_min_notional' || openPositions !== 0
    || riskState.rung === 0 || riskState.review?.needed === true) return { riskState, events: [] };
  const s = JSON.parse(JSON.stringify(riskState));
  const at = isClock(t) ? t : s.t;
  const events = [];
  raiseReview(s, 'flat_entries_too_small', at, (type, severity, message, data) =>
    events.push({ type, t: at, severity, message, data }));
  return { riskState: s, events };
}

/**
 * What humanReEnable would do, without doing it. The GUI reads willRebase from here.
 * Rungs 1 and 2 clear only on the deadlock itself: an explicit openPositions of 0 AND
 * the below-minimum review flag. Being flat alone must not shed a size cut.
 */
export function reEnablePreview(riskState, { openPositions } = {}) {
  if (!isValidRiskState(riskState)) return { allowed: true, reason: 'ok', willRebase: true };
  const { rung, halt, equityHigh } = riskState;
  const deadlocked = rung >= 1 && openPositions === 0
    && riskState.review?.needed === true && riskState.review.reason === 'flat_entries_too_small';
  if (!halt.active && rung < 3 && !deadlocked) return { allowed: false, reason: 'nothing_to_clear', willRebase: false };
  return { allowed: true, reason: 'ok', willRebase: rung >= 3 || equityHigh === null || deadlocked };
}

/**
 * The ONLY way out of a halt, and the way out of a rung that cannot recover by itself:
 * rungs 3 and 4 at any time, and rungs 1 and 2 only in the deadlock, where the book is
 * flat and entries at the reduced size are below the minimum order (see
 * noteEntryRejection). With no positions equity cannot move, so neither would ever clear.
 *
 * The equity high is rebased to current equity in exactly those cases. On the top rungs
 * the old high would otherwise re-trip on the very next tick. So each re-enable is a
 * fresh allowance, which is why it needs a named human. Anywhere else on rungs 1 and 2
 * the high is kept, so neither a pause nor being flat can shed the size reduction.
 * Daily, weekly, market and data blocks are left alone.
 *
 * Pass openPositions: the deadlock cannot be cleared without an explicit 0.
 * Returns { ok, reason, riskState, events }; on refusal riskState is unchanged.
 */
export function humanReEnable(riskState, { t, equity, by, confirm, openPositions } = {}) {
  const refuse = (reason) => ({ ok: false, reason, riskState, events: [] });
  if (confirm !== true) return refuse('not_confirmed');
  if (typeof by !== 'string' || by.trim() === '') return refuse('no_human_named');
  if (!isClock(t)) return refuse('invalid_clock');
  if (!isPositive(equity)) return refuse('invalid_equity');

  const valid = isValidRiskState(riskState);
  if (valid && riskState.t !== null && t < riskState.t) return refuse('clock_regression');
  const preview = reEnablePreview(riskState, { openPositions });
  if (!preview.allowed) return refuse(preview.reason);

  const s = valid ? JSON.parse(JSON.stringify(riskState)) : initialRiskState(equity, t);
  const previous = s.halt;
  const rebased = preview.willRebase;
  const fromRung = s.rung;
  if (rebased) {
    s.equityHigh = equity;
    s.outage = null;
    s.drawdown = 0;
    s.rung = 0;
  }
  s.equity = equity;
  s.day.startEquity ??= equity;
  s.week.startEquity ??= equity;
  s.t = t;
  s.halt = { active: false, source: null, reason: null, at: null, by: null, flatten: false };
  s.review = noReview();
  s.lastReEnable = { t, by, equity, rebased, fromRung, previousSource: previous.source };
  return { ok: true, reason: 'ok', riskState: s, events: [{ type: 'human_re_enable', t, severity: 'warning',
    message: `Re-enabled by ${by}.${rebased ? ' Equity high rebased to current equity.' : ''}`, data: { by, equity, rebased } }] };
}

const toEntries = (m) => {
  if (m instanceof Map) return [...m.values()];
  return Array.isArray(m) ? m : null;
};

const lookup = (m, key) => {
  if (m instanceof Map) return m.get(key);
  return isObject(m) && Object.hasOwn(m, key) ? m[key] : undefined;
};

/** Correlation size between two symbols. Unknown counts as fully correlated. */
function correlationOf(correlations, a, b) {
  if (a === b) return 1;
  const rho = lookup(lookup(correlations, a), b) ?? lookup(lookup(correlations, b), a);
  return Number.isFinite(rho) ? Math.min(1, Math.abs(rho)) : 1;
}

/** Null if any position cannot be read: risk we cannot measure blocks new risk. */
function readBook(positions, prices, candidateVol, volatility, cfg) {
  const book = [];
  for (const p of positions) {
    if (!isObject(p) || typeof p.symbol !== 'string'
      || !isPositive(p.qty) || !isPositive(p.stopPrice) || !isPositive(p.entryPrice)) return null;
    const quoted = lookup(prices, p.symbol);
    // With no live price, take the highest price known, which overstates exposure.
    const mark = isPositive(quoted) ? quoted : Math.max(p.entryPrice, isPositive(p.highWater) ? p.highWater : 0);
    const held = typeof volatility === 'number' ? undefined : lookup(volatility, p.symbol);
    book.push({
      symbol: p.symbol,
      mark,
      value: p.qty * mark,
      qty: p.qty,
      stopPrice: p.stopPrice,
      vol: isPositive(held) ? held : Math.max(cfg.assumedVolAnnual, candidateVol),
    });
  }
  return book;
}

/** Largest weight for the candidate that keeps portfolio vol within target. */
function volTargetWeight(book, equity, symbol, vol, correlations, target) {
  const weighted = book.map((b) => ({ ...b, risk: (b.value / equity) * b.vol }));
  let variance = 0;
  let cross = 0;
  for (const a of weighted) {
    cross += a.risk * correlationOf(correlations, a.symbol, symbol);
    for (const b of weighted) variance += a.risk * b.risk * correlationOf(correlations, a.symbol, b.symbol);
  }
  if (variance >= target ** 2) return 0;
  // Larger root of (w*vol)^2 + 2*(w*vol)*cross + variance = target^2.
  return (-cross + Math.sqrt(cross ** 2 + target ** 2 - variance)) / vol;
}

const rejection = (reason, limit = reason, extra = {}) =>
  ({ qty: 0, notional: 0, riskAmount: 0, rejected: true, reason, limit, ...extra });

function size(args) {
  if (!isObject(args)) return rejection('invalid_input');
  const { signal, price, equity, positions, riskState, config, volatility, correlations, sizeMultiplier,
    costs, prices, cash } = args;

  const gate = canEnter(riskState);
  if (!gate.ok) return rejection(gate.reason, 'can_enter');
  if (!isObject(config)) return rejection('invalid_config');
  const cfg = clampRiskConfig(config);

  if (!isObject(signal) || typeof signal.symbol !== 'string' || signal.symbol === '') return rejection('invalid_signal');
  if (signal.side === 'short') return rejection('short_not_supported');
  if (signal.side !== 'long') return rejection('not_an_entry');
  if (!isPositive(price)) return rejection('invalid_price');
  if (!isPositive(equity)) return rejection('invalid_equity');
  if (!isPositive(sizeMultiplier)) return rejection('invalid_size_multiplier');
  if (cash !== undefined && !(Number.isFinite(cash) && cash >= 0)) return rejection('invalid_cash');

  const stop = signal.stopDistancePct;
  if (!isPositive(stop)) return rejection('no_stop');
  if (stop < cfg.minStopDistancePct - EPS) return rejection('stop_too_tight');
  if (stop > cfg.maxStopDistancePct + EPS) return rejection('stop_too_wide');

  const vol = typeof volatility === 'number' ? volatility : lookup(volatility, signal.symbol);
  if (!isPositive(vol)) return rejection('volatility_unknown');
  if (vol < MIN_PLAUSIBLE_ANNUAL_VOL) return rejection('volatility_implausible');
  if (!isObject(correlations) && !(correlations instanceof Map)) return rejection('correlations_unknown');

  // Without a tier the caller gets Tier 3 costs: the worst case, so smaller sizes.
  const feePct = costs === undefined ? cfg.defaultFeePct : costs?.feePct;
  const slipPct = costs === undefined ? cfg.defaultSlipPct : costs?.slipPct;
  if (!isPositive(feePct) || !isPositive(slipPct)) return rejection('invalid_costs');

  const held = toEntries(positions);
  if (held === null) return rejection('invalid_positions');
  const book = readBook(held, prices, vol, volatility, cfg);
  if (book === null) return rejection('invalid_positions');

  // Loss per unit of notional if the stop is hit: the distance, fees both ways,
  // slippage both ways, and the extra slip a stop fill takes.
  const lossPerNotional = stop + 2 * feePct + 2 * slipPct + cfg.stopGapSlipPct;
  // What one unit of notional costs to buy, so a cap holds at the filled price.
  const fillFactor = 1 + feePct + slipPct;
  const exitCostPct = feePct + slipPct + cfg.stopGapSlipPct;

  const sumOf = (fn) => book.reduce((total, b) => total + fn(b), 0);
  const gross = sumOf((b) => b.value);
  const openRisk = sumOf((b) => b.qty * (Math.abs(b.mark - b.stopPrice) + b.mark * exitCostPct));
  const sameSymbol = sumOf((b) => (b.symbol === signal.symbol ? b.value : 0));
  const cluster = sumOf((b) =>
    (correlationOf(correlations, b.symbol, signal.symbol) >= cfg.clusterCorrelation - EPS ? b.value : 0));

  // Each step can only shrink the size. Order: docs/rebuild/risk-engine.md.
  let notional = (equity * cfg.riskPerTradePct) / lossPerNotional;
  let limit = 'risk_per_trade';
  const trace = [{ limit, notional }];
  const cap = (name, value) => {
    trace.push({ limit: name, notional: value });
    if (value < notional - EPS) {
      notional = Math.max(0, value);
      limit = name;
    }
  };

  cap('max_position', equity * cfg.maxPositionPct - sameSymbol);

  // After the per-position caps so "half size" really halves, even for a capped
  // position. Before the portfolio caps, because those are hard room, not a preference.
  const ladderMultiplier = LADDER_RUNGS[riskState.rung].sizeMultiplier;
  const strategyMultiplier = Math.min(1, sizeMultiplier);
  const multiplier = ladderMultiplier * strategyMultiplier;
  if (ladderMultiplier < 1 && strategyMultiplier < 1) cap('drawdown_ladder_and_half_risk', notional * multiplier);
  else if (ladderMultiplier < 1) cap('drawdown_ladder', notional * multiplier);
  else if (strategyMultiplier < 1) cap('half_risk', notional * multiplier);

  cap('vol_target', equity * volTargetWeight(book, equity, signal.symbol, vol, correlations, cfg.volTargetAnnual));
  cap('open_risk', (equity * cfg.maxOpenRiskPct - openRisk) / lossPerNotional);
  cap('gross_exposure', (equity * cfg.maxGrossExposurePct - gross) / fillFactor);
  cap('cluster', (equity * cfg.maxClusterPct - cluster) / fillFactor);
  if (cash !== undefined) cap('cash', cash / fillFactor);

  const detail = { multiplier, lossPerNotional, trace };
  if (notional < cfg.minNotional - EPS) return rejection('below_min_notional', limit, detail);
  return {
    qty: notional / price,
    notional,
    riskAmount: notional * lossPerNotional,
    rejected: false,
    reason: limit,
    limit,
    ...detail,
  };
}

/**
 * Size a new long entry. Returns { qty, notional, riskAmount, rejected, reason, limit }.
 * On success `reason` names the limit that decided the size. On rejection qty is 0 and
 * `reason` says why; for below_min_notional, `limit` names the cap that shrank it.
 *
 * Required: everything in the contract signature, sizeMultiplier included (1 = full
 * risk, 0.5 = paper(half)), so forgetting it blocks trades instead of doubling risk.
 * volatility: annual vol as a number for the candidate, or a Map/object by symbol.
 * correlations: Map or object of symbol -> symbol -> rho; a missing pair counts as 1.
 * Optional extras: costs { feePct, slipPct } (from v6Paper.costFor; defaults to Tier 3),
 * prices (Map/object of marks for held positions), cash (quote cash available).
 */
export function sizeEntry(args) {
  try {
    return size(args);
  } catch {
    return rejection('internal_error');
  }
}
