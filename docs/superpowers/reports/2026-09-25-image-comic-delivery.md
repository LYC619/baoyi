# 图片／漫画模块交付记录

基线提交：`2b2154e`。本轮实现本地相册、漫画书架与阅读器、ZIP／CBZ 导入、图片类型和标签，以及哔咔登录、搜索、选章、串行下载、失败重试与入库。资料库备份、恢复、清空和全局下载记录已接入图片品类。

## 验证

- `verify-image-library.ts`：自然排序、重复导入、人工资料和进度保留、隐藏分组、缺页、归档边界、备份恢复通过。
- `verify-image-download.ts`：离线模拟签名请求、分页、限速、登录过期、下载中断、只补缺页、重复入库和重启中断通过。
- `verify-image-ui.ts`：独立资料库中的实际 Electron 图片协议、缩略图、导入确认、单页／双页／连续阅读、章节边界、阅读位置恢复、960px 布局通过；解包后的应用也通过相同检查。
- `npm run typecheck`、`npm run build`、`npm run selfcheck`：通过，自检为 634 项、0 失败。
- `verify-library-backup.ts`：75 项通过；`check-module-memory.ts`：9 组／4 模块通过。
- `electron-builder --dir`：已在 `output/image-comic-verification/package/win-unpacked` 生成独立 Windows 测试包；未覆盖既有发布目录。

截图与运行报告位于 `output/image-comic-verification/`，包含 1440px 书架、960px 窗口和阅读器。该目录仅保存合成资料与测试产物，不进入版本库。

哔咔协议根据本地 `参考/picacomic-downloader-main` 源码核对，许可说明见 `docs/third-party/picacomic-downloader.txt`。在线登录和真实站点下载需要用户账号，本轮只做离线模拟，未宣称在线实测通过。
