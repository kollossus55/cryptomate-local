/**
 * V6 paper tests: costs, bar and book fills, the ledger invariants, legacy
 * shapes, and randomised sequences checked against an independent cash tally.
 */
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import {
  costFor, simulateFill, walkBook, applyFill, applyFunding, createLedger, assertLedger, updatePosition,
  ledgerEquity, quarantineStatus, adoptLegacyPortfolio, toPortfolioRecord, toTradeRecord, positionsBySymbol, toRiskCosts,
  LedgerInvariantError, PaperInputError, EXCHANGE_LABEL,
} from '../shared/trading/v6Paper.js';
import { createPortfolioState, applyBuy, applySell } from '../shared/trading/portfolio.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const throwsCode = (fn, code, type = LedgerInvariantError) => assert.throws(fn, (e) => {
  assert.ok(e instanceof type, `wrong error type: ${e}`);
  assert.strictEqual(e.code, code);
  return true;
});
const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
};

const T = Date.UTC(2024, 5, 1);
const NO_SLIP = { feePct: 0.1, slipPct: 0 };
const intent = (o = {}) => ({
  type: 'enter', symbol: 'SOLUSDT', strategyId: 's1', side: 'long', qty: 10,
  reason: 'test', reasonCode: 'TEST', refPrice: 100, ...o,
});
const bar = (o, h = o * 1.01, l = o * 0.99, c = o) => ({ t: T, o, h, l, c, v: 1, qv: 1 });
const buyAt = (price, qty, o = {}) => simulateFill({
  intent: intent({ qty, ...o }), bar: bar(price), cost: { feePct: 0.1, slipPct: 0, ...o.cost }, t: o.t ?? T,
});
const sellAt = (price, qty, o = {}) => buyAt(price, qty, { type: 'reduce', ...o });

console.log('costs');

test('costFor matches the contract table', () => {
  assert.deepStrictEqual(
    [costFor('BTCUSDT', 1), costFor('DOGEUSDT', 2), costFor('XYZUSDT', 3)].map((c) => [c.feePct, c.slipPct]),
    [[0.1, 0.03], [0.1, 0.08], [0.1, 0.25]],
  );
  assert.strictEqual(costFor('BTCUSDT', 1, { instrument: 'perp' }).feePct, 0.05);
});

test('stress scales fee, slippage and stop slip, and cannot discount', () => {
  const c = costFor('ETH/USDT', 1, { stress: 2 });
  near(c.feePct, 0.2); near(c.slipPct, 0.06); near(c.stopSlipPct, 0.2);
  throwsCode(() => costFor('BTCUSDT', 1, { stress: 0.5 }), 'bad_stress', PaperInputError);
  throwsCode(() => costFor('BTCUSDT', 1, { stress: NaN }), 'bad_stress', PaperInputError);
});

test('tier mistakes cost more, never less', () => {
  assert.strictEqual(costFor('DOGEUSDT', 1).slipPct, 0.08);
  assert.strictEqual(costFor('ETHFIUSDT', 1).slipPct, 0.08);
  assert.strictEqual(costFor('BTCUSDT', undefined).slipPct, 0.25);
});

test('a fractional cost is refused, not charged 100x too low', () => {
  throwsCode(() => simulateFill({ intent: intent(), bar: bar(100), cost: { feePct: 0.001, slipPct: 0.0003 } }),
    'cost_units', PaperInputError);
});

test('toRiskCosts converts to the fractions v6Risk reads', () => {
  const r = toRiskCosts(costFor('BTCUSDT', 1));
  near(r.feePct, 0.001); near(r.slipPct, 0.0003); near(r.stopSlipPct, 0.001);
});

console.log('bar fills');

test('market fill takes the bar open plus slippage, adverse on both sides', () => {
  const cost = costFor('SOLUSDT', 3);
  const buy = simulateFill({ intent: intent(), bar: bar(100), cost });
  near(buy.price, 100.25); near(buy.fee, 10 * 100.25 * 0.001);
  assert.strictEqual(buy.method, 'bar');
  const sell = simulateFill({ intent: intent({ type: 'exit' }), bar: bar(100), cost });
  near(sell.price, 99.75);
});

test('long stop above the open fills from the gapped open, not the stop', () => {
  const f = simulateFill({ intent: intent({ type: 'exit' }), bar: bar(90, 92, 88), cost: costFor('SOLUSDT', 3), isStop: true, stopPrice: 95 });
  near(f.price, 90 * (1 - 0.0035));
  assert.ok(f.flags.includes('gap_through_stop'));
});

test('long stop inside the bar fills from the stop with the extra slip', () => {
  const f = simulateFill({ intent: intent({ type: 'exit', symbol: 'BTCUSDT' }), bar: bar(100, 101, 94), cost: costFor('BTCUSDT', 1), isStop: true, stopPrice: 95 });
  near(f.price, 95 * (1 - 0.0013)); // tier 1: 0.03% + 0.10% stop slip
  assert.deepStrictEqual(f.flags, []);
});

test('short stop mirrors it: the higher of stop and open', () => {
  const cost = costFor('BTCUSDT', 1, { instrument: 'perp' });
  const f = simulateFill({ intent: intent({ type: 'exit', side: 'short', symbol: 'BTCUSDT' }), bar: bar(110, 112, 108), cost, isStop: true, stopPrice: 105 });
  near(f.price, 110 * 1.0013);
  assert.strictEqual(f.action, 'buy');
});

test('stress also widens the stop slip', () => {
  const f = simulateFill({ intent: intent({ type: 'exit', symbol: 'BTCUSDT' }), bar: bar(100, 101, 94), cost: costFor('BTCUSDT', 1, { stress: 2 }), isStop: true, stopPrice: 95 });
  near(f.price, 95 * (1 - 0.0026));
});

test('an untouched stop is flagged', () => {
  const f = simulateFill({ intent: intent({ type: 'exit' }), bar: bar(100, 101, 99), cost: costFor('SOLUSDT', 3), isStop: true, stopPrice: 95 });
  assert.ok(f.flags.includes('stop_not_touched'));
});

test('delisted coin exits at last close minus 10%', () => {
  const f = simulateFill({ intent: intent({ type: 'exit' }), bar: bar(50, 51, 40, 42), cost: costFor('SOLUSDT', 3), isDelist: true });
  near(f.price, 37.8);
  assert.strictEqual(f.method, 'bar_delist');
});

console.log('book fills');

const BOOK = {
  t: T,
  bids: [[99, 5], [98, 5], [97, 5]],
  asks: [[101, 5], [102, 5], [103, 5]],
};

test('walkBook arithmetic', () => {
  const w = walkBook(BOOK.asks, 8);
  near(w.quote, 5 * 101 + 3 * 102);
  near(w.vwap, (5 * 101 + 3 * 102) / 8);
  assert.strictEqual(w.filledQty, 8);
  assert.strictEqual(w.shortfallQty, 0);
});

test('book buy fills at the VWAP of the asks, fee on executed notional', () => {
  const f = simulateFill({ intent: intent({ qty: 8 }), book: BOOK, cost: NO_SLIP });
  near(f.price, 811 / 8);
  near(f.fee, 811 * 0.001);
  assert.strictEqual(f.method, 'book');
  assert.strictEqual(f.slipSource, 'book');
  near(f.slipPct, (811 / 8 - 100) / 100 * 100);
});

test('book sell walks bids downward', () => {
  const f = simulateFill({ intent: intent({ type: 'exit', qty: 12 }), book: BOOK, cost: NO_SLIP });
  near(f.price, (5 * 99 + 5 * 98 + 2 * 97) / 12);
});

test('unsorted, string-priced and object levels are normalised', () => {
  const book = { t: T, bids: [{ price: 98, qty: 5 }, { price: 99, qty: 5 }], asks: [['102', '5'], ['101', '5'], ['bad', '1']] };
  near(simulateFill({ intent: intent({ qty: 8 }), book, cost: NO_SLIP }).price, 811 / 8);
});

test('a thin size never beats mid plus tier slippage; the raw walk is kept', () => {
  const book = { t: T, bids: [[99.99, 100]], asks: [[100.01, 100]] };
  const f = simulateFill({ intent: intent({ qty: 1 }), book, cost: costFor('SOLUSDT', 3) });
  near(f.price, 100 * 1.0025);
  near(f.bookVwap, 100.01);
  assert.strictEqual(f.method, 'book');
  assert.strictEqual(f.slipSource, 'tier_floor');
});

test('a walk worse than the tier is what gets charged', () => {
  const f = simulateFill({ intent: intent({ qty: 15 }), book: BOOK, cost: costFor('SOLUSDT', 3) });
  near(f.price, 102);
  assert.strictEqual(f.slipSource, 'book');
});

test('thin book: an entry is refused whole and changes nothing', () => {
  const f = simulateFill({ intent: intent({ qty: 16 }), book: BOOK, cost: NO_SLIP });
  assert.strictEqual(f.status, 'rejected');
  assert.strictEqual(f.rejectReason, 'insufficient_depth');
  assert.strictEqual(f.availableQty, 15);
  assert.strictEqual(f.fee, 0);
  const l = createLedger({ cash: 1000, t: T });
  assert.strictEqual(applyFill(l, f), l);
  assert.throws(() => toTradeRecord(f), LedgerInvariantError);
});

test('thin book: an exit is never blocked, it fills the visible depth', () => {
  const f = simulateFill({ intent: intent({ type: 'exit', qty: 20 }), book: BOOK, cost: NO_SLIP });
  assert.strictEqual(f.status, 'partial');
  assert.strictEqual(f.qty, 15);
  assert.strictEqual(f.requestedQty, 20);
  near(f.shortfallQty, 5);
  near(f.price, 98);
  assert.ok(f.flags.includes('insufficient_depth'));
  let l = applyFill(createLedger({ cash: 5000, t: T }), buyAt(100, 20));
  l = applyFill(l, f);
  near(l.positions[0].qty, 5);
});

test('book stop fills at the worse of walk and stop, then the stop slip', () => {
  const up = simulateFill({ intent: intent({ type: 'exit', qty: 1 }), book: BOOK, cost: NO_SLIP, isStop: true, stopPrice: 95 });
  near(up.price, 95 * 0.999);
  const down = simulateFill({ intent: intent({ type: 'exit', qty: 1 }), book: BOOK, cost: NO_SLIP, isStop: true, stopPrice: 99.5 });
  near(down.price, 99 * 0.999);
});

test('unavailable book falls back to tier slippage and says so', () => {
  const cost = costFor('SOLUSDT', 2);
  const cases = [
    [null, 'no_book'],
    [{ t: T, bids: [], asks: [] }, 'empty_book'],
    [{ t: T, bids: [[102, 1]], asks: [[101, 1]] }, 'crossed_book'],
    [{ t: T - 60_000, bids: [[99, 9]], asks: [[101, 9]] }, 'stale_book'],
    [{ t: T, stale: true, bids: [[99, 9]], asks: [[101, 9]] }, 'stale_book'],
  ];
  for (const [book, why] of cases) {
    const f = simulateFill({ intent: intent(), book, cost, t: T });
    assert.strictEqual(f.method, 'tier_fallback');
    assert.ok(f.flags.includes(`book_unavailable:${why}`), why);
    near(f.price, 100.08);
  }
});

test('fallback stop still takes the worse price and the stop slip', () => {
  const f = simulateFill({ intent: intent({ type: 'exit', refPrice: 90 }), cost: costFor('SOLUSDT', 2), t: T, isStop: true, stopPrice: 95 });
  near(f.price, 90 * 0.9982);
});

test('no book and no reference price cannot be invented', () => {
  throwsCode(() => simulateFill({ intent: intent({ refPrice: undefined }), cost: NO_SLIP, t: T }), 'no_price', PaperInputError);
  throwsCode(() => simulateFill({ intent: intent(), cost: NO_SLIP }), 'missing_time', PaperInputError);
  throwsCode(() => simulateFill({ intent: intent(), bar: bar(1), book: BOOK, cost: NO_SLIP }), 'ambiguous_mode', PaperInputError);
  throwsCode(() => simulateFill({ intent: intent({ side: 'flat' }), bar: bar(1), cost: NO_SLIP }), 'bad_intent', PaperInputError);
});

console.log('ledger');

test('entry debits notional and fee; input is not mutated', () => {
  const l0 = deepFreeze(createLedger({ cash: 2000, t: T }));
  const l1 = applyFill(l0, buyAt(100, 10));
  near(l1.cash, 2000 - 1000 - 1);
  near(l1.fees, 1);
  assert.strictEqual(l1.realized, 0);
  assert.strictEqual(l1.positions[0].entryFees, 1);
  assert.strictEqual(l0.cash, 2000);
});

test('multiple entries average the price; partial closes realise the right P&L', () => {
  let l = createLedger({ cash: 5000, t: T });
  l = applyFill(l, buyAt(100, 10, { t: T + 1 }));
  l = applyFill(l, buyAt(200, 10, { t: T + 2 }));
  near(l.positions[0].entryPrice, 150);
  near(l.positions[0].entryFees, 3);
  assert.strictEqual(l.positions[0].addCount, 1);

  l = applyFill(l, sellAt(180, 5, { t: T + 3 }));
  near(l.lastFill.grossPnl, 150);
  near(l.lastFill.entryFeeShare, 0.75);
  near(l.lastFill.realizedPnl, 150 - 0.75 - 0.9);
  near(l.positions[0].qty, 15);
  near(l.positions[0].entryFees, 2.25);
  near(l.positions[0].entryPrice, 150);

  l = applyFill(l, sellAt(120, 15, { type: 'exit', t: T + 4 }));
  near(l.lastFill.grossPnl, -450);
  assert.strictEqual(l.positions.length, 0);
  const fees = 1 + 2 + 0.9 + 1.8;
  near(l.fees, fees);
  near(l.realized, 150 - 450 - fees);
  near(l.cash, 5000 + l.realized);
});

test('fee reconciliation: every fill fee is counted once, across the ledger and Trade rows', () => {
  const fills = [buyAt(100, 10, { t: T + 1 }), sellAt(110, 4, { t: T + 2 }), sellAt(90, 6, { type: 'exit', t: T + 3 })];
  let l = createLedger({ cash: 2000, t: T });
  const rows = [];
  for (const f of fills) { l = applyFill(l, f); rows.push(toTradeRecord(l.lastFill)); }
  near(l.fees, fills.reduce((s, f) => s + f.fee, 0));
  near(rows.reduce((s, r) => s + r.fee, 0), l.fees);
  near(rows.reduce((s, r) => s + r.profit_loss, 0), l.realized);
  near(l.grossRealized - l.fees, l.realized);
});

test('the same fill twice is a breach', () => {
  const f = buyAt(100, 1);
  const l = applyFill(createLedger({ cash: 1000, t: T }), f);
  throwsCode(() => applyFill(l, f), 'duplicate_fill');
});

test('breaches throw typed errors', () => {
  const l = applyFill(createLedger({ cash: 2000, t: T }), buyAt(100, 10));
  throwsCode(() => applyFill(createLedger({ cash: 50, t: T }), buyAt(100, 10)), 'insufficient_cash');
  throwsCode(() => applyFill(l, sellAt(100, 11, { t: T + 1 })), 'overclose');
  throwsCode(() => applyFill(l, sellAt(100, 1, { symbol: 'XUSDT', t: T + 1 })), 'no_position');
  throwsCode(() => applyFill(createLedger({ cash: 2000 }), buyAt(100, 1, { side: 'short', type: 'enter' })), 'spot_short');
  throwsCode(() => applyFill(l, buyAt(100, 1, { strategyId: 's2', t: T + 1 })), 'strategy_mismatch');
  throwsCode(() => applyFill(l, { ...buyAt(100, 1, { t: T + 1 }), price: NaN }), 'bad_fill');
  throwsCode(() => applyFill(l, { ...buyAt(100, 1, { t: T + 1 }), fee: -1 }), 'bad_fill');
  throwsCode(() => applyFill(l, { ...buyAt(100, 1, { t: T + 1 }), id: undefined }), 'bad_fill');
});

test('a ledger corrupted from outside is detected', () => {
  const l = applyFill(createLedger({ cash: 2000, t: T }), buyAt(100, 10));
  throwsCode(() => assertLedger({ ...l, cash: l.cash + 1 }), 'value_not_conserved');
  throwsCode(() => assertLedger({ ...l, cash: -1 }), 'negative_cash');
  throwsCode(() => assertLedger({ ...l, fees: l.fees + 1 }), 'pnl_mismatch');
  throwsCode(() => assertLedger({ ...l, cash: NaN }), 'non_finite');
  throwsCode(() => applyFill({ ...l, realized: 5 }, sellAt(100, 1, { t: T + 1 })), 'value_not_conserved');
});

test('all-in entry does not trip on a rounding error', () => {
  const cash = 1234.56;
  const price = 3.3333333;
  const qty = cash / (price * 1.001);
  const l = applyFill(createLedger({ cash, t: T }), buyAt(price, qty));
  assert.ok(l.cash >= 0);
});

const perpCost = { feePct: 0.05, slipPct: 0, instrument: 'perp' };
const perp = (o) => ({ side: 'short', symbol: 'BTCUSDT', cost: perpCost, ...o });

test('perp short: profit when price falls, fees net, value locked as collateral', () => {
  let l = createLedger({ cash: 2000, t: T });
  const f = simulateFill({ intent: intent(perp({ type: 'enter' })), bar: bar(100), cost: perpCost, t: T });
  assert.strictEqual(f.action, 'sell');
  l = applyFill(l, f);
  near(l.cash, 2000 - 1000 - 0.5);
  near(ledgerEquity(l, { BTCUSDT: 90 }).equity, 2000 - 0.5 + 100);
  l = applyFill(l, simulateFill({ intent: intent(perp({ type: 'exit' })), bar: bar(90), cost: perpCost, t: T + 1 }));
  near(l.lastFill.grossPnl, 100);
  near(l.realized, 100 - 0.5 - 0.45);
  near(l.cash, 2000 + l.realized);
});

test('funding: longs pay and shorts receive on a positive rate, closed pro rata', () => {
  const open = (side, cash = 2000) => applyFill(createLedger({ cash, t: T }),
    simulateFill({ intent: intent({ side, symbol: 'BTCUSDT', type: 'enter' }), bar: bar(100), cost: perpCost, t: T }));
  const event = { symbol: 'BTCUSDT', rate: 0.0001, price: 110, t: T + 8 * 3600e3 };

  const long = applyFunding(open('long'), event);
  near(long.funding, 0.11);
  near(long.cash, open('long').cash - 0.11);
  const short = applyFunding(open('short'), event);
  near(short.funding, -0.11);
  near(short.cash, open('short').cash + 0.11);

  const half = applyFill(long, simulateFill({ intent: intent({ type: 'reduce', symbol: 'BTCUSDT', qty: 5 }), bar: bar(100), cost: perpCost, t: T + 9e6 }));
  near(half.lastFill.fundingShare, 0.055);
  near(half.lastFill.realizedPnl, 0 - 0.25 - 0.055 - 0.25);
  near(half.positions[0].fundingAccrued, 0.055);

  throwsCode(() => applyFunding(long, event), 'duplicate_funding');
});

test('funding with no free cash comes out of collateral and still conserves', () => {
  const qty = 2000 / (100 * 1.0005);
  let l = applyFill(createLedger({ cash: 2000, t: T }),
    simulateFill({ intent: intent({ qty, symbol: 'BTCUSDT' }), bar: bar(100), cost: perpCost, t: T }));
  near(l.cash, 0, 1e-6);
  const before = l.positions[0].collateral;
  l = applyFunding(l, { symbol: 'BTCUSDT', rate: 0.001, price: 100, t: T + 1 });
  assert.ok(l.positions[0].collateral < before);
  l = applyFill(l, simulateFill({ intent: intent({ type: 'exit', qty, symbol: 'BTCUSDT' }), bar: bar(100), cost: perpCost, t: T + 2 }));
  near(l.cash, 2000 + l.realized, 1e-6);
});

test('funding on spot is refused', () => {
  const l = applyFill(createLedger({ cash: 2000, t: T }), buyAt(100, 1));
  throwsCode(() => applyFunding(l, { symbol: 'SOLUSDT', rate: 0.001, price: 100, t: T + 1 }), 'funding_on_spot');
});

test('a short that loses more than the account has throws, it does not hide the hole', () => {
  let l = applyFill(createLedger({ cash: 1000, t: T }),
    simulateFill({ intent: intent(perp({ type: 'enter', qty: 9 })), bar: bar(100), cost: perpCost, t: T }));
  throwsCode(() => applyFill(l, simulateFill({ intent: intent(perp({ type: 'exit', qty: 9 })), bar: bar(300), cost: perpCost, t: T + 1 })), 'negative_cash');
});

test('updatePosition moves stops but not money', () => {
  const l = applyFill(createLedger({ cash: 2000, t: T }), buyAt(100, 1, { stopPrice: 90, initialStopPrice: 90, exitProfile: 'trend' }));
  assert.strictEqual(l.positions[0].stopPrice, 90);
  assert.strictEqual(l.positions[0].exitProfile, 'trend');
  assert.strictEqual(updatePosition(l, 'SOLUSDT', { stopPrice: 95 }).positions[0].stopPrice, 95);
  throwsCode(() => updatePosition(l, 'SOLUSDT', { qty: 5 }), 'accounting_field');
  assert.strictEqual(positionsBySymbol(l).get('SOLUSDT').qty, 1);
});

console.log('legacy shapes');

// Snapshot of the live record, 2026-11-05 13:35 UTC, with ownership fields removed.
const pos = (asset_symbol, quantity, avg_entry_price, current_value, fees_paid, profit_loss, highest_price, last_known_price, opened_at) => ({
  asset_symbol, quantity, avg_entry_price, current_value, fees_paid, profit_loss, highest_price, last_known_price, opened_at,
  dca_count: 0, breakeven_activated: false, trailing_stop_price: null, partial_profits_taken: [],
});
const SAMPLE = {
  total_balance: 9908.85902775,
  available_balance: 5949.53782034,
  positions: [
    pos('ZECUSDT', 0.6170330028614842, 1296.5270841105876, 808.1774864879147, 0.8000043711539121, 7.377482116760902, 1333.55, 1309.78, '2026-11-05T00:00:00.485Z'),
    pos('PEPEUSDT', 161098693.08685234, 0.000004965899999999999, 793.7171509696128, 0.7999999999999998, -7.0828490303870995, 0.0000050912, 0.0000049269, '2026-11-05T00:00:00.485Z'),
    pos('ONDOUSDT', 1958.3843329253368, 0.4085, 781.3953488372094, 0.8, -19.404651162790607, 0.4158, 0.399, '2026-11-05T00:00:00.485Z'),
    pos('OKBUSDT', 7.192378059509908, 110.84701294901043, 791.952748132636, 0.7973040668686399, -6.098179830905985, 111.62, 110.11, '2026-11-05T07:35:00.815Z'),
    pos('XLMUSDT', 4772.236597561778, 0.16672245281702447, 784.0784729794001, 0.7956506965640547, -12.356168685834843, 0.16672245281702447, 0.1643, '2026-11-05T11:35:00.977Z'),
  ],
  total_profit_loss: -53.57660566,
  total_trades: 9,
  id: 'sample',
  positions_value: 3959.32120741,
  last_updated: '2026-11-05T13:35:06.654Z',
};
const lastPrices = (record) => new Map(record.positions.map((p) => [p.asset_symbol, p.last_known_price]));

test('total_profit_loss keeps its meaning: realised, net, unrealised excluded', () => {
  // The identity the live record satisfies with a 10,000 start.
  const unrealised = SAMPLE.positions.reduce((s, p) => s + p.profit_loss, 0);
  near(10000 + SAMPLE.total_profit_loss + unrealised, SAMPLE.total_balance, 1e-3);
  const l = adoptLegacyPortfolio(SAMPLE);
  near(l.capital, 10000, 1e-3);
  assert.strictEqual(l.realized, SAMPLE.total_profit_loss);
  const out = toPortfolioRecord(l, new Map([['ZECUSDT', 2000]]));
  assert.strictEqual(out.total_profit_loss, SAMPLE.total_profit_loss, 'a price move must not touch it');
});

/** Every legacy field survives adopt -> write. */
function assertRoundTrip(record) {
  const ledger = adoptLegacyPortfolio(record);
  const out = toPortfolioRecord(ledger, lastPrices(record));
  near(out.available_balance, record.available_balance, 1e-8);
  near(out.total_balance, record.total_balance, 1e-6);
  near(out.total_profit_loss, record.total_profit_loss || 0, 1e-8);
  assert.strictEqual(out.total_trades, record.total_trades || 0);
  assert.strictEqual(out.positions.length, record.positions.length);
  record.positions.forEach((src, i) => {
    const dst = out.positions[i];
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'number') near(dst[k], v, Math.abs(v) * 1e-9 + 1e-9);
      else assert.deepStrictEqual(dst[k], v, k);
    }
  });
  return { ledger, out };
}

test('real sample: round trip keeps every field', () => {
  const { out } = assertRoundTrip(SAMPLE);
  near(out.positions_value, SAMPLE.positions_value, 1e-6);
});

test('live Portfolio.json: round trip keeps every field (read-only)', () => {
  const path = 'D:\\cryptomate-local\\data\\entities\\Portfolio.json';
  if (!existsSync(path)) { console.log('        SKIPPED: file not on this machine'); return; }
  for (const record of JSON.parse(readFileSync(path, 'utf8'))) assertRoundTrip(record);
});

test('a second round trip through the record is stable and keeps V6 state', () => {
  let l = adoptLegacyPortfolio(SAMPLE);
  l = applyFill(l, simulateFill({ intent: intent({ strategyId: 's1', symbol: 'SOLUSDT', qty: 1, stopPrice: 90, exitProfile: 'trend' }), bar: bar(100), cost: NO_SLIP, t: T }));
  l = applyFill(l, simulateFill({ intent: intent({ type: 'exit', strategyId: 'legacy', symbol: 'ONDOUSDT', qty: 1000 }), bar: bar(0.4), cost: NO_SLIP, t: T + 1 }));
  const prices = lastPrices(SAMPLE);
  const once = toPortfolioRecord(l, prices);
  const back = adoptLegacyPortfolio(JSON.parse(JSON.stringify(once)));
  const twice = toPortfolioRecord(back, prices);
  assert.deepStrictEqual(twice, once);
  const sol = positionsBySymbol(back).get('SOLUSDT');
  assert.strictEqual(sol.strategyId, 's1');
  assert.strictEqual(sol.stopPrice, 90);
  assert.strictEqual(sol.exitProfile, 'trend');
  near(back.fees, l.fees, 1e-9);
  near(back.capital, l.capital, 1e-6);
  throwsCode(() => applyFill(back, l.lastFill), 'duplicate_fill');
});

test('adopted positions have no stop, and say so', () => {
  const l = adoptLegacyPortfolio(SAMPLE);
  assert.ok(l.positions.every((p) => p.stopPrice === null && p.strategyId === 'legacy' && p.side === 'long'));
  assert.strictEqual(l.adoption.warnings.filter((w) => w.includes('no stop')).length, 5);
});

test('a dashboard edit wins over the V6 block', () => {
  const l = applyFill(createLedger({ cash: 2000, t: T }), buyAt(100, 10, { stopPrice: 90 }));
  const rec = JSON.parse(JSON.stringify(toPortfolioRecord(l, {})));
  rec.positions[0].quantity = 4;
  rec.available_balance += 600;
  const back = adoptLegacyPortfolio(rec);
  assert.strictEqual(back.positions[0].qty, 4);
  assert.strictEqual(back.positions[0].strategyId, 'legacy');
  near(back.positions[0].collateral, 400);
  assert.ok(back.adoption.warnings.some((w) => w.includes('changed outside V6')));
});

test('duplicate symbol spellings merge; zero rows are dropped; a bad balance is refused', () => {
  const rec = { available_balance: 100, positions: [
    { asset_symbol: 'ZECUSDT', quantity: 1, avg_entry_price: 100, fees_paid: 1 },
    { asset_symbol: 'ZEC/USDT', quantity: 3, avg_entry_price: 200 },
    { asset_symbol: 'OLD/USDT', quantity: 0, avg_entry_price: 5 },
  ] };
  const l = adoptLegacyPortfolio(rec);
  assert.strictEqual(l.positions.length, 1);
  near(l.positions[0].entryPrice, 175);
  throwsCode(() => adoptLegacyPortfolio({ available_balance: -1 }), 'bad_legacy_portfolio');
  assert.strictEqual(adoptLegacyPortfolio({ available_balance: 1, positions: [{ asset_symbol: 'X', quantity: -1, avg_entry_price: 1 }] }).quarantined.length, 1);
});

test('marks accept a Map, an object, and either symbol spelling; no price uses the last known', () => {
  const l = adoptLegacyPortfolio({ available_balance: 0, positions: [{ asset_symbol: 'ZEC/USDT', quantity: 2, avg_entry_price: 100, last_known_price: 110 }] });
  assert.strictEqual(ledgerEquity(l, new Map([['ZECUSDT', 120]])).equity, 240);
  assert.strictEqual(ledgerEquity(l, { 'ZEC/USDT': 130 }).equity, 260);
  assert.strictEqual(ledgerEquity(l, new Map()).equity, 220);
  const out = toPortfolioRecord(l, new Map([['ZECUSDT', 120]]));
  assert.strictEqual(out.positions[0].asset_symbol, 'ZEC/USDT');
  assert.strictEqual(out.positions[0].last_known_price, 120);
  assert.strictEqual(out.positions[0].highest_price, 120);
});

test('ledger matches portfolio.js on the same trades', () => {
  const state = createPortfolioState(SAMPLE);
  let l = adoptLegacyPortfolio(SAMPLE);
  const costs = (fillPrice, qty) => ({ fillPrice, fee: fillPrice * qty * 0.001, slippagePercent: 0 });

  applySell(state, { symbol: 'ZECUSDT', quantity: 0.2, costs: costs(1400, 0.2), timestamp: 'x' });
  l = applyFill(l, simulateFill({ intent: intent({ type: 'reduce', symbol: 'ZECUSDT', strategyId: 'legacy', qty: 0.2 }), bar: bar(1400), cost: NO_SLIP, t: T }));
  applyBuy(state, { symbol: 'ZECUSDT', quantity: 0.1, costs: costs(1500, 0.1), timestamp: 'x' });
  l = applyFill(l, simulateFill({ intent: intent({ symbol: 'ZECUSDT', strategyId: 'legacy', qty: 0.1 }), bar: bar(1500), cost: NO_SLIP, t: T + 1 }));
  const rest = state.positions.find((p) => p.asset_symbol === 'ZECUSDT').quantity;
  applySell(state, { symbol: 'ZECUSDT', quantity: rest, costs: costs(1100, rest), timestamp: 'x' });
  l = applyFill(l, simulateFill({ intent: intent({ type: 'exit', symbol: 'ZECUSDT', strategyId: 'legacy', qty: rest }), bar: bar(1100), cost: NO_SLIP, t: T + 2 }));

  near(l.cash, state.available_balance, 1e-8);
  near(l.realized, state.total_profit_loss, 1e-8);
  assert.strictEqual(l.trades, state.total_trades);
  assert.strictEqual(l.positions.length, state.positions.length);
});

test('Trade rows: V6 shape, net and gross P&L, percent slippage', () => {
  let l = createLedger({ cash: 2000, t: T });
  l = applyFill(l, simulateFill({ intent: intent({ reason: 'Trend up', reasonCode: 'ENTRY_TREND' }), bar: bar(100), cost: costFor('SOLUSDT', 3), t: T }));
  const entry = toTradeRecord(l.lastFill);
  assert.strictEqual(entry.exchange, EXCHANGE_LABEL);
  assert.strictEqual(entry.exchange, 'Paper Trading (V6)');
  assert.strictEqual(entry.trade_type, 'buy');
  assert.strictEqual(entry.status, 'completed');
  assert.strictEqual(entry.strategy_id, 's1');
  assert.strictEqual(entry.reason_code, 'ENTRY_TREND');
  assert.strictEqual(entry.exit_reason, null);
  assert.strictEqual(entry.profit_loss, 0);
  near(entry.slippage_percent, 0.25);

  const exit = simulateFill({ intent: intent({ type: 'exit', reason: 'Stop hit', reasonCode: 'STOP' }), bar: bar(120), cost: costFor('SOLUSDT', 3), t: T + 1 });
  throwsCode(() => toTradeRecord(exit), 'unsettled_fill');
  l = applyFill(l, exit);
  const row = toTradeRecord(l.lastFill);
  assert.strictEqual(row.trade_type, 'sell');
  assert.strictEqual(row.exit_reason, 'Stop hit');
  near(row.gross_profit_loss, 10 * (119.7 - 100.25));
  near(row.profit_loss, l.realized);
  near(row.total_value, 1197);
  for (const k of ['asset_symbol', 'trade_type', 'quantity', 'price', 'total_value', 'exchange']) assert.ok(row[k] !== undefined, k);
});

test('a short entry stays out of the dashboard win rate', () => {
  const f = simulateFill({ intent: intent({ side: 'short', symbol: 'BTCUSDT' }), bar: bar(100), cost: perpCost, t: T });
  const row = toTradeRecord(f);
  assert.strictEqual(row.trade_type, 'sell');
  assert.strictEqual(typeof row.profit_loss, 'undefined');
});

console.log('randomised sequences');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32; };
}

/**
 * Tallies money by raw flows, with none of the ledger's averaging, shares or
 * collateral. Once everything is flat the two must agree exactly.
 */
function runSequence(seed, steps = 400) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const start = 10_000 + r() * 90_000;
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'];
  const instrumentOf = { AAAUSDT: 'spot', BBBUSDT: 'spot', CCCUSDT: 'perp', DDDUSDT: 'perp' };
  const prices = Object.fromEntries(symbols.map((s) => [s, 0.001 * 10 ** (r() * 7)]));
  let ledger = deepFreeze(createLedger({ cash: start, t: T }));
  let t = T;
  let flows = 0, feesPaid = 0, fundingPaid = 0, tradePnl = 0, fills = 0;

  const take = (fill) => {
    if (fill.status === 'rejected') return;
    const next = applyFill(ledger, fill);
    const row = toTradeRecord(next.lastFill);
    fills++;
    flows += (fill.action === 'sell' ? 1 : -1) * next.lastFill.qty * fill.price;
    feesPaid += fill.fee;
    tradePnl += row.profit_loss ?? 0;
    ledger = deepFreeze(next);
  };
  const intentFor = (symbol, type, side, qty) => intent({ symbol, type, side, qty, refPrice: prices[symbol], strategyId: 'rand' });
  const priceIt = (i, symbol, stop) => {
    const cost = costFor(symbol, pick([1, 2, 3]), { stress: pick([1, 2]), instrument: instrumentOf[symbol] });
    const p = prices[symbol];
    const mode = r();
    if (mode < 0.5) {
      return simulateFill({ intent: i, bar: { t, o: p, h: p * 1.02, l: p * 0.98, c: p }, cost, t,
        ...(stop ? { isStop: true, stopPrice: p * (i.side === 'long' ? 0.99 : 1.01) } : {}) });
    }
    if (mode < 0.9) {
      const levels = (dir) => Array.from({ length: 8 }, (_, k) => [p * (1 + dir * 0.0005 * (k + 1)), i.qty * (0.05 + r() * 0.4)]);
      return simulateFill({ intent: i, book: { t, bids: levels(-1), asks: levels(1) }, cost, t });
    }
    return simulateFill({ intent: i, book: null, cost, t });
  };

  for (let step = 0; step < steps; step++) {
    t += 3600e3;
    for (const s of symbols) prices[s] *= Math.exp((r() - 0.5) * 0.08);
    const symbol = pick(symbols);
    const open = ledger.positions.find((p) => p.symbol === symbol);
    const action = r();

    if (!open) {
      const side = instrumentOf[symbol] === 'perp' && r() < 0.5 ? 'short' : 'long';
      const budget = ledger.cash * r() * 0.3;
      if (budget > 1) take(priceIt(intentFor(symbol, 'enter', side, budget / (prices[symbol] * 1.02)), symbol));
    } else if (action < 0.25) {
      const budget = ledger.cash * r() * 0.2;
      if (budget > 1) take(priceIt(intentFor(symbol, 'enter', open.side, budget / (prices[symbol] * 1.02)), symbol));
    } else if (action < 0.55) {
      take(priceIt(intentFor(symbol, 'reduce', open.side, open.qty * (0.1 + r() * 0.6)), symbol));
    } else if (action < 0.8) {
      take(priceIt(intentFor(symbol, 'exit', open.side, open.qty), symbol, r() < 0.5));
    } else if (open.instrument === 'perp') {
      const before = ledger.funding;
      ledger = deepFreeze(applyFunding(ledger, { symbol, rate: (r() - 0.4) * 0.002, price: prices[symbol], t }));
      fundingPaid += ledger.funding - before;
    }

    // At every step, with any marks: equity = capital + realised + unrealised net.
    const unrealised = ledger.positions.reduce((s, p) =>
      s + (p.side === 'long' ? 1 : -1) * p.qty * (prices[p.symbol] - p.entryPrice) - p.entryFees - p.fundingAccrued, 0);
    near(ledgerEquity(ledger, prices).equity, ledger.capital + ledger.realized + unrealised, 1e-5);
    assert.ok(ledger.cash >= 0);
    assert.ok(ledger.positions.every((p) => p.qty > 0));
    near(ledger.fees, feesPaid, 1e-6);
  }

  // Flatten. Depth is ample here so the whole size clears.
  for (const p of [...ledger.positions]) {
    t += 1;
    take(simulateFill({ intent: intentFor(p.symbol, 'exit', p.side, p.qty), bar: { t, o: prices[p.symbol] }, cost: costFor(p.symbol, 3, { instrument: p.instrument }), t }));
  }
  assert.strictEqual(ledger.positions.length, 0);
  const independent = start + flows - feesPaid - fundingPaid;
  near(ledger.cash, independent, 1e-5);
  near(ledger.realized, independent - start, 1e-5);
  near(tradePnl, ledger.realized, 1e-5);
  near(ledger.funding, fundingPaid, 1e-7);
  near(ledger.grossRealized - ledger.fees - ledger.funding, ledger.realized, 1e-5);
  return { fills, funding: fundingPaid };
}

test('300 seeded sequences conserve value against an independent cash tally', () => {
  let fills = 0, funded = 0;
  for (let seed = 1; seed <= 300; seed++) {
    try {
      const r = runSequence(seed);
      fills += r.fills;
      if (r.funding !== 0) funded++;
    } catch (e) { e.message = `seed ${seed}: ${e.message}`; throw e; }
  }
  console.log(`        ${fills} fills, ${funded}/300 sequences with funding`);
  assert.ok(fills > 10_000 && funded > 200, 'the sequences must actually exercise the ledger');
});

test('randomised fills are never better than the worse of tier and walk', () => {
  const r = rng(77);
  for (let i = 0; i < 2000; i++) {
    const mid = 10 ** (r() * 4 - 1);
    const tier = 1 + Math.floor(r() * 3);
    const cost = costFor('BTCUSDT', tier);
    const levels = (dir) => Array.from({ length: 6 }, (_, k) => [mid * (1 + dir * 0.0002 * (k + 1 + r())), 0.5 + r() * 3]);
    const book = { t: T, bids: levels(-1), asks: levels(1) };
    const type = r() < 0.5 ? 'enter' : 'exit';
    const f = simulateFill({ intent: intent({ type, qty: 0.1 + r() * 6, refPrice: mid }), book, cost, t: T });
    if (f.status === 'rejected') continue;
    const realMid = (Math.max(...book.bids.map((l) => l[0])) + Math.min(...book.asks.map((l) => l[0]))) / 2;
    if (f.action === 'buy') assert.ok(f.price >= f.bookVwap - 1e-12 && f.price >= realMid * (1 + cost.slipPct / 100) - 1e-12);
    else assert.ok(f.price <= f.bookVwap + 1e-12 && f.price <= realMid * (1 - cost.slipPct / 100) + 1e-12);
  }
});

test('review item 5: a bad row is set aside, reported and kept; the rest stays tradable', () => {
  const bad = { asset_symbol: 'SOL/USDT', quantity: 4.78, avg_entry_price: 0, note: 'keep me' };
  const rec = { available_balance: 500, total_profit_loss: 0, positions: [
    { asset_symbol: 'ETHUSDT', quantity: 2, avg_entry_price: 100, last_known_price: 100 }, bad, null,
    { asset_symbol: 'XRPUSDT', quantity: 1, avg_entry_price: 1, v6: { qty: 1, entryPrice: 1, side: 'short', instrument: 'spot' } },
  ] };
  const l = adoptLegacyPortfolio(rec);
  assert.deepStrictEqual(l.positions.map((p) => p.symbol), ['ETHUSDT']);
  assert.strictEqual(l.quarantined.length, 3);
  assert.strictEqual(l.adoption.warnings.filter((w) => /bad position row set aside/.test(w)).length, 3);
  assert.ok(l.adoption.warnings.some((w) => /^SOL\/USDT/.test(w)));
  near(l.capital, 700);
  const back = toPortfolioRecord(l, new Map(), { now: 1 });
  assert.deepStrictEqual(back.positions.find((p) => p?.asset_symbol === 'SOL/USDT'), bad);
  near(back.total_balance, 700);
  const again = adoptLegacyPortfolio(JSON.parse(JSON.stringify({ ...rec, ...back })));
  assert.strictEqual(again.quarantined.length, 3, 'the row survives every cycle until a human fixes it');
  near(again.capital, 700);
});

test('retest item 3: a set-aside row keeps the value in the engine record, never its own', () => {
  const eth = { asset_symbol: 'ETHUSDT', quantity: 2, avg_entry_price: 100, last_known_price: 100 };
  const good = (symbol, value) => ({ asset_symbol: symbol, quantity: 3, avg_entry_price: 10, current_value: value });
  const broken = (symbol, value) => ({ asset_symbol: symbol, quantity: 3, avg_entry_price: 0, current_value: value, last_known_price: 9 });
  const rec = { available_balance: 500, total_profit_loss: 0, total_balance: 1000,
    positions: [eth, broken('SOLUSDT', 1), broken('ADAUSDT', 5000)],
    v6_state: { record: { positions: [good('SOL/USDT', 200), good('ADAUSDT', 100)] } } };
  const l = adoptLegacyPortfolio(rec);
  assert.deepStrictEqual(quarantineStatus(l), { value: 300, unknown: 0 });
  near(ledgerEquity(l, new Map()).equity, 1000);
  near(l.capital, 1000);
  assert.ok(!l.adoption.warnings.some((w) => /total_balance/.test(w)));
  near(toPortfolioRecord(l, new Map(), { now: 1 }).total_balance, 1000);

  for (const value of [1, 5000]) {
    const noRecord = adoptLegacyPortfolio({ available_balance: 1, positions: [broken('SOLUSDT', value)] });
    assert.deepStrictEqual(quarantineStatus(noRecord), { value: 0, unknown: 1 }, 'its own value is not trusted');
    const sameBadRow = adoptLegacyPortfolio({ available_balance: 1, positions: [broken('SOLUSDT', value)],
      v6_state: { record: { positions: [broken('SOLUSDT', value)] } } });
    assert.deepStrictEqual(quarantineStatus(sameBadRow), { value: 0, unknown: 1 }, 'nor is an unreadable row in the record');
  }
  const blind = adoptLegacyPortfolio({ available_balance: 1, positions: [null] });
  assert.deepStrictEqual(quarantineStatus(blind), { value: 0, unknown: 1 });
  assert.deepStrictEqual(quarantineStatus(createLedger({ cash: 10, t: 1 })), { value: 0, unknown: 0 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
