# V6 risk engine

Module: `shared/trading/v6Risk.js`. Tests: `node tests/v6Risk.test.mjs`.

These limits cap how much can be lost and how fast. They do not make a strategy
profitable, and they cannot prevent every loss: a price gap can fill a stop well past
the allowance below. Risk management around an entry with no edge just loses more slowly.

**Exits are never blocked.** Everything on this page limits new entries. No limit, halt
or data problem stops a position from leaving. The most these rules do to exits is ask
for more of them: flatten everything, or tighten trailing stops.

All percentages below are stored as fractions in config (0.5% is `0.005`).

## Size limits

"Range" is what the GUI may set. Anything outside it is pulled back to the nearest end.

| Setting | What it does | Default | Range | Why |
|---|---|---|---|---|
| `riskPerTradePct` | Most one trade may lose if its stop is hit, costs included, as a share of equity | 0.5% | 0.05% to 1% | Keeps any one loss small enough that a losing streak is survivable |
| `maxOpenRiskPct` | Total loss if every open stop were hit at once | 3% | 0.5% to 5% | Crypto falls together, so stops tend to fire together |
| `maxPositionPct` | Largest single position by value | 20% | 1% to 25% | A tight stop would otherwise allow a huge position that a gap could hurt |
| `maxGrossExposurePct` | Total value of all positions | 100% | 10% to 100% | No leverage on spot |
| `maxClusterPct` | Most equity in coins that move together | 40% | 5% to 50% | Five correlated coins are one bet, not five |
| `clusterCorrelation` | How closely two coins must move to count as one group | 0.70 | 0.50 to 0.90 | Lower groups more coins together, which is stricter |
| `volTargetAnnual` | Portfolio volatility the book may reach (a yearly figure) | 18% | 5% to 20% | Caps size when markets are wild. Only ever shrinks a position, never grows one |
| `assumedVolAnnual` | Volatility assumed for a held coin when none is supplied | 100% | 80% to 300% | Unknown is treated as wild |
| `minNotional` | Smallest order worth placing, in quote currency | 25 | 10 to 1000 | A trade too small to matter is refused, not shrunk to dust |
| `minStopDistancePct` | Tightest stop accepted | 0.5% | 0.2% to 2% | Inside this, costs and noise dominate the stop |
| `maxStopDistancePct` | Widest stop accepted | 25% | 5% to 30% | Also catches a stop sent as 5 instead of 0.05 |

## Cost allowances

Risk per trade includes these, so "0.5% at the stop" means after costs.

| Setting | What it does | Default | Range | Why |
|---|---|---|---|---|
| `defaultFeePct` | Fee per side when no cost is supplied | 0.10% | 0.10% to 1% | Contract fee rate |
| `defaultSlipPct` | Slippage per side when no cost is supplied | 0.25% | 0.25% to 2% | Tier 3, the worst tier, so an unknown coin is sized cautiously |
| `stopGapSlipPct` | Extra slip a stop fill takes | 0.10% | 0.10% to 2% | Contract cost model. A real gap can be far larger than this |

Loss per unit of position = stop distance + 2 x fee + 2 x slippage + stop-gap slip.

## Entry blocks

| Setting | What it does | Default | Range | Clears when |
|---|---|---|---|---|
| `ladderHalfPct` | Drawdown from the equity high that halves new position size | 5% | 1% to 7.5% | Drawdown recovers past threshold minus the recovery band, or a human re-enable in the below-minimum deadlock only |
| `ladderQuarterPct` | Drawdown that quarters new position size | 10% | 2% to 12.5% | Same |
| `ladderNoEntryPct` | Drawdown that stops new entries | 15% | 3% to 17.5% | Same, or a human re-enable (see below) |
| `ladderHaltPct` | Drawdown that closes everything and halts | 20% | 4% to 20% | Only a human re-enable |
| `ladderRecoveryPct` | How far past a threshold equity must recover before a rung releases | 1% | 0.5% to 3% | Stops size flipping when equity sits on a threshold |
| `dailyLossPct` | Loss today that stops new entries | 2% | 0.5% to 3% | Next UTC day (00:00 UTC), even if equity recovers sooner |
| `weeklyLossPct` | Loss this week that stops new entries | 4% | 1% to 6% | Next UTC Monday, even if equity recovers sooner |
| `btcDrop24hPct` | BTC fall over 24 hours that stops entries and tightens trails | 8% | 3% to 10% | See market breaker below |
| `btcDrop7dPct` | BTC fall over 7 days that does the same | 15% | 5% to 20% | See market breaker below |
| `marketRecoveryPct` | How far BTC must recover past a breaker threshold | 1% | 0.5% to 2% | |
| `marketCooldownHours` | Minimum time after the last breach before the breaker clears | 24 | 6 to 72 | |
| `minHealthyVenues` | Healthy exchanges needed when a venue list is supplied | 2 | 2 to 5 | Data gate reopens on the next healthy update |

Thresholds trip at exactly the stated figure: exactly -5.00% is half size. The ladder is
kept in order automatically. If a setting would put a rung at or past the next one, the
shallower rung is tightened to sit at least 1% inside it. The daily limit is never
looser than the weekly one.

**Ranges marked by the contract:** risk per trade (1%), open risk (5%) and gross exposure
(100%). The other ranges are this agent's proposals and need the coordinator's sign-off.

### Other reasons entries stop

| Reason shown | Meaning | Clears when |
|---|---|---|
| `halted` | Drawdown halt, manual halt, or fail-safe halt | Only a human re-enable |
| `data_unhealthy` | Prices stale, disagreeing or unknown | Next healthy update |
| `market_data_unknown` | BTC history missing, stale, gappy or too short, so the breaker cannot be read | BTC data returns |
| `input_fault` | Equity, clock or config unusable on this tick | Next usable update |
| `risk_state_invalid` | Stored risk state unreadable | Human re-enable, after the next update has marked it halted |

## How a position is sized

Each step can only shrink the size. `reason` names the step that last shrank it.

1. `risk_per_trade`: equity x risk per trade / loss per unit (costs included).
2. `max_position`: cap, less anything already held in that coin.
3. `drawdown_ladder`, `half_risk`, or `drawdown_ladder_and_half_risk`: multipliers. They
   multiply together, so half size on a half-risk strategy is a quarter. They come after
   step 2 so "half size" really halves a capped position.
4. `vol_target`: room left under the portfolio volatility target.
5. `open_risk`: room left under the open-risk cap.
6. `gross_exposure`: room left under gross exposure, at the filled price.
7. `cluster`: room left in this coin's correlated group.
8. `cash`: available cash at the filled price, if supplied.
9. Below `minNotional`: rejected. `reason` is `below_min_notional` and `limit` names the
   step that shrank it.

Steps 4 to 8 come last because they are hard room in the book. A strategy multiplier above
1 is treated as 1.

## Things worth knowing

- **Re-enabling resets the drawdown baseline.** From the no-entries or halt rung, or from
  the half or quarter rung in the below-minimum deadlock, a re-enable sets the equity high
  to current equity. On the top two rungs the old high would otherwise trip again on the
  next tick. So each re-enable grants a fresh 20% allowance, and repeated re-enables have no
  combined limit. In every other case on the half or quarter rung the high is kept, so
  neither a pause nor being flat can shed the size cut.
- **Any rung can stick once flat.** See "Stuck on a rung" below.
- **A re-enable does not clear** daily, weekly, market or data blocks.
- **A bad equity print could halt the bot.** A false -20% reading is acted on, because
  delaying a flatten would be gating an exit. Bad data cannot raise the equity high, but
  it can trip the ladder. The failure costs missed trades rather than capital, but it
  still needs a human to clear.
- **Daily and weekly baselines** are the last equity seen before the boundary, so a loss
  across midnight or during downtime still counts. After a long outage this can trip the
  limit on the first tick. That is deliberate.
- **The breaker compares close to close.** It does not see a peak-to-trough fall inside
  the window. Pass 1h or 4h bars: daily bars only show a crash once the day has closed.
- **The cluster cap looks only at the candidate's own neighbours.** Groups are not chained:
  if A matches B and B matches C, A and C are not grouped unless they match each other.
- **A backward clock** blocks entries until time catches up, and a re-enable is refused
  while the supplied time is behind the stored time.
- **Shorts are rejected here** (`short_not_supported`). `v6Core` sizes a perp short by
  passing it as the mirror-image long. The stop maths is symmetric, but funding is not in
  the loss allowance, and a short gets no hedge credit against held longs.

## Stuck on a rung

With no positions, equity cannot move, so the drawdown cannot recover by itself. The bot
then shows **needs review** (`riskDirectives(state).needsReview`, with detail in
`state.review`). This is a report, not a block: it changes no limit and clears no rung.

| `review.reason` | Meaning | Raised by |
|---|---|---|
| `flat_entries_blocked` | No positions, on the no-entries or halt rung | `updateRiskState` with `openPositions: 0` |
| `flat_entries_too_small` | No positions, on any rung, and an entry was refused because the reduced size is below `minNotional` | `noteEntryRejection` |

Flat on the half or quarter rung with no such refusal is not flagged. Having no signal yet
is not a deadlock, because a later entry can still move equity.

The flag stays through day rollovers and restarts. It goes only when a position opens, the
rung returns to normal, or a human re-enables. It does not time out.

**The way out is a human re-enable.** On the no-entries and halt rungs it works as it always
has. On the half and quarter rungs it works only in the deadlock: `openPositions` is exactly
0 and the `flat_entries_too_small` flag is set. Otherwise it returns `nothing_to_clear`, so
a flat account cannot shed a size cut at will. If a position opens, the deadlock is over, and
going flat again needs a fresh below-minimum refusal.

It needs the same confirmation and named human as any other. It does not change
`minNotional` or any other limit, and it is separate from the rule refusing limit loosening
on the quarter rung or worse. The bot goes back to full size from a new, lower equity high,
so entries that were too small can be placed again.

Smallest equity at which an entry still clears the default $25 minimum, Tier 3 costs:

| Stop | Full | Half | Quarter | Quarter on paper(half) |
|---|---|---|---|---|
| 5% | $290 | $580 | $1,160 | $2,320 |
| 10% | $540 | $1,080 | $2,160 | $4,320 |
| 15% | $790 | $1,580 | $3,160 | $6,320 |
| 20% | $1,040 | $2,080 | $4,160 | $8,320 |
| 25% | $1,290 | $2,580 | $5,160 | $10,320 |

A $10,000 account on the quarter rung holds just over $8,500 to $9,000. In paper(half), a
stop of exactly 20% still clears $25 there. Entries are refused from a stop of about 20.5%
at the bottom of the rung, and about 21.7% at the top. Exactly -15% ($8,500) is already the
no-entries rung.

## Integration

```js
updateRiskState(riskState, { t, equity, btcBars, dataHealth, config, openPositions })
                                                  // { riskState, events }
canEnter(riskState)                               // { ok, reason, reasons }
sizeEntry({ signal, price, equity, positions, riskState, config, volatility, correlations,
            sizeMultiplier, costs, prices, cash })
noteEntryRejection(riskState, sized, { t, openPositions })   // { riskState, events }
reEnablePreview(riskState, { openPositions })     // { allowed, reason, willRebase }
humanReEnable(riskState, { t, equity, by, confirm, openPositions })
                                                  // { ok, reason, riskState, events }
```

Beyond the contract: `LADDER_RUNGS`, `riskDirectives(riskState)` returning
`{ entriesAllowed, sizeMultiplier, flatten, tightenTrails, needsReview }`, `manualHalt`,
`humanReEnable`, `noteEntryRejection`, `reEnablePreview`, `utcDayKey`, `utcWeekKey`.
`sizeEntry` also returns `limit`, `multiplier`, `lossPerNotional` and `trace`.

`openPositions` is the count of open positions. Only an explicit `0` counts as flat. Left
out or unreadable, nothing is treated as flat. With no halt on the normal, half or quarter
rung, `humanReEnable` refuses with `nothing_to_clear` unless the deadlock above is present.
A manual halt on the half or quarter rung can always be cleared, and keeps the equity high
and the size cut unless the deadlock is present.

`reEnablePreview` uses the same rule as `humanReEnable`. The GUI should read `allowed` and
`willRebase` from it rather than repeating `rung >= 3`.

Call `noteEntryRejection` after every rejected `sizeEntry`, and keep the state it returns.
It ignores everything except a `below_min_notional` rejection on a flat book, on a ladder
rung. "Flat" there means nothing open and nothing already planned in this step.

Required for `sizeEntry`, or every entry is rejected:

- `sizeMultiplier` (1 for full risk, 0.5 for paper(half)).
- `volatility`: annualised, as a number or a Map/object by symbol. Below 10% is refused
  as a likely daily figure.
- `correlations`: Map or object of symbol to symbol to rho. `{}` is valid, but a missing
  pair counts as fully correlated, so one group would hold the whole book.
- `config`: pass `DEFAULT_RISK_CONFIG` for defaults. Nested config objects are not read.

Also: `dataHealth` must be `{ ok: true }` or a venue list, including in the simulator, or
entries stay shut. `btcBars` needs just over 7 days of history. Pass `prices` so exposure
uses live marks; without it, held positions are valued at their highest known price.
`stopDistancePct`, `feePct` and `slipPct` are fractions. `v6Paper` costs are percent
numbers, so divide by 100 first.

Read flatten and trail orders through `riskDirectives(riskState)`. They are not top-level
fields on the state.

Store `riskState` as JSON and call `initialRiskState` only when no record exists at all.
A failed read must pass `null`, which halts safely, rather than creating a fresh state,
which would lift a halt.
