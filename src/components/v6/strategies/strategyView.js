// Pure view logic for the Strategies page. No React, no aliases, so it can be
// exercised from a plain Node script. Nothing here computes a statistic: every
// number shown comes from v6Control. These helpers only choose wording.

// Contract section 6 (I8). The server decides; this floor only stops the page
// from ever offering a return on a weaker rule than the contract's.
export const SHADOW_RETURN_FLOOR = 20;
export const FORWARD_JUDGE_FLOOR = 20;
export const RETURN_CONFIRM_WORD = 'RETURN';

const ORDER = { paper_full: 0, paper_half: 1, certified: 2, shadow: 3, research: 4 };

export const isPaper = (s) => s?.lifecycle === 'paper_half' || s?.lifecycle === 'paper_full';
export const isFailed = (s) => s?.lifecycle === 'research' && s?.certificate?.status === 'failed';
export const canTrade = (s) => isPaper(s) || s?.lifecycle === 'certified';

export function sortStrategies(items) {
  const rank = (s) => (ORDER[s.lifecycle] ?? 5) * 2 + (isFailed(s) ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
}

export function stateBadge(s) {
  if (isFailed(s)) return { tone: 'slate', label: 'FAILED' };
  switch (s?.lifecycle) {
    case 'paper_half': return { tone: 'amber', label: 'PAPER (HALF RISK)' };
    case 'paper_full': return { tone: 'amber', label: 'PAPER (FULL RISK)' };
    case 'certified': return { tone: 'indigo', label: 'CERTIFIED' };
    case 'shadow': return { tone: 'amber', label: 'SHADOW, no positions' };
    case 'research': return { tone: 'slate', label: 'NOT CERTIFIED' };
    default: return { tone: 'slate', label: s?.displayState || 'UNKNOWN' };
  }
}

export function summaryCounts(items) {
  const c = { paper: 0, certified: 0, shadow: 0, failed: 0, untested: 0 };
  for (const s of items) {
    if (isPaper(s)) c.paper += 1;
    else if (s.lifecycle === 'certified') c.certified += 1;
    else if (s.lifecycle === 'shadow') c.shadow += 1;
    else if (isFailed(s)) c.failed += 1;
    else c.untested += 1;
  }
  return c;
}

export function testsLine(s) {
  const c = s?.certificate;
  if (!c || c.status === 'none') return { main: 'Not tested', sub: null };
  const main = c.total ? `${c.passed ?? 0} of ${c.total}` : 'No results';
  if (c.status === 'stale') return { main, sub: 'Certificate no longer applies' };
  const failed = c.failedIds ?? [];
  if (!failed.length) return { main, sub: c.holdoutRun === false ? 'Holdout not used' : null };
  const holdout = c.holdoutRun === false ? ' (holdout not used)' : '';
  return { main, sub: `Failed ${failed.join(', ')}${holdout}` };
}

const unitWord = (unit, n) => {
  const word = unit === 'days' ? 'day' : 'trade';
  return n === 1 ? word : `${word}s`;
};

// Below the floor a count is shown instead of a verdict (design section 4.2).
// A breach is a fact that already demoted the strategy, so it is always shown.
// Only an explicit 'inside' earns the inside wording: the gate's `unknown` fails
// check 2, so it must never fall through to something that reads as fine.
export function driftLine({ status, n, note, xUnit }) {
  const count = n == null ? null : `n = ${n} ${unitWord(xUnit, n)}`;
  const tail = note ? ` ${note}` : '';
  const tooFew = { tone: 'slate', text: `Too few ${unitWord(xUnit, 2)} to judge${count ? ` (${count})` : ''}.` };
  switch (status) {
    case 'breach':
      return { tone: 'red', text: `Outside the expected range${count ? ` (${count})` : ''}.${tail}` };
    case 'inside':
      if ((n ?? 0) < FORWARD_JUDGE_FLOOR) return tooFew;
      return { tone: 'slate', text: `Inside the expected range (${count}). This is not a forecast.${tail}` };
    case 'warming':
    case 'too_few':
      return tooFew;
    case 'none':
    case null:
    case undefined:
      return { tone: 'slate', text: 'Not running forward yet.' };
    default:
      return { tone: 'red', text: `Drift cannot be judged, so check 2 blocks entries.${tail}` };
  }
}

export function forwardCell(s) {
  if (s?.lifecycle === 'shadow') {
    return {
      main: s.demotedAt ? 'Demoted' : 'Shadow only',
      sub: s.demotionReason ?? s.drift?.note ?? null,
    };
  }
  if (canTrade(s)) {
    const until = s.halfRiskUntilTrades;
    const main = s.lifecycle === 'paper_half' && until
      ? `${s.forwardTrades ?? 0} of ${until} trades`
      : `${s.forwardTrades ?? 0} trades`;
    // A tradable strategy starts at warming, so the list's `none` can only be the
    // gate's `unknown`, which blocks entries. It must not read as not started.
    const status = s.drift?.status === 'none' ? 'unknown' : s.drift?.status;
    return { main, sub: driftLine({ status, n: s.forwardTrades, note: null }).text };
  }
  return { main: 'Not run', sub: null };
}

export function criteriaByGroup(criteria) {
  const rows = criteria ?? [];
  return {
    dev: rows.filter((r) => r.group === 'dev'),
    holdout: rows.filter((r) => r.group === 'holdout'),
    failed: rows.filter((r) => r.status === 'fail'),
  };
}

// Anything but an explicit pass or fail is "not run". A blank must never read
// as a pass.
export const criterionStatus = (status) => (status === 'pass' || status === 'fail' ? status : 'not_run');

// The gate stores holdout rows with no result text and the value as a fraction,
// so a bare 0.183 would sit beside a "<= 25%" threshold. This is display only.
const FRACTION_ROWS = new Set(['H2', 'H3', 'H4']);

export function criterionResult(row) {
  if (row?.result != null && row.result !== '') return row.result;
  const v = row?.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) return v == null ? '-' : String(v);
  if (FRACTION_ROWS.has(row.id)) return `${(v * 100).toFixed(1)}%`;
  return String(Math.round(v * 100) / 100);
}

export function mergeDriftRows(drift) {
  const rows = new Map();
  const at = (x) => {
    if (!rows.has(x)) rows.set(x, { x });
    return rows.get(x);
  };
  for (const e of drift?.expected ?? []) {
    Object.assign(at(e.x), { p5: e.p5, p50: e.p50, p95: e.p95, lo: e.lo, hi: e.hi, band: [e.p5, e.p95] });
  }
  for (const f of drift?.forward ?? []) at(f.x).returnPct = f.returnPct;
  for (const b of drift?.breaches ?? []) at(b.x).breach = b.note ?? 'Drift breach';
  return [...rows.values()].sort((a, b) => a.x - b.x);
}

// A strategy that merely failed its tests can sit in shadow too, and there is no
// path from there to paper. Only a demoted strategy with a matching valid
// certificate can come back, and only when the server says the count is met.
// The detail certificate carries the stored status, which stays 'valid' after expiry
// or a code change. The strategy row carries the verified one, and that one wins.
export function verifiedCertificate(strategy, certificate) {
  if (!certificate) return certificate;
  return { ...certificate, status: strategy?.certificate?.status ?? 'stale' };
}

export function holdoutUsed(certificate) {
  return (certificate?.criteria ?? []).some((c) => c.group === 'holdout' && c.status !== 'not_run');
}

export function shadowReturnState({ strategy, certificate }) {
  if (strategy?.lifecycle !== 'shadow') return { applicable: false };
  const sr = strategy.shadowReturn ?? null;
  const required = Math.max(SHADOW_RETURN_FLOOR, sr?.signalsRequired ?? SHADOW_RETURN_FLOOR);
  const inRange = sr?.signalsInRange ?? null;
  const wasDemoted = strategy.demotedAt != null;
  const certOk = certificate?.status === 'valid' && certificate?.hashMatches === true;
  const countKnown = inRange != null;
  const countMet = countKnown && inRange >= required;
  const pending = sr?.pending === true;
  const preconditions = [
    {
      id: 'demoted',
      ok: wasDemoted,
      label: wasDemoted
        ? 'Demoted by the drift monitor'
        : 'Never held a paper state: it is in shadow because it did not pass its tests',
    },
    {
      id: 'certificate',
      ok: certOk,
      label: certOk ? 'Certificate valid and matches the code' : 'No valid certificate matching the current code',
    },
    {
      id: 'signals',
      ok: countMet,
      label: countKnown
        ? `${inRange} of ${required} forward shadow signals back inside the expected range`
        : 'The server has not reported a shadow signal count',
    },
  ];
  return {
    applicable: true,
    wasDemoted,
    required,
    inRange,
    countKnown,
    pending,
    preconditions,
    serverReason: sr?.reason ?? null,
    canRequest: wasDemoted && certOk && countMet && sr?.eligible !== false && !pending,
  };
}
