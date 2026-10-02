# Findings

- package.json is 0.8.0; release contains 21 historical version/experiment directories.
- The user-confirmed working package is output/pica-network-verification/package/win-unpacked.
- Four processes are currently using that package; preserve it in place.
- Current code includes the image library/reader/Pica additions plus video fixes since 0.8.0.
- Default release uses AppData; green/portable marker configurations switch to exe/data.
- dist:portable and the portable config hardcode 0.8.0 and duplicate config.extends.
- Existing uncommitted source/network fixes must be preserved.
- package-lock.json still said 0.7.0. Sync only root metadata, not dependencies.
- Tags exist for 0.6.0 (game) and 0.7.0 (video); 0.8.0 adds Hanime/video refinements.
- New minor 0.9.0 consolidates the image module and subsequent network fixes.
- .tmp-split/wt is a registered worktree with 282 staged changes; preserve all of .tmp-split.
- One old release contains baoyi.db; old output folders also contain database snapshots.
  Preserve these byte-for-byte and do not redistribute historical archives.
- Keep doc/hanime-api-notes.md and doc/fixtures in place: active scripts reference them.
