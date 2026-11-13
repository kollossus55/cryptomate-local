STATUS: DONE 2026-11-13. VERDICT: NO EDGE, NOTHING FROZEN. Pre-registered (commit 5e9c54d) before any data was fetched; text above Results unchanged.

# r-onchain: do sentiment and on-chain flows time BTC and ETH?

Every family so far used price and volume only, and 518 trials found nothing. This one uses information
prices do not contain. The three hypotheses were proposed on 2026-11-11; this fixes their details.

## Data (free, public, fetched once, saved with the fetch time)

- **Fear & Greed index**, alternative.me (`api.alternative.me/fng/?limit=0`), daily from 2018-02-01.
- **Total stablecoin supply (USD-pegged)**, DefiLlama (`stablecoins.llama.fi/stablecoincharts/all`).
- **BTC exchange inflow and outflow (native units)**, Coin Metrics community API, `FlowInExNtv` and
  `FlowOutExNtv`.
- Prices: the DEV store's Binance daily bars for BTCUSDT and ETHUSDT.

Window: **2018-03-01 to 2024-12-31** (DEV only). Halves split at 2021-08-01. Holdout and forward are not touched.

**Timing:** a value stamped day d is treated as known only at the end of day d. It can trigger a trade at
the open of day d+1, never earlier.

**Point-in-time caveats, stated in advance:**
- Coin Metrics relabels exchange addresses after the fact, so old flow values can include knowledge not
  available at the time. H3 cannot be certified even if it passes.
- DefiLlama's history can be revised when it adds coverage. H2 carries the same flag, more weakly.
- Fear & Greed is published once a day and not revised, as far as is known.

## Hypotheses and cells (6 trials; global 518 -> 524)

- **H1, buy fear.** When Fear & Greed <= 20, buy at the next open and hold `h` days. While a trade is open,
  new signals for that coin are ignored. Cells: BTC h=10, BTC h=30, ETH h=10, ETH h=30 (4 trials).
  *Reason:* panicked sellers pay whoever takes the other side.
- **H2, stablecoin liquidity.** Hold a 50/50 BTC+ETH basket on day d+1 while stablecoin supply on day d is
  above its value 30 days earlier; otherwise cash (1 trial). *Reason:* new stablecoins are money on-chain,
  waiting to buy.
- **H3, exchange outflow.** Hold BTC on day d+1 while the sum of (outflow - inflow) over days d-6..d is
  positive; otherwise cash (1 trial). *Reason:* coins leaving exchanges means less supply for sale.

## How each cell is measured

- **H1:** one event per trade. Gross = exit close / entry open - 1. Excess = gross - h x the coin's mean
  daily close-to-close return over the window (its drift). Cost = one round trip at the coin's tier cost.
- **H2, H3:** one event per day held. Gross = that day's open-to-next-open return. Cost = one round trip on
  each day a holding period starts. Excess = gross - the same day-weighted drift. (H2's basket uses the
  average of the two coins.)

## Gate (the same as r-catalogue and r-lottery)

A cell passes only if all hold:
1. At least 30 events.
2. Mean gross beats mean cost.
3. Mean excess > 0 with t >= 2 on 4-week blocks.
4. Mean excess > 0 in both halves.

A passing cell goes on to a full walk-forward under D1-D8, including D8 (beat buy-and-hold). Passing the
gate certifies nothing. If none passes, nothing is frozen and the family is closed. No new cells, thresholds
or lookbacks after results are seen.

## Results (run 2026-11-13, `node scripts/v6/research/r-onchain.mjs study`)

Data fetched 2026-11-13 into `.rebuild/data/research/onchain/` (not in git): Fear & Greed 2,522 DEV days,
stablecoins 2,590, BTC flows 2,771. Every Coin Metrics value carries a status time in April 2026, which
confirms H3's flows were computed long after the fact. Drift per day: BTC 0.149%, ETH 0.158%.

| Cell | Events | Gross | Cost | Excess | t (4-wk blocks) | Halves | Gate |
|---|---|---|---|---|---|---|---|
| H1 BTC h=10 | 57 | 2.232% | 0.260% | 0.738% | 0.90 | 1.199% / 0.005% | FAIL |
| H1 BTC h=30 | 29 | 2.556% | 0.260% | -1.924% | -0.60 | -0.842% / -3.456% | FAIL (also n<30) |
| H1 ETH h=10 | 57 | 1.399% | 0.260% | -0.181% | 0.07 | -0.313% / 0.029% | FAIL |
| H1 ETH h=30 | 29 | 1.348% | 0.260% | -3.392% | -0.61 | -4.435% / -1.914% | FAIL (also n<30) |
| H2 basket | 1,738 days, 24 entries | 0.236% | 0.004% | 0.082% | 0.43 | 0.135% / 0.010% | FAIL |
| H3 BTC | 1,155 days, 175 entries | 0.277% | 0.039% | 0.127% | **1.45** | 0.351% / -0.058% | FAIL |

**No cell passes. Nothing is frozen; the family is closed.** Global trials: 518 -> 524.

Reading:
- **H1, buy fear:** trades after extreme fear made money on average, but no more than simply holding over
  the same number of days. The 30-day holds did worse than holding: fear often came early in long bear
  markets (2018, 2022).
- **H2, stablecoin growth:** in the market 70% of days, with excess per day near zero. Not distinguishable
  from buy-and-hold with less exposure.
- **H3, exchange outflow:** the strongest (t 1.45), but it is all in the first half and negative after
  2021-08. It could not have been certified anyway, because the flows are relabelled after the fact.

Not done, and not to be done on this data: other fear thresholds, greed-selling, MVRV or active-address
rules, other lookbacks, or combinations. Each would be a new trial chosen after seeing these numbers.
