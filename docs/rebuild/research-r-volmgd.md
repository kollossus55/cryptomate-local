VERDICT: NOTHING QUALIFIES, NOTHING FROZEN. 0 of 3 walk-forwards pass D1-D8: all fail D2 (DSR 0.000) and D8 (no better than the same-universe hold); best run (top10) also fails D7 (SOL 38.3%). Vol scaling did not reliably beat a static equal-risk basket out of sample.

The pre-registration below is unchanged from before the first run, apart from this line and the results at the end.

# r-volmgd: volatility-managed exposure to an equal-risk basket

## Pre-registration (fixed before the first run)

**Hypothesis.** Volatility clusters and is persistent, while future returns are at most weakly related
to recent volatility (Moreira and Muir 2017, "Volatility-Managed Portfolios"). So scaling exposure
inversely to recent realised variance cuts risk in high-volatility spells more than it cuts return,
and raises risk-adjusted return relative to holding the same basket. Economic reason: high-volatility
spells in crypto are leverage unwinds and liquidation cascades, which raise risk sharply without a
matching rise in expected return; investors who must hold through them (or are forced out at the
bottom) are not paid for it. It can survive costs because it is a slow allocator that rebalances only
when the desired size moves by a factor of two, on the most liquid coins.

**What would count as no edge.** Failing any of D1-D8 under real v6Risk sizing. Separately, the
vol-management claim itself fails if the vol-managed basket does not beat the same basket held at
constant equal risk (the `static` control below) on Sharpe.

**Known before running (structural limits, stated so they are not read as findings later).**
- v6Risk caps portfolio vol at the 20% ceiling and open risk at 5%. A crypto basket has roughly
  60-80% annual vol with high cross-correlation, so gross exposure will usually sit around 20-40%,
  never 100%. The 100% gross cap in the brief is therefore never the binding limit.
- v6Core cannot resize an open position. Scaling is done in three ways only: (a) size at entry
  (risk per trade / stop distance, so notional is proportional to scale / coin vol), (b) a rebalance
  exit when the desired stop distance has moved by more than a factor of 2 from the one at entry,
  with re-entry at the new size on the next bar, (c) going fully flat when the scale falls below
  `sMin`. This is a coarse discretisation of the continuous Moreira-Muir weight.
- D2 deflates by the global trial count (385 before this study) and the pooled trial Sharpe spread
  (0.53-1.56 annual). Every earlier non-carry run had DSR at or below 0.14. A pass needs a Sharpe far
  above anything measured so far, so D2 is expected to fail. It is not argued around.
- D7: a single-coin version cannot pass, so only point-in-time baskets are tested.

**Universes.** Point-in-time top N by trailing 30-day median quote volume, >= 200 days of history,
dead coins included (`pointInTimeUniverse`). Primary: `top20`. Secondary: `top10`.

**Rule** (daily bars, decide at the close, fill at the next open, long or flat, no direction signal):
1. Basket return on each of the last 365 days = equal-weight mean of the daily log returns of the coins
   in today's universe that have a bar that day. Short vol `sigS` = annualised stdev of the last
   `volN` basket returns; long-run vol `sigL` = annualised stdev of all 365.
2. Scale `s = min(1, (sigL / sigS)^2)` (variance ratio, as in Moreira-Muir; capped at 1 so no leverage).
3. If `s < sMin`: every held coin gets `flat`, no entries.
4. Otherwise each universe coin not held gets `long` with stop distance
   `d = min(0.25, stopK x dailyVol30(coin) / s)`, so v6Risk's risk-per-trade sizing gives notional
   proportional to `s / vol(coin)`: equal risk across coins, scaled by `s`.
5. A held coin is closed (`flat`) when its current `d` differs from its entry `d` by more than a factor
   of 2 either way (rebalance), or when it leaves the universe. It re-enters next bar at the new size.
6. Exits: hard stop at `d` from entry, plus the signal exits above. No trail, no time stop, no regime
   exit (`SIGNAL_ONLY_EXITS`), so no undeclared filter.

**Risk config** (inside HARD_CEILINGS): riskPerTradePct = 0.05 / N (top20 0.25%, top10 0.5%) so the
open-risk budget spreads across the basket instead of filling with the first few coins;
maxOpenRiskPct 5%, maxPositionPct 20%, maxClusterPct 50%, volTargetAnnual 20%, gross 100%.
Entry order when caps bind: universe volume rank.

**Grid** (coarse, 8 points per walk-forward):
- `volN` in {20, 60} days
- `sMin` in {0, 0.5} (0 = never fully flat, scaling only through size and rebalancing)
- `stopK` in {3, 5}

**Runs (trial budget 50, planned 26):**
- W1 `top20` walk-forward, grid above: 8 trials. Primary.
- W2 `top10` walk-forward, grid above: 8 trials.
- W3 `top20` + the one pre-registered crash filter, grid above: 8 trials. Crash filter: basket
  cumulative log return over the last 30 days below -25% means flat everything and no entries.
- C1, C2 `static` control on top20 and top10: `s` forced to 1 (equal-risk basket, same stops and
  rebalance band), stopK 3: 2 trials. Tests whether vol scaling adds anything.
- Side diagnostics only (not candidates): same-universe rolling hold, and the hold scaled to the
  strategy's average exposure.

**Walk-forward.** From 2018-01-01, train 730 days, test 180 days, so out of sample is 2020-01-01 to
2024-12-31. Parameters picked on train windows only by `walkForward`. D8 uses its built-in benchmark,
the equal-weight buy-and-hold of the universe as it stood on the first out-of-sample day.
`auditLookahead` with `rebuild` on every walk-forward. 1d only.

**Decision rule.** Freeze a candidate (at most 2) only if its walk-forward passes all of D1-D8 with the
audit clean, using the global trial count. If more than one passes, freeze the primary-universe one
first. If none passes, freeze nothing. No retuning after seeing results; no extra grid points.

## Results (DEV, net of costs, real v6Risk sizing, out of sample 2020-01-01 to 2024-12-31)

Trials: 26 of 50, all logged in `data/research/v6/trials-r-volmgd.jsonl` (24 walk-forward grid points,
2 static controls). Global trial count at judging: 468-486 (other agents were logging at the same time).
`auditLookahead` with `rebuild`: clean on all 3 walk-forwards. No run hit the trial budget, no extra grid points
were added, nothing was retuned.

### D1-D8 per walk-forward

| | W1 top20 | W2 top10 (best) | W3 top20 + crash filter |
|---|---|---|---|
| D1 Sharpe, 90% CI | FAIL 0.59 [-0.13, 1.33] | PASS 1.07 [0.33, 1.78] | FAIL 0.72 [-0.09, 1.50] |
| D2 DSR | FAIL 0.000 | FAIL 0.000 | FAIL 0.000 |
| D3 max DD | PASS 22.5% | PASS 18.8% | PASS 24.9% |
| D4 position changes | PASS 1668 | PASS 554 | PASS 2076 |
| D5 return at 2x costs | PASS +41.4% | PASS +99.0% | PASS +51.5% |
| D6 plateau (worst vs chosen) | PASS 0.77 vs 1.34 | PASS 0.79 vs 0.92 | PASS 0.70 vs 1.27 |
| D7 coin / year share | FAIL ADA 30.5%, 2021 68.4% | FAIL SOL 38.3%, 2023 39.2% | PASS ADA 18.0%, 2021 56.6% |
| D8 Calmar / Sharpe vs hold | FAIL 0.32 vs 0.80 / 0.59 vs 1.02 | FAIL 0.91 vs 0.93 / 1.07 vs 1.08 | FAIL 0.37 vs 0.80 / 0.72 vs 1.02 |
| Total return | +41.9% | +119.8% | +55.1% |
| Average exposure | 13.5% | 17.7% | 13.6% |
| Realised vol | 13.3% | 15.9% | 13.5% |
| Closed trades (hard stop / signal) | 834 (359 / 455) | 277 (117 / 152) | 1038 (297 / 721) |
| Simulated re-enables | 1 | 2 | 2 |

Per-year returns: top20 2020 +27.7%, 2021 +22.4%, 2022 -15.0%, 2023 +8.6%, 2024 -1.7%.
top10 2020 +26.7%, 2021 +33.8%, 2022 -13.4%, 2023 +31.9%, 2024 +13.4%.
top20 crash 2020 +22.2%, 2021 +25.5%, 2022 -14.6%, 2023 +18.6%, 2024 -0.2%.

Costs (on 10k starting equity): top20 fees 175, slippage 305; top10 fees 134, slippage 174; top20 crash
fees 222, slippage 331. No stop-gap or delisting costs registered.

Walk-forward picks were unstable: the selected point changed at most fold boundaries (11 folds), mixing
`sMin` 0 and 0.5 and both `volN` values.

### Does vol management add anything? (fixed parameters over the same OOS span)

| | Static equal-risk control | Vol-managed grid range (8 points) | Rolling hold of the list | Hold scaled to strategy exposure |
|---|---|---|---|---|
| top20 Sharpe | 0.78 (DD 31.8%) | 0.77 to 1.34 | 0.88 (DD 81.6%) | 0.88 (DD 16.8%) |
| top10 Sharpe | 0.99 (DD 24.3%) | 0.79 to 1.45 | 1.02 (DD 80.3%) | 1.02 (DD 22.6%) |

The `sMin = 0` points (scaling through size and rebalancing only) sit at the static control (top20 0.82-0.98,
top10 0.81-1.13). The best points in both universes are `volN 20, sMin 0.5, stopK 3` (1.34, 1.45): going flat when
20-day basket variance is more than twice the 365-day variance. That is a single hindsight-best of 8, and the
walk-forward, which had to pick it on earlier data, did not capture it (0.59 and 1.07 out of sample). Simply holding
the same rolling list at the strategy's average exposure gave a Sharpe at least as high in both universes, and a
smaller drawdown on top20.

### Why it fails

- **D2.** With ~480 global trials and the pooled trial Sharpe spread, a DSR of 0.90 needs a Sharpe far above
  anything measured here. Expected and stated before running.
- **D8.** The engine's 20% portfolio-vol ceiling and 5% open-risk budget hold exposure at 13-18%, so this is
  a de-risked basket. Its Sharpe is no better than the hold's, and the hold's Calmar (0.80-0.93) is helped by
  the 2020 start; no run beat it on either measure.
- **Hard stops** closed 30-43% of trades. Stops at 3-5 daily vols on a no-signal allocator act as a
  noise-driven exit and add churn the Moreira-Muir design does not have. The contract requires a stop on
  every entry, so this cannot be removed.
- **D7** on top10: SOL alone gave 38% of profit.

### Caveats

- v6Core cannot resize an open position, so scaling is a discretised approximation (entry size, a factor-2
  rebalance band, and a full-flat threshold). A continuously rebalanced version could behave differently;
  it is not testable through `runSim` as it stands. Not a bug, a design limit.
- The 2020-2024 span holds one full crash cycle; five years of daily data are a small sample for a slow
  allocator (bootstrap CIs span roughly 1.4 Sharpe units).
- The global trial count moved during the runs (468 to 486) because other agents were logging. It cannot
  change any verdict: every DSR printed 0.000.
- No holdout data was read. `FROZEN_CANDIDATES` is empty.
