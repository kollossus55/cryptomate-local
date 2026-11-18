# Wave 2 research brief (all research agents)

Read docs/rebuild/CONTRACT.md (all of it) and docs/rebuild/core-sim.md, then copy the pattern in
scripts/v6/harness-example.mjs. Skim docs/rebuild/exit-engine.md and risk-engine.md.

**Your job is to find out whether your idea really works, not to make it work.** A clear,
well-tested "this has no edge" is a full success.

Rules:
- DEV data only, through `loadBars`. Never `hub.bars`, never a live API call for prices, never
  `D:\cryptomate-local\data\research`, never anything under `holdout/`. Do not use your own memory of
  what happened in markets in 2025-2026 to choose rules.
- Decide the hypothesis and a coarse grid BEFORE running, and write it at the top of your doc.
  Economic reason first: why should this edge exist and survive costs?
- At most 50 trials. Log every one, with `trialRecord`, to `data/research/v6/trials-<agent>.jsonl`.
- Use walkForward and `checkDevCriteria`, with `auditLookahead` clean, including `rebuild`.
- Results count only under real v6Risk sizing inside HARD_CEILINGS. You may use the ceilings, and
  report average exposure. `fullWeightRisk` figures are for diagnosis only, never for a pass.
- Point-in-time universes only. No hand-picked coin lists except a fixed BTC/ETH-style universe
  whose choice is justified without hindsight.
- Max 3 worker processes. Scratch in `data/tmp/<agent>/`.
- Do not edit shared/trading/*. Your strategy code goes in `scripts/v6/research/<agent>.mjs`,
  exporting strategy objects in the contract shape plus `FROZEN_CANDIDATES`: at most 2, with exact
  parameters. Report a harness or module bug rather than working around it.
- Do NOT evaluate on holdout. The final validator does that once.

Report in `docs/rebuild/research-<agent>.md`: hypothesis, grid, trial count, the full D1-D8 table for
each frozen candidate, per-year returns, worst drawdown, exposure, cost breakdown, what failed and
why. If nothing qualifies, say so and freeze nothing. State the verdict on the first line.
