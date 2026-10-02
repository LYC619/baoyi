# 哔咔图片下载修复

后续已整理为 [0.9.0 正式本地发布](../../releases/0.9.0.md)。以下保留当时的修复过程和验证包路径。

## 原因

用户反馈账号收藏和章节信息可以读取，但封面失败，下载停在 0/90 页；同机参考项目可正常下载。

对照 `参考/picacomic-downloader-main/src-tauri/src/pica_client.rs`，参考项目的图片客户端跟随 HTTP 跳转，并对瞬时失败最多重试三次。本机参考项目选择系统代理，与 Windows 当前启用的系统代理一致。

读取失败任务的封面 URL 后，实际请求收到 `301`，由 `storage-b.picacomic.com` 转到 `img.picacomic.com`。抱一此前给封面和正文图片都设置了 `redirect: 'error'`，因此遇到该跳转就失败。直接改成 `net.fetch({redirect: 'manual'})` 仍会触发 Electron 37 的 `Redirect was cancelled` 问题，必须通过 `net.request` 的 redirect 事件取得跳转地址。

## 修复

- 将影视下载已验证的 Chromium 网络适配器移到公共服务，原影视模块保留兼容导出。默认保留影视会话 Cookie 行为，图片请求使用 `credentials: 'omit'`。
- 哔咔 API 请求继续使用原来的签名请求；图片和封面使用同一套手动跳转逻辑，逐跳检查 HTTPS、地址及循环，最多跟随五次跳转。
- 连接失败、超时和 408/429/500/502/503/504 响应最多重试三次；取消立即终止，404 等永久错误不反复重试。
- 保留图片格式校验、响应大小限制及失败后只补缺页行为。错误信息可保留 Chromium 网络错误码，但不输出账号令牌或服务响应正文。

## 验证

- `verify-image-network.ts`：五种跳转状态、相对跳转、凭据隔离、循环及跳转上限、非法地址、瞬时重试、永久错误和取消通过。
- `verify-image-source.ts`、`verify-image-download.ts`：收藏榜单封面及原有断点补页回归通过。
- `verify-video-download-network.ts`：10 项通过；`verify-video-download-electron.cjs`：5 项通过，包含真实 Chromium Cookie、Referer、手动跳转、代理和图片请求省略 Cookie。
- `npm run build` 和最终 `npm run typecheck` 通过；构建仍有此前记录的工具链弃用和 WASM 路径提示。
- 源码及修复包的 `verify-image-source-ui.ts` 均通过，合成服务现包含 301 跳转，并验证封面显示和选章下载入库。
- `verify-image-network-live.cjs` 使用失败任务信息及本机已有登录状态，只读访问原资料库，经过现有系统代理实际读取了封面和首张正文图片：封面 JPEG 38,744 字节；章节返回 90 页；首张正文 JPEG 54,527 字节。没有重新下载整个章节，也没有改写用户任务或下载目录。

真实网络报告：`output/pica-network-verification/live-report.json`。报告仅保存状态、域名、图片类型和字节数，不保存令牌、作品标题或图片内容。独立诊断进程使用系统解密所需的临时加密配置，运行后删除该临时配置。

## 交付

修复程序：`output/pica-network-verification/package/win-unpacked/抱一.exe`，需与同目录依赖文件一起保留。它使用原有正式资料库；关闭旧窗口、运行此程序后，可在原失败任务上点击“重试缺失页”。旧的 `pica-browse-verification/package` 程序未覆盖。

打包命令：

```powershell
node node_modules/electron-builder/cli.js --dir --config.electronDist=node_modules/electron/dist --config.directories.output=output/pica-network-verification/package
node --experimental-strip-types --no-warnings scripts/verify-image-source-ui.ts output/pica-network-verification/package/win-unpacked/抱一.exe
```
