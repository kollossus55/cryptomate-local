# V6 market hub: exchanges

Agent `exchanges`. Module `shared/trading/v6Exchanges.js`, tests `tests/v6Exchanges.test.mjs`,
live probe `scripts/v6/exchange-probe.mjs`.

All 8 venues answered bars, ticker and book in the final live run, with no rate limiting.
Every figure below was measured on 2026-11-05 from this machine, in three short runs, while
other agents were working. Treat them as one afternoon's snapshot of BTC, not as a benchmark.

## Recommended defaults

These are `DEFAULT_PRIORITIES` in the module.

| Job | Order | Why |
|---|---|---|
| Bars | binance, okx, bybit, kucoin, bitget, gate, kraken, coinbase | The research store comes from Binance (`scripts/v6/fetch-spot.mjs`), so live bars match the backtests. USD venues go last so failover stays in USDT for as long as it can. |
| Ticker | binance, okx, bybit, kucoin, bitget, gate, coinbase, kraken | Deepest USDT markets first. Kraken last because of its pacing. |
| Book | okx, binance, kucoin, bybit, bitget, kraken, gate, coinbase | OKX had consistently tight depth and carries a timestamp; Binance's book has none. Coinbase last because each call is about 1 MB. |
| Consensus | all venues | Median across every venue that answers. Needs at least 2. |
| USDT/USD basis | kraken, coinbase | The only two with a direct USDT/USD market. |

Which venue suits which job:

| Venue | Good for | Weak spot |
|---|---|---|
| Binance | Primary bars, matches research data | Book has no timestamp. Reported HTTP 451 on the old hosted server (see below) |
| OKX | Book, second bars source, replay | 300-bar cap. Daily needs `1Dutc` |
| Bybit | Fastest USDT venue here, replay | Thinner book for a $100k order than OKX or Binance |
| KuCoin | Consensus voter | 50 levels did not cover a $100k BTC buy in one sample |
| Bitget | Consensus voter | 84% of its markets are tokenised equities. Daily needs `1Dutc` |
| Gate | Consensus voter, wide alt coverage | Slowest (1d bars 1.0-1.3 s), thinnest book measured. 430 leveraged tokens |
| Kraken | Peg source, independent USD voter | Rate limits hard. Hub paces it at one call per 2 s |
| Coinbase | Peg source, independent USD voter | No 4h candles, no bulk book, quote volume is estimated |

**Cross-venue replay should use OKX or Bybit.** `scripts/v6/fetch-venues.mjs` stores history for
those two. A Coinbase replay would also compare USD bars against USDT bars.

**Binance reachability.** Every Binance call from this machine returned 200. `marketData.js` says
it was geo-blocked (HTTP 451) on the old hosted server, and `gui-design.md` carries that forward
as F9. If it is blocked where the engine runs, the first call opens the breaker for 30 minutes and
the hub moves to OKX, so the default order still works. A deployment known to be blocked should
simply disable it.

## Latency

Median of 3 rounds, final run, milliseconds. These are per-call times including any wait in
the hub's own queue.

| Venue | 1d bars | 4h bars | Ticker | Book | Raw round trip (`health`) |
|---|---|---|---|---|---|
| Binance | 264 | 219 | 221 | 224 | 253 |
| OKX | 308 | 271 | 270 | 285 | 301 |
| Bybit | 193 | 174 | 200 | 199 | 201 |
| Kraken | 94 | 1945* | 1982* | 1999* | 44 |
| Coinbase | 73 | 299** | 2945* | 116 | 54 |
| KuCoin | 428 | 267 | 264 | 287 | 300 |
| Gate | 1260 | 339 | 273 | 259 | 1094 (status `slow`) |
| Bitget | 362 | 314 | 264 | 278 | 339 |

\* Mostly waiting for Kraken's 2 s pacing, not network time. Coinbase's ticker also waits on it,
because a USD ticker needs the basis and Kraken is one of the two basis sources.
\*\* Built from 1h candles.

An 8-venue `consensusPrice` took about 2 s, set by Kraken's pacing. The universe call took 4.1 s.

## Depth

Slippage from the mid to buy $100k of BTC, from 50 levels, in percent. Only a few snapshots
each, so the order among the tight venues is weak evidence.

| Venue | Low | High | Note |
|---|---|---|---|
| Binance | 0.0000 | 0.0024 | |
| OKX | 0.0001 | 0.0014 | |
| Kraken | 0.0005 | 0.0005 | One sample only |
| KuCoin | 0.0001 | 0.0059 | One sample did not fill completely |
| Coinbase | 0.0025 | 0.0159 | |
| Bitget | 0.0065 | 0.0182 | |
| Bybit | 0.0077 | 0.0103 | |
| Gate | 0.0416 | 0.0439 | |

All of these are well inside the contract's 0.03% Tier 1 slippage, except Gate.

## Live output

Final run, `node scripts/v6/exchange-probe.mjs`, exit 0.

Every venue, every timeframe, on BTC: the last bar was the latest closed bar, on the UTC grid,
ascending, no gaps, not stale. For example, at about 16:40 UTC:

```
1d count=5 last=2026-11-04T00:00:00Z latestClosed=true grid=true asc=true gaps=0 stale=false
4h count=5 last=2026-11-05T12:00:00Z latestClosed=true grid=true asc=true gaps=0 stale=false
1h count=5 last=2026-11-05T15:00:00Z latestClosed=true grid=true asc=true gaps=0 stale=false
```

All venues returned 200 daily bars with no gaps, including Kraken once it was paced correctly.

```
basis {"ok":true,"basis":0.998735,"deviationPct":-0.1265,
       "sources":[{"venue":"kraken","price":0.998765},{"venue":"coinbase","price":0.998705}]}
BTCUSDT  ok venues=8 spreadPct=0.0241 outliers=[]
ETHUSDT  ok venues=8 spreadPct=0.0157 outliers=[]
SOLUSDT  ok venues=8 spreadPct=0.0331 outliers=[]
DOGEUSDT ok venues=8 spreadPct=0.0365 outliers=[]
BTCUSD   ok venues=8 spreadPct=0.0244 outliers=[]
universe venues=8 failed=[] excluded={stablecoin:49, wrapped:16, leveraged:446, non_crypto:244}
top: BTC $7690M, ETH $3273M, SOL $810M, ZEC $570M, XRP $450M, HYPE $270M, NEAR $236M ...
```

**USDT is really off peg right now, by about -0.13%.** So the basis adjustment is doing work today,
not only in a crisis. In one reading Coinbase's raw BTC price was 0.145% below Binance's; after
adjustment the gap was 0.020%. Without it, every USD venue would look like a small disagreement.

Bar prices are deliberately absent from this document and from the probe's output: see
[Holdout](#holdout).

## Venue quirks

| Quirk | Venue | Handling |
|---|---|---|
| Daily bar closes at 16:00 UTC by default | OKX `1D`, Bitget `1day` | Request `1Dutc`. Confirmed live: the two variants return different bars. Any bar off the UTC grid is refused |
| Daily bar is UTC | Binance, Bybit, Kraken, Coinbase, KuCoin, Gate | Confirmed live |
| Newest first | OKX, Bybit, Coinbase, KuCoin | Sorted in `normalizeBars` |
| Oldest first | Binance, Kraken, Gate, Bitget | Same path |
| Column order differs | KuCoin `t,o,c,h,l`; Gate `t,qv,c,h,l,o,v`; Coinbase `t,l,h,o,c,v` | Per-adapter mapping, each tested |
| Closed flag | OKX `confirm`, Gate column 7 | Venue flag beats the clock. Others use the clock, plus 5 s grace |
| Newest row is the forming bar | All | Dropped |
| No `limit` parameter | Kraken (`since`), KuCoin (`startAt`/`endAt`), Coinbase | Time window or tail slice |
| Bar caps | OKX 300, Coinbase 300, Kraken 720 | Venue skipped if it cannot serve the length |
| No 4h candles, HTTP 400 | Coinbase | Built from 1h, paged past the 300 cap, whole 4h groups only |
| Quote volume absent | Coinbase | Estimated from typical price. Kraken uses its VWAP |
| Pair renamed in response | Kraken `XBTUSD` becomes `XXBTZUSD` | Reads the only data key |
| Old asset names | Kraken BTC=XBT, DOGE=XDG | Mapped both ways |
| Full book only, about 1 MB, 21,000 levels | Coinbase `level=2` | Sliced to depth. Last in priority |
| Book sizes fixed | KuCoin 20 or 100; Binance fixed steps | Rounded up, then trimmed |
| No ticker timestamp | Kraken, Gate | Staleness cannot be detected. See limitations |
| Ticker time is the last trade | Binance, Coinbase | 15-minute limit, not 60 s, so a quiet market is not called dead |

"No such pair" has eight different forms, all mapped to `not_listed`, which never trips a breaker:

| Venue | Answer |
|---|---|
| Binance | 400, code -1121 |
| OKX | 200, code 51001 |
| Bybit | 200, retCode 10001 |
| Kraken | 200, `EQuery:Unknown asset pair` |
| Coinbase | 404 |
| KuCoin | 200, code 400100 on candles; 200, code 200000 **with every field null** on stats; `data: null` on books |
| Gate | 400, label `INVALID_CURRENCY` |
| Bitget | 400, code 40034 |

## Universe pollution

The first live run put `RQQQ`, `RMU`, `RSPY` and `RNVDA` above ETH, at up to $9.1B a day. These are
Bitget tokenised equities: 3,098 of its 3,673 markets. A volume-ranked universe with no defence
would have been mostly US stocks. Layers now in place:

1. **Venue tags.** Bitget lowercase `r` in `baseCoin`, Bybit `symbolType: xstocks`, KuCoin
   `market: Stocks`, Gate `base_name` containing xStock, OKX `instCategory`. Cached for 24 h.
2. **Bitget's filter is per symbol, not per base.** Uppercasing `rAY` gives `RAY`, a real coin, so
   a shared rule could remove the wrong asset. If Bitget's symbol list cannot be fetched, its
   tickers are refused rather than admitted unfiltered.
3. **`minVenues` defaults to 2.** A single-venue coin cannot pass the gate's price check anyway, and
   this also catches Binance's own stock tokens (`SNDKB`, `SOXLB`, `CRCLB`), which I found no tag for.
4. **A short static list** of xStocks as a backstop if every tag call fails.

**Same ticker, different project.** A venue priced more than 10% from the others on a base is not
merged. Live, this dropped venues on XMR, LIT, BEAM, TON, FOGO, DATA, INIT and NFP. I did not verify
the cause of each. Some will be different projects, others frozen prices on a delisted market.

`marketData.js` has a related bug: `(UP|DOWN|BULL|BEAR)USDT$` drops real tokens JUP, SYRUP and UP.
V6 is not affected. I did not change it.

## Behaviour contract

- `bars` returns plain `Bar[]` plus a non-enumerable `.meta`. A USD venue's bars stay in USD, with
  `meta.quoteMismatch: true`: today's basis says nothing about last month's bars.
- `ticker` and `book` always answer in the quote requested. A USD venue with no usable basis is
  skipped, never passed off as USDT.
- `consensusPrice` returns `price` even when `ok` is false, for marking only. **Entries must
  require `ok`.** With exactly two venues a split cannot be attributed, so `ok` is false. With three
  or more an outlier is named and dropped, and more than half must remain.
- Basis: median of Kraken and Coinbase. If they differ by more than 0.25% the basis is unusable and
  USD venues sit out. One source is accepted. Last good basis holds for 10 minutes.
- Stale data: failover first. If everything is stale, the freshest answer flagged `stale`. If
  everything is down, last good bars or ticker flagged `stale` and `lastGood`, so exits still have
  a price. Books have no last-good fallback. Nothing ever fetched means it throws.
- Breaker: opens on 3 consecutive failures, cooldown 30 s doubling to 15 minutes, one probe at a
  time. 429 honours Retry-After, else 60 s. 418 is 5 minutes. 403 and 451 are 30 minutes.
- `health()` `ok` needs a real success on this hub, so an untried venue is `unknown`, not healthy.
  `status` gives the GUI's `ok`, `slow`, `error`, `blocked`, `rate_limited`, `unknown`.

**Keep one long-lived hub per process.** Breaker, rate-limit and health state live in memory. A hub
per tick forgets all of it, and each hub paces itself, so parallel hubs add up. This is how the
first probe breached Kraken's limit.

## Limitations

- **Kraken's real limit is not known.** One call per second was rate limited in both runs that
  used it; the first was my probe's fault (8 parallel hubs), the second used one hub. One per 2 s
  was clean in the single run that used it, which is thin evidence. Other agents may share this IP, which I could not
  rule out.
- **Pacing is per hub, not per IP.** The engine and research scripts do not coordinate.
- **With many symbols, Kraken drops out of consensus.** Its queue holds about 2 calls at 2 s pacing
  before `local_throttle`, so a 20-symbol sweep leaves roughly 7 voters. That is safe, but Kraken
  also feeds the basis, which then leans on Coinbase alone. A 30 s basis cache limits this.
- **Frozen feeds on Kraken and Gate are undetectable** by timestamp. Consensus catches one only once
  it drifts past tolerance.
- **`hub.bars` does not know about ticker collisions.** `bars('LITUSDT')` can return a different
  project on a venue the universe dropped. Check `universe().venues`, or pass `{ venue }`.
- **Closed-bar filtering trusts the local clock** on venues with no closed flag. The 5 s grace
  covers small skew only.
- **Volumes are self-reported.** Summing them does not make them true. Wash trading is not modelled.
- **USD venues on `bars` failover are not rescaled**, so during a real depeg a failover shifts the
  price level. Check `meta.quoteMismatch`.
- Timeframes are `1h`, `4h`, `1d` only, as the contract requires. No paging past each venue's cap,
  except Coinbase 4h.
- **Not tested against a real outage or real depeg.** Failover, breaker and peg behaviour are proven
  on mocks only. The 429 path did fire live on Kraken and behaved correctly.

## Holdout

The hub has no date range, serves latest bars only, and is not a research data source. Research must
use `v6Bars.loadBars()`. Nothing stops a research script from calling `hub.bars` for recent data, so
this rests on convention. If that matters, `v6Bars` is the place to enforce it.

Recent bars fall in the locked holdout period. The probe reports bar shape only and neither prints
nor stores prices. My first raw format checks, before the probe existed, did print a few recent BTC
daily and 4h candles, and part of a Kraken USDT/USD 4h series, to the console of this session. Nothing
was saved or analysed, and no strategy work was done here.

## Verification

- `node tests/v6Exchanges.test.mjs`: 97 passed, 0 failed. Mocked fetch and fake clock, no network.
- Mutation check: 29 deliberate breaks to the module, one at a time, all caught by the tests. The
  first pass caught 27 of 28: removing the `no_majority` rule broke nothing, because no test reached
  it. A test was added.
- Live probe: exit 0 in the final run.
