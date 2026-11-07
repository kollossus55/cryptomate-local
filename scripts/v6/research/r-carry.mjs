#!/usr/bin/env node
/**
 * r-carry: delta-neutral funding carry, and funding as a crowding signal.
 *
 *   node scripts/v6/research/r-carry.mjs selftest   synthetic checks of the pair simulator
 *   node scripts/v6/research/r-carry.mjs carry      walk-forward grid, all universes
 *   node scripts/v6/research/r-carry.mjs robust <top10|top20|majors> <entryApr> <lookbackDays>
 *   node scripts/v6/research/r-carry.mjs events     crowding event study
 *   node scripts/v6/research/r-carry.mjs overlay    crowding overlay through real runSim
 *   node scripts/v6/research/r-carry.mjs diag       checks on logged parameters, adds no trials
 *
 * IMPORTANT: Family A (the pair) does NOT run through v6Core or runSim. v6Core refuses
 * shorts (short_not_supported), so `runPaired` below is a separate simulator with its own
 * accounting. It reuses v6Stats, v6Risk (state, gates, sizing), v6Paper.costFor and
 * checkDevCriteria, and follows v6Sim's bar order, but it is NOT the live decision path, and
 * so breaks the contract's "same code path" rule until the pair is built into v6Core.
 * Family B (overlay) is long-only and does run through runSim and walkForward.
 *
 * Bar order in runPaired, matching core-sim.md:
 *   funding up to the open -> queued fills at the open (exits first) -> dead-coin check ->
 *   liquidation on the bar's perp high -> in-bar funding -> mark at close ->
 *   risk update -> exits -> entries (filled at the next open).
 *
 * All prices inside are in SPOT units: perp prices are divided by the contract multiplier.
 * Funding: rate > 0 pays the short. Marks missing from the store use that day's perp open.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSymbols, loadBars, pointInTimeUniverse, tierFor } from '../../../shared/trading/v6Bars.js';
import { fullWeightRisk } from '../../../shared/trading/v6Core.js';
import { loadFunding, loadPerpBars, perpToSpot } from '../../../shared/trading/v6Derivs.js';
import { costFor } from '../../../shared/trading/v6Paper.js';
import { DEFAULT_RISK_CONFIG, canEnter, initialRiskState, riskDirectives, sizeEntry, updateRiskState } from '../../../shared/trading/v6Risk.js';
import { auditLookahead, checkDevCriteria, gridCombos, runSim, trialRecord, walkForward } from '../../../shared/trading/v6Sim.js';
import { mean, seededRandom, stdev, summarize } from '../../../shared/trading/v6Stats.js';
import { btcAboveSma, buyAndHold, defineStrategy } from '../../../shared/trading/v6Strategies.js';

const DAY = 86400000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const V6 = join(ROOT, 'data/research/v6');
const TMP = join(ROOT, 'data/tmp/r-carry');
const AGENT = 'r-carry';
const FROM = Date.UTC(2019, 9, 1);
const TRAIN_DAYS = 365;
const TEST_DAYS = 180;

/** Fixed before any run. See the pre-registration in docs/rebuild/research-r-carry.md. */
export const PAIR_DEFAULTS = Object.freeze({
  pairStop: 0.03, entryBasisMax: 0.05, marginFrac: 1, topUpAt: 0.5, liqFee: 0.0125,
  maintenance: Object.freeze({ 1: 0.01, 2: 0.025, 3: 0.05 }), deadDays: 3, delistHaircut: 0.10,
  grossCap: 1, hedgeCredit: true, initialEquity: 100000, testLeakDays: 0,
});

export const UNIVERSES = Object.freeze({
  majors: Object.freeze({ universe: { kind: 'fixed', symbols: ['BTCUSDT', 'ETHUSDT'] }, maxPositionPct: 0.25, slowAllocator: true }),
  top10: Object.freeze({ universe: { kind: 'top', n: 10 }, maxPositionPct: 0.10, slowAllocator: false }),
  top20: Object.freeze({ universe: { kind: 'top', n: 20 }, maxPositionPct: 0.10, slowAllocator: false }),
});
export const CARRY_GRID = Object.freeze({ entryApr: [0.10, 0.20, 0.40], lookbackDays: [3, 7, 14] });

const riskConfigFor = (maxPositionPct) => ({
  ...DEFAULT_RISK_CONFIG, riskPerTradePct: 0.01, maxOpenRiskPct: 0.05, maxGrossExposurePct: 1, maxClusterPct: 0.5,
  volTargetAnnual: 0.20, maxPositionPct,
});

function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

// ---------- data ----------

function indexBars(bars) {
  const at = new Map();
  for (let i = 0; i < bars.length; i++) at.set(bars[i].t, i);
  return { bars, at };
}

function indexFunding(rows) {
  const t = rows.map((r) => r.t);
  const cum = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) cum[i + 1] = cum[i] + rows[i].rate;
  return { rows, t, cum };
}

/** Shapes raw series into the simulator's data object. Pure, so tests and the audit can build their own. */
export function buildPairData({ spot, perp, funding, multipliers = new Map(), universeFn, tierFn }) {
  const data = { spot: new Map(), perp: new Map(), funding: new Map(), universeFn, tierFn };
  for (const [s, bars] of spot) data.spot.set(s, indexBars(bars));
  for (const [s, bars] of perp) {
    const k = multipliers.get(s) ?? 1;
    data.perp.set(s, { ...indexBars(k === 1 ? bars : bars.map((b) => ({ ...b, o: b.o / k, h: b.h / k, l: b.l / k, c: b.c / k }))), mult: k });
  }
  for (const [s, rows] of funding) data.funding.set(s, indexFunding(rows));
  data.btc = data.spot.get('BTCUSDT').bars;
  data.calendar = data.btc.map((b) => b.t);
  return data;
}

/** Spot symbol -> perp name, from the store. Same-name spot wins (1000SATS trades as such on spot). */
function perpNames() {
  const spots = new Set(listSymbols({ timeframe: '1d' }));
  const out = new Map();
  for (const f of readdirSync(join(V6, 'derivs/dev/funding'))) {
    const name = f.replace('.json', '');
    let s = spots.has(name) ? name : perpToSpot(name).spot;
    let k = spots.has(name) ? 1 : perpToSpot(name).multiplier;
    if (name === 'LUNA2USDT') { s = 'LUNAUSDT~2'; k = 1; }
    if (spots.has(s) && !out.has(s)) out.set(s, { name, k });
  }
  return out;
}

export function loadPairData() {
  const names = perpNames();
  const spot = loadBars({ symbols: [...names.keys()], timeframe: '1d' });
  const perpList = [...names.values()].map((v) => v.name);
  const rawPerp = loadPerpBars({ symbols: perpList, timeframe: '1d' });
  const rawFunding = loadFunding({ symbols: perpList });
  const perp = new Map(), funding = new Map(), multipliers = new Map();
  for (const [s, { name, k }] of names) {
    if (!rawPerp.has(name) || !rawFunding.has(name) || !spot.has(s)) continue;
    perp.set(s, rawPerp.get(name));
    // Funding marks are in contract units, so they scale like the bars.
    funding.set(s, k === 1 ? rawFunding.get(name) : rawFunding.get(name).map((r) => ({ ...r, mark: r.mark > 0 ? r.mark / k : r.mark })));
    multipliers.set(s, k);
  }
  const cache = new Map();
  const universeFn = (t, { topN }) => {
    const key = `${t}|${topN}`;
    if (!cache.has(key)) cache.set(key, pointInTimeUniverse(t, { topN }));
    return cache.get(key);
  };
  return buildPairData({ spot, perp, funding, multipliers, universeFn, tierFn: tierFor });
}

/** Annualised funding from events stamped in [tClose - days, tClose). Null when history is short or the feed stopped. */
export function trailingApr(f, tClose, days) {
  if (!f || !f.t.length) return null;
  const lo = tClose - days * DAY;
  if (f.t[0] > lo) return null;
  const i = lowerBound(f.t, lo), j = lowerBound(f.t, tClose);
  if (j <= i || tClose - f.t[j - 1] > 2 * DAY) return null;
  return (f.cum[j] - f.cum[i]) * 365 / days;
}

/** Annualised volatility of log(perp/spot) daily changes, or of spot returns when hedged is false. */
function legVol(data, sym, T, hedged) {
  const s = data.spot.get(sym), p = data.perp.get(sym);
  const xs = [];
  let prev = null;
  for (let d = 30; d >= 0; d--) {
    const t = T - d * DAY;
    const si = s.at.get(t), pi = p.at.get(t);
    if (si === undefined || pi === undefined) { prev = null; continue; }
    const x = hedged ? Math.log(p.bars[pi].c / s.bars[si].c) : Math.log(s.bars[si].c);
    if (prev !== null) xs.push(x - prev);
    prev = x;
  }
  return xs.length >= 20 ? stdev(xs) * Math.sqrt(365) : 1;
}

// ---------- the pair simulator ----------

/**
 * @param {object} a
 * @param {object} a.data from buildPairData
 * @param {object} a.universe { kind, symbols | n }
 * @param {object|Function} a.params { entryApr, lookbackDays, alwaysOn? } or t -> params
 * @param {number} a.maxPositionPct cap per leg, passed to v6Risk
 * @param {object} [a.opts] overrides of PAIR_DEFAULTS. testLeakDays exists only so the
 *   self test can prove the audit catches a signal reading the future.
 * @returns {{ equity, trades, fills, summary, costs, liquidations, marginCalls, stops }}
 */
export function runPaired({ data, universe, params, maxPositionPct, from = -Infinity, to = Infinity, stress = 1, closeOut = true, opts = {} }) {
  const o = { ...PAIR_DEFAULTS, ...opts };
  const paramsAt = typeof params === 'function' ? params : () => params;
  const cal = data.calendar;
  const first = lowerBound(cal, from), last = lowerBound(cal, to + 1) - 1;
  if (last <= first) throw new Error('range covers fewer than two bars');
  const riskCfg = riskConfigFor(maxPositionPct);

  let cash = o.initialEquity;
  let riskState = initialRiskState(cash, cal[first]);
  const pairs = new Map();
  let exitQueue = new Map();
  let entryQueue = [];
  const equity = [], trades = [], fills = [];
  const tally = { fees: 0, slippage: 0, stopGap: 0, delistHaircut: 0, liquidationLoss: 0, funding: 0, fundingPaid: 0, basis: 0 };
  let liquidations = 0, marginCalls = 0, stops = 0, entries = 0, exposureSum = 0, heldDays = 0, riskBlocks = 0;

  const legCost = (sym, T) => {
    const tier = data.tierFn(sym, T);
    const s = costFor(sym, tier, { stress, instrument: 'spot' });
    const p = costFor(sym, tier, { stress, instrument: 'perp' });
    return { tier: s.tier, sFee: s.feePct / 100, sSlip: s.slipPct / 100, pFee: p.feePct / 100, pSlip: p.slipPct / 100, stop: s.stopSlipPct / 100 };
  };
  const barAt = (m, sym, T) => { const x = m.get(sym); const i = x?.at.get(T); return i === undefined ? null : x.bars[i]; };

  const chargeFunding = (p, upTo, T) => {
    if (!p.perpOpen) return;
    const f = data.funding.get(p.symbol);
    while (p.fi < f.t.length && f.t[p.fi] <= upTo) {
      const row = f.rows[p.fi++];
      const price = row.mark > 0 ? row.mark : (barAt(data.perp, p.symbol, T)?.o ?? p.lastP);
      const amt = row.rate * p.qty * price;
      p.wallet += amt; p.funding += amt; tally.funding += amt;
      if (amt < 0) tally.fundingPaid -= amt;
    }
  };

  const closePerp = (p, ref, slip, fee, T, kind) => {
    const px = ref * (1 + slip);
    const feeAmt = fee * p.qty * px;
    const pricePnl = p.qty * (p.perpEntry - px);
    cash += p.wallet + pricePnl - feeAmt;
    p.perpPnl = pricePnl; p.fees += feeAmt; p.perpOpen = false; p.wallet = 0;
    tally.fees += feeAmt; tally.slippage += p.qty * ref * slip;
    fills.push({ t: T, symbol: p.symbol, type: kind, leg: 'perp', qty: p.qty, price: px });
  };
  const closeSpot = (p, ref, slip, fee, T, kind) => {
    const px = ref * (1 - slip);
    const gross = p.qty * px;
    const feeAmt = fee * gross;
    cash += gross - feeAmt;
    p.spotPnl = p.qty * (px - p.spotEntry); p.fees += feeAmt;
    tally.fees += feeAmt; tally.slippage += p.qty * ref * slip;
    fills.push({ t: T, symbol: p.symbol, type: kind, leg: 'spot', qty: p.qty, price: px });
  };
  const finish = (p, T, reason) => {
    const basis = p.spotPnl + p.perpPnl;
    const pnl = basis + p.funding - p.fees;
    tally.basis += basis;
    trades.push({ symbol: p.symbol, pnl, barsHeld: Math.round((T - p.entryT) / DAY), entryT: p.entryT, exitT: T, reason, funding: p.funding, basis, fees: p.fees, notional: p.notional });
    pairs.delete(p.symbol);
  };

  for (let i = first; i <= last; i++) {
    const T = cal[i], tClose = T + DAY;
    const signalT = tClose + o.testLeakDays * DAY;

    // 1. Funding up to the open.
    for (const p of pairs.values()) chargeFunding(p, T, T);

    // 2. Queued fills, exits first.
    const carry = new Map();
    for (const [sym, x] of exitQueue) {
      const p = pairs.get(sym);
      if (!p) continue;
      const sb = barAt(data.spot, sym, T), pb = barAt(data.perp, sym, T);
      if (!sb || (p.perpOpen && !pb)) { carry.set(sym, x); continue; }
      const c = legCost(sym, T);
      const extra = x.stop ? c.stop : 0;
      if (x.stop) {
        // closeSpot and closePerp book all slip as slippage; move the stop part to its own line.
        const gap = p.qty * (sb.o + (p.perpOpen ? pb.o : 0)) * extra;
        tally.stopGap += gap; tally.slippage -= gap;
      }
      closeSpot(p, sb.o, c.sSlip + extra, c.sFee, T, 'exit');
      if (p.perpOpen) closePerp(p, pb.o, c.pSlip + extra, c.pFee, T, 'exit');
      finish(p, T, x.reason);
    }
    exitQueue = carry;
    for (const e of entryQueue) {
      const sb = barAt(data.spot, e.symbol, T), pb = barAt(data.perp, e.symbol, T);
      if (!sb || !pb || pairs.has(e.symbol)) continue;
      const c = legCost(e.symbol, T);
      const spotPx = sb.o * (1 + c.sSlip), perpPx = pb.o * (1 - c.pSlip);
      const unit = spotPx * (1 + c.sFee) + perpPx * (c.pFee + o.marginFrac);
      const qty = Math.min(e.qty, cash / unit);
      if (!(qty * spotPx >= riskCfg.minNotional)) continue;
      const sFee = c.sFee * qty * spotPx, pFee = c.pFee * qty * perpPx, margin = o.marginFrac * qty * perpPx;
      cash -= qty * spotPx + sFee + pFee + margin;
      tally.fees += sFee + pFee;
      tally.slippage += qty * (sb.o * c.sSlip + pb.o * c.pSlip);
      fills.push({ t: T, symbol: e.symbol, type: 'enter', leg: 'pair', qty, price: spotPx });
      const f = data.funding.get(e.symbol);
      pairs.set(e.symbol, {
        symbol: e.symbol, qty, spotEntry: spotPx, perpEntry: perpPx, wallet: margin, entryT: T, perpOpen: true,
        fi: lowerBound(f.t, T + 1), funding: 0, fees: sFee + pFee, spotPnl: 0, perpPnl: 0,
        lastS: sb.c, lastP: pb.c, missS: 0, missP: 0, notional: qty * spotPx,
      });
      entries++;
    }
    entryQueue = [];

    // 3. Dead coins, then liquidation on the bar's high. Isolated margin: the wallet is all it can lose.
    for (const p of [...pairs.values()]) {
      const sb = barAt(data.spot, p.symbol, T), pb = barAt(data.perp, p.symbol, T);
      p.missS = sb ? 0 : p.missS + 1;
      p.missP = pb ? 0 : p.missP + 1;
      const c = legCost(p.symbol, T);
      if (p.missS >= o.deadDays) {
        const hair = p.lastS * o.delistHaircut;
        tally.delistHaircut += p.qty * hair;
        if (p.perpOpen) closePerp(p, pb ? pb.o : p.lastP, c.pSlip, c.pFee, T, 'delist');
        closeSpot(p, p.lastS - hair, 0, c.sFee, T, 'delist');
        exitQueue.delete(p.symbol);
        finish(p, T, 'delisted');
        continue;
      }
      if (p.perpOpen && p.missP >= o.deadDays) {
        closePerp(p, p.lastP, c.pSlip, c.pFee, T, 'perp_dead');
        exitQueue.set(p.symbol, { reason: 'perp_dead', stop: true });
      }
      if (p.perpOpen && pb) {
        const liqPx = (p.wallet / p.qty + p.perpEntry) / (1 + o.maintenance[c.tier]);
        if (pb.h >= liqPx) {
          const px = Math.max(liqPx, pb.o);
          const left = Math.max(0, p.wallet + p.qty * (p.perpEntry - px) - o.liqFee * p.qty * px);
          cash += left;
          tally.liquidationLoss += o.liqFee * p.qty * px;
          p.perpPnl = left - p.wallet; p.wallet = 0; p.perpOpen = false;
          fills.push({ t: T, symbol: p.symbol, type: 'liquidation', leg: 'perp', qty: p.qty, price: px });
          liquidations++;
          exitQueue.set(p.symbol, { reason: 'liquidated', stop: true });
        }
      }
      if (sb) p.lastS = sb.c;
      if (pb) p.lastP = pb.c;
    }

    // 4. In-bar funding.
    for (const p of pairs.values()) chargeFunding(p, tClose - 1, T);

    // 5. Mark at the close.
    let value = cash, spotValue = 0;
    for (const p of pairs.values()) {
      spotValue += p.qty * p.lastS;
      value += p.qty * p.lastS + (p.perpOpen ? p.wallet + p.qty * (p.perpEntry - p.lastP) : 0);
    }
    equity.push({ t: T, equity: value });
    exposureSum += value > 0 ? spotValue / value : 0;
    if (pairs.size) heldDays++;
    if (i === last) break;

    // 6. Risk state, on the real engine.
    const updated = updateRiskState(riskState, { t: tClose, equity: value, btcBars: data.btc.slice(Math.max(0, i - 10), i + 1), dataHealth: { ok: true }, config: riskCfg });
    riskState = updated.riskState;
    const directives = riskDirectives(riskState);

    // 7. Exits. Never blocked.
    const pr = paramsAt(tClose);
    for (const p of pairs.values()) {
      if (exitQueue.has(p.symbol) || !p.perpOpen) continue;
      if (directives.flatten) { exitQueue.set(p.symbol, { reason: 'risk_flatten', stop: false }); continue; }
      const pnl = p.qty * (p.lastS - p.spotEntry) + p.qty * (p.perpEntry - p.lastP);
      if (pnl <= -o.pairStop * p.notional) { stops++; exitQueue.set(p.symbol, { reason: 'basis_stop', stop: true }); continue; }
      const apr = trailingApr(data.funding.get(p.symbol), signalT, pr.lookbackDays);
      if (!pr.alwaysOn && (apr === null || apr < pr.entryApr / 2)) { exitQueue.set(p.symbol, { reason: 'funding_faded', stop: false }); continue; }
      const held = p.wallet + p.qty * (p.perpEntry - p.lastP);
      const need = o.marginFrac * p.qty * p.lastP;
      if (held < o.topUpAt * need) {
        const add = need - held;
        if (cash >= add) { cash -= add; p.wallet += add; }
        else { marginCalls++; exitQueue.set(p.symbol, { reason: 'margin_call', stop: false }); }
      }
    }

    // 8. Entries.
    const gate = canEnter(riskState);
    if (!gate.ok || directives.flatten) { riskBlocks++; continue; }
    const list = universe.kind === 'fixed' ? universe.symbols : data.universeFn(tClose, { topN: universe.n });
    const candidates = [];
    for (const sym of list) {
      if (pairs.has(sym) || !data.funding.has(sym) || !data.perp.has(sym)) continue;
      const sb = barAt(data.spot, sym, T), pb = barAt(data.perp, sym, T);
      if (!sb || !pb) continue;
      const apr = trailingApr(data.funding.get(sym), signalT, pr.lookbackDays);
      if (apr === null || (!pr.alwaysOn && apr < pr.entryApr)) continue;
      if (Math.abs(pb.c / sb.c - 1) > o.entryBasisMax) continue;
      candidates.push({ sym, apr, close: sb.c });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.apr - a.apr || (a.sym < b.sym ? -1 : 1));

    const book = [...pairs.values()].filter((p) => p.perpOpen).map((p) => ({ symbol: p.symbol, qty: p.qty, entryPrice: p.spotEntry, stopPrice: p.lastS * (1 - o.pairStop) }));
    const prices = new Map(book.map((b) => [b.symbol, pairs.get(b.symbol).lastS]));
    const vols = new Map();
    const volOf = (s) => Math.max(0.10, legVol(data, s, T, o.hedgeCredit));
    for (const b of book) vols.set(b.symbol, volOf(b.symbol));
    let free = cash;
    let legs = 2 * spotValue;
    for (const c of candidates) {
      vols.set(c.sym, volOf(c.sym));
      const lc = legCost(c.sym, T);
      const sized = sizeEntry({
        signal: { strategyId: 'carry', symbol: c.sym, side: 'long', score: 0.5, stopDistancePct: o.pairStop, exitProfile: 'revert', reason: 'funding carry', meta: {} },
        price: c.close, equity: value, positions: book, riskState, config: riskCfg, volatility: vols, correlations: {}, sizeMultiplier: 1,
        costs: { feePct: lc.sFee + lc.pFee, slipPct: lc.sSlip + lc.pSlip }, prices, cash: Math.max(0, free) / (1 + o.marginFrac),
      });
      if (sized.rejected) continue;
      // v6Risk counts one leg. Both legs count towards gross, so this can only shrink the size.
      const notional = Math.min(sized.notional, (o.grossCap * value - legs) / 2);
      if (notional < riskCfg.minNotional) continue;
      const qty = notional / c.close;
      entryQueue.push({ symbol: c.sym, qty });
      book.push({ symbol: c.sym, qty, entryPrice: c.close, stopPrice: c.close * (1 - o.pairStop) });
      prices.set(c.sym, c.close);
      free -= notional * (1 + o.marginFrac);
      legs += 2 * notional;
    }
  }

  // Closing fill, as runSim does, so the summary is net of the exit costs.
  if (closeOut) {
    const T = cal[last];
    for (const p of [...pairs.values()]) {
      const c = legCost(p.symbol, T);
      closeSpot(p, p.lastS, c.sSlip, c.sFee, T, 'close');
      if (p.perpOpen) closePerp(p, p.lastP, c.pSlip, c.pFee, T, 'close');
      finish(p, T, 'end_of_run');
    }
    equity[equity.length - 1] = { t: T, equity: cash };
  }

  const summary = summarize(equity, trades, { periodsPerYear: 365 });
  summary.positionChanges = entries + trades.length;
  summary.exposure = exposureSum / equity.length;
  summary.timeInMarket = heldDays / equity.length;
  return { equity, trades, fills, summary, costs: { ...tally, stress }, liquidations, marginCalls, stops, riskBlocks, openAtEnd: pairs.size, riskState };
}

// ---------- walk-forward, same logic as v6Sim.walkForward ----------

const paramsKey = (grid, p) => Object.keys(grid).map((k) => p[k]).join('|');

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
  const neighbours = trials.filter((tr) => Math.max(0, ...pos(tr.params).map((x, i) => Math.abs(x - c[i]))) === 1);
  return { params: center.params, sharpe: self.sharpe, neighbours: neighbours.map((n) => ({ params: n.params, sharpe: n.sharpe })) };
}

export function walkForwardPaired({ data, name, grid = CARRY_GRID, opts = {}, bench = null }) {
  const u = UNIVERSES[name];
  const shared = { data, universe: u.universe, maxPositionPct: u.maxPositionPct, opts };
  const cal = data.calendar;
  const start = Math.max(FROM, cal[0]), end = cal[cal.length - 1];
  const combos = gridCombos(grid);
  const picks = [];
  for (let testFrom = start + TRAIN_DAYS * DAY; testFrom <= end; testFrom += TEST_DAYS * DAY) {
    let best = null, bestScore = -Infinity;
    for (const params of combos) {
      const { summary } = runPaired({ ...shared, params, from: testFrom - TRAIN_DAYS * DAY, to: testFrom - 1 });
      if (summary.sharpe > bestScore) { best = params; bestScore = summary.sharpe; }
    }
    picks.push({ testFrom, params: best, trainScore: bestScore });
  }
  const oosFrom = picks[0].testFrom;
  const scheduled = (t) => {
    let cur = picks[0].params;
    for (const p of picks) if (p.testFrom <= t) cur = p.params;
    return cur;
  };
  const oos = runPaired({ ...shared, params: scheduled, from: oosFrom, to: end });
  const stress2x = runPaired({ ...shared, params: scheduled, from: oosFrom, to: end, stress: 2 });
  const trials = combos.map((params) => {
    const r = runPaired({ ...shared, params, from: oosFrom, to: end });
    const s = r.summary;
    return { params, sharpe: s.sharpe, periodsPerYear: 365, nObs: s.periods, closedTrades: s.closedTrades, maxDrawdown: s.maxDrawdown, totalReturn: s.totalReturn, calmar: s.calmar, exposure: s.exposure, liquidations: r.liquidations };
  });
  return {
    oos, stress2x, picks, trials, plateau: plateauOf(grid, picks, trials), benchmark: bench ? bench(oosFrom, end, u) : null,
    summary: oos.summary, strategy: { id: `carry-${name}`, version: 1, timeframe: '1d', slowAllocator: u.slowAllocator }, span: { from: oosFrom, to: end },
  };
}

/** Equal-weight buy-and-hold of the universe as it stood on the first OOS day, through real runSim. */
function makeBenchmark(allBars) {
  return (oosFrom, end, u) => {
    const list = u.universe.kind === 'fixed' ? u.universe.symbols : pointInTimeUniverse(oosFrom, { topN: u.universe.n });
    const symbols = list.filter((s) => allBars.has(s));
    const run = runSim({
      strategies: [buyAndHold({ symbols })], bars: allBars, from: oosFrom, to: end, costs: { tierFn: tierFor },
      modules: { risk: fullWeightRisk({ weight: 1 / symbols.length }) }, collectEvents: false,
    });
    return { summary: run.summary, symbols };
  };
}

// ---------- lookahead audit for the pair simulator ----------

/** Cuts spot, perp, funding and the universe at each date and compares fills and equity bit for bit. */
export function auditPaired({ data, name, params, opts = {}, from, to, cuts = 6, seed = 1 }) {
  const u = UNIVERSES[name];
  const args = { universe: u.universe, params, maxPositionPct: u.maxPositionPct, opts, from, closeOut: false };
  const full = runPaired({ ...args, data, to });
  const rand = seededRandom(seed);
  const n = full.equity.length;
  const key = (f) => `${f.t}|${f.symbol}|${f.type}|${f.leg}|${f.qty}|${f.price}`;
  const out = [];
  for (let i = 0; i < cuts; i++) {
    const cut = full.equity[2 + Math.floor((0.1 + 0.8 * ((i + rand()) / cuts)) * (n - 3))].t;
    const spot = new Map(), perp = new Map(), funding = new Map();
    for (const [s, x] of data.spot) { const b = x.bars.filter((r) => r.t <= cut); if (b.length) spot.set(s, b); }
    for (const [s, x] of data.perp) { const b = x.bars.filter((r) => r.t <= cut); if (b.length) perp.set(s, b); }
    for (const [s, x] of data.funding) { const r = x.rows.filter((e) => e.t < cut + DAY); if (r.length) funding.set(s, r); }
    const universeFn = (t, q) => {
      if (t > cut + DAY) throw new Error('universe asked past the cut');
      return data.universeFn(t, q);
    };
    const cutData = buildPairData({ spot, perp, funding, universeFn, tierFn: data.tierFn });
    const part = runPaired({ ...args, data: cutData, to: cut });
    let detail = null;
    const expected = full.fills.filter((f) => f.t <= cut);
    if (part.fills.length !== expected.length) detail = `${part.fills.length} fills vs ${expected.length}`;
    for (let j = 0; !detail && j < expected.length; j++) if (key(part.fills[j]) !== key(expected[j])) detail = `fill ${j} differs`;
    for (let j = 0; !detail && j < part.equity.length; j++) if (part.equity[j].equity !== full.equity[j].equity) detail = `equity differs at ${part.equity[j].t}`;
    out.push({ cut, ok: !detail, detail });
  }
  return { ok: out.every((c) => c.ok), cuts: out, fills: full.fills.length };
}

// ---------- Family B: crowding overlay, contract-shaped, runs through runSim ----------

/** Mean of BTC and ETH trailing annualised funding. Reads only events before t. */
export function crowdIndex(funding, t, days = 7) {
  const xs = ['BTCUSDT', 'ETHUSDT'].map((s) => trailingApr(funding.get(s), t, days)).filter((x) => x !== null);
  return xs.length ? mean(xs) : null;
}

export function momentumBase(params = {}) {
  const p = { n: 30, ...params };
  return defineStrategy({
    id: 'mom20', name: 'Top-20 momentum (harness example)', timeframe: '1d', params: p, warmupBars: 100,
    universe: { kind: 'top', n: 20 },
    signals(ctx) {
      return ctx.universe.map((symbol) => ({
        strategyId: 'mom20', symbol, score: 0.5, exitProfile: 'trend', meta: {},
        side: ctx.ind(symbol, 'roc', ctx.params.n) > 0 ? 'long' : 'flat', stopDistancePct: 0.15, reason: `${ctx.params.n}d momentum`,
      }));
    },
  });
}

export const OVERLAY_BASES = Object.freeze({ btc100: () => btcAboveSma({ n: 100 }), mom20: () => momentumBase({ n: 30 }) });

/** Wraps a long-only base. `funding` holds { t, cum } indexes; reads stop at ctx.t. */
export function crowdOverlay(baseName, mode, funding) {
  return ({ crowdApr }) => {
    const base = OVERLAY_BASES[baseName]();
    const id = `${base.id}-crowd-${mode}`;
    return defineStrategy({
      ...base, id, name: `${base.name}, crowding ${mode}`, params: { ...base.params, crowdApr, mode },
      signals(ctx) {
        const sigs = base.signals(ctx).map((s) => ({ ...s, strategyId: id }));
        const c = crowdIndex(funding, ctx.t);
        if (c === null || c < crowdApr) return sigs;
        if (mode === 'flat') return sigs.map((s) => ({ ...s, side: 'flat', reason: `${s.reason}; funding crowded` }));
        return sigs.filter((s) => s.side !== 'long' || ctx.positions.has(s.symbol));
      },
    });
  };
}

const overlayRisk = { risk: riskConfigFor(0.25) };

// ---------- trial log ----------

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const trialFile = join(V6, `trials-${AGENT}.jsonl`);

function logTrial(family, strategyId, trial, note) {
  const seen = new Set(existsSync(trialFile) ? readLines(trialFile).map((l) => `${l.strategyId}|${JSON.stringify(l.params)}`) : []);
  if (seen.has(`${strategyId}|${JSON.stringify(trial.params)}`)) return;
  appendFileSync(trialFile, `${JSON.stringify(trialRecord({ agent: AGENT, family, strategyId, timeframe: '1d', trial, note, ts: new Date().toISOString() }))}\n`);
}
const allTrials = () => readdirSync(V6).filter((f) => /^trials-.*\.jsonl$/.test(f)).flatMap((f) => readLines(join(V6, f)));

function byYearPct(equity) {
  const out = {};
  let prev = equity[0].equity, y = new Date(equity[0].t).getUTCFullYear();
  for (let i = 1; i < equity.length; i++) {
    const yy = new Date(equity[i].t).getUTCFullYear();
    if (yy !== y) { out[y] = equity[i - 1].equity / prev - 1; prev = equity[i - 1].equity; y = yy; }
  }
  out[y] = equity[equity.length - 1].equity / prev - 1;
  return out;
}

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
function printPaired(label, r) {
  const s = r.summary;
  console.log(`${label}: return ${pct(s.totalReturn)}, CAGR ${pct(s.cagr)}, Sharpe ${s.sharpe.toFixed(2)}, maxDD ${pct(s.maxDrawdown)}, trades ${s.closedTrades}, avg spot exposure ${pct(s.exposure)}, in market ${pct(s.timeInMarket)}`);
  const c = r.costs;
  console.log(`  funding net ${c.funding.toFixed(0)} (paid ${c.fundingPaid.toFixed(0)}), basis incl slippage ${c.basis.toFixed(0)}, fees ${c.fees.toFixed(0)}, slippage ${c.slippage.toFixed(0)}, stop slip ${c.stopGap.toFixed(0)}, delist ${c.delistHaircut.toFixed(0)}, liq fees ${c.liquidationLoss.toFixed(0)}; liquidations ${r.liquidations}, margin calls ${r.marginCalls}, basis stops ${r.stops}, risk-blocked days ${r.riskBlocks}`);
  console.log(`  years ${Object.entries(byYearPct(r.equity)).map(([y, v]) => `${y} ${pct(v)}`).join(', ')}`);
}

// ---------- commands ----------

function cmdCarry() {
  const data = loadPairData();
  const allBars = loadBars({ timeframe: '1d' });
  const bench = makeBenchmark(allBars);
  mkdirSync(TMP, { recursive: true });
  const dump = {};
  for (const name of Object.keys(UNIVERSES)) {
    const t0 = performance.now();
    const wf = walkForwardPaired({ data, name, bench });
    for (const tr of wf.trials) logTrial('carry-paired', `carry-${name}`, tr, 'pair simulator, NOT through v6Core');
    console.log(`\n=== ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s) OOS from ${new Date(wf.span.from).toISOString().slice(0, 10)}`);
    console.log('picks', wf.picks.map((p) => `${new Date(p.testFrom).toISOString().slice(0, 7)} ${p.params.entryApr}/${p.params.lookbackDays} (${p.trainScore.toFixed(2)})`).join('; '));
    printPaired('OOS walk-forward', wf.oos);
    printPaired('2x costs', wf.stress2x);
    console.log('grid (fixed params, OOS span):');
    for (const t of wf.trials) console.log(`  apr ${t.params.entryApr} lb ${t.params.lookbackDays}: Sharpe ${t.sharpe.toFixed(2)} ret ${pct(t.totalReturn)} DD ${pct(t.maxDrawdown)} trades ${t.closedTrades} exp ${pct(t.exposure)} liq ${t.liquidations}`);
    console.log(`benchmark: Sharpe ${wf.benchmark.summary.sharpe.toFixed(2)}, Calmar ${wf.benchmark.summary.calmar.toFixed(2)}, DD ${pct(wf.benchmark.summary.maxDrawdown)}, ${wf.benchmark.symbols.join(' ')}`);
    const center = wf.plateau?.params ?? wf.picks[0].params;
    const audit = auditPaired({ data, name, params: center, from: wf.span.from, to: wf.span.to });
    console.log(`pair audit: ${audit.ok ? 'clean' : 'FAILED'} (${audit.fills} fills) ${audit.ok ? '' : JSON.stringify(audit.cuts.filter((c) => !c.ok))}`);
    const v = checkDevCriteria(wf, { trials: allTrials() });
    console.log(v.report);
    const top = Object.entries(wf.oos.summary.bySymbol).sort((a, b) => b[1] - a[1]);
    console.log('by coin', top.slice(0, 6).map(([k, x]) => `${k} ${x.toFixed(0)}`).join(', '), '... worst', top.slice(-3).map(([k, x]) => `${k} ${x.toFixed(0)}`).join(', '));
    const reasons = {};
    for (const t of wf.oos.trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
    console.log('exits', JSON.stringify(reasons), 'avg bars held', wf.oos.summary.avgBarsHeld.toFixed(1));
    dump[name] = { summary: wf.summary, picks: wf.picks, trials: wf.trials, plateau: wf.plateau, criteria: v.criteria, costs: wf.oos.costs, audit: audit.ok, years: byYearPct(wf.oos.equity), stress: wf.stress2x.summary.totalReturn, liquidations: wf.oos.liquidations, marginCalls: wf.oos.marginCalls, stops: wf.oos.stops, benchmark: wf.benchmark.summary };
  }
  writeFileSync(join(TMP, 'carry.json'), JSON.stringify(dump, null, 1));
}

function cmdRobust(name, entryApr, lookbackDays) {
  const data = loadPairData();
  const u = UNIVERSES[name];
  const params = { entryApr: Number(entryApr), lookbackDays: Number(lookbackDays) };
  const from = FROM + TRAIN_DAYS * DAY;
  const base = { data, universe: u.universe, maxPositionPct: u.maxPositionPct, from };
  const record = (r, p) => ({ params: p, sharpe: r.summary.sharpe, periodsPerYear: 365, nObs: r.summary.periods, closedTrades: r.summary.closedTrades, maxDrawdown: r.summary.maxDrawdown, totalReturn: r.summary.totalReturn });
  const note = 'pair simulator, NOT through v6Core';
  const runs = [['margin 0.5', { ...params, marginFrac: 0.5 }, { marginFrac: 0.5 }], ['no hedge credit', { ...params, hedgeCredit: false }, { hedgeCredit: false }]];
  for (const [label, p, opts] of runs) {
    const r = runPaired({ ...base, params, opts });
    printPaired(`${name} ${label}`, r);
    logTrial('carry-paired-robust', `carry-${name}`, record(r, p), note);
  }
  const m = UNIVERSES.majors;
  const always = { alwaysOn: true, lookbackDays: 7, entryApr: 0 };
  const r = runPaired({ data, universe: m.universe, maxPositionPct: m.maxPositionPct, from, params: always });
  printPaired('always-on BTC/ETH', r);
  logTrial('carry-paired-robust', 'carry-majors', record(r, always), note);
}

function fundingIndexes() {
  const raw = loadFunding({ symbols: ['BTCUSDT', 'ETHUSDT'] });
  return new Map([...raw].map(([s, rows]) => [s, indexFunding(rows)]));
}

function cmdEvents() {
  const funding = fundingIndexes();
  const bars = loadBars({ symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '1d', from: FROM });
  const edges = [-Infinity, 0.10, 0.30, 0.50, 0.80, Infinity];
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const b = bars.get(sym);
    for (const h of [7, 30]) {
      for (let e = 0; e + 1 < edges.length; e++) {
        const xs = [], dds = [];
        for (let i = 0; i + h < b.length; i++) {
          const c = crowdIndex(funding, b[i].t + DAY);
          if (c === null || c < edges[e] || c >= edges[e + 1]) continue;
          xs.push(b[i + h].c / b[i].c - 1);
          let low = Infinity;
          for (let k = i + 1; k <= i + h; k++) low = Math.min(low, b[k].l);
          dds.push(low / b[i].c - 1);
        }
        console.log(`${sym} ${h}d C ${edges[e]}..${edges[e + 1]}: days ${xs.length}, mean fwd ${xs.length ? pct(mean(xs)) : '-'}, sd ${xs.length > 1 ? pct(stdev(xs)) : '-'}, mean worst ${dds.length ? pct(mean(dds)) : '-'}`);
      }
    }
  }
  logTrial('crowding-events', 'crowd-event-study', { params: { edges: [0.10, 0.30, 0.50, 0.80], horizons: [7, 30] }, sharpe: null, periodsPerYear: 365, nObs: null, closedTrades: null, maxDrawdown: null, totalReturn: null }, 'event study, diagnostic');
}

function cmdOverlay() {
  const funding = fundingIndexes();
  const bars = loadBars({ timeframe: '1d' });
  const setup = { bars, costs: { tierFn: tierFor }, universeFn: pointInTimeUniverse, config: overlayRisk };
  const grid = { crowdApr: [0.30, 0.50, 0.80] };
  const oosFrom = FROM + TRAIN_DAYS * DAY;
  for (const baseName of Object.keys(OVERLAY_BASES)) {
    const base = OVERLAY_BASES[baseName]();
    const b = runSim({ ...setup, strategies: [base], from: oosFrom, collectEvents: false });
    logTrial('crowding-overlay', `${base.id}-base`, { params: base.params, sharpe: b.summary.sharpe, periodsPerYear: b.summary.periodsPerYear, nObs: b.summary.periods, closedTrades: b.summary.closedTrades, maxDrawdown: b.summary.maxDrawdown, totalReturn: b.summary.totalReturn }, 'no overlay, baseline');
    console.log(`\n=== ${baseName} baseline: return ${pct(b.summary.totalReturn)}, Sharpe ${b.summary.sharpe.toFixed(2)}, Calmar ${b.summary.calmar.toFixed(2)}, DD ${pct(b.summary.maxDrawdown)}, trades ${b.summary.closedTrades}, exposure ${pct(b.summary.exposure ?? 0)}`);
    for (const mode of ['block', 'flat']) {
      const factory = crowdOverlay(baseName, mode, funding);
      const wf = walkForward({ ...setup, strategyFactory: factory, grid, from: FROM, trainDays: TRAIN_DAYS, testDays: TEST_DAYS });
      const id = factory({ crowdApr: 0.5 }).id;
      for (const tr of wf.trials) logTrial('crowding-overlay', id, tr, null);
      const s = wf.summary;
      console.log(`--- ${baseName} ${mode}: WF return ${pct(s.totalReturn)}, Sharpe ${s.sharpe.toFixed(2)}, Calmar ${s.calmar.toFixed(2)}, DD ${pct(s.maxDrawdown)}, trades ${s.closedTrades}, exposure ${pct(s.exposure ?? 0)}`);
      console.log('  picks', wf.picks.map((p) => p.params?.crowdApr).join(','));
      for (const t of wf.trials) console.log(`  crowdApr ${t.params.crowdApr}: Sharpe ${t.sharpe.toFixed(2)} ret ${pct(t.totalReturn)} DD ${pct(t.maxDrawdown)} Calmar ${t.calmar.toFixed(2)} trades ${t.closedTrades}`);
      const crowdApr = wf.plateau?.params?.crowdApr ?? 0.5;
      const rebuild = (cut) => {
        const lastT = cut.get('BTCUSDT').at(-1).t;
        const cutFunding = new Map([...funding].map(([k, f]) => [k, indexFunding(f.rows.filter((r) => r.t < lastT + DAY))]));
        return crowdOverlay(baseName, mode, cutFunding)({ crowdApr });
      };
      const audit = auditLookahead({ ...setup, rebuild, from: Date.UTC(2021, 0, 1), cuts: 3 });
      console.log(`  lookahead audit: ${audit.ok ? 'clean' : `FAILED ${JSON.stringify(audit.cuts.filter((c) => !c.ok))}`}`);
      console.log(checkDevCriteria(wf, { trials: allTrials() }).report);
    }
  }
}

// ---------- diagnostics: already-logged parameters only, so no new trials ----------

function cmdDiag() {
  const data = loadPairData();
  const from = FROM + TRAIN_DAYS * DAY;
  const dailyRets = (eq) => eq.slice(1).map((p, i) => p.equity / eq[i].equity - 1);
  const annualSharpe = (xs, ppy) => mean(xs) / stdev(xs) * Math.sqrt(ppy);
  const autocorr = (xs, lag) => {
    const m = mean(xs);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { den += (xs[i] - m) ** 2; if (i >= lag) num += (xs[i] - m) * (xs[i - lag] - m); }
    return num / den;
  };
  const cases = [
    ['majors', { entryApr: 0.1, lookbackDays: 14 }],
    ['top10', { entryApr: 0.1, lookbackDays: 14 }],
    ['top20', { entryApr: 0.2, lookbackDays: 14 }],
    ['majors', { alwaysOn: true, lookbackDays: 7, entryApr: 0 }],
  ];
  for (const [name, params] of cases) {
    const u = UNIVERSES[name];
    const r = runPaired({ data, universe: u.universe, maxPositionPct: u.maxPositionPct, from, params });
    const rets = dailyRets(r.equity);
    const months = new Map();
    for (const p of r.equity) months.set(new Date(p.t).toISOString().slice(0, 7), p.equity);
    const me = [...months.values()];
    const mrets = me.slice(1).map((v, i) => v / me[i] - 1);
    console.log(`\n=== ${name} ${JSON.stringify(params)}`);
    console.log(`daily Sharpe ${annualSharpe(rets, 365).toFixed(2)}; monthly Sharpe ${annualSharpe(mrets, 12).toFixed(2)}; AC1 ${autocorr(rets, 1).toFixed(3)}, AC7 ${autocorr(rets, 7).toFixed(3)}; losing months ${mrets.filter((x) => x < 0).length}/${mrets.length}; worst month ${pct(Math.min(...mrets), 2)}; worst day ${pct(Math.min(...rets), 3)}`);
    console.log(`Sharpe after a flat cash rate: ${[0.02, 0.04].map((rf) => `rf ${pct(rf, 0)}: ${annualSharpe(rets.map((x) => x - rf / 365), 365).toFixed(2)}`).join(', ')}`);
    const ys = r.summary.byYear;
    const total = Object.values(ys).reduce((a, b) => a + b, 0);
    console.log(`share of profit by year: ${Object.entries(ys).map(([y, v]) => `${y} ${pct(v / total)}`).join(', ')}`);
    const eqAt = new Map(r.equity.map((p) => [p.t, p.equity]));
    const big = r.trades.filter((t) => t.notional >= 0.01 * (eqAt.get(t.entryT) ?? 1e5));
    const notionals = r.trades.map((t) => t.notional).sort((a, b) => a - b);
    console.log(`trades ${r.trades.length}, at least 1% of equity ${big.length}; notional median ${notionals[notionals.length >> 1]?.toFixed(0)}, largest ${notionals.at(-1)?.toFixed(0)}`);
    const byYear = {};
    for (const t of r.trades) {
      const y = new Date(t.exitT).getUTCFullYear();
      byYear[y] ??= { funding: 0, dollarDays: 0 };
      byYear[y].funding += t.funding; byYear[y].dollarDays += t.notional * t.barsHeld;
    }
    console.log(`funding yield on notional held, by exit year: ${Object.entries(byYear).map(([y, v]) => `${y} ${pct(v.funding / v.dollarDays * 365)}`).join(', ')}`);
    const worst = [...r.trades].sort((a, b) => a.pnl / a.notional - b.pnl / b.notional).slice(0, 3);
    console.log(`worst trades: ${worst.map((t) => `${t.symbol} ${new Date(t.entryT).toISOString().slice(0, 10)} ${pct(t.pnl / t.notional, 2)} ${t.reason}`).join('; ')}`);
    for (const f of r.fills.filter((x) => x.type === 'liquidation')) {
      const tr = r.trades.find((t) => t.symbol === f.symbol && t.exitT > f.t);
      console.log(`liquidation: ${f.symbol} ${new Date(f.t).toISOString().slice(0, 10)} notional ${(f.qty * f.price).toFixed(0)}, trade pnl ${tr?.pnl.toFixed(0)}`);
    }
    const mc = r.trades.filter((t) => t.reason === 'margin_call');
    console.log(`margin-call exits ${mc.length}, their total fees ${mc.reduce((a, t) => a + t.fees, 0).toFixed(0)}`);
    // Ceiling check: largest spot share of equity, measured independently of the simulator's own gate.
    let maxPair = 0, maxTotal = 0;
    for (const p of r.equity) {
      let tot = 0;
      for (const t of r.trades) if (t.entryT <= p.t && p.t < t.exitT) { tot += t.notional; maxPair = Math.max(maxPair, t.notional / p.equity); }
      maxTotal = Math.max(maxTotal, tot / p.equity);
    }
    console.log(`at entry value: largest pair ${pct(maxPair)} of equity, largest total spot ${pct(maxTotal)} (both legs double that)`);
    // Funding recomputed from the raw store with a separate loop, using marks where recorded.
    const sample = [...r.trades].sort((a, b) => b.funding - a.funding)[0];
    if (sample) {
      const qty = r.fills.find((f) => f.t === sample.entryT && f.symbol === sample.symbol && f.type === 'enter').qty;
      const f = data.funding.get(sample.symbol), pb = data.perp.get(sample.symbol);
      let sum = 0;
      for (const row of f.rows) {
        if (row.t <= sample.entryT || row.t > sample.exitT) continue;
        const dayT = Math.floor(row.t / DAY) * DAY;
        sum += row.rate * qty * (row.mark > 0 ? row.mark : pb.bars[pb.at.get(dayT)].o);
      }
      console.log(`funding reconciliation, ${sample.symbol}: simulator ${sample.funding.toFixed(2)}, separate sum ${sum.toFixed(2)}`);
    }
  }
  // D7 across the fixed grid, for information only: nothing may be picked from this.
  for (const name of ['top10', 'top20']) {
    const u = UNIVERSES[name];
    const rows = gridCombos(CARRY_GRID).map((params) => {
      const s = runPaired({ data, universe: u.universe, maxPositionPct: u.maxPositionPct, from, params }).summary;
      return `${params.entryApr}/${params.lookbackDays}: ${s.topYear} ${pct(s.topYearShare)}`;
    });
    console.log(`\n${name} top-year share by fixed params: ${rows.join('; ')}`);
  }
}

// ---------- self test ----------

function cmdSelftest() {
  let bad = 0;
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) bad++; };
  const t0 = Date.UTC(2021, 0, 1);
  const days = 200;
  const flat = (price, n = days) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * DAY, o: price, h: price, l: price, c: price, v: 1, qv: 1e9 }));
  const fund = (rate, n = days) => Array.from({ length: n * 3 }, (_, i) => ({ t: t0 + i * 8 * 3600e3, rate: typeof rate === 'function' ? rate(i) : rate, mark: null }));
  const make = ({ spot, perp, rate }) => buildPairData({
    spot: new Map([['BTCUSDT', flat(100)], ['ETHUSDT', spot]]), perp: new Map([['ETHUSDT', perp]]), funding: new Map([['ETHUSDT', fund(rate)]]),
    universeFn: () => ['ETHUSDT'], tierFn: () => 1,
  });
  const args = { universe: { kind: 'fixed', symbols: ['ETHUSDT'] }, params: { entryApr: 0.1, lookbackDays: 7 }, maxPositionPct: 0.25, from: t0 + 40 * DAY };

  // 1. Flat prices: profit must be exactly funding less fees and slippage.
  let r = runPaired({ ...args, data: make({ spot: flat(100), perp: flat(100), rate: 0.0003 }) });
  const c = r.costs;
  const expect = c.funding - c.fees - c.slippage;
  check('conservation at flat prices', Math.abs(r.summary.profit - expect) < 1e-6, `${r.summary.profit.toFixed(4)} vs ${expect.toFixed(4)}`);
  check('one trade held to the end', r.summary.closedTrades === 1 && r.trades[0].reason === 'end_of_run');
  const n = r.trades[0].notional;
  // Tier 1 per side: spot 0.10 + 0.03, perp 0.05 + 0.03, so 0.42% of notional round trip.
  check('both legs charged', Math.abs((c.fees + c.slippage) / n - 0.0042) < 0.0001, ((c.fees + c.slippage) / n).toFixed(5));
  check('sized to the 25% leg cap', Math.abs(n / 100000 - 0.25) < 0.01, (n / 100000).toFixed(3));

  // 2. Delta neutral: a large equal move in both legs changes nothing but funding and costs.
  const wave = flat(100).map((b, i) => { const p = 100 * (1 + 0.4 * Math.sin(i / 15)); return { ...b, o: p, h: p, l: p, c: p }; });
  r = runPaired({ ...args, data: make({ spot: wave, perp: wave, rate: 0.0003 }) });
  check('hedged through a +-40% wave', r.liquidations === 0 && r.summary.maxDrawdown < 0.002 && r.summary.profit > 0, `DD ${r.summary.maxDrawdown.toFixed(4)} profit ${r.summary.profit.toFixed(0)}`);

  // 3. Spike: a 2x short at +70% intraday must liquidate and lose no more than its margin.
  const spike = flat(100).map((b, i) => (i === 60 ? { ...b, h: 170 } : b));
  r = runPaired({ ...args, data: make({ spot: flat(100), perp: spike, rate: 0.0003 }), opts: { marginFrac: 0.5 } });
  check('liquidates on the high at 0.5 margin', r.liquidations === 1 && r.trades.some((x) => x.reason === 'liquidated'), `liq ${r.liquidations}`);
  const lost = r.trades.find((x) => x.reason === 'liquidated');
  check('loss limited to the wallet', lost && lost.basis + lost.funding >= -0.5 * lost.notional * 1.02 && lost.basis < -0.4 * lost.notional, lost ? (lost.basis / lost.notional).toFixed(3) : 'none');
  r = runPaired({ ...args, data: make({ spot: flat(100), perp: spike, rate: 0.0003 }) });
  check('survives at 1.0 margin', r.liquidations === 0);

  // 4. Funding flips negative: exits, and paid funding is charged.
  r = runPaired({ ...args, data: make({ spot: flat(100), perp: flat(100), rate: (i) => (i < 300 ? 0.0003 : -0.0003) }) });
  check('exits when funding fades', r.trades[0].reason === 'funding_faded' && r.costs.fundingPaid > 0, `${r.trades[0].reason}, paid ${r.costs.fundingPaid.toFixed(1)}`);

  // 5. Basis stop: the perp premium widens 4%.
  const wide = flat(100).map((b, i) => (i >= 60 ? { ...b, o: 104, h: 104, l: 104, c: 104 } : b));
  r = runPaired({ ...args, data: make({ spot: flat(100), perp: wide, rate: 0.0003 }) });
  check('basis stop fires', r.stops >= 1 && r.trades[0].reason === 'basis_stop' && r.costs.stopGap > 0, r.trades[0].reason);
  const cc = r.costs;
  const total = r.trades.reduce((a, x) => a + x.pnl, 0);
  check('trade pnl sums to equity change', Math.abs(total - r.summary.profit) < 1e-6, `${total.toFixed(3)} vs ${r.summary.profit.toFixed(3)}, stop slip ${cc.stopGap.toFixed(2)}`);

  // 6. Delisting: spot stops printing.
  r = runPaired({ ...args, data: make({ spot: flat(100, 80), perp: flat(100, 100), rate: 0.0003 }) });
  check('delist haircut on spot', r.trades[0].reason === 'delisted' && r.costs.delistHaircut > 0, r.trades[0].reason);

  // 7. Trailing funding sees only events before the close.
  const f = indexFunding(fund(0.001));
  check('funding window is 21 events for 7 days', Math.abs(trailingApr(f, t0 + 30 * DAY, 7) - 0.021 * 365 / 7) < 1e-12);
  const future = indexFunding([...fund(0.001, 30), { t: t0 + 30 * DAY, rate: 9, mark: null }]);
  check('event stamped at the close is not read', trailingApr(future, t0 + 30 * DAY, 7) === trailingApr(f, t0 + 30 * DAY, 7));

  // 8. The audit passes honest code and catches a signal planted to read 5 days ahead.
  const flip = (i) => (Math.floor(i / 36) % 2 ? -0.0001 : 0.0003);
  const data = make({ spot: wave, perp: wave, rate: flip });
  const span = { data, name: 'majors', params: { entryApr: 0.1, lookbackDays: 7 }, from: t0 + 10 * DAY, to: t0 + 190 * DAY };
  const clean = auditPaired(span);
  check('audit clean on honest code', clean.ok && clean.fills > 4, `${clean.fills} fills ${JSON.stringify(clean.cuts.filter((x) => !x.ok))}`);
  const leak = auditPaired({ ...span, opts: { testLeakDays: 5 } });
  check('audit catches a planted leak', !leak.ok, `${leak.cuts.filter((x) => !x.ok).length} of ${leak.cuts.length} cuts differ`);
  console.log(bad ? `${bad} FAILED` : 'ALL PASS');
  process.exit(bad ? 1 : 0);
}

// Frozen after the results. Empty means nothing qualified.
export const FROZEN_CANDIDATES = Object.freeze([]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const commands = { selftest: cmdSelftest, carry: cmdCarry, robust: cmdRobust, events: cmdEvents, overlay: cmdOverlay, diag: cmdDiag };
  if (!commands[cmd]) { console.error('usage: r-carry.mjs selftest|carry|robust|events|overlay'); process.exit(2); }
  commands[cmd](...rest);
}
