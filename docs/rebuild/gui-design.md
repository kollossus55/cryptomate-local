# CryptoMate V6 GUI design

Author: `audit-gui`. Audited at commit `e711874`, branch `rebuild/v6`.
Builds on `docs/rebuild/CONTRACT.md`, which wins on any conflict.

Reconciled against the modules on disk at the last revision: `v6Risk`, `v6Exits`, `v6Exchanges`,
`v6Paper`, `v6Core`, `v6Strategies` (`STRATEGIES` was still empty). Those names are real. `v6SignalGate`,
`v6Engine`, `v6Control` and the `V6*` entities did not exist yet, so
everything touching them in sections 6 and 7 is a **proposal** their owners must confirm.
Numbers in wireframes are illustrative only.

Contents:

1. Key findings
2. Audit of the current GUI
3. Design language to reuse
4. Rules every V6 page follows
5. Views: Mission Control, Strategies, Signal Tests, Risk Controls, Exchanges
6. `v6Control` API
7. Entity usage and proposed fields
8. Navigation changes
9. Empty, loading and error states
10. Component list and build order
11. Acceptance checks
12. Issues for other owners

---

## 1. Key findings

These change how Wave 3 should build, so they come first.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **Strategy Lab and Committee read entities the client does not define.** `ENTITY_NAMES` has no `StrategyLabAccount`, `StrategyLabTrade` or `CommitteeDecision`, so `base44.entities.StrategyLabAccount` is `undefined` and `.list()` throws. By reading the code (not run in a browser), the `= []` default then turns that error into "No lab accounts yet". | `src/api/base44Client.js` `ENTITY_NAMES`; `StrategyLab.jsx:66-75`; `Committee.jsx` | Any `base44.entities.V6*` call fails the same way. V6 pages use `v6Control` only (section 6). The existing bug needs its own fix. |
| F2 | **There is no server entity allow-list**, although the contract mentions one. Any entity name is accepted, and `/api/entities` lets the browser PATCH any row. | `server/entityStore.js`, `server/index.js:351` | A direct `V6Config` PATCH would bypass `clampRiskConfig`. GUI writes must go through `v6Control`. Consider refusing browser writes to `V6*` on the server. |
| F3 | **Legacy buttons delete V6 trades.** `Trading.jsx:445` runs `Trade.deleteMany({})` (every row). `TradeHistory.jsx:37-40` deletes the newest 1000 rows of any engine. Both also reset the Portfolio. `resetTradingData` clears Trade and rewrites *every* Portfolio row without touching `v6_ledger`. | same files; `server/entityStore.js:396` | The V6 paper record can be silently destroyed, and the ledger left inconsistent. See I3. |
| F4 | **V6 and legacy share one Portfolio row, by design.** `v6Paper` has `adoptLegacyPortfolio` and `toPortfolioRecord`, as the contract says. But the legacy worker and manual trades on `Trading` write that same row. Adopted positions get `strategyId: 'legacy'`, and `stopPrice: null` unless the row had a trailing stop. | `v6Paper.js:635-750`; `Trading.jsx`; `autoTradingWorker` | Day one may **not** be flat, and may show positions with no stop. The GUI must handle both (5.1, 9.1). Concurrent writers are the risk. See I2. |
| F5 | **The legacy engine and its live path stay in the app.** `tradingScheduler` still runs every 5 minutes, and `live_trading_enabled` can be armed in the legacy flow. | `server/scheduler.js`, `LiveTradingPanel.jsx` | A banner claiming "the whole app is paper" could be false. The banner says V6 is paper and separately reports legacy live state (section 4.1). |
| F6 | **Error details are dropped on non-2xx.** `server/index.js` replies `{ error: err.message }`, so custom fields never reach the page. | `server/index.js:346` | `v6Control` returns HTTP 200 with `{ ok:false, code, error, fields }` for expected refusals. |
| F7 | **`initialData: []` and `= []` hide failure.** Only `Committee.jsx` mentions `isError` among the pages, and 22 `alert()` calls stand in for feedback. | pages listed in section 2 | V6 pages use one hook with explicit loading, error and empty branches. |
| F8 | **Some legacy alerts and charts are made from random numbers.** See section 2.3. | `Alerts.jsx:69`, `useNotificationMonitor.jsx:85,93`, `AdvancedChart.jsx`, `PredictiveModels.jsx:19` | V6 alarms must not share a surface with them without a label. Mission Control reads `V6RiskEvent`, not `Notification`. |
| F9 | **Binance is reported as geo-blocked on this server (HTTP 451)**, yet it is first in `DEFAULT_PRIORITIES`, and `AutoTrading.jsx` still says "real Binance OHLCV data". I did not test this from the box. | `marketData.js:82`; `v6Exchanges.js:617` | The Exchanges page needs a distinct `blocked` state, parsed from the `geo_blocked:` prefix of `lastError`. See I13. |
| F10 | **Some things this GUI needs are undefined:** capital sleeves, the verdict shape, per-signal rows when entries are blocked, and failed-candidate records. | section 12 | Decisions listed as I4, I6, I7, I9. |
| F11 | **Every V6 trade would show "AI Trading Signal, undefined/100 strength" in Trade History.** `toTradeRecord` sets `ai_signal: { reasoning, indicators }` with no score, and `TradeHistory.jsx:436-444` prints the badge whenever `ai_signal` exists. | `v6Paper.js:753`; `TradeHistory.jsx:444` | Branch on `exchange === 'Paper Trading (V6)'` in `TradeHistory`: "Why this trade" heading, no badge. Must ship with V6. |
| F12 | **Rung 3 can strand the engine.** `v6Risk` notes that when flat, equity cannot move, so the no-new-entries rung never recovers by itself. Only `humanReEnable` clears it. | `v6Risk.js:450` | Re-enable is needed outside a halt too. Own headline state `NEEDS_REVIEW` (5.1, 5.4). |

---

## 2. Audit of the current GUI

### 2.1 Routing and registration

- `src/pages.config.js` says it is auto-generated, but locally it is hand-edited (see the
  `LOCAL CHANGE` lines). Add an import and a `PAGES` entry by hand.
- `TradeSignals`, `AltcoinScanner` and `AISettings` are not in `PAGES`. They are hand-wired in
  `src/App.jsx`. Leave those alone.
- A route is `/<PageKey>`, and `createPageUrl(name)` returns `/${name}`.
- `Layout` receives `currentPageName`. It renders no navigation for `Home`.
- `AuthContext` shows `LockScreen` before the app when signed out, so Mission Control can
  be the post-login destination.
- Three places send users to `Trading` and must change to `MissionControl`: `Layout.jsx`
  lines 109 and 228, and `Home.jsx:21`. `Home.jsx:33,37` is the login `next` target.
- `Layout` footer says "Demo Platform with Live Trading" (rewrite in section 8.4).

### 2.2 Page inventory

"Writes" means persistent writes. Verdicts: **Keep**, **Legacy** (moved to the Legacy group
unchanged except for the banner), **Fix** (needs copy or logic changes).

| Page | Shows | Reads | Writes | Legacy-engine dependence | Verdict |
|---|---|---|---|---|---|
| `Home` | Marketing landing | auth | none | none | **Fix**: see 2.3; redirect to Mission Control |
| `Trading` (1795 lines) | Asset grid, signal badges, manual paper trades, AI recommendations, legacy panels | Portfolio, Trade, AutoTradingSettings, TradingPreferences, AISignalConfig, ExchangeConnection | Trade, Portfolio, Notification, preferences, settings; invokes `tradingScheduler`, `liveOrderExecution` | Very high: `confidence`, `recommendation`, `window.assetSignalData` | **Legacy**; most misleading page |
| `AutoTrading` (1012) | V5 engine settings and status | AutoTradingSettings, Portfolio | AutoTradingSettings | Total | **Legacy**. None of its risk settings affect V6 |
| `TradeSignals` | LLM "recommendations" with Confidence | Portfolio, TradingPreferences, AutoTradingSettings | Trade, Portfolio, Notification; invokes `aiTradingRecommendations` | High | **Legacy** |
| `AltcoinScanner` | Scan results with buy actions | ScanResult, Portfolio | Trade, Portfolio, Notification; invokes `altcoinScannerWorker` | High | **Legacy** |
| `AISignals` | Indicator composite, regime, anomaly detection | AISignalConfig | AISignalConfig | High; uses `PredictiveModels` | **Legacy** |
| `Insights` | LLM advisor on performance | Portfolio, Trade, AutoTradingSettings | AutoTradingSettings ("apply recommendation") | High | **Legacy** |
| `Backtesting` | Legacy 1h backtester | BacktestResult | BacktestResult | Runs the signal engine V6 replaced | **Legacy**. Its numbers are not V6 evidence |
| `Committee` | Shadow committee on legacy picks | CommitteeDecision, AutoTradingSettings | `committee` field only | High; broken read (F1) | **Legacy**, needs the F1 fix |
| `StrategyLab` | Two daily paper accounts vs BTC | StrategyLabAccount, StrategyLabTrade | invokes `strategyLabWorker` | Separate from main engine; broken read (F1) | **Legacy**. Best visual reference for V6 |
| `ExchangeSettings` | API key storage, OKX public feed, guides | ExchangeConnection | ExchangeConnection; `exchangeCredentials` | Live path only | **Fix**: rename in nav, add notice, correct false line (2.3) |
| `AISettings` | LLM provider and model | `aiModelConfig` | `aiModelConfig` | V6 does not use an LLM | **Legacy** |
| `Alerts` | Price alerts, notifications | PriceAlert, Notification | PriceAlert, Notification | Simulated items (F8) | **Keep in Records**, remove or label random items |
| `TradeHistory` | All trades | Trade, Portfolio | Trade (delete all), Portfolio | `ai_signal` block would print "undefined/100 strength" on V6 rows (F11). Totals mix engines, as does `PortfolioCard` win rate | **Fix**: F11, add engine filter defaulting to V6, protect reset (I3) |
| `Security` | Password, 2FA | auth | auth | none | **Keep** |
| `AdminDashboard` | Users, stats, reset | User, Trade, Portfolio, Notification | User, Portfolio, reset | Stats are legacy-shaped | **Keep** (admin only) |

Key legacy components:

| Component | Note |
|---|---|
| `PortfolioCard`, `AssetCard` | Legacy. `AssetCard` renders `{confidence}/100 Signal Strength` |
| `signalLabels.js` | Maps scores to "Very Strong Buy" (>= 88) |
| `AIRecommendationNotification` | Popup with "AI Confidence" |
| `AIAnalysisModal` | "% AI confidence" text plus chart from `AdvancedChart` |
| `SystemHealthMonitor` | Legacy indicators and scan log. Do not reuse |
| `LiveTradingPanel` | Legacy live arming. V6 never renders or calls this |
| `ConnectionStatusCard` | Key connection card. Stays in API Keys. Its status config is a useful tone reference |
| `PublicMarketData` | Browser fetches OKX directly. V6 must go through the server |
| `ResetTradingData` | **Best confirm pattern in the app** (states effects, typed word). Copy it |

### 2.3 Stale or misleading claims

| Where | Claim | Problem | Action |
|---|---|---|---|
| `Home.jsx` | "trade the top 20 cryptocurrencies with confidence", "Start Trading Smarter Today", "Indicator Intelligence" | Implies a demonstrated edge; the engine lost money in 9/9 windows on 4h | Rewrite (8.4) |
| `Home.jsx` | "Join thousands of traders", "Free forever plan" | Not true of a one-user local app | Remove |
| `Home.jsx` | "All trades are simulated", "no real money is involved", "for demonstration purposes only" | False while the live path exists | Rewrite |
| `Home.jsx` | "AI-driven anomaly detection alerts" | Some of those are random (below) | Remove |
| `AssetCard.jsx`, `Trading.jsx`, `TradeHistory.jsx:444` | "95/100 Signal Strength", "Avg Confidence", "/100 strength" | Reads as odds; it is an uncalibrated indicator score | Legacy banner now. Never reproduce in V6 |
| `signalLabels.js` | "Very Strong Buy" | Implied certainty from the same score | As above |
| `AutoTrading.jsx:501-511` | "Only execute trades with AI confidence above this level" | The value is a signal-strength score, not AI confidence. Slider runs to 95 | Legacy banner |
| `AutoTrading.jsx` | "Configure AI-powered automated trading", "Respects all risk limits" | Oversells; the risk limits did not stop losses | Legacy banner |
| `AutoTrading.jsx` | "Browser fallback if server is down" (twice) vs "Browser-side trading was removed on 2026-10-27" on the same page | Self-contradiction | Legacy banner; delete if touched |
| `AutoTrading.jsx` | "real Binance OHLCV data" | Binance removed from `marketData.js` (OKX, then Coinbase) | Legacy banner; delete if touched |
| `AutoTrading.jsx` | Low Risk tagged "Recommended" | No evidence behind the tag | Legacy banner |
| `TradeSignals.jsx`, `AIRecommendationNotification.jsx` | "Confidence", "AI Confidence", "Pred. Confidence" | AI-picked winners with implied probability | Legacy banner; disable the popup outside legacy pages (I10) |
| `AltcoinScanner`, `TradeSignals` | "Analyzing markets with AI", "technical, sentiment, and on-chain data" | `Backtesting.jsx` itself says no sentiment source is wired up. I did not verify the on-chain claim | Legacy banner |
| `Insights.jsx` | "Our advanced AI ... actionable" | Advice can write straight to live engine settings | Legacy banner |
| `Backtesting.jsx` | "same signal engine as the live bot", Win Rate front and centre | True, but that engine failed, and it has none of the V6 tests | Legacy banner |
| `ExchangeSettings.jsx:218` | "Live order execution requires backend functions (not yet enabled)", "All trading remains simulated" | **False**: `liveOrderExecution` and the arming flow exist | Replace (8.5) |
| `ExchangeSettings.jsx` | "this feed powers all charts, signals, and paper trading across the app" | Not true for V6 | Replace (8.5) |
| `Layout.jsx` footer | "Demo Platform with Live Trading" | Conflicts with the V6 story | Rewrite (8.4) |
| `Alerts.jsx:69` | Random "AI anomaly" notification | **Fabricated**: `Math.random() > 0.95` | Remove |
| `useNotificationMonitor.jsx:85,93` | "Unusual volume spike", "High volatility" | **Fabricated** from `Math.random()` | Remove |
| `AdvancedChart.jsx` | Chart inside `AIAnalysisModal` | `generateMockData()` on mount: price history shown is random | Remove or label "SIMULATED" |
| `PredictiveModels.jsx` | "LSTM" model with confidence | Not an LSTM: a formula on 24h change plus random noise | Legacy banner; remove if touched |
| `AnomalyDetection.jsx:111` | Estimated large transactions | Derived estimate from volume, not observed data (from a partial read) | Legacy banner |
| `AISettings.jsx` | `PLATFORM_MODELS` list | Base44-era list; V6 uses no LLM | Legacy banner |

Fabricated alerts are a separate class of problem. They create false alarms that could
be mistaken for V6 alarms, so removing them is not cosmetic. Those are the only edits to
legacy logic this design asks for.

---

## 3. Design language to reuse

Stack: React 18, Tailwind, shadcn components in `src/components/ui`, lucide icons,
recharts, date-fns, `@tanstack/react-query`. Dark only; no theme switch.

Base V6 on `StrategyLab.jsx` and `Committee.jsx`, which are newer and calmer than the
gradient-heavy legacy pages.

| Element | Use |
|---|---|
| App background | From `Layout`. Do not add a `min-h-screen` gradient per page |
| Page wrapper | `p-4 md:p-6 space-y-6` |
| Page title | `flex items-center gap-2 text-2xl font-bold text-slate-100` with `h-6 w-6` icon |
| Subtitle | `mt-1 max-w-3xl text-sm text-slate-400` |
| Card | `bg-slate-900/60 border-slate-800` |
| Card title | `text-base text-slate-200` in `CardHeader className="pb-2"` |
| Stat tile | `StatCard` from `StrategyLab.jsx`: label, `text-2xl font-semibold`, sub-line |
| Table | Plain `<table className="w-full text-sm">` in `overflow-x-auto`, `text-xs text-slate-400` headers, `border-t border-slate-800` rows. This is the StrategyLab pattern; `ui/table` appears in only one component |
| Money and percent | `money()`, `pct()`, `pnlCls()` from `StrategyLab.jsx`; move into `src/components/v6/format.js` |
| Tone badges | `Badge` with `bg-<c>-500/20 text-<c>-300 border-<c>-500/30` (`Committee.jsx`) |
| Active nav | `bg-indigo-600 text-white`; inactive `text-slate-400 hover:text-white hover:bg-slate-800` |
| Controls | `Switch`, `Slider`, `Select`, `Input`, `Tabs`, `Sheet`, `AlertDialog`, `Dialog`. All already in the repo |
| Available but unused | `Skeleton`, `Tooltip`, `Collapsible`, `use-toast`. `Toaster` is mounted in `App.jsx`. Use them rather than `alert()` |

Semantic tones. Each state always carries an icon and text, never colour alone.

| Tone | Means | Never use for |
|---|---|---|
| slate | In cash, idle, not applicable | |
| indigo | Holding positions, neutral info | |
| emerald | A check passed, positive P&L, venue healthy | "Good trade", "trading" |
| amber | Paper mode, shadow, reduced size, degraded | |
| red | Check failed, negative P&L, halt, alarm | **Being in cash** |

Cash is a valid result, so it is slate, never red. `TRADING` is indigo, never green,
because holding a position is not a good outcome by itself.

### Charts

Use the `StrategyLab.jsx` recharts setup: `CartesianGrid` `#334155` at 0.35 opacity, no
vertical lines, axis `#475569`, ticks `#94a3b8`, custom tooltip, `activeDot` with ring.

| Series | Colour | Line |
|---|---|---|
| V6 paper equity, forward result | `#3987e5` | solid 2px |
| BTC buy and hold | `#199e70` | dashed `6 4` |
| Second comparison, if needed | `#d95926` | solid 2px |
| Expected median | `#94a3b8` | dashed `3 3` |
| Expected band | `#64748b`, 25% opacity | area, no stroke |

The first three were validated with the dataviz script against `#0f172a`: all checks pass,
worst adjacent colourblind separation 9.4. Series colours never carry status meaning.

Rules: one Y axis only; a legend for two or more series and direct end labels; a "View as
table" toggle on each chart; label values in text colours, not series colours.

---

## 4. Rules every V6 page follows

### 4.1 Paper banner (in `Layout`, on every page except `Home`)

Sticky, full width, above page content, not dismissable.

```
+--------------------------------------------------------------------------------+
| [FlaskConical]  PAPER MODE  V6 uses virtual money. It has no way to place      |
|                 real orders.                                      Why? (link)  |
+--------------------------------------------------------------------------------+
```

Classes: `sticky top-0 z-40 bg-amber-500/15 border-b border-amber-500/40 text-amber-200`,
with "PAPER MODE" in `font-bold tracking-wide`. On mobile it sits under the top bar (which
is `sticky top-0 z-30`, so offset it with `top-16`).

- The text is **static**. It is a fact about the code, so it renders even if the API is down.
- Second row, driven by `status.legacy`. This is what stops the banner from lying (F5):

```
| [AlertTriangle] LEGACY LIVE TRADING IS ON. The old engine can place real orders |
|                 on your exchange account. This is separate from V6.  Review ->  |
```
  `bg-red-600 text-white`. Shown when `legacy.liveTradingEnabled === true`.

- Amber row when `legacy.autoTradingEnabled === true`:
  `The old auto-trader is also running on its own paper account.`
- Slate row when status failed: `Could not read the old engine's live setting.` Never
  assume it is off.
- Set `document.title` to `PAPER - <page> - CryptoMate` on V6 pages.
- Every money figure on V6 pages is labelled "Paper equity", "Paper P&L" and so on.

### 4.2 Language

Applies to all V6 UI text and to `reason` and `message` fields shown in the GUI.

Banned: guarantee, guaranteed, sure, safe bet, risk-free, proven, winning (as a promise),
confidence (for a signal), strength, accuracy, AI-picked, AI-powered, smart, strong buy,
high probability, can't lose, recommended (for a trade).

Required wording:

| Instead of | Write |
|---|---|
| Certified, as if it were a promise | "Passed its tests on past data. Past results do not predict future ones." |
| Signal passed | "Cleared all 7 tests. The trade is allowed; it may still lose." |
| Score 0.82 | Rank only, for example "Ranked 2 of 5 today". **Never show `score` as a number, percent, or /100.** The contract says it is for ranking only |
| No strategy qualified | State it plainly and calmly: "This is an expected result" |
| Backtest profit | Always "net of costs" |

Always put a sample size next to any statistic ("n = 7 trades"). Below 20 forward trades,
show "Too few trades to judge" rather than a verdict.

### 4.3 Data access

- Pages call `base44.functions.invoke('v6Control', { action, ... })` only, through the
  `useV6` hooks. **No page uses `base44.entities.V6*`.** Reasons: F1, F2, and one place to
  clamp, shape and bound data.
- No `initialData`. No `= []` defaults that hide errors.
- Numbers are not recomputed in the browser. Limits, ceilings, thresholds and venue lists
  always come from the API, so the UI cannot drift from `v6Risk` or the frozen criteria.

```js
// src/hooks/useV6.js
export class V6Refusal extends Error { /* code, fields */ }

async function callV6(action, params = {}) {
  const { data } = await base44.functions.invoke('v6Control', { action, ...params });
  if (!data?.ok) throw new V6Refusal(data?.error ?? 'Request refused', data?.code, data?.fields);
  return data;
}

export const useV6Query = (action, params, opts = {}) => useQuery({
  queryKey: ['v6', action, params ?? null],
  queryFn: () => callV6(action, params),
  placeholderData: (prev) => prev,  // keep last data on screen during a refetch
  ...opts,
});

export function useV6Mutation(action, { invalidates = ['status'] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params) => callV6(action, params),
    onSettled: () => invalidates.forEach((a) => qc.invalidateQueries({ queryKey: ['v6', a] })),
  });
}
```

Poll intervals. The engine ticks every 5 minutes, so faster polling only shows the same data.

| Action | `refetchInterval` |
|---|---|
| `status` | 30 s, shared by banner and Mission Control through the same query key |
| `equityCurve`, `decisions`, `strategies`, `signalTests`, `events` | 60 s |
| `exchanges` | 30 s |
| `riskConfig`, `strategyDetail`, `signalTest` | none (refetch on mutation) |

Set `refetchIntervalInBackground: false`.

### 4.4 Time

Show UTC, labelled, wherever a day boundary matters ("Today (UTC)"). Each page shows "Last
engine run 3 min ago". Use `date-fns`.

### 4.5 Confirmations

| Level | When | Pattern |
|---|---|---|
| None | Harmless, reversible (acknowledge alarm, reorder venues before save) | Toast after |
| `AlertDialog` | Tighten a limit, disable a strategy, disable a venue | States the effect |
| `AlertDialog` with a typed word | Flatten all, re-enable after halt | `ResetTradingData` pattern; states effects |

Writes apply on the next engine tick. Every write toast says so:
"Saved. Applies on the next engine run (within 5 minutes)."

---

## 5. Views

### 5.1 Mission Control (`/MissionControl`, `src/pages/MissionControl.jsx`)

Icon `Gauge`. Answers: what is it doing, why, and does it need me?

```
+--------------------------------------------------------------------------------+
| PAPER MODE  V6 uses virtual money. It has no way to place real orders.         |
+--------------------------------------------------------------------------------+
| Mission Control                                     Last engine run 3 min ago  |
|                                                                                |
| +----------------------------------------------------------------------------+ |
| | [CircleDot]  HOLDING 2 PAPER POSITIONS                                     | |
| | Holding 2 paper positions from 1 strategy. Open risk 0.9% of equity.       | |
| |                                               Why this state? (expandable) | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| ALARMS (shown only when any are unacknowledged)                                |
| +----------------------------------------------------------------------------+ |
| | [!] critical  09:15 UTC  Price data stale on Kraken. New entries off,      | |
| |                          exits continue on last good price.  [Acknowledge] | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-----------------+ +-----------------+ +-----------------+ +----------------+ |
| | Paper equity    | | Vs BTC hold     | | Drawdown        | | Exposure       | |
| | $10,412         | | -3.1 pts        | | -3.2% from peak | | 34% / 100%     | |
| | +4.1% all time  | | since 12 Nov    | | Worst -6.0%     | | Open risk 0.9% | |
| +-----------------+ +-----------------+ +-----------------+ +----------------+ |
|                                                                                |
| +-- Paper equity vs BTC, both start at 100 ---------- [7D][30D][90D][All] ----+ |
| | 108 |                ____/---- BTC hold (dashed)                           | |
| | 104 |        _______/   ___/---- V6 paper                                  | |
| | 100 |_______/__________/                                                   | |
| |     +-------------------------------------------------------               | |
| |  Flat stretches are time in cash.                       [View as table]    | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Drawdown ladder ---------------------------------------------------------+ |
| |   0%         -5%         -10%        -15%        -20%                      | |
| |   |-----*-----|-----------|-----------|-----------|                        | |
| |   Full size   Half size   Quarter     No entries  Flatten + halt           | |
| |   Now: -3.2%. Full size. 1.8 points until size halves.                     | |
| |   Daily loss -0.4% of -2%    Weekly -1.1% of -4%                           | |
| |   BTC 24h -1.2% of -8%       BTC 7d -3.0% of -15%                          | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Open positions (2) ------------------------------------------------------+ |
| | Coin Strategy     Qty   Entry   Now     Paper P&L    Stop    To stop  Risk | |
| | ETH  tsmom_majors 0.52  3,120   3,204   +$44 (+0.5R) 2,990   -6.7%   $68  | |
| |      next: trail 3,010 | time stop in 11 bars                          [v] | |
| | BTC  tsmom_majors 0.01  96,000  95,100  -$9  (-0.2R) 91,500  -3.8%   $45  | |
| |      next: break-even at +1R (100,500)                                 [v] | |
| |                                                                            | |
| |  Expanded ETH exit plan (profile: trend)                                   | |
| |   Hard stop      2,950   armed    set at entry, never moves down           | |
| |   Break-even     3,290   waiting  moves stop to entry after +1R            | |
| |   Chandelier     3,010   active   trail, 4x ATR under the high             | |
| |   Time stop      11 bars armed    closes if it has not worked              | |
| |   Signal exit    -       armed    closes if strategy goes flat             | |
| |   Regime exit    -       armed    closes if regime turns off               | |
| |   Partial profit -       off      not used in this profile                 | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Today's decisions (UTC) ------------ [All][Entries][Exits][Blocked] ------+ |
| | 16:05 ENTERED  ETH long  tsmom_majors. Cleared all 7 tests.  Trend up...   | |
| | 16:05 BLOCKED  SOL long  tsmom_majors. Failed Liquidity: spread 0.31%...   | |
| | 16:05 SHADOW   BTC long  mean_rev_v1. Logged only, no paper position.      | |
| | 11:20 EXIT     XRP       stop hit at 0.5812, -1.0R.                        | |
| |                                                       All signal tests ->  | |
| +----------------------------------------------------------------------------+ |
+--------------------------------------------------------------------------------+
```

**Headline.** The server derives `status.headline`, so the wording and precedence are
tested in one place. First matching row wins.

| # | `state` | Condition | Title | Line | Tone |
|---|---|---|---|---|---|
| 1 | `ENGINE_DOWN` | Last tick older than 15 min, or never ran | ENGINE NOT RUNNING | "Last run was 22 min ago. Stops are not being checked." | red |
| 2 | `HALTED` | Ladder halt or flatten active | HALTED | "Halted at -20.4% drawdown. Positions flattened. Needs your review in Risk Controls." | red |
| 3 | `PAUSED` | `halt.active`, `source: 'manual'`, not flattening | PAUSED BY YOU | "You paused new entries at 14:02 UTC. 2 positions are still managed by their exit plans." | amber |
| 4 | `NEEDS_REVIEW` | `rung === 3` and no open positions (F12) | NEEDS YOUR REVIEW | "No new entries at -15.3% drawdown, and with no positions this cannot recover by itself. Review in Risk Controls." | amber |
| 5 | `NO_CERTIFIED` | No strategy in a paper state | IN CASH | "In cash: no strategy has passed certification, so nothing is allowed to trade." | slate |
| 6 | `ENTRIES_BLOCKED` | `canEnter` is false | NO NEW ENTRIES | "No new entries: BTC -9.1% in 24h (market breaker). 2 positions still managed." | amber |
| 7 | `HOLDING` | One or more open positions | HOLDING N PAPER POSITIONS | "Holding 2 paper positions from 1 strategy. Open risk 0.9% of equity." | indigo |
| 8 | `WAITING` | Certified, no positions | IN CASH | "In cash: 1 strategy active, no signal cleared all 7 tests today. Last block: SOL, Liquidity." | slate |

`NO_CERTIFIED` sits above `ENTRIES_BLOCKED` on purpose. A fresh risk state has
`market.ok: false` and `data.ok: false` until the first update, so `canEnter` is false on
day one. The real reason for being in cash is still that nothing is certified; any
breaker goes in `reasons[]`.

`NO_CERTIFIED` with open positions (after a demotion, or adopted from the old engine) must
not say "In cash". Title becomes `CLOSING N POSITIONS`, line "No certified strategy. 1
position closing under its exit plan." With shadows, add "2 running in shadow, logging only".

`canEnter().reasons` to text. `v6Control` maps these; raw codes never reach the screen.

| Code | Text |
|---|---|
| `halted` | Halted (shows source and reason) |
| `input_fault` | The engine got inputs it could not trust |
| `drawdown_no_entries` | Drawdown past the no-entries level |
| `daily_loss_limit` / `weekly_loss_limit` | Daily / weekly loss limit reached |
| `market_breaker` | BTC fell past the market breaker |
| `market_data_unknown` | BTC history not available yet, so the breaker cannot be checked |
| `data_unhealthy` | Too few healthy price sources |
| `risk_state_invalid` | Stored risk state could not be read |

`halt.source: 'fail_safe'` (unreadable state) renders as `HALTED` with "Stored risk state could
not be read. Halted until you re-enable." The peak is unknown, so do not show a drawdown figure.

"Why this state?" expands `headline.reasons[]`, for example each strategy and what stopped
it, with links. When `ENGINE_DOWN`, numbers stay on screen with a "stale" badge.

**Vs BTC tile.** Shows the difference in percentage points since V6 started. The tile is
neutral text with a sign, and it must show when V6 is behind. BTC uses no fees, as in Strategy Lab.

**Ladder.** Plain divs, not a chart. Marker at current drawdown; active rung has text label.
All thresholds come from `status.risk.ladder`, so the rungs follow any tightened values.

**Positions.** Sort by distance to stop, closest first. To-stop column is `text-amber-300`
under 2% with a text flag "near stop". If a price is stale, show a "stale" badge and "last
good price 12 min ago". Short positions read the same way with signs flipped. Perp
positions show `instrument` and funding paid or received.

Exit plan rows are built from `position.exitPlan` (`createExitPlan`): `hardStopPrice`,
`breakEvenPrice`, `trail`, `timeStop`, `signalExit`, `regimeExit`, `partials`. Disabled parts
show "off". Non-empty `exitPlan.warnings` (for example `no_stop_given`) show under the plan.

**Adopted positions.** A position with `strategyId: 'legacy'` shows the strategy as
"Adopted from old engine". If `stopPrice` is null, the Stop column shows a red "NO STOP" with
an icon, it sorts first, and a critical alarm stands until the engine assigns one. Never
render a blank or a zero distance for a missing stop.

**Alarms.** From `V6RiskEvent`, severity `warning` or `critical`, unacknowledged. Critical
alarms stay until the condition clears, even if acknowledged.

### 5.2 Strategies (`/Strategies`, `src/pages/Strategies.jsx`)

Icon `Layers`. Named to stay distinct from legacy "Strategy Lab".

List:

```
+--------------------------------------------------------------------------------+
| Strategies                                                                     |
| A strategy can only trade after passing fixed tests on past data, net of       |
| costs. Passing does not predict future results. You cannot promote one by hand.|
|                                                                                |
| 1 paper | 1 shadow | 4 failed | Tested 212 parameter sets across all research  |
|                                                                                |
| Strategy         State        Tests     Forward     Sleeve  Entries            |
| ---------------------------------------------------------------------------    |
| TS momentum      PAPER (HALF) 12 of 12  7 of 20     50%     [on ]        [>]   |
|   tsmom_majors   1d           trades, within range                             |
| Mean reversion   SHADOW       9 of 12   Demoted     -       logging only [>]   |
|   mean_rev_v1    1d           14 Nov: drift breach                             |
| Vol breakout     FAILED       5 of 8    Not run     -       -            [>]   |
|   vol_break_v2   4h           failed D1, D2, D5 (holdout not used)             |
+--------------------------------------------------------------------------------+
```

Detail, opened in-page at `/Strategies?id=tsmom_majors`:

```
+--------------------------------------------------------------------------------+
| < All strategies     TS momentum  v1  1d  tsmom_majors                         |
| Plain rule text from the registry.                                             |
|                                                                                |
| research --> certified --> [paper (half)] --> paper (full)                     |
|                                   \--> shadow on drift breach (automatic)      |
| Half risk until 20 forward trades complete: 7 of 20  [=======-----------]      |
|                                                                                |
| +-- Controls ---------------------------+ +-- Certificate --------------------+|
| | Allow new entries        [on ]        | | Issued 12 Nov 2026   Valid         ||
| | Capital sleeve  [----*-----] 50%      | | Hash a91f...c02, matches code      ||
| | Size multiplier 0.5 (half risk)       | | Trial count 212 (global)           ||
| | Off blocks entries only. Open         | | Holdout: clean                     ||
| | positions keep their exit plans.      | | Passed on past data, net of costs. ||
| +---------------------------------------+ +------------------------------------+|
|                                                                                |
| +-- Evidence: DEV (walk-forward, net of costs) ------------------------------+ |
| |    Test                         Needs             Result           Pass    | |
| | D1 Sharpe, CI lower bound       >= 0.8, > 0       1.02, CI 0.21    [ok]    | |
| | D2 Deflated Sharpe probability  >= 0.90           0.93             [ok]    | |
| | D3 Max drawdown                 <= 30%            24.1%            [ok]    | |
| | D4 Closed trades                >= 100            143              [ok]    | |
| | D5 Profitable at 2x costs       > 0               +31%             [ok]    | |
| | D6 Parameter plateau            all >= 50%        worst 62%        [ok]    | |
| | D7 Concentration                coin <= 35%,      coin 22%,        [ok]    | |
| |                                 year <= 60%       year 48%                 | |
| | D8 Beats same-universe hold     Calmar or Sharpe  Calmar 1.1 v 0.6 [ok]    | |
| +-- Evidence: HOLDOUT (one shot, frozen parameters) -------------------------+ |
| | H1 Sharpe                       >= 0.5            0.71             [ok]    | |
| | H2 Max drawdown                 <= 25%            18.3%            [ok]    | |
| | H3 Total return                 > 0               +22%             [ok]    | |
| | H4 Drawdown smaller than BTC    < BTC             18.3% v 41%      [ok]    | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Forward result vs what the backtest expected ----------------------------+ |
| | +12% |                         .......... 95th percentile (band)           | |
| |  +6% |        ____/--- forward paper result                                | |
| |   0% |______/.....------- expected median (dashed)                         | |
| |  -6% |              .......... 5th percentile (band)                       | |
| |      +---------------------------------------------- trades completed      | |
| | Within expected range. n = 7, too few trades to judge.     [View as table] | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| Recent trades (Trade rows)         Recent signal tests -> (Signal Tests filter)|
+--------------------------------------------------------------------------------+
```

**Lifecycle badges.** `research` slate, `certified` indigo, `paper_half` and `paper_full`
amber with "PAPER", `shadow` amber with "SHADOW, no positions". `FAILED` is a slate label
for a research strategy whose latest certificate failed; the lifecycle stays `research`.

**Controls by state:**

| State | Switch label | Effect |
|---|---|---|
| `paper_half`, `paper_full`, `certified` | Allow new entries | Off blocks entries; exits continue |
| `shadow` | Log shadow signals | Logging only. Cannot create a position |
| `research` | none | Text: "Not certified, cannot trade" |

There is **no promote button and no "ignore drift" button**. Lifecycle moves only by
certificate and drift monitor. The contract gives no path from `shadow` back to `paper`
(see I8), so the GUI offers none. No control anywhere leads to live trading.

**Turning entries off** shows an `AlertDialog` that says open positions stay under their
exit plans, with an unchecked option "Also close this strategy's open positions at the
next engine run".

**Sleeve.** Slider 0 to 100, step 5. The sum across strategies may not exceed 100, and
`maxSleevePct` shows how much remains. See I4.

**Evidence.** Rows come from `certificate.criteria[]`, not hard-coded, because criteria are
frozen in the contract. A failed row is red with an `X` icon and text, and shows both the
needed and actual value. `not_run` rows show a dash and "Not run", for example H-rows
of a strategy that failed DEV. Never show a blank as a pass.

**Holdout caveat.** When `holdoutClean === false`, an amber note under the holdout header
says: "Earlier research already looked at this period, so this holdout result is not a
clean test." It is mandatory for the two legacy Strategy Lab rules, per the contract.

**Drift chart.** X axis is forward trades completed, or days for slow allocators. Y axis
is cumulative net return percent. A breach gets a `ReferenceDot` with an icon and text label.
Under two points, show "The chart starts after the first forward trade closes."

### 5.3 Signal Tests (`/SignalTests`, `src/pages/SignalTests.jsx`)

Icon `ListChecks`. The "proof tested before trading" page.

```
+--------------------------------------------------------------------------------+
| Signal Tests                                                                   |
| Every entry must clear all 7 tests. Clearing them means the trade is allowed.  |
| It may still lose.                                                             |
|                                                                                |
| [Last 7 days v] [All strategies v] [All coins v] [All outcomes v]              |
| [Any failed test v]                                                 [Clear]    |
|                                                                                |
| 214 tested | 9 entered | 141 blocked | 52 shadow | 12 not tested               |
| Most common block: Liquidity (63)                                              |
|                                                                                |
| Time (UTC)   Coin Strategy     Result  CERT DRIFT DATA REPLAY LIQ HIST RISK     |
| ----------------------------------------------------------------------------   |
| 16 Nov 16:05 ETH  tsmom_majors ENTERED  ok   ok    ok   ok    ok  ok   ok   [>] |
| 16 Nov 16:05 SOL  tsmom_majors BLOCKED  ok   ok    ok   ok    X   ok   -    [>] |
|   Liquidity: spread 0.31% is above the 0.20% budget                            |
| 16 Nov 16:05 BTC  mean_rev_v1  SHADOW   X    ok    ok   ok    ok  ok   ok   [>] |
|   Certificate: strategy is in shadow, logged only                              |
| 15 Nov 16:05 ADA  tsmom_majors NOT TESTED -  -     -    -     -   -    -    [>] |
|   Not tested: new entries were off (drawdown -15.2%)                           |
|                                                         [Load more]            |
+--------------------------------------------------------------------------------+
```

Check cells use a lucide icon plus an accessible label: `Check` emerald, `X` red, `Minus`
slate for `not_run`. A `not_run` must never render like a pass. On phones, the seven
columns collapse to "6 of 7 passed, failed Liquidity".

Clicking a row opens a right-side `Sheet`:

```
+------------------------------------------------------+
| SOL long  tsmom_majors                  BLOCKED      |
| 16 Nov 16:05 UTC, decided on the 1d bar closed 16:00 |
| Why it wanted to trade: 100-day trend up ...         |
| Ranked 2 of 5 today                                  |
|                                                      |
| BLOCKED BY Liquidity                                 |
| Spread 0.31% is above the 0.20% budget.              |
|                                                      |
| 1 Certificate      [ok]  a91f...c02 matches code     |
| 2 Forward drift    [ok]  inside band, n = 7          |
| 3 Data             [ok]  bar age 5 min, 0 gaps,      |
|                          3 venues, spread 0.04%      |
|                          (limit 0.50%)               |
| 4 Cross-venue      [ok]  Coinbase replay agrees      |
| 5 Liquidity        [X]   spread 0.31% (limit 0.20%)  |
|                          depth $41k for $2.0k order  |
|                          cost 0.42% (budget 0.30%)   |
| 6 Historical       [ok]  expectancy +0.12R net,      |
|                          n = 38 on DEV               |
| 7 Risk             [-]   Not run: blocked earlier    |
|                                                      |
| Stop 6.2% below entry. Profile: trend.               |
| Open position / Trade -> (if entered)                |
+------------------------------------------------------+
```

Filters map to `signalTests` params and are kept in the URL (`useSearchParams`) so a link
from Mission Control or Strategies can open a filtered view, for example
`/SignalTests?strategy=tsmom_majors&outcome=blocked`.

A low `n` on test 6 gets a "small sample" note. The check result stays as reported.

**Outcomes, from the order in `v6Core.step`:**

| Outcome | Comes from | Display |
|---|---|---|
| `entered` | Intent created | All 7 checks shown |
| `blocked` | `gate.check` refused | Failed check and values |
| `rejected` | `entry_rejected` with code `not_in_universe`, `no_stop`, `short_on_spot`, `no_price`, or `sizing` | "Rejected before the tests: no price" or, for `sizing`, "Passed the tests, then sizing refused it: ..." |
| `shadow` | Strategy in shadow | Logged only |
| `not_tested` | `entries_blocked` (`canEnter` false) | "Not tested: new entries were off" plus the reason |

Add a `rejected` count to the summary row and the outcome filter. A `not_tested` entry may
be one row per strategy with a count rather than per coin; see I7.

### 5.4 Risk Controls (`/RiskControls`, `src/pages/RiskControls.jsx`)

Icon `ShieldAlert`.

```
+--------------------------------------------------------------------------------+
| Risk Controls                                                                  |
| Limits for V6 only. The old Auto-Trading settings have no effect here.         |
|                                                                                |
| +-- Current state -----------------------------------------------------------+ |
| | [ok] Entries allowed. Full size. Drawdown -3.2%.                           | |
| |                                  [Pause new entries]   [Flatten all paper] | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Per trade ---------------------------------------------------------------+ |
| | Risk per trade (?)     [ 0.50 ] %    Default 0.5   Allowed 0.05 to 1       | |
| | Max position           [ 20   ] %    Default 20    Allowed 1 to 25         | |
| +-- Portfolio ---------------------------------------------------------------+ |
| | Open risk              [ 3.0  ] %    Default 3     Allowed 0.5 to 5        | |
| | Gross exposure         [ 100  ] %    Default 100   Allowed 10 to 100       | |
| | Volatility target      [ 18   ] %    Default 18    Allowed 5 to 20         | |
| | Cluster cap            [ 40   ] %    Default 40    Allowed 5 to 50         | |
| +-- Drawdown ladder (from equity high) --------------------------------------+ |
| | Half size at           [ -5   ] %    Quarter size at  [ -10 ] %            | |
| | No new entries at      [ -15  ] %    Flatten + halt   [ -20 ] %            | |
| +-- Loss limits and market breaker ------------------------------------------+ |
| | Daily loss [ -2 ] %   Weekly loss [ -4 ] %                                 | |
| | BTC 24h    [ -8 ] %   BTC 7d      [ -15 ] %                                | |
| +-- Advanced (collapsed) ----------------------------------------------------+ |
| | Correlation grouping, recovery bands, breaker cooldown, venues, stop range | |
| +-- Fixed (not editable) ----------------------------------------------------+ |
| | Leverage on spot: none. Exits are never blocked. A stop is always required.| |
| | Stale or disagreeing data: no new entries, exits continue.                 | |
| | Cost assumptions: fee 0.10%, slippage 0.25%, stop gap slip 0.10%.          | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
|  2 unsaved changes                  [Reset to defaults] [Discard] [Save...]    |
|                                                                                |
| +-- Recent changes and events -----------------------------------------------+ |
| | 14 Nov 10:02 You changed risk per trade 0.50 -> 0.40                       | |
| | 12 Nov 16:05 Ladder moved to half size at -5.1%                            | |
| +----------------------------------------------------------------------------+ |
+--------------------------------------------------------------------------------+
```

**Limits.** These are the real keys, defaults and allowed ranges from `DEFAULT_RISK_CONFIG` and
`HARD_CEILINGS` in `v6Risk.js`, shown here for reference only. The page renders them from
`riskConfig`, so it follows any change in the module. The engine stores positive fractions
(`0.05`); the page shows percents, and loss levels with a minus sign.

| Key | Label | Default | Allowed | Help text |
|---|---|---|---|---|
| `riskPerTradePct` | Risk per trade | 0.5% | 0.05-1% | How much of your paper equity you lose if one trade hits its stop. |
| `maxOpenRiskPct` | Open risk | 3% | 0.5-5% | Total you would lose if every open position hit its stop at once. |
| `maxPositionPct` | Max position | 20% | 1-25% | The largest single position, as a share of equity. |
| `maxGrossExposurePct` | Gross exposure | 100% | 10-100% | Total value of all positions as a share of equity. 100% means no leverage. |
| `volTargetAnnual` | Volatility target | 18% a year | 5-20% | Positions are scaled so the portfolio moves about this much per year. A target, not a promise. |
| `maxClusterPct` | Correlated cluster cap | 40% | 5-50% | Coins that move together count as a group. This caps that group. |
| `ladderHalfPct` | Half size at | -5% | -1 to -7.5% | Falling this far from the equity high halves new position sizes. |
| `ladderQuarterPct` | Quarter size at | -10% | -2 to -12.5% | New positions drop to a quarter of normal size. |
| `ladderNoEntryPct` | No new entries at | -15% | -3 to -17.5% | Stops new entries. Open positions keep their exit plans. |
| `ladderHaltPct` | Flatten and halt at | -20% | -4 to -20% | Closes everything and stops until you re-enable it here. |
| `dailyLossPct` | Daily loss | -2% | -0.5 to -3% | No new entries until the next UTC day. |
| `weeklyLossPct` | Weekly loss | -4% | -1 to -6% | No new entries until the next UTC week. |
| `btcDrop24hPct` | BTC 24h breaker | -8% | -3 to -10% | A BTC fall this big stops new entries and tightens trails. |
| `btcDrop7dPct` | BTC 7d breaker | -15% | -5 to -20% | Same, over seven days. |

Advanced group, collapsed by default:

| Key | Label | Default | Allowed | Help text |
|---|---|---|---|---|
| `clusterCorrelation` | Correlation that forms a cluster | 0.70 | 0.50-0.90 | Coins correlated above this count as one group. |
| `assumedVolAnnual` | Assumed volatility | 100% | 80-300% | Used when a coin's volatility cannot be measured. |
| `ladderRecoveryPct` | Ladder recovery band | 1% | 0.5-3% | Drawdown must improve this far past a rung before size comes back. Stops flip-flopping. |
| `marketRecoveryPct` | Market recovery band | 1% | 0.5-2% | How far past the breaker level BTC must recover. |
| `marketCooldownHours` | Breaker cooldown | 24 h | 6-72 h | Minimum wait after the market breaker trips. |
| `minHealthyVenues` | Healthy venues needed | 2 | 2-5 | Fewer healthy price sources than this stops new entries. |
| `minNotional` | Smallest order | $25 | $10-1,000 | Orders below this are skipped. |
| `minStopDistancePct` | Tightest stop | 0.5% | 0.2-2% | Signals with a closer stop are refused. |
| `maxStopDistancePct` | Widest stop | 25% | 5-30% | Signals with a wider stop are refused. |

`defaultFeePct`, `defaultSlipPct` and `stopGapSlipPct` can only be raised above the contract's
cost model. Show them as read-only text. Backtests were judged on those costs.

Reward:risk minimums belong to the exit profile (`trend` 2, `swing` 1.5, `revert` 1), not this
form. Show them read-only under "Fixed". If `v6SignalGate` exposes test thresholds, add a
read-only "Test thresholds" group.

**Editing rules:**

- Client validation mirrors the server, but the server decides.
- `clampRiskConfig` **silently** clamps, drops unknown keys, and pushes ladder rungs down to
  keep them at least 1 point apart. It also caps `dailyLossPct` at `weeklyLossPct` and
  `ladderRecoveryPct` at half of `ladderHalfPct`. So `setRiskConfig` must run the clamp, compare
  the result with what was submitted, and refuse any difference with `fields` naming the
  value that would really apply. The user must never save one number and get another.
- A proposed rule, for the coordinator to accept: **while the ladder is on the quarter-size
  rung or worse, or halted, changes that loosen a limit are refused** (`LOOSEN_BLOCKED`). This
  stops the limits moving during a drawdown. Tightening is always allowed. Direction comes from
  `meta.looser`, because it differs by key (lower is looser for `minHealthyVenues`).
- Save opens an `AlertDialog` listing old to new values, flagged tighter or looser.

**How controls map to `v6Risk`.** `v6Control` records a request in `V6Config`; `v6Engine` applies
it at the start of its next tick, so risk state keeps a single writer. A pause can therefore
take up to 5 minutes, which the page says. `by` is the signed-in user.

| Button | Request | Engine calls |
|---|---|---|
| Pause new entries | `pauseEntries` | `manualHalt({ flatten: false })` |
| Flatten all paper | `flattenAll` | `manualHalt({ flatten: true })` |
| Resume, Re-enable | `reenable` | `humanReEnable({ confirm: true, by, equity })` |

There is no separate resume: a manual halt can only be cleared by `humanReEnable`.

**Pause.** Asks for a reason. The button then changes to "Resume new entries". Exits continue.
On rungs 0 to 2 resuming keeps the equity high, so it needs only an `AlertDialog`. If the ladder
has reached rung 3 or 4 in the meantime, `willRebase` is true and the full flow below applies.

**Flatten.** `AlertDialog` with typed word `FLATTEN`. Lists each position and paper P&L. The page
then shows "Flatten requested, closing at next engine run (within 5 minutes)". The halt stops the
engine reopening them, and only a re-enable clears it.

**Halt and re-enable flow:**

```
 RUNNING
    | drawdown reaches -20%            (engine, automatic)
    v
 HALTED, flattening  --- exits fill at next tick(s) ---> HALTED, flat
                                                            |
           Risk Controls shows red panel:                   |
           what happened, peak, equity, loss, time          |
                                                            v
                                 [Review and re-enable...]  (enabled only if
                                  preconditions are all met)
                                                            |
                         Dialog: review + note + type RE-ENABLE
                                                            v
                                     RUNNING, next engine run, peak rebased
```

```
+-- HALTED ---------------------------------------------------------------------+
| Flatten and halt triggered 15 Nov 09:20 UTC at -20.4% drawdown.                |
| Peak $12,010 -> equity $9,560. Paper loss from peak $2,450.                    |
|                                                                                |
| Before re-enabling:                                                            |
| [ok] Flatten finished: no positions left to close                              |
| [ok] Engine running (last run 2 min ago)                                       |
| Info: 3 venues healthy. Entries also need healthy data after re-enabling.      |
|                                                                                |
|                                                 [Review and re-enable...]      |
+--------------------------------------------------------------------------------+

+-- Re-enable V6 paper trading --------------------------------------------------+
| This does not fix whatever caused the loss. It lets V6 open paper positions    |
| again under the same rules.                                                    |
|                                                                                |
| - The equity high resets to $9,560, so the ladder restarts from there.         |
|   Without this it would halt again immediately.                                |
| - That gives V6 a fresh 20% allowance on top of the loss so far. Your account  |
|   could fall a further 20% from here before the next halt.                     |
| - The chart and worst-drawdown record still show the old high.                 |
| - Daily, weekly, market and data blocks are not cleared by this.               |
| - Strategies keep their current lifecycle state.                               |
|                                                                                |
| Why are you re-enabling? (required)                                            |
| [______________________________________________________]                       |
|                                                                                |
| Type RE-ENABLE to confirm  [__________]             [Cancel] [Re-enable]       |
+--------------------------------------------------------------------------------+
```

The server re-checks the preconditions and writes an audit event. The engine then calls
`humanReEnable`, and if that refuses at the tick it raises a critical event with the reason.
No auto-resume. Daily and weekly limits and the market breaker clear on their own, with a
countdown or condition shown; they need no human action.

Facts from `humanReEnable` that this flow depends on:

- The rebase is decided by the module, not the GUI: `rung >= 3` rebases, lower rungs keep the
  high so a pause cannot be used to shed reduced size. `status` exposes it as
  `risk.reenable.willRebase`. The dialog text above applies only when it is true.
- It clears `rung === 3` too. For `NEEDS_REVIEW` (F12) show the same panel in amber, titled
  "No new entries, and cannot recover by itself".
- Preconditions when `willRebase` is true: no positions open and no flatten pending. A paused
  book on rung 0 to 2 may hold positions.
- It overwrites `equityHigh`, so `worstDrawdownPct` must come from `V6EquityPoint`, not risk state.

### 5.5 Exchanges (`/Exchanges`, `src/pages/Exchanges.jsx`)

Icon `Network`. Public market data only. The venue list comes from `EXCHANGES`, which has
eight: binance, okx, bybit, kraken, coinbase, kucoin, gate, bitget. The wireframe shows four.

```
+--------------------------------------------------------------------------------+
| Exchanges                                                                      |
| Where V6 gets prices. Public data only: no API keys, no orders, no account     |
| access.                                                                        |
|                                                                                |
| [ok] 3 of 4 enabled venues healthy. Price checks need at least 2.              |
|                                                                                |
| Pri Venue    On    Health     Latency  Last OK   Last error        Role    Test |
| ---------------------------------------------------------------------------    |
| [^v] 1 OKX    [on]  [ok] OK    142 ms   1m ago    -                 Primary [Test]|
| [^v] 2 Coinbase [on] [ok] OK   188 ms   1m ago    -                 Replay  [Test]|
| [^v] 3 Kraken [on]  [!] Slow   1,204 ms 2m ago    timeout 09:12     Check   [Test]|
| [^v] 4 Binance [off][x] Blocked -       never     HTTP 451 (region) None    [Test]|
|                                                                                |
|  Test result, OKX: ticker OK 121 ms, bars OK 164 ms (last closed 16:00),       |
|  book OK 133 ms.  Tested 10:02:14 UTC.                                         |
|                                                          [Discard] [Save order]|
|                                                                                |
| +-- Which venue does what ---------------------------------------------------+ |
| | Bars for signals             OKX, then failover to Coinbase                | |
| | Cross-venue replay (test 4)  Coinbase                                      | |
| | Price consensus (test 3)     OKX, Coinbase, Kraken                         | |
| | Order book, liquidity (5)    OKX                                           | |
| | Paper fills                  Simulated from the book above, no real order  | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Price agreement (consensus) ---------------------------------------------+ |
| | Coin   Consensus  OKX     Coinbase  Kraken   Spread  Limit   Status         | |
| | BTC    95,102     95,100  95,110    95,098   0.01%   0.50%   [ok] Agree     | |
| | ETH    3,204      3,204   3,205     3,290    0.03%   0.50%   [!] Kraken out | |
| | SOL    182.40     182.40  184.10    -        0.93%   0.50%   [x] Disagree   | |
| | Disagreeing or stale data stops new entries. Exits continue.               | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-- Exchange API keys: LIVE TRADING ONLY, NOT USED BY V6 ---------------------+ |
| | [KeyRound] Keys stored for the old engine's live trading. V6 never reads    | |
| | them and does not need them. Adding keys here does not improve V6.          | |
| |                                                   Manage API keys (legacy) ->| |
| +----------------------------------------------------------------------------+ |
+--------------------------------------------------------------------------------+
```

- The key card is visually separate (dashed `border-slate-700`, no shared table) and shows
  **no key data**. This page never reads `ExchangeConnection`.
- Priority uses up and down buttons, not drag and drop, for keyboard use. Changes are
  staged until Save. One order is enough: `createMarketHub` accepts `priorities` as a plain
  array and applies it to `bars`, `ticker` and `book`. Per-job order stays out of the GUI.
- **Disabling.** Refused for the last enabled venue (`MIN_VENUES`): exits need a price
  source. Dropping below 2 is allowed, but the dialog warns "Tests 3 and 4 will fail, so
  new entries stop".
- **Health states.** `v6Control` derives these from `hub.health()`, first match wins:

  | State | Rule |
  |---|---|
  | `disabled` | Not enabled in config |
  | `unknown` | `lastOk` is null and no error. `hub.health()` reports `ok: true` for an untried venue, so do not trust `ok` alone |
  | `blocked` | `lastError` starts `geo_blocked:` (403 or 451, 30 min cooldown) |
  | `rate_limited` | `lastError` starts `rate_limited:` (429 or 418) and `retryInMs > 0` |
  | `error` | `breaker` is `open`. Show "retry in 42 s" from `retryInMs` |
  | `recovering` | `breaker` is `half_open` |
  | `slow` | `latencyMs` above the warn level |
  | `ok` | Otherwise |

- **Consensus reasons.** From `consensusPrice`: `outlier_excluded` (still ok, names the venue,
  amber), `venues_disagree`, `no_majority`, `insufficient_venues` (all red). With exactly two
  venues a split cannot be attributed, so say "2 venues disagree" and name neither. `pegAlarm`
  raises a warning that USDT is off its peg.
- **Test button.** Server-side public `ticker`, `bars`, `book` for BTC, with `{ venue }`.
  Rate limited to one call per venue per 15 seconds (contract rule 8), with the button
  disabled for that time. It must respect the engine's backoff. Hub breakers live in memory
  per `createMarketHub`, so a hub created inside `v6Control` would not know about them.
  Either share one hub instance, or refuse with `RATE_LIMITED` when `V6ExchangeHealth` shows
  a retry time still ahead (I13).
- `Slow` threshold comes from the API (`latencyWarnMs`).

---

## 6. `v6Control` API

`base44/functions/v6Control/entry.ts`, invoked as
`base44.functions.invoke('v6Control', { action, ...params })`.

Rules:

- `export default async function (req)`, with the admin check from `strategyLabWorker`.
- Imports from `./shared/` only. **Must not** import `liveOrderExecution`,
  `executeApprovedTrade`, `liveTradingControl` or `okxExchange`, must not read
  `ExchangeConnection`, and calls no signed endpoints.
- Only `testExchange` and `consensus` touch the network, through `v6Exchanges`.
- `v6Control` never moves money. It writes config and requests. The engine alone changes
  positions and the ledger, so flatten and close requests are flags that it consumes.
- Reads are bounded: every list has a server-side default and max `limit`.
- Each write creates a `V6RiskEvent` with `type: 'operator_change'`, `before`, `after`.

**Envelope (HTTP 200, per F6):**

```js
{ ok: true, asOf: 1794000000000, ...result }
{ ok: false, code: 'ABOVE_CEILING', error: 'Plain English message',
  fields: { riskPerTradePct: 'Ceiling is 1%' } }
```

Non-2xx is reserved for unexpected faults: 401 (not signed in, from the server), 403, 404
(function missing), 500.

Codes: `UNKNOWN_ACTION`, `BAD_REQUEST`, `ABOVE_CEILING`, `LOOSEN_BLOCKED`, `VERSION_CONFLICT`,
`CONFIRM_MISMATCH`, `PRECONDITION_FAILED`, `NOT_HALTED`, `NOT_ALLOWED_IN_STATE`,
`SLEEVE_OVER_100`, `MIN_VENUES`, `RATE_LIMITED`, `NOT_FOUND`.

Times are epoch ms UTC. Percentages in `status` are display numbers (`-3.2` means -3.2%). The
exception is `riskConfig` and `setRiskConfig`, which use the engine's positive fractions
(`0.05`); `meta` says how to display them.

### 6.1 Read actions

**`status`** (banner, Mission Control, Risk Controls state, nav dot)

```js
// request { action: 'status' }
{
  ok: true, asOf,
  mode: 'paper',                          // always; literal
  engine: { lastTickAt, lastTickOk, lastError, tickEveryMin: 5, stale: false },
  headline: {
    state: 'HOLDING',  // ENGINE_DOWN|HALTED|PAUSED|NEEDS_REVIEW|NO_CERTIFIED|ENTRIES_BLOCKED|HOLDING|WAITING
    title: 'HOLDING 2 PAPER POSITIONS',
    line: 'Holding 2 paper positions from 1 strategy. Open risk 0.9% of equity.',
    tone: 'indigo',
    reasons: [{ text, link: { page: 'Strategies', query: 'id=mean_rev_v1' } }],
  },
  account: {
    startedAt, startingEquity, equity, cash, positionsValue,
    realized, unrealized, fees, grossExposurePct, openRiskPct,
    btcReturnPct, equityReturnPct, vsBtcPts,
  },
  risk: {
    canEnter: true, blockReasons: [],     // canEnter().reasons mapped to text (5.1)
    sizeMultiplier: 1,                    // LADDER_RUNGS[rung].sizeMultiplier
    drawdownPct: -3.2, worstDrawdownPct: -6.0, peakEquity,
    rung: 0, rungName: 'normal',  // normal|half_size|quarter_size|no_new_entries|flatten_and_halt
    ladder: { halfPct: -5, quarterPct: -10, noEntriesPct: -15, haltPct: -20 },
    daily:  { lossPct: -0.4, limitPct: -2, resetsAt },
    weekly: { lossPct: -1.1, limitPct: -4, resetsAt },
    btc:    { chg24hPct: -1.2, limit24hPct: -8, chg7dPct: -3.0, limit7dPct: -15, tripped: false },
    dataOk: true, requestPending: null,   // 'pause'|'flatten'|'reenable' awaiting the next tick
    halted: null,                         // or { source: 'manual'|'drawdown'|'fail_safe', at, by, reason,
                                          //      flatten, drawdownPct, peakEquity, equity }
    reenable: { available: false, willRebase: false, preconditions: [{ id, label, ok }] },
  },
  positions: [{
    symbol, strategyId, strategyName, adopted: false, side, instrument: 'spot', fundingAccrued,
    qty, entryPrice, entryTime, lastPrice, priceAgeSec, stale: false, unrealized, rMultiple,
    stopPrice, initialStopPrice,          // null when adopted without a stop
    distanceToStopPct, riskToStop, barsHeld, exitProfile, nextExit: 'trail 3,010',
    exitWarnings: [],
    exitPlan: [{ id: 'hard_stop', label: 'Hard stop', level: 2950,
                 state: 'armed',          // armed|active|waiting|done|off
                 note: 'set at entry, never moves down' }],
  }],
  strategies: { paper: 1, certified: 0, shadow: 1, research: 3, failed: 2 },
  alarms: { critical: 1, warning: 0 },
  legacy: { autoTradingEnabled: false, liveTradingEnabled: false, killSwitch: false },
}
```

`legacy` is a read-only read of three `AutoTradingSettings` fields. It is the only
legacy data V6 touches (see I1). If that read fails, `legacy` is `null` and the banner
shows "unknown".

**`equityCurve`**

```js
// request  { action: 'equityCurve', range: '7d'|'30d'|'90d'|'all' }
{ ok: true, asOf, startedAt, downsampled: true,
  points: [{ t, equityIndex: 100.0, btcIndex: 100.0, equity, drawdownPct, exposurePct }] }
```

Both series are rebased to 100 at the first point in the range. At most 500 points.

**`decisions`**

```js
// request  { action: 'decisions', day?: '2026-11-16', kind?: 'all'|'entry'|'exit'|'blocked', limit?: 50 }
{ ok: true, asOf, day,
  items: [{ t, kind: 'entered'|'exit'|'reduce'|'blocked'|'shadow'|'not_tested',
            symbol, strategyId, side, text, reasonCode, signalTestId?, tradeId?, pnl?, rMultiple? }] }
```

Merges `V6SignalTest` with `Trade` rows where `exchange === 'Paper Trading (V6)'`.

**`events`**

```js
// request  { action: 'events', onlyOpen?: true, type?, since?, limit?: 50 }
{ ok: true, asOf, items: [{ id, t, type, severity: 'info'|'warning'|'critical',
   code, message, data, ackedAt, clearedAt, sticky: true }] }
```

**`strategies`**

```js
// request { action: 'strategies' }
{ ok: true, asOf, globalTrialCount: 212, maxSleevePct: 50,
  items: [{ id, name, version, timeframe, lifecycle, displayState: 'PAPER (HALF)',
            operatorEnabled, sleevePct, sizeMultiplier, forwardTrades, halfRiskUntilTrades: 20,
            drift: { status: 'inside'|'breach'|'too_few'|'none', note }, demotedAt, demotionReason,
            certificate: { id, status: 'valid'|'failed'|'stale'|'none', passed: 12, total: 12,
                           failedIds: [], holdoutRun: true } }] }
```

**`strategyDetail`**

```js
// request { action: 'strategyDetail', id: 'tsmom_majors' }
{ ok: true, asOf,
  strategy: { /* item above */ ruleText, params, universeText, exitProfile },
  certificate: {
    id, status, issuedAt, hash, hashMatches: true, trialCount, holdoutClean: true,
    criteria: [{ id: 'D1', group: 'dev'|'holdout', label: 'Sharpe, CI lower bound',
                 needs: '>= 0.8, > 0', result: '1.02, CI 0.21',
                 value: 1.02, status: 'pass'|'fail'|'not_run' }],
  },
  drift: {
    xUnit: 'trades'|'days', status, n, note,
    expected: [{ x, p5, p50, p95 }],
    forward:  [{ x, returnPct }],
    breaches: [{ x, t, note }],
  },
  recentTrades: [ /* Trade rows, max 20 */ ],
}
```

**`signalTests`**

```js
// request
{ action: 'signalTests', from?, to?, strategyId?, symbol?,
  outcome?: 'entered'|'blocked'|'rejected'|'shadow'|'not_tested',
  failedCheck?: 'certificate'|'drift'|'data'|'replay'|'liquidity'|'history'|'risk',
  cursor?, limit?: 50 }           // limit max 200, default range last 7 days
// response
{ ok: true, asOf, nextCursor,
  summary: { total, entered, blocked, rejected, shadow, notTested,
             topFailure: { check: 'liquidity', count: 63 } },
  facets: { strategies: [{ id, name }], symbols: [] },
  items: [{ id, t, barTime, symbol, strategyId, side, outcome, rejectCode,
            blockedBy: 'liquidity', blockedText: 'spread 0.31% is above the 0.20% budget',
            checks: { certificate: 'pass', drift: 'pass', data: 'pass', replay: 'pass',
                      liquidity: 'fail', history: 'pass', risk: 'not_run' } }] }
```

**`signalTest`**

```js
// request { action: 'signalTest', id }
{ ok: true, asOf, test: { /* item above */
    reason, rankInBatch: 2, batchSize: 5, exitProfile, stopDistancePct, tradeId,
    checks: [{ id: 'liquidity', n: 5, label: 'Liquidity', status: 'fail',
               text: 'spread 0.31% (limit 0.20%)',
               values: [{ label: 'Spread', value: '0.31%', limit: '0.20%' },
                        { label: 'Depth', value: '$41k', limit: 'for $2.0k order' }] }] } }
```

**`riskConfig`**

```js
// request { action: 'riskConfig' }
{ ok: true, asOf, version: 7,
  config:   { /* clampRiskConfig output, engine fractions */ },
  defaults: { /* DEFAULT_RISK_CONFIG */ },
  ceilings: { /* HARD_CEILINGS: { key: { min, max } } */ },
  meta: { riskPerTradePct: { label, help, group: 'trade', scale: 100, unit: '%', step: 0.05,
                             sign: 1, looser: 'up', editable: true } },
                             // ladder and loss keys use sign: -1 for display
  loosenBlocked: false,
  fixed: ['Leverage on spot: none', 'Exits are never blocked'] }
```

**`exchanges`**

```js
// request { action: 'exchanges' }
{ ok: true, asOf, version: 3, minForConsensus: 2, latencyWarnMs: 1000,
  venues: [{ venue: 'okx', label: 'OKX', enabled: true, priority: 1,
             health: 'ok', latencyMs: 142, lastOk, lastError: null, lastErrorAt: null,
             breaker: 'closed', retryInMs: 0, consecutiveFailures: 0,
             roles: ['bars', 'book', 'consensus'] }],
  roles: { bars: ['okx', 'coinbase'], replay: 'coinbase',
           consensus: ['okx', 'coinbase', 'kraken'], book: 'okx' } }
```

Reads `V6ExchangeHealth` as last written by the engine. It makes no network call.

**`consensus`**

```js
// request { action: 'consensus', symbols?: ['BTCUSDT'] }  max 10; default held coins + BTC, ETH
{ ok: true, asOf, tolerancePct: 0.5,      // DEFAULT_HUB_CONFIG.tolerancePct
  items: [{ symbol, price, lastGood, quotes: { okx: 95100, coinbase: 95110 },
            spreadPct: 0.01, rawSpreadPct: 0.01, ok: true, reason: null,
            disagreement: false, outliers: [], pegAlarm: false }] }
```

Cache for 60 s on the server. Runs `hub.consensusPrice`, so it uses public endpoints only.

### 6.2 Write actions

All return `{ ok: true, asOf, effective: 'next_tick', ... }` unless refused.

| Action | Request | Response extras | Refusals |
|---|---|---|---|
| `setRiskConfig` | `{ patch: {...}, expectedVersion }` | `version, config` | `ABOVE_CEILING`, `LOOSEN_BLOCKED`, `VERSION_CONFLICT`, `BAD_REQUEST` (ladder order) |
| `resetRiskConfig` | `{ expectedVersion }` | `version, config` | as above; defaults may be looser, so `LOOSEN_BLOCKED` applies |
| `pauseEntries` | `{ reason }` | `requestedAt` | `BAD_REQUEST` |
| `flattenAll` | `{ confirm: 'FLATTEN', reason }` | `requestedAt` | `CONFIRM_MISMATCH` |
| `reenable` | `{ confirm, note }`. `confirm` is `'RE-ENABLE'` when `willRebase`, otherwise `'RESUME'` | `requestedAt, willRebase` | `CONFIRM_MISMATCH`, `NOT_HALTED` (nothing to clear), `PRECONDITION_FAILED` (with `fields`), `BAD_REQUEST` (empty note) |
| `setStrategyEnabled` | `{ id, enabled, closePositions?: false }` | `strategy` | `NOT_FOUND`, `NOT_ALLOWED_IN_STATE` (`research`) |
| `setSleeves` | `{ sleeves: { tsmom_majors: 50 }, expectedVersion }` | `version` | `SLEEVE_OVER_100`, `VERSION_CONFLICT` |
| `setExchanges` | `{ venues: [{ venue, enabled, priority }], expectedVersion }` | `version, warnings: [] ` | `MIN_VENUES`, `VERSION_CONFLICT` |
| `testExchange` | `{ venue }` | `result` (below) | `RATE_LIMITED`, `NOT_FOUND` |
| `ackEvent` | `{ id }` | `event` | `NOT_FOUND` |

```js
// testExchange result; persists nothing except a short info event if it failed
{ venue: 'okx', ok: true, testedAt,
  steps: [{ name: 'ticker', ok: true, ms: 121, detail: 'BTC 95,100' },
          { name: 'bars',   ok: true, ms: 164, detail: 'last closed 16:00 UTC' },
          { name: 'book',   ok: true, ms: 133, detail: 'spread 0.01%' }] }
```

Deliberately **absent** from this API: promote a strategy, override a gate result, ignore
drift, edit a certificate, change holdout state, edit criteria, anything about live trading,
API keys or `ExchangeConnection`.

---

## 7. Entity usage and proposed fields

Entities are read by `v6Control`, never by pages.

| View | Action | V6Config | V6StrategyState | V6SignalTest | V6RiskEvent | V6ExchangeHealth | V6Certificate | V6EquityPoint | Trade |
|---|---|---|---|---|---|---|---|---|---|
| Banner, Mission Control | `status` | R | R | R | R | R | | R | |
| Mission Control | `equityCurve` | | | | | | | R | |
| Mission Control | `decisions` | | | R | | | | | R |
| Mission Control, Risk | `events` | | | | R | | | | |
| Strategies | `strategies`, `strategyDetail` | R | R | | | | R | | R |
| Signal Tests | `signalTests`, `signalTest` | | R | R | | | | | |
| Risk Controls | `riskConfig`, writes | RW | | | W | | | | |
| Exchanges | `exchanges`, `setExchanges` | RW | | | W | R | | | |

`status` also reads `AutoTradingSettings` (three fields, read only) and the V6 account (I2).

Proposed fields. Store convention: snake_case, like existing entities.

```js
V6Config (singleton)
{ version, risk: {...}, venues: [{ venue, enabled, priority }],
  strategies: { [id]: { operator_enabled, sleeve_pct } },
  // Requests. v6Control writes them; v6Engine applies and clears them at the next tick.
  halt_request: null | { at, by, reason, flatten },
  reenable_request: null | { at, by, note },
  close_requests: [{ strategy_id, at }] }

// riskState from v6Risk also needs a home the status action can read. Engine owner to choose;
// V6Config.risk_state is the simplest. The ledger lives in Portfolio.v6_ledger (see I2).

V6StrategyState
{ strategy_id, name, version, timeframe,
  lifecycle: 'research'|'certified'|'paper_half'|'paper_full'|'shadow',
  certificate_id, size_multiplier, forward_trades, forward_series: [{ x, return_pct }],
  drift_status, drift_note, demoted_at, demotion_reason, last_signal_at }

V6Certificate
{ strategy_id, strategy_version, hash, status: 'valid'|'failed'|'stale', issued_at,
  trial_count, holdout_clean, criteria: [{ id, group, label, needs, result, value, status }],
  expected: { x_unit, points: [{ x, p5, p50, p95 }] } }

V6SignalTest
{ t, bar_time, symbol, strategy_id, side, reason, rank_in_batch, batch_size,
  outcome: 'entered'|'blocked'|'rejected'|'shadow'|'not_tested',
  reject_code, blocked_by, blocked_text, not_tested_reason,
  checks: [{ id, status: 'pass'|'fail'|'not_run', text, values: [{ label, value, limit }] }],
  exit_profile, stop_distance_pct, trade_id }

V6RiskEvent
{ t, type, severity, code, message, data, sticky, acked_at, cleared_at, before, after }

V6ExchangeHealth (one row per venue, updated in place)
{ venue, ok, breaker, latency_ms, last_ok, last_error, last_error_at, retry_until,
  consecutive_failures, rate_limited }        // hub.health() as of the last tick

V6EquityPoint
{ t, equity, cash, btc_price, drawdown_pct, exposure_pct }
```

**Storage note.** The store rewrites a whole JSON file on every save, and `list()` scans all
rows. Every 5 minutes for a year is about 105,000 `V6EquityPoint` rows, so plan for this:

- `V6EquityPoint`: keep 5-minute points for 7 days, hourly for 90 days, daily forever.
- `V6SignalTest`: one row per strategy, symbol and bar, not per tick; cap at about 50,000.
- Write these with `bulkCreate` once per tick.

---

## 8. Navigation changes

### 8.1 Groups

`Layout.jsx` replaces the flat `navItems` with groups:

```js
const NAV_GROUPS = [
  { label: 'V6', items: [
    { name: 'Mission Control', path: 'MissionControl', icon: Gauge },
    { name: 'Strategies',      path: 'Strategies',     icon: Layers },
    { name: 'Signal Tests',    path: 'SignalTests',    icon: ListChecks },
    { name: 'Risk Controls',   path: 'RiskControls',   icon: ShieldAlert },
    { name: 'Exchanges',       path: 'Exchanges',      icon: Network },
  ]},
  { label: 'Records', items: [
    { name: 'Trade History', path: 'TradeHistory', icon: History },
    { name: 'Alerts',        path: 'Alerts',       icon: Bell },
  ]},
  { label: 'Account', items: [
    { name: 'Security', path: 'Security', icon: Lock },
    // Admin appended here when user.role === 'admin'
  ]},
  { label: 'Legacy', collapsible: true, items: [
    { name: 'Trading',            path: 'Trading',          icon: TrendingUp },
    { name: 'Auto-Trading',       path: 'AutoTrading',      icon: Sparkles },
    { name: 'Trade Signals',      path: 'TradeSignals',     icon: Target },
    { name: 'Altcoin Scanner',    path: 'AltcoinScanner',   icon: Scan },
    { name: 'AI Signals',         path: 'AISignals',        icon: Brain },
    { name: 'AI Insights',        path: 'Insights',         icon: Activity },
    { name: 'Backtesting',        path: 'Backtesting',      icon: Activity },
    { name: 'Committee',          path: 'Committee',        icon: Users },
    { name: 'Strategy Lab',       path: 'StrategyLab',      icon: FlaskConical },
    { name: 'API Keys (live only)', path: 'ExchangeSettings', icon: KeyRound },
    { name: 'AI Settings',        path: 'AISettings',       icon: Cpu },
  ]},
];
```

```
+--------------------+
| CryptoMate         |
| V6 paper engine    |   <- replaces "Your Crypto Trading Assistant"
+--------------------+
| V6                 |
| > Mission Control  |  <- red dot + count when status.alarms.critical > 0
|   Strategies       |
|   Signal Tests     |
|   Risk Controls    |
|   Exchanges        |
| RECORDS            |
|   Trade History    |
|   Alerts           |
| ACCOUNT            |
|   Security         |
|   Admin            |
| LEGACY         [v] |  collapsed by default, text-slate-500
+--------------------+
```

- Group labels: `px-3 pt-4 pb-1 text-[10px] uppercase tracking-wider text-slate-500`.
- Legacy uses `ui/collapsible`. It opens automatically when the current page is in it. Open
  state is saved in `localStorage`, wrapped in try/catch.
- No route is removed. Every legacy URL keeps working.

### 8.2 Registration

`src/pages.config.js`: add `MissionControl`, `Strategies`, `SignalTests`, `RiskControls`,
`Exchanges` as imports and `PAGES` keys. `App.jsx` needs no change.

Keep `mainPage: "Home"`. `Layout` special-cases `Home`, and it already redirects signed-in
users. Change that redirect, the two logo links, and the login `next` to `MissionControl`.

### 8.3 Legacy banner

Rendered by `Layout` when `currentPageName` is in the Legacy group, under the paper banner:

```
| [Archive] LEGACY PAGE. This belongs to the old engine, not V6. Nothing here     |
|   changes V6. Measured net of costs, that engine lost money in 9 of 9 ninety-   |
|   day windows on 4h and 8 of 9 on 1h. Scores here are not odds.   Go to V6 ->   |
```

Classes: `bg-slate-800 border-b border-slate-700 text-slate-300`. The two text figures come
from the contract. For the `StrategyLab` page use a variant: it has a separate engine, so
say "Separate paper experiment. Not V6. Its two rules are not clean on the holdout period."

### 8.4 Replacement copy

Home hero (keep the layout):

- Badge: `Paper trading research platform`
- Title: `Test crypto strategies before they trade`
- Text: `Strategies must pass fixed tests on past data, net of costs, before they can
  paper trade. If none passes, the bot stays in cash and tells you why.`
- Remove: "Join thousands of traders", "Free forever plan", "Setup in 2 minutes",
  "Start Trading Smarter Today", "AI anomaly detection", "with confidence".
- Disclaimer: `V6 is paper only, with virtual funds. Past results do not predict future
  ones. A separate legacy live-trading feature exists and is off unless you arm it.`

`Layout` footer lead:

> **V6 is paper only.** It uses virtual funds and has no way to place real orders. The legacy
> live-trading path is separate and stays off unless you arm it.

Keep the existing risk disclaimer paragraph.

### 8.5 ExchangeSettings notice

Page title becomes "API Keys (live only)". Replace the "Simulated Trading Mode" card with:

> **Live trading only. Not used by V6.** Keys stored here are for the old engine's live
> order path, which can place real orders once armed. V6 uses public data and never reads
> these keys. For market data, see Exchanges.

Replace "this feed powers all charts, signals, and paper trading across the app" with "Feeds
the legacy pages. V6 venues are managed on the Exchanges page."

---

## 9. Empty, loading and error states

### 9.1 Day one: no strategy certified, in cash

This is the expected first state and must look like a result, not a fault. It is slate
and calm, and shows no spinner or red.

```
+--------------------------------------------------------------------------------+
| PAPER MODE  V6 uses virtual money. It has no way to place real orders.         |
+--------------------------------------------------------------------------------+
| Mission Control                                     Last engine run 2 min ago  |
|                                                                                |
| +----------------------------------------------------------------------------+ |
| | [Banknote]  IN CASH                                                        | |
| | In cash: no strategy has passed certification, so nothing is allowed to    | |
| | trade.                                                                     | |
| |                                                                            | |
| | This is an expected result, not a fault. V6 only trades strategies that    | |
| | pass fixed tests on past data, net of costs. Sitting in cash beats         | |
| | trading rules with no tested edge.                                         | |
| |                                                                            | |
| | 6 candidates tested. 0 passed. 2 running in shadow, logging only.          | |
| | See why each failed ->                                                     | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| +-----------------+ +-----------------+ +-----------------+ +----------------+ |
| | Paper equity    | | Vs BTC hold     | | Drawdown        | | Exposure       | |
| | $10,000         | | Not enough data | | 0.0%            | | 0%             | |
| | 100% cash       | | Starts today    | | Full size       | | Open risk 0%   | |
| +-----------------+ +-----------------+ +-----------------+ +----------------+ |
|                                                                                |
| Paper equity vs BTC: "The chart starts after the engine has run for a day."    |
| Drawdown ladder: renders normally, marker at 0%.                               |
| Open positions: "No open positions."                                           |
| Today's decisions: "No entries today. 14 shadow signals logged. See Signal     |
|   Tests." or "The engine ran, and no strategy produced a signal."              |
+--------------------------------------------------------------------------------+
```

The "Sitting in cash" wording is about process, not a promise. If BTC rises, the "Vs BTC"
tile shows that cash is behind, without excuses.

**This wireframe assumes a clean account.** `adoptLegacyPortfolio` takes over the existing
row, so if the old engine left positions, day one instead shows `CLOSING N POSITIONS`, adopted
rows, and equity that is not $10,000. "NO STOP" rows and a critical alarm appear until the
engine assigns stops. `ledger.adoption.warnings` go in `headline.reasons`. Show all of that as
it is: never headline "In cash" while any position is open. The start point for the BTC
comparison is the first `V6EquityPoint`, with its equity as the base.

During the first minutes `canEnter` is false (`market_data_unknown`, `data_unhealthy`), which is
normal. It appears under "Why this state?" and does not change the headline.

### 9.2 State matrix

| View | Loading (first) | Refetch | Empty | Engine not installed (404) | API error |
|---|---|---|---|---|---|
| Banner | Static text shows at once | no change | n/a | Static text, plus "Could not read the old engine's live setting" | Same |
| Mission Control | `Skeleton` per card | Keep data | 9.1 | Full-page state (9.3) | Red card + retry; if prior data exists, keep it with a "stale since" badge |
| Equity chart | Skeleton 288px | Keep | "The chart starts after the engine has run for a day." | hidden | Inline "Could not load chart" + retry |
| Positions | Skeleton rows | Keep | "No open positions." | hidden | Inline |
| Decisions | Skeleton rows | Keep | 9.1 text | hidden | Inline |
| Strategies | Skeleton rows | Keep | "No strategies registered yet. Research results appear here when candidates are tested." | 9.3 | Inline |
| All failed | n/a | n/a | "No strategy passed. That is a valid result." List still shows each failure | | |
| Strategy detail | Skeleton | Keep | No certificate: "Not tested yet." Holdout not used: rows show "Not run" | 9.3 | `NOT_FOUND`: "This strategy no longer exists" + link back |
| Drift chart | Skeleton | Keep | "The chart starts after the first forward trade closes." | | Inline |
| Signal Tests | Skeleton rows | Keep | No rows ever: "Nothing tested yet. A test appears when a strategy produces a signal." With filters: "No tests match these filters." + Clear | 9.3 | Inline + retry |
| Risk Controls | Skeleton form | Do not overwrite unsaved edits | Config missing: API returns defaults | 9.3 | Form disabled; "Could not load limits, so editing is off." Never show guessed limits |
| Exchanges | Skeleton rows | Keep | No readings: each venue `unknown`, "Waiting for the first engine run." | 9.3 | Inline + retry |

Query-state order on each card: `isPending` -> skeleton; `isError && !data` -> error;
empty -> empty; otherwise data, with a stale badge when `isError && data`.

### 9.3 Other global states

| State | Detected by | Display |
|---|---|---|
| Server down | `ApiError` status 0 | Red card with `error.message`, which already says how to start the server. Banner stays |
| `v6Control` not installed | `ApiError` 404 | "V6 is not installed yet. The API function was not found." |
| `v6Control` failed to load | `ApiError` 500 with "failed to load" | Show that message plus "See the server log." |
| Signed out | 401 | `AuthContext` handles it |
| Engine never ran | `engine.lastTickAt` null | `ENGINE_DOWN`, line: "The engine has not run yet. It is scheduled every 5 minutes." |
| Engine stale | `engine.stale` | `ENGINE_DOWN`; other numbers get a "stale" badge |
| Engine error | `lastTickOk` false | Critical alarm with `engine.lastError` |
| Halted | `risk.halted` | Red headline, link to Risk Controls |
| `VERSION_CONFLICT` | write refusal | "These settings changed elsewhere. Reload to see the latest." Keep the user's edits visible |
| Other refusal | `V6Refusal` | Toast or `fields` message under inputs |
| Write in flight | `isPending` | Button disabled + spinner. No optimistic updates on risk or venue writes |

---

## 10. Component list and build order

### New files

| File | Purpose |
|---|---|
| `src/hooks/useV6.js` | `callV6`, `useV6Query`, `useV6Mutation`, `V6Refusal` |
| `src/components/v6/format.js` | `money`, `pct`, `pnlCls`, `signed`, `ago`, `utc` |
| `src/components/v6/PaperBanner.jsx` | 4.1, used by `Layout` |
| `src/components/v6/LegacyBanner.jsx` | 8.3, used by `Layout` |
| `src/components/v6/StateCard.jsx` | Shared loading, error and empty wrapper (9.2) |
| `src/components/v6/ToneBadge.jsx` | Tone to badge classes plus icon; `LifecycleBadge`, `OutcomeBadge`, `HealthBadge` wrappers |
| `src/components/v6/CheckIcon.jsx` | pass, fail, not_run with accessible label |
| `src/components/v6/HeadlineCard.jsx` | Headline and reasons |
| `src/components/v6/StatTile.jsx` | From `StrategyLab.StatCard` |
| `src/components/v6/EquityVsBtcChart.jsx` | recharts, range tabs, table toggle |
| `src/components/v6/DriftChart.jsx` | Band, median, forward, breaches, table toggle |
| `src/components/v6/ChartFrame.jsx` | Shared tooltip, legend, "View as table" |
| `src/components/v6/DrawdownLadder.jsx` | Rung display and period limits |
| `src/components/v6/PositionsTable.jsx` | With expandable `ExitPlanList` |
| `src/components/v6/DecisionsFeed.jsx` | Today's decisions |
| `src/components/v6/AlarmList.jsx` | Events with acknowledge |
| `src/components/v6/StrategyTable.jsx` | List view |
| `src/components/v6/StrategyDetail.jsx` | Detail, `LifecycleStepper`, `EvidenceTable`, `SleeveControl` |
| `src/components/v6/SignalFilters.jsx` | URL-backed filter bar |
| `src/components/v6/SignalTestTable.jsx` | Table and mobile collapse |
| `src/components/v6/SignalTestSheet.jsx` | Detail `Sheet` |
| `src/components/v6/LimitField.jsx` | Input with default, ceiling, help, error |
| `src/components/v6/RiskForm.jsx` | Grouped limits, dirty state, save dialog |
| `src/components/v6/HaltPanel.jsx` | State, pause, flatten, re-enable dialogs |
| `src/components/v6/TypedConfirmDialog.jsx` | Typed-word pattern from `ResetTradingData` |
| `src/components/v6/VenueTable.jsx` | Enable, priority, health, test |
| `src/components/v6/VenueRoles.jsx` | Which venue does what |
| `src/components/v6/ConsensusTable.jsx` | Price agreement |
| `src/components/v6/ApiKeysNotice.jsx` | Live-only card |
| `src/pages/{MissionControl,Strategies,SignalTests,RiskControls,Exchanges}.jsx` | Pages |
| `shared/trading/v6Status.js` | Pure `deriveHeadline(...)` |
| `base44/functions/v6Control/entry.ts` | API |
| `tests/v6Control.test.mjs`, `tests/v6Gui.test.mjs` | Section 11 |

### Edited files

`src/Layout.jsx`, `src/pages.config.js`, `src/pages/Home.jsx`, `src/pages/ExchangeSettings.jsx`,
`src/pages/TradeHistory.jsx`, `src/pages/Alerts.jsx`,
`src/components/notifications/useNotificationMonitor.jsx`, `scripts/sync-shared.mjs`,
`server/scheduler.js`, `server/entityStore.js` (reset lists).

### Build order

1. `v6Control` with `status` and `deriveHeadline`, returning the day-one state from empty entities.
2. `useV6`, `format`, `PaperBanner`, nav groups, `LegacyBanner`, page registration, redirects.
3. Mission Control, with day-one state first.
4. Risk Controls, including halt and re-enable. This is the only safety-critical UI.
5. Exchanges. 6. Strategies. 7. Signal Tests.
8. Legacy copy and fabricated-alert removal, `TradeHistory` filter.

Pages can be built against fixtures that match section 6 while engine agents finish.

---

## 11. Acceptance checks

`tests/v6Gui.test.mjs` (plain Node, static):

- No banned word from 4.2 in `src/components/v6/**` or the five V6 pages, case-insensitive.
  Allow-list `risk-free` only if it occurs in a negated sentence (none is expected).
- No `base44.entities.V6` in `src/`.
- `src/pages/` V6 files contain no `initialData`, `alert(`, or `score`-as-percent rendering.
- All five pages are in `PAGES`, and every nav path resolves to `PAGES` or `App.jsx`.

`tests/v6Control.test.mjs`:

- `entry.ts` has no import of forbidden modules, and no `ExchangeConnection`, `api_key`,
  or `api_secret` text.
- Every headline row in 5.1, including precedence: halted and no certified -> `HALTED`.
- `mode` is always `'paper'`.
- `setRiskConfig` above ceiling returns `ABOVE_CEILING` and leaves config unchanged.
- `reenable` with wrong word, with nothing to clear, or with open positions while
  `willRebase` is true is refused. `NEEDS_REVIEW` accepts it.
- A clamped value (for example `ladderHalfPct` pushed down by the ordering rule) is refused
  with `fields`, not saved silently.
- Headline: no certified, open adopted position -> "CLOSING", never "IN CASH".
- Headline: day-one risk state (`market.ok: false`) with nothing certified -> `NO_CERTIFIED`.
- Venue with `ok: true`, `lastOk: null` -> `unknown`. `geo_blocked: ...` -> `blocked`.
- `setStrategyEnabled` on `research` is refused.
- No action name exists containing `promote`, `live`, or `override`.
- `setExchanges` refuses zero venues.

Manual, in the running test server (port from the brief, never 8788):

- Empty data: banner and day-one state show; no red anywhere except real alarms.
- Stop the engine job: `ENGINE_DOWN` appears within 15 minutes.
- Set `live_trading_enabled` true on a test data folder only: red banner row appears on
  every page.
- Phone width: no horizontal page scroll; tables scroll inside their cards.
- Each legacy URL still loads, with its banner.
- A V6 trade in Trade History shows no "/100 strength" text (F11).

---

## 12. Issues for other owners

Needs a decision or a change outside this file. Severity is my judgement.

| # | Sev | Owner | Issue | Recommendation |
|---|---|---|---|---|
| I1 | High | Coordinator | Legacy `tradingScheduler` keeps running. If `is_enabled` is on, two engines run, and the legacy one can be live. The banner reports this but cannot stop it. Reading `AutoTradingSettings` in `v6Control` is not banned by contract rule 1, but confirm it. | Confirm the read. Decide whether legacy auto-trading is switched off at V6 launch. V6 must not change it itself. |
| I2 | High | Engine, integrator, coordinator | `v6Paper` adopts the legacy Portfolio row and writes back to it, as the contract says. The legacy worker and manual trades on `Trading` also write that row. Writes between ticks could be lost or break `capital`, which is solved from the accounting identity. Adopted positions may have no stop. | Before V6 starts: legacy auto-trading off, and manual buy and sell on `Trading` disabled or sent to a separate row. `v6Engine` assigns stops to adopted positions on its first tick (`updatePosition`). |
| I3 | High | Integrator | `Trade.deleteMany({})` in `Trading.jsx:445` and the newest-1000 delete in `TradeHistory.jsx:37-40` wipe V6 trades. `resetTradingData` clears Trade and overwrites all Portfolio rows but leaves `v6_ledger`, which `adoptLegacyPortfolio` then reads. V6 entities are in neither `RESET_CLEARS` nor `RESET_KEEPS`, and the reset's in-flight guard should cover `v6Engine`. | Scope both deletes to `exchange: { $ne: 'Paper Trading (V6)' }`. Put all `V6*` in `RESET_KEEPS`, or define one explicit V6 reset that clears Trade rows, `v6_ledger` and `V6*` together. |
| I4 | Medium | `v6Risk`, `v6Core` | Capital sleeves are requested but not in the contract. `v6Core` passes `config.sizeMultipliers[strategy.id]` to `sizeEntry`, which scales size but does not cap a strategy's share of equity. | Add a per-strategy cap. If deferred, render sleeves read-only and drop `setSleeves`. |
| I5 | Resolved | `v6Risk` | Peak after a halt: `humanReEnable` rebases at rung 3 and above. Each rebase is a fresh 20% allowance, so repeated re-enables have no overall floor. | No change needed. The dialog states the allowance. Coordinator may want a lifetime floor later. |
| I6 | Medium | `v6SignalGate`, `v6Core` | The GUI needs all 7 results with values. `v6Core` keeps only `verdict.ok` and `verdict.reason`, and passes a single reason to `entry_rejected`. It also has no shadow path that I could see: a shadow strategy needs its signals tested and logged without an intent. | Gate evaluates every check, or reports `not_run`. Either the gate persists verdicts or `v6Core` returns them. Adopt `V6SignalTest.checks` from section 7. Define shadow handling. |
| I7 | Medium | `v6Core` | Confirmed in code. `gate.check` runs **before** `sizeEntry`, so gate check 7 cannot test that size fits; sizing failures surface as `entry_rejected: sizing`. When `canEnter` is false, `entries_blocked` has one event per strategy with a count and no symbols, so per-coin rows are impossible. | Accept check 7 as stop and reward:risk only, with sizing as a separate outcome (this design assumes that), or size first. Add symbols to `entries_blocked`. |
| I8 | Medium | Coordinator | Contract has no return path from `shadow`. | Leave none in v1. Decide whether re-certifying a new version is the only way back. |
| I9 | Medium | Research, validator | Failed candidates need `V6Certificate` rows (`status: 'failed'`), or the GUI cannot show why cash is the result. `expected` percentile data must be written at certification for the drift chart. | Write them for every candidate, and record `holdout_clean: false` for the two legacy rules. |
| I10 | Medium | Coordinator | Legacy popups (`AIRecommendationNotification`) mount in `Trading` only, so they are contained, but fabricated alerts reach the shared `NotificationCenter`. | Approve removal of the fabricated alerts. |
| I11 | Medium | Integrator | `ENTITY_NAMES` omits `StrategyLabAccount`, `StrategyLabTrade`, `CommitteeDecision` (F1). Contract names an entity allow-list that does not exist (F2). | Add the three names. Correct the contract note. Optionally refuse browser writes to `V6*`. |
| I12 | Low | Integrator | Add `v6Engine`, `v6Control` to `FUNCTION_DIRS` in `sync-shared.mjs`, and `v6Engine` to `JOBS`. `functionRuntime` discovers functions by folder automatically. | Do at integration. |
| I13 | Medium | `v6Exchanges`, engine | Hub breakers and rate-limit state live in memory per `createMarketHub`, so a hub built per tick or per `v6Control` call forgets them, which works against contract rule 8. `hub.health()` says `ok: true` for untried venues, and `v6Risk` counts `ok` venues as healthy, so a new hub can pass `minHealthyVenues` having contacted nobody. Binance leads `DEFAULT_PRIORITIES` though reported geo-blocked (F9). Daily bar close times may differ by venue: `strategyLabWorker` notes OKX at 16:00 UTC, so replay could disagree for that reason alone. | One long-lived hub shared by engine and control. Count a venue healthy only after a success. Seed V6 config with OKX first. Align bar boundaries before replay. |
| I14 | Low | `v6Exchanges`, `v6Risk` | Risk ceilings and `tolerancePct` now exist. Venue roles and `latencyWarnMs` still have no source. `clampRiskConfig` clamps silently, so `v6Control` must compare before saving (5.4). | Export roles. `v6Control` owns `latencyWarnMs`, proposed 1,000 ms. |
| I15 | Low | Engine | Retention in section 7 is needed to keep JSON files small. | Implement compaction in `v6Engine`. |
| I16 | Low | `v6Strategies` | `defineStrategy` has no plain-English rule field, which `strategyDetail.ruleText` needs. | Add a `description` field. Until then, show the params only. |
