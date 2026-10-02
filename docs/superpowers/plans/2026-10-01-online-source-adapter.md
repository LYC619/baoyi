# 在线来源适配与海报墙 Implementation Plan

**完成状态（2026-10-02）：任务 1–8 已完成并核验。详见 [交付记录](../reports/2026-10-01-online-source-adapter.md)。旧交接保留作历史参考；无需重复实施。**

> 按用户“自主推进”授权，使用 executing-plans 在当前功能分支串行执行，保留全部已有修改，不新增子代理、不提交。沿用已有工作区以复用尚未提交的海报墙与下载流程。

**Goal:** 用户输入支持的网页地址，直接在抱一海报墙浏览线上资料、打开详情和内置播放器，并从明显的下载按钮进入已有下载及登记流程。

**Architecture:** 标准 VideoObject 适配器把 HTML 中公开的 JSON-LD 转成现有 DiscoveryEntry；在线来源服务负责受限请求、按需详情、分页和缓存合并。海报墙复用原有收藏与下载，无需用户导入 JSON；原网页仅作为明确的备用入口。首版不执行网页脚本、不探测私有接口、不做站点专用采集。

**Tech Stack:** Electron net.fetch、node-html-parser、SQLite、Vue、原有 DiscoveryCatalogue / DiscoveryWorkflow。

## 已批准的体验与边界

- 输入网址后主操作为“接入海报墙”。支持的页面产生在线来源与作品卡片；不支持时保留输入并说明原因，可选择普通网页浏览。
- 来源分成在线来源与导入目录。在线来源可以刷新、按网页提供的下一页继续读取；已收藏和已下载的作品不会因刷新消失。
- 详情沿用收藏、评分、备注。按需请求详情页以补齐显式视频文件地址，不能把 HTML 页面当文件下载。
- 直接视频文件在当前主界面内播放，顶部显示作品名称与“下载保存”。仅提供外部播放页的作品明确显示限制，由用户选择打开来源页面。
- 保留现有任务进度、取消、重试、仅保存文件和下载后入库。浏览及收藏不增加本地视频记录。
- 只承诺标准公开 VideoObject 资料，不承诺任意网站自动适配；不接入本轮未验证的特定内容站点。

## 实施任务

- [x] 1. 新增 `scripts/verify-online-source.ts`：使用 HTML 文本与隔离数据库测试 VideoObject/@graph/ItemList、相对地址、稳定身份、分页合并、收藏保留、详情补齐、失败不覆盖、非文件链接不可下载、请求体上限。先运行确认缺少实现，再编写下列模块。
- [x] 2. 新增 `electron/kinds/video/discovery/adapters/video-object.ts` 和 `online.ts`。适配器输入 `{html,url}`、输出 `{name,entries,nextPageUrl}`；服务提供 `connect(url)`、`refresh(id)`、`next(id)`、`detail(selection)`。每次读取最多 2 MB / 15 秒 / 5 次重定向，一次只发一个请求，下一页限制同站点，条目总数不超过 2,000。
- [x] 3. 扩展 `src/types/video-discovery.ts` 和 `catalogue.ts`：在线来源配置保存在已有 payload，作品增加显式 `mediaUrl`；解析仍经统一校验；合并使用稳定 ID，个人标记和下载时快照保持原语义。
- [x] 4. 扩展 `electron/ipc/video-discovery.ts`、`electron/preload.ts`：只允许主窗口调用 online API。网络读取经独立会话，站点内容不在主应用执行。
- [x] 5. 修改 `WebSourceEntry.vue`、`Discover.vue`，加入接入、在线来源切换、刷新和分页；增加 `DiscoveryPlayer.vue` 原生视频播放器及下载按钮。只在 CSP 增加 media-src，保留脚本和 iframe 的原限制。
- [x] 6. 新增 `scripts/verify-online-source-ui.ts`：本机网页实际接入、详情补齐、封面显示、收藏、主窗口内真实 WebM 播放、下载字节校验、入库、分页、刷新保留、重启恢复、错误提示；确认不创建浏览弹窗。
- [x] 7. 运行来源单元测试、类型检查、构建、海报目录和通用浏览入口回归。生成 `release/online-source-preview`，对最终 exe 重跑在线完整界面测试，查看深浅色截图；正式发行指针保持不变。
- [x] 8. 在 `docs/superpowers/reports/2026-10-01-online-source-adapter.md` 记录支持范围与实际证据，提供独立启动器及本机演示页面，避免用户必须自行找一个刚好支持的外站才能试用。

验收命令：`node --experimental-strip-types --no-warnings scripts/verify-online-source.ts`；`node --max-old-space-size=768 node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json --pretty false`；`node --max-old-space-size=1536 node_modules/vite/bin/vite.js build`；`node --experimental-strip-types --no-warnings scripts/verify-online-source-ui.ts release/online-source-preview/win-unpacked/抱一.exe`。
