STATUS: PRE-REGISTERED 2026-11-13, before any lottery statistic was computed. Results go below, unchanged above.

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

## Results

(Not run yet.)
