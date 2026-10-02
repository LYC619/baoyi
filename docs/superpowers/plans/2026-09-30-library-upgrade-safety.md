# Library Upgrade Safety Implementation Plan

> Main-session executing-plans and test-driven-development. No subagents.

**Goal:** Verified, consistent pre-upgrade database snapshots; failed protection stops startup;
settings show the actual version, schema, data directory and snapshot/export information.

**Architecture:** A pure SQLite/filesystem library-snapshots service accepts a database opener,
so Node SQLite tests exercise the same safety logic as better-sqlite3 in Electron. Probe existing
databases read-only and snapshot before any journal/schema/version writes. VACUUM INTO includes
committed WAL data; quick_check and a recorded SHA-256 verify creation. Unique filenames preserve
older snapshots and .bak files. Same successful app/schema version does not snapshot on every launch.
Any unrecognized existing database or snapshot failure aborts upgrade. New empty libraries skip it.

**Tech Stack:** Existing SQLite, filesystem, Electron IPC, Vue settings and Lucide.

## Safety Service
- [x] Add scripts/verify-library-upgrade.ts. Prove missing service RED. Test WAL snapshots, schema
  and app-version changes, unversioned legacy data, new/empty libraries, repeated launches, quote
  paths, preserved previous backups, future schema refusal and corrupt source refusal.
- [x] Add electron/services/library-snapshots.ts and src/types/library-snapshot.ts. Export
  openUpgradedDatabase, createLibrarySnapshot, readSnapshotInventory and record export helpers.
- [x] Inject VACUUM/verification/metadata/migration failures: no writable upgrade connection before
  verified protection, failed migration closes its handle, last-successful version only after success,
  and retries retain all previous snapshots. No automatic deletion of snapshots or media files.
- [x] Inventory validates manifest shape and contained filenames, distinguishes missing/changed
  files, limits returned records and surfaces malformed/orphan records. Creation verification is
  labelled as such, not presented as a live recheck. Show old .bak count separately.

## Startup Integration
- [x] Replace database.ts backupBeforeMigrate with openUpgradedDatabase around initSchema and
  journal setup. Assign the singleton only after schema initialization succeeds. Preserve current
  artwork migration behavior and keep old recovery assets.
- [x] Wrap main.ts startup rejection with visible failure dialog and exit without opening main UI.
  Test with a mocked Electron boundary and real isolated database, then actual Electron upgrade UI.

## Data Information
- [x] Add guarded data:snapshot-info, data:create-snapshot and data:open-snapshot-dir handlers,
  preload and types. Info includes app/schema version, actual DB/data paths, snapshot inventory,
  old backups and last successful JSON metadata export. Never accept caller-supplied snapshot paths.
- [x] Extend JSON export to remember path/time/size only after successful write. Keep the existing
  export/restore formats, confirmation, recovery snapshot and restart behavior.
- [x] Add a settings data-section component with refresh, manual snapshot, open-directory,
  snapshot list and last export status. Keep existing manual export/restore actions. No decorative
  cards around this section; use the existing restrained settings layout and responsive rows.

## Verification
- [x] Run service/IPC/real Electron rehearsals: schema-11 data upgrades to 12 only after snapshot,
  snapshots contain pre-migration rows/settings, restart does not duplicate, manual snapshot creates
  another file, metadata export info refreshes and foreign frames are rejected.
- [x] Inspect 960/1440 screenshots and failure startup evidence. Run backup, image reader/bulk,
  library/download/update regressions, build/typecheck, selfcheck and diff check.
- [x] Record stage 7 evidence. Then audit all seven requirements, bump to 0.10.0, package into a
  new release directory and validate that package using disposable profiles. Do not overwrite 0.9.0.
