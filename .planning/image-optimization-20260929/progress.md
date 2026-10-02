# Progress

## Goal start
- User approved the seven recommended improvements and explicitly requested a goal.
- Created an active goal without a token budget; continuing in the main session.
- Read source, queue, IPC, UI, types and existing download regression tests.
- Root cause of shifting percentage confirmed: job.total += pages.length inside chapter loop.
- Starting stage 1 with regression tests before implementation.

## Stage 1 implementation
- Red regression confirmed denominator 2 instead of 3 for a 2+1 chapter fixture.
- Added normalized optional progress metadata, bounded rolling speed meter, source events,
  whole-job catalog prefetch, byte/reuse accounting and distinct queue/library notifications.
- Refreshed download UI with whole/chapter progress, transport phase, stored/received bytes and speed.
- Added queue, meter, transfer-event and isolated UI tests. Existing image regressions and source UI pass.
- UI fixture initially did not notify already-mounted stores after replacing the jobs handler;
  fixed setup, re-ran against unchanged 0.9.0 (expected missing progressbar failure),
  then against the new build (pass). Screenshots at 1440x960 and 960x640 reviewed.
- Current evidence: output/image-optimization/. Preserve prior release evidence in output/pica-browse-verification/.
- Stage 1 complete on 2026-09-30. Main-session review verified timer cleanup, terminal speed,
  original-image byte preservation, fixed selected-page denominator and isolated queue notifications.
- New checks: progress meter, queue progress (including cancel), partial-stream/retry events,
  UI state/long-title/narrow-window coverage. Existing image network/source/download/library checks passed.
- npm run build and typecheck passed; selfcheck 634 passed / 0 failed; git diff --check passed.
- Goal remains active. Next: stage 2 design/tests for pause/resume, durable queue order,
  page concurrency with serialized manifest commits and coordinated 429 backoff.
- No new release yet. 0.9.0 and the user's running package remain untouched.

## Stage 2 implementation
- Read current files and classified previous turn as concrete progress, not a wait/blocker.
- Added request gate tests and queue control tests; confirmed missing pause API before changes.
- Added 1-3 persisted concurrency (default 2), request-attempt gating, shared 429 cooldown,
  serialized file/manifest commits, paused status, queue order/positions, guarded IPC and controls.
- Gate covers retries as well as first requests. Paused/running cancellation waits for workers and commits.
- Tests cover pause/resume without redownloading good pages, queued pause/reorder, retained paused state,
  actual 3-way overlap, out-of-order completion with 16 intact manifest entries, aborting peers on failure,
  duplicate concurrent enqueues, and running retry being a no-op.
- Additional RED cases found Retry-After was clipped to 10 seconds and cooldown was lost on restart.
  Now parse seconds/HTTP dates without shortening the server wait, and persist retryNotBefore across pauses/restarts.
- Backend control/gate tests and all stage-1 image regressions pass; real-IPC UI control test passed once.
- Stage 2 complete: final build, UI/control/progress/source regressions and selfcheck (634/0) passed.
- Added task-center attention/all filter coverage: observed failure with a completed comic visible;
  passed after sharing the filter, retaining paused work and fixing the empty-results state.
- Re-ran control UI after the final build; git diff --check passed (line-ending warnings only).
- Stage 3 starts with metadata/manifest/audit/repair tests; no release or user-profile changes.

## Stage 3 complete
- Added image-size 2.0.4 (pure JS, exact pin, no install scripts) for actual dimensions/format/bytes.
- Shared validated manifest reader; new downloads persist expected chapter page IDs before transfer.
- Read-only audit merges expected pages and local indexes, detects checksum/extension mismatches,
  missing files/whole chapters, rejects traversal/external directory links, honors hidden resources.
- Local files without source hashes are unverified, not falsely marked integrity-verified. Old manifests
  disclose incomplete catalog coverage. Audit reads current disk state even if an index says missing.
- queue.repair(resourceId) freshly audits and schedules only damaged/missing source page IDs. Repair
  survives pause/restart, does not depend on old job records, preserves good file bytes/mtime and
  customized title/tags/group/publication/chapter order/progress, and excludes newly appearing source pages.
- Existing chapter directories and filenames remain stable; previously unsaved pages follow saved catalog
  order even if remote order changes. A source format change fails safely without replacing/duplicating files.
- Added guarded page-info/audit/repair IPC, detail audit panel ahead of previews, reader specifications.
  Completed jobs refresh the panel; dismissing a paused repair restores controls instead of leaving them disabled.
- RED tests observed missing audit/repair APIs, source-format duplicate-page risk, wrong extension accepted,
  stale missing index, missing-page order drift, missing UI action and stuck controls after dismiss.
- GREEN: integrity/repair, control/gate/progress/network/source/transfer/library/download regressions;
  final build (including typecheck), selfcheck 634/0 and git diff --check (CRLF warnings only).
- Final build UI checks passed: integrity, download control/progress, source, existing image library/reader/import
  including application restart. Screenshots reviewed at 1440 and 960 widths.
- Evidence: output/image-optimization/integrity-ui, library-ui-stage3, source-ui-stage3,
  integrity-build.log and selfcheck-stage3.log. Report: docs/superpowers/reports/2026-09-30-image-integrity.md.
- No current exec sessions, no release yet. Stage 4 is next; goal remains active.

## Stage 4 complete
- Previous goal turn classified as progress: stage 3 changed source and produced verified evidence.
- Added updates.ts with manual source-ID comparison, source/local title distinction, downloaded,
  incomplete, new, legacy-unverified and source-unavailable states. Check does not mutate disk/DB.
- Download rechecks selection and accepts only current new chapters; old damaged chapters are not
  implicitly repaired. Target is the existing resource/directory, not a newly chosen root.
- Queue requests now accept an internal {resourceId,repairPages} option. Targeted repairs/updates
  are bound to the original item; deleted or hidden queued targets fail before filesystem changes.
- Fixed an observed RED case: new source preface chapter was interleaving a user's customized order.
  New chapters now append after custom order and retain it on later scans, including missing chapters.
- Update panel checks only on user action, shows per-chapter states, supports new-only selection,
  requires login via guarded IPC, clears stale results after download and refreshes the local detail.
- Tests: verify-image-updates.ts and verify-image-updates-ui.ts. UI proved RED before integration.
  Verified selected-only image requests, no mount-time network calls, same-directory downloads,
  metadata/cover/progress preservation, old manifest warning, remote removal preservation,
  repeated scan stability, hidden checks and deleting a target while queued.
- Final build/typecheck passed. Final UI: updates, integrity, download control/progress and source passed.
  Existing integrity, repair, control, progress, download and library regressions passed.
  Selfcheck 634 passed / 0 failed; git diff --check passed with CRLF warnings only.
- Evidence: output/image-optimization/updates-ui (wide/narrow screenshots reviewed), source-ui-stage4,
  updates-build.log, selfcheck-stage4.log. No test exec sessions remain live.
- Stage 5 next: reader zoom/pan, cover-single spread alignment, per-work preferences, bookmarks,
  and read status independent from publication. No stage-5 implementation yet; inspect current reader,
  schema, backup/restore and preferences before design/tests. Goal remains active; no release yet.

## Stage 5 complete
- Schema 12 adds image_reader_state and image_bookmarks, guarded reader IPC and backup validation.
  Older schema-11 backups remain supported. Also fixed paused download backup validation.
- Reader now uses pinned @panzoom/panzoom 4.6.2 for paged zoom/pan (25-400%), bounded translation,
  actual image dimensions and rotation. Continuous mode preserves page-relative offset on zoom/resize,
  supports pointer drag scrolling, and keeps at most seven page images mounted.
- Cover-aware spread helper aligns direct jumps/backwards navigation, never pairs across chapters.
- Per-work preference writes are serialized. Global-default save/reset are explicit; reset persists after close/restart.
- Added bookmark create/rename/delete/jump/offset and independent read toggles in reader and detail.
- RED evidence: new Electron rehearsal failed on missing zoom control against the previous build.
  After full build passed zoom/drag/rotate/reset/limits, RTL/cover rules, continuous drag, bookmarks,
  work isolation, defaults and restart. An intermediate UI run started before main-process build
  completed and used the stale preload; rerun after the build completed passed without code change.
- Passed reader state/layout, backup 75/0 and backup IPC 7/0, integrity/repair/updates, download
  control/progress/meter/gate/transfer/network/source/library/download regressions.
- Built and typechecked successfully; selfcheck 634/0. UI regressions: library/import/reader/photos,
  source, updates, integrity, download control/progress. git diff --check passed (CRLF warnings only).
- Evidence: output/image-optimization/reader-ui, library-ui-stage5, source-ui-stage5,
  reader-build.log, selfcheck-stage5.log and regression-stage5-*.log. Screenshots inspected at 1440/960.
- Stage 6 starts with measurements: current library.list performs a get() (five queries) per item;
  Home.vue mounts the entire shelf, while covers already use native lazy image loading.
- Goal remains active. No release/commit/tag; version remains 0.9.0 during development.

## Stage 6 complete
- Added transactional bulkUpdate API/IPC/preload: classification, add/remove/replace tags, independent
  read state. Validates all IDs, hidden resources/destinations and 1-5000 selection limit before writes;
  any later DB error rolls the entire selection and tag-pool changes back. Emits one changed event.
- Added ImageShelf (60-item pages) and ImageBulkPanel, current-page/all-results selection, selection
  persistence across pages, filter-reset selection, explicit tag replacement confirmation, error/retry,
  read badges and a read filter independent from publication. Preserves page on detail navigation.
- Found and fixed RED empty-filter pagination: a resultless filter unmounted the shelf and prevented
  its page-reset watcher. Moved the remembered page reset to the persistent image store.
- Optimized library.list from per-item get queries to two relational reads. Added resource_id to
  chapter/page joins so SQLite can use the existing resource-first index. No schema/index change.
- Baseline: 2000 works/48000 indexed pages, Node SQLite, 10001 preparations, 111345 ms, 1374209-byte payload.
  Final measured optimized run: 2 preparations, 126 ms, same payload and list/detail values.
  Earlier 98 ms is another run, not a separate guarantee. A first overlapping trial was discarded;
  baseline.json holds the later isolated measurement.
- Actual Electron 500-work UI baseline: 500 mounted cards/images, 3215 DOM nodes, 1362 ms until loaded cover.
  Final rehearsal: 60 cards/images, 731 nodes, 405 ms. Native lazy image loading already exists;
  decoded-at-first-cover counts vary with async scheduling (9 baseline, 14 final), so no unsupported
  claim of reduced decoder work and no new cache/worker implementation.
- Synthetic UI initially used non-hex page IDs and covers were rejected by the protocol; fixed fixture
  IDs (32 hex) and used real CBZ media. This was a fixture issue, not an application failure.
- Passed bulk/list parity for missing progress/cover, read/tag/search/group filters, hidden rules,
  malformed input, duplicate selection, rollback injection and no filesystem writes.
- Real Electron tests: page/all-result selection, cross-page selection, one notification, filter reset,
  zero-results reset, read filters, stale hidden destination with retry and confirmed tag replacement.
  960/1440 screenshots inspected. Original library/reader/source/update/integrity/download UI passes.
- Final build/typecheck passed. Backend regressions passed; selfcheck 634/0; git diff --check passed
  (CRLF warnings only). No remaining exec sessions. Evidence under output/image-optimization:
  library-performance, bulk-ui, bulk-build.log, library-ui-stage6, source-ui-stage6,
  regression-stage6-*.log, selfcheck-stage6.log.
- Stage 7 inspection only, no implementation yet: database.ts backupBeforeMigrate currently probes
  old schema, VACUUM INTOs a fixed .bak name, skips if already present, and logs/continues on errors.
  getDb assigns its singleton before initSchema. main.ts whenReady chain has no startup failure UI.
  Existing data:export-json/restore-json handlers and Settings data/about panels should be extended.
- Stage 7 must create verified snapshots before upgrade writes, fail closed with visible startup error,
  preserve all old backups, report version/data/snapshot metadata and keep manual backup/restore.
- Goal remains active. Versions are still 0.9.0; final target 0.10.0 has not been built or released.

## Stage 7 in progress
- Prior turn was progress: stages 5/6 implemented and verified, with persisted reports and benchmarks.
- Added library-snapshots.ts with readonly probe, unique VACUUM INTO snapshots, SQLite quick_check,
  bounded-memory SHA-256 recording, manifest published after verification, version/schema gating,
  future-schema refusal and last-successful version recorded only after initialization succeeds.
- No automatic snapshot deletion. Inventory tracks available/missing/changed files, orphan/invalid
  manifests, old .bak counts and existing recovery snapshots. JSON export path/time/size recorded.
- Replaced database.ts's log-and-continue migration backup with the fail-closed service, assigning
  singleton only after schema initialization. Failed initialization closes its connection.
- main.ts now takes its single-instance lock before getSettings can open/upgrade the DB. Early
  protection failure is retained, surfaced with showErrorBox after ready, and exits without opening
  a main window or interrupting persisted tasks. No retry through game finalization after failure.
- Added guarded snapshot info/create/open IPC, preload/types and unframed settings safety panel.
  Existing JSON export/restore stays available. Latest export refreshes the panel.
- RED observed missing safety service, missing visible startup failure path, missing snapshot IPC
  and missing create-snapshot UI against stage-6 build.
- GREEN so far: verify-library-upgrade.ts (WAL/schema/app-version/empty/legacy/corrupt/future data,
  snapshot/verification/manifest/migration failures and retries), verify-library-startup.ts (real
  database singleton failure/retry plus main.ts failure/secondary-instance behavior), snapshot IPC,
  existing backup IPC 7/0. UI tests and real Electron failure harness are written but not yet verified.
- Build/typecheck now running or just completed; collect the live tool results before proceeding.
  Version still 0.9.0, no new release. Next: real Electron success/failure/UI, regression, report,
  then full completion audit and 0.10.0 packaging.

## Stage 7 complete; release audit in progress
- Collected successful stage-7 build and backend/UI regressions; selfcheck-stage7.log ends 634/0.
- Actual Electron startup failure cases exit 1 with zero windows and byte-identical source DBs.
- Upgrade UI verifies pre-schema-12 snapshot, manual snapshot/export, folder action, restart without
  duplication and missing-file display. Inspected both wide screenshots in addition to prior narrow ones.
- Added the stage-7 report. All seven feature stages are implemented; the goal remains active until
  0.10.0 is built, tested as a packaged executable and delivered with source/manifest/checksums.
- Extending existing isolated UI rehearsals to accept a packaged executable and preserve separate
  packaged evidence. No new agents and no changes to the running old app or real library.

## Final release delivered
- All seven requirements audited against the approved spec, source and tests. See the final report
  docs/superpowers/reports/2026-09-30-image-optimization-release.md.
- Package and both lockfile versions are 0.10.0. npm run dist:dir completed; standard AppData
  executable is release/0.10.0/win-unpacked. No installer/green/portable-data build was produced.
- Final tests: config 5/0, selfcheck 634/0, 25 backend/component suite commands passing (task
  operations 20/0), ten actual packaged UI suites passing, three real Electron failure rehearsals.
- Final verifier matches 60 compiled files, native SQLite and MediaInfo resources. Final packed
  500-work shelf: 60 cards, 731 DOM nodes, 342 ms until first loaded cover. No decoder claim.
- Updated stale test assumptions only: video detail tab/edit actions and unique poster fixtures;
  legacy import tests kept and current preview-import/remount/cancel behavior added. Initial
  failures and successful reruns are explicitly identified in release/0.10.0/verification.json.
- Source ZIP: 446 allowlisted source/config/script/resource/release-document files, all hashes
  independently read from the archive and checked against the current files. 130 delivered files
  checked against SHA256SUMS. Local dirty-worktree provenance retained; no commit or Git tag.
- Existing 0.9.0 manifest verified: all 126 files unchanged. User-confirmed old package still in
  its original path; no real profiles or user downloads touched. No active test processes remain.
- Updated release/current.json and release/README.md only after artifact verification. Old releases
  and stage process evidence retained. Current release notes include unsigned-binary, backup
  scope, original-quality and synthetic-network limitations.
