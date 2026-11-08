VERDICT: NO EDGE, NOTHING FROZEN. All 4 pre-registered effects failed the event-study gate (none has a gross effect that beats round-trip costs with t >= 2 and stable halves), so by the pre-registered rule no walk-forward was run and D1-D8 were never reached. FROZEN_CANDIDATES is empty. 4 trials logged; global count now 490. Holdout not touched.

The pre-registration below is unchanged from before the first run, apart from this line and the results at the end.

# Research r-season: calendar and intraday seasonality, long or cash

Agent r-season. DEV only (to 2024-12-31). Holdout never unlocked or read. Global count before this
family: 486 logged trials in 12 families, 0 passes.

## Pre-registration (written before any data was examined)

### Why such an edge could exist

- **Session order flow (time of day).** US institutions, CME, US-listed products and US retail trade
  in US hours. If their net flow is persistently one-sided, returns would concentrate in the US
  session. The mirror case is Asia hours, when Asian exchanges dominated spot volume in 2018-2021.
- **Weekend liquidity.** Banks, OTC desks and US-listed products are shut at the weekend. Thin books
  could mean weekend moves carry volatility but no premium, so a weekday-only hold would keep most
  of the return with less risk.
- **Turn of month.** Month-end fund rebalancing, payroll and salary flows into savings plans and
  monthly DCA buys land around the turn of the month, the mechanism behind the classic equity effect
  (day -1 to +3).

Why it might not survive: these effects are widely published, so they may be arbitraged away, and
any intraday window costs a round trip per instance. Tier 1 is 0.26%, tier 2 0.36%, tier 3 0.70% per
round trip. A daily 8-hour window must earn about 0.3% per day gross just to break even, which is
roughly 100% a year before any profit. That is the main reason to expect a negative result.

### Deviation from the contract, declared up front

The contract says 1h is for stop-path fidelity, not entries, and `defineStrategy` refuses 1h
strategies. I do not work around that. 1h data is used only for the event study (measuring the
window returns). Every walk-forward runs through the real `runSim`/`v6Core` path on **4h** bars
(time-of-day windows are whole 4h bars) or **1d** bars (day windows). All windows below are chosen so
they are exact multiples of the decision bar.

### Universe

Point-in-time top N by trailing 30-day median quote volume (`pointInTimeUniverse`), dead coins
included, stablecoins excluded by the store. Event study: N = 15, equal weight, rebalanced daily.
Walk-forward: N in the grid.

### The four effects (exact definitions, all times UTC)

| ID | Effect | Held window | Decision bar |
|---|---|---|---|
| E1 | US session | 12:00 to 20:00 every day (two 4h bars) | 4h |
| E2 | Asia session | 00:00 to 08:00 every day (two 4h bars) | 4h |
| E3 | Weekdays only | Monday 00:00 to Saturday 00:00, flat over the weekend | 1d |
| E4 | Turn of month | open of the last calendar day of the month to the close of day +3 (4 days) | 1d |

Entries decide at the close of the bar before the window and fill at the window's first open; exits
decide at the close of the window's last bar and fill at the next open. So sim windows match the
event-study windows exactly.

### Step 1: event study (one trial per effect, 4 trials)

On 1h bars, 2018-01-01 to 2024-12-31, per window instance: basket gross return = equal-weight mean
of each coin's close-to-close return over the window (coins in the day's top 15 with full bars).
Cost per instance = basket mean round-trip cost from `tierFor` on that day. Reported per effect:
mean gross window return, mean cost, mean net, t-stat of the gross return, mean excess over the
unconditional basket drift for the same number of hours (and its t-stat), the two halves
(2018-2021, 2022-2024) separately, and the annualised Sharpe of the daily net series, which is
the logged trial Sharpe.

**Gate (all required) to walk-forward an effect:**
1. mean gross window return > mean round-trip cost, and
2. excess over unconditional drift > 0 with t-stat >= 2, and
3. the excess has the same sign in both halves.

The gate uses all of DEV, which overlaps the walk-forward's out-of-sample span (2020-2024). That is
selection, so the event studies are logged as trials and enter D2's count.

### Step 2: walk-forward (only for effects that pass the gate)

Harness: `walkForward`, trainDays 730, testDays 180, from 2018-01-01, so OOS is 2020-2024. Real
`v6Risk` sizing: risk per trade 1%, open risk 5%, max position 25%, cluster 50%, vol target 20%,
clamped to HARD_CEILINGS. Exits: signal only (no trail, time stop, break-even or regime exit) plus the
hard stop at entry: `stopDistancePct = min(0.15, 3 x 30-day daily vol)`. Costs per contract by tier.
`auditLookahead` with `rebuild` at the plateau centre.

Grids (coarse, fixed now):

| Effect | Grid | Combos |
|---|---|---|
| E1, E2 | topN {10, 20} x window length {4, 8, 12} hours from the fixed start hour | 6 |
| E3 | topN {10, 20} x flat days {Sun only, Sat+Sun, Fri+Sat+Sun} | 6 |
| E4 | topN {10, 20} x days after the turn {2, 3, 4} (day -1 fixed) | 6 |

Each combo is a logged trial. Budget: 4 + up to 24 = 28 of the 30 allowed.

### Decision rule

A run is a candidate only if `checkDevCriteria` passes D1-D8 with the global trial count and the
audit is clean. If one passes, its plateau-centre parameters go in `FROZEN_CANDIDATES` (max 2) and
research stops. No retuning after a failure, no extra effects, no new windows.

## Results

Run: `node scripts/v6/research/r-season.mjs study` (1h bars, 2018-01-01 to 2024-12-31, PIT top 15, 109
distinct coins ever listed, dead coins included). A day counts only when at least 5 basket coins have
both closes, which leaves 2,398 days. Unconditional basket drift: +0.099% per day.

| Effect | Hours | Instances | Mean gross | t gross | Mean RT cost | Mean net | Excess vs drift (t) | Excess 2018-21 / 2022-24 | Net Sharpe (ann.) | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| E1 US 12-20 UTC | 8 | 2,396 | -0.007% | -0.12 | 0.483% | -0.489% | -0.040% (-0.72) | +0.070% / -0.170% | -3.36 | FAIL |
| E2 Asia 00-08 UTC | 8 | 2,389 | +0.009% | 0.18 | 0.482% | -0.473% | -0.024% (-0.48) | -0.054% / +0.011% | -3.56 | FAIL |
| E3 Weekdays (flat Sat+Sun) | 120 | 342 | +0.245% | 0.45 | 0.484% | -0.239% | -0.249% (-0.46) | +0.081% / -0.644% | -0.17 | FAIL |
| E4 Turn of month (-1..+3) | 96 | 78 | +0.848% | 1.05 | 0.484% | +0.364% | +0.452% (0.56) | +2.089% / -1.558% | 0.17 | FAIL |

Gross vs net: the basket's mean round trip is about 0.48% (top 15 is mostly tier 2 and tier 3, not
just BTC/ETH). Both session windows earn roughly zero gross, so net is about -0.48% per day, -3.4 to
-3.6 Sharpe. Weekdays-only earns less than holding through the weekend would (negative excess).
Turn of month is the only effect whose gross mean beats cost, but at t = 1.05 on 78 months and with
the excess flipping sign between the halves (+2.1% then -1.6%), it is noise.

Trials: 4 (`data/research/v6/trials-r-season.jsonl`), one per event study, logged with the
annualised net Sharpe per instance. No walk-forward was run, so the D1-D8 table is empty for every
effect: nothing reached the harness. The script's strategy factories (4h for E1/E2, 1d for E3/E4)
build through `defineStrategy` but were deliberately not simulated.

### Caveats

- The gate used all of DEV, which overlaps the walk-forward out-of-sample span. It only stopped
  effects here, so the overlap cannot have produced a false pass.
- Equal-weight, close-to-close window returns ignore fill timing at the open and v6Risk sizing.
  These would only lower net returns further, and gross is already below cost for E1-E3.
- Fixed windows: other hours or days were not tested, by design. A scan across all 24 hours would
  be 24 more tests with no economic prior, and the data gives no reason to run them.
- 1h was used for measurement only. The contract still forbids 1h entries, and these results support
  that rule: an intraday round trip costs about 0.5% on this basket, and no daily window comes close
  to earning it.
