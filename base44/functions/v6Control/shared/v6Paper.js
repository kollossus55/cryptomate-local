// GENERATED FILE — DO NOT EDIT.
// Copied from /shared/trading by scripts/sync-shared.mjs.
// Edit the source in /shared/trading and re-run: npm run sync:functions
/**
 * V6 paper fills and ledger. Pure: no clock, no I/O, no exchange access.
 * Paper only. Nothing here can place an order.
 *
 * Units, because this repo has been bitten by them (see costs.js):
 *   feePct / slipPct / stopSlipPct are PERCENT numbers, as in the contract table:
 *   0.10 means 0.10%. Funding `rate` is a FRACTION, as exchanges publish it.
 *
 * Accounting identity, re-checked on every update:
 *   cash + SUM(collateral) + SUM(entryFees) + SUM(fundingAccrued) = capital + realized
 * Entry fees and funding sit on the open position and reach `realized` pro rata
 * as it closes. That is how portfolio.js treats fees, so `realized` keeps the
 * meaning of the legacy total_profit_loss, and the Trade rows sum to it exactly.
 *
 * Positions are fully collateralised: a perp locks its whole notional (the
 * contract caps gross exposure at 100%), so a 1x perp long behaves as a spot long
 * plus funding. Shorts exist on perps only.
 */

export const EXCHANGE_LABEL = 'Paper Trading (V6)';
export const STOP_EXTRA_SLIP_PCT = 0.10;
export const DELIST_HAIRCUT_PCT = 10;
export const PERP_FEE_PCT = 0.05;
export const DEFAULT_MAX_BOOK_AGE_MS = 30_000;

const SPOT_FEE_PCT = 0.10;
const TIER_SLIP_PCT = { 1: 0.03, 2: 0.08, 3: 0.25 };
const FILL_ID_MEMORY = 256;
const DUST = 1e-9; // relative qty tolerance
const LEGACY_STRATEGY_ID = 'legacy';

/** Ledger state would be corrupted, or already is. `code` is machine readable. */
export class LedgerInvariantError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'LedgerInvariantError';
    this.code = code;
    this.details = details;
  }
}

/** A caller handed simulateFill or costFor something that cannot be priced honestly. */
export class PaperInputError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PaperInputError';
    this.code = code;
  }
}

const isPos = (n) => Number.isFinite(n) && n > 0;
const compact = (s) => String(s ?? '').replace(/[/\-_]/g, '').toUpperCase();
const dirOf = (side) => (side === 'short' ? -1 : 1);
const isoOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * Contract cost table. `stress` multiplies fee, slippage and the stop slip, so
 * stress: 2 is the D5 "2x costs" test. It may not go below 1: paper never gets
 * cheaper than the table. An unknown tier is costed as tier 3, and tier 1 is only
 * honoured for BTC and ETH, because the contract defines it by name.
 *
 * @param {string} symbol
 * @param {1|2|3} tier
 * @param {{stress?: number, instrument?: 'spot'|'perp'}} [opts]
 * @returns {{feePct: number, slipPct: number, stopSlipPct: number, instrument: string, tier: number}}
 */
export function costFor(symbol, tier, { stress = 1, instrument = 'spot' } = {}) {
  if (!Number.isFinite(stress) || stress < 1) {
    throw new PaperInputError('bad_stress', `stress must be a number >= 1, got ${stress}`);
  }
  if (instrument !== 'spot' && instrument !== 'perp') {
    throw new PaperInputError('bad_instrument', `unknown instrument ${instrument}`);
  }
  const major = /^(BTC|ETH)([/\-_:]|USDT|USDC|USD|$)/.test(String(symbol ?? '').toUpperCase());
  let effective = TIER_SLIP_PCT[tier] === undefined ? 3 : tier;
  if (effective === 1 && !major) effective = 2;
  return {
    feePct: (instrument === 'perp' ? PERP_FEE_PCT : SPOT_FEE_PCT) * stress,
    slipPct: TIER_SLIP_PCT[effective] * stress,
    stopSlipPct: STOP_EXTRA_SLIP_PCT * stress,
    instrument,
    tier: effective,
  };
}

/**
 * Fractions passed as percents would under-charge 100x without any visible
 * failure. Nothing in the cost table is below 0.01%, so a smaller non-zero value
 * can only be that mistake.
 */
function readCost(cost) {
  if (!cost) throw new PaperInputError('missing_cost', 'simulateFill needs a cost from costFor()');
  const { feePct, slipPct, stopSlipPct = STOP_EXTRA_SLIP_PCT } = cost;
  for (const [name, v] of Object.entries({ feePct, slipPct, stopSlipPct })) {
    if (!Number.isFinite(v) || v < 0) throw new PaperInputError('bad_cost', `${name} is ${v}`);
    if (v > 0 && v < 0.01) {
      throw new PaperInputError('cost_units', `${name} ${v} looks like a fraction; costs are percents (0.10 = 0.10%)`);
    }
  }
  return { feePct, slipPct, stopSlipPct, instrument: cost.instrument ?? 'spot' };
}

/**
 * The same cost in v6Risk's units. v6Risk reads every *Pct as a FRACTION, so a
 * costFor result handed to sizeEntry directly would read 0.10% as 10%.
 */
export function toRiskCosts(cost) {
  const { feePct, slipPct, stopSlipPct } = readCost(cost);
  return { feePct: feePct / 100, slipPct: slipPct / 100, stopSlipPct: stopSlipPct / 100 };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** Clean one side of a book: numeric, positive, best price first. */
function readLevels(levels, bestFirst) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l) => (Array.isArray(l) ? [Number(l[0]), Number(l[1])] : [Number(l?.price), Number(l?.qty)]))
    .filter(([p, q]) => isPos(p) && isPos(q))
    .sort((a, b) => (a[0] - b[0]) * bestFirst);
}

function readBook(book, t, maxAgeMs) {
  if (!book) return { unavailable: 'no_book' };
  const asks = readLevels(book.asks, 1);
  const bids = readLevels(book.bids, -1);
  if (!asks.length || !bids.length) return { unavailable: 'empty_book' };
  if (bids[0][0] >= asks[0][0]) return { unavailable: 'crossed_book' };
  // hub.book sets `stale` itself: venues with no timestamp report t as the fetch time.
  if (book.stale === true || (Number.isFinite(book.t) && t - book.t > maxAgeMs)) return { unavailable: 'stale_book' };
  return { asks, bids, mid: (asks[0][0] + bids[0][0]) / 2 };
}

/**
 * Consume levels best-first for a BASE quantity. costs.js has a quote-denominated
 * walker, but V6 intents carry base qty, and converting through a guessed price
 * would change the size being tested.
 */
export function walkBook(levels, qty) {
  let remaining = qty;
  let quote = 0;
  for (const [price, available] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, available);
    quote += take * price;
    remaining -= take;
  }
  if (remaining <= qty * DUST) remaining = 0;
  const filledQty = qty - remaining;
  return { filledQty, quote, vwap: filledQty > 0 ? quote / filledQty : null, shortfallQty: remaining };
}

const ENTRY_FIELDS = ['stopPrice', 'initialStopPrice', 'exitProfile', 'exitPlan', 'riskAtEntry'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * Price an intent. Two modes:
 *
 * BAR (simulator): pass `bar`, the bar AFTER the decision. Market fills take its
 * open plus tier slippage. Stops take the worse of stop price and open, plus tier
 * slippage plus the stop slip. `isDelist` is the last close minus 10%.
 *
 * BOOK (live paper): pass `book` as { bids, asks, t? }, levels as [price, qty] or
 * { price, qty }. The fill is the volume-weighted walk for the size, but never
 * better than mid plus tier slippage: a snapshot understates a real order, which
 * arrives later, and the contract says every result is net of the table. The raw
 * walk stays on the Fill (bookVwap) so real costs can still be measured.
 * Stops also get the worse-of rule against the stop price, plus the stop slip.
 *
 * Depth short of the size: entries are REJECTED whole. Exits and reduces fill
 * what is visible, status 'partial', because exits are never blocked and a price
 * for depth nobody can see would be invented. The rest stays open at risk for the
 * next step. A missing, empty, crossed or stale book falls back to intent.refPrice
 * plus tier slippage, with method 'tier_fallback'.
 *
 * `intent.side` is the POSITION side ('long'|'short'), on exits too.
 *
 * @returns Fill { id, t, symbol, strategyId, type, side, action, instrument, status,
 *   requestedQty, qty, price, notional, fee, feePct, slipPct, method, slipSource, isStop,
 *   basePrice, refPrice, bookVwap, shortfallQty, flags, reason, reasonCode, rejectReason, ... }
 *   slipPct here is the REALISED adverse move from the intended price.
 */
export function simulateFill({
  intent, bar = null, book = null, cost, isStop = false, stopPrice = null,
  isDelist = false, t: tArg, maxBookAgeMs = DEFAULT_MAX_BOOK_AGE_MS,
}) {
  if (!intent) throw new PaperInputError('missing_intent', 'no intent');
  const { type, side, symbol, qty } = intent;
  if (!['enter', 'exit', 'reduce'].includes(type)) throw new PaperInputError('bad_intent', `type ${type}`);
  if (side !== 'long' && side !== 'short') {
    throw new PaperInputError('bad_intent', `side must be the position side, long or short, got ${side}`);
  }
  if (!symbol) throw new PaperInputError('bad_intent', 'no symbol');
  if (!isPos(qty)) throw new PaperInputError('bad_intent', `qty ${qty}`);
  if (bar && book) throw new PaperInputError('ambiguous_mode', 'pass bar or book, not both');
  if ((isStop || isDelist) && type === 'enter') throw new PaperInputError('bad_intent', 'an entry cannot be a stop or delist fill');
  if (isStop && !isPos(stopPrice)) throw new PaperInputError('bad_stop', `stopPrice ${stopPrice}`);
  if (isDelist && !bar) throw new PaperInputError('bad_intent', 'a delist exit needs the last bar');
  const c = readCost(cost);

  const t = tArg ?? intent.t ?? bar?.t ?? book?.t;
  if (!Number.isFinite(t)) throw new PaperInputError('missing_time', 'no timestamp from t, intent, bar or book');

  const action = (type === 'enter') === (side === 'long') ? 'buy' : 'sell';
  const worse = (a, b) => (action === 'buy' ? Math.max(a, b) : Math.min(a, b));
  const adverse = (p, pct) => (action === 'buy' ? p * (1 + pct / 100) : p * (1 - pct / 100));
  const stopSlip = isStop ? c.stopSlipPct : 0;
  const flags = [];

  const common = {
    t, symbol, type, side, action, instrument: c.instrument,
    strategyId: intent.strategyId ?? null,
    requestedQty: qty,
    feePct: c.feePct,
    isStop,
    stopPrice: isStop ? stopPrice : null,
    refPrice: intent.refPrice ?? null,
    reason: intent.reason ?? null,
    reasonCode: intent.reasonCode ?? null,
    flags,
    // Carried to the position so an entry is born with its exit plan.
    positionFields: type === 'enter' ? pick(intent, ENTRY_FIELDS) : undefined,
  };

  const finish = ({ price, intended, method, slipSource = 'tier', filledQty = qty, extra = {} }) => {
    const notional = filledQty * price;
    return {
      ...common,
      id: intent.id ?? `${symbol}|${t}|${type}|${action}|${filledQty}|${price}`,
      status: filledQty < qty ? 'partial' : 'filled',
      qty: filledQty,
      price,
      notional,
      fee: notional * c.feePct / 100,
      slipPct: (action === 'buy' ? price - intended : intended - price) / intended * 100,
      basePrice: intended,
      method,
      slipSource,
      ...extra,
    };
  };

  if (bar) {
    if (!isPos(bar.o)) throw new PaperInputError('bad_bar', `open ${bar.o}`);
    if (isDelist) {
      if (!isPos(bar.c)) throw new PaperInputError('bad_bar', `close ${bar.c}`);
      flags.push('delisted');
      return finish({ price: adverse(bar.c, DELIST_HAIRCUT_PCT), intended: bar.c, method: 'bar_delist', slipSource: 'delist' });
    }
    if (!isStop) return finish({ price: adverse(bar.o, c.slipPct), intended: bar.o, method: 'bar' });

    if (worse(bar.o, stopPrice) === bar.o && bar.o !== stopPrice) flags.push('gap_through_stop');
    const extreme = action === 'sell' ? bar.l : bar.h;
    if (Number.isFinite(extreme) && worse(extreme, stopPrice) === stopPrice && extreme !== stopPrice) {
      flags.push('stop_not_touched');
    }
    return finish({
      price: adverse(worse(stopPrice, bar.o), c.slipPct + stopSlip),
      intended: stopPrice,
      method: 'bar',
    });
  }

  const parsed = readBook(book, t, maxBookAgeMs);

  if (parsed.unavailable) {
    const ref = intent.refPrice;
    if (!isPos(ref)) throw new PaperInputError('no_price', `no usable book (${parsed.unavailable}) and refPrice is ${ref}`);
    flags.push(`book_unavailable:${parsed.unavailable}`);
    return finish({
      price: adverse(isStop ? worse(stopPrice, ref) : ref, c.slipPct + stopSlip),
      intended: isStop ? stopPrice : ref,
      method: 'tier_fallback',
    });
  }

  const walk = walkBook(action === 'buy' ? parsed.asks : parsed.bids, qty);

  if (walk.shortfallQty > 0) {
    flags.push('insufficient_depth');
    if (type === 'enter') {
      return {
        ...common,
        id: intent.id ?? `${symbol}|${t}|${type}|rejected`,
        status: 'rejected', rejectReason: 'insufficient_depth',
        qty: 0, price: null, notional: 0, fee: 0, slipPct: null,
        basePrice: parsed.mid, method: 'book', slipSource: 'book',
        bookVwap: walk.vwap, bookMid: parsed.mid, availableQty: walk.filledQty, shortfallQty: walk.shortfallQty,
      };
    }
  }

  const base = worse(walk.vwap, adverse(parsed.mid, c.slipPct));
  return finish({
    price: isStop ? adverse(worse(base, stopPrice), stopSlip) : base,
    intended: isStop ? stopPrice : parsed.mid,
    method: 'book',
    slipSource: base === walk.vwap ? 'book' : 'tier_floor',
    filledQty: walk.filledQty,
    extra: { bookVwap: walk.vwap, bookMid: parsed.mid, shortfallQty: walk.shortfallQty },
  });
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** A fresh ledger holding `cash`. */
export function createLedger({ cash, t = null }) {
  if (!Number.isFinite(cash) || cash < 0) throw new LedgerInvariantError('bad_cash', `cash ${cash}`);
  return {
    cash, positions: [], realized: 0, fees: 0,
    capital: cash, grossRealized: 0, funding: 0, trades: 0,
    recentFillIds: [], lastFill: null, lastT: t,
  };
}

const findIndex = (ledger, symbol) => {
  const key = compact(symbol);
  return ledger.positions.findIndex((p) => compact(p.symbol) === key);
};

/** Map<symbol, Position>, the form v6Core and strategy contexts use. */
export function positionsBySymbol(ledger) {
  return new Map(ledger.positions.map((p) => [p.symbol, p]));
}

/**
 * Rows set aside at adoption: `value` stays in equity, so that setting a row aside is not
 * a loss. `unknown` counts rows with no trusted value; while it is above zero equity
 * cannot be trusted, and v6Risk freezes the ladder.
 */
export function quarantineStatus(ledger) {
  return ledger.quarantine ?? { value: 0, unknown: 0 };
}

/** What is wrong with one position as [code, message, details], or null. */
function positionFault(p) {
  if (!isPos(p.qty)) return ['bad_qty', `${p.symbol} qty ${p.qty}`, { symbol: p.symbol }];
  if (!isPos(p.entryPrice)) return ['bad_entry_price', `${p.symbol} entry ${p.entryPrice}`];
  if (p.side === 'short' && p.instrument !== 'perp') return ['spot_short', p.symbol];
  if (!Number.isFinite(p.entryFees) || p.entryFees < 0) return ['bad_entry_fees', `${p.symbol} ${p.entryFees}`];
  if (!Number.isFinite(p.collateral) || !Number.isFinite(p.fundingAccrued)) {
    return ['non_finite', `${p.symbol} collateral or funding`];
  }
  return null;
}

/**
 * Verify every ledger invariant. Called on the way in and the way out of each
 * update, so a ledger corrupted elsewhere is caught instead of built on.
 */
export function assertLedger(ledger) {
  const breach = (code, msg, details) => { throw new LedgerInvariantError(code, msg, details); };
  if (!ledger || !Array.isArray(ledger.positions)) breach('bad_ledger', 'not a ledger');
  for (const k of ['cash', 'realized', 'fees', 'capital', 'grossRealized', 'funding']) {
    if (!Number.isFinite(ledger[k])) breach('non_finite', `${k} is ${ledger[k]}`, { field: k });
  }
  if (ledger.cash < 0) breach('negative_cash', `cash ${ledger.cash}`, { cash: ledger.cash });

  let collateral = 0, openFees = 0, openFunding = 0;
  let scale = Math.abs(ledger.capital) + Math.abs(ledger.cash);
  const seen = new Set();
  for (const p of ledger.positions) {
    const key = compact(p.symbol);
    if (seen.has(key)) breach('duplicate_position', p.symbol);
    seen.add(key);
    const fault = positionFault(p);
    if (fault) breach(...fault);
    collateral += p.collateral;
    openFees += p.entryFees;
    openFunding += p.fundingAccrued;
    scale += Math.abs(p.collateral);
  }

  const tol = 1e-7 + 1e-10 * scale;
  const conservation = ledger.cash + collateral + quarantineStatus(ledger).value + openFees + openFunding
    - (ledger.capital + ledger.realized);
  if (!(Math.abs(conservation) <= tol)) breach('value_not_conserved', `off by ${conservation}`, { conservation });
  if (ledger.fees < openFees - tol) breach('fee_mismatch', `fees ${ledger.fees} below open entry fees ${openFees}`);
  const reconciled = ledger.grossRealized - (ledger.fees - openFees) - (ledger.funding - openFunding);
  if (!(Math.abs(reconciled - ledger.realized) <= tol)) {
    breach('pnl_mismatch', `realized ${ledger.realized}, components say ${reconciled}`, { reconciled });
  }
  return ledger;
}

function assertFill(fill) {
  const bad = (msg) => { throw new LedgerInvariantError('bad_fill', msg, { fill }); };
  if (!fill || !fill.id) bad('fill has no id, so it cannot be applied exactly once');
  if (!['enter', 'exit', 'reduce'].includes(fill.type)) bad(`type ${fill.type}`);
  if (fill.side !== 'long' && fill.side !== 'short') bad(`side ${fill.side}`);
  if (!isPos(fill.qty)) bad(`qty ${fill.qty}`);
  if (!isPos(fill.price)) bad(`price ${fill.price}`);
  if (!Number.isFinite(fill.fee) || fill.fee < 0) bad(`fee ${fill.fee}`);
  if (!Number.isFinite(fill.t)) bad(`t ${fill.t}`);
  const expected = (fill.type === 'enter') === (fill.side === 'long') ? 'buy' : 'sell';
  if (fill.action !== expected) bad(`action ${fill.action} on a ${fill.type} of a ${fill.side}`);
}

/** Cash may land a rounding error below zero on an all-in entry. */
const settleCash = (cash) => (cash < 0 && cash > -1e-9 ? 0 : cash);

function enterPosition(ledger, fill) {
  const instrument = fill.instrument ?? 'spot';
  if (fill.side === 'short' && instrument !== 'perp') {
    throw new LedgerInvariantError('spot_short', `${fill.symbol}: shorts exist on perps only`);
  }
  const index = findIndex(ledger, fill.symbol);
  const existing = index === -1 ? null : ledger.positions[index];
  if (existing) {
    if (existing.side !== fill.side) {
      throw new LedgerInvariantError('implicit_flip', `${fill.symbol} is ${existing.side}; exit before entering ${fill.side}`);
    }
    if (existing.strategyId !== fill.strategyId) {
      throw new LedgerInvariantError('strategy_mismatch', `${fill.symbol} belongs to ${existing.strategyId}, not ${fill.strategyId}`);
    }
    if (existing.instrument !== instrument) {
      throw new LedgerInvariantError('instrument_mismatch', `${fill.symbol} is ${existing.instrument}`);
    }
  }
  const notional = fill.qty * fill.price;
  const cash = settleCash(ledger.cash - notional - fill.fee);
  if (cash < 0) {
    throw new LedgerInvariantError('insufficient_cash', `${fill.symbol} needs ${notional + fill.fee}, has ${ledger.cash}`, { cash: ledger.cash });
  }

  const position = existing
    ? {
      ...existing,
      qty: existing.qty + fill.qty,
      entryPrice: (existing.qty * existing.entryPrice + notional) / (existing.qty + fill.qty),
      entryFees: existing.entryFees + fill.fee,
      collateral: existing.collateral + notional,
      addCount: existing.addCount + 1,
      lastPrice: fill.price,
    }
    : {
      symbol: fill.symbol, strategyId: fill.strategyId, side: fill.side, instrument,
      qty: fill.qty, entryPrice: fill.price, entryTime: fill.t, entryFees: fill.fee,
      stopPrice: null, initialStopPrice: null, highWater: fill.price, lowWater: fill.price,
      partialsTaken: [], exitProfile: null, exitPlan: null, barsHeld: 0, riskAtEntry: null,
      ...fill.positionFields,
      collateral: notional, fundingAccrued: 0, lastFundingT: null, addCount: 0, lastPrice: fill.price,
    };

  return {
    cash,
    positions: existing ? ledger.positions.with(index, position) : [...ledger.positions, position],
    realized: ledger.realized,
    grossRealized: ledger.grossRealized,
    settled: { ...fill, grossPnl: 0, realizedPnl: 0, entryFeeShare: 0, fundingShare: 0, settled: true },
  };
}

function exitPosition(ledger, fill) {
  const index = findIndex(ledger, fill.symbol);
  if (index === -1) throw new LedgerInvariantError('no_position', `${fill.symbol} is not open`);
  const pos = ledger.positions[index];
  if (pos.side !== fill.side) {
    throw new LedgerInvariantError('side_mismatch', `${fill.symbol} is ${pos.side}, fill closes ${fill.side}`);
  }
  if (fill.qty > pos.qty * (1 + DUST)) {
    throw new LedgerInvariantError('overclose', `${fill.symbol} closing ${fill.qty} of ${pos.qty}`, { qty: pos.qty });
  }

  const closesAll = fill.qty >= pos.qty * (1 - DUST);
  const qty = closesAll ? pos.qty : fill.qty;
  const fraction = closesAll ? 1 : qty / pos.qty;
  const entryFeeShare = pos.entryFees * fraction;
  const fundingShare = pos.fundingAccrued * fraction;
  const collateralShare = pos.collateral * fraction;
  const grossPnl = dirOf(pos.side) * qty * (fill.price - pos.entryPrice);
  const realizedPnl = grossPnl - entryFeeShare - fundingShare - fill.fee;

  const cash = settleCash(ledger.cash + collateralShare + grossPnl - fill.fee);
  if (cash < 0) {
    throw new LedgerInvariantError('negative_cash', `${fill.symbol} close leaves cash ${cash}: the account is bankrupt`, { cash });
  }

  const remaining = {
    ...pos,
    qty: pos.qty - qty,
    entryFees: pos.entryFees - entryFeeShare,
    fundingAccrued: pos.fundingAccrued - fundingShare,
    collateral: pos.collateral - collateralShare,
    lastPrice: fill.price,
  };
  return {
    cash,
    positions: closesAll ? ledger.positions.toSpliced(index, 1) : ledger.positions.with(index, remaining),
    realized: ledger.realized + realizedPnl,
    grossRealized: ledger.grossRealized + grossPnl,
    settled: { ...fill, qty, notional: qty * fill.price, grossPnl, realizedPnl, entryFeeShare, fundingShare, settled: true },
  };
}

/**
 * Apply one Fill and return a NEW ledger. The input is never mutated.
 * A rejected fill returns the same ledger. Throws LedgerInvariantError rather
 * than return a corrupt state; a duplicate fill id is a breach, which is what
 * stops a retried run charging fees twice.
 *
 * `ledger.lastFill` is the settled fill (grossPnl, realizedPnl, ...): pass that to
 * toTradeRecord.
 */
export function applyFill(ledger, fill) {
  assertLedger(ledger);
  if (fill?.status === 'rejected') return ledger;
  assertFill(fill);
  if (ledger.recentFillIds.includes(fill.id)) {
    throw new LedgerInvariantError('duplicate_fill', `${fill.id} was already applied`, { id: fill.id });
  }
  const { settled, ...moved } = fill.type === 'enter' ? enterPosition(ledger, fill) : exitPosition(ledger, fill);
  return assertLedger({
    ...ledger,
    ...moved,
    fees: ledger.fees + fill.fee,
    trades: ledger.trades + 1,
    recentFillIds: [...ledger.recentFillIds, fill.id].slice(-FILL_ID_MEMORY),
    lastFill: settled,
    lastT: fill.t,
  });
}

/**
 * Accrue one funding payment on a perp. Positive rate: longs pay, shorts receive.
 * Paid from cash; if cash is short, the rest comes out of the position's own
 * collateral, as an exchange margin account would.
 *
 * @param {{symbol: string, rate: number, price: number, t: number}} event
 *   rate is a FRACTION per interval, price the mark at the funding time.
 */
export function applyFunding(ledger, { symbol, rate, price, t }) {
  assertLedger(ledger);
  const index = findIndex(ledger, symbol);
  if (index === -1) throw new LedgerInvariantError('no_position', `${symbol} is not open`);
  const pos = ledger.positions[index];
  if (pos.instrument !== 'perp') throw new LedgerInvariantError('funding_on_spot', symbol);
  if (!Number.isFinite(rate) || !isPos(price) || !Number.isFinite(t)) {
    throw new LedgerInvariantError('bad_funding', `rate ${rate} price ${price} t ${t}`);
  }
  if (pos.lastFundingT !== null && t <= pos.lastFundingT) {
    throw new LedgerInvariantError('duplicate_funding', `${symbol} already accrued up to ${pos.lastFundingT}`);
  }

  const payment = dirOf(pos.side) * pos.qty * price * rate;
  const fromCash = payment > 0 ? Math.min(payment, ledger.cash) : payment;
  const fromCollateral = payment - fromCash;
  if (fromCollateral > pos.collateral) {
    throw new LedgerInvariantError('negative_cash', `${symbol} funding ${payment} exceeds cash and collateral`);
  }
  return assertLedger({
    ...ledger,
    cash: ledger.cash - fromCash,
    funding: ledger.funding + payment,
    lastT: t,
    positions: ledger.positions.with(index, {
      ...pos,
      collateral: pos.collateral - fromCollateral,
      fundingAccrued: pos.fundingAccrued + payment,
      lastFundingT: t,
    }),
  });
}

const ACCOUNTING_FIELDS = new Set(['symbol', 'side', 'instrument', 'strategyId', 'qty', 'entryPrice', 'entryTime',
  'entryFees', 'collateral', 'fundingAccrued', 'lastFundingT']);

/**
 * Change a position's non-accounting fields: stops, water marks, exit plan,
 * barsHeld and so on. Money only moves through fills and funding.
 */
export function updatePosition(ledger, symbol, patch) {
  const index = findIndex(ledger, symbol);
  if (index === -1) throw new LedgerInvariantError('no_position', `${symbol} is not open`);
  const forbidden = Object.keys(patch).filter((k) => ACCOUNTING_FIELDS.has(k));
  if (forbidden.length) throw new LedgerInvariantError('accounting_field', `cannot patch ${forbidden.join(', ')}`);
  return { ...ledger, positions: ledger.positions.with(index, { ...ledger.positions[index], ...patch }) };
}

/** Prices may be a Map or a plain object, keyed ZECUSDT or ZEC/USDT. */
function priceFor(prices, position) {
  const base = compact(position.symbol);
  const keys = [position.symbol, position.legacy?.asset_symbol, base, base.replace(/USDT$/, '/USDT')];
  for (const key of keys) {
    const p = prices instanceof Map ? prices.get(key) : prices?.[key];
    if (isPos(p)) return p;
  }
  return position.lastPrice ?? position.entryPrice;
}

const positionValue = (p, mark) => p.collateral + dirOf(p.side) * p.qty * (mark - p.entryPrice);

/** Mark-to-market. Derived, never accumulated. */
export function ledgerEquity(ledger, prices) {
  let positionsValue = quarantineStatus(ledger).value;
  for (const p of ledger.positions) positionsValue += positionValue(p, priceFor(prices, p));
  return { cash: ledger.cash, positionsValue, equity: ledger.cash + positionsValue };
}

// ---------------------------------------------------------------------------
// Legacy Portfolio and Trade entities
// ---------------------------------------------------------------------------

const MAPPED_LEGACY_FIELDS = new Set(['quantity', 'avg_entry_price', 'current_value', 'fees_paid', 'profit_loss',
  'highest_price', 'last_known_price', 'opened_at', 'dca_count', 'trailing_stop_price', 'v6']);

function adoptPosition(p, warnings) {
  const qty = p.quantity;
  const entryPrice = p.avg_entry_price;
  const entryFees = p.fees_paid || 0;
  if (!isPos(qty) || !isPos(entryPrice)) {
    throw new LedgerInvariantError('bad_legacy_position', `${p.asset_symbol} qty ${qty} entry ${entryPrice}`);
  }
  const legacy = Object.fromEntries(Object.entries(p).filter(([k]) => !MAPPED_LEGACY_FIELDS.has(k)));
  const stopPrice = isPos(p.trailing_stop_price) ? p.trailing_stop_price : null;
  const lastPrice = isPos(p.last_known_price) ? p.last_known_price : entryPrice;
  const openedAt = Date.parse(p.opened_at);
  const base = {
    symbol: compact(p.asset_symbol), strategyId: LEGACY_STRATEGY_ID, side: 'long', instrument: 'spot',
    qty, entryPrice, entryTime: Number.isFinite(openedAt) ? openedAt : null, entryFees,
    stopPrice, initialStopPrice: stopPrice,
    highWater: Math.max(p.highest_price || 0, entryPrice), lowWater: Math.min(lastPrice, entryPrice),
    partialsTaken: [], exitProfile: null, exitPlan: null, barsHeld: 0, riskAtEntry: null,
    collateral: qty * entryPrice, fundingAccrued: 0, lastFundingT: null,
    addCount: p.dca_count || 0, lastPrice, legacy,
  };

  // Our own round-trip block. The legacy fields stay authoritative: the dashboard
  // can close or edit a position, and then the block no longer describes it.
  let position = base;
  if (p.v6) {
    const stale = Math.abs(p.v6.qty - qty) > qty * DUST || Math.abs(p.v6.entryPrice - entryPrice) > entryPrice * DUST;
    if (stale) warnings.push(`${p.asset_symbol}: changed outside V6, its V6 fields were dropped`);
    else position = { ...base, ...p.v6, qty, entryPrice, entryFees, lastPrice, legacy };
  }
  if (position.stopPrice === null) warnings.push(`${p.asset_symbol}: no stop, needs an exit plan`);
  return position;
}

function mergeAdopted(a, b, warnings) {
  warnings.push(`${a.symbol}: duplicate legacy rows merged`);
  const qty = a.qty + b.qty;
  return {
    ...a, qty,
    entryPrice: (a.qty * a.entryPrice + b.qty * b.entryPrice) / qty,
    entryFees: a.entryFees + b.entryFees,
    collateral: a.collateral + b.collateral,
    highWater: Math.max(a.highWater, b.highWater),
    lowWater: Math.min(a.lowWater, b.lowWater),
  };
}

/**
 * One position row that cannot be read must not stop the rest from exiting. It leaves
 * the tradable book and stays on the record for a human; see quarantineStatus for its value.
 */
function adoptRow(row, warnings) {
  let fault;
  try {
    const p = adoptPosition(row, warnings);
    fault = positionFault(p);
    if (!fault) return p;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    fault = [err.code ?? 'bad_legacy_position', err.message];
  }
  warnings.push(`${row?.asset_symbol}: bad position row set aside (${fault[1]}). It will not exit until fixed`);
  return null;
}

/**
 * The last value of a set-aside row. Nothing stored on an unreadable row can be trusted,
 * its own value included, so only a readable row in the engine's own record counts.
 */
function lastTrustedValue(record, row) {
  const own = record.v6_state?.record?.positions;
  if (!row?.asset_symbol || !Array.isArray(own)) return null;
  const last = own.find((p) => p?.asset_symbol && compact(p.asset_symbol) === compact(row.asset_symbol));
  return last && adoptRow(last, []) && isPos(last.current_value) ? last.current_value : null;
}

/**
 * Portfolio entity -> V6 ledger.
 *
 * `capital` is solved from the accounting identity, since the entity does not
 * store it. On a clean record it comes out as the starting balance. Fees and
 * funding paid before adoption are not recoverable, so `fees` starts at the open
 * entry fees and `grossRealized` starts at the legacy net figure.
 *
 * Adopted positions carry strategyId 'legacy', and stopPrice null unless the record
 * had a trailing stop. The contract wants a stop on everything, so the worker must
 * give them one through updatePosition. ledger.adoption.warnings lists what it found.
 * Unreadable rows go to ledger.quarantined, and toPortfolioRecord writes them back as they came.
 */
export function adoptLegacyPortfolio(record, { t = null } = {}) {
  const cash = record?.available_balance;
  if (!Number.isFinite(cash) || cash < 0) {
    throw new LedgerInvariantError('bad_legacy_portfolio', `available_balance ${cash}`);
  }
  const warnings = [];
  const bySymbol = new Map();
  const quarantined = [];
  for (const row of record.positions ?? []) {
    if (row && !row.quantity) { warnings.push(`${row.asset_symbol}: zero-quantity row dropped`); continue; }
    const p = adoptRow(row, warnings);
    if (!p) { quarantined.push(row); continue; }
    const key = compact(p.symbol);
    bySymbol.set(key, bySymbol.has(key) ? mergeAdopted(bySymbol.get(key), p, warnings) : p);
  }
  const positions = [...bySymbol.values()];
  const quarantine = { value: 0, unknown: 0 };
  for (const row of quarantined) {
    const value = lastTrustedValue(record, row);
    if (value === null) quarantine.unknown += 1; else quarantine.value += value;
  }

  const sum = (f) => positions.reduce((s, p) => s + f(p), 0);
  const openFees = sum((p) => p.entryFees);
  const openFunding = sum((p) => p.fundingAccrued);
  const saved = record.v6_ledger ?? {};
  const realized = record.total_profit_loss || 0;
  const fees = Math.max(saved.fees ?? 0, openFees);
  const funding = saved.funding ?? openFunding;
  const capital = cash + sum((p) => p.collateral) + quarantine.value + openFees + openFunding - realized;

  if (Number.isFinite(saved.capital) && Math.abs(saved.capital - capital) > 1e-6) {
    warnings.push(`capital moved from ${saved.capital} to ${capital}: the record changed outside V6`);
  }
  const marked = sum((p) => positionValue(p, p.lastPrice)) + quarantine.value;
  if (Number.isFinite(record.total_balance) && Math.abs(record.total_balance - cash - marked) > 0.01) {
    warnings.push(`total_balance ${record.total_balance} disagrees with cash + positions ${cash + marked}`);
  }

  return assertLedger({
    cash, positions, realized, fees, capital,
    grossRealized: realized + (fees - openFees) + (funding - openFunding),
    funding,
    trades: record.total_trades || 0,
    recentFillIds: saved.recentFillIds ?? [],
    lastFill: null,
    lastT: t ?? saved.lastT ?? (Date.parse(record.last_updated) || null),
    portfolioId: record.id ?? null,
    quarantined,
    quarantine,
    adoption: { warnings },
  });
}

const round8 = (n) => Math.round(n * 1e8) / 1e8;

/**
 * Ledger -> Portfolio update payload, same shape as toPersistablePortfolio.
 *
 * total_profit_loss stays what the dashboards have always been given: cumulative
 * REALISED P&L net of fees, with unrealised excluded. position.profit_loss stays
 * unrealised net of entry fees. Check on the live record:
 * start + total_profit_loss + SUM(position.profit_loss) = total_balance.
 * Do not "fix" it to equity minus start.
 *
 * V6-only state rides along in position.v6 and v6_ledger, which the UI ignores.
 *
 * @param {Map|Object} prices marks; a missing symbol uses the last known price
 * @param {{now?: number}} [opts] clock for last_updated, else the last ledger event
 */
export function toPortfolioRecord(ledger, prices, { now } = {}) {
  const positions = ledger.positions.map((p) => {
    const mark = priceFor(prices, p);
    const { legacy, ...v6 } = p;
    return {
      breakeven_activated: false,
      partial_profits_taken: [],
      ...legacy,
      asset_symbol: legacy?.asset_symbol ?? p.symbol,
      quantity: p.qty,
      avg_entry_price: p.entryPrice,
      current_value: positionValue(p, mark),
      fees_paid: p.entryFees,
      profit_loss: dirOf(p.side) * p.qty * (mark - p.entryPrice) - p.entryFees - p.fundingAccrued,
      highest_price: Math.max(p.highWater ?? 0, mark),
      last_known_price: mark,
      opened_at: isoOf(p.entryTime),
      dca_count: p.addCount ?? 0,
      trailing_stop_price: p.stopPrice ?? null,
      v6: { ...v6, lastPrice: mark },
    };
  });
  const { cash, positionsValue, equity } = ledgerEquity(ledger, prices);
  return {
    available_balance: round8(cash),
    total_balance: round8(equity),
    positions_value: round8(positionsValue),
    positions: [...positions, ...(ledger.quarantined ?? [])],
    total_trades: ledger.trades,
    total_profit_loss: round8(ledger.realized),
    last_updated: isoOf(now ?? ledger.lastT),
    v6_ledger: {
      capital: ledger.capital, fees: ledger.fees, funding: ledger.funding,
      recentFillIds: ledger.recentFillIds, lastT: ledger.lastT,
    },
  };
}

/**
 * Settled fill (ledger.lastFill) -> Trade entity row.
 *
 * A raw exit fill does not know its P&L, so it is refused rather than written
 * as a zero-P&L trade. PortfolioCard's win rate counts every 'sell' row with a
 * numeric profit_loss, so a short ENTRY leaves profit_loss unset: it is a sell
 * that closed nothing. A long entry keeps the 0 the V5 worker writes.
 */
export function toTradeRecord(fill) {
  if (fill?.status === 'rejected') {
    throw new LedgerInvariantError('bad_fill', 'a rejected fill is not a trade');
  }
  const entering = fill?.type === 'enter';
  if (!entering && !fill?.settled) {
    throw new LedgerInvariantError('unsettled_fill', 'pass ledger.lastFill, which carries the realised P&L');
  }
  const record = {
    asset_symbol: fill.symbol,
    trade_type: fill.action,
    quantity: fill.qty,
    price: fill.price,
    total_value: fill.qty * fill.price,
    fee: fill.fee,
    slippage_percent: fill.slipPct,
    exchange: EXCHANGE_LABEL,
    status: 'completed',
    strategy_id: fill.strategyId,
    reason_code: fill.reasonCode,
    exit_reason: entering ? null : fill.reason,
    fill_method: fill.method,
    timestamp: isoOf(fill.t),
    ai_signal: { reasoning: fill.reason, indicators: [`V6 ${fill.strategyId}`] },
  };
  if (!entering) {
    record.profit_loss = fill.realizedPnl;
    record.gross_profit_loss = fill.grossPnl;
  } else if (fill.side === 'long') {
    record.profit_loss = 0;
  }
  return record;
}
