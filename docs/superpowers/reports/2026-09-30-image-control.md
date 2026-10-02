# Image download control checkpoint

Stage 2 is complete in source, not yet released. Version remains 0.9.0 until the full goal passes.

- Pause/resume and queue order persist. Good pages are reused after checksum validation.
- Default concurrency is two, bounded to 1-3. Every retry uses the request gate.
- HTTP 429 reduces concurrency to one and preserves Retry-After across pauses/restarts.
- Serialized commits preserve out-of-order page results. Failure/cancellation settles all workers.
- Main-window IPC checks, duplicate-work guards and login checks remain enforced.
- Task-center attention/all filtering includes paused work and hides successful work when appropriate.

Evidence: gate/control/progress/meter/network/source/download/library scripts passed;
real-IPC control, progress and source UI passed in independent profiles; build/typecheck passed;
selfcheck 634 passed, zero failed. Final control UI rerun after build passed.
Screenshots and logs: output/image-optimization/control-ui, control-build.log,
source-ui-control, selfcheck-stage2.log. git diff --check passed with CRLF warnings only.

No existing releases, real profiles, ongoing downloads or running applications were modified.
