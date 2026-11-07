# V6 engine and control

Agent `b-engine`. Worker `base44/functions/v6Engine/` (`engine.js`, `intrabar.js`, `entry.ts`), API
`base44/functions/v6Control/` (`control.js`, `entry.ts`). Tests `tests/v6Engine.test.mjs`,
`tests/v6Control.test.mjs`. Paper only: public market data, no keys, no signed endpoints.

## The cycle

Every 5 minutes, in `runCycle`:

1. Take the run lock: an in-process flag, then a lease in `V6Config.engine_lease` (10 minutes).
   Another live process's lease skips the cycle. An expired lease or a dead pid is taken over.
2. Finish any outbox a crash left behind.
3. Cutover check, on first run only.
4. Load certificates and strategy states, and choose the strategies that may run.
5. Quote held coins directly, never through a universe.
6. Apply operator requests, once each, by request id.
7. Exit delisted coins.
8. Read 5-minute bars for held coins.
9. Run one `step` per timeframe with a newly closed bar, plus one in-bar pass for the rest.
   Fills land between passes.
10. Apply operator close requests, run lifecycle updates, build rows, commit.

Nothing above can stop an exit. Halts, pauses, a missing certificate, a missing gate and a legacy
conflict only remove strategies from the step. Positions are always evaluated.

## Atomicity

The store has no multi-file transaction, so the commit is one atomic write of the Portfolio row. It
holds the ledger, `v6_state`, and an `outbox` of every Trade and V6* row the cycle made, with fixed ids.

| Crash point | Result |
|---|---|
| Before the commit | Nothing happened. The next tick repeats the work. |
| After the commit | The ledger is right, rows are missing. The next cycle drains the outbox, skipping ids that exist. |
| During the drain | Same. Inserts check ids; upserts are last-write-wins. |

`v6_state.consumed` records request ids inside the commit, so a request cannot apply twice.

`V6Config` is written by `v6Control`, plus the lease and request clearing by the engine. Risk state
lives in `Portfolio.v6_state.riskState`, which only the engine writes.

## Time

`step` gets wall-clock `t`, read after the prefetch. The gate ages books and bars against that `t`
with a 30-second book limit in both directions, so passing the bar close would refuse every book.
Entry fills are stamped with the bar close, the simulator's next-bar open. Exits floor by `barMs`, so
`barsHeld` matches the simulator. `Trade.executed_at` holds the wall time.

A bar counts as closed 3 minutes after it ends. If the closed bar is not published yet, the decision
waits for a later tick, and it is never made on a stale bar.

## Wicks

The hub has no 5m timeframe, so `intrabar.js` reads public 5-minute klines from OKX, Bybit, then Binance,
one request per held coin on a normal tick, with a 10-minute cooldown after 403, 418, 429 or 451. After an
outage it pages back through the gap, up to 12 requests per coin: about 100 hours on OKX, 41 days on the
others. Anything older, or a venue that stopped answering part way back, is read from closed hourly and
daily bars (`gap_coarse`). A stop touched on one of those fills at the worse of the stop, that bar's open
and the current book, and raises `gap_fill`.

Every past price sample (5-minute wick, read-back, gap bar, closed bar) is tested against `stopAt(position, t)`
in `v6Exits`, the stop in force when the sample began, and never the current stop. In the engine that is
`stopTouchedBy`. Null means nothing is known that far back, so the sample tests nothing. Only samples that touched
reach the exit module, so a low between an old and a new stop is not acted on, and a read-back that touched an
older stop fills from that stop. A sample spanning a ratchet meets the older stop, so a low after the ratchet
inside that sample can be missed; hourly bars limit that to the hour of the ratchet.

`rangedExits` wraps `evaluateExit` and widens only the adverse side of the bar. The favourable side stays
at the mark, because the simulator ratchets on closed bars only. The stop fill uses the worse of the stop
and the open of the first 5-minute bar that touched it, so a gap is not forgiven. With no 5-minute data
the stop is checked at the mark and `wick_unavailable` is raised.

Targets are not checked against 5-minute highs. A target touched only between polls is missed.

`rangedExits` also passes `after: { h, l }`, the tick's range, so a stop moved earlier in the bar meets
what came after it.

## Prices without consensus

CONTRACT section 6: "Exits use the last good price and raise an alarm." While venues disagree on a held
coin the reported price is not used for the mark, for a stop or for the wick. `position.lastPrice` stays,
`no_consensus` is raised, and drawdown and breakers do not move on one venue's print.

The bound is `NO_CONSENSUS_MAX_MS`, 15 minutes, or three ticks. An unconfirmed price never ratchets a stop,
never raises the equity high and never sets a fill, on either side of the bound. Past it the exit needs evidence
that executes:

- A usable book (two-sided, not crossed, not stale) wins over every print. On a disputed tick, and on every tick
  once the clock runs, the book is read. `state.bookCrossSince` starts when it first crosses the stop, and only
  the book staying on the safe side for a whole 15 minutes (`state.bookSafeSince`) clears it. An ok tick does not,
  nor does a brief safe-side book, nor losing the book. Once it has
  run 15 minutes the mark is the book, so a position closes at book prices at most 15 minutes plus one tick after
  the cross, even if consensus keeps coming and going above the stop. A cross after a long disagreement waits
  its own 15 minutes.
- Past the bound with the book on the safe side, the mark is the best bid, or `position.lastPrice` if that is
  lower, so it can only worsen. `no_consensus_long` is raised. Print 50 with a book at 100 sells nothing; print 300
  with a book at 100 moves nothing.
- With no usable book the mark worsens to the worst price any venue reports, and `no_consensus_no_book` is raised.
  If that fires the stop, the fill comes from that price and `exit_worst_quote` states it. One bad print can
  close a position here. That was chosen over holding with no evidence at all.

A real crash on which the venues agree has `ok: true` and exits on the same tick. The closed-bar check on a new
bar is unchanged.

Wicks are not read while venues disagree, past the bound included. `state.wickFrom` keeps where the gap began, and
the first tick with consensus reads back from there, so a wick through the stop in that window exits then, not
on the next daily bar. A wick while venues are still apart past the bound is not acted on: the book decides.

## Strategy code missing

A held position whose strategy is not in the registry keeps its stop, trail and regime exits, but signal exits
need the strategy's code and cannot run. `strategy_code_missing` (warning, per coin) says so.

## Failure classes

| Case | Behaviour |
|---|---|
| Held coin leaves the universe | Still quoted and managed; universes only feed entries. |
| All venues down | Marks at the last good price, critical `all_venues_down`, exits fill at `tier_fallback` from that price. The delist clock does not start. |
| One coin unquoted while BTC is fine | Clock starts. After 3 days it exits at the last price minus the 10% haircut, `delisted`. |
| No consensus on a held coin | Exits use the available price, warning raised. Entries need `consensus.ok`. |
| Partial exit | `exitPending` is stored, the remainder is re-emitted each tick. |
| Nothing fills on an exit | `exitPending` is stored and a critical alarm raised. |
| Entry with no usable book | Skipped, never filled at a guess. |
| Legacy on after cutover, or the account changed outside V6 | Critical alarm, entries blocked, exits continue. |
| Cycle throws | Nothing committed, `cycle_failed` stored, next tick retries. |

Repeating alarms are stored when they start and hourly after that.

## Strategy loading

`selectStrategies` runs `STRATEGIES` through `verifyCertificate`. With none valid, the account holds cash
and one `in_cash` event records the reason when it changes. This is the expected state until the final
validator runs. Codes: `no_strategies`, `no_certified`, `all_disabled`, `shadow_only`, `gate_unavailable`.

The gate is loaded by dynamic import, naming each export it uses, so a broken gate module blocks entries
without stopping exits. `issueCertificate` is not imported by either function, and a test scans for it.

## Cutover

First run only, when the Portfolio row has no `v6_state`. Refused with a daily critical event if legacy
`is_enabled` is on (`legacy_enabled`), any position is open or the list is not a list (`not_flat`), more than
one Portfolio row exists (`multiple_portfolios`) or a needed file is unreadable, and the row is left untouched.

Legacy counts as on if any `AutoTradingSettings` row has a truthy `is_enabled`, whatever its date or type, so
the text `"false"` blocks too. `status.legacy` reads the same way. An unreadable file blocks as `store_unreadable`.

`setExchanges` accepts own keys of `EXCHANGES` only, once each, for venues and the book role.

A `positions` value that is not a list sets `status.positionsDamaged` and a NEEDS_REVIEW headline until the
next cycle restores it from the record. Re-enable and `recutover` treat it as not flat.

The first commit pins `V6Config.portfolio_id` and `cutover_at`. The engine and `v6Control` read that row
and no other. An extra row raises `multiple_portfolios` and blocks entries, and V6 stays where it is. A
pinned row that is gone, or has lost `v6_state`, stops the engine (`portfolio_missing`, `state_missing`).
It never starts over by itself, because that would wipe the halt, the high and the history. The `recutover`
action (confirm word RECUTOVER) restarts it, and only on a flat account that really lost its state.
A flat account keeps its real cash, realized P&L and trade count. With no Portfolio row, one is created
with 10,000 of paper cash.

`tradingScheduler` is out of `server/scheduler.js`, and `strategyLab` keeps running. The stagger bug is
fixed. A job can return `logLine` for a durable log line.

## Reset protection (I3)

`resetTradingData` keeps V6 entities and V6 Trade rows, and leaves alone any Portfolio row with
`v6_ledger` or `v6_state`. Its result gains `v6PortfoliosKept`. So a legacy reset no longer resets the
account once V6 owns it, and there is no V6 reset path yet.

`EntityStore.delete` and `deleteMany` refuse with 403 if they would reach a V6 trade or a ledger row, and
remove nothing. This sits in the store, so the browser, the entity API and functions are all covered.
Names are compared in lower case, because `TRADE` reaches the same file on Windows.

`Trading.jsx` now stops on `v6RecordExists()` before its Portfolio write, and its trade delete is scoped.
That delete was `deleteMany({})`, which the store has always refused, so the old reset failed after it had
already written the Portfolio row.

## The account record

Each commit stores `v6_state.record`, a copy of the balances, positions, counters and `v6_ledger`. The next
cycle loads the ledger from that copy and only compares the row with it. A difference sets `state.foreign`:
critical `foreign_change`, repeated hourly, entries blocked, and the commit puts the row back. So an edit can
neither change the ledger nor stop an exit, however bad its values. It stays up until the operator
acknowledges a `foreign_change` event, which reaches the engine as `foreign_ack_request`. An edit arriving
with the acknowledgement keeps the alarm up.

A legacy page's manual trade on the V6 account therefore answers 200 and is then undone. Refusing it would
break pages that write those fields before cutover, and the entity API cannot tell one intent from the other.

## Entity API

Engine state is writable by the engine, `v6Control` and the certificate script, which reach the store
directly, and by nothing over HTTP. `assertEntityApiWrite` in `server/entityStore.js` sees every entity
write, with the canonical name:

- Any entity named `V6*`: 403, including `V6Config`, so a forged lease or request cannot get in.
- Portfolio: any body key starting `v6`, null included, on every route. `positions[].v6` that differs from
  the stored one, the mark aside. A new row while V6 owns one. A bulk update matching the V6 row.
- Trade: creating one with the V6 exchange or a `v6` id, re-labelling, rewriting or bulk-updating a V6 row.
- User: demoting, renaming or deleting the operator, by single or bulk route. `role: ''` and null count.

Legacy Portfolio writes (`total_balance`, `available_balance`, `positions`, `total_profit_loss`,
`total_trades`) still pass, because all five pages use them. See the account record above.

`drainOutbox` has its own allowlist (Trade with the V6 exchange, `V6StrategyState`, `V6SignalTest`,
`V6RiskEvent`, `V6ExchangeHealth`, `V6EquityPoint`), and it never throws. Other entries are dropped with
`outbox_rejected`. Rows that fail stay in the outbox with `outbox_failed`; telemetry is capped at 500, and
trades and lifecycle rows are not capped.

A lease is believed only if `until <= now + LEASE_MS` and the pid is a positive integer. Anything else is
ignored with `lease_invalid`.

Entity names are canonical at the store (`canonicalName`): schema files first, then data files, then the
first spelling seen. One cache and one file per entity. No-match bulk writes do not touch the file.

## Cross-site requests

`refuseCrossSite` in `server/index.js` runs before auth and before the OPTIONS answer, so it applies with no
password set. It decides what is an API path from the same segments the router uses, so `/.//api/...` counts.
Every `/api/` request, reads included, gets 403 if Host is not local (DNS rebinding). A state change also gets
403 if Origin is not this server or the dev server, or if `Sec-Fetch-Site` is `cross-site`. A body that is not
`application/json` gets 415. No Origin means a local tool, which is allowed: a process on this machine is not
what this defends against.

## Damaged files

An empty list in a file that keeps a `.good` copy, beside a copy with rows, is restored like a damaged file
(`store_restored`, why `empty`). `_save` writes both files, so a real delete leaves both empty and stays deleted.

Unreadable never reads as empty. `_load` saves one `.corrupt-<ts>` copy, and reads and writes then throw
`ENTITY_UNREADABLE` (503), so nothing overwrites the damaged file. Valid JSON that is not a list counts.

`Portfolio`, `V6Config`, `V6StrategyState`, `V6Certificate` and `AutoTradingSettings` keep `<name>.json.good`,
refreshed after each write. Damaged or deleted, they restore from it and the store writes a critical
`store_restored` event. Entries stay blocked until that event is acknowledged; exits continue.

Any other unreadable file blocks entries with `store_unreadable`, listed in `lastCycle.store_faults`, and
exits continue. A log found damaged only at write time blocks entries from the next tick. With
`V6RiskEvent` itself unreadable, `lastCycle` and the server log are the only record.

Portfolio unreadable with no good copy is the one case that stops exits: `portfolio_unreadable`, status
`stopped`, and a person repairs the file. There is no ledger to exit from.

Strategy state resolves to the safest answer. `v6_state.lifecycles` remembers each lifecycle. A row that
vanished after leaving research, or that claims better than a remembered shadow, becomes shadow at size 0
with `strategy_state_lost`, and only `returnFromShadow` brings it back. With the file unreadable, no
lifecycle moves at all. A strategy never seen before starts normally, so a late certificate still works.

## Exits whatever the entry state

A held position gets its stops, targets, regime exit and signal exit with the certificate gone, the operator
switch off, legacy on, an account alarm, or no gate. Regime is computed on every new bar with a held position.
A strategy that may not enter has its signals read by the engine and passed through `rangedExits`, never
through `step`, so a signal that can close a position cannot open one. Its full universe is read in case
its signals depend on the other coins.

## Quarantined rows

`paper.adoptLegacyPortfolio` puts an unreadable position row in `ledger.quarantined` and writes it back as
it came. Such a row has no stop and never exits. Each one raises critical `position_quarantined`, hourly, on
the first run too, blocks entries, and is listed in `status.quarantinedPositions` and left out of
`status.positions`. The record holds the row too, so a repair means editing `positions` and
`v6_state.record.positions` together with the server stopped. There is no action for it yet.

## Venue roles

`V6Config.roles` holds `{ replay, book }`. `setExchanges` refuses a replay venue other than OKX or Bybit, and
a role venue that is switched off. It does not move a role silently. With no saved role, `exchanges` reports
the first capable enabled venue.

- Replay: both venues go to the gate as an array, the chosen one first, so an unusable venue falls back.
- Book: the gate's book and the entry fill use the chosen venue only, so its failure costs entries.
- Exits try the chosen venue, then any venue.

## v6Control

All actions in gui-design section 6, plus `returnFromShadow` (I8), which the GUI calls with
`{ id, confirm: 'RETURN', note }`. It leaves a request; the engine runs the gate's `returnFromShadow`.
`setSleeves` always refuses (I4). `status.risk.allTime` is
`{ highEquity, highAt, drawdownPct, reenables }`, as `useAllTimeDrawdown.js` reads it.

`returnFromShadow` verifies the certificate itself and fails closed with no gate. A repeat while a request is
waiting gets the first request's time and queues nothing; `shadowReturn.pending` shows that state.

Warm-up: the first `min_trades` shadow signals do not count toward the 20. `shadow_in_range` still includes
them, because the gate owns that field. Control subtracts them for the count and the refusal, and the engine
passes the gate the same reduced number. A signal at exactly `min_trades` does have a verdict, so this is one
signal stricter than "no verdict" implies; it follows the decision as written.

`strategyDetail.certificate.status` is the verified status, and `storedStatus` keeps the stored word.
`drift.breaches` has one `{ x, text, note }` marker where the line enters a breach, using the gate's
`evaluateDrift`.

`setRiskConfig` refuses, in order: unknown or read-only keys, values outside a ceiling, anything the clamp
would move, then loosening on the quarter-size rung or worse, while halted, or with unreadable state.

## Known limits

- Multi-timeframe strategies are tested only on 1d. The 4h path shares the code but has no test.
- A top-N universe with real venues has not run: no certificate exists, so that prefetch is only covered
  by a fixed universe on a mocked hub. A large universe may take longer than 30 seconds to read books.
  Stale books fail check 5, so the cost is missed entries, not bad ones.
- `V6SignalTest` uses a stub gate in most engine tests. One test runs the real `createSignalGate`.
  No engine test passes all seven real checks, because that needs a real certificate and history table.
- `data/v6/signal-history.json` missing means check 6 fails, which blocks entries.
- Perp funding is not charged: V6 strategies are spot today, and `applyFunding` is not called.
- A position's `stale` comes from `v6_state.priceAt`, set when a quote arrives, and turns true after 11
  minutes or when no time is recorded. A price from a venue disagreement does not count, until the bound.
- `status.risk.worstDrawdownPct` is measured from `v6_state.allTimeHigh`, which only rises. A re-enable rebases
  the risk engine's `equityHigh`, not this. It also lives in `v6_state.worstDrawdownPct`, because retention
  thins old equity points. A drawdown from before that field existed is only known from surviving points.
- `user.role !== 'admin'` on `v6Control` is checked by a source test only. The E2E has no password set, so
  the caller is the local operator and gets 200. With a password set, the server answers 401 without a session.
- Tiers come from 1d bars at decision time. A held coin with no stored tier pays tier 3.
- Anyone with file access can still edit `data/entities`, including `v6_state.record` and a `.good` copy,
  and can recompute a certificate seal. The guards cover the HTTP API, not the disk.
- A wick is one venue's print. With consensus healthy it can still fire a stop on its own.
- A closed bar on a new-bar pass is not held back by a disagreement on the live price.

## Changes needed in files owned by others

- `shared/trading/v6Exchanges.js`: add a 5m timeframe, then delete `intrabar.js`, so backoff is shared.
- `shared/trading/v6Core.js`: pass `openPositions` to `updateRiskState` and call `noteEntryRejection`.
  The engine does both through `modules.risk` for now, and matches the rejection on its message text.
- `README.md`: "The app rejects any key that can withdraw" is false for OKX and Kraken (paper-lock.md).
- `server/index.js`: the header comment still says the server can arm live trading.
- GUI: nothing shows `status.quarantinedPositions`, and nothing offers `recutover`.
- `shared/trading/v6SignalGate.js`: count only signals with a verdict in `recordShadowResult`, so
  `shadow_in_range` means what it says. Then the subtraction in control and the engine can go.
