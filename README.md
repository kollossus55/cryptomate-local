# CryptoMate — Local

The full app, running on your machine. Same pages, same UI, same backend functions — with Base44 replaced by a local server.

Nothing leaves your machine except the market data requests the bot already makes.

---

## Setup

Needs **Node 20 or newer** (`node --version`).

```bash
cd cryptomate-local
npm install
npm start
```

Then open **http://127.0.0.1:8788**.

First run takes about a minute while the UI builds. After that it starts in a couple of seconds.

---

## What changed from the hosted version

Nothing in the UI. All 14 pages and every component are the files from your repo, unmodified.

What was replaced is everything underneath:

| Base44 | Local |
|---|---|
| Hosted entity database | JSON files in `data/entities/`, atomic writes |
| OAuth login | Single local operator, no login |
| Serverless functions | Same code, run in-process by `server/` |
| Cron workflows | Interval timers in `server/scheduler.js` |
| Platform secret store | `.env` |

The 16 backend functions run **unmodified**. They were written for Deno, so the server provides the environment they expect — `Deno.serve`, `Deno.env`, and a loader hook that resolves their `npm:@base44/sdk` and `base44:runtime` imports to local shims. Fifteen are HTTP endpoints; `autoTradingEngineBackend` is a shared library the others import.

That matters for maintenance: when you change a function in Base44, you can copy the file across and it just works. No porting, no divergence. **One caveat since 2026-10-26:** files carried a small number of `// LOCAL FIX:` patches (bug fixes made locally that the hosted version has not received). Re-copying a file over one of these silently drops the fix — check for the marker, or diff against the D:\cryptomate-backup-20261026 snapshots, before overwriting. The trading-library copies under each function's `shared/` folder are **generated** — edit `/shared/trading/` and run `npm run sync:functions` instead of touching them.

---

## How it runs

One process, one port:

- **8788** — serves both the API and the built UI

The scheduler reproduces your Base44 workflows:

| Job | Interval | Was |
|---|---|---|
| `tradingScheduler` | 5 min | `*/5 * * * *` |
| `altcoinScannerWorker` | 15 min | `*/15 * * * *` |
| `notificationCleanup` | daily | daily |

Each job waits for its previous run to finish before starting again — the trading worker mutates the portfolio, and two overlapping runs would double-spend the same cash. First runs are staggered so three jobs don't all fire at boot.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build if needed, then run everything |
| `npm run server` | Server only (skips the build check) |
| `npm run dev` | Vite dev server on :5173 with hot reload, for editing the UI |
| `npm run build` | Rebuild the UI after changing `src/` |

`npm run dev` needs the server running too — start it with `npm run server` in a second terminal.

**After editing anything in `src/`, run `npm run build`** or you'll keep seeing the old UI.

### Optional: "is it alive?" phone alert (heartbeat)

Set `HEARTBEAT_URL` in `.env` to a [healthchecks.io](https://healthchecks.io)
ping URL (free tier: sign up → Add Check → period 15 min, grace 5 min → copy
the ping URL). The server then POSTs one outbound ping every 5 minutes. If the
pings ever stop — crash, hang, power cut — Healthchecks emails you, even though
your dying server could not have said a word. Leave it empty and the server
just logs `Heartbeat: disabled` at boot. The URL is included in `.env.example`
and kept out of git, since anyone holding it could spoof "alive" pings.

---

## Password lock

On first load the app asks you to create a password — there is nothing to sign
into yet, so setup opens straight away.

After that you get the landing page first, exactly as before. **Sign In / Sign
Up** opens the lock screen, and signing out returns you to the landing page. The
server refuses every API request without a valid session — so the data cannot be reached by reloading, calling the API
directly, or opening it in another browser.

**Trading continues while you are signed out.** The scheduler and backend
functions run in the server process and never consult a session. A bot that
stopped honouring stop-losses because you locked the screen would be far more
dangerous than the screen being visible.

What the lock does *not* protect against is anyone with access to the machine
itself — the data sits in plain JSON under `data/`. It gates the HTTP API, which
stops someone at your keyboard or on your network, not someone with your disk.

Details: scrypt-hashed (never stored in plain text), session in an HttpOnly
SameSite=Strict cookie, 10 failed attempts triggers a 15-minute lockout, and
sessions live in memory so restarting the server signs you out.

### Two-factor authentication

Optional, and off until you turn it on under **Security** in the sidebar. It is
standard TOTP (RFC 6238), so any authenticator works — Google Authenticator,
Authy, 1Password, Bitwarden. Scan the QR or type the key by hand.

With it on, a correct password alone no longer signs you in: it earns a
five-minute challenge that must be answered with a code.

**Requires `EXCHANGE_ENCRYPTION_KEY`** (LOCAL, 2026-10-26) — the TOTP secret
is itself encrypted with that key before it touches disk; a plaintext second
factor sitting next to encrypted exchange keys would defeat the point, and
enrolment now refuses without a valid one. If the key is later rotated or
lost, the stored secret becomes undecryptable **by design**: sign in with a
backup code, or delete `data/auth.json` and re-enrol. Backup codes are also
stored salted and scrypt-hashed now, so a stolen `auth.json` is no longer
brute-forceable offline for them.

- **Backup codes.** Ten are generated at enrolment and shown once, because they
  are stored hashed. Each works once. Without them, losing your phone means
  resetting the lock entirely.
- **Replay protection.** A TOTP code is valid for thirty seconds, so the step it
  came from is recorded and the same code cannot be used twice.
- **Turning it off requires your password**, so someone at an unlocked screen
  cannot quietly remove it.

Use a phone rather than an authenticator on this same machine. A second factor
sitting next to the first is not really a second factor.

**Forgotten password or lost your phone with no backup codes?** Delete
`data/auth.json` and you will be asked to set a new password, with two-factor
off again. Your trading data is untouched. There is no other recovery — that is
the cost of there being no account to recover through.

---

## Starting a clean measurement period

**Admin → Database → Reset trading data.**

Clears the trade history and returns the paper account to a starting balance,
so a new sample is not mixed with old results. It states exactly what will be
deleted and what will be kept, with record counts, and requires you to type
`RESET`.

What it keeps: your trading settings, signal configuration, exchange
connection, backtest results, password and two-factor. Only the trading
history and the portfolio go.

Two safeguards worth knowing:

- **A snapshot is taken automatically first**, into `data/snapshots/<timestamp>/`,
  and the UI tells you where. If the snapshot fails, the reset is refused
  rather than proceeding with no way back. The last 20 are kept.
- **It refuses while a trading cycle is running.** The worker writes its
  portfolio once at the end of a cycle from its own in-memory state, so a reset
  landing mid-cycle would be silently undone seconds later. Wait a few seconds
  and try again.

Note the date you reset, so that when you compare against buy-and-hold you are
measuring the same window.

---

## Data

Everything lives in `data/`:

```
data/
  entities/        one JSON file per entity
  auth.json        password hash, 2FA secret and hashed backup codes
                   (delete to reset the lock entirely)
  logs/            daily server logs
```

Plain JSON, written atomically — a process killed mid-write can't leave a truncated file. Anything that becomes unreadable is preserved as `.corrupt-<timestamp>` rather than silently overwritten, because it may be the only copy of your trade history.

Back up by copying the `data` folder. That's the whole state.

---

## Going live

Unchanged from the hosted app — same arming sequence, same 24-hour cooldown, same server-side checks.

The key is already set up (`EXCHANGE_ENCRYPTION_KEY` in `.env`, exactly 64
hex chars — all consumers validate that format strictly and refuse anything
else, since a mistyped key used to decode into a 2-byte cipher instead of
failing loudly). Every outward exchange/LLM call now sits under a 20-second
timeout, and live orders are **rounded to each instrument's own lot/minimum
size, with `dry_run` honored on both the OKX and Kraken paths** — a dry-run
preview shows exactly what would be sent and places nothing.

What CODE review cannot do: rehearse the exchange. Before arming for real,
run the arming sequence with **testnet API keys** once, watching the server
log end to end. Live orders that code never sent are the only feedback that
counts.

Create API keys with **read and spot-trade permissions only**. The app rejects any key that can withdraw.

---

## Running continuously

The app stops when you close the terminal, and a Windows update reboot will
take it down. To have it start automatically at boot, run this **once** from an
**Administrator** PowerShell in the app folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

That registers a scheduled task which:

- starts at boot, before anyone logs in
- runs as SYSTEM, so no password is stored anywhere
- restarts automatically if it crashes
- has no execution time limit

It starts the task immediately and then checks the server actually answers on
port 8788, rather than just reporting that the task launched.

To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
```

Day-to-day:

```powershell
Get-ScheduledTask CryptoMate      # state
Stop-ScheduledTask CryptoMate     # stop now
Start-ScheduledTask CryptoMate    # start now
```

### Things to know once it runs as a task

**There is no console window.** A task that starts before login has no desktop,
so watch `data\logs\bot-YYYY-MM-DD.log` instead of expecting a terminal.

**Build the UI first.** The task runs `server/index.js`, which does not build
the UI — only `npm start` does. Run `npm start` once before installing the task,
or the web page will show "not built yet" while trading works fine.

**Stop the task before running `npm start` manually.** Two copies cannot both
trade — the second exits on the port conflict, which is deliberate — but it is
confusing to debug. `Stop-ScheduledTask CryptoMate` first.

**Windows sleep is a separate problem.** The task handles reboots; it does not
stop the machine suspending. A sleeping machine is a bot that cannot honour its
stop-losses, so set power options to never sleep.

**If a manual run later reports a permissions error** writing to `data\`, it is
because the task created those files as SYSTEM. Grant yourself access with:

```powershell
icacls D:\cryptomate-local\data /grant "$env:USERNAME:(OI)(CI)F" /T
```

---

## Security

- Bound to **127.0.0.1**. The UI shows your positions and can arm live trading, so it is not reachable from your network. Don't change `HOST` without putting authentication in front of it.
- **No login**, by design — anyone with access to your machine has access to the app. That's the same trust boundary as your files.
- Secrets live in `.env` only. Logs are redacted before writing.
- `.gitignore` already excludes `.env`, `data/`, `dist/` and `node_modules/`.

---

## Troubleshooting

**First command to run when something is wrong:**

```bash
npm run doctor
```

It prints the installed build, checks every SDK namespace the backend functions
call, confirms all 15 functions load, and flags the settings that silently
produce zero trades. It is read-only and safe to run while the server is up.

That check exists because two bugs reached you the same way: a namespace the
functions call that the local shim did not provide. Those only show up at run
time as `Cannot read properties of undefined`, and the message is identical
whichever namespace is missing. The doctor names it directly.


**"Cannot reach the local server"** in the UI — the server isn't running. `npm start`.

**"Port 8788 is already in use"** — another copy is running, or something else has the port. Set `PORT` in `.env`.

**"The UI has not been built yet"** — run `npm run build`.

**A function fails to load** — the startup log names it and says why. The other functions keep working; only that endpoint is affected.

**No trades appearing** — check the server log. The worker logs which gate
rejected what (`below_strength=18, correlated=2`), so "nothing happened" always
has a reason. Two configurations fail closed and will reject everything, so the
server warns about both at startup:

- **AI confirmation set to "auto" with no LLM configured.** That gate rejects a
  trade it cannot get an opinion on. Either set `LLM_PROVIDER` and `LLM_API_KEY`
  in `.env`, or set AI confirmation back to "off".
- **Kill switch on.**

---

## The honest part

This is the same strategy as before, now running where you can see it. Porting it to your machine didn't make it more likely to be profitable — it made it yours to inspect, change and test.

Keep it on paper until you have a few hundred trades and can compare against buy-and-hold over the same window. The backtester reports that benchmark. If the strategy doesn't beat it, no amount of infrastructure will fix that — but at least now the numbers will tell you honestly.
