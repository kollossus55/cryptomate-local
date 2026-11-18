// Logic behind the Exchanges page. Run: node tests/v6GuiExchanges.test.mjs
import {
  REPLAY_VENUES, consensusView, rolesNotKept, disableImpact, displayHealth, draftFrom, healthSummary, isDirty,
  moveVenue, quoteMap, saveProblems, setRole, setVenueEnabled, toPayload, venueRoles,
} from '../src/components/v6/exchanges/venueDraft.js';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { passed += 1; console.log(`PASS ${name}`); } else { failed += 1; console.log(`FAIL ${name}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const data = {
  version: 3,
  minForConsensus: 2,
  venues: [
    { venue: 'bybit', enabled: true, priority: 2, health: 'ok', lastOk: 1 },
    { venue: 'okx', enabled: true, priority: 1, health: 'ok', lastOk: 1 },
    { venue: 'kraken', enabled: true, priority: 3, health: 'ok', lastOk: null },
    { venue: 'binance', enabled: false, priority: 4, health: 'blocked', lastOk: null },
  ],
  roles: { replay: 'okx', book: 'okx' },
};
const draft = draftFrom(data);
const ctx = { minForConsensus: 2 };

check('draft sorts by priority', same(draft.venues.map((v) => v.venue), ['okx', 'bybit', 'kraken', 'binance']));
check('clean draft is not dirty', !isDirty(draft, data));

const moved = moveVenue(draft, 'bybit', -1);
check('move up swaps', same(moved.venues.map((v) => v.venue), ['bybit', 'okx', 'kraken', 'binance']));
check('move is dirty', isDirty(moved, data));
check('move past the top is a no-op', moveVenue(draft, 'okx', -1) === draft);
check('payload renumbers from 1', same(toPayload(moved, 3).venues.map((v) => v.priority), [1, 2, 3, 4]));
check('payload carries version and roles', toPayload(moved, 3).expectedVersion === 3 && toPayload(moved, 3).roles.replay === 'okx');

check('replay choices are OKX and Bybit only', same(REPLAY_VENUES, ['okx', 'bybit']));
check('coinbase replay blocks save', saveProblems(setRole(draft, 'replay', 'coinbase')).length === 1);
check('unset replay blocks save', saveProblems(setRole(draft, 'replay', null)).length === 1);
check('bybit replay is allowed', saveProblems(setRole(draft, 'replay', 'bybit')).length === 0);
const replayOff = setRole(setVenueEnabled(draft, 'bybit', false), 'replay', 'bybit');
check('switched-off replay venue blocks save', saveProblems(replayOff).length === 1);
check('switched-off book venue blocks save', saveProblems(setVenueEnabled(draft, 'okx', false)).length >= 1);

const one = ['bybit', 'kraken'].reduce((d, id) => setVenueEnabled(d, id, false), draft);
check('last venue cannot be disabled', disableImpact(one, 'okx', ctx).blocked !== null);
const two = setVenueEnabled(draft, 'kraken', false);
check('dropping below 2 warns, is allowed', (() => {
  const r = disableImpact(two, 'bybit', ctx);
  return r.blocked === null && r.warnings.some((w) => w.includes('Tests 3 and 4'));
})());
check('disabling replay venue warns', disableImpact(draft, 'okx', ctx).warnings.some((w) => w.includes('replay')));
check('harmless disable has no warnings', disableImpact(draft, 'kraken', ctx).warnings.length === 0);

check('untried venue called ok shows unknown', displayHealth({ enabled: true, health: 'ok', lastOk: null }) === 'unknown');
check('missing health shows unknown', displayHealth({ enabled: true }) === 'unknown');
check('disabled wins', displayHealth({ enabled: false, health: 'ok', lastOk: 1 }) === 'disabled');
check('real failures pass through without lastOk', displayHealth({ enabled: true, health: 'blocked', lastOk: null }) === 'blocked');
check('untried never counts as answering', same(healthSummary(data.venues), { enabled: 3, answering: 2, unknown: 1 }));

check('roles follow the draft', same(venueRoles(moved, 'bybit'), ['Primary bars', 'Consensus']));
check('disabled venue has no roles', venueRoles(draft, 'binance').length === 0);
check('replay and book show on the venue', same(venueRoles(draft, 'okx'), ['Primary bars', 'Consensus', 'Book', 'Replay']));

check('quote array becomes a map', same(quoteMap([{ venue: 'okx', price: 5 }]), { okx: 5 }));
check('agree', consensusView({ ok: true, reason: null, quotes: {} }).label === 'Agree');
check('outlier is ok but amber and named', (() => {
  const v = consensusView({ ok: true, reason: 'outlier_excluded', outliers: [{ venue: 'kraken' }], quotes: {} });
  return v.tone === 'amber' && v.label === 'kraken left out';
})());
check('two-venue split names neither', consensusView({ ok: false, reason: 'venues_disagree', quotes: { okx: 1, bybit: 2 } }).label === '2 venues disagree');
check('wider split is red', consensusView({ ok: false, reason: 'venues_disagree', quotes: { a: 1, b: 2, c: 3 } }).tone === 'red');
check('no majority is red', consensusView({ ok: false, reason: 'no_majority', quotes: {} }).tone === 'red');
check('too few venues is red', consensusView({ ok: false, reason: 'insufficient_venues', quotes: {} }).tone === 'red');
check('not ok never reads as agreeing', consensusView({ ok: false, reason: null, quotes: {} }).tone === 'red');

check('role the server replaced is reported', rolesNotKept({ replay: 'bybit', book: 'okx' }, { replay: 'okx', book: 'okx' }).join() === 'replay');
check('kept roles report nothing', rolesNotKept({ replay: 'okx', book: 'okx' }, { replay: 'okx', book: 'okx' }).length === 0);
check('no roles returned counts as not kept', rolesNotKept({ replay: 'okx', book: null }, undefined).join() === 'replay');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
