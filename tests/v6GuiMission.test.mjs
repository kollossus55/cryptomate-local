// Logic behind Mission Control and Risk Controls. Run: node tests/v6GuiMission.test.mjs
// limitLogic runs the real clampRiskConfig, DEFAULT_RISK_CONFIG and HARD_CEILINGS.
import { DEFAULT_RISK_CONFIG, HARD_CEILINGS, clampRiskConfig } from '../shared/trading/v6Risk.js';
import { buildFields, defaultsDiff, direction, evaluateDrafts, fieldMeta, formatLimit, parseInput, toInput } from '../src/components/v6/risk/limitLogic.js';
import { LIMIT_META } from '../src/components/v6/risk/limitMeta.js';
import { floorResetOffer, floorView, panelActions, panelMode, rebaseExposure, recutoverOffer, reviewText, selfClearingBlocks } from '../src/components/v6/risk/haltLogic.js';
import { deriveAllTime } from '../src/components/v6/shared/allTimeLogic.js';
import { axisFor } from '../src/components/v6/mission/chartAxis.js';
import { RISK_META } from '../base44/functions/v6Control/control.js';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
};

const data = { config: clampRiskConfig(DEFAULT_RISK_CONFIG), defaults: DEFAULT_RISK_CONFIG, ceilings: HARD_CEILINGS, meta: RISK_META };
const fields = buildFields(data);
const f = (k) => fields.find((x) => x.key === k);

// Every limit in the engine has words, and direction agrees with the API's list.
eq('every engine key has local wording', Object.keys(HARD_CEILINGS).filter((k) => !LIMIT_META[k]?.label), []);
eq('every editable key has help text', fields.filter((x) => x.editable && !x.meta.help).map((x) => x.key), []);
eq('help is never just the label', fields.filter((x) => x.meta.help === x.meta.label).map((x) => x.key), []);
eq('looser matches the API', Object.keys(RISK_META).filter((k) => LIMIT_META[k].looser && LIMIT_META[k].looser !== RISK_META[k].looser), []);
eq('costs are read-only and fixed', ['defaultFeePct', 'defaultSlipPct', 'stopGapSlipPct'].map((k) => [f(k).editable, f(k).meta.group]), [[false, 'fixed'], [false, 'fixed'], [false, 'fixed']]);
eq('BTC breakers stay in the loss group', f('btcDrop24hPct').meta.group, 'loss');

// Display.
eq('percent', formatLimit(0.005, f('riskPerTradePct').meta), '0.5%');
eq('loss shows a minus', formatLimit(0.05, f('ladderHalfPct').meta), '-5%');
eq('dollars', formatLimit(25, f('minNotional').meta), '$25');
eq('hours', formatLimit(24, f('marketCooldownHours').meta), '24h');
eq('no float dust', toInput(0.07, f('ladderHalfPct').meta), '7');
eq('parse strips minus on loss fields', parseInput('-5', f('ladderHalfPct').meta), 0.05);
eq('parse keeps a minus invalid elsewhere', parseInput('-5', f('riskPerTradePct').meta), null);
eq('parse rejects text', parseInput('abc', f('riskPerTradePct').meta), null);
eq('parse rejects blank', parseInput(' ', f('riskPerTradePct').meta), null);

// Direction.
eq('more risk is looser', direction(f('riskPerTradePct').meta, 0.005, 0.008), 'looser');
eq('fewer venues is looser', direction(f('minHealthyVenues').meta, 3, 2), 'looser');
eq('deeper halt is looser', direction(f('ladderHaltPct').meta, 0.15, 0.2), 'looser');

// Validation.
const run = (drafts, opts) => evaluateDrafts(fields, drafts, opts);
eq('unchanged draft is no change', run({ riskPerTradePct: '0.5' }).changes.length, 0);
eq('valid change makes a patch', run({ riskPerTradePct: '0.4' }).patch, { riskPerTradePct: 0.004 });
eq('above ceiling refused', run({ riskPerTradePct: '2' }).errors.riskPerTradePct, 'Allowed 0.05% to 1%.');
eq('above ceiling never reaches the patch', run({ riskPerTradePct: '2' }).patch, {});
eq('blank is an error', run({ riskPerTradePct: '' }).errors.riskPerTradePct, 'Enter a number.');
eq('rung order: clamp would move a neighbour, so it is flagged',
  Object.keys(run({ ladderHaltPct: '15' }).errors), ['ladderNoEntryPct']);
eq('daily looser than weekly flagged', Object.keys(run({ dailyLossPct: '3', weeklyLossPct: '2' }).errors), ['dailyLossPct']);
eq('fractional venues flagged', Object.keys(run({ minHealthyVenues: '2.5' }).errors), ['minHealthyVenues']);
eq('loosen blocked', Object.keys(run({ riskPerTradePct: '0.8' }, { loosenBlocked: true }).errors), ['riskPerTradePct']);
eq('tighten still allowed while blocked', run({ riskPerTradePct: '0.4' }, { loosenBlocked: true }).errors, {});
eq('read-only keys never patch', run({ defaultFeePct: '0.5' }).patch, {});
eq('defaults diff empty at defaults', defaultsDiff(fields).length, 0);

// Missing range: no guessing.
const noCeil = buildFields({ ...data, ceilings: {} });
eq('no ceiling means not editable', noCeil.filter((x) => x.editable).length, 0);

// Halt panel.
const st = (risk, extra = {}) => ({ risk, positions: [], headline: { state: 'WAITING' }, ...extra });
eq('normal', panelMode(st({ halted: null })), 'normal');
eq('manual pause', panelMode(st({ halted: { source: 'manual', flatten: false } })), 'paused');
eq('manual flatten is halted, not paused', panelMode(st({ halted: { source: 'manual', flatten: true } })), 'halted');
eq('drawdown halt', panelMode(st({ halted: { source: 'drawdown', flatten: true } })), 'halted');
eq('fail safe', panelMode(st({ halted: { source: 'fail_safe' } })), 'fail_safe');
eq('null risk state reports HALTED with no record', panelMode(st({ halted: null }, { headline: { state: 'HALTED' } })), 'fail_safe');
eq('needs review by headline', panelMode(st({ halted: null }, { headline: { state: 'NEEDS_REVIEW' } })), 'review');
eq('needs review by flag on a lower rung', panelMode(st({ halted: null, review: { needed: true } })), 'review');
eq('too-small wording does not claim entries are blocked', /stopped/.test(reviewText({ review: { reason: 'flat_entries_too_small' } }, String).body), false);
eq('too-small wording from the rung alone, as the API sends it', reviewText({ rung: 2, drawdownPct: -11 }, String).title, 'Cannot recover by itself');
eq('rung 3 wording says entries stopped', reviewText({ rung: 3, drawdownPct: -15 }, String).title, 'No new entries, and cannot recover by itself');
eq('no flatten when flat', panelActions(st({ halted: null })).canFlatten, false);
eq('flatten offered with positions', panelActions(st({ halted: null }, { positions: [{}] })).canFlatten, true);
eq('no second flatten while closing', panelActions(st({ halted: { source: 'drawdown', flatten: true } }, { positions: [{}] })).canFlatten, false);
eq('pending request locks actions', panelActions(st({ halted: null, requestPending: 'pause' }, { positions: [{}] })).canPause, false);
eq('re-enable follows the server flag', panelActions(st({ halted: { source: 'drawdown', flatten: true }, reenable: { available: false } })).canReenable, false);
eq('unmet check keeps the button off', panelActions(st({ halted: { source: 'drawdown', flatten: true }, reenable: { available: true, preconditions: [{ ok: false }] } })).canReenable, false);
eq('met checks turn it on', panelActions(st({ halted: { source: 'drawdown', flatten: true }, reenable: { available: true, preconditions: [{ ok: true }] } })).canReenable, true);
eq('weekly with no reset time', selfClearingBlocks({ weekly: { lossPct: -5, limitPct: -4, resetsAt: null } }, () => 'x')[0].includes('next UTC Monday'), true);

// Re-enable exposure (r-risk requirement).
const r1 = (v) => Math.round(v * 10) / 10;
const ex = rebaseExposure({ known: true, drawdownPct: -20.4, highEquity: 12010, reenables: 2, atLeast: false }, 9560, -20);
eq('next flatten equity is 20% under the new high', r1(ex.nextHaltEquity), 7648);
eq('next flatten measured from the all-time high', r1(ex.nextHaltFromAllTimePct), -36.3);
eq('current fall passes through', ex.nowFromAllTimePct, -20.4);
const top = rebaseExposure({ known: true, drawdownPct: 0, highEquity: 10000, reenables: 0 }, 10000, -20);
eq('at the high the two measures agree', r1(top.nextHaltFromAllTimePct), -20);
const lost = rebaseExposure({ known: false }, 9560, -20);
eq('unknown high keeps the equity level, no invented figure', [r1(lost.nextHaltEquity), lost.nextHaltFromAllTimePct, lost.known], [7648, null, false]);
eq('no ladder config gives no level', rebaseExposure({ known: false }, 9560, undefined).nextHaltEquity, null);
eq('at-least carries over', rebaseExposure({ known: true, drawdownPct: -5, highEquity: 11000, atLeast: true }, 9000, -20).atLeast, true);

// Recutover is offered only when the state is really gone and the account is flat.
const lostEvent = [{ code: 'state_missing', clearedAt: null }];
const gone = { engine: { lastTickAt: null }, positions: [], quarantinedPositions: [] };
eq('lost and flat is offered', recutoverOffer(gone, lostEvent), { stateLost: true, available: true });
eq('first run, no event, is not offered', recutoverOffer(gone, []).stateLost, false);
eq('events not loaded is not offered', recutoverOffer(gone, undefined).available, false);
eq('working engine with a leftover event is not offered', recutoverOffer({ ...gone, engine: { lastTickAt: 5 } }, lostEvent).stateLost, false);
eq('cleared event is not offered', recutoverOffer(gone, [{ code: 'state_missing', clearedAt: 9 }]).stateLost, false);
eq('portfolio_missing does not count', recutoverOffer(gone, [{ code: 'portfolio_missing' }]).stateLost, false);
eq('open position blocks it', recutoverOffer({ ...gone, positions: [{}] }, lostEvent), { stateLost: true, available: false });
eq('quarantined row blocks it', recutoverOffer({ ...gone, quarantinedPositions: [{}] }, lostEvent), { stateLost: true, available: false });

// Chart axis.
const even = (t) => new Set(t.slice(1).map((v, i) => v - t[i])).size === 1;
for (const [label, pts] of [['small range', [{ equityIndex: 99.2, btcIndex: 108 }]], ['wide range', [{ equityIndex: 62, btcIndex: 240 }]], ['flat', [{ equityIndex: 100, btcIndex: 100 }]]]) {
  const { ticks, domain } = axisFor(pts);
  eq(`axis ticks even, ${label}`, even(ticks), true);
  eq(`axis includes 100, ${label}`, ticks.includes(100), true);
  eq(`axis covers data, ${label}`, domain[0] <= Math.min(pts[0].equityIndex, pts[0].btcIndex) && domain[1] >= Math.max(pts[0].equityIndex, pts[0].btcIndex), true);
}

// All-time drawdown.
const acct = { equity: 9000, startingEquity: 10000 };
eq('API figure wins', deriveAllTime({ account: acct, risk: { allTime: { drawdownPct: -25, highEquity: 12000, reenables: 2 } } }, null).drawdownPct, -25);
eq('curve fallback survives a rebased peak', Math.round(deriveAllTime({ account: acct, risk: { peakEquity: 9500 } }, { points: [{ t: 1, equity: 12000 }] }).drawdownPct), -25);
eq('thinned curve is flagged at-least', deriveAllTime({ account: acct, risk: {} }, { points: [{ t: 1, equity: 12000 }], downsampled: true }).atLeast, true);
eq('fail safe shows no figure', deriveAllTime({ account: acct, risk: { halted: { source: 'fail_safe' } } }, { points: [] }).known, false);

// Drawdown floor (CONTRACT section 6, 2026-11-07).
const fmt = { money: (v) => `$${Math.round(v)}`, pct: (v, d = 1) => `${v.toFixed(d)}%` };
const floorAt = (patch = {}) => ({ pct: -30, reference: 12000, level: 8400, drawdownPct: -20, pointsAbove: 10, dollarsAbove: 1200, breached: false,
  reset: { available: false, preconditions: [{ id: 'breached', ok: false }, { id: 'halted', ok: false }, { id: 'flat', ok: true }] }, ...patch });
const far = floorView(floorAt(), fmt);
eq('floor: distance in points and dollars', far.line.includes('10.0 points ($1200) above it') && far.line.includes('$8400') && far.line.includes('-30%'), true);
eq('floor: far is neutral', far.tone, 'slate');
eq('floor: within 5 points turns amber', floorView(floorAt({ pointsAbove: 4.9 }), fmt).tone, 'amber');
const reached = floorView(floorAt({ breached: true, breachEquity: 8350 }), fmt);
eq('floor: reached is red and says a re-enable does not clear it', [reached.tone, reached.line.includes('A re-enable does not clear this')], ['red', true]);
eq('floor: unknown level shows no figure', floorView({ breached: false }, fmt).known, false);
eq('floor: missing floor does not throw', floorView(undefined, fmt).line.length > 0, true);
const banned = /guarantee|\bsure\b|safe bet|risk-free|proven|confidence|strength|accuracy|smart|recommended/i;
eq('floor: wording has no banned words', [far, reached, floorView(null, fmt)].some((v) => banned.test(v.line)), false);
// Re-enable dialog: the floor's distance is part of the exposure, and which comes first.
const withFloor = rebaseExposure({ known: true, drawdownPct: -25, highEquity: 12000, reenables: 1 }, 9000, -20, floorAt({ pointsAbove: 5, dollarsAbove: 600 }));
eq('dialog: floor level and distance', [withFloor.floorLevel, withFloor.floorPointsAbove, withFloor.floorDollarsAbove], [8400, 5, 600]);
eq('dialog: floor at 8400 comes before the ladder flatten at 7200', withFloor.floorFirst, true);
eq('dialog: ladder first when it is higher', rebaseExposure({ known: true, drawdownPct: 0, highEquity: 12000 }, 12000, -20, floorAt()).floorFirst, false);
eq('dialog: no floor known', rebaseExposure({ known: true, drawdownPct: 0, highEquity: 12000 }, 12000, -20).floorLevel, null);
// Re-enable is disabled by the server's floor precondition; reset follows the server and any pending request.
const floorHalt = {
  headline: { state: 'HALTED' },
  positions: [],
  risk: {
    halted: { source: 'floor', flatten: true },
    reenable: { available: true, willRebase: false, preconditions: [{ id: 'floor', label: 'Drawdown floor reset first', ok: false }] },
    floor: floorAt({ breached: true, reset: { available: true, preconditions: [{ id: 'breached', ok: true }, { id: 'halted', ok: true }, { id: 'flat', ok: true }] } }),
  },
};
eq('floor halt renders halted', panelMode(floorHalt), 'halted');
eq('floor halt: re-enable disabled', panelActions(floorHalt).canReenable, false);
eq('floor halt: reset offered', floorResetOffer(floorHalt), { show: true, available: true, preconditions: floorHalt.risk.floor.reset.preconditions });
eq('floor reset: not while a request is pending', floorResetOffer({ ...floorHalt, risk: { ...floorHalt.risk, requestPending: 'resetFloor' } }).available, false);
eq('floor reset: not when a check fails', floorResetOffer({ ...floorHalt, risk: { ...floorHalt.risk, floor: floorAt({ breached: true, reset: { available: true, preconditions: [{ id: 'flat', ok: false }] } }) } }).available, false);
eq('floor reset: hidden when not reached', floorResetOffer({ risk: { floor: floorAt() } }).show, false);

console.log(fails ? `${fails} FAILED` : 'all logic checks passed');
process.exitCode = fails ? 1 : 0;
