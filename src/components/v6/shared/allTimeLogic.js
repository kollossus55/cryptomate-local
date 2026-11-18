// Cumulative drawdown from the all-time high, across re-enables (contract section 6).
// risk.drawdownPct cannot answer this: each rebasing re-enable resets the equity high, so
// a repeatedly re-enabled book could look shallow while being far below where it peaked.
//
// Source is status.risk.allTime = { highEquity, highAt, drawdownPct, reenables }, which is
// null until the engine has stored a high. Then the figure comes from the equity history.
// That curve is thinned to 500 points, which can miss the true high, so a thinned result is
// flagged `atLeast`: the real drawdown can only be deeper than the one shown, never shallower.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Pure, so it can be tested without React. */
export function deriveAllTime(status, curve) {
  const risk = status?.risk;
  const direct = risk?.allTime;
  if (direct && isNum(direct.drawdownPct)) {
    return {
      known: true,
      drawdownPct: direct.drawdownPct,
      highEquity: direct.highEquity ?? null,
      highAt: direct.highAt ?? null,
      reenables: direct.reenables ?? null,
      atLeast: false,
    };
  }
  const unknown = { known: false, drawdownPct: null, highEquity: null, highAt: null, reenables: null, atLeast: false };
  const equity = status?.account?.equity;
  if (!isNum(equity) || risk?.halted?.source === 'fail_safe' || !curve) return unknown;

  let highEquity = Math.max(equity, status.account.startingEquity ?? -Infinity, risk?.peakEquity ?? -Infinity);
  let highAt = null;
  for (const p of curve.points ?? []) {
    if (isNum(p.equity) && p.equity >= highEquity) {
      highEquity = p.equity;
      highAt = p.t;
    }
  }
  if (!(highEquity > 0)) return unknown;
  return {
    known: true,
    drawdownPct: (equity / highEquity - 1) * 100,
    highEquity,
    highAt,
    reenables: null,
    atLeast: curve.downsampled === true,
  };
}

/** "-24.0%" with an "at least" prefix when the figure may understate the fall. */
export function allTimeLabel(allTime, formatPct) {
  if (!allTime.known) return null;
  return `${allTime.atLeast ? 'At least ' : ''}${formatPct(allTime.drawdownPct)}`;
}
