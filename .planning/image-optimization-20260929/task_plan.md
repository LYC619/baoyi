# Image workflow optimization goal

## Approved scope and order
- [x] 1. Accurate download progress, transfer speed/bytes and network states
- [x] 2. Pause/resume, queue ordering, bounded concurrency and rate-limit backoff
- [x] 3. Original-image metadata, integrity audit and selective repair
- [x] 4. Manual remote updates and local chapter comparison without overwriting edits
- [x] 5. Reader zoom/pan, cover spread rules, per-work preferences, bookmarks, read status
- [x] 6. Bulk organization and measured large-library performance improvements
- [x] 7. Upgrade-time database snapshots and version/data/backup information
- [x] Final regression, new release and documentation

## Rules
- Main-session serial implementation and review; no agents/new task chats.
- Preserve all pre-existing dirty files and release/0.9.0.
- Do not terminate or overwrite the running pica-network-verification app.
- Synthetic fixtures and separate test profiles; never reset/download into real user data.
- Test-first per stage. Record actual evidence, not assumed completion.
- New feature release targets 0.10.0 after all stages pass, not during partial work.

## References
- Design: docs/superpowers/specs/2026-09-29-image-optimization.md
- Stage 1: docs/superpowers/plans/2026-09-29-image-download-progress.md
- Stage 2: docs/superpowers/plans/2026-09-30-image-download-control.md
- Stage 3: docs/superpowers/plans/2026-09-30-image-integrity.md
- Stage 4: docs/superpowers/plans/2026-09-30-image-updates.md
- Stage 5: docs/superpowers/plans/2026-09-30-image-reader.md
- Stage 6: docs/superpowers/plans/2026-09-30-image-library-management.md
- Stage 7: docs/superpowers/plans/2026-09-30-library-upgrade-safety.md

## Errors
- Expected RED: queue total was 2 instead of 3 before first image request.
- UI fixture initially missed the change event after replacing an already-loaded jobs handler.
  Corrected setup and proved RED against 0.9.0, GREEN against the new build.
