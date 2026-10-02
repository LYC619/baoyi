# Progress

## 2026-09-29
- Resumed from previous turn summary; no previous cleanup actions had occurred.
- Read package/build configurations and inventoried top-level directories.
- Checked running apps and current Git status.
- Published 0.9.0 with synchronized package/lock metadata and corrected build configs.
- Release config regression: 4 expected failures before changes, 5/5 pass afterward.
- Standard build, packaged IPC/UI test and four image regressions passed; selfcheck 634/634.
- Archived 51 items / 6,322 files, validating every moved file with SHA-256 before/after.
- Preserved running application, real data, .recover, references and dirty .tmp-split worktree.
- Added current release/docs indexes and retained the original README under docs/history.
- Verified 58 compiled files are byte-identical to the user-confirmed network-fix package.
- Saved 399 build-source/config/resource files in a 2.23 MiB source ZIP; verified every entry SHA-256.
- Generated release/current.json, manifest.json (126 artifact files), source-files.json and SHA256SUMS.txt.
- Completed documentation, preservation notes and version history. No commits, tags, deletions or user-data migrations.
- Final checks: 126 binary artifact hashes, 129 checksum entries and all 51 move statuses passed.
- The original four application processes are still running from the preserved network-verification package.
- Normal git diff --check passed; existing CRLF files were not rewritten.
