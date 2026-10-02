# 在线来源适配交付记录

完成核验：2026-10-02。接续会话 `01a0f832-bf54-7a41-9139-756e8d81af3a`，复用已有实现并完成回归、打包、演示与文档。主会话串行处理，未创建子代理，未提交或推送。

## 已实现的使用流程

输入支持的网页 → 接入已有海报墙 → 按需读取详情 → 收藏、评分、备注 → 主窗口内播放 → 下载保存 → 按选择登记本地库。播放切换下载面板时暂停并释放媒体。浏览和收藏不增加本地影片；最终程序实测下载文件与源文件逐字节一致。

网页必须提供公开 JSON-LD VideoObject，可嵌入 @graph 或 ItemList。读取公开资料，不执行网页脚本。内播及下载使用明确的视频文件地址；普通观看页面不作为文件下载，HLS/DASH、DRM 和站点专用解析不在本轮范围。没有验证任意外站或新增成人站点适配。

来源按稳定身份保存，支持刷新、同站分页及按需详情。请求限制为 2 MB、15 秒、5 次重定向；来源最多 2,000 项。读取失败保留缓存和个人标记。歧义详情不会把推荐视频的媒体赋给当前作品。原有导入目录和独立网页浏览入口仍可使用。

## 立即试用

1. 运行 `release/online-source-preview/start-demo.cmd`，保持演示窗口打开。
2. 运行 `release/online-source-preview/start-preview.cmd`。程序使用该目录下独立的 `preview-profile`。
3. 在「影视 → 找视频」粘贴 `http://127.0.0.1:18765/index.html`，点击「接入海报墙」。
4. 打开「森林纪行」查看详情，点击「观看」或「下载保存」。下载时选择试用目录，可取消登记本地库以仅保存。
5. 点击「读取下一页」验证更多作品；「只有观看页面」演示缺少内播媒体的提示。

演示使用程序生成的海报和 WebM，同一测试短片供多个示例作品使用。预览自带运行时，无需另装 Node。固定端口 18765 若占用，请关闭先前演示服务后重试。源码和资产位于 [examples/online-source](../../../examples/online-source/README.md)。

## 本轮重新运行的验证

| 检查 | 结果 |
| --- | --- |
| `scripts/verify-online-source.ts` | 11 项通过 |
| `scripts/verify-discovery-workflow.ts` | 12 项通过，覆盖下载、取消、重试、快照和备份流程 |
| `vue-tsc --noEmit -p tsconfig.json` | 退出码 0 |
| Vite 生产构建 | 退出码 0 |
| `scripts/verify-discovery-ui.ts` | 原有目录界面 10 项通过 |
| `scripts/verify-web-browser-ui.ts` | 普通网页入口 5 项通过 |
| electron-builder 独立目录打包 | 退出码 0 |
| 对最终 `release/online-source-preview/win-unpacked/抱一.exe` 运行 `scripts/verify-online-source-ui.ts` | 6 组通过，无页面脚本错误 |
| 预览自带 Electron 运行演示服务 | HTML、媒体字节、Range 请求、404 通过 |
| `git diff --check` | 退出码 0；仅已有 CRLF 转换提示 |

打包界面验收覆盖：零目录输入网址、海报缓存、无后台详情遍历、正确详情补齐、个人标记、真实 WebM 播放、全程单主窗口、切换下载停止播放、下载字节一致、本地登记和筛选、分页去重及循环终止、刷新及失败保留、浅色窄窗口、未知网页保留输入、重启恢复配置与任务。

证据在 `output/online-source-ui/result.json` 与同目录截图，执行日志在 `output/online-source-packaged-ui.log`。已查看 `player-dark.png` 和 `wall-light-narrow.png`；后者的 HTTP 503 提示来自主动注入的失败用例，用于证明错误下仍保留作品与收藏。

构建仍提示既有 MediaInfo WASM 运行时定位及包体积信息，构建成功。打包配置已包含独立 MediaInfo WASM 资源。本轮实测为本机 WebM；外站访问、编解码、登录和防盗链仍依赖来源条件。

## 保存状态

分支保持 `codex/field-test-fixes-20260908`，保留其他已有修改。预览单独位于 `release/online-source-preview`；`release/current.json` 仍指向 `0.10.1/win-unpacked/抱一.exe`，未替换正式版。后续接续应以本记录为准，旧交接文件的“尚未编码”是历史状态。
