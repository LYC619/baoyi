# 哔咔浏览恢复交付记录

后续真实站点测试发现并修复图片服务器跳转兼容问题。最新程序及验证范围见 [哔咔图片下载修复](2026-09-29-pica-network-fix.md)。

基线提交：`136aa58`。接续 2026-09-27 的未提交成果，恢复搜索、账号收藏和排行榜三个入口。收藏支持分页及新旧排序，排行榜支持日、周、月榜；列表和详情展示作品名称、作者与封面，详情返回保留原列表，选章下载沿用现有队列。

## 实现与审查

- 根据本地 `参考/picacomic-downloader-main` 核对收藏与排行榜路径、排序、周期和响应字段。
- 封面 URL 由来源响应登记，主进程获取并验证图片格式及 5 MiB 大小限制，交给渲染进程显示；请求不附带账号令牌，缺图或加载失败保留占位。
- 收藏、排行榜和封面 IPC 使用现有主窗口身份及登录校验。
- 主会话串行审查接口、类型、桥接、列表切换和下载选章流程，未发现阻止交付的问题。没有创建新子代理。

## 验证结果

- `node --experimental-strip-types --no-warnings scripts/verify-image-source.ts`：收藏分页排序、三种榜单、封面字段及读取、凭据隔离、异常响应、登录过期通过。
- `node --experimental-strip-types --no-warnings scripts/verify-image-download.ts`：签名请求、分页、限速、断点补页、重复下载、入库及重启中断通过。
- `node --experimental-strip-types --no-warnings scripts/verify-image-library.ts`：图片库注册、顺序、资料及进度保留、归档和备份恢复回归通过。
- `npm run build`：类型检查、渲染进程、主进程和 preload 构建通过。仍有原有 Vite CJS、Sass API 弃用及 MediaInfo WASM 构建期路径提示；WASM 按打包配置单独复制。
- `npm run selfcheck`：634 项通过，0 失败。
- `verify-image-source-ui.ts`：源码构建与 Windows 解包程序均通过真实 IPC 界面测试，覆盖登录、收藏分页排序、日周月榜、封面及缺图占位、桌面及 960×640 最小窗口、选章下载入库、返回原榜单、搜索、登录过期和退出登录。
- 选章测试明确等待任务终态，核对入库资源编号、来源编号、页数及章节：只选择第 2 话，只下载该章并入库 1 页。
- `git diff --check`：通过。

## 接续时的问题

原界面测试将异步函数传给 `waitForFunction`，Promise 被当成满足条件的值，导致下载仍在运行时提前读取空资源编号。已改为在测试进程中轮询任务状态，并在成功后核对入库内容。

本次首次在受限执行环境启动 Electron 时，GPU 子进程以 `0xC0000135` 退出，随后主进程触发 `0x80000003` 并出现系统弹窗。用户调整权限后，同一测试在沙箱外正常启动，后续多次源码及打包验证未再出现该崩溃。测试使用 `output/pica-browse-verification/profile-*` 独立资料库。

默认打包停在 Electron 运行时下载步骤。结束该打包进程后，改用本机已安装并验证的 Electron 37.10.3，成功完成打包：

```powershell
node node_modules/electron-builder/cli.js --dir --config.electronDist=node_modules/electron/dist --config.directories.output=output/pica-browse-verification/package
node --experimental-strip-types --no-warnings scripts/verify-image-source-ui.ts output/pica-browse-verification/package/win-unpacked/抱一.exe
```

## 产物与范围

可运行程序：`output/pica-browse-verification/package/win-unpacked/抱一.exe`。程序需连同该目录中的依赖文件一起保留，既有 release 目录没有覆盖。

证据位于 `output/pica-browse-verification/`：`report.json`、`report-packaged.json`、`ranking-desktop*.png`、`ranking*.png` 和 `chapter-selection*.png`。截图封面为合成测试图片。

本轮使用合成网络响应，未使用真实账号验证站点可用性、在线登录或真实内容下载。真实网络、账号权限及站点当前响应仍需在线使用时确认。
