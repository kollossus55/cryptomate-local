import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

import { fetchHistoricalCandles, fetchPricesForSymbols } from './shared/marketData.js';
import { createMarketHub, estimateSlippage } from './shared/v6Exchanges.js';
import {
  LAB_STRATEGIES, LAB_UNIVERSE, LAB_LOOKBACK_DAYS, DAY_MS,
  latestClosedDailyBar, newLabAccount, runLabStep,
  volumeSnapshot, recordVolumeSnapshot, screenDue, volumeCandidates, applyScreen,
} from './shared/strategyLab.js';

/**
 * LOCAL CHANGE (strategy lab) — Strategy Lab Worker.
 *
 * Runs the paper strategies in shared/trading/strategyLab.js side by side,
 * each in its own virtual account (StrategyLabAccount), logging fills to
 * StrategyLabTrade. Hourly from the local scheduler: every run marks equity
 * and checks stops (and the exposure account's floor) at the latest price;
 * the daily decisions run once per newly closed daily candle (OKX daily bars
 * close at 16:00 UTC).
 *
 * The market exposure account (docs/rebuild/exposure-account.md) also takes a
 * volume snapshot across the 8 venues once per closed daily candle, and
 * re-screens its coins when a screen is due. Those calls are public, unsigned
 * reads.
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

/** Open time of Binance's first daily candle for a symbol, or null if it is not listed there. */
async function firstBinanceDailyBar(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=0&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? Number(rows[0][0]) : null;
  } catch {
    return null;
  }
}

/**
 * Once per closed daily candle, before the exposure account's step: a volume
 * snapshot, then the screen when one is due. Mutates `state`; returns notes.
 */
async function prepareExposure(state: any, strategy: any, { now, bar }: { now: number; bar: number }) {
  const rules = strategy.rules;
  const notes: string[] = [];
  const hub = createMarketHub();
  try {
    const rows = await hub.universe({ topN: 2000, minQuoteVolume: 1, minVenues: 1 });
    recordVolumeSnapshot(state, bar, volumeSnapshot(rows, rules), rules);
    if (rows.meta?.failed?.length) notes.push(`venues failed in snapshot: ${rows.meta.failed.map((f: any) => f.venue ?? f).join(', ')}`);
  } catch (e) {
    notes.push(`volume snapshot failed: ${(e as Error).message}`);
  }
  if (!screenDue(state, bar, rules)) return notes;
  // A screen with no snapshot would leave the account empty for 91 days.
  if (!(state.volume_log || []).length) {
    notes.push('screen postponed: no volume snapshot yet');
    return notes;
  }
  const candidates = volumeCandidates(state, rules);
  const checks = new Map();
  for (const { base } of candidates) {
    const symbol = `${base}USDT`;
    const c: any = { firstBinanceBar: await firstBinanceDailyBar(symbol) };
    try {
      const book = await hub.book(symbol, 50, { venue: 'okx' });
      const s = estimateSlippage(book, 'buy', rules.orderUsd);
      c.okxCostPct = s.complete ? s.slippagePct : null;
    } catch { /* not on OKX: fails C5 */ }
    try {
      const k = (await fetchHistoricalCandles(symbol, '1d', now - LAB_LOOKBACK_DAYS * DAY_MS, now)).filter((x: any) => x.closeTime < now);
      c.okxCandles = k.length;
      c.okxPrice = k.at(-1)?.close ?? null;
    } catch { /* fails C6 */ }
    checks.set(base, c);
  }
  applyScreen(state, candidates, checks, { bar, now, rules });
  notes.push(`screened ${candidates.length} candidates: members ${state.members.map((s: string) => s.replace('USDT', '')).join(', ') || 'none'}`);
  return notes;
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

    // Working copies, without the store's own fields and the outbox.
    const states = new Map(LAB_STRATEGIES.map((s) => {
      const { id, created_date, updated_date, created_by, pending_trades: _p, ...state } = accounts.get(s.id);
      return [s.id, structuredClone(state)];
    }));

    // Only fetch daily candles when some account has not yet decided on the latest closed bar.
    const dueBar = latestClosedDailyBar(now);
    const due = LAB_STRATEGIES.some((s) => states.get(s.id).last_decision_bar !== dueBar);

    const exposure = LAB_STRATEGIES.filter((x) => x.kind === 'exposure');
    const notes: string[] = [];
    for (const s of exposure) {
      const state = states.get(s.id);
      if (state.last_decision_bar !== dueBar && !state.floored_at) {
        notes.push(...(await prepareExposure(state, s, { now, bar: dueBar })).map((n) => `${s.id}: ${n}`));
      }
    }

    // Exposure members and holdings come from the account, not from LAB_UNIVERSE.
    const extra = new Set<string>();
    for (const s of exposure) {
      const state = states.get(s.id);
      for (const sym of [...(state.members || []), ...Object.keys(state.positions || {})]) if (!LAB_UNIVERSE.includes(sym)) extra.add(sym);
    }
    if (extra.size) {
      for (const [sym, p] of await fetchPricesForSymbols([...extra])) prices.set(sym, p);
    }
    const candles = due ? await fetchDailyCandles([...LAB_UNIVERSE, ...extra], now) : new Map();

    const summary: any[] = [];
    for (const strategy of LAB_STRATEGIES) {
      const id = accounts.get(strategy.id).id;
      // Without fresh candles, only stops, the floor and marking run (no decision possible).
      const market = { candles: due && candles.get('BTCUSDT') ? candles : new Map(), prices };
      const { account, trades, decided } = runLabStep({ account: states.get(strategy.id), strategy, market, now });
      const pending = trades.map((t: any, i: number) => ({ ...t, id: t.id || `lab-${strategy.id}-${now}-${i}` }));
      const saved = await Accounts.update(id, { ...account, pending_trades: pending });
      await flushPendingTrades(Accounts, Trades, saved);
      summary.push({ strategy: strategy.id, equity: Math.round(account.last_equity), positions: Object.keys(account.positions).length, trades: trades.length, decided });
    }

    for (const n of notes) console.log(`[strategyLab] ${n}`);
    for (const s of summary) {
      console.log(`[strategyLab] ${s.strategy}: equity $${s.equity}, ${s.positions} open, ${s.trades} fills${s.decided ? ' (daily decision)' : ''}`);
    }
    return Response.json({ success: true, summary, notes });
  } catch (error) {
    console.error('[strategyLab] failed:', error);
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
