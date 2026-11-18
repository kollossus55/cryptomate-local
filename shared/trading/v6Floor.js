// Permanent drawdown floor (CONTRACT section 6, user-approved addition, 2026-11-07).
//
// The ladder's -20% flatten measures from the equity high, and every rebasing re-enable
// moves that high down to current equity. The floor measures from a high that a re-enable
// never moves, so repeated re-enables cannot walk the account past it. It is a ceiling, not
// a setting: no config field reads or changes it, and only a floor reset by a human, on a
// flat and halted account, moves its reference.

export const FLOOR_PCT = 0.30;

// Float slack, so a fall of exactly 30% counts as reaching the floor.
const EPS = 1e-9;

const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The reference high: the floor's own high once a reset has set one, else the all-time high. */
export function floorReference(state) {
  if (isPos(state?.floorHigh)) return state.floorHigh;
  return isPos(state?.allTimeHigh) ? state.allTimeHigh : null;
}

export const floorLevel = (reference) => (isPos(reference) ? reference * (1 - FLOOR_PCT) : null);

/** True at or below the floor. Unknown inputs never count as reached. */
export function floorReached(equity, reference) {
  if (!isPos(reference) || typeof equity !== 'number' || !Number.isFinite(equity)) return false;
  return (equity - reference) / reference <= -FLOOR_PCT + EPS;
}
