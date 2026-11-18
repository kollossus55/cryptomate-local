# data-derivs: perp, funding and cross-venue data quality

Everything below is DEV only (t < 2025-01-01). Holdout rows are stored under `*/holdout/` and were not analysed.
Tables come from `node scripts/v6/fetch-derivs.mjs --report`, which reads through the locked loaders.

## Effect on the carry result (`research-r-carry.md`)

I found no data fault that undermines it. r-carry ran after the archive backfill below, so it used the final store.

| Check | Result |
|---|---|
| Stored funding vs Binance monthly archive, BTC and ETH, 2021 | 2,190 events, 0 absent, 0 rate mismatches |
| Funding gaps over 8h inside live spans, all perps | 0 |
| Top-20 month slots 2020-2024 with perp and funding | 1,156 of 1,200; 36 of the 44 misses are in 2020 |
| Perp vs Binance spot store, 1d close, 72 coins | median 0.07%, p99 0.39% |
| Missing marks (r-carry uses the day's perp open) | Marks start 2023-10-31 for BTC and ETH; mark vs open averages +0.06%, so no material bias |
| Zero-volume bars inside live spans | ICP and TLM only, 1,038 default-rate events, no top-20 overlap |
| 1d bar gaps, which could trip r-carry's 3-day delisting exit | BNX, ICP, LIT, TLM only; none in the top 20 during a gap |

Limits that remain:

- **One venue.** All funding is Binance. The archive check is the same source, so it proves the copy, not the market. No second venue's funding history was fetched, so nothing shows the income was available elsewhere.
- **The archive check covers BTC and ETH in 2021 only.** That is the year carrying most of the profit, but alts and other years are unchecked.
- **The regime finding is in the raw data too.** Median perp funding was 35.1% in 2021 and -2.4% in 2022, with 29% of 2022 negative. This supports r-carry's "one regime" warning.
- **The top-20 and gap overlaps were checked at month starts,** not trade by trade against r-carry's run.

## Caveats for anyone using this data

- **Funding is not always 8h.** The contract says every 8h, but 195 perps ran at 4h or 2h at some point, and 4 events are 6h apart. Use the actual events. Never multiply by 3 per day.
- **Binance records phantom data.** After delisting it serves flat zero-volume bars and default 0.01% funding for months or years, and it records funding before first trade. `loadPerpBars` and `loadFunding` cut these; `raw: true` shows them. A perp with no daily bars returns no funding.
- **`startTime=0` on `fundingRate` returns the newest rows.** The fetcher starts at 1.
- **REST lost some history.** Klines for 13 perps were missing or late (SXP, CVC, CTK, ICP, TLM and others), so they were merged from the monthly archive (`--backfill`). REST wins on overlap. Some gaps remain, listed below. OGUSDT has funding but no bars; LITUSDT and NUUSDT have bars but no funding.
- **Perp symbols differ from spot.** Use `perpToSpot`: 1000PEPEUSDT is 1000x PEPEUSDT.
- **Stale manifest.** `derivs/manifest.json` shows pre-backfill row counts for backfilled perps (for example SXP as 0). Trust the files. `--backfill` would refresh it, but it was not rerun.
- **Venue coin list.** 73 coins, not ~30: the union of the top 30 at each DEV year end, so no use of today's rankings. It was chosen before the backfill, so backfilled perps were not candidates.
- **Venue bars are spot.** OKX uses `1Dutc`, because plain `1D` cuts at Hong Kong midnight. Bybit spot starts 2021-07. Delisted pairs are absent on both, as the no-rows list shows.
- **Thin Bybit markets give false prices.** ZEC closed at 1.11 against 56.27 on Binance on 2024-12-31, with near-zero volume; DASH is also unreliable. Do not use either in cross-venue replay, and require a minimum venue volume. OKX ONE and EGLD diverge above 5% on about 20 days each, mostly early.
- **Open interest:** REST history is only 30 days (older `startTime` is rejected). The public metrics archive goes back further, so 10 majors were stored as one daily sample (`loadOpenInterest`). BTC starts 2020-09, the rest 2021-12.

## Holdout exposure

A probe with `startTime=0` printed 3 BTC funding rows and a mark price from November 2026, and 2 FTT rows from June 2025. `exchangeInfo` also showed current listing status and some 2025 delivery dates. None of it was stored or used in any statistic, and the listing status was removed from the manifest. The holdout fetch and backfill wrote rows without display. Holdout row counts now sit in `*/holdout/manifest.json`.

## Perp coverage (DEV)

| Item | Value |
|---|---|
| Perps with DEV funding files | 394 |
| Perps with DEV 1d files | 395 |
| Perps with real trading in DEV (after dead tail cut) | 395 |
| First 1d bar | 2019-09-08 |
| Perps whose last traded bar is before 2024-12-31 | 55 |
| Dead-tail 1d bars cut by the loader | 10492 |
| Dead-tail funding events cut by the loader | 38669 |
| Missing-day gaps in 1d | 8 across 4 perps |
| Zero-volume 1d bars inside a live span | 346 |
| 1d bars failing OHLC sanity | 0 |
| Funding files with no 1d file | OGUSDT |

1d gaps, first 40: BNXUSDT 2022-04-16..2022-04-18; BNXUSDT 2022-06-08..2022-06-10; BNXUSDT 2022-08-09..2022-08-13; BNXUSDT 2023-01-31..2023-02-22; ICPUSDT 2022-08-31..2022-09-27; LITUSDT 2022-02-25..2022-03-01; LITUSDT 2022-03-31..2022-04-03; TLMUSDT 2023-02-28..2023-03-30

Delisted in DEV: 1000BTTCUSDT 2022-04-11, AGIXUSDT 2024-06-25, AKROUSDT 2022-05-27, ANCUSDT 2022-05-13, ANTUSDT 2024-04-01, AUDIOUSDT 2024-05-16, BLUEBIRDUSDT 2024-03-26, BLZUSDT 2024-12-23, BONDUSDT 2024-12-16, BTCSTUSDT 2021-03-12, BTSUSDT 2022-08-18, BTTUSDT 2022-01-14, BZRXUSDT 2021-12-19, COCOSUSDT 2023-05-25, CTKUSDT 2024-04-01, CVCUSDT 2022-11-29, CVXUSDT 2024-05-14, DARUSDT 2024-12-26, DGBUSDT 2024-04-01, DODOUSDT 2022-05-27, DOTECOUSDT 2021-02-19, FOOTBALLUSDT 2024-03-26, FRONTUSDT 2024-08-23, FTTUSDT 2022-11-14, GALUSDT 2024-07-11, GLMRUSDT 2024-05-15, HNTUSDT 2023-03-20, IDEXUSDT 2024-05-15, KEEPUSDT 2022-02-15, KEYUSDT 2024-12-03, KLAYUSDT 2024-10-22, LENDUSDT 2020-10-09, LOOMUSDT 2024-12-09, LUNAUSDT 2022-05-12, MATICUSDT 2024-09-04, MAVIAUSDT 2024-12-16, MBLUSDT 2024-05-13, NUUSDT 2022-02-15, OCEANUSDT 2024-06-25, ORBSUSDT 2024-12-09, RADUSDT 2024-05-14, RAYUSDT 2022-11-15, RENUSDT 2024-12-03, RNDRUSDT 2024-07-16, SCUSDT 2022-06-17, SLPUSDT 2024-05-15, SNTUSDT 2024-05-13, SRMUSDT 2022-11-15, STPTUSDT 2024-05-13, STRAXUSDT 2024-03-15, TOMOUSDT 2023-11-14, UNFIUSDT 2024-10-30, WAVESUSDT 2024-06-11, XEMUSDT 2024-12-09, YFIIUSDT 2022-04-12

## Funding intervals (DEV)

Perps per sustained interval (3+ events in a row; one perp can appear twice): {"2":9,"4":192,"8":223}.
Events: 951565. Mark price missing on 51.2%. Non-Regular type on 0. Largest single rate: ATAUSDT 2024-12-28 -0.03.
Gaps over 8h: 0 across 0 perps. First 30: 

Perps not on a constant 8h (195), first 60:

- 1000000MOGUSDT: 4h from 2024-11-07
- 1000BONKUSDT: 4h from 2023-11-22
- 1000CATUSDT: 4h from 2024-10-21
- 1000CHEEMSUSDT: 4h from 2024-11-25
- 1000RATSUSDT: 4h from 2023-12-15
- 1000SATSUSDT: 4h from 2023-12-12
- 1000WHYUSDT: 4h from 2024-11-25
- 1000XUSDT: 4h from 2024-11-13
- 1MBABYDOGEUSDT: 4h from 2024-09-16
- ACEUSDT: 4h from 2023-12-18
- ACTUSDT: 4h from 2024-11-11
- ACXUSDT: 4h from 2024-12-06
- AERGOUSDT: 4h from 2024-09-10
- AEROUSDT: 4h from 2024-12-04
- AEVOUSDT: 4h from 2024-03-13
- AIUSDT: 4h from 2024-01-08
- AIXBTUSDT: 4h from 2024-12-20
- AKTUSDT: 4h from 2024-11-18
- ALPACAUSDT: 4h from 2024-08-22
- ALTUSDT: 4h from 2024-01-25
- AMBUSDT: 8h from 2023-03-30, 4h from 2023-10-12
- API3USDT: 8h from 2022-02-22, 4h from 2023-10-12
- AUCTIONUSDT: 4h from 2023-12-15
- AVAUSDT: 4h from 2024-12-13
- AXLUSDT: 4h from 2024-03-01
- BADGERUSDT: 4h from 2023-11-09
- BANANAUSDT: 4h from 2024-08-15
- BANUSDT: 4h from 2024-11-18
- BBUSDT: 4h from 2024-05-13
- BEAMXUSDT: 4h from 2023-11-17
- BIGTIMEUSDT: 4h from 2023-10-12
- BLZUSDT: 8h from 2020-09-17, 4h from 2023-08-14, 8h from 2023-08-31, 4h from 2023-09-05, 8h from 2023-09-13, 4h from 2023-10-12
- BNXUSDT: 8h from 2022-04-01, 2h from 2022-12-04, 8h from 2022-12-14
- BOMEUSDT: 4h from 2024-03-16
- BONDUSDT: 4h from 2023-10-15
- BRETTUSDT: 4h from 2024-08-20
- BSVUSDT: 4h from 2023-10-20
- BSWUSDT: 4h from 2024-09-05
- CAKEUSDT: 4h from 2023-11-02
- CATIUSDT: 4h from 2024-09-20
- CETUSUSDT: 4h from 2024-11-06
- CGPTUSDT: 4h from 2024-12-20
- CHESSUSDT: 4h from 2024-08-29
- CHILLGUYUSDT: 4h from 2024-11-27
- COSUSDT: 4h from 2024-09-30
- COWUSDT: 4h from 2024-11-06
- CYBERUSDT: 8h from 2023-08-21, 4h from 2023-08-31, 2h from 2023-09-02, 8h from 2023-09-04, 4h from 2023-10-12
- DEGENUSDT: 4h from 2024-11-15
- DEGOUSDT: 4h from 2024-12-13
- DEXEUSDT: 4h from 2024-12-24
- DFUSDT: 4h from 2024-12-30
- DIAUSDT: 4h from 2024-10-02
- DODOXUSDT: 8h from 2023-08-08, 4h from 2023-10-12
- DOGSUSDT: 4h from 2024-08-26
- DRIFTUSDT: 4h from 2024-11-08
- DYMUSDT: 4h from 2024-02-07
- EIGENUSDT: 4h from 2024-10-01
- ENAUSDT: 4h from 2024-04-02
- ETHFIUSDT: 4h from 2024-03-18
- ETHWUSDT: 4h from 2023-11-28

## Funding by year (DEV)

Mean annualised funding, long pays when positive. Alts are the top 8 by 30-day median perp quote volume at 2024-12-31, so this list carries that date's hindsight for earlier years. Blank means the perp had under 2 events that year; 2019 starts on 2019-09-10.

| Perp | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|
| BTCUSDT | 7.5% | 17.2% | 30.6% | 4.2% | 7.9% | 11.9% |
| ETHUSDT | 8.9% | 27.4% | 37.5% | 0.8% | 8.3% | 13.0% |
| XRPUSDT |  | 24.6% | 48.1% | 0.0% | 8.2% | 14.2% |
| DOGEUSDT |  | 9.4% | 38.5% | 3.4% | 10.0% | 14.0% |
| SOLUSDT |  | -12.6% | 28.6% | -38.0% | 1.3% | 13.6% |
| 1000PEPEUSDT |  |  |  |  | 10.2% | 20.1% |
| SUIUSDT |  |  |  |  | 4.3% | 10.3% |
| BNBUSDT |  | 2.5% | 21.7% | -12.6% | -8.3% | -3.3% |
| LINKUSDT |  | 11.5% | 43.0% | 5.9% | 10.2% | 13.3% |
| ADAUSDT |  | 26.7% | 39.9% | -1.0% | 7.2% | 14.0% |
| Median perp | 7.5% | 18.4% | 35.1% | -2.4% | 8.3% | 13.9% |
| Perps counted | 3 | 81 | 137 | 160 | 244 | 372 |

Share of time funding was negative (time-weighted by interval):

| Perp | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|
| BTCUSDT | 18.3% | 14.3% | 7.3% | 22.1% | 10.1% | 8.4% |
| ETHUSDT | 4.8% | 2.6% | 4.1% | 34.2% | 9.1% | 4.2% |
| XRPUSDT |  | 4.9% | 4.0% | 39.5% | 16.1% | 7.2% |
| DOGEUSDT |  | 15.5% | 8.5% | 25.8% | 10.0% | 10.0% |
| SOLUSDT |  | 25.4% | 4.7% | 42.6% | 28.1% | 10.3% |
| 1000PEPEUSDT |  |  |  |  | 18.2% | 10.5% |
| SUIUSDT |  |  |  |  | 28.5% | 23.7% |
| BNBUSDT |  | 18.4% | 21.4% | 50.6% | 29.4% | 22.1% |
| LINKUSDT |  | 17.3% | 0.7% | 17.0% | 6.6% | 9.7% |
| ADAUSDT |  | 6.1% | 7.0% | 40.9% | 17.4% | 8.4% |
| Median perp | 18.3% | 9.2% | 6.9% | 29.1% | 9.5% | 7.0% |

## Second venues (DEV, spot)

73 coins. Agreement is |venue close / (perp close / multiplier) - 1| on shared 1d bars.

| Venue | tf | Coins with rows | Earliest | Median first bar | Gaps | Median abs diff | p99 abs diff |
|---|---|---|---|---|---|---|---|
| okx | 1d | 59 | 2018-01-11 | 2020-09-23 | 0 | 0.072% | 0.76% |
| okx | 4h | 59 | 2018-01-11 | 2020-09-22 | 0 |  |  |
| bybit | 1d | 62 | 2021-07-05 | 2021-11-12 | 0 | 0.075% | 11.89% |
| bybit | 4h | 62 | 2021-07-05 | 2021-11-12 | 0 |  |  |

No rows: okx: EOSUSDT VETUSDT XMRUSDT ZECUSDT DASHUSDT MATICUSDT FTMUSDT ALICEUSDT OCEANUSDT WAVESUSDT RLCUSDT BAKEUSDT LUNCUSDT ENAUSDT; bybit: VETUSDT XMRUSDT NEOUSDT ONTUSDT IOTAUSDT IOSTUSDT ALICEUSDT OCEANUSDT RLCUSDT TRBUSDT BAKEUSDT

Coins disagreeing with the perp by over 1% median or 5% p99: okx EGLDUSDT: median 0.09%, p99 6.2% over 1553 days; okx ONEUSDT: median 0.13%, p99 11.4% over 1091 days; bybit ZECUSDT: median 0.92%, p99 98.6% over 1099 days; bybit DASHUSDT: median 1.64%, p99 26.1% over 1162 days

## Binance spot store check (DEV, 1d close)

| Compared with spot store | Coins | Days | Median abs diff | p99 abs diff |
|---|---|---|---|---|
| Binance perp | 72 | 100654 | 0.070% | 0.39% |
| okx | 57 | 81812 | 0.035% | 0.87% |
| bybit | 60 | 61617 | 0.044% | 11.94% |

Flagged: okx EGLDUSDT: median 0.05%, p99 6.1%; okx ONEUSDT: median 0.10%, p99 10.2%; bybit ZECUSDT: median 0.97%, p99 6791.1%; bybit DASHUSDT: median 1.64%, p99 35.1%

## Open interest (DEV)

| Perp | Days | First | Last |
|---|---|---|---|
| ADAUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| AVAXUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| BNBUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| BTCUSDT | 1583 | 2020-09-01 | 2024-12-31 |
| DOGEUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| ETHUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| LINKUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| LTCUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| SOLUSDT | 1127 | 2021-12-01 | 2024-12-31 |
| XRPUSDT | 1127 | 2021-12-01 | 2024-12-31 |

