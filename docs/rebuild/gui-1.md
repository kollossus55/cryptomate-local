# V6 GUI: shared layer, Mission Control, Risk Controls

Owner: `b-gui-1`. Work in progress: the usage notes below are stable and safe to build on.

## Shared pieces

Import everything from `@/components/v6/shared`.

| Export | Use |
|---|---|
| `useV6Query(action, params, opts)` | Query with the poll interval from gui-design 4.3 |
| `useV6Status()` | The shared `status` query (banner, nav dot, pages) |
| `useV6Mutation(action, { invalidates })` | Write. Rejects with `V6Refusal` (`code`, `fields`) |
| `describeV6Error(err)` | `{ kind, title, message }` for the 9.3 states |
| `NEXT_TICK_NOTE` | Sentence every write toast must include |
| `PaperBanner` | Mount in `Layout` above page content, on every page except `Home` |
| `PageHeader` | Title, PAPER tag, "Last engine run", `document.title` |
| `QueryState` | The 9.2 order: skeleton, error, empty, data |
| `V6Card`, `SkeletonRows`, `EmptyNote`, `InlineError`, `PageError`, `StaleSince` | Card pieces |
| `ToneBadge`, `StaleBadge`, `toneOf` | Semantic tones from section 3 |
| `CheckIcon` | `pass`, `fail`, `not_run` with an accessible label |
| `StatTile` | Label, value, sub-lines |
| `ChartFrame`, `ChartLegend`, `ChartTooltip`, `SERIES_COLORS`, `AXIS` | Chart chrome, table toggle |
| `TypedConfirmDialog` | Confirm dialog, optional typed word and required note |
| `money`, `signedMoney`, `pct`, `signedPct`, `pts`, `rMultiple`, `price`, `qty`, `coin`, `pnlCls`, `ago`, `until`, `utc`, `utcDate`, `utcDateYear`, `utcTime` | Formatters. Missing numbers render as a dash |

The design listed `src/hooks/useV6.js` and `src/components/v6/format.js`. Under the agreed
ownership they live in `src/components/v6/shared/`.

## What was built

- `src/pages/MissionControl.jsx`, parts in `src/components/v6/mission/`: headline, alarms, tiles, equity vs BTC chart with table view, ladder and loss meters, positions with exit plan and distance to stop, today's decisions.
- `src/pages/RiskControls.jsx`, parts in `src/components/v6/risk/`: halt panel, limit form, events log. The page is short on purpose: the logic is in `limitLogic.js` and `haltLogic.js`, which are pure and tested.

## Rules the code keeps

- **Words and groups are local, display rules are from the API.** `fieldMeta` takes `scale`, `unit`, `sign` and `looser` from `meta`, and takes label, help and group from `limitMeta.js`, because the API's `help` copies its label and its groups differ from gui-design 5.4.
- **No range, no editing.** A limit with no ceiling from the API is read-only. Nothing is guessed.
- **`clampRiskConfig` moves values silently,** so the form runs it first and refuses any draft it would change.
- **Re-enable needs `available` and every precondition met.** `available` alone stays true while positions are closing, and the server then refuses.
- **The review wording comes from the rung.** `status.risk` has no `review` field, so rung below 3 means `flat_entries_too_small`, which must not claim entries are blocked.
- **The re-enable dialog opens with the cost.** `rebaseExposure` in `haltLogic.js` gives the fall from the all-time high across re-enables, and the equity at which the next automatic flatten fires, also as a fall from the all-time high. Worked example: equity 9,560, all-time high 12,010, halt -20% gives a flatten near 7,648, which is -36.3% from the all-time high. If the high is unknown the dialog says so and invents no figure.

## Quarantine and recutover

`QuarantineCard` sits at the top of both pages. `RecutoverPanel` is on Risk Controls only. `status` has no field for lost state, so `recutoverOffer` needs the open `state_missing` event and no `lastTickAt`. A `status.engine.stateLost` flag would be cleaner. The re-enable checks count a quarantined row as flat, because `status.positions` leaves it out.

## Changes needed outside these files

In `base44/functions/v6Control/control.js`:

| Item | Effect today |
|---|---|
| `status.risk` has no `review` | The GUI infers the reason from the rung |
| `weekly.resetsAt` is null | The GUI says "next UTC Monday" with no countdown |
| `strategies.failed` is hardcoded 0 | The GUI counts from the `strategies` action instead |
| `positionView`: `priceAgeSec: null`, `stale: false` | A stale price on a position can never be flagged |
| `positionView`: `nextExit: null`, `strategyName` is the id | No next-exit text; the table shows the raw strategy id |
| `RISK_META.help` copies the label | Harmless now, ignored by the GUI |
| Refusal `fields` text uses raw fractions ("Ceiling is 0.01") | Only reachable if client checks are bypassed |
| `worstDrawdownPct` comes from stored `drawdown_pct` | Confirm it is measured from the all-time high; the engine writes it that way at `engine.js:688` |

## Verification

Tests and fixtures live in `data/tmp/b-gui-1/` (git-ignored), because `tests/` is not owned here. Fixtures are real `handle()` output from `control.js` over real `v6Risk` state, except the day-one candidate list: the fixture registry is empty, so that list is hand-written.

- Logic: `tests/v6GuiMission.test.mjs`. It is not yet in the `test` script in `package.json`, which this agent does not own. Real handlers: 16 checks pass (`gen-fixtures.mjs`).
- Render: 17 states on both pages plus 3 re-enable dialogs in headless Chrome. No crashes, and no banned words or `undefined`, `NaN` in rendered text. Phone width checked at 500px.
- This render caught a crash the build and logic tests missed, so run it after any chart change.
- Not checked: pages inside the real `Layout.jsx` (the harness mounts the banner and page alone, so the phone banner offset is unverified), a running server, and real engine data. No action buttons were clicked through to a request in the browser; request payloads were checked against the handlers only.
