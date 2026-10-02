# Image Download Control Implementation Plan

> **For agentic workers:** Use executing-plans in the main session. No subagents or new worktrees.

**Goal:** Durable pause/resume and queue order, with 1-3 concurrent page transfers and coordinated rate limiting.

**Architecture:** Keep one active work at a time. Use a per-job request gate around each
image attempt, including retries, so HTTP 429 lowers concurrency to one and defers all
new attempts. At most three page workers read/download; one commit chain writes files,
manifest and counters. Pause/cancel waits for workers/commits to settle before returning.

**Tech Stack:** TypeScript, Node promises/AbortSignal, SQLite settings/job JSON, Electron IPC, Vue.

## Task 1: Gate and queue regression tests

- [x] Create `scripts/verify-image-request-gate.ts`: two requests overlap at limit 2;
  a third waits; 429 cooldown prevents early starts and caps later requests at one;
  queued cancellation releases listeners and does not execute work.
- [x] Create `scripts/verify-image-download-control.ts`: pause an active transfer after
  one complete page, continue only missing pages; pause queued work, reorder other queued
  work and check execution order; reload paused work without automatically starting it.
- [x] Test out-of-order page completion produces a complete manifest and correct page ordering,
  first worker error settles others before marking terminal, and cancelled attempts leave no .part files.
- [x] Observe failures before production changes.

## Task 2: Implement request gate and safe parallel commits

Files: `electron/kinds/image/request-gate.ts` (new), `source.ts`, `downloads.ts`,
`download-progress.ts`, `src/types/image.ts`.

- [x] Gate capacity reads the persisted preference (default 2, integer 1-3). Defer is shared
  across retries, occurs before releasing the failed attempt, and remains serial for that job.
- [x] Source accepts an optional attempt gate; standalone cover/source clients retain existing behavior.
- [x] Concurrent workers use a serialized commit chain. Abort peers on first failure and await all
  workers before terminal status or starting the next job. Preserve the first real failure cause.
- [x] Pause is distinct from cancellation, preserves good files and survives restart; resume checks
  old hashes and requeues safely. Disallow duplicate active/paused work, including concurrent enqueues.
- [x] Persist queueOrder and expose queuePosition; move only queued jobs, not the active transfer.
- [x] Aggregate transport phases across workers; a single waiting/retrying worker must not hide
  active reception, while a whole-job cooldown is visible.

## Task 3: IPC and UI

Files: `electron/ipc/image-source.ts`, `electron/preload.ts`, `src/types/image.ts`,
`src/composables/useImageDownloads.ts`, `src/components/image/ImageDownloadList.vue`.

- [x] Add guarded pause/resume/move/options IPC; resume requires a valid login.
- [x] Add icon controls with titles, busy state, queue position and numeric concurrency input.
- [x] Mark paused work as needing attention without counting it as running.
- [x] Use an isolated Electron UI fixture to drive real IPC pause/resume/order/options,
  verify task refresh and inspect wide/narrow screenshots.

## Task 4: Verification and checkpoint

- [x] Run new control/gate tests plus previous progress/network/source/download/library regressions.
- [x] Run typecheck/build, source UI and progress UI with isolated profiles and separate evidence paths.
- [x] Main-session review of cancellation, permit release, manifest atomicity and version/data safety.
- [x] Update goal ledger and delivery report; leave 0.9.0 and real user data untouched.
