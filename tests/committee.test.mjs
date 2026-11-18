/**
 * Agent committee (phase 1) tests: vote mapping, every coordinator decision
 * path, agents on synthetic candles, determinism, and record shaping.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  voteFromScore, coordinate, runCommittee, resolveCommitteeSettings,
  deriveHigherTimeframe, buildContext, shouldLogDecision, toDecisionRecord,
  marketRegimeAgent, derivativesAgent, liquidityAgent, candlePrePass, buildMarketContext,
  computeOutcome, outcomeRipeHours, filterVerdict, decisionKey,
  AGENT_NAMES, LONG_AT, AGAINST_AT,
} from '../shared/trading/committee.js';
import { EntityStore } from '../server/entityStore.js';
import { isStableBase, isCryptoBase } from '../shared/trading/marketData.js';
import { dedupeDecisions, summarizeFilter, agentScorecard, engineComparison, outcomeSummary } from '../src/lib/committeeStats.js';

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
});
test('derived 1d bars from 4h: 200 -> 33, unmapped interval -> null', () => {
  const htf = deriveHigherTimeframe(uptrend, '4h');
  assert.strictEqual(htf.length, 33);
  assert.strictEqual(htf[htf.length - 1].close, uptrend[uptrend.length - 1].close);
  assert.strictEqual(deriveHigherTimeframe(uptrend, '1d'), null);
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

// --- phase 2: context agents ---------------------------------------------------

const S = resolveCommitteeSettings({});
const ctxWith = (extra, candles = uptrend, interval = '1h') => buildContext({ symbol: 'UPUSDT', candles, interval, ...extra });

test('marketRegime vetoes a sharp BTC drop', () => {
  const crash = makeCandles(200, { drift: 0.001 });
  for (let k = 196; k < 200; k++) { crash[k] = { ...crash[k], close: crash[k - 1].close * 0.985 }; }
  const v = marketRegimeAgent(ctxWith({ market: { btcCandles: crash, breadth: null } }), S);
  assert.ok(v.veto, 'expected a veto');
});
test('marketRegime vetoes weak breadth when breadth_veto is set', () => {
  const v = marketRegimeAgent(ctxWith({ market: { btcCandles: uptrend, breadth: { above: 2, total: 20, share: 0.1 } } }), resolveCommitteeSettings({ breadth_veto: 0.25 }));
  assert.ok(v.veto);
});
test('marketRegime breadth veto is off by default', () => {
  const v = marketRegimeAgent(ctxWith({ market: { btcCandles: uptrend, breadth: { above: 2, total: 20, share: 0.1 } } }), S);
  assert.ok(!v.veto);
  assert.strictEqual(v.vote, 'abstain');
});
test('marketRegime never votes long, even in a strong market', () => {
  const v = marketRegimeAgent(ctxWith({ market: { btcCandles: uptrend, breadth: { above: 18, total: 20, share: 0.9 } } }), S);
  assert.strictEqual(v.vote, 'abstain');
  assert.ok(!v.veto);
});
test('marketRegime abstains in a weak market but logs the reading', () => {
  const v = marketRegimeAgent(ctxWith({ market: { btcCandles: downtrend, breadth: { above: 6, total: 20, share: 0.3 } } }), S);
  assert.strictEqual(v.vote, 'abstain');
  assert.ok(v.score <= 40, `score ${v.score} should still read weak`);
  assert.match(v.reasons[0], /Weak market/);
});
test('marketRegime without BTC data is no-data', () => {
  assert.strictEqual(marketRegimeAgent(ctxWith({}), S).dataOk, false);
});

const hourly = (n, fn) => Array.from({ length: n }, (_, i) => ({ ts: Date.UTC(2026, 10, 1) + i * 3600e3, value: fn(i) }));
test('derivatives: not fetched vs no perpetual are both no-data', () => {
  assert.strictEqual(derivativesAgent(ctxWith({}), S).dataOk, false);
  assert.strictEqual(derivativesAgent(ctxWith({ derivatives: null }), S).dataOk, false);
});
test('derivatives vetoes crowded funding', () => {
  const v = derivativesAgent(ctxWith({ derivatives: { fundingRate: 0.001, openInterest: [], longShort: [] } }), S);
  assert.ok(v.veto);
});
test('derivatives votes long when OI rises with price', () => {
  const v = derivativesAgent(ctxWith({ derivatives: { fundingRate: 0.0001, openInterest: hourly(48, (i) => 1e8 * (1 + i * 0.004)), longShort: [] } }), S);
  assert.strictEqual(v.vote, 'long');
});
test('derivatives votes against when OI rises into a falling price', () => {
  const v = derivativesAgent(ctxWith({ derivatives: { fundingRate: 0.0001, openInterest: hourly(48, (i) => 1e8 * (1 + i * 0.004)), longShort: [] } }, downtrend), S);
  assert.strictEqual(v.vote, 'against');
});

const book = (bidDepth, askDepth, spread = 0.0002) => {
  const mid = 100;
  const bids = Array.from({ length: 20 }, (_, i) => [mid * (1 - spread / 2 - i * 0.001), bidDepth / 20 / mid]);
  const asks = Array.from({ length: 20 }, (_, i) => [mid * (1 + spread / 2 + i * 0.001), askDepth / 20 / mid]);
  return { bids, asks };
};
test('liquidity: not fetched is no-data', () => {
  assert.strictEqual(liquidityAgent(ctxWith({}), S).dataOk, false);
});
test('liquidity vetoes a wide spread', () => {
  assert.ok(liquidityAgent(ctxWith({ orderBook: book(1e6, 1e6, 0.01) }), S).veto);
});
test('liquidity vetoes a book that cannot absorb the probe', () => {
  assert.ok(liquidityAgent(ctxWith({ orderBook: book(1e6, 200) }), S).veto);
});
test('liquidity votes long on bid-heavy book, against on ask-heavy, abstains when balanced', () => {
  assert.strictEqual(liquidityAgent(ctxWith({ orderBook: book(4e6, 1e6) }), S).vote, 'long');
  assert.strictEqual(liquidityAgent(ctxWith({ orderBook: book(1e6, 4e6) }), S).vote, 'against');
  assert.strictEqual(liquidityAgent(ctxWith({ orderBook: book(1e6, 1e6) }), S).vote, 'abstain');
});
test('a context-agent veto blocks an otherwise unanimous committee', () => {
  const r = runCommittee({ symbol: 'UPUSDT', candles: uptrend, interval: '1h', orderBook: book(1e6, 1e6, 0.01) }, {});
  assert.strictEqual(r.decision, 'veto');
});
test('candlePrePass counts only candle agents', () => {
  const p = candlePrePass({ symbol: 'UPUSDT', candles: uptrend, interval: '1h' }, {});
  assert.ok(p.long >= 2 && p.long <= 4);
});
test('buildMarketContext: breadth needs at least 10 assets', () => {
  const few = new Map([['A', uptrend], ['B', downtrend]]);
  assert.strictEqual(buildMarketContext(few, uptrend).breadth, null);
  const many = new Map(Array.from({ length: 10 }, (_, i) => [`S${i}`, i < 7 ? uptrend : downtrend]));
  assert.strictEqual(buildMarketContext(many, uptrend).breadth.share, 0.7);
});

// --- phase 2: outcomes -----------------------------------------------------------

const flatBars = (n, price, interval = 3600e3, t0 = Date.UTC(2026, 10, 1)) =>
  Array.from({ length: n }, (_, i) => ({ openTime: t0 + i * interval, open: price, high: price, low: price, close: price, closeTime: t0 + (i + 1) * interval - 1 }));

test('outcome enters at the next bar open (no look-ahead)', () => {
  const bars = flatBars(40, 100);
  bars[5] = { ...bars[5], open: 101, high: 101, low: 101, close: 101 };
  const o = computeOutcome(bars, bars[4].openTime + 1);
  assert.strictEqual(o.entry_price, 101);
});
test('outcome is null until the window has closed', () => {
  assert.strictEqual(computeOutcome(flatBars(20, 100), Date.UTC(2026, 10, 1)), null);
});
test('stop wins when one bar spans both TP and SL', () => {
  const bars = flatBars(40, 100);
  bars[3] = { ...bars[3], high: 120, low: 90 };
  const o = computeOutcome(bars, bars[0].openTime, { takeProfitPercent: 8, stopLossPercent: 3 });
  assert.strictEqual(o.first_hit, 'sl');
  assert.strictEqual(o.bars_to_exit, 4);
});
test('take-profit recorded when hit first', () => {
  const bars = flatBars(40, 100);
  bars[2] = { ...bars[2], high: 110 };
  assert.strictEqual(computeOutcome(bars, bars[0].openTime).first_hit, 'tp');
});
test('4h outcome: 24 bars = 96h horizon, ret_4h is the first bar', () => {
  const bars = flatBars(40, 100, 4 * 3600e3);
  bars[0] = { ...bars[0], close: 102 };
  const o = computeOutcome(bars, bars[0].openTime, {}, '4h');
  assert.strictEqual(o.horizon_hours, 96);
  assert.strictEqual(o.ret_4h, 2);
  assert.strictEqual(o.ret_24h, 0);
});
test('ripeness scales with the interval', () => {
  assert.strictEqual(outcomeRipeHours('1h'), 25);
  assert.strictEqual(outcomeRipeHours('4h'), 100);
});

// --- entity store batch update ---------------------------------------------------

test('bulkUpdate patches many rows in one write and counts unknown ids', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-committee-'));
  try {
    const store = new EntityStore(dir);
    const [a, b] = store.bulkCreate('CommitteeDecision', [{ symbol: 'A', outcome: null }, { symbol: 'B', outcome: null }]);
    const r = store.bulkUpdate('CommitteeDecision', [
      { id: a.id, data: { outcome: { ret_24h: 1 } } },
      { id: b.id, data: { outcome: { ret_24h: -2 }, id: 'hijack' } },
      { id: 'nope', data: { outcome: {} } },
    ]);
    assert.deepStrictEqual(r, { updated: 2, missing: 1 });
    const reloaded = new EntityStore(dir);
    assert.strictEqual(reloaded.get('CommitteeDecision', a.id).outcome.ret_24h, 1);
    assert.strictEqual(reloaded.get('CommitteeDecision', b.id).outcome.ret_24h, -2);
    assert.strictEqual(reloaded.list('CommitteeDecision', { filter: { outcome: null } }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- filter role -------------------------------------------------------------

const fv = (votes) => ({ votes: votes.map((v) => ({ eligible: true, veto: false, ...v })) });
test('filter: defaults to the filter role, blocking at 2 against', () => {
  const s = resolveCommitteeSettings({});
  assert.strictEqual(s.role, 'filter');
  assert.strictEqual(s.block_against, 2);
  assert.strictEqual(resolveCommitteeSettings({ role: 'nonsense' }).role, 'filter');
});
test('filter: no objections allows', () => {
  assert.strictEqual(filterVerdict(fv([{ agent: 'trend', vote: 'long' }, { agent: 'momentum', vote: 'abstain' }]), {}).verdict, 'allow');
});
test('filter: one against allows, two block', () => {
  assert.strictEqual(filterVerdict(fv([{ agent: 'trend', vote: 'against' }, { agent: 'momentum', vote: 'long' }]), {}).verdict, 'allow');
  const r = filterVerdict(fv([{ agent: 'trend', vote: 'against' }, { agent: 'momentum', vote: 'against' }]), {});
  assert.strictEqual(r.verdict, 'block');
  assert.match(r.reason, /trend, momentum/);
});
test('filter: any veto blocks, even with every other agent long', () => {
  const r = filterVerdict(fv([
    { agent: 'trend', vote: 'long' }, { agent: 'momentum', vote: 'long' },
    { agent: 'derivatives', vote: 'against', veto: { reason: 'Funding 0.080%/8h' } },
  ]), {});
  assert.strictEqual(r.verdict, 'block');
  assert.match(r.reason, /derivatives.*Funding/);
});
test('filter: ineligible votes do not count', () => {
  const r = filterVerdict(fv([
    { agent: 'trend', vote: 'against', eligible: false },
    { agent: 'momentum', vote: 'against' },
    { agent: 'liquidity', vote: 'against', veto: { reason: 'x' }, eligible: false },
  ]), {});
  assert.strictEqual(r.verdict, 'allow');
});
test('filter: block_against is configurable; null result allows', () => {
  const two = fv([{ agent: 'trend', vote: 'against' }, { agent: 'momentum', vote: 'against' }]);
  assert.strictEqual(filterVerdict(two, { block_against: 3 }).verdict, 'allow');
  assert.strictEqual(filterVerdict(null, {}).verdict, 'allow');
});
test('filter: decision record carries the verdict (null when legacy skipped)', () => {
  const result = runCommittee({ symbol: 'UPUSDT', candles: uptrend }, {});
  const rec = toDecisionRecord({ result, cycleId: 'c', evaluatedAt: 'now', interval: '1h', mode: 'shadow', legacyDecision: 'enter', filter: { verdict: 'block', reason: 'r' } });
  assert.strictEqual(rec.filter_verdict, 'block');
  assert.strictEqual(rec.filter_reason, 'r');
  const skip = toDecisionRecord({ result, cycleId: 'c', evaluatedAt: 'now', interval: '1h', mode: 'shadow', legacyDecision: 'skip' });
  assert.strictEqual(skip.filter_verdict, null);
});

// --- phase 3: dedupe + page stats --------------------------------------------

test('decisionKey: symbol + candle + legacy decision', () => {
  assert.strictEqual(decisionKey({ symbol: 'A', bar_time: 'T', legacy_decision: 'enter' }), 'A|T|enter');
  const result = runCommittee({ symbol: 'UPUSDT', candles: uptrend }, {});
  const rec = toDecisionRecord({ result, cycleId: 'c', evaluatedAt: 'now', interval: '1h', mode: 'shadow', legacyDecision: 'skip', barTime: '2026-11-04T16:00:00.000Z' });
  assert.strictEqual(rec.bar_time, '2026-11-04T16:00:00.000Z');
});

const rec = (o) => ({ symbol: 'A', bar_time: 'T1', legacy_decision: 'enter', filter_verdict: 'allow', evaluated_at: '2026-11-04T16:05:00Z', votes: [], outcome: null, ...o });
const out = (first_hit, ret_24h = 0) => ({ first_hit, ret_24h, max_up: 1, max_down: -1 });

test('stats: dedupe keeps the earliest per symbol/candle/decision, enter separate from skip', () => {
  const rows = dedupeDecisions([
    rec({ id: 2, evaluated_at: '2026-11-04T16:10:00Z' }),
    rec({ id: 1, evaluated_at: '2026-11-04T16:05:00Z' }),
    rec({ id: 3, legacy_decision: 'skip' }),
    rec({ id: 4, bar_time: 'T2' }),
  ]);
  assert.deepStrictEqual(rows.map((r) => r.id).sort(), [1, 3, 4]);
});
test('stats: dedupe falls back to the evaluated hour without bar_time', () => {
  const rows = dedupeDecisions([rec({ id: 1, bar_time: undefined }), rec({ id: 2, bar_time: undefined, evaluated_at: '2026-11-04T16:55:00Z' }), rec({ id: 3, bar_time: undefined, evaluated_at: '2026-11-04T17:00:00Z' })]);
  assert.strictEqual(rows.length, 2);
});
test('stats: outcomeSummary counts only resolved rows', () => {
  const s = outcomeSummary([rec({ outcome: out('tp', 4) }), rec({ outcome: out('sl', -2) }), rec({})]);
  assert.strictEqual(s.total, 3); assert.strictEqual(s.resolved, 2); assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.winRate, 50); assert.strictEqual(s.stopRate, 50); assert.strictEqual(s.avgRet24h, 1);
});
const many = (n, verdict, hit, extra = {}) => Array.from({ length: n }, (_, i) => rec({ symbol: verdict + hit + i, filter_verdict: verdict, outcome: out(hit), ...extra }));
test('stats: filter verdict waits for the minimum sample', () => {
  const s = summarizeFilter([...many(5, 'allow', 'tp'), ...many(5, 'block', 'sl')]);
  assert.strictEqual(s.verdict, 'collecting');
});
test('stats: filter verdict helping / hurting / inconclusive', () => {
  const help = summarizeFilter([...many(20, 'allow', 'tp'), ...many(20, 'allow', 'sl'), ...many(10, 'block', 'tp'), ...many(30, 'block', 'sl')], { minSample: 30 });
  assert.strictEqual(help.verdict, 'helping');
  const hurt = summarizeFilter([...many(10, 'allow', 'tp'), ...many(30, 'allow', 'sl'), ...many(20, 'block', 'tp'), ...many(20, 'block', 'sl')], { minSample: 30 });
  assert.strictEqual(hurt.verdict, 'hurting');
  const flat = summarizeFilter([...many(20, 'allow', 'tp'), ...many(20, 'allow', 'sl'), ...many(20, 'block', 'tp'), ...many(20, 'block', 'sl')], { minSample: 30 });
  assert.strictEqual(flat.verdict, 'inconclusive');
});
test('stats: filter ignores non-picks and groups block reasons by veto agent', () => {
  const vetoVotes = [{ agent: 'derivatives', eligible: true, veto: { reason: 'x' }, vote: 'against' }];
  const s = summarizeFilter([
    rec({ symbol: 'S', legacy_decision: 'skip', filter_verdict: null }),
    rec({ symbol: 'B1', filter_verdict: 'block', votes: vetoVotes }),
    rec({ symbol: 'B2', filter_verdict: 'block', votes: [] }),
  ]);
  assert.strictEqual(s.picks, 2);
  assert.deepStrictEqual(s.blockReasons.map((b) => b.label).sort(), ['against votes', 'veto: derivatives']);
});
test('stats: agent scorecard buckets votes on legacy picks', () => {
  const rows = [
    rec({ symbol: 'X', outcome: out('tp'), votes: [{ agent: 'trend', vote: 'long', data_ok: true }, { agent: 'liquidity', vote: 'abstain', data_ok: false }] }),
    rec({ symbol: 'Y', outcome: out('sl'), votes: [{ agent: 'trend', vote: 'against', data_ok: true }] }),
    rec({ symbol: 'Z', legacy_decision: 'skip', votes: [{ agent: 'trend', vote: 'long', data_ok: true }] }),
  ];
  const card = agentScorecard(rows);
  const trend = card.find((a) => a.agent === 'trend');
  assert.strictEqual(trend.long.total, 1); assert.strictEqual(trend.long.winRate, 100);
  assert.strictEqual(trend.against.total, 1); assert.strictEqual(trend.against.winRate, 0);
  assert.strictEqual(card.find((a) => a.agent === 'liquidity').noData, 1);
});
test('stats: engine comparison', () => {
  const e = engineComparison([rec({ symbol: 'L', decision: 'no_quorum', outcome: out('tp') }), rec({ symbol: 'C', legacy_decision: 'skip', decision: 'enter', outcome: out('sl') })]);
  assert.strictEqual(e.legacy.total, 1); assert.strictEqual(e.committee.total, 1); assert.strictEqual(e.committee.winRate, 0);
});

// --- universe: stablecoins, tokenised stocks, commodities ---------------------

test('universe: stablecoins are excluded, including unknown USDx', () => {
  for (const b of ['USDC', 'USDG', 'RLUSD', 'PYUSD', 'USD1', 'USDNEW', 'EUR']) assert.ok(isStableBase(b), b);
  for (const b of ['SUI', 'ENA', 'UNI', 'AAVE']) assert.ok(!isStableBase(b), b);
});
test('universe: OKX non-crypto categories and gold are excluded, X-named coins are not', () => {
  const nonCrypto = new Set(['XGOOGL', 'XAAPL', 'XMSTR']);
  for (const b of ['XGOOGL', 'XMSTR', 'XAUT', 'PAXG']) assert.ok(!isCryptoBase(b, nonCrypto), b);
  for (const b of ['XLM', 'XTZ', 'XDC', 'ZEC']) assert.ok(isCryptoBase(b, nonCrypto), b);
  assert.ok(isCryptoBase('XLM', null), 'no category data = no category filter');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
