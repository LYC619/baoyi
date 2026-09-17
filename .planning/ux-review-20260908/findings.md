# UX Review Findings

## Baseline

- Current source is version 0.8.0 with extensive uncommitted previous feature work.
- Previous delivery: docs/verification/2026-09-08-field-test-fixes.md. Packaged UI was tested at 1280 and 960 widths in an isolated profile.
- Previous checks explicitly did not validate a complete authenticated real-site download or real LLM identification accuracy.
- docs/superpowers/plans/2026-09-07-series-video-download.md explicitly excluded automatic registration, restart recovery, and byte-range resume.
- The current video model already has works and episodes; investigate how downloading and library presentation connect to it before proposing a replacement.

## Evidence Policy

Label every finding as current runtime observation, code-established behavior, user report, or unverified hypothesis. Previous verification is background evidence and does not constitute a new test run.

## Current Findings

- Download service runSeries uses the chosen directory directly, generates per-video filenames, and returns an explicit not-registered success message. Its remembered destinations and catalog tokens are memory-only.
- Both download entry points require an already registered resource with hanime_id. Empty-library URL acquisition is unavailable.
- Video Detail places separate single-download and series-download panels before the synopsis and episode table. The resource has one hanime_id; episode schema has one path per (resource_id, season, episode), without per-episode external identity or file variants.
- collection_name is a user-editable virtual grouping field, not a persistent physical series-directory identity.
- Game cover search prioritizes name_en, name_zh, then directory name. Steam is primary; Bing/SearXNG image search is optional and candidates pass a small host allowlist.
- probeImage swallows all candidate network failures; the caller can report no Steam match even when Steam matched but images failed.
- GameCard and game Detail lack the image-error fallback present in the video module. setGameCover removes old cached files before copying a replacement.
- User clarified: failed game is Genshin Impact; search currently uses client/launcher name. They requested non-Steam alternatives and clarification about proxy requirements.
- Packaged walkthrough observed: missing game cover cache renders a broken image; a path-bearing but absent video file is selected by the main Play button as if available.
- Packaged series detail has separate download panels before the episode list and a large multi-row sticky action bar at 960x640.
- Real Genshin search fixture (valid game names but a shared directory named media) fell back to that directory and returned unrelated Steam candidates. Their preview images were broken. index.html disallows all remote img sources while game Detail binds candidate HTTPS URLs directly.
- ys.mihoyo.com/main returned HTTP 200 via Node fetch without explicit application proxy. Its HTML metadata describes an old version and contains no og:image, so homepage scraping alone cannot be called a finished cover provider.
- SteamGridDB API docs returned 200; IGDB docs returned a 403 challenge in the same environment. Further source validation is in progress.
- Final packaged walkthrough completed with 12 captured states and no page exceptions; intentionally broken-cache 404s and CSP console errors were captured, not treated as a clean-console pass.
- Portal control: 12 candidate previews were blocked; selecting a candidate downloaded and displayed the local cover successfully. This isolates the preview failure from network access and final image persistence.
- Episode list heading starts at CSS y=801 in a 1280x900 viewport and y=843 in a 960x640 viewport. No document-wide horizontal overflow was found; usability problems concern ordering, density, and recovery.
- Official CN launcher is launcher.mihoyo.com (200), not the initially guessed hyp.mihoyo.com. Its published configuration is being inspected without executing remote code.
- SteamGridDB OpenAPI was parsed as YAML: its name-search and asset endpoints require Authorization Bearer API keys. IGDB availability remains unverified after its documentation challenge.
- Current application proxy is attached only to the persist:hanime-network session. Game covers use default Chromium net.fetch, so the in-app Hanime proxy does not configure game-cover traffic.
- Official launcher configuration contains tightly scoped components with both Genshin names and corresponding PNG references. Two associated PNGs returned 206 image/png with no explicit application proxy; composition/full decoding is not yet validated.
- Full optimization plan written: 8 work packages, 24 scenario acceptance cases, scope and migration rules, source alternatives and proxy boundaries.
