# Findings

- Download queue is serial at both work/page level. total grows chapter by chapter.
- Job JSON is stored in image_download_jobs.payload; additive optional progress fields can
  be normalized on load without destructive schema migration.
- Source uses validated HTTPS redirects, 3 transient retries, 429 backoff and raw image bytes.
- boundedBody owns body streaming; a delta callback can report bytes without re-encoding.
- UI refresh is debounced 100 ms; emitting every body chunk would starve refresh under load.
  Use throttled transient progress, persist important boundaries only.
- useImageStore listens to image:changed and reloads the whole library. Added separate
  image:jobs-changed/onJobsChanged and a non-starving job-refresh throttle; library
  notifications now happen on chapter import, not on every transfer event.
- Existing tests use synthetic responses, Node SQLite and temporary directories.
- Previous release source snapshot and all current uncommitted code must remain intact.
