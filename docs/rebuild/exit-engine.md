# Exit engine (`shared/trading/v6Exits.js`)

Every V6 position has an exit plan from the moment it opens. The plan decides when the
position leaves. It does not make a losing strategy profitable, and no exit rule can
guarantee a winning trade.

The numbers below are round starting values. They have not been tested on market data.
Treat them as defaults to research, not as tuned settings.

## GUI help text

**R** is the distance between your entry and your first stop. If you buy at 100 with a
stop at 90, then 1R is 10, and +2R means the price reached 120.

### Rules every profile uses

- **Hard stop.** The price set at entry that closes the position. It never moves further
  away. If the price jumps past it, the exit happens at the worse price, not the stop.
- **Break-even.** Once the trade has been +1R in profit, the stop moves just past your
  entry, far enough to cover fees and slippage both ways. If the price jumps past that
  stop, the trade can still lose money.
- **Trailing stop.** Follows the best price reached, staying a set number of ATRs behind
  it. ATR is the coin's typical bar size, so the gap widens for volatile coins. It only
  ever moves in your favour. A sudden jump of more than 6 ATRs past the best price does
  not move the stop until the next bar confirms the price is real.
- **Time stop.** Closes a trade that has not made enough progress after a set number of
  bars, so money is not stuck in something that is going nowhere.
- **Signal exit.** Closes the position when its strategy turns flat or opposite.
- **Regime exit.** Reacts when the overall market turns against the position, either by
  closing it or by tightening the trailing stop. Closing needs a change: a position opened
  while the market was already against it stays open, unless the market improves and
  later turns against it again. An unknown market state never closes a position.
- **Partial profit.** Sells part of the position at a set profit level.

### Trend

For riding long moves. It accepts pullbacks and has no profit target, so it often gives
back a good part of a gain before exiting. Expect many small losses and few large wins.

- Trailing stop 4 ATRs behind the best price, starting at +1R
- Time stop: after 40 bars, closes if the trade is not in profit. No maximum age
- Closes if the market regime changes to one against it
- No partial profit

### Swing

For moves lasting days to a few weeks. It banks half at a target and trails the rest.

- Trailing stop 3 ATRs behind the best price, starting at +1R
- Sells 50% of the original position at +2R
- Time stop: after 20 bars, closes if the trade is under +0.5R. Always closes by 60 bars
- If the market regime turns against it, the trail halves its distance and the trade stays open

### Revert

For short bets that a stretched price snaps back. It takes profit quickly and leaves
early, because a snap-back that has not happened soon is probably not coming.

- Trailing stop 2 ATRs behind the best price, starting at +1R
- Sells 50% at +1R and the other 50% at +2R, so it is fully out by +2R
- Time stop: after 5 bars, closes if the trade is under +0.25R. Always closes by 10 bars
- Closes if the market regime changes to one against it

| Setting | Trend | Swing | Revert |
|---|---|---|---|
| Stop if none is supplied | 3 ATR, or 15% | 2 ATR, or 10% | 2 ATR, or 8% |
| Break-even | +1R | +1R | +1R |
| Trail distance | 4 ATR | 3 ATR | 2 ATR |
| Time stop | 40 bars, 0R | 20 bars, 0.5R | 5 bars, 0.25R |
| Maximum age | none | 60 bars | 10 bars |
| Change to adverse regime | exit | see note | exit |
| Adverse regime, any time | no action | tighten trail | no action |
| Partial profit | none | 50% at 2R | 50% at 1R, 50% at 2R |
| Spike guard | 6 ATR | 6 ATR | 6 ATR |
| Minimum reward:risk | 2 | 1.5 | 1 |

Note: Swing never closes on the regime. Its trail tightens for as long as the regime is
adverse, including a regime that was already adverse when the trade opened.

## Integration notes

### Decision order

`EXIT_PRIORITY`, first wins: `hard_stop`, `breakeven_stop`, `trail_stop`, `no_stop`,
`time_stop`, `regime_exit`, `signal_exit`, `take_profit`, `partial_take_profit`.

The three stops are one price, so only one can fire, and `reasonCode` says which stage
the stop had reached. `no_stop` is listed with them, but it only arises when no stop
exists, so it cannot conflict with one. A full exit beats a partial. The stop beats the
target on a bar that touches both, as the contract requires.

### Using the result

Merge every result with `applyExitResult(position, result)`. Applying `newStop` alone
loses the water marks, the ratchet floor and the partial record. A caller that persists
`newStop` and `exitPlan` keeps the floor and partial record, but not the water marks.
`qty` stays with the ledger.

| Field | Meaning |
|---|---|
| `newStop` | Stop in force after this evaluation, always filled when one is known |
| `fraction` | Share of the CURRENT qty, so `qty * fraction` is correct |
| `fractionOfOriginal` | Same sale as a share of the original size |
| `fillHint.kind` | `stop`, `target` or `next_open` |
| `fillHint.price` | `stop`: worse of stop and open. `target`: the level, or the blend of levels. `next_open`: null, with `refPrice` for reference |
| `partialId` | Id of the last partial level hit, else null |
| `exitPlan` | Same as `update.exitPlan`. Must be persisted: it holds the ratchet floor and the partial record |
| `flags` | Every data problem seen |
| `dataOk` | False when price, ATR, stop, plan or clock was bad. Raise an alarm on this |

`fillHint.price` does not include the extra 0.10% stop slippage. `v6Paper` should add it,
so it is not counted twice.

A hold on bad data has `reasonCode: 'hold_bad_data'`. `regime_missing`, `bad_regime`,
`regime_baseline_set`, `bad_signal` and `signal_mismatch` are advisory: they appear in `flags` but leave
`dataOk` true.

### Inputs

- `t` is the decision clock. Bars held is `floor((t - entryTime) / barMs)`, so repeated
  5-minute ticks do not age a position. The stored `barsHeld` is only used if the clock
  is unusable. Passing bar open time versus close time shifts the count by one bar, so
  the simulator and the worker must pass the same kind of `t`.
- `createExitPlan` takes `config.timeframe` or `config.barMs`, and defaults to `1d`.
- `config.costs` is `{ feePct, slipPct, stopSlipPct }` in percent units, so 0.10 means
  0.10%. Missing costs use Tier 3, the dearest. Pass the real tier, or break-even sits
  too far from entry for majors.
- `regime` is a word (`bull`, `bear`, `neutral`, `risk_on`, `risk_off`, ...) or
  `{ label, riskOn, riskOff, tightenTrails }`, which covers `v6Core.computeRegime`.
- Pass the regime at entry to `createExitPlan` as `regime` (or `config.regime`). It is stored as
  `plan.regimeAtEntry` and seeds `plan.state.lastRegimeBias`. If it is missing, the first
  regime seen becomes the baseline and the result carries `regime_baseline_set`.
- For the market breaker, pass `config.tightenTrails: true` to `evaluateExit`.
- `signal` should be `null` when the strategy has no opinion.

### Behaviour worth knowing

- A ratchet earned on a bar applies from the next bar. A bar cannot move the stop and
  then hit it, because OHLC does not show which came first.
- Break-even and trail use the bar high or low, not the close. Live ticks see those
  excursions and the simulator must match. As a result the stop can land above the close,
  and the position then exits at the next open or tick.
- Only clean bars ratchet the stop or take profit. Clean means all four prices are valid
  and consistent, and the bar is not from before entry. The stop test still uses any
  valid price from a broken bar.
- Partial fills assume the target price, even when the bar opened beyond it. That is the
  conservative choice.

### Regime exit rules

- Fires only when the regime changes to adverse from a known regime that was not adverse.
  The last known regime lives in `exitPlan.state.lastRegimeBias`, so it survives a restart.
- `unknown`, a missing regime and unrecognised words change nothing. Bear, then unknown,
  then bear does not fire. Bull, then unknown, then bear does.
- After firing, `state.regimeExitLatched` keeps the exit firing while the regime stays
  adverse, so an exit that was decided but not filled repeats on replay. An unknown regime
  pauses it. A known regime that is not adverse clears it.
- The `tighten` action follows the regime's level, not a change. It applies whenever the
  regime is adverse, including at entry.

### Spike guard rules

- `spikeGuard: { enabled, atrMult }` is a sweepable profile parameter, default 6.
- If a clean bar's best price is more than `atrMult` ATRs past the previous water mark
  (high for a long, low for a short), the water mark and stop stay put, the bar carries
  `spike_unconfirmed` (so a hold is `hold_bad_data`), and the price waits in
  `exitPlan.state.pendingBest`. Exactly `atrMult` ATRs is accepted.
- A later bar confirms it by reaching within `atrMult` ATRs of the pending price. The
  water mark then takes the pending price, and the stop ratchets on that bar. A bar that
  does not reach it drops the pending price, and that bar's own best is judged as usual.
- A replayed bar cannot confirm itself, because confirmation needs a later bar time.
- Stop-hit checks ignore the guard. Leaving on a bad price is the safe direction.

### Known limits

- The spike guard covers ratcheting only. A false print can still reach a partial target,
  and the bar is flagged when that happens. It can also fire a stop if the print is on
  the losing side, as intended.
- The same false price on two consecutive bars or ticks counts as confirmed and raises the
  stop permanently. A stale quote repeating on the next tick would do this, so live prices
  still rely on `hub.consensusPrice`.
- A real jump over the limit ratchets one bar late, and a one-bar wick is never accepted.
  This costs some protection on genuine spikes, so it should be measured in research.
- With no ATR at all, current or last good, the guard cannot judge a jump. The water mark
  then moves unguarded, and the bar is flagged `bad_atr`. The trail stays frozen, but
  break-even can still arm.
- With no valid price and no last good price through the stop, the stop cannot be
  tested. The result is a flagged hold, unless a time, regime or signal rule exits.
- A caller that overwrites both `stopPrice` and `exitPlan.state.stopFloor` can loosen the
  stop as far as the plan's hard stop, but no further.
