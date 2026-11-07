# Paper fills and ledger (`shared/trading/v6Paper.js`)

Pure module: no clock, no I/O, no exchange access, no imports. Tests:
`node tests/v6Paper.test.mjs`.

## Exports

| Export | Purpose |
|---|---|
| `costFor(symbol, tier, { stress, instrument })` | Contract table. Returns `{ feePct, slipPct, stopSlipPct, instrument, tier }` |
| `toRiskCosts(cost)` | The same cost as fractions, for `v6Risk.sizeEntry` |
| `simulateFill({ intent, bar \| book, cost, isStop, stopPrice, isDelist, t, maxBookAgeMs })` | Returns a Fill |
| `walkBook(levels, qty)` | Base-quantity book walk |
| `createLedger({ cash, t })`, `assertLedger(ledger)` | New ledger; full invariant check |
| `applyFill(ledger, fill)` | Immutable update. `ledger.lastFill` is the settled fill |
| `applyFunding(ledger, { symbol, rate, price, t })` | One funding payment on a perp |
| `updatePosition(ledger, symbol, patch)` | Stops, water marks, exit plan. Refuses accounting fields |
| `ledgerEquity(ledger, prices)`, `positionsBySymbol(ledger)` | Mark-to-market; `Map<symbol, Position>` for v6Core |
| `adoptLegacyPortfolio(record, { t })` | Portfolio entity to ledger |
| `toPortfolioRecord(ledger, prices, { now })` | Ledger to Portfolio update payload |
| `toTradeRecord(ledger.lastFill)` | Settled fill to Trade row |
| `LedgerInvariantError`, `PaperInputError` | Typed errors with a `.code` |

## Units

`feePct`, `slipPct` and `stopSlipPct` are PERCENT numbers, as in the contract table:
`0.10` means 0.10%. `v6Exits` uses the same units. `v6Risk` uses fractions, so go through
`toRiskCosts`. `simulateFill` refuses a non-zero cost below 0.01 with code `cost_units`,
because that can only be a fraction and would under-charge 100x. Funding `rate` is a
fraction, as exchanges publish it.

## Fill rules

`intent.side` is the position side on exits too, which is what v6Core emits.

| Mode | Market | Stop |
|---|---|---|
| Bar (`method: 'bar'`) | next bar open, plus tier slip | worse of stop and open, plus tier slip plus stop slip |
| Book (`'book'`) | worse of VWAP and mid plus tier slip | that, then worse of it and stop, plus stop slip |
| No usable book (`'tier_fallback'`) | `refPrice` plus tier slip | worse of stop and `refPrice`, plus tier slip plus stop slip |
| Delist (`'bar_delist'`) | last close minus 10%, fee still charged | |

Book unavailable means missing, empty, crossed, flagged `stale`, or older than
`maxBookAgeMs` (30s). The reason is in `flags` as `book_unavailable:<why>`.

**Tier floor on book fills.** A book fill is never better than mid plus tier slippage.
Small orders would otherwise pay about half the spread, well under the table, so live
paper would look cheaper than the backtest that certified the strategy. The contract says
every result is net of the table. `slipSource` says which one set the price
(`'book'` or `'tier_floor'`), and `bookVwap` always keeps the raw walk, so real costs can
still be measured against the table.

**Thin books.** An entry is refused whole: `status: 'rejected'`, `rejectReason:
'insufficient_depth'`, and `applyFill` leaves the ledger alone. An exit or reduce fills the
visible depth with `status: 'partial'` and `shortfallQty`. It is not blocked, and no price
is invented for depth nobody can see. The rest stays open at risk, so the next step must
emit the exit again.

## Ledger

```
{ cash, positions: Position[], realized, fees,
  capital, grossRealized, funding, trades, recentFillIds, lastFill, lastT }
```

Position is the contract shape plus `instrument`, `collateral`, `fundingAccrued`,
`lastFundingT`, `addCount`, `lastPrice`. One position per symbol, as in the contract's
`Map<symbol, Position>`.

Checked on the way in and out of every update:

```
cash + SUM(collateral) + SUM(entryFees) + SUM(fundingAccrued) = capital + realized
realized = grossRealized - (fees - open entry fees) - (funding - open funding)
```

Entry fees and funding stay on the open position and reach `realized` pro rata as it
closes, so the Trade rows sum exactly to `realized`.

Perps are fully collateralised at 1x, because the contract caps gross exposure at 100%.
Shorts exist on perps only, so a short must be costed with `instrument: 'perp'`. Funding
comes from cash, then from the position's collateral if cash has run out.

Breach codes: `negative_cash`, `insufficient_cash`, `value_not_conserved`, `pnl_mismatch`,
`fee_mismatch`, `duplicate_fill`, `duplicate_funding`, `overclose`, `no_position`,
`spot_short`, `implicit_flip`, `strategy_mismatch`, `instrument_mismatch`, `side_mismatch`,
`funding_on_spot`, `bad_fill`, `bad_funding`, `non_finite`, `bad_qty`, and others.

Duplicate detection remembers the last 256 fill ids. Ids are derived from symbol, time,
type, side, qty and price, or taken from `intent.id` if set.

## Legacy meaning of `total_profit_loss`

It is cumulative REALISED P&L, net of fees (pro-rated entry fee plus exit fee). It excludes
unrealised P&L, despite the "Total P&L" label in `PortfolioCard`. The schema says
"Total realized profit/loss", `portfolio.js` adds only `netPnL` to it, and the live record
proves it:

```
10000 + total_profit_loss + SUM(position.profit_loss) = total_balance
10000 + (-53.58)          + (-37.56)                  = 9908.86
```

`position.profit_loss` is unrealised net of entry fees. Both are preserved. Do not change
`total_profit_loss` to equity minus start.

Adoption solves `capital` from the identity; the live record gives 10,000. Fees paid
before adoption cannot be recovered, so `fees` starts at the open entry fees.

V6-only state travels in `position.v6` and `v6_ledger`, which the UI ignores, so a ledger
survives a write and re-adopt. Legacy fields stay authoritative: if the dashboard edits a
position, its `v6` block is dropped and a warning is added to `ledger.adoption.warnings`.

## Worker wiring

```js
const cost = costFor(symbol, tierFor(symbol, t), { instrument });
const fill = simulateFill({ intent, book, cost, t,
  isStop: intent.fill?.mode === 'stop', stopPrice: position?.stopPrice });
ledger = applyFill(ledger, fill);                    // rejected fills are a no-op
if (fill.status !== 'rejected') trades.push(toTradeRecord(ledger.lastFill));
// After an entry: const p = v6Core.openPosition({ intent, fill, t, ... });
// then updatePosition(ledger, symbol, { stopPrice, initialStopPrice, exitPlan,
// exitProfile, riskAtEntry }) from p. Apply step() patches through updatePosition too.
```

## Known limits

- **Adopted positions have no stop.** All 5 live V5 positions adopt with `stopPrice: null`
  and `strategyId: 'legacy'`. The worker must give them a stop and exit plan before the
  first step.
- **Bankruptcy blocks an exit.** A short close that would leave total cash negative throws
  `negative_cash`. At 1x this needs a loss above the whole account, but it is the one case
  where the ledger refuses an exit.
- **No limit fills.** `simulateFill` has no limit mode, so a target exit is a market fill.
- **No volume check in bar mode.** A simulated fill can exceed the bar's real volume.
  Liquidity is only tested in book mode and by the signal gate.
- **Book depth is what the snapshot shows.** Hidden liquidity and order-book reaction to
  the order are not modelled.
- **Fees are in quote currency on both sides.** Binance takes buy fees in base; the value
  is the same.
- **Dashboards are long-only.** Position rows compute `(live - entry) * qty`, so a short's
  P&L shows with the wrong sign when a live price is available. A short's cover is a `buy`,
  so the `PortfolioCard` win rate, which reads only sells, leaves it out.
