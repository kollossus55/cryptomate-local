VERDICT: No exit rule creates edge. Keep the hard stop, trail and time stop. Turn off break-even and partial profit, because both cost return. Recommended 1d profiles are below. Nothing is frozen, and the values are not validated on 4h.

> Correction after audit: the global trial count is 385, not 390.

# Research: exit rules (agent r-exits)

No exit rule can guarantee a winning trade. Exits changed how losses and gains are shaped, and none of them turned a random entry into a qualifying strategy. All 50 trials are used and all figures are net of costs. Every walk-forward failed D2, and DEV is the only period seen.

## Answer

| Component | Verdict | Average loss | Give-back from peak | Return |
|---|---|---|---|---|
| Hard stop at 2 to 3 ATR | **Keep.** Plateau | 3 ATR is -0.56 Re, 2 ATR is -0.69 | 75% at 3 ATR, 86% at 2 | Real-sizing Sharpe 0.57 and 0.56 |
| Tight stop, 1 to 1.5 ATR | **Looks safe, costs money** | Smaller in percent (-8.5% at 1 ATR) but larger in money (-0.89 Re) | 111% at 1 ATR | Max drawdown 17.3% against 12.9% |
| Break-even at 1R or tighter | **Looks safe, costs return** | Not improved: -0.77 against -0.69 Re | 80% against 86% | -0.049 Re per trade on random, -0.112 on breakout, both significant |
| Break-even at 2R | No effect | Same | Same | It fires on only 3% of trades, so leave it off |
| Chandelier trail, 3 to 6 ATR | **Keep.** It protects the book, not the mean | Little change | 86% at 4 ATR against 108% with none | With no trail, drawdown is about double |
| Chandelier at 2 ATR | **Looks safe, costs return** | -0.76 Re | Best, 61% | Sharpe 0.28, the cliff edge of the axis |
| Time stop, 10 to 20 bars | **Keep, and it has a price** | The biggest loss reducer: -0.53 Re at 10 bars, -0.85 with none | No change | Costs about 0.07 Re per trade on the diagnostic, not visible under real sizing |
| Partial take-profit | **Looks safe, costs return** | No better: -0.71 to -0.77 Re | 73-81% against 86% | About 40% of return on random (14.6% against 23.4%) |

Re is net result divided by the planned loss budget, so -1 is one full budget and all stop widths risk the same money. At 0.5% risk, 1 Re is 0.5% of equity. Figures are random entries, five seeds, unless stated.

**The break-even stop is more nuanced than "it gets clipped".** About 75% of trades that left at break-even would have gone on to lose without it, so it mostly rescues losers. The other quarter is worth more: the same entries averaged +0.26 Re without it against 0.01 with it (+0.40 on breakout), and 14% to 19% would have reached +1R or more. It raises the win rate from 30% to 44%, which feels safer, while total return falls.

**Tight stops do not cut the money lost.** Risk sizing buys a larger position for a tighter stop, so the percent loss falls while the money lost rises. At 1 ATR, 67% of trades hit the hard stop.

**Tail loss per trade did not separate the configs.** The worst 5% of trades average -1.00 Re in every config, because the simulated stop holds and these daily bars rarely gap. Treat that as a limit of the test, not as safety. Worst calendar month is the useful tail measure here:

| Config | Random, worst month Re | Breakout, worst month Re |
|---|---|---|
| Stop 1 ATR | -13.5 | not run |
| Stop 2 ATR (C) | -10.1 | -18.0 |
| Stop 3 ATR | -9.1 | -12.3 |
| Time stop 10 bars | -9.0 | not run |
| No time stop | -12.0 | -18.0 |
| Stop only (`bare`) | -15.3 | -17.5 |

**No trail is the most tempting wrong answer.** On random entries it has the best return (66% to 81%), and the highest mean Re. That comes from a few runaway trades: the top 1% of trades supply 59% to 70% of gross wins, mostly entries from 2018-20 that rode the 2021 bull market. Capped at +10 Re per trade the advantage disappears, and it turns significantly negative on breakout (-0.672) and dip (-0.291). Drawdown reaches 26.5% to 37.0%, past the -20% halt, with 1.4 to 2 simulated human re-enables on random (2 on breakout and dip). With no simulated re-enable, the runs tested stopped after 6 to 12 entries.

**The current swing and revert placeholders are clearly bad.** At the same time in market they do worse than a random exit: -1.23% per trade for `ph_swing`, CI [-1.98%, -0.42%], and -0.60% for `ph_revert`, CI [-0.96%, -0.27%]. Real-sizing Sharpe is 0.32 and -0.06 against 0.56 for C. Stacking break-even, a tighter trail and partials compounds the cost.

**Exit timing has no proven skill.** Against the placebo with the same holding times, no recommended config is distinguishable from zero: C +0.57% CI [-1.08%, +2.46%], `stop3` -0.20%, `t10` +0.32%. Their value is shaping losses, not adding return.

## Hypotheses against results

| Hypothesis | Result |
|---|---|
| H1 Tight stops cut average loss but lose more in total | Supported in percent terms. In equal-money terms they do not even cut average loss |
| H2 Break-even looks safe and reduces return | Supported, though most break-even exits avoided a loss |
| H3 A trail cuts give-back; 2 ATR is too tight | Supported |
| H4 A time stop is most likely to help per unit of risk | Half right: it cuts losses most, but does not raise return per trade |
| H5 Partials cut variance and reduce return | Supported |

## Recommended profiles (1d only)

Exported as `RECOMMENDED_EXIT_PROFILES` in `scripts/v6/research/r-exits.mjs`. Each one is a config that was run exactly as written: trend is `stop3`, swing is `C`, revert is `t10`. `FROZEN_CANDIDATES` is empty. `v6Exits.js` was not edited.

| Setting | Trend (now) | Swing (now) | Revert (now) |
|---|---|---|---|
| Stop | 3 ATR (3) | 2 ATR (2) | 2 ATR (2) |
| Break-even | off (+1R) | off (+1R) | off (+1R) |
| Chandelier | 4 ATR (4) | 4 ATR (3) | 4 ATR (2) |
| Time stop | 20 bars, 0R (40, 0R) | 20 bars, 0R (20, 0.5R) | 10 bars, 0R (5, 0.25R) |
| Maximum age | none (none) | none (60) | none (10) |
| Partial | none (none) | none (50% at 2R) | none (50% at 1R and 2R) |
| Regime exit | off (exit) | off (tighten) | off (exit) |

The evidence does not support three different shapes. The profiles differ only in stop width and time stop, and the trend and swing gap is small.

Left at placeholder and untested: `trail.activateR` 1, `tightenFactor` 0.5, spike guard 6 ATR, `fallbackPct`, `minRewardRisk`, break-even buffer, time stop `minR` values other than 0.

**Regime exit needs a coordinator decision.** It was off in every tested config, which is the only reason it is off here. It was never isolated, so this is not evidence against it, and the contract lists it as part of every plan.

**Stops must be sent by the strategy.** `hardStop.atrMult` applies only when a position arrives without a stop. A strategy gets the tested stop only by sending `stopDistancePct` = multiple x ATR(14) / close. Stops were clamped to 29%, which applied to 37% of trades at 3 ATR on random entries and 13% on breakouts, so "3 ATR" is partly a 29% stop.

### Plateau

Real-sizing Sharpe, one grid step either side. All neighbours tested hold at least 50% of the chosen value.

| Axis (random) | Values |
|---|---|
| Stop 1 / 1.5 / **2** / 3 / 4 ATR | 0.46 / 0.49 / **0.56** / 0.57 / 0.50 |
| Chandelier 2 / 3 / **4** / 6 ATR | 0.28 / 0.56 / **0.56** / 0.69 |
| Time stop 10 / **20** / 40 / off | 0.62 / **0.56** / 0.51 / 0.50 |
| Break-even **off** / 0.5R / 1R / 2R | **0.56** / 0.44 / 0.57 / 0.58 |
| Partial **off** / 1R / 2R | **0.56** / 0.35 / 0.45 |

Seed standard deviation is about 0.15, so the standard error is about 0.07. Most gaps inside the plateau are noise. Break-even looks free on this axis at 1R and 2R, and only the paired test shows its cost.

The plateau is proven around swing only. Trend has only its stop axis tested, because no other axis was run at 3 ATR. Revert has one neighbour, and that neighbour did better on dip: C 0.62 against `t10` 0.45, on one path. `t10` is still preferred there for loss reasons: 14.7% drawdown with no re-enable against 16.8% with one, and -0.48 against -0.66 Re average loss. That choice gives up return (16.5% against 28.7%).

## Reserved confirmation trials

| Trial | Result | Reading |
|---|---|---|
| `trendRec` (stop 3, trail 6, time 40), random | Sharpe 0.64, return 25.1%, max DD 14.8% | No better than the simpler configs |
| `trendRec`, breakout | Sharpe 0.86, return 42.7%, max DD 13.4% | **Failed.** `stop3` scored 1.26, so it is not recommended |
| C on 4h, random, 3 seeds | Sharpe -0.34, return -9.0%, max DD 16.9% | Loses money |
| `t120` on 4h, random, 3 seeds | Sharpe -0.13, return -1.1%, max DD 16.9% | Same clock time as 20 daily bars; seeds run from 0.61 to -0.68 |
| C on 4h, breakout | Sharpe 0.70, return 49.6%, max DD 30.0%, 2 re-enables | Fees and slippage 4,658 on 10,000 starting equity |

The 1d values should not be carried to 4h. Costs take a much larger share there, which fits the contract's evidence.

## Harness results

Lookahead audit with `rebuild`: clean on all 17 jobs. Walk-forward out of sample starts 2020-07, under real v6Risk with `maxStopDistancePct` 0.30. Trial count 50 of 50.

| Run | Return | Sharpe | Max DD | Trades | Exposure | 2x cost | Re-enables | Fees / slip / stop gaps |
|---|---|---|---|---|---|---|---|---|
| breakout | 48.1% | 0.91 | 12.4% | 415 | 8.3% | 39.2% | 0 | 209 / 336 / 115 |
| dip | 12.8% | 0.34 | 19.7% | 344 | 7.9% | 9.7% | 1 | 117 / 185 / 75 |
| random seed 1 | 14.5% | 0.35 | 20.4% | 322 | 9.3% | 12.7% | 1 | 147 / 260 / 93 |
| random seed 2 | 30.0% | 0.57 | 19.5% | 261 | 11.2% | 16.0% | 1 | 150 / 267 / 109 |
| random seed 3 | 4.5% | 0.18 | 15.3% | 154 | 4.6% | 10.3% | 0 | 40 / 79 / 49 |
| random seed 4 | 65.0% | 0.86 | 15.1% | 360 | 7.3% | 49.2% | 1 | 110 / 182 / 201 |
| random seed 5 | 38.1% | 0.76 | 18.2% | 195 | 12.3% | 32.5% | 1 | 82 / 151 / 38 |

Costs are in account units on 10,000 starting equity. Same-universe buy-and-hold Sharpe is 0.96. Per-year returns and the D1-D8 tables are in the appendix.

These runs pick a config per fold, and they do worse than simply holding a fixed sensible config (breakout 0.91 against 1.09 for C). The picks jump around between folds on every entry type, so re-tuning exits on recent history is not worth doing.

Random seeds range from 0.18 to 0.86 on the same procedure. That spread is the noise floor for any single-path result in this document. Random entries earn a positive Sharpe here because top-20 coins rose over the period, at low exposure.

Breakout entries with these exits passed everything except D2 at 0.000. **That is not a candidate.** It was a control entry for this study, and the breakout family belongs to r-breakout.

## Limits

- **Daily stop path.** Stops use daily highs and lows. Real gaps, wicks and thin books can be worse, so real tail loss is larger than shown.
- **One market history.** The large mean effects come mostly from 2018-20 entries. In the paired tables the 2021-22 column is often near zero or reversed.
- **Multiple comparisons.** About 50 paired tests were read, so a few marginal results will be chance, such as `t40`. The break-even and partial results repeat across entry types, which is why I trust them more.
- **Breakout and dip have one path each.** Only random has seeds.
- **Long-hold placebos are weak.** For `bare` and `chOff`, shuffled holds run into the end of the data, so ignore their timing figures.
- **4h** has no recommendation.

## Changes from the pre-registration

1. **Rule overridden.** The fixed rule scores removing the trail as HELPS on mean Re (+3.2 random, +1.2 breakout). I did not follow it, for the reasons above. The same applies to `ch6` (+0.487), which loses significance when capped, and `trendRec`, which used it, failed on breakout. Removing the time stop also scores as helping (+0.069), and I kept the stop because minimum loss comes first. That is a judgement call, and the price is stated in the table.
2. **Measures added after seeing results:** trimmed mean, the +10 Re cap, top-1% share and worst month.
3. **Placebo bug fixed.** It applied the delisting haircut to live coins past the end of the data. Diagnostics were rerun. The effect was small.
4. **Simulator changed mid-study.** `v6Sim` gained `simReEnable`, so all 50 parameter sets were rerun on it, and every figure here comes from that rerun. `v6Core.js` and `v6Risk.js` changed during that run, so dip and random:3 were rerun again and matched on 31 of 31 trials. Those two are also the only jobs checked this way.
5. **Trial log.** `trials-r-exits.jsonl` keeps its 50 lines as first logged, following `harness-fixes.md`. 15 lines differ by more than 0.01 Sharpe from the figures here, the largest being dip C, 0.17 logged against 0.62. Three are 4h lines that the remeasure did not cover: breakout C 0.94 to 0.70, random C -0.24 to -0.34, `t120` -0.06 to -0.13. Quote this document, not those lines.
6. **Seeds.** Random seeds are one logged trial each, as pre-registered, so 5 seeds x 23 configs are 23 lines. A stricter reading would count more.
7. **Smoke test.** One unlogged plumbing run, seed 99, config C, 2021 only, under default risk settings. Its result played no part in any choice.
8. **Harness D6** treats the config list as an axis, so its figures below mean nothing. Use the plateau table.

## Pre-registration (written before the first run)

Only non-trial data checks came first: date coverage, universe size, and ATR as a percent of price.
That check showed top-20 ATR(14) is large (median about 8% on seven sampled dates), so a 4 ATR stop is
often past 25%. The stop axis is therefore centred on 2 ATR, and the widest stops are clamped at 29%.

**Economic reason.** An exit cannot create edge from a driftless price. On a martingale, any stop,
target or trail only reshapes the payoff: smaller average loss is paid for with a lower win rate or
smaller wins, and every extra exit pays costs. So the default belief is that exits change the shape of
returns and cost money. An exit component can truly add return only if crypto returns have structure it
exploits: momentum (cutting losers and riding winners should pay) or volatility clustering (leaving a
stalled trade should free risk). Daily crypto bars are noisy with ATR near 8%, so I expect:

- H1. Tight stops (1 to 1.5 ATR) cut average loss per trade but lose more in total, by being hit by noise.
- H2. Break-even stops look safe and reduce return: they clip trades that would have recovered.
- H3. A chandelier trail reduces give-back from peak. Its effect on return is unknown, with 2 ATR too tight.
- H4. A time stop is the most likely to help per unit of risk, if stalled trades have no drift.
- H5. Partial take-profit cuts variance and reduces return, by selling the right tail.

**Measures.** Average loss, tail loss (mean of the worst 5% of trades, worst trade), give-back from peak,
expectancy, sum of results per year, exit-reason mix. The unit is `Re`: net result divided by the planned
loss budget (stop distance plus round-trip costs), so -1 is one full budget and every stop width risks the
same money. At the default 0.5% risk, 1 Re is 0.5% of equity.

**Entries (never emit `flat`, so the exit alone closes the trade).** All long, spot, point-in-time top 20,
1d, score-neutral:

1. `random`: a pure hash of (seed, symbol, bar time) fires with p = 0.02 per coin per bar. Five seeds.
   Same entries for every exit config, so differences are paired.
2. `breakout`: close above the prior 20-bar high.
3. `dip`: close below the prior 5-bar low while above the 100-bar SMA.

Stop distance is k x ATR(14) / close, clamped to [0.6%, 29%]. `maxStopDistancePct` is set to 0.30, its
ceiling, so wide stops are not rejected on volatile coins. All other risk settings stay at the defaults.

**Placebo for drift.** Random longs earn market drift, so holding longer can look like a better exit.
Each config's trades get a placebo: same entries, the same holding times shuffled across trades, exit at
the close, normal costs, no stop. Config minus placebo is what the exit rule's timing is worth at the same
time in market.

**Grid.** Centre C: stop 2 ATR, break-even off, chandelier 4 ATR (activates at +1R), time stop 20 bars
(minR 0), no partial. Regime exit off, spike guard at 6 ATR, signal exit inert. Regime exit is not in the
family and stays untested, except inside the three placeholder profiles.

| Axis | Values (C in brackets) |
|---|---|
| Stop, ATR | 1, 1.5, [2], 3, 4 |
| Break-even trigger | [off], 0.5R, 1R, 2R |
| Chandelier, ATR | off, 2, 3, [4], 6 |
| Time stop, bars | off, 10, [20], 40 |
| Partial | [off], 50% at 1R, 50% at 2R |

Plus: `bare` (stop 2 ATR only), `bare_be1` (bare + break-even 1R), `full` (C + break-even 1R + 50% at 2R),
and the current placeholders `ph_trend` (stop 3), `ph_swing` (stop 2), `ph_revert` (stop 2) unchanged.

**Trial budget, 50.** One trial is one exit config on one entry type.

- random: all 23 configs. breakout: 14. dip: 8. That is 45.
- 5 reserved for confirming the recommended profile after the results, including on 4h.
- breakout subset: C, stop 1.5/3, break-even 1R/2R, chandelier off/3/6, time off/40, partial 2R, bare,
  ph_trend, ph_swing.
- dip subset: C, break-even 1R, chandelier off/2, time 10, partial 1R, bare, ph_revert.
- Random seeds are replicates of one parameter set, never selected between, so the five seeds are one
  trial line carrying the mean, and the note says so.

**Two layers.**

1. Judged: `walkForward` (train 730d, test 180d, from 2018-07-01) under real v6Risk, `auditLookahead`
   with `rebuild`, `checkDevCriteria`. D6 from the harness treats the config list as an axis, which means
   nothing here, so plateau is judged by hand along each axis.
2. Diagnostic, for per-trade measurement only: same exit code path, 2018-07 to 2024-12, with constant
   risk per trade and no ladder, because the real drawdown ladder can stop entries and end the sample.
   Not a performance claim.

**Decision rules, fixed now.** Paired difference in mean Re against the reference config, on shared
entries, 90% CI from a bootstrap over entry months (trades in a month are correlated).

- HELPS: CI above 0 on random, and same sign on breakout.
- LOOKS SAFE, COSTS RETURN: cuts average loss, tail loss or give-back, with CI below 0.
- NO MEASURABLE EFFECT: CI spans 0. The simpler rule wins, so the component is off, unless it cuts tail
  loss at no measurable cost, because the user ranks minimum loss first.
- Recommend the middle of a run of neighbours, not the best cell. A value qualifies only if its one-step
  neighbours are not significantly worse.

## Appendix: full tables

Generated by `node scripts/v6/research/r-exits.mjs report`.

### random (diagnostic, equal risk, 2018-07 to 2024-12, 5 seed(s); n is per seed)

| cfg | n | mean Re | 90% CI | median | win | avg loss Re | avg loss % | CVaR5 Re | worst Re | worst % | past -1.25 | Re/yr | bars | stop dist | clamped | reach 1R | give-back % of peak | give-back Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C | 631 | 0.289 | [0.110, 0.479] | -0.40 | 30% | -0.69 | -12.5% | -1.00 | -1.01 | -29% | 0.0% | 28.1 | 21.4 | 17.5% | 10% | 45% | 86% | 2.68 | 0.57% | [-1.08%, 2.46%] |
| stop1 | 698 | 0.310 | [0.094, 0.546] | -0.97 | 22% | -0.89 | -8.5% | -1.00 | -1.01 | -29% | 0.0% | 33.4 | 14.0 | 9.1% | 0% | 48% | 111% | 4.03 | -0.41% | [-1.81%, 1.16%] |
| stop1_5 | 657 | 0.307 | [0.113, 0.509] | -0.96 | 27% | -0.79 | -11.1% | -1.00 | -1.01 | -29% | 0.0% | 31.0 | 18.5 | 13.5% | 3% | 47% | 96% | 3.22 | 0.08% | [-1.17%, 1.58%] |
| stop3 | 609 | 0.232 | [0.080, 0.393] | -0.19 | 32% | -0.56 | -13.6% | -1.00 | -1.00 | -29% | 0.0% | 21.8 | 24.3 | 23.3% | 37% | 40% | 75% | 2.15 | -0.20% | [-1.79%, 1.43%] |
| stop4 | 604 | 0.184 | [0.047, 0.327] | -0.16 | 32% | -0.51 | -13.9% | -1.00 | -1.00 | -29% | 0.0% | 17.1 | 25.3 | 26.4% | 64% | 38% | 72% | 1.91 | 0.42% | [-1.15%, 2.13%] |
| be0_5 | 695 | 0.164 | [0.045, 0.289] | 0.01 | 59% | -0.79 | -14.5% | -1.00 | -1.00 | -29% | 0.0% | 17.6 | 13.9 | 17.3% | 10% | 33% | 80% | 2.33 | -0.32% | [-1.69%, 1.17%] |
| be1 | 652 | 0.248 | [0.086, 0.419] | -0.16 | 44% | -0.77 | -14.1% | -1.00 | -1.01 | -29% | 0.0% | 24.8 | 18.9 | 17.4% | 10% | 45% | 80% | 2.37 | 0.07% | [-1.63%, 1.93%] |
| be2 | 633 | 0.283 | [0.108, 0.472] | -0.39 | 32% | -0.71 | -12.8% | -1.00 | -1.01 | -29% | 0.0% | 27.6 | 21.2 | 17.5% | 10% | 45% | 86% | 2.66 | 0.42% | [-1.07%, 2.13%] |
| chOff | 340 | 3.829 | [1.348, 6.763] | -0.66 | 6% | -0.63 | -12.1% | -1.00 | -1.00 | -29% | 0.0% | 200.3 | 117.2 | 19.2% | 14% | 44% | 108% | 16.79 | 43.69% | [-6.81%, 100.69%] |
| ch2 | 713 | 0.053 | [-0.052, 0.168] | -0.15 | 43% | -0.76 | -13.7% | -1.00 | -1.01 | -29% | 0.0% | 5.9 | 12.8 | 17.2% | 9% | 46% | 61% | 1.16 | -0.64% | [-1.58%, 0.38%] |
| ch3 | 677 | 0.176 | [0.023, 0.344] | -0.29 | 35% | -0.70 | -12.6% | -1.00 | -1.01 | -29% | 0.0% | 18.4 | 16.5 | 17.3% | 10% | 45% | 76% | 1.87 | -0.30% | [-1.62%, 1.20%] |
| ch6 | 568 | 0.755 | [0.328, 1.233] | -0.44 | 22% | -0.66 | -11.9% | -1.00 | -1.01 | -29% | 0.0% | 66.0 | 31.6 | 17.6% | 11% | 45% | 97% | 4.63 | 5.26% | [-0.04%, 11.77%] |
| tOff | 601 | 0.319 | [0.123, 0.529] | -0.86 | 35% | -0.85 | -15.7% | -1.00 | -1.00 | -29% | 0.0% | 29.5 | 26.1 | 17.7% | 11% | 51% | 86% | 2.65 | 0.60% | [-1.28%, 2.54%] |
| t10 | 670 | 0.261 | [0.106, 0.431] | -0.23 | 25% | -0.53 | -9.4% | -1.00 | -1.01 | -29% | 0.0% | 26.9 | 17.0 | 17.4% | 10% | 38% | 85% | 2.65 | 0.32% | [-1.27%, 2.03%] |
| t40 | 610 | 0.307 | [0.113, 0.508] | -0.64 | 33% | -0.80 | -14.7% | -1.00 | -1.01 | -29% | 0.0% | 28.8 | 24.5 | 17.6% | 11% | 49% | 87% | 2.69 | 0.40% | [-1.53%, 2.44%] |
| p1 | 631 | 0.138 | [0.017, 0.268] | -0.15 | 44% | -0.77 | -14.0% | -1.00 | -1.01 | -29% | 0.0% | 13.4 | 21.4 | 17.5% | 10% | 45% | 73% | 3.02 | -1.15% | [-2.85%, 0.54%] |
| p2 | 631 | 0.184 | [0.045, 0.330] | -0.39 | 32% | -0.71 | -12.8% | -1.00 | -1.01 | -29% | 0.0% | 17.9 | 21.4 | 17.5% | 10% | 45% | 81% | 2.92 | 0.15% | [-1.17%, 1.64%] |
| bare | 273 | 5.393 | [2.233, 8.941] | -0.98 | 11% | -0.98 | -20.2% | -1.00 | -1.00 | -29% | 0.0% | 226.4 | 181.1 | 20.0% | 16% | 50% | 122% | 23.11 | 70.91% | [8.27%, 140.70%] |
| bare_be1 | 374 | 3.095 | [1.260, 5.255] | -0.00 | 48% | -0.94 | -18.8% | -1.00 | -1.00 | -29% | 0.0% | 178.0 | 97.2 | 19.0% | 13% | 50% | 95% | 12.21 | 46.16% | [5.99%, 93.44%] |
| full | 652 | 0.150 | [0.020, 0.285] | -0.16 | 44% | -0.77 | -14.1% | -1.00 | -1.01 | -29% | 0.0% | 15.0 | 18.9 | 17.4% | 10% | 45% | 75% | 2.59 | -0.96% | [-2.38%, 0.49%] |
| ph_trend | 597 | 0.252 | [0.089, 0.427] | -0.09 | 46% | -0.76 | -18.5% | -1.00 | -1.00 | -29% | 0.0% | 23.1 | 26.8 | 23.5% | 38% | 44% | 70% | 1.95 | 0.17% | [-1.62%, 2.08%] |
| ph_swing | 712 | 0.055 | [-0.051, 0.168] | -0.06 | 49% | -0.82 | -14.8% | -1.00 | -1.01 | -29% | 0.0% | 6.0 | 13.2 | 17.2% | 9% | 44% | 64% | 1.55 | -1.23% | [-1.98%, -0.42%] |
| ph_revert | 805 | -0.015 | [-0.060, 0.031] | -0.07 | 44% | -0.47 | -8.2% | -0.99 | -1.00 | -29% | 0.0% | -1.8 | 5.1 | 17.0% | 9% | 24% | 46% | 0.83 | -0.60% | [-0.96%, -0.27%] |

Robustness (added after seeing the first table, not pre-registered):

| cfg | mean Re | mean without top 1% of trades | top 1% share of gross wins | worst month sum Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|
| C | 0.289 | 0.088 | 26% | -10.1 | 0.57% | [-1.08%, 2.46%] |
| stop1 | 0.310 | -0.010 | 32% | -13.5 | -0.41% | [-1.81%, 1.16%] |
| stop1_5 | 0.307 | 0.074 | 26% | -11.7 | 0.08% | [-1.17%, 1.58%] |
| stop3 | 0.232 | 0.075 | 26% | -9.1 | -0.20% | [-1.79%, 1.43%] |
| stop4 | 0.184 | 0.050 | 25% | -9.0 | 0.42% | [-1.15%, 2.13%] |
| be0_5 | 0.164 | -0.003 | 35% | -8.4 | -0.32% | [-1.69%, 1.17%] |
| be1 | 0.248 | 0.056 | 28% | -9.7 | 0.07% | [-1.63%, 1.93%] |
| be2 | 0.283 | 0.083 | 26% | -10.1 | 0.42% | [-1.07%, 2.13%] |
| chOff | 3.829 | 0.779 | 69% | -10.5 | 43.69% | [-6.81%, 100.69%] |
| ch2 | 0.053 | 0.003 | 10% | -10.9 | -0.64% | [-1.58%, 0.38%] |
| ch3 | 0.176 | 0.055 | 19% | -9.8 | -0.30% | [-1.62%, 1.20%] |
| ch6 | 0.755 | 0.253 | 40% | -9.8 | 5.26% | [-0.04%, 11.77%] |
| tOff | 0.319 | 0.119 | 23% | -12.0 | 0.60% | [-1.28%, 2.54%] |
| t10 | 0.261 | 0.073 | 29% | -9.0 | 0.32% | [-1.27%, 2.03%] |
| t40 | 0.307 | 0.110 | 24% | -12.0 | 0.40% | [-1.53%, 2.44%] |
| p1 | 0.138 | 0.033 | 19% | -9.4 | -1.15% | [-2.85%, 0.54%] |
| p2 | 0.184 | 0.075 | 17% | -9.9 | 0.15% | [-1.17%, 1.64%] |
| bare | 5.393 | 1.710 | 59% | -15.3 | 70.91% | [8.27%, 140.70%] |
| bare_be1 | 3.095 | 0.590 | 70% | -8.8 | 46.16% | [5.99%, 93.44%] |
| full | 0.150 | 0.045 | 18% | -9.5 | -0.96% | [-2.38%, 0.49%] |
| ph_trend | 0.252 | 0.100 | 23% | -10.5 | 0.17% | [-1.62%, 2.08%] |
| ph_swing | 0.055 | -0.008 | 13% | -10.4 | -1.23% | [-1.98%, -0.42%] |
| ph_revert | -0.015 | -0.030 | 6% | -7.0 | -0.60% | [-0.96%, -0.27%] |

Exit mix:

- C: trail_stop 40%, hard_stop 39%, time_stop 21%, end_of_sim 1%, delisted 0%
- stop1: hard_stop 67%, trail_stop 27%, time_stop 6%, end_of_sim 1%, delisted 0%
- stop1_5: hard_stop 51%, trail_stop 36%, time_stop 13%, end_of_sim 1%, delisted 0%
- stop3: trail_stop 37%, time_stop 36%, hard_stop 26%, end_of_sim 1%, delisted 0%
- stop4: time_stop 42%, trail_stop 36%, hard_stop 22%, end_of_sim 1%, delisted 0%
- be0_5: breakeven_stop 45%, hard_stop 29%, trail_stop 18%, time_stop 7%, end_of_sim 1%, delisted 0%
- be1: hard_stop 38%, trail_stop 25%, breakeven_stop 20%, time_stop 16%, end_of_sim 1%, delisted 0%
- be2: hard_stop 39%, trail_stop 37%, time_stop 20%, breakeven_stop 3%, end_of_sim 1%, delisted 0%
- chOff: hard_stop 48%, time_stop 45%, end_of_sim 6%, delisted 0%
- ch2: trail_stop 45%, hard_stop 38%, time_stop 16%, end_of_sim 1%, delisted 0%
- ch3: trail_stop 45%, hard_stop 38%, time_stop 16%, end_of_sim 1%, delisted 0%
- ch6: hard_stop 42%, time_stop 30%, trail_stop 26%, end_of_sim 1%, delisted 0%
- tOff: trail_stop 50%, hard_stop 49%, end_of_sim 1%, delisted 0%
- t10: time_stop 43%, trail_stop 31%, hard_stop 26%, end_of_sim 1%, delisted 0%
- t40: trail_stop 47%, hard_stop 46%, time_stop 6%, end_of_sim 1%, delisted 0%
- p1: trail_stop 40%, hard_stop 39%, time_stop 21%, end_of_sim 1%, delisted 0%
- p2: trail_stop 40%, hard_stop 39%, time_stop 21%, end_of_sim 1%, delisted 0%
- bare: hard_stop 88%, end_of_sim 11%, delisted 1%
- bare_be1: hard_stop 49%, breakeven_stop 45%, end_of_sim 5%, delisted 0%
- full: hard_stop 38%, trail_stop 25%, breakeven_stop 20%, time_stop 16%, end_of_sim 1%, delisted 0%
- ph_trend: hard_stop 34%, trail_stop 29%, regime_exit 14%, time_stop 11%, breakeven_stop 11%, end_of_sim 1%, delisted 0%
- ph_swing: hard_stop 38%, trail_stop 33%, time_stop 20%, breakeven_stop 8%, end_of_sim 1%, delisted 0%
- ph_revert: time_stop 67%, hard_stop 15%, take_profit 8%, trail_stop 7%, regime_exit 3%, breakeven_stop 2%, end_of_sim 0%, delisted 0%

Paired, A minus B, shared entries:

| A vs B | pairs | d mean Re | 90% CI | call | capped at +10 Re | 2018-20 | 2021-22 | 2023-24 |
|---|---|---|---|---|---|---|---|---|
| stop1 vs C | 3141 | -0.046 | [-0.143, 0.055] | n.s. | -0.146 [-0.213, -0.083] | 0.056 | 0.093 | -0.298 |
| stop1_5 vs C | 3141 | -0.011 | [-0.075, 0.046] | n.s. | -0.037 [-0.069, -0.004] | 0.038 | 0.024 | -0.099 |
| stop3 vs C | 3028 | -0.059 | [-0.103, -0.020] | WORSE | -0.011 [-0.050, 0.025] | -0.139 | -0.002 | -0.034 |
| stop4 vs C | 2995 | -0.104 | [-0.168, -0.046] | WORSE | -0.033 [-0.088, 0.016] | -0.218 | -0.010 | -0.080 |
| be0_5 vs C | 3141 | -0.137 | [-0.226, -0.056] | WORSE | -0.095 [-0.173, -0.024] | -0.334 | 0.005 | -0.069 |
| be1 vs C | 3150 | -0.049 | [-0.087, -0.016] | WORSE | -0.031 [-0.057, -0.007] | -0.125 | 0.003 | -0.021 |
| be2 vs C | 3157 | -0.003 | [-0.008, 0.002] | n.s. | -0.003 [-0.008, 0.002] | -0.008 | 0.003 | -0.003 |
| bare_be1 vs bare | 1359 | -2.096 | [-3.934, -0.445] | WORSE | 0.031 [-0.155, 0.199] | -5.004 | 0.170 | -0.249 |
| chOff vs C | 1688 | 3.203 | [1.136, 5.617] | better | -0.197 [-0.412, 0.030] | 7.463 | -0.234 | 0.446 |
| ch2 vs C | 3139 | -0.239 | [-0.356, -0.128] | WORSE | -0.132 [-0.218, -0.050] | -0.426 | -0.021 | -0.262 |
| ch3 vs C | 3142 | -0.121 | [-0.201, -0.046] | WORSE | -0.036 [-0.084, 0.012] | -0.253 | 0.085 | -0.190 |
| ch6 vs C | 2821 | 0.487 | [0.180, 0.838] | better | 0.046 [-0.060, 0.163] | 1.245 | -0.091 | 0.273 |
| tOff vs bare | 1360 | -5.122 | [-8.543, -2.102] | WORSE | 0.198 [-0.109, 0.494] | -12.192 | 0.448 | -0.733 |
| tOff vs C | 2997 | 0.069 | [0.014, 0.133] | better | 0.052 [0.007, 0.105] | 0.096 | -0.005 | 0.116 |
| t10 vs C | 3137 | -0.042 | [-0.094, 0.006] | n.s. | -0.024 [-0.068, 0.018] | -0.111 | 0.012 | -0.022 |
| t40 vs C | 3036 | 0.046 | [0.002, 0.095] | better | 0.029 [-0.003, 0.065] | 0.044 | -0.010 | 0.105 |
| chOff vs bare | 1361 | -1.404 | [-2.888, -0.248] | WORSE | 0.019 [-0.127, 0.154] | -3.299 | 0.178 | -0.306 |
| p1 vs C | 3157 | -0.151 | [-0.220, -0.085] | WORSE | -0.064 [-0.113, -0.018] | -0.264 | -0.037 | -0.145 |
| p2 vs C | 3157 | -0.105 | [-0.160, -0.054] | WORSE | -0.020 [-0.051, 0.012] | -0.195 | 0.002 | -0.118 |
| C vs bare | 1359 | -5.172 | [-8.618, -2.119] | WORSE | 0.157 [-0.164, 0.465] | -12.326 | 0.484 | -0.767 |
| full vs C | 3150 | -0.142 | [-0.212, -0.073] | WORSE | -0.051 [-0.096, -0.006] | -0.273 | -0.005 | -0.142 |
| ph_trend vs C | 2847 | -0.001 | [-0.077, 0.074] | n.s. | 0.037 [-0.033, 0.105] | -0.072 | -0.029 | 0.103 |
| ph_swing vs C | 3137 | -0.249 | [-0.363, -0.137] | WORSE | -0.142 [-0.231, -0.058] | -0.448 | -0.044 | -0.245 |
| ph_revert vs C | 3144 | -0.314 | [-0.477, -0.152] | WORSE | -0.207 [-0.350, -0.072] | -0.552 | -0.091 | -0.285 |
| ph_trend vs bare | 1296 | -4.503 | [-7.217, -2.029] | WORSE | 0.147 [-0.184, 0.451] | -10.732 | 0.319 | -0.738 |
| ph_swing vs bare | 1360 | -5.367 | [-8.784, -2.267] | WORSE | 0.028 [-0.311, 0.358] | -12.574 | 0.339 | -0.920 |

Break-even clipping (trades that left on the break-even stop, against the same entry without it):

| cfg vs ref | share of trades on BE stop | their mean Re | same entries in ref | ref ended better | ref ended at +1R or more | ref lost |
|---|---|---|---|---|---|---|
| be0_5 vs C | 41% | 0.00 | 0.31 | 27% | 16% | 73% |
| be1 vs C | 19% | 0.01 | 0.26 | 24% | 14% | 75% |
| be2 vs C | 3% | 0.02 | 0.11 | 22% | 8% | 71% |
| bare_be1 vs bare | 32% | 0.01 | 4.71 | 12% | 11% | 88% |

Stops hit, against the same entry with the 2 ATR stop:

- stop1: 61% of trades hit the hard stop. In C those entries averaged -0.28 Re, and 13% ended in profit.
- stop1_5: 49% of trades hit the hard stop. In C those entries averaged -0.61 Re, and 6% ended in profit.
- p1: 45% of trades took the partial. Those trades: 1.27 Re with it, 1.61 Re without.
- p2: 29% of trades took the partial. Those trades: 2.24 Re with it, 2.59 Re without.

### breakout (diagnostic, equal risk, 2018-07 to 2024-12, 1 seed(s); n is per seed)

| cfg | n | mean Re | 90% CI | median | win | avg loss Re | avg loss % | CVaR5 Re | worst Re | worst % | past -1.25 | Re/yr | bars | stop dist | clamped | reach 1R | give-back % of peak | give-back Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C | 712 | 0.654 | [0.317, 1.004] | -0.61 | 35% | -0.80 | -11.9% | -0.99 | -1.00 | -28% | 0.0% | 71.6 | 19.1 | 14.0% | 0% | 55% | 92% | 3.30 | 2.13% | [-0.42%, 4.64%] |
| stop1_5 | 793 | 0.664 | [0.300, 1.036] | -0.97 | 29% | -0.88 | -10.0% | -0.99 | -1.00 | -22% | 0.0% | 81.0 | 15.1 | 10.5% | 0% | 54% | 104% | 3.99 | 1.18% | [-1.41%, 3.71%] |
| stop3 | 666 | 0.500 | [0.249, 0.764] | -0.18 | 39% | -0.65 | -14.0% | -1.00 | -1.00 | -29% | 0.0% | 51.3 | 23.4 | 20.4% | 13% | 52% | 80% | 2.47 | 2.30% | [-0.40%, 5.11%] |
| be1 | 789 | 0.507 | [0.230, 0.789] | 0.01 | 54% | -0.92 | -13.8% | -0.99 | -1.00 | -28% | 0.0% | 61.5 | 14.6 | 14.0% | 0% | 56% | 83% | 2.71 | 2.34% | [-0.10%, 4.79%] |
| be2 | 723 | 0.626 | [0.298, 0.963] | -0.62 | 39% | -0.84 | -12.6% | -0.99 | -1.00 | -28% | 0.0% | 69.6 | 18.5 | 14.0% | 0% | 55% | 91% | 3.23 | 2.24% | [-0.37%, 5.09%] |
| chOff | 401 | 1.837 | [-0.456, 5.359] | -0.97 | 5% | -0.72 | -11.1% | -0.99 | -1.00 | -28% | 0.0% | 113.3 | 94.2 | 15.0% | 0% | 56% | 116% | 12.72 | -2.59% | [-50.32%, 60.18%] |
| ch3 | 833 | 0.341 | [0.093, 0.573] | -0.41 | 39% | -0.79 | -11.6% | -0.99 | -1.00 | -28% | 0.0% | 43.8 | 12.3 | 13.9% | 0% | 54% | 82% | 2.21 | -0.61% | [-2.70%, 1.77%] |
| ch6 | 612 | 1.105 | [0.486, 1.781] | -0.97 | 26% | -0.77 | -11.3% | -0.99 | -1.00 | -28% | 0.0% | 104.0 | 30.9 | 13.9% | 0% | 56% | 104% | 5.42 | 6.46% | [-0.81%, 14.97%] |
| tOff | 691 | 0.688 | [0.343, 1.045] | -0.74 | 36% | -0.85 | -12.8% | -0.99 | -1.00 | -29% | 0.0% | 73.2 | 20.6 | 14.1% | 0% | 57% | 93% | 3.31 | 2.67% | [-0.39%, 5.92%] |
| t40 | 697 | 0.677 | [0.334, 1.029] | -0.74 | 36% | -0.84 | -12.7% | -0.99 | -1.00 | -29% | 0.0% | 72.6 | 20.3 | 14.1% | 0% | 57% | 93% | 3.33 | 1.24% | [-1.45%, 4.01%] |
| p2 | 712 | 0.440 | [0.202, 0.681] | -0.57 | 40% | -0.85 | -12.6% | -0.99 | -1.00 | -28% | 0.0% | 48.2 | 19.1 | 14.0% | 0% | 55% | 86% | 3.69 | 0.70% | [-1.38%, 2.81%] |
| bare | 315 | 2.843 | [-0.531, 8.032] | -0.98 | 9% | -0.98 | -15.9% | -1.00 | -1.00 | -29% | 0.0% | 137.8 | 152.6 | 15.6% | 0% | 57% | 124% | 21.39 | 34.29% | [-32.95%, 132.00%] |
| ph_trend | 717 | 0.409 | [0.179, 0.648] | 0.01 | 54% | -0.79 | -17.2% | -1.00 | -1.00 | -29% | 0.0% | 45.1 | 21.4 | 20.6% | 13% | 51% | 75% | 2.14 | 0.94% | [-1.82%, 3.81%] |
| ph_swing | 938 | 0.175 | [0.018, 0.321] | 0.01 | 55% | -0.95 | -13.9% | -0.99 | -1.00 | -28% | 0.0% | 25.2 | 9.2 | 13.8% | 0% | 53% | 68% | 1.82 | 0.08% | [-1.05%, 1.28%] |

Robustness (added after seeing the first table, not pre-registered):

| cfg | mean Re | mean without top 1% of trades | top 1% share of gross wins | worst month sum Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|
| C | 0.654 | 0.346 | 26% | -18.0 | 2.13% | [-0.42%, 4.64%] |
| stop1_5 | 0.664 | 0.327 | 26% | -17.3 | 1.18% | [-1.41%, 3.71%] |
| stop3 | 0.500 | 0.292 | 24% | -12.3 | 2.30% | [-0.40%, 5.11%] |
| be1 | 0.507 | 0.240 | 29% | -15.7 | 2.34% | [-0.10%, 4.79%] |
| be2 | 0.626 | 0.322 | 27% | -17.8 | 2.24% | [-0.37%, 5.09%] |
| chOff | 1.837 | 0.390 | 57% | -13.7 | -2.59% | [-50.32%, 60.18%] |
| ch3 | 0.341 | 0.194 | 18% | -16.1 | -0.61% | [-2.70%, 1.77%] |
| ch6 | 1.105 | 0.562 | 33% | -18.8 | 6.46% | [-0.81%, 14.97%] |
| tOff | 0.688 | 0.394 | 24% | -18.0 | 2.67% | [-0.39%, 5.92%] |
| t40 | 0.677 | 0.385 | 24% | -18.0 | 1.24% | [-1.45%, 4.01%] |
| p2 | 0.440 | 0.278 | 17% | -17.0 | 0.70% | [-1.38%, 2.81%] |
| bare | 2.843 | 1.326 | 41% | -17.5 | 34.29% | [-32.95%, 132.00%] |
| ph_trend | 0.409 | 0.214 | 25% | -11.8 | 0.94% | [-1.82%, 3.81%] |
| ph_swing | 0.175 | 0.101 | 12% | -13.9 | 0.08% | [-1.05%, 1.28%] |

Exit mix:

- C: trail_stop 48%, hard_stop 44%, time_stop 8%, end_of_sim 0%
- stop1_5: hard_stop 59%, trail_stop 38%, time_stop 3%, end_of_sim 0%
- stop3: trail_stop 50%, hard_stop 29%, time_stop 21%, end_of_sim 0%
- be1: hard_stop 41%, breakeven_stop 29%, trail_stop 26%, time_stop 3%, end_of_sim 0%
- be2: hard_stop 45%, trail_stop 41%, time_stop 8%, breakeven_stop 7%, end_of_sim 0%
- chOff: hard_stop 61%, time_stop 34%, end_of_sim 5%, delisted 0%
- ch3: trail_stop 54%, hard_stop 42%, time_stop 4%
- ch6: hard_stop 51%, trail_stop 29%, time_stop 19%, end_of_sim 1%
- tOff: trail_stop 54%, hard_stop 46%, end_of_sim 0%
- t40: trail_stop 53%, hard_stop 46%, time_stop 1%, end_of_sim 0%
- p2: trail_stop 48%, hard_stop 44%, time_stop 8%, end_of_sim 0%
- bare: hard_stop 91%, end_of_sim 8%, delisted 1%
- ph_trend: hard_stop 32%, trail_stop 30%, breakeven_stop 17%, regime_exit 15%, time_stop 5%, end_of_sim 0%
- ph_swing: hard_stop 43%, trail_stop 39%, breakeven_stop 13%, time_stop 5%

Paired, A minus B, shared entries:

| A vs B | pairs | d mean Re | 90% CI | call | capped at +10 Re | 2018-20 | 2021-22 | 2023-24 |
|---|---|---|---|---|---|---|---|---|
| stop1_5 vs C | 712 | 0.016 | [-0.172, 0.169] | n.s. | -0.035 [-0.108, 0.036] | -0.222 | 0.042 | 0.234 |
| stop3 vs C | 666 | -0.166 | [-0.277, -0.054] | WORSE | -0.037 [-0.115, 0.049] | -0.234 | -0.026 | -0.224 |
| be1 vs C | 712 | -0.112 | [-0.248, -0.009] | WORSE | -0.077 [-0.156, -0.006] | -0.086 | -0.022 | -0.218 |
| be2 vs C | 712 | -0.009 | [-0.024, 0.004] | n.s. | -0.009 [-0.024, 0.004] | -0.005 | 0.000 | -0.022 |
| chOff vs C | 401 | 1.189 | [-1.018, 4.683] | n.s. | -0.672 [-1.071, -0.225] | 3.110 | -1.017 | 0.277 |
| ch3 vs C | 712 | -0.326 | [-0.543, -0.140] | WORSE | -0.118 [-0.218, -0.017] | -0.640 | 0.158 | -0.440 |
| ch6 vs C | 612 | 0.505 | [0.014, 1.060] | better | -0.036 [-0.217, 0.150] | 1.378 | -0.194 | 0.238 |
| tOff vs bare | 315 | -2.260 | [-7.299, 1.060] | n.s. | 0.621 [-0.065, 1.220] | -5.107 | 1.262 | -0.710 |
| tOff vs C | 691 | 0.015 | [-0.013, 0.049] | n.s. | 0.015 [-0.013, 0.049] | 0.017 | -0.011 | 0.036 |
| t40 vs C | 697 | 0.008 | [-0.020, 0.040] | n.s. | 0.008 [-0.020, 0.040] | 0.005 | -0.020 | 0.036 |
| chOff vs bare | 315 | -0.731 | [-1.687, 0.082] | n.s. | -0.065 [-0.305, 0.146] | -1.092 | 0.069 | -0.769 |
| p2 vs C | 712 | -0.213 | [-0.337, -0.100] | WORSE | -0.039 [-0.106, 0.021] | -0.375 | 0.011 | -0.250 |
| C vs bare | 315 | -2.273 | [-7.354, 1.048] | n.s. | 0.609 [-0.080, 1.215] | -5.113 | 1.258 | -0.738 |
| ph_trend vs C | 638 | -0.185 | [-0.381, -0.002] | WORSE | -0.067 [-0.200, 0.059] | -0.000 | -0.162 | -0.371 |
| ph_swing vs C | 712 | -0.469 | [-0.729, -0.231] | WORSE | -0.226 [-0.385, -0.069] | -0.792 | -0.004 | -0.556 |
| ph_trend vs bare | 286 | -2.848 | [-8.442, 0.805] | n.s. | 0.452 [-0.296, 1.088] | -6.252 | 0.778 | -0.998 |
| ph_swing vs bare | 315 | -2.720 | [-7.926, 0.612] | n.s. | 0.318 [-0.403, 0.883] | -5.725 | 1.005 | -1.088 |

Break-even clipping (trades that left on the break-even stop, against the same entry without it):

| cfg vs ref | share of trades on BE stop | their mean Re | same entries in ref | ref ended better | ref ended at +1R or more | ref lost |
|---|---|---|---|---|---|---|
| be1 vs C | 25% | 0.00 | 0.40 | 27% | 19% | 73% |
| be2 vs C | 7% | -0.00 | 0.13 | 22% | 10% | 80% |

Stops hit, against the same entry with the 2 ATR stop:

- stop1_5: 53% of trades hit the hard stop. In C those entries averaged -0.51 Re, and 8% ended in profit.
- p2: 39% of trades took the partial. Those trades: 2.40 Re with it, 2.95 Re without.

### dip (diagnostic, equal risk, 2018-07 to 2024-12, 1 seed(s); n is per seed)

| cfg | n | mean Re | 90% CI | median | win | avg loss Re | avg loss % | CVaR5 Re | worst Re | worst % | past -1.25 | Re/yr | bars | stop dist | clamped | reach 1R | give-back % of peak | give-back Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C | 602 | 0.302 | [0.021, 0.619] | -0.31 | 30% | -0.66 | -13.8% | -1.00 | -1.00 | -29% | 0.0% | 28.0 | 21.8 | 20.5% | 21% | 45% | 85% | 2.55 | 1.31% | [-1.92%, 4.91%] |
| be1 | 629 | 0.147 | [-0.069, 0.387] | -0.17 | 43% | -0.73 | -15.4% | -1.00 | -1.00 | -29% | 0.0% | 14.2 | 19.4 | 20.5% | 21% | 43% | 80% | 2.18 | -3.11% | [-5.85%, -0.36%] |
| chOff | 365 | 1.552 | [0.239, 3.153] | -0.46 | 5% | -0.56 | -12.5% | -1.00 | -1.00 | -29% | 0.0% | 87.2 | 93.1 | 21.8% | 25% | 44% | 107% | 11.38 | 11.75% | [-6.65%, 32.81%] |
| ch2 | 742 | 0.030 | [-0.119, 0.190] | -0.24 | 41% | -0.75 | -15.6% | -1.00 | -1.00 | -29% | 0.0% | 3.4 | 13.5 | 20.3% | 19% | 42% | 59% | 1.11 | -2.62% | [-4.24%, -1.05%] |
| t10 | 683 | 0.261 | [0.029, 0.520] | -0.18 | 25% | -0.48 | -10.0% | -1.00 | -1.00 | -29% | 0.0% | 27.4 | 16.9 | 20.4% | 20% | 38% | 84% | 2.53 | -0.56% | [-3.39%, 2.60%] |
| p1 | 602 | 0.155 | [-0.026, 0.347] | -0.13 | 44% | -0.74 | -15.5% | -1.00 | -1.00 | -29% | 0.0% | 14.4 | 21.8 | 20.5% | 21% | 45% | 71% | 2.88 | -4.26% | [-7.69%, -1.25%] |
| bare | 297 | 2.749 | [-0.362, 7.115] | -0.99 | 11% | -0.96 | -22.1% | -1.00 | -1.00 | -29% | 0.0% | 125.6 | 158.9 | 22.0% | 27% | 53% | 124% | 14.14 | 4.39% | [-41.99%, 62.91%] |
| ph_revert | 1007 | -0.001 | [-0.072, 0.072] | -0.04 | 47% | -0.46 | -9.3% | -0.99 | -1.00 | -29% | 0.0% | -0.1 | 5.2 | 20.1% | 18% | 21% | 42% | 0.74 | -0.51% | [-1.16%, 0.10%] |

Robustness (added after seeing the first table, not pre-registered):

| cfg | mean Re | mean without top 1% of trades | top 1% share of gross wins | worst month sum Re | timing vs placebo | CI |
|---|---|---|---|---|---|---|
| C | 0.302 | 0.048 | 33% | -16.5 | 1.31% | [-1.92%, 4.91%] |
| be1 | 0.147 | -0.016 | 29% | -15.9 | -3.11% | [-5.85%, -0.36%] |
| chOff | 1.552 | 0.448 | 53% | -13.9 | 11.75% | [-6.65%, 32.81%] |
| ch2 | 0.030 | -0.023 | 11% | -15.8 | -2.62% | [-4.24%, -1.05%] |
| t10 | 0.261 | 0.065 | 32% | -15.0 | -0.56% | [-3.39%, 2.60%] |
| p1 | 0.155 | 0.023 | 23% | -15.7 | -4.26% | [-7.69%, -1.25%] |
| bare | 2.749 | 1.032 | 48% | -16.7 | 4.39% | [-41.99%, 62.91%] |
| ph_revert | -0.001 | -0.017 | 7% | -12.8 | -0.51% | [-1.16%, 0.10%] |

Exit mix:

- C: trail_stop 39%, hard_stop 36%, time_stop 23%, end_of_sim 2%, delisted 0%
- be1: hard_stop 36%, trail_stop 23%, breakeven_stop 20%, time_stop 19%, end_of_sim 2%, delisted 0%
- chOff: time_stop 55%, hard_stop 39%, end_of_sim 6%, delisted 1%
- ch2: trail_stop 42%, hard_stop 38%, time_stop 19%, end_of_sim 1%, delisted 0%
- t10: time_stop 45%, trail_stop 31%, hard_stop 23%, end_of_sim 1%
- p1: trail_stop 39%, hard_stop 36%, time_stop 23%, end_of_sim 2%, delisted 0%
- bare: hard_stop 86%, end_of_sim 12%, delisted 2%
- ph_revert: time_stop 69%, hard_stop 13%, take_profit 5%, regime_exit 5%, trail_stop 5%, breakeven_stop 1%, end_of_sim 1%

Paired, A minus B, shared entries:

| A vs B | pairs | d mean Re | 90% CI | call | capped at +10 Re | 2018-20 | 2021-22 | 2023-24 |
|---|---|---|---|---|---|---|---|---|
| be1 vs C | 583 | -0.028 | [-0.102, 0.024] | n.s. | -0.009 [-0.051, 0.026] | -0.058 | -0.071 | 0.027 |
| chOff vs C | 360 | 1.341 | [0.100, 2.861] | better | -0.291 [-0.487, -0.106] | 4.695 | -0.740 | 0.271 |
| ch2 vs C | 540 | -0.233 | [-0.468, -0.034] | WORSE | -0.059 [-0.167, 0.045] | -0.780 | -0.020 | -0.062 |
| t10 vs C | 578 | -0.076 | [-0.250, 0.056] | n.s. | -0.006 [-0.085, 0.068] | -0.294 | 0.072 | -0.049 |
| chOff vs bare | 292 | -1.828 | [-5.236, 0.169] | n.s. | 0.016 [-0.201, 0.212] | -5.514 | -0.012 | 0.016 |
| p1 vs C | 602 | -0.147 | [-0.272, -0.041] | WORSE | -0.029 [-0.090, 0.027] | -0.384 | -0.068 | -0.055 |
| C vs bare | 293 | -2.438 | [-6.512, 0.571] | n.s. | 0.413 [0.080, 0.742] | -7.808 | 0.713 | -0.093 |
| ph_revert vs C | 571 | -0.267 | [-0.556, -0.010] | WORSE | -0.104 [-0.299, 0.073] | -0.801 | -0.137 | -0.021 |

Break-even clipping (trades that left on the break-even stop, against the same entry without it):

| cfg vs ref | share of trades on BE stop | their mean Re | same entries in ref | ref ended better | ref ended at +1R or more | ref lost |
|---|---|---|---|---|---|---|
| be1 vs C | 18% | 0.01 | 0.15 | 18% | 9% | 78% |

Stops hit, against the same entry with the 2 ATR stop:

- p1: 45% of trades took the partial. Those trades: 1.28 Re with it, 1.61 Re without.

### Real v6Risk walk-forward (OOS 2020-07 on), fixed configs


#### breakout: 1 run(s), audit clean

| cfg | Sharpe | sd | return | max DD | trades | re-enables |
|---|---|---|---|---|---|---|
| C | 1.09 | 0.00 | 67.8% | 13.2% | 357 | 0.0 |
| stop1_5 | 1.12 | 0.00 | 80.1% | 14.8% | 363 | 0.0 |
| stop3 | 1.26 | 0.00 | 69.8% | 11.8% | 337 | 0.0 |
| be1 | 0.99 | 0.00 | 56.2% | 14.2% | 401 | 0.0 |
| be2 | 1.12 | 0.00 | 70.8% | 13.1% | 357 | 0.0 |
| chOff | 0.50 | 0.00 | 39.3% | 26.5% | 68 | 2.0 |
| ch3 | 1.07 | 0.00 | 61.6% | 11.7% | 453 | 0.0 |
| ch6 | 1.04 | 0.00 | 64.7% | 14.1% | 283 | 0.0 |
| tOff | 1.13 | 0.00 | 72.2% | 12.4% | 336 | 0.0 |
| t40 | 1.12 | 0.00 | 70.5% | 13.2% | 350 | 0.0 |
| p2 | 1.04 | 0.00 | 47.8% | 11.8% | 383 | 0.0 |
| bare | 0.63 | 0.00 | 68.0% | 37.0% | 61 | 2.0 |
| ph_trend | 1.02 | 0.00 | 49.5% | 12.0% | 370 | 0.0 |
| ph_swing | 0.98 | 0.00 | 43.6% | 12.7% | 572 | 0.0 |

Walk-forward picked-config OOS:

- 1d-breakout-1: return 48.1%, Sharpe 0.91, max DD 12.4%, 415 trades, exposure 8.3%, 2x cost 39.2%, last entry 2024-11-15, costs fees 209 slip 336 gaps 115 delist 0; years 2020 23.2% 2021 11.2% 2022 -7.5% 2023 14.4% 2024 2.2%; picks stop1_5 p2 ph_swing stop3 ph_swing ch3 tOff stop1_5 stop3 p2; benchmark Sharpe 0.96

D1-D8 (first run):
```
DEV criteria: NOT QUALIFIED (net of costs; a pass is evidence, never a promise of winning trades)
  D1 PASS  Sharpe 0.91, 90% CI [0.12, 1.64]  (need >= 0.80 and CI low > 0)
  D2 FAIL  0.000  (need >= 0.90)  390 trials
  D3 PASS  12.4%  (need <= 30%)
  D4 PASS  415  (need >= 100 closed trades)
  D5 PASS  39.2%  (need > 0 at 2x costs)
  D6 PASS  worst 0.99 vs chosen 1.26  (need neighbours >= 50%)  2 neighbours of {"cfg":"stop3"}
  D7 PASS  LINKUSDT 19.2%, 2020 48.3%  (need coin <= 35%, year <= 60%)
  D8 PASS  Calmar 0.73 vs 0.72, Sharpe 0.91 vs 0.96  (need better Calmar or Sharpe)
  Simulated re-enables: 0. Regime exits: 0, P&L 0.00.
```

#### dip: 1 run(s), audit clean

| cfg | Sharpe | sd | return | max DD | trades | re-enables |
|---|---|---|---|---|---|---|
| C | 0.62 | 0.00 | 28.7% | 16.8% | 384 | 1.0 |
| be1 | 0.67 | 0.00 | 32.3% | 16.9% | 397 | 1.0 |
| chOff | 0.75 | 0.00 | 70.9% | 34.6% | 109 | 2.0 |
| ch2 | 0.18 | 0.00 | 4.3% | 15.1% | 517 | 0.0 |
| t10 | 0.45 | 0.00 | 16.5% | 14.7% | 462 | 0.0 |
| p1 | 0.09 | 0.00 | 1.8% | 14.3% | 431 | 0.0 |
| bare | 0.82 | 0.00 | 91.2% | 32.4% | 57 | 2.0 |
| ph_revert | 0.21 | 0.00 | 4.1% | 11.9% | 700 | 0.0 |

Walk-forward picked-config OOS:

- 1d-dip-1: return 12.8%, Sharpe 0.34, max DD 19.7%, 344 trades, exposure 7.9%, 2x cost 9.7%, last entry 2024-11-04, costs fees 117 slip 185 gaps 75 delist 0; years 2020 8.1% 2021 15.0% 2022 -9.7% 2023 -0.2% 2024 0.6%; picks t10 t10 bare t10 be1 t10 ph_revert be1 bare chOff; benchmark Sharpe 0.96

D1-D8 (first run):
```
DEV criteria: NOT QUALIFIED (net of costs; a pass is evidence, never a promise of winning trades)
  D1 FAIL  Sharpe 0.34, 90% CI [-0.42, 1.01]  (need >= 0.80 and CI low > 0)
  D2 FAIL  0.000  (need >= 0.90)  390 trials
  D3 PASS  19.7%  (need <= 30%)  from the all-time high, across 1 simulated re-enables
  D4 PASS  344  (need >= 100 closed trades)
  D5 PASS  9.7%  (need > 0 at 2x costs)
  D6 FAIL  worst 0.09 vs chosen 0.45  (need neighbours >= 50%)  2 neighbours of {"cfg":"t10"}
  D7 FAIL  BNBUSDT 49.4%, 2021 127.0%  (need coin <= 35%, year <= 60%)
  D8 FAIL  Calmar 0.14 vs 0.72, Sharpe 0.34 vs 0.96  (need better Calmar or Sharpe)
  Simulated re-enables: 1. Regime exits: 1, P&L -7.48.
```

#### random: 5 run(s), audit clean

| cfg | Sharpe | sd | return | max DD | trades | re-enables |
|---|---|---|---|---|---|---|
| C | 0.56 | 0.16 | 23.4% | 12.9% | 403 | 0.0 |
| stop1 | 0.46 | 0.08 | 22.4% | 17.3% | 417 | 0.4 |
| stop1_5 | 0.49 | 0.15 | 21.6% | 15.4% | 410 | 0.2 |
| stop3 | 0.57 | 0.09 | 20.3% | 12.5% | 398 | 0.0 |
| stop4 | 0.50 | 0.07 | 15.9% | 12.2% | 401 | 0.0 |
| be0_5 | 0.44 | 0.08 | 14.5% | 12.2% | 466 | 0.0 |
| be1 | 0.57 | 0.10 | 23.4% | 13.1% | 424 | 0.0 |
| be2 | 0.58 | 0.15 | 24.7% | 13.0% | 404 | 0.0 |
| chOff | 0.71 | 0.12 | 70.9% | 27.8% | 80 | 1.6 |
| ch2 | 0.28 | 0.17 | 7.4% | 13.0% | 494 | 0.0 |
| ch3 | 0.56 | 0.18 | 22.5% | 12.8% | 454 | 0.0 |
| ch6 | 0.69 | 0.09 | 33.3% | 15.0% | 322 | 0.4 |
| tOff | 0.50 | 0.18 | 21.3% | 15.1% | 374 | 0.2 |
| t10 | 0.62 | 0.17 | 26.5% | 11.7% | 433 | 0.0 |
| t40 | 0.51 | 0.18 | 21.7% | 14.8% | 384 | 0.2 |
| p1 | 0.35 | 0.08 | 10.0% | 12.6% | 433 | 0.0 |
| p2 | 0.45 | 0.08 | 14.6% | 12.6% | 423 | 0.0 |
| bare | 0.66 | 0.12 | 66.0% | 30.1% | 54 | 1.4 |
| bare_be1 | 0.77 | 0.10 | 80.5% | 29.9% | 101 | 2.0 |
| full | 0.48 | 0.15 | 15.7% | 12.7% | 443 | 0.0 |
| ph_trend | 0.64 | 0.14 | 24.4% | 13.2% | 388 | 0.0 |
| ph_swing | 0.32 | 0.20 | 8.6% | 12.9% | 488 | 0.0 |
| ph_revert | -0.06 | 0.25 | -1.3% | 9.9% | 563 | 0.0 |

Walk-forward picked-config OOS:

- 1d-random-1: return 14.5%, Sharpe 0.35, max DD 20.4%, 322 trades, exposure 9.3%, 2x cost 12.7%, last entry 2024-10-28, costs fees 147 slip 260 gaps 93 delist 0; years 2020 1.2% 2021 14.4% 2022 -6.9% 2023 2.7% 2024 3.5%; picks stop1 ch6 bare stop1_5 t40 t10 t10 stop1 bare_be1 ph_trend; benchmark Sharpe 0.96
- 1d-random-2: return 30.0%, Sharpe 0.57, max DD 19.5%, 261 trades, exposure 11.2%, 2x cost 16.0%, last entry 2024-11-06, costs fees 150 slip 267 gaps 109 delist 9; years 2020 5.3% 2021 11.1% 2022 -11.5% 2023 29.7% 2024 -3.2%; picks t10 ch6 bare ch3 ch3 stop1 be0_5 stop1 bare_be1 ch6; benchmark Sharpe 0.96
- 1d-random-3: return 4.5%, Sharpe 0.18, max DD 15.3%, 154 trades, exposure 4.6%, 2x cost 10.3%, last entry 2024-11-19, costs fees 40 slip 79 gaps 49 delist 0; years 2020 3.2% 2021 4.3% 2022 -6.7% 2023 0.5% 2024 3.6%; picks be0_5 ch6 bare bare_be1 chOff stop1 stop1 be0_5 stop3 be0_5; benchmark Sharpe 0.96
- 1d-random-4: return 65.0%, Sharpe 0.86, max DD 15.1%, 360 trades, exposure 7.3%, 2x cost 49.2%, last entry 2024-09-21, costs fees 110 slip 182 gaps 201 delist 0; years 2020 17.8% 2021 30.7% 2022 -6.1% 2023 1.4% 2024 12.7%; picks ch6 stop3 ch6 ch3 ch3 ch3 be0_5 ph_trend chOff ph_trend; benchmark Sharpe 0.96
- 1d-random-5: return 38.1%, Sharpe 0.76, max DD 18.2%, 195 trades, exposure 12.3%, 2x cost 32.5%, last entry 2023-09-13, costs fees 82 slip 151 gaps 38 delist 0; years 2020 17.2% 2021 7.1% 2022 -11.0% 2023 8.6% 2024 13.9%; picks t10 t40 bare_be1 bare_be1 stop1 bare_be1 ch3 tOff ch6 be2; benchmark Sharpe 0.96

D1-D8 (first run):
```
DEV criteria: NOT QUALIFIED (net of costs; a pass is evidence, never a promise of winning trades)
  D1 FAIL  Sharpe 0.35, 90% CI [-0.44, 1.04]  (need >= 0.80 and CI low > 0)
  D2 FAIL  0.000  (need >= 0.90)  390 trials
  D3 PASS  20.4%  (need <= 30%)  from the all-time high, across 1 simulated re-enables
  D4 PASS  322  (need >= 100 closed trades)
  D5 PASS  12.7%  (need > 0 at 2x costs)
  D6 PASS  worst 0.74 vs chosen 0.77  (need neighbours >= 50%)  2 neighbours of {"cfg":"t10"}
  D7 FAIL  XRPUSDT 51.1%, 2021 100.6%  (need coin <= 35%, year <= 60%)
  D8 FAIL  Calmar 0.15 vs 0.72, Sharpe 0.35 vs 0.96  (need better Calmar or Sharpe)
  Simulated re-enables: 1. Regime exits: 0, P&L 0.00.
```
