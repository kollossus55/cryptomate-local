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
 */

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
    const newTrades: any[] = [];
    for (const strategy of LAB_STRATEGIES) {
      const row = accounts.get(strategy.id);
      // Without fresh candles, only stops and marking run (no decision possible).
      const market = { candles: due && candles.get('BTCUSDT') ? candles : new Map(), prices };
      const { id, created_date, updated_date, created_by, ...state } = row;
      const { account, trades, decided } = runLabStep({ account: structuredClone(state), strategy, market, now });
      await Accounts.update(id, account);
      newTrades.push(...trades);
      summary.push({ strategy: strategy.id, equity: Math.round(account.last_equity), positions: Object.keys(account.positions).length, trades: trades.length, decided });
    }
    if (newTrades.length) await Trades.bulkCreate(newTrades);

    for (const s of summary) {
      console.log(`[strategyLab] ${s.strategy}: equity $${s.equity}, ${s.positions} open, ${s.trades} fills${s.decided ? ' (daily decision)' : ''}`);
    }
    return Response.json({ success: true, summary });
  } catch (error) {
    console.error('[strategyLab] failed:', error);
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
