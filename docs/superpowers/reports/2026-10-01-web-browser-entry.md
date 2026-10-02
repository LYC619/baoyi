# 通用网页浏览入口验收

完成日期：2026-10-01。落实用户最后确定的“通用型，输入网页地址后打开并浏览”：进入“影视 → 找视频”默认显示在线浏览，无需本地视频或作品清单。

## 使用与交付

双击 [启动隔离预览.cmd](../../../release/web-browser-preview/启动隔离预览.cmd)，完成首次引导后进入“影视 → 找视频 → 在线浏览”。粘贴网址，点击“打开网页”。常用网址可保存为来源，支持打开、编辑、移除和重启保留。

网页在抱一管理的独立窗口打开。窗口菜单支持主页、后退、前进、刷新、更换网址、复制网址和返回抱一；Ctrl+L 会带回当前地址。加载失败显示错误页，可刷新或更换地址。普通 HTTP(S) 跨站导航和跳转可用，弹出页面在同一窗口打开。

新预览位于 `release/web-browser-preview/`，隔离启动使用其下的 `preview-profile`。版本字段沿用 0.10.1，基于当前工作区构建；正式版仍在 `release/0.10.1/`，`release/current.json` 仍指向正式版，原海报墙预览也保留。没有提交或推送代码。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 地址校验及来源持久化 | 8 项通过 |
| 最终预览包的真实 Electron 界面流程 | 5 组通过 |
| 原海报目录界面回归 | 10 项通过 |
| TypeScript 类型检查、生产构建、独立打包 | 通过 |
| 深色、浅色与窄窗口截图检查 | 通过 |
| 本轮相关文件 diff 空白检查 | 通过 |

真实界面验证使用两个本机 HTTP 服务和独立 SQLite 资料目录，覆盖空库直接输入网址、来源保存、浏览窗口隔离、前进后退刷新、跨站跳转、更换网址、加载失败恢复、窗口复用、弹出链接、编辑、完整关闭重启保留、移除，以及无本地资源写入。远程页没有主应用的 `window.baoyi` 或 Node `require`。没有访问外部内容站点，也没有据此宣称某个网站的播放或登录已经验证。

复验发现并修复两处问题：测试原来在 preload 就绪后立刻修改路由，可能被启动过程覆盖，现改为通过加载完成后的可见按钮进入页面；很长的域名作为默认来源名称时可能超出读回限制，现限制默认名称长度并增加持久化回归测试。

证据：`output/web-browser-unit.log`、`output/web-browser-typecheck.log`、`output/web-browser-build.log`、`output/web-browser-packaging.log`、`output/web-browser-packaged-ui.log`、`output/web-browser-discovery-regression.log`。最终界面结果与截图在 `output/web-browser-ui/`：`result.json`、`web-entry-dark.png`、`web-entry-light.png`、`web-entry-narrow.png`、`web-browser.png`。历史 failure 文件保留用于诊断，以最终成功日志及 `result.json` 为准。

## 当前能力范围

已有海报墙、来源目录、个人标记及目录下载流程保留。普通网页入口不会自动采集网页、生成海报墙、同步网站收藏、解析视频或下载文件；这部分不能算作之前提出的网站整套流程集成。网页播放取决于网站自身与 Electron 的格式支持，依赖多窗口的登录流程可能不兼容。

浏览窗口使用独立持久会话，不带主应用 preload，设备权限关闭。网址仅支持 HTTP(S)。来源名称和网址保存在 `settings.web_browser_sources`，最多 64 个；不写入作品目录或本地资源表。当前完整资料备份不包含设置，因此这些网址需要随资料目录完整备份。

具体操作见 [使用说明](../../../release/web-browser-preview/试用说明.md)；产品功能说明见 [视频来源与海报墙](../../video-discovery.md)。
