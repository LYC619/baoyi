# UX Review Plan

## Goal

Review BaoYi's current user journeys and produce a complete, evidence-based optimization plan for series-aware video folders, metadata, registration, multi-video details, and failed game covers. This task changes documentation only.

## Phases

1. [complete] Inspect current implementation, previous delivery scope, available runtime and verification evidence.
2. [complete] Walk through the video, game, scan, task, and settings journeys; distinguish observed behavior from code-derived risks.
3. [complete] Define alternatives, recommended resource model, directory and metadata contract, interaction flows, recovery behavior, and migration.
4. [complete] Write prioritized implementation work packages and scenario-based acceptance criteria; self-review and deliver.

## Constraints

- Preserve the existing dirty worktree and active user data.
- Do not implement product changes or commit existing work.
- Use an isolated profile for any application walkthrough.
- User clarified Genshin Impact and launcher-name search. Investigated current behavior with independent samples; the original user installation and LLM identification remain uninspected.
- rtk is unavailable; use original commands with focused output.

## Errors And Limits

- Initial command discovery returned a nonzero status because rtk was absent; rg is available.
- Session catchup completed without recovered context.
- The first walkthrough navigated before the initial router mount settled and timed out on the software page; fixed the harness to enter video via its visible module tab. No product failure inferred from this harness race.
- The next walkthrough captured video/game/cover/task evidence, then used the wrong settings selector (main); corrected to .settings. A new round also records console CSP errors and verifies a known Steam game's preview versus local cover adoption.
- Windows rg literal wildcard path was rejected; future searches use -g against the scripts directory.
- Initial unverified public-source guesses returned DNS failure and 404; the valid official launcher URL was subsequently verified. IGDB documentation returned 403; no API-success claim is made.
