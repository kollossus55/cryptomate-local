// Pure view logic for the Signal Tests page. No React, no aliases. Limits and
// thresholds never live here: they arrive as text from v6Control.

// The order and ids are the contract's seven gate checks.
export const CHECKS = [
  { id: 'certificate', n: 1, label: 'Certificate', short: 'Cert' },
  { id: 'drift', n: 2, label: 'Forward drift', short: 'Drift' },
  { id: 'data', n: 3, label: 'Data', short: 'Data' },
  { id: 'replay', n: 4, label: 'Cross-venue replay', short: 'Replay' },
  { id: 'liquidity', n: 5, label: 'Liquidity', short: 'Liq' },
  { id: 'history', n: 6, label: 'Historical', short: 'Hist' },
  { id: 'risk', n: 7, label: 'Risk', short: 'Risk' },
];

// Not checks, but the gate can name them as the blocker. Raw codes stay off screen.
const GATE_FAULTS = { no_gate: 'No gate connected', gate_error: 'Gate error' };

export const checkLabel = (id) => CHECKS.find((c) => c.id === id)?.label ?? GATE_FAULTS[id] ?? 'Unknown test';

export const OUTCOMES = [
  { id: 'entered', label: 'Entered', tone: 'indigo' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'rejected', label: 'Rejected', tone: 'amber' },
  { id: 'shadow', label: 'Shadow', tone: 'amber' },
  { id: 'not_tested', label: 'Not tested', tone: 'slate' },
];

export const outcomeOf = (id) => OUTCOMES.find((o) => o.id === id)
  ?? { id, label: id ?? 'Unknown', tone: 'slate' };

export const RANGES = [
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
  { id: 'all', label: 'All time', ms: null },
];
export const DEFAULT_RANGE = '7d';

const REJECT_TEXT = {
  not_in_universe: 'the coin is not in the strategy universe',
  no_stop: 'the signal had no stop',
  short_on_spot: 'shorts are not possible on spot',
  no_price: 'no usable price',
};

// Anything but an explicit pass or fail is "not run", so a missing result can
// never be read as a pass.
export const checkStatus = (status) => (status === 'pass' || status === 'fail' ? status : 'not_run');

// `checks` is a map in the list response and an array in the detail response.
export function statusFor(checks, id) {
  if (Array.isArray(checks)) return checkStatus(checks.find((c) => c.id === id)?.status);
  return checkStatus(checks?.[id]);
}

export function checkCounts(checks) {
  const c = { pass: 0, fail: 0, not_run: 0, failed: [] };
  for (const { id, label } of CHECKS) {
    const s = statusFor(checks, id);
    c[s] += 1;
    if (s === 'fail') c.failed.push(label);
  }
  return c;
}

export function compactChecks(checks) {
  const c = checkCounts(checks);
  const parts = [`${c.pass} of ${CHECKS.length} passed`];
  if (c.failed.length) parts.push(`failed ${c.failed.join(', ')}`);
  if (c.not_run) parts.push(`${c.not_run} not run`);
  return parts.join(', ');
}

// The gate's blocked_text already starts with the check label.
export function blockedDetail(item) {
  const text = item?.blockedText;
  if (!text) return null;
  const prefix = `${checkLabel(item.blockedBy)}: `;
  return text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length) : text;
}

// Checks 5 and 7 run after sizing (contract section 6), so a sizing refusal has
// only cleared the five checks before it. It must not read as "passed the tests".
export function whyLine(item) {
  switch (item?.outcome) {
    case 'entered':
      return 'Cleared all 7 tests. The trade is allowed; it may still lose.';
    case 'blocked':
      return item.blockedBy
        ? `${checkLabel(item.blockedBy)}: ${blockedDetail(item) ?? 'no detail stored'}`
        : item.blockedText ?? 'Blocked. No detail was stored.';
    case 'rejected':
      if (item.rejectCode === 'sizing') {
        return `Cleared the tests that run before sizing, then sizing refused it${item.blockedText ? `: ${item.blockedText}` : '.'}`;
      }
      return `Rejected before the tests: ${REJECT_TEXT[item.rejectCode] ?? item.blockedText ?? item.rejectCode ?? 'no detail stored'}`;
    case 'shadow':
      return item.blockedText
        ? `Logged only, no paper position. ${item.blockedText}`
        : 'Logged only, no paper position.';
    case 'not_tested': {
      const why = item.notTestedReason ?? item.blockedText;
      return `Not tested: new entries were off${why ? ` (${why})` : ''}`;
    }
    default:
      return item?.blockedText ?? '';
  }
}

export function filtersFromParams(params) {
  const range = params.get('range');
  const outcome = params.get('outcome');
  const failed = params.get('failed');
  return {
    range: RANGES.some((r) => r.id === range) ? range : DEFAULT_RANGE,
    strategy: params.get('strategy') ?? '',
    symbol: params.get('symbol') ?? '',
    outcome: OUTCOMES.some((o) => o.id === outcome) ? outcome : '',
    failed: CHECKS.some((c) => c.id === failed) ? failed : '',
  };
}

export const hasActiveFilters = (f) => Boolean(
  f.strategy || f.symbol || f.outcome || f.failed || f.range !== DEFAULT_RANGE,
);

// `now` is passed in and held steady by the caller so the query key is stable.
export function requestFromFilters(f, now) {
  const range = RANGES.find((r) => r.id === f.range);
  const req = { from: range?.ms == null ? 0 : now - range.ms };
  if (f.strategy) req.strategyId = f.strategy;
  if (f.symbol) req.symbol = f.symbol;
  if (f.outcome) req.outcome = f.outcome;
  if (f.failed) req.failedCheck = f.failed;
  return req;
}
