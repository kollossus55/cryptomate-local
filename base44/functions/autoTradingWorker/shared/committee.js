// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
/**
 * Agent Committee — phase 1 (shadow mode).
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
});

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
  return s;
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

/**
 * Derive 4h bars from 1h bars (groups of 4, aligned to the most recent bar).
 * Lets the Trend agent read the higher timeframe with no extra API calls.
 * Returns null for any other base interval.
 */
export function deriveHigherTimeframe(candles, interval) {
  if (interval !== '1h' || !Array.isArray(candles)) return null;
  const out = [];
  for (let end = candles.length; end - 4 >= 0; end -= 4) {
    const group = candles.slice(end - 4, end);
    out.unshift({
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[3].close,
      volume: group.reduce((a, c) => a + (c.volume || 0), 0),
      closeTime: group[3].closeTime,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Built once per asset per cycle and shared by every agent. */
export function buildContext({ symbol, candles, interval = '1h' }) {
  const regime = detectRegime(candles);
  return {
    symbol,
    interval,
    candles,
    candlesHTF: deriveHigherTimeframe(candles, interval),
    regime,
    // The committee's own market label. Phase 2's Market Regime agent (BTC
    // context + breadth) replaces this asset-level reading and adds risk_off.
    marketRegime: regime.regime === 'range' ? 'range' : 'trend',
    price: candles[candles.length - 1]?.close ?? null,
  };
}

// ---------------------------------------------------------------------------
// Agents — each: (ctx) => vote. Pure, no I/O.
// ---------------------------------------------------------------------------

/** Trend: 1h EMA stack, checked against the 4h EMA20. Only counts in a trending market. */
export function trendAgent(ctx) {
  const comp = trendComponent(ctx.candles, ctx.regime);
  if (!comp) return noData('trend', 'EMAs unavailable');

  let score = comp.score;
  const reasons = [...comp.reasons];
  const htf = ctx.candlesHTF;

  if (htf && htf.length >= 21) {
    const closes = htf.map((c) => c.close);
    const e = ema(closes, 20);
    const ePrev = ema(closes.slice(0, -1), 20);
    const price = closes[closes.length - 1];
    const htfUp = e !== null && ePrev !== null && price > e && e > ePrev;
    const htfDown = e !== null && ePrev !== null && price < e && e < ePrev;
    if (htfUp) {
      reasons.push('4h: price above rising EMA20');
      if (score < 50) score = 50 + (score - 50) * 0.3;
    } else if (htfDown) {
      reasons.push('4h: price below falling EMA20');
      if (score > 50) score = 50 + (score - 50) * 0.3;
    } else {
      reasons.push('4h trend mixed');
      score = 50 + (score - 50) * 0.7;
    }
  } else {
    reasons.push('4h check unavailable');
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

export const AGENTS = Object.freeze({
  trend: trendAgent,
  momentum: momentumAgent,
  volumeFlow: volumeFlowAgent,
  structure: structureAgent,
});

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
export function runCommittee({ symbol, candles, interval = '1h' }, rawSettings) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const s = resolveCommitteeSettings(rawSettings);
  const ctx = buildContext({ symbol, candles, interval });

  const votes = [];
  for (const [name, agent] of Object.entries(AGENTS)) {
    if (s.agents_enabled[name] === false) continue;
    try {
      votes.push(agent(ctx));
    } catch (e) {
      votes.push(noData(name, `Agent error: ${e.message}`));
    }
  }

  return { symbol, price: ctx.price, ...coordinate(votes, ctx, s) };
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

/** Shape a committee result into a CommitteeDecision entity record. */
export function toDecisionRecord({ result, cycleId, evaluatedAt, interval, mode, legacyDecision, legacyStrength, legacyTraded, ownerEmail }) {
  return {
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
