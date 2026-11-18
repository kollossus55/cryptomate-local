import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

import { fetchCandles, fetchHistoricalCandles } from './shared/marketData.js';
import { computeOutcome, outcomeRipeHours, COMMITTEE_RETENTION_DAYS } from './shared/committee.js';

/**
 * LOCAL CHANGE (agent committee, phase 2) — Resolve Committee Outcomes.
 *
 * Fills `outcome` on CommitteeDecision records once 24 hours have passed:
 * forward returns at 4h and 24h, the 24h high/low, and whether the account's
 * take-profit or stop-loss would have hit first. Runs hourly from the local
 * scheduler.
 *
 * It labels EVERY logged decision — entries, rejects and vetoes alike. That is
 * the point: it is how the shadow comparison learns whether a veto saved money
 * or cost it, and which agents' votes are followed by gains.
 *
 * Read-only against the market; writes only CommitteeDecision.outcome (and
 * outcome_tried_at on a decision it could not resolve yet), in one batched
 * write per run.
 *
 * A decision that cannot resolve (no candles, a symbol that keeps failing)
 * must not hold its place at the front: each run takes the ripe decisions
 * tried least recently, so the newest ones get their turn. Decisions older
 * than COMMITTEE_RETENTION_DAYS are deleted here, because the worker that
 * used to delete them no longer runs on the scheduler.
 */

const MAX_PER_RUN = 3000;
const HOUR = 3600e3;
const BAR_HOURS = { '15m': 0.25, '30m': 0.5, '1h': 1, '4h': 4, '1d': 24 };
// fetchCandles returns at most ~300 bars; older decisions page through history.
const RECENT_BARS = 280;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    const now = Date.now();
    const cutoff = new Date(now - COMMITTEE_RETENTION_DAYS * 864e5).toISOString();
    const purged = await base44.asServiceRole.entities.CommitteeDecision.deleteMany({ evaluated_at: { $lt: cutoff } });

    // Coarse pre-filter at the shortest horizon, then each decision's own interval.
    const ripeBefore = new Date(now - outcomeRipeHours('1h') * HOUR).toISOString();
    const intervalOf = (d) => (BAR_HOURS[d.interval] ? d.interval : '1h');
    const candidates = (await base44.asServiceRole.entities.CommitteeDecision.filter(
      { outcome: null, evaluated_at: { $lt: ripeBefore } },
      'evaluated_at',
    )) || [];
    // Never tried first, then least recently tried, oldest decision first within each.
    const pending = candidates
      .filter((d) => Date.parse(d.evaluated_at) + outcomeRipeHours(intervalOf(d)) * HOUR <= now)
      .sort((a, b) => String(a.outcome_tried_at ?? '').localeCompare(String(b.outcome_tried_at ?? ''))
        || String(a.evaluated_at).localeCompare(String(b.evaluated_at)))
      .slice(0, MAX_PER_RUN);
    if (!pending.length) {
      return Response.json({ success: true, resolved: 0, pending: 0, purged: purged?.count ?? 0 });
    }

    // TP/SL from the account settings, read-only, so outcomes speak the same
    // language as the trades the legacy engine actually takes.
    const settingsRows = (await base44.asServiceRole.entities.AutoTradingSettings.list()) || [];
    const settings = settingsRows[0] || {};
    const targets = {
      takeProfitPercent: settings.take_profit_percent ?? 8,
      stopLossPercent: settings.stop_loss_percent ?? 3,
    };

    // Group by symbol AND interval: outcomes are measured on the decision's own bars.
    const groups = new Map();
    for (const d of pending) {
      const interval = intervalOf(d);
      const key = `${d.symbol}|${interval}`;
      if (!groups.has(key)) groups.set(key, { symbol: d.symbol, interval, decisions: [] });
      groups.get(key).decisions.push(d);
    }

    const updates = [];
    const failures = [];
    let unripe = 0;
    const triedAt = new Date(now).toISOString();
    const tried = (decisions) => {
      for (const d of decisions) updates.push({ id: d.id, data: { outcome_tried_at: triedAt } });
    };

    for (const { symbol, interval, decisions } of groups.values()) {
      const oldest = Math.min(...decisions.map((d) => Date.parse(d.evaluated_at)));
      const barMs = BAR_HOURS[interval] * HOUR;

      let candles;
      try {
        candles = oldest >= now - RECENT_BARS * barMs
          ? await fetchCandles(symbol, interval, 300)
          : await fetchHistoricalCandles(symbol, interval, oldest - 2 * barMs, now);
      } catch (e) {
        failures.push(`${symbol}: ${e.message}`);
        tried(decisions);
        continue;
      }
      if (!candles?.length) { failures.push(`${symbol}: no candles`); tried(decisions); continue; }

      for (const d of decisions) {
        const outcome = computeOutcome(candles, Date.parse(d.evaluated_at), targets, interval);
        if (!outcome) { unripe++; tried([d]); continue; }
        updates.push({ id: d.id, data: { outcome: { ...outcome, resolved_at: new Date().toISOString() } } });
      }
    }

    const resolved = updates.filter((u) => u.data.outcome).length;
    if (updates.length) await base44.asServiceRole.entities.CommitteeDecision.bulkUpdate(updates);

    console.log(`[resolveCommitteeOutcomes] resolved ${resolved}, unripe ${unripe}, ` +
      `groups ${groups.size}, failures ${failures.length}, purged ${purged?.count ?? 0}`);
    return Response.json({
      success: true,
      resolved,
      purged: purged?.count ?? 0,
      unripe,
      groups: groups.size,
      failures: failures.slice(0, 20),
    });
  } catch (error) {
    console.error('[resolveCommitteeOutcomes] error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
