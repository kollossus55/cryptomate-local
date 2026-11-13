STATUS: DONE 2026-11-13. VERDICT: NO EDGE, NOTHING FROZEN. Pre-registered (commit 3d093cc) before the run; text above Results unchanged.

# r-lottery: does a lottery-like coin underperform?

Source: awesome-systematic-trading #103 (return asymmetry) and #110 (skewness). The idea: traders overpay
for coins with lottery-like payoffs (a few huge up days, positive skew), so those coins earn less later, and
coins without them earn more. It has not been tested here before. r-lowvol ranked on volatility, which is
related but not the same: a coin can be volatile without being skewed.

## Data and universe

DEV only: 2020-01-01 to 2024-12-31, daily Binance spot bars, `pointInTimeUniverse` top 30 by volume as of
each rebalance day. A coin needs every daily close over its lookback. Perp bars and funding come from the
same DEV store as r-catalogue. Holdout and forward stores are not touched.

## Signals (computed on closes up to the day before the rebalance)

- **MAX**: the mean of the 5 largest daily returns in the lookback (a smoother version of Bali et al.'s MAX).
- **SKEW**: the sample skewness of daily returns in the lookback.

Lookback `L` is 30 or 90 days.

## Portfolios (weekly, Monday open to next Monday open)

Rank the eligible coins on the signal. Low = the bottom fifth (rounded down, at least 4 coins), high = the
top fifth.

- **LO** (long-only, spot): equal weight in the low group. Excess = its return minus the equal-weight return
  of all eligible coins over the same week. Cost: a round trip on each changed slot, divided by the group size.
- **LS** (long-short, perps): long the low group, short the high group, equal weight, funding paid and
  received. Excess = gross (it is market-neutral by construction). Cost is the same, on both legs.

The direction is fixed in advance: low lottery-ness is long. The reverse is not tested.

## Cells and trials

2 signals x 2 lookbacks x 2 legs = **8 cells, 8 trials**. Global count goes from 510 to 518.

## Gate (the same as r-catalogue's event-study gate)

A cell passes only if all of these hold:
1. At least 30 weekly events.
2. Mean gross return beats mean cost.
3. Mean excess > 0 with t >= 2 on 4-week blocks.
4. Mean excess > 0 in both halves (2020-2022 and 2023-2024).

Only a passing cell goes on to a full walk-forward under D1-D8. LS cells would also need the perp-shorts
branch. Nothing passes on the gate alone. If nothing passes, nothing is frozen and the family is closed.
No new cells after results are seen.

## Results (run 2026-11-13, `node scripts/v6/research/r-lottery.mjs study`)

198 coins were ever in the top 30; 179 have a same-symbol perp. 246 weekly events per cell. Per-week means:

| Cell | L | Gross | Cost | Excess | t (4-wk blocks) | Halves | Gate |
|---|---|---|---|---|---|---|---|
| MAX-LO | 30 | 1.448% | 0.130% | 0.124% | 0.30 | 0.047% / 0.229% | FAIL |
| MAX-LS | 30 | 0.205% | 0.261% | 0.205% | 0.23 | -0.151% / 0.692% | FAIL |
| MAX-LO | 90 | 1.802% | 0.073% | 0.474% | **1.64** | 0.506% / 0.431% | FAIL (t) |
| MAX-LS | 90 | 0.851% | 0.167% | 0.851% | 1.16 | 0.774% / 0.955% | FAIL (t) |
| SKEW-LO | 30 | 1.310% | 0.232% | -0.014% | -0.14 | -0.149% / 0.170% | FAIL |
| SKEW-LS | 30 | -0.152% | 0.390% | -0.152% | -0.30 | -0.401% / 0.188% | FAIL |
| SKEW-LO | 90 | 1.758% | 0.130% | 0.430% | 1.56 | 0.332% / 0.564% | FAIL (t) |
| SKEW-LS | 90 | 0.759% | 0.221% | 0.759% | 1.25 | 0.587% / 0.993% | FAIL (t) |

**No cell passes. Nothing is frozen; the family is closed.** Global trials: 510 -> 518.

Reading:
- The 30-day signals show nothing. The 90-day signals point the predicted way in both halves, but the best t
  is 1.64. That is short of the 2.0 bar for one test, and well short once it is one of 8 cells, and of 518 overall.
- The LO cells' large gross (1.3-1.8% a week) is almost all market drift over 2020-2024: their excess over
  the equal-weight universe is 0.0-0.5%. Long-only, this is a market bet, not a lottery effect.
- The LS legs are noisy: the weekly excess swings by several percent, so even a 0.85% mean is not distinguishable
  from zero over 4.7 years.
- LS ranks only the coins with a perp at both opens, so its groups can differ from LO's. Stated here because
  the pre-registration said "eligible coins" without saying so.

Not done, and not to be done on this data: the reverse direction, other lookbacks, a top-50 universe, or
stacking MAX and SKEW. Each would be a new trial chosen after seeing these numbers.
