# Image Download Progress Implementation Plan

> **For agentic workers:** Use executing-plans in the main session; user explicitly disallows new subagents.

**Goal:** Stable whole-job/current-chapter progress and truthful transport state/bytes/speed.

**Architecture:** Add backward-compatible job progress metadata, a small transfer-rate meter,
and optional source observer callbacks. Fetch selected chapter catalogs before image bodies.
Keep file integrity checks, raw downloads and task persistence in the existing queue.

**Tech Stack:** TypeScript, Node test fixtures/SQLite, Electron IPC, Vue 3.

## Task 1: Prove the progress contract

Files: create `scripts/verify-image-download-progress.ts`; reuse `scripts/helpers/test-images.ts`.

- [x] Synthetic two chapters (2+1 pages); observe queue snapshots. Assert `total===3`
  before the first image request and throughout `totalKnown` snapshots.
- [x] Stream a PNG in two chunks; make one response return 429 before succeeding.
  Assert catalog/receiving/rate-limited states, exact received/stored bytes, final speed zero.
- [x] Requeue completed work; assert reusedPages=3 and receivedBytes=0.
- [x] Load old payload with no progress; assert safe initialized values and no resume side effects.
- [x] Run `node --experimental-strip-types --no-warnings scripts/verify-image-download-progress.ts`;
  require a failure on the missing fixed denominator before changing production code.

## Task 2: Implement source observation and queue accounting

Files: modify `src/types/image.ts`, `electron/kinds/image/source.ts`, `electron/kinds/image/downloads.ts`,
`electron/ipc/image-source.ts`, `electron/preload.ts`, `src/composables/useImageDownloads.ts`;
create `electron/kinds/image/download-progress.ts` for typed defaults and the bounded rate meter.

- [x] Optional source observer reports phase, byte deltas and retry delay; it never includes URL/token/body.
- [x] `boundedBody` reports each accepted byte chunk; existing max-size and cancellation checks stay intact.
- [x] Collect selected chapter pages once per run; lock total only after all catalogs resolve.
- [x] Hash-valid local pages increment completed/stored/reused counters, not network bytes.
- [x] Stream progress updates in memory, notify at most every 250 ms plus state transitions;
  persist only existing page/phase boundaries. Clear timers and speed at every terminal path.
- [x] Normalize historic payloads on load, without restarting interrupted jobs.
- [x] Separate `image:jobs-changed` from library-change notifications so transfer events do not reload the whole bookshelf.
- [x] Run the new test and existing `verify-image-network.ts`, `verify-image-source.ts`,
  `verify-image-download.ts`, `verify-image-library.ts` with Node strip-types; require all pass.

## Task 3: Render and verify the UI

Files: modify `src/components/image/ImageDownloadList.vue` and its focused UI fixture.

- [x] Show job and chapter progress separately; catalog phase is indeterminate.
- [x] Show phase labels, actual stored/received byte sizes and speed; retain existing actions.
- [x] Reuse theme tokens; constrain title and numeric rows, wrapping cleanly at 960x640.
- [x] Run `npm run typecheck`, `npm run build`, isolated source UI verification and `git diff --check`.
- [x] Review state transitions and performance before marking stage 1 complete in the goal ledger.

No commit or release overwrite during intermediate work. Continue to a separate stage-2 plan after this stage passes.
