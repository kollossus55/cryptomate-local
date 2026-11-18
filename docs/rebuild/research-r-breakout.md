# Research: breakouts (agent r-breakout)

> Correction after audit: some walk-forward figures predate the harness fix, e.g. W2 shows 0.40 where the verdict file shows 0.81. Use data/research/v6/remeasure/verdicts.jsonl.

VERDICT: NO EDGE QUALIFIED, NOTHING FROZEN. The best rule (Donchian 1d) fails D2 and D7: its profit is almost all 2020-2021, and within a month a breakout does no better than the average universe coin.

## Pre-registration (written before the first run)

**Economic reason.** Crypto has no fundamental anchor, attention is the marginal buyer, and a new high
is the cheapest attention signal there is. Holders who sold lower anchor on old highs, so supply above a
long range is thin. If the crowd under-reacts and then chases, a fresh n-bar high should be followed by
above-normal drift, with a positively skewed payoff: many small stops, few huge winners. It could survive
costs because a trend hold pays the round trip once over weeks, not daily. The reason it might not: a
new high is public and free, the same crowd sells the first pullback, and the universe of top-volume coins
is exactly the most watched one.

**Hypotheses.**
- H1: a fresh n-bar closing breakout, in a risk-on market, beats the same-universe unconditional forward
  return, net of round-trip costs.
- H2: prior volatility contraction lowers the false-breakout rate and raises expectancy.
- H3: a volume surge on the breakout bar does the same.
- H4: most profit comes from a few trades. Measured, not assumed; if true it is a fragility to report.

**Common rules, fixed for every trial.**
- Fresh breakout only: close > highest high of prior n bars, and the previous close was not. One pulse,
  no chasing. Fill at next open (simulator).
- Regime: BTC close > BTC 200-DAY SMA (1200 bars on 4h). Ablated once, see reserve.
- Universe: `{kind:'top', n:30}` point in time, best first. `topN` 20 keeps the first 20 of it.
- Stop: 3 ATR(14) for `trend`, 2 ATR(14) for `swing` (the profile defaults), capped at 25%.
- Exits: the unmodified `trend` and `swing` profiles. No extra signal exit.
- Score: breakout size in ATRs / 3, clipped to 0..1. Ranking only.
- Risk, one config for all trials, at HARD_CEILINGS: 1% per trade, 5% open risk, 25% position, 20% vol
  target, 50% cluster, ladder 7.5/12.5/17.5/20, daily 3%, weekly 6%. The rest default.
- Walk-forward: from 2018-03-01, rolling 730d train, 180d test, objective Sharpe, minTrainTrades 20.
  OOS therefore runs 2020-02-29 to 2024-12-31.

**Grid (42 trials + reserve of at most 8 = 50 max).**

| Run | Family | TF | Grid | Trials |
|---|---|---|---|---|
| W1 | Donchian | 1d | n 20/50/100, exit trend/swing, topN 20/30 | 12 |
| W2 | Donchian | 4h | n 50/100/200, exit trend/swing, topN 30 | 6 |
| W3 | Vol contraction | 1d | n 20/50, squeeze 0.6/0.8, exit trend/swing, topN 30 | 8 |
| W4 | Vol contraction | 4h | n 50/100, squeeze 0.7, exit trend/swing, topN 30 | 4 |
| W5 | Volume confirmed | 1d | n 20/50, volMult 1.5/2, exit trend/swing, topN 30 | 8 |
| W6 | Volume confirmed | 4h | n 50/100, volMult 2, exit trend/swing, topN 30 | 4 |

Squeeze: realised vol(10)/realised vol(100) on the bars BEFORE the breakout is below the value (20/200
on 4h). volMult: breakout bar quote volume / 20-bar mean quote volume before it is at least the value.

Reserve: regime off on the best 1d and 4h rule (2), default risk config on the best rule (1 or 2), at most
4 more, each declared here with its reason before it runs. Everything is logged.

**Measurements.**
- False breakout (signal level, before sizing): any close back below the breakout level within 5 days
  (5 bars on 1d, 30 on 4h), next open as entry.
- Forward return at 5/10/20 days from the next open, net of tier round-trip cost, against the same-universe
  same-regime baseline of all coin-bars; t-stat on monthly mean excess.
- Winners: share of net profit from the top 1/5/10 trades, share of gross profit from the top 10% of
  trades, and net profit without the top 5 and top 10.

**Reserve declared after W1-W5, before running them (8 trials, total 50).** The event study showed the
breakout entry has about zero excess over the same month's baseline while the portfolio Sharpe is high, so
the question became whether the entry contributes anything at all.
- A1, A2: regime off on the W1 centre (Donchian 1d n50 swing top 30) and the W4 centre (squeeze 4h n100 trend).
- A3: W1 centre under the default risk config.
- P1-P5: random-entry control. Same universe, regime, stop, exits and sizing as the W1 centre; each risk-on
  coin-bar enters with probability 0.04 (about the breakout event rate), five seeds. If these match the
  breakout Sharpe, the entry adds nothing and the result comes from regime plus exits.

## Results

50 of 50 trials used and logged in `data/research/v6/trials-r-breakout.jsonl` (42 grid, 8 reserve). All
figures are DEV, net of costs, under real v6Risk sizing at HARD_CEILINGS, walk-forward OOS 2020-02-29 to
2024-12-31, unless marked otherwise. `auditLookahead` with `rebuild` was clean on all six runs, on each
run's plateau centre, 3 cuts from 2021.

| Run | Rule | OOS Sharpe | 90% CI | Return | Max DD | Trades | Exposure | Fails |
|---|---|---|---|---|---|---|---|---|
| W1 | Donchian 1d | 1.16 | 0.30 to 1.95 | 92.3% | 17.0% | 302 | 7.5% | D2, D7 |
| W2 | Donchian 4h | 0.40 | -0.25 to 1.09 | 19.8% | 18.0% | 821 | 5.5% | D1, D2, D6, D7, D8 |
| W3 | Squeeze 1d | 0.65 | -0.01 to 1.27 | 32.5% | 13.1% | 173 | 6.8% | D1, D2, D6, D8 |
| W4 | Squeeze 4h | 0.69 | -0.08 to 1.38 | 39.8% | 13.6% | 357 | 4.1% | D1, D2, D6, D7, D8 |
| W5 | Volume 1d | 0.89 | 0.12 to 1.62 | 66.0% | 15.7% | 337 | 7.4% | D2 |
| W6 | Volume 4h | 0.32 | -0.39 to 1.05 | 15.0% | 18.0% | 561 | 5.1% | D1, D2, D6, D7, D8 |

Same-universe buy and hold at full weight: 1d +617.5%, Sharpe 0.92, drawdown 78.0%; 4h +601.5%, Sharpe 0.90,
drawdown 79.4%.

### D1-D8 for the two closest rules

No candidate is frozen, so these are shown for the record. D2 is at 329 global trials, from reruns of the
identical W1 and W5 grids at the end (no new trials: the log stayed at 50). The 329 leaves out
`trials-example.jsonl`, which the harness example would count. Other agents may still add trials.

| | W1 Donchian 1d | W5 Volume 1d | Need |
|---|---|---|---|
| D1 | PASS 1.16, CI [0.30, 1.95] | PASS 0.89, CI [0.12, 1.62] | >= 0.80, CI low > 0 |
| D2 | **FAIL 0.179** | **FAIL 0.069** | >= 0.90 |
| D3 | PASS 17.0% | PASS 15.7% | <= 30% |
| D4 | PASS 302 | PASS 337 | >= 100 |
| D5 | PASS +85.3% | PASS +46.3% | > 0 at 2x costs |
| D6 | PASS worst 0.64 vs 1.12 | PASS worst 0.62 vs 1.17 | neighbours >= 50% |
| D7 | **FAIL** BNB 25.2%, 2021 68.7% | PASS BTC 18.2%, 2020 54.6% | coin <= 35%, year <= 60% |
| D8 | PASS Calmar 0.85 vs 0.64, Sharpe 1.16 vs 0.92 | PASS Calmar 0.70 vs 0.64, Sharpe 0.89 vs 0.92 | better Calmar or Sharpe |

W1's D2 read 0.969 when it first ran with only 12 trials logged. That number came from running first and must
not be quoted. W5's D8 passes on Calmar only, which is easy for a book at 7% exposure against a fully invested
benchmark.

### Per-year return (compounded, walk-forward)

| Run | 2020 (from Mar) | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|
| W1 | 36.1% | 46.6% | -0.7% | -0.6% | -2.4% |
| W2 | 24.6% | 7.1% | 0.0% | -3.3% | -7.1% |
| W3 | 14.8% | 7.8% | 0.0% | 2.8% | 4.1% |
| W4 | 0.1% | 37.1% | 0.0% | 4.3% | -2.3% |
| W5 | 36.0% | 21.9% | 0.0% | -3.7% | 3.8% |
| W6 | 14.2% | 11.7% | 0.0% | -9.9% | 0.0% |

**This is the main result.** Nearly all profit is 2020-2021. Over 2022-2024 W1 lost about 4%, W5 made about
zero, and only W3 (about +7%) and W4 (about +2%) gained. The regime filter kept the book almost entirely flat
through 2022, so that year's zero is cash, not skill.

### Costs (on 10,000 starting equity)

| Run | Fees | Slippage | Stop gaps | Delisting | Total | Net profit |
|---|---|---|---|---|---|---|
| W1 | 387 | 675 | 234 | 0 | 1,296 | 9,229 |
| W2 | 1,095 | 2,120 | 332 | 21 | 3,569 | 1,976 |
| W3 | 234 | 440 | 131 | 0 | 804 | 3,250 |
| W4 | 695 | 1,288 | 218 | 0 | 2,201 | 3,980 |
| W5 | 316 | 572 | 220 | 0 | 1,108 | 6,595 |
| W6 | 652 | 1,310 | 109 | 0 | 2,071 | 1,500 |

On 4h, costs exceed the net profit in W2 and W6, and equal over half of it in W4. D5 figures are path dependent,
since costs change sizes and ladder timing: W1 fell only 7 points at 2x costs, W5 fell 20.

### False-breakout rate

Share of signals closing back below the breakout level within 5 days, top 30, before sizing.

| Rule | n | False rate | Events |
|---|---|---|---|
| Donchian 1d | 20 / 50 / 100 | 55.4% / 53.2% / 50.2% | 1,509 / 1,128 / 837 |
| Squeeze 0.8, 1d | 20 / 50 | 56.5% / 54.3% | 665 / 398 |
| Squeeze 0.6, 1d | 20 / 50 | 59.6% / 58.9% | 332 / 180 |
| Volume 1.5x, 1d | 20 / 50 | 52.2% / 50.5% | 1,098 / 856 |
| Volume 2x, 1d | 20 / 50 | 48.7% / 46.9% | 766 / 614 |
| Donchian 4h | 50 / 100 / 200 | 78.7% / 77.4% / 76.7% | 4,553 / 3,313 / 2,558 |
| Squeeze 0.7, 4h | 50 / 100 | 79.0% / 75.0% | 1,097 / 512 |
| Volume 2x, 4h | 50 / 100 | 73.3% / 72.3% | 2,399 / 1,758 |

About half of daily breakouts fail within five days, and about three quarters on 4h. The 4h figure is partly
mechanical: 30 closes get a chance rather than 5, so the two timeframes are not like for like. Inside the
portfolio, hard stops closed 37-41% of trades in every run.

- **H2 rejected.** Volatility contraction did not lower the false rate on 1d. It raised it by 1 to 6 points.
- **H3 half true.** A volume surge cut the false rate by 3 to 7 points, but excess return did not improve and
  W5's Sharpe is below W1's. Fewer failures did not mean more profit.

### Is there excess return? (H1)

Forward return from the next open, net of round-trip cost, W1 centre (n50, top 30), against all coin-bars of the
same universe in the risk-on regime:

| Horizon | Breakout mean | Median | Baseline mean | Month-matched excess | t |
|---|---|---|---|---|---|
| 5d | 3.8% | -0.5% | 0.6% | 0.0% | 0.0 |
| 10d | 6.6% | 0.8% | 1.9% | -0.1% | -0.1 |
| 20d | 8.6% | 0.7% | 5.2% | -2.1% | -1.4 |

**H1 not supported.** The raw gap over baseline disappears once each month is compared with itself. That pattern
fits breakouts firing mostly in months when everything rises, which would make the raw mean a bet on the market.
Across the 21 distinct signal sets and 3 horizons (63 correlated cells), only squeeze 4h n100 reached |t| >= 2
(t 2.0 at 5d, 2.5 at 10d). That is about what chance gives in 63 cells, and W4 took 60.2% of its profit from DOGE,
so I do not treat it as a finding.

### Concentration in a few winners (H4)

| Run | Top 1 / net | Top 5 / net | Top 10 / net | Top 10% of trades / gross | Net without top 5 | Net without top 10 | Median R |
|---|---|---|---|---|---|---|---|
| W1 | 24% | 56% | 78% | 64% | 4,042 | 2,003 | 0.01 |
| W2 | 33% | 123% | 193% | 71% | -456 | -1,846 | 0.01 |
| W3 | 15% | 69% | 117% | 61% | 999 | -553 | 0.01 |
| W4 | 63% | 130% | 171% | 80% | -1,183 | -2,811 | 0.01 |
| W5 | 18% | 69% | 101% | 71% | 2,016 | -39 | 0.01 |
| W6 | 63% | 217% | 348% | 79% | -1,754 | -3,714 | -0.15 |

**H4 confirmed.** The median trade is about zero. Removing the best 10 trades wipes out the profit in five of six
runs, and removes 78% of it in W1. W1's three best trades were all entered in Feb-Mar 2021 (BNB, VET, THETA). The
trail stop earns everything and the hard stop gives much of it back (W1: +20,565 and -11,268). That shape is what
trend following should look like, but W1's largest winners came from one bull market.

### Reserve runs (fixed parameters, OOS span, not walk-forward)

Comparison base: W1 centre fixed, Sharpe 1.12, 2020-2021 profit 10,639, 2024 loss 2,145.

| Run | Sharpe | Return | Max DD | Trades | Exposure | 2020-2021 profit | 2024 |
|---|---|---|---|---|---|---|---|
| A1 Donchian 1d, regime off | 1.17 | 84.1% | 18.0% | 308 | 5.6% | 11,257 | 0 |
| A2 Squeeze 4h, regime off | 0.97 | 72.7% | 15.9% | 370 | 6.2% | 6,181 | 1,129 |
| A3 Donchian 1d, default risk | 1.02 | 49.4% | 11.1% | 453 | 5.1% | 5,511 | -551 |
| P1-P5 random entry | 0.40 to 0.67, mean 0.53 | 21.8% to 44.6% | 18.3% to 19.4% | 335 to 389 | 6.8% to 8.6% | 2,629 to 5,403 | 0 |

- **Random entry.** All five seeds earned a positive Sharpe, so regime plus exits plus this bull market give about
  half of W1's Sharpe with no signal at all. The breakout beat every seed (1.12 against at most 0.67), so it did
  add something over a coin flip. Two limits: five seeds is a small sample, and every seed shows zero P&L in 2024
  (see harness issue 1), which spares them a year in which the W1 centre lost 2,145. This sits awkwardly with the
  zero month-matched excess. The likely reconciliation is that breakouts time the market across months, which
  the coin flip does not. I did not test that directly.
- **Regime.** Turning it off did not lower Sharpe (1.17 against 1.12; 0.97 against 0.97). In 2022 A1 lost 1,964
  against the centre's 141, so the filter saved about 1,800 that year. A1 also shows zero P&L in 2024, which flatters
  it, so this is a weak comparison. The filter's shown value is avoided loss in a bear year, not higher Sharpe.
- **Risk config.** The default config gives a similar Sharpe at about half the return and a lower drawdown.

## What failed and why

1. No breakout rule qualified. W1 fails D2 and D7, W5 fails D2, and the other four each fail at least four criteria.
2. The profit is one bull market. D7 catches this for W1. W5 passes D7 narrowly (2020 at 54.6%), yet its 2022-2024
   total is about zero.
3. No cross-sectional edge shown: within a month, a breakout coin does no better than the average universe coin.
4. 4h is worse throughout: more false breakouts, costs above net profit in W2 and W6, and negative Sharpe at
   neighbouring parameters in W4 and W6.
5. `topN` looks like noise: fixed 1d trend Sharpes at n20 are 1.19 (top 20) and 0.64 (top 30). A setting that
   should matter little moved Sharpe by half.

`FROZEN_CANDIDATES` is empty. Nothing goes to holdout.

## Departures from the pre-registration

- Reserve: the plan allowed regime 2, risk 1-2, and at most 4 more. I ran 2 + 1 + 5 placebo seeds, so the last
  group was 5, one over. The total stayed within 50.
- The placebo is a control added after seeing W1-W5 (W6 had not finished). It was declared in this doc first.
- W1 and W5 were rerun unchanged to refresh D2. No new parameter sets.

## Limits of this work

- The audit covered each run's plateau centre only, not the reserve runs, which are not candidates.
- Bars are loaded only for coins that were ever in the point-in-time top 30, plus BTC. That should not change
  results, since strategies read nothing else, but I reasoned this and did not test it against a full load.
- D2 for W2, W3, W4 and W6 was computed at 63 to 272 trials, when each ran. Each already failed, and more trials
  should only lower it.
- A last fill of 2025-01-01 in W1 and W5 is the end-of-run close-out stamped at the close of the 2024-12-31 bar.
  No holdout bar was read.

## Harness issues for the coordinator (not fixed, shared files untouched)

1. **Stuck ladder rung distorts long runs.** At the -17.5% rung entries stop. A flat book cannot recover and the
   sim has no human re-enable, so the run sits in cash to the end. W6 last filled on 2023-12-11 and W2 on
   2024-08-01. A1 and all five placebos show zero 2024 P&L with 18-19% drawdown, which fits the same cause, though
   I did not confirm their fill dates. `summary.halted` stays false in these cases, so it does not reveal this. It
   also tends to hold measured drawdown near 18-20%, which makes D3 easy to pass.
2. **`walkForward` ignores a per-fold universe.** `scheduledStrategy` keeps the first strategy's `universe`, so a
   `universe.n` grid parameter silently stops applying. I kept `n: 30` and applied `topN` inside `signals`. That is
   a workaround inside my own file, so the brief's "report it" applies: W1's topN results depend on that slice.
3. **`market.regime` is 200 bars, not 200 days.** On 4h it is a 33-day average, and it drives regime exits (W4 52,
   W6 84 exits). My entry filter uses a true 200-day average, so on 4h the entry and exit regimes differ.
4. **D2 depends on run order.** The same rule scored 0.969 and 0.179 on the same day. The final validator should
   recompute D2 for every candidate from the complete trial set.
