# Image integrity checkpoint

Stage 3 is implemented and verified in source. Final release remains pending stages 4-7.

## Delivered
- Reader shows actual dimensions, original file format and byte size without converting stored files.
- Detail page audits expected manifest pages and local indexed pages without modifying files or database.
- Source checks compare SHA-256; missing files, mismatched bytes, invalid format/extension and external
  path links are reported. Unhashed local files remain explicitly unverified after header/dimension checks.
- New manifests retain expected page catalogs; older catalogs remain compatible with limited-coverage notice.
- Repair is a durable, pausable queue job restricted to freshly audited bad source pages. It preserves
  good bytes/mtime, local metadata, custom chapter order and reading position, and works after old jobs are removed.
- A missing remote page fails clearly. A changed source format fails safely before file replacement,
  avoiding duplicate pages or reading-position loss; automatic cross-format identity migration is not included.
- Main-window IPC and hidden-resource access checks remain enforced. Audit works offline; repair requires login.

## Verification
- RED/GREEN tests: scripts/verify-image-integrity.ts, verify-image-repair.ts, verify-image-integrity-ui.ts.
- PNG, JPEG and WebP specifications verified. Native reader displays full bytes; only existing bookshelf
  thumbnails use the thumbnail conversion path. Checks do not establish that the source holds an artist's master file.
- Existing download, control, progress, network, transfer, source and library checks passed.
- Final build/typecheck passed. Selfcheck: 634 passed, zero failed. Diff check passed with CRLF warnings only.
- Final UI: audit/repair/auth/refresh, paused-job dismissal, download controls, progress, source browsing,
  reader modes/progress persistence, local imports and application restart all passed with isolated profiles.
- Screenshots: output/image-optimization/integrity-ui/audit-960.png, audit-1440.png,
  reader-info-960.png; existing library UI evidence at library-ui-stage3, source UI at source-ui-stage3.

No 0.9.0 release files, real user profiles or running application were replaced or terminated.
