# Library upgrade protection checkpoint

Stage 7 implementation is complete. Final release packaging and its acceptance audit remain pending.

## Delivered
- Read-only probing and consistent VACUUM INTO snapshots before writable schema initialization.
  Existing WAL commits are included. SQLite quick_check and bounded-memory SHA-256 verify creation.
- Unique files and exclusive manifests preserve all earlier snapshots, legacy backups and recovery
  files. Failures retain orphan files rather than deleting potentially recoverable data.
- Refuse corrupt, unrecognized and future-schema databases. Protection failure stops startup with
  a visible error and no main window. Acquire the single-instance lock before opening the database.
- Publish the database singleton and successful application version only after initialization succeeds.
  Restarting the same successful app/schema does not create another automatic snapshot.
- Guarded settings IPC shows actual app/schema/data paths, snapshot inventory and successful JSON
  export information, with manual snapshot and folder actions. Existing JSON restore remains intact.
- Creation verification is historical; current file status checks existence/size, not a fresh hash audit.
  Snapshots contain the database and local settings, not downloaded media, and are not auto-pruned.

## Evidence
- Service tests cover WAL, schema/app-version changes, empty/legacy/future/corrupt libraries, quote
  paths, injected snapshot/verification/manifest/migration failures, retries and manifest path rejection.
- Startup harness exercises actual database singleton failure/retry and main-process lock ordering.
- Real Electron failure harness: blocked snapshot directory, corrupt database and future schema each
  exit 1 with zero windows; original database bytes remain identical.
- Real Electron UI: schema 11 to 12, pre-migration rows/settings in snapshot, manual snapshot, JSON
  export, directory action, restart without duplicate snapshot and missing-file state all pass.
- Guarded snapshot IPC passes; existing backup IPC is 7/0. Image library, reader, bulk, update,
  integrity, source and download UI/backend regressions pass. Typecheck/build pass, selfcheck 634/0.
- Inspected 960/1440 protection and snapshot screenshots; no overflow. Diff check passes (CRLF warnings).

Evidence is in output/image-optimization/upgrade-ui, startup-safety, upgrade-build.log,
regression-stage7-*.log and selfcheck-stage7.log. Only disposable profiles and synthetic data were used.
No real profile, release/0.9.0 or running user application was changed.
