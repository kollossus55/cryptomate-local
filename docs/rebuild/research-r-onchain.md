STATUS: PRE-REGISTERED 2026-11-13, before any on-chain or sentiment data was fetched. Results go below, unchanged above.

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

## Results

(Not run yet.)
