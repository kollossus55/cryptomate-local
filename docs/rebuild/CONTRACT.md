# CryptoMate V6 rebuild — shared contract

Every agent reads this first. It wins over anything else except the coordinator.

## 0. Why this rebuild exists

Measured on this repo's own backtester, net of costs: the live engine lost money in
9/9 ninety-day windows on 4h (-76% compounded) and 8/9 on 1h (-83%). Its one-signal
"HA only" configuration is -98%/-100%. Only DAILY-bar rules showed life. Costs and
churn are what kills short timeframes. The prior sample was 20-40 of TODAY's top
coins, so it also carries survivorship bias.

So the order of priority is: (1) find entries with a real, tested edge, or admit there
are none; (2) cap loss; (3) always have an exit. Risk management around an entry with
no edge just loses more slowly.

**Nothing can guarantee winning trades.** Never write code, UI text or reports that
imply it. A correct outcome of this project is "no strategy qualified, so the bot sits
in cash and says why". Report negative results plainly; they are valuable.

## 1. Hard rules (no exceptions)

1. **PAPER ONLY.** V6 code never imports `liveOrderExecution`, `executeApprovedTrade`,
   `liveTradingControl`, `okxExchange`, never uses API keys, never calls a private or
   signed exchange endpoint. Public market data only.
2. **Work only in `D:\cryptomate-local\.rebuild`** (worktree, branch `rebuild/v6`). Never
   touch `D:\cryptomate-local` outside `.rebuild`, its `data/`, or the running server
   on port 8788. Reading `D:\cryptomate-local\data\research` is allowed; writing is not.
3. **Never run `git commit`, `git push`, `git stash`, `git checkout`, `git reset`,
   `git clean`.** The coordinator handles version control. `git diff`/`log`/`show` are fine.
4. **Stay inside your owned files** (given in your brief). Need a change elsewhere? Say
   so in your final report; don't make it. Other agents are editing in parallel.
5. **Do not edit generated copies** in `base44/functions/*/shared/`. Edit `shared/trading/`.
6. **No secrets.** The worktree has no `.env`, deliberately: test servers must not ping
   the heartbeat, call the LLM, or read real keys. Do not copy `.env` here.
7. **Test servers** use a port from your brief (never 8788) and run from this worktree.
8. Be polite to public APIs: stay well under published rate limits, back off on 429/418,
   cap concurrency at 4 per host. A Binance IP ban would hurt everyone.
9. Scratch files go in `data/tmp/<your-agent-name>/` (git-ignored). Long jobs must print
   progress and be resumable. The box has 24 cores shared by all agents: use at most 4
   worker processes at once.
10. Report honestly. If a test failed or you skipped something, say that. Never soften a
    negative result, and never tune a test until it passes.

## 2. Research integrity (anti-overfitting)

The biggest risk here is many agents trying many ideas until one looks good by luck.

- **DEV period**: all data up to and including `2024-12-31`.
- **HOLDOUT period**: `2025-01-01` onward. **LOCKED.** `loadBars()` refuses any range past
  DEV unless `V6_HOLDOUT_UNLOCK=<token>` is set, and only the final validator gets the
  token. Research agents must never read holdout data by any route, including
  `D:\cryptomate-local\data\research` or a fresh API fetch. Each frozen candidate gets ONE
  holdout evaluation, and is never retuned after.
  Caveat to carry into all reports: earlier research already looked at this period, so
  the two legacy Strategy Lab rules are NOT clean on it. New rules are.
- **Log every trial.** Each parameter set you evaluate gets a line in
  `data/research/v6/trials-<agent>.jsonl` — including the failures. Deflated Sharpe uses
  the total trial count across all agents, so hiding trials corrupts the result.
- **Coarse grids only.** Round parameters (20/50/100/200, not 87). At most ~50 trials
  per family. Prefer a plateau of good neighbours over one sharp peak.
- **Same code path**: a strategy runs through the same functions in backtest and live.
- **No lookahead**: decide on CLOSED bars only and fill at the NEXT bar's open.

### Cost model (defaults; every result must be net of these)

| | fee/side | slippage/side |
|---|---|---|
| Tier 1 (BTC, ETH) | 0.10% | 0.03% |
| Tier 2 (30d median quote vol >= $50M/day) | 0.10% | 0.08% |
| Tier 3 (everything else) | 0.10% | 0.25% |

Also: stop fills take a further 0.10% slip and fill at the WORSE of stop price and bar open
(gaps are not forgiven). If a bar touches both stop and target, assume the stop came first.
Perps: 0.05% taker fee plus actual historical funding, every 8h, paid or received.
A coin that delists exits at its last close minus 10%.

### Universe (point in time)

On each date, eligible coins are those that on THAT date had >= 200 days of history and
ranked top-N by trailing 30-day median quote volume, excluding stablecoins, wrapped/pegged
tokens and leveraged tokens. Delisted coins stay in the data until they die. Never pick
the universe with today's rankings.

### Timeframes

`1d` and `4h` only for decisions. `1h` is allowed for stop-path fidelity, not for entries:
the evidence says costs kill it.

### Pre-registered promotion criteria (FROZEN — do not change, do not argue around)

A strategy is CERTIFIED for paper trading only if ALL hold, net of costs:

On DEV (walk-forward, parameters chosen only on earlier data):
- D1 Sharpe >= 0.8, and the 90% bootstrap CI lower bound > 0
- D2 Deflated Sharpe probability >= 0.90, using the global trial count
- D3 Max drawdown <= 30%
- D4 >= 100 closed trades (or >= 30 position-changes for slow allocators)
- D5 Still profitable at 2x costs
- D6 Parameter plateau: every neighbour within one grid step keeps Sharpe >= 50% of the chosen value
- D7 No single coin > 35% of total profit; no single calendar year > 60% of total profit
- D8 Calmar or Sharpe better than the same-universe buy-and-hold

On HOLDOUT (one shot, frozen parameters):
- H1 Sharpe >= 0.5
- H2 Max drawdown <= 25%
- H3 Total return > 0
- H4 Drawdown smaller than BTC buy-and-hold over the same span

If nothing passes, nothing is certified, and the engine holds cash. That is fine.
Failing candidates may run in SHADOW (signals logged, no paper position).

## 3. Architecture

```
scripts/v6/*.mjs                    research + data tooling
shared/trading/v6Bars.js            bar store loader, holdout lock, point-in-time universe
shared/trading/v6Stats.js           Sharpe, PSR/DSR, bootstrap CI, drawdown, Calmar
shared/trading/v6Sim.js             portfolio simulator (runs v6Core.step, see below)
shared/trading/v6Strategies.js      strategy registry: pure signal functions
shared/trading/v6Risk.js            portfolio risk engine (sizing, limits, drawdown ladder)
shared/trading/v6Exits.js           per-position exit plans
shared/trading/v6Paper.js           paper fills + ledger (order-book aware)
shared/trading/v6Exchanges.js       multi-exchange public data, health, failover, consensus
shared/trading/v6SignalGate.js      pre-trade signal tests + certificates + drift monitor
shared/trading/v6Core.js            pure engine step: state + market in, actions out
base44/functions/v6Engine/entry.ts  worker: the only stateful part, scheduled every 5 min
base44/functions/v6Control/entry.ts API for the GUI
```

Files stay flat in `shared/trading/` with a `v6` prefix: `scripts/sync-shared.mjs` copies
flat files into function folders. All `shared/trading/v6*.js` are pure ES modules with no
Deno APIs. Only `v6Exchanges.js` and `v6Bars.js` may do I/O. Everything else takes the
clock, prices and bars as arguments. Keep plain JS with JSDoc.

### Data shapes

```js
// Bar. `closed` is implicit: consumers only ever receive closed bars.
{ t, o, h, l, c, v, qv }          // t = open time ms UTC, qv = quote volume

// Strategy (v6Strategies.js). Pure, deterministic, no I/O.
{
  id: 'tsmom_majors', name, version: 1, timeframe: '1d',
  params: { ... }, grid: { param: [values] },
  universe: { kind: 'fixed', symbols: [...] } | { kind: 'top', n: 20 },
  warmupBars: 200,
  // ctx = { t, bars: Map<symbol, Bar[]>, universe: string[], params,
  //         positions: Map<symbol, Position>, regime }
  // bars[i] are closed and end at t. Never reaches past them.
  signals(ctx) -> Signal[]
}

// Signal: what a strategy wants. Strength and sizing hints only; v6Risk decides size.
{
  strategyId, symbol, side: 'long' | 'flat' | 'short',
  score,                     // 0..1, for ranking only
  stopDistancePct,           // required for 'long'/'short'; no stop = no trade
  exitProfile: 'trend' | 'swing' | 'revert',
  reason,                    // plain English, shown in the GUI
  meta: {}
}

// Position
{ symbol, strategyId, side, qty, entryPrice, entryTime, entryFees,
  stopPrice, initialStopPrice, highWater, lowWater, partialsTaken: [],
  exitProfile, exitPlan, barsHeld, riskAtEntry }

// Order intent returned by v6Core.step
{ type: 'enter'|'exit'|'reduce', symbol, strategyId, side, qty, reason, reasonCode, refPrice }
```

### v6Core.step (the single decision path, used by both sim and live)

```js
step({ t, account, positions, market, strategies, config, gate, riskState })
  -> { intents, riskState, events }
// Order inside step, always:
//  1. mark to market
//  2. EXITS first: stops, trails, time, regime, signal. Never blocked by anything.
//  3. risk state update: drawdown ladder, breakers
//  4. new entries only if the risk state allows: signals -> gate -> size -> intents
```

Exits are never blocked: no breaker, stale-data flag, gate or limit can stop a position
from leaving. If data is stale, exits use the last good price and raise an alarm.

### Risk defaults (v6Risk, tunable in GUI, within hard ceilings)

- Risk per trade 0.5% of equity at the stop; ceiling 1%
- Open risk (sum of risk to stops) <= 3%; ceiling 5%
- Max position 20% of equity; gross exposure <= 100%; no leverage on spot
- Volatility targeting: scale positions toward a 15-20% annual portfolio vol target
- Correlated cluster cap: at most 40% of equity in a correlated group
- Drawdown ladder from equity high: -5% half size, -10% quarter size,
  -15% no new entries, -20% flatten and halt until a human re-enables it in the GUI
- Daily loss -2%, weekly loss -4%: no new entries until the period rolls
- Market breaker: BTC -8% in 24h or -15% in 7d: no new entries, tighten trails
- Stale or disagreeing data: no new entries, exits continue

### Exit plans (v6Exits): every position has all of these from the moment it opens

Hard stop set at entry (never moved down) · break-even after +1R · chandelier ATR trail ·
time stop if it hasn't worked · signal exit · regime exit · optional partial profit.
Profiles `trend`, `swing`, `revert` combine these differently.

### Signal gate (v6SignalGate): "test before trading"

Every entry must clear ALL of these, and every verdict is stored for the GUI:

1. Certificate: strategy has a valid certificate whose hash matches code + params.
2. Forward drift: live paper results are not outside the backtest's expected range.
   Breach demotes the strategy to shadow automatically.
3. Data test: bars fresh, no gaps, price agrees across >= 2 exchanges within tolerance.
4. Cross-venue replay: recompute the signal on a second exchange's bars; it must agree.
5. Liquidity test: spread and depth support the size within the cost budget.
6. Historical test: replay this signal on this symbol's DEV-period history; expectancy
   net of costs must not be negative.
7. Risk test: has a stop, size fits limits, reward:risk meets the profile minimum.

New certified strategies start at half risk until 20 forward trades are complete.

### Lifecycle

`research -> certified -> paper(half) -> paper(full)`, with automatic demotion to `shadow`
on drift. No path leads to live trading: that stays a human decision in the existing
arming flow, and V6 never touches it.

### Entities (new, in `server/entityStore.js` allow-list, added by the integrator)

`V6Config`, `V6StrategyState`, `V6SignalTest`, `V6RiskEvent`, `V6ExchangeHealth`,
`V6Certificate`, `V6EquityPoint`. Existing `Portfolio` and `Trade` are reused so the
current dashboards keep working. Trades use `exchange: 'Paper Trading (V6)'` and carry
`strategy_id`, `reason_code`, `exit_reason`.

## 4. Conventions

Match the repo: ES modules, 2-space indent, explanatory comment only where the *why* is not
obvious. Tests are plain `node tests/x.test.mjs` scripts that print PASS/FAIL and exit
non-zero on failure (see `tests/strategyLab.test.mjs`). Name yours `tests/v6*.test.mjs`.
Do not edit `package.json`; report the test filename and the integrator wires it in.

End your work with a report: what you built, exact test output, what doesn't work, what
you did not do, any changes needed in files you do not own. Lead with the outcome. Keep it
under 400 words, and put long detail in `docs/rebuild/<your-agent-name>.md`.

## 5. Module signatures (build against these; do not wait for each other)

```js
// v6Bars.js
HOLDOUT_START = Date.UTC(2025,0,1)
HOLDOUT_TOKEN_SHA256 = '132e23ac759b080970d2f5035f03ec0eda73ec6cc6ae312b3b1fe9066e60d817'
loadBars({ symbols, timeframe, from, to })     -> Map<symbol, Bar[]>  // throws past DEV unless unlocked
pointInTimeUniverse(t, { topN, timeframe })     -> string[]
tierFor(symbol, t)                              -> 1 | 2 | 3
// Holdout bars live in a separate folder, data/research/v6/holdout/, so DEV work never opens them.

// v6Stats.js
sharpe(returns, periodsPerYear), sortino, maxDrawdown(equity), calmar(equity, periodsPerYear),
bootstrapCI(returns, statFn, { n, blockLen, alpha, seed }), psr(returns, benchmarkSR),
deflatedSharpe(returns, trialCount, trialSRVariance), summarize(equityCurve, trades)

// v6Exits.js
EXIT_PROFILES
createExitPlan({ position, profile, atr, config })                  -> exitPlan
evaluateExit({ position, bar, atr, signal, regime, t, config })     -> { action: 'hold'|'exit'|'reduce',
                                       fraction, reasonCode, reason, newStop, fillHint }
// Stops may only ratchet in the protective direction.

// v6Risk.js
DEFAULT_RISK_CONFIG, HARD_CEILINGS, clampRiskConfig(cfg)
initialRiskState(equity, t)
updateRiskState(riskState, { t, equity, btcBars, dataHealth, config }) -> { riskState, events }
canEnter(riskState) -> { ok, reason }
sizeEntry({ signal, price, equity, positions, riskState, config, volatility, correlations, sizeMultiplier })
  -> { qty, notional, riskAmount, rejected, reason }

// v6Paper.js
costFor(symbol, tier, { stress })                                    -> { feePct, slipPct }
simulateFill({ intent, bar | book, cost, isStop, stopPrice })       -> Fill
applyFill(ledger, fill) -> ledger    // { cash, positions, realized, fees }, invariant-checked

// v6Exchanges.js
EXCHANGES, createMarketHub({ priorities, enabled, fetchImpl, now })
hub.bars(symbol, timeframe, limit, { venue }), hub.ticker(symbol), hub.book(symbol, depth),
hub.consensusPrice(symbol) -> { price, venues, spreadPct, ok, reason }
hub.health() -> [{ venue, ok, latencyMs, lastError, lastOk, ... }]
hub.universe({ topN, minQuoteVolume }) -> [{ symbol, quoteVolume, venues }]

// v6Core.js
step({ t, account, positions, market, strategies, config, gate, riskState }) -> { intents, riskState, events }
// market: { bars: Map, prices: Map, health }. gate: async-free object with check(signal, ctx) -> verdict.
// In the simulator, gate is a pass-through.

// v6Sim.js
runSim({ strategies, bars, from, to, config, costs, universeFn }) -> { equity, trades, events, summary }
walkForward({ strategyFactory, grid, bars, trainDays, testDays, ... }) -> { oos, picks, summary }
```

## 6. Coordinator decisions (2026-11-05, binding for wave 3)

Numbering refers to docs/rebuild/gui-design.md section 12 and docs/rebuild/audit-engine.md.

- **Legacy off (I1).** Legacy auto-trading stays off at launch. It was paused while flat on
  2026-11-05 (`is_enabled=false`). Never run legacy and V6 against `Portfolio` together.
  The `tradingScheduler` job is removed at cutover. V6 does NOT adopt legacy positions; cutover
  requires a flat account and aborts otherwise.
- **Paper lock.** Land the audit's hard lock: function denylist in `functionRuntime.js`,
  entity-write refusal for the arming fields, startup assertion. Also close the Trading-page
  manual-order path. Unlocking is a deliberate human code/config change, not a GUI toggle.
- `v6Control` may READ the three `AutoTradingSettings` fields for the banner. Read only.
- **Limit loosening (5.4).** Accepted: refuse any loosening on the quarter-size rung or worse.
- **Path back from shadow (I8).** Automatic demotion, never automatic promotion. A demoted
  strategy returns only by a human action in the GUI, after >= 20 forward shadow signals back
  inside the expected range, and restarts at half risk.
- **Sleeves (I4).** Read-only for now: equal risk across active strategies, displayed not edited.
- **Fabricated alerts (I10).** Remove the random "anomaly" alerts from `Alerts.jsx` and
  `useNotificationMonitor.jsx`. Every alert must trace to a real event.
- **Gate timing (I6, I7).** Split the gate: `preSize` (checks 1-4, 6) before sizing, `postSize`
  (checks 5, 7) after. `v6Core` keeps all seven results per signal, not just ok/reason.
- **Rung 3 (F12).** `NEEDS_REVIEW` state accepted; the GUI says a human must re-enable.
- **Re-enable allowance.** Each re-enable resets the equity high, so Mission Control must always
  show cumulative drawdown from the all-time high across re-enables.
- **Permanent drawdown floor (user-approved addition, 2026-11-07).** A hard ceiling, not a
  setting: no config field reads or loosens it. It sits at -30% from `v6_state.allTimeHigh`
  (matching criterion D3), a high that a re-enable never rebases. When equity reaches it,
  exactly -30% included, the engine flattens every position through the same halt as the
  ladder's -20% flatten (exits are never blocked, stale prices included), halts, and raises a
  critical `floor_breached`. A normal re-enable does not clear it. Only the v6Control action
  `resetFloor` does: confirm word `FLOOR`, a note, a named human, a halted and flat account.
  The engine re-checks those, moves the floor's reference (`v6_state.floorHigh`) to current
  equity, and records a permanent `floor_reset` event with the old high, the equity and the
  user. V6 stays halted until a separate re-enable. The floor is shown wherever drawdown is:
  Mission Control, Risk Controls, and the re-enable dialog with its distance from equity.
- **Venue health (I13).** An untried venue is `unknown`, not healthy, and never counts toward
  consensus. Share one hub instance per process so backoff is global.
- **Trade safety (I3, F11).** Legacy delete/reset paths must not silently remove V6 trades or
  leave `v6_ledger` stale. V6 trades render correctly in Trade History.
- **Broken pages (I11).** Fix `ENTITY_NAMES`. The contract's "allow-list" means that list.
- **Log noise.** Fix the `NewsWidget` polling and the `{data}` vs `.success` mismatch.

### Added after the exchange hub report

- **Consensus is required for entries.** `price` is still set when `consensus.ok` is false, so
  entries must check `consensus.ok` explicitly. Exits use the last good price and raise an alarm.
- **Ticker collisions.** `hub.bars` can return a different project under a colliding ticker
  (LIT, BEAM). The cross-venue replay must treat a large price mismatch as a failed check,
  never as an agreement, and the live universe must exclude known collisions.
- **Replay venue.** `roles.replay` is OKX or Bybit, the only stored replay history, not Coinbase.
- **Holdout and the hub.** Research code must never call `hub.bars`; it reads `loadBars` only.
- **Disclosure for the final report.** While building the hub, the exchanges agent printed a few
  recent BTC candles and part of a Kraken 4h series to its own console. Nothing was saved or
  analysed, and that agent does no strategy research.
