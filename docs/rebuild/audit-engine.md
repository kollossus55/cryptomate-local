# CryptoMate V6 rebuild: legacy engine audit

Agent: `audit-engine`. Read-only audit. No code, settings or entities were changed.
Data snapshot: `D:\cryptomate-local\data\entities` as of 2026-11-05 16:30 UTC, logs to the same day.
Paths are relative to `D:\cryptomate-local\.rebuild` unless absolute. No holdout data was read.

The brief's picture has moved on. It describes 5 open positions. At 16:30 UTC the legacy account
is **flat**: all 12 entries made today hit the stop. See section E for what that means for cutover.

## Summary, most severe first

1. **Paper is paper only because no exchange credentials exist.** No code lock exists. Storing one
   Kraken key makes a manual order on the Trading page real, with no arming and no 24h cooldown (A).
2. **Stops can fail silently.** A held symbol that leaves the top-100 universe keeps a frozen price
   forever, with no log. If both data providers fail, the cycle returns before any exit logic. A
   schedule or `is_enabled=false` stops all exit management (C).
3. **The live record has negative expectancy, and higher strength did worse.** 411 resolved trades,
   27.3% wins, mean -0.78% per trade. Strength 95 is the worst bucket. Today: 12 entries, 12 stops,
   -3.2% on the account (D).
4. **Legacy and V6 must never run against `Portfolio` together.** The worker walks every position
   and rewrites the whole record each cycle, so it would stop out V6 positions and overwrite them (E).
5. **The live bot and `backtest.js` are materially different systems.** Backtest results say little
   about this bot, and `backtest.js` has a volume-scaling bug of its own (B).
6. **The worker's own log never reaches disk.** Cycle history is unrecoverable, so several October
   questions can only be answered indirectly (B).
7. **Log noise is a UI bug, not a trading one.** It burns about 300 LLM calls a day and discards the
   results (F).

---

## A. Paper safety

### Is there a route to a real order today?

**No, measured.** `D:\cryptomate-local\data\entities\ExchangeConnection.json` does not exist, so
`store.list` returns `[]`, and every real-order route needs a connection row with stored credentials.

### What the settings actually mean

- `execution_mode: "auto"` means **nothing**. The worker ignores it (`base44/functions/autoTradingWorker/entry.ts` L106-113, local fix 2026-10-27) and so does the scheduler (`base44/functions/tradingScheduler/entry.ts` L38-41). Only `is_enabled` gates.
- `live_trading_enabled`, `exchange_connection_id`, `live_trading_requested_at` and `kill_switch_enabled` are absent from settings.
- `ai_confirmation_mode` is `off`, so `executeApprovedTrade` has no feed: it needs mode `manual` plus a signed `PendingTradeApproval` (`executeApprovedTrade/entry.ts` L54-61).

### Routes to `liveOrderExecution`

| Route | Evidence | Guard |
|---|---|---|
| Worker | `autoTradingWorker/entry.ts` L175-215 config, L217-241 place, L589-604 sell, L953-968 buy | `live_trading_enabled`, connection id, request at least 24h old, connection active, connected, `ready_for_live` |
| `executeApprovedTrade` | L170-179 arming, L184 invoke | Same arming test, plus manual approval |
| **Trading page manual order** | `src/pages/Trading.jsx` L629-665 | **Any active connected connection. No arming, no cooldown.** |
| Other UI | `TradeModal`, `LiveTradingPanel` L44 to `liveTradingControl` | Control flow only |

### Weak points inside `liveOrderExecution/entry.ts`

- It never checks `live_trading_enabled` or the cooldown. Arming lives only in callers.
- L413-418 blocks OKX non-testnet ("Phase 1"). **Kraken has no such guard**: L447, L659 and L711 need only `confirm_live`, then L769 calls the real `/0/private/AddOrder`.
- L424-433 looks up the kill switch by `exchange_connection_id`, so a connection not assigned in settings bypasses it.
- L357 auth is meaningless locally, because the shim's `auth.me()` always returns the admin.
- OKX testnet path (L558-575, `base44/shared/okxExchange.ts` L121-122) uses `x-simulated-trading`: demo money.
- The worker sends `ZECUSDT`, while L474 expects `X/USDT`-style input. The worker route is probably broken by symbol format on OKX, and likely on Kraken (L723). The UI uses `X/USDT`, so the UI route is not. Do not rely on this as a safety property.

### Other ways around the arming flow

- `liveTradingControl` claims to be the sole writer of the arming fields, but `server/index.js` L350-409 exposes generic POST/PATCH on any entity. A signed-in session can write a backdated `live_trading_requested_at` plus `live_trading_enabled`.
- `exchangeCredentials/entry.ts` L216-282 creates a connection as `is_active: true`, connected. L97-100 cannot detect withdrawal permission, so the README claim of rejecting withdraw-capable keys is false for OKX and Kraken (L23-25, L154-157).
- `EXCHANGE_ENCRYPTION_KEY` is set in `.env` (name checked only), so the credential store is usable right now.

### What must stay true for paper to stay paper

1. No `ExchangeConnection` row exists, above all none with Kraken credentials.
2. The OKX non-testnet block at `liveOrderExecution/entry.ts` L413-418 stays.
3. `live_trading_enabled` stays absent or false.
4. Nobody uses Exchange Settings to store a key while V6 runs.
5. The server stays on 127.0.0.1 behind its password. Note the log shows 2FA off.

### Hard paper lock (integrator work, outside V6-owned files)

1. **Primary:** in `server/functionRuntime.js` (`loadAll` L262 / `invoke` L308) refuse a denylist while `PAPER_LOCK` is on, default on: `liveOrderExecution`, `executeApprovedTrade`, `liveTradingControl`, `exchangeCredentials`. The registry auto-loads every folder in `base44/functions`, so simply not importing them is not enough.
2. **Defence in depth:** first statement of `liveOrderExecution`, before any decrypt, returns 403 when `PAPER_LOCK` is on.
3. `server/index.js` entity API: reject writes to `ExchangeConnection` and to any `live_*`, `exchange_connection_id` field on `AutoTradingSettings`.
4. Startup assertion: refuse to start the scheduler if `ExchangeConnection` has rows while the lock is on.
5. Test that the denylist refuses each function, and that `grep` finds no private-endpoint call outside `liveOrderExecution` and the exchange helpers.

About 30 lines in total. Turning it off should need an env change and a restart, never a UI action.

---

## B. Live versus backtest

### Evidence limit

Worker `log()` is `console.log` (`entry.ts` L57). `server/logger.js` captures only Logger output, so
no cycle line ever reaches `data/logs`: a grep of all logs for `Run start`, `Universe:`, `BUY `, `SELL `
returns 0 hits. The logger header's claim that each cycle logs the gate is false. Tick-level gaps
cannot be recovered. `Notification` and `SignalOutcome` are the only durable record.

### Why 5 positions opened at 00:00 on 2026-11-05

Not a signal event. It is the daily reset:

- Portfolio take-profit fired 2026-11-04 17:43:48 at +5.24% and halted entries to UTC rollover (`shared/trading/risk.js` L130-137).
- The first tick after midnight rolled counters, cleared the cooldown and `assets_traded_today`, and five empty slots filled at once from strength-95 candidates, $800 each (8% cap).
- The same happens after every trade-cap day. **137 of 449 entries (31%) came in the first 5 minutes of a 4h bar, and 162 of the then 444 at hour 00.** 40 ticks opened exactly 5 positions.
- A single 4h close typically has 50-60 candidates (CommitteeDecision: 231 legacy `enter` rows across 4 bars, today). Strength-95 ties mean selection among them is not meaningful.

### Today's full sequence (Trade + SignalOutcome)

| Entry | Exit | Symbol | Net % |
|---|---|---|---|
| 00:00 | 07:35 | STX | -3.59 |
| 00:00 | 11:35 | UNI | -3.10 |
| 00:00 | 14:40 | ONDO | -3.76 |
| 00:00 | 14:55 | PEPE | -3.21 |
| 00:00 | 15:10 | ZEC | -3.67 |
| 07:35 | 15:05 | OKB | -3.16 |
| 11:35 | 14:40 | XLM | -3.22 |
| 14:40 | 15:05 | LIT | -3.47 |
| 14:40 | 15:10 | STRK | -3.31 |
| 14:55 | 15:25 | AAVE | -3.52 |
| 15:05 | 15:25 | ARB | -3.13 |
| 15:05 | 15:30 | TAO | -3.19 |

All strength 95. Every stop refilled its slot on the same tick into a falling market. The late entries
lasted 20-30 minutes. Result: 24 trades (over the 20 cap, correctly, since exits are not capped), P&L
-$319.93, equity $9,680.07, flat. No entries until 00:00 UTC, when the next burst of 5 comes.

### Churn mechanisms

1. **Vacuous bearish exit.** `entry.ts` L557-574: `sdBearish = !effInd.supply_demand || ...`, `sp500Bearish = !effInd.sp500ai || ...`. With neither indicator on, both are true and every position exits next cycle. Measured: 169 exits with `SD=null, SP500=null`, 2026-10-02 to 10-28; 164 of them within 6 minutes; 21.3% wins; mean -0.32%. That is **41% of all resolved trades**. The current config has `sp500ai` on, so this path is dormant, not fixed.
2. **Stale scanner buy against a fresh exit.** Scanner opportunities up to 24h old are admitted (L396-454, L404) and skip minimum strength, confluence and calibration (L752-768, contradicting the comment at L770-773). Exit uses the fresh closed bar. Example: 11-03 ZEC bought 12:01:34, sold 12:06:29 at SP500=20. 11 of 41 valued bearish exits were within 6 minutes; those 41 won 2.4%, mean -1.19%.
3. **`trades_today` counts buys and sells** (L619, L982), so a cap of 20 is 10 round trips.

### October findings

- **Long inactivity: yes, but flat, not unmanaged.** Oct 3, 4, 10, 11, 12 show 10 entries in the first 30 minutes, then about 24h of nothing (Oct 13 the same by 02:09). On Oct 10-12 the 20-trade cap was consumed by vacuous exits within about 15 minutes. Positions open at noon on Oct 10, 11, 12, 24, 25: 0 by resolved records.
- **Oct 18-19:** `isEdgeSufficient` (`shared/trading/costs.js` L224-238) blocked every entry when TP was 5 and SL 3 (gross 1.0 below 1.2). 0 buys for about 36h and 1,530 undeduplicated notifications. The worker was alive, and the book was flat by resolved records. This covers most of the 46.4h event gap from 10-17 14:40; the first 9 hours of it are unexplained. Why the rate exceeded one per 5-minute tick is not known.
- **Restarts:** boots per log: 10-11:1, 10-20:5, 10-21:1, 10-22:2, 10-26:6, 10-27:6, 11-04:7. No shutdown lines exist. Log days missing for 10-10, 10-24, 10-25 although trades occurred, so a missing log is no proof of downtime.
- **Missed stops:** see C. The largest is XPL: entry 10-31 05:51, exit 11-01 04:36, -12.54%, stop at -12.55%.
- **Non-crypto traded:** stablecoins and tokenised stocks were traded (USDG, RLUSD, XAUT, XSOXS, XSOXL, XMSTR and others): 49 resolved trades, mean -0.68%. Universe filter added 2026-11-04 (commit 1915e5b).

### Divergences from `shared/trading/backtest.js`

| Topic | Live worker | Backtest |
|---|---|---|
| Stop level | Flat 3% **net of entry fee** (L532-551). ATR stop from sizing (L822-830) is never stored | ATR distance, floor 3, skip above 12 (L181) |
| Risk sizing | Sized on ATR distance, stopped at 3%, so realised risk differs from intended | Consistent |
| Stop detection | Last price every 5 min, wicks missed | Bar range, stop first, gap-aware (L205-220) |
| Stop fill | Later market price, overshoots | Stop or gap open |
| Trailing | Activates at +3% net, high from sampled prices | From entry, no activation, bar high (L269-275) |
| Breakeven | Yes | Not modelled |
| Take-profit | Market once net at least 10% | Limit at target |
| Entry timing | Any 5-min tick, mid-bar, ticker price | Next bar open (L287+) |
| Entry filter | Scanner bypass, calibration gate, edge gate | Not modelled |
| Signal exit | Composite below 50 and vacuous AND | Strength threshold (L277-281) |
| Portfolio limits | TP, daily loss, trade cap, `assets_traded_today`, exposure, correlation, market halt | Not modelled |
| Universe | Live top 100 and scanner | Fixed list |
| Slippage | Order book walk | Volume estimate |
| Thin-book exit | Flag ignored, fills at estimate (L579-586) | Holds |
| Fees | `settings.exchange` undefined, so `binance` 0.1% (L518) with OKX data | Per config |

**Backtest bug:** `shared/trading/backtest.js` L101 `volumeScale = 3_600_000/intervalMs`, labelled
"bar quoteVolume to 24h equivalent". It should be `86_400_000/intervalMs`. On 4h it uses x0.25 not x6,
understating volume 24x and overstating impact about 4.9x. This flatters nothing: it inflates backtest
slippage, so the contract's -76% and -83% figures carry a pessimistic bias of unmeasured size. It does
not overturn them on this evidence, but they should be rerun or flagged. Copies under
`base44/functions/*/shared` need `scripts/sync-shared.mjs`.

---

## C. Stop integrity

### Wicks and overshoot

Measured over 126 stop exits: trigger median -3.16%, p5 -3.99%, worst -12.55%. Actual net: mean -3.56%.
Four stops were worse than -5%: XPL -12.54, ANIME -8.31, KAT -7.85, MERL -5.25. Wicks between polls
are invisible, so stops are missed on the way down and only fire if price stays there. Fills then come
at a later price. That is the inverse of the backtest's bar-low logic.

XPL's 22.8h hold and -12.5% is consistent with a stale price or downtime, but neither is proven.

### Failure modes

| Failure | Behaviour | Evidence | Silent? |
|---|---|---|---|
| Symbol leaves universe, is delisted, or is filtered | Price seeded from `last_known_price`; refetch only if undefined or equal to entry, so it **freezes forever**. The "No price" branch at L524 is effectively unreachable | L254-256, L369-374 | **Yes** |
| Primary provider down | ScanResult fallback uses opportunity prices, possibly stale, as marks for stops | L308-351, L360-363 | Yes |
| Both providers down | `market_data_unavailable` returned before exit logic | L308-351 | **Yes**, no alert |
| Coinbase fallback | 40 products, USD quote, no 4h candles | `marketData.js` L170-172, L190 | Partly |
| Schedule guard | `allowed:false` returns before market data, contradicting the comment at L278-284 | `risk.js` L242-243, worker L276-301 | **Yes** |
| Kill switch or `is_enabled=false` | No exits at all | worker L111-113, scheduler L41 | **Yes** |
| Crash mid-cycle | SignalOutcome writes (L623-642, L990) happen before the single Portfolio write (L1147), then Trade (L1150), then settings (L1171): not atomic. Positions may be sold in memory only. Lease self-clears after 5 minutes (L53, L150-168) | | Yes |
| `applySell` returns `invalid_costs` | No log | L615 | Yes |
| Job overlap | Skipped with a warning | `server/scheduler.js` L70 | No |

`server/entityStore.js` L77-79 writes per file atomically (tmp plus rename). There is no multi-entity transaction.

The current universe filter makes the first row likelier: anything held that now fails the filter drops
out of the universe. V6 needs a per-position price age check, a direct fetch for held symbols, and an
alarm. Exits should run before, and independently of, all guards.

### Other stop-adjacent defects

- Positions from `executeApprovedTrade` (L238-246) lack `trailing_stop_price`; `portfolio.js` L244 tests `=== null`, so undefined never sets a trail.
- Scheduler stagger bug: `server/scheduler.js` L87 reads `timers.length` before anything is pushed, so all jobs fire together at the same second.

---

## D. Correctness and signal quality

### Accounting

| Item | Finding |
|---|---|
| Fee double count | **None in the core.** `portfolio.js` `applyBuy` debits notional plus fee, `avg_entry` excludes fee, L184-185 net = gross minus entry share minus exit fee |
| Stop metric | `netPercent` (L64-75) nets the entry fee only, so "3%" is not the realised loss |
| `trades_today` | Buys and sells both count (L619, L982) |
| `daily_loss` | Sum of losing sells only (L618). Ignores wins and unrealised loss, while portfolio TP uses equity. The two guards are asymmetric, despite the comment at `risk.js` L100-102 |
| `daily_start_equity` | Set from `last_known_price` marks at rollover (L247-271), so stale marks flow in |
| Circuit breaker | `risk.js` L33-70 reset does not clear `circuit_breaker_triggered_at`, so later trips do not record or notify (L285) |
| Portfolio TP | Formula is right (`risk.js` L104-127), but nothing reconciles the baseline with balance changes |
| `SignalOutcome` | `exit_price` uses mark, not fill (L634). L624 resolves the first unresolved match by symbol |
| `_dirty` | Always true after `markToMarket` (`portfolio.js` L232): writes every cycle |
| `executeApprovedTrade` | Different cost model, fee inside `quoteAmount` (L160, L249), and positions lack `fees_paid`, `last_known_price`, `opened_at` |
| `isEdgeSufficient` | Assumes 50% win rate against a measured 27% |
| Calibration | See below |

### Unresolved anomalies (not proven; do not treat as explained)

1. **False portfolio take-profit:** 99.01% (10-09 18:09), 100.27% (10-22 08:58 and again 10-27 12:46). Each force-closed everything and halted the day. It implies equity near 2x `daily_start_equity`. Fees suggest equity near $5k on Oct 9-22 and $10k by Oct 27, so a balance change is the obvious suspect, but the identical 100.27 twice is unexplained. Exact cause not found.
2. **Out-of-band reset on Nov 4:** after 17:43, no SELL notifications and no SignalOutcome resolution for UNI, XAUT, NEAR. `Trade.json` has nothing before today and `daily_start_equity` was exactly 10000. `resetTradingData` does not fit, since it would have cleared Notification and SignalOutcome, and no reset log line exists. Portfolio and Trade appear to have been changed another way. **Worth asking the owner.**
3. **38 orphaned SignalOutcome rows**, none matching an open position, so they will never resolve. Includes batches of 5 on 10-02, 4 on 10-20, and the 11-04 trio above.

Because of (2), Trade history is one day long. **Do not use `Trade.json` for performance.** Reconstruction
from Notifications: 298 matched round trips, gross -$1,028, fees $318, net -$1,347. It is lossy (6-dp prices,
13 unmatched) and spans different account sizes, so treat it as direction only.

### SignalOutcome: 449 rows, 411 resolved, 38 orphaned

Overall: 27.3% wins (Wilson 95% 23.2-31.8), mean -0.78% net (CI -1.04 to -0.53), median -0.51%.

| Strength | n | Win % (Wilson 95%) | Mean net % (95% CI) |
|---|---|---|---|
| 60-69 | 34 | 32.4 (19.1-49.2) | +0.14 (-0.67 to 0.95) |
| 70-79 | 23 | 34.8 (18.8-55.1) | -0.08 (-0.30 to 0.13) |
| 80-89 | 93 | 28.0 (19.9-37.8) | -0.67 (-1.21 to -0.12) |
| 95 (the only value above 87) | 261 | 25.7 (20.8-31.3) | -1.01 (-1.34 to -0.67) |

Direction is inverted: stronger signals did not do better. Win-rate intervals overlap, so this does **not**
show lower strength is good. It shows strength has no demonstrated positive value.

| Exit | n | Win % | Mean net % | Sum % |
|---|---|---|---|---|
| Stop | 126 | 0 | -3.56 | -448.6 |
| Vacuous bearish | 169 | 21.3 | -0.32 | -54.3 |
| Valued bearish | 41 | 2.4 | -1.19 | -48.6 |
| Trailing | 61 | 100 | +1.99 | +121.1 |
| Take-profit | 14 | 100 | +7.74 | +108.4 |

Payoff shape: a stop costs about 1.8 trailing wins. Hold under 6 minutes: n=178, mean -0.40%.

Period: before 10-18 mean -0.60; Nov n=42, 11.9% wins, mean -1.98 (CI -2.68 to -1.29).

**Caveats.** Five weeks, one market period. Entries cluster (40 ticks of 5), so trades are not
independent and effective n is well below 411; the CIs above are too narrow. Config changed repeatedly,
and buckets are confounded by exit regime: 41% of trades had no real exit test, unevenly spread
(vacuous share: 60-69 38%, 70-79 91%, 80-89 49%, 95 34%). The 70-79 row is close to untested. Percentages are per position, not account return. No conclusion here
is about the composite as a strategy under a clean exit rule, only about this bot as run.

### Calibration

`CalibrationModel`, fitted once on 10-23 (n=267): predicts 0.585-0.615 against about 0.30 actual, and slope
**positive** while the data slope negative. Cause: `calibrateSignals/entry.ts` L21-22 runs 2,000 gradient steps at
0.01 on unscaled 0-100 input, so the fit has not converged. No scheduler job refits it. The entry gate
(L795) needs probability at least 60, which works out to strength about 80: it **rejects the 60-79 range**
on the normal path, while the scanner bypass ignores it. Discard for V6.

### CommitteeDecision: 239 rows, **0 outcomes**

Agent quality **cannot be measured yet**, and nothing below is evidence of edge.

- All rows are from 2026-11-05 00:00 to 13:00. The committee was built on 2026-11-04 (12f66f0 onward), and entries were halted until midnight. Coverage is 21 cycles, 83 symbols.
- Outcomes need 25 bars, 100h on 4h (`committee.js` L728-733), so the first ripen about 2026-11-09 04:00, assuming `committeeOutcomes` stays on. The `resolveCommitteeOutcomes` header's "24 hours" is wrong for 4h.

| Agent | Long | Against | Abstain | Veto | No data |
|---|---|---|---|---|---|
| trend | 44 | 85 | 110 | 0 | 0 |
| momentum | 227 | 4 | 8 | 0 | 0 |
| volumeFlow | 104 | 32 | 103 | 0 | 0 |
| structure | 9 | 27 | 203 | 0 | 0 |
| marketRegime | 0 | 0 | 239 | 0 | 0 |
| derivatives | 108 | 6 | 125 | 0 | 26 |
| liquidity | 96 | 15 | 128 | 4 | 8 |

Decisions: 62 enter, 138 no_quorum, 28 dissent, 7 low_score, 4 veto. Filter verdict on 231 legacy entries: 199 allow, 32 block.
Momentum says long 95% of the time, which adds little because rows are selected on legacy entry.
marketRegime has abstained on every row. Anecdote only: all 5 midnight entries were allowed and all were stopped;
3 of the other 7 had some earlier block (OKB, STRK, TAO). n=12, one down day. No inference.

---

## E. What to keep, and cutover

### Module verdicts

| Module | Verdict | Notes |
|---|---|---|
| `shared/trading/indicators.js` | Keep | No trading dependencies |
| `shared/trading/portfolio.js` | Keep the accounting | Fee logic is sound. Fix `=== null` at L244 |
| `shared/trading/costs.js` | Keep `applyCosts`, `estimateFillFromBook` | Drop `isEdgeSufficient`; set fees per venue |
| `shared/trading/marketData.js` | Keep closed-bar logic | Needs held-symbol fetch and health output |
| `shared/trading/sizing.js` | Keep with care | Imports only indicators. Not reviewed line by line; the stop it computes must actually be stored |
| `shared/trading/risk.js` | Keep ideas only | Rollover, breaker defects above |
| `shared/trading/signalEngine.js` | Keep as a feature source | Deterministic, but `strength` has no shown value |
| `shared/trading/committee.js` | Shadow only | Revisit after outcomes ripen |
| `shared/trading/strategyLab.js`, its worker | Keep, independent | Own accounts and entities |
| `shared/trading/backtest.js` | Fix L101 first | Reference only |
| `server/logger.js`, `scheduler.js`, `entityStore.js` | Keep | Fix stagger; route job output to file |
| `autoTradingWorker`, `tradingScheduler` | **Retire** | |
| `calibrateSignals`, `CalibrationModel` | **Discard** | Unconverged |
| `autoTradingEngineBackend` | Delete candidate | Dead per header L7-14 |

`altcoinScannerWorker` writes only `ScanResult`, so it cannot trade.

### What breaks when the legacy worker stops

| Consumer | Effect |
|---|---|
| `AltcoinScanner` page | Fine: `ScanResult` comes from the `altcoinScan` job. Keep that job |
| `StrategyLab` page | Fine: own job and entities |
| `Committee` page | **Freezes.** `CommitteeDecision` is written inside the worker (L1012-1135). Existing rows still resolve while `committeeOutcomes` runs |
| `TradeSignals` page | Reads Portfolio, Trade, settings, `aiTradingRecommendations`. Works; shows V6 data once V6 writes |
| `AutoTrading` page | Its toggle becomes misleading: it would suggest control over V6. Needs a label change |
| `Trading` page | Works. Run-now button (L1365) still invokes `tradingScheduler`, gated only by `is_enabled` |
| `CalibrationPanel` | Stops getting new `SignalOutcome` rows |
| Notifications | Trade and risk notices stop unless V6 emits them |
| Heartbeat | Independent of jobs; a healthy ping does **not** mean trading ran |

### Why not to run both

`Portfolio` is reused by contract. The worker walks **every** position, applying its flat stop and bearish exit
to anything there, and rewrites the record each cycle (L1144-1147). So V6 positions would be stopped by legacy
rules and concurrent V6 updates lost. A partial switch-off is not safe.

### Recommended cutover

**Best window: now until 00:00 UTC on 2026-11-06.** The account is flat with the cap hit, so no decision is needed on legacy positions. The 5 positions in the brief no longer exist. Recheck first, since this was true at 16:30 UTC.

1. Confirm `Portfolio.positions` is empty.
2. Set `is_enabled=false` in `AutoTradingSettings`. Safe only because flat; it strands anything open. This stops the midnight burst and also covers the Trading page button.
3. Remove the `tradingScheduler` entry from `JOBS` (`server/scheduler.js` L14) and restart. Keep `altcoinScan`, `notificationCleanup`, `committeeOutcomes` (at least until 11-09), `strategyLab`.
4. Land the paper lock (A) before V6 starts.
5. `snapshotEntities`, then let V6 adopt the record at $9,680.07 (`adoptLegacyPortfolio` in `shared/trading/v6Paper.js` L656 exists). Do not reset: keep the loss on the books.
6. Keep legacy `Trade` rows; V6 rows are told apart by `exchange: 'Paper Trading (V6)'`.

**If midnight passes first,** 5 new positions open. Do not use `is_enabled=false`. Set `max_trades_per_day: 0`, which is exit-safe and verified: `checkTradeLimit` accepts 0 (`risk.js` L139-142), `newEntriesAllowed` false (L273), loop guard at L811 also stops scanner buys, and exits continue. Raising `min_confidence` would **not** work, because scanner buys bypass it. Wait until flat, then step 2. Most holds end within a day (26 of 411 ran over 12h; the longest 54h). Do not have V6 adopt legacy positions: their true stop is not stored, and they sit on legacy exit rules.

Rollback: re-add the job and set `is_enabled=true` only after V6 is flat and stopped.

---

## F. Log noise: `aiMarketIntelligence`

**Cause confirmed: a browser widget, not the trading engine.**

1. `src/components/trading/NewsWidget.jsx` L30-38 polls every 5 minutes; L46-55 fetches the top 5 assets in sequence. It is on by default (`src/pages/Trading.jsx` L67, L1588-1590).
2. `src/components/trading/AdvancedSignalGenerator.jsx` L38-65: `src/api/base44Client.js` L160-166 returns `{data}`, but L52 checks `response?.success`. That is always falsy, so **every successful result is discarded** and the 10-minute cache at L59 is never filled. The deployed bundle has the same code. Failures are not cached either, and the client limiter (8/min, L17) does not stop 5.
3. Server `aiMarketIntelligence/entry.ts` L6-9, L37-55 allows one call per 60s and returns 503 otherwise, logged as ERROR at `server/index.js` L345. So one of each 5 reaches the LLM, the others are "rate limited".

Measured today: bursts of 5 at 300s; 248 invokes (10 succeeded and were thrown away, 201 limited, 37 unavailable). Oct 14-23 and Oct 30-Nov 4 ran at 60s cadence, about 7,200 invokes a day, in 5 clusters at 60s offsets. That fits several open Trading tabs, which is an inference. It only happens with a signed-in tab (none from the 22:49 restart to 09:42 sign-in today).

Also: `add_context_from_internet` is unsupported locally (`server/functionRuntime.js` L139-141), so "real-time" intelligence has no live source and can be invented.

Fix: read `response.data`, cache failures with a retry-after, fetch on demand rather than polling, and log the 503 at debug. Or remove the widget, which is the better call given the point above. Check `AIAnalysisModal` L84 for the same shape bug. No effect on trading.

---

## Changes needed outside this file (for the integrator)

| File | Change |
|---|---|
| `server/functionRuntime.js`, `base44/functions/liveOrderExecution/entry.ts`, `server/index.js` | Paper lock (A) |
| `server/scheduler.js` | Remove `tradingScheduler` job; fix stagger at L87 |
| `shared/trading/backtest.js` L101 | Use `86_400_000/intervalMs`, then sync |
| `server/logger.js` or job runner | Capture job output to file; V6 must log every cycle |
| `src/components/trading/*`, `src/api/base44Client.js` | Fix or remove news polling |

## Requirements this audit implies for V6

- Exits run first and are independent of every guard; price age is checked per position; held symbols are fetched directly; failure raises an alarm.
- The stop computed at entry is the stop stored and enforced.
- No midnight refill: spread or rate-limit entries, and no same-tick refill after a stop.
- Filters that count (universe, entry gate) apply on every entry path.
- Every cycle leaves a durable record, including no-ops.

## Not done

- `signalEngine.js`, `sizing.js`, `strategyLab.js`, `altcoinScannerWorker` were read in part only.
- `scripts/doctor.js` was only grepped (L130-133 reports paper or live).
- No market data was fetched, so wick and missed-stop sizes are from recorded exits, not candles.

Scratch scripts: `data/tmp/audit-engine/` (`so.mjs`, `days.mjs`, `cd.mjs`, `g.mjs`).
