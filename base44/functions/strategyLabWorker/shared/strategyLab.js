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
//   exposure_screened Market exposure, no edge claimed: a screened basket of
//                    large liquid coins, inverse-vol weights scaled to a 20%
//                    annual vol target, weekly rebalance, permanent floor at
//                    70% of the start. Rules: docs/rebuild/exposure-account.md.
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

// Fixed by docs/rebuild/exposure-account.md (pre-registered 2026-11-18). Change them
// only by adding a row to that doc's Changes table first.
export const EXPOSURE_RULES = Object.freeze({
  minVenues: 4,               // C2
  minVolumeUsd: 100e6,        // C3: median of the daily snapshots
  volumeDays: 30,             // C3: snapshots kept
  snapshotMinUsd: 10e6,       // coins below this are left out of a snapshot
  historyDays: 1095,          // C4: Binance daily history
  orderUsd: 10000,            // C5
  maxCostPct: 0.10,           // C5
  minCandles: 60,             // C6
  maxMembers: 15,
  screenEveryDays: 91,
  rebalanceEveryDays: 7,
  volDays: 60,
  volTarget: 0.20,
  band: 0.25,
  minTradeUsd: 25,
  floorFraction: 0.70,
});

LAB_STRATEGIES.push({
  id: 'exposure_screened',
  name: 'Market exposure: screened coins, 20% vol target',
  kind: 'exposure',
  // Members come from the account's own screen, not from this list.
  universe: [],
  rules: EXPOSURE_RULES,
});

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
    ...(strategy.kind === 'exposure' ? {
      members: [], volume_log: [], screen_log: [], last_screen_bar: null,
      last_rebalance_bar: null, rebalance_pending: false, floored_at: null,
    } : {}),
  };
}

// ---------- market exposure account ----------

const median0 = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** One day's volumes from the market hub's universe rows: C1 is applied by the hub, C2 here. */
export function volumeSnapshot(universeRows, rules = EXPOSURE_RULES) {
  const vols = {};
  for (const r of universeRows || []) {
    if ((r.venues?.length ?? 0) < rules.minVenues || r.priceConflict) continue;
    if (!(r.quoteVolume >= rules.snapshotMinUsd)) continue;
    vols[r.base] = Math.round(r.quoteVolume);
  }
  return vols;
}

/** Keeps the latest `volumeDays` snapshots, one per daily bar. */
export function recordVolumeSnapshot(account, bar, vols, rules = EXPOSURE_RULES) {
  const log = (account.volume_log || []).filter((e) => e.bar !== bar);
  account.volume_log = [...log, { bar, vols }].sort((a, b) => a.bar - b.bar).slice(-rules.volumeDays);
  return account;
}

export function screenDue(account, bar, rules = EXPOSURE_RULES) {
  return account.last_screen_bar == null || bar - account.last_screen_bar >= rules.screenEveryDays * DAY_MS;
}

/** C3: median across the kept snapshots, a missing day counting as zero. Highest first. */
export function volumeCandidates(account, rules = EXPOSURE_RULES) {
  const log = account.volume_log || [];
  if (!log.length) return [];
  const bases = new Set(log.flatMap((e) => Object.keys(e.vols)));
  return [...bases]
    .map((base) => ({ base, medianVolume: median0(log.map((e) => e.vols[base] ?? 0)) }))
    .filter((c) => c.medianVolume >= rules.minVolumeUsd)
    .sort((a, b) => b.medianVolume - a.medianVolume);
}

/**
 * C4 to C6 on the C3 candidates, then the member cap. `checks` maps base to
 * { firstBinanceBar, okxCostPct, okxCandles, okxPrice }; a missing value fails its rule.
 */
export function applyScreen(account, candidates, checks, { bar, now, rules = EXPOSURE_RULES }) {
  const rows = candidates.map(({ base, medianVolume }) => {
    const c = checks.get(base) || {};
    const failed = [];
    if (!(Number.isFinite(c.firstBinanceBar) && now - c.firstBinanceBar >= rules.historyDays * DAY_MS)) failed.push('C4');
    if (!(Number.isFinite(c.okxCostPct) && c.okxCostPct <= rules.maxCostPct)) failed.push('C5');
    if (!((c.okxCandles ?? 0) >= rules.minCandles && c.okxPrice > 0)) failed.push('C6');
    return { base, medianVolume: Math.round(medianVolume), failed };
  });
  const passed = rows.filter((r) => !r.failed.length);
  passed.slice(rules.maxMembers).forEach((r) => r.failed.push('cap'));
  const members = passed.slice(0, rules.maxMembers).map((r) => `${r.base}USDT`);
  account.members = members;
  account.last_screen_bar = bar;
  account.rebalance_pending = true;
  account.screen_log = [...(account.screen_log || []), {
    bar, at: new Date(now).toISOString(), snapshots: (account.volume_log || []).length, members, rows,
  }].slice(-20);
  return account;
}

/**
 * Target weights: 1/vol per member, scaled so the basket's vol (with correlations,
 * annualised over 365 days) is at most the target. Never more than 100% in total.
 */
export function exposureTargets(members, candles, rules = EXPOSURE_RULES) {
  const need = rules.volDays + 1;
  const none = (usable) => ({ weights: new Map(), basketVol: null, scale: 0, usable });
  const usable = members.filter((s) => (candles.get(s)?.length ?? 0) >= need);
  if (!usable.length) return none(usable);
  // The same dates for every member, so the correlations line up.
  const common = usable.map((s) => new Set(candles.get(s).map((c) => c.openTime)))
    .reduce((a, b) => new Set([...a].filter((t) => b.has(t))));
  const times = [...common].sort((a, b) => a - b).slice(-need);
  if (times.length < need) return none(usable);
  const returns = usable.map((s) => {
    const byTime = new Map(candles.get(s).map((c) => [c.openTime, c.close]));
    const closes = times.map((t) => byTime.get(t));
    return closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  });
  const n = rules.volDays;
  const means = returns.map((r) => r.reduce((a, x) => a + x, 0) / n);
  const cov = (i, j) => returns[i].reduce((a, x, k) => a + (x - means[i]) * (returns[j][k] - means[j]), 0) / (n - 1);
  const vols = usable.map((_, i) => Math.sqrt(cov(i, i)));
  if (vols.some((v) => !(v > 0))) return none(usable);
  const inv = vols.map((v) => 1 / v);
  const sum = inv.reduce((a, x) => a + x, 0);
  const base = inv.map((x) => x / sum);
  let variance = 0;
  for (let i = 0; i < usable.length; i++) for (let j = 0; j < usable.length; j++) variance += base[i] * base[j] * cov(i, j);
  // Rounding can leave a fully hedged basket's variance a hair below zero.
  const basketVol = Math.sqrt(Math.max(0, variance) * 365);
  const scale = basketVol > 0 ? Math.min(1, rules.volTarget / basketVol) : 1;
  return { weights: new Map(usable.map((s, i) => [s, base[i] * scale])), basketVol, scale, usable };
}

/** Every run: at or below the floor, sell everything and stop for good. */
function checkFloor(account, strategy, market, now) {
  if (strategy.kind !== 'exposure') return [];
  const floor = account.starting_capital * strategy.rules.floorFraction;
  if (!account.floored_at && accountEquity(account, market.prices) > floor) return [];
  if (!account.floored_at) account.floored_at = new Date(now).toISOString();
  const trades = [];
  for (const pos of Object.values({ ...account.positions })) {
    const price = market.prices.get(pos.symbol);
    if (!price) continue; // sold on a later run, once a price returns
    trades.push(fill(account, { symbol: pos.symbol, side: 'sell', quoteAmount: pos.quantity * price, price,
      quoteVolume24h: market.candles.get(pos.symbol)?.at(-1)?.quoteVolume, reason: `Floor: equity at or below $${floor.toFixed(0)}, stopped for good`, now }));
  }
  return trades;
}

function decideExposure(account, strategy, market, now, bar) {
  const rules = strategy.rules;
  if (account.floored_at) return [];
  const due = account.rebalance_pending || account.last_rebalance_bar == null
    || bar - account.last_rebalance_bar >= rules.rebalanceEveryDays * DAY_MS;
  if (!due) return [];
  const members = account.members || [];
  const { weights, basketVol, scale } = exposureTargets(members, market.candles, rules);
  const equity = accountEquity(account, market.prices);
  const symbols = [...new Set([...members, ...Object.keys(account.positions)])];
  const plan = [];
  for (const s of symbols) {
    const price = market.prices.get(s);
    if (!price) continue;
    const isMember = members.includes(s);
    // A member without usable candles keeps what it holds rather than being sold on missing data.
    if (account.positions[s] && isMember && !weights.has(s)) continue;
    const cur = (account.positions[s]?.quantity ?? 0) * price;
    const tgt = (weights.get(s) ?? 0) * equity;
    const diff = tgt - cur;
    if (Math.abs(diff) < rules.minTradeUsd) continue;
    if ((cur > 0) === (tgt > 0) && Math.abs(diff) <= rules.band * tgt) continue;
    const why = !isMember ? 'left the universe'
      : `target ${((weights.get(s) ?? 0) * 100).toFixed(1)}% (basket vol ${(basketVol * 100).toFixed(0)}%, scale ${scale.toFixed(2)})`;
    plan.push({ s, price, diff, why, vol: market.candles.get(s)?.at(-1)?.quoteVolume });
  }
  const trades = [];
  for (const p of plan.sort((a, b) => a.diff - b.diff)) { // sells first
    if (p.diff < 0) {
      trades.push(fill(account, { symbol: p.s, side: 'sell', quoteAmount: -p.diff, price: p.price, quoteVolume24h: p.vol, reason: `Rebalance: ${p.why}`, now }));
    } else {
      const amt = Math.min(p.diff, account.cash / 1.003);
      if (amt >= rules.minTradeUsd) trades.push(fill(account, { symbol: p.s, side: 'buy', quoteAmount: amt, price: p.price, quoteVolume24h: p.vol, reason: `Rebalance: ${p.why}`, now }));
    }
  }
  account.last_rebalance_bar = bar;
  account.rebalance_pending = false;
  account.last_targets = { bar, basket_vol: basketVol, scale, weights: Object.fromEntries(weights) };
  return trades;
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
  const trades = [...checkStops(account, strategy, market, now), ...checkFloor(account, strategy, market, now)];
  const bar = market.candles.get('BTCUSDT')?.at(-1)?.openTime ?? null;
  let decided = false;
  if (bar && bar !== account.last_decision_bar) {
    const decide = { trend: decideTrend, composite: decideComposite, exposure: decideExposure }[strategy.kind];
    trades.push(...decide(account, strategy, market, now, bar));
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
