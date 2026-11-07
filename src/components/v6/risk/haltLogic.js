// Which panel Risk Controls shows, and which actions it offers. Pure, so every state in
// gui-design 5.4 can be tested without rendering.

/**
 * mode: fail_safe | halted | paused | review | normal
 *
 * A manual flatten renders as `halted`, not `paused`: its positions are being closed, and
 * only a re-enable lets V6 open any again.
 */
export function panelMode(status) {
  const halted = status?.risk?.halted;
  const state = status?.headline?.state;
  // An unreadable risk state reports HALTED with no halt record behind it.
  if (halted?.source === 'fail_safe' || (state === 'HALTED' && !halted)) return 'fail_safe';
  if (halted?.source === 'manual' && !halted.flatten) return 'paused';
  if (halted) return 'halted';
  if (state === 'NEEDS_REVIEW' || status?.risk?.review?.needed === true) return 'review';
  return 'normal';
}

/**
 * v6Risk raises review for two reasons. The second can fire on the half and quarter rungs,
 * where entries are allowed but every one is below the minimum order, so the wording must
 * not claim that entries are blocked. status.risk does not carry state.review, so the rung
 * decides: flat_entries_blocked needs rung 3 or worse.
 */
export function reviewText(risk, formatPct) {
  const tooSmall = risk?.review?.reason === 'flat_entries_too_small' || (typeof risk?.rung === 'number' && risk.rung < 3);
  if (tooSmall) {
    return {
      title: 'Cannot recover by itself',
      body: 'No positions, and entries at this reduced size fall below the minimum order. With no positions, equity cannot move, so the rung cannot release by itself. A human must re-enable here.',
    };
  }
  return {
    title: 'No new entries, and cannot recover by itself',
    body: `New entries stopped at ${formatPct(risk?.drawdownPct)} drawdown. With no positions, equity cannot move, so this level cannot release by itself. A human must re-enable here.`,
  };
}

/**
 * What a rebasing re-enable does to the automatic flatten. The ladder measures from the new
 * high, so its -20% is deeper than -20% from the all-time high: in simulation books fell up
 * to 37.6% past that point with no ladder flatten. The drawdown floor (status.risk.floor) is
 * the one limit re-enables share, so it is shown too, and which of the two comes first.
 *
 * allTime comes from useAllTimeDrawdown. haltPct is status.risk.ladder.haltPct (negative).
 * nextHaltFromAllTimePct is null when the all-time high is unknown; `atLeast` carries over
 * because a thinned curve can only understate the fall.
 */
export function rebaseExposure(allTime, equity, haltPct, floor) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const nextHaltEquity = num(equity) && num(haltPct) ? equity * (1 + haltPct / 100) : null;
  const high = allTime?.known ? allTime.highEquity : null;
  const floorLevel = num(floor?.level) ? floor.level : null;
  return {
    floorLevel,
    floorPointsAbove: floorLevel !== null && num(floor?.pointsAbove) ? floor.pointsAbove : null,
    floorDollarsAbove: floorLevel !== null && num(floor?.dollarsAbove) ? floor.dollarsAbove : null,
    floorFirst: floorLevel !== null && nextHaltEquity !== null && floorLevel >= nextHaltEquity,
    known: allTime?.known === true,
    nowFromAllTimePct: allTime?.known ? allTime.drawdownPct : null,
    highEquity: high,
    reenables: allTime?.reenables ?? null,
    atLeast: allTime?.atLeast === true,
    haltPct: num(haltPct) ? haltPct : null,
    nextHaltEquity,
    nextHaltFromAllTimePct: nextHaltEquity !== null && num(high) && high > 0 ? (nextHaltEquity / high - 1) * 100 : null,
  };
}

/**
 * The permanent drawdown floor (status.risk.floor; CONTRACT section 6, 2026-11-07). Measured
 * from a high a re-enable never moves. Formatters are passed in so this stays pure. Within
 * 5 points of the floor the tone turns amber.
 */
export function floorView(floor, { money, pct }) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const depth = num(floor?.pct) ? pct(floor.pct, 0) : '-30%';
  if (floor?.breached === true) {
    const fell = num(floor.breachEquity) ? ` Equity fell to ${money(floor.breachEquity)}.` : '';
    return {
      known: num(floor.level), breached: true, tone: 'red',
      line: `Drawdown floor reached: ${depth} from ${money(floor.reference)}.${fell} Every position is closed and V6 is halted. A re-enable does not clear this; a floor reset does, once the account is flat.`,
    };
  }
  if (!num(floor?.level) || !num(floor?.reference) || !num(floor?.pointsAbove)) {
    return { known: false, breached: false, tone: 'slate', line: 'The drawdown floor level is not available right now.' };
  }
  const dollars = num(floor.dollarsAbove) ? ` (${money(floor.dollarsAbove)})` : '';
  return {
    known: true, breached: false, tone: floor.pointsAbove <= 5 ? 'amber' : 'slate',
    line: `Drawdown floor at ${money(floor.level)}, ${depth} from ${money(floor.reference)}. Equity is ${floor.pointsAbove.toFixed(1)} points${dollars} above it. Reaching it closes every position and halts, and a re-enable does not move it.`,
  };
}

/** Whether to offer the floor reset. The server re-checks all of it, and the engine again. */
export function floorResetOffer(status) {
  const floor = status?.risk?.floor;
  const items = floor?.reset?.preconditions ?? [];
  const pending = status?.risk?.requestPending ?? null;
  return {
    show: floor?.breached === true,
    available: floor?.reset?.available === true && items.every((p) => p.ok) && !pending,
    preconditions: items,
  };
}

/**
 * Whether to offer recutover. status has no flag for lost state, so two facts are required:
 * the engine's open state_missing event, and no last run on record, because that event can
 * outlive the state coming back. portfolio_missing does not count: the engine stops on it
 * before it reads the request. available also needs a flat account, as the server does,
 * and a quarantined row is a position even though status.positions leaves it out.
 */
export function recutoverOffer(status, openEvents) {
  const stateLost = !status?.engine?.lastTickAt
    && (openEvents ?? []).some((e) => e.code === 'state_missing' && !e.clearedAt);
  const flat = (status?.positions?.length ?? 0) === 0 && (status?.quarantinedPositions?.length ?? 0) === 0;
  return { stateLost, available: stateLost && flat };
}

export function panelActions(status) {
  const mode = panelMode(status);
  const risk = status?.risk;
  const pending = risk?.requestPending ?? null;
  const open = status?.positions?.length ?? 0;
  const closing = risk?.halted?.flatten === true;
  return {
    mode,
    pending,
    canPause: mode === 'normal' && !pending,
    canFlatten: open > 0 && !closing && !pending,
    // available only says the state can clear. The server still refuses on an unmet check.
    canReenable: mode !== 'normal' && risk?.reenable?.available === true && !pending
      && (risk.reenable.preconditions ?? []).every((p) => p.ok),
    showReenable: mode !== 'normal',
    willRebase: risk?.reenable?.willRebase === true,
  };
}

/** Blocks that clear with no human action, with when or how (gui-design 5.4). */
export function selfClearingBlocks(risk, untilText) {
  const out = [];
  const hit = (p) => typeof p?.lossPct === 'number' && typeof p?.limitPct === 'number' && p.lossPct <= p.limitPct;
  if (hit(risk?.daily)) out.push(`Daily loss limit reached. Clears in ${untilText(risk.daily.resetsAt)}, even if equity recovers sooner.`);
  if (hit(risk?.weekly)) {
    const when = risk.weekly.resetsAt ? `in ${untilText(risk.weekly.resetsAt)}` : 'next UTC Monday';
    out.push(`Weekly loss limit reached. Clears ${when}, even if equity recovers sooner.`);
  }
  if (risk?.btc?.tripped) out.push('Market breaker tripped. Clears when BTC recovers and the cooldown ends.');
  return out;
}

export const REQUEST_TEXT = {
  pause: 'Pause requested. New entries stop at the next engine run (within 5 minutes).',
  flatten: 'Flatten requested, closing at next engine run (within 5 minutes).',
  reenable: 'Re-enable requested. It is checked again at the next engine run (within 5 minutes).',
  resetFloor: 'Floor reset requested. It is checked again at the next engine run (within 5 minutes). V6 stays halted until you re-enable.',
};
