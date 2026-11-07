/**
 * V6 portfolio simulator: runs v6Core.step over history with one shared cash ledger.
 *
 * Timeline of one bar T, in this order. The order is what keeps it honest:
 *   1. funding due up to the open is charged (perps)
 *   2. intents decided at the PREVIOUS close fill at this bar's open, exits first
 *   3. bar T is appended to the visible history, which only now makes it readable
 *   4. a coin that has stopped printing is delisted: last close minus 10%
 *   5. funding inside the bar is charged
 *   6. v6Core.step decides at T's close. Stops and targets it reports were resting
 *      during the bar, so they fill inside the bar; everything else waits for the
 *      next open, which is step 2 of the next bar
 *   7. equity = cash + positions marked at the close
 *
 * Why lookahead is hard here: ctx.bars arrays are grown one bar at a time, so a
 * strategy holds real arrays that do not contain the future. Built-in indicators are
 * computed once per series, but only through an accessor bounded by those arrays.
 * auditLookahead() re-runs on truncated data, which catches what structure cannot.
 *
 * Pure: bars, costs and funding are arguments. Pass v6Bars.pointInTimeUniverse as
 * universeFn and v6Bars.tierFor as costs.tierFn. Without a tierFn every coin but
 * BTC and ETH is costed as Tier 3, the expensive direction.
 */
import { computeRegime, createIndicatorAccess, entryPositionFields, exitConfigFor, exitRemainderPatch, fullWeightRisk, step } from './v6Core.js';
import * as paper from './v6Paper.js';
import * as realRisk from './v6Risk.js';
import { bootstrapCI, DAY_MS, deflatedSharpe, returnsFromEquity, seededRandom, sharpe, summarize, trialStats } from './v6Stats.js';
import { buyAndHold } from './v6Strategies.js';

const TF_MS = { '1h': 3600000, '4h': 14400000, '1d': DAY_MS };
/** Matches v6Bars: a coin this long past its last bar is dead, not just missing a bar. */
const DELIST_GRACE_MS = 3 * DAY_MS;
const DEFAULT_EQUITY = 10000;
const MIN_FILL_NOTIONAL = 1;

// ---------- market preparation ----------

/**
 * Bars checked, frozen and indexed once, so repeated runs (grids, folds) share the
 * work and the indicator cache. Treat it as read-only.
 */
export class PreparedMarket {
  constructor(series, calendar, byTime, barMs) {
    this.series = series;
    this.calendar = calendar;
    this.byTime = byTime;
    this.barMs = barMs;
    this.universeCache = new Map();
  }
}

/**
 * @param {Map<string, object[]>} bars closed bars per symbol, oldest first. The bar
 *   objects are frozen in place: nothing downstream may alter a bar.
 * @returns {PreparedMarket}
 */
export function prepareMarket(bars) {
  if (bars instanceof PreparedMarket) return bars;
  const series = new Map();
  const times = new Set();
  for (const [symbol, list] of bars) {
    let prev = -Infinity;
    for (const b of list) {
      if (!(b.t > prev)) throw new Error(`${symbol}: bars are not strictly ascending at t=${b.t}`);
      if (![b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)) throw new Error(`${symbol}: bad prices at t=${b.t}`);
      prev = b.t;
      times.add(b.t);
      Object.freeze(b);
    }
    series.set(symbol, { symbol, index: series.size, bars: list, cache: new Map() });
  }
  const calendar = Float64Array.from(times).sort();
  if (calendar.length < 2) throw new Error('Need at least two bars to simulate');
  const gaps = [];
  for (let i = 1; i < Math.min(calendar.length, 200); i++) gaps.push(calendar[i] - calendar[i - 1]);
  const barMs = gaps.sort((a, b) => a - b)[gaps.length >> 1];
  const position = new Map();
  calendar.forEach((t, i) => position.set(t, i));
  const byTime = Array.from({ length: calendar.length }, () => []);
  for (const s of series.values()) for (const b of s.bars) byTime[position.get(b.t)].push(s);
  return new PreparedMarket(series, calendar, byTime, barMs);
}

/** First index with bars[i].t >= t. */
function firstBarAt(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const DEFAULT_SIM_RE_ENABLE = Object.freeze({ afterDays: 30 });
const REGIME_DAYS = 200;

const defaultTier = (symbol) => (/^(BTC|ETH)USDT/.test(symbol) ? 1 : 3);

// ---------- runSim ----------

/**
 * Simulates strategies over [from, to] on one shared account.
 *
 * @param {object} a
 * @param {object[]} a.strategies all on one timeframe
 * @param {Map|PreparedMarket} a.bars include history before `from`: it is the warmup
 * @param {number} [a.from] first bar open time, inclusive
 * @param {number} [a.to] last bar open time, inclusive
 * @param {object} [a.config] { initialEquity, risk, exits, sizeMultipliers, ... }
 * @param {object} [a.costs] { stress, tierFn(symbol, t), funding: Map<symbol, {t, rate, mark}[]> }
 * @param {Function} [a.universeFn] (t, { topN, timeframe }) -> string[]; required for 'top' universes
 * @param {object} [a.modules] { risk, exits } replacements, for benchmarks and tests
 * @param {boolean} [a.closeOut] sell what is still open at the end, with costs (default true)
 * @param {boolean} [a.collectEvents] default true; training runs turn it off for speed
 * @param {{ afterDays: number }|false} [a.simReEnable] a sim has no human to clear the -15%
 *   and -20% rungs, and flat equity never recovers, so this stands in for one: once a rung
 *   has blocked entries for afterDays and the book is flat, it calls humanReEnable. Each
 *   one is listed in summary.reEnables. Manual and fail-safe halts are never cleared.
 *   Simulation only; false reproduces the live rule. Default { afterDays: 30 }.
 * @returns {{ equity: {t, equity, cash, gross, open}[], trades: object[], fills: object[],
 *   events: object[], summary: object, costs: object, ledger: object }}
 *   equity[i].t is the bar's open time and the value is marked at that bar's close.
 *   summary.maxDrawdown comes from the equity curve's all-time high, which a re-enable
 *   does not touch, unlike the risk engine's rebased high.
 *   config.regimeFn({ t, barT, bars, ind, universe, defaultRegime }) replaces the BTC
 *   SMA200 regime for ctx.regime and exits. universe is the union of the strategies'
 *   universes at this bar. It must return a regime, and sees closed bars only.
 */
export function runSim({
  strategies, bars, from = -Infinity, to = Infinity, config = {}, costs = {}, universeFn,
  modules = {}, closeOut = true, collectEvents = true, simReEnable = DEFAULT_SIM_RE_ENABLE,
}) {
  const m = prepareMarket(bars);
  const { barMs, calendar } = m;
  const risk = modules.risk || realRisk;
  const periodsPerYear = Math.round((365 * DAY_MS) / barMs);
  const stress = costs.stress ?? 1;
  const tierFn = costs.tierFn || defaultTier;
  const initialEquity = config.initialEquity ?? DEFAULT_EQUITY;
  // Explicit per strategy: v6Core has no default multiplier, by design.
  const sizeMultipliers = Object.fromEntries(strategies.map((s) => [s.id, config.sizeMultipliers?.[s.id] ?? 1]));
  const stepConfig = { rethrowStrategyErrors: true, ...config, sizeMultipliers };

  const strategyById = new Map();
  for (const s of strategies) {
    if (TF_MS[s.timeframe] !== barMs) throw new Error(`Strategy ${s.id} is ${s.timeframe}, the bars are ${barMs}ms apart`);
    if (s.universe?.kind === 'top' && !universeFn) {
      throw new Error(`Strategy ${s.id} has a 'top' universe but no universeFn was given. Today's list would be survivorship bias.`);
    }
    strategyById.set(s.id, s);
  }

  const first = lowerBound(calendar, from);
  const last = lowerBound(calendar, to + 1) - 1;
  if (last <= first) throw new Error('The from/to range covers fewer than two bars');

  // The history strategies can read: warmup now, then one bar at a time.
  const visible = new Map();
  const shown = new Array(m.series.size);
  const cursor = new Int32Array(m.series.size);
  for (const [symbol, s] of m.series) {
    const n = firstBarAt(s.bars, calendar[first]);
    const list = s.bars.slice(0, n);
    visible.set(symbol, list);
    shown[s.index] = list;
    cursor[s.index] = n;
  }
  /** The bar opening at T, if this symbol has one and it isn't yet visible. */
  const barOpeningAt = (symbol, T) => {
    const s = m.series.get(symbol);
    const b = s?.bars[cursor[s.index]];
    return b && b.t === T ? b : null;
  };
  const ind = createIndicatorAccess(visible, (symbol) => m.series.get(symbol));

  let universeMemo = m.universeCache.get(universeFn);
  if (!universeMemo) m.universeCache.set(universeFn, universeMemo = new Map());
  const timeframe = strategies[0]?.timeframe;
  let decisionT = calendar[first];
  // Nothing decided at the last close can fill, and that close can be the first
  // instant of the locked holdout, so nothing may ask the data store about it.
  let finalBar = false;
  const universeFor = (strategy) => {
    if (strategy.universe.kind === 'fixed') return strategy.universe.symbols;
    if (finalBar) return [];
    const key = `${strategy.universe.n}|${decisionT}`;
    let u = universeMemo.get(key);
    if (!u) universeMemo.set(key, u = universeFn(decisionT, { topN: strategy.universe.n, timeframe }));
    return u;
  };

  const costMemo = new Map();
  const costOf = (symbol, strategy, t) => {
    const instrument = strategy?.perp ? 'perp' : 'spot';
    const tier = tierFn(symbol, t);
    const key = `${symbol}|${tier}|${instrument}`;
    let c = costMemo.get(key);
    if (!c) costMemo.set(key, c = paper.costFor(symbol, tier, { stress, instrument }));
    return c;
  };

  let ledger = paper.createLedger({ cash: initialEquity, t: calendar[first] });
  let riskState = risk.initialRiskState(initialEquity, calendar[first]);
  const events = [], fills = [], trades = [], equity = [];
  const tally = { fees: 0, slippage: 0, stopGap: 0, delistHaircut: 0, funding: 0 };
  const eventCounts = {};
  const openPnl = new Map();
  const fundingCursor = new Map();
  const prices = new Map();
  let pending = [];

  const addEvent = (e) => {
    const key = e.code || e.type;
    eventCounts[key] = (eventCounts[key] || 0) + 1;
    if (collectEvents) events.push(e);
  };
  const positionOf = (symbol) => ledger.positions.find((p) => p.symbol === symbol);

  /** Settles a fill and writes it to the fill and trade records. rawPrice is the price before slippage. */
  function settle(fill, rawPrice, kind) {
    const before = positionOf(fill.symbol);
    ledger = paper.applyFill(ledger, fill);
    const s = ledger.lastFill;
    const slip = Math.abs(s.price - rawPrice) * s.qty;
    tally.fees += s.fee;
    if (kind === 'delist') tally.delistHaircut += slip; else tally.slippage += slip;
    if (kind === 'stop') tally.stopGap += Math.abs(rawPrice - fill.stopPrice) * s.qty;
    fills.push({
      t: s.t, symbol: s.symbol, strategyId: s.strategyId, type: s.type, side: s.side, action: s.action,
      qty: s.qty, price: s.price, rawPrice, fee: s.fee, kind, reasonCode: s.reasonCode,
    });
    if (s.type === 'enter') { openPnl.set(s.symbol, 0); return; }

    const total = openPnl.get(s.symbol) + s.realizedPnl;
    const closed = !positionOf(s.symbol);
    trades.push({
      symbol: s.symbol, strategyId: s.strategyId, side: s.side, qty: s.qty,
      entryTime: before.entryTime, entryPrice: before.entryPrice, exitTime: s.t, exitPrice: s.price,
      pnl: s.realizedPnl, grossPnl: s.grossPnl, fees: s.fee + s.entryFeeShare, funding: s.fundingShare,
      positionPnl: total, rMultiple: before.riskAtEntry > 0 ? total / before.riskAtEntry : null,
      barsHeld: Math.round((s.t - before.entryTime) / barMs), reasonCode: s.reasonCode, reason: s.reason, partial: !closed,
    });
    if (closed) openPnl.delete(s.symbol); else openPnl.set(s.symbol, total);
    const remainder = closed ? null : exitRemainderPatch(s);
    if (remainder) ledger = paper.updatePosition(ledger, s.symbol, remainder);
  }

  function chargeFunding(p, upTo, price) {
    const rows = costs.funding?.get(p.symbol);
    if (!rows) throw new Error(`Perp position in ${p.symbol} but costs.funding has no rows for it`);
    let i = fundingCursor.get(p.symbol);
    if (i === undefined) i = lowerBound(rows.map((r) => r.t), p.entryTime + 1);
    while (i < rows.length && rows[i].t <= upTo) {
      const row = rows[i++];
      const before = ledger.funding;
      ledger = paper.applyFunding(ledger, { symbol: p.symbol, rate: row.rate, price: row.mark > 0 ? row.mark : price, t: row.t });
      tally.funding += ledger.funding - before;
    }
    fundingCursor.set(p.symbol, i);
  }
  const chargeAllFunding = (upTo, priceOf) => {
    for (const p of ledger.positions) if (p.instrument === 'perp') chargeFunding(p, upTo, priceOf(p));
  };

  function fillAtOpen(intent, bar, t) {
    const strategy = strategyById.get(intent.strategyId);
    const cost = costOf(intent.symbol, strategy, t);
    if (intent.type === 'enter') {
      let fill = paper.simulateFill({ intent, bar, cost, t });
      // Sized at the close, filled at the open: an upward gap can outrun the cash.
      const need = fill.notional + fill.fee;
      if (need > ledger.cash) {
        const qty = intent.qty * (ledger.cash / need) * (1 - 1e-12);
        if (qty * fill.price < MIN_FILL_NOTIONAL) {
          addEvent({ t, type: 'entry_unfilled', code: 'no_cash', symbol: intent.symbol, message: 'No cash at the fill' });
          return;
        }
        fill = paper.simulateFill({ intent: { ...intent, qty }, bar, cost, t });
      }
      fill.positionFields = entryPositionFields({
        intent, fill, cost, modules, exitConfig: exitConfigFor(strategy, config, { barMs }),
      });
      fundingCursor.delete(intent.symbol);
      settle(fill, bar.o, 'open');
      return;
    }
    const p = positionOf(intent.symbol);
    if (!p) return;
    const qty = intent.type === 'exit' ? p.qty : Math.min(intent.qty, p.qty);
    settle(paper.simulateFill({ intent: { ...intent, qty }, bar, cost, t }), bar.o, 'open');
  }

  function fillInBar(intent, T, decisionTime) {
    const p = positionOf(intent.symbol);
    if (!p) return;
    const strategy = strategyById.get(intent.strategyId);
    const cost = costOf(intent.symbol, strategy, decisionTime);
    const qty = intent.type === 'exit' ? p.qty : Math.min(intent.qty, p.qty);
    const sized = { ...intent, qty };
    if (intent.fill.mode === 'stop') {
      settle(paper.simulateFill({ intent: sized, bar: intent.fill.bar, cost, isStop: true, stopPrice: intent.fill.stopPrice, t: T }), intent.fill.price, 'stop');
    } else {
      // A target fills at its own price, never better, even on a gap through it.
      settle(paper.simulateFill({ intent: sized, bar: { ...intent.fill.bar, o: intent.fill.price }, cost, t: T }), intent.fill.price, 'target');
    }
  }

  const reEnables = [];
  const regimeBars = Math.round((REGIME_DAYS * DAY_MS) / barMs);
  let blockedSince = null, peak = initialEquity, peakSeen = 0;

  const market = {
    bars: visible, prices, barMs, periodsPerYear, ind, universeFor, health: { ok: true }, isNewBar: true,
    barT: null, regime: null, costFor: null,
  };

  for (let k = first; k <= last; k++) {
    const T = calendar[k];
    const tClose = T + barMs;

    // 1-2. The open.
    chargeAllFunding(T, (p) => barOpeningAt(p.symbol, T)?.o ?? p.lastPrice);
    const carried = [];
    for (const intent of pending) {
      const bar = barOpeningAt(intent.symbol, T);
      if (bar) fillAtOpen(intent, bar, T);
      else if (intent.type === 'enter') addEvent({ t: T, type: 'entry_unfilled', code: 'no_bar', symbol: intent.symbol, message: 'No bar at the fill' });
      else carried.push(intent);
    }
    pending = carried;

    // 3. The bar closes and becomes readable.
    prices.clear();
    for (const s of m.byTime[k]) {
      const vis = shown[s.index];
      const n = cursor[s.index];
      if (vis.length !== n) throw new Error(`The bars array for ${s.symbol} was altered during the run. Strategies must not mutate ctx.bars.`);
      vis.push(s.bars[n]);
      cursor[s.index] = n + 1;
      prices.set(s.symbol, s.bars[n].c);
    }

    // 4. Delisting. Noticed only after the grace period has passed, using nothing
    // but the absence of bars so far, so it cannot leak a death before it happened.
    for (const p of [...ledger.positions]) {
      const vis = visible.get(p.symbol);
      const lastBar = vis[vis.length - 1];
      if (lastBar.t === T) continue;
      if (T - (lastBar.t + barMs) <= DELIST_GRACE_MS) continue;
      const intent = { type: 'exit', symbol: p.symbol, strategyId: p.strategyId, side: p.side, qty: p.qty, reason: 'Coin delisted', reasonCode: 'delisted', refPrice: lastBar.c };
      const cost = costOf(p.symbol, strategyById.get(p.strategyId), T);
      settle(paper.simulateFill({ intent, bar: lastBar, cost, isDelist: true, t: T }), lastBar.c, 'delist');
      pending = pending.filter((x) => x.symbol !== p.symbol);
      addEvent({ t: T, type: 'alarm', code: 'delisted', symbol: p.symbol, message: `${p.symbol} stopped trading; sold at last close minus the haircut.` });
    }

    // 5-6. The close.
    chargeAllFunding(tClose - 1, (p) => prices.get(p.symbol) ?? p.lastPrice);
    finalBar = k === last;
    const costT = finalBar ? T : tClose;
    decisionT = tClose;
    market.barT = T;
    for (const s of strategies) s.atBar?.(T);
    const defaultRegime = computeRegime(ind, config.btcSymbol || 'BTCUSDT', regimeBars, visible);
    market.regime = defaultRegime;
    if (config.regimeFn) {
      const universe = [...new Set(strategies.flatMap((s) => universeFor(s)))];
      market.regime = config.regimeFn({ t: tClose, barT: T, bars: visible, ind, universe, defaultRegime });
      if (market.regime === undefined || market.regime === null) throw new Error('config.regimeFn must return a regime; use { label: \'unknown\' } when there is none');
    }
    market.costFor = (symbol, strategy) => costOf(symbol, strategy, costT);
    const out = step({
      t: tClose, account: { cash: ledger.cash }, positions: paper.positionsBySymbol(ledger), market,
      strategies, config: stepConfig, riskState, modules,
    });
    riskState = out.riskState;
    for (const e of out.events) addEvent(e);
    for (const { symbol, patch } of out.updates) if (positionOf(symbol)) ledger = paper.updatePosition(ledger, symbol, patch);
    if (k < last) {
      for (const intent of out.intents) {
        if (intent.fill.mode === 'market') pending.push(intent); else fillInBar(intent, T, costT);
      }
      // Exits fill before entries at the open, so the cash they free is there to spend.
      pending.sort((a, b) => (a.type === 'enter') - (b.type === 'enter'));
    } else {
      for (const intent of out.intents) if (intent.fill.mode !== 'market') fillInBar(intent, T, costT);
    }

    // 7. Mark.
    const mark = paper.ledgerEquity(ledger, prices);
    equity.push({ t: T, equity: mark.equity, cash: mark.cash, gross: mark.positionsValue, open: ledger.positions.length });

    // 8. Track a rung that blocks entries. The stand-in human acts after the mark, so
    // the first new entry is decided on the next bar.
    if (!(riskState.rung >= 3)) blockedSince = null;
    else {
      blockedSince ??= tClose;
      if (simReEnable && risk.humanReEnable && !ledger.positions.length && !pending.length
        && tClose - blockedSince >= simReEnable.afterDays * DAY_MS) {
        const rung = riskState.rung;
        const cleared = risk.humanReEnable(riskState, { t: tClose, equity: mark.equity, by: 'sim', confirm: true });
        if (!cleared.ok) throw new Error(`simReEnable refused: ${cleared.reason}`);
        riskState = cleared.riskState;
        blockedSince = null;
        while (peakSeen < equity.length) peak = Math.max(peak, equity[peakSeen++].equity);
        reEnables.push({ t: tClose, rung, equity: mark.equity, drawdownFromPeak: 1 - mark.equity / peak });
        addEvent({ t: tClose, type: 'sim_re_enable', code: 'sim_re_enable', severity: 'warning', message: `Simulated human re-enable from rung ${rung}` });
      }
    }
  }

  // Liquidation value at the end, with exit costs, so an open winner is not free profit.
  const leftOpen = ledger.positions.length;
  if (closeOut && leftOpen) {
    const T = calendar[last];
    for (const p of [...ledger.positions]) {
      const vis = visible.get(p.symbol);
      const c = vis[vis.length - 1].c;
      const intent = { type: 'exit', symbol: p.symbol, strategyId: p.strategyId, side: p.side, qty: p.qty, reason: 'End of simulation', reasonCode: 'end_of_sim', refPrice: c };
      const cost = costOf(p.symbol, strategyById.get(p.strategyId), T);
      settle(paper.simulateFill({ intent, bar: { t: T, o: c, h: c, l: c, c }, cost, t: T + barMs }), c, 'close_out');
    }
    const point = equity[equity.length - 1];
    point.equity = ledger.cash;
    point.cash = ledger.cash;
    point.gross = 0;
    point.open = 0;
  }

  const summary = summarize(equity, trades, { periodsPerYear });
  const closedByRegime = trades.filter((t) => t.reasonCode === 'regime_exit');
  let exposure = 0;
  for (const e of equity) exposure += e.equity > 0 ? e.gross / e.equity : 0;
  Object.assign(summary, {
    positionChanges: fills.length,
    exposure: exposure / equity.length,
    feesPaid: tally.fees,
    halted: risk.riskDirectives(riskState).flatten === true,
    eventCounts,
    finalRung: riskState.rung ?? null,
    // A run ending here is not trading, whether or not it is formally halted.
    stuckAtEnd: blockedSince === null ? null : {
      rung: riskState.rung, name: realRisk.LADDER_RUNGS[riskState.rung].name, since: blockedSince,
      days: (calendar[last] + barMs - blockedSince) / DAY_MS,
    },
    reEnables,
    simReEnables: reEnables.length,
    regimeExits: closedByRegime.length,
    regimeExitPnl: closedByRegime.reduce((total, t) => total + t.pnl, 0),
  });
  return { equity, trades, fills, events, summary, costs: { ...tally, stress }, ledger, riskState };
}

// ---------- lookahead audit ----------

const fillKey = (f) => `${f.t}|${f.symbol}|${f.type}|${f.qty}|${f.price}`;

/**
 * Proves a strategy's history does not depend on its future. Re-runs it with the bars
 * cut off at several dates; every fill and equity point up to each cut must match the
 * full run exactly. Run it on every candidate: it catches what the structure cannot,
 * such as a strategy closing over the full bars or a universeFn that peeks.
 * @returns {{ ok: boolean, cuts: { cut: number, ok: boolean, detail: string|null }[] }}
 */
export function auditLookahead({ strategy, rebuild, bars, from, to, cuts = 5, seed = 1, ...rest }) {
  const m = prepareMarket(bars);
  const args = { from, closeOut: false, collectEvents: false, ...rest };
  const build = (data) => [rebuild ? rebuild(data) : strategy];
  const whole = new Map([...m.series].map(([symbol, s]) => [symbol, s.bars]));
  const full = runSim({ ...args, strategies: build(whole), bars: m, to });
  const rand = seededRandom(seed);
  const n = full.equity.length;
  const out = [];
  for (let i = 0; i < cuts; i++) {
    const at = 2 + Math.floor((0.1 + 0.8 * ((i + rand()) / cuts)) * (n - 3));
    const cut = full.equity[at].t;
    const truncated = new Map();
    for (const [symbol, s] of m.series) {
      const end = firstBarAt(s.bars, cut + 1);
      if (end) truncated.set(symbol, s.bars.slice(0, end));
    }
    const part = runSim({ ...args, strategies: build(truncated), bars: truncated, to: cut });
    let detail = null;
    const expected = full.fills.filter((f) => f.t <= cut);
    if (part.fills.length !== expected.length) detail = `${part.fills.length} fills up to the cut, the full run has ${expected.length}`;
    for (let j = 0; !detail && j < expected.length; j++) {
      if (fillKey(part.fills[j]) !== fillKey(expected[j])) detail = `fill ${j} differs: ${fillKey(part.fills[j])} vs ${fillKey(expected[j])}`;
    }
    for (let j = 0; !detail && j < part.equity.length; j++) {
      if (part.equity[j].equity !== full.equity[j].equity) detail = `equity differs at t=${part.equity[j].t}`;
    }
    out.push({ cut, ok: !detail, detail });
  }
  return { ok: out.every((c) => c.ok), cuts: out };
}

// ---------- walk-forward ----------

/** Every combination of a grid, in a fixed order. An empty grid gives one empty set. */
export function gridCombos(grid = {}) {
  let combos = [{}];
  for (const [key, values] of Object.entries(grid)) {
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
  }
  return combos;
}

const paramsKey = (grid, params) => Object.keys(grid).map((k) => `${k}=${params[k]}`).join(',');

/** What a fold switch can change. Anything else must be the same for every grid point. */
const PER_FOLD_FIELDS = new Set(['params', 'signals', 'universe', 'warmupBars', 'exitOverrides', 'grid', 'name']);

/** The switcher runs one strategy, so a grid cannot vary a field it has no way to switch. */
function assertSwitchable(strategies) {
  const [first] = strategies;
  for (const s of strategies) {
    for (const key of new Set([...Object.keys(first), ...Object.keys(s)])) {
      if (PER_FOLD_FIELDS.has(key)) continue;
      if (JSON.stringify(s[key]) !== JSON.stringify(first[key]) || (typeof s[key] === 'function' && s[key] !== first[key])) {
        throw new Error(`walkForward cannot honour a grid that changes strategy.${key} (${first[key]} vs ${s[key]}). Run each value as its own walkForward.`);
      }
    }
  }
}

/**
 * One strategy that switches parameters at fold boundaries, so positions carry across
 * them. runSim calls atBar before each step, so universe and warmup are the fold's own.
 */
function scheduledStrategy(segments, base) {
  const starts = segments.map((s) => s.from);
  let current = segments[0].strategy;
  return {
    ...base,
    atBar(barT) {
      const i = lowerBound(starts, barT + 1) - 1;
      current = i >= 0 ? segments[i].strategy : null;
    },
    get universe() { return (current ?? base).universe; },
    get warmupBars() { return (current ?? base).warmupBars; },
    get exitOverrides() { return current?.exitOverrides; },
    signals(ctx) {
      return current ? current.signals({ ...ctx, params: current.params }) : [];
    },
  };
}

/**
 * Walk-forward test. For each fold the parameters are chosen on the train window
 * alone, and traded on the test window that follows. The out-of-sample result is ONE
 * continuous run across all test windows, not separate runs glued together, so a
 * position held across a boundary pays no made-up round trip.
 *
 * @param {object} a
 * @param {(params: object) => object} a.strategyFactory
 * @param {object} a.grid { param: [values] }
 * @param {Map|PreparedMarket} a.bars
 * @param {number} a.trainDays
 * @param {number} a.testDays
 * @param {number} [a.from] start of the first train window
 * @param {number} [a.to]
 * @param {boolean} [a.anchored] train windows all start at `from` (default: rolling)
 * @param {string} [a.objective] summary field to maximise on train (default 'sharpe')
 * @param {number} [a.minTrainTrades] parameter sets with fewer closed trades can't be picked
 * @param {boolean} [a.extras] also run 2x costs, the benchmark and fixed-parameter
 *   trials, which checkDevCriteria needs (default true)
 * @param {{ afterDays: number }|false} [a.simReEnable] see runSim
 * @returns {{ oos, picks, summary, trials, plateau, stress2x, benchmark, combos, strategy }}
 *   Log every entry of `trials`: each is one parameter set evaluated.
 */
export function walkForward({
  strategyFactory, grid = {}, bars, trainDays, testDays, from, to, anchored = false, objective = 'sharpe',
  minTrainTrades = 0, extras = true, config = {}, costs = {}, universeFn, modules = {}, simReEnable,
}) {
  if (!(trainDays > 0 && testDays > 0)) throw new Error('walkForward needs trainDays and testDays');
  const m = prepareMarket(bars);
  const start = Math.max(from ?? -Infinity, m.calendar[0]);
  const end = Math.min(to ?? Infinity, m.calendar[m.calendar.length - 1]);
  const combos = gridCombos(grid);
  assertSwitchable(combos.map(strategyFactory));
  const shared = { bars: m, config, costs, universeFn, modules, simReEnable };

  const picks = [];
  for (let testFrom = start + trainDays * DAY_MS; testFrom <= end; testFrom += testDays * DAY_MS) {
    const trainFrom = anchored ? start : testFrom - trainDays * DAY_MS;
    const trainTo = testFrom - 1;
    let best = null, bestScore = -Infinity;
    for (const params of combos) {
      const { summary } = runSim({ ...shared, strategies: [strategyFactory(params)], from: trainFrom, to: trainTo, collectEvents: false });
      const score = summary.closedTrades >= minTrainTrades ? summary[objective] : -Infinity;
      if (score > bestScore) { best = params; bestScore = score; }
    }
    picks.push({
      trainFrom, trainTo, testFrom, testTo: Math.min(testFrom + testDays * DAY_MS - 1, end),
      params: best, trainScore: Number.isFinite(bestScore) ? bestScore : null,
    });
  }
  if (!picks.length) throw new Error('The span is shorter than one train window');

  const oosFrom = picks[0].testFrom;
  const base = strategyFactory(picks.find((p) => p.params)?.params ?? combos[0]);
  // A fold where nothing qualified sits in cash.
  const scheduled = scheduledStrategy(picks.map((p) => ({ from: p.testFrom, strategy: p.params ? strategyFactory(p.params) : null })), base);
  const oos = runSim({ ...shared, strategies: [scheduled], from: oosFrom, to: end });

  const result = {
    oos, picks, summary: oos.summary, combos: combos.length, strategy: { id: base.id, version: base.version, timeframe: base.timeframe, slowAllocator: base.slowAllocator === true },
    span: { from: oosFrom, to: end }, trials: [], plateau: null, stress2x: null, benchmark: null,
  };
  if (!extras) return result;

  result.stress2x = runSim({ ...shared, strategies: [scheduled], from: oosFrom, to: end, collectEvents: false, costs: { ...costs, stress: 2 * (costs.stress ?? 1) } });

  // Fixed parameters over the whole OOS span. Never used to pick anything: they feed
  // the trial log and the plateau test.
  result.trials = combos.map((params) => {
    const { summary: s } = runSim({ ...shared, strategies: [strategyFactory(params)], from: oosFrom, to: end, collectEvents: false });
    return {
      params, sharpe: s.sharpe, periodsPerYear: s.periodsPerYear, nObs: s.periods, closedTrades: s.closedTrades,
      maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn, calmar: s.calmar,
      simReEnables: s.simReEnables, regimeExits: s.regimeExits,
    };
  });
  result.plateau = plateauOf(grid, picks, result.trials);
  result.benchmark = benchmarkRun({ base, m, oosFrom, end, costs, universeFn, config });
  return result;
}

/** Equal-weight buy-and-hold of the strategy's universe as it stood on the first day. */
function benchmarkRun({ base, m, oosFrom, end, costs, universeFn, config }) {
  const k = lowerBound(m.calendar, oosFrom);
  const listed = (s) => (m.series.get(s)?.bars ?? []).some((b) => b.t <= m.calendar[k]);
  const list = base.universe.kind === 'fixed' ? base.universe.symbols : universeFn(m.calendar[k], { topN: base.universe.n, timeframe: base.timeframe });
  const symbols = list.filter(listed);
  if (!symbols.length) return null;
  const run = runSim({
    strategies: [buyAndHold({ symbols, timeframe: base.timeframe })], bars: m, from: oosFrom, to: end, config, costs,
    modules: { risk: fullWeightRisk({ weight: 1 / symbols.length }) }, collectEvents: false,
  });
  // With a universe in the grid this is the first pick's universe, so say which it was.
  return { ...run, symbols, universe: base.universe };
}

/** D6 on the most-picked parameters: every neighbour within one grid step, diagonals included. */
function plateauOf(grid, picks, trials) {
  const keys = Object.keys(grid);
  const counts = new Map();
  for (const p of picks) {
    if (!p.params) continue;
    const key = paramsKey(grid, p.params);
    counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, params: p.params });
  }
  let center = null;
  for (const c of counts.values()) if (!center || c.n >= center.n) center = c;
  if (!center) return null;
  const pos = (params) => keys.map((k) => grid[k].indexOf(params[k]));
  const c = pos(center.params);
  const self = trials.find((tr) => paramsKey(grid, tr.params) === paramsKey(grid, center.params));
  const neighbours = trials.filter((tr) => {
    const d = pos(tr.params).map((x, i) => Math.abs(x - c[i]));
    return Math.max(0, ...d) === 1;
  });
  return { params: center.params, sharpe: self.sharpe, neighbours: neighbours.map((n) => ({ params: n.params, sharpe: n.sharpe })) };
}

// ---------- criteria ----------

/**
 * Applies the frozen DEV criteria D1-D8 to a walkForward result (extras on).
 * Anything that can't be measured FAILS, with the reason in `detail`.
 *
 * @param {object} result from walkForward
 * @param {object} ctx
 * @param {number} [ctx.trialCount] GLOBAL trial count across all agents
 * @param {number} [ctx.trialSRVariance] PER-PERIOD variance of trial Sharpes
 * @param {object[]} [ctx.trials] raw trial lines from every agent, in place of the two above
 * @param {boolean} [ctx.slowAllocator] D4 counts position-changes
 * @param {number} [ctx.seed] bootstrap seed
 * @returns {{ pass: boolean, criteria: object, report: string }}
 */
export function checkDevCriteria(result, ctx = {}) {
  const s = result.oos.summary;
  const rets = returnsFromEquity(result.oos.equity);
  const ppy = s.periodsPerYear;
  const row = (pass, value, threshold, detail = '') => ({ pass: Boolean(pass), value, threshold, detail });
  const fixed = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : String(x));

  const ci = bootstrapCI(rets, (r) => sharpe(r, ppy), { n: ctx.bootstrapN ?? 2000, blockLen: ctx.blockLen ?? 20, alpha: 0.10, seed: ctx.seed ?? 1 });

  const global = ctx.trials ? trialStats(ctx.trials, ppy) : ctx;
  const { trialCount, trialSRVariance } = global;
  let d2;
  if (!(trialCount >= 1)) d2 = row(false, null, '>= 0.90', 'global trial count not supplied');
  else if (trialCount > 1 && !(trialSRVariance > 0)) d2 = row(false, null, '>= 0.90', 'trial Sharpe variance not supplied');
  else {
    const dsr = deflatedSharpe(rets, trialCount, trialSRVariance);
    d2 = row(dsr >= 0.90, fixed(dsr, 3), '>= 0.90', `${trialCount} trials`);
  }

  const slow = ctx.slowAllocator ?? result.strategy?.slowAllocator;
  const d4value = slow ? s.positionChanges : s.closedTrades;
  const d4need = slow ? 30 : 100;

  const stressed = result.stress2x?.summary;
  const p = result.plateau;
  let d6;
  if (!p) d6 = row(false, null, 'neighbours >= 50%', 'no plateau data: walkForward ran without extras, or nothing was picked');
  else if (!p.neighbours.length) d6 = row(false, null, 'neighbours >= 50%', 'no grid neighbours, so a plateau cannot be shown');
  else {
    const floor = 0.5 * p.sharpe;
    const worst = Math.min(...p.neighbours.map((n) => n.sharpe));
    d6 = row(p.sharpe > 0 && worst >= floor, `worst ${fixed(worst)} vs chosen ${fixed(p.sharpe)}`, 'neighbours >= 50%', `${p.neighbours.length} neighbours of ${JSON.stringify(p.params)}`);
  }

  const profitable = s.profit > 0;
  const bench = result.benchmark?.summary;
  const criteria = {
    D1: row(s.sharpe >= 0.8 && ci.lo > 0, `Sharpe ${fixed(s.sharpe)}, 90% CI [${fixed(ci.lo)}, ${fixed(ci.hi)}]`, '>= 0.80 and CI low > 0'),
    D2: d2,
    D3: row(s.maxDrawdown <= 0.30, pct(s.maxDrawdown), '<= 30%', s.simReEnables ? `from the all-time high, across ${s.simReEnables} simulated re-enables` : ''),
    D4: row(d4value >= d4need, d4value, `>= ${d4need} ${slow ? 'position-changes' : 'closed trades'}`),
    D5: stressed ? row(stressed.totalReturn > 0, pct(stressed.totalReturn), '> 0 at 2x costs') : row(false, null, '> 0 at 2x costs', 'no 2x costs run'),
    D6: d6,
    D7: row(profitable && s.topCoinShare <= 0.35 && s.topYearShare <= 0.60,
      profitable ? `${s.topCoin} ${pct(s.topCoinShare)}, ${s.topYear} ${pct(s.topYearShare)}` : 'no profit',
      'coin <= 35%, year <= 60%'),
    D8: bench
      ? row(s.calmar > bench.calmar || s.sharpe > bench.sharpe,
        `Calmar ${fixed(s.calmar)} vs ${fixed(bench.calmar)}, Sharpe ${fixed(s.sharpe)} vs ${fixed(bench.sharpe)}`, 'better Calmar or Sharpe')
      : row(false, null, 'better Calmar or Sharpe', 'no benchmark run'),
  };
  const pass = Object.values(criteria).every((c) => c.pass);
  const lines = Object.entries(criteria).map(([id, c]) =>
    `  ${id} ${c.pass ? 'PASS' : 'FAIL'}  ${c.value ?? 'n/a'}  (need ${c.threshold})${c.detail ? `  ${c.detail}` : ''}`);
  const report = [
    `DEV criteria: ${pass ? 'ALL PASS' : 'NOT QUALIFIED'} (net of costs; a pass is evidence, never a promise of winning trades)`,
    ...lines,
    `  Simulated re-enables: ${s.simReEnables ?? 'n/a'}. Regime exits: ${s.regimeExits ?? 'n/a'}, P&L ${fixed(s.regimeExitPnl)}.`,
    ...(s.stuckAtEnd ? [`  STUCK at the end: rung ${s.stuckAtEnd.name} for ${s.stuckAtEnd.days.toFixed(0)} days.`] : []),
  ].join('\n');
  // Set only by scripts/v6/rerun-registered.mjs, which redoes D2 once every trial is known.
  globalThis.__v6CriteriaSink?.({ rets, periodsPerYear: ppy, pass, criteria, summary: s, strategy: result.strategy, trials: result.trials ?? [], picks: result.picks?.map((p) => p.params) ?? [] });
  return { pass, criteria, report };
}

/** One line for data/research/v6/trials-<agent>.jsonl. Log every trial, failures included. */
export function trialRecord({ agent, family, strategyId, timeframe, trial, note, ts }) {
  return {
    ts, agent, family, strategyId, timeframe, params: trial.params, sharpe: trial.sharpe,
    periodsPerYear: trial.periodsPerYear, nObs: trial.nObs, closedTrades: trial.closedTrades,
    maxDrawdown: trial.maxDrawdown, totalReturn: trial.totalReturn, simReEnables: trial.simReEnables, regimeExits: trial.regimeExits, note: note ?? null,
  };
}
