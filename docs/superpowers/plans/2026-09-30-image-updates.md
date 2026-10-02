# Image Chapter Updates Implementation Plan

> Execute in the main session with executing-plans and test-driven-development. No subagents.

**Goal:** Manually compare source chapters with the local work and download only selected new
chapters into its existing directory, preserving edited metadata, chapter order and reading progress.

**Architecture:** A small updates service combines source.detail, the validated manifest and the
read-only integrity audit. Identity is source chapter ID, never display title. Statuses distinguish
new, downloaded, incomplete, unverified legacy data and local chapters no longer listed remotely.
downloadUpdates rechecks current state before enqueueing. No automatic polling or background updates.
Use the existing queue and attach the target resource ID so deleted/hidden targets cannot be recreated.
When a local chapter order was customized, newly discovered chapters append after that order.

**Tech Stack:** Existing TypeScript/SQLite services, Electron main-window IPC, Vue and Lucide controls.

## Task 1: Read-only comparison and selective enqueue
- [x] Add scripts/verify-image-updates.ts using synthetic source responses and a temporary database.
  Seed two chapters; rename source/local titles independently, remove one local file, add two remote
  IDs including an earlier source ordinal. Check ID-based statuses and unchanged files/database.
- [x] Observe missing service failure, implement electron/kinds/image/updates.ts and shared types.
- [x] Check hidden/local-only sources before network requests; preserve remote-unavailable chapters.
  Reject stale/non-new/invalid selections atomically. Revalidate current path/access before enqueue.
- [x] Download only the selected new chapters into the existing root. Preserve old file bytes/mtime,
  metadata, cover, progress and custom chapter order; no implicit repair of unrelated old missing pages.
- [x] Bind targeted queue jobs to the resource and reject removed/hidden targets before disk writes.

## Task 2: Chapter order preservation
- [x] Observe failure when a new early-ordinal source chapter collides with an existing custom order.
- [x] In ImageLibrary.register, retain existing customized chapter ordinals and append newly found
  chapters after the maximum known ordinal. Preserve natural source ordering for uncustomized works.
- [x] Verify repeated scans do not move appended chapters back into the customized block.

## Task 3: UI and IPC
- [x] Add guarded check-updates and download-updates IPC requiring login; keep returned DTOs path-free.
- [x] Add a source-only update panel with manual check, status rows, new-chapter checkboxes, select-all,
  download action, disabled/busy/error states, last-checked timestamp and queue completion refresh.
- [x] No source detail/page requests on mount; only user checks/downloads may request remote data.
- [x] Build an isolated real-IPC UI test for manual triggering, statuses, selected-only download,
  metadata preservation, auth errors, narrow/wide layout and updated local chapters.

## Task 4: Verification
- [x] Run focused update tests and prior integrity/repair/download/library regressions.
- [x] Run build/typecheck, source/control/progress/updates UI, selfcheck and diff checks.
- [x] Inspect screenshots and update the goal ledger/report. Do not package until stages 5-7 finish.
