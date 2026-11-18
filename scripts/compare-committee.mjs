#!/usr/bin/env node
/**
 * LOCAL CHANGE (agent committee, phase 2): legacy engine vs agent committee on
 * the same OKX history, same exits, sizing and costs. Three engines: legacy,
 * filter (legacy picks, committee may only block — the default role) and
 * committee (committee picks entries itself).
 *
 *   npm run compare:committee                       # account's interval, top 20 alts
 *   npm run compare:committee -- --interval 1h --days 60 --top 30
 *
 * Default history: 60 days on 1h, 240 days on 4h (so the 30% test slice
 * still holds a few hundred bars).
 *
 * Splits each series 70/30. The first 70% ("train") is where committee
 * thresholds may be tuned; the last 30% ("test") is reported as the honest
 * out-of-sample result. Re-tuning after looking at "test" turns it into
 * training data — don't.
 *
 * Committee replay has BTC context but no derivatives or order book (no
 * honest history exists for those), so it under-represents the live committee;
 * shadow mode is the real proof.
 *
 * Read-only: fetches public candles and reads AutoTradingSettings for TP/SL.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchUniverse, fetchHistoricalCandles } from '../shared/trading/marketData.js';
import { runBacktest, splitTrainTest } from '../shared/trading/backtest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const TOP = arg('top', 20);
const INTERVAL_MS = { '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

function loadSettings() {
  const file = path.join(ROOT, 'data', 'entities', 'AutoTradingSettings.json');
  if (!existsSync(file)) return {};
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(rows) && rows[0]) || {};
  } catch { return {}; }
}

const settings = loadSettings();
const ivIdx = process.argv.indexOf('--interval');
const ivArg = ivIdx > -1 ? process.argv[ivIdx + 1] : null;
const INTERVAL = INTERVAL_MS[ivArg] ? ivArg : (INTERVAL_MS[settings.candle_interval] ? settings.candle_interval : '1h');
const DAYS = arg('days', INTERVAL === '4h' ? 240 : INTERVAL === '1d' ? 720 : 60);
const base = {
  initialCapital: 10000,
  minStrength: settings.min_confidence ?? 70,
  stopLossPercent: settings.stop_loss_percent ?? 3,
  takeProfitPercent: settings.take_profit_percent ?? 8,
  maxPositions: settings.max_open_positions ?? 5,
  exchange: 'okx',
  candleIntervalMs: INTERVAL_MS[INTERVAL],
};

console.log(`Fetching ${DAYS}d of ${INTERVAL} candles for top ${TOP} alts + BTC...`);
const universe = await fetchUniverse({ topN: TOP + 10 });
// fetchUniverse already drops stablecoins, tokenised stocks and commodities.
const symbols = universe.map((u) => u.symbol).filter((s) => s !== 'BTCUSDT').slice(0, TOP);

const end = Date.now();
const start = end - DAYS * 86400e3;
const all = new Map();
for (const s of ['BTCUSDT', ...symbols]) {
  try {
    const c = await fetchHistoricalCandles(s, INTERVAL, start, end);
    if (c.length > 300) all.set(s, c);
    process.stdout.write('.');
  } catch (e) {
    process.stdout.write('x');
  }
}
console.log(` ${all.size - 1} alts loaded`);

const { train, test } = splitTrainTest(all, 0.7);
const withoutBtc = (m) => new Map([...m].filter(([s]) => s !== 'BTCUSDT'));

function run(data, engine) {
  const cfg = engine === 'legacy'
    ? base
    : { ...base, entryEngine: engine, committeeSettings: settings.committee || {} };
  // Legacy never sees BTC (an altcoin universe); committee/filter use it as context only.
  const r = runBacktest(engine === 'legacy' ? withoutBtc(data) : data, cfg);
  return r.metrics || { error: r.error };
}

const rows = [];
for (const [label, data] of [['train (first 70%)', train], ['test (last 30%)', test]]) {
  // filter = legacy picks, committee may only block (the default role).
  for (const engine of ['legacy', 'filter', 'committee']) {
    const t0 = Date.now();
    const m = run(data, engine);
    rows.push({ period: label, engine, m, secs: ((Date.now() - t0) / 1000).toFixed(0) });
  }
}

const fmt = (v, d = 2) => (v === undefined || v === null ? '-' : Number.isFinite(v) ? v.toFixed(d) : String(v));
console.log(`\n${INTERVAL} candles, TP ${base.takeProfitPercent}% / SL ${base.stopLossPercent}% / max ${base.maxPositions} positions / legacy min strength ${base.minStrength}\n`);
console.log(['period'.padEnd(18), 'engine'.padEnd(10), 'trades', 'win%', 'return%', 'PF', 'expect$', 'maxDD%', 'sharpe'].join('  '));
for (const { period, engine, m } of rows) {
  if (m.error) { console.log(period.padEnd(18), engine.padEnd(10), m.error); continue; }
  console.log([
    period.padEnd(18), engine.padEnd(10),
    String(m.totalTrades).padStart(6), fmt(m.winRate, 1).padStart(5), fmt(m.totalReturn ?? m.totalReturnPercent).padStart(7),
    fmt(m.profitFactor).padStart(4), fmt(m.expectancy).padStart(7), fmt(m.maxDrawdown).padStart(6), fmt(m.sharpeRatio).padStart(6),
  ].join('  '));
}
