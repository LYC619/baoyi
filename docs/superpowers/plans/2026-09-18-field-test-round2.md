# 影视库实测第二轮 · 修复与优化计划（2026-09-18）

给下一个会话看的。上一轮（2026-09-17 会话 `6149e0b6`）做完的事、当前工作区状态、
以及这一轮要做的 10 件事都在这里。**先读「起点」再动手**，工作区里堆着 200 多个未提交
文件，别把它们当成本轮改动。

术语先说清（本文里的意思）：
- **作品目录 / 资源包**：一部作品在视频库里自己的文件夹，里面有 `baoyi.json` 清单和
  `.baoyi/artwork/` 图片目录。数据库表 `video_directories` 记着哪部作品绑定了哪个目录。
- **缓存目录**：`%APPDATA%\抱一\posters`。抱一自己放图的地方，和视频库无关。
- **`baoyi://poster/`**：渲染进程加载本地图片用的自定义协议，主进程在 `electron/main.ts`
  的 `registerFileProtocol` 里处理。
- **合集**：`episode_total > 1` 的作品，海报墙上可展开看单集。
- **闸门**：`npm run typecheck`、`npm run selfcheck`（当前 632 通过）、构建、以及真机 CDP 排练。

---

## 0. 起点：工作区状态与前置动作

- 分支 `codex/field-test-fixes-20260908`，HEAD `5b9bdd4`。Codex 那一批（52 个改动 +
  约 150 个新文件）加上 9-17 我这一批（识别报告补列、海报缓存改回 APPDATA、Hanime 五地址池
  + 开关 + 回退 + 启动地址记忆 + 验证窗口快速失败）**全部未提交**。
- 上一轮的完整报告在会话记录里；关键结论：`.baoyi/artwork` 一张没动；缓存目录里 296 张
  被库引用、约 285 张是渲染用的临时副本（见 §A）。
- 用户当时还开着旧版打包程序（`release/0.8.0-video-agent-background-20260913`），
  新代码从未在真库上启动过。

**建议第一步就拆分提交**（用户拍板要不要）：
`迁移修复 / Hanime 网络 / 海报存储 / 影视下载 / 整理 / 备份 / 游戏封面 / 脚本与文档`。
不拆的话本轮改动会和 Codex 的混在一起，以后没法单独回退。

**本轮不做**：不动游戏封面和软件图标的存放方式（它们没有"库"的概念）；不做 DNS 延迟测速。

---

## A. 海报全部进视频库（用户 9-18 拍板：所有图最终都进视频库，本地明文可读）

### 现状（真库只读查过）

| 位置 | 谁写的 | 数量 |
|---|---|---|
| `<作品目录>/.baoyi/artwork/` | 整理、导入目录、下载完成后写清单 | 库里 975 处引用，文件都在 |
| 缓存目录，库里正式引用 | 刮削下载、手选海报、下载任务封面 | 作品封面 57、横图 52、单集 11+11、其他 8 |
| 缓存目录，无引用 | 显示时的临时副本（见下） | 约 285 张 |

根因：`baoyi://poster/<文件名>` 只在缓存目录里找文件（`main.ts` `PROTOCOL_DIRS`），所以
`service.ts` 的 `cacheLocalPoster` / `cacheListedPoster` 每次列表都把视频库里的图**再复制
一份进缓存**才显示得出来。这就是"到处都有海报"的来源。

51 部作品有本地位置（42 部已绑定目录，9 部有文件没绑定）；其中 39 部的 `.baoyi/artwork`
里已经有一张和缓存里字节相同的图。6 部只有链接没有文件。

### 改法（三步，顺序不能反）

**A1. 协议按路径取图，不再复制。**
- `posterUrl()`（`src/utils/index.ts:223`）改为把**完整路径**编进 URL：
  `baoyi://poster/?p=<encodeURIComponent(absPath)>&v=<version>`。
- `main.ts` 协议处理：只放行三类路径 —— 缓存目录直属文件、路径含 `\.baoyi\artwork\` 段
  且扩展名在 `POSTER_EXTS` 内、或与数据库任一 `poster_path / thumbnail_path` 完全相等。
  其余 404。用 `path.resolve` 后比对，杜绝 `..`。
- 删掉 `cacheLocalPoster` / `cacheListedPoster` 和它们的 6 个调用点（`service.ts:117,154,
  161,178,180,183,214,296`）。`isLocalPosterPath`（渲染侧）和 `isLocalPoster`（主进程侧）
  是刻意的两份，改一处另一处同步，selfcheck 里有同组用例。
- 游戏封面 `baoyi://cover/` 和图标 `baoyi://icon/` 不动。

**A2. 新图一律写进作品目录。**
- 新增 `artworkDirFor(db, resourceId)`：作品绑定了目录 → `<目录>/.baoyi/artwork`；没绑定但
  `resource.path` 或任一 `episode.path` 存在 → 该文件所在目录下的 `.baoyi/artwork`；都没有
  （只有链接）→ `postersDir()` 暂放。
- 四个写入点换用它：`setVideoPoster`（`service.ts:1084`）、`downloadPoster` 单集/横图分支
  （`:1208`）、`dropPosterFiles`（`:1056`，删旧图时按新目录找）、下载任务 `savePoster`
  （`ipc/video-workflow.ts:48`，下载时目录已知，直接写作品目录）。
- 下载完成绑定目录那一步（`download/workflow.ts:214-221` 写清单）已经会把图收进
  `.baoyi/artwork`，只需确认暂放缓存的那张被搬走后**删掉缓存副本**。

**A3. 一次性迁移 + 清理。**
- 复用 `services/poster-storage.ts` 的机制（复制 → 校验哈希 → 写恢复映射 → 改引用 → 删旧），
  但目标按作品算：每条缓存引用 → `artworkDirFor()`。目录里已有同哈希文件就直接改指向。
  算不出目录的（6 部）留在缓存。来源同时认 `%APPDATA%\抱一\posters` 和项目 `data/posters`，
  这样用户没启动过 9-17 那版也不要紧。
- 无引用的缓存文件：按 sha256 在扫描目录下所有 `.baoyi/artwork` 里找同内容，找到的删；
  找不到的**不删**，启动日志报数，交给用户。
- 恢复映射写到 `%APPDATA%\抱一\artwork-migrations/`。

### 验证
- selfcheck：协议放行规则（三类通过、`..` 和任意路径拒绝）、`artworkDirFor` 三种情形。
- 真机排练：真库快照 + 两份缓存副本 + 假 checkout（配方见记忆
  `baoyi-verify-with-temp-profile`、`baoyi-settings-video-sections-need-in-app-nav`），
  启动后核对：`.baoyi/artwork` 新增文件数、库引用全部指向作品目录、缓存目录只剩 6 部、
  影视墙 84 张里番图 0 破图（对照上一轮截图 `output/rehearsal-20260917/01-video-wall.png`）。
- 排练里**不能**用真的 `E:\视频`：把涉及的作品目录 robocopy 到临时盘再改快照里的路径。

---

## B. 九项实测问题

每项：现象 → 已定位到的原因 / 位置 → 改法 → 验证。标 **[待复现]** 的是原因还没在真库上坐实，
新会话先复现再改。

### B1. 详情页封面可选任一单集封面（优化）
- 位置：`src/pages/video/Detail.vue:712-740` 英雄区只有「找海报 / 换 / 撤」；单集的
  `poster_path / thumbnail_path` 已在 `library.contents` 里。
- 改法：加「从单集选」按钮，弹出网格列出每集的竖图和横图（复用 `VideoArtwork.vue`）。
  新增 IPC `video:use-episode-artwork(resourceId, episodeId, role)`：校验单集属于该作品、
  文件存在，然后调 `setVideoPoster(id, path, true)`（它本来就吃本地路径；A2 后会写进作品目录）。
  同时写 `poster_source = 单集的 poster_source`，标 `user_edited: poster_path`。
- 验证：selfcheck 校验归属和不存在文件；CDP 点一次换图后 `item.poster_path` 变化且墙上刷新。

### B2. 搜索一次后所有合集默认展开（bug）
- 原因：`src/pages/video/Home.vue:77-80` 的 watcher —— 只要 `store.keyword` 非空或选了标签，
  就把所有 `episode_total > 1` 的作品 `expanded[id] = true`。清空搜索后 watcher 再跑，
  但 `expanded[id]` 已经是 true，条件 `expanded.value[item.id] || ...` 继续成立，永远收不回。
- 改法：把「用户手动展开」和「搜索自动展开」分开记（`userExpanded` / `autoExpanded` 两个集合）。
  搜索或标签条件消失时清空 `autoExpanded`。自动展开只对 `matchingEpisodes(id).length > 0`
  的合集做；作品自身匹配、单集不匹配的不展开（现有那条「当前条件未命中单集」的空态提示
  就用不上了，可删）。
- 验证：CDP 输 keyword → 有匹配单集的合集展开、其他不展 → 清空 → 全部收回；
  手动展开的一部在搜索前后保持展开。

### B3. 「资料待补齐」说不清缺什么（优化）
- 原因：`service.ts:119` 的 `pending_reasons` 里 `metadata` 来自两处：
  `item.needs_review`（`ai_status !== 'done'`，从没经过识别确认）和
  `video_directories.metadata_state = 'pending'`。后者由清单的 `missing` 决定
  （`bundle.ts:239`：缺简介、缺封面、或调用方传入的 missing），**和集数无关**。
  所以"集数全但仍待补齐"多半是缺简介或缺封面。
- 改法：`video_directories` 加列 `missing TEXT NOT NULL DEFAULT '[]'`（照 `schema.ts:449`
  `display_label` 那种"列不存在才加"的写法，不动 `_schema` 版本号）。三个写
  `metadata_state` 的地方（`local-sync.ts:112`、`organize.ts:772`、`download/workflow.ts:234`）
  同时写 missing。`list-state.ts:44` 把它读出来；`pending_reasons` 从 `'metadata'` 细分成
  `'metadata:description' | 'metadata:poster' | 'metadata:review'`（保留 `'metadata'` 作为
  筛选大类，`issueLabels` 里对应「缺简介 / 缺封面 / 未经识别确认」）。卡片角标文字改成
  具体的那一条，多条用「、」连。
- 验证：selfcheck 三种 missing 组合各出对应文案；真库快照里挑一部"集数全但待补齐"的，
  改完能看到具体原因。

### B4. Agent 整理没拿到竖向封面 **[待复现]**
- 已查到的链路：`service.ts:816 enrichVideoWithAgent`。
  - 只勾「补封面」且单集有 hanime 编号 → `loadVideoWork()` → 里面有 `supplementPoster`
    （`download/sources.ts:128`，去搜索页拿竖向封面），这条路**能**拿到竖图。
  - 勾了「补资料」或没编号 → 走 `identifyOne`，封面用 `payload.poster_path`
    和 `command.sourceDetails`（`hanime_detail` 工具的结果）。**怀疑点一**：工具路径没走
    `supplementPoster`，播放页本身只有横向帧图，所以只拿到横图。
  - 收尾（`:886-890`）把单集封面提升为作品封面的条件是"作品没有封面或文件不存在"，
    **怀疑点二**：作品已经有一张横图时不会被竖图替换（`fetchPosterOnce` 那边有
    `localPortrait` 判断，这里没有）。
- 复现：真库快照里挑一部 Agent 整理过、封面是横图的作品，跑一次「补封面」看日志走哪条分支。
- 改法（按复现结果二选一或都做）：识别后统一用 `loadVideoWork(payload.hanime_id)` 取图
  （或给 `hanime_detail` 工具结果补 `supplementPoster`）；收尾提升时用 `selectVideoArtwork`
  的 `hasPortrait` 判断，作品封面不是竖图且未手改就替换。
- 验证：`verify-hentai-e2e` 加一条"播放页只有横图 → 搜索页补竖图"的 fixture；真机跑一部。

### B5. 任务面板下载栏常置于下部（优化）
- 位置：`src/components/tasks/TaskCenter.vue:47-52` 四个分区（运行中 / 下载队列 / 最近结束 /
  下载结果）顺序渲染在同一个滚动区 `.task-panel__body` 里。
- 改法：body 拆成上下两个区域：上面「运行中 + 最近结束」独立滚动；下面「下载队列 +
  下载结果」固定在面板底部、自己一个 `max-height: 45%` 的滚动区，有下载任务时才显示。
  面板整体仍是 `flex-direction: column`，footer 不动。
- 验证：CDP 铺 40 条历史 + 2 条下载，量 `.task-panel__downloads` 的
  `getBoundingClientRect().bottom` 贴着 footer 顶。

### B6. 很多地方不能鼠标选中文字（优化）
- 原因：`src/styles/global.scss:25` 给 `body` 设了 `user-select: none`，只有 h1-h3、
  textarea、select 例外。
- 改法：反过来 —— `body` 默认 `user-select: text`，只给需要拖拽/点击的壳子加
  `user-select: none`：标题栏（`TitleBar.vue`，那里已有 `-webkit-app-region: drag`）、
  侧栏导航按钮、海报墙卡片、页签条、按钮。加一个工具类 `.no-select`。
- 验证：CDP 对详情页简介、任务面板日志、设置页地址池三处 `getComputedStyle(el).userSelect`
  为 `text`，标题栏和卡片为 `none`；手动拖选一段确认。

### B7. 下载补全变合集后标题没切、单集简介留在作品简介里 **[待复现]**
- 真库里就有这个案例：`被幹鬥士 瘋狂性愛！`（已绑定目录）旁边还有
  `被幹鬥士 瘋狂性愛！ 1` 和 `被幹鬥士 瘋狂性愛！ 2` 两条（没目录、没文件、路径指向
  `E:\视频\动漫\寝取られファイター ヤリっちんぐ！\2349x`）。先只读把这三条的
  `name_zh / user_edited / description / hanime_id / video_sources` 全部拉出来看。
- 已查到的判定逻辑：`download/workflow.ts:110-118` 和 `:286-292` 的 `promoteTitle`
  要求 `!user_edited.includes('name_zh')` 且（某集标题 == 作品名 或
  `numberedEpisode(作品名).title == 系列名`）。简介：`episodeMetadata` 为真时置空
  （除非 user_edited），但**只在 promote 成功的分支里**。
- 怀疑点：(a) 用户说的"先刮了一次单集"—— `organize.ts:507` 创建合集时会把 `name_zh`
  标成 user_edited，之后任何自动改名都被挡；(b) 标题比对靠字符串，单集刮削写进去的
  `name_zh` 是页面的中文标题（可能带 `＃1`、全角空格等），字符串对不上。
- 改法方向：提升条件改为**按来源编号**判断（作品的 `hanime_id` 或其单集的 `video_sources`
  命中系列目录里的任一条就算同一作品），不再比字符串；单集升合集时把原 `description`
  挪到对应那一集的 `description`（不是丢掉），作品简介置空；`organize.ts:507` 那处
  只在用户真的改过名时才标 user_edited。
- 验证：`verify-video-download` 加"先单集刮削再补全成系列"的用例；真库快照上对那三条跑一次补全。

### B8. 合集内编辑第几集 + 系列分部（新功能）
- 现状：`db.ts:1035 EPISODE_COLUMNS` 白名单里没有 `episode / season`，界面上没有改集号的地方。
  但 `episode-details.ts:94 reconcileEpisodeSlots` 已经能带冲突检测、保存点地改集号；
  `season` 列一直在，只是里番模式下 `videoEpisodeLabel(withoutSeason=true)` 不显示。
- 改法：
  - 新增 IPC `video:renumber-episodes(resourceId, [{ episodeId, season, number }])` →
    `reconcileEpisodeSlots` → `syncSeriesStatus` → 绑定了目录就 `persistVideoWorkBundle`
    （清单和 sidecar 里 `season / number` 字段已有）。冲突原样返回那句"部分本地集数编号存在冲突"。
  - 详情页「作品内容」页签加「管理集数」模式：每行两个数字框（季/部、集），改完一次提交。
    已有的「移出合集」按钮放进同一模式里。
  - 分部：不新加列，就用 `season`。里番模式下 `season > 0` 时标签显示「第 N 部 · 第 M 集」，
    `season = 0` 仍只显示「第 M 集」。**只做手动设置**，不做自动识别（用户原话：这种里番不多）。
    `VideoScopeSwitch` 和 `VideoItems` 的分组按 season 分段显示。
- 验证：selfcheck 覆盖 renumber 的冲突、跨部换号、回滚；CDP 在一部 4 集合集上把第 3 集改成
  第 2 部第 1 集，列表分段正确，清单 `baoyi.json` 里对应项 `season = 2`。

### B9. 批量管理点「下一步」进了创建合集（bug）
- 原因：`Home.vue:370` 「下一步」按钮的条件是 `v-if="selecting"`，批量管理也是 selecting
  态（`:372` 点批量管理 → `toggleSelecting(); bulkOpen = true`），于是这个按钮也出现，
  点了走 `organize('organize')` 打开创建合集面板。
- 改法：「下一步」改成 `v-if="selecting && !bulkOpen"`；批量管理态的操作全在
  `VideoBulkPanel` 里（分组 / 标签 / 删除），不需要「下一步」。顺手把「创建合集」按钮在
  bulkOpen 时的文案从「取消选择」改成「退出批量管理」，免得两种选择态看起来一样。
- 验证：CDP 点批量管理 → 工具栏没有「下一步」；点创建合集 → 有。

---

## C. 执行顺序

| 批 | 内容 | 理由 |
|---|---|---|
| 0 | 拆分提交（用户拍板）；用新代码在真库上启动一次，确认 9-17 那批迁移和 Hosts 开关在真库上正常 | 先把地基落定 |
| 1 | B9、B2、B6、B5（四个纯前端小改） | 半天内能全部关掉，且和后面互不干扰 |
| 2 | A1 → A2 → A3（海报归位） | B1 依赖 A2 的写入位置 |
| 3 | B3、B1 | 都是加字段 + 加入口 |
| 4 | B7、B4（先复现再改） | 要读真库、可能改数据流 |
| 5 | B8（最大的一项） | 独立功能，放最后 |
| 6 | 全量闸门 + 真机排练 + 打包 + 交付说明（照 `docs/changes/2026-09-12-video-field-feedback.md` 的格式） | |

每批结束跑 typecheck + selfcheck；批 2、4、5 结束加真机排练。所有涉及数据库和文件的改动
先在真库快照上跑，真库和 `E:\视频` 只读。

---

## D. 需要用户拍板 / 未查清

1. 提交拆分是否现在做（§0）。
2. §A3 无引用且在视频库里找不到同内容的缓存文件，是留着还是删（默认留着并报数）。
3. B7 / B4 的原因是推断，复现后如果不是这两处，改法要重定。
4. B8 分部只做手动；是否需要"从文件名里的『第 N 部』自动识别"留到下一轮。
5. 9-17 那批 Hanime 改动里，`hanime_hosts_active_ip` 写库走 `patchSettings` 会触发一次
   设置广播，没观察到副作用但也没专门测。

---

## E. 相关文件速查

| 主题 | 文件 |
|---|---|
| 协议与白名单 | `electron/main.ts:58-77` |
| 海报缓存复制 | `electron/kinds/video/service.ts:130-175, 1056-1105, 1195-1215` |
| 海报迁移机制 | `electron/services/poster-storage.ts`、`electron/services/database.ts:219-226` |
| 清单与 artwork 写入 | `electron/kinds/video/bundle.ts:95-135, 175-200`、`local-sync.ts:89-114` |
| 待处理原因 | `electron/kinds/video/service.ts:112-126`、`list-state.ts:40-75` |
| Agent 补封面 | `electron/kinds/video/service.ts:816-891`、`download/sources.ts:128-176` |
| 下载补全提升标题 | `electron/kinds/video/download/workflow.ts:100-125, 280-295`、`catalogue.ts:16-47` |
| 集号调整 | `electron/kinds/video/episode-details.ts:80-110`、`db.ts:1034-1050` |
| 首页展开/选择态 | `src/pages/video/Home.vue:60-110, 360-395` |
| 任务面板 | `src/components/tasks/TaskCenter.vue:30-60, 195-320, 331-390` |
| 全局选中 | `src/styles/global.scss:20-64` |
| 详情页封面区 | `src/pages/video/Detail.vue:310-365, 700-745, 836-875` |
