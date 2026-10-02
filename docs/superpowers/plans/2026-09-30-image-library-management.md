# Image Library Management Implementation Plan

> Main-session executing-plans and test-driven-development. No subagents or new chats.

**Goal:** Atomic bulk category/tag/read changes and measured large-library improvements.

**Architecture:** Retain ImageLibrary/ImageApi and the existing shelf. Measure SQL calls, elapsed
time, payload and mounted/decoded covers using synthetic data. Replace per-item list queries with
batched relational reads while retaining the exact list/detail contract. Bound shelf DOM with explicit
60-item pagination. Selection belongs to the current filtered result set, survives page changes,
and clears on query changes. Backend revalidates every ID and destination inside one transaction.

**Tech Stack:** Existing Vue/Pinia, SQLite, Electron IPC and Lucide. No new UI framework.

## Measurement And Contract
- [x] Add reusable synthetic library fixture and scripts/verify-image-library-performance.ts.
  Save baseline before optimizing. Normal run must fail when list uses more than five SQL preparations.
- [x] Add a real Electron UI measurement of load, DOM/image counts, decoded covers and page navigation.
  Save pre-change metrics and observe missing selection/pagination failure.
- [x] Preserve list/detail equality for chapters, missing-page counts, custom covers, read state,
  progress and filters. Verify hidden resources do not leak through filters or aggregates.

## Atomic Bulk Changes
- [x] Add scripts/verify-image-bulk.ts, first failing on missing bulkUpdate. Test 1-5000 distinct IDs,
  category and read, tags add/remove/replace, normalization, absent/hidden resources, unavailable
  destination, invalid types, rollback after a database write failure and no changes to files/progress.
- [x] Add ImageBulkPatch and bulkUpdate IPC/preload. Implement transaction in
  electron/kinds/image/library.ts with strict allowlist validation before writes. Hidden destinations
  are rejected. Empty/oversized selections reject, duplicate IDs count only once. Reuse tags rules.
- [x] Return changed count and emit one image:changed event after successful commit, none on error.

## Measured Improvements
- [x] Optimize library.list in electron/kinds/image/library.ts, combining list reads and grouping
  chapters instead of calling get per result. Keep get contract; compare benchmark before/after.
- [x] Add per-page count bounded to 60, previous/next icon buttons, current/total page indicator and
  reset/clamp when filters or result counts change in src/components/image/ImageShelf.vue (integrated by src/pages/image/Home.vue). Existing lazy cover
  loading stays enabled. Avoid premature new caches or workers.
- [x] Add selection mode with native checkboxes, current-page selection and explicit all-results
  selection up to backend limit. Never silently carry selections into another type/filter.
- [x] Add src/components/image/ImageBulkPanel.vue for selected count, category, tag action/input,
  read state and apply. Preserve unchanged fields by default, show errors, and disable during save.
- [x] Add read filter independent of publication to ImageQuery and src/stores/image.ts. Read-only
  badges in grid/list identify marked works. Continue-reading behavior remains progress-based.

## Verification
- [x] Run bulk/benchmark and existing library/reader/update/download/backup tests, typecheck/build.
- [x] Rehearse select/apply/error/filter/page changes, large shelf and 960/1440 screenshots in Electron.
  Compare load/DOM/decoded counts against baseline. Inspect screenshots for overflow/overlap.
- [x] Update report and ledgers, then stage 7. Version stays 0.9.0 until final release validation.
