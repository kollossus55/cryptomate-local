// Pure logic for the Exchanges page: the staged edit, what a change would break, and how
// raw health and consensus rows read. No React, so tests/v6GuiExchanges.test.mjs runs it in Node.

// The only venues with stored replay history (contract section 6), so the only valid choice.
export const REPLAY_VENUES = ['okx', 'bybit'];

export const TEST_COOLDOWN_MS = 15_000;

const ANSWERING = new Set(['ok', 'slow']);

const byPriority = (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity);

/** The editable part of an `exchanges` response. */
export function draftFrom(data) {
  return {
    venues: [...data.venues].sort(byPriority).map(({ venue, enabled }) => ({ venue, enabled })),
    roles: { replay: data.roles?.replay ?? null, book: data.roles?.book ?? null },
  };
}

export const enabledVenues = (draft) => draft.venues.filter((v) => v.enabled).map((v) => v.venue);

export function moveVenue(draft, venue, delta) {
  const from = draft.venues.findIndex((v) => v.venue === venue);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= draft.venues.length) return draft;
  const venues = [...draft.venues];
  [venues[from], venues[to]] = [venues[to], venues[from]];
  return { ...draft, venues };
}

export function setVenueEnabled(draft, venue, enabled) {
  return { ...draft, venues: draft.venues.map((v) => (v.venue === venue ? { ...v, enabled } : v)) };
}

export const setRole = (draft, role, venue) => ({ ...draft, roles: { ...draft.roles, [role]: venue } });

export const isDirty = (draft, data) => JSON.stringify(draft) !== JSON.stringify(draftFrom(data));

export function toPayload(draft, expectedVersion) {
  return {
    venues: draft.venues.map(({ venue, enabled }, i) => ({ venue, enabled, priority: i + 1 })),
    roles: draft.roles,
    expectedVersion,
  };
}

/**
 * What switching a venue off would do. `blocked` means it may not happen at all: exits
 * need a price source, so the last venue stays on.
 */
export function disableImpact(draft, venue, { minForConsensus, labelOf = (id) => id }) {
  const remaining = enabledVenues(draft).filter((id) => id !== venue);
  if (remaining.length === 0) {
    return { blocked: 'This is the last enabled venue. Exits need a price source, so it stays on.', warnings: [] };
  }
  const warnings = [];
  if (remaining.length < minForConsensus) {
    warnings.push('Tests 3 and 4 will fail, so new entries stop. Exits continue.');
  }
  if (draft.roles.replay === venue) {
    warnings.push(`${labelOf(venue)} is the replay venue. Choose the other replay venue before saving.`);
  }
  if (draft.roles.book === venue) {
    warnings.push(`${labelOf(venue)} is the order book venue. Choose another before saving.`);
  }
  return { blocked: null, warnings };
}

/** Reasons the staged edit may not be saved. Empty means Save is allowed. */
export function saveProblems(draft, { labelOf = (id) => id } = {}) {
  const on = enabledVenues(draft);
  const problems = [];
  if (on.length === 0) problems.push('At least one venue must stay enabled.');
  const { replay, book } = draft.roles;
  if (!REPLAY_VENUES.includes(replay)) {
    problems.push('Replay must be OKX or Bybit: they are the only venues with stored history.');
  } else if (!on.includes(replay)) {
    problems.push(`The replay venue, ${labelOf(replay)}, is switched off.`);
  }
  if (book && !on.includes(book)) problems.push(`The order book venue, ${labelOf(book)}, is switched off.`);
  return problems;
}

/**
 * The state to display. A venue only counts as working after a real success, whatever
 * the server calls it, so an untried venue can never read as healthy (I13).
 */
export function displayHealth({ enabled, health, lastOk }) {
  if (enabled === false) return 'disabled';
  if (!health) return 'unknown';
  if (ANSWERING.has(health) && lastOk == null) return 'unknown';
  return health;
}

export function healthSummary(venues) {
  const on = venues.filter((v) => v.enabled);
  const states = on.map(displayHealth);
  return {
    enabled: on.length,
    answering: states.filter((s) => ANSWERING.has(s)).length,
    unknown: states.filter((s) => s === 'unknown').length,
  };
}

/**
 * Roles the server did not keep after a save. It may work replay and book out for itself,
 * so a 200 does not mean the choice stuck. Read back, never assumed.
 */
export function rolesNotKept(asked, saved) {
  return ['replay', 'book'].filter((role) => asked[role] !== (saved?.[role] ?? null));
}

/** One venue's roles under the staged edit. */
export function venueRoles(draft, venue) {
  const on = enabledVenues(draft);
  const roles = [];
  if (on[0] === venue) roles.push('Primary bars');
  else if (on.includes(venue)) roles.push('Backup bars');
  if (on.includes(venue)) roles.push('Consensus');
  if (draft.roles.book === venue) roles.push('Book');
  if (draft.roles.replay === venue) roles.push('Replay');
  return roles;
}

// The API design sends a venue map; the hub itself gives an array of quote objects.
export function quoteMap(quotes) {
  if (!Array.isArray(quotes)) return quotes ?? {};
  return Object.fromEntries(quotes.map((q) => [q.venue, q.price]));
}

/** How one consensus row reads: { tone, state, label }. state picks the icon. */
export function consensusView(item, { labelOf = (id) => id } = {}) {
  const venueCount = Object.keys(quoteMap(item.quotes)).length;
  const outliers = (item.outliers ?? []).map((o) => labelOf(o.venue ?? o));

  if (item.reason === 'outlier_excluded') {
    return { tone: 'amber', state: 'warn', label: `${outliers.join(', ') || 'A venue'} left out` };
  }
  if (item.ok) return { tone: 'emerald', state: 'ok', label: 'Agree' };
  if (item.reason === 'venues_disagree') {
    // With two venues a split cannot be attributed, so neither is named.
    const label = venueCount === 2 ? '2 venues disagree' : 'Venues disagree';
    return { tone: 'red', state: 'bad', label };
  }
  if (item.reason === 'no_majority') return { tone: 'red', state: 'bad', label: 'No majority' };
  if (item.reason === 'insufficient_venues') return { tone: 'red', state: 'bad', label: 'Too few venues' };
  return { tone: 'red', state: 'bad', label: item.reason ? `Not usable: ${item.reason}` : 'Not usable' };
}
