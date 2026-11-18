// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
// LOCAL CHANGE (strategy lab): two daily paper strategies run side by side,
// each in its own virtual $10,000 account, completely separate from the main
// auto-trader's Portfolio, Trade records and risk settings. Paper only — this
// module never talks to an exchange; it only decides and books paper fills.
//
// Both strategies are the exact rules that were walk-forward tested
// (scripts/trend-test.mjs, scripts/composite-walk.mjs), so live paper results
// can be compared with the backtest:
//
//   trend_btc_eth    Hold BTC and ETH (half each) while the daily close is
//                    above its 100-day average; cash otherwise. No stop.
//   composite_daily  SP500-AI composite on daily candles of 20 large caps.
//                    Buy when all 6 sub-indicators are bullish, sell when
//                    fewer than 3 are (the live "bearish confluence exit"),
//                    no fixed take-profit. Stop at 2x ATR (3% floor, skip if
//                    over 12%), risk 1% per trade, max 10% per position,
//                    max 5 positions — the backtester's sizing.
//
// Pure: callers pass candles, prices and the clock in; nothing here fetches.
import { compositeComponent } from './signalEngine.js';
import { atr } from './indicators.js';
import { applyCosts } from './costs.js';

export const LAB_START_CAPITAL = 10000;
export const LAB_EXCHANGE = 'okx';
export const DAY_MS = 864e5;
// OKX daily candles open/close at Hong Kong midnight = 16:00 UTC.
export const DAILY_BAR_OFFSET_MS = 16 * 3600e3;
export const LAB_LOOKBACK_DAYS = 260;

export const LARGE_CAPS = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'DOGE', 'ADA', 'LINK', 'AVAX', 'LTC',
  'TRX', 'DOT', 'BCH', 'XLM', 'UNI', 'ATOM', 'ETC', 'FIL', 'NEAR', 'AAVE'].map((b) => `${b}USDT`);

export const LAB_STRATEGIES = [
  {
    id: 'trend_btc_eth',
    name: 'Trend: BTC & ETH above 100-day average',
    kind: 'trend',
    universe: ['BTCUSDT', 'ETHUSDT'],
    smaDays: 100,
    driftBand: 0.25,
  },
  {
    id: 'composite_daily',
    name: 'SP500 AI composite (daily, all 6 agree)',
    kind: 'composite',
    universe: LARGE_CAPS,
    enterVotes: 6,
    exitBelowVotes: 3,
    signalBars: 200,
    maxPositions: 5,
    riskPerTradePercent: 1,
    maxPositionPercent: 10,
    atrMultiplier: 2,
    minStopPercent: 3,
    maxStopPercent: 12,
  },
];

export const LAB_UNIVERSE = [...new Set(LAB_STRATEGIES.flatMap((s) => s.universe))];

// All six composite members vote, regardless of the user's AISignalConfig —
// the lab tests the composite itself, not the user's current toggles.
const ALL_SIX = { sp500ai_ha: true, sp500ai_ssl: true, sp500ai_cmo: true, sp500ai_airsi: true, sp500ai_tmo: true, sp500ai_mf: true };

/** Open time of the most recent daily bar that has fully closed at `now`. */
export function latestClosedDailyBar(now) {
  return Math.floor((now - DAILY_BAR_OFFSET_MS) / DAY_MS) * DAY_MS + DAILY_BAR_OFFSET_MS - DAY_MS;
}

export function newLabAccount(strategy, { now, btcPrice = null }) {
  return {
    strategy_id: strategy.id,
    name: strategy.name,
    started_at: new Date(now).toISOString(),
    starting_capital: LAB_START_CAPITAL,
    cash: LAB_START_CAPITAL,
    positions: {},
    last_decision_bar: null,
    equity_history: [],
    last_equity: LAB_START_CAPITAL,
    peak_equity: LAB_START_CAPITAL,
    max_drawdown_percent: 0,
    realized_pnl: 0,
    total_fees: 0,
    trade_count: 0,
    benchmark_btc_start: btcPrice,
  };
}

export function compositeVotes(closedCandles, bars = 200) {
  const window = closedCandles.slice(-bars);
  const c = compositeComponent(window, ALL_SIX);
  return c ? { bullCount: c.bullCount, total: c.total, bullish: c.votes.filter((v) => v.bull).map((v) => v.name) } : null;
}

function sma(candles, n) {
  if (candles.length < n) return null;
  let a = 0;
  for (let i = candles.length - n; i < candles.length; i++) a += candles[i].close;
  return a / n;
}

export function accountEquity(account, prices) {
  let v = account.cash;
  for (const p of Object.values(account.positions)) v += p.quantity * (prices.get(p.symbol) ?? p.last_price ?? p.entry_price);
  return v;
}

function fill(account, { symbol, side, quoteAmount, price, quoteVolume24h, reason, now, extra = {} }) {
  const costs = applyCosts({ side, intendedPrice: price, quoteAmount, exchange: LAB_EXCHANGE, quoteVolume24h });
  const at = new Date(now).toISOString();
  if (side === 'buy') {
    const quantity = quoteAmount / costs.fillPrice;
    account.cash -= quoteAmount + costs.fee;
    account.total_fees += costs.fee;
    const prev = account.positions[symbol];
    if (prev) {
      // top-up (trend rebalance): weighted average entry
      const q = prev.quantity + quantity;
      prev.entry_price = (prev.entry_price * prev.quantity + costs.fillPrice * quantity) / q;
      prev.quantity = q;
      prev.entry_fees += costs.fee;
    } else {
      account.positions[symbol] = { symbol, quantity, entry_price: costs.fillPrice, entry_time: at, entry_fees: costs.fee, last_price: price, ...extra };
      account.trade_count++;
    }
    return { strategy_id: account.strategy_id, symbol, side, quantity, price: costs.fillPrice, quote_amount: quoteAmount, fee: costs.fee, reason, executed_at: at, ...extra };
  }
  const pos = account.positions[symbol];
  const quantity = Math.min(pos.quantity, quoteAmount / price);
  const proceeds = quantity * costs.fillPrice;
  const share = quantity / pos.quantity;
  const entryFees = pos.entry_fees * share;
  const pnl = quantity * (costs.fillPrice - pos.entry_price) - entryFees - costs.fee;
  account.cash += proceeds - costs.fee;
  account.total_fees += costs.fee;
  account.realized_pnl += pnl;
  pos.quantity -= quantity;
  pos.entry_fees -= entryFees;
  if (pos.quantity * price < 1) delete account.positions[symbol];
  return {
    strategy_id: account.strategy_id, symbol, side, quantity, price: costs.fillPrice, quote_amount: proceeds, fee: costs.fee, reason,
    executed_at: at, entry_price: pos.entry_price, entry_time: pos.entry_time,
    pnl, pnl_percent: ((costs.fillPrice / pos.entry_price) - 1) * 100,
  };
}

/** Stops are checked every run against the latest price (composite only). */
function checkStops(account, strategy, market, now) {
  const trades = [];
  if (strategy.kind !== 'composite') return trades;
  for (const pos of Object.values({ ...account.positions })) {
    const price = market.prices.get(pos.symbol);
    if (!price || !pos.stop_price || price > pos.stop_price) continue;
    const last = market.candles.get(pos.symbol)?.at(-1);
    trades.push(fill(account, { symbol: pos.symbol, side: 'sell', quoteAmount: pos.quantity * price, price, quoteVolume24h: last?.quoteVolume, reason: `Stop hit (${pos.stop_price.toPrecision(6)})`, now }));
  }
  return trades;
}

function decideTrend(account, strategy, market, now) {
  const trades = [];
  const equity = accountEquity(account, market.prices);
  const eligible = strategy.universe.filter((s) => (market.candles.get(s)?.length ?? 0) >= strategy.smaDays && market.prices.get(s));
  const w = eligible.length ? 1 / eligible.length : 0;
  const plan = [];
  for (const s of eligible) {
    const c = market.candles.get(s), close = c.at(-1).close, avg = sma(c, strategy.smaDays);
    const on = close > avg;
    const price = market.prices.get(s);
    const cur = (account.positions[s]?.quantity ?? 0) * price;
    const tgt = on ? w * equity : 0;
    const why = `close ${close.toPrecision(6)} ${on ? '>' : '<='} 100d avg ${avg.toPrecision(6)}`;
    if ((cur > 0) !== (tgt > 0) || (tgt > 0 && Math.abs(cur - tgt) > strategy.driftBand * tgt)) plan.push({ s, price, diff: tgt - cur, why, vol: c.at(-1).quoteVolume });
  }
  for (const p of plan.sort((a, b) => a.diff - b.diff)) {   // sells first
    if (p.diff < 0) trades.push(fill(account, { symbol: p.s, side: 'sell', quoteAmount: -p.diff, price: p.price, quoteVolume24h: p.vol, reason: account.positions[p.s] && -p.diff < account.positions[p.s].quantity * p.price * 0.99 ? `Rebalance: ${p.why}` : `Trend off: ${p.why}`, now }));
    else {
      const amt = Math.min(p.diff, account.cash / 1.003);
      if (amt >= 10) trades.push(fill(account, { symbol: p.s, side: 'buy', quoteAmount: amt, price: p.price, quoteVolume24h: p.vol, reason: account.positions[p.s] ? `Rebalance: ${p.why}` : `Trend on: ${p.why}`, now }));
    }
  }
  return trades;
}

function decideComposite(account, strategy, market, now) {
  const trades = [];
  const votesBy = new Map();
  for (const s of strategy.universe) {
    const c = market.candles.get(s);
    if (!c || c.length < 60) continue;
    const v = compositeVotes(c, strategy.signalBars);
    if (v) votesBy.set(s, v);
  }
  // exits first
  for (const pos of Object.values({ ...account.positions })) {
    const v = votesBy.get(pos.symbol), price = market.prices.get(pos.symbol);
    if (!v || !price || v.bullCount >= strategy.exitBelowVotes) continue;
    trades.push(fill(account, { symbol: pos.symbol, side: 'sell', quoteAmount: pos.quantity * price, price, quoteVolume24h: market.candles.get(pos.symbol).at(-1).quoteVolume, reason: `Composite ${v.bullCount}/${v.total} bullish — below ${strategy.exitBelowVotes}`, now }));
  }
  // entries
  const equity = accountEquity(account, market.prices);
  const cands = [...votesBy.entries()]
    .filter(([s, v]) => v.bullCount >= strategy.enterVotes && !account.positions[s] && market.prices.get(s))
    .sort((a, b) => market.candles.get(b[0]).at(-1).quoteVolume - market.candles.get(a[0]).at(-1).quoteVolume);
  for (const [s, v] of cands) {
    if (Object.keys(account.positions).length >= strategy.maxPositions) break;
    const c = market.candles.get(s), price = market.prices.get(s), a = atr(c);
    if (!a) continue;
    let stopPct = (a * strategy.atrMultiplier / c.at(-1).close) * 100;
    if (stopPct > strategy.maxStopPercent) continue;              // too volatile — skip, as tested
    stopPct = Math.max(stopPct, strategy.minStopPercent);
    const amt = Math.min(equity * strategy.riskPerTradePercent / 100 / (stopPct / 100), equity * strategy.maxPositionPercent / 100, account.cash * 0.95);
    if (amt < 10) continue;
    trades.push(fill(account, { symbol: s, side: 'buy', quoteAmount: amt, price, quoteVolume24h: c.at(-1).quoteVolume, now,
      reason: `Composite ${v.bullCount}/${v.total} bullish (${v.bullish.join(', ')})`,
      extra: { stop_price: price * (1 - stopPct / 100), stop_percent: stopPct } }));
  }
  return trades;
}

/**
 * One scheduler tick for one strategy. `market` = { candles: Map(symbol -> closed
 * daily candles, oldest first), prices: Map(symbol -> latest price) }. Daily
 * decisions run once per newly closed bar; stops and marking run every tick.
 * Mutates and returns the account.
 */
export function runLabStep({ account, strategy, market, now }) {
  const trades = checkStops(account, strategy, market, now);
  const bar = market.candles.get('BTCUSDT')?.at(-1)?.openTime ?? null;
  let decided = false;
  if (bar && bar !== account.last_decision_bar) {
    trades.push(...(strategy.kind === 'trend' ? decideTrend : decideComposite)(account, strategy, market, now));
    account.last_decision_bar = bar;
    decided = true;
  }
  for (const p of Object.values(account.positions)) if (market.prices.get(p.symbol)) p.last_price = market.prices.get(p.symbol);
  const equity = accountEquity(account, market.prices);
  account.last_equity = equity;
  account.last_marked_at = new Date(now).toISOString();
  if (market.prices.get('BTCUSDT')) account.last_btc_price = market.prices.get('BTCUSDT');
  account.peak_equity = Math.max(account.peak_equity, equity);
  account.max_drawdown_percent = Math.max(account.max_drawdown_percent, (1 - equity / account.peak_equity) * 100);
  if (decided) {
    account.equity_history = [...account.equity_history, {
      date: new Date(bar + DAY_MS).toISOString(), equity: Math.round(equity * 100) / 100,
      btc: market.prices.get('BTCUSDT') ?? null, positions: Object.keys(account.positions).length,
    }].slice(-2000);
  }
  return { account, trades, decided };
}
