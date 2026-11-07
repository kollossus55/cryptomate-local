VERDICT: NO EDGE CERTIFIED. The pre-registered ensemble fails D2, D7 and D6 (partial plateau). Nothing frozen. Holdout not touched.

# r-ensemble: equal-risk sleeves of trend, breakout and regime hold

## Pre-registration (written 2026-11-07, before any run)

### Hypothesis and economic reason

Three return streams that each fail the DEV criteria on their own may be partly
independent: time-series trend on BTC/ETH, Donchian breakout on the top 30, and a regime-gated
BTC/ETH hold. Run together on one account at equal risk per position, diversification
might raise Sharpe and spread profit across coins and years, which goes after D2 and D7.
The economic reason is diversification across signals with low correlation, not a new edge.

**Selection bias, declared up front.** All three components were picked after their DEV
walk-forward results were seen (they are among the better Sharpes in
`remeasure/verdicts.jsonl`). The ensemble is therefore NOT a clean test: its DEV result is
biased upward, and that applies to every number below. No component parameter is tuned here.

Known weakness, also declared up front: two of the three sleeves trade BTC and ETH on a
BTC trend condition, and the engine allows one position per symbol. They will overlap a lot,
so diversification comes mainly from the breakout sleeve.

### Exact combination (frozen)

All on 1d bars, through `runSim` (one shared account, `v6Core.step`), in this priority order
(the engine processes entries per strategy in order, and the first sleeve to hold a symbol owns it):

| Sleeve | Code | Registered grid (chosen per fold on train only) | Train risk config |
|---|---|---|---|
| S1 trend | `trendFactory({ rule: 'tsmom', universe: 'btceth' })` from r-trend.mjs | `L: [30, 90, 180, 365]` | r-trend btceth: 1% / 5% / 25% / 50% / vol 0.20 |
| S2 regime hold | `makeStrategy('hold', 'T', p)` from r-regime.mjs | `n: [50, 100, 200]` | r-regime CONFIG (same values) |
| S3 breakout | `breakoutFactory('donchian', '1d')` from r-breakout.mjs | W1: `n: [20, 50, 100], exit: [trend, swing], topN: [20, 30]`, minTrainTrades 20 | `RISK_AT_CEILINGS` |

- Weights: equal risk per position, `sizeMultipliers` 1 / 1 / 1. That is the risk engine's
  own unit: every entry risks the same fraction of equity at its stop. No sleeve weight is
  tuned. Sleeve-level budgets are not exactly equal because of symbol ownership and the shared
  open-risk cap; this is reported, not fixed.
- Combined OOS risk config: the contract default clamped with 1% per trade, 5% open risk,
  25% max position, 50% cluster, vol target 0.20 (the r-trend / r-regime config). Default ladder.
- Each sleeve keeps its own exit overrides and exit profiles.
- Walk-forward: common folds for all sleeves, from 2018-09-01 (the latest start of the three
  families), train 730 days rolling, test 180 days. OOS 2020-08-31 to 2024-12-31. Each sleeve's
  parameters per fold come from `walkForward(..., extras: false)` on its own registered config,
  then one continuous OOS `runSim` holds all three sleeves, each switching parameters at fold
  boundaries (same switcher logic as `walkForward`).
- D5: the same run at 2x costs. D8 benchmark: equal-weight buy-and-hold of the union of the
  sleeves' universes on the first OOS day (top 30, which contains BTC and ETH), full weight,
  as `walkForward` builds it.
- D6: the joint grid is the product of the three sleeve grids. Centre = each sleeve's
  most-picked parameters. Neighbours = every joint combination within one grid step on every
  axis (diagonals included, as `plateauOf` does), each a fixed-parameter run over the OOS span.
  If that is more than 40 runs, only the axis neighbours are run and D6 is reported as
  "partial, cannot pass".
- D2: `checkDevCriteria` with every line in `data/research/v6/trials-*.jsonl` except
  `trials-example.jsonl` (the re-measurement's convention), including this family's own lines.
- Lookahead: `auditLookahead` per sleeve (it takes one strategy) plus the same cut test on the
  combined three-sleeve run, done in this script with the same rule (fills and equity up to
  each cut must match exactly).
- Diagnostics (logged as trials): each sleeve alone on the same folds and config, and the
  correlation of their daily returns.
- Trials planned: 1 ensemble + 3 standalone + 1 centre + at most 40 neighbours. Cap 50.
- Pass rule: all of D1-D8 plus a clean audit. Then, and only then, FROZEN_CANDIDATES is set.
  Holdout is never touched.

## Results

Run order: `picks` (36 s), `main`, `plateau`. 11 trials logged in `data/research/v6/trials-r-ensemble.jsonl`
(1 ensemble, 3 sleeve-alone diagnostics, 1 D6 centre, 6 D6 neighbours). Global trial count at the
final verdict: 450 (other families logged trials while this ran). Audits clean: all three sleeves
with `auditLookahead`, and the combined three-sleeve cut test (3 cuts from 2023-01-01).

Walk-forward picks (train only): trend L=30 in 7 folds, then 365; hold n=100 in 8 of 9;
breakout varies fold to fold (n 20/50/100, both exits, topN 20/30).

### D1-D8, ensemble E1, OOS 2020-08-31 to 2024-12-31, net of costs

| | Result | Need | |
|---|---|---|---|
| D1 | Sharpe 1.19, 90% CI [0.31, 1.94] | >= 0.80, CI low > 0 | PASS |
| D2 | DSR 0.000, 450 trials | >= 0.90 | FAIL |
| D3 | max DD 11.0% | <= 30% | PASS |
| D4 | 216 closed trades | >= 100 | PASS |
| D5 | +72.1% at 2x costs (Sharpe 1.03) | > 0 | PASS |
| D6 | centre 1.33; 6 axis neighbours 1.05-1.28 (all >= 50%) | every neighbour within one step | FAIL by pre-registration: 47 diagonal neighbours exceed the 40-run cap, only 6 axis neighbours run, so D6 is partial and cannot pass |
| D7 | ETHUSDT 47.8% of profit, 2021 44.2% | coin <= 35%, year <= 60% | FAIL |
| D8 | Calmar 1.52 vs 0.37, Sharpe 1.19 vs 0.75 (top-30 equal-weight hold) | better either | PASS |

Total return +95.5%, average exposure 13.6%. Per year: 2020 (from Sep) +6.4%, 2021 +39.6%,
2022 -2.0%, 2023 +23.8%, 2024 +8.5%. Costs: fees 245, slippage 268, stop gaps 83 (on 10,000 start).
Regime exits 32, P&L +36.

### What the sleeves did

| | Sharpe alone | DD alone | Top coin | Top year |
|---|---|---|---|---|
| S1 trend (tsmom BTC/ETH) | 1.21 | 8.1% | BTC 67% | 2023 48% |
| S2 regime hold | 1.40 | 8.5% | ETH 67% | 2021 63% |
| S3 Donchian top 30 | 0.68 | 14.9% | DOGE 22% | 2023 50% |
| Ensemble | 1.19 | 11.0% | ETH 48% | 2021 44% |

P&L by sleeve inside the ensemble: hold 6,550, breakout 2,127, trend 872. Daily return
correlations: trend-hold 0.57, trend-breakout 0.60, hold-breakout 0.44.

### Why it failed

- **The diversification premise did not hold.** Correlations are 0.44 to 0.60, not low, because
  all three sleeves are long crypto only when BTC trends up. The ensemble Sharpe (1.19) is
  below the best sleeve alone (hold, 1.40) and about equal to trend alone.
- **D7:** the year problem is solved (2021 is 44%), but the coin problem is not: ETH is 48% of
  profit. Two sleeves trade BTC/ETH and one position per symbol is allowed, so the majors dominate.
- **D2:** with 450 trials and a pooled annual Sharpe spread of 1.47 (0.59 without r-carry), the
  expected best-of-trials Sharpe is far above 1.19. Even without carry the bar is roughly 1.7.
  The verdict does not depend on how carry is treated.
- **D6:** the joint grid is too large to show a full plateau within the trial budget. The axis
  neighbours that were run are stable (worst 1.05 vs 1.33), which is mildly encouraging but not a pass.

### Caveats

- Selection bias: components were chosen after seeing their DEV results, so D1, D3, D5 and D8
  passing here are biased upward and are weak evidence.
- `auditLookahead` takes one strategy, so the combined audit uses a copy of its cut rule in this
  script (fills and equity must match exactly up to each cut). A multi-strategy option in
  `auditLookahead` would remove that copy. Reported, not worked around in shared code.
- The combined run uses one risk config (the r-trend / r-regime values); the breakout sleeve's
  picks were made under its own `RISK_AT_CEILINGS` config, as registered.
- Global count excludes `trials-example.jsonl`, following the re-measurement.

FROZEN_CANDIDATES: empty.
