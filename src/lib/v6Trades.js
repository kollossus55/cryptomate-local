import { base44 } from '@/api/base44Client';

// Mirrors EXCHANGE_LABEL in shared/trading/v6Paper.js, which stamps every V6 trade.
export const V6_EXCHANGE = 'Paper Trading (V6)';

export const isV6Trade = (trade) => trade?.exchange === V6_EXCHANGE;

export const V6_RESET_REFUSED =
  'V6 has a paper record on this account, so the old reset is refused: it would delete V6 trades ' +
  'or leave the V6 ledger out of step with the portfolio.';

/**
 * True once V6 has written anything to the account: a ledger or engine state on
 * any Portfolio row (the same test as isV6Record in server/entityStore.js), or
 * any V6 trade. Legacy resets must stop when this is true. A failed read
 * rejects, and callers treat that as "do not reset".
 */
export async function v6RecordExists() {
  const [portfolios, v6Trades] = await Promise.all([
    base44.entities.Portfolio.list(),
    base44.entities.Trade.filter({ exchange: V6_EXCHANGE }, '-created_date', 1),
  ]);
  return portfolios.some((p) => p.v6_ledger || p.v6_state) || v6Trades.length > 0;
}
