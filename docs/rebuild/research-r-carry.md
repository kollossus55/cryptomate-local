VERDICT: NOT QUALIFIED. Nothing frozen. Paired carry fails D7 in all three universes (2021 is 62-70% of profit) and did not run through v6Core. The crowding overlay fails several criteria in every variant and helps only one of two bases.

> Correction after audit: mom20 flat is 30.5% drawdown in the verdict file, not 16.2%, and fails D3. Carry DSR of 1.000 is overstated; see harness-fixes.md, Corrections after audit.

# r-carry: delta-neutral funding carry and funding as a crowding signal

## Pre-registration (written 2026-11-05 before any result was computed)

### Economic reason

Crypto perps are used by leveraged longs who pay funding to hold exposure. Taking the other side
(short perp, long the same amount of spot) needs capital in two wallets, carries exchange and margin
risk, and cannot be levered freely, so that capital is limited and funding can stay above what a
near-riskless position should earn. The edge should survive costs only when funding is high and
persistent enough to pay about 0.4% (BTC, ETH) to 1.3% (Tier 3) round trip on both legs. It should
also shrink as more capital arrives. The risks are basis blowouts, funding flips and liquidation
of the short leg during spikes.

Crowding hypothesis: very high funding means longs are leveraged and crowded, so forward returns
of long positions are worse, or their drawdowns larger, and cutting long exposure helps other strategies.

### Family A: paired carry

Paired simulator in `scripts/v6/research/r-carry.mjs`. It does NOT run through v6Core, because
v6Core rejects shorts. Long spot, short the same coin quantity of the Binance USDT-M perp. Daily
decisions on closed bars, fills at the next open, both legs.

Signal: annualised sum of funding events in the trailing `lookbackDays`, using only events stamped
before the bar close. Enter when >= `entryApr`, exit when < `entryApr / 2`. Highest funding first.

Grid (27 trials):
- universe: `majors` (fixed BTC, ETH: the two largest and the first perps listed, chosen without
  reference to results), `top10`, `top20` (point-in-time spot top-N, coins with no perp skipped)
- `entryApr`: 10%, 20%, 40%
- `lookbackDays`: 3, 7, 14

Fixed before running, not tuned:
- Basis stop: pair price P&L (excluding funding) <= -3% of entry at a daily close, exit at next open with stop slip.
- Entry gate: |perp/spot - 1| <= 5% (also guards against ticker collisions).
- Margin `marginFrac` 1.0: short collateral equals notional, as v6Paper locks it. Capital split 50/50.
- Isolated margin. Liquidation tested on each day's perp high. Maintenance 1% (Tier 1), 2.5% (Tier 2), 5%
  (Tier 3). Liquidation fee 1.25%. Remaining spot leg then sold at next open at stop slip, unhedged until then.
- Top-up from free cash below half the required margin. If cash is short, the pair exits (`margin_call`).
- Costs from `v6Paper.costFor` on both legs (spot 0.10% and perp 0.05% fee, tier slippage on each leg, stop
  slip on each leg). Actual funding events. 2x stress doubles fees and slippage, not funding.
- Delisting: no bar for 3 days means exit: spot at last close minus 10%, perp at its last close.
- Idle cash earns 0. Sharpe uses a zero risk-free rate, as v6Stats does.

Sizing: real `v6Risk.updateRiskState`, `canEnter`, `riskDirectives`, `sizeEntry`, at the HARD_CEILINGS for risk per
trade 1%, open risk 5%, gross 100%, cluster 50%, vol target 20%. Max position 25% per leg for majors,
10% for top-N (so up to 5 pairs). Stop distance passed is the 3% basis stop. Volatility passed is
the pair's trailing 30-day spread volatility, floored at v6Risk's 10% minimum: this gives the hedge credit, and
a robustness run removes that credit. Correlations are `{}`, so all pairs count as one cluster. Both
legs count towards gross, so total spot notional is at most 50% of equity.

Walk-forward: from 2019-10-01, train 365 days, test 180 days, rolling, objective Sharpe. Same logic as
`walkForward`, re-implemented for the pair simulator. `checkDevCriteria` is used unmodified on a
result of the same shape. A dedicated lookahead audit cuts spot, perp, funding and universe at random dates and
compares fills and equity bit for bit. D8 benchmark: `runSim` equal-weight buy-and-hold of the universe.

D4: closed pair round trips >= 100 for top-N. `majors` is declared a slow allocator (>= 30 position changes).
Known before running: `majors` cannot pass D7, since with two coins one holds at least 50% of profit.

Robustness trials (at most 9, on the most-picked parameters of the best universe): `marginFrac` 0.5,
no hedge credit, always-on BTC/ETH (entryApr 0).

### Family B: funding as a crowding signal (long-only, through real runSim, walkForward, auditLookahead)

Crowding index: mean of BTC and ETH trailing 7-day annualised funding, events before the bar close.
Bases: `btcAboveSma` n=100 and the harness 30-day top-20 momentum, neither re-tuned.
Modes: `block` (no new entries while crowded, held positions stay), `flat` (exit while crowded).
Grid: `crowdApr` 30%, 50%, 80%. 2 bases x 2 modes x 3 = 12 trials, plus 2 no-overlay baselines = 14.
One event study (forward 7d and 30d returns of BTC and ETH by crowding bucket) is logged as one trial line.
Success needs the overlay to beat the same base on Sharpe or drawdown out of sample, across neighbouring
thresholds, as well as D1-D8 to freeze anything.

Trial budget: 27 + 14 + 1 + at most 8 = 50.

## Results

Everything below is DEV only, net of costs. OOS span 2020-09-30 to 2024-12-31. No holdout data was read.
`FROZEN_CANDIDATES` is empty.

**Family A results did not pass through v6Core or runSim.** They come from `runPaired`, a separate simulator
that uses the real v6Risk, `costFor`, v6Stats and `checkDevCriteria`. Even a full D1-D8 pass could not have been
certified as it stands, because the contract requires one code path for backtest and live.

Trials: 45 of 50 (27 carry grid, 3 carry robustness, 14 overlay, 1 event study). The global count was 349-385
when the criteria ran, and other agents may have added more since.

### Family A: walk-forward D1-D8

| | majors | top10 | top20 |
|---|---|---|---|
| D1 Sharpe, 90% CI | PASS 7.66 [6.27, 9.25] | PASS 6.33 [4.72, 7.98] | PASS 6.13 [4.61, 7.69] |
| D2 Deflated Sharpe | PASS 1.000 | PASS 1.000 | PASS 1.000 |
| D3 Max drawdown | PASS 0.2% | PASS 0.4% | PASS 0.8% |
| D4 Trades | PASS 64 position changes (32 pairs) | PASS 136 | PASS 165 |
| D5 Return at 2x costs | PASS 22.7% | PASS 22.5% | PASS 21.1% |
| D6 Worst neighbour vs chosen | PASS 6.25 vs 7.66 | PASS 6.56 vs 6.66 | PASS 4.84 vs 6.27 |
| **D7 Top coin, top year** | **FAIL** ETH 57.7%, 2021 61.7% | **FAIL** XLM 14.5%, 2021 64.1% | **FAIL** BAND 14.4%, 2021 69.8% |
| D8 Calmar, Sharpe vs buy-and-hold | PASS 27.98 vs 0.88, 7.66 vs 1.09 | PASS 14.97 vs 0.77, 6.33 vs 1.02 | PASS 8.93 vs 0.49, 6.13 vs 0.83 |
| Pair lookahead audit | clean | clean | clean |

D7 is a real failure, not one unlucky parameter set. All 18 fixed parameter sets for top10 and top20 have 2021
above 60% of profit (lowest 61.5%). That table is information only, and nothing was picked from it. The
majors universe could never pass D7, as registered beforehand. The criteria are frozen, so a narrow miss is a miss.

| | majors | top10 | top20 |
|---|---|---|---|
| Total return | 27.1% | 30.4% | 32.2% |
| CAGR | 5.8% | 6.4% | 6.8% |
| 2020 (from Sep 30) | 2.4% | 2.7% | 2.3% |
| 2021 | 16.3% | 19.0% | 22.0% |
| 2022 | -0.0% | 0.1% | -0.3% |
| 2023 | 2.0% | 1.7% | 1.5% |
| 2024 | 4.6% | 4.9% | 4.7% |
| Worst drawdown | 0.2% | 0.4% | 0.8% |
| Average spot exposure (both legs: double) | 25.2% | 21.2% | 22.1% |
| Days with a pair open | 58% | 54% | 57% |
| Closed pairs, average days held | 32, 51 | 136, 49 | 165, 43 |

Cost and P&L breakdown on 100,000 starting equity:

| | majors | top10 | top20 |
|---|---|---|---|
| Funding, net | 31,043 | 35,404 | 40,517 |
| of which paid out | 280 | 983 | 1,098 |
| Fees, both legs | 2,816 | 2,873 | 3,264 |
| Slippage, both legs | 1,127 | 3,573 | 5,423 |
| Stop slip | 0 | 12 | 0 |
| Delisting haircut | 0 | 0 | 0 |
| Liquidation fees | 0 | 136 | 1 |
| Basis P&L (includes slippage) | -1,114 | -2,126 | -5,058 |
| Liquidations / margin-call exits / basis stops | 0 / 16 / 0 | 1 / 46 / 0 | 1 / 58 / 0 |

57 days were blocked for new entries by v6Risk, the same count in each universe.

Grid, fixed parameters over the OOS span (Sharpe / return / closed pairs):

| entryApr / lookback | majors | top10 | top20 |
|---|---|---|---|
| 10% / 3 | 6.79 / 25.4% / 61 | 2.10 / 18.5% / 335 | 2.58 / 16.8% / 513 |
| 10% / 7 | 7.32 / 26.4% / 41 | 6.59 / 29.3% / 201 | 4.84 / 28.0% / 290 |
| 10% / 14 | 7.66 / 26.9% / 31 | 6.66 / 32.2% / 137 | 5.97 / 30.6% / 226 |
| 20% / 3 | 6.99 / 24.6% / 22 | 6.81 / 28.0% / 130 | 5.78 / 27.8% / 175 |
| 20% / 7 | 6.76 / 21.9% / 20 | 6.75 / 28.3% / 107 | 5.05 / 27.0% / 144 |
| 20% / 14 | 6.25 / 22.8% / 16 | 6.56 / 31.0% / 79 | 6.27 / 32.4% / 103 |
| 40% / 3 | 4.81 / 14.4% / 29 | 4.41 / 19.1% / 138 | 3.86 / 19.3% / 182 |
| 40% / 7 | 4.71 / 15.2% / 20 | 4.85 / 19.6% / 97 | 4.89 / 24.2% / 112 |
| 40% / 14 | 4.33 / 13.7% / 12 | 5.34 / 22.8% / 71 | 5.08 / 23.5% / 74 |

### How much to believe the numbers

The funding income is real in this data, but the Sharpe figures overstate the case. Do not quote them unqualified.
These checks used fixed parameters (`scripts/v6/research/r-carry.mjs diag`), which adds no trials.

- **Sharpe is inflated by serial correlation.** Funding is persistent, so daily returns have lag-1 autocorrelation of
  0.47-0.65. Scaling by sqrt(365) assumes none. On monthly returns Sharpe is 1.7-2.0, not 6-8. D1 and D2 use daily
  returns, so their CIs and the 1.000 are too flattering. D1 would likely still pass.
- **Sharpe uses a zero cash rate.** Against a flat 4% it is 2.2-2.6 on daily returns. 2022 and 2023 returned about
  0-2%, likely below what cash earned in those years, so in those two years the trade was not worth its risk.
- **The edge is one regime.** 2021 is 62-70% of profit and 2022 is about zero. The strategy depends on bull-market
  leverage demand.
- **The funding signal adds nothing over simply holding on majors.** Always-on BTC/ETH made 30.4%, Sharpe 8.58, against
  26.9% and 7.66 for the best timed majors setting. It has only 11 trades, so it fails D4, and with two coins it fails D7
  on coin share. Raising the threshold only reduced return, because the book then sat in cash.
- **The drawdown is not the risk.** 0.2-0.8% measures only what happened on one exchange in this sample. See "Not modelled".
- **Trade counts are padded.** Cash-limited leftovers make small pairs. At fixed parameters only 102 of 137 (top10)
  and 77 of 103 (top20) pairs were at least 1% of equity. I did not measure this on the walk-forward runs, so top20's
  D4 pass is weaker than it looks.
- **Margin-call exits are a design cost.** With all capital deployed, a +50% move forces an exit rather than a move of
  value from spot to margin. In the fixed majors run those exits carried 1,554 in fees.

Checks that passed: funding on the largest trade in each run matches a separate recomputation from the store to the
cent. Trade P&L sums to equity change. All 16 self tests pass, including conservation at flat prices, staying
hedged through a +-40% wave, and the audit catching a planted 5-day leak on 4 of 6 cuts.

### Family A: robustness (top10, 10% / 14 days, fixed parameters)

| Variant | Return | Sharpe | Max DD | Liquidations |
|---|---|---|---|---|
| Base | 32.2% | 6.66 | 0.6% | 1 |
| `marginFrac` 0.5 | 28.6% | 2.48 | 2.8% | 16 |
| No hedge credit (spot volatility into v6Risk) | 24.1% | 6.55 | 0.6% | 0 |
| Always-on BTC/ETH | 30.4% | 8.58 | 0.1% | 0 |

Halving the margin does not raise return, because gross exposure already caps the book. It adds 15 liquidations and
cuts Sharpe by more than half. Use full collateral. The hedge credit is not what drives the result.

### Family B: funding as a crowding signal

Ran through real `runSim`, `walkForward` and `auditLookahead` with `rebuild`. All four audits are clean.

| Base | Run | Return | Sharpe | Calmar | Max DD | Trades | Exposure | Fails |
|---|---|---|---|---|---|---|---|---|
| btc100 | no overlay | 22.4% | 1.07 | 0.84 | 5.8% | 28 | 3.6% | not assessed |
| btc100 | block | 22.4% | 1.07 | 0.84 | 5.8% | 28 | 3.6% | D2, D4, D7, D8 |
| btc100 | flat | 16.9% | 1.43 | 1.34 | 2.8% | 35 | 3.3% | D2, D4, D7 |
| mom20 | no overlay | 47.0% | 0.78 | 0.60 | 15.8% | 322 | 5.2% | not assessed |
| mom20 | block | 19.7% | 0.45 | 0.27 | 15.8% | 282 | 4.6% | D1, D2, D7, D8 |
| mom20 | flat | 27.1% | 0.63 | 0.36 | 16.2% | 284 | 4.1% | D1, D2, D7, D8 |

Overlay rows are walk-forward. Baselines are fixed-rule runs over the same span.

No usable edge. `block` on btc100 changed nothing at any threshold. `flat` improved btc100's ratios and halved its
drawdown, at the cost of a quarter of its return, but mom20 was worse in both modes. One base out of two, on 35 trades
of a single coin, is not evidence. Do not add this overlay to other strategies.

The event study explains why. High funding goes with more risk, not lower return. From the lowest bucket to the
highest (index >= 80%), the mean worst 30-day dip goes from -10.8% to -24.5% for BTC and -14.2% to -27.8% for ETH. Mean
forward returns show no clean pattern: 30-day BTC 5.9% against 1.9%, ETH 5.2% against 13.7%. The top bucket has only
56 days, overlapping and from few episodes, so this is suggestive only. Funding as a volatility input was not tested here.

### Assumptions and limits

Modelled: fees and slippage on both legs at entry and exit, real funding events, daily basis moves between legs, isolated
margin with daily top-up, liquidation on the daily perp high, unhedged spot after liquidation, delisting.

Sizing disclosure: v6Risk has no pair concept, so the real `sizeEntry` was fed a stand-in. The spot leg is the
position, the 3% basis stop is the stop, and spread volatility is the volatility, with both legs' costs. Gross was then
capped by counting both legs. This is the closest honest mapping, not v6Risk sizing a short. Measured at entry value, total
spot peaked at 50.2% (100.4% counting both legs) and a pair at 10.1%, slightly over the caps because sizing
uses the decision close and equity then moves.

Not modelled, and these are the tail risks of this trade: exchange failure or withdrawal freezes (both legs sit
on one venue), USDT depegging, auto-deleveraging of the short, delays moving collateral between wallets (top-up is
instant here), legging risk between the two fills, size-based margin tiers, and 1h liquidation paths. The maintenance
rates and the 1.25% liquidation fee are assumptions, not Binance's schedule.

Data caveats: `docs/rebuild/data-derivs.md` did not exist when this ran, so perp and funding data have no quality report
behind them. I confirmed that DEV funding and perp bars load for BTC, ETH, SOL and 1000PEPE, and that the holdout lock
refuses a later range. Most funding events have no stored mark (4,536 of 5,819 for BTC), so those use the day's perp open.
The pair audit covers each universe's most-picked fixed parameters, not the walk-forward's parameter schedule. D4 for
majors uses the slow-allocator rule, declared beforehand.

One self-test scenario was changed after it failed: it decided with under 20 days of spread history, so
the simulator correctly fell back to 100% volatility and sized to 20%. The scenario now starts after 30 days. The
simulator was not changed.

### What running the pair on paper would need

None of this exists today, and all of it is outside this agent's owned files.

1. **v6Core:** a paired position with one intent for two legs, entered and exited together, and a defined response when one leg fails.
2. **v6Risk:** a hedged sizing path with a funding term, replacing the stand-in above. It rejects shorts today.
3. **v6Paper:** `applyFunding` exists and full collateral matches `marginFrac` 1, but it has no liquidation or margin top-up.
4. **v6Exchanges:** no funding feed exists. It needs live public funding rates.
5. **v6Exits:** a basis stop and a funding-faded exit. Price stops on one leg do not fit a pair.
6. **v6SignalGate:** the liquidity test on both books, and funding and basis in the data and replay checks.
7. **Research:** rerun this through `runSim` once built, then apply D1-D8 again. Results here do not carry over.

Paper-only stays in force.
