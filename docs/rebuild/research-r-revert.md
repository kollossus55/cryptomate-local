VERDICT: NO EDGE. Nothing qualified, nothing frozen (FROZEN_CANDIDATES is empty).

# Research r-revert: long-only mean reversion in uptrends

## Pre-registration (written 2026-11-05, before any trial was run)

### Hypothesis and economic reason

Sharp short-term falls inside an established uptrend are partly price pressure rather than news:
forced selling, liquidation cascades and retail panic push price past fair value, and whoever
supplies liquidity is paid for it when the pressure ends. In an uptrend, dip buyers exist, so the
snap-back should be quick. It should survive costs because the targeted move (several percent in
days) is much larger than the 0.26% to 0.70% round trip.

The known danger: this payoff looks like selling insurance. Many small wins, and rare large losses
when a dip is the start of a real fall. So a high win rate is not evidence of edge, and the worst
case gets reported next to every result.

Null hypothesis: after costs, under real sizing and with real stops, these entries earn no more
than chance, and the D1-D8 criteria fail.

### Fixed rules, all experiments

- Spot, long only, `revert` exit profile unmodified. Risk engine: real v6Risk.
- Risk config, one setting for everything: ceilings on riskPerTradePct 1%, maxOpenRiskPct 5%,
  maxPositionPct 25%, volTargetAnnual 20%. All else default, including the ladder and breakers.
- Universe: point-in-time top 20.
- Uptrend filter: close > SMA(trendN), SMA(trendN) above its value trendN/5 bars ago, and BTC close
  above BTC SMA(trendN).
- Stop: 2 ATR(14) from the fill (the profile default), minimum 1%. A coin needing more than 20% is
  skipped, not given a tighter stop.
- Snap-back exit: flat signal when close > SMA(exitMa). exitMa is 5 on 1d, 12 on 4h. Plus the
  profile's partials, trail, time stop and regime exit.
- Walk-forward: from 2018-06-01, 730-day train, 180-day test, rolling, objective Sharpe,
  minTrainTrades 20. OOS runs about 2020-06 to 2024-12.

### Grid (44 trials, plus 6 reserved = 50)

| Exp | TF | Trigger | Grid | Trials |
|---|---|---|---|---|
| E1 | 1d | RSI(rsiLen) < rsiMax | rsiLen {2,4}, rsiMax {10,20}, trendN {100,200} | 8 |
| E2 | 1d | close < SMA(maN) - distAtr x ATR | maN {5,10}, distAtr {1,2}, trendN {100,200} | 8 |
| E3 | 1d | capitulation: fall >= dropAtr x ATR and quote volume >= volMult x 20-bar average | volMult {2,3}, dropAtr {1.5,2.5}, trendN {100,200} | 8 |
| E4 | 4h | RSI | rsiLen {4,8}, rsiMax {15,25}, trendN {600,1200} | 8 |
| E5 | 4h | distance | maN {12,30}, distAtr {1.5,2.5}, trendN {600,1200} | 8 |
| E6 | 4h | capitulation (120-bar volume average), trendN 600 | volMult {2,3}, dropAtr {1.5,2.5} | 4 |

Reserve, 6 robustness trials on the best experiment's most-picked parameters, each on the OOS span
with fixed parameters: stop 1.5 ATR; stop 3 ATR; fixed BTC+ETH universe (the two Tier 1 coins, chosen
by the cost table, not by results); top 50; default risk config; no snap-back signal exit. These are
diagnostics. None can become a candidate.

Frozen candidates come only from E1-E6, must pass all of D1-D8, and use the most-picked parameters.

## Results

50 of 50 trials used and logged in `data/research/v6/trials-r-revert.jsonl`: 44 grid, 6 reserve. No
rule changed after the runs began. `auditLookahead` with `rebuild` was clean on all six experiments.
Global trial count was 220 at the end, and still rising as other agents ran.

All figures are walk-forward OOS, about 2020-06 to 2024-12, net of costs, real v6Risk sizing.

### D1-D8, all six experiments

| | E1 RSI 1d | E2 dist 1d | E3 capit 1d | E4 RSI 4h | E5 dist 4h | E6 capit 4h |
|---|---|---|---|---|---|---|
| D1 Sharpe (90% CI) | -0.28 [-0.78, 0.37] FAIL | 0.09 [-0.47, 0.77] FAIL | 0.00 FAIL | -0.71 [-1.41, 0.08] FAIL | -0.72 [-1.50, 0.10] FAIL | -0.38 [-1.06, 0.30] FAIL |
| D2 DSR | 0.000 FAIL | 0.000 FAIL | 0.000 FAIL | 0.000 FAIL | 0.000 FAIL | 0.000 FAIL |
| D3 max DD | 10.3% pass | 7.3% pass | 0.0% pass | 13.6% pass | 15.0% pass | 8.2% pass |
| D4 trades | 223 pass | 133 pass | 0 FAIL | 259 pass | 312 pass | 137 pass |
| D5 return at 2x costs | -7.7% FAIL | -2.0% FAIL | 0.0% FAIL | -13.8% FAIL | -12.7% FAIL | -10.6% FAIL |
| D6 plateau | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| D7 concentration | no profit FAIL | BTC 176%, 2020 287% FAIL | FAIL | no profit FAIL | no profit FAIL | no profit FAIL |
| D8 vs buy-and-hold | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |

Benchmark: same-universe buy-and-hold, Sharpe 0.94, Calmar about 0.67, max drawdown about 80%. D3 passes
only because exposure is tiny.

### Returns, exposure and costs (start equity 10,000)

| | Total | 2020 | 2021 | 2022 | 2023 | 2024 | Exposure | Fees | Slippage | Stop gap | Delist |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | -5.7% | +2.4% | +1.7% | 0.0% | -6.6% | -3.1% | 2.1% | 238 | 259 | 0 | 0 |
| E2 | +1.2% | +3.4% | +2.8% | 0.0% | -4.6% | -0.3% | 1.6% | 166 | 167 | 0 | 0 |
| E3 | 0.0% | cash | cash | cash | cash | cash | 0% | 0 | 0 | 0 | 0 |
| E4 | -11.2% | -1.6% | +1.4% | -1.0% | -6.5% | -3.9% | 0.8% | 361 | 473 | 4 | 0 |
| E5 | -12.4% | +1.6% | -4.3% | +0.5% | -10.3% | 0.0% | 1.0% | 435 | 632 | 0 | 0 |
| E6 | -5.3% | -0.9% | +0.8% | +0.2% | -0.7% | -4.6% | 0.6% | 324 | 421 | 0 | 0 |

Costs are not the whole story. Adding fees and slippage back, gross P&L is about -70 (E1), +450 (E2),
-280 (E4), -170 (E5) and +215 (E6) on 10,000 over 4.5 years. That is roughly zero before costs, so
cheaper execution would not rescue this.

### Worst case

| | Win rate | Profit factor | Avg win | Avg loss | Worst trade | Worst price loss | Worst bar (equity) | Worst 7 days | Losing streak |
|---|---|---|---|---|---|---|---|---|---|
| E1 | 59.6% | 0.80 | +0.26R | -0.46R | -1.09R | -19.5% SUI | -4.2% 2023-08-17 | -5.6% | 7 |
| E2 | 59.4% | 1.07 | +0.30R | -0.41R | -1.05R | -18.4% SOL | -3.9% 2023-08-17 | -3.9% | 5 |
| E4 | 42.5% | 0.68 | +0.49R | -0.58R | -1.27R | -15.9% XRP | -2.1% 2023-02-09 | -5.1% | 14 |
| E5 | 44.9% | 0.69 | +0.48R | -0.62R | -1.53R | -13.3% XLM | -2.0% 2021-11-16 | -5.3% | 22 |
| E6 | 51.8% | 0.78 | +0.36R | -0.54R | -1.41R | -13.7% EOS | -1.6% 2020-06-11 | -2.4% | 9 |

**The 60% win rate on 1d is the trap this family was expected to show.** Average losses are 1.4 to 1.8
times average wins. In E1, 144 signal exits made +2,068, and 26 hard stops gave back -1,984.

**Stops fire together.** On 2023-08-17, in the fixed-parameter E1 run (RSI(2) < 10, trend 200), 8 positions
hit their hard stops on one day, including BTC, ETH, LINK and XRP, for about -4% of equity. The real
protection there was the 5% open-risk cap, not diversification.

**This table understates the tail.** Crypto trades 24/7, so bars open at the prior close and stop
fills show almost no gap (the Stop gap column is near 0). The simulator fills a touched stop at the stop
price plus 0.10%. In a liquidation cascade the real fill would be worse, and that is exactly when this
strategy holds the most. 1h stop paths are not modelled. Treat the Worst trade column as the
mildest the worst loss could be, not an estimate of it.

### What failed and why

- **No edge on 1d.** RSI and distance dips bounce often but not by enough. The profits were in 2020-21
  and gone by 2023-24, so even the best case (E2) shows decay. 2022 was flat because the trend filter
  kept it out, which is the one part that worked.
- **4h is clearly worse.** Sharpe -0.4 to -0.7, costs larger than any gross gain, and win rates under 52%.
  This agrees with the contract's finding on short timeframes. One limit: the unmodified `revert` time
  stop is 20 hours on 4h bars and was the most common exit, so a slower 4h exit was not tested.
- **Capitulation on 1d (E3) was not really tested out of sample.** No parameter set reached 20 train
  trades in any fold, so walk-forward sat in cash. The condition is simply rare inside an uptrend. Over
  the OOS span the fixed-parameter runs had 0 to 22 trades. The BTC market breaker also blocked 11 of 33
  signals in the widest setting (2 of 10 in the next), so the risk engine removes some of these trades by
  design.
- **Tempting numbers that are not evidence.** E2 with maN 10, distAtr 2 shows fixed-parameter Sharpe 0.84
  to 0.90, and E3 reaches 0.68, on 6 to 15 and 8 trades. They fail D4, were selected as the best of 50, and
  their neighbours are at 0.04 to 0.10 on 157 to 208 trades. Worth noting: deeper dips looked better, but
  there are too few to know. A later study could test this with a wider universe. It was not done here.

### Reserve robustness (E2 center: maN 5, distAtr 1, trendN 100; fixed parameters, not candidates)

| Variant | Sharpe | Return | Max DD | Trades | Win rate | Exposure | Worst bar |
|---|---|---|---|---|---|---|---|
| Stop 1.5 ATR | 0.26 | +5.5% | 6.5% | 135 | 63% | 1.6% | -3.9% |
| Stop 3 ATR | -0.08 | -0.8% | 3.9% | 47 | 51% | 0.6% | -2.5% |
| BTC + ETH only | 0.15 | +1.2% | 1.9% | 34 | 62% | 0.6% | -1.6% |
| Top 50 | 0.21 | +4.0% | 8.1% | 143 | 62% | 1.6% | -4.9% |
| Default risk config | 0.12 | +1.2% | 3.4% | 108 | 57% | 0.8% | -2.0% |
| No snap-back exit | 0.10 | +1.5% | 6.5% | 101 | 55% | 1.7% | -3.9% |

None comes near Sharpe 0.8, so the failure does not depend on stop width, universe, risk setting or
exit choice.

### Disclosures

- A plumbing check ran one 2019 window, printing counts only. It informed no rule.
- `data/tmp/r-revert/diag.mjs` re-ran three logged parameter sets for the signal, breaker and stop-cluster
  counts above. They add no new trials and informed no rule.
- Holdout was not touched. `loadBars` only, DEV range.
- No harness or module bug was found.
