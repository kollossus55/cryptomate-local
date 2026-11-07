# r-risk: portfolio risk settings

VERDICT: KEEP THE DEFAULTS, because nothing beats them, not because they passed. On the fixed harness no config passes the sizing rule, A included (18.4% drawdown on R2 against a 15% limit). Larger sizes are clearly worse. Smaller size (B) stays untested on R4. Nothing frozen.

Summary (re-read 2026-11-06 on the fixed harness; section 0 has the evidence):

- **Defaults do not starve strategies.** At default, average exposure is 10.8% (R2), 5.0% (R3) and
  7.6% (R4). The stuck-in-cash reading of low exposure was largely the freeze.
- **Raising size is now firmly rejected.** The freeze hid it: R2 drawdown at C is 37.6% (was 15.6%),
  D 27.6%, E 24.4%, F 21.0%.
- **About 28% of the ladder's apparent drawdown protection was the freeze,** and 34% in the three
  pairs where rung 3 fired. The rest is real, but it costs return in all six pairs.
- **The ladder no longer caps drawdown near 15%.** Each re-enable rebases the high, so 13 of 36 runs
  went 20% or more below their all-time high, up to 37.6%, with no flatten.
- **Rung 3 fired 62 times in 16 of 36 runs. Rung 4 fired in none.** At default config, rung 3 fired
  in 2 of 8 runs, both in the same 2022 episode.
- **No result shows an edge.** The random control has the best Sharpe of any H or I run (R4-I, 0.85).

Numbers marked SUPERSEDED below came from the frozen harness and should not be quoted.

## 0. Re-read on the fixed harness (added 2026-11-06)

Source: `docs/rebuild/harness-fixes.md` and `data/research/v6/remeasure/`, with per-run detail in
`data/tmp/remeasure/r-risk/`. No new parameter sets and no new trials: this reads existing
re-measurements only. All 50 logged trials matched.

18 Sharpes moved by more than 0.01: 15 full-span runs and 3 walk-forward picks. Each of the 15 is a run
that reached rung 3 without my own re-enable wrapper. Every run that never reached rung 3 reproduced
its logged figures, as did J, N and M. So on these daily runs the shifts track the freeze, although the
harness note does not separate its causes formally. Its count of 3 frozen is a floor, and clearly an
undercount here.

### What changed

$10,000 unless marked. Return, Sharpe and max drawdown show old > new; the other columns are new.

| Run | Return | Sharpe | Max DD | Calmar | Exposure | Rung 3 firings | Re-enables |
|---|---|---|---|---|---|---|---|
| R2-A | 44.4 > 51.5% | 0.62 > 0.59 | 15.2 > 18.4% | 0.36 | 10.8% | 1 | 1 |
| R2-A $1M | 46.0 > 46.5% | 0.64 > 0.55 | 15.3 > 21.7% | 0.28 | 11.0% | 1 | 1 |
| R2-C | 37.5 > 12.0% | 0.51 > 0.20 | 15.6 > 37.6% | 0.05 | 10.9% | 4 | 4 |
| R2-D | 74.7 > 66.8% | 0.76 > 0.57 | 15.3 > 27.6% | 0.30 | 13.0% | 3 | 3 |
| R2-E | -4.9 > 52.0% | -0.10 > 0.47 | 15.3 > 24.4% | 0.27 | 13.3% | 5 | 5 |
| R2-F | 41.8 > 50.1% | 0.68 > 0.67 | 15.8 > 21.0% | 0.31 | 8.8% | 1 | 1 |
| R2-H | 37.9 > 20.1% | 0.44 > 0.25 | 17.7 > 34.3% | 0.08 | 14.0% | 4 | 3 |
| R2-I | -7.8 > 72.6% | -0.77 > 0.61 | 9.4 > 24.2% | 0.36 | 13.6% | 13 | 12 |
| R2-K | 99.5 > 99.4% | 0.83 > 0.70 | 15.0 > 27.8% | 0.40 | 13.9% | 5 | 3 |
| R2-L | -5.1 > 117.0% | -0.10 > 0.78 | 15.1 > 25.9% | 0.49 | 14.4% | 5 | 5 |
| R3-I | 23.3 > 52.4% | 0.44 > 0.71 | 9.4 > 14.0% | 0.48 | 6.4% | 1 | 1 |
| R4-E | 41.3 > 54.9% | 0.58 > 0.60 | 15.6 > 19.7% | 0.35 | 12.9% | 1 | 1 |
| R4-H | 31.0 > 30.7% | 0.43 > 0.37 | 17.6 > 25.8% | 0.16 | 13.9% | 1 | 1 |
| R4-I | -5.9 > 93.8% | -0.23 > 0.85 | 9.3 > 26.1% | 0.41 | 11.6% | 10 | 7 |
| R4-K | 48.7 > 60.1% | 0.65 > 0.63 | 15.2 > 20.2% | 0.37 | 13.3% | 2 | 1 |

Unchanged: all other R3 runs, R1, R2-B, R4-A, every J and N, M, full weight, X, and $1,000.

### Does "keep the defaults" hold?

Yes, but as a default outcome, not a pass. The pre-registered rules, applied as written:

| Test | Result on the fixed harness |
|---|---|
| A | **Fails**: R2 drawdown 18.4% against 15%. It used to miss by 0.16 points; it now misses by 3.4 |
| B | Clears R2 and R3: drawdown 13.6% and 7.6%; Sharpe 0.50 and 0.74 against floors of 0.49 and 0.69. **Cannot pass**: no R4 run |
| C | **Fails**: R2 drawdown 37.6%, Sharpe 0.20 |
| D | **Fails**: R2 drawdown 27.6% |
| E | **Fails**: drawdown 24.4% (R2), 19.7% (R4); R2 Sharpe 0.47 |
| F | **Fails**: R2 drawdown 21.0% |
| Ladder H | Calmar better only on R3. Drawdown up 9.9, 2.2, 6.1 points. **Fails** |
| Ladder I | Calmar better on R2 and R4 (was worse on all three). Drawdown -0.2, +2.7, +6.4 points. **Fails** on the 2-point limit |
| Breaker removed | Calmar better on R2, R4, worse on R3. Drawdown up 3.4, 3.0, 0.5 points. **Fails, so it stays** |
| Period limits removed | Calmar better on R2, worse on R3, no R4 run. **Fails, so they stay** |

What this does and does not support:

- **Not raising size is better supported than before.** The sizing rule was censored by the freeze, and
  that censoring is gone. Every larger size breaks the line on R2.
- **The case for A over B is open.** B is the only config not shown to fail. It gives up 21 points of
  return on R2 and 15 on R3, and its Sharpe margin on R2 is 0.01. The missing R4 run is my
  pre-registration flaw, and my trial budget is spent, so I cannot settle it. I do not recommend B on
  an incomplete test.
- **The rule's 15% line is finer than the outcome noise.** R2-A is 18.4% at $10,000 and 21.7% at
  $1,000,000. R2-E is 24.4% under the harness re-enable and 29.8% under my wrapper, which differ mainly
  in waiting for a flat book. R2-C (37.6%) is worse than the larger R2-D (27.6%). Path differences of
  this kind move drawdown by 3-10 points, so small gaps here are not effects.

### What the ladder really does

Same sizing, ladder on against off (J and N have no ladder, so they did not change). Drawdown cuts are
in points.

| Ref | Size | Return on / off | Max DD on / off | Calmar on / off | Cut, frozen | Cut, fixed | Share that was freeze |
|---|---|---|---|---|---|---|---|
| R2 | default | 51.5% / 56.4% | 18.4% / 28.8% | 0.36 / 0.25 | 13.6 | 10.4 | 24% |
| R3 | default | 46.4% / 60.5% | 8.3% / 9.2% | 0.73 / 0.82 | 0.9 | 0.9 | 0% |
| R4 | default | 31.2% / 51.4% | 13.4% / 18.8% | 0.32 / 0.35 | 5.4 | 5.4 | 0% |
| R2 | max | 52.0% / 60.2% | 24.4% / 33.2% | 0.27 / 0.23 | 17.9 | 8.8 | 51% |
| R3 | max | 57.7% / 104.7% | 11.3% / 15.5% | 0.64 / 0.75 | 4.2 | 4.2 | 0% |
| R4 | max | 54.9% / 126.1% | 19.7% / 32.3% | 0.35 / 0.41 | 16.7 | 12.6 | 25% |
| **All six** | | | | | **58.7** | **42.3** | **28%** |

Across the three pairs where rung 3 fired, the cut falls from 48.2 to 31.8 points, so 34% was the
freeze.

- **It still cuts drawdown in all six pairs, and still costs return in all six.** The cost is 5 to 71
  points. Calmar is better in 2 of 6 pairs, both R2 (was 1 of 6).
- **Much of the remaining protection is size cuts, not the stop.** R3-A and R4-A never reached rung 3,
  so all of their cut is rungs 1-2. R2-A spent 66% of days on those rungs, against 1% on rung 3. These
  runs cannot split the two elsewhere without a new parameter set.
- **"Locks in losses" is much weaker than I said.** R2-E's collapse to -4.9% was the freeze: it is now
  +52.0%. The slow-recovery cost remains: R2-A made +11.8% and -4.2% in 2023-24 against +20.6% and
  +4.0% with no ladder, and R4-A is unchanged.
- **It does not hold drawdown under 18%.** That was the freeze. It holds only if the human declines to
  re-enable. The stand-in always accepts after 30 days, so real results depend on that decision and
  should fall between the frozen and fixed numbers only if the human is at least as cautious.
- **The tight ladder's recovery is not a case for it.** R2-I and R4-I needed 12 and 7 re-enables in 6.5
  years, each a fresh allowance, and the random control scored best. I read that as path noise and
  market beta, not as evidence that a tighter ladder works.

### How often rung 3 and -20% fire

| Group | Runs | Runs with rung 3 | Rung 3 firings | Runs with rung 4 |
|---|---|---|---|---|
| All real-ladder runs | 36 | 16 | 62 | 0 |
| Default ladder (excludes H, I) | 30 | 11 | 33 | 0 |
| Default config A, all equities | 8 | 2 | 2 | 0 |

A firing is an entry to rung 3 or above, at each config's own threshold. There were 54 re-enables,
5 of them from my M wrapper. One run, R4-I, ended on rung 3 (was 15 of 16). The two A firings are R2 at
$10,000 and $1,000,000, both in June 2022. R3 reached rung 3 only at the tight ladder's threshold.

**-20% never fires, but for a different reason from the one I gave.** I said equity freezes near -15%.
In fact each re-enable rebases the high, so rung 4 measures from the last rebase. 13 of 36 runs spent
days at 20% or more below their all-time high, up to 35% of the span (R2-C, R2-H), with rung 4
never active. Worst cases: R2-C 37.6% and R2-H 34.3%, both past D3's 30%. Among default-config runs
only R2-A at $1,000,000 did this (21.7%). The contract's re-enable allowance note anticipates this.

What followed, 28 rung-3 spells at the default ladder, excluding M: 25 ended by re-enable, 3 by
recovery. Median spell 31 days, range 2 to 69. Measured from the end of the spell, 14 of 23 with a full
year of data were up a year later, median +5.4%, worst further fall -13.6%. These overlap heavily:
nearly all are R2 in 2022-24, so the true sample is about three episodes. Re-enabling in early 2022
was often too soon, and the 2023-24 spells mostly recovered.

### Still valid, and not answerable

Still valid: the first-crossing, bootstrap and "what followed" tables (no-ladder curves), the BTC
breaker study, the 4h cadence gap, the minimum-equity table and the ceiling note.

Not answerable from these re-measurements: rung 1-2 protection against rung-3 protection on R2 and on
R4 at max size; B on R4; any re-enable delay other than 30 days; the harness replica behind the 1.5%
exposure figure, which was not re-measured (R2-A at 10.8% is the nearest evidence).

## 1. Pre-registration (written 2026-11-05, before running)

### Question

core-sim reports about 2% average exposure under real v6Risk sizing. Are the defaults sensibly
calibrated, or do they starve strategies? This family looks for settings, not an edge, so it may
freeze no strategy. Its output is `RECOMMENDED_RISK_CONFIG`.

### Economic reasoning and hypotheses

Sizing is mechanical. Per trade, notional = equity x riskPerTrade / (stop + costs). Across the book,
gross <= maxOpenRisk / stop. So at a 15% stop the default 3% cap allows about 20% gross, and the 5%
ceiling about 33%. Exposure is set by the stop distance, not by the vol target.

- H1. Size is linear in risk, so Sharpe should barely move as size rises while return and drawdown
  scale up together. If so, the defaults starve dollars, not risk-adjusted performance. Bigger
  size only helps if the entry has an edge: with no edge it loses faster.
- H2. The binding limit is risk_per_trade or open_risk, not vol_target.
- H3. The drawdown ladder cuts size after losses. In a trend-following book, drawdowns are often
  followed by recoveries, so the ladder may lock in losses. It should help a strategy with no edge
  more than one with an edge. It may rarely fire at all at default size.
- H4. The -15% rung sticks once flat, and -20% ends the run. Both should be rare at real sizing.
- H5. The market breaker blocks entries after sharp falls. Crypto bounces after crashes, so its
  value is uncertain: it may avoid falling knives or may miss rebounds.
- H6. At $10,000, minNotional rejects little at default size, but stacked multipliers on wide
  stops can reach it. The sim has no lot rounding, so results should be close to scale-free.

### Reference strategies (fixed, not tuned; none is a candidate)

Span: 2018-07-01 to DEV end, $10,000, real v6Risk through a pass-through recorder.

| Id | Rule | Why |
|---|---|---|
| R1 ref_btc_sma | BTC above 100d SMA, 20% stop, signal-only exits | Shipped reference, single coin. Not clean evidence |
| R2 ref_mom20 | Top 20 point-in-time, 30d ROC > 0, 15% stop, trend profile | The harness example behind the 2% figure |
| R3 ref_brk20 | Top 20, close > prior 50d high while BTC above 200d, stop 3 ATR clamped to 5-25%, trend profile | ATR stops, more like a real candidate |
| R4 ref_rand20 | Top 20, hash(symbol, bar) < 2% a day, same stop and exits as R3 | No-timing control: market beta, no selection |

### Grid (config names; anything unnamed is DEFAULT_RISK_CONFIG)

| Name | Settings |
|---|---|
| A default | risk 0.5%, open 3%, vol 18% |
| B | risk 0.25% |
| C | risk 1%, open 3% |
| D | risk 1%, open 5% |
| E max | risk 1%, open 5%, vol 20% |
| F | risk 1%, open 5%, vol 10% |
| H ladder wide | E plus 7.5/12.5/17.5/20 |
| I ladder tight | E plus 3/6/9/12 |
| J no ladder | E with ladder neutralised (diagnosis) |
| K no breaker | E with market breaker neutralised (diagnosis) |
| L no period limits | E with daily and weekly limits neutralised (diagnosis) |
| M re-enable | E with a simulated human re-enable 30 days after rung 3 or 4 (diagnosis) |

J, K, L and M step outside the engine with a wrapper around the real module. They measure what a
rule is worth. They are never recommended and never count as results.

Trials, 50 maximum: R2, R3 x A-F, H-L = 22. R4 x A, E, H, I, J, K = 6. R1 x A, E = 2. Scale at
$1,000 and $1,000,000: R3 x A, E = 4, R2 x A = 2. M on R2, R3 = 2. fullWeightRisk diagnosis on R2,
R3 = 2. walkForward at the recommended config, three-value grids on R2 and R3 = 6. Total 46, 4 spare.

### Decision rules (fixed now)

Sizing: from A-F pick the largest setting where, on each of R2, R3, R4: (1) max drawdown <= 15%,
which leaves room below the -20% halt; (2) the -20% halt does not fire; and on R2 and R3:
(3) Sharpe is no worse than A's minus 0.10. If no reference has a positive net return, keep the
defaults, because more size on no edge only loses faster.

Ladder: change it only if a variant improves Calmar on at least 2 of R2, R3, R4 and does not raise
max drawdown by more than 2 points on any. Otherwise keep the default. Same test for the breaker
and period limits when compared with their neutralised runs: they stay unless clearly harmful, and
this agent does not propose loosening any loss limit past its ceiling in any case.

Never chosen by highest return. Walk-forward with checkDevCriteria runs on the recommended config.
If history gives too few rung triggers to count, a stationary block bootstrap of the no-ladder
daily returns estimates the rate. That adds no parameter set, so it is not a trial.

## 2. Results

Section 1 is unchanged from the pre-registration. This section reports the frozen harness: SUPERSEDED notes mark what no longer stands, and section 0 replaces it.

### Trial count and changes from the plan

50 of 50 trials logged in `data/research/v6/trials-r-risk.jsonl`: 15 are diagnosis-only, 6 are
walk-forward. All DEV data through `loadBars`. A two-month smoke run was not logged.

Changes and flaws, stated plainly:

- **The 4 spare trials were chosen after seeing the first sweep:** config N (defaults, ladder
  neutralised) on R2, R3, R4, and config X (R2 from 2022-01-01). They were needed because the rung-3
  stick confounded the grid.
- **The sizing rule was badly designed.** Its drawdown test was censored by the freeze, which held max
  drawdown near 15% whatever the size (the fixed harness removes this; see section 0). I also never scheduled R4 for B, C, D or F, so those
  configs could not pass as written. The rule's outcome stands (section below), but N and J are the
  more informative evidence, and they are post-hoc.
- **A bug in my first study was fixed before use.** 4h breaker forward returns were anchored on the
  prior daily close, which put part of the crash in the "after" window. They now start at the 4h
  close that tripped. Minimum-equity figures now use the real Tier 3 allowance.
- **The harness replica logged nothing,** because its parameter sets are already in
  `trials-example.jsonl`. Its script is scratch: `data/tmp/r-risk/harness-replica.mjs`.

### Why exposure is low

> **SUPERSEDED, frozen harness.** The "Rung-3 stick" row was the freeze: R2-E is now 13.3%, not 2.7%. The harness replica was not re-measured. The other rows stand.

| Layer | Evidence |
|---|---|
| Arithmetic | R1: 0.5% risk / 20% stop is about 2.5% per position. It held 2.3% on average (4.0% while in) |
| Portfolio caps | Default no ladder: 5.5% (R3), 11.5% (R4), 13.2% (R2) average exposure |
| Ladder size cuts | R4-A, never on rung 3: 7.6%, against 11.5% with no ladder |
| Rung-3 stick | Harness replica 1.5%. R2-E 2.7% (11.6% before the stick) |

Which limit set the size of accepted entries, default size with no ladder (N):

| Ref | risk_per_trade | open_risk | vol_target |
|---|---|---|---|
| R2 | 761 | 269 | 254 |
| R3 | 174 | 61 | 1 |
| R4 | 369 | 74 | 4 |

H2 holds at default size. At maximum size vol_target takes over on R2 (547 of 1,029 entries in R2-J).
Realised book volatility at default, no ladder, was 8.7% to 14.7%, under the 18% target. The contract
says "scale toward" the target, but v6Risk only ever shrinks, so the target is a cap, not an aim.

### Sizing: default against maximum, with the stick removed

Ladder neutralised, so this is diagnosis only. It is the clean read on H1.

| Ref | Config | Exposure | Return | Sharpe | Max DD | Calmar |
|---|---|---|---|---|---|---|
| R2 | N default | 13.2% | 56.4% | 0.54 | 28.8% | 0.25 |
| R2 | J max | 17.5% | 60.2% | 0.47 | 33.2% | 0.23 |
| R3 | N default | 5.5% | 60.5% | 0.88 | 9.2% | 0.82 |
| R3 | J max | 8.7% | 104.7% | 0.87 | 15.5% | 0.75 |
| R4 | N default | 11.5% | 51.4% | 0.65 | 18.8% | 0.35 |
| R4 | J max | 18.8% | 126.1% | 0.80 | 32.3% | 0.41 |

H1 mostly holds. Raising size lifts drawdown about 1.7x on R3 and R4, and return 1.7x on R3 and 2.5x on
R4. It gives R2 almost nothing because its caps bind. Max size takes R2 and R4 past 30%, beyond what the ladder
allows. R3 could carry more, but one reference strategy with a good sample is not grounds to raise a
global default.

R4, the random control, matches or beats R2 (0.65 against 0.54). So R2 shows no selection edge, and
much of what these references earn is market beta. For comparison, full weight (`fullWeightRisk`, 5%
per coin, diagnosis only) returned 178% on R2 with a 69% drawdown and Sharpe 0.56, and 137% on R3 with
a 46% drawdown and Sharpe 0.58. Real sizing earns less, at a better Sharpe.

### All real-ladder runs, $10,000

> **SUPERSEDED, frozen harness.** Rows R2 A, C-I, R3-I and R4 E, H, I, plus their rung-day columns. Section 0 has current figures. The instability paragraph below described a freeze effect: R2-D and R2-E are now 66.8% and 52.0%.

| Ref | Cfg | Exp | Return | Sharpe | Max DD | Calmar | Rung days 0/1/2/3 | First rung 3 |
|---|---|---|---|---|---|---|---|---|
| R1 | A | 2.3% | 16.4% | 0.93 | 3.4% | 0.69 | 100/0/0/0 | none |
| R1 | E | 3.7% | 30.7% | 0.93 | 5.8% | 0.72 | 60/40/0/0 | none |
| R2 | A | 6.2% | 44.4% | 0.62 | 15.2% | 0.38 | 24/29/8/39 | 2022-06-12 |
| R2 | B | 7.3% | 30.3% | 0.50 | 13.6% | 0.31 | 27/33/41/0 | none |
| R2 | C | 6.3% | 37.5% | 0.51 | 15.6% | 0.32 | 21/22/13/44 | 2022-02-22 |
| R2 | D | 7.1% | 74.7% | 0.76 | 15.3% | 0.59 | 22/18/17/43 | 2022-03-07 |
| R2 | E | 2.7% | -4.9% | -0.10 | 15.3% | -0.05 | 6/5/12/77 | 2019-12-26 |
| R2 | F | 5.5% | 41.8% | 0.68 | 15.8% | 0.35 | 32/22/15/31 | 2022-12-17 |
| R2 | H | 7.8% | 37.9% | 0.44 | 17.7% | 0.29 | 27/19/10/44 | 2022-02-21 |
| R2 | I | 0.3% | -7.8% | -0.77 | 9.4% | -0.13 | 1/3/3/93 | 2018-12-26 |
| R3 | A | 5.0% | 46.4% | 0.79 | 8.3% | 0.73 | 64/36/0/0 | none |
| R3 | B | 3.7% | 31.7% | 0.74 | 7.6% | 0.57 | 67/33/0/0 | none |
| R3 | C | 6.2% | 87.0% | 0.96 | 10.2% | 0.99 | 58/39/3/0 | none |
| R3 | D | 7.1% | 61.3% | 0.74 | 10.9% | 0.70 | 38/58/4/0 | none |
| R3 | E | 7.2% | 57.7% | 0.71 | 11.3% | 0.64 | 37/57/6/0 | none |
| R3 | F | 5.1% | 65.3% | 0.96 | 9.0% | 0.89 | 85/15/0/0 | none |
| R3 | H | 7.8% | 78.5% | 0.77 | 13.5% | 0.69 | 60/36/4/0 | none |
| R3 | I | 3.7% | 23.3% | 0.44 | 9.4% | 0.35 | 16/27/29/28 | 2023-03-19 |
| R4 | A | 7.6% | 31.2% | 0.57 | 13.4% | 0.32 | 36/37/27/0 | none |
| R4 | E | 7.1% | 41.3% | 0.58 | 15.6% | 0.35 | 20/28/13/39 | 2022-06-14 |
| R4 | H | 7.8% | 31.0% | 0.43 | 17.6% | 0.24 | 28/22/11/39 | 2022-06-19 |
| R4 | I | 1.5% | -5.9% | -0.23 | 9.3% | -0.10 | 3/3/12/82 | 2019-08-30 |

**These single-path numbers are unstable.** Moving the vol target from 18% to 20% (R2-D to R2-E) takes
the return from +74.7% to -4.9%, only because the stick arrives in 2019 instead of 2022. Do not read
small differences here as effects. R3's C and F look good for the same reason: no pattern across the
grid supports them.

### Pre-registered decisions

> **SUPERSEDED, frozen harness.** This whole table. Section 0 re-applies every rule. The outcomes hold, but several reasons changed.

| Test | Outcome |
|---|---|
| Sizing | **No config passes.** A fails on R2 drawdown (15.16% against 15%). B fails on Sharpe (R2 0.50 against 0.62), C, E on Sharpe and drawdown, D and F on drawdown. B, C, D, F also lack R4 runs. So no evidence for a change: keep defaults |
| Ladder H (wide) | Calmar better on R2, R3, worse on R4. Drawdown up 2.4, 2.2, 2.0 points. **Fails** the 2-point limit |
| Ladder I (tight) | Calmar worse on all three. **Fails** |
| Breaker removed | Calmar better on R2 (a stick-timing artefact) and R4, worse on R3, with R3 drawdown up 3.0 points. **Fails, so it stays** |
| Period limits removed | No improvement on R2 or R3. **Fails, so they stay** |

H and I were only tested at maximum size, not at default.

### The ladder: it does both

> **SUPERSEDED, frozen harness.** This whole subsection, including "under 18%", the R2-A 0.0% years and "5 of 6". Section 0 replaces it. R3 rows and default R4 are unchanged.

Same sizing, ladder on against off:

| Ref | Size | Return on / off | Max DD on / off | Calmar on / off |
|---|---|---|---|---|
| R2 | default | 44.4% / 56.4% | 15.2% / 28.8% | 0.38 / 0.25 |
| R3 | default | 46.4% / 60.5% | 8.3% / 9.2% | 0.73 / 0.82 |
| R4 | default | 31.2% / 51.4% | 13.4% / 18.8% | 0.32 / 0.35 |
| R2 | max | -4.9% / 60.2% | 15.3% / 33.2% | -0.05 / 0.23 |
| R3 | max | 57.7% / 104.7% | 11.3% / 15.5% | 0.64 / 0.75 |
| R4 | max | 41.3% / 126.1% | 15.6% / 32.3% | 0.35 / 0.41 |

It cuts losses: drawdown stays under 18% where it would reach 33%. It also locks them in. R2-A earned
0.0% in both 2023 and 2024, when the no-ladder run made +20.6% and +4.0%. R4-A, never stuck, made
+6.8% and +0.1% against +20.5% and +9.1%, because recovering at half or quarter size is slow.

Calmar is lower with the ladder in 5 of 6 rows, so it buys a hard loss limit, not better risk-adjusted
return. H3's idea that it helps a no-edge strategy most is not supported: R4 did not benefit. The
evidence is about two bear markets, so that is weak either way. This is not an argument to loosen it.

### How often -15% and -20% trigger, and what followed

> **SUPERSEDED, frozen harness.** The first two paragraphs: "equity freezes near -15%", "15 ended on it", and the 17.7% worst drawdown. Section 0 replaces them. The tables below use no-ladder curves and stand.

Rung 4 fired in 0 of 36 real-ladder runs. Leaving out the re-enable runs, the worst real-ladder drawdown was
17.7%, with rung 3 itself set at 17.5%. Rung 3 stops entries, positions exit on their stops, and equity freezes near -15%. So
-20% is reachable only by a gap or a drop in positions still open. Even the tight ladder's -12% halt
never fired.

Rung 3 fired in 16 of 36 runs, and 15 ended on it. The one exception is the re-enable policy run.
In those 15, stuck and flat time was 25% to 92% of the span.

First crossings per drawdown episode, on curves with no ladder:

| Curve | -15% crossings | -20% crossings |
|---|---|---|
| Default (N): R2 / R3 / R4 | 1 / 0 / 1 | 1 / 0 / 0 |
| Max (J): R2 / R3 / R4 | 3 / 1 / 3 | 2 / 0 / 2 |

What followed on the max curves:

| Trigger | Date | Next 365d | Worst further fall in 365d | Days to regain high |
|---|---|---|---|---|
| R2 -15% | 2018-12-25 | +0.5% | -1.1% | 101 |
| R2 -15% | 2019-08-24 | +13.8% | -6.7% | 336 |
| R2 -15% | 2022-02-17 | -8.1% | -20.5% | never in data |
| R3 -15% | 2023-08-16 | +23.6% | -0.5% | 88 |
| R4 -15% | 2019-08-28 | +27.7% | -8.2% | 170 |
| R4 -15% | 2022-04-30 | -5.1% | -11.0% | 601 |
| R4 -15% | 2024-08-03 | n/a (+3.6% at 90d) | -0.5% | 104 |
| R2 -20% | 2019-12-23 | +25.5% | -1.0% | 215 |
| R2 -20% | 2022-05-07 | -9.3% | -15.7% | never in data |
| R4 -20% | 2019-09-26 | +34.4% | -3.2% | 141 |
| R4 -20% | 2022-06-12 | -8.9% | -8.9% | 558 |

Recoveries were the more common outcome: 4 of 6 measurable -15% triggers were up a year later. But the
2022 triggers were followed by up to another 20.5% of loss. These are not independent events: they
cluster in 2018-19 and 2022, so the true sample is about three episodes.

Bootstrap chance of reaching each drawdown (2,000 paths, mean block 20 days, no-ladder daily returns).
This resamples one history and is not a forecast:

| Curve | -15% in 1y | -15% in 3y | -20% in 1y | -20% in 3y |
|---|---|---|---|---|
| R2 default | 32% | 79% | 11% | 49% |
| R3 default | 0.05% | 5.7% | 0% | 0.5% |
| R4 default | 11% | 48% | 2.2% | 20% |
| R2 max | 61% | 97% | 32% | 81% |
| R3 max | 9.7% | 43% | 1.3% | 15% |
| R4 max | 49% | 91% | 22% | 65% |

On a strategy without a strong edge, rung 3 within three years is likely even at default size, so a
human will be asked to decide. At max size it is close to certain on two of three references.

**Re-enabling.** (SUPERSEDED as a baseline: R2-E under the harness re-enable is +52.0% with 24.4% drawdown, and -4.9% was the freeze. The M figures themselves stand.) A simulated re-enable 30 days after rung 3 (diagnosis only) took R2-E from -4.9% to
+57.4%, but it needed 5 re-enables in 6.5 years and cumulative drawdown doubled, from 15.3% to 29.8%.
That matches the contract's warning that each one grants a fresh allowance. R3 needed none.

### Market breaker

On daily bars the breaker tripped 46 times, for 103 days (4.3% of days). It depends only on BTC, so
this study is free of the stick. BTC after a trip against all days:

| Horizon | After a trip (mean / median) | All days (mean / median) |
|---|---|---|
| 1d | +0.75% / +0.50% | +0.17% / +0.07% |
| 3d | +0.87% / +1.14% | +0.51% / +0.27% |
| 7d | -0.13% / +0.85% | +1.22% / +0.59% |
| 14d | +0.42% / +1.21% | +2.51% / +1.37% |
| 30d | +2.55% / +1.76% | +5.50% / +2.49% |

Top-20 equal-weight basket: -1.4% at 7 days against +0.9%, and -2.1% at 30 days against +3.7%.

Entries it would have blocked, from the runs with it neutralised:

> **SUPERSEDED, frozen harness.** This table and "modest value at low cost". Fixed harness: R2 58 trades, -$683, -0.11R against 0.18R; R3 unchanged; R4 26 trades, +$574, 0.44R against 0.34R. So it helped on R2, barely mattered on R3 and blocked winners on R4. It stays because removal fails the drawdown test, not because its value is shown. "Daily and weekly limits barely matter" also goes: removing them moved R2 from 52.0% to 117.0%, though rung-3 timing may explain much of that.

| Ref | Blocked trades | Their P&L | Their average R | Other trades' average R |
|---|---|---|---|---|
| R2 | 44 | -$745 | -0.17 | 0.33 |
| R3 | 3 | -$37 | -0.16 | 0.52 |
| R4 | 20 | -$98 | 0.34 | 0.34 |

Modest value at low cost. Means after a trip are weaker past three days, though medians are close to
normal, and the bounce in the first three days is small. No significance test was run, and windows
overlap. It stays. Daily and weekly limits barely matter: 1-2% of days, and removing them changed R3 by
2.5 points and R2 by 0.2.

**Sim and live differ here.** A 1d strategy feeds the breaker daily bars. On 4h bars it trips 76 times
for 178 days (7.5%), about 73% more blocked time. If live passes 4h bars as risk-engine.md advises, it
will block more than any daily backtest shows.

### Scale

> **SUPERSEDED, frozen harness.** R2-A: $10,000 is now 51.5% / 10.8% and $1,000,000 46.5% / 11.0%, so "at most 1.6 points" becomes 5.0, with drawdown 18.4% against 21.7%. Rung 3 fired 15 days apart in those two runs. R3 stands. R2-A now has 6,488 `below_min_notional` rejections, and 178 entries under $100. The $1,000 runs did not change, because the sim re-enable acts only from rung 3. `humanReEnable` has since gained a deadlock path, so "a human has no button" no longer holds for the engine.

| Run | $1,000 | $10,000 | $1,000,000 |
|---|---|---|---|
| R2-A return / exposure | -4.7% / 0.2% | 44.4% / 6.2% | 46.0% / 6.3% |
| R3-A return / exposure | 35.2% / 3.3% | 46.4% / 5.0% | 46.5% / 5.0% |
| R3-E return / exposure | 25.2% / 3.6% | 57.7% / 7.2% | 57.7% / 7.2% |

$10,000 is close to scale-free: at most 1.6 points of return against $1,000,000. Its many
`below_min_notional` rejections (4,299 on R2-A) are the caps working: a full book with less than $25
of room left. No fill is below $25, so an exchange minimum near that would not bite. 127 of R2-A's
992 entries were under $100.

$1,000 is distorted, and shows a **deadlock**. R2-A at $1,000 reached rung 1 in 2018, its half size
fell below $25, and it spent 96% of days there with 23,229 rejections, finishing with no trades after
2018. A flat book cannot recover, and `humanReEnable` refuses with `nothing_to_clear` below rung 3, so
a human has no button for it.

Smallest current equity at which entries still clear minNotional $25, default risk, Tier 3 costs:

| Stop | Full | Half | Quarter | Quarter on paper(half) |
|---|---|---|---|---|
| 5% | $290 | $580 | $1,160 | $2,320 |
| 10% | $540 | $1,080 | $2,160 | $4,320 |
| 15% | $790 | $1,580 | $3,160 | $6,320 |
| 20% | $1,040 | $2,080 | $4,160 | $8,320 |
| 25% | $1,290 | $2,580 | $5,160 | $10,320 |

So a $10,000 account can hit this too: on the quarter rung, equity is about $8,500-$9,000, and a
strategy in paper(half) with stops of about 20% or wider is refused every entry.

Not tested: the simulator has no lot-size rounding, so rounding effects are unmeasured. It also has no
market impact in bar fills, so the $1,000,000 column says nothing about capacity.

### Walk-forward at the recommended config

> **SUPERSEDED, frozen harness.** All R2 figures and both D2 values. Fixed harness, R2: D1 **FAIL** 0.79 [-0.03, 1.56], D2 **FAIL** 0.000, D3 PASS 18.4%, D4 PASS 1,425, D5 PASS 29.4%, D6 PASS 0.43 vs 0.78, D7 **FAIL** BNB 17.4%, 2021 71.9%, D8 **FAIL** 0.52 vs 0.72, 0.79 vs 0.96. Return 51.2%, exposure 10.9%, flat 8.7%, end rung 1, 1 re-enable, years +18.1 / +31.2 / -9.6 / +11.8 / -3.4, costs $553 / $833 / $83 / $0. Its 83 regime exits made $2,559, about half its profit, through the undeclared BTC SMA200 exit. R3 is unchanged except D2 0.000, and fails D2 only. Neither qualifies. "Censored" and "stopped trading in 2022" no longer apply. Costs table: R2-A is now $694 / $1,154 / $182 / $0; R3-A and R4-A are unchanged.

Defaults, real v6Risk, rolling 730-day train, 180-day test, OOS from 2020-06-30. `auditLookahead` clean
with `rebuild` on both, 3 cuts. R2 grid n 20/30/60, R3 grid n 20/50/100. These are reference strategies
and are not candidates. Global trial count was 337 and 340 when run, and other agents were still adding.

| Criterion | Need | R2 ref_mom20 | R3 ref_brk20 |
|---|---|---|---|
| D1 Sharpe, 90% CI | >= 0.80, low > 0 | PASS 0.88 [0.07, 1.67] | PASS 1.03 [0.23, 1.74] |
| D2 Deflated Sharpe | >= 0.90 | **FAIL** 0.049 | **FAIL** 0.089 |
| D3 Max drawdown | <= 30% | PASS 15.2% | PASS 9.5% |
| D4 Closed trades | >= 100 | PASS 560 | PASS 222 |
| D5 Return at 2x costs | > 0 | PASS 38.8% | PASS 43.6% |
| D6 Plateau | neighbours >= 50% | PASS 0.58 vs 0.87 | PASS 1.01 vs 1.02 (1 neighbour) |
| D7 Concentration | coin <= 35%, year <= 60% | **FAIL** BNB 21.5%, 2021 85.4% | PASS BNB 20.6%, 2023 34.9% |
| D8 Against buy-and-hold | better Calmar or Sharpe | **FAIL** 0.55 vs 0.72, 0.88 vs 0.96 | PASS 0.92 vs 0.72, 1.03 vs 0.96 |
| Overall | | NOT QUALIFIED | NOT QUALIFIED |

| | R2 | R3 |
|---|---|---|
| Return | 43.1% | 46.1% |
| Exposure | 4.4% | 5.8% |
| Flat share | 62% | 45% |
| End rung | 3 (stuck) | 0 |
| 2020 / 2021 / 2022 / 2023 / 2024 | +18.1 / +31.2 / -7.6 / 0.0 / 0.0 | +13.7 / +11.9 / 0.0 / +12.7 / +1.9 |
| Fees / slippage / stop gaps / delisting | $235 / $326 / $54 / $0 | $100 / $160 / $40 / $0 |

R2's 15.2% drawdown and 0.88 Sharpe are censored: it stopped trading in 2022, so 2023-24 are not
evidence of anything. Over 2022-24 alone, without the earlier gains, it returned -6.5% (config X).

Costs on the full-span $10,000 runs at default:

| Run | Fees | Slippage | Stop gaps | Delisting |
|---|---|---|---|---|
| R2-A | $371 | $641 | $152 | $0 |
| R3-A | $126 | $210 | $46 | $0 |
| R4-A | $158 | $279 | $93 | $0 |

## 3. Recommendation

Unchanged by the re-read, on the weaker basis in section 0. `RECOMMENDED_RISK_CONFIG` equals `DEFAULT_RISK_CONFIG`, every key, inside HARD_CEILINGS:
risk per trade 0.5%, open risk 3%, vol target 18%, ladder 5/10/15/20, breaker 8%/15%, daily 2%,
weekly 4%, minNotional 25. `FROZEN_CANDIDATES` is empty. No result here shows any strategy has an
edge, and no setting can guarantee winning trades.

### Ceilings

One real block, reported without asking to loosen it. A single-position, wide-stop allocator cannot
reach meaningful size. At the 1% ceiling a 20% stop gives about 4.9% of equity, and the 25% position cap
needs a stop under about 3.6%. R1 made 16.4% in 6.5 years at Sharpe 0.93. So a slow allocator can pass
on Sharpe and still earn very little in dollars. Everything else is fine: the 20% vol ceiling does not
bind at default size.

### For the coordinator (no change made; these are outside my files)

> **SUPERSEDED, frozen harness.** Items 1, 2, 3 and 5. The harness fix covers 1 and 5. Item 2 becomes: rung 3 is still the main event, but -20% limits loss only from the last rebase, so re-enable screens must show drawdown from the all-time high, as the contract requires. A limit that survives re-enables would be a tightening; it is untested here and is your call. Item 3: the engine now has a deadlock path; the alarm and any start-up equity check still need confirming. Item 4 stands.

1. **Report rung-3 status on every result.** runSim has no human, so a run that reaches rung 3 is cash
   from there on. Each D1-D8 table should show first rung-3 date and flat share, and the final
   validator should treat D3 and H2 as censored when a run ended stuck. Other agents' figures may need
   checking for this, including their low-exposure results. I did not review them.
2. **Rung 3 is the operating halt, and -20% is almost never reached.** Mission Control and alerts
   should treat rung 3 as the main event. The contract's "-20% flatten" should not be assumed to be
   what limits loss in practice: at -15% the book is simply running off on its stops.
3. **Fix the rung 1-2 deadlock.** Flat, on rung 1 or 2, every entry under minNotional, and
   `humanReEnable` returns `nothing_to_clear`. It needs an alarm and a way out, or a refusal to start
   below the table's equity line. Lowering minNotional on the quarter rung may count as a loosening
   under decision 5.4, so that route needs a ruling.
4. **Pick one breaker cadence** for sim and live, or state the difference.
5. **Optional:** a human-policy option in runSim, reported separately from the headline result, so
   post-rung-3 behaviour can be measured without a wrapper.

### Limits of this work

- The evidence rests on about two bear markets and one path per config.
- References are long-only with shared universes, so R2, R3 and R4 are not independent.
- J, K, L, M, N and full weight are diagnosis only and count as no result.
- No test of multiple strategies sharing the risk budget, of 4h strategies, or of half-risk starts in
  simulation (the paper(half) figures above are arithmetic).
- The 30-day re-enable is a stand-in that always accepts; real human timing could be better or worse.

Reproduce: `node scripts/v6/research/r-risk.mjs sweep` (resumes, skips saved runs), then `study`, then
`wf`. Saved output is in `data/tmp/r-risk/`.
