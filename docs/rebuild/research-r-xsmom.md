# Research r-xsmom: NOT QUALIFIED. Cross-sectional momentum showed no edge on DEV; nothing is frozen.

Walk-forward result, net of costs under real v6Risk sizing: -8.3% over four years, Sharpe -0.20. It fails
D1, D2, D5, D6, D7 and D8. `FROZEN_CANDIDATES` is empty. This is a DEV result only, and no holdout data was
read. No result here implies that any strategy would win.

## Summary

| | |
|---|---|
| Trials | 50 of 50: 36 stage 1, 12 stage 2, 2 post-hoc weekday checks. All logged |
| OOS span | 2020-12-31 to 2024-12-31, 9 folds |
| Total return | -8.3% (2x costs: -13.1%) |
| Sharpe | -0.20, 90% CI [-0.90, 0.46] |
| Worst drawdown | 18.0% |
| Average exposure | 5.4% of equity |
| Closed trades | 305, win rate 42%, profit factor 0.82, average -0.03R |
| Lookahead audit | Clean with `rebuild`, 4 cuts, on the most-picked parameters |

## D1-D8 (walk-forward, the only figures that count)

No candidate is frozen, so this table is for the family's walk-forward run.

| Criterion | Result | Value | Needed |
|---|---|---|---|
| D1 | FAIL | Sharpe -0.20, CI [-0.90, 0.46] | >= 0.80, CI low > 0 |
| D2 | FAIL | 0.000 at 137 global trials | >= 0.90 |
| D3 | PASS | 18.0% | <= 30% |
| D4 | PASS | 305 closed trades | >= 100 |
| D5 | FAIL | -13.1% at 2x costs | > 0 |
| D6 | FAIL | Worst neighbour -0.91 vs chosen 0.73 | Neighbours >= 50% |
| D7 | FAIL | No profit | Coin <= 35%, year <= 60% |
| D8 | FAIL | Calmar -0.12 vs 0.31, Sharpe -0.20 vs 0.70 | Better Calmar or Sharpe |

D2 was computed when the global count was 137. The trial files now hold 289 lines, including the example file.
It was not recomputed, because a negative Sharpe cannot pass at any count.

## Per-year returns

| Run | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|
| Walk-forward | -3.1% | 0.0% | -3.7% | -1.7% |
| Fixed L20 radj K10 weekly (not a pass figure) | +24.1% | 0.0% | +9.2% | +2.2% |
| Top-30 buy-and-hold benchmark, full weight | +240.8% | -70.9% | +58.5% | +63.3% |

The walk-forward run was in cash for nearly all of 2022 because of the BTC gate. The benchmark returned +156.8%
with an 85.4% drawdown. Its Sharpe of 0.70 comes at full exposure, against 5.4% here.

## Costs and turnover (walk-forward, $10,000 start)

| Item | Amount |
|---|---|
| Fees | $101 |
| Slippage | $148 |
| Stop gaps | $18 |
| Delisting haircut | $0 |
| Total costs | $267 |
| Net loss | $831 |

The loss before costs was about $564, so costs made it worse but did not cause it. Turnover was 2.6x equity a
year. By traded value, tier 1 was 10.6%, tier 2 61.0% and tier 3 28.4%.

Exits: 113 signal, 65 hard stop, 43 trail, 38 regime, 30 break-even, 8 time, 8 end of run.

**Delisting.** No position hit the delisting rule in the walk-forward run or the fixed run. Across the 13 stage 2
runs there were two cases, one each in the swing and $50M-floor runs. The $50M-floor case was NPXS, a loss of
$7.60. The feared crash-coin problem did not show up, but exposure was small and the universe was limited to the
top 30.

## What failed and why

1. **Parameter choice did not carry forward.** Train windows picked four different parameter sets across 9
   folds, and the out-of-sample result was negative. L20 radj K10 weekly was the most picked (4 of 9 folds) and
   also the best of the 36 trials, at Sharpe 0.73. That figure is not clean, because it is the maximum of 36 over
   the span being reported. It would still fail D1, D6 and D7 (2021 is 62.5% of profit).
2. **Much of the gap between the two runs is one fold.** In the first fold (2021 H1), the fixed set made +29.2%
   and the walk-forward pick made -0.3%. The fixed run's 38.8% total depends heavily on those six months.
3. **The result depends on the rebalance weekday.** This is the strongest evidence against the family. The same
   rule, with only the weekday moved, gives:

   | Phase | Sharpe | Return | 2021 | 2023 | 2024 |
   |---|---|---|---|---|---|
   | 0 (grid) | 0.73 | +38.6% | +24.1% | +9.2% | +2.2% |
   | 2 | 0.00 | -2.2% | -2.8% | +7.3% | -6.3% |
   | 4 | 0.28 | +9.1% | +19.9% | -9.0% | 0.0% |

   A real momentum effect should not depend much on which weekday it trades. Phase 4's 2024 reads exactly 0.0%,
   which looks like the sticky no-entries rung described below. I did not confirm that.
4. **Slower rebalancing does not work.** All 18 trials at `rebal` 28 lost money, and `rebal` 14 fell to 0.19.
   Among the 18 weekly trials, 11 were positive and 7 negative. Sharpe also tends to fall as `L` rises. So any
   signal is short-lived, which is the opposite of what the low-turnover hypothesis needed.
5. **Rank spread is not significant.** Weekly forward return by trailing 20-day return quintile, 2021-2024,
   ungated, top 30, with the delisting haircut:

   | Span | Q1 (winners) | Q2 | Q3 | Q4 | Q5 (losers) | Q1-Q5 | t |
   |---|---|---|---|---|---|---|---|
   | 2021 | 6.11% | 1.66% | 2.66% | 5.40% | 3.51% | 2.60% | 0.98 |
   | 2022 | -3.31% | -2.42% | -1.88% | -2.27% | -2.38% | -0.94% | -0.89 |
   | 2023 | 2.09% | 1.57% | 0.79% | 1.37% | 0.26% | 1.82% | 2.26 |
   | 2024 | 2.22% | 1.64% | 1.43% | 1.52% | 2.00% | 0.23% | 0.17 |
   | All | 1.79% | 0.60% | 0.75% | 1.53% | 0.84% | 0.95% | 1.14 |

   The pattern is not monotonic. This ranks on raw return, while the most-picked set uses `radj`, so it is
   indicative only.
6. **The control is not clearly beaten.** Replacing the momentum rank with the volume rank gives Sharpe 0.34
   against 0.73, but the whole lead comes from 2021 (+24.1% vs -1.0%). In 2023 and 2024 the control did better:
   +11.3% and +3.2% against +9.2% and +2.2%. The pre-registered test was that a candidate must beat the control.
   The fixed set does overall, but on one weekday and through one year.

## Stage 2 (fixed parameters, around L20 radj K10 weekly)

Figures are diagnosis only. Each row is a fixed run on the OOS span, with no walk-forward.

| Variant | Sharpe | Return | Max DD | Trades | Exposure | Tier 3 |
|---|---|---|---|---|---|---|
| Base | 0.73 | 38.6% | 15.9% | 325 | 8.9% | 28% |
| Gate 100 | 0.89 | 52.8% | 14.7% | 324 | 9.2% | 30% |
| Gate off (see note) | 0.41 | 14.8% | 18.0% | 180 | 3.5% | 10% |
| Top 20 | 0.69 | 37.6% | 15.6% | 309 | 8.3% | 17% |
| Top 50 | 0.64 | 34.8% | 17.1% | 397 | 7.9% | 44% |
| Swing | 0.66 | 30.8% | 14.2% | 363 | 8.5% | 31% |
| $50M floor | 0.83 | 49.8% | 15.5% | 279 | 7.4% | 3% |
| Stop 2 ATR | 0.53 | 27.0% | 18.4% | 321 | 8.5% | 28% |
| Stop 4 ATR | 0.67 | 31.3% | 15.0% | 310 | 8.0% | 29% |
| Rebal 14 | 0.19 | 6.0% | 18.5% | 257 | 6.8% | 24% |
| Skip 7 days | 0.38 | 17.2% | 15.4% | 359 | 8.6% | 35% |
| No rank buffer | 0.58 | 30.2% | 16.2% | 352 | 9.1% | 31% |
| Control (volume rank) | 0.34 | 13.7% | 16.9% | 255 | 10.3% | 5% |

**Gate 100 and the $50M floor are not candidates**, even though both show Sharpe above 0.8. Stage 2 was
registered as unable to change a candidate. Both ran only on the phase-0 weekday, both are picked after the fact
from 50 trials, neither has a walk-forward or plateau, and both fail D7 (2021 is 63.2% and 81.1% of profit).

**Gate off is not a fair comparison.** Its drawdown reached 18.0%, past the 17.5% no-entries rung. Its 2023 and
2024 returns are exactly 0.0% and it logged 137 blocked-entry events, so it appears to have sat flat from 2022
on. What it does show is -10.4% in 2022 against 0.0% with the gate. The gate's full contribution was not measured.

## Harness and module notes

No shared file was edited. These need the coordinator's attention:

- **`walkForward` ignores a universe size in the grid.** `scheduledStrategy` spreads `base`, so the OOS run uses
  the first pick's `universe.n`, while the train runs use each combo's own. I avoided this by keeping `topN` out
  of the grid. Other agents may not have.
- **The no-entries rung freezes a simulation.** Once flat at that rung, equity cannot recover, so the rest of the
  run reads as zero return. This matches `risk-engine.md`, but reported Sharpe and drawdown then include the
  frozen period, which can flatter a variant.

## Deviations and disclosures

- The pre-registration said OOS starts 2021-01-01. `walkForward` starts it at 2020-12-31 because 2020 was a leap
  year. Stage 2 and the phase runs start 2021-01-01, which is why the base shows 38.6% there and 38.8% in stage 1.
- **The two phase trials were not pre-registered.** I added them after seeing stages 1 and 2, because the jump
  between `rebal` 7 and 14 looked suspicious. They used the last 2 trials of the budget. The `phase` parameter
  defaults to 0 and left the base unchanged: the rerun reproduced 38.8%.
- A shell quoting error in my edit dropped the `note` on those two trial lines, so they logged as null. I
  rewrote the two notes by hand. No trial values changed, and the script line is fixed.
- I rebuilt the walk-forward schedule separately to check for a harness fault. It reproduced -8.3% with the same
  18.0% drawdown, so the negative result is not a scheduling bug.
- The audit covered the most-picked fixed parameters, not the switching walk-forward run.
- The risk config uses the ceilings for sizing and the ladder. Exposure still averaged 5.4%, including the cash
  year, so absolute returns here are small whatever the signal.
- The OOS span holds one bull year, one bear year and two recovery years. That is few independent regimes. 2021
  is over 60% of profit in 9 of the 13 stage 2 runs. The exceptions are top 20 and swing (59% each) and no rank
  buffer (43%), plus the control, where 2023 is 82%.

## Pre-registration (written before any run)

**Hypothesis.** Among the most liquid coins, recent winners keep outperforming recent losers over the
next few weeks, because retail attention and capital rotate slowly between narratives. Holding the
strongest few, only while BTC is in an uptrend, should earn a return per unit of risk that a plain
gated basket of the same liquid coins does not.

**Why it might survive costs.** Weekly or slower rebalancing, a rank buffer that keeps a holding until it
falls below 2K, and a universe limited to the top 30 by volume all hold turnover down.

**Why it might fail.** Top-ranked coins are often pumps that mean-revert, tier 3 slippage is 0.25% a
side on top of the fee, delisting candidates can rank high just before they die, and the BTC gate may
supply all of the apparent edge while the ranking adds nothing. Real sizing caps exposure at roughly
20-25%.

**Rule.** Every `rebal` days (fixed calendar, day index mod `rebal`), rank the point-in-time top 30 by
`metric` over `L` days. Buy the top `K` with a positive trailing return. Close a holding once its rank
is worse than 2K, its trailing return is negative, or it leaves the universe. If BTC closes at or below
its 200-day average, close everything on any day and buy nothing. Stop = 3 x ATR14, clamped to 8-30%.
Exit profile `trend`.

**Stage 1 grid (36 trials).** `L` {20, 50, 100} x `metric` {ret, radj} x `K` {3, 5, 10} x `rebal` {7, 28}.

**Stage 2 (12 trials, fixed parameters, robustness only).** One change at a time from the stage 1
most-picked parameters: gate 100, gate off, topN 20, topN 50, profile swing, liquidity floor $50M
(forces Tier 1-2), stop 2 ATR, stop 4 ATR, rebal 14, skip the last 7 days, no rank buffer, and a
**control** that replaces the momentum rank with the volume rank. Stage 2 can never change a candidate:
it can only count against one. A candidate must beat the control, or the edge belongs to the gate.

**Evaluation.** walkForward from 2019-01-01, rolling 730-day train, 180-day test, train objective Sharpe,
at least 20 train trades. OOS is 2021-01-01 to 2024-12-31. The start is 2019 because only 15 coins were
eligible at the end of 2018, which is not a cross-section.

**Risk config.** Real v6Risk at the ceilings: 1% per trade, 5% open risk, 20% vol target, 50% cluster,
30% widest stop, ladder 7.5/12.5/17.5/20, daily 3%, weekly 6%. Breakers at defaults. Every other number
is the default. `fullWeightRisk` is used for diagnosis only.

**Budget.** 48 planned, 50 maximum.
