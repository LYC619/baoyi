# Image chapter updates checkpoint

Stage 4 is complete in source. Final 0.10.0 packaging still awaits stages 5-7.

## Delivered
- Manual chapter checks compare stable source IDs, not titles. Source name/publication remain visible
  separately from local edits. Existing, incomplete, new, unverified legacy and remotely absent chapters
  are distinguished without mutating local metadata or files.
- Users select only new chapters. Selection is revalidated before enqueue, and download uses the existing
  resource directory. No implicit repair of older missing pages, no mount-time source requests or polling.
- Local name, notes, tags, group, favorite, publication, cover and reading progress are preserved.
- New early-ordinal source chapters append after a customized local order, which survives later scans.
- Targeted queue jobs cannot recreate removed/hidden resources. Remote disappearance does not delete
  downloaded chapters. Check and download endpoints require login and the main application frame.

## Evidence
- scripts/verify-image-updates.ts: read-only comparison, selected-only transfer, metadata and byte/mtime
  retention, custom order, stale selections, old manifests, hidden resources and removal while queued.
- scripts/verify-image-updates-ui.ts: real IPC, manual triggering, statuses, new-only selection, auth,
  local refresh and responsive layouts. Screenshots in output/image-optimization/updates-ui.
- Build/typecheck passed; selfcheck 634/0; diff check passed with CRLF warnings only.
- Final updates, integrity, control, progress and source UI passed. Earlier image download/library,
  integrity/repair/control/progress regressions also passed after backend changes.
- Logs: output/image-optimization/updates-build.log and selfcheck-stage4.log.

All tests used synthetic responses and independent temporary profiles. Existing releases and the
running user application were left untouched.
