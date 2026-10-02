# Image workflow 0.10.0 acceptance

Main-session serial execution. No subagents, commits, tags or real-account downloads.

## Requirement audit
| Stage | Acceptance and preservation | Evidence |
| --- | --- | --- |
| 1 | Fixed whole-job denominator, chapter progress, actual transfer bytes/speed, explicit waiting states | progress, meter, transfer-events and packaged progress UI |
| 2 | Durable pause/order, missing-only resume, 1-3 page limit, shared cooldown, settled workers | gate, control and packaged real-IPC control UI |
| 3 | Original bytes/specs, read-only integrity checks, damaged/missing-only repair | integrity, repair and packaged audit/reader metadata UI |
| 4 | Manual stable-ID comparison, selected-new-only download, preserve edits/order/progress | updates and packaged updates UI |
| 5 | Panzoom limits/drag, cover spreads, per-work preferences, bookmarks, independent read state | reader layout/state, backup and packaged reader/restart UI |
| 6 | Atomic bulk changes, hidden guards, one notification, bounded shelf and measured SQL reduction | bulk, performance benchmark and packaged bulk UI |
| 7 | Snapshot before upgrade writes, fail-closed startup, visible version/paths/export inventory | upgrade/startup/snapshot IPC and packaged upgrade UI |

## Final verification
- Release config: 5 passed; selfcheck: 634 passed, 0 failed.
- Twenty image/library backend suites passed under final-* logs, plus video library UI, posters,
  database, service and task operations (20 passed, 0 failed): 25 suite commands in total.
- npm run dist:dir completed with typecheck and native dependency rebuild, Electron 37.10.3 x64.
- Ten suites ran the actual release/0.10.0/win-unpacked executable on disposable profiles:
  image-download-progress-ui, image-download-control-ui, image-integrity-ui, image-updates-ui,
  image-reader-ui, image-bulk-ui, library-upgrade-ui, image-source-ui, image-ui, video-packaged-ui.
- The final compiled main was exercised in real Electron for blocked snapshot directory, corrupt
  source and future schema: exit 1, zero windows, byte-identical input databases. This failure
  harness replaces only the native error dialog and uses development Electron, not the packaged exe.
- 60 compiled files match the ASAR byte-for-byte; native SQLite and MediaInfo WASM are present.
- Verified 126 files against the existing 0.9.0 manifest. The user-confirmed old package remains present.
- Source ZIP rechecked against all 446 source-file hashes; 130 delivered files match SHA256SUMS.
- Packaged screenshots inspected; no overlapping reader controls or narrow settings overflow.
- Final packaged 500-work shelf: 60 cards, 731 DOM nodes, 342 ms to first loaded cover. Earlier
  isolated data benchmark: 10001 to 2 statements, 111345 to 126 ms, identical payload. No decoder claim.

## Test maintenance found during audit
- Old video packaged UI assumed grouping/type fields were always visible. It now uses the actual
  files tab/edit action, distinct fixture poster bytes and the migrated fixture artwork path.
- Task operations tests predated preview-confirm import. Retained direct legacy-import coverage;
  added real current Home preview lifetime/progress/remount and cancelled-picker coverage.
- These corrections change only verification scripts, not video application behavior.
- Content verifier uses platform-native paths for the ASAR API on Windows.

## Delivery and limits
New standard AppData directory release only. Local dirty-worktree provenance, not a tagged release;
source ZIP and SHA-256 are generated and independently rechecked by finalize-local-release.ps1.
Release pointer updates happen after this artifact gate. Detailed results are in verification.json.
No auto-pruning of snapshots, migration of real user data, deletion of old packages or suppression
of system security was performed. Binary is unsigned. Existing Sass/Vite/WASM warnings remain.
Synthetic network success does not imply all live providers/proxies/accounts are verified.

Evidence root: output/image-optimization. Per-stage reports retain their historical checkpoint status;
this report and docs/releases/0.10.0.md are the final release-level record.
