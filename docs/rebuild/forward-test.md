STATUS: LOGGING. Pre-registered 2026-11-13, before any forward bar existed. Review on or after 2027-05-14.
Nothing here is certified, nothing trades, and no paper position is opened.

# Forward test of four near-misses

## Why

After 510 trials no strategy passed D1-D8 on DEV, so V6 holds cash. Testing more ideas on the same
2018-2024 data mostly raises the D2 bar for everything else. Data that no rule has ever seen is the one
clean test left, and it adds nothing to the trial count. The user approved this on 2026-11-13.

## Contract amendment (2026-11-13, approved by the user)

The holdout was "2025-01-01 onward" with no end, so it would have included every forward bar. Now:

- **HOLDOUT** is `2025-01-01` to `2026-11-13` inclusive (`HOLDOUT_END`). Still locked, still one shot per
  frozen candidate. An unlocked `loadBars` stops at `HOLDOUT_END`, whatever the files hold, and
  `fetch-spot.mjs --phase holdout` no longer fetches past it.
- **FORWARD** starts `2026-11-14` (`FORWARD_START`). Its bars live in their own store,
  `data/research/v6-forward/`, written live by `scripts/v6/forward-test.mjs`.
  `openForwardView()` in v6Bars reads that store only, never dev or holdout files. A test bans it from
  `scripts/v6/research/`.
- **Warmup.** The forward store also holds bars from 2025-08-21, because the rules need up to 365 days
  of history and the universe needs 200 days. Those bars are indicator history only: no result before
  `FORWARD_START` is computed or reported. They fall in the holdout's dates, so this file says so. Nothing
  has used the holdout to measure performance, and nothing will through this store.
- **Trial count.** These are four already-counted trials re-run unchanged on new data, with no selection.
  They add nothing to the global count (510). Choosing among them after the review would be selection:
  see "What a result means".

## The four candidates (frozen)

Each one uses its own walk-forward's **last pick** (the parameters chosen on the most recent training
window before 2025) and the exact risk config its walk-forward ran with. Strategy code is imported from
the research scripts unchanged. The runner refuses to run if any of them changes (SHA-256 below).

| Id | What | Code | Parameters | Risk config | DEV result (remeasured) |
|---|---|---|---|---|---|
| F1 | 20-day closing breakout, top 20, only when BTC regime is risk-on | `r-risk.mjs` `refBrk20` | `n=20` (last pick, test from 2024-06-09) | `RECOMMENDED_RISK_CONFIG` (= defaults), clamped | Sharpe 1.08, DD 8.7%, 223 trades. Fails D2 |
| F2 | 20-day closing breakout, top 20, no regime filter, 3xATR stop, trend exits | `r-exits.mjs` `exitTestStrategy({ entry: 'breakout', seed: 1 })` | `cfg=ph_trend` (last pick, test from 2024-12-06) | defaults with `maxStopDistancePct 0.30` | Sharpe 1.07, DD 12.8%, 382 trades. Fails D2 |
| F3 | Time-series momentum on BTC and ETH | `r-trend.mjs` `trendFactory({ rule: 'tsmom', universe: 'btceth' })` | `L=365` (last pick, test from 2024-12-05) | r-trend's `riskConfig('btceth')` | Sharpe 1.31, DD 7.5%, 160 trades. Fails D2, D7 |
| F4 | Fresh 200-bar closing high on 4h, top 30, BTC above its 200-day average | `r-breakout.mjs` `breakoutFactory('donchian', '4h')` | `n=200, exit=trend, topN=30` (last pick, test from 2024-08-06) | `RISK_AT_CEILINGS` | Sharpe 1.01, DD 18.6%, 629 trades. Fails D2, D7 |

F1 and F2 are close relatives: the same entry, with and without the regime filter. Read them as one idea
tested two ways, not as two independent chances.

Frozen script hashes (SHA-256 of the file bytes):

```
r-risk.mjs      5a1dca6553278d3f7eda014f3783ff5832c72d873bc53a6e5764f213583738fa
r-exits.mjs     f1b74ad2a14840ffa7e8a67809486061894887a1c547c0847d1b231a03934e1f
r-trend.mjs     ae112214823ce5ccb8bb9ce91faa314bbd1b3e5cf83951b77b44928450731e63
r-breakout.mjs  b15459df04c0467a06965f92706149a6c6589f3b54a7b129a2431a03fb82b89f
```

Engine code (v6Sim, v6Core, v6Risk, v6Exits) is not frozen. Any change to it before the review must be
listed under "Changes during the window", and the review is re-run on both versions.

## How it runs

`node scripts/v6/forward-test.mjs`, hourly from the app scheduler (job `forwardTest`):

1. Once a UTC day, reads Binance 24h volume for every USDT pair and adds the top 60 (after the usual
   exclusions: stablecoins, wrapped, leveraged, tokenised stocks) to the tracked list. A coin once tracked
   stays tracked, so its volume history has no holes. A new coin gets its history from 2025-08-21.
2. Appends every newly closed 1d and 4h bar for each tracked coin (Binance, public endpoint, same source
   as DEV). Only closed bars are written.
3. When a new bar has closed for a candidate's timeframe, re-runs that candidate through `runSim` from
   `FORWARD_START` to the latest closed bar, with no close-out, and appends any new fills to
   `data/research/v6-forward/log/<id>.jsonl`. That log is the live record of what each rule would have done,
   written at the time.

Nothing is printed about returns. `--status` shows coverage and fill counts only.

## Review (pre-registered)

`node scripts/v6/forward-test.mjs review` refuses to run before 2027-05-14. On or after that date it runs
each candidate from `FORWARD_START` to the last bar closed before 2027-05-14, with close-out, and reports:
total return, Sharpe, max drawdown, closed trades, BTC buy-and-hold over the same window, and whether the
re-run's fills match the live log.

A candidate **shows forward support** only if all of these hold:

1. Total return > 0, net of costs.
2. Sharpe >= 0.5.
3. Max drawdown <= 15%.
4. Sharpe or Calmar better than BTC buy-and-hold over the same window.
5. At least 10 closed trades.
6. The re-run's fills match the live log (any difference is explained before anything else is read).

## What a result means

- **No support:** drop the candidate. Do not retune it, do not re-run it on another window.
- **Support:** it is still not certified. It failed D2 and possibly D7 on DEV, and the contract has no
  route from a forward result to a certificate. It is evidence for the user to decide whether to extend
  the forward window or change the contract. Six months is short: F3 may close only a handful of trades, and
  one candidate in four passing by luck is plausible. One passer alone is weak evidence.
- **Never:** loosen D1-D8, pick the best of the four and call it validated, or add a fifth candidate later
  and back-date it.

## Changes during the window

None yet.
