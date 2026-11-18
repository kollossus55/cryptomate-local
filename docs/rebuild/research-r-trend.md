VERDICT: NOTHING QUALIFIES, NOTHING FROZEN. 0 of 9 walk-forwards pass D1-D8: all 9 fail D2 and D7. On the only universe that could be certified (top 10), trend lost clearly to holding.

> Correction after audit: blend-top10 passes D7, so "all 9 fail D7" is wrong. It still fails other criteria. Use data/research/v6/remeasure/verdicts.jsonl for final figures.

# r-trend: time-series trend on large coins, long or cash

Trials: 48 of 50, all logged and unique. Lookahead audit with `rebuild`: clean on all 9 walk-forwards.
All figures are DEV, net of costs, under real v6Risk sizing unless marked otherwise. The pre-registration
below is unchanged from before the first run, apart from this header and the results at the end.

## Pre-registration (fixed before the first run)

**Hypothesis.** A large coin's own trailing return predicts its next few weeks, so holding it only
while its trend is up keeps most of the upside and skips the deep bear legs. Economic reason: slow
diffusion of news and flows, retail herding, and forced selling that makes crypto drawdowns
persistent. It should survive costs because it trades rarely, on the cheapest coins. It may not be
an edge at all: the good results seen so far came from a biased sample, and a long-or-cash rule can
look good simply by sitting out one or two crashes.

**What would count as no edge.** Failing any of D1-D8 under real v6Risk sizing. In particular,
failing to beat same-universe buy-and-hold on Sharpe or Calmar (D8).

**Known before running.** D7 caps any one coin at 35% of profit. With one coin the share is 100%,
and with two coins one must hold at least 50%. So BTC-only and BTC+ETH cannot be certified whatever
their results, and only top 10 can qualify. They are run as the brief asks, to test the claim, and
are reported as failing D7. D7 is not argued around.

**Universes.**
- `btc`: BTCUSDT.
- `btceth`: BTCUSDT, ETHUSDT. Choice justified without hindsight: they are the contract's Tier 1,
  and were ranked 1 and 2 by point-in-time volume at the first date the universe exists (2018-03-15).
- `top10`: point-in-time top 10 by trailing volume, dead coins included.

**Rules** (daily bars, decide at the close, fill at the next open, long or flat):
- `sma`: close above SMA(n).
- `tsmom`: return over L days above 0.
- `blend`: at least k of 4 lookbacks (30, 90, 180, 365 days) have a positive return. A lookback
  without enough history counts as a down vote. Primary hypothesis, because it reduces dependence
  on any one lookback.

**Sizing.** Stop distance = stopK x daily realised vol (30d), capped at 25%. v6Risk sizes on the
stop, so a volatile coin gets a smaller position: this is the volatility scaling. Sizing happens at
entry only; the simulator has no rebalancing. v6Risk at the ceilings for sizing only: open risk 5%,
position 25%, cluster 50%, vol target 20%, risk per trade 1% (0.5% on top10, so all 10 coins fit
inside open risk). Ladder and breakers stay at defaults.

**Exits.** Profile `trend`, unmodified, except the signal-exit diagnostic below. A coin that leaves
the top 10 is held until its own trend turns down or an exit fires.

**Walk-forward.** From 2018-01-01, rolling 730-day train, 180-day test, objective Sharpe. OOS runs
2020-01-01 to 2024-12-31. All DEV.

**Grid (48 trials, limit 50).**

| Block | Grid | Universes | Trials |
|---|---|---|---|
| sma | n 50/100/200, stopK 4 | 3 | 9 |
| tsmom | L 30/90/180/365, stopK 4 | 3 | 12 |
| blend | k 2/3/4, stopK 4 | btc, btceth | 6 |
| blend | k 2/3/4 x stopK 3/4/6 | top10 | 9 |
| Exit diagnostic: signal and hard stop only | blend k3 stopK4 | 3 | 3 |
| 4h robustness: same rule, lookbacks x6, trail and time stop rescaled | blend k3 stopK4 | 3 | 3 |
| Full-weight diagnostic, never a pass | blend k3 stopK4 | 3 | 3 |
| Full-span diagnostic from 2018-07-01 | blend k3 stopK4 | 3 | 3 |

The diagnostics use blend k3 stopK4, the centre of the grid, whatever the main results show.

**Freezing rule.** Freeze a candidate only if it passes all of D1-D8 with a clean audit.
Otherwise freeze nothing.

## Results

No candidate is frozen, so `FROZEN_CANDIDATES` is empty and no holdout evaluation is needed. The
table below therefore covers all 9 walk-forwards rather than frozen candidates.

### Was the claim true?

Contract section 0 says daily rules showed life. On this test that holds only in a narrow sense:

- **BTC and BTC+ETH:** trend matched holding on Sharpe, with far smaller drawdown. It did not clearly
  beat it. At full weight, BTC blend k3 made Sharpe 1.04 against 1.12 for holding, drawdown 45.3%
  against 76.6%, and return 525% against 1,196%. That is drawdown reduction paid for with return,
  not a higher risk-adjusted return. The one clear Sharpe win (tsmom on BTC+ETH, 1.31 against 1.17)
  is the best of six rule and universe runs on those coins, and its D2 is only 0.21.
- **Point-in-time top 10:** the claim fails. Sharpe was 0.41 to 0.66 against 1.08 for the first-day
  basket and 1.02 for rolling hold. At full weight the rule made Sharpe 0.52 with an 82.7% drawdown,
  which is worse than holding on both counts (rolling hold: 1.02 and 80.3%).

So the result weakens as the sample gets broader and less biased. BTC and ETH are also known
survivors, so the good results on them do not escape that bias, even though choosing them needed
no hindsight.

### D1-D8, all walk-forwards

| Run | D1 Sharpe [90% CI] | D2 DSR | D3 DD | D4 count | D5 2x costs | D6 worst / chosen | D7 top coin, top year | D8 Calmar, Sharpe vs hold | Fails |
|---|---|---|---|---|---|---|---|---|---|
| sma btc | 1.12 [0.31, 1.84] | 0.119 | 5.1% | 126 changes | +28.0% | 1.11 / 1.39 | BTC 100%, 2020 43% | 1.09 v 0.87, 1.12 v 1.12 | D2 D7 |
| tsmom btc | 1.16 [0.34, 1.91] | 0.133 | 5.0% | 160 changes | +20.2% | 0.76 / 1.46 | BTC 100%, 2023 59% | 1.13 v 0.87, 1.16 v 1.12 | D2 D7 |
| blend btc | 0.90 [0.10, 1.67] | 0.046 | 5.2% | 124 changes | +18.3% | 1.00 / 1.22 | BTC 100%, 2020 61% | 0.73 v 0.87, 0.90 v 1.12 | D2 D7 D8 |
| sma btceth | 1.14 [0.35, 1.84] | 0.130 | 7.3% | 262 changes | +39.8% | 0.96 / 1.23 | BTC 65%, 2023 39% | 1.21 v 1.04, 1.14 v 1.17 | D2 D7 |
| tsmom btceth | 1.31 [0.57, 2.00] | 0.210 | 7.2% | 310 changes | +63.4% | 0.63 / 1.39 | BTC 60%, 2020 43% | 1.52 v 1.04, 1.31 v 1.17 | D2 D6 D7 |
| blend btceth | 0.94 [0.17, 1.68] | 0.058 | 8.0% | 208 changes | +28.7% | 0.88 / 1.11 | BTC 60%, 2020 62% | 0.70 v 1.04, 0.94 v 1.17 | D2 D7 D8 |
| sma top10 | 0.44 [-0.29, 1.09] | 0.003 | 13.9% | 840 trades | +15.4% | 0.51 / 0.74 | BNB 49%, 2021 71% | 0.27 v 0.93, 0.44 v 1.08 | D1 D2 D7 D8 |
| tsmom top10 | 0.41 [-0.30, 1.06] | 0.003 | 13.7% | 1,015 trades | +14.4% | 0.29 / 0.80 | BNB 48%, 2021 84% | 0.25 v 0.93, 0.41 v 1.08 | D1 D2 D6 D7 D8 |
| blend top10 * | 0.66 [-0.13, 1.29] | 0.009 | 15.0% | 480 trades | +24.4% | 0.53 / 0.68 | BNB 37%, 2021 68% | 0.41 v 0.93, 0.66 v 1.08 | D1 D2 D7 D8 |

\* Stopped trading after hitting the -15% rung. See "Runs cut short".

D2 values were taken as each run finished, so they used a growing global count of 140 to 273
trials. The count is now 334 and they were not recomputed. A higher count can only make D2 harder,
and the best value is 0.21 against a 0.90 threshold. D6 compares against the most-picked parameters.
Most grids here are one-dimensional, so those parameters often have a single neighbour.

### Returns, drawdown, exposure

| Run | Total | 2020 | 2021 | 2022 | 2023 | 2024 | Max DD | Avg exposure | Win rate | Avg bars |
|---|---|---|---|---|---|---|---|---|---|---|
| sma btc | 30.9% | 13.4% | 3.5% | -4.0% | 8.1% | 7.4% | 5.1% | 6.2% | 33% | 17 |
| tsmom btc | 31.5% | 7.9% | 2.3% | -3.0% | 17.4% | 4.7% | 5.0% | 6.2% | 45% | 13 |
| blend btc | 20.5% | 12.4% | -0.3% | 0.0% | 3.0% | 4.3% | 5.2% | 4.9% | 50% | 16 |
| sma btceth | 53.1% | 19.1% | 6.6% | -3.5% | 16.7% | 7.1% | 7.3% | 8.6% | 34% | 16 |
| tsmom btceth | 67.5% | 29.0% | 7.5% | -3.6% | 19.4% | 5.0% | 7.2% | 9.7% | 46% | 15 |
| blend btceth | 31.4% | 19.3% | 1.8% | 0.0% | 4.2% | 3.8% | 8.0% | 5.4% | 45% | 15 |
| sma top10 | 20.2% | 7.1% | 13.3% | -5.4% | 5.4% | -0.8% | 13.9% | 7.8% | 33% | 13 |
| tsmom top10 | 18.3% | 0.8% | 15.2% | -5.9% | 5.9% | 2.2% | 13.7% | 8.3% | 40% | 11 |
| blend top10 * | 34.8% | 20.9% | 19.5% | -6.7% | 0.0% | 0.0% | 15.0% | 5.1% | 43% | 12 |
| Hold BTC | 1,196% | 301% | 60% | -64% | 156% | 121% | 76.6% | 100% | | |
| Hold BTC+ETH | 1,821% | 382% | 258% | -67% | 104% | 65% | 77.8% | 100% | | |
| Rolling hold top 10 | 974% | 123% | 428% | -71% | 56% | 100% | 80.3% | 100% | | |

Exposure is 5-10% because a 1% risk budget on a 10-25% stop buys a small position. Sharpe barely
depends on size, but these are the real returns the system would earn: about 3-11% a year in the
runs above, with cash assumed to earn nothing.

### Costs (dollars, on 10,000 starting equity)

| Run | Fees | Slippage | Stop gap | Delisting |
|---|---|---|---|---|
| sma btc | 124 | 61 | 45 | 0 |
| tsmom btc | 163 | 74 | 26 | 0 |
| blend btc | 113 | 59 | 30 | 0 |
| sma btceth | 212 | 93 | 44 | 0 |
| tsmom btceth | 291 | 133 | 31 | 0 |
| blend btceth | 146 | 69 | 31 | 0 |
| sma top10 | 241 | 286 | 49 | 0 |
| tsmom top10 | 281 | 315 | 35 | 0 |
| blend top10 * | 175 | 259 | 70 | 0 |

Costs are not what kills this family: every run stayed profitable at 2x costs (D5). On top 10 they
do take a real share, about 504 to 631 dollars against about 1,800 to 3,500 of net profit.

### Diagnostics (blend k3 stopK4, fixed parameters, OOS span unless noted)

| Test | btc | btceth | top10 |
|---|---|---|---|
| Fixed parameters, `trend` exits, real sizing | 1.00, DD 4.5% | 0.88, DD 7.0% | 0.63, DD 13.9% |
| Signal and hard stop only | 0.84, DD 10.0% | 0.87, DD 20.3% ** | 0.66, DD 17.8% ** |
| Full weight (never a pass) | 1.04, DD 45.3% | 0.95, DD 46.4% | 0.52, DD 82.7% |
| Hold, same span | 1.12, DD 76.6% | 1.17, DD 77.8% | 1.02, DD 80.3% |
| Full span from 2018-07-01 | 0.83, DD 5.3% | 0.84, DD 7.5% | 0.55, DD 13.9% |
| Hold, full span | 0.96, DD 76.6% | 0.89, DD 76.8% | 0.80, DD 77.5% |
| 4h | 0.72, DD 7.5%, 204 trades | 0.63, DD 10.2%, 423 trades | 0.24, DD 15.0%, 1,511 trades ** |

\*\* Cut short by the drawdown ladder, so not a like-for-like comparison.

- **Adding the 2018 bear does not rescue it.** Over the full span, the fixed rule is below holding
  on Sharpe in all three universes, though with far smaller drawdown.
- **4h is worse everywhere**, with about 3x the trades. It gives no support to moving off daily bars.
- **The `trend` exits do not add obvious value.** Removing them left Sharpe lower on BTC and about
  the same elsewhere, but two of those three runs were cut short, so this is weak evidence.

### Exposure-matched hold

Added after the BTC result, so it was not pre-registered. It is a benchmark with no parameters and
selected nothing, so it is not logged as a trial. It scales the hold's daily returns to each run's
average exposure, with cash for the rest and no extra rebalancing cost.

| Run | Strategy Calmar, DD, return | Hold at same exposure |
|---|---|---|
| sma btc | 1.09, 5.1%, 30.9% | 0.61, 7.4%, 25.0% |
| tsmom btc | 1.13, 5.0%, 31.5% | 0.61, 7.4%, 24.8% |
| blend btc | 0.73, 5.2%, 20.5% | 0.61, 5.9%, 19.4% |
| sma btceth | 1.21, 7.3%, 53.1% | 0.72, 10.8%, 45.2% |
| tsmom btceth | 1.52, 7.2%, 67.5% | 0.72, 12.1%, 52.1% |
| blend btceth | 0.70, 8.0%, 31.4% | 0.70, 6.9%, 26.6% |
| sma top10 | 0.27, 13.9%, 20.2% | 0.58, 10.6%, 34.8% |
| tsmom top10 | 0.25, 13.7%, 18.3% | 0.58, 11.1%, 37.0% |
| blend top10 * | 0.41, 15.0%, 34.8% | 0.57, 7.0%, 21.8% |

This is the most favourable evidence for the family: on BTC and BTC+ETH, timing beat simply holding
a small position, on Calmar and return, in five of six runs, and tied on Calmar in the sixth. It is
one bull-heavy five-year span, on two coins, with no deflation for the number of runs. On top 10,
trend had a worse Calmar and deeper drawdown than a small static holding in every run.

### Runs cut short

The -15% rung stops new entries, and once the book is flat equity cannot recover, so only a human
re-enable releases it. The simulator has no re-enable, so a run that touches it sits in cash for good.

| Run | Evidence |
|---|---|
| blend top10 walk-forward | DD 15.03%, 2023 and 2024 exactly 0, 777 blocked-entry events |
| Signal exits top10 | DD 17.8%, 2022-2024 exactly 0, 57 trades |
| 4h top10 | DD 15.00%, 2024 exactly 0 |
| Signal exits btceth | DD 20.25%, flattened and halted, 2022-2024 exactly 0 |

For the first three, the cause is inferred from these numbers: no run was repeated to trace it. The
fourth reports `halted: true`.

This matters for reading blend top10. Its 0.66 covers about three active years, and its D7 year share
is inflated because it missed 2023-24. It does not change the verdict. The top 10 runs that were not
cut short (sma 0.44, tsmom 0.41, fixed blend k3 stopK4 0.63) also fall well short of holding, and the
full-weight run, which has no ladder, made 0.52. That the ladder fired at all on about 5% exposure
is itself a result: these books lost 15% of equity on small positions.

### What failed and why

- **D2 (all 9).** Best 0.21 against 0.90. Five years of daily data with Sharpe near 1 is not enough
  evidence once hundreds of trials are counted.
- **D7 (all 9).** Structural for btc and btceth, as stated before running. On top 10, 2021 and BNB
  carried too much of the profit.
- **D8 and D1 on top 10.** Altcoin trends reverse sharply: frequent whipsaws and stops, with win rates
  of 33-43%, and no protection in the crashes at full weight.
- **Lookback fragility.** The 30-day lookback looks best on fixed parameters in all three universes
  (1.46, 1.39, 0.80), but 90 days next to it is 0.76, 0.63 and 0.29. That is a sharp peak, not a
  plateau, and it fails D6 twice. These are OOS-span figures, so they are not a basis for choosing 30.
- **Blending did not help.** The primary hypothesis was the blend. On BTC and BTC+ETH it was the
  weakest rule and the only one to fail D8. On top 10 its higher Sharpe is mixed up with the cut-short run.

### Limits of this test

- The OOS span is five years, with one major bear market.
- Stops on crash days fill at the worse of stop and open, which is optimistic on wick days. The delisting
  haircut never applied here.
- Sizing is at entry only, with no rebalancing, so the vol scaling is coarse.
- `warmupBars` is constant at 200 because walk-forward keeps the first pick's warmup for every fold.
  Coins with too little history for a lookback are handled by the down vote or NaN test instead.
