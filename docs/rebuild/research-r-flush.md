VERDICT: NO EDGE. Nothing qualified, nothing frozen (FROZEN_CANDIDATES is empty). Best run (E3) Sharpe 0.13 on 33 trades; D4 is structurally out of reach on 10 coins.

# Research r-flush: buying forced-liquidation flushes

## Pre-registration (written 2026-11-07, before any event count, return or trial was computed)

### Hypothesis and economic reason

A liquidation cascade is a burst of forced, price-insensitive selling: leveraged longs are closed
by the exchange's liquidation engine at whatever the book offers. Whoever absorbs that flow
(market makers, spot buyers) demands a discount, so price should overshoot fair value during the
flush and partly revert over the following days once the forced sellers are gone. The edge, if
any, is a liquidity premium paid by the liquidated, and it should be largest when the flush is
confirmed as forced (leverage visibly removed), not merely a price drop.

Null hypothesis: after costs, under real v6Risk sizing and real stops, buying after a confirmed
flush earns no more than buying after an equal price drop without confirmation, and D1-D8 fail.

### How this differs from plain mean reversion (r-revert, which found no edge)

1. **Conditioning on flow, not price.** r-revert entered on price alone (RSI, distance from an
   average, a high-volume drop). Here a drop qualifies only with a measured deleveraging: open
   interest in coins (not USD, which falls mechanically with price) down by a threshold over the
   same window, or perp funding swinging from strongly positive to negative. The claim is that
   these identify forced selling, which price alone cannot separate from news-driven selling.
2. **No uptrend filter.** Flushes happen in all regimes; r-revert required an uptrend, which
   made its capitulation experiment almost never fire.
3. **Pre-registered time exit**, not a snap-back to a moving average.
4. **A control is built in.** The event study compares confirmed flushes against drop-only
   events of the same size on the same coins. If confirmation adds nothing, this is just
   mean reversion again and the verdict is no edge, regardless of sim numbers.

### Data and point-in-time rules

- Spot 1d bars through `loadBars` (DEV only). Decisions at the daily close `ctx.t`, fills at
  the next open (simulator default).
- Open interest: `loadOpenInterest`, 10 majors (BTC from 2020-09, the other 9 from 2021-12),
  one sample per UTC day, usually 23:55. Only samples with `t < ctx.t` are used. OI is in coins.
- Funding: `loadFunding`, Binance USDT-M perps, mapped to spot with `perpToSpot`. Only events
  with `t < ctx.t` are used (an event stamped exactly at the close is excluded). Each rate is
  normalised to an 8h equivalent by its actual interval (never x3 per day).
- `auditLookahead` uses `rebuild`, cutting the OI and funding maps at the same instant as the bars.

### Event definition (fixed)

On coin i at close t (window W = 3 days):

- **Drop:** close(t) / close(t - 3 bars) - 1 <= -dropAtr x ATR(14) / close, where ATR is taken
  as of the bar before the window (lag 3), so the flush does not widen its own yardstick.
- **OI confirmation (`oi`):** OI(last sample before t) / OI(last sample before t - 3d) - 1 <= -oiDrop.
- **Funding confirmation (`fund`):** max 8h-equivalent funding over events in [t - 10d, t - 3d)
  >= fundHi, AND mean funding over events in [t - 1d, t) < 0.
- **New event only:** the full condition holds at t and did not hold at either of the two
  previous closes, so one flush gives one entry.
- Stop: 2 x ATR(14) at t (the profile default), min 1%; skip if it would exceed 20%.
- Exit: `revert` profile with overrides `timeStop { bars: H, minR: 0, maxBars: H }`, no strategy
  flat signals. Hard stop, trail, spike guard and the contract's regime exit stay as in the
  profile.
- Risk: real v6Risk at the same ceilings r-revert used (risk per trade 1%, open risk 5%, max
  position 25%, vol target 20%), plus the market breaker at its ceilings (BTC -10% in 24h,
  -20% in 7d). Reason: the default breaker (-8%/-15%) would block entries on exactly the days
  this hypothesis is about. It stays on, inside HARD_CEILINGS, and blocked signals are reported.
- Universe: point-in-time top 20 by the contract rule. For `oi` and `either` it is further
  restricted to coins with OI data (the 10 majors); for `fund` to coins with a perp. Caveat: the
  OI list is 10 coins that exist today, so it carries survivorship bias in favour of a long
  rule; the point-in-time top-20 filter only limits it.

### Grid and trials (max 50; planned 21 + up to 4 reserve)

| Exp | Confirmation | Universe | Grid | Trials |
|---|---|---|---|---|
| E0 | event study | OI10 / top-20 perps | descriptive; one fixed-param `runSim` of E1's centre (dropAtr 2, oiDrop 0.10, H 3) logged as one trial | 1 |
| E1 | `oi` | top20 n OI10 | dropAtr {2,3} x oiDrop {0.10,0.20} x H {3,7} | 8 |
| E2 | `fund` | top20 with perp | dropAtr {2,3} x fundHi {0.0003,0.0006} x H {3,7} | 8 |
| E3 | `either` (oi OR fund) | top20 n OI10 | dropAtr {2,3} x H {3,7}; oiDrop 0.10, fundHi 0.0003 | 4 |

Event study (E0) reports, for each event set, count and mean / median forward return from the
next open over 1, 3, 5 and 10 days, net of the Tier round trip: (a) `oi` flushes, (b) `fund`
flushes, (c) drop-only events with the same drop rule on the same coins (the mean-reversion
control), (d) all coin-days. Spans: OI10 from 2020-09 / 2021-12; top-20 perps from 2020-01;
all to 2024-12-31.

Walk-forward: rolling, trainDays 365, testDays 180, objective Sharpe, minTrainTrades 10.
E1 and E3 start 2021-01-01 (OOS from 2022-01; alts have OI only from 2021-12, so early folds
are BTC-only); E2 starts 2020-01-01 (OOS from 2021-01). The shorter train than other families
(730) is forced by OI coverage and fixed before running.

Reserve (only if the best experiment's walk-forward Sharpe >= 0.5): up to 4 fixed-parameter
diagnostics on its most-picked parameters (stop 3 ATR; BTC+ETH only; default breaker; H 5).
These can never become candidates.

### Decision rule

- A candidate is frozen only if its walk-forward result passes all of D1-D8 with the global
  trial count, `auditLookahead` is clean, AND the event study shows the confirmed flush beating
  the drop-only control at the chosen horizon. Then FROZEN_CANDIDATES gets it and research stops;
  holdout is not touched.
- **D4 feasibility, stated in advance:** flushes are rare and OI covers 10 coins with about
  three years of DEV history, of which walk-forward leaves about three years out of sample. If
  the OOS trade count is far below 100, D4 is structurally out of reach for the OI variants and
  that is reported as a failure. D4 is not lowered.
- Anything else: no edge, nothing frozen.

## Results (added after the runs; no rule changed after the first run)

21 trials logged in `data/research/v6/trials-r-flush.jsonl` (E0 1, E1 8, E2 8, E3 4). Reserve not
used: no experiment reached walk-forward Sharpe 0.5. Global trial count at judging: 439 (other agents
were logging in parallel). `auditLookahead` with `rebuild` (bars, OI and funding cut together) was clean
on E1, E2 and E3. One process, about 20 seconds per experiment. Holdout not touched.

### E0 event study (DEV, net of the tier round trip, entry at next open)

| Event set | n | 1d | 3d mean (median, win) | 5d | 10d |
|---|---|---|---|---|---|
| all coin-days, OI10 | 10,420 | -0.29% | -0.09% (-0.36%, 47%) | +0.14% | +0.74% |
| drop-only 2 ATR, OI10 (control) | 192 | -1.39% | -2.09% (-1.09%, 41%) | -2.59% | -1.37% |
| oi flush 2 ATR / OI -10% | 85 | -0.49% | -0.05% (+0.09%, 54%) | -0.83% | -0.35% |
| drop-only 3 ATR, OI10 (control) | 81 | -1.15% | -0.89% (+0.04%, 51%) | -2.11% | -0.50% |
| oi flush 3 ATR / OI -10% | 43 | +0.43% | +0.79% (+0.59%, 67%) | -0.66% | +0.95% |
| all coin-days, top-20 perps | 36,306 | -0.30% | +0.04% (-0.52%, 47%) | +0.42% | +1.32% |
| drop-only, top-20 perps (control) | 627 | +0.53% | -0.48% (-0.34%, 48%) | -1.87% | -1.14% |
| fund flush, top-20 perps | 47 | +6.39% | +0.19% (-2.81%, 45%) | +1.20% | -0.06% |

Reading: OI confirmation does separate flushes from plain drops: confirmed events lose about 2 points
less over 3 days than the drop-only control, which is the direction the hypothesis predicts and the
one way this differs from r-revert. But the confirmed events themselves earn roughly zero after costs,
below the unconditional drift at 5 and 10 days, so the "overshoot" is not large enough to pay. The
3 ATR subset looks better (+0.79% at 3d) on 43 events, which is too few to separate from noise, and it
is the best of eight rows. The funding flush 1d mean (+6.4%) is outlier-driven (median -2.8%); 44 of
47 events are in 2020-21, 0 in 2022, 3 after.

E0 fixed-parameter sim (dropAtr 2, OI -10%, H 3, 2020-09 to 2024-12): Sharpe -0.50, -5.9%, 69 trades;
2022 -6.6%. The market breaker tripped 15 times.

### D1-D8, walk-forward OOS

| | E1 oi (2022-01..2024-12) | E2 fund (2021-01..2024-12) | E3 either (2022-01..2024-12) |
|---|---|---|---|
| D1 Sharpe (90% CI) | 0.11 [-0.68, 1.01] FAIL | 0.00 FAIL | 0.13 [-0.66, 1.01] FAIL |
| D2 DSR (439 trials) | 0.000 FAIL | 0.000 FAIL | 0.000 FAIL |
| D3 max DD | 5.0% pass | 0.0% pass | 5.0% pass |
| D4 trades | 32 FAIL | 0 FAIL | 33 FAIL |
| D5 at 2x costs | -0.4% FAIL | 0.0% FAIL | -0.2% FAIL |
| D6 plateau | FAIL (-0.60 vs -0.51) | FAIL (nothing picked) | FAIL (-0.62 vs -0.49) |
| D7 concentration | ETH 302%, 2024 148% FAIL | no profit FAIL | ETH 251%, 2024 123% FAIL |
| D8 vs buy-and-hold | pass (Calmar 0.07 vs -0.06) | FAIL | pass (Calmar 0.08 vs -0.06) |

Returns: E1 +1.0% total (2022 0.0%, 2023 -0.5%, 2024 +1.5%), exposure 1.2%, fees 56 and slippage 61
on 10,000, no stop gaps. E3 +1.2%, exposure 1.3%. The first two folds of E1/E3 sat in cash (BTC-only
OI before 2021-12, under 10 train trades). All E1 fixed-parameter trials have negative OOS Sharpe
(-0.18 to -0.60), so the small positive walk-forward figure comes from fold switching, not a stable rule.
E2 sat in cash in every fold: funding flips after strongly positive funding almost vanished after 2021
(0 to 4 OOS trades per parameter set).

### What failed and why

- **No usable edge.** Confirmation improves on a plain drop but the improved result is still about zero
  net of costs. Gross P&L in E1 is about +220 on 10,000 over three years: cheaper execution would not
  rescue it.
- **D4 is structurally out of reach.** OI exists for 10 coins, 9 of them only from 2021-12. Even the
  loosest definition gives about 20-30 OI-confirmed events a year across all ten, and walk-forward
  leaves about three years out of sample. 100 trades is not reachable without more coins or more
  history. D4 was not lowered.
- **The risk engine removes part of the event set by design.** Even at the ceilings (BTC -10%/24h,
  -20%/7d) the breaker blocks entries on the biggest market-wide flushes, which is also why the fund
  event study (47) and sim (4 OOS) counts differ so much.
- **Caveats.** The OI list is 10 coins that survive today (bias in favour of a long rule). Daily OI
  sampling (one 23:55 sample) misses intraday flushes that revert before the close. Funding is Binance
  only. Stop fills on a 24/7 market show no gap, so the tail is understated, as in r-revert.
