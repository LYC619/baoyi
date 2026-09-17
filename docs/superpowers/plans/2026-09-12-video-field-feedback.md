# Video field feedback implementation plan

> Execute in this task with executing-plans, sequentially. The user explicitly approved implementation on 2026-09-12 and prohibits new subagents. Preserve the existing working tree and do not commit or publish it.

**Goal:** Make existing single-episode folders, downloaded episodes and manually created collections behave consistently: correct local detection, library defaults, names, descriptions, navigation and a simple collection UI.

**Architecture:** Keep a work as the library card, an episode as independently described content, and files as versions of that content. Resolve identity using confirmed source IDs first; retain legacy paths/history and derive episode numbers from a consistent source catalogue. Directory promotion is previewed with the download, stays in the same parent, never overwrites a destination, and updates library paths with a recoverable journal. Collection creation only changes library relationships by default.

**Tech Stack:** Electron, Vue 3, TypeScript, SQLite, existing source parser/download pipeline and Playwright verification scripts.

## Acceptance and decisions

- The user authorized fixes to all feedback from both test rounds, including the earlier directory-as-video bug and detail layout.
- Supplementing a work defaults to its existing directory; a standalone episode folder may be promoted to its confirmed series name in the same library. New downloads default to the configured video library. The system Downloads folder is only a last fallback.
- Preserve local files, original episode names, watch state, notes and independent descriptions. A translated playlist caption is separate from the original episode title.
- Display episode numbers even when there is no explicit season. List order is not a substitute for the episode number.
- A supplementary download from episode 4 must detect the existing file despite its different Japanese filename, retain episode 4's identity and description, and skip it by default.
- New filenames use the original episode name, an E-number and quality. Do not prefix them with the entry episode's title. Source IDs remain in the manifest.
- Collection UI uses “创建合集 / 加入合集”, a name and episode order. Automatically show the preview. File copying and directory controls stay in a separate optional file-management flow.
- Detail tabs: content, descriptions, notes, files/management. Type and tags remain visible near the upper right. Episode descriptions are selected independently and never displayed as every episode's description.
- Returning from a video detail always returns to the video library, including when opened from a task or another module.
- No tests or migrations run against the user's production library. Use new temporary profiles and fixture files; deliver a new unpacked build directory.

## Task 1 — Reproduce legacy-file and download failures

Files: `scripts/verify-video-field-feedback.ts`, existing workflow/library verification scripts.

- [x] Add isolated fixtures for a movie record whose path is a directory and whose parts contain an actual file; assert the directory is not a content asset.
- [x] Add source catalogue order 4, 2, 1, with a different original title for each episode. Assert local episode 4 is detected and retains number 4.
- [x] Assert a new download uses the configured video-library root, a supplement stays in its current library, and the preview names the proposed series directory.
- [x] Download episode 2 using fake transfer bytes; assert the original name, E02, separate description, original local episode and progress survive.
- [x] Assert an occupied destination is never overwritten and no transfer starts.

Run: `node --experimental-strip-types --no-warnings scripts/verify-video-field-feedback.ts`.
Expected first run: assertion failures for the reported behaviors, not import or fixture errors.

## Task 2 — Content identity, metadata and legacy normalization

Files: `electron/kinds/video/episode-identity.ts`, `episode-details.ts`, `library.ts`, `schema.ts`, `registration.ts`, `db.ts`, `bundle.ts`, `src/types/index.ts`, `src/types/video-library.ts`, `src/types/library-backup.ts`.

- [x] Separate original title, episode description, poster and notes from work metadata with backward-compatible optional fields.
- [x] Use a source ID to associate legacy movie parts with the corresponding episode. Keep source IDs, existing episode IDs and watch state stable; exclude actual directories from assets and remove only proven directory assets.
- [x] Parse consistent catalogue labels into a canonical work title and explicit episode numbers; preserve unknown labels instead of inventing certainty.
- [x] Carry per-episode metadata through registration, portable manifests, backup and organization snapshots.

Core invariant to verify:
```ts
assert.equal(draft.episodes.find(ep => ep.videoCode === '104')?.state, 'local')
assert.equal(listEpisodes(db, id).find(ep => ep.episode === 4)?.position_sec, 91)
assert.ok(getVideoWorkLibrary(db, id).assets.every(asset => !fs.statSync(asset.path).isDirectory()))
```

## Task 3 — Download defaults, original names and directory promotion

Files: `electron/kinds/video/download/workflow.ts`, `sources.ts`, `placement.ts`, `electron/ipc/video-workflow.ts`, `src/types/video-workflow.ts` and portable bundle helpers.

- [x] Pass configured video roots into the workflow and choose the existing work directory before any generic download setting.
- [x] Preserve source-page original titles/descriptions while retaining playlist labels and source IDs. Obtain metadata from each episode page already used for resolving its stream.
- [x] Persist a directory-promotion plan with the job; validate the resolved source/destination and same-parent scope before rename. Rename only a confirmed standalone episode directory, update all referenced paths transactionally, retain recovery information and handle occupied targets before transferring bytes.
- [x] Publish new files using `original title - E02 720p.mp4`; retain existing filenames and store episode metadata separately.
- [x] Registration/metadata retries reuse completed files and remain restart-safe.

Run the new feedback script and `scripts/verify-video-workflow.ts`, `scripts/verify-video-work-library.ts`, `scripts/verify-video-bundle-registration.ts`.

## Task 4 — Simple collection creation and preserved episode information

Files: `electron/kinds/video/organize.ts`, `src/types/video-organize.ts`, `src/components/video/OrganizePanel.vue`, `OrganizePreview.vue`, `useOrganizeSession.ts`, `src/pages/video/Home.vue`.

- [x] Extend collection requests with the collection name and explicit episode-number overrides. Capture these changes in the existing journal so rollback preserves later edits.
- [x] Preserve donor title/description/notes as episode information before merging, including the first selected work.
- [x] Show the collection name and episode list immediately after selection, generate the preview automatically, and use a single visible “创建合集” action.
- [x] Keep source-directory/path controls out of the default collection flow. Put copying into an explicitly chosen “整理文件” mode.
- [x] Verify natural ordering, number conflicts, preserved metadata and rollback with isolated databases.

## Task 5 — Detail tabs, per-episode reading and reliable return

Files: `src/pages/video/Detail.vue`, `src/components/video/VideoItems.vue`, new focused detail components if necessary, `src/composables/useModules.ts` only if shared navigation behavior is required.

- [x] Add user-level regression scenarios before changing rendering: a seasonless E04, distinct episode descriptions, upper-right type/tags, switching tabs and return after opening from a non-video route.
- [x] Apply frontend-design to the existing theme; retain readable content at 960×640 without horizontal overflow.
- [x] Display original names, number labels, quality and availability without repeating full paths as content. Select an episode to read its own description.
- [x] Use an explicit video-library return target and retain current video-library filters/scroll.

## Task 6 — Integration and delivery

- [x] Run targeted data, workflow, organization, backup and browser regressions. Resolve failures before broad checks.
- [x] Run `npm run typecheck`, `npm run selfcheck`, `npm run build`.
- [x] Package into a new `release/0.8.0-field-feedback-20260912` directory, leaving the previous build intact.
- [x] Launch only with a temporary user-data directory, verify the shipped UI and inspect screenshots at normal and minimum window sizes.
- [x] Write the result and practical local-test sequence alongside the plan. Report what was tested and any remaining real-network limitation without claiming production-data migration was exercised.

## Completion evidence — 2026-09-12

- Delivered `release/0.8.0-field-feedback-20260912/win-unpacked/抱一.exe`; preserved the previous integration build.
- Data/workflow/organization/backup regressions passed. Final renderer runs: feedback 7/7, workflow 13/13, organization 12/12. Core selfcheck: 627/627; production build and type checking passed.
- Packaged verification: 14/14 with native SQLite and an isolated temporary profile. Evidence and reviewed screenshots: `output/video-field-feedback-20260912/packaged-ui/run-65uTLI`.
- Visual verification exposed a real refresh bug: assigning the base `Episode` IPC result into the shared content list discarded attached assets. A realistic IPC fixture reproduced the renderer error; merging the returned fields preserves file/version data and passes the regression. The fixture now includes route transitions, and packaged checks catch console errors as well as uncaught page errors.
- User-facing changes and six-step local test guide: `docs/changes/2026-09-12-video-field-feedback.md`. Real-site media downloading remains for local field testing; all development file operations used synthetic media and temporary libraries.
