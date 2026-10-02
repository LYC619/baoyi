# Image Reader Enhancement Implementation Plan

> Main-session execution with executing-plans and test-driven-development. No subagents.

**Goal:** Zoom and pan, standalone cover spreads, per-work preferences, bookmarks and independent
read status, with restart/rescan/backup preservation and no change to original image files.

**Architecture:** Add image_reader_state (per-work preferences and read flag) and image_bookmarks
(one bookmark per page, with offset and label), owned by the resource/page through foreign keys.
Keep global defaults in the existing settings key. Use schema 12 and extend metadata backup/restore,
including paused-download compatibility and older schema-11 backups. Use @panzoom/panzoom for paged
zoom/pan; continuous mode retains native scrolling/virtualization with scaled page measurements.
Extract pure spread navigation rules for cover-first alignment and chapter boundaries.

**Tech Stack:** Vue, Lucide, @panzoom/panzoom, existing SQLite/Electron TypeScript APIs.

## 1. Reader data and backup
- [x] Add scripts/verify-image-reader-state.ts; observe missing service failure. Cover global defaults,
  per-work overrides/reset, validated zoom/cover settings, independent read/publication/progress,
  bookmark upsert/label/offset/ownership/missing pages, rescan/restart and cascade deletion.
- [x] Add schema 12 tables and ImageReaderState service. Extend ImageItem/Patch with read boolean,
  and add guarded reader-preferences/bookmarks/save-bookmark/remove-bookmark IPC/preload types.
- [x] Extend backup table allowlist, validation and ownership checks; normalize older backups to empty
  new tables. Test round-trip of reader state/bookmarks and paused jobs, malformed input rollback,
  and migration from schema 11 without changing existing metadata.

## 2. Spread and zoom behavior
- [x] Add pure spread helpers and tests for cover solo, odd/even chapters, backwards navigation,
  direct page jumps and no cross-chapter pairing; keep photos single-page.
- [x] Pin @panzoom/panzoom. Use actual image dimensions to size the paged canvas before applying
  zoom/pan, keeping rotate/fit/fullscreen behavior. Clamp zoom to 25-400 percent and reset pan on page changes.
- [x] Continuous mode reflows page measurements on zoom, preserves page-relative scroll location,
  supports pointer drag scrolling, and keeps rendered/preloaded images bounded.

## 3. Reader controls
- [x] Add stable responsive toolbar controls for modes/fit/zoom/reset, bookmark toggle/list,
  read status, settings and fullscreen. Controls must not overlap content or resize on dynamic labels.
- [x] Per-work preference changes stay local; explicit save-as-global and reset-to-global actions.
  Settings includes cover-single toggle. Bookmarks support navigation, rename and removal.
- [x] Detail page exposes read toggle independently from publication and progress.
- [x] Use a real-IPC Electron fixture: prove missing features RED, then exercise zoom/pan/spreads,
  bookmarks/offsets, work isolation, read status, hidden resources, restart and wide/narrow screenshots.

## 4. Verification
- [x] Run focused reader/spread/backup tests plus image download/update/integrity/library regressions.
- [x] Adapt existing reader UI tests to intentional toolbar/spread behavior changes, retaining the
  same import/reading/progress/restart coverage. Run build/typecheck, selfcheck, UI and diff checks.
- [x] Inspect screenshots, record evidence and leave the goal active for stages 6-7 and final packaging.
