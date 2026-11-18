VERDICT: NOTHING FROZEN. No regime detector met the pre-registered freeze rule. BTC trend (n=100) shows some timing skill on passive holdings, but it adds nothing to the active entries tested, and that one result does not survive correction for the 12 detectors tried.

# r-regime: market regime detection

## Pre-registration (written before the first run, not edited afterwards)

**Hypothesis.** Crypto bear phases are persistent, because of leverage unwinds, falling liquidity and
high cross-coin correlation, so long entries there should have worse expectancy than in bull phases. A
slow market-state filter that blocks long entries, and closes longs in the worst state, should raise
risk-adjusted return, not just lower exposure. It can survive costs only if it flips a few times a
year. The honest alternative is that any filter that spends time in cash shrinks drawdown in
proportion to exposure, and misses sharp recoveries, with no timing skill at all.

**Detectors.** Each is stateless, reads closed bars only, and has a built-in neutral zone that acts as
hysteresis. All thresholds were set before running.

| Family | State | risk_on | risk_off | Grid (3 each) |
|---|---|---|---|---|
| T trend | BTC close against SMA(n) | above SMA x 1.03 | below SMA x 0.97 | n = 50, 100, 200 |
| B breadth | Share of point-in-time top 50 with close above own SMA(n) | >= 0.60 | < 0.40 | n = 50, 100, 200 |
| V vol | BTC realised vol 30d / 180d | ratio < off / 1.25 | ratio >= off | off = 1.25, 1.5, 2.0 |
| D drawdown | BTC close below its 365d high | dd < 0.75 x off | dd >= off | off = 0.20, 0.30, 0.50 |

Breadth returns `unknown` with fewer than 5 coins measurable.

**How a label acts.** risk_on: entries pass. neutral or unknown: no new entries, positions held.
risk_off: no new entries, and held longs get a flat signal. The flat signal fills at the next open, the
same timing as the exit engine's `regime_exit`. It is used because `runSim` overwrites `market.regime`
with `computeRegime` and offers no way to supply another regime.

**Reference entries.** Chosen for different styles, not for how they perform.

- R1 `hold`: always long BTC and ETH, 20% hard stop, signal-only exits. BTC and ETH are fixed because
  they are the contract's only Tier 1 coins. This is the pure timing test.
- R2 `mom`: top 20 point-in-time, long when 30d return > 0, ranked by it, flat when it is <= 0. 15%
  stop, trend profile.
- R3 `dip`: top 20 point-in-time, long after a 5d return below -15%, ranked by depth. 10% stop, revert
  profile.

The built-in regime exit is switched off in all of them, or the sim's BTC SMA200 regime would filter
every run, baselines included.

**Trials.** 12 detectors x 3 entries = 36, plus 3 unfiltered baselines, plus 3 runs with the engine's
default SMA200 regime exit left on = 42, under the cap of 50.

**Protocol.** 1d bars. Walk-forward from 2018-09-01 (so the 365d detectors are warm), 730d train, 180d
test, rolling. Real v6Risk at the HARD_CEILINGS: risk per trade 1%, open risk 5%, position 25%, cluster
50%, vol target 20%. All else default.

**Measures.** Time in market, average exposure, drawdown avoided, upside missed, next-day return by
label, flips per year, spell lengths. Timing against exposure is separated in two ways: a placebo that
circularly shifts the in-market series (same time in market, same flip count, timing destroyed; every
shift of at least 30 days), and a constant-exposure comparison at the same average time in market.
Placebos are controls and select nothing, so they are not logged as trials. Masked-stream figures are
diagnosis only.

**Freeze rule.** Freeze a detector only if ALL hold on the out-of-sample span, for the parameters most
often picked by walk-forward:

1. F1: Sharpe under real sizing beats the unfiltered baseline on at least 2 of 3 entries, and is no
   more than 0.10 worse on the third.
2. F2: Max drawdown is below the constant-exposure baseline's (baseline max drawdown x time in market)
   on at least 2 of 3 entries.
3. F3: Placebo p <= 0.05 for Sharpe, on the equal-weight top-20 stream.
4. F4: At most 12 label changes a year, and median spell at least 10 days.
5. F5: `auditLookahead` clean, with `rebuild`.

If two pass, freeze the higher mean Sharpe gain. D1-D8 is reported for the best filtered entry. A
filter is not a strategy, so passing F1-F5 certifies no strategy, and D1-D8 failures on a reference
entry are reported as they are.

## Results

Out-of-sample span: 2020-08-31 to 2024-12-31 (4.34 years, 9 folds). 42 trials logged, 42 unique, 264
across all agents at the time of the D2 check. `auditLookahead` with `rebuild` was clean on all 18 jobs.
`FROZEN_CANDIDATES` is empty.

The pre-registration above is unchanged apart from this file's first line. One smoke run on 2020 came
before the main run. It printed trade counts, exposure and exit reasons, not returns.

### Freeze rule

| Detector (most picked) | F1 Sharpe | F2 drawdown | F3 placebo | F4 flips | F5 audit | Result |
|---|---|---|---|---|---|---|
| T n=100 | FAIL | FAIL | PASS (p 0.026) | FAIL | PASS | Not frozen |
| B n=100 | PASS | FAIL | FAIL (p 0.096) | FAIL | PASS | Not frozen |
| V off=2 | FAIL | FAIL | FAIL (p 1.000) | FAIL | PASS | Not frozen |
| D off=0.3 | FAIL | FAIL | FAIL (p 0.080) | FAIL | PASS | Not frozen |

B's F1 pass is noise-sized: gains of +0.01, -0.02 and +0.06. V off=2 is a dead grid point: it was never
risk_off in the span, so the filter did nothing.

Sharpe under real sizing, fixed parameters, baseline to filtered:

| Detector | hold | mom | dip |
|---|---|---|---|
| T n=100 | 0.63 to 1.49 | 0.61 to 0.54 | -0.66 to -0.69 |
| B n=100 | 0.63 to 0.64 | 0.61 to 0.59 | -0.66 to -0.59 |
| V off=2 | 0.63 to 0.63 | 0.61 to 0.61 | -0.66 to -0.67 |
| D off=0.3 | 0.63 to 1.12 | 0.61 to 0.46 | -0.66 to -1.00 |

### The risk ladder confounds every real-sizing comparison

This matters more than any single figure here. Most runs stop trading long before the span ends, because
the -15% rung cannot clear once flat, and the -20% rung halts until a human re-enables. The simulator has
no human, so those runs sit in cash for the rest of the span.

| Entry | Filter | Last day with a position | Share of span live | Exposure while live |
|---|---|---|---|---|
| hold | none | 2021-05-23 (halted) | 17% | 24.1% |
| hold | engine | 2021-05-19 | 17% | 23.9% |
| hold | T | 2024-12-30 | 100% | 8.9% |
| hold | B | 2022-08-19 | 45% | 6.0% |
| hold | V | 2024-12-30 | 100% | 5.7% |
| hold | D | 2024-12-30 | 100% | 5.3% |
| mom | none | 2022-01-20 | 32% | 15.1% |
| mom | engine | 2022-02-20 | 34% | 13.7% |
| mom | T | 2023-08-16 | 68% | 9.0% |
| mom | B | 2024-12-30 | 100% | 7.8% |
| mom | V | 2022-01-20 | 32% | 11.9% |
| mom | D | 2023-06-13 | 64% | 6.5% |
| dip | none | 2022-04-28 | 38% | 3.3% |
| dip | engine | 2022-04-28 | 38% | 3.3% |
| dip | T | 2024-12-30 | 100% | 1.6% |
| dip | B | 2024-12-17 | 99% | 1.0% |
| dip | V | 2022-02-23 | 34% | 2.0% |
| dip | D | 2023-06-09 | 64% | 1.5% |

So the baselines above mostly describe 2020-21, and the filtered runs describe the whole span. Filtered and
unfiltered Sharpes are not like for like, and neither are their drawdowns, which the ladder caps near
15-22%. Staying alive is a real benefit of a filter under these rules, but it is path-dependent, and it is
not timing skill.

The check below compares each run only up to the day its baseline stopped. It is post hoc, uses saved
walk-forward equity with no new trials, and covers short, mostly bullish windows. It is evidence, not a pass.

| Filter | hold to 2021-05-23 | mom to 2022-01-20 | dip to 2022-04-28 |
|---|---|---|---|
| none | 1.54, DD 22.2% | 1.11, DD 15.3% | -0.98, DD 14.0% |
| engine | 1.81, DD 18.9% | 1.50, DD 11.7% | -1.01, DD 14.3% |
| T | 3.05, DD 8.5% | 0.51, DD 12.8% | -0.85, DD 9.5% |
| B | 1.38, DD 14.6% | 0.44, DD 11.5% | -0.83, DD 8.8% |
| V | 0.66, DD 6.3% | 0.70, DD 14.4% | -1.51, DD 15.6% |
| D | 2.58, DD 10.5% | 1.36, DD 9.8% | -1.25, DD 13.7% |

These are walk-forward runs, so parameters vary by fold. On this view T and B make `mom` worse, and T's
gain is confined to `hold`.

### Does a filter improve risk-adjusted results, or only reduce exposure?

Diagnosis only: full-weight masked streams, with switch costs of 0.13% (BTC) and 0.18% (top 20) per side.
Top-20 baseline: Sharpe 0.54, max drawdown 88%. BTC baseline: Sharpe 1.08, max drawdown 77%. "Const DD" is
baseline drawdown x time in market, which is what simply holding less would give.

| Detector | Time in | Top-20 Sharpe | Placebo p | DD | Const DD | Up missed | Down avoided | BTC Sharpe | BTC p | BTC DD |
|---|---|---|---|---|---|---|---|---|---|---|
| T n=50 | 56% | 0.84 | 0.047 | 64% | 49% | 44% | 49% | 1.41 | 0.014 | 54% |
| T n=100 | 61% | 1.13 | 0.026 | 53% | 54% | 38% | 45% | 1.57 | 0.034 | 35% |
| T n=200 | 61% | 0.65 | 0.197 | 72% | 54% | 39% | 42% | 1.22 | 0.138 | 52% |
| B n=50 | 44% | 0.74 | 0.077 | 51% | 39% | 53% | 57% | 0.70 | 0.456 | 54% |
| B n=100 | 45% | 0.77 | 0.096 | 54% | 40% | 50% | 55% | 1.02 | 0.186 | 54% |
| B n=200 | 54% | 0.73 | 0.127 | 56% | 47% | 42% | 45% | 1.06 | 0.214 | 57% |
| V off=1.25 | 76% | 0.04 | 0.980 | 92% | 67% | 30% | 24% | 0.47 | 0.974 | 77% |
| V off=1.5 | 95% | 0.42 | 0.890 | 88% | 84% | 7% | 6% | 0.90 | 0.908 | 79% |
| V off=2 | 100% | 0.55 | 1.000 | 88% | 88% | 0% | 0% | 1.08 | 1.000 | 77% |
| D off=0.2 | 52% | 0.64 | 0.237 | 70% | 46% | 52% | 54% | 1.21 | 0.170 | 43% |
| D off=0.3 | 59% | 0.94 | 0.080 | 56% | 52% | 42% | 48% | 1.37 | 0.142 | 54% |
| D off=0.5 | 77% | 0.68 | 0.243 | 78% | 68% | 23% | 25% | 1.11 | 0.277 | 64% |

- **BTC trend:** the only family with evidence of timing, and only on passive holdings. T n=100 cuts more
  downside than upside and beats its placebo on both streams. But p 0.026 does not clear a Bonferroni bar
  for 12 detectors (0.004). The neighbour n=200 shows nothing (p 0.197), so this is not a broad plateau.
- **Breadth:** mostly exposure reduction. Sharpe rises on the top-20 stream, not on BTC, drawdown stays above
  the constant-exposure level, and upside missed nearly matches downside avoided.
- **Drawdown state:** weak. D off=0.3 has a good drawdown placebo on the top-20 stream (p 0.001), but not on
  BTC (p 0.304), and its Sharpe placebo fails on both.
- **Realised vol:** harmful. High-vol labels came before the best returns (risk_off next-day mean +206% a year
  at off=1.25, t 1.61), so the filter sat out rebounds. This is the wrong sign for the hypothesis.
- **Active entries:** on the `mom` and `dip` engine streams no detector beat its placebo at 0.05 (lowest p
  0.228). `mom` already leaves on its own 30d rule, and `dip` loses money in every regime tested.

Next-day returns by label are noisy. For T n=100 on the top 20, risk_on averages +113% a year (t 2.10) and
risk_off -42% (t -0.52). Other windows are not monotonic: T n=50 has neutral at -143%, and B n=200 has neutral
at +170%. Treat the label ordering as weak.

### Flips

| Detector | on / neutral / off | Changes a year | To risk_off a year | In/out switches a year | Median spell | Spells of 5d or less | Engine regime_exits (4.3y) |
|---|---|---|---|---|---|---|---|
| T n=50 | 49 / 17 / 35% | 35.3 | 9.7 | 9.0 | 3 | 69% | 20 |
| T n=100 | 53 / 12 / 35% | 24.2 | 5.3 | 3.7 | 3 | 66% | 8 |
| T n=200 | 59 / 6 / 35% | 15.9 | 4.6 | 3.2 | 3 | 67% | 7 |
| B n=50 | 40 / 13 / 48% | 41.9 | 11.8 | 9.4 | 2 | 76% | 21 |
| B n=100 | 41 / 14 / 46% | 29.5 | 7.6 | 4.6 | 2 | 71% | 10 |
| B n=200 | 46 / 14 / 40% | 22.8 | 5.8 | 2.3 | 3 | 67% | 5 |
| V off=1.25 | 59 / 27 / 14% | 23.0 | 6.0 | 3.7 | 6 | 47% | 8 |
| V off=1.5 | 79 / 19 / 2% | 13.4 | 0.7 | 0.9 | 9 | 47% | 2 |
| V off=2 | 100 / 0 / 0% | 0.9 | 0.0 | 0.0 | 7 | 40% | 0 |
| D off=0.2 | 43 / 12 / 45% | 27.0 | 4.6 | 4.6 | 2 | 72% | 10 |
| D off=0.3 | 57 / 6 / 37% | 11.1 | 3.0 | 1.4 | 4 | 65% | 3 |
| D off=0.5 | 68 / 12 / 20% | 6.5 | 1.4 | 0.9 | 7 | 41% | 2 |

Engine exits come from feeding each label series through the real `evaluateExit`, with a long reopened at
each risk_on. No detector met F4's median spell of 10 days. Most changes are jitter in and out of the neutral
band: raw label changes are several times the real in/out switches (T n=100: 24.2 against 3.7). F4 measured
label changes, so a rule on switches would have been kinder, but T n=100 would still fail F1 and F2.

Any regime used for exits should still get a dwell or wider band. The band did not stop short spells, and a
strategy that enters in neutral would be exposed to every neutral-to-risk_off step.

### D1-D8

Nothing was frozen, so this is the best filtered entry, as pre-registered. It certifies nothing.

`hold` + T, walk-forward (mostly n=100):

| | Result | Value | Need |
|---|---|---|---|
| D1 | PASS | Sharpe 1.40, 90% CI [0.66, 2.06] | >= 0.80, CI low > 0 |
| D2 | FAIL | 0.250, 264 trials | >= 0.90 |
| D3 | PASS | 8.5% | <= 30% |
| D4 | FAIL | 19 closed trades | >= 100 |
| D5 | PASS | +78.3% at 2x costs | > 0 |
| D6 | FAIL | worst neighbour 0.74 vs 1.49 | >= 50% |
| D7 | FAIL | ETH 66.9%, 2021 62.6% | coin <= 35%, year <= 60% |
| D8 | PASS | Calmar 1.70 vs 0.79, Sharpe 1.40 vs 1.03 | better Calmar or Sharpe |

No run of the 18 passed all eight. D2 failed on every one. `mom` + B fails D1, D2 and D6, and `mom` + engine
fails D1, D2, D6 and D7.

### Returns, exposure and costs (walk-forward, real sizing, starting equity 10,000)

| Entry | Filter | Sharpe | Return | Max DD | Trades | Avg exposure | Fees | Slippage | Stop gaps | 2x-cost return |
|---|---|---|---|---|---|---|---|---|---|---|
| hold | none | 0.63 | 32.5% | 22.2% | 3 | 4.0% | 6 | 2 | 0 | 32.0% |
| hold | engine | 0.74 | 38.1% | 18.9% | 3 | 4.0% | 7 | 2 | 0 | 37.5% |
| hold | T | 1.40 | 79.8% | 8.5% | 19 | 8.9% | 32 | 10 | 0 | 78.3% |
| hold | B | 0.55 | 19.1% | 15.0% | 13 | 2.7% | 9 | 3 | 0 | 18.5% |
| hold | V | 0.24 | 5.0% | 11.7% | 17 | 5.7% | 10 | 5 | 0 | 4.8% |
| hold | D | 1.07 | 54.5% | 11.1% | 19 | 5.3% | 17 | 6 | 0 | 53.6% |
| mom | none | 0.61 | 31.7% | 16.0% | 293 | 4.8% | 179 | 257 | 27 | 10.8% |
| mom | engine | 0.76 | 43.1% | 15.5% | 275 | 4.7% | 222 | 297 | 49 | 19.0% |
| mom | T | 0.20 | 6.9% | 15.5% | 441 | 6.2% | 194 | 327 | 24 | 2.7% |
| mom | B | 0.58 | 34.3% | 13.5% | 445 | 7.8% | 224 | 335 | 38 | 38.3% |
| mom | V | 0.37 | 13.8% | 15.3% | 240 | 3.8% | 132 | 178 | 4 | 17.0% |
| mom | D | 0.64 | 31.9% | 15.1% | 220 | 4.2% | 160 | 250 | 46 | 11.1% |
| dip | none | -0.66 | -15.0% | 15.0% | 311 | 1.3% | 226 | 324 | 61 | -15.7% |
| dip | engine | -0.67 | -15.4% | 15.4% | 314 | 1.3% | 227 | 325 | 61 | -15.9% |
| dip | T | -0.59 | -13.6% | 14.8% | 410 | 1.6% | 239 | 398 | 42 | -15.3% |
| dip | B | -0.57 | -10.6% | 13.3% | 249 | 1.0% | 173 | 255 | 15 | -14.7% |
| dip | V | -0.93 | -15.6% | 15.6% | 193 | 0.7% | 122 | 185 | 48 | -14.7% |
| dip | D | -0.92 | -16.2% | 16.2% | 217 | 0.9% | 156 | 254 | 34 | -15.2% |

Delisting haircuts were zero in every run. Some 2x-cost returns exceed the 1x figure (`mom` + B, `mom` + V,
`dip` + V). Higher costs change the path, and so when the ladder locks, which is another sign of how much
the ladder drives these numbers.

Per-year returns:

| Entry | Filter | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|
| hold | none | 11.5% | 18.8% | 0.0% | 0.0% | 0.0% |
| hold | engine | 11.5% | 23.8% | 0.0% | 0.0% | 0.0% |
| hold | T | 10.9% | 45.1% | -0.7% | 6.6% | 5.6% |
| hold | B | 2.9% | 16.3% | -0.4% | 0.0% | 0.0% |
| hold | V | 3.6% | 4.9% | -7.7% | 1.8% | 2.8% |
| hold | D | 11.5% | 36.3% | 0.0% | 0.8% | 0.8% |
| mom | none | 19.3% | 15.1% | -4.1% | 0.0% | 0.0% |
| mom | engine | 19.3% | 30.8% | -8.3% | 0.0% | 0.0% |
| mom | T | 8.1% | 2.0% | -1.4% | -1.7% | 0.0% |
| mom | B | 4.5% | 4.0% | 0.0% | 18.5% | 4.2% |
| mom | V | 1.1% | 17.6% | -4.3% | 0.0% | 0.0% |
| mom | D | 19.3% | 21.3% | -6.5% | -2.5% | 0.0% |
| dip | none | -5.4% | -3.7% | -6.7% | 0.0% | 0.0% |
| dip | engine | -5.4% | -4.0% | -6.8% | 0.0% | 0.0% |
| dip | T | -5.4% | -1.7% | -4.3% | -1.1% | -1.7% |
| dip | B | -1.9% | -4.1% | -4.8% | -0.8% | 0.5% |
| dip | V | -6.1% | -7.9% | -2.3% | 0.0% | 0.0% |
| dip | D | -3.2% | -8.6% | -1.7% | -3.6% | 0.0% |

2020 is September to December only.

### What failed and why

- **Hypothesis:** not supported as a general filter. Support is limited to BTC trend on passive holdings.
- **Generality:** the freeze rule asked for gains on 2 of 3 entries, and no detector with a meaningful gain
  managed it. T and D help `hold` and hurt or do nothing for `mom` and `dip`.
- **Power:** 4.3 years hold about one full cycle, so the out-of-sample evidence rests on a handful of regime
  spells. Placebo p-values on so few spells are fragile.
- **`engine_*` placebo streams:** weak, because those baselines are flat for most of the span.

## Interface: what the code expects

`regime(ctx)` values match what `v6Exits` reads, with one wart. Nothing here needs a change for correctness
today, but items 1, 3 and 5 block real use of any custom regime.

1. **`runSim` cannot take a custom regime (mismatch).** `v6Sim.js` line 355 always sets `market.regime` to
   `computeRegime(...)`, so a regime function cannot reach `ctx.regime` or the exit engine in simulation.
   `step` would honour a supplied `market.regime`. This study applied labels inside the strategy instead.
   A `config.regimeFn` hook is needed if one is ever frozen.
2. **`unknown` is not a recognised word (minor).** It is missing from `REGIME_WORDS`, so `readRegime` treats it
   as unrecognised and raises the advisory `bad_regime` flag. Behaviour is right: nothing fires and `dataOk`
   stays true. Seen in this run on B n=100 and n=200. The same happens with `computeRegime`'s own
   `label: 'unknown'`. A legitimate state should not raise a bad-data flag.
3. **`computeRegime` returns an object and never `neutral` (mismatch).** It has two states with no band, while
   the requested shape is a four-value string. `readRegime` accepts both, so this is compatible, but any
   strategy reading `ctx.regime` directly must handle `{ label, riskOn }`, not a string.
4. **Hidden filter in the default profiles (affects other agents).** `trend` and `revert` have a regime exit on,
   so any strategy using them is exiting on BTC SMA200 with no band, unless it disables that. Results from
   other agents may include this without saying so. Measured here: `mom` 0.61 to 0.76, `hold` 0.63 to 0.74,
   `dip` no change, all under the lockout caveat above.
5. **Breadth has no universe to read (mismatch).** `step` computes one regime for all strategies, before any
   strategy's universe, and `ctx.universe` is per strategy. This study used `ctx.regimeUniverse`, which does
   not exist in the contract.
6. **Stuck rungs in research (needs a coordinator decision).** See the ladder section. The behaviour is
   documented in risk-engine.md, but long-span research results depend heavily on it. Any run reaching -15%
   is cash from then on, so a reported Sharpe can describe only the first part of a span.

Scratch: `data/tmp/r-regime/` holds `report.json`, `report.txt`, `render.mjs` and `lockout.mjs`.
