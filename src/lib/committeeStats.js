/**
 * LOCAL CHANGE (agent committee, phase 3): pure stats for the Committee page.
 * No imports, so tests/committee.test.mjs can exercise it under plain Node.
 *
 * Inputs are CommitteeDecision records. An outcome is "resolved" once the
 * hourly resolveCommitteeOutcomes job has filled `outcome` (first_hit is
 * 'tp' | 'sl' | 'neither' over the outcome window, at the account's TP/SL).
 */

/** Minimum resolved picks on EACH side before the filter's verdict means anything. */
export const MIN_FILTER_SAMPLE = 30;
/** Win-rate gap (percentage points) the verdict needs before it picks a side. */
export const VERDICT_GAP_PTS = 5;

/**
 * One record per (symbol, candle, legacy decision). Records written before the
 * worker deduped (no bar_time) fall back to the hour they were evaluated in.
 * Keeps the earliest record of each group.
 */
export function dedupeDecisions(records) {
  const sorted = [...(records || [])].sort((a, b) => String(a.evaluated_at).localeCompare(String(b.evaluated_at)));
  const seen = new Set();
  const out = [];
  for (const r of sorted) {
    const bar = r.bar_time || String(r.evaluated_at || '').slice(0, 13);
    const key = `${r.symbol}|${bar}|${r.legacy_decision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const isResolved = (r) => r && r.outcome && typeof r.outcome === 'object' && r.outcome.first_hit;

function mean(values) {
  const ok = values.filter((v) => Number.isFinite(v));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

/** Outcome summary of a set of records (resolved ones only). */
export function outcomeSummary(records) {
  const done = (records || []).filter(isResolved);
  const n = done.length;
  const tp = done.filter((r) => r.outcome.first_hit === 'tp').length;
  const sl = done.filter((r) => r.outcome.first_hit === 'sl').length;
  return {
    total: (records || []).length,
    resolved: n,
    pending: (records || []).length - n,
    winRate: n ? (tp / n) * 100 : null,
    stopRate: n ? (sl / n) * 100 : null,
    avgRet24h: mean(done.map((r) => r.outcome.ret_24h)),
    avgMaxUp: mean(done.map((r) => r.outcome.max_up)),
    avgMaxDown: mean(done.map((r) => r.outcome.max_down)),
  };
}

/**
 * The filter question: of the legacy engine's picks, did the ones the
 * committee would have BLOCKED do worse than the ones it ALLOWED?
 * verdict: 'collecting' (sample too small) | 'helping' | 'hurting' | 'inconclusive'.
 */
export function summarizeFilter(records, { minSample = MIN_FILTER_SAMPLE, gapPts = VERDICT_GAP_PTS } = {}) {
  const picks = dedupeDecisions(records).filter((r) => r.legacy_decision === 'enter' && r.filter_verdict);
  const allowed = outcomeSummary(picks.filter((r) => r.filter_verdict === 'allow'));
  const blocked = outcomeSummary(picks.filter((r) => r.filter_verdict === 'block'));

  let verdict = 'collecting';
  let detail = `Need ${minSample} resolved picks on each side (allowed ${allowed.resolved}, blocked ${blocked.resolved}).`;
  if (allowed.resolved >= minSample && blocked.resolved >= minSample) {
    const gap = allowed.winRate - blocked.winRate;
    if (gap >= gapPts) {
      verdict = 'helping';
      detail = `Blocked picks won ${gap.toFixed(1)} pts less often than allowed ones.`;
    } else if (gap <= -gapPts) {
      verdict = 'hurting';
      detail = `Blocked picks won ${(-gap).toFixed(1)} pts MORE often than allowed ones — the filter is removing winners.`;
    } else {
      verdict = 'inconclusive';
      detail = `Win rates within ${gapPts} pts (gap ${gap.toFixed(1)}). No evidence either way yet.`;
    }
  }

  // Why picks were blocked: 'veto: derivatives' / 'against votes'.
  const reasons = {};
  for (const r of picks.filter((p) => p.filter_verdict === 'block')) {
    const vetoAgents = (r.votes || []).filter((v) => v.eligible && v.veto).map((v) => v.agent);
    const label = vetoAgents.length ? `veto: ${vetoAgents.join(', ')}` : 'against votes';
    (reasons[label] ||= []).push(r);
  }
  const blockReasons = Object.entries(reasons)
    .map(([label, rs]) => ({ label, ...outcomeSummary(rs) }))
    .sort((a, b) => b.total - a.total);

  return { picks: picks.length, allowed, blocked, verdict, detail, blockReasons };
}

/**
 * Per agent, over the legacy engine's picks: how did picks fare when this
 * agent voted long, abstained, voted against, or vetoed? An agent worth
 * keeping shows a lower win rate when it objects than when it agrees.
 */
export function agentScorecard(records) {
  const picks = dedupeDecisions(records).filter((r) => r.legacy_decision === 'enter');
  const agents = new Map();
  for (const r of picks) {
    for (const v of r.votes || []) {
      if (!agents.has(v.agent)) agents.set(v.agent, { long: [], abstain: [], against: [], veto: [], noData: [] });
      const bucket = agents.get(v.agent);
      if (v.data_ok === false) bucket.noData.push(r);
      else if (v.veto) bucket.veto.push(r);
      else (bucket[v.vote] || bucket.abstain).push(r);
    }
  }
  return [...agents.entries()].map(([agent, b]) => ({
    agent,
    long: outcomeSummary(b.long),
    abstain: outcomeSummary(b.abstain),
    against: outcomeSummary(b.against),
    veto: outcomeSummary(b.veto),
    noData: b.noData.length,
  }));
}

/** Legacy picks vs what the committee would have picked on its own ('replace' role). */
export function engineComparison(records) {
  const rs = dedupeDecisions(records);
  return {
    legacy: outcomeSummary(rs.filter((r) => r.legacy_decision === 'enter')),
    committee: outcomeSummary(rs.filter((r) => r.decision === 'enter')),
  };
}
