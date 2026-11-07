/**
 * v6Control: the only way the GUI reads or changes V6. Admin only, paper only.
 *
 * It never moves money. Writes change config or leave a request in V6Config, and the
 * engine applies requests at its next tick, so the ledger and risk state keep one writer.
 *
 * Deliberately absent: promoting a strategy, overriding a gate result, ignoring drift,
 * creating or editing a certificate, holdout or criteria changes, live trading, API keys.
 */

import { randomUUID } from 'node:crypto';

import * as risk from './shared/v6Risk.js';
import { DEFAULT_HUB_CONFIG, EXCHANGES } from './shared/v6Exchanges.js';

const TICK_MIN = 5;
const ENGINE_DOWN_MS = 15 * 60_000;
const CONSENSUS_TTL_MS = 60_000;
const TEST_EXCHANGE_GAP_MS = 30_000;
const MIN_VENUES = 2;
const MAX_CURVE_POINTS = 500;
const DAY_MS = 86_400_000;
const LOOSEN_BLOCKED_RUNG = 2;
const V6_EXCHANGE = 'Paper Trading (V6)';
const SHADOW_SIGNALS_REQUIRED = 20;
const HALF_RISK_TRADES = 20;
const PAPER_STATES = new Set(['paper_half', 'paper_full']);

const refuse = (code, error, fields) => ({ ok: false, code, error, ...(fields ? { fields } : {}) });
const pct = (v) => (Number.isFinite(v) ? v * 100 : null);
const clampLimit = (v, fallback, max) => Math.min(max, Math.max(1, Number.isInteger(v) ? v : fallback));

const REASON_TEXT = {
  halted: 'Halted',
  input_fault: 'The engine got inputs it could not trust',
  drawdown_no_entries: 'Drawdown past the no-entries level',
  daily_loss_limit: 'Daily loss limit reached',
  weekly_loss_limit: 'Weekly loss limit reached',
  market_breaker: 'BTC fell past the market breaker',
  market_data_unknown: 'BTC history not available yet, so the breaker cannot be checked',
  data_unhealthy: 'Too few healthy price sources',
  risk_state_invalid: 'Stored risk state could not be read',
};

const m = (label, group, unit, scale, step, sign, looser, editable = true) => ({
  label, help: label, group, scale, unit, step, sign, looser, editable,
});

export const RISK_META = {
  riskPerTradePct: m('Risk per trade', 'trade', '%', 100, 0.05, 1, 'up'),
  maxOpenRiskPct: m('Max open risk', 'portfolio', '%', 100, 0.1, 1, 'up'),
  maxPositionPct: m('Max position size', 'portfolio', '%', 100, 1, 1, 'up'),
  maxGrossExposurePct: m('Max gross exposure', 'portfolio', '%', 100, 5, 1, 'up'),
  maxClusterPct: m('Max correlated cluster', 'portfolio', '%', 100, 1, 1, 'up'),
  clusterCorrelation: m('Cluster correlation', 'portfolio', '', 1, 0.05, 1, 'up'),
  volTargetAnnual: m('Volatility target', 'portfolio', '%', 100, 1, 1, 'up'),
  // A higher assumed volatility means smaller positions.
  assumedVolAnnual: m('Assumed volatility', 'portfolio', '%', 100, 5, 1, 'down'),
  ladderHalfPct: m('Half size at', 'ladder', '%', 100, 0.5, -1, 'up'),
  ladderQuarterPct: m('Quarter size at', 'ladder', '%', 100, 0.5, -1, 'up'),
  ladderNoEntryPct: m('No entries at', 'ladder', '%', 100, 0.5, -1, 'up'),
  ladderHaltPct: m('Flatten and halt at', 'ladder', '%', 100, 0.5, -1, 'up'),
  // Needing a smaller recovery releases the ladder sooner.
  ladderRecoveryPct: m('Ladder recovery', 'ladder', '%', 100, 0.1, 1, 'down'),
  dailyLossPct: m('Daily loss limit', 'loss', '%', 100, 0.1, -1, 'up'),
  weeklyLossPct: m('Weekly loss limit', 'loss', '%', 100, 0.1, -1, 'up'),
  btcDrop24hPct: m('BTC 24h breaker', 'market', '%', 100, 0.5, -1, 'up'),
  btcDrop7dPct: m('BTC 7d breaker', 'market', '%', 100, 0.5, -1, 'up'),
  marketRecoveryPct: m('Market recovery', 'market', '%', 100, 0.1, 1, 'down'),
  marketCooldownHours: m('Market cooldown', 'market', 'h', 1, 1, 1, 'down'),
  minHealthyVenues: m('Minimum healthy venues', 'data', '', 1, 1, 1, 'down'),
  minNotional: m('Minimum order', 'trade', '$', 1, 5, 1, 'down'),
  minStopDistancePct: m('Minimum stop distance', 'trade', '%', 100, 0.1, 1, 'down'),
  maxStopDistancePct: m('Maximum stop distance', 'trade', '%', 100, 1, 1, 'up'),
  defaultFeePct: m('Fee assumption', 'cost', '%', 100, 0.01, 1, 'down', false),
  defaultSlipPct: m('Slippage assumption', 'cost', '%', 100, 0.01, 1, 'down', false),
  stopGapSlipPct: m('Stop gap assumption', 'cost', '%', 100, 0.01, 1, 'down', false),
};

const FIXED_RULES = ['Leverage on spot: none', 'Exits are never blocked'];

// --- shared reads ------------------------------------------------------------

async function config(E) {
  const rows = await E.V6Config.list('-created_date', 5);
  return rows[0] ?? E.V6Config.create({
    id: 'v6-config', version: 1, risk: risk.clampRiskConfig(risk.DEFAULT_RISK_CONFIG), venues: [], strategies: {},
    halt_request: null, reenable_request: null, close_requests: [], reinstate_requests: [], engine_lease: null,
  });
}

// The same row the engine runs on: the pinned one, never a newer row that looks like it.
async function account(E) {
  const [cfg] = await E.V6Config.list('-created_date', 5);
  if (cfg?.portfolio_id) return E.Portfolio.get(cfg.portfolio_id);
  const rows = await E.Portfolio.list('-created_date', 20);
  return rows.find((r) => r.v6_state) ?? rows[0] ?? null;
}

const operatorEvent = (E, now, user, code, message, before, after) => E.V6RiskEvent.create({
  t: now, type: 'operator_change', severity: 'info', code, message, data: { by: user.email ?? null }, sticky: false,
  acked_at: null, cleared_at: null, before, after,
});

const riskOf = (row) => row?.v6_state?.riskState ?? null;

function loosenBlocked(rs) {
  // An unreadable state is treated as the worst case.
  if (!rs) return true;
  return rs.halt?.active === true || rs.rung >= LOOSEN_BLOCKED_RUNG;
}

const damagedPositions = (row) => row?.positions != null && !Array.isArray(row.positions);
// A list that cannot be read is not flat, so the damaged value stands in as one row.
const positionRows = (row) => (damagedPositions(row) ? [row.positions] : row?.positions ?? []);

function reenableInfo(rs, positions, cfg) {
  const preview = risk.reEnablePreview(rs, { openPositions: positions.length });
  const flat = positions.length === 0;
  const preconditions = preview.willRebase ? [
    { id: 'flat', label: 'No positions open', ok: flat },
    { id: 'no_flatten', label: 'No flatten pending', ok: flat || !(cfg.halt_request?.flatten || rs?.halt?.flatten) },
  ] : [];
  return { available: preview.allowed, reason: preview.reason, willRebase: preview.willRebase, preconditions };
}

// --- headline ----------------------------------------------------------------

/** First matching row wins (gui-design 5.1). */
export function deriveHeadline({ now, lastTickAt, rs, positions, lifecycles, equity, openRiskPct, quarantined = 0, positionsDamaged = false }) {
  const n = positions.length;
  const plural = (c, word) => `${c} ${word}${c === 1 ? '' : 's'}`;
  const paper = lifecycles.filter((l) => PAPER_STATES.has(l)).length;
  const shadows = lifecycles.filter((l) => l === 'shadow').length;
  const can = rs ? risk.canEnter(rs) : { ok: false, reasons: ['risk_state_invalid'] };
  const reasons = can.reasons.map((code) => ({ text: REASON_TEXT[code] ?? 'New entries are blocked' }));
  const row = (state, title, line, tone) => ({ state, title, line, tone, reasons });

  if (!lastTickAt || now - lastTickAt > ENGINE_DOWN_MS) {
    const ago = lastTickAt ? `Last run was ${Math.round((now - lastTickAt) / 60_000)} min ago.` : 'The engine has not run yet.';
    return row('ENGINE_DOWN', 'ENGINE NOT RUNNING', `${ago} Stops are not being checked.`, 'red');
  }
  if (!rs || rs.halt?.source === 'fail_safe') return row('HALTED', 'HALTED', 'Stored risk state could not be read. Halted until you re-enable.', 'red');
  if (rs.rung === 4 || rs.halt?.flatten || (rs.halt?.active && rs.halt.source !== 'manual')) {
    return row('HALTED', 'HALTED', `Halted at ${(-pct(rs.drawdown)).toFixed(1)}% drawdown. Needs your review in Risk Controls.`, 'red');
  }
  // LOCAL FIX: an unreadable position is not cash, and it has no working exit.
  if (quarantined > 0) {
    return row('NEEDS_REVIEW', 'NEEDS YOUR REVIEW', `${plural(quarantined, 'position')} cannot be read and will not exit until you repair it. New entries are held.`, 'red');
  }
  if (positionsDamaged) {
    return row('NEEDS_REVIEW', 'NEEDS YOUR REVIEW', 'The stored position list is damaged, so nothing held can be shown. The next run tries to restore it from the engine record.', 'red');
  }
  if (rs.halt?.active) {
    const at = rs.halt.at ? new Date(rs.halt.at).toISOString().slice(11, 16) : '';
    return row('PAUSED', 'PAUSED BY YOU', `You paused new entries at ${at} UTC. ${plural(n, 'position')} still managed by their exit plans.`, 'amber');
  }
  if (risk.riskDirectives(rs).needsReview) {
    const why = rs.review?.reason === 'flat_entries_too_small'
      ? 'Entries at this reduced size fall below the minimum order'
      : `No new entries at ${(-pct(rs.drawdown)).toFixed(1)}% drawdown`;
    return row('NEEDS_REVIEW', 'NEEDS YOUR REVIEW', `${why}, and with no positions this cannot recover by itself. Review in Risk Controls.`, 'amber');
  }
  if (paper === 0) {
    const tail = shadows ? ` ${shadows} running in shadow, logging only.` : '';
    if (n > 0) return row('NO_CERTIFIED', `CLOSING ${plural(n, 'POSITION').toUpperCase()}`, `No certified strategy. ${plural(n, 'position')} closing under its exit plan.${tail}`, 'slate');
    return row('NO_CERTIFIED', 'IN CASH', `In cash: no strategy has passed certification, so nothing is allowed to trade.${tail}`, 'slate');
  }
  if (!can.ok) {
    return row('ENTRIES_BLOCKED', 'NO NEW ENTRIES', `No new entries: ${reasons[0]?.text ?? 'blocked'}. ${plural(n, 'position')} still managed.`, 'amber');
  }
  if (n > 0) {
    const from = new Set(positions.map((p) => p.strategyId)).size;
    return row('HOLDING', `HOLDING ${plural(n, 'PAPER POSITION').toUpperCase()}`, `Holding ${plural(n, 'paper position')} from ${plural(from, 'strategy').replace('strategys', 'strategies')}. Open risk ${(openRiskPct ?? 0).toFixed(1)}% of equity.`, 'indigo');
  }
  return row('WAITING', 'IN CASH', `In cash: ${paper} ${paper === 1 ? 'strategy' : 'strategies'} active, no signal cleared all 7 tests today.`, 'slate');
}

// --- read actions ------------------------------------------------------------

// Two missed ticks and a minute of grace: one late cycle is not a stale price.
const PRICE_STALE_MS = 11 * 60_000;

const shortPrice = (x) => String(Number(x.toPrecision(6)));

const isOn = (rule) => rule === true || rule?.enabled === true;

function nextExitText(v, stop) {
  if (v.exitPending) return `Closing: ${v.exitPending.reason ?? 'exit under way'}`;
  const plan = v.exitPlan;
  const parts = [];
  if (Number.isFinite(stop)) parts.push(`${stop === v.initialStopPrice ? 'Hard stop' : 'Trailing stop'} at ${shortPrice(stop)}`);
  if (isOn(plan?.timeStop) && plan.timeStop.bars > (v.barsHeld ?? 0)) {
    const bars = plan.timeStop.bars - (v.barsHeld ?? 0);
    parts.push(`time stop check in ${bars} ${bars === 1 ? 'bar' : 'bars'}`);
  }
  return parts.join(', ') || null;
}

function positionView(row, now, { priceAt = {}, nameOf = new Map() } = {}) {
  const v = row.v6 ?? {};
  const last = row.last_known_price ?? v.lastPrice ?? null;
  const stop = v.stopPrice ?? null;
  const side = v.side ?? 'long';
  const dir = side === 'short' ? -1 : 1;
  const qty = row.quantity;
  const riskToStop = Number.isFinite(stop) && Number.isFinite(last) ? Math.max(0, dir * (last - stop) * qty) : null;
  const symbol = v.symbol ?? row.asset_symbol;
  // No recorded quote time reads as stale: an unknown age is not a fresh price.
  const pricedAt = priceAt[symbol];
  const ageMs = Number.isFinite(pricedAt) ? Math.max(0, now - pricedAt) : null;
  return {
    symbol, strategyId: v.strategyId ?? null, strategyName: nameOf.get(v.strategyId) ?? v.strategyId ?? null,
    adopted: false, side, instrument: v.instrument ?? 'spot', fundingAccrued: v.fundingAccrued ?? 0,
    qty, entryPrice: row.avg_entry_price, entryTime: v.entryTime ?? null, lastPrice: last, priceAgeSec: ageMs === null ? null : Math.round(ageMs / 1000), stale: ageMs === null || ageMs > PRICE_STALE_MS,
    unrealized: row.profit_loss ?? 0,
    rMultiple: v.riskAtEntry > 0 ? (row.profit_loss ?? 0) / v.riskAtEntry : null,
    stopPrice: stop, initialStopPrice: v.initialStopPrice ?? null,
    distanceToStopPct: Number.isFinite(stop) && last > 0 ? (dir * (last - stop) / last) * 100 : null,
    riskToStop, barsHeld: v.barsHeld ?? null, exitProfile: v.exitProfile ?? null, nextExit: nextExitText(v, stop),
    exitWarnings: v.exitPlan?.warnings ?? [], exitPlan: exitPlanRows(v, stop), asOf: now,
  };
}

function exitPlanRows(v, stop) {
  const plan = v.exitPlan;
  if (!plan) return [];
  const row = (id, label, level, on, note) => ({ id, label, level: level ?? null, state: on ? 'armed' : 'off', note });
  return [
    row('hard_stop', 'Hard stop', plan.hardStopPrice ?? v.initialStopPrice, true, 'set at entry, never moves down'),
    row('break_even', 'Break-even', plan.breakEvenPrice, isOn(plan.breakEven), 'moves the stop to entry'),
    row('trail', 'Trail', stop, isOn(plan.trail), 'follows the high'),
    row('time_stop', 'Time stop', null, isOn(plan.timeStop), 'closes if it has not worked'),
    row('signal_exit', 'Signal exit', null, isOn(plan.signalExit), 'closes if the strategy goes flat'),
    row('regime_exit', 'Regime exit', null, isOn(plan.regimeExit), 'closes if the regime turns off'),
    row('partial', 'Partial profit', null, !!plan.partials?.length, 'takes part of the position off'),
  ];
}

function changeOver(bars, ms) {
  const last = bars?.[bars.length - 1];
  if (!last) return null;
  const then = [...bars].reverse().find((b) => last.t - b.t >= ms);
  return then ? ((last.c - then.c) / then.c) * 100 : null;
}

async function status({ E, now, registry }) {
  const [cfg, row, stateRows, openEvents, curveFirst, curveAll, settings, certRows] = await Promise.all([
    config(E), account(E), E.V6StrategyState.list('-created_date', 200),
    E.V6RiskEvent.filter({ cleared_at: null }, '-t', 200),
    E.V6EquityPoint.list('t', 1), E.V6EquityPoint.list('drawdown_pct', 1),
    E.AutoTradingSettings.list().catch(() => null),
    E.V6Certificate.list('-issued_at', 200),
  ]);
  const state = row?.v6_state ?? null;
  const rs = riskOf(row);
  const cfgRisk = risk.clampRiskConfig(cfg.risk);
  const nameOf = new Map((Array.isArray(registry) ? registry : Object.values(registry ?? {})).map((s) => [s.id, s.name]));
  // A quarantined row can hold anything, so it is listed on its own and never formatted.
  const quarantined = state?.quarantined ?? [];
  const unreadableRows = new Set(quarantined.map((q) => q.raw));
  const positionsDamaged = damagedPositions(row);
  const positions = (positionsDamaged ? [] : row?.positions ?? []).filter((p) => p && typeof p === 'object' && !unreadableRows.has(JSON.stringify(p)))
    .map((p) => positionView(p, now, { priceAt: state?.priceAt, nameOf }));
  // Newest certificate per strategy: a later pass replaces an earlier failure.
  const latestCerts = new Map();
  for (const c of certRows) if (!latestCerts.has(c.strategy_id)) latestCerts.set(c.strategy_id, c);
  const lifecycles = stateRows.map((s) => s.lifecycle);
  const equity = row?.total_balance ?? null;
  const cash = row?.available_balance ?? null;
  const positionsValue = row?.positions_value ?? 0;
  const unrealized = positions.reduce((s, p) => s + p.unrealized, 0);
  const openRisk = positions.reduce((s, p) => s + (p.riskToStop ?? 0), 0);
  const openRiskPct = equity > 0 ? (openRisk / equity) * 100 : 0;
  const lastTickAt = state?.lastTickT ?? null;
  const can = rs ? risk.canEnter(rs) : { ok: false, reasons: ['risk_state_invalid'] };
  const directives = rs ? risk.riskDirectives(rs) : { sizeMultiplier: 0 };
  const failed = openEvents.find((e) => e.type === 'cycle_failed' && e.t > (lastTickAt ?? 0));
  const startingEquity = state?.startingEquity ?? null;
  const firstBtc = curveFirst[0]?.btc_price;
  const lastBtc = (await E.V6EquityPoint.list('-t', 1))[0]?.btc_price;
  const btcReturnPct = firstBtc > 0 && lastBtc > 0 ? ((lastBtc - firstBtc) / firstBtc) * 100 : null;
  const equityReturnPct = startingEquity > 0 && equity !== null ? ((equity - startingEquity) / startingEquity) * 100 : null;
  const pending = cfg.halt_request ? (cfg.halt_request.flatten ? 'flatten' : 'pause') : cfg.reenable_request ? 'reenable' : null;
  const allTimeHigh = state?.allTimeHigh ?? null;
  const count = (fn) => stateRows.filter(fn).length;
  const anySetting = (field) => settings.some((s) => Boolean(s?.[field])); // as the engine reads is_enabled
  const legacy = settings === null ? null : {
    autoTradingEnabled: anySetting('is_enabled'),
    liveTradingEnabled: anySetting('live_trading_enabled'),
    killSwitch: anySetting('kill_switch_enabled'),
  };
  const dayEnd = (Math.floor(now / DAY_MS) + 1) * DAY_MS;

  return {
    ok: true, asOf: now, mode: 'paper',
    engine: {
      lastTickAt, lastTickOk: !failed, lastError: failed?.message ?? null, tickEveryMin: TICK_MIN,
      stale: !lastTickAt || now - lastTickAt > ENGINE_DOWN_MS,
    },
    headline: deriveHeadline({ now, lastTickAt, rs, positions, lifecycles, equity, openRiskPct, quarantined: quarantined.length, positionsDamaged }),
    account: {
      startedAt: state?.startedAt ?? null, startingEquity, equity, cash, positionsValue,
      realized: row?.total_profit_loss ?? 0, unrealized, fees: row?.v6_ledger?.fees ?? 0,
      grossExposurePct: equity > 0 ? (positionsValue / equity) * 100 : 0, openRiskPct,
      btcReturnPct, equityReturnPct,
      vsBtcPts: btcReturnPct !== null && equityReturnPct !== null ? equityReturnPct - btcReturnPct : null,
    },
    risk: {
      canEnter: can.ok && !quarantined.length,
      blockReasons: [...can.reasons.map((c) => REASON_TEXT[c] ?? 'New entries are blocked'), ...(quarantined.length ? ['A position row cannot be read'] : [])],
      sizeMultiplier: directives.sizeMultiplier ?? 0,
      drawdownPct: rs ? -pct(rs.drawdown ?? 0) : null,
      worstDrawdownPct: Math.min(state?.worstDrawdownPct ?? 0, curveAll[0]?.drawdown_pct ?? 0),
      review: rs?.review ?? null,
      peakEquity: rs?.equityHigh ?? null,
      allTime: allTimeHigh > 0 && equity !== null ? {
        highEquity: allTimeHigh, highAt: state.allTimeHighAt ?? null,
        drawdownPct: ((equity - allTimeHigh) / allTimeHigh) * 100, reenables: state.reenables ?? 0,
      } : null,
      rung: rs?.rung ?? null, rungName: rs ? risk.LADDER_RUNGS[rs.rung]?.name : null,
      ladder: {
        halfPct: -pct(cfgRisk.ladderHalfPct), quarterPct: -pct(cfgRisk.ladderQuarterPct),
        noEntriesPct: -pct(cfgRisk.ladderNoEntryPct), haltPct: -pct(cfgRisk.ladderHaltPct),
      },
      daily: { lossPct: lossPct(equity, rs?.day?.startEquity), limitPct: -pct(cfgRisk.dailyLossPct), resetsAt: dayEnd },
      weekly: { lossPct: lossPct(equity, rs?.week?.startEquity), limitPct: -pct(cfgRisk.weeklyLossPct), resetsAt: Date.parse(risk.utcWeekKey(now)) + 7 * DAY_MS },
      btc: {
        chg24hPct: pct(rs?.market?.change24h), limit24hPct: -pct(cfgRisk.btcDrop24hPct),
        chg7dPct: pct(rs?.market?.change7d), limit7dPct: -pct(cfgRisk.btcDrop7dPct), tripped: rs?.market?.tripped === true,
      },
      dataOk: rs?.data?.ok === true, requestPending: pending,
      halted: rs?.halt?.active ? {
        source: rs.halt.source, at: rs.halt.at, by: rs.halt.by, reason: rs.halt.reason, flatten: rs.halt.flatten,
        drawdownPct: -pct(rs.drawdown ?? 0), peakEquity: rs.equityHigh, equity,
      } : null,
      reenable: reenableInfo(rs, positionRows(row), cfg), // raw rows: quarantined ones are not flat
    },
    positions,
    positionsDamaged,
    quarantinedPositions: quarantined.map((q) => ({ symbol: q.symbol, message: 'This row cannot be read. It has no stop and cannot exit until a person fixes it.' })),
    strategies: {
      paper: count((s) => PAPER_STATES.has(s.lifecycle)), certified: count((s) => s.lifecycle === 'certified'),
      shadow: count((s) => s.lifecycle === 'shadow'), research: count((s) => s.lifecycle === 'research'),
      failed: [...latestCerts.values()].filter((c) => c.status === 'failed').length,
    },
    alarms: {
      critical: openEvents.filter((e) => e.severity === 'critical' && !e.acked_at).length,
      warning: openEvents.filter((e) => e.severity === 'warning' && !e.acked_at).length,
    },
    legacy,
  };
}

const lossPct = (equity, start) => (equity !== null && start > 0 ? ((equity - start) / start) * 100 : null);

async function equityCurve({ E, now, body }) {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[body.range];
  const from = days ? now - days * DAY_MS : 0;
  const rows = await E.V6EquityPoint.filter({ t: { $gte: from } }, 't', 200_000);
  const stride = Math.max(1, Math.ceil(rows.length / MAX_CURVE_POINTS));
  const picked = rows.filter((_, i) => i % stride === 0);
  if (rows.length && picked[picked.length - 1] !== rows[rows.length - 1]) picked[picked.length - 1] = rows[rows.length - 1];
  const e0 = picked[0]?.equity;
  const b0 = picked.find((p) => p.btc_price > 0)?.btc_price;
  return {
    ok: true, asOf: now, startedAt: rows[0]?.t ?? null, downsampled: stride > 1,
    points: picked.map((p) => ({
      t: p.t, equityIndex: e0 > 0 ? (p.equity / e0) * 100 : null, btcIndex: b0 > 0 && p.btc_price > 0 ? (p.btc_price / b0) * 100 : null,
      equity: p.equity, drawdownPct: p.drawdown_pct, exposurePct: p.exposure_pct,
    })),
  };
}

async function decisions({ E, now, body }) {
  const day = typeof body.day === 'string' ? body.day : new Date(now).toISOString().slice(0, 10);
  const from = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(from)) return refuse('BAD_REQUEST', 'That day could not be read.');
  const to = from + DAY_MS;
  const limit = clampLimit(body.limit, 50, 200);
  const [tests, trades] = await Promise.all([
    E.V6SignalTest.filter({ t: { $gte: from, $lt: to } }, '-t', 500),
    E.Trade.filter({ exchange: V6_EXCHANGE }, '-timestamp', 500),
  ]);
  const items = [];
  for (const s of tests) {
    const kind = s.outcome === 'entered' ? 'entered' : s.outcome === 'shadow' ? 'shadow' : s.outcome === 'not_tested' ? 'not_tested' : 'blocked';
    items.push({ t: s.t, kind, symbol: s.symbol, strategyId: s.strategy_id, side: s.side, text: s.blocked_text ?? s.reason ?? '', reasonCode: s.blocked_by ?? s.reject_code ?? null, signalTestId: s.id, tradeId: s.trade_id ?? undefined });
  }
  for (const tr of trades) {
    const t = Date.parse(tr.timestamp);
    if (!(t >= from && t < to) || tr.reason_code === 'signal') continue;
    items.push({ t, kind: 'exit', symbol: tr.asset_symbol, strategyId: tr.strategy_id, side: null, text: tr.exit_reason ?? '', reasonCode: tr.reason_code, tradeId: tr.id, pnl: tr.profit_loss });
  }
  const want = { entry: ['entered'], exit: ['exit', 'reduce'], blocked: ['blocked'] }[body.kind];
  return { ok: true, asOf: now, day, items: items.filter((i) => !want || want.includes(i.kind)).sort((a, b) => b.t - a.t).slice(0, limit) };
}

const eventView = (e) => ({
  id: e.id, t: e.t, type: e.type, severity: e.severity, code: e.code, message: e.message, data: e.data,
  ackedAt: e.acked_at ?? null, clearedAt: e.cleared_at ?? null, sticky: e.sticky === true,
});

async function events({ E, now, body }) {
  const query = {};
  if (body.onlyOpen) query.cleared_at = null;
  if (typeof body.type === 'string') query.type = body.type;
  if (Number.isFinite(body.since)) query.t = { $gte: body.since };
  const rows = await E.V6RiskEvent.filter(query, '-t', clampLimit(body.limit, 50, 200));
  return { ok: true, asOf: now, items: rows.map(eventView) };
}

// The first min_trades shadow signals have no range to be inside, so they earn nothing.
const shadowSignalsCounted = (state, cert) => Math.max(0, (state?.shadow_in_range ?? 0) - (cert?.expected?.min_trades ?? 0));

// One marker where the forward line enters a breach, not one for every point inside it.
function driftBreaches(series, expected, gateModule) {
  if (!gateModule?.evaluateDrift || !expected) return [];
  const breaches = [];
  let inside = true;
  series.forEach((point, i) => {
    const drift = gateModule.evaluateDrift(expected, series.slice(0, i + 1).map((p) => p.trade_return_pct));
    if (drift.status === 'breach' && inside) breaches.push({ x: point.x, text: drift.note, note: drift.note });
    inside = drift.status !== 'breach';
  });
  return breaches;
}

function strategyItem(s, state, cert, cfg, gateModule) {
  const lifecycle = state?.lifecycle ?? 'research';
  const display = { paper_half: 'PAPER (HALF)', paper_full: 'PAPER (FULL)', shadow: 'SHADOW', certified: 'CERTIFIED', research: 'RESEARCH' }[lifecycle];
  const verdict = cert && gateModule ? gateModule.verifyCertificate(cert, s, Date.now()) : null;
  const criteria = cert?.criteria ?? [];
  return {
    id: s.id, name: s.name, version: s.version, timeframe: s.timeframe, lifecycle, displayState: display,
    operatorEnabled: cfg.strategies?.[s.id]?.operator_enabled !== false,
    // Read only: equal risk across active strategies (CONTRACT section 6, I4).
    sleevePct: null, sizeMultiplier: state?.size_multiplier ?? 0, forwardTrades: state?.forward_trades ?? 0, halfRiskUntilTrades: HALF_RISK_TRADES,
    drift: { status: { warming: 'too_few', inside: 'inside', breach: 'breach', unknown: 'unknown' }[state?.drift_status] ?? 'none', note: state?.drift_note ?? null },
    demotedAt: state?.demoted_at ?? null, demotionReason: state?.demotion_reason ?? null,
    shadowReturn: {
      signalsInRange: shadowSignalsCounted(state, cert), signalsRequired: SHADOW_SIGNALS_REQUIRED,
      pending: (cfg.reinstate_requests ?? []).some((r) => r.strategy_id === s.id),
    },
    certificate: {
      id: cert?.id ?? null, status: cert ? (verdict?.ok ? 'valid' : cert.status === 'failed' ? 'failed' : 'stale') : 'none',
      passed: criteria.filter((c) => c.status === 'pass').length, total: criteria.length,
      failedIds: criteria.filter((c) => c.status === 'fail').map((c) => c.id), holdoutRun: criteria.some((c) => c.group === 'holdout' && c.status !== 'not_run'),
    },
  };
}

async function strategyContext(E, registry) {
  const [cfg, stateRows, certRows] = await Promise.all([config(E), E.V6StrategyState.list('-created_date', 200), E.V6Certificate.list('-issued_at', 200)]);
  const certs = new Map();
  for (const c of certRows) if (!certs.has(c.strategy_id)) certs.set(c.strategy_id, c);
  return { cfg, states: new Map(stateRows.map((s) => [s.strategy_id, s])), certs, all: Array.isArray(registry) ? registry : Object.values(registry ?? {}) };
}

async function strategies({ E, now, registry, gateModule }) {
  const { cfg, states, certs, all } = await strategyContext(E, registry);
  const trialCount = Math.max(0, ...[...certs.values()].map((c) => c.trial_count ?? 0));
  return {
    ok: true, asOf: now, globalTrialCount: trialCount, maxSleevePct: 50,
    items: all.map((s) => strategyItem(s, states.get(s.id), certs.get(s.id), cfg, gateModule)),
  };
}

async function strategyDetail({ E, now, body, registry, gateModule }) {
  const { cfg, states, certs, all } = await strategyContext(E, registry);
  const s = all.find((x) => x.id === body.id);
  if (!s) return refuse('NOT_FOUND', 'That strategy does not exist.');
  const state = states.get(s.id);
  const cert = certs.get(s.id);
  const recentTrades = await E.Trade.filter({ exchange: V6_EXCHANGE, strategy_id: s.id }, '-timestamp', 20);
  const series = state?.forward_series ?? [];
  const item = strategyItem(s, state, cert, cfg, gateModule);
  return {
    ok: true, asOf: now,
    strategy: { ...item, ruleText: s.description ?? '', params: s.params ?? {}, universeText: s.universe?.kind === 'top' ? `Top ${s.universe.n} by volume` : (s.universe?.symbols ?? []).join(', '), exitProfile: s.exitProfile ?? null },
    certificate: cert ? {
      id: cert.id, status: item.certificate.status, storedStatus: cert.status, issuedAt: cert.issued_at, expiresAt: cert.expires_at ?? null, hash: cert.hash,
      hashMatches: gateModule ? gateModule.strategyHash(s) === cert.hash : null, trialCount: cert.trial_count, holdoutClean: cert.holdout_clean, criteria: cert.criteria ?? [],
    } : null,
    drift: {
      xUnit: cert?.expected?.x_unit ?? 'trades', status: state?.drift_status ?? 'none', n: series.length, note: state?.drift_note ?? null,
      expected: cert?.expected?.points ?? [], forward: series.map((p) => ({ x: p.x, returnPct: p.return_pct })), breaches: driftBreaches(series, cert?.expected, gateModule),
    },
    recentTrades,
  };
}

const checkMap = (checks) => Object.fromEntries((checks ?? []).map((c) => [c.id, c.status]));

const testItem = (s) => ({
  id: s.id, t: s.t, barTime: s.bar_time, symbol: s.symbol, strategyId: s.strategy_id, side: s.side, outcome: s.outcome,
  rejectCode: s.reject_code ?? null, blockedBy: s.blocked_by ?? null, blockedText: s.blocked_text ?? null, notTestedReason: s.not_tested_reason ?? null, checks: checkMap(s.checks),
});

async function signalTests({ E, now, body }) {
  const from = Number.isFinite(body.from) ? body.from : now - 7 * DAY_MS;
  const to = Number.isFinite(body.to) ? body.to : now;
  const query = { t: { $gte: from, $lte: to } };
  if (body.strategyId) query.strategy_id = body.strategyId;
  if (body.symbol) query.symbol = body.symbol;
  if (body.outcome) query.outcome = body.outcome;
  let rows = await E.V6SignalTest.filter(query, '-t', 5_000);
  if (body.failedCheck) rows = rows.filter((r) => checkMap(r.checks)[body.failedCheck] === 'fail');
  const failures = new Map();
  for (const r of rows) if (r.blocked_by) failures.set(r.blocked_by, (failures.get(r.blocked_by) ?? 0) + 1);
  const top = [...failures.entries()].sort((a, b) => b[1] - a[1])[0];
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const limit = clampLimit(body.limit, 50, 200);
  const offset = Number.isInteger(body.cursor) && body.cursor > 0 ? body.cursor : 0;
  const page = rows.slice(offset, offset + limit);
  return {
    ok: true, asOf: now, nextCursor: offset + limit < rows.length ? offset + limit : null,
    summary: { total: rows.length, entered: count('entered'), blocked: count('blocked'), rejected: count('rejected'), shadow: count('shadow'), notTested: count('not_tested'), topFailure: top ? { check: top[0], count: top[1] } : null },
    facets: { strategies: [...new Set(rows.map((r) => r.strategy_id))].map((id) => ({ id, name: id })), symbols: [...new Set(rows.map((r) => r.symbol))] },
    items: page.map(testItem),
  };
}

async function signalTest({ E, now, body }) {
  const s = typeof body.id === 'string' ? await E.V6SignalTest.get(body.id) : null;
  if (!s) return refuse('NOT_FOUND', 'That signal test does not exist.');
  return {
    ok: true, asOf: now,
    test: {
      ...testItem(s), reason: s.reason, rankInBatch: s.rank_in_batch, batchSize: s.batch_size, exitProfile: s.exit_profile, stopDistancePct: s.stop_distance_pct, tradeId: s.trade_id ?? null,
      checks: (s.checks ?? []).map((c, i) => ({ ...c, n: i + 1 })),
    },
  };
}

async function riskConfig({ E, now }) {
  const [cfg, row] = await Promise.all([config(E), account(E)]);
  return {
    ok: true, asOf: now, version: cfg.version, config: risk.clampRiskConfig(cfg.risk), defaults: risk.DEFAULT_RISK_CONFIG,
    ceilings: risk.HARD_CEILINGS, meta: RISK_META, loosenBlocked: loosenBlocked(riskOf(row)), fixed: FIXED_RULES,
  };
}

const REPLAY_VENUES = ['okx', 'bybit'];
// Own properties only: constructor and toString are truthy lookups on any object.
const isVenue = (id) => typeof id === 'string' && Object.hasOwn(EXCHANGES, id);
const DISAGREEMENT_REASONS = new Set(['venues_disagree', 'no_majority', 'outlier_excluded']);

// A saved role wins. With none saved, the first enabled venue able to do the job is used.
function effectiveRoles(cfg, on) {
  const saved = cfg.roles ?? {};
  return {
    replay: on.includes(saved.replay) ? saved.replay : on.find((v) => REPLAY_VENUES.includes(v)) ?? null,
    book: on.includes(saved.book) ? saved.book : on[0] ?? null,
  };
}

function venueList(cfg) {
  const saved = new Map((cfg.venues ?? []).map((v) => [v.venue, v]));
  return Object.keys(EXCHANGES).map((venue, i) => ({ venue, enabled: saved.get(venue)?.enabled ?? true, priority: saved.get(venue)?.priority ?? i + 1 }));
}

async function exchanges({ E, now }) {
  const [cfg, rows] = await Promise.all([config(E), E.V6ExchangeHealth.list('venue', 50)]);
  const health = new Map(rows.map((r) => [r.venue, r]));
  const venues = venueList(cfg).sort((a, b) => a.priority - b.priority).map((v) => {
    const h = health.get(v.venue);
    return {
      ...v, label: EXCHANGES[v.venue]?.label ?? v.venue,
      // A venue nobody has tried is unknown, never healthy.
      health: h?.status ?? 'unknown', latencyMs: h?.latency_ms ?? null, lastOk: h?.last_ok ?? null, lastError: h?.last_error ?? null,
      lastErrorAt: h?.last_error_at ?? null, breaker: h?.breaker ?? null, retryInMs: h?.retry_until ? Math.max(0, h.retry_until - now) : 0,
      consecutiveFailures: h?.consecutive_failures ?? 0, roles: [],
    };
  });
  const on = venues.filter((v) => v.enabled).map((v) => v.venue);
  const { replay, book } = effectiveRoles(cfg, on);
  for (const v of venues) {
    if (!v.enabled) continue;
    v.roles = ['bars', 'consensus', ...(v.venue === replay ? ['replay'] : []), ...(v.venue === book ? ['book'] : [])];
  }
  return {
    ok: true, asOf: now, version: cfg.version, minForConsensus: MIN_VENUES, latencyWarnMs: DEFAULT_HUB_CONFIG.latencyWarnMs, venues,
    roles: { bars: on, replay, consensus: on, book },
  };
}

const consensusCache = new Map();

async function consensus({ E, now, body, hub }) {
  const row = await account(E);
  const heldCoins = positionRows(row).map((p) => p?.v6?.symbol ?? p?.asset_symbol).filter(Boolean);
  const asked = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : [...heldCoins, 'BTCUSDT', 'ETHUSDT'];
  const symbols = [...new Set(asked)].slice(0, 10);
  const items = [];
  for (const symbol of symbols) {
    const hit = consensusCache.get(symbol);
    if (hit && now - hit.at < CONSENSUS_TTL_MS) { items.push(hit.item); continue; }
    const q = await hub.consensusPrice(symbol).catch((err) => ({ price: null, ok: false, reason: err.message }));
    const item = {
      symbol, price: q.price ?? null, lastGood: q.lastGood ?? null,
      quotes: Object.fromEntries((q.quotes ?? []).map((v) => [v.venue, v.price])), spreadPct: q.spreadPct ?? null, rawSpreadPct: q.rawSpreadPct ?? q.spreadPct ?? null,
      ok: q.ok === true, reason: q.reason ?? null, disagreement: DISAGREEMENT_REASONS.has(q.reason), outliers: q.outliers ?? [], pegAlarm: q.pegAlarm === true,
    };
    consensusCache.set(symbol, { at: now, item });
    items.push(item);
  }
  return { ok: true, asOf: now, tolerancePct: DEFAULT_HUB_CONFIG.tolerancePct, items };
}

// --- write actions -----------------------------------------------------------

const looser = (key, before, after) => {
  if (after === before) return false;
  return RISK_META[key]?.looser === 'down' ? after < before : after > before;
};

/** Validates a full proposed config. Returns a refusal, or null when it may be saved. */
function reviewRisk(current, proposed, changed, rs) {
  const above = {};
  for (const key of changed) {
    const { min, max } = risk.HARD_CEILINGS[key];
    if (proposed[key] > max) above[key] = `Ceiling is ${max}`;
    else if (proposed[key] < min) above[key] = `Floor is ${min}`;
  }
  if (Object.keys(above).length) return refuse('ABOVE_CEILING', 'A value is outside its hard limit. Nothing was changed.', above);

  // clampRiskConfig adjusts silently, so any difference must be refused, not saved.
  const clamped = risk.clampRiskConfig(proposed);
  const moved = {};
  for (const key of Object.keys(risk.HARD_CEILINGS)) {
    if (Math.abs(clamped[key] - proposed[key]) > 1e-12) moved[key] = `Would really apply as ${clamped[key]}`;
  }
  if (Object.keys(moved).length) return refuse('BAD_REQUEST', 'Those values conflict with each other. Nothing was changed.', moved);

  if (loosenBlocked(rs)) {
    const blocked = {};
    for (const key of changed) if (looser(key, current[key], proposed[key])) blocked[key] = 'Loosening is refused on the quarter-size rung or worse, or while halted';
    if (Object.keys(blocked).length) return refuse('LOOSEN_BLOCKED', 'Limits cannot be loosened during a drawdown or halt. Tightening is allowed.', blocked);
  }
  return null;
}

const versionConflict = () => refuse('VERSION_CONFLICT', 'The settings changed since you opened them. Reload and try again.');

async function setRiskConfig({ E, now, body, user }) {
  const patch = body.patch;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return refuse('BAD_REQUEST', 'No changes were sent.');
  const [cfg, row] = await Promise.all([config(E), account(E)]);
  if (body.expectedVersion !== cfg.version) return versionConflict();
  const bad = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(risk.HARD_CEILINGS, key)) bad[key] = 'Unknown setting';
    else if (RISK_META[key]?.editable === false) bad[key] = 'This setting is read only';
    else if (!Number.isFinite(value)) bad[key] = 'Must be a number';
  }
  if (Object.keys(bad).length) return refuse('BAD_REQUEST', 'A setting could not be accepted. Nothing was changed.', bad);
  const current = risk.clampRiskConfig(cfg.risk);
  const proposed = { ...current, ...patch };
  const refusal = reviewRisk(current, proposed, Object.keys(patch), riskOf(row));
  if (refusal) return refusal;
  const version = cfg.version + 1;
  await E.V6Config.update(cfg.id, { risk: proposed, version });
  await operatorEvent(E, now, user, 'risk_config', 'Risk limits changed.', current, proposed);
  return { ok: true, asOf: now, effective: 'next_tick', version, config: proposed };
}

async function resetRiskConfig({ E, now, body, user }) {
  const [cfg, row] = await Promise.all([config(E), account(E)]);
  if (body.expectedVersion !== cfg.version) return versionConflict();
  const current = risk.clampRiskConfig(cfg.risk);
  const proposed = risk.clampRiskConfig(risk.DEFAULT_RISK_CONFIG);
  const changed = Object.keys(proposed).filter((k) => proposed[k] !== current[k]);
  const refusal = reviewRisk(current, proposed, changed, riskOf(row));
  if (refusal) return refusal;
  const version = cfg.version + 1;
  await E.V6Config.update(cfg.id, { risk: proposed, version });
  await operatorEvent(E, now, user, 'risk_config_reset', 'Risk limits reset to defaults.', current, proposed);
  return { ok: true, asOf: now, effective: 'next_tick', version, config: proposed };
}

const request = (now, user, extra) => ({ id: randomUUID(), at: now, by: user.email ?? user.id ?? 'operator', ...extra });

async function pauseEntries({ E, now, body, user }) {
  if (typeof body.reason !== 'string' || !body.reason.trim()) return refuse('BAD_REQUEST', 'Say why you are pausing.');
  const cfg = await config(E);
  const req = request(now, user, { reason: body.reason.trim(), flatten: false });
  await E.V6Config.update(cfg.id, { halt_request: req });
  await operatorEvent(E, now, user, 'pause_entries', 'Pause requested.', null, req);
  return { ok: true, asOf: now, effective: 'next_tick', requestedAt: now };
}

async function flattenAll({ E, now, body, user }) {
  if (body.confirm !== 'FLATTEN') return refuse('CONFIRM_MISMATCH', 'Type FLATTEN to confirm.');
  const cfg = await config(E);
  const req = request(now, user, { reason: typeof body.reason === 'string' ? body.reason : 'operator flatten', flatten: true });
  await E.V6Config.update(cfg.id, { halt_request: req });
  await operatorEvent(E, now, user, 'flatten_all', 'Flatten requested.', null, req);
  return { ok: true, asOf: now, effective: 'next_tick', requestedAt: now };
}

async function reenable({ E, now, body, user }) {
  const [cfg, row] = await Promise.all([config(E), account(E)]);
  const info = reenableInfo(riskOf(row), positionRows(row), cfg);
  if (!info.available) {
    if (info.reason === 'nothing_to_clear') return refuse('NOT_HALTED', 'There is nothing to clear.');
    return refuse('PRECONDITION_FAILED', 'This cannot be cleared while positions are open.', { flat: 'No positions open' });
  }
  if (body.confirm !== (info.willRebase ? 'RE-ENABLE' : 'RESUME')) return refuse('CONFIRM_MISMATCH', `Type ${info.willRebase ? 'RE-ENABLE' : 'RESUME'} to confirm.`);
  if (typeof body.note !== 'string' || !body.note.trim()) return refuse('BAD_REQUEST', 'A note is required.');
  const unmet = info.preconditions.filter((p) => !p.ok);
  if (unmet.length) return refuse('PRECONDITION_FAILED', 'Not every condition is met.', Object.fromEntries(unmet.map((p) => [p.id, p.label])));
  const req = request(now, user, { note: body.note.trim() });
  await E.V6Config.update(cfg.id, { reenable_request: req });
  await operatorEvent(E, now, user, 'reenable', 'Re-enable requested.', null, req);
  return { ok: true, asOf: now, effective: 'next_tick', requestedAt: now, willRebase: info.willRebase };
}

async function setStrategyEnabled({ E, now, body, user, registry, gateModule }) {
  const { cfg, states, certs, all } = await strategyContext(E, registry);
  const s = all.find((x) => x.id === body.id);
  if (!s) return refuse('NOT_FOUND', 'That strategy does not exist.');
  if (typeof body.enabled !== 'boolean') return refuse('BAD_REQUEST', 'enabled must be true or false.');
  const state = states.get(s.id);
  if (!state || state.lifecycle === 'research') return refuse('NOT_ALLOWED_IN_STATE', 'A research strategy has no certificate, so it cannot be switched on.');
  const before = cfg.strategies?.[s.id] ?? {};
  const after = { ...before, operator_enabled: body.enabled };
  const patch = { strategies: { ...cfg.strategies, [s.id]: after } };
  if (!body.enabled && body.closePositions === true) patch.close_requests = [...(cfg.close_requests ?? []), request(now, user, { strategy_id: s.id })];
  await E.V6Config.update(cfg.id, patch);
  await operatorEvent(E, now, user, 'strategy_enabled', `${s.id} ${body.enabled ? 'switched on' : 'switched off'}.`, before, after);
  return { ok: true, asOf: now, effective: 'next_tick', strategy: strategyItem(s, state, certs.get(s.id), { ...cfg, ...patch }, gateModule) };
}

async function returnFromShadow({ E, now, body, user, registry, gateModule }) {
  const { cfg, states, certs, all } = await strategyContext(E, registry);
  const s = all.find((x) => x.id === body.id);
  if (!s) return refuse('NOT_FOUND', 'That strategy does not exist.');
  if (body.confirm !== 'RETURN') return refuse('CONFIRM_MISMATCH', 'Type RETURN to confirm.');
  if (typeof body.note !== 'string' || !body.note.trim()) return refuse('BAD_REQUEST', 'A note is required.');
  const state = states.get(s.id);
  if (state?.lifecycle !== 'shadow') return refuse('NOT_ALLOWED_IN_STATE', 'Only a strategy in shadow can return.');
  // Fails closed: with no gate to check it, the certificate does not count as valid.
  const cert = certs.get(s.id);
  if (!gateModule?.verifyCertificate(cert, s, now)?.ok) {
    return refuse('PRECONDITION_FAILED', 'This strategy has no valid certificate, so it cannot return.');
  }
  const counted = shadowSignalsCounted(state, cert);
  if (counted < SHADOW_SIGNALS_REQUIRED) {
    return refuse('PRECONDITION_FAILED', `${counted} of ${SHADOW_SIGNALS_REQUIRED} shadow signals are back inside the expected range.`);
  }
  const waiting = (cfg.reinstate_requests ?? []).find((r) => r.strategy_id === s.id);
  if (waiting) return { ok: true, asOf: now, effective: 'next_tick', requestedAt: waiting.at };
  const req = request(now, user, { strategy_id: s.id, note: body.note.trim() });
  await E.V6Config.update(cfg.id, { reinstate_requests: [...(cfg.reinstate_requests ?? []), req] });
  await operatorEvent(E, now, user, 'return_from_shadow', `Return from shadow requested for ${s.id}.`, null, req);
  return { ok: true, asOf: now, effective: 'next_tick', requestedAt: now };
}

// Sleeves are read only for now (CONTRACT section 6, I4).
const setSleeves = async () => refuse('NOT_ALLOWED_IN_STATE', 'Sleeves are read only: risk is split equally across active strategies.');

async function setExchanges({ E, now, body, user }) {
  const cfg = await config(E);
  if (body.expectedVersion !== cfg.version) return versionConflict();
  if (!Array.isArray(body.venues)) return refuse('BAD_REQUEST', 'No venues were sent.');
  const unknown = body.venues.filter((v) => !isVenue(v?.venue));
  if (unknown.length) return refuse('BAD_REQUEST', 'An unknown venue was sent.');
  if (new Set(body.venues.map((v) => v.venue)).size !== body.venues.length) return refuse('BAD_REQUEST', 'A venue was sent twice.');
  const venues = body.venues.map((v) => ({ venue: v.venue, enabled: v.enabled === true, priority: Number(v.priority) || 99 }));
  if (venues.filter((v) => v.enabled).length < MIN_VENUES) return refuse('MIN_VENUES', `At least ${MIN_VENUES} venues must stay on for consensus.`);
  const on = venues.filter((v) => v.enabled).map((v) => v.venue);
  const { replay = null, book = null } = { ...cfg.roles, ...body.roles };
  if (replay !== null && !REPLAY_VENUES.includes(replay)) return refuse('BAD_REQUEST', 'Replay must be OKX or Bybit: they are the only venues with stored history.');
  if (replay !== null ? !on.includes(replay) : !on.some((v) => REPLAY_VENUES.includes(v))) return refuse('PRECONDITION_FAILED', 'The replay venue is switched off. Choose OKX or Bybit and keep it on.');
  if (book !== null && !isVenue(book)) return refuse('BAD_REQUEST', 'An unknown venue was sent.');
  if (book !== null && !on.includes(book)) return refuse('PRECONDITION_FAILED', 'The order book venue is switched off. Choose one that is on.');
  const roles = { replay, book };
  const version = cfg.version + 1;
  await E.V6Config.update(cfg.id, { venues, roles, version });
  await operatorEvent(E, now, user, 'exchanges', 'Exchange settings changed.', { venues: cfg.venues, roles: cfg.roles ?? {} }, { venues, roles });
  return { ok: true, asOf: now, effective: 'next_tick', version, warnings: [] };
}

const lastTest = new Map();

async function testExchange({ E, now, body, hub, user }) {
  const venue = body.venue;
  if (!isVenue(venue)) return refuse('NOT_FOUND', 'That venue does not exist.');
  if (now - (lastTest.get(venue) ?? 0) < TEST_EXCHANGE_GAP_MS) return refuse('RATE_LIMITED', 'That venue was tested moments ago. Try again shortly.');
  lastTest.set(venue, now);
  const timed = async (name, fn, detail) => {
    const started = Date.now();
    try {
      const value = await fn();
      return { name, ok: true, ms: Date.now() - started, detail: detail(value) };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - started, detail: err.message };
    }
  };
  const steps = [
    await timed('ticker', () => hub.ticker('BTCUSDT', { venue }), (v) => `BTC ${v?.price ?? v?.last ?? ''}`),
    await timed('bars', () => hub.bars('BTCUSDT', '1h', 2, { venue }), (v) => `${v.length} bars`),
    await timed('book', () => hub.book('BTCUSDT', 5, { venue }), () => 'book read'),
  ];
  const ok = steps.every((s) => s.ok);
  if (!ok) await operatorEvent(E, now, user, 'test_exchange', `Test of ${venue} failed.`, null, { venue });
  return { ok: true, asOf: now, effective: 'next_tick', result: { venue, ok, testedAt: now, steps } };
}

async function ackEvent({ E, now, body, user }) {
  const event = typeof body.id === 'string' ? await E.V6RiskEvent.get(body.id) : null;
  if (!event) return refuse('NOT_FOUND', 'That event does not exist.');
  const updated = await E.V6RiskEvent.update(event.id, { acked_at: new Date(now).toISOString(), acked_by: user.email ?? null });
  // The engine owns this block, so the acknowledgement reaches it as a request.
  if (event.code === 'foreign_change') {
    const cfg = await config(E);
    await E.V6Config.update(cfg.id, { foreign_ack_request: request(now, user, {}) });
  }
  return { ok: true, asOf: now, effective: 'next_tick', event: eventView(updated) };
}

// Only for an account that has really lost its engine state. It can never be used to shed
// a halt, a high-water mark or a drawdown from a working account.
async function recutover({ E, now, body, user }) {
  if (body.confirm !== 'RECUTOVER') return refuse('CONFIRM_MISMATCH', 'Type RECUTOVER to confirm.');
  const cfg = await config(E);
  const row = await account(E);
  if (!cfg.cutover_at) return refuse('NOT_ALLOWED_IN_STATE', 'V6 has not cut over yet, so there is nothing to start again.');
  if (row?.v6_state) return refuse('NOT_ALLOWED_IN_STATE', 'The account still has its engine state. Starting over is only for an account that lost it.');
  if (damagedPositions(row) || row?.positions?.some((p) => p?.quantity)) return refuse('NOT_ALLOWED_IN_STATE', 'The account holds positions. It must be flat to start over.');
  const req = request(now, user, {});
  await E.V6Config.update(cfg.id, { recutover_request: req });
  await operatorEvent(E, now, user, 'recutover', 'Operator asked V6 to start over on this account.', null, { portfolio_id: row?.id ?? null });
  return { ok: true, asOf: now, effective: 'next_tick', request: req };
}

export const ACTIONS = {
  status, equityCurve, decisions, events, strategies, strategyDetail, signalTests, signalTest, riskConfig, exchanges, consensus,
  setRiskConfig, resetRiskConfig, pauseEntries, flattenAll, reenable, setStrategyEnabled, returnFromShadow, setSleeves,
  setExchanges, testExchange, ackEvent, recutover,
};

export async function handle({ entities, body = {}, user, hub, registry = [], gateModule = null, now = Date.now() }) {
  const action = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!action) return refuse('UNKNOWN_ACTION', 'That action does not exist.');
  return action({ E: entities, body, user, hub, registry, gateModule, now });
}
