# Harness fixes and what they changed

Owner: core-sim. Measured by `scripts/v6/rerun-registered.mjs`: 34 tasks, none failed, 3 workers. Results are in
`data/research/v6/remeasure/report.txt` and `verdicts.jsonl`. These are re-measurements, not new trials, and
`trials-*.jsonl` was not touched.

**Result: 0 of 56 walk-forward runs pass D1-D8, so no family's "nothing qualifies" verdict changed.** The freeze
did matter. It hid large drawdowns in several logged trials, so logged `maxDrawdown` and Sharpe figures should
not be quoted for frozen runs.

## Summary of impact

| Bug | Logged numbers affected | How much |
|---|---|---|
| 1. Grid `universe.n` ignored out of sample | None found | None |
| 2. Ladder freeze | At least 86 of 385 trials | Large |
| 3. First pick's `warmupBars` kept | None found | None |
| 4. Regime window 200 bars on 4h | 41 logged 4h trials | Not separated from bug 2 |

"None found" is judged from the scripts as they stand now. Some were edited after their trials were logged, so an
earlier version could have differed. Logged trial lines come from fixed-parameter runs, which never used the fold
switcher. Bugs 1 and 3 could only ever reach `oos` and `stress2x`.

## Bug 1: universe in a grid

Confirmed and fixed. `scheduledStrategy` spread `base`, so the out-of-sample run kept the first pick's universe.
`runSim` now calls `atBar` before each step, and `universe` and `warmupBars` are the fold's own. `walkForward`
throws if a grid changes anything it cannot switch: `id`, `timeframe`, `perp`, `slowAllocator` or `version`.

Exposure, by script:

- `r-xsmom`: `GRID` has no universe key. `top20` and `top50` are stage 2 `runSim` runs, so they were honoured.
- `r-breakout`: `topN` is in the W1 grid, but the script holds `universe.n` at 30 and slices `ctx.universe`.
- `r-trend`, `r-regime`, `r-revert`, `r-exits`, `r-risk`: the universe is constant across each grid.
- `r-carry`: the pair simulator does not use this path, and the overlay grid is `crowdApr` only.

One thing remains: a key read only inside `signals` cannot be proved used. With a universe in the grid, the
benchmark uses the first pick's universe, now recorded as `benchmark.universe`.

## Bug 2: ladder freeze

Confirmed and fixed. A flat book at rung 3 or 4 had flat equity forever, and only a human could clear it.
`runSim` and `walkForward` now take `simReEnable`, default `{ afterDays: 30 }`, and `false` restores the old
behaviour. It calls `humanReEnable` once a rung has blocked entries for that long **and** the book is flat.
Manual and fail-safe halts are never cleared. The live engine is unchanged.

Reported in `summary`: `simReEnables`, `reEnables[]`, `finalRung`, `stuckAtEnd`. `summary.halted` still means
flatten only, so `stuckAtEnd` is what shows a run stuck at either rung. The criteria report prints both.

`summary.maxDrawdown` was already taken from the equity curve's all-time high, which a re-enable does not touch.
D3 uses it, and a test proves two halts stack past 25%.

Logged trials the old harness froze, meaning they needed at least one re-enable on re-measurement:

| File | Logged | Re-measured | Frozen | Sharpe moved > 0.01 | Largest shift |
|---|---|---|---|---|---|
| `trials-r-breakout.jsonl` | 50 | 50 | 10 | 21 | 0.43 |
| `trials-r-carry.jsonl` | 45 | 41 | 6 | 6 | 0.17 |
| `trials-r-exits.jsonl` | 50 | 47 | 14 | 14 | 0.80 |
| `trials-r-regime.jsonl` | 42 | 42 | 27 | 27 | 0.49 |
| `trials-r-revert.jsonl` | 50 | 50 | 13 | 18 | 1.45 |
| `trials-r-risk.jsonl` | 50 | 50 | 3 | 18 | 1.38 |
| `trials-r-trend.jsonl` | 48 | 48 | 7 | 12 | 0.42 |
| `trials-r-xsmom.jsonl` | 50 | 48 | 6 | 7 | 0.30 |

The frozen column is a floor. Trials built by hand from a summary do not report re-enables, and that hides most of
`r-risk`: its 18 moved Sharpes are the better guide there. Nine trials could not be matched to a re-measurement.

Largest cases, old against new:

| Trial | Sharpe | Max DD | Closed trades |
|---|---|---|---|
| `revert-dist-4h-E5`, maN 30, trendN 1200 | -1.18 to -2.63 | 15% to 64% | 272 to 2,037 |
| `revert-rsi-4h-E4`, rsiLen 4, trendN 1200 | -0.96 to -2.21 | 15% to 64% | 360 to 2,363 |
| `ref_mom20`, config I | -0.77 to 0.61 | 9% to 24% | 68 to 1,286 |
| `ref_rand20`, config I | -0.23 to 0.85 | 9% to 26% | 70 to 437 |

The freeze cut both ways. It capped losing strategies at about 15%, and it stopped others before a recovery. The
`r-risk` calibration conclusions rest on such runs, so they should be re-read against the new figures. That
includes the random-entry control, which now shows Sharpe 0.85 at the logged config I.

## Bug 3: warmup

Confirmed and fixed by the same change as bug 1. No logged run was affected, because `warmupBars` is constant across
every grid. `r-breakout` uses `max(n + 2, 110 or 220)`, and its largest `n` stays under the floor on both timeframes.
`r-trend` held it constant deliberately.

r-trend's report of four runs that stopped trading is bug 2, not bug 3.

## Regime

**Hook.** `config.regimeFn({ t, barT, bars, ind, universe, defaultRegime })` replaces the default regime for
`ctx.regime` and exits. `universe` is the union of the strategies' universes, so breadth is possible. Returning
nothing throws.

**Window.** The default is now 200 days on any timeframe, 1,200 bars on 4h, where it was about 33 days. This changes
4h results: 15 lines in `r-breakout`, 20 in `r-revert`, 3 in `r-exits`, 3 in `r-trend`. Its effect was not separated
from bug 2. The `step` fallback in `v6Core.js` still uses 200 bars. The simulator never reaches it, but a live 4h
caller would, so b-gate should change it.

**Undeclared filter.** The default `trend` and `revert` profiles include a BTC SMA200 regime exit that research
configs did not state. It stays on. `summary.regimeExits` and `regimeExitPnl` now report it, summed over each
family's out-of-sample runs:

| Family | Regime exits | P&L |
|---|---|---|
| r-trend | 325 | +416 |
| r-risk | 126 | +2,647 |
| r-breakout | 104 | -256 |
| r-carry | 101 | +4,821 |
| r-regime | 82 | +9,452 |
| r-xsmom | 38 | -198 |
| r-revert | 20 | -298 |
| r-exits | 2 | -23 |

P&L is what those exits realised, not what the rule added or saved.

**`unknown` was not added to `REGIME_WORDS`.** That is not the whole fix. A word there gets a bias, so `unknown` would
set a neutral baseline and a later change to risk-off would fire a regime exit that does not fire today. The
`bad_regime` flag it raises is advisory only, so `v6Exits.js` was left alone. The right fix is one line in
`readRegime`, returning `known: true, hasBias: false` for that word, and it needs its owner's agreement.

## -17.5% rung

Neither a ladder bug nor hysteresis. It is r-breakout's declared config, ladder 7.5/12.5/17.5/20, the maximum
`clampRiskConfig` allows. The default stays -15%. Hysteresis only delays easing, by `ladderRecoveryPct`.

## D2 in the re-measurement

The final step recomputes D2 for every run from all 385 logged trials, using re-measured Sharpes where they exist.
`trials-example.jsonl` is excluded as a demo. Run order cannot change a verdict. Thresholds are unchanged.

Failures across the 56 runs: D2 53, D7 50, D8 41, D1 36, D6 24, D5 13, D4 9, D3 5. Runs that fail only D2:
`brk_volume_1d`, `exit-breakout`, `ref_brk20`.

**The coordinator should decide how to treat this.** Pooled trial Sharpe spread is 1.56, driven by `r-carry`'s pair
simulator, which logs Sharpes up to 8.58. Without `r-carry` it is 0.58. All non-carry DSRs round to 0.000 with it. The 0.288 sensitivity figure first quoted here was wrong; see Corrections after audit. The verdict holds both ways. Carry's Sharpes of 6 to 8 come from a simulator outside `runSim`, and
should be treated with suspicion until reviewed. All three carry universes fail D7.

## Limits of this measurement

- Shifts combine every change since logging: bug 2, the 4h window, and b-gate's `v6Core.js` edits. They are not
  attributed to one cause.
- `r-exits` 4h confirmation runs were not rerun, as they are not logged trials.
- `rerun-registered.mjs` was checked by this one full run. It has no test of its own.

## Corrections after audit

An independent audit recomputed D1, D3, D7 and D8 by hand on three runs and D2 on all 56. **0 of 56 still stands.**

- **D2 units fixed.** `trialStats` pooled per-period Sharpes across 1d and 4h trials, which mixed units. It now pools annual Sharpes and converts once to the period of the run being judged. The 0.90 threshold did not change. Verdicts were re-derived: 0 of 56 pass, 385 trials. The previous file is `verdicts.pre-d2-unit-fix.jsonl`.
- **The 0.288 figure was wrong.** It used stale logged Sharpes and N=340, not the global 385. On that same spec the best were crowd-flat 0.384 and rr-hold-T 0.362. With correct units, every non-carry DSR is at or below 0.14 excluding carry from the spread. The three D2-only runs would need a trial spread of 0.14 or less; measured is 0.53 to 0.65.
- **Carry DSR of 1.000 is overstated.** Daily carry returns are autocorrelated (AC1 0.48 to 0.63). On monthly returns DSR is about 0.17 to 0.64 at a spread of 0.65. Carry fails D7 regardless and did not run through `runSim`.
- Carry pair Sharpes inflate the pooled spread, so non-carry DSRs print as 0.000 in `verdicts.jsonl`. Read those as "below 0.14", not as exactly zero.

## Final re-measurement on final shared code

`rerun-registered.mjs --fresh` on the final shared modules (stop-order fix, D2 units fix, new exit profiles). **0 of 56 pass, 385 trials.** Previous set: `data/research/v6/remeasure-pre-final/`.

- 40 of 56 Sharpes moved by more than 0.01, and 17 runs now fail a different set of criteria. The stop-order fix measured no backtest effect, so the likely cause is the new default exit profiles. This was not separated run by run.
- Examples: `brk_donchian_1d` 1.16 to 0.67, `brk_donchian_4h` 0.81 to 1.01, `exit-random` 0.86 to 0.47.
- Runs now fail only one criterion: `carry-majors`, `carry-top10`, `carry-top20` (D7) and `ref_brk20`, `exit-breakout` (D2). `ref_brk20` and `exit-breakout` are controls, not candidates, and D2 is far from met.
- The exit profiles came from random-entry tests. They are not a proven improvement for any given strategy, and they must not be tuned against these numbers. These re-measurements add no new trials to the count, but the sensitivity is itself evidence that no result here is robust.
