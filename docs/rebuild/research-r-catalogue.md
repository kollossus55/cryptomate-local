VERDICT: NO EDGE, NOTHING FROZEN. All 20 pre-registered cells (C1-C5) failed the event-study gate, so by the pre-registered rule no walk-forward ran and D1-D8 were never reached. FROZEN_CANDIDATES is empty. 20 trials logged; global count now 510. Holdout not touched.

The pre-registration below is unchanged from before the first run, apart from this line and the results at the end.

# r-catalogue: four outside ideas from the paperswithbacktest catalogue

Source: github.com/paperswithbacktest/awesome-systematic-trading, reviewed 2026-11-13. These are the
only catalogue ideas that are both new to V6 and expressible on its data:

| Effect | Catalogue entry | Needs shorts |
|---|---|---|
| C1 | #37 Price Overreactions in the Cryptocurrency Market (continuation, long side) | no |
| C2 | #37, mirror: continuation after a down overreaction, short side | yes (perp) |
| C3 | #39 Cryptocurrency as money (long-only pairs rotation) | no |
| C4 | #27 ratio mean reversion and #97/#98 pairs trading (long-short spread) | yes (perp) |
| C5 | #25 Momentum with intra-market correlation filter (long-short, and its long leg alone) | yes for C5-LS |

ETH/BTC alone (#27's direct analogue) is not tested: with two coins one of them must carry at least
half the profit, so D7 (no coin > 35%) can never pass. Its idea is tested across many pairs in C4.

Perp shorts were enabled in v6Risk on 2026-11-13 (funding allowance 1.5% in each short's loss; see
risk-engine.md) before this pre-registration. Shorts trade Binance USDT perps with actual funding.

## Hypotheses and economic reasons

- **C1/C2, overreaction continuation.** A daily move far outside a coin's recent range is usually
  news or a flow shock. Attention is limited and retail flow chases moves, so part of the repricing
  arrives over the next days. Caporale & Plastun report fading overreactions loses and following
  them pays (BTC, LTC, XRP, DASH). Null: after costs, entries after an abnormal day earn no more than
  the same coins' unconditional drift over the same horizon.
- **C3/C4, pairs mean reversion.** Coins that moved together closely over the formation window are
  partial substitutes for the same flows (sector rotation, index-like baskets). A gap in their price
  ratio is often flow pressure on one leg that reverses. C3 holds only the cheap leg (the paper's
  long-only variant) and keeps market exposure; C4 holds the spread (long cheap perp, short rich perp)
  and should be close to market neutral. Null: the cheap leg (C3) or the spread (C4) earns nothing
  after costs. Deviation from the paper: pairs are chosen by return correlation over the formation
  window, not an Engle-Granger cointegration test (fewer free choices, no p-value threshold to pick).
- **C5, correlation-filtered momentum.** When short-term average correlation is above long-term,
  moves are market-wide and herding makes them persist (momentum). When it is below, moves are
  idiosyncratic noise that reverts (reversal). Null: the regime-switched long-short portfolio, or its
  long leg, earns nothing after costs.

## Fixed definitions (all UTC, daily bars, DEV only: 2020-01-01 to 2024-12-31)

Universe: point-in-time top N by trailing 30-day median quote volume (`pointInTimeUniverse`), N = 20
for C1, C2 and C5, N = 10 for C3 and C4. Short-side effects use only coins whose perp exists under the
same symbol on that date (1000x contracts are skipped). Halves: 2020-2022 and 2023-2024.

- **C1:** event when a coin's close-to-close return on day t exceeds k x sd(previous 30 daily
  returns). Buy at the open of t+1, sell at the close of t+h. Gross = close(t+h) / open(t+1) - 1.
- **C2:** event when the return is below -k x sd. Short the perp at the open of t+1, cover at the close
  of t+h. Gross = -(perp close / perp open - 1) + funding received (actual events in the hold).
- **C3/C4:** each day, among the top 10, pairs with return correlation >= 0.8 over the trailing F days.
  z = (log(A/B) - mean) / sd over the trailing F days. Event when z <= -Z (A cheap; each unordered pair is
  checked both ways). Enter at the next open. Exit at the first close with z >= 0, or after 20 days.
  While a pair is open it cannot fire again. C3 gross = A's return. C4 gross = A's perp return - B's
  perp return + net funding on both legs.
- **C5:** every Monday open, rhoS = mean pairwise correlation of daily returns over 20 days, rhoL over
  120 days, top 20 with perps. Rank by trailing L-day return. If rhoS > rhoL: long top 4, short bottom 4
  (momentum); else long bottom 4, short top 4 (reversal). Hold to the next Monday open. C5-LS gross =
  mean(long) - mean(short) + net funding. C5-LO gross = mean(long), spot.

Costs: contract cost model through `costFor` (spot fee 0.10%, perp 0.05%, tier slippage), charged per
round trip. C5 charges only on names that change, both legs.

## Grid (20 trials; the family budget is 50)

| Effect | Grid | Trials |
|---|---|---|
| C1 | k {2, 3} x h {1, 5} | 4 |
| C2 | k {2, 3} x h {1, 5} | 4 |
| C3 | Z {1.5, 2} x F {90, 180} | 4 |
| C4 | Z {1.5, 2} x F {90, 180} | 4 |
| C5 | L {30, 90} x {LS, LO} | 4 |

Every cell is logged with `trialRecord` to `data/research/v6/trials-r-catalogue.jsonl`.

## Step 1: event-study gate (same rule as r-season)

A cell passes only if ALL hold:
1. mean gross > mean round-trip cost;
2. mean excess > 0 with t >= 2, where excess is gross minus the same coins' unconditional drift over
   the same horizon for long-only effects (C1, C3, C5-LO), minus the mirrored drift for C2, and the
   gross itself for the spreads (C4, C5-LS);
3. mean excess positive in both halves.

The t-statistic is computed on block means, not single events, because events cluster on the same
days: blocks of 7 days for C1/C2/C5 and 28 days for C3/C4 (longer than the longest hold).

## Step 2: walk-forward, only for an effect with a passing cell

The effect's strategy runs through `walkForward` (real v6Core and v6Risk sizing inside HARD_CEILINGS,
train 730 days, test 180 days, from 2020-01-01), grid = that effect's four cells, `auditLookahead`
clean, judged by `checkDevCriteria` with the global trial count. Stop: 3 x ATR(14) / close, clipped to
[3%, 25%]. Exit profile `swing` for C1/C2 with a time exit at h bars, `revert` for C3/C4, `trend` for
C5. Up to 2 frozen candidates. If no cell passes step 1, no walk-forward runs and nothing is frozen.

Holdout (2025+) is not read by any route.

## Results (run 2026-11-13)

`node scripts/v6/research/r-catalogue.mjs study`: 140 symbols ever in the top 20, 130 with a same-symbol perp,
25 s. Mean gross and cost are per event; excess t is on block means. Gate: gross > cost, excess > 0 with t >= 2,
excess positive in both halves.

| Cell | Events | Mean gross | Mean cost | Mean net | Mean excess | Excess t (blocks) | Halves 2020-22 / 2023-24 | Net Sharpe | Gate |
|---|---|---|---|---|---|---|---|---|---|
| C1 k2 h1 | 1,407 | 0.198% | 0.490% | -0.292% | -0.042% | -1.83 | -0.223% / 0.220% | -1.32 | FAIL |
| C1 k2 h5 | 1,126 | 2.406% | 0.486% | 1.920% | 1.241% | -0.41 | 0.815% / 1.841% | 0.18 | FAIL |
| C1 k3 h1 | 470 | 0.227% | 0.501% | -0.274% | -0.029% | -1.67 | -0.330% / 0.400% | -1.28 | FAIL |
| C1 k3 h5 | 412 | 3.531% | 0.497% | 3.035% | 2.281% | 0.73 | 1.815% / 2.911% | 0.80 | FAIL |
| C2 k2 h1 | 871 | -1.109% | 0.379% | -1.487% | -0.945% | -1.91 | -1.553% / 0.195% | -1.96 | FAIL |
| C2 k2 h5 | 732 | 0.329% | 0.380% | -0.051% | 1.154% | -0.21 | 1.341% / 0.805% | -1.00 | FAIL |
| C2 k3 h1 | 257 | -2.648% | 0.385% | -3.033% | -2.498% | -1.68 | -3.458% / 0.016% | -2.17 | FAIL |
| C2 k3 h5 | 213 | 2.340% | 0.384% | 1.956% | 3.045% | 0.38 | 3.919% / 1.096% | -0.35 | FAIL |
| C3 Z1.5 F90 | 507 | 4.628% | 0.471% | 4.157% | 0.291% | 0.24 | -0.368% / 3.610% | 1.10 | FAIL |
| C3 Z1.5 F180 | 357 | 3.357% | 0.513% | 2.843% | -1.490% | 0.07 | -1.769% / 1.665% | 0.94 | FAIL |
| C3 Z2 F90 | 284 | 3.511% | 0.473% | 3.038% | -1.141% | 0.23 | -2.057% / 4.137% | 1.09 | FAIL |
| C3 Z2 F180 | 215 | 1.328% | 0.498% | 0.831% | -3.524% | 0.24 | -3.971% / 0.829% | 0.81 | FAIL |
| C4 Z1.5 F90 | 464 | -0.011% | 0.683% | -0.694% | -0.011% | 0.17 | 0.218% / -1.322% | -0.19 | FAIL |
| C4 Z1.5 F180 | 350 | -2.520% | 0.757% | -3.277% | -2.520% | -0.54 | -2.461% / -3.227% | -0.46 | FAIL |
| C4 Z2 F90 | 265 | -1.567% | 0.688% | -2.254% | -1.567% | -1.42 | -1.212% / -3.754% | -0.91 | FAIL |
| C4 Z2 F180 | 210 | -5.327% | 0.742% | -6.069% | -5.327% | -0.40 | -5.620% / -2.204% | -0.33 | FAIL |
| C5-LS L30 | 242 | 0.477% | 0.415% | 0.061% | 0.477% | 0.66 | 0.837% / -0.001% | 0.04 | FAIL |
| C5-LO L30 | 242 | 1.444% | 0.258% | 1.186% | 0.232% | 0.26 | 0.382% / 0.034% | 0.60 | FAIL |
| C5-LS L90 | 242 | 0.019% | 0.345% | -0.326% | 0.019% | 0.02 | -0.499% / 0.705% | -0.19 | FAIL |
| C5-LO L90 | 242 | 1.161% | 0.213% | 0.947% | 0.303% | 0.33 | 0.065% / 0.617% | 0.47 | FAIL |

No cell reaches t >= 2. The best block t is 0.73 (C1 k3 h5).

### What the numbers say

- **Big per-event averages come from a few episodes, not a steady effect.** Where the event mean and the
  block t disagree in sign, a handful of crowded weeks dominate. C1 k2 h5: 96 of 222 weeks had a positive mean;
  the largest weeks are 2024-11-06 (26 events, +535% summed excess) and 2021-04-08 (+427%), against 2022-11-03
  (FTX, -419%) and 2022-05-05 (LUNA, -339%). A strategy holding these would live or die on a few market events.
- **C2, shorting after a crash day, loses at 1 day** (-1.1% gross per event): crashes tended to bounce the next
  day, worst in 2020-03-13 and 2021-05-20. This is not evidence for buying crashes: r-flush and r-revert tested
  that side and found no edge, and flipping a failed rule after seeing it would be a new, post-hoc hypothesis.
- **C3 looks good gross only because the coins went up.** The cheap leg earned 1-5% per event, but less than its
  own drift over the hold (excess near zero or negative). LUNA (2022-05-20) and two 2020 episodes, where the
  "cheap" coin kept falling, drive the losses.
- **C4, the market-neutral spread, has negative gross in 3 of 4 cells.** Pairs that diverge in crypto mostly
  keep diverging over 20 days, so the spread loses before costs; two perp legs cost 0.68-0.76% a round trip.
- **C5 has no regime effect.** The long-short version is near zero gross; the long leg's return is mostly the
  market's.

### Not done

- No walk-forward and no D1-D8, by the pre-registered rule. Nothing frozen.
- No other thresholds, horizons or pair rules were tried; doing so would be new trials on a family that showed
  no t-stat anywhere near 2.
- Cointegration (Engle-Granger) pair selection was not tried; correlation >= 0.8 was pre-registered instead.
- Perp shorts were enabled in v6Risk for this work (in the worktree, tested). No strategy uses them, so the change
  has not been applied to the live tree.
