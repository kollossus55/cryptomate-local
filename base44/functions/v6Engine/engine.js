/**
 * V6 paper engine: the only stateful part of V6. PAPER ONLY, public market data only.
 *
 * One cycle: take the lease, finish any unfinished commit, load state, run v6Core.step
 * through the shared hub, fill intents through v6Paper in book mode, then commit.
 *
 * Commit is a single atomic write of the Portfolio row. That row holds the ledger,
 * v6_state, and an outbox of every Trade and V6* row the cycle produced, under fixed ids.
 * The store has no multi-file transaction, so the outbox is what makes a crash harmless:
 * before the commit nothing happened, and after it the next cycle finishes the rows.
 *
 * Nothing here can stop an exit. Halts, pauses, missing certificates and a legacy
 * conflict only remove strategies from the step. Positions are always evaluated.
 */

import * as paper from './shared/v6Paper.js';
import * as risk from './shared/v6Risk.js';
import * as realExits from './shared/v6Exits.js';
import {
  computeRegime, createIndicatorAccess, entryPositionFields, exitConfigFor, exitRemainderPatch, step,
} from './shared/v6Core.js';

export const TF_MS = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const FIVE_MIN_MS = 5 * 60_000;
export const DELIST_GRACE_MS = 3 * 86_400_000;
export const LEASE_MS = 10 * 60_000;
const REPLAY_VENUES = ['okx', 'bybit'];
export const DEFAULT_STARTING_CASH = 10_000;
// Tickers that resolve to different projects on different venues (CONTRACT section 6).
export const TICKER_COLLISIONS = new Set(['LITUSDT', 'BEAMUSDT']);

const BTC = 'BTCUSDT';
const BTC_RISK_KEY = 'BTCUSDT@1h';
// A closed bar can take a few minutes to appear on every venue.
const BAR_LAG_MS = 3 * 60_000;
const REGIME_BARS = 260;
const MAX_BARS = 300;
const CONCURRENCY = 4;
const ALARM_REPEAT_MS = 3_600_000;
const MIN_FILL_NOTIONAL = 1;
const CONSUMED_MEMORY = 100;
const SIGNAL_TEST_CAP = 50_000;
const DAY_MS = 86_400_000;
// CONTRACT section 6: exits use the last good price while venues disagree. This is how long.
// Past it the reported price is believed, because an exit must never wait without limit.
export const NO_CONSENSUS_MAX_MS = 15 * 60_000;
// Two 5-minute bars: the newest bar can lag, and that is not a hole in the data.
const GAP_SLACK_MS = 2 * FIVE_MIN_MS;
const REQUEUE_CAP = 500;
const UNREADABLE = 'ENTITY_UNREADABLE';
// The only rows a cycle ever produces. An outbox entry naming anything else is not ours.
const OUTBOX_ENTITIES = new Set(['Trade', 'V6StrategyState', 'V6SignalTest', 'V6RiskEvent', 'V6ExchangeHealth', 'V6EquityPoint']);
// What the engine last wrote to the account. Anything else on the row came from outside.
const ACCOUNT_FIELDS = ['available_balance', 'total_balance', 'positions_value', 'positions', 'total_trades', 'total_profit_loss', 'v6_ledger'];

const tfOfMs = (ms) => Object.keys(TF_MS).find((k) => TF_MS[k] === ms) ?? '1d';
const closedOpen = (now, tf) => Math.floor((now - BAR_LAG_MS) / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf];
const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-');
const lastOf = (a) => (a?.length ? a[a.length - 1] : null);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function defaultConfig(venues = []) {
  return {
    id: 'v6-config', version: 1, risk: risk.clampRiskConfig(risk.DEFAULT_RISK_CONFIG), venues, roles: {}, strategies: {},
    halt_request: null, reenable_request: null, close_requests: [], reinstate_requests: [], engine_lease: null,
  };
}

async function loadConfig(E) {
  const rows = await E.V6Config.list('-created_date', 5);
  return rows[0] ?? E.V6Config.create(defaultConfig());
}

// --- run lock ----------------------------------------------------------------

const RUNNING = Symbol.for('cryptomate.v6.engine.running');

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

// A lease the engine could have written. No real one runs past now + LEASE_MS, so a longer
// one cannot be allowed to stop exits, whichever live process it names.
const leaseValid = (lease, now) => Number.isFinite(lease?.until) && lease.until <= now + LEASE_MS
  && Number.isInteger(lease.pid) && lease.pid > 0;

async function acquireLease(E, cfg, now, isAlive) {
  const lease = cfg.engine_lease;
  const invalid = Boolean(lease) && !leaseValid(lease, now);
  if (lease && !invalid && lease.until > now && lease.pid !== process.pid && isAlive(lease.pid)) {
    return { ok: false, reason: `another engine holds the lease until ${new Date(lease.until).toISOString()}` };
  }
  await E.V6Config.update(cfg.id, { engine_lease: { pid: process.pid, at: now, until: now + LEASE_MS } });
  return { ok: true, invalid };
}

// --- outbox ------------------------------------------------------------------

const outboxOpAllowed = (op) => OUTBOX_ENTITIES.has(op?.entity) && typeof op.id === 'string' && op.id !== ''
  && op.data !== null && typeof op.data === 'object' && (op.entity !== 'Trade' || op.data.exchange === paper.EXCHANGE_LABEL);

/**
 * Writes each row once. Safe to repeat: rows have fixed ids, upserts are last-write-wins.
 * Never throws: one bad row must not stop the cycle, because exits run in that cycle.
 * @returns {{ failed: object[], rejected: number, error: string|null }} failed rows can be
 *   retried; rejected ones were not the engine's and are dropped.
 */
export async function drainOutbox(E, outbox) {
  const list = Array.isArray(outbox) ? outbox : [];
  const failed = [];
  let rejected = Array.isArray(outbox) || outbox === undefined || outbox === null ? 0 : 1;
  let error = null;
  const groups = new Map();
  for (const op of list) {
    if (!outboxOpAllowed(op)) { rejected++; continue; }
    if (!op.upsert) {
      if (!groups.has(op.entity)) groups.set(op.entity, []);
      groups.get(op.entity).push(op);
      continue;
    }
    try {
      const found = await E[op.entity].get(op.id);
      if (found) await E[op.entity].update(op.id, op.data);
      else await E[op.entity].create({ ...op.data, id: op.id });
    } catch (err) {
      failed.push(op);
      error = err.message;
    }
  }
  for (const [entity, ops] of groups) {
    try {
      const existing = await E[entity].filter({ id: { $in: ops.map((o) => o.id) } }, undefined, ops.length);
      const have = new Set(existing.map((r) => r.id));
      const fresh = ops.filter((o) => !have.has(o.id)).map((o) => ({ ...o.data, id: o.id }));
      if (fresh.length) await E[entity].bulkCreate(fresh);
    } catch (err) {
      failed.push(...ops);
      error = err.message;
    }
  }
  return { failed, rejected, error };
}

// Trades and lifecycle rows are the record, so they wait however long it takes.
// Telemetry for a damaged file is capped, or the account row would grow without limit.
function requeue(ops) {
  const record = (op) => op.entity === 'Trade' || op.entity === 'V6StrategyState';
  return [...ops.filter(record), ...ops.filter((op) => !record(op)).slice(-REQUEUE_CAP)];
}

// --- strategy loading --------------------------------------------------------

const CASH_TEXT = {
  gate_unavailable: 'The signal gate is not installed, so no strategy can run. Holding cash.',
  no_strategies: 'No strategy has a valid certificate. Holding cash.',
  no_certified: 'No strategy has a valid certificate. Holding cash.',
  all_disabled: 'Every certified strategy is switched off by the operator. Holding cash.',
  shadow_only: 'Every certified strategy is in shadow, so nothing is trading. Holding cash.',
  foreign_change: 'The paper account was changed outside V6. New entries are held until that is acknowledged.',
  multiple_portfolios: 'More than one Portfolio row exists. New entries are held until the extra row is removed.',
  store_unreadable: 'A data file cannot be read or written. New entries are held until it is repaired.',
  store_restored: 'A data file was restored from its good copy. New entries are held until that is acknowledged.',
  position_quarantined: 'A position row cannot be read. New entries are held until a person fixes it.',
};

const BLOCK_TEXT = {
  legacy_enabled: 'Legacy auto-trading was switched back on. New entries are blocked; exits continue.',
  multiple_portfolios: 'More than one Portfolio row exists. V6 stays on its own account; new entries are blocked and exits continue.',
  store_restored: 'A data file was restored from its latest good copy. New entries are blocked until that event is acknowledged; exits continue.',
};

/** Which strategies may run. A strategy without a valid certificate never appears here. */
export function selectStrategies({ registry, certificates, states, cfg, gateModule, t }) {
  const all = Array.isArray(registry) ? registry : Object.values(registry ?? {});
  const skipped = [];
  if (!gateModule) {
    return { active: [], skipped: all.map((s) => ({ strategy_id: s.id, why: 'gate_unavailable' })), cashCode: 'gate_unavailable' };
  }
  const active = [];
  let disabled = 0;
  for (const strategy of all) {
    const certificate = certificates.get(strategy.id);
    const verdict = gateModule.verifyCertificate(certificate, strategy, t);
    if (!verdict.ok) { skipped.push({ strategy_id: strategy.id, why: verdict.code }); continue; }
    if (cfg.strategies?.[strategy.id]?.operator_enabled === false) {
      disabled++;
      skipped.push({ strategy_id: strategy.id, why: 'operator_disabled' });
      continue;
    }
    active.push(strategy);
  }
  let cashCode = null;
  if (!active.length) cashCode = disabled ? 'all_disabled' : all.length ? 'no_certified' : 'no_strategies';
  else if (active.every((s) => states.get(s.id)?.lifecycle === 'shadow')) cashCode = 'shadow_only';
  return { active, skipped, cashCode };
}

// A gate that refuses everything. step always gets a gate, whatever else failed.
function refusingGate(reason) {
  const verdict = { ok: false, stage: 'pre', reason, blockedBy: 'no_gate', checks: [], sizeMultiplier: 0 };
  return { check: () => verdict, preSize: () => verdict, postSize: () => verdict, modeFor: () => 'shadow', advanceShadow: () => ({}) };
}

// --- market ------------------------------------------------------------------

/** 30-day median daily quote volume decides the cost tier. Unknown coins pay the worst tier. */
export function tierFromBars(symbol, dailyBars) {
  if (symbol === BTC || symbol === 'ETHUSDT') return 1;
  const qv = (dailyBars ?? []).slice(-30).map((b) => b.qv).filter(Number.isFinite).sort((a, b) => a - b);
  if (!qv.length) return 3;
  return qv[Math.floor(qv.length / 2)] >= 50e6 ? 2 : 3;
}

const CACHE = Symbol.for('cryptomate.v6.engine.bars');

function barReader(hub, now, cache) {
  // Refetched only when a newer bar has closed, so a 5-minute tick costs no bar requests.
  return async function barsFor(symbol, tf, limit) {
    const key = `${symbol}|${tf}`;
    const hit = cache.get(key);
    const want = closedOpen(now, tf);
    if (hit && hit.limit >= limit && lastOf(hit.bars)?.t === want) return hit.bars;
    try {
      const raw = await hub.bars(symbol, tf, limit);
      const bars = raw.filter((b) => b.t + TF_MS[tf] <= now);
      if (raw.meta) Object.defineProperty(bars, 'meta', { value: raw.meta, enumerable: false });
      cache.set(key, { bars, limit });
      return bars;
    } catch {
      return hit?.bars ?? [];
    }
  };
}

async function quote(hub, symbol) {
  try { return await hub.consensusPrice(symbol); } catch { return null; }
}

async function bookFor(hub, symbol, venue) {
  try { return await hub.book(symbol, 50, venue ? { venue } : {}); } catch { return null; }
}

// An exit never waits on the chosen venue: any venue's book beats a fallback fill.
const exitBook = async (hub, symbol, venue) => (await bookFor(hub, symbol, venue)) ?? (venue ? bookFor(hub, symbol) : null);

/** The price a close could trade at now, or null if this book could not fill it. */
function executablePrice(book, side, t) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  if (!(bid > 0 && ask > bid) || book.stale === true || t - book.t > paper.DEFAULT_MAX_BOOK_AGE_MS) return null;
  return side === 'short' ? ask : bid;
}

/** Replay venues, the operator's choice first. */
export function replayOrder(cfg) {
  const chosen = cfg.roles?.replay;
  return REPLAY_VENUES.includes(chosen) ? [chosen, ...REPLAY_VENUES.filter((v) => v !== chosen)] : REPLAY_VENUES;
}

/**
 * Hourly and daily bars for the part of the gap the 5-minute reader could not reach, so a
 * stop touched during a long outage is not forgotten. Bars older than the position cannot
 * touch it.
 *
 * Bars that touch nothing are dropped, so their old lows cannot reach the exit module.
 *
 * @returns {object[]|null} the bars that touched a stop, or null when there was no gap
 */
async function coarseGapBars(barsFor, position, from, now, fine) {
  const covered = fine?.length ? fine[0].t : now;
  if (covered - from <= GAP_SLACK_MS) return null;
  const touching = [];
  for (const tf of ['1h', '1d']) {
    const ms = TF_MS[tf];
    const bars = await barsFor(position.symbol, tf, Math.min(MAX_BARS, Math.ceil((covered - from) / ms) + 2));
    for (const b of bars) {
      if (b.t < position.entryTime || b.t + ms <= from || b.t >= covered) continue;
      if (stopTouchedBy(position, b) !== null) touching.push(b);
    }
  }
  return touching;
}

/**
 * The only test of a past price sample against a stop: the stop it meets is the one in force
 * when the sample began. A stop moved since, or a time nothing is known about, tests nothing.
 * @returns {number|null} the stop this sample touched
 */
function stopTouchedBy(position, sample) {
  const stop = realExits.stopAt(position, sample.t);
  if (stop === null) return null;
  return (position.side === 'short' ? sample.h >= stop : sample.l <= stop) ? stop : null;
}

/**
 * What the samples since the last tick did to the stop. Only samples that touched carry a
 * range forward, so a low that broke no stop of its time never reaches the exit module.
 * @returns {object|null} null when there were no samples; low and high are null with no touch
 */
export function wickSummary(position, fine, coarse = []) {
  const bars = [...coarse, ...(fine ?? [])].sort((a, b) => a.t - b.t);
  if (!bars.length) return null;
  const touching = bars.filter((b) => stopTouchedBy(position, b) !== null);
  const [first] = touching;
  if (!first) return { low: null, high: null, touchOpen: null, touchStop: null, coarseTouch: false };
  return {
    low: Math.min(...touching.map((b) => b.l)), high: Math.max(...touching.map((b) => b.h)),
    touchOpen: first.o, touchStop: stopTouchedBy(position, first), coarseTouch: coarse.includes(first),
  };
}

/**
 * Exits with the tick's real range. step builds a flat bar at the mark on a tick inside
 * a bar, which would miss a wick. Only the adverse side is widened: the favourable side
 * stays at the mark, because the simulator ratchets stops on closed bars only.
 *
 * Positions another pass owns report a stop kind so core's backstop leaves them alone.
 *
 * exitSignals carries the signals of strategies that may not enter this bar. They arrive
 * here rather than through step, so a signal that can close a position can never open one.
 */
export function rangedExits(exits, wicks, skip, exitSignals = new Map()) {
  return {
    ...exits,
    evaluateExit(args) {
      const { symbol, side } = args.position;
      if (skip.has(symbol)) return { action: 'hold', fillHint: { kind: 'stop' } };
      const signalled = { ...args, signal: args.signal ?? exitSignals.get(symbol) ?? null };
      const w = wicks.get(symbol);
      if (!w || w.low === null) return exits.evaluateExit(signalled);
      const bar = side === 'short'
        ? { ...args.bar, h: Math.max(args.bar.h, w.high) }
        : { ...args.bar, l: Math.min(args.bar.l, w.low) };
      // after: a stop moved earlier in this bar meets only what came later, which is this range.
      return exits.evaluateExit({ ...signalled, bar, after: { h: w.high, l: w.low } });
    },
  };
}

// --- the cycle ---------------------------------------------------------------

/**
 * The account V6 runs on. Once cut over it is the pinned row and nothing else: a row with a
 * newer date or a better balance can never take its place.
 */
async function resolveAccount(E, cfg) {
  const rows = await E.Portfolio.list('-created_date', 20);
  const owned = rows.filter((r) => r.v6_state);
  const row = cfg.portfolio_id ? await E.Portfolio.get(cfg.portfolio_id) : owned[0] ?? rows[0] ?? null;
  return { row, extras: rows.filter((r) => r.id !== row?.id).length, ambiguous: !cfg.portfolio_id && owned.length > 1 };
}

const accountRecord = (row) => Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, row[k] ?? null]));

const accountDiff = (row, record) => ACCOUNT_FIELDS.filter((k) => JSON.stringify(row[k] ?? null) !== JSON.stringify(record[k] ?? null));

// Lost state is never a fresh start. A strategy that was running returns to shadow, where
// only the operator can bring it back, and a strategy that was in shadow stays there.
const lostStrategyState = (initial, t) => ({
  ...initial, lifecycle: 'shadow', size_multiplier: 0, demoted_at: t, demotion_reason: 'strategy_state_lost',
});

function freshState() {
  return {
    version: 1, seq: 0, riskState: undefined, lastBarT: {}, lastTickT: null, regime: {}, noQuoteSince: {}, noConsensusSince: {}, bookCrossSince: {}, bookSafeSince: {}, wickFrom: {}, tiers: {},
    openTrades: {}, consumed: [], alarms: {}, cashCode: null, allTimeHigh: null, startedAt: null, startingEquity: null, outbox: [],
  };
}

async function refuseCutover(E, code, message, t, { type = 'cutover_refused', status = 'refused' } = {}) {
  const id = `v6e-${status === 'refused' ? 'cutover' : status}-${code}-${risk.utcDayKey(t)}`;
  try {
    if (!(await E.V6RiskEvent.get(id))) {
      await E.V6RiskEvent.create({
        id, t, type, severity: 'critical', code, message, data: {}, sticky: true, acked_at: null, cleared_at: null,
      });
    }
  } catch (err) {
    console.error(`[v6Engine] ${message} (the event could not be stored: ${err.message})`);
  }
  return { ok: true, status, code, reason: message, logLine: `${status === 'refused' ? 'refused to start' : 'stopped'}: ${message}` };
}

// Without a ledger there is nothing to run exits on, so this is the one case that stops.
const stopForHuman = (E, code, message, t) => refuseCutover(E, code, message, t, { type: 'engine_stopped', status: 'stopped' });

async function runOneCycle(deps, cfg, { leaseInvalid = false } = {}) {
  const { entities: E, hub, intrabar, registry = [], gateModule = null, history = null, hooks = {} } = deps;
  const now = deps.now();
  const exits = deps.exits ?? realExits;
  const events = [];
  const outbox = [];
  const raise = (e) => events.push({ severity: 'info', ...e });
  // Anything unreadable holds entries and is reported. Only the ledger itself stops a cycle.
  const faults = new Set(cfg.unreadable ? ['V6Config'] : []);
  const read = async (entity, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      if (err.code !== UNREADABLE) throw err;
      faults.add(entity);
      return fallback;
    }
  };
  if (leaseInvalid) raise({ type: 'alarm', severity: 'critical', code: 'lease_invalid', message: 'The engine lease held values the engine never writes, so it was ignored.' });

  // 1. Finish whatever a crash left between commit and outbox.
  let account;
  try {
    account = await resolveAccount(E, cfg);
  } catch (err) {
    if (err.code !== UNREADABLE) throw err;
    return stopForHuman(E, 'portfolio_unreadable', `${err.message} There is no good copy, so V6 has stopped and no exit can run until it is repaired.`, now);
  }
  let { row } = account;
  if (cfg.portfolio_id && !row) {
    return stopForHuman(E, 'portfolio_missing', 'The V6 account row is gone and there is no good copy. V6 has stopped and will not start over by itself.', now);
  }
  if (account.ambiguous) {
    return stopForHuman(E, 'multiple_portfolios', 'Two Portfolio rows both claim to be the V6 account and none is pinned. V6 has stopped rather than pick one.', now);
  }
  if (row?.v6_state?.outbox) {
    const drained = await drainOutbox(E, row.v6_state.outbox);
    outbox.push(...requeue(drained.failed));
    if (drained.failed.length) {
      faults.add('outbox');
      raise({ type: 'alarm', severity: 'critical', code: 'outbox_failed', message: `${drained.failed.length} record(s) could not be written and are being kept: ${drained.error}` });
    }
    if (drained.rejected) raise({ type: 'alarm', severity: 'critical', code: 'outbox_rejected', message: `${drained.rejected} outbox record(s) were not the engine's and were dropped.` });
  }

  // 2. Cutover. V6 starts only on a flat account with legacy off, and adopts nothing.
  // Every row, and anything truthy: legacy reads it that way, so a late-dated row or the text
  // "true" must not hide it. The text "false" also blocks, which is the safe way to be wrong.
  const settings = await read('AutoTradingSettings', () => E.AutoTradingSettings.list(), null);
  const legacyOn = (settings ?? []).some((s) => Boolean(s?.is_enabled));
  if (!row?.v6_state) {
    // Already cut over and the state is gone: starting again would wipe the halt, the high
    // and the history, so it takes the operator's deliberate recutover action.
    if (cfg.cutover_at && !cfg.recutover_request) {
      return stopForHuman(E, 'state_missing', 'The V6 account row has lost its engine state. V6 has stopped; the recutover action starts it again on a flat account.', now);
    }
    if (faults.size) return refuseCutover(E, 'store_unreadable', `Cannot start while these cannot be read: ${[...faults].join(', ')}.`, now);
    if (legacyOn) return refuseCutover(E, 'legacy_enabled', 'Legacy auto-trading is on. V6 will not share the account with it.', now);
    const damaged = row?.positions != null && !Array.isArray(row.positions);
    if (damaged || row?.positions?.some((p) => p?.quantity)) {
      return refuseCutover(E, 'not_flat', `The account holds ${damaged ? 'an unreadable list of' : row.positions.length} legacy position(s). V6 needs it flat and does not adopt them.`, now);
    }
    if (account.extras) return refuseCutover(E, 'multiple_portfolios', 'More than one Portfolio row exists. V6 needs exactly one account.', now);
  }

  const firstRun = !row?.v6_state;
  const state = firstRun ? freshState() : { ...freshState(), ...row.v6_state, outbox: [] };
  if (!row) {
    const seed = paper.createLedger({ cash: DEFAULT_STARTING_CASH, t: now });
    row = await E.Portfolio.create(paper.toPortfolioRecord(seed, new Map(), { now }));
  }
  // The engine's own record is the truth. The row is only compared with it, so an edit to
  // the row can neither change the ledger nor stop an exit, and the commit puts it back.
  const changed = state.record ? accountDiff(row, state.record) : [];
  const accountRow = state.record ? { ...row, ...state.record } : row;
  let ledger;
  try {
    ledger = paper.adoptLegacyPortfolio(accountRow);
  } catch (err) {
    if (firstRun) throw err;
    changed.push(`unusable account row: ${err.message}`);
    ledger = paper.adoptLegacyPortfolio({ ...accountRow, available_balance: 0 });
  }
  // Apart from every other warning, and on the first run too: such a row has no stop and
  // never exits, so it is the one position a person has to deal with.
  const quarantined = ledger.quarantined ?? [];
  state.quarantined = quarantined.map((r) => ({ symbol: r?.asset_symbol ?? null, raw: JSON.stringify(r) }));
  for (const q of state.quarantined) {
    raise({ type: 'alarm', severity: 'critical', code: 'position_quarantined', symbol: q.symbol ?? 'unknown', message: `A position row for ${q.symbol ?? 'an unknown coin'} cannot be read. It has no stop and cannot exit until a person fixes it.` });
  }
  // With a record, the comparison above is the whole answer: adoption read the engine's own
  // data, so its warnings say nothing about the outside.
  const foreign = firstRun ? [] : state.record ? changed : [...changed, ...(ledger.adoption?.warnings ?? [])];
  if (foreign.length) state.foreign = { since: state.foreign?.since ?? now, what: foreign };
  const consumed = new Set(state.consumed);
  const foreignAck = cfg.foreign_ack_request;
  if (foreignAck && !consumed.has(foreignAck.id)) {
    consumed.add(foreignAck.id);
    // An edit after the acknowledgement is a new edit, and it keeps the alarm up.
    if (!foreign.length) delete state.foreign;
  }
  const seq = state.seq + 1;
  const cycleId = `c${seq}`;
  const positionOf = (symbol) => ledger.positions.find((p) => p.symbol === symbol);

  // 3. Strategies. None is the expected state until a certificate exists.
  const certRows = await read('V6Certificate', () => E.V6Certificate.list('-issued_at', 200), []);
  const stateRows = await read('V6StrategyState', () => E.V6StrategyState.list('-created_date', 200), null);
  const certificates = new Map();
  for (const c of certRows) if (!certificates.has(c.strategy_id)) certificates.set(c.strategy_id, c);
  const states = new Map((stateRows ?? []).map((s) => [s.strategy_id, s]));
  const allStrategies = Array.isArray(registry) ? registry : Object.values(registry);
  if (gateModule) {
    for (const s of allStrategies) {
      const known = state.lifecycles?.[s.id];
      const current = states.get(s.id);
      const initial = gateModule.initialStrategyState({ strategy: s });
      if ((!current && known && known !== 'research') || (known === 'shadow' && current && current.lifecycle !== 'shadow')) {
        states.set(s.id, lostStrategyState(initial, now));
        raise({ type: 'alarm', severity: 'critical', code: 'strategy_state_lost', strategyId: s.id, message: `The saved state of ${s.id} is missing or does not match the account, so it is in shadow. Only the operator can bring it back.` });
      } else if (!current) states.set(s.id, initial);
    }
  }
  const selection = selectStrategies({ registry, certificates, states, cfg, gateModule, t: now });
  // Last, because reading a damaged file above is what records a restore.
  const restored = await read('V6RiskEvent', () => E.V6RiskEvent.filter({ type: 'store_restored' }, '-t', 50), []);
  const blockEntries = [];
  if (legacyOn) blockEntries.push('legacy_enabled');
  if (state.foreign) blockEntries.push('foreign_change');
  if (account.extras) blockEntries.push('multiple_portfolios');
  if (quarantined.length) blockEntries.push('position_quarantined');
  if (faults.size) blockEntries.push('store_unreadable');
  if (restored.some((e) => !e.acked_at)) blockEntries.push('store_restored');
  // The restore and the quarantine have their own events, and a second event for the
  // restore could be acknowledged while the one that holds entries stayed open.
  for (const code of blockEntries.filter((c) => c !== 'store_restored' && c !== 'position_quarantined')) {
    const message = code === 'foreign_change'
      ? `The paper account changed outside V6: ${state.foreign.what.join('; ')}. The engine's record was kept, so the edit is undone. New entries are blocked until this is acknowledged; exits continue.`
      : code === 'store_unreadable'
        ? `These cannot be read or written: ${[...faults].join(', ')}. New entries are blocked; exits continue.`
        : BLOCK_TEXT[code];
    raise({ type: 'alarm', severity: 'critical', code, message });
  }
  const active = blockEntries.length ? [] : selection.active;

  // 4. Prices. Held coins are read directly, never through a universe.
  const cache = (globalThis[CACHE] ??= new Map());
  const barsFor = barReader(hub, now, deps.barCache ?? cache);
  const held = [...ledger.positions];
  state.priceAt ??= {};
  state.wickFrom ??= {};
  state.bookCrossSince ??= {};
  state.bookSafeSince ??= {};
  const btcQuote = await quote(hub, BTC);
  const btcQuoted = Number.isFinite(btcQuote?.price);
  const prices = new Map();
  const unconfirmed = new Set();
  const bookChecks = [];
  const worstQuote = new Map(); // symbol -> the only price left: no consensus and no book
  if (btcQuoted && btcQuote.ok) prices.set(BTC, btcQuote.price);
  const quotes = await mapLimit(held, CONCURRENCY, (p) => (p.symbol === BTC ? btcQuote : quote(hub, p.symbol)));
  held.forEach((p, i) => {
    const q = quotes[i];
    // Only the book clears a running bound, so an ok tick still has to look at it.
    if (!q?.ok && Number.isFinite(q?.price) || state.bookCrossSince[p.symbol] !== undefined) bookChecks.push({ p, q });
    if (Number.isFinite(q?.price)) {
      delete state.noQuoteSince[p.symbol];
      if (q.ok) {
        delete state.noConsensusSince[p.symbol];
        prices.set(p.symbol, q.price);
        state.priceAt[p.symbol] = now;
        return;
      }
      state.noConsensusSince[p.symbol] ??= now;
      unconfirmed.add(p.symbol);
      // Wicks are not read from here until consensus returns, when this window is read back.
      state.wickFrom[p.symbol] ??= Math.max(state.lastTickT ?? p.entryTime, p.entryTime);
      // Not marked, so one venue's print moves no stop, no drawdown and no breaker.
    } else if (btcQuoted) {
      // BTC answered and this coin did not, so this coin is the problem, not the network.
      state.noQuoteSince[p.symbol] ??= now;
    }
  });
  // An exit on disputed prices needs evidence that executes, so a live book outranks any print.
  // The bound runs from the book crossing the stop, and only the book staying on the safe side
  // for a whole bound ends it: a passing ok tick or one good book says nothing about what
  // could be sold. Marks can only worsen, so nothing unconfirmed lifts a stop or the equity high.
  await mapLimit(bookChecks, CONCURRENCY, async ({ p, q }) => {
    const { symbol } = p;
    const short = p.side === 'short';
    const worst = short ? Math.max : Math.min;
    const worsened = (price) => worst(...[price, p.lastPrice].filter(Number.isFinite));
    const booked = executablePrice(await exitBook(hub, symbol, cfg.roles?.book), p.side, now);
    const crossed = booked !== null && (short ? booked >= p.stopPrice : booked <= p.stopPrice);
    if (crossed) {
      state.bookCrossSince[symbol] ??= now;
      delete state.bookSafeSince[symbol];
    } else if (booked !== null && state.bookCrossSince[symbol] !== undefined) {
      state.bookSafeSince[symbol] ??= now;
      if (now - state.bookSafeSince[symbol] >= NO_CONSENSUS_MAX_MS) {
        delete state.bookCrossSince[symbol];
        delete state.bookSafeSince[symbol];
      }
    }
    const longAlarm = () => raise({ type: 'alarm', severity: 'critical', code: 'no_consensus_long', symbol, message: `Venues have disagreed on ${symbol} for over 15 minutes. Exits now follow its order book and ignore the reported prices.` });

    if (crossed && now - state.bookCrossSince[symbol] >= NO_CONSENSUS_MAX_MS) {
      prices.set(symbol, worsened(booked));
      state.priceAt[symbol] = now;
      longAlarm();
      return;
    }
    if (q?.ok || !Number.isFinite(q?.price)) return;
    if (crossed || now - state.noConsensusSince[symbol] < NO_CONSENSUS_MAX_MS) {
      raise({ type: 'alarm', severity: 'warning', code: 'no_consensus', symbol, message: `Venues disagree on ${symbol}: ${q.reason ?? 'no consensus'}. Exits use the last good price for up to 15 minutes.` });
      return;
    }
    if (booked !== null) {
      prices.set(symbol, worsened(booked)); // on the safe side, so this marks and fires nothing
      state.priceAt[symbol] = now;
      longAlarm();
      return;
    }
    const reported = worst(...[q.price, ...(q.quotes ?? []).map((v) => v?.price)].filter(Number.isFinite));
    prices.set(symbol, worsened(reported));
    worstQuote.set(symbol, reported);
    raise({ type: 'alarm', severity: 'critical', code: 'no_consensus_no_book', symbol, message: `Venues have disagreed on ${symbol} for over 15 minutes and no order book is available. An exit would use the worst price any venue reports, ${reported}.` });
  });

  if (held.length && !btcQuoted && !quotes.some((q) => Number.isFinite(q?.price))) {
    raise({ type: 'alarm', severity: 'critical', code: 'all_venues_down', message: 'No venue is answering. Positions are marked at the last good price and exits still run.' });
  }

  // 5. Operator requests that need no market data.
  let riskState = firstRun ? null : state.riskState ?? null;
  if (firstRun) {
    const equity = paper.ledgerEquity(ledger, prices).equity;
    riskState = risk.initialRiskState(equity, now);
    state.startedAt = now;
    state.startingEquity = equity;
    state.allTimeHigh = equity;
    raise({ type: 'cutover', severity: 'warning', code: 'cutover', message: `V6 started on a flat account with ${equity.toFixed(2)} in paper cash.` });
  }
  let t = Math.max(now, state.lastTickT ?? 0);
  const halt = cfg.halt_request;
  if (halt && !consumed.has(halt.id)) {
    const out = risk.manualHalt(riskState, { t, reason: halt.reason, by: halt.by, flatten: halt.flatten === true });
    riskState = out.riskState;
    out.events.forEach(raise);
    consumed.add(halt.id);
  }
  const reenable = cfg.reenable_request;
  if (reenable && !consumed.has(reenable.id)) {
    const equity = paper.ledgerEquity(ledger, prices).equity;
    const out = risk.humanReEnable(riskState, { t, equity, by: reenable.by, confirm: true, openPositions: ledger.positions.length + (ledger.quarantined?.length ?? 0) });
    if (out.ok) {
      riskState = out.riskState;
      state.reenables = (state.reenables ?? 0) + 1;
    } else raise({ type: 'alarm', severity: 'warning', code: 'reenable_refused', message: `Re-enable refused: ${out.reason}.` });
    out.events.forEach(raise);
    consumed.add(reenable.id);
  }
  for (const req of cfg.reinstate_requests ?? []) {
    if (consumed.has(req.id)) continue;
    consumed.add(req.id);
    const strategy = allStrategies.find((s) => s.id === req.strategy_id);
    const current = states.get(req.strategy_id);
    if (!gateModule || !strategy || !current) continue;
    // Warm-up signals had no range to be inside, so the gate sees only those that did.
    const certificate = certificates.get(req.strategy_id);
    const counted = Math.max(0, (current.shadow_in_range ?? 0) - (certificate?.expected?.min_trades ?? 0));
    const out = gateModule.returnFromShadow({ ...current, shadow_in_range: counted }, { t, by: req.by, confirm: true, strategy, certificate });
    if (out.ok) states.set(req.strategy_id, out.state);
    else raise({ type: 'alarm', severity: 'warning', code: 'reinstate_refused', message: `Return from shadow refused: ${out.reason}.` });
    (out.events ?? []).forEach(raise);
  }

  // 6. Delisted: nothing quotes the coin for three days while the network is fine.
  const costOf = (symbol, strategy) => paper.costFor(symbol, state.tiers[symbol] ?? tierFromBars(symbol), { instrument: strategy?.perp ? 'perp' : 'spot' });
  const strategyOf = (id) => allStrategies.find((s) => s.id === id);
  const forwardTrades = [];
  const tradeIds = new Map();

  function settle(fill, kind) {
    ledger = paper.applyFill(ledger, fill);
    const s = ledger.lastFill;
    const id = `v6t-${slug(s.id)}`;
    outbox.push({ entity: 'Trade', id, data: { ...paper.toTradeRecord(s), executed_at: new Date(now).toISOString(), fill_kind: kind } });
    if (s.type === 'enter') {
      state.openTrades[s.symbol] = { pnl: 0, notional: s.qty * s.price, strategyId: s.strategyId, tradeId: id };
      tradeIds.set(s.symbol, id);
      return;
    }
    const open = state.openTrades[s.symbol] ?? { pnl: 0, notional: 0, strategyId: s.strategyId, tradeId: id };
    open.pnl += s.realizedPnl;
    state.openTrades[s.symbol] = open;
    if (positionOf(s.symbol)) {
      const remainder = exitRemainderPatch(s);
      if (remainder) ledger = paper.updatePosition(ledger, s.symbol, remainder);
      return;
    }
    if (open.notional > 0) forwardTrades.push({ strategyId: open.strategyId, returnPct: (open.pnl / open.notional) * 100, t: s.t, tradeId: open.tradeId });
    delete state.openTrades[s.symbol];
  }

  for (const p of held) {
    const since = state.noQuoteSince[p.symbol];
    if (!since || now - since <= DELIST_GRACE_MS) continue;
    const last = p.lastPrice;
    const intent = { id: `${cycleId}|delist|${p.symbol}`, type: 'exit', symbol: p.symbol, strategyId: p.strategyId, side: p.side, qty: p.qty, reason: 'Coin delisted', reasonCode: 'delisted', refPrice: last };
    const bar = { t: now, o: last, h: last, l: last, c: last };
    settle(paper.simulateFill({ intent, bar, cost: costOf(p.symbol, strategyOf(p.strategyId)), isDelist: true, t: now }), 'delist');
    delete state.noQuoteSince[p.symbol];
    raise({ type: 'alarm', severity: 'critical', code: 'delisted', symbol: p.symbol, message: `${p.symbol} stopped trading; sold at the last price minus the haircut.` });
  }

  // 7. Wicks since the last tick, for every position still open.
  const wicks = new Map();
  const remaining = [...ledger.positions];
  const wickBars = await mapLimit(remaining, CONCURRENCY, async (p) => {
    // A wick is one venue's print, so it waits for confirmation like any other price.
    if (unconfirmed.has(p.symbol)) return null;
    const from = (prices.has(p.symbol) && state.wickFrom[p.symbol]) || Math.max(state.lastTickT ?? p.entryTime, p.entryTime);
    const fine = await Promise.resolve().then(() => intrabar(p.symbol, from, now)).catch(() => null);
    return { fine, coarse: await coarseGapBars(barsFor, p, from, now, fine) };
  });
  remaining.forEach((p, i) => {
    if (unconfirmed.has(p.symbol)) return;
    const { fine, coarse } = wickBars[i];
    const w = wickSummary(p, fine, coarse ?? []);
    if (coarse) raise({ type: 'alarm', severity: 'warning', code: 'gap_coarse', symbol: p.symbol, message: `Part of the time since the last tick has no 5-minute data for ${p.symbol}; hourly and daily bars cover it.` });
    if (w) {
      wicks.set(p.symbol, w);
      if (prices.has(p.symbol)) delete state.wickFrom[p.symbol];
    } else raise({ type: 'alarm', severity: 'warning', code: 'wick_unavailable', symbol: p.symbol, message: `No 5-minute data for ${p.symbol}; stops checked at the current price only.` });
  });

  for (const p of remaining) {
    if (strategyOf(p.strategyId)) continue;
    raise({ type: 'alarm', severity: 'warning', code: 'strategy_code_missing', symbol: p.symbol, strategyId: p.strategyId, message: `The code of the strategy that opened ${p.symbol} is not installed, so its signal exits cannot run. Stops, trailing stops and regime exits still run.` });
  }

  // 8. Which timeframes have a newly closed bar.
  const tfOfPosition = (p) => tfOfMs(p.exitPlan?.barMs);
  const tfs = new Set([...active.map((s) => s.timeframe), ...remaining.map(tfOfPosition)]);
  const btcHourly = await barsFor(BTC, '1h', 200);
  const passes = [];
  const usedSymbols = new Set();
  for (const tf of tfs) {
    const strategies = active.filter((s) => s.timeframe === tf);
    const mine = remaining.filter((p) => tfOfPosition(p) === tf);
    const barT = closedOpen(now, tf);
    if (barT === state.lastBarT[tf]) continue;
    const probe = await barsFor(BTC, tf, REGIME_BARS);
    // Not published yet, or no venue answering: decide later, never on a stale bar. A position
    // needs only its own coin, so BTC being unavailable does not hold up its exits.
    const fallback = !probe.length && !strategies.length ? await barsFor(mine[0].symbol, tf, 60) : probe;
    if (lastOf(fallback)?.t !== barT) continue;
    passes.push({ tf, barT, strategies, mine, isNewBar: true });
    mine.forEach((p) => usedSymbols.add(p.symbol));
  }
  const inBar = remaining.filter((p) => !usedSymbols.has(p.symbol));
  if (inBar.length || !passes.length) {
    const tf = inBar.length ? tfOfPosition(inBar[0]) : '1d';
    passes.push({ tf, barT: closedOpen(now, tf), strategies: [], mine: inBar, isNewBar: false });
  }

  // 9. One step per pass. Fills land between passes so later passes see the real book.
  const health = hub.health();
  const universeCache = new Map();
  const universeFor = async (s) => {
    if (s.universe.kind === 'fixed') return s.universe.symbols.filter((x) => !TICKER_COLLISIONS.has(x));
    const key = s.universe.n;
    if (!universeCache.has(key)) {
      const rows = await hub.universe({ topN: s.universe.n }).catch(() => []);
      universeCache.set(key, rows.map((r) => r.symbol).filter((x) => !TICKER_COLLISIONS.has(x)));
    }
    return universeCache.get(key);
  };

  let intentCount = 0;
  let lastEquity = null;
  for (const [passIndex, pass] of passes.entries()) {
    const barMs = TF_MS[pass.tf];
    const bars = new Map([[BTC_RISK_KEY, btcHourly]]);
    const passPrices = new Map(prices);
    const universes = new Map();
    const gateData = { consensus: new Map(), replay: new Map(), books: new Map(), history };

    for (const p of pass.mine) {
      bars.set(p.symbol, await barsFor(p.symbol, tfOfPosition(p), 60));
    }

    if (pass.isNewBar && pass.strategies.length) {
      bars.set(BTC, await barsFor(BTC, pass.tf, REGIME_BARS));
      for (const s of pass.strategies) universes.set(s.id, await universeFor(s));
      const symbols = [...new Set([...universes.values()].flat())];
      const need = Math.min(MAX_BARS, Math.max(REGIME_BARS, ...pass.strategies.map((s) => (s.warmupBars ?? 0) + 5)));
      await mapLimit(symbols, CONCURRENCY, async (symbol) => {
        const [series, q, daily] = await Promise.all([
          barsFor(symbol, pass.tf, need), quote(hub, symbol), barsFor(symbol, '1d', 35),
        ]);
        bars.set(symbol, series);
        state.tiers[symbol] = tierFromBars(symbol, daily);
        if (q) gateData.consensus.set(symbol, q);
        // Consensus is required for entries, so a coin without it has no entry price.
        if (q?.ok && Number.isFinite(q.price) && !positionOf(symbol)) passPrices.set(symbol, q.price);
        // Both go to the gate: a venue can answer with bars it cannot use, and the gate falls back.
        const candidates = [];
        for (const venue of replayOrder(cfg)) {
          try {
            candidates.push({ venue, bars: await hub.bars(symbol, pass.tf, need, { venue }) });
          } catch { /* the gate fails this check when no replay venue answered */ }
        }
        if (candidates.length) gateData.replay.set(symbol, candidates);
      });
      // Books go last: the gate refuses one older than 30 seconds.
      await mapLimit(symbols, CONCURRENCY, async (symbol) => {
        const book = await bookFor(hub, symbol, cfg.roles?.book);
        if (book) gateData.books.set(symbol, book);
      });
    }

    // Held positions of a strategy that may not enter this bar. It still decides their exits.
    const blockedHeld = new Map();
    if (pass.isNewBar) {
      for (const p of pass.mine) {
        const s = strategyOf(p.strategyId);
        if (s && !pass.strategies.includes(s)) blockedHeld.set(s, [...(blockedHeld.get(s) ?? []), p.symbol]);
      }
      if (pass.mine.length && !bars.has(BTC)) bars.set(BTC, await barsFor(BTC, pass.tf, REGIME_BARS));
    }
    const blockedUniverses = new Map();
    for (const [s, symbols] of blockedHeld) {
      const universe = [...new Set([...await universeFor(s).catch(() => []), ...symbols])];
      blockedUniverses.set(s, universe);
      const need = Math.min(MAX_BARS, Math.max(60, (s.warmupBars ?? 0) + 5));
      await mapLimit(universe, CONCURRENCY, async (symbol) => { bars.set(symbol, await barsFor(symbol, pass.tf, need)); });
    }

    const ind = createIndicatorAccess(bars);
    if (pass.isNewBar && bars.get(BTC)?.length) state.regime[pass.tf] = computeRegime(ind, BTC, 200, bars);
    const regime = state.regime[pass.tf] ?? { riskOn: null, label: 'unknown' };

    const exitSignals = new Map();
    for (const [s, symbols] of blockedHeld) {
      try {
        const said = s.signals({
          t: deps.now(), barT: pass.barT, bars, params: s.params, positions: paper.positionsBySymbol(ledger), regime, ind, universe: blockedUniverses.get(s),
        }) ?? [];
        for (const signal of said) if (symbols.includes(signal.symbol)) exitSignals.set(signal.symbol, signal);
      } catch (err) {
        raise({ type: 'alarm', code: 'strategy_error', strategyId: s.id, message: err.message });
      }
    }

    const inPass = new Set(pass.mine.map((p) => p.symbol));
    const skip = new Set(ledger.positions.map((p) => p.symbol).filter((s) => !inPass.has(s)));
    const usable = pass.isNewBar ? pass.strategies : [];
    // Held strategies stay visible for their exit overrides, but cannot signal.
    const exitOnly = [...new Set(ledger.positions.map((p) => strategyOf(p.strategyId)).filter(Boolean))]
      .filter((s) => !usable.includes(s)).map((s) => ({ ...s, signals: () => [] }));
    const sizeMultipliers = Object.fromEntries(active.map((s) => [s.id, states.get(s.id)?.size_multiplier ?? 0.5]));

    const gate = gateModule
      ? gateModule.createSignalGate({ states, certificates, data: pass.strategies.length ? gateData : {} })
      : refusingGate('The signal gate is not installed');

    // Wall clock, read after the prefetch: the gate ages books and bars against this t,
    // so the bar close would fail every book. Only the entry fill time uses the close.
    const stepT = Math.max(deps.now(), t);
    const entryT = pass.isNewBar ? pass.barT + barMs : stepT;
    t = stepT;
    const out = step({
      t: stepT,
      account: { cash: ledger.cash, quarantine: paper.quarantineStatus(ledger) },
      positions: paper.positionsBySymbol(ledger),
      market: {
        bars, prices: passPrices, health, barT: pass.barT, barMs, ind, regime, isNewBar: pass.isNewBar,
        periodsPerYear: Math.round((365 * DAY_MS) / barMs),
        universeFor: (s) => universes.get(s.id) ?? [],
        costFor: costOf,
      },
      strategies: [...usable, ...exitOnly],
      config: { risk: risk.clampRiskConfig(cfg.risk), sizeMultipliers, btcSymbol: BTC_RISK_KEY, exits: {} },
      gate,
      riskState,
      modules: {
        // step does not know the book size, and v6Risk needs it to see a flat, stuck account.
        risk: { ...risk, updateRiskState: (s, input) => risk.updateRiskState(s, { ...input, openPositions: ledger.positions.length + (ledger.quarantined?.length ?? 0) }) },
        exits: rangedExits(exits, wicks, skip, exitSignals),
      },
    });
    riskState = out.riskState;
    lastEquity = out.equity;
    if (out.events.some((e) => e.type === 'entry_rejected' && e.message === 'below_min_notional')) {
      const noted = risk.noteEntryRejection(riskState, { reason: 'below_min_notional' }, { t: stepT, openPositions: ledger.positions.length + (ledger.quarantined?.length ?? 0) });
      riskState = noted.riskState;
      noted.events.forEach(raise);
    }
    for (const e of out.events) {
      if (e.type !== 'signal_test') raise(e);
    }
    for (const { symbol, patch } of out.updates) {
      if (positionOf(symbol) && !skip.has(symbol)) ledger = paper.updatePosition(ledger, symbol, patch);
    }

    // Exits fill first, so the cash they free is there for entries.
    const ordered = [...out.intents].sort((a, b) => (a.type === 'enter') - (b.type === 'enter'));
    for (const intent of ordered) {
      const id = `${cycleId}|p${passIndex}|${intent.symbol}|${intent.type}|${intentCount++}`;
      try {
        await fillIntent({ ...intent, id }, intent.type === 'enter' ? entryT : stepT);
      } catch (err) {
        raise({ type: 'alarm', severity: 'critical', code: 'fill_failed', symbol: intent.symbol, message: `${intent.type} on ${intent.symbol} failed: ${err.message}. It will be tried again next tick.` });
      }
    }

    for (const e of out.events) {
      if (e.type !== 'signal_test') continue;
      const { type: _type, ...fields } = e;
      outbox.push({
        entity: 'V6SignalTest', id: `v6s-${slug(e.strategy_id)}-${slug(e.symbol)}-${e.bar_time}`,
        data: { ...fields, trade_id: e.outcome === 'entered' ? tradeIds.get(e.symbol) ?? null : null },
      });
    }

    for (const [strategyId, result] of Object.entries(out.shadow ?? {})) {
      const current = states.get(strategyId);
      if (gateModule && current) {
        states.set(strategyId, gateModule.recordShadowResult(current, result, { certificate: certificates.get(strategyId), t: stepT }).state);
      }
    }
    if (pass.isNewBar) state.lastBarT[pass.tf] = pass.barT;
  }

  async function fillIntent(intent, T) {
    const strategy = strategyOf(intent.strategyId);
    const cost = costOf(intent.symbol, strategy);
    if (intent.type === 'enter') {
      const book = await bookFor(hub, intent.symbol, cfg.roles?.book);
      // An entry with no real book is skipped. Only exits may fall back to the tier cost.
      if (!book) {
        raise({ type: 'entry_unfilled', severity: 'warning', code: 'no_book', symbol: intent.symbol, message: `No order book for ${intent.symbol}; entry skipped.` });
        return;
      }
      let fill = paper.simulateFill({ intent, book, cost, t: now });
      if (fill.status === 'rejected' || fill.flags?.some((f) => f.startsWith('book_unavailable'))) {
        raise({ type: 'entry_unfilled', severity: 'warning', code: fill.rejectReason ?? 'no_book', symbol: intent.symbol, message: `Entry on ${intent.symbol} not filled: ${fill.rejectReason ?? 'book unusable'}.` });
        return;
      }
      const need = fill.notional + fill.fee;
      if (need > ledger.cash) {
        const qty = intent.qty * (ledger.cash / need) * (1 - 1e-12);
        if (qty * fill.price < MIN_FILL_NOTIONAL) {
          raise({ type: 'entry_unfilled', severity: 'warning', code: 'no_cash', symbol: intent.symbol, message: `No cash left for ${intent.symbol}.` });
          return;
        }
        fill = paper.simulateFill({ intent: { ...intent, qty }, book, cost, t: now });
      }
      fill.positionFields = entryPositionFields({ intent, fill, cost, exitConfig: exitConfigFor(strategy, {}, { barMs: TF_MS[strategy?.timeframe] ?? DAY_MS }) });
      // The decision close is the next bar's open, the time the simulator gives this fill.
      settle({ ...fill, t: T }, 'entry');
      return;
    }

    const p = positionOf(intent.symbol);
    if (!p) return;
    const qty = intent.type === 'exit' ? p.qty : Math.min(intent.qty, p.qty);
    const sized = { ...intent, qty };
    let fill;
    if (intent.fill?.mode === 'limit') {
      // A target fills at its own price, never better, even on a gap through it.
      fill = paper.simulateFill({ intent: sized, bar: { ...intent.fill.bar, o: intent.fill.price }, cost, t: now });
    } else if (intent.fill?.mode === 'stop') {
      const short = p.side === 'short';
      // Read back from an older stop, the fill is priced from that stop, not the one above it.
      const { touchOpen, touchStop } = wicks.get(intent.symbol) ?? {};
      const worst = short ? Math.max : Math.min;
      const base = worst(...[intent.fill.price, touchOpen, touchStop].filter(Number.isFinite));
      if (wicks.get(intent.symbol)?.coarseTouch) {
        raise({ type: 'alarm', severity: 'warning', code: 'gap_fill', symbol: intent.symbol, message: `The stop on ${intent.symbol} was touched while no 5-minute data was available. It was filled at the worse of the stop, the opening gap and the current book.` });
      }
      fill = paper.simulateFill({ intent: sized, book: await exitBook(hub, intent.symbol, cfg.roles?.book), cost, isStop: true, stopPrice: base, t: now });
    } else {
      fill = paper.simulateFill({ intent: sized, book: await exitBook(hub, intent.symbol, cfg.roles?.book), cost, t: now });
    }
    if (!(fill.qty > 0)) {
      // No bids at all. Keep the intent to leave, so the next tick tries again.
      ledger = paper.updatePosition(ledger, intent.symbol, { exitPending: { reasonCode: intent.reasonCode, reason: intent.reason } });
      raise({ type: 'alarm', severity: 'critical', code: 'exit_unfilled', symbol: intent.symbol, message: `Nothing filled on the ${intent.symbol} exit; trying again next tick.` });
      return;
    }
    if (worstQuote.has(intent.symbol) && fill.method === 'tier_fallback') {
      raise({ type: 'alarm', severity: 'critical', code: 'exit_worst_quote', symbol: intent.symbol, message: `${intent.symbol} closed at ${fill.price} with no consensus and no order book, from the worst price any venue reported, ${worstQuote.get(intent.symbol)}. The real price may differ.` });
    }
    settle({ ...fill, t: Math.max(T, ledger.lastT ?? 0) }, intent.fill?.mode ?? 'market');
  }

  // 10. Operator close requests, after the normal exits.
  for (const req of cfg.close_requests ?? []) {
    if (consumed.has(req.id)) continue;
    consumed.add(req.id);
    for (const p of ledger.positions.filter((x) => x.strategyId === req.strategy_id)) {
      const id = `${cycleId}|close|${p.symbol}`;
      const intent = {
        id, type: 'exit', symbol: p.symbol, strategyId: p.strategyId, side: p.side, qty: p.qty, reason: 'Closed by the operator',
        reasonCode: 'operator_close', refPrice: prices.get(p.symbol) ?? p.lastPrice, fill: { mode: 'market', price: null },
      };
      try {
        await fillIntent(intent, t);
      } catch (err) {
        raise({ type: 'alarm', severity: 'critical', code: 'fill_failed', symbol: p.symbol, message: `Operator close on ${p.symbol} failed: ${err.message}.` });
      }
    }
  }

  // 11. Strategy lifecycle. Promotion is by certificate only; demotion is automatic.
  // With the state file unreadable nothing here could be saved, and nothing may advance.
  if (gateModule && stateRows) {
    for (const trade of forwardTrades) {
      const current = states.get(trade.strategyId);
      if (!current) continue;
      const out = gateModule.recordForwardTrade(current, trade, { certificate: certificates.get(trade.strategyId) });
      states.set(trade.strategyId, out.state);
      (out.events ?? []).forEach(raise);
    }
    for (const strategy of selection.active) {
      const out = gateModule.advanceLifecycle(states.get(strategy.id), { strategy, certificate: certificates.get(strategy.id), t });
      states.set(strategy.id, out.state);
      (out.events ?? []).forEach(raise);
    }
    for (const [strategyId, data] of states) {
      outbox.push({ entity: 'V6StrategyState', id: `v6st-${slug(strategyId)}`, upsert: true, data: { ...data, strategy_id: strategyId } });
    }
    state.lifecycles = Object.fromEntries([...states].map(([id, s]) => [id, s.lifecycle]));
  }

  // 12. Why the account is in cash, recorded when the reason changes rather than every tick.
  const cashCode = blockEntries[0] ?? selection.cashCode;
  if (cashCode !== state.cashCode) {
    if (cashCode) raise({ type: 'in_cash', code: cashCode, message: CASH_TEXT[cashCode] ?? 'New entries are blocked. Holding cash.', data: { skipped: selection.skipped } });
    state.cashCode = cashCode;
  }

  // 13. Marks, equity and rows for the commit.
  const marks = new Map(prices);
  for (const p of ledger.positions) if (!marks.has(p.symbol)) marks.set(p.symbol, p.lastPrice);
  const eq = paper.ledgerEquity(ledger, marks);
  if (eq.equity > (state.allTimeHigh ?? 0) || !state.allTimeHighAt) state.allTimeHighAt = now;
  state.allTimeHigh = Math.max(state.allTimeHigh ?? eq.equity, eq.equity);
  const drawdownPct = state.allTimeHigh > 0 ? ((eq.equity - state.allTimeHigh) / state.allTimeHigh) * 100 : 0;
  // Kept here as well: retention thins old equity points, and the worst one could go with them.
  state.worstDrawdownPct = Math.min(state.worstDrawdownPct ?? 0, drawdownPct);
  // A fill this tick was priced now. Closed coins drop out, so the map only holds open ones.
  state.priceAt = Object.fromEntries(ledger.positions.map((p) => [p.symbol, state.priceAt[p.symbol] ?? now]));
  // Memory of a closed position must not count against the next one in the same coin.
  const stillHeld = ([symbol]) => positionOf(symbol);
  state.noQuoteSince = Object.fromEntries(Object.entries(state.noQuoteSince).filter(stillHeld));
  state.noConsensusSince = Object.fromEntries(Object.entries(state.noConsensusSince).filter(stillHeld));
  state.wickFrom = Object.fromEntries(Object.entries(state.wickFrom).filter(stillHeld));
  state.bookCrossSince = Object.fromEntries(Object.entries(state.bookCrossSince).filter(stillHeld));
  state.bookSafeSince = Object.fromEntries(Object.entries(state.bookSafeSince).filter(stillHeld));

  outbox.push({
    entity: 'V6EquityPoint', id: `v6q-${Math.floor(now / FIVE_MIN_MS)}`,
    data: {
      t: now, equity: eq.equity, cash: eq.cash, btc_price: btcQuoted ? btcQuote.price : null,
      // From the all-time high, so a re-enable cannot hide earlier losses.
      drawdown_pct: drawdownPct,
      exposure_pct: eq.equity > 0 ? (eq.positionsValue / eq.equity) * 100 : 0,
    },
  });
  for (const h of health) {
    outbox.push({
      entity: 'V6ExchangeHealth', id: `v6h-${h.venue}`, upsert: true,
      data: {
        venue: h.venue, ok: h.ok === true, status: h.status ?? (h.ok ? 'ok' : 'unknown'), breaker: h.breaker ?? null, latency_ms: h.latencyMs ?? null,
        last_ok: h.lastOk ?? null, last_error: h.lastError ?? null, last_error_at: h.lastErrorAt ?? null,
        // The hub's rateLimited is a lifetime count; status says whether it applies now.
        retry_until: h.retryInMs > 0 ? now + h.retryInMs : null, consecutive_failures: h.consecutiveFailures ?? 0, rate_limited: h.status === 'rate_limited',
      },
    });
  }

  // A repeating alarm is stored when it starts and once an hour after that.
  const alarms = {};
  let eventIndex = 0;
  for (const e of events) {
    const key = `${e.code ?? e.type}|${e.symbol ?? ''}`;
    const repeating = e.type === 'alarm';
    if (repeating) {
      const seen = state.alarms[key];
      alarms[key] = seen && now - seen < ALARM_REPEAT_MS ? seen : now;
      if (seen && now - seen < ALARM_REPEAT_MS) continue;
    }
    const { type, severity, code, message, data, symbol, strategyId, t: at, ...rest } = e;
    outbox.push({
      entity: 'V6RiskEvent', id: `v6e-${cycleId}-${eventIndex++}`,
      data: {
        t: at ?? now, type, severity, code: code ?? type, message: message ?? '', data: { ...rest, ...data, symbol, strategyId },
        sticky: severity === 'critical', acked_at: null, cleared_at: null,
      },
    });
  }

  const committedRow = paper.toPortfolioRecord(ledger, marks, { now });
  const nextState = {
    ...state, seq, riskState, alarms, lastTickT: Math.max(now, state.lastTickT ?? 0), record: accountRecord(committedRow),
    consumed: [...consumed].slice(-CONSUMED_MEMORY),
    lastCycle: {
      at: now, ok: true, active: active.map((s) => s.id), held: ledger.positions.length, cash_code: cashCode, new_bars: passes.filter((p) => p.isNewBar).map((p) => p.tf), equity: lastEquity, store_faults: [...faults],
    },
    outbox,
  };

  // 14. Commit: one atomic write. Everything after it can be redone.
  hooks.beforeCommit?.();
  await E.Portfolio.update(row.id, { ...committedRow, v6_state: nextState });
  hooks.afterCommit?.();

  // The ledger is committed, so nothing after this may fail the cycle.
  const drained = await drainOutbox(E, outbox);
  await E.Portfolio.update(row.id, { v6_state: { ...nextState, outbox: requeue(drained.failed) } });
  try {
    if (!cfg.unreadable) {
      if (cfg.portfolio_id !== row.id) await E.V6Config.update(cfg.id, { portfolio_id: row.id, cutover_at: cfg.cutover_at ?? now });
      if (firstRun && cfg.recutover_request) await E.V6Config.update(cfg.id, { cutover_at: now, recutover_request: null });
      await clearConsumedRequests(E, cfg, consumed);
    }
    if (seq % 12 === 0) await pruneRetention(E, now);
  } catch (err) {
    console.error(`[v6Engine] after commit: ${err.message}`);
  }

  const line = `${cashCode ? `in cash (${cashCode})` : 'active'}; equity ${eq.equity.toFixed(2)}; held ${ledger.positions.length}; strategies ${active.length}; new bars ${nextState.lastCycle.new_bars.join(',') || 'none'}`;
  return { ok: true, status: 'ran', seq, cashCode, held: ledger.positions.length, equity: eq.equity, logLine: line };
}

async function clearConsumedRequests(E, cfg, consumed) {
  const latest = await E.V6Config.get(cfg.id);
  if (!latest) return;
  const patch = {};
  if (latest.halt_request && consumed.has(latest.halt_request.id)) patch.halt_request = null;
  if (latest.reenable_request && consumed.has(latest.reenable_request.id)) patch.reenable_request = null;
  if (latest.foreign_ack_request && consumed.has(latest.foreign_ack_request.id)) patch.foreign_ack_request = null;
  for (const key of ['close_requests', 'reinstate_requests']) {
    const left = (latest[key] ?? []).filter((r) => !consumed.has(r.id));
    if (left.length !== (latest[key] ?? []).length) patch[key] = left;
  }
  if (Object.keys(patch).length) await E.V6Config.update(cfg.id, patch);
}

/** 5-minute points for 7 days, hourly for 90 days, daily after that. Signal tests capped. */
export async function pruneRetention(E, now) {
  const points = await E.V6EquityPoint.list('t', 200_000);
  const seen = new Set();
  const drop = [];
  for (const p of points) {
    const age = now - p.t;
    if (age <= 7 * DAY_MS) continue;
    const bucket = age <= 90 * DAY_MS ? `h${Math.floor(p.t / 3_600_000)}` : `d${Math.floor(p.t / DAY_MS)}`;
    if (seen.has(bucket)) drop.push(p.id);
    else seen.add(bucket);
  }
  if (drop.length) await E.V6EquityPoint.deleteMany({ id: { $in: drop } });
  const tests = await E.V6SignalTest.list('-t', SIGNAL_TEST_CAP + 5_000);
  if (tests.length > SIGNAL_TEST_CAP) await E.V6SignalTest.deleteMany({ id: { $in: tests.slice(SIGNAL_TEST_CAP).map((r) => r.id) } });
}

/** One locked cycle. Overlap is refused in-process and across processes. */
export async function runCycle(deps) {
  const { entities: E, now, isAlive = pidAlive } = deps;
  if (globalThis[RUNNING]) return { ok: true, status: 'skipped', reason: 'a cycle is already running', logLine: 'skipped: a cycle is already running' };
  globalThis[RUNNING] = true;
  let cfg = null;
  let leased = false;
  try {
    try {
      cfg = await loadConfig(E);
    } catch (err) {
      if (err.code !== UNREADABLE) throw err;
      // The default limits are the tightest that apply, and the in-process flag still guards overlap.
      cfg = { ...defaultConfig(), unreadable: true };
      return await runOneCycle(deps, cfg);
    }
    const lease = await acquireLease(E, cfg, now(), isAlive);
    if (!lease.ok) return { ok: true, status: 'skipped', reason: lease.reason, logLine: `skipped: ${lease.reason}` };
    leased = true;
    return await runOneCycle(deps, cfg, { leaseInvalid: lease.invalid });
  } finally {
    globalThis[RUNNING] = false;
    if (leased) await E.V6Config.update(cfg.id, { engine_lease: null }).catch(() => {});
  }
}
