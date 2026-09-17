# 抱一使用体验审查证据

日期：2026-09-08。本次交付为审查和规划，产品代码未修改。完整方案见 [优化规划](../superpowers/plans/2026-09-08-user-experience-optimization.md)。

## 1. 范围和方法

基于当前未提交工作区阅读实现，并启动上次交付的 `release/0.8.0-field-test-20260908/win-unpacked/抱一.exe`。启动参数指定本轮独立 `user-data-dir`，在主进程校验实际路径后才操作。未改正式片库、用户游戏安装目录和正在使用的应用配置。

使用当前 schema 和注册函数构造作品、12 集系列、缺失文件、原神/启动器/Portal 游戏条目。视频和可执行文件是明确标记的不可播放/不可启动测试文件，没有执行它们；本轮真实网络操作仅用于封面查询和官方资料来源核查。

Playwright 操作成品窗口，在 1280×900、960×640 的 CSS 客户区尺寸截图，记录元素位置、破图数量、页面异常与控制台错误。截图像素受本机 DPI 影响，布局数据以 CSS 像素为准。

本次也阅读了扫描、识别结果、任务中心、设置和目录行为。没有执行全部设置选项、游戏存档备份恢复或真实大库性能测试；这些在规划中作为后续验收项，不冒充已完成测试。

## 2. 最重要的发现

### F01. 下载与作品管理未闭环

**代码确认，用户反馈一致。** 系列服务把文件写入当次选择的 `directory`，没有根据作品创建子目录；单集服务使用文件另存对话框。两者成功结果均明确写“仅保存文件，未自动入库”。本服务没有保存简介、封面、作品清单或注册新内容的调用。

位置：[系列目标目录和文件名](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/download/service.ts:184)、[成功结果](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/download/service.ts:236)、[单集结果](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/download/service.ts:296)。

服务内的最近目录、完成路径和系列目录信息使用内存变量，不能提供跨应用重启的作品目录归属；下载入口还要求先有包含有效 Hanime 编号的库内资源。

位置：[来源解析入口](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/download/service.ts:77)、[IPC 与目录选择](/D:/8.Project/0_0_维护/抱一/electron/ipc/video-download.ts:27)。

### F02. 游戏封面预览被成品 CSP 阻断

**实测和代码确认。** 当前 CSP 为 `img-src 'self' data: baoyi:`，不允许候选图片的远程 HTTPS 地址；游戏详情却直接把候选 URL 写入 `<img src>`。

位置：[页面 CSP](/D:/8.Project/0_0_维护/抱一/index.html:7)、[游戏详情候选图片](/D:/8.Project/0_0_维护/抱一/src/pages/game/Detail.vue:715)。

Portal 对照样本产生 12 个破图预览。控制台记录 `Refused to load the image ... because it violates ... img-src 'self' data: baoyi:`。选择第一张候选后，实际下载成功，本地封面出现，破图数归零。这说明本次网络与最终保存可行，预览有独立故障，不能归结为代理未开。

证据：[Portal 候选破图](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/portal-candidate-preview-1280.png)、[采用后本地封面](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/portal-cover-adopted-1280.png)。

### F03. 搜索词回退会产生不相关封面

**实测和代码确认。** 当前查询依次使用英文名、中文名、目录名。匹配排序保留 exact、partial 和其他结果，其他结果也可能进入候选。

原神样本设置了正确的“原神 / Genshin Impact”，但其共享测试目录名为 `media`。最终面板显示按 `media` 搜索，返回 Whirligig Media Player、Media Circus 等不相关候选。该样本证明目录回退风险，不代表用户真实原神目录也叫 `media`。

位置：[查询词顺序](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/covers.ts:74)、[不相关候选仍保留](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/covers.ts:201)。证据：[原神候选面板](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/genshin-cover-search-1280.png)。最后一次查询约 12.9 秒，属于这个网络和样本的观测值。

用户补充真实问题是原神，当前按客户端名称搜索。未读取用户原神安装配置或实际识别日志，因此不把首次识别如何得出客户端名称认定为已经复现。

### F04. 缺少按环节恢复的封面体验

**部分实测、部分代码确认。** `probeImage` 对异常统一返回失败，上层可能提示“Steam 上没找到”，即使实际上是图片请求失败。缓存文件丢失时游戏卡片和详情均显示破图，不出现自动可用的占位与修复状态。

位置：[候选探测](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/service.ts:299)、[无候选的原因拼接](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/service.ts:397)、[游戏卡片](/D:/8.Project/0_0_维护/抱一/src/components/game/GameCard.vue:54)。

此外，`setGameCover` 先删除原缓存，再复制新图。新图复制失败时旧图已丢失是代码建立的风险，本次未向用户目录注入复制失败。

位置：[封面替换顺序](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/service.ts:231)。证据：[缺失缓存的详情](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/game-broken-cover-960.png)。

### F05. 多视频信息层级不适合选集和补集

**实测和代码确认。** 作品概览之后先呈现单集下载、系列下载，再是简介，之后才到季集。还未解析下载源时，这两块也常驻。

| 客户区 | 单集下载面板起点 | 系列下载面板起点 | 简介标题 | 季集标题 |
| --- | --- | --- | --- | --- |
| 1280×900 | y=353 | y=492 | y=641 | y=801 |
| 960×640 | y=395 | y=534 | y=683 | y=843 |

960 宽度下顶部多操作按钮换成两行，占据额外高度。无全页面横向溢出不等于操作路径顺畅，用户仍要先滚过大量非播放内容。

位置：[影视详情](/D:/8.Project/0_0_维护/抱一/src/pages/video/Detail.vue:709)。证据：[1280 详情](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/series-detail-1280.png)、[960 详情](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/series-detail-960.png)、[季集列表](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/series-episodes-960.png)。

### F06. 文件路径与本地可用性混为一谈

**实测和代码确认。** 样本第 2 集路径为空，第 3 集有路径但磁盘上不存在。详情只显示“缺 1”，主按钮推荐“播放 S01E03”；失联文件被呈现为已有可播放内容。未实际启动测试文件。

计数仅判断 `path != ''`；前端的播放候选同样按非空路径筛选。应在详情和播放前核查可用性，区分未下载、失联和离线磁盘。

位置：[已有集数统计](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/schema.ts:239)、[播放候选选择](/D:/8.Project/0_0_维护/抱一/src/pages/video/Detail.vue:375)。

### F07. 导入仍有不必要的配置门槛

**代码确认。** 加影视前先检查 AI enabled/API Key；无 AI 即拒绝继续。即使之后能读本地 NFO，也没有通过此入口直接注册的流程。游戏首页也有类似前置要求。

位置：[视频扫描预检](/D:/8.Project/0_0_维护/抱一/electron/kinds/video/service.ts:617)、[游戏新增流程](/D:/8.Project/0_0_维护/抱一/src/pages/game/Home.vue:97)。

将来下载自行生成的资源清单必须有无需 AI 的确定性注册路径，否则“资料随文件携带”仍不能消除重复识别成本。

### F08. 任务中心不能承接长期恢复

**实测和代码确认。** 封面搜索、选择结束后任务中心仍显示暂无任务；现有任务仅本次运行保留。任务卡片主要提供查看日志，没有指向作品、目录和相应恢复阶段的动作。

位置：[任务中心](/D:/8.Project/0_0_维护/抱一/src/components/tasks/TaskCenter.vue:113)、[日志按钮与卡片操作](/D:/8.Project/0_0_维护/抱一/src/components/tasks/TaskCenter.vue:164)。证据：[封面操作后的任务面板](/D:/8.Project/0_0_维护/抱一/.recover/ux-review-20260908/task-center-after-cover-1280.png)。

### F09. 低对比信息妨碍扫描

**截图观察与样式计算。** 当前样式中，浅色次要文字 `#9ca3af` 对白色约 2.54:1，警告色 `#fbbf24` 对白色约 1.67:1，深色次要文字 `#6b6b85` 对主背景 `#1e1e2e` 约 3.18:1。用于正常尺寸的有效信息时低于 4.5:1 目标；不将禁用控件混同为必须同等对比的正常文字。

位置：[主题变量](/D:/8.Project/0_0_维护/抱一/src/styles/variables.scss:17)。本轮没有完成全量无障碍审计，建议后续针对实际状态、焦点与点击目标做成品检查。

## 3. 封面替代来源核查

| 来源 | 本次结果 | 可推导的结论 |
| --- | --- | --- |
| [原神国内官网](https://ys.mihoyo.com/main/) | 200 | 本机可访问；HTML 无 `og:image`，描述仍带旧版本信息，不能只取首页 metadata 就宣称已完成封面适配 |
| [米哈游启动器官网](https://launcher.mihoyo.com/) | 200 | 官方发布页面可访问，提供公开页面配置地址 |
| [本次公开配置](https://act.mihoyo.com/puzzle/hyp/pz_Bur_m6Btc7/config.b56a267a.js) | 200 | TypeScript AST 静态解析找到“原神 / Genshin Impact”对应组件与图片引用；未执行远程 JavaScript |
| 原神对应的两张 `act-webstatic.mihoyo.com` PNG | Range 请求均 206、`image/png`，约 0.44-0.48 秒 | 官方图片网络来源可行，尚未把图片构图和完整解码当作已验收 |
| [SteamGridDB 文档](https://www.steamgriddb.com/api/v2)及 [OpenAPI](https://www.steamgriddb.com/static/openapi.yml) | 均 200，YAML 结构解析成功 | 游戏名称搜索和图片接口要求 Bearer API Key；本次未调用需要密钥的图库 API |
| [IGDB 文档](https://api-docs.igdb.com/) | 403 challenge | 本轮可用性核查未完成，不作为零配置默认方案 |

官网资源地址带发布版本/哈希，以上链接是当日证据，不保证未来不变。两张精确图片地址保存在本地 `official-assets.json`，避免在实现中照抄为永不刷新的常量。

网络测试使用 Node `fetch`，未设置应用代理；不能排除本机透明路由。成品游戏查询使用默认 Chromium 网络，而当前抱一代理只写入 `persist:hanime-network`。因此官方直连可行性、系统代理、Hanime 专用代理三者需要分别描述。

位置：[Hanime 专用代理应用](/D:/8.Project/0_0_维护/抱一/electron/services/proxy.ts:77)、[游戏封面默认网络调用](/D:/8.Project/0_0_维护/抱一/electron/kinds/game/service.ts:284)。

## 4. 运行结果和复核入口

最终界面走查脚本正常退出，捕获 12 个状态。页面异常为 0，12 个状态均无 document 级横向溢出；控制台保留了刻意缺失缓存的 404 和实际 CSP 图片阻断，不能将此写成“界面全部通过”。

本地证据目录：`D:\8.Project\0_0_维护\抱一\.recover\ux-review-20260908`。

- `walkthrough.ts`：独立成品走查，创建自己的测试 profile，结束时关闭该实例。
- `evidence.json`：12 个状态、DOM 位置、完整控制台错误和查询结果。
- `source-research.json`、`source-research-round2.json`：官方页面和图库文档的网络记录。
- `official-assets.json`：官方原神组件对应的图片 URL 与状态探测。
- 同目录 PNG：列表、详情、失效封面、候选预览、采用结果、任务与设置截图。

复跑命令在项目根目录执行：

```powershell
node --experimental-strip-types --no-warnings .recover/ux-review-20260908/walkthrough.ts
node .recover/ux-review-20260908/official-assets.mjs
```

首两次走查的启动时序和设置选择器不正确，已修正审查脚本，最终完整运行成功。外部来源初次猜测的主机或仓库地址曾失败，之后只将已核查的实际来源纳入建议。上述审查工具问题未归因于应用。

未重新执行全量构建和上次 627 项自检，因为本轮未改产品功能。上次测试结果只作为背景文档读取，没有标成本轮重新通过。后续功能完成必须在最终包复验真实下载、目录及资料、自动注册、旧库迁移和使用路径。
