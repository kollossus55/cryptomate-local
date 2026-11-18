// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
/**
 * Agent Committee — phases 1-2 (shadow mode).
 *
 * Phase 2 adds three context agents that can VETO: Market Regime (BTC trend +
 * breadth; one-sided, never votes long), Derivatives (OKX funding, open
 * interest, long/short ratio) and Liquidity (spread, probe-size slippage, book
 * imbalance). It also adds computeOutcome() for the hourly outcome job and is
 * replayable through backtest.js (entryEngine: 'committee').
 *
 * Instead of one blended strength score, independent agents each cast a vote
 * (long / against / abstain) with their own reasons, and a coordinator opens a
 * long only when a quorum agrees, nobody vetoes, and the weighted committee
 * score clears a threshold. Design doc: "CryptoMate Agent Committee — Design".
 *
 * Phase 1 scope:
 *  - Four candle-based agents wrapping the existing signalEngine components:
 *    Trend (1h + derived 4h), Momentum, Volume/Flow, Structure.
 *  - The coordinator with veto, regime gating, quorum and score rules. No
 *    phase-1 agent has veto power yet; the path exists for phase 2's Market
 *    Regime, Derivatives and Liquidity agents.
 *  - SHADOW ONLY. The worker logs what the committee would have done next to
 *    what the legacy engine did. It never places, blocks or sizes a trade.
 *
 * Everything here is a pure function of its inputs: same candles and settings,
 * same decision. Risk controls (risk.js, sizing.js) are not referenced and not
 * changed — the committee can only ever decide WHETHER, never HOW MUCH.
 *
 * Lives flat in /shared/trading (not an agents/ subfolder) because
 * scripts/sync-shared.mjs copies flat .js files only.
 */

import {
  detectRegime,
  trendComponent,
  momentumComponent,
  meanReversionComponent,
  volumeComponent,
  supplyDemandComponent,
  compositeComponent,
  MIN_CANDLES,
} from './signalEngine.js';
import { ema } from './indicators.js';
import { estimateFillFromBook } from './costs.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const COMMITTEE_MODES = ['off', 'shadow', 'live'];

export const DEFAULT_COMMITTEE_SETTINGS = Object.freeze({
  // 'live' is accepted but treated as 'shadow' until phase 3's go/no-go passes.
  mode: 'shadow',
  // Long votes needed. Capped at the number of eligible agents, never below
  // min_eligible. With phase 1's four agents this is close to unanimous; every
  // vote is logged, so other quorums can be replayed from the records.
  min_long_votes: 4,
  // More active dissents than this blocks the trade.
  max_against: 1,
  // Weighted committee score (0–1) needed to enter.
  min_score: 0.6,
  // Fewer eligible agents than this = no_quorum. Never trade on thin evidence.
  min_eligible: 3,
  // Per-agent weights; missing = 1.0.
  weights: {},
  // Per-agent on/off; missing = on.
  agents_enabled: {},

  // --- phase 2: veto thresholds (shape fixed here, values tuned in backtest) ---
  // Market Regime vetoes when BTC fell this much (%) over the last 4 hours...
  btc_drop_veto_pct: 3,
  // ...or when fewer than this share of scanned assets sit above their EMA50.
  // 0 = off (default). On 240d of 4h OKX data (train slice only) the legacy
  // signals this vetoed were the best in the sample: 320 signals over 63 days,
  // 54% win, +2.4%/trade, positive in 5 of 6 months. A washed-out market is
  // where alt reversals start, not a reason to stand aside.
  breadth_veto: 0,
  // Derivatives vetoes at this funding rate per 8h (0.0005 = 0.05%, ~5x the
  // 0.01% baseline): longs are crowded and pay to stay in.
  funding_veto: 0.0005,
  // Above this, funding counts against the trade without vetoing it.
  funding_warn: 0.0003,
  // Liquidity vetoes above this bid/ask spread (%)...
  max_spread_pct: 0.3,
  // ...or when a market buy of this many USDT cannot fill within the
  // slippage limit. A fixed probe, so the committee never depends on sizing.
  liquidity_probe_usdt: 1000,
  // At most this many assets per cycle get the extra OKX calls (derivatives +
  // order book), best candle pre-pass first. Keeps within OKX rate limits.
  context_fetch_budget: 40,

  // --- filter role ---
  // 'filter' (default): the legacy engine picks entries and the committee may
  // only BLOCK one (any veto, or block_against+ agents voting against).
  // 'replace': the committee picks entries itself (phases 1-2). On 4h OKX
  // history the candle agents picked no better than a random bar, while
  // legacy signals with 2+ against votes lost money — so the committee earns
  // its keep as an objector, not a selector.
  role: 'filter',
  // Eligible against votes that block a legacy entry in the filter role.
  block_against: 2,
});

export const COMMITTEE_ROLES = ['filter', 'replace'];

/** Days of CommitteeDecision records to keep. */
export const COMMITTEE_RETENTION_DAYS = 30;

export function resolveCommitteeSettings(raw) {
  const s = { ...DEFAULT_COMMITTEE_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!COMMITTEE_MODES.includes(s.mode)) s.mode = DEFAULT_COMMITTEE_SETTINGS.mode;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  s.min_long_votes = Math.max(1, Math.round(num(s.min_long_votes, 4)));
  s.max_against = Math.max(0, Math.round(num(s.max_against, 1)));
  s.min_score = Math.min(1, Math.max(0, num(s.min_score, 0.6)));
  s.min_eligible = Math.max(1, Math.round(num(s.min_eligible, 3)));
  s.weights = { ...(s.weights || {}) };
  s.agents_enabled = { ...(s.agents_enabled || {}) };
  const d = DEFAULT_COMMITTEE_SETTINGS;
  s.btc_drop_veto_pct = Math.max(0, num(s.btc_drop_veto_pct, d.btc_drop_veto_pct));
  s.breadth_veto = Math.min(1, Math.max(0, num(s.breadth_veto, d.breadth_veto)));
  s.funding_veto = num(s.funding_veto, d.funding_veto);
  s.funding_warn = num(s.funding_warn, d.funding_warn);
  s.max_spread_pct = Math.max(0, num(s.max_spread_pct, d.max_spread_pct));
  s.liquidity_probe_usdt = Math.max(10, num(s.liquidity_probe_usdt, d.liquidity_probe_usdt));
  s.context_fetch_budget = Math.max(0, Math.round(num(s.context_fetch_budget, d.context_fetch_budget)));
  if (!COMMITTEE_ROLES.includes(s.role)) s.role = d.role;
  s.block_against = Math.max(1, Math.round(num(s.block_against, d.block_against)));
  return s;
}

const INTERVAL_HOURS = { '15m': 0.25, '30m': 0.5, '1h': 1, '4h': 4, '1d': 24 };

/** Close price `hours` before the last bar, or null if history is too short. */
function closeHoursAgo(candles, hours, interval) {
  const per = INTERVAL_HOURS[interval];
  if (!per || !Array.isArray(candles)) return null;
  const bars = Math.round(hours / per);
  const c = candles[candles.length - 1 - bars];
  return c && Number.isFinite(c.close) ? c.close : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Component score at or above this votes long; at or below AGAINST_AT votes against. */
export const LONG_AT = 60;
export const AGAINST_AT = 40;

/**
 * The committee reads every indicator, independent of the user's legacy
 * indicator toggles — those toggles shape the legacy engine being compared
 * against, and an agent that silently loses its inputs is not independent.
 */
const ALL_INDICATORS = Object.freeze({
  rsi: true, macd: true, bollinger: true, ema: true, stoch: true,
  supply_demand: true, sp500ai: true,
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function lerp(v, inLo, inHi, outLo, outHi) {
  if (inHi === inLo) return outHi;
  const t = clamp((v - inLo) / (inHi - inLo), 0, 1);
  return outLo + t * (outHi - outLo);
}

const round2 = (v) => Math.round(v * 100) / 100;

function mean(values) {
  const ok = values.filter((v) => Number.isFinite(v));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

function abstain(agent, reason, extra = {}) {
  return { agent, vote: 'abstain', confidence: 0, veto: false, reasons: [reason], dataOk: true, score: null, ...extra };
}

function noData(agent, reason) {
  return { agent, vote: 'abstain', confidence: 0, veto: false, reasons: [reason], dataOk: false, score: null };
}

/**
 * Turn a 0–100 component score into a vote. Confidence starts at 0.5 at the
 * voting threshold and reaches 1.0 at 90 (long) or 10 (against), so every
 * long vote carries at least half weight into the committee score.
 */
export function voteFromScore(agent, score, reasons, extra = {}) {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return abstain(agent, 'No reading', extra);
  }
  const base = { agent, veto: false, reasons, dataOk: true, score: Math.round(score), ...extra };
  if (score >= LONG_AT) return { ...base, vote: 'long', confidence: round2(lerp(score, LONG_AT, 90, 0.5, 1)) };
  if (score <= AGAINST_AT) return { ...base, vote: 'against', confidence: round2(lerp(score, AGAINST_AT, 10, 0.5, 1)) };
  return { ...base, vote: 'abstain', confidence: 0 };
}

/** Base interval -> [higher-timeframe label, bars per HTF bar]. */
const HTF = { '15m': ['1h', 4], '30m': ['2h', 4], '1h': ['4h', 4], '4h': ['1d', 6] };

/**
 * Derive higher-timeframe bars from the base bars (1h -> 4h, 4h -> 1d, ...),
 * grouped from the most recent bar backwards. Lets the Trend agent read the
 * higher timeframe with no extra API calls. Null for an unmapped interval.
 */
export function deriveHigherTimeframe(candles, interval) {
  const spec = HTF[interval];
  if (!spec || !Array.isArray(candles)) return null;
  const n = spec[1];
  const out = [];
  for (let end = candles.length; end - n >= 0; end -= n) {
    const group = candles.slice(end - n, end);
    out.unshift({
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[n - 1].close,
      volume: group.reduce((a, c) => a + (c.volume || 0), 0),
      closeTime: group[n - 1].closeTime,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Market-wide context, built ONCE per cycle and shared by every asset:
 * BTC candles plus breadth (share of scanned assets above their EMA50).
 * Breadth is null with fewer than 10 assets — too few to call it a market.
 */
export function buildMarketContext(candlesBySymbol, btcCandles) {
  let above = 0;
  let total = 0;
  for (const candles of candlesBySymbol.values()) {
    if (!Array.isArray(candles) || candles.length < 50) continue;
    const e50 = ema(candles.map((c) => c.close), 50);
    if (e50 === null) continue;
    total++;
    if (candles[candles.length - 1].close > e50) above++;
  }
  return {
    btcCandles: Array.isArray(btcCandles) ? btcCandles : null,
    breadth: total >= 10 ? { above, total, share: round2(above / total) } : null,
  };
}

/**
 * Built once per asset per cycle and shared by every agent.
 *
 * `market`, `derivatives` and `orderBook` are optional: undefined means "not
 * fetched this cycle" and null means "fetched, unavailable". Either way the
 * agent that needs it abstains as no-data — it never guesses.
 */
export function buildContext({ symbol, candles, interval = '1h', market, derivatives, orderBook, limits }) {
  const regime = detectRegime(candles);
  return {
    symbol,
    interval,
    candles,
    candlesHTF: deriveHigherTimeframe(candles, interval),
    regime,
    market,
    derivatives,
    orderBook,
    limits: { maxSlippagePercent: 0.5, ...(limits || {}) },
    // The committee's own market label. Phase 2's Market Regime agent (BTC
    // context + breadth) replaces this asset-level reading and adds risk_off.
    marketRegime: regime.regime === 'range' ? 'range' : 'trend',
    price: candles[candles.length - 1]?.close ?? null,
  };
}

// ---------------------------------------------------------------------------
// Agents — each: (ctx) => vote. Pure, no I/O.
// ---------------------------------------------------------------------------

/** Trend: base-interval EMA stack, checked against the higher timeframe's EMA20 (1h->4h, 4h->1d). Only counts in a trending market. */
export function trendAgent(ctx) {
  const comp = trendComponent(ctx.candles, ctx.regime);
  if (!comp) return noData('trend', 'EMAs unavailable');

  let score = comp.score;
  const reasons = [...comp.reasons];
  const htf = ctx.candlesHTF;
  const htfLabel = HTF[ctx.interval]?.[0] || 'HTF';

  if (htf && htf.length >= 21) {
    const closes = htf.map((c) => c.close);
    const e = ema(closes, 20);
    const ePrev = ema(closes.slice(0, -1), 20);
    const price = closes[closes.length - 1];
    const htfUp = e !== null && ePrev !== null && price > e && e > ePrev;
    const htfDown = e !== null && ePrev !== null && price < e && e < ePrev;
    if (htfUp) {
      reasons.push(`${htfLabel}: price above rising EMA20`);
      if (score < 50) score = 50 + (score - 50) * 0.3;
    } else if (htfDown) {
      reasons.push(`${htfLabel}: price below falling EMA20`);
      if (score > 50) score = 50 + (score - 50) * 0.3;
    } else {
      reasons.push(`${htfLabel} trend mixed`);
      score = 50 + (score - 50) * 0.7;
    }
  } else {
    reasons.push('Higher-timeframe check unavailable');
  }

  return voteFromScore('trend', score, reasons, { eligibleIn: ['trend'] });
}

/** Momentum: MACD/RSI/Stochastic (regime-aware) averaged with the SP500-AI composite votes. */
export function momentumAgent(ctx) {
  const m = momentumComponent(ctx.candles, ALL_INDICATORS, ctx.regime);
  const c = compositeComponent(ctx.candles, ALL_INDICATORS);
  const score = mean([m?.score, c?.score]);
  if (score === null) return noData('momentum', 'Momentum indicators unavailable');
  return voteFromScore('momentum', score, [...(m?.reasons || []), ...(c?.reasons || [])]);
}

/** Bars of price change the Volume/Flow agent reads to tell buying from selling. */
export const FLOW_LOOKBACK = 5;

/**
 * Volume / Flow: relative volume and money flow, made directional.
 *
 * volumeComponent rewards a volume surge without asking which way price moved,
 * so heavy selling scored as bullish (seen on live OKX data: falling assets got
 * a long vote). Volume confirms the move it comes with — so when price has
 * fallen over the lookback, an above-neutral reading is mirrored into an
 * against vote (distribution), and a below-neutral one is left as is.
 */
export function volumeFlowAgent(ctx) {
  const v = volumeComponent(ctx.candles, ctx.regime);
  if (!v) return noData('volumeFlow', 'Volume data unavailable');
  const c = ctx.candles;
  const now = c[c.length - 1]?.close;
  const then = c[c.length - 1 - FLOW_LOOKBACK]?.close;
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) {
    return noData('volumeFlow', 'Price history too short for flow direction');
  }
  const change = (now - then) / then;
  const reasons = [...v.reasons];
  let score = v.score;
  if (change < 0 && score > 50) {
    score = 100 - score;
    reasons.push(`Price down ${(change * 100).toFixed(1)}% over ${FLOW_LOOKBACK} bars — volume is confirming selling`);
  } else {
    reasons.push(`Price ${change >= 0 ? 'up' : 'down'} ${(Math.abs(change) * 100).toFixed(1)}% over ${FLOW_LOOKBACK} bars`);
  }
  return voteFromScore('volumeFlow', score, reasons);
}

/**
 * Structure: supply/demand zones, plus mean reversion in a range only (in a
 * trend, fading the bands is how trend-followers lose money). Abstains when no
 * zone is nearby and the market is trending — that is "no opinion", not "no".
 */
export function structureAgent(ctx) {
  const sd = supplyDemandComponent(ctx.candles, ctx.regime);
  const mr = ctx.marketRegime === 'range'
    ? meanReversionComponent(ctx.candles, ALL_INDICATORS, ctx.regime)
    : null;
  const score = mean([sd?.score, mr?.score]);
  if (score === null) return abstain('structure', 'No zone nearby and not in a range');
  return voteFromScore('structure', score, [...(sd?.reasons || []), ...(mr?.reasons || [])]);
}

// ---------------------------------------------------------------------------
// Phase 2 agents — read data beyond the asset's own candles, and can veto.
// They take settings because their veto thresholds are configurable.
// ---------------------------------------------------------------------------

/**
 * Market Regime: BTC trend and market breadth. One market-wide reading, so it
 * casts the same vote for every asset in a cycle.
 * Veto: BTC down btc_drop_veto_pct over 4 hours, or breadth below breadth_veto.
 */
export function marketRegimeAgent(ctx, s) {
  const btc = ctx.market?.btcCandles;
  if (!btc || btc.length < 60) return noData('marketRegime', 'BTC candles unavailable');

  const closes = btc.map((c) => c.close);
  const price = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const back = closeHoursAgo(btc, 4, ctx.interval) ?? closes[closes.length - 2];
  const chg4 = back ? (price - back) / back : 0;
  const breadth = ctx.market.breadth;
  const reasons = [];

  if (chg4 * 100 <= -s.btc_drop_veto_pct) {
    return {
      agent: 'marketRegime', vote: 'against', confidence: 1, dataOk: true, score: 0,
      veto: { reason: `BTC down ${(chg4 * 100).toFixed(1)}% over 4h` },
      reasons: [`BTC down ${(chg4 * 100).toFixed(1)}% over 4h — risk-off`],
    };
  }
  if (breadth && s.breadth_veto > 0 && breadth.share < s.breadth_veto) {
    return {
      agent: 'marketRegime', vote: 'against', confidence: 1, dataOk: true, score: 0,
      veto: { reason: `Breadth ${(breadth.share * 100).toFixed(0)}% above EMA50` },
      reasons: [`Only ${breadth.above}/${breadth.total} assets above EMA50 — risk-off`],
    };
  }

  let score = 50;
  if (e50 !== null) {
    if (price > e50) { score += 15; reasons.push('BTC above its EMA50'); }
    else { score -= 15; reasons.push('BTC below its EMA50'); }
  }
  if (e20 !== null && e50 !== null) {
    if (e20 > e50) { score += 10; reasons.push('BTC EMA20 above EMA50'); }
    else { score -= 10; reasons.push('BTC EMA20 below EMA50'); }
  }
  if (breadth) {
    const pct = `${(breadth.share * 100).toFixed(0)}%`;
    if (breadth.share >= 0.6) { score += 15; reasons.push(`Broad market strength: ${pct} above EMA50`); }
    else if (breadth.share >= 0.5) { score += 5; reasons.push(`Breadth ${pct} above EMA50`); }
    else if (breadth.share < 0.3) { score -= 20; reasons.push(`Weak breadth: ${pct} above EMA50`); }
    else if (breadth.share < 0.4) { score -= 15; reasons.push(`Soft breadth: ${pct} above EMA50`); }
    else reasons.push(`Breadth ${pct} above EMA50`);
  } else {
    reasons.push('Breadth unavailable (too few assets)');
  }
  // Veto-only. The market reading is logged (score + reasons) but never voted:
  //  - a long vote handed every asset the same free vote in strong markets
  //    (seen live: 19/30 would enter at 76% breadth);
  //  - an against vote did worse than nothing: it joins the voting pool, which
  //    raises the quorum to all four candle agents and blocks exactly the
  //    weak-market reversals that pay. Train-slice backtest (240d 4h):
  //    committee -4.5% with it, +11.3% without; better in both train halves.
  const v = voteFromScore('marketRegime', score, reasons);
  const label = v.vote === 'long' ? 'Supportive market' : v.vote === 'against' ? 'Weak market' : 'Neutral market';
  return { ...v, vote: 'abstain', confidence: 0, reasons: [`${label} — informational, Market Regime only vetoes`, ...reasons] };
}

/**
 * Derivatives: OKX perpetual funding, open interest and long/short ratio.
 * The question it answers: is new money backing this move, or is it crowded?
 * Veto: funding at or above funding_veto (longs crowded and paying for it).
 */
export function derivativesAgent(ctx, s) {
  const d = ctx.derivatives;
  if (d === undefined) return noData('derivatives', 'Not fetched this cycle');
  if (d === null) return noData('derivatives', 'No OKX perpetual for this asset');

  const { fundingRate, openInterest, longShort } = d;
  if (!Number.isFinite(fundingRate) && !(openInterest?.length >= 2)) {
    return noData('derivatives', 'Derivatives data empty');
  }

  if (Number.isFinite(fundingRate) && fundingRate >= s.funding_veto) {
    return {
      agent: 'derivatives', vote: 'against', confidence: 1, dataOk: true, score: 0,
      veto: { reason: `Funding ${(fundingRate * 100).toFixed(3)}%/8h — longs crowded` },
      reasons: [`Funding ${(fundingRate * 100).toFixed(3)}% per 8h — longs crowded`],
    };
  }

  const now = ctx.candles[ctx.candles.length - 1].close;
  const then = closeHoursAgo(ctx.candles, 24, ctx.interval);
  const priceChg = then ? (now - then) / then : null;
  const oiChg = changeOver24h(openInterest);
  const lsChg = changeOver24h(longShort);

  let score = 50;
  const reasons = [];
  if (priceChg !== null && oiChg !== null) {
    const p = `${(priceChg * 100).toFixed(1)}%`;
    const o = `${(oiChg * 100).toFixed(1)}%`;
    if (priceChg > 0 && oiChg > 0.02) {
      score += 10 + Math.min(20, oiChg * 200);
      reasons.push(`OI ${o} with price ${p} — new money backing the move`);
    } else if (priceChg > 0 && oiChg < -0.02) {
      score -= 5;
      reasons.push(`Price ${p} on falling OI (${o}) — short covering, not new demand`);
    } else if (priceChg < 0 && oiChg > 0.02) {
      score -= 20;
      reasons.push(`OI ${o} into a falling price (${p}) — shorts building`);
    } else if (priceChg < 0 && oiChg < -0.02) {
      score -= 5;
      reasons.push(`Price ${p} with OI ${o} — longs unwinding`);
    } else {
      reasons.push(`OI flat (${o}) over 24h`);
    }
  }
  if (Number.isFinite(fundingRate)) {
    const f = `${(fundingRate * 100).toFixed(3)}%`;
    if (fundingRate < 0 && priceChg !== null && priceChg > 0) {
      score += 8;
      reasons.push(`Negative funding (${f}) into a rally — shorts paying, squeeze fuel`);
    } else if (fundingRate >= s.funding_warn) {
      score -= 10;
      reasons.push(`Funding elevated (${f}/8h)`);
    } else {
      reasons.push(`Funding neutral (${f}/8h)`);
    }
  }
  if (lsChg !== null && lsChg > 0.1 && priceChg !== null && priceChg > 0) {
    score -= 5;
    reasons.push(`Long/short ratio up ${(lsChg * 100).toFixed(0)}% in 24h — longs piling in`);
  }
  return voteFromScore('derivatives', score, reasons);
}

/** Relative change from the point ~24h before the newest, in a [{ts, value}] series (oldest first). */
function changeOver24h(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = series[series.length - 1];
  const target = latest.ts - 24 * 3600e3;
  let base = null;
  for (const p of series) if (p.ts <= target) base = p;
  if (!base || !base.value) return null;
  return (latest.value - base.value) / base.value;
}

/**
 * Liquidity: can a probe-sized market buy fill cleanly, and which side of the
 * book is heavier? A healthy book alone is not a reason to buy, so the vote
 * comes from order-book imbalance within 2% of mid, not from depth itself.
 * Veto: spread above max_spread_pct, or the probe cannot fill within the
 * account's slippage limit.
 */
export function liquidityAgent(ctx, s) {
  const b = ctx.orderBook;
  if (b === undefined) return noData('liquidity', 'Not fetched this cycle');
  if (!b || !b.bids?.length || !b.asks?.length) return noData('liquidity', 'Order book unavailable');

  const bid = b.bids[0][0];
  const ask = b.asks[0][0];
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : Infinity;
  const veto = (reason) => ({
    agent: 'liquidity', vote: 'against', confidence: 1, dataOk: true, score: 0, veto: { reason }, reasons: [reason],
  });

  if (spreadPct > s.max_spread_pct) return veto(`Spread ${spreadPct.toFixed(2)}% over ${s.max_spread_pct}%`);
  const fill = estimateFillFromBook(b, 'buy', s.liquidity_probe_usdt);
  if (!fill || fill.insufficientLiquidity) return veto(`Book cannot absorb a ${s.liquidity_probe_usdt} USDT buy`);
  if (fill.slippagePercent > ctx.limits.maxSlippagePercent) {
    return veto(`Slippage ${fill.slippagePercent.toFixed(2)}% on ${s.liquidity_probe_usdt} USDT over ${ctx.limits.maxSlippagePercent}% limit`);
  }

  const within = (levels, lo, hi) => levels.reduce((a, [p, q]) => (p >= lo && p <= hi ? a + p * q : a), 0);
  const bidQ = within(b.bids, mid * 0.98, mid);
  const askQ = within(b.asks, mid, mid * 1.02);
  const reasons = [`Spread ${spreadPct.toFixed(3)}%, ${s.liquidity_probe_usdt} USDT slips ${fill.slippagePercent.toFixed(3)}%`];
  if (!(bidQ > 0) || !(askQ > 0)) {
    return abstain('liquidity', 'Book too shallow within 2% to read imbalance', { reasons });
  }
  const ratio = bidQ / askQ;
  const score = 50 + clamp(Math.log2(ratio) * 20, -30, 30);
  reasons.push(`Bid/ask depth within 2%: ${ratio.toFixed(2)}x`);
  return voteFromScore('liquidity', score, reasons);
}

export const CANDLE_AGENTS = Object.freeze({
  trend: trendAgent,
  momentum: momentumAgent,
  volumeFlow: volumeFlowAgent,
  structure: structureAgent,
});

export const CONTEXT_AGENTS = Object.freeze({
  marketRegime: marketRegimeAgent,
  derivatives: derivativesAgent,
  liquidity: liquidityAgent,
});

export const AGENTS = Object.freeze({ ...CANDLE_AGENTS, ...CONTEXT_AGENTS });

export const AGENT_NAMES = Object.keys(AGENTS);

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Decision order: vetoes → regime gating → eligibility → dissent → quorum → score.
 * Returns the decision plus the full tally, so any other quorum or threshold
 * can be replayed later from the logged votes.
 */
export function coordinate(votes, ctx, rawSettings) {
  const s = resolveCommitteeSettings(rawSettings);

  const tagged = votes.map((v) => ({
    ...v,
    eligible: v.dataOk !== false && (!v.eligibleIn || v.eligibleIn.includes(ctx.marketRegime)),
  }));
  const eligible = tagged.filter((v) => v.eligible);
  const vetoes = eligible.filter((v) => v.veto);
  const longs = eligible.filter((v) => v.vote === 'long');
  const againsts = eligible.filter((v) => v.vote === 'against');
  const abstains = eligible.filter((v) => v.vote === 'abstain');

  const w = (v) => (Number.isFinite(Number(s.weights[v.agent])) ? Number(s.weights[v.agent]) : 1);
  const voting = [...longs, ...againsts];
  const denom = voting.reduce((a, v) => a + w(v), 0);
  const numer = longs.reduce((a, v) => a + w(v) * v.confidence, 0);
  const committeeScore = denom > 0 ? round2(numer / denom) : 0;

  // Abstains shrink the pool but never count as yes: the quorum is taken over
  // agents that actually voted, floored at min_eligible so two lone longs with
  // everyone else silent can never open a trade.
  const requiredLong = Math.max(s.min_eligible, Math.min(s.min_long_votes, voting.length));

  let decision;
  let reason;
  if (vetoes.length) {
    decision = 'veto';
    reason = `Vetoed by ${vetoes.map((v) => v.agent).join(', ')}`;
  } else if (eligible.length < s.min_eligible) {
    decision = 'no_quorum';
    reason = `Only ${eligible.length} eligible agent(s), need ${s.min_eligible}`;
  } else if (againsts.length > s.max_against) {
    decision = 'dissent';
    reason = `${againsts.length} against (max ${s.max_against}): ${againsts.map((v) => v.agent).join(', ')}`;
  } else if (longs.length < requiredLong) {
    decision = 'no_quorum';
    reason = `${longs.length}/${requiredLong} long votes`;
  } else if (committeeScore < s.min_score) {
    decision = 'low_score';
    reason = `Score ${committeeScore} < ${s.min_score}`;
  } else {
    decision = 'enter';
    reason = `${longs.length} long, ${againsts.length} against, score ${committeeScore}`;
  }

  return {
    decision,
    reason,
    regime: ctx.marketRegime,
    committeeScore,
    longVotes: longs.length,
    againstVotes: againsts.length,
    abstains: abstains.length,
    eligible: eligible.length,
    requiredLong,
    votes: tagged,
  };
}

/**
 * Run every enabled agent on one asset and coordinate. An agent that throws is
 * recorded as a no-data abstain — one broken agent must not sink the cycle.
 */
export function runCommittee(input, rawSettings) {
  const { candles } = input || {};
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const s = resolveCommitteeSettings(rawSettings);
  const ctx = buildContext(input);

  const votes = [];
  for (const [name, agent] of Object.entries(AGENTS)) {
    if (s.agents_enabled[name] === false) continue;
    try {
      votes.push(agent(ctx, s));
    } catch (e) {
      votes.push(noData(name, `Agent error: ${e.message}`));
    }
  }

  return { symbol: input.symbol, price: ctx.price, ...coordinate(votes, ctx, s) };
}

/**
 * Filter role: should the committee BLOCK an entry the legacy engine chose?
 * Only objections count — a veto from any eligible agent, or block_against or
 * more eligible against votes. Long votes and the committee score are ignored:
 * the committee never adds a trade in this role, it can only remove one.
 */
export function filterVerdict(result, rawSettings) {
  if (!result) return { verdict: 'allow', reason: 'Committee had no reading' };
  const s = resolveCommitteeSettings(rawSettings);
  const eligible = (result.votes || []).filter((v) => v.eligible);
  const vetoes = eligible.filter((v) => v.veto);
  if (vetoes.length) {
    return { verdict: 'block', reason: `Vetoed by ${vetoes.map((v) => v.agent).join(', ')}: ${vetoes.map((v) => v.veto.reason).join('; ')}` };
  }
  const againsts = eligible.filter((v) => v.vote === 'against');
  if (againsts.length >= s.block_against) {
    return { verdict: 'block', reason: `${againsts.length} against (block at ${s.block_against}): ${againsts.map((v) => v.agent).join(', ')}` };
  }
  return { verdict: 'allow', reason: againsts.length ? `${againsts.length} against, under ${s.block_against}` : 'No objections' };
}

/**
 * Cheap first pass: candle agents only, no network. The worker uses the long
 * count to decide which assets earn the extra OKX calls this cycle.
 */
export function candlePrePass({ symbol, candles, interval = '1h' }, rawSettings) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const s = resolveCommitteeSettings(rawSettings);
  const ctx = buildContext({ symbol, candles, interval });
  let long = 0;
  let against = 0;
  for (const [name, agent] of Object.entries(CANDLE_AGENTS)) {
    if (s.agents_enabled[name] === false) continue;
    try {
      const v = agent(ctx, s);
      const eligible = v.dataOk !== false && (!v.eligibleIn || v.eligibleIn.includes(ctx.marketRegime));
      if (!eligible) continue;
      if (v.vote === 'long') long++;
      else if (v.vote === 'against') against++;
    } catch { /* counted as no vote */ }
  }
  return { symbol, long, against };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Keep the log to decisions worth comparing: anything with at least two long
 * votes, any veto, and every asset the legacy engine wanted to enter.
 */
export function shouldLogDecision(result, legacyDecision) {
  if (!result) return false;
  return result.longVotes >= 2 || result.decision === 'veto' || legacyDecision === 'enter';
}

/** Bars of the decision's own interval the outcome window spans (24h on 1h, 96h on 4h). */
export const OUTCOME_HORIZON_BARS = 24;

/** Hours until a decision on `interval` can be resolved (the window + the entry bar). */
export function outcomeRipeHours(interval = '1h') {
  return (INTERVAL_HOURS[interval] || 1) * (OUTCOME_HORIZON_BARS + 1);
}

/**
 * Forward outcome of one decision, from candles of the decision's interval
 * (oldest first).
 *
 * Same honesty rules as backtest.js: entry is the OPEN of the first bar that
 * starts at or after the decision (no look-ahead), and when one bar spans both
 * take-profit and stop-loss the STOP is assumed to have filled first.
 * ret_4h / ret_24h are fixed clock horizons; first_hit and the max moves span
 * OUTCOME_HORIZON_BARS bars (horizon_hours). Null until that window has fully
 * closed. Returns are gross (before fees and slippage) and in percent.
 */
export function computeOutcome(candles, evaluatedAtMs, { takeProfitPercent = 8, stopLossPercent = 3 } = {}, interval = '1h') {
  if (!Array.isArray(candles) || !Number.isFinite(evaluatedAtMs)) return null;
  const barHours = INTERVAL_HOURS[interval];
  if (!barHours) return null;
  const i0 = candles.findIndex((c) => c.openTime >= evaluatedAtMs);
  if (i0 === -1 || i0 + OUTCOME_HORIZON_BARS > candles.length) return null;

  const entry = candles[i0].open;
  if (!(entry > 0)) return null;
  const window = candles.slice(i0, i0 + OUTCOME_HORIZON_BARS);
  // Close of the bar that ends `hours` after entry (null if finer than one bar).
  const closeAfter = (hours) => {
    const k = Math.round(hours / barHours) - 1;
    return k >= 0 && k < window.length ? window[k].close : null;
  };
  const pct = (p) => round2(((p - entry) / entry) * 100);
  const tp = entry * (1 + takeProfitPercent / 100);
  const sl = entry * (1 - stopLossPercent / 100);

  let first = 'neither';
  let barsToExit = null;
  for (let k = 0; k < window.length; k++) {
    const c = window[k];
    const hitSl = c.low <= sl;
    const hitTp = c.high >= tp;
    if (hitSl || hitTp) {
      first = hitSl ? 'sl' : 'tp';
      barsToExit = k + 1;
      break;
    }
  }

  return {
    entry_price: entry,
    entry_time: new Date(candles[i0].openTime).toISOString(),
    ret_4h: closeAfter(4) === null ? null : pct(closeAfter(4)),
    ret_24h: closeAfter(24) === null ? null : pct(closeAfter(24)),
    horizon_hours: barHours * OUTCOME_HORIZON_BARS,
    max_up: pct(Math.max(...window.map((c) => c.high))),
    max_down: pct(Math.min(...window.map((c) => c.low))),
    first_hit: first,
    bars_to_exit: barsToExit,
    take_profit_percent: takeProfitPercent,
    stop_loss_percent: stopLossPercent,
  };
}

/** Shape a committee result into a CommitteeDecision entity record. */
/**
 * Dedupe key for one decision: the worker runs every 5 minutes but a decision
 * belongs to a candle, so each (symbol, candle, legacy decision) is logged once.
 * Keeping legacy_decision in the key lets a later 'enter' in the same candle
 * still be recorded after an earlier 'skip'.
 */
export function decisionKey({ symbol, bar_time, legacy_decision }) {
  return `${symbol}|${bar_time}|${legacy_decision}`;
}

export function toDecisionRecord({ result, cycleId, evaluatedAt, interval, mode, legacyDecision, legacyStrength, legacyTraded, ownerEmail, filter, barTime }) {
  return {
    // Open time (ISO) of the newest candle the committee saw.
    bar_time: barTime ?? null,
    // Filter role: the committee's verdict on a legacy entry (null when the
    // legacy engine did not want this asset — there is nothing to filter).
    filter_verdict: filter?.verdict ?? null,
    filter_reason: filter?.reason ?? null,
    cycle_id: cycleId,
    evaluated_at: evaluatedAt,
    symbol: result.symbol,
    price: result.price,
    interval,
    mode,
    decision: result.decision,
    decision_reason: result.reason,
    regime: result.regime,
    committee_score: result.committeeScore,
    long_votes: result.longVotes,
    against_votes: result.againstVotes,
    abstains: result.abstains,
    eligible_agents: result.eligible,
    required_long: result.requiredLong,
    votes: result.votes.map((v) => ({
      agent: v.agent,
      vote: v.vote,
      confidence: v.confidence,
      score: v.score,
      veto: v.veto,
      eligible: v.eligible,
      data_ok: v.dataOk,
      reasons: v.reasons,
    })),
    legacy_decision: legacyDecision,
    legacy_strength: legacyStrength ?? null,
    legacy_traded: !!legacyTraded,
    // Forward returns, filled by phase 2's resolveCommitteeOutcomes job.
    outcome: null,
    owner_email: ownerEmail,
  };
}
