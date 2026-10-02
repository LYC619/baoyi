# Image Integrity Implementation Plan

> Execute in the main session using executing-plans and test-driven-development. No subagents.

**Goal:** Show actual file specifications, audit local/manifest pages without writes,
and repair only selected missing or damaged source pages without overwriting edits.

**Architecture:** A shared manifest reader validates identity and relative paths. A read-only
integrity service combines expected source entries and indexed local pages, with SHA-256
for source files and conservative unverified status for local files without a checksum.
Use the maintained image-size package for dimensions rather than custom binary parsers.
Metadata is read on demand, avoiding schema migration and full-library startup work.
Repair is a normal durable queue job restricted to page IDs selected by a fresh server-side
audit, using existing pause/retry/concurrency machinery. No arbitrary renderer file paths.

**Tech Stack:** TypeScript, image-size, Node fs/crypto, existing SQLite/Electron/Vue APIs.

## 1. Metadata and read-only audit
- [x] Add tests in scripts/verify-image-integrity.ts for PNG/JPEG/WebP dimensions,
  valid/missing/checksum-mismatch pages, local unverified pages, malformed manifests,
  complete missing chapters, traversal/symlinks, hidden resources and unchanged files/DB.
- [x] Observe missing API failures, then add metadata.ts, manifest.ts and integrity.ts.
- [x] Include expected page IDs in manifest chapters before image requests. Old manifests
  remain readable; audits explicitly disclose that old catalogs may be incomplete.
- [x] Show original dimensions/format/size in the reader and a work-level audit panel.

## 2. Selective repair
- [x] Add queue tests in scripts/verify-image-repair.ts. Damage/delete two of three pages,
  verify only those two get network requests; preserve good bytes/mtime, user name/tags/group,
  customized chapter order, progress and manifest entries. Reject hidden/active/unsafe work.
- [x] Add queue.repair(resourceId), restricted-page job persistence, stable existing chapter
  directories and metadata preservation. Rescan only after repair commits finish.
- [x] Failed remote-ID lookup must fail clearly, not mark missing pages repaired or download
  newly added pages outside the selected repair set. Repair does not depend on job history.

## 3. IPC/UI and verification
- [x] Guard page-info/audit/repair IPC; local audit requires no login, repair requires login.
- [x] Add ImageIntegrityPanel to the existing detail page, with busy/error/summary states,
  failed-page listing and repair action. Keep layout unframed and responsive.
- [x] Run real-IPC UI checks with synthetic fixtures at wide/narrow sizes. Inspect screenshots.
- [x] Run image regressions, build/typecheck, selfcheck, diff checks; record evidence and
  update the goal ledger. Preserve existing release and user data.
