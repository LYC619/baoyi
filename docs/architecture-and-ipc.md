# 抱一架构与 IPC 索引

> 本文件由 `scripts/generate-architecture-docs.ts` 根据 `electron/ipc/*`、`electron/preload.ts`、`electron/services/storage/schema.ts`、`electron/archive/tools.ts` 与 `src/router/index.ts` 自动生成。请运行 `npm run docs:generate` 更新，勿手工编辑。

## 概览

| 维度 | 当前值 |
|---|---|
| 应用版本 | `0.20.8` |
| SQLite Schema 版本 | `v33`（共 66 张数据表） |
| 主进程服务域 | 7 个子目录 / 51 个模块文件 |
| IPC 通道 | 502 条主进程通道（24 个模块）；Preload 暴露 25 个命名空间（495 invoke / 7 send / 29 event） |
| 前端路由 | 19 条（Hash 路由；详情页按 `meta.remountOnId` 防迟到响应） |
| 归档助理工具 | 22 项（均含 JSON Schema 与离线 Eval 覆盖） |
| Preload ↔ Main 一致性 | 缺失 handle: 0，缺失 on: 0 |

## 1. 主进程服务分层 (`electron/services/`)

| 业务域 | 模块数 | 文件清单 |
|---|---:|---|
| `agent/` | 7 | `context.ts`、`files.ts`、`loop.ts`、`paths.ts`、`pi-adapter.ts`、`queue.ts`、`values.ts` |
| `hanime/` | 4 | `hanime-browser.ts`、`hanime-direct.ts`、`hanime-download.ts`、`hanime-network-rules.ts` |
| `media/` | 4 | `artwork-migration.ts`、`iconExtractor.ts`、`poster-protocol.ts`、`poster-storage.ts` |
| `network/` | 10 | `chromium-download-fetch.ts`、`discovery-browser.ts`、`online-network-rules.ts`、`online-network.ts`、`proxy-rules.ts`、`proxy.ts`、`searchService.ts`、`web-browser-sources.ts`、`web-browser-url.ts`、`web-browser.ts` |
| `storage/` | 16 | `activity.ts`、`database.ts`、`identify-records.ts`、`library-backup.ts`、`library-snapshots.ts`、`organize-plans.ts`、`portable-rules.ts`、`portable.ts`、`reset-files.ts`、`scan-units.ts`、`schema.ts`、`setting-keys.ts`、`settings-store.ts`、`snapshot-archive.ts`、`storage-usage.ts`、`task-records.ts` |
| `system/` | 7 | `fstree.ts`、`json.ts`、`language.ts`、`lifecycle.ts`、`text-file.ts`、`timing.ts`、`window-focus.ts` |
| `taxonomy/` | 3 | `resource-taxonomy.ts`、`taxonomy-store.ts`、`taxonomy.ts` |

## 2. 数据表结构 (`SCHEMA_VERSION = 33`)

| 表名 | 列数 |
|---|---:|
| `archive_actions` | 11 |
| `archive_runs` | 7 |
| `categories` | 6 |
| `document_annotations` | 10 |
| `document_categories` | 6 |
| `document_custom_groups` | 7 |
| `document_file_operations` | 5 |
| `document_files` | 5 |
| `document_insight_runs` | 10 |
| `document_insights` | 20 |
| `document_meta` | 17 |
| `document_recycle` | 6 |
| `episode` | 25 |
| `game_meta` | 16 |
| `game_notes` | 7 |
| `identification_reports` | 11 |
| `identify_logs` | 14 |
| `image_bookmarks` | 6 |
| `image_chapters` | 7 |
| `image_collection_members` | 3 |
| `image_collections` | 3 |
| `image_download_jobs` | 4 |
| `image_groups` | 6 |
| `image_meta` | 9 |
| `image_pages` | 8 |
| `image_progress` | 4 |
| `image_reader_state` | 3 |
| `organize_plans` | 5 |
| `pending_software` | 24 |
| `personal_records` | 7 |
| `project_automation` | 7 |
| `project_context` | 9 |
| `project_event_generation` | 6 |
| `project_events` | 14 |
| `project_launch_profiles` | 17 |
| `project_meta` | 9 |
| `project_sessions` | 6 |
| `project_summaries` | 14 |
| `resource` | 26 |
| `resource_links` | 15 |
| `save_backups` | 7 |
| `scan_units` | 9 |
| `settings` | 2 |
| `skill_card` | 3 |
| `skill_metric` | 7 |
| `skill_proposal` | 5 |
| `skill_record` | 10 |
| `skip_list` | 4 |
| `software_meta` | 9 |
| `tags` | 5 |
| `task_records` | 13 |
| `video_assets` | 9 |
| `video_detached_owners` | 1 |
| `video_directories` | 9 |
| `video_discovery_artwork` | 2 |
| `video_discovery_marks` | 3 |
| `video_discovery_sources` | 3 |
| `video_download_jobs` | 4 |
| `video_episode_assets` | 2 |
| `video_meta` | 32 |
| `video_organize_journal` | 7 |
| `video_scan_ignores` | 4 |
| `video_scan_state` | 4 |
| `video_sources` | 11 |
| `workspace_changes` | 8 |
| `workspace_sessions` | 6 |

## 3. 前端路由 (`src/router/index.ts`)

| 路径 | 路由名 | 所属模块 | `remountOnId` | 页面组件 |
|---|---|---|---|---|
| `/` | `home` | `software` | 否 | `@/pages/software/Home.vue` |
| `/detail/:id` | `detail` | `software` | 是 | `@/pages/software/Detail.vue` |
| `/settings` | `settings` | `-` | 否 | `@/pages/Settings.vue` |
| `/confirm` | `confirm` | `software` | 否 | `@/pages/software/Confirm.vue` |
| `/organize` | `organize` | `software` | 否 | `@/pages/software/Organize.vue` |
| `/game` | `game-home` | `game` | 否 | `@/pages/game/Home.vue` |
| `/game/:id` | `game-detail` | `game` | 是 | `@/pages/game/Detail.vue` |
| `/video` | `video-home` | `video` | 否 | `@/pages/video/Home.vue` |
| `/video/discover` | `video-discover` | `video` | 否 | `@/pages/video/Discover.vue` |
| `/video/:id` | `video-detail` | `video` | 是 | `@/pages/video/Detail.vue` |
| `/onboarding` | `onboarding` | `-` | 否 | `@/pages/Onboarding.vue` |
| `/image` | `image-home` | `image` | 否 | `@/pages/image/Home.vue` |
| `/image/:id` | `image-detail` | `image` | 是 | `@/pages/image/Detail.vue` |
| `/project` | `project-home` | `project` | 否 | `@/pages/project/Home.vue` |
| `/project/:id` | `project-detail` | `project` | 是 | `@/pages/project/Detail.vue` |
| `/document` | `document-home` | `document` | 否 | `@/pages/document/Home.vue` |
| `/document/:id` | `document-reader` | `document` | 是 | `@/pages/document/Reader.vue` |
| `/personal` | `personal-home` | `personal` | 否 | `@/pages/personal/Home.vue` |
| `/:pathMatch(.*)*` | `(redirect)` | `-` | 否 | `redirect -> /` |

## 4. Preload API 边界 (`window.baoyi.*`)

- **暴露命名空间（25）**：`archive`、`workspace`、`project`、`comic`、`image`、`videoAgentOrganize`、`videoImport`、`hanimeBrowser`、`app`、`win`、`software`、`game`、`music`、`video`、`videoOrganize`、`tasks`、`categories`、`tags`、`pending`、`settings`、`scan`、`ai`、`data`、`logs`、`organize`
- **主进程推送事件（29）**：`ai:progress`、`archive:event`、`archive:insights-changed`、`game:cover-progress`、`game:progress`、`game:session`、`hanime-browser:download`、`image:changed`、`image:jobs-changed`、`music:changed`、`organize:progress`、`project:changed`、`project:run`、`project:session`、`scan:progress`、`video-agent:progress`、`video-discovery:download`、`video-download:progress`、`video-import:changed`、`video-preview:closed`、`video-preview:frames`、`video-updates:changed`、`video-workflow:changed`、`video:library-changed`、`video:progress`、`web-browser:edit-address`、`win:maximize-change`、`win:navigate`、`workspace:changed`
- **边界安全约定**：所有渲染进程调用经过 `electron/ipc/main-window.ts`（主窗口主 frame 鉴权、停机/重置门控与原型污染/空字节/深度守卫）及 `electron/ipc/validate.ts` 运行时参数校验，失败时抛出带错误码的结构化 `IpcError`。

## 5. IPC 通道清单 (`electron/ipc/*.ts`)

| 模块文件 | 通道数 | 注册通道 |
|---|---:|---|
| `electron/ipc/archive.ts` | 29 | `archive:actions`、`archive:archive`、`archive:cancel`、`archive:insight-activate`、`archive:insight-adopt`、`archive:insight-cancel`、`archive:insight-cleanup`、`archive:insight-cleanup-preview`、`archive:insight-clear-cache`、`archive:insight-detail`、`archive:insight-edit`、`archive:insight-list`、`archive:insight-preview`、`archive:insight-start`、`archive:memory`、`archive:memory-edit`、`archive:project-handoff-adopt`、`archive:project-handoff-cancel`、`archive:project-handoff-generate`、`archive:project-handoff-preview`、`archive:rename`、`archive:send`、`archive:session`、`archive:sessions`、`archive:skills`、`archive:source`、`archive:status`、`archive:steer`、`archive:undo` |
| `electron/ipc/audio.ts` | 2 | `video:audio-info`、`video:audio-lyrics` |
| `electron/ipc/comic-ingest.ts` | 14 | `comic:browse`、`comic:cancel-browse`、`comic:cancel-preview`、`comic:clean`、`comic:cover`、`comic:defaults`、`comic:dismiss`、`comic:jobs`、`comic:logs`、`comic:preview`、`comic:retry`、`comic:revalidate`、`comic:start`、`comic:stop` |
| `electron/ipc/game-project.ts` | 6 | `game:check-projects`、`game:import-projects`、`game:link-states`、`game:preview-projects`、`game:read-link`、`game:restore-project-artwork` |
| `electron/ipc/game-workspace.ts` | 9 | `game:background:clear`、`game:background:pick`、`game:default-entry`、`game:link:patch`、`game:link:preview`、`game:notes:export`、`game:notes:list`、`game:notes:remove`、`game:notes:save` |
| `electron/ipc/game.ts` | 31 | `game:add-manual`、`game:backup-save`、`game:backups`、`game:cancel` *(on)*、`game:check-save-paths`、`game:clear-cover`、`game:counts`、`game:delete-backup`、`game:get`、`game:launch`、`game:list`、`game:open-backup`、`game:open-link`、`game:pick-cover`、`game:pick-dirs`、`game:pick-links`、`game:pick-save-dir`、`game:preview-backup`、`game:preview-restore`、`game:rebuild-covers`、`game:relocate`、`game:remove`、`game:restore-backup`、`game:reveal`、`game:reveal-link`、`game:running`、`game:scan`、`game:search-covers`、`game:set-cover-url`、`game:update`、`game:verify-save` |
| `electron/ipc/image-source.ts` | 25 | `image:cancel-job`、`image:check-updates`、`image:choose-download-root`、`image:dismiss-job`、`image:download`、`image:download-batch`、`image:download-options`、`image:download-target`、`image:download-updates`、`image:job-logs`、`image:jobs`、`image:move-job`、`image:pause-job`、`image:repair`、`image:resume-job`、`image:retry-job`、`image:source-cover`、`image:source-detail`、`image:source-favorites`、`image:source-login`、`image:source-logout`、`image:source-owned`、`image:source-ranking`、`image:source-search`、`image:source-status` |
| `electron/ipc/image.ts` | 30 | `image:audit`、`image:bookmarks`、`image:bulk-update`、`image:collections`、`image:confirm-import`、`image:gallery`、`image:get`、`image:groups`、`image:list`、`image:move`、`image:page-info`、`image:pages`、`image:preferences`、`image:prepare-import`、`image:progress`、`image:reader-preferences`、`image:relocate`、`image:remove`、`image:remove-bookmark`、`image:remove-collection`、`image:remove-group`、`image:rename-tag`、`image:rescan`、`image:reveal`、`image:save-bookmark`、`image:save-chapter`、`image:save-collection`、`image:save-group`、`image:tag-counts`、`image:update` |
| `electron/ipc/library-backup.ts` | 2 | `data:export-json`、`data:restore-json` |
| `electron/ipc/library-snapshots.ts` | 5 | `data:archive-snapshots`、`data:create-snapshot`、`data:export-snapshot`、`data:open-snapshot-dir`、`data:snapshot-info` |
| `electron/ipc/music.ts` | 8 | `music:cancel`、`music:directory`、`music:download`、`music:jobs`、`music:pick-directory`、`music:preview`、`music:retry`、`music:search` |
| `electron/ipc/project.ts` | 57 | `project:add-entry`、`project:applications`、`project:apply-proposal`、`project:automation`、`project:cancel-message`、`project:confirm-import`、`project:create-session`、`project:edit-summary`、`project:files`、`project:get`、`project:git`、`project:launch:open-preview`、`project:launch:preview`、`project:launch:profiles`、`project:launch:remove`、`project:launch:revoke`、`project:launch:runs`、`project:launch:save`、`project:launch:start`、`project:launch:stop`、`project:list`、`project:move`、`project:move-records`、`project:open`、`project:open-application`、`project:open-file`、`project:open-terminal`、`project:organize`、`project:overview`、`project:pick-path`、`project:preferences`、`project:prepare-import`、`project:prepare-move`、`project:preview-move`、`project:read-file`、`project:recover-move`、`project:relocate`、`project:remove`、`project:remove-entry`、`project:rescan`、`project:resources`、`project:resume-organize`、`project:reveal`、`project:rules`、`project:save-entry`、`project:scripts`、`project:select-application`、`project:select-repository`、`project:send-message`、`project:session`、`project:sessions`、`project:summaries`、`project:summarize`、`project:undo-batch`、`project:undo-event`、`project:undo-summary`、`project:update` |
| `electron/ipc/software.ts` | 40 | `organize:materialize`、`organize:organized`、`organize:pick-root`、`organize:plans`、`organize:preview`、`organize:preview-relocate`、`organize:relocate`、`organize:remove-links`、`organize:run`、`organize:sync`、`organize:undo`、`organize:unlink`、`pending:clear-skipped`、`pending:confirm`、`pending:count`、`pending:list`、`pending:remove-skipped`、`pending:skip`、`pending:skipped-count`、`pending:skipped-list`、`pending:update`、`scan:cancel` *(on)*、`scan:pick-dir`、`scan:reset`、`scan:reset-one`、`scan:run`、`scan:units`、`software:add-manual`、`software:clear-icon`、`software:counts`、`software:get`、`software:launch`、`software:list`、`software:pick-icon`、`software:pick-launcher`、`software:refresh-icons`、`software:relocate`、`software:remove`、`software:reveal`、`software:update` |
| `electron/ipc/storage.ts` | 2 | `data:clear-browser-cache`、`data:storage-usage` |
| `electron/ipc/system.ts` | 43 | `ai:cancel` *(on)*、`ai:complete`、`ai:models`、`ai:test`、`ai:test-search`、`ai:test-tmdb`、`app:copy`、`app:global-search`、`app:info`、`app:open-url`、`app:stat-paths`、`categories:list`、`categories:move`、`categories:remove`、`categories:upsert`、`data:dir`、`data:export-markdown`、`data:open-dir`、`data:open-save-backup-root`、`data:pick-save-backup-root`、`data:reset`、`data:save-backup-root`、`data:stats`、`hanime-browser:open`、`logs:clear`、`logs:list`、`logs:reports`、`settings:get`、`settings:hanime-verify`、`settings:patch`、`settings:proxy-status`、`tags:create`、`tags:list`、`tags:merge`、`tags:remove`、`tags:rename`、`tasks:clear`、`tasks:list`、`tasks:save`、`win:close` *(on)*、`win:is-maximized`、`win:minimize` *(on)*、`win:toggle-maximize` *(on)* |
| `electron/ipc/video-agent-organize.ts` | 3 | `video-agent:cancel`、`video-agent:prepare`、`video-agent:run` |
| `electron/ipc/video-core.ts` | 31 | `video:bulk-update`、`video:cancel` *(on)*、`video:clear-poster`、`video:counts`、`video:edit-taxonomy`、`video:episode-artwork`、`video:episode-scrape`、`video:episodes`、`video:fetch-poster`、`video:get`、`video:import-bundle`、`video:list`、`video:pick-dirs`、`video:pick-poster`、`video:play`、`video:play-episode`、`video:readiness`、`video:reidentify`、`video:removal-apply`、`video:removal-preview`、`video:remove`、`video:renumber-episodes`、`video:restore-scraped`、`video:reveal`、`video:reveal-subtitle`、`video:scan`、`video:source-search`、`video:taxonomy`、`video:update`、`video:update-episode`、`video:use-episode-artwork` |
| `electron/ipc/video-discovery.ts` | 19 | `video-discovery:artwork`、`video-discovery:entries`、`video-discovery:export`、`video-discovery:external-play`、`video-discovery:import`、`video-discovery:mark`、`video-discovery:online-connect`、`video-discovery:online-detail`、`video-discovery:online-network-probe`、`video-discovery:online-network-status`、`video-discovery:online-next`、`video-discovery:online-refresh`、`video-discovery:open`、`video-discovery:remove`、`video-discovery:sources`、`web-browser:list`、`web-browser:open`、`web-browser:remove`、`web-browser:save` |
| `electron/ipc/video-download.ts` | 6 | `video-download:cancel`、`video-download:reveal`、`video-download:run`、`video-download:run-series`、`video-download:series`、`video-download:sources` |
| `electron/ipc/video-import.ts` | 9 | `video-import:cancel`、`video-import:confirm`、`video-import:discard`、`video-import:get`、`video-import:list`、`video-import:prepare`、`video-import:refresh`、`video-import:review`、`video-import:update` |
| `electron/ipc/video-organize.ts` | 10 | `video-organize:apply`、`video-organize:layout-apply`、`video-organize:layout-preview`、`video-organize:list`、`video-organize:pick-directory`、`video-organize:preview`、`video-organize:preview-relocate`、`video-organize:relocate`、`video-organize:retry`、`video-organize:rollback` |
| `electron/ipc/video-preview.ts` | 11 | `video-preview:choices`、`video-preview:clear-frames`、`video-preview:copy`、`video-preview:external`、`video-preview:frame-cache`、`video-preview:frames`、`video-preview:open`、`video-preview:pick-player`、`video-preview:release`、`video-preview:release-frames`、`video-preview:reveal` |
| `electron/ipc/video-workflow.ts` | 23 | `settings:ffmpeg-detect`、`settings:ffmpeg-pick`、`video-updates:cancel`、`video-updates:start`、`video-updates:status`、`video-workflow:caches`、`video-workflow:cancel`、`video-workflow:clear-cache`、`video-workflow:dismiss`、`video-workflow:enqueue`、`video-workflow:list`、`video-workflow:pick-root`、`video-workflow:prepare`、`video-workflow:retry`、`video-workflow:reveal`、`video:default-asset`、`video:library`、`video:play-asset`、`video:preview-collection-name`、`video:relocate-asset`、`video:rename-collection`、`video:reveal-asset`、`video:sync-files` |
| `electron/ipc/workspace.ts` | 87 | `workspace:documents:analyze-import`、`workspace:documents:annotate`、`workspace:documents:annotations`、`workspace:documents:categories`、`workspace:documents:confirm-import`、`workspace:documents:content`、`workspace:documents:covers:get`、`workspace:documents:covers:put`、`workspace:documents:covers:range`、`workspace:documents:covers:source`、`workspace:documents:custom-groups`、`workspace:documents:export`、`workspace:documents:get`、`workspace:documents:list`、`workspace:documents:markdown`、`workspace:documents:move-to-submodule`、`workspace:documents:open`、`workspace:documents:organize:execute`、`workspace:documents:organize:history`、`workspace:documents:organize:pick-directory`、`workspace:documents:organize:preview`、`workspace:documents:organize:undo`、`workspace:documents:pdf:range`、`workspace:documents:position`、`workspace:documents:prepare-import`、`workspace:documents:relocate`、`workspace:documents:remove`、`workspace:documents:remove-annotation`、`workspace:documents:remove-category`、`workspace:documents:remove-custom-group`、`workspace:documents:reveal`、`workspace:documents:save-category`、`workspace:documents:save-custom-group`、`workspace:documents:text:index`、`workspace:documents:text:search`、`workspace:documents:text:slice`、`workspace:documents:update`、`workspace:files:choose`、`workspace:files:confirm`、`workspace:files:operations`、`workspace:files:preview`、`workspace:files:recover`、`workspace:links:add`、`workspace:links:backlinks`、`workspace:links:list`、`workspace:links:project-references`、`workspace:links:remove`、`workspace:links:resources`、`workspace:personal:capture-state`、`workspace:personal:choose-avatar`、`workspace:personal:list`、`workspace:personal:overview`、`workspace:personal:remove`、`workspace:personal:renew`、`workspace:personal:save`、`workspace:personal:snooze`、`workspace:preferences:choose-data-directory`、`workspace:preferences:data-directory`、`workspace:preferences:get`、`workspace:preferences:save`、`workspace:recycle:cleanup`、`workspace:recycle:confirm`、`workspace:recycle:confirm-batch`、`workspace:recycle:list`、`workspace:recycle:locations`、`workspace:recycle:preview`、`workspace:recycle:preview-batch`、`workspace:recycle:restore`、`workspace:recycle:resume`、`workspace:skills:cancel`、`workspace:skills:confirm`、`workspace:skills:list`、`workspace:skills:proposals`、`workspace:skills:record`、`workspace:skills:save`、`workspace:skills:undo-record`、`workspace:timeline:cancel`、`workspace:timeline:check`、`workspace:timeline:context`、`workspace:timeline:dismiss`、`workspace:timeline:events`、`workspace:timeline:export`、`workspace:timeline:generate`、`workspace:timeline:publish`、`workspace:timeline:remove`、`workspace:timeline:save`、`workspace:timeline:update-context` |

## 6. 归档助理工具集 (`electron/archive/tools.ts`，共 22 项)

| # | 工具名 | 必填参数 | 说明 |
|---:|---|---|---|
| 1 | `archive_result` | `cursor` | 续读较大的工具结果。若任意 archive 工具返回 format=json-fragment，将每页 text 按顺序拼接为原始 JSON，next 非空时原样传为 cursor（token 与 offset）续读。结果是同一快照，不会重新执行原操作；中断后快照失效时重新查资料或修改记录，不重复写入。 |
| 2 | `archive_search` | 无 | 搜索抱一全部可见归档：软件、游戏、影视、图片、文库、项目和个人记录。多关键词空格分隔，支持繁简模糊匹配元数据；正文用 archive_search_text。kinds 省略时检索全部可见类型。返回来源 ID、总数和 next 分页。 |
| 3 | `archive_get` | `id` | 读取一个资源的最新详情、可修改 metadata、version、writableFields、fieldHints、protectedFields（先前人工编辑过的受保护字段）、摘录、关联和文件副本。修改前必须先调用本工具取得最新 version。 |
| 4 | `archive_project_workbench` | `id` | 只读项目当前便签（context）、关键 Prompt、规则链接、启动配置和 Git 短状态。返回读取时间、contextRevision、HEAD 与覆盖警告；不执行配置、不读取 Diff 或项目正文。 |
| 5 | `archive_catalog` | 无 | 查看现有全部品类的分类和分组字典（documentCategories、documentGroups、imageGroups 及各模块 categories）；修改文库/图片分类分组须使用返回的 ID。 |
| 6 | `archive_web_search` | `query` | 通过用户已配置的搜索服务检索公开信息，例如作品作者、出版信息、软件官网。只使用公开名称或关键词，不得包含本地路径（如 C:\ 或 /Users/）、选文、私人档案及文件内容。结果是网页摘要，不表示已读完整作品。 |
| 7 | `archive_create_category` | `kind`, `name` | 按明确要求创建文库分类（document_category，需指定 submodule）、文库分组（document_group，需指定 categoryId）或图片分类（image_group，可指定 imageType），自动复用同范围同名项并返回 {item, created}；创建后用 archive_update 传入 item.id。仅建立分类，不移动文件。 |
| 8 | `archive_read` | `id` | 逐段读取文库 TXT/MD/PDF 原文，或项目内指定相对路径（path）的文本文件。文库可传 page（PDF 页码，从 1 起）或 line（文本行号，从 1 起）；返回定位与 next cursor，有 next 时传为 cursor 续读直至结束。 |
| 9 | `archive_search_text` | `query` | 在文库实际正文中搜索字面关键词。每批读取 12 份，next 非空需沿 offset 继续；ids 非空时限定范围；unread 明确列出不支持/离线文件。PDF 带页码。本地提取匹配片段，片段会用于当前模型对话。 |
| 10 | `archive_project_files` | `id` | 列出已归档项目的文件（返回 files、total、next）；可按相对目录 path 和关键词 query 查找，有 next 时传为 cursor 继续。 |
| 11 | `archive_project_search` | `id`, `path`, `query` | 搜索项目内指定相对路径文本文件（path），返回匹配行号 matches 和续查 cursor。 |
| 12 | `archive_update` | `changes`, `reason` | 执行用户要求的元数据整理，可批量改名、标签、分类、备注等；不会改文件路径。先用 archive_get 取得 version、writableFields、protectedFields 与 fieldHints。默认保留 protectedFields，除非用户明确要求覆盖。文库分类用 type、分组用 customGroupId（均为 ID）；图片分类用 groupId（ID）；软件/游戏/影视/项目分类用 category（名称）。patch 只能给该类型允许的字段，个人 data 必须传完整对象。整批原子保存，返回可撤销操作（含 action.id）。已明确授权的修改直接执行，不重复询问。 |
| 13 | `archive_create_personal` | `kind`, `name` | 按用户要求新增个人档案、资产、经历、待办、指标或测量。先搜索避免重复；返回可撤销记录（含 action.id）。创建技能卡请用 archive_skill。data 字段按类型填写：asset 可用 category/cost/currency/cycle/expiresOn/url/provider；experience 可用 date/organization/category；todo 可用 dueOn/done；metric 用 unit；measurement 必须有 metricId/value/date。 |
| 14 | `archive_check` | `ids` | 核验资源路径是否仍可用，读取真实文件状态和文库副本位置。ids 至少包含 1 项。 |
| 15 | `archive_locate` | `id`, `directory` | 在用户指定的文件夹里寻找文库原文件候选（仅支持文库资源）；按文件名寻找并返回候选大小与修改时间，不自动认定同一内容。最多扫描 10000 项；截断会告知。 |
| 16 | `archive_relocate` | `id`, `file` | 用户已指定正确新文件后，修复文库路径绑定（仅支持文库资源，file 须为存在的绝对路径）。复用原生核验和冲突检查；不移动或删除文件。 |
| 17 | `archive_organize` | `action` | 按文库分类/分组整理真实文件（仅支持文库资源）。action=preview 需传 ids/rootDir/mode，返回计划 token 与逐项状态（ready/conflict/skip/missing）；action=execute 需传同次 preview 的 token（若期间资料或文件变化须重新 preview）；action=history 查看历史记录；action=undo/recover 需传 operationId。只有用户已要求本次移动或复制时才 execute，不重复询问已给出的授权。 |
| 18 | `archive_actions` | 无 | 查看本次或历史元数据修改记录（返回含 action.id 与 state）；可用 archive_undo 传入 action.id 撤销。 |
| 19 | `archive_undo` | `id` | 按用户要求撤销一次元数据修改或个人记录新增。id 必须是 archive_update / archive_create_personal / archive_actions 返回的操作记录 ID（action.id），而非资源 ID；若有后续手动编辑则保留现状并返回 undone=false。 |
| 20 | `archive_link` | `action`, `owner`, `ownerId` | 查看或建立资源关联。owner 为项目、事件、技能、经历或资产；action=list 仅需 owner/ownerId，action=add 需传 resourceId（可选 annotationId），action=remove 需传 linkId；关联不复制文件。 |
| 21 | `archive_skill` | `action` | 读取个人技能卡及指标、提出新技能卡草案或记录指标。action=propose 的 input 需含 name、summary、metrics；action=record 的 input 需含 cardId、metricKey、version、value、date、requestId、evidence。草案沿用个人模块确认流程，不把 propose 当作已确认。 |
| 22 | `archive_history` | 无 | 查找升级前的资料、个人和项目助手历史。query 匹配标题或内容；指定 id 和 kind 后读取原会话。开启隐私隐藏时返回空列表与原因说明。 |
