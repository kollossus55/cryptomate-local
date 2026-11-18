# V6 spot data: quality report (agent data-spot)

Source: Binance public spot klines, USDT pairs only. All statistics below are DEV
(bars before 2025-01-01). Holdout content was not analysed: only row counts and coverage dates appear here.

## What the store contains

Measured 2026-11-06. Row counts are after cleaning.

| Part | Timeframe | Store ids | Rows | Newest bar (UTC) |
|---|---|---|---|---|
| DEV | 1d | 466 | 524,171 | 2024-12-31 00:00 |
| DEV | 4h | 466 | 3,143,280 | 2024-12-31 20:00 |
| DEV | 1h | 466 | 12,566,469 | 2024-12-31 23:00 |
| Holdout | 1d | 500 | 271,215 | 2026-11-04 00:00 |
| Holdout | 4h | 500 | 1,628,402 | 2026-11-05 16:00 |
| Holdout | 1h | 500 | 6,513,726 | 2026-11-05 20:00 |

**DEV is complete** on all three timeframes: 0 failed symbols. `READY-1d.flag`, `READY-4h.flag`
and `READY-1h.flag` are written. DEV 1d and 4h were not changed after those flags went up
(checksum identical before and after the final 1h and holdout builds).

**1h covers every pair, not the top 60 in the brief.** Choosing 60 coins by volume would have
put selection bias back into stop-path checks, and fetching all of them took about 20 minutes.
1h has had less checking than 1d and 4h: it was not reconciled against them or compared to OKX.

**The holdout is complete from 2025-01-01 up to the newest bars above, but it is not current.**
It was last extended on 2026-11-05 at about 21:42 UTC. On 2026-11-06 at 11:25 UTC it was one
closed 1d bar, three closed 4h bars and 14 closed 1h bars behind. All 396 pairs with TRADING
status reach the newest bar on every timeframe, there are 0 failed symbols, and timestamps
are in strict order in every file. To bring it up to date before any holdout run:

```
node scripts/v6/fetch-spot.mjs --discover
node scripts/v6/fetch-spot.mjs --fetch --phase holdout --tf 1d,4h,1h --refresh
node scripts/v6/fetch-spot.mjs --build --phase holdout --tf 1d,4h,1h
```

No holdout run has used this data, and the unlocked path has only been tested on a fixture,
because the real token is not available to this agent. Holdout `listing_spike` flags can
mislabel a wick on a pair's first 2025 bar, since that bar is first in its file.

## How to use it

```js
import { loadBars, pointInTimeUniverse, tierFor, symbolInfo, barFlags, listSymbols } from '../shared/trading/v6Bars.js';
```

- `loadBars({ symbols?, timeframe, from?, to? })`: closed bars, `from <= t <= to`. Omitting `to`
  stops at the end of the view. Symbols with no bars in range are left out of the Map.
- `pointInTimeUniverse(t, { topN?, timeframe? })`: best first, using only days closed by `t`.
  A coin needs 200 closed daily bars, a bar on the last closed day and a non-zero median.
- `tierFor(symbol, t)`, `medianQuoteVolume(symbol, t)`: missing days count as zero volume.
- `symbolInfo(symbol, { timeframe? })`: `firstBarT, lastBarT, lastClose, barCount, delisted,
  deathKind ('delisted' | 'migrated' | null), migratedTo`. This is the input to the rule
  "a coin that delists exits at its last close minus 10%".
- `barFlags(symbol, { timeframe? })`: `[{ t, kinds }]`.

Rules a consumer must know:

- **`t` past DEV throws while locked**, in `loadBars`, `pointInTimeUniverse`, `tierFor` and
  `medianQuoteVolume`. That includes `t === HOLDOUT_START` exactly, so a simulator stamping
  the last DEV bar with its end time must use `closeTime` (`...59.999`), not the next open.
  `tierFor` for BTC and ETH never throws, as it needs no data.
- **The view hides the future.** Locked, a coin that died in 2025 reports `delisted: false`
  and a coin listed in 2025 does not exist.
- **Bars are shared and cached.** Treat them as read-only.
- **`LUNAUSDT~2` is a store id, not a ticker.** See "Ticker reuse" below.

## Discovery and dead-coin recovery

| Source | USDT pairs |
|---|---|
| `exchangeInfo` (518 TRADING, 257 BREAK) | 775 |
| Extra in the `data.binance.vision` bucket | 1 (NBTUSDT) |
| Probing the 79 other base assets known from any quote currency | 0 found |
| **Total ever discovered** | **776** |
| After exclusions (186 stable, fiat, wrapped, leveraged, tokenised stock) | **590** |

**Recovered: 194 of 194 non-trading pairs (100%) after exclusions, with bars for every one.**
465 of the 590 have DEV bars; the other 125 were listed from 2025 on.

`exchangeInfo` keeps delisted pairs as BREAK and klines still serves them, so REST covered
every symbol, including NBTUSDT, and the planned bucket-zip fallback was not needed. All
of about 50 well-known dead or renamed tickers I checked by hand were present (BCC, VEN, BCHSV, old
LUNA, UST, SRM, NPXS, MCO, KEEP, NU, ANC, HC, STORM and others).

There is no independent census of every pair Binance ever listed, so "100%" means 100% of
what Binance's own systems still know about. A ticker erased from all of them would be
invisible to this check. The probe finding zero suggests that set is small.

## Alive vs dead by year (DEV, after exclusions)

| Year | New listings | Delisted | Migrated | Alive at year end | Eligible at year end |
|---|---|---|---|---|---|
| 2017 | 6 | 0 | 0 | 6 | 0 |
| 2018 | 15 | 0 | 2 | 19 | 15 |
| 2019 | 65 | 1 | 1 | 82 | 41 |
| 2020 | 102 | 3 | 3 | 178 | 103 |
| 2021 | 123 | 0 | 3 | 298 | 222 |
| 2022 | 42 | 19 | 6 | 315 | 301 |
| 2023 | 52 | 11 | 3 | 353 | 329 |
| 2024 | 61 | 33 | 6 | 375 | 342 |

466 store ids in DEV, 91 dead by 2024-12-31 (67 delisted, 24 migrated). Dead coins are
19.5% of everything that ever traded in DEV.

How much this matters: of the point-in-time top 100 on 2021-01-01, 18 were really delisted
by the end of DEV; of the top 100 on 2022-01-01, 10 were. Top 50: 3 to 4 per starting year.
A sample built from today's top coins would have held none of them.

## Fixes applied to bars

Raw downloads stay in `dev/raw/` and `holdout/raw/`. The loader reads the cleaned files.

| Fix | 1d | 4h | Note |
|---|---|---|---|
| Duplicates removed | 0 | 0 | |
| Non-positive prices dropped | 0 | 0 | |
| OHLC inconsistencies repaired | 0 | 0 | |
| Trailing zero-volume bars stripped | 3 | 2 | BCC, KLAY: death is the last real trade (1h: 2) |

**Redenominations (8 pairs, prices back-adjusted, volume inverse-adjusted, `qv` unchanged).**
Binance does not adjust klines for token swaps. Unfixed, these are fake moves of up to 1000x.

| Pair | Date | Factor | Observed step |
|---|---|---|---|
| BNXUSDT | 2023-02-22 | 0.01 | 0.0100 |
| BTCSTUSDT | 2021-03-19 | 0.1 | 0.100 |
| COCOSUSDT | 2021-01-23 | 1000 | 1000 |
| DREPUSDT | 2021-04-02 | 100 | 100.0 |
| QUICKUSDT | 2023-07-21 | 0.001 | 0.001 |
| STRAXUSDT | 2024-03-28 | 0.1 | 0.100 |
| SUNUSDT | 2021-06-18 | 0.001 | 0.001 |
| VIDTUSDT | 2022-11-09 | 0.1 | 0.093 |

These are inferred from a power-of-ten step (within 12%) across a halt of 3 or more days,
not confirmed against announcements. Seven are exact. VIDT is the weakest: its 0.093 could
hide a genuine -7% move, which the adjustment keeps. Adjusted bars are not the prices shown
at the time, so absolute price levels before these dates are not historical quotes.

**Ticker reuse (2 pairs).** `LUNAUSDT` is old LUNA, dying at 0.00005 on 2022-05-13.
`LUNAUSDT~2` is the new coin from 2022-05-31, a 20,000x step that would otherwise be one bar.
A strategy listing `LUNAUSDT` gets the old coin. `VENUSDT` had a single empty bar at 0.0001
three months after its swap; it was dropped as a ghost, so VEN dies on 2018-07-23.

The same detector runs on the holdout, silently. Holdout events scale forward, so DEV files
never depend on holdout data. Nobody has reviewed what it did there, and it cannot be
reviewed without opening the holdout: the final validator should read
`holdout/events-1d.json` first.

## Flagged, not altered

| Flag | 1d | 4h | 1h |
|---|---|---|---|
| `listing_spike`: first bar, high over 4x body or low under 1/4 | 29 | 24 | 20 |
| `wick`: same test, later bars | 16 | 16 | 15 |
| `gap_before`: bars missing before this one | 11 | 281 | 3,002 |
| `zero_volume` | 0 | 149 | 6,597 |

Wicks are kept deliberately. LINK and RLC printed 0.0001 on 2020-03-12, and others printed
wicks of over 75%. These are real prints that I cannot prove wrong, and clipping them would
flatter stop-loss results. They will trigger stops in the simulator. The contract's fill rule
(worse of stop and open) then assumes a fill near the stop, which is optimistic on such a
bar: a real stop in that book would have filled far lower.

Listing bars are unreliable (for example ICP 249 to 2831, APT 1 to 100). The 200-day rule
keeps them out of universe strategies. A fixed-symbol strategy can still see them in warm-up.

**Gaps.** 1d has 11 gaps of 3 days or more and none shorter. After adjustment the steps
across them are about 1.0, except for three real halts: FTT (310 days, 2022-11 to 2023-09,
-32%), CVC (153 days, -9%) and KEY (27 days, +84%). A position held over one has no bar to
exit on. 4h gaps cluster on exchange-wide maintenance days: 2020-02-19 (92 pairs), 2019-08-15
(51), 2019-05-15 (39), 2019-03-12 (28).

**Other oddities, left as they are:** SCRUSDT trades thinly from 2024-10-11, then normal
trading opens on 2024-10-22 at 0.80 against a 1.397 prior close, after a missing day of 4h bars.
ETHUSDT opens 49% down on the 4h bar of 2017-08-22, in its first days of trading. Across
all 4h bars only 4 steps exceed 30% between close and next open, and these two plus FTT and
KEY are all of them.

## Checks

**4h against 1d, all 524,171 pair-days:** every 4h high, close and summed quote volume
reconciles to the 1d bar. One daily low differs by more than 1e-6.

**OKX, DEV dates only, `1Dutc` closes** (three 100-day windows ending 2021-06, 2023-06,
2024-12): 4,800 comparisons, median difference 0.021%, 99th percentile 0.185%, maximum 2.03%
(AVAX, one day), one above 1%.

| Coin | Days | Median % | Max % |
|---|---|---|---|
| BTC | 300 | 0.007 | 0.180 |
| ETH | 300 | 0.008 | 0.073 |
| XRP | 300 | 0.017 | 0.158 |
| ADA | 300 | 0.023 | 0.279 |
| SOL | 300 | 0.021 | 0.546 |
| DOGE | 300 | 0.015 | 0.295 |
| LTC | 300 | 0.015 | 0.589 |
| LINK | 300 | 0.025 | 0.163 |
| DOT | 300 | 0.022 | 0.144 |
| AVAX | 300 | 0.030 | 2.029 |
| UNI | 300 | 0.030 | 0.497 |
| ATOM | 300 | 0.025 | 0.316 |
| FIL | 300 | 0.024 | 0.186 |
| AAVE | 300 | 0.043 | 0.403 |
| MANA | 300 | 0.049 | 0.366 |
| CRV | 300 | 0.043 | 0.248 |

This sample covers live, liquid coins only. EOS and ZEC returned no OKX data (6 windows
missed), and delisted coins generally are not served, so **dead coins have no cross-venue
check**, and neither do the redenomination fixes.

## Known residual survivorship and limits

1. **USDT pairs only.** A coin that lived and died on BTC or BNB pairs is absent. That matters
   most before 2020: USDT pairs started in 2017-08 and only 15 coins are eligible at the end
   of 2018. Results for 2018 and 2019 rest on a thin universe.
2. **Binance only.** Coins never listed on Binance are absent, and a coin's history here starts
   at its Binance listing, not at its launch.
3. **"Delisted" means the USDT pair ended on Binance.** XMR and WAVES are counted dead though
   they still trade elsewhere. This is the right treatment for a Binance-only bot.
4. **`MIGRATIONS` is written from general knowledge**, not checked against announcements, and
   may be incomplete: a swap missing from it reads as `delisted` and takes the 10% haircut.
   Swap ratios often are not 1:1 (LEND to AAVE, NPXS to PUNDIX, BTT to BTTC), so
   `migratedTo` must not be used to splice prices.
5. **Early volumes understate liquidity**, since much volume then was on BTC pairs. Volume
   is also as reported, wash trading and zero-fee promotions included.
6. **The holdout lock is a code lock, not a file lock.** Anyone can open
   `data/research/v6/holdout/` directly. `holdout/discovery.json` also holds today's listing
   status, which is future information. Rule compliance still depends on agents.
