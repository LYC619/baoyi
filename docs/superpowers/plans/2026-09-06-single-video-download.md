# Single Video Download Implementation Plan

> **For agentic workers:** 使用 executing-plans 串行执行；用户要求不用子 agent。dirty 工作区不提交、不重置。

**Goal:** 从详情页解析单集直链到安全保存、进度、取消、错误与日志的闭环。

**Architecture:** 纯解析/网络取源、流传输、主进程协调、renderer 单例四层。IPC 只接受短期源令牌和资源 id，路径仅由原生保存对话框提供。海报和数据库不变。

**Tech Stack:** TypeScript、Vue 3、Electron 37、Node fs/ReadableStream、现有 node-html-parser，无新增依赖。

### Task 1: 安全流传输（TDD）
- [x] 新建 scripts/verify-video-download.ts：合成 MP4 和注入 fetch/fs，断言文件、字节/进度、失败清理；运行脚本观察缺少实现的断言失败。
- [x] 新建 electron/kinds/video/download/transfer.ts：transferVideo({url,destination,referer,signal,fetch,onProgress})；独占 part 写入，校验后 link 发布，finally 关闭和清理。
- [x] 补齐未知大小、HTTP、HTML/HLS、截断、取消、超时、同名竞争、磁盘错误和清理告警，运行到通过。

### Task 2: 源和 main 协调（TDD）
- [x] 新建 scripts/verify-video-download-service.ts，先测解析、令牌、保存取消和单任务锁，观察失败。
- [x] 新建 electron/kinds/video/download/sources.ts：仅播放器/脚本直链，排除列表缩略图/分片；复用 fetchHanimeResource，15 秒超时，挑战页提示验证后重试。
- [x] 新建 electron/kinds/video/download/service.ts：短期源令牌、文件名、路径授权、单任务锁、取消、进度和完成路径索引。
- [x] 新增 src/types/video-download.ts，在类型入口导入/导出，新增 video-download 任务类别；运行测试确认失败释放锁且不写库。

### Task 3: IPC 和 renderer（TDD）
- [x] 新建 scripts/verify-video-download-ui.ts，用 renderer-harness 测成功/失败/取消、订阅、共享状态和日志；先观察失败。
- [x] 新建 electron/ipc/video-download.ts，在 handlers 注册；检查主窗口主 frame，接入 preload 的 sources/download/cancel/progress/reveal。
- [x] 新建 src/composables/useVideoDownload.ts：模块级状态，订阅先于 invoke，requestId 隔离事件，Promise finally 收尾。
- [x] 新建 src/components/video/SingleDownload.vue，独立嵌入 Detail；标题/编号、清晰度、保存/取消/打开位置，不改海报区。
- [x] TaskCenter 针对下载显示字节；package scripts 登记测试。运行新增测试和 typecheck。

### Task 4: 集成与交付
- [x] 跑 verify-task-center、verify-task-operations、verify-task-center-ui、verify-settings-scan、verify-hanime-verification、verify-hentai-e2e、check-modules、selfcheck。
- [x] npm run build，仅构建，不打包或运行应用。
- [x] 检查本轮差异，写验证记录，说明实站/GUI/系列队列未覆盖。

自审：接口、文件和阶段已限定；安全测试先于生产实现，无新依赖/迁移。
