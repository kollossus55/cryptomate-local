# Market exposure account (Strategy Lab)

Pre-registration, written 2026-11-18 before any code ran. The rules below are fixed. They were
chosen without looking at any coin's returns.

## What this is, and what it is not

A paper account that holds a basket of large, liquid coins, sized so the account moves about 20%
a year, and stops for good at a 30% loss. It exists so the system has something paper trading
continuously, with fills, fees, rebalancing and a drawdown floor, while V6 holds cash.

- **No edge is claimed.** Its expected return is the crypto market's, scaled down. When crypto
  falls, it loses money. Its results are not evidence that any strategy works.
- **Separate from V6.** It is a Strategy Lab account (StrategyLabAccount, StrategyLabTrade). It
  never reads or writes Portfolio, Trade or V6 state, and needs no certificate. V6's gate is
  unchanged.
- **No research trial.** Nothing is searched or tuned, so the global trial count (524) is
  unchanged.
- **Paper only.** The PAPER_ONLY lock stays on. It never places an exchange order.

## Universe: which coins it may hold

The universe is re-screened at the start and then every 91 days. A coin is a member when it
passes all six rules on the screen day:

| Rule | Requirement |
|---|---|
| C1 | A crypto asset: not a stablecoin, wrapped or pegged coin, leveraged token, or tokenised stock or commodity (`classifyBase` in `v6Exchanges.js`, with the venues' own tags). |
| C2 | Listed on at least 4 of the 8 venues (Binance, OKX, Bybit, Kraken, Coinbase, KuCoin, Gate, Bitget), with prices that agree (no `priceConflict`). |
| C3 | Median 24h volume across venues of at least $100M, over the daily snapshots of the last 30 days. A day the coin is missing from the snapshot counts as zero. Until 30 snapshots exist, the median of those taken so far: the first screen uses one snapshot. |
| C4 | At least 1,095 days (3 years) of Binance daily history before the screen day. A coin not on Binance fails. |
| C5 | Buying $10,000 on OKX's order book costs at most 0.10% above the mid price. |
| C6 | OKX has a price and at least 60 closed daily candles for it (the account trades and values on OKX, like the rest of the Strategy Lab). |

At most 15 members: if more pass, the 15 with the highest C3 volume. A daily volume snapshot is
taken once per closed daily candle; it keeps coins that pass C1 and C2 with at least $10M of
volume.

The read-only screen on 2026-11-18 (one snapshot) passed BTC, ETH, SOL, XRP, ZEC, NEAR and BNB.
HYPE failed C4. That screen was a preview: membership is set by the account's own first screen.

## Sizing

- **Weights:** each member's weight is proportional to 1 / its volatility (60 daily log returns
  on OKX), so each carries about the same risk.
- **Volatility target:** the basket's volatility is estimated from the same 60 days, with
  correlations, annualised with 365 days. All weights are scaled by `min(1, 20% / basket vol)`.
  Total exposure never exceeds 100% of equity: no leverage. The rest is cash.

## Rebalancing

- On the first daily decision, then whenever 7 or more days have passed since the last
  rebalance, and always right after a screen.
- A coin is traded only when it enters or leaves, or its value differs from its target by more
  than 25% of the target. Trades under $25 are skipped. Sells go first.
- A coin that leaves the universe is sold at that rebalance.
- A held coin with no OKX price is left as it is until a price returns.

## Floor

Checked on every hourly run at the latest prices. If equity is at or below $7,000 (70% of the
$10,000 start), everything is sold and the account stops for good (`floored_at` is set). It is
not restarted automatically.

## Costs and data

The Strategy Lab cost model (`costs.js`, OKX fees and slippage by volume). Prices and daily
candles from OKX. Volume snapshots and C2 from the V6 market hub. Listing age from Binance's
public daily candles.

## Changes

The operator may change these rules. Each change is listed below with its date and reason
before it takes effect. Results before and after a change are reported separately. Rules are
never changed because of this account's own results.

| Date | Change | Reason |
|---|---|---|
| | | |
