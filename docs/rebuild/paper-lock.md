# PAPER_ONLY lock

Agent: `b-lock`. Closes audit section A (`docs/rebuild/audit-engine.md`).

Paper trading used to depend on no `ExchangeConnection` row existing. It now depends on code.
While the lock is on, no signed order can leave the process, whatever is stored in the data folder.

## Releasing it

The lock is on by default. There is no GUI, API or entity path to turn it off. A release needs
**both** of these, then a restart:

1. Env var, in `.env` or the service definition:
   `CRYPTOMATE_PAPER_LOCK_RELEASE=I_ACCEPT_REAL_MONEY_RISK`
2. Marker file `PAPER_LOCK_RELEASED` in the app root (next to `package.json`, not in `data/`),
   containing that same phrase. Save it as UTF-8 or ASCII: PowerShell 5.1's `>` writes UTF-16,
   which does not match, so the lock stays on. Use `Set-Content -Encoding ascii`.

`PAPER_ONLY=false`, `1`, `true`, a wrong phrase, or either half alone all leave it locked. The
decision is made once, when `server/functionRuntime.js` is imported, and frozen. Changing the
environment later, including `Deno.env.set`, has no effect.

Every boot records the state in the log: `PAPER_ONLY lock: ON`, or a banner reading
`PAPER_ONLY lock RELEASED`. With only one half set, a warning names the half that is present.

## The layers

| # | Where | What it stops |
|---|---|---|
| 1 | `FunctionRegistry.loadAll` | `liveOrderExecution` is not imported, so no handler exists |
| 2 | `FunctionRegistry.invoke` | Denylist, 403, for HTTP, scheduler and function-to-function calls |
| 3 | `liveOrderExecution` entry and both `execute*Order` helpers | First statement, before any decrypt. A missing lock value counts as locked |
| 4 | `liveTradingControl`, `executeApprovedTrade` | `request`/`enable` refused; approvals skip the live branch |
| 5 | `guardStoreForPaperLock` | Arming writes refused at the store, shared by the entity API and all functions |
| 6 | `maskConnection` | Functions read a stored `ready_for_live` as `simulated` |
| 7 | `paperLockFetchRefusal` | Outbound tripwire on `fetch`: only the two Balance calls may be signed |
| 8 | `assertPaperLockAtBoot` | Logs live state loudly. Never throws, never stops the scheduler |
| 9 | `src/pages/Trading.jsx` | Paper notice, arming panel hidden, no live handler passed to the modal |

### Why layer 6 exists

`autoTradingWorker` places the live sell first and, on failure, does `continue`, which skips the
exit. If armed data existed and the order were simply refused, the worker would believe it was live
and **paper stops would stop firing**. The worker is not an owned file, so the shim makes the
connection look simulated and the worker takes its normal paper path. Removing the mask makes the
stop test fail. Only `trading_mode` on `ExchangeConnection` is masked, so `AutoTradingSettings`
stays truthful for the V6 banner, and the raw entity API still shows the true stored values.

### What counts as an arming write

- `AutoTradingSettings`: any `live_*` field and `exchange_connection_id`, unless the value is
  `false`, `null` or absent. The string `"false"` is refused.
- `ExchangeConnection`: `trading_mode`, unless `simulated`, `null` or absent.
- Entity names compare case-insensitively. On Windows `autotradingsettings.json` is the same file,
  so a lower-case entity name would otherwise have been a real bypass.
- Rewriting a value already stored passes, so a whole-row settings save still works and a kill
  switch can be set while live state exists.

## Deliberate differences from the audit's list

- **`executeApprovedTrade` is not denylisted.** It is also the paper path for manual approvals, and
  its only route to an order is `liveOrderExecution`. While locked it fills as paper
  (`Paper Trading (Manual Approve)`). Denying it would break paper approvals and rejections.
- **`exchangeCredentials` is not denylisted**, per the brief: it signs read-only Balance calls only.
  `store`, `test`, `delete` and `fetchBalances` all work, so a key can still be stored. A stored key
  is inert while locked.
- **`disable` and `cancel` on `liveTradingControl` stay allowed.** They only reduce state, and
  they are the way to clear live state.
- **Writes to `ExchangeConnection` are not refused wholesale**, only `trading_mode`.
- **The scheduler still starts when live state is found**, per the brief. The audit proposed
  refusing to start it, which would have stopped exits.

## Clearing live state while locked

Boot leaves stored rows as found, so the evidence survives. The panel with the Disarm button is
hidden while locked, so this is an API call, from a signed-in session:

`POST /api/functions/liveTradingControl` with `{"action":"cancel"}`

`cancel` clears the first settings row and the first active connection only. Any other connection
left at `ready_for_live` needs `PATCH /api/entities/ExchangeConnection/<id>` with
`{"trading_mode":"simulated"}`, which the lock allows.

## Known limits

- The tripwire wraps global `fetch`. Code using `node:https` or undici directly would pass it.
  Nothing in the repo does, and layers 1-5 do not depend on it.
- It is a code lock, not a sandbox. Someone who can edit these files can remove it. A script run
  outside the server process is not covered at all.
- `liveOrderExecution` `dry_run` is refused too, because the whole function is denied. Credential
  checks go through `exchangeCredentials` `test`.
- Masking changes what functions read, so a worker log may say "not in ready_for_live mode" while
  the file says otherwise. The boot log and `/api/health` `paperLock.liveStateFound` report the truth.
- `/api/health` only returns `paperLock` to a signed-in session. Without it the Trading page assumes
  locked, which is the safe direction.
- The hosted Base44 runtime has no lock value, so these functions would refuse there. That is
  fail-closed on purpose.

## Tests

`node tests/v6PaperLock.test.mjs`: 32 tests. It boots the real server on port 8792 from a copy under
`data/tmp/b-lock/app` with a preloaded mock `fetch`, no `.env`, and fake keys stored through the real
`exchangeCredentials` route. The final phase releases the lock inside the copy and shows the same
attack reaches the mock `AddOrder`, so the zero-order results can actually fail.

Each layer was also removed in turn in a scratch copy, and the suite failed every time:

| Removed | Failed tests |
|---|---|
| Connection mask | Worker stop |
| Denylist | 3: runtime release, registry refusal, function-to-function. HTTP stayed at 403 through layer 3 |
| Store guard | 3: function writes, entity API (clean and armed data) |
| Case-insensitive entity names | 2: function writes, entity API |
| Fetch tripwire | Signed requests |
| Mask plus `executeApprovedTrade` guard | 2: worker stop, approval |
| Entry guard | Fail-closed check. The denylist still held |
| Boot assertion | Harness aborts at boot, exit 1, no named test |

The Trading page is checked at source level, and `Trading.jsx` compiles on its own with esbuild. It
was not rendered in a browser. A full `vite build` did not confirm it: the build currently fails on
`src/components/v6/mission/DecisionsFeed.jsx`, which imports `createPageUrl` from `src/utils.js`, and
that file does not export it. That file is outside this work.

## For the integrator

- `package.json`: add `node tests/v6PaperLock.test.mjs` to `test`.
- `.gitignore`: add `PAPER_LOCK_RELEASED`, so a release can never be committed.
- `server/index.js` header comment says the server "can arm live trading". That is now only true
  after a release.

README text, "Going live" section, to replace "Unchanged from the hosted app":

> Live trading is off by a code lock, `PAPER_ONLY`, which no setting in the app can change. Releasing
> it takes a deliberate edit on this machine: see `docs/rebuild/paper-lock.md`. After a release, the
> arming sequence and 24-hour cooldown apply as before. While locked, `dry_run` on
> `liveOrderExecution` is refused; test credentials from Exchange Settings instead.

The same section's "The app rejects any key that can withdraw" is false for OKX and Kraken (audit
section A) and should say the key's permissions cannot be checked, so the operator must create it
without withdrawal rights.
