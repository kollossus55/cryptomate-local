VERDICT: PENDING (pre-registration written before the first run; results are appended below it).

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
