# 通用视频来源与海报墙实施计划

> **2026-10-01 方向校正：** 本文完成标记仅针对当时的“导入目录”通用实现。用户随后明确：主要目标是依托现成网页的在线使用体验，导入清单不应是前置条件。因此本文不能作为原始整体需求已经完成的依据。新方向及明确缺口见 [在线资料库重规划](2026-10-01-online-library-replan.md)。保留下文作为实现历史。

> **For agentic workers:** Use executing-plans in this session. 根据项目 AGENTS.md 串行实现、审查和验证，不创建子代理。用户已授权实施；沿用当前有未提交成果的分支，保留原有改动，不另开丢失现状的 checkout。

**Goal:** 完成通用来源切换、海报墙、浏览与观看、选择性下载和本地登记；保留既有入口。来源来自用户导入的标准目录，提供非成人的离线示例，不新增专门成人站点的检索或播放适配器。

**Architecture:** 新建来源目录和个人标记服务；下载复用 transferVideo、VideoDownloadJob、现有任务中心和 registerVideoContent。新任务与旧任务共享持久表但按类型隔离执行，避免旧队列把新来源当成 Hanime。浏览窗口不持有主应用权限。来源目录仅由用户主动导入，浏览不自动注册本地资源。

**Tech Stack:** Electron 37、Vue 3、TypeScript、SQLite；现有 Node 离线验证和 Playwright 隔离 profile。

## 1. 来源与目录

- [x] 新增 `src/types/video-discovery.ts`，定义来源、作品、播放入口、下载选项、榜单出处和个人标记。
- [x] 新增 `scripts/verify-video-discovery.ts`，先验证同 ID 更新不丢个人标记、空备注可保存、来源隔离、坏 URL/重复编号/过大目录被拒绝、浏览不写 resource。
- [x] 新增 `electron/kinds/video/discovery/catalogue.ts`。输入 `parseCatalogue(raw: unknown): DiscoverySource`，仅接受 `schemaVersion: 1`、非空来源 ID 和最多 2000 作品；HTTP(S) 链接无内嵌账号，不读取脚本；写入在事务中完成。
- [x] 运行 `node --experimental-strip-types --no-warnings scripts/verify-video-discovery.ts`，确认从失败转为通过。

## 2. 下载与本地登记

- [x] 新增 discovery 下载工作流；使用来源快照保存任务，单次入队产生一个作品任务，同一来源作品不可重复排队。
- [x] 扩展共享 job store 的过滤器，旧流程只接管旧任务，新流程只接管 discovery 任务；IPC 合并列表并按任务/草稿 ID 分发。
- [x] 离线测试验证真实传输至临时目录，完成后才登记来源及文件；重复登记幂等；取消、重启中断和登记失败重试保留已完成文件。
- [x] 下载只接受目录中明确列出的完整视频文件。不能下载的作品仍可浏览/观看，按钮说明能力；不推测分片清单为完整文件。

## 3. 桌面入口与海报墙

- [x] 新增来源 IPC 与隔离浏览窗口，renderer 只传来源 ID/作品 ID；主进程读取对应 URL。
- [x] 新增 `/video/discover` 页面与影视库“找视频”入口，支持来源选择、文本搜索、标签/榜单筛选、收藏、详情、观看和下载。
- [x] 复用 DownloadPanel，给通用目录单独草稿状态；下载选项与原 Hanime 入口文案分开。
- [x] 目录导入使用系统文件选择框；支持导出标准目录和下载示例说明，错误保留已有来源。

## 4. 验证与交付

- [x] typecheck、build、来源/队列/入库测试通过。
- [x] 用隔离 profile、本机 HTTP 视频和海报运行界面测试：来源切换、筛选、标记、打开观看、下载、入库、重启后恢复。
- [x] 检查海报墙截图和窄窗口布局，修复遮挡/溢出。
- [x] 运行现有视频队列相关回归；不运行联网成人站点探测。
- [x] 保留来源格式文档、离线验证证据、交付说明；明确支持范围及未经在线验证的内容。未经用户要求不提交、推送或改写旧发行版。

## 参考取舍

借鉴 JavdbEmbySkin 的海报墙/个人评分分离、javranking-extension 的编号归一化和带出处榜单、jav-play 的浏览/播放动作分离。代码按抱一现有结构实现，不整包注入脚本，不复用外部站点地址推导或抓取规则。
