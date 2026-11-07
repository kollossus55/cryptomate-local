VERDICT: NOT QUALIFIED. The low-volatility walk-forward failed D1, D2, D6, D7 and D8 on DEV. FROZEN_CANDIDATES is empty, and no holdout data was read.

# Research r-lowvol: cross-sectional low volatility / low beta

No result here implies that any strategy would win. A clear "this did not qualify" is the outcome.

## Summary

| | |
|---|---|
| Trials | 43 of 50, all logged: 1 smoke test, 32 stage 1, 10 stage 2. Global count at D2 time: 419 (example file excluded) |
| OOS span | 2020-12-31 to 2024-12-31, 9 folds of 180 days, 730-day rolling train |
| Walk-forward total return | +7.0%, CAGR 1.7% (2x costs: +7.4%) |
| Sharpe | 0.26, 90% CI [-0.56, 1.13] |
| Worst drawdown | 11.9% |
| Average exposure | 11.2% of equity |
| Closed trades / position changes | 89 / 178. Win rate 46%, profit factor 1.24 |
| Lookahead audit | Clean with `rebuild`, 4 cuts, on the most-picked parameters |

## D1-D8 (walk-forward, the only figures that count)

| Criterion | Result | Value | Needed |
|---|---|---|---|
| D1 | FAIL | Sharpe 0.26, CI [-0.56, 1.13] | >= 0.80, CI low > 0 |
| D2 | FAIL | DSR 0.000 at 419 global trials | >= 0.90 |
| D3 | PASS | 11.9% | <= 30% |
| D4 | PASS | 178 position changes (slow allocator, declared in advance). 89 closed trades | >= 30 |
| D5 | PASS | +7.4% at 2x costs | > 0 |
| D6 | FAIL | Worst neighbour -0.23 vs chosen 0.94 (31 neighbours of vol L30 K5 rebal7 gate200) | >= 50% |
| D7 | FAIL | XRP 72.3% of profit; 2023 131.8% | coin <= 35%, year <= 60% |
| D8 | FAIL | Calmar 0.14 vs 0.31; Sharpe 0.26 vs 0.70 | Better Calmar or Sharpe |

At 2x costs the return is slightly higher than at 1x (+7.4% vs +7.0%). That is path dependence in sizing and fills, not a cost benefit. Costs are small here.

## Per-year returns

| Run | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|
| Walk-forward | -2.6% | -4.7% | +9.9% | +4.9% |
| Most-picked fixed set, vol L30 K5 rebal7 gate200 (not a pass figure) | +11.5% | 0.0% | +9.6% | +12.7% |
| Top-30 equal-weight buy-and-hold, full weight | +240.8% | -70.9% | +58.5% | +63.3% |

## Costs and turnover (walk-forward, $10,000 start)

Fees $73, slippage $107, stop gaps $0, delisting $0, total $180. Turnover was 1.9x equity a year. By traded value, tier 1 was 29%, tier 2 33% and tier 3 38%. Exits: 54 signal, 32 hard stop, 3 end of run. The most-traded names were TRX, BTC, ETH, BNB, XRP and LTC.

## What failed and why

1. **Fold choices did not carry forward.** Train windows picked 6 different parameter sets in 9 folds. The first three folds (2021 to mid-2022) picked ungated sets (gateN 0), so the run held low-vol coins into the 2022 bear and lost 4.7% that year. The 2023 H2 fold picked a monthly beta set with a train Sharpe of 0.42. Most of the gap between the fixed sets (31 of 32 positive, mean Sharpe 0.74) and the walk-forward (0.26) comes from these switches.
2. **The fixed-set figures are not clean evidence.** The best fixed set, vol L90 K3 rebal7 gate0, reached Sharpe 1.33, but that is the maximum of 32 runs over the span being reported. With 419 global trials no Sharpe near 1 would pass D2. Harness-fixes measured every non-carry DSR at or below 0.14.
3. **Profit is concentrated.** The walk-forward profit came from 2023 and from XRP. The years before and after were near flat or negative.
4. **Exposure is small.** Real v6Risk sizing with 3 ATR stops held about 11% of equity on average, so even a real effect gives a CAGR of about 2%. That cannot beat a full-weight benchmark on Calmar unless drawdown is tiny.

## What looked real (diagnosis only, cannot certify anything)

- **Quintile spread.** Weekly forward return by trailing 30-day volatility quintile, top 30, 2021-2024, ungated, with the delisting haircut: low vol 1.71%, Q2 1.25%, Q3 0.82%, Q4 1.53%, high vol 0.19% a week. Low minus high was 1.52%, t 1.74, n 205. Mean/sd was 0.14 for low vol against 0.01 for high vol. 2022 carries most of the significance (t 2.91). The other years have t 0.29 to 1.25. Most of the spread is the high-vol leg doing badly, which long-only cannot harvest. This fits the BAB literature.
- **Stage 2 controls.** Around the most-picked set, which was rerun fixed on the OOS span: low vol 0.95, the high-vol leg -0.13, the volume rank 0.59, BTC+ETH only 0.48. Robustness variants: top 20 1.12, top 50 0.92, stop 2 ATR 0.85, stop 5 ATR 1.22, rebal 14 0.98, no buffer 0.72, trend exits 0.69. The pre-registered control test is met for this fixed set. The walk-forward fails, so stage 2 cannot create a candidate.
- Across the 32 fixed trials, vol (mean Sharpe 0.86) beat beta (0.61), and weekly rebalancing (1.00) beat monthly (0.48).

A future test could fix gateN at 200 and metric at vol, with no grid choice for either. It would be shaped by this DEV result, so its DEV evidence would not be independent. Only the holdout could judge it, and the holdout was not touched here.

## Deviations and disclosures

- **Smoke test.** Before stage 1, I ran the default parameters on 2023 alone to check the mechanics: Sharpe 2.03, 17 trades. I logged it as a trial, with `span: "2023-only"`. It did not change the grid or the rule, which were already written.
- The pre-registration said OOS starts 2021-01-01. `walkForward` starts it at 2020-12-31, the same leap-year effect r-xsmom saw. Stage 2 runs start 2021-01-01.
- Seven trials of the budget are unused. I ran no post-hoc trials.
- No shared file was edited. No harness bug was found. Simulated re-enables were 0, so the ladder freeze fix did not come into play.
- Earlier research looked at the 2025-26 period, which carries the usual caveat. This family is new and its holdout is clean.

## Pre-registration (written before any run, 2026-11-07)

**Hypothesis.** Among the point-in-time most liquid coins, the names with the lowest trailing realised
volatility (or lowest beta to BTC) earn a better return per unit of risk than the high-volatility names and
than an equal-weight basket of the same universe. Holding the K lowest-risk names, rebalanced on a fixed
calendar, optionally only while BTC is above its 200-day average, should beat the same-universe buy-and-hold
on Sharpe or Calmar, net of costs, under real v6Risk sizing.

**Economic reason.** Leverage-constrained investors who want more exposure buy high-beta coins instead of
borrowing, and lottery-seeking retail buyers overpay for coins with large right tails. Both bid up
high-volatility names and leave the low-volatility end under-priced per unit of risk (Frazzini-Pedersen
"betting against beta"; Bali-Cakici-Whitelaw "MAX" effect). In crypto both forces are, if anything, stronger.

**Why it might survive costs.** Volatility ranks are persistent, so turnover should be low; low-volatility
names are mostly large and Tier 1-2, so slippage is lower than in xsmom (Tier 3 0.25% a side); weekly or
monthly rebalancing with a 2K rank buffer.

**Why it might fail.** (1) The long-only version cannot short the high-beta leg, which is where most of the
equity BAB premium sits. (2) "Lowest vol in the top 30" may simply be "hold BTC and ETH", which is a market
bet, not an anomaly; the majors control tests this. (3) Low-volatility coins still fall 70%+ in a crypto bear,
so without the BTC gate drawdown may fail D3. (4) v6Risk sizes by stop distance and vol target, so exposure
may stay small. (5) A falling, dying coin can look low-volatility once trading dries up; the 10% delisting
haircut and the point-in-time universe (dead coins included) keep this in the test.

**How this differs from r-xsmom.** xsmom ranked on the trailing RETURN (first moment, raw or vol-adjusted)
and bought the winners. This ranks on the SECOND moment (realised vol) or on co-movement with BTC (beta), and
ignores past return entirely. The held names are different (stable large caps, not recent pumps), the
expected holding period is longer (vol ranks persist, momentum ranks do not), and the equity literature finds
the two effects close to uncorrelated. xsmom's `radj` metric divided return by vol but still chose the
highest return per unit of vol; it never bought low-vol names for being low-vol. I use the same harness
settings as xsmom so the two can be compared, and I do not reuse any of its parameter choices.

**Rule.** Universe: point-in-time top `topN` = 30 by trailing 30-day median quote volume (v6Bars, dead coins
included). Every `rebal` days (day index mod `rebal`), rank the universe ascending by `metric` over `L` days:
- `vol`: annualised realised volatility of daily log returns (`realisedVol`, L bars).
- `beta`: OLS beta of the coin's daily log returns on BTC's over the last L days, matched by bar time,
  at least 80% of L pairs required. BTC's beta is 1.

Buy the K lowest. Keep a holding while its rank is better than 2K; close it when it falls past 2K or leaves
the universe. If `gateN` > 0 and BTC closes at or below its `gateN`-day SMA, close everything on any day and
buy nothing. Stop = 3 x ATR14, clamped to 8%-30%. Exits: `SIGNAL_ONLY_EXITS` (rank, gate, universe exits,
plus the hard stop that every position carries). No trail, time stop or regime exit, because this is a
holding strategy and the gate is the declared regime filter.

**D4.** The strategy is declared `slowAllocator: true`, so D4 counts position changes (>= 30). It is a
calendar rebalancer of a ranked basket, not a trade-signal strategy. Closed trades are reported as well.

**Stage 1 grid (32 trials), walk-forward.** `metric` {vol, beta} x `L` {30, 90} x `K` {3, 5} x `rebal`
{7, 28} x `gateN` {0, 200}.

**Stage 2 (10 trials, fixed parameters on the OOS span, robustness only).** One change at a time from the
stage 1 most-picked parameters: topN 20, topN 50, stop 2 ATR, stop 5 ATR, rebal 14, no rank buffer, default
`trend` exit profile instead of signal-only, and three controls:
- `highvol`: the same rule holding the K HIGHEST-ranked names (the leg BAB says is overpriced);
- `volume`: hold the K highest-volume names (rank ignores risk);
- `majors`: hold BTC and ETH only, same gate and exits.

Stage 2 can never create or change a candidate; it can only count against one.

**Decision rule.** A candidate is frozen only if the stage 1 walk-forward passes all of D1-D8 via
`checkDevCriteria` with the GLOBAL trial count (all `trials-*.jsonl` except the example file), with
`auditLookahead` (rebuild) clean, AND in stage 2 the low-risk rule beats all three controls on Sharpe.
Otherwise nothing is frozen and the verdict is NOT QUALIFIED.

**Evaluation.** walkForward from 2019-01-01, rolling 730-day train, 180-day test, train objective Sharpe,
at least 10 closed train trades (monthly rebalancing makes few trades). OOS 2021-01-01 to 2024-12-31. DEV only.

**Risk config.** Real v6Risk at the ceilings, identical to r-xsmom: 1% per trade, 5% open risk, 20% vol target,
50% cluster, 30% widest stop, ladder 7.5/12.5/17.5/20, daily 3%, weekly 6%, simReEnable default (30 days).
Costs: contract tiers via `tierFor`, stops +0.10% and gap-aware, delisting -10%.

**Diagnostic (not a trial).** Weekly forward return by trailing 30-day vol quintile, 2021-2024, top 30,
ungated, delisting haircut included. Used only to describe, never to pick parameters.

**Budget.** 42 planned, 50 maximum.
