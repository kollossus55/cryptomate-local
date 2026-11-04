/**
 * Agent committee (phase 1) tests: vote mapping, every coordinator decision
 * path, agents on synthetic candles, determinism, and record shaping.
 */

import assert from 'node:assert';

import {
  voteFromScore, coordinate, runCommittee, resolveCommitteeSettings,
  deriveHigherTimeframe, buildContext, shouldLogDecision, toDecisionRecord,
  AGENT_NAMES, LONG_AT, AGAINST_AT,
} from '../shared/trading/committee.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

// --- synthetic candles -------------------------------------------------------

/** Deterministic pseudo-noise so tests never depend on Math.random. */
function noise(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

function makeCandles(n, { drift = 0, start = 100, vol = 0.004, volumeRamp = 0 } = {}) {
  const out = [];
  let price = start;
  const t0 = Date.UTC(2026, 9, 1);
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + drift + noise(i) * vol);
    const high = Math.max(open, close) * (1 + Math.abs(noise(i + 7)) * vol);
    const low = Math.min(open, close) * (1 - Math.abs(noise(i + 13)) * vol);
    const volume = 1000 * (1 + Math.abs(noise(i + 3))) * (1 + volumeRamp * Math.max(0, i - (n - 10)));
    out.push({ open, high, low, close, volume, openTime: t0 + i * 3600e3, closeTime: t0 + (i + 1) * 3600e3 - 1 });
    price = close;
  }
  return out;
}

const uptrend = makeCandles(200, { drift: 0.004, volumeRamp: 0.3 });
const downtrend = makeCandles(200, { drift: -0.004 });
const flat = makeCandles(200, { drift: 0, vol: 0.002 });

const v = (agent, vote, confidence = 0.8, extra = {}) =>
  ({ agent, vote, confidence, veto: false, reasons: [], dataOk: true, score: null, ...extra });
const trendCtx = { marketRegime: 'trend' };
const rangeCtx = { marketRegime: 'range' };

// --- vote mapping ------------------------------------------------------------

test('score at LONG_AT votes long with confidence 0.5', () => {
  const r = voteFromScore('x', LONG_AT, []);
  assert.strictEqual(r.vote, 'long');
  assert.strictEqual(r.confidence, 0.5);
});
test('score 90+ votes long with confidence 1', () => {
  assert.strictEqual(voteFromScore('x', 97, []).confidence, 1);
});
test('score at AGAINST_AT votes against', () => {
  assert.strictEqual(voteFromScore('x', AGAINST_AT, []).vote, 'against');
});
test('neutral score abstains', () => {
  assert.strictEqual(voteFromScore('x', 50, []).vote, 'abstain');
});
test('non-finite score abstains', () => {
  assert.strictEqual(voteFromScore('x', NaN, []).vote, 'abstain');
  assert.strictEqual(voteFromScore('x', null, []).vote, 'abstain');
});

// --- coordinator truth table --------------------------------------------------

test('four longs in a trend = enter', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'long'), v('structure', 'long')], trendCtx, {});
  assert.strictEqual(r.decision, 'enter');
  assert.strictEqual(r.committeeScore, 0.8);
});
test('any veto wins over a full quorum', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'long'), v('structure', 'long', 0.8, { veto: { reason: 'x' } })], trendCtx, {});
  assert.strictEqual(r.decision, 'veto');
});
test('two against = dissent', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'against'), v('structure', 'against')], trendCtx, {});
  assert.strictEqual(r.decision, 'dissent');
});
test('an abstain shrinks the pool: three longs + one abstain = enter', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'long'), v('structure', 'abstain', 0)], trendCtx, {});
  assert.strictEqual(r.requiredLong, 3);
  assert.strictEqual(r.decision, 'enter');
});
test('three longs + one against = no_quorum at default 4', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'long'), v('structure', 'against')], trendCtx, {});
  assert.strictEqual(r.requiredLong, 4);
  assert.strictEqual(r.decision, 'no_quorum');
});
test('two longs with everyone else abstaining never enters', () => {
  const r = coordinate([v('trend', 'long', 1), v('momentum', 'long', 1), v('volumeFlow', 'abstain', 0), v('structure', 'abstain', 0)], trendCtx, {});
  assert.strictEqual(r.requiredLong, 3);
  assert.strictEqual(r.decision, 'no_quorum');
});
test('trend agent is ineligible in a range, so quorum drops to 3', () => {
  const votes = [v('trend', 'long', 0.8, { eligibleIn: ['trend'] }), v('momentum', 'long'), v('volumeFlow', 'long'), v('structure', 'long')];
  const r = coordinate(votes, rangeCtx, {});
  assert.strictEqual(r.eligible, 3);
  assert.strictEqual(r.requiredLong, 3);
  assert.strictEqual(r.decision, 'enter');
});
test('fewer than min_eligible agents = no_quorum', () => {
  const r = coordinate([v('momentum', 'long'), v('volumeFlow', 'long', 0.8, { dataOk: false })], trendCtx, {});
  assert.strictEqual(r.decision, 'no_quorum');
  assert.strictEqual(r.eligible, 1);
});
test('missing data never counts as a vote', () => {
  const r = coordinate([v('trend', 'long'), v('momentum', 'long'), v('volumeFlow', 'against', 0.9, { dataOk: false }), v('structure', 'long')], trendCtx, {});
  assert.strictEqual(r.againstVotes, 0);
});
test('weak agreement = low_score', () => {
  const r = coordinate([v('trend', 'long', 0.5), v('momentum', 'long', 0.5), v('volumeFlow', 'long', 0.5), v('structure', 'long', 0.5)], trendCtx, {});
  assert.strictEqual(r.decision, 'low_score');
});
test('one dissent lowers the score through the denominator', () => {
  const r = coordinate([v('trend', 'long', 1), v('momentum', 'long', 1), v('volumeFlow', 'long', 1), v('structure', 'long', 1), v('extra', 'against', 1)], trendCtx, { min_long_votes: 4 });
  assert.strictEqual(r.committeeScore, 0.8);
  assert.strictEqual(r.decision, 'enter');
});
test('weights change the score', () => {
  const votes = [v('trend', 'long', 1), v('momentum', 'against', 1)];
  const r = coordinate(votes, trendCtx, { weights: { trend: 3 } });
  assert.strictEqual(r.committeeScore, 0.75);
});

// --- settings ---------------------------------------------------------------

test('settings default to shadow mode', () => {
  assert.strictEqual(resolveCommitteeSettings(undefined).mode, 'shadow');
});
test('unknown mode falls back to shadow', () => {
  assert.strictEqual(resolveCommitteeSettings({ mode: 'yolo' }).mode, 'shadow');
});
test('min_score is clamped to 0..1', () => {
  assert.strictEqual(resolveCommitteeSettings({ min_score: 7 }).min_score, 1);
});

// --- agents on candles --------------------------------------------------------

test('derived 4h bars: 200 x 1h -> 50 x 4h, closes line up', () => {
  const htf = deriveHigherTimeframe(uptrend, '1h');
  assert.strictEqual(htf.length, 50);
  assert.strictEqual(htf[htf.length - 1].close, uptrend[uptrend.length - 1].close);
  assert.strictEqual(deriveHigherTimeframe(uptrend, '15m'), null);
});
test('too few candles returns null', () => {
  assert.strictEqual(runCommittee({ symbol: 'X', candles: uptrend.slice(0, 20) }, {}), null);
});
test('every agent votes on a clean series', () => {
  const r = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  assert.deepStrictEqual(r.votes.map((x) => x.agent), AGENT_NAMES);
  for (const x of r.votes) assert.ok(['long', 'against', 'abstain'].includes(x.vote), `${x.agent}: ${x.vote}`);
});
test('strong uptrend: Trend agent votes long', () => {
  const r = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  assert.strictEqual(r.votes.find((x) => x.agent === 'trend').vote, 'long');
  assert.strictEqual(r.regime, 'trend');
});
test('strong downtrend: never enter, Trend agent votes against', () => {
  const r = runCommittee({ symbol: 'DNUSDT', candles: downtrend, interval: '1h' }, {});
  assert.notStrictEqual(r.decision, 'enter');
  assert.strictEqual(r.votes.find((x) => x.agent === 'trend').vote, 'against');
});
test('Volume/Flow never votes long on a falling series', () => {
  const heavySelling = makeCandles(200, { drift: -0.004, volumeRamp: 0.5 });
  const r = runCommittee({ symbol: 'DNUSDT', candles: heavySelling, interval: '1h' }, {});
  assert.notStrictEqual(r.votes.find((x) => x.agent === 'volumeFlow').vote, 'long');
});
test('flat market reads as range', () => {
  assert.strictEqual(buildContext({ symbol: 'F', candles: flat }).marketRegime, 'range');
});
test('deterministic: same input, same decision', () => {
  const a = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  const b = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  assert.deepStrictEqual(a, b);
});
test('disabled agent is left out', () => {
  const r = runCommittee({ symbol: 'UPUSDT', candles: uptrend }, { agents_enabled: { structure: false } });
  assert.ok(!r.votes.some((x) => x.agent === 'structure'));
});

// --- logging ------------------------------------------------------------------

test('log filter keeps legacy entries and 2+ long votes only', () => {
  assert.strictEqual(shouldLogDecision({ longVotes: 0, decision: 'no_quorum' }, 'enter'), true);
  assert.strictEqual(shouldLogDecision({ longVotes: 2, decision: 'no_quorum' }, 'skip'), true);
  assert.strictEqual(shouldLogDecision({ longVotes: 1, decision: 'dissent' }, 'skip'), false);
  assert.strictEqual(shouldLogDecision(null, 'enter'), false);
});
test('decision record carries votes, legacy decision and empty outcome', () => {
  const result = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  const rec = toDecisionRecord({
    result, cycleId: 'c1', evaluatedAt: '2026-11-04T00:00:00Z', interval: '1h', mode: 'shadow',
    legacyDecision: 'enter', legacyStrength: 74, legacyTraded: true, ownerEmail: 'op@local',
  });
  assert.strictEqual(rec.symbol, 'UPUSDT');
  assert.strictEqual(rec.votes.length, AGENT_NAMES.length);
  assert.strictEqual(rec.legacy_traded, true);
  assert.strictEqual(rec.outcome, null);
  assert.ok(JSON.stringify(rec)); // serialisable for the JSON entity store
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
