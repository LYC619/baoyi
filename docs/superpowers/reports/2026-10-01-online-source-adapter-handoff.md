# 在线来源适配：新会话实施交接

记录日期：2026-10-01。用户因上下文过长，要求记好计划后自己开新会话。此文件是实施入口，不是完成报告。

## 先看这几条

1. 用户已经说过“可以，你自主推进吧，我歇一会”和“开始实施吧”。新会话直接按 [实施计划](../plans/2026-10-01-online-source-adapter.md) 执行，无须重新询问是否开工。
2. **本计划尚未开始编码。** 中断前仅阅读了现有代码并保存计划。`electron/kinds/video/discovery/online.ts`、`scripts/verify-online-source.ts`、`src/components/video/DiscoveryPlayer.vue` 在交接时均不存在；计划全部任务未完成。
3. 用户不接受只做一个“网址收藏＋原网页弹窗”。他要网站内容进入已有海报墙，详情和观看尽量留在当前界面，并有明显的下载入口，复用已有任务与本地入库。
4. 先前的海报墙、下载和浏览器均在当前未提交工作中。直接在现有目录继续，保留其他修改，不重置、不提交、不推送、不新建子代理。
5. 首版技术方案是通用标准 VideoObject 网页适配；它只证明通用流程，不能被描述成任意网站或原先提到的特定项目已经适配。

## 用户意图与范围

用户最初参考网上项目，希望从囤积本地大视频改为在线浏览、选择、观看，喜欢时才下载入库。前一版要求导入 JSON 才能显示海报墙，偏离了在线优先；后一版只是普通浏览窗口，也没有接上已有功能。用户实测后明确指出没有类似现有来源的下载入口，打开的仍是原网页弹窗。

最近确认的方向：**输入支持的来源网址 → 网页资料进入抱一海报墙 → 详情、收藏 → 内置观看 → 有可用文件时下载 → 按选择登记本地库。** 未适配网页应明确标注，可提供普通浏览作为辅助，不能悄悄把辅助浏览说成集成成功。

本轮选定的具体实施方式：读取 HTML 内公开 JSON-LD 的 VideoObject，兼容 @graph、ItemList；把标题、封面、描述、年份、评分、详情链接、显式媒体文件地址转为现有 DiscoveryEntry。它是一种无需特定站点规则的标准适配器。不同网站不保证提供这些信息，不能承诺粘贴任意网址就能自动生成海报墙。原始需求提过 JAV 相关项目，但本计划不包含这些站点的专用抓取或脚本集成。

## 工作区与环境

- 目录：`D:\8.Project\0_0_维护\抱一`。
- 分支：`codex/field-test-fixes-20260908`，已有大量其他未提交工作。
- PowerShell；Node 22.14；Electron 37.10.3；Vue / TypeScript / SQLite。
- `rtk` 先前检查不可用，直接运行命令。
- 项目 AGENTS.md 要求默认主会话串行，不主动新增子代理或任务会话。
- `.planning/.active_plan` 仍是其他工作的 `image-ux-20260930`，不要覆盖它；本任务以 docs 中的计划和本交接为准。
- 本次交接没有启动后台进程或测试，也没有新的运行中 exec 会话。
- 正式版 `release/0.10.1/` 和 `release/current.json` 不得覆盖，指针仍应为 `0.10.1/win-unpacked/抱一.exe`。
- 已有两套独立旧预览：`release/video-discovery-preview`（导入清单海报墙）、`release/web-browser-preview`（普通网页浏览）。新交付使用 `release/online-source-preview`。

## 现有代码可直接复用的部分

| 文件 | 当前作用 / 接入提示 |
| --- | --- |
| `src/types/video-discovery.ts` | DiscoveryEntry/Source/Card/Selection/Api；需扩展 online 来源配置、显式 mediaUrl 和 online API。 |
| `electron/kinds/video/discovery/catalogue.ts` | 统一校验、来源持久化、个人标记、本地资源关联。`importSource` 会先 parseCatalogue，未知字段被丢弃；新增字段必须完整经过类型、解析、保存和读回。 |
| `electron/kinds/video/discovery/workflow.ts` | 已有 prepare / enqueue / retry / cancel / 入库。以 DiscoverySelection 取下载信息，任务保存作品快照；直接接入它，不重造下载器。 |
| `electron/ipc/video-discovery.ts` | 来源 IPC、封面缓存、主窗口调用校验；可在此注册 online.connect/refresh/next/detail。 |
| `electron/preload.ts` | `window.baoyi.video.discovery` 桥接。 |
| `src/pages/video/Discover.vue` | 海报墙、筛选、收藏、详情、下载面板；当前默认 WebSourceEntry。online 结果选中对应来源即可复用这套卡片。 |
| `src/components/video/WebSourceEntry.vue` | 目前主按钮仅“打开网页”，另有保存网址。需加“接入海报墙”作为主操作，普通打开保留为次操作。 |
| `src/components/video/DiscoveryDetail.vue` | 已有观看、下载保存、收藏、评分、备注；缺少下载地址时禁用并说明原因。 |
| `src/components/video/DownloadPanel.vue` | 收到 discovery selection 会自动 prepare，已有画质、目录、仅保存/登记、下载任务状态。 |
| `src/composables/useVideoWorkflow.ts` | discovery 草稿和下载队列控制，不要走其旧来源专用 URL 解析分支。 |
| `src/composables/useVideoDiscovery.ts` | pendingDiscoveryDownload、pendingWebAddress。 |
| `src/main.ts` | 接收浏览窗口事件、导航到 discovery。 |
| `electron/services/web-browser.ts` | 目前是独立 BrowserWindow，且主动拦截原生文件下载。这就是用户说的弹窗，不能作为新功能主交付。 |
| `electron/services/discovery-browser.ts` | 目录专用原网页窗口；只在当前 URL 能对应目录条目时启用“保存此视频”。新内置播放器不依赖此弹窗。 |
| `index.html` | CSP 默认仅 self、图片 baoyi；内置远程 video 需有针对性加入 media-src，不能放宽 script-src 或给远程页面主窗口权限。 |

`node-html-parser` 9.0.2 已在 package.json，优先复用，无需另加 HTML 解析依赖。`parseCatalogue` 下载地址校验只允许明确的完整视频文件格式，不能把普通网页或 HLS/DASH 清单伪装成下载文件。

## 实施时应明确的细节

- 新增 `adapters/video-object.ts`，纯文本解析，返回 `{name,entries,nextPageUrl}`，不执行网页脚本。使用受限遍历解析嵌套资料，处理相对链接并剔除非 HTTP(S) 地址。
- 在线服务提供 `connect(url)`、`refresh(id)`、`next(id)`、`detail(selection)`。只在用户连接、刷新、翻页或打开详情时发请求，不后台遍历全站。
- 单次最多 2 MB、15 秒、5 次重定向；网络请求串行；显式 next 链接限制同站点；总条目最多 2,000。失败保留现有来源和收藏，不用空结果覆盖。
- 来源 ID 与条目 ID 稳定，建议对规范化来源 URL / 作品页面 URL 做哈希，不依赖标题。详情补齐时保持原条目 ID；同一 URL 重复接入不能产生另一套收藏。
- 来源的线上配置存进已有 payload，尽量让原有完整资料备份自然包含它。注意 summary 类型也要带 online 信息以驱动 UI。
- 列表可能只有资料和详情链接，详情请求才取得 contentUrl。要明确选择对应作品，不能把详情页推荐的另一个视频误当当前作品。
- 刷新合并更新资料并保留已缓存作品，个人标记和下载快照不受影响；分页去重、阻止循环，不能刷新后丢失收藏入口。
- 明确 mediaUrl 与 playUrl 的区别：前者是可交给原生 video 的媒体文件；后者可能只是普通观看网页。
- `DiscoveryPlayer.vue` 在当前界面播放显式媒体，顶部包含标题、关闭、下载保存。没有可内播文件时明确显示可打开来源页，不自动弹窗冒充内置播放。
- 沿用现有界面风格；详情/播放器/下载面板切换时暂停播放，避免重叠遮罩或关闭后仍播放。

## 测试与预览

先写 `scripts/verify-online-source.ts` 跑出缺少实现的失败，再实现。覆盖解析、URL 校验、稳定身份、分页、个人标记保留、详情补齐、失败不覆盖、文件与网页地址区分、请求大小限制。

新增 `scripts/verify-online-source-ui.ts`：生成本机普通视频网页和真实 WebM，启动隔离 Electron，通过真实 UI/IPC 完整走通。验收点包括零目录输入网址、海报和详情、收藏、单主窗口内实际播放、下载文件字节相等、登记、本地计数、分页、刷新、重启保留、未知网页提示，以及无浏览弹窗。

可参考：

- `scripts/verify-discovery-ui.ts`：本机 HTTP 服务、MediaRecorder 生成 WebM/封面、真实下载与入库、对任务状态轮询。
- `scripts/verify-web-browser-ui.ts`：隔离启动、重启、可见按钮进入页面、深浅色截图。
- `scripts/verify-discovery-workflow.ts`：下载快照、重试、恢复和完整资料备份。
- Playwright 可由 `BAOYI_PLAYWRIGHT` 指定；现有脚本默认路径为 `C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`。

两条已经排查过的测试陷阱：

1. `window.baoyi` 来自 preload，存在不等于 Vue/router 已完成启动。启动后用 `getByRole('button', {name: /^影视\s/}).click()` 再点“找视频”，不要过早改 location.hash。
2. 不要把 async IPC 判断函数直接传给 Playwright waitForFunction；该环境曾把 Promise 当作真值提前结束。用普通异步循环明确 await 每次 IPC 结果，附超时。

命令（日志写入 output，避免长输出）：

```powershell
node --experimental-strip-types --no-warnings scripts/verify-online-source.ts
node --max-old-space-size=768 node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json --pretty false
node --max-old-space-size=1536 node_modules/vite/bin/vite.js build
node --experimental-strip-types --no-warnings scripts/verify-discovery-ui.ts
node --experimental-strip-types --no-warnings scripts/verify-web-browser-ui.ts
node node_modules/electron-builder/out/cli/cli.js --dir --config.electronDist=node_modules/electron/dist --config.directories.output=release/online-source-preview
node --experimental-strip-types --no-warnings scripts/verify-online-source-ui.ts 'release/online-source-preview/win-unpacked/抱一.exe'
```

主按钮变更后，旧浏览测试应明确点击保留的“打开网页”次按钮，不能因新主流程而删掉旧浏览回归。目录测试仍验证旧功能。

旧成果已通过的测试是：网页地址/来源 8 项、浏览器 UI 5 组、目录 UI 10 项、类型检查与构建。**这些不验证本计划的新适配功能。** 新实现必须取得自己的证据。

交付包含新预览、独立启动脚本、可在本机运行的演示网页与视频、使用说明、截图和验收报告。启动脚本沿用清除 ELECTRON_RUN_AS_NODE 并传 `--user-data-dir=%~dp0preview-profile` 的方式。最终必须说明支持的网页格式、未适配的范围和实测边界，不再把原网页弹窗当作完成。

## 新会话第一步

阅读本文件、实施计划和项目 AGENTS.md，检查文件是否有后续变化；随后从计划任务 1 编写测试开始。无需重新研究帖子或再向用户确认已批准的通用流程。用户要求保留的原始体验是判断实现是否偏题的依据，通用标准适配器不等同于全部原始站点目标已经完成。
