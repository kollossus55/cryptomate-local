// Wording for each limit, from docs/rebuild/risk-engine.md and gui-design 5.4. This file
// holds words and display rules only. Every number shown (value, default, allowed range)
// comes from the riskConfig response, so a guessed limit can never appear. See fieldMeta in
// limitLogic.js for how this merges with the API's `meta`.
//
// `looser` is the direction, in engine units, that relaxes the limit. It differs by key:
// a higher minHealthyVenues is stricter, a higher riskPerTradePct is looser.

const percent = { scale: 100, unit: '%', step: 0.05, sign: 1 };
const loss = { scale: 100, unit: '%', step: 0.5, sign: -1, looser: 'up' };

export const GROUPS = [
  { id: 'trade', title: 'Per trade' },
  { id: 'portfolio', title: 'Portfolio' },
  { id: 'ladder', title: 'Drawdown ladder (from equity high)' },
  { id: 'loss', title: 'Loss limits and market breaker' },
];

export const ADVANCED_GROUP = { id: 'advanced', title: 'Advanced' };

export const LIMIT_META = {
  riskPerTradePct: {
    ...percent, group: 'trade', looser: 'up', label: 'Risk per trade',
    help: 'How much of your paper equity you lose if one trade hits its stop, costs included.',
    why: 'Keeps any one loss small enough that a losing streak is survivable. A price gap can fill a stop past this.',
  },
  maxPositionPct: {
    ...percent, step: 1, group: 'trade', looser: 'up', label: 'Max position',
    help: 'The largest single position, as a share of equity.',
    why: 'A tight stop would otherwise allow a huge position that a gap could hurt.',
  },
  maxOpenRiskPct: {
    ...percent, step: 0.5, group: 'portfolio', looser: 'up', label: 'Open risk',
    help: 'Total you would lose if every open position hit its stop at once.',
    why: 'Crypto falls together, so stops tend to fire together.',
  },
  maxGrossExposurePct: {
    ...percent, step: 5, group: 'portfolio', looser: 'up', label: 'Gross exposure',
    help: 'Total value of all positions as a share of equity. 100% means no leverage.',
    why: 'No leverage on spot.',
  },
  volTargetAnnual: {
    ...percent, step: 1, group: 'portfolio', looser: 'up', label: 'Volatility target',
    help: 'The yearly portfolio volatility the book may reach. A target, not a promise.',
    why: 'Caps size when markets are wild. It only ever shrinks a position, never grows one.',
  },
  maxClusterPct: {
    ...percent, step: 5, group: 'portfolio', looser: 'up', label: 'Correlated cluster cap',
    help: 'Coins that move together count as a group. This caps that group.',
    why: 'Five correlated coins are one bet, not five.',
  },
  ladderHalfPct: {
    ...loss, group: 'ladder', label: 'Half size at',
    help: 'Falling this far from the equity high halves new position sizes.',
    clears: 'Drawdown recovers past this level by the recovery band.',
  },
  ladderQuarterPct: {
    ...loss, group: 'ladder', label: 'Quarter size at',
    help: 'New positions drop to a quarter of normal size.',
    clears: 'Drawdown recovers past this level by the recovery band.',
  },
  ladderNoEntryPct: {
    ...loss, group: 'ladder', label: 'No new entries at',
    help: 'Stops new entries. Open positions keep their exit plans.',
    clears: 'Drawdown recovers, or a human re-enables. Once flat it cannot recover by itself.',
  },
  ladderHaltPct: {
    ...loss, group: 'ladder', label: 'Flatten and halt at',
    help: 'Closes everything and stops until you re-enable it here.',
    clears: 'Only a human re-enable.',
  },
  dailyLossPct: {
    ...loss, group: 'loss', label: 'Daily loss',
    help: 'No new entries until the next UTC day.',
    clears: '00:00 UTC, even if equity recovers sooner.',
  },
  weeklyLossPct: {
    ...loss, group: 'loss', label: 'Weekly loss',
    help: 'No new entries until the next UTC week.',
    clears: 'Next UTC Monday, even if equity recovers sooner.',
  },
  btcDrop24hPct: {
    ...loss, group: 'loss', label: 'BTC 24h breaker',
    help: 'A BTC fall this big stops new entries and tightens trails.',
    clears: 'BTC recovers past the level by the market recovery band, after the cooldown.',
  },
  btcDrop7dPct: {
    ...loss, group: 'loss', label: 'BTC 7d breaker',
    help: 'Same, over seven days.',
    clears: 'BTC recovers past the level by the market recovery band, after the cooldown.',
  },
  clusterCorrelation: {
    scale: 1, unit: '', step: 0.05, sign: 1, group: 'advanced', looser: 'up', label: 'Correlation that forms a cluster',
    help: 'Coins correlated above this count as one group. Lower groups more coins together, which is stricter.',
  },
  assumedVolAnnual: {
    ...percent, step: 10, group: 'advanced', looser: 'down', label: 'Assumed volatility',
    help: "Used when a coin's volatility cannot be measured. Unknown is treated as wild.",
  },
  ladderRecoveryPct: {
    ...percent, step: 0.5, group: 'advanced', looser: 'down', label: 'Ladder recovery band',
    help: 'Drawdown must improve this far past a rung before size comes back. Stops flip-flopping.',
  },
  marketRecoveryPct: {
    ...percent, step: 0.5, group: 'advanced', looser: 'down', label: 'Market recovery band',
    help: 'How far past the breaker level BTC must recover.',
  },
  marketCooldownHours: {
    scale: 1, unit: ' h', step: 1, sign: 1, group: 'advanced', looser: 'down', label: 'Breaker cooldown',
    help: 'Minimum wait after the market breaker trips.',
  },
  minHealthyVenues: {
    scale: 1, unit: '', step: 1, sign: 1, group: 'advanced', looser: 'down', label: 'Healthy venues needed',
    help: 'Fewer healthy price sources than this stops new entries.',
  },
  minNotional: {
    scale: 1, unit: '$', step: 5, sign: 1, group: 'advanced', looser: 'down', label: 'Smallest order',
    help: 'Orders below this are skipped. A trade too small to matter is refused, not shrunk to dust.',
  },
  minStopDistancePct: {
    ...percent, step: 0.1, group: 'advanced', looser: 'down', label: 'Tightest stop',
    help: 'Signals with a closer stop are refused. Inside this, costs and noise dominate the stop.',
  },
  maxStopDistancePct: {
    ...percent, step: 1, group: 'advanced', looser: 'up', label: 'Widest stop',
    help: 'Signals with a wider stop are refused. Also catches a stop sent as 5 instead of 0.05.',
  },
  // Backtests were judged on these costs, so they are shown and never edited here.
  defaultFeePct: { ...percent, editable: false, group: 'fixed', label: 'Fee per side' },
  defaultSlipPct: { ...percent, editable: false, group: 'fixed', label: 'Slippage per side' },
  stopGapSlipPct: { ...percent, editable: false, group: 'fixed', label: 'Stop gap slip' },
};

export const FIXED_FACTS = [
  'Leverage on spot: none.',
  'Exits are never blocked.',
  'A stop is always required.',
  'Stale or disagreeing data: no new entries, exits continue.',
];
