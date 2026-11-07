# GUI 2: Strategies and Signal Tests

Agent b-gui-2. Paper only. Nothing here creates, edits or overrides a certificate.

## What exists

- `src/pages/Strategies.jsx`: list, day-one card, and detail by `?id=`.
- `src/pages/SignalTests.jsx`: filters in the URL, summary, table, detail sheet by `?id=`.
- `src/components/v6/strategies/`: lifecycle stepper, certificate card, D1-D8 and H1-H4 evidence, why-failed card, drift chart with table view, read-only sleeve, entry switch, return from shadow. Pure logic is in `strategyView.js`.
- `src/components/v6/signals/`: filters, summary, table, sheet with all seven checks. Pure logic is in `signalView.js`.

## How it was checked

Scratch files are in `data/tmp/b-gui-2/`. Tests run without a server, so port 8788 was not touched.

- `logic.check.mjs`: view logic on hand-written inputs.
- `contract.check.mjs`: the real `v6Control` `handle()` on a temporary `EntityStore`, with real sealed certificates and the real gate, feeding my real view logic. It covers expired certificates, changed code, failed candidates, unknown drift, paging and refusals.
- `run2.sh`: pages in headless Chrome on fixtures: every loading, empty and error state, plus write payloads.
- `run3.sh`: the same pages rendering responses captured from the real `handle()`, plus the production build.

Not tested: a running server, a real engine tick after a return request, and a real certificate from the final validator. None exists yet.

## Bugs the real API exposed, now fixed

| Bug | Effect | Fix |
| --- | --- | --- |
| GUI required `shadowReturn.eligible === true`; the API does not send it | Return button could never enable | Only an explicit `eligible: false` blocks |
| Detail `certificate.status` is the stored status | Expired or changed-code certificate showed Valid and could enable return | `verifiedCertificate` uses the verified status from the strategy row; missing means stale |
| List maps `unknown` drift to `none` | A strategy blocked by check 2 read "Not running forward yet" | For a tradable strategy `none` is treated as unknown |
| `sleevePct` is always null | Paper strategy showed sleeve "None" | Shows equal share, matching section 6 |
| `holdout_clean` is true on a candidate that never reached holdout | Failed strategy showed holdout "Clean" | Shows "Not used" unless a holdout row ran |

## Requested changes elsewhere

v6Control (b-worker):

1. `strategyDetail.drift.breaches` is always `[]`, so the chart breach marker never appears on real data. The breach still shows in text. Send `{x, text}`.
2. Send `certificate.expiresAt`. The Expires line stays hidden until then.
3. Send the verified status on the detail certificate, so the GUI need not merge two fields.
4. `shadowReturn.pending` is missing and requests are consumed on the next tick. A second submit before the tick queues a duplicate, which the gate refuses with a `reinstate_refused` alarm. Harmless but noisy.
5. `returnFromShadow` does not check the certificate. The GUI and the gate both do, so a bypass gets an accepted reply and then a refusal alarm at the tick.
6. Unknown drift should reach the list as `unknown`. The GUI workaround relies on tradable states never starting at `none`.
7. `failed: 0` in `status.strategies` is hard coded, and `maxSleevePct: 50` is unused.
8. `signalTests` facets come from the filtered rows, so picking one strategy empties the other choices until cleared. Summaries silently cap at 5,000 rows.
9. `notTestedReason` is not sent. Untested strategies show "Not tested" with no reason.

Validator or b-gate:

- Holdout rows have `result: null`, and H4 stores only the strategy drawdown. The GUI cannot show the BTC figure H4 was judged against.
- The first `min_trades` shadow signals count during warming with no range applied. Please confirm that is intended for the 20-signal rule.

## Deviations from gui-design

- Section 5.2 slider and "no return path" are replaced by CONTRACT section 6: read-only sleeves and a human return.
- "Passed the tests, then sizing refused it" became "Cleared the tests that run before sizing, then sizing refused it", because checks 5 and 7 have not run at that point.
- Empty text says "Nothing tested in the last 7 days", because the default range is 7 days.
- A failed candidate has no route to paper, even if it sits in shadow.

## Chart colours

Validator on `#3987e5,#94a3b8` over `#0f172a`: CVD PASS (13.2), normal vision PASS (15.4), contrast PASS. Lightness and chroma FAIL for `#94a3b8` only. That is deliberate: it is a neutral reference line, not a category, and it carries a dash and a direct label.
