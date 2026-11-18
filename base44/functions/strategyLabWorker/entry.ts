import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

import { fetchHistoricalCandles, fetchPricesForSymbols } from './shared/marketData.js';
import {
  LAB_STRATEGIES, LAB_UNIVERSE, LAB_LOOKBACK_DAYS, DAY_MS,
  latestClosedDailyBar, newLabAccount, runLabStep,
} from './shared/strategyLab.js';

/**
 * LOCAL CHANGE (strategy lab) — Strategy Lab Worker.
 *
 * Runs the two daily paper strategies in shared/trading/strategyLab.js side by
 * side, each in its own virtual account (StrategyLabAccount), logging fills to
 * StrategyLabTrade. Hourly from the local scheduler: every run marks equity
 * and checks stops at the latest price; the daily buy/sell decisions run once
 * per newly closed daily candle (OKX daily bars close at 16:00 UTC).
 *
 * Fully separate from the main auto-trader: it never reads or writes
 * Portfolio, Trade, AutoTradingSettings or risk settings, and never places an
 * exchange order. Paper only.
 *
 * Fills go out through an outbox: each account's new fills are saved in the
 * same write as its new positions and cash (pending_trades), then created
 * with fixed ids and cleared. A run that fails in between is finished by the
 * next one, and a fill that already exists is never written twice.
 */

async function flushPendingTrades(Accounts: any, Trades: any, account: any) {
  const pending = account.pending_trades || [];
  if (!pending.length) return account;
  const existing = new Set(((await Trades.filter({ id: { $in: pending.map((t: any) => t.id) } })) || []).map((t: any) => t.id));
  const missing = pending.filter((t: any) => !existing.has(t.id));
  if (missing.length) await Trades.bulkCreate(missing);
  return await Accounts.update(account.id, { pending_trades: [] });
}

async function fetchDailyCandles(symbols: string[], now: number) {
  // Uncached on purpose: the shared candle cache refreshes at UTC midnight,
  // eight hours after OKX's daily close.
  const out = new Map();
  for (const s of symbols) {
    try {
      const c = (await fetchHistoricalCandles(s, '1d', now - LAB_LOOKBACK_DAYS * DAY_MS, now))
        .filter((x: any) => x.closeTime < now)
        .sort((a: any, b: any) => a.openTime - b.openTime);
      if (c.length) out.set(s, c);
    } catch (e) {
      console.warn(`[strategyLab] candles failed for ${s}: ${(e as Error).message}`);
    }
  }
  return out;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') {
      return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    const now = Date.now();
    const Accounts = base44.asServiceRole.entities.StrategyLabAccount;
    const Trades = base44.asServiceRole.entities.StrategyLabTrade;

    const prices = await fetchPricesForSymbols(LAB_UNIVERSE);
    if (!prices.get('BTCUSDT')) {
      return Response.json({ success: false, error: 'No live prices available' }, { status: 502 });
    }

    const rows = (await Accounts.list()) || [];
    const accounts = new Map(rows.map((r: any) => [r.strategy_id, r]));
    // Fills a failed run left behind, before anything new is decided.
    for (const [sid, r] of accounts) accounts.set(sid, await flushPendingTrades(Accounts, Trades, r));
    for (const s of LAB_STRATEGIES) {
      if (!accounts.has(s.id)) {
        const created = await Accounts.create(newLabAccount(s, { now, btcPrice: prices.get('BTCUSDT') }));
        accounts.set(s.id, created);
      }
    }

    // Only fetch daily candles when some account has not yet decided on the latest closed bar.
    const dueBar = latestClosedDailyBar(now);
    const due = LAB_STRATEGIES.some((s) => accounts.get(s.id).last_decision_bar !== dueBar);
    const candles = due ? await fetchDailyCandles(LAB_UNIVERSE, now) : new Map();

    const summary: any[] = [];
    for (const strategy of LAB_STRATEGIES) {
      const row = accounts.get(strategy.id);
      // Without fresh candles, only stops and marking run (no decision possible).
      const market = { candles: due && candles.get('BTCUSDT') ? candles : new Map(), prices };
      const { id, created_date, updated_date, created_by, pending_trades: _p, ...state } = row;
      const { account, trades, decided } = runLabStep({ account: structuredClone(state), strategy, market, now });
      const pending = trades.map((t: any, i: number) => ({ ...t, id: t.id || `lab-${strategy.id}-${now}-${i}` }));
      const saved = await Accounts.update(id, { ...account, pending_trades: pending });
      await flushPendingTrades(Accounts, Trades, saved);
      summary.push({ strategy: strategy.id, equity: Math.round(account.last_equity), positions: Object.keys(account.positions).length, trades: trades.length, decided });
    }

    for (const s of summary) {
      console.log(`[strategyLab] ${s.strategy}: equity $${s.equity}, ${s.positions} open, ${s.trades} fills${s.decided ? ' (daily decision)' : ''}`);
    }
    return Response.json({ success: true, summary });
  } catch (error) {
    console.error('[strategyLab] failed:', error);
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
