# b-gui-3: Exchanges view, navigation, legacy fixes

## Verification (final code)
- `npx vite build --outDir data/tmp/b-gui-3/dist`: passes, no redirect or config change.
- `node tests/v6GuiExchanges.test.mjs`: 36 passed, 0 failed. Not yet wired into the test script.
- `data/tmp/b-gui-3/render-check.mjs`: 13 of 13. Renders the real Exchanges and TradeHistory pages to HTML with fixtures. Uses a router shim, so it does not test navigation.
- Not done: real browser, phone width, or a live save against a running v6Control.

## Built
- `src/pages/Exchanges.jsx`, `src/components/v6/exchanges/`: venues with enable and priority, health including `unknown`, latency, last error, consensus disagreement, test button, role selectors, separate API key notice labelled live only and unused by V6.
- Replay is limited to OKX or Bybit. Save is blocked otherwise.
- `src/pages.config.js`, `src/Layout.jsx`: five V6 pages registered, V6/Records/Account/Legacy nav groups, old pages still reachable under Legacy. Home sends signed-in users to Mission Control.
- `src/lib/v6Trades.js`, `src/components/LegacyBanner.jsx`, `src/components/notifications/fabricatedNotifications.js`.

## Section 6 fixes
- Random anomaly alerts removed from Alerts and the notification monitor. Old stored fabricated rows are hidden.
- NewsWidget: one asset per 5-minute poll, skips hidden tabs, dedupes headlines. `{data}` vs `.success` fixed, with a call gate and backoff honouring `retry_after_ms`.
- Trade History: V6 trades render with reasons and signed P&L; engine filter defaults to V6; old signal shown as an indicator score, not a probability.
- Legacy delete and reset refuse or exclude V6 records. These guards are client side only.
- Wording that implied confident or guaranteed profit, including strength-95 claims, removed or relabelled across legacy pages.

## Handler comparison (base44/functions/v6Control/control.js)
Matches: health values, consensus reasons, test `steps`, `expectedVersion`, `minForConsensus`.

Differences, none fixable from the GUI:
1. `setExchanges` ignores `roles`. `exchanges` derives replay (first enabled OKX or Bybit) and book (first enabled venue). Role selectors therefore cannot change anything today. The page reads back after saving and warns "Venues saved, role choice not kept" rather than reporting success.
2. `setExchanges` does not enforce replay in okx/bybit. Only the page does.
3. `consensus` sets `disagreement: q.reason === 'disagreement'`, but the hub emits `venues_disagree`, `no_majority`, `outlier_excluded`, so the flag looks always false. The page reads `reason`, so it is unaffected.
4. `engine.js` stores `retry_until: h.retryUntil`, but hub `health()` emits `retryInMs`, so retry countdowns will not appear. The badge shows just the state. `rate_limited: h.rateLimited === true` also compares against a count.

## Needed in files I do not own
- `src/pages/Trading.jsx:461` `Trade.deleteMany({})` removes V6 trades; score wording remains there (b-lock).
- `server/entityStore.js` `resetTradingData` must protect V6 trades and `v6_ledger`, and list V6* in RESET_KEEPS (b-engine). Until then the server reset path can still remove them.
- `control.js`, `engine.js`: items 1 to 4 above.
- Integrator: wire `tests/v6GuiExchanges.test.mjs`.
- `src/utils.js` is empty and shadows `src/utils/index.ts`, so any `@/utils` import fails the build. Nothing imports it now.

## Known limits
- Alerts are only checked while the Trading page is open. Technical and pattern alerts and Discord/Telegram delivery never ran; they are labelled as such.
- Fixing `.success` means news and AIAnalysisModal now show real model output. Its on-chain and social figures are unverified, and it uses LLM quota, about one call per 5 minutes while the widget shows.
- `Math.random` still feeds legacy displays: AdvancedChart, AnomalyDetection, PredictiveModels, AltcoinScanner, LiveTradingSimulation, TechnicalAnalysisEngine, AutoTradingDebugPanel. Not audited line by line and not labelled simulated.
- NotificationCenter clear-all destructures `{items}` from `filter`, which returns an array. Likely an existing bug, untouched.
