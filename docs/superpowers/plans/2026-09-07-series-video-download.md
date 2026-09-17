# Series Video Download Completion Plan

**Goal:** Complete the interrupted series download workflow in the existing checkout.

**Authorization:** Continue task 01a070f7-970b-7c31-b196-e025c8711a1a. The user authorized completing the work without stepwise approval and requested no subagents. Preserve the existing dirty checkout and the running application.

**Architecture:** Reuse the download service's shared transfer lock, native directory picker, streaming transfer, and runtime task center. The main process owns the playlist; renderer selections must be a nonempty subset of that playlist. Resolve and transfer episodes serially. Include the current episode when it appears in the playlist, preserve order, and deduplicate IDs. Show each episode's result and retain successful files when cancelled.

**Tech Stack:** Existing TypeScript, Electron, Vue, node-html-parser, and offline regression scripts. No added dependencies.

## Service and Sources

- [x] Restore context and run existing series/service UI tests and typecheck.
- [x] Extend `scripts/verify-video-series-download.ts`: current episode, deduplication, selection validation, stale catalogs, cancellation/cleanup, saved-directory lookup, warnings, per-episode events, and existing files.
- [x] Observe failures, then update `sources.ts`, `service.ts`, `transfer.ts`, and `src/types/video-download.ts` to satisfy the tests. Preserve poster parsing and library records.
- [x] Add the service regression to `package.json` and rerun affected download tests. Series 18/0, transfer 29/0, source/service 20/0, task-center UI passing.

## Renderer and Task Center

- [x] Extend `scripts/verify-video-series-download-ui.ts` for selection, result logs, terminal progress, request isolation, and late cancellation responses; observe failures.
- [x] Complete `useVideoSeriesDownload.ts` and `SeriesDownload.vue`: select all/subset, retry failed selections, actual episode titles/IDs, bytes/speed, accessible progress, results, and directory reveal.
- [x] Give series tasks an episode-count task kind; verify `TaskCenter.vue` does not format episodes as bytes. Expose the series panel for Hanime resources regardless of local classification.
- [x] Verify compiled Vue components with the existing offline renderer harness. Renderer/SFC 12/0. Playwright at 1280x900, 390x844, and 320x780 verifies selection, unmount/remount, results, retry, and overflow with an isolated mock IPC bridge.

## Verification and Delivery

- [x] Run download, task, settings, verification-window, and poster regression scripts, module checks, and selfcheck.
- [x] Run `npm run build` and inspect changes. Record results and remaining real-site/GUI limitations in `2026-09-07-series-video-download-verification.md`.

Runtime-only queues remain consistent with the approved scope: no restart recovery, byte-range resume, automatic registration, packaging, or app restart in this completion pass.
