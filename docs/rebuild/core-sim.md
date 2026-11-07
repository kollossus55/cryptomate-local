# V6 core and simulator

Owner: core-sim. Files: `shared/trading/v6Core.js`, `v6Sim.js`, `v6Stats.js`, `v6Strategies.js`,
`scripts/v6/harness-example.mjs`, and `tests/v6Core.test.mjs`, `v6Sim.test.mjs`, `v6Stats.test.mjs`.

Start from `scripts/v6/harness-example.mjs`. It loads DEV bars, runs `walkForward`, logs trials, audits
for lookahead and prints the D1-D8 report.

## The clock

`t` is the decision clock: the close of the last closed bar, in the simulator and in live. `market.barT`
is the open time of that bar. A fill at the open of bar k has `barsHeld` 1 at the close of bar k.

Each bar opening at T runs in this order:

1. Funding up to the open.
2. Queued intents fill at the open, exits first.
3. The bar becomes visible.
4. Delisting check.
5. In-bar funding.
6. `step` at t = T + barMs: order mark, exits, risk update, entries.
7. Stop and target intents fill inside this bar. All others queue for the next open.
8. Equity is marked at the close. `equity[i].t` is the bar open time.

Consequences worth knowing:

- A signal on the last bar never fills.
- A stop ratcheted on a bar cannot catch that same bar.
- A stop can fire on the entry bar.
- A bar touching stop and target counts the stop only.
- The final bar's close can be the holdout start, so the final bar asks nothing of the store. `ctx.universe`
  is empty for `top` universes on that bar, and costs use the bar's open time.

## How lookahead is prevented

- `ctx.bars` holds real arrays that grow one bar at a time, so the future is absent, not hidden.
- Bars are frozen. Changing the length of a visible array throws.
- Built-in indicators are computed once over the full series for speed, but read through `ctx.ind`, which
  is bounded by the visible length. A negative lag throws. A custom indicator function receives visible
  bars only.
- `auditLookahead` reruns on data truncated at random cuts and compares fills and equity bit for bit.

**Limit of the audit.** A strategy that closes over the full data from outside `ctx` passes the audit,
because truncating the simulator's bars does not touch the closure. Pass `rebuild: (bars) => strategy`
instead of `strategy`, and the audit rebuilds it from the cut data, which catches full-sample statistics.
A closure that reads exactly one bar ahead is still not caught even with `rebuild`, because the decision
that uses it is on the last bar of the cut, and that decision never fills. Read data through `ctx` only.

## Decisions

- **Perp shorts: rejected.** They reach v6Risk and are refused with `short_not_supported`. v6Risk has no
  funding term in its loss allowance, so no size would be honest. Short accounting and funding are tested
  through `fullWeightRisk`, which is for benchmarks and tests only.
- **Flatten:** only `riskDirectives(nextRisk).flatten` flattens. `halt.active` alone blocks entries and
  leaves positions alone.
- **Missing size multiplier:** fails closed in v6Risk. `runSim` builds an explicit multiplier per strategy,
  default 1, from `config.sizeMultipliers`.
- **Stop backstop:** if a stop was touched and the exit module did not report a stop, `step` exits with
  `stop_guard` and raises an alarm. It never replaces a stop the module did report.
- **Thin books:** a partly filled exit sets `exitPending`, and `step` re-emits the remainder each call until
  flat.
- **Default tier with no `tierFn`:** BTC and ETH Tier 1, everything else Tier 3.

## Units

| Value | Unit |
|---|---|
| v6Paper costs | percent, 0.10 = 0.10% |
| v6Risk config and costs | fraction |
| v6Exits params | percent |
| `signal.stopDistancePct` | fraction |
| funding rate | fraction |

## BTC above 100d against trend-test.mjs

`scripts/trend-test.mjs` cannot run here because its candle file is absent, and the research copy must not
be read. Its loop was ported onto `loadBars` DEV bars, 2018-03-05 to 2024-12-31, starting at 10,000.

| Run | Final | Sharpe | Max DD |
|---|---|---|---|
| Port: 0.15% per side, equity at open | 182,634 | 1.153 | 38.8% |
| Marked at close | 184,177 | 1.156 | 38.8% |
| 0.10% fee + 0.03% slip | 187,406 | 1.161 | 38.7% |
| Weight 0.995 | 186,303 | 1.161 | 38.6% |
| `runSim`, weight 0.995, `fullWeightRisk` | 186,160 | 1.161 | 38.6% |

The drift band never fires for a single coin at full weight, so removing it changes nothing. Once costs,
marking and weight are aligned, the two differ by 0.08%. The remainder is the sim's closing fill at the end
of the run (88 fills against 87) and sizing on the decision close rather than the fill-day open. The 0.995
weight is a setting of this comparison, leaving room for fees.

## Known gaps

- 1h stop-path fidelity is not modelled. Stops use the decision bar's high and low.
- A partly filled `reduce` is not re-emitted. Only `exit` remainders are chased.
- Migrated coins still take the 10% delisting haircut when the old symbol ends.
- A position stopped inside a bar is charged that whole bar's funding.
- Simulations run on a single timeframe.
- `step` is exercised against thin books through `simulateFill` in tests. No live worker exists yet.

## Performance

20 coins, 5 years, daily, every coin signalling every bar through real risk and exits, about 1,200 trades:
1.6 to 2.0 seconds on this machine (1,997ms in the last test run), with other agents running. That meets 2 seconds only
narrowly, not the "well under" that was asked for, and the speed test may fail under load. Correlations and v6Risk's config normalising
are the largest remaining costs. A sparser strategy is much faster: BTC above 100d takes about 150ms.
`pointInTimeUniverse` adds about 2 seconds once per process.

Real risk sizing gives low exposure: a single-coin strategy holds 2-3% of equity on average, and the example
top-20 momentum holds about 2%. Expect returns far below `fullWeightRisk` figures.

Harness fixes and their measured impact: `docs/rebuild/harness-fixes.md`.

## Stops and the order of events

A price sample may only meet the stop in force when it began. `stopAt(position, t)` in
v6Exits is the one rule for this. Core records each change through `recordStop` in
`position.stopLog`, as {t, stop}, and the current stop's time in `stopSetAt`.

- A stop decided on a closed bar counts as set at that close, so it covers the whole next bar.
- A stop moved by a tick counts from the tick. That bar's range meets the older stop, and the
  moved stop meets only the close, plus `after` if the caller passes it.
- A sample older than everything known returns null and tests nothing. With no log, only
  samples from `stopSetAt` on can test, or from the entry if the stop never moved.
- The log holds 48 entries. Past that the second-oldest goes, so the oldest stays and
  `stopAt` can answer with an older, looser stop, never a tighter one.
- The simulator has no ticks, so none of this changes a test there. On DEV bars, six runs
  (1d and 4h, three exit profiles) gave identical trades, equity and summary.
