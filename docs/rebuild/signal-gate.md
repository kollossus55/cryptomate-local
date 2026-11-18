# V6 signal gate

Agent `b-gate`. Module `shared/trading/v6SignalGate.js`, tests `tests/v6SignalGate.test.mjs`, table
builder `scripts/v6/build-signal-history.mjs`. Also owns `shared/trading/v6Core.js`.

A pass means a signal is allowed to trade. It does not mean the trade will win.

## Engine interface

The module is pure and synchronous. `step` is sync, so everything the gate reads is fetched first.

### Per tick, on a new bar

```js
import { createSignalGate } from './v6SignalGate.js';

const gate = createSignalGate({
  states,        // Map or object: strategyId -> V6StrategyState row (plain JSON)
  certificates,  // Map or object: strategyId -> V6Certificate row
  data: {
    consensus,   // Map: symbol -> hub.consensusPrice(symbol)
    replay,      // Map: symbol -> { venue, bars } or, better, [{ venue: 'okx', bars }, { venue: 'bybit', bars }]; bars: await hub.bars(symbol, tf, n, { venue })
    books,       // Map: symbol -> await hub.book(symbol, 50)
    history,     // the parsed table from data/v6/signal-history.json
  },
  config,        // optional overrides of DEFAULT_GATE_CONFIG
});

const out = step({ t, account, positions, market, strategies, config, gate, riskState, modules });
```

Prefetch for every symbol in the universes of `paper_half`, `paper_full` and `shadow` strategies. A
symbol missing from `consensus`, `replay`, `books` or `history` fails its check, so a short prefetch
blocks entries and never lets one through. `n` must cover `strategy.warmupBars`, and OKX serves at most
300 bars. Keep `.meta` on the bars array: `bars.meta.venue`, `stale`, `lastGood` and `quoteMismatch` are read.

Prefetch is needed on new-bar ticks only. With `market.isNewBar === false`, step runs exits and returns
before the entry block, so the gate is not called and `data` may be `{}`. Still pass a gate.

`market` needs `bars`, `prices`, `barMs`, `barT` and `costFor`. `modules.exits`, `isNewBar`,
`exitRemainderPatch`, `entryPositionFields` and `exitConfigFor` are unchanged.

**Never pass `PASS_THROUGH_GATE` from the worker.** It is for the simulator and tests.

### Gate object

```js
gate.modeFor(strategy)                 -> 'trade' | 'shadow'
gate.preSize(signal, ctx)              -> Verdict   // checks 1, 2, 3, 4, 6
gate.postSize(signal, ctx)             -> Verdict   // checks 5, 7
gate.advanceShadow(args)               -> { [strategyId]: { book, closed } }

// ctx, built by step:
// preSize:  { t, strategy, market, positions, heldAtSignal, riskState, regime, ind, universe, price }
// postSize: the same, plus { sized, exitPlan, cost }

Verdict = { ok, stage, reason, blockedBy, checks: Check[], sizeMultiplier }
Check   = { id, status: 'pass'|'fail'|'not_run', text, values: [{ label, value, limit }] }
```

Check ids, in contract order: `certificate`, `drift`, `data`, `replay`, `liquidity`, `history`, `risk`.
Also exported from `v6Core` as `GATE_CHECKS`. Every check of a stage always runs, so a failed check does
not hide the others. `postSize` is not called when `preSize` refused a tradable strategy, so checks 5 and
7 report `not_run` in that row.

### What step returns

`{ intents, riskState, events, updates, equity, shadow }`. `shadow` is new. `events` gains one
`signal_test` per entry signal, ready to store as `V6SignalTest`. Filter on `type === 'signal_test'`:

```js
{ t, type: 'signal_test', bar_time, symbol, strategy_id, side, reason, rank_in_batch, batch_size,
  outcome: 'entered'|'blocked'|'rejected'|'shadow'|'not_tested',
  reject_code,        // not_in_universe, no_stop, short_on_spot, no_price, sizing, or null
  blocked_by,         // check id, no_gate, gate_error, or null
  blocked_text, not_tested_reason,
  checks,             // always all seven, in contract order
  exit_profile, stop_distance_pct, trade_id: null }   // the worker fills trade_id
```

`entry_rejected` still fires, with code `gate` for a refusal. `entries_blocked` now also carries
`symbols`. An alarm with code `no_gate` means step ran without a gate and refused every entry.

A shadow strategy never produces an `enter` intent. It gets `outcome: 'shadow'` rows, and any open
position it still holds keeps running under its exit plan.

### After the step

```js
// Shadow results, on every tick where out.shadow is not null
state = recordShadowResult(state, out.shadow[strategyId], { certificate, t }).state;

// Each closed real trade. tradeId makes a replay after a restart harmless.
const { state: next, events } = recordForwardTrade(state, { returnPct, t, tradeId }, { certificate });

// Each tick, so a valid certificate moves research -> certified -> paper_half
const { state: moved, events } = advanceLifecycle(state, { strategy, certificate, t });
```

`returnPct` is net percent on the position's notional, 1.5 meaning +1.5%, so half-risk trades compare
fairly with the backtest. `tradeOutcomes(rows)` builds it from sim-shaped trade rows. A partly closed
position counts once, when it is flat.

`recordForwardTrade` runs the drift monitor. A breach sets `lifecycle: 'shadow'` and returns a
`strategy_demoted` event. Reaching 20 trades returns `strategy_full_risk`. Store the returned state.

### Certificates and hashing

```js
strategyHash(strategy)                          -> hex sha256 of code + params
verifyCertificate(cert, strategy, t)            -> { ok, code, reason }
```

`code` is `ok`, `missing`, `bad_format`, `bad_seal`, `not_valid_status`, `criteria_not_passed`,
`wrong_strategy`, `wrong_version`, `hash_mismatch`, `not_yet_valid` or `expired`.

`issueCertificate` is for the final validator's script only. Neither `v6Engine` nor `v6Control` may
import it, and a test scans for that.

### Human return from shadow

```js
returnFromShadow(state, { t, by, confirm: true, strategy, certificate })
  -> { ok, reason, state, events }
```

`reason` is `ok`, `not_confirmed`, `no_human_named`, `invalid_clock`, `not_in_shadow`,
`invalid_certificate` or `not_enough_shadow_signals`. For the GUI, `state.shadow_in_range` is the count
so far and `SHADOW_SIGNALS_TO_RETURN` is the 20 needed. On refusal the state is unchanged. On success
the strategy restarts at `paper_half` with its forward count at 0. Nothing calls this automatically.

## V6StrategyState

Plain JSON. Create it once with `initialStrategyState({ strategy })`.

```js
{ strategy_id, version, lifecycle: 'research'|'certified'|'paper_half'|'paper_full'|'shadow',
  size_multiplier, forward_trades, forward_series: [{ x, return_pct, trade_return_pct, t, trade_id }],
  drift_status: 'warming'|'inside'|'breach'|'unknown', drift_note, demoted_at, demotion_reason,
  shadow_series: [number], shadow_in_range, shadow_book: [], transitions: [{ t, from, to, by, reason }] }
```

`return_pct` is cumulative, `trade_return_pct` per trade. A missing or corrupt state fails check 1.

## Drift monitor: measured results

Synthetic trades, true mean 1% and sd 5%. Bands built from 150-trade backtests, 8 backtest
samples, forward runs of 100 trades. The band uses a two-stage bootstrap: each path resamples
the backtest, then draws from that resample. One stage treated the backtest mean as exact.

| Measure | One stage | Two stage, two-sided | Two stage, low side only (current) | Limit in test |
|---|---|---|---|---|
| Healthy strategy demoted | 18.9% | 11.5% | 4.4% | at most 6% |
| Lost edge (true mean -1) caught | not measured across samples | 73.4%, median after 33 trades | 78.4%, median after 27 trades | at least 78% |

**Low side only (2026-11-18).** The two-sided band also demoted a strategy whose results ran
*above* the range, which spent half of alpha on a case that is never a reason to stop trading.
`buildExpectedBand` now returns `sides: 'low'` with `hi: null` on every point, and spends all of
alpha on the lower limit. On the same seeds that improved both measures (table). The lost-edge
limit was 80% and the band still cannot reach it, so the limit was lowered to 78% by the
operator's decision, with this change, not on its own. A band without `sides` (built before
the change) is still evaluated two-sided. The two-sided figures below are kept for the record.

The nominal rate is 5%. The measured 11.5% is more than twice that, because 150 trades cannot
pin down a mean. One backtest sample alone gives 40% upper-side false breaches.

Detection by backtest sample mean: -0.10: 26%; 0.34: 35%; 0.47: 81%; 0.71: 81%; 0.79: 86%;
1.10: 86%; 1.31: 95%; 1.55: 97%. The misses sit where the backtest itself looks poor, so the band
already allows a poor result. Excluding those samples would make the test pass, and that has
not been done. `a strategy that lost its edge is caught` is left failing at its original limit.

Real backtests are optimistic, so real decay should appear as low-side breaches sooner than this
symmetric synthetic case suggests. That has not been measured.

## Decisions and limits

- `CERT_TTL_DAYS` of 180 and reward:risk taken from `avgWinR` are b-gate's choices, not contract
  figures. Demotion on an upper-side breach was too, and was removed on 2026-11-18 (see above).
- The certificate seal shows tampering. It is not forge-proof, because the module holds no secret.
  The integrator must refuse browser writes to V6Certificate and V6StrategyState, keep
  `issueCertificate` and `PASS_THROUGH_GATE` out of app code, and not make gate config GUI-editable.
- Helper code outside `signals()` is hashed only when listed in `codeDeps`.
- Coins with no DEV history always fail check 6, so new listings cannot trade.
- OKX's 300-bar cap limits warmup for the check 4 replay.
- Slow allocators are measured for drift in trades only.
- With no gate, `step` refuses all entries, except on the simulator's prepared history. That
  fallback exists because `v6Sim.js` is not b-gate's file. Passing `gate: PASS_THROUGH_GATE` there
  would allow it to be deleted.

## Risk and regime in step

`updateRiskState` receives `openPositions`, net of this step's exits. A rejected size calls
`noteEntryRejection` with `planned.size`, which drops this step's exits and counts its earlier
entries. Shadow rejections are not noted, because nothing real was refused.

The fallback regime average spans 200 days on any timeframe, 1200 bars on 4h. With too little
history the regime is `unknown`, not a shorter average. Without `market.barMs`, bars are taken as
daily and the existing alarm fires.

## Signal history table

```
node scripts/v6/build-signal-history.mjs [--out=path] [--module=path] [--reference=name] [--force]
```

Default output is `data/v6/signal-history.json`. It uses DEV data only, refuses to run with
`V6_HOLDOUT_UNLOCK` set, skips strategies already built with the same hash, and refuses perp
strategies. Trades still open at the end of DEV are left out, not force-closed. While `STRATEGIES`
is empty the table is empty, check 6 blocks every entry, and the engine holds cash.

## Replay venue usability

Before a venue's bars count as evidence, check 4 asks whether the venue is usable for that coin. It
is unusable when any of these hold over the bars shared with the primary source:

- median or latest quote volume, scaled to a day, is under $1,000, or volume is missing
- median or latest close is more than 2% away
- any one close is more than 20% away
- the existing rules on venue, staleness, reach, warmup or overlap fail

No coin is named. An unusable venue's bars never reach the strategy, so they cannot count for or
against a signal. The first usable venue decides, and a disagreement fails without asking another
venue. With no usable venue the check fails with status `fail`, a `replay status` value of
`unknown` and text starting `Replay unknown`. The result shape has no separate unknown status.

Thresholds come from DEV: 117 venue-coin pairs, last 300 shared days. Bybit ZEC and DASH round to
zero volume and were 98.6% and 29.5% off on their worst day. Of the other 115 pairs the thinnest day
was $5.5k and the worst day 5.8% off. Bybit WAVES ended DEV 5.75% off, so it fails the 2% rule.

A single `{ venue, bars }` still works, but then one bad venue blocks the coin. The engine should
pass both venues as an array.
