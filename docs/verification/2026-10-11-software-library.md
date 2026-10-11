# 软件整理目录接续实现与验证（2026-10-11）

需求来自软件迁入整理目录后的三个问题：已整理条目缺少常驻入口；删除记录遗留 junction；文件夹分类与软件库不能同步。用户已确认改分类采用“先预览，确认后移动”。

## 实现

- 整理页提供“待整理”和“已整理”，后者保留归档条目，显示目录/链接失效状态，支持搜索、重新归置、链接转实体、移除链接与打开所在文件夹。
- 进入整理页及手动刷新时读取“整理根 / 分类 / 软件”两层目录，登记新分类和新软件，修复可唯一识别的外部移动，并按文件夹更新分类。新软件保持待识别，不自动调用 AI。
- 重新归置由主进程计算准确目标；详情页、批量分类和已整理页都先展示位置，用户确认后执行。冲突、共享目录、分类目录为链接、链接目标变化等情况拒绝移动。
- 删除软件记录时清理关联链接，保留真实文件；共用同一个链接的其他记录仍存在时保留入口。孤立链接逐项选择，执行时重新核对范围和记录引用。
- 同步、移动、链接转换、清理和删除记录在主进程互斥执行。前端保留删除失败项以便重试。

## 回归范围

| 命令 | 覆盖 |
| --- | --- |
| `npm run verify-organize-sync` | 25 项：目录读取、分类同步、同名/重复链接歧义、原位置仍在、共用记录、真 junction 清理、移动限制、失效链接保护、旧 bin 根路径修复等 |
| `npm run verify-organize-renderer` | 删除失败保留选择；批量分类取消不写、确认归置；主进程互斥及异常释放 |
| `npm run verify-organize-ui` | 10 组真实 Electron/SQLite/IPC 场景，见下文 |
| `npm run build` | Vue/TypeScript 检查及 renderer/main/preload 构建 |
| `npm run selfcheck` | 既有 634 项回归 |
| `npm run check-modules` | 9 组 / 5 模块一致性检查 |
| `node --experimental-strip-types --no-warnings scripts/verify-library-selection.ts` | 既有选择、批量部分失败及重试行为 |

真实应用场景：分类/新软件入库与二次同步幂等；归档与坏链接显示、滚动到底部；重新归置预览及身份/备注/启动端保留；资源管理器外部移动后修复；详情改分类取消与确认；孤立链接清理；移除链接回到待整理；链接转实体；删记录联动删链接；960×640 下控件可达且无横向溢出。

`output/software-library-20261011/run-*/verification.json` 记录结果，旁边保存界面截图。每次运行创建独立 profile、数据库和合成目录；不启动测试 EXE，不连接用户模型服务，不读取或改动真实资料库。

最终结果：以上检查全部通过。最后一次真实应用验证为 `output/software-library-20261011/run-rIWete/verification.json`，10/10 通过，页面运行错误为 0。构建日志为 `output/software-library-build.log`，既有自检日志为 `output/software-library-selfcheck.log`（634/0）。构建保留项目原有 Vite CJS、Sass legacy API 及 MediaInfo WASM 路径警告，没有新增编译错误。

## 使用边界

本轮按既定设计仅在进入整理页和手动点击时同步。后台定时扫描、应用启动时同步及同步后自动 AI 识别未启用。没有主程序或存在身份歧义的目录只在报告中列出；目录缺失不删除记录，分类目录消失不自动删除分类。只改软件文件夹名的外部操作缺乏可靠身份依据，不能保证自动认回原记录。

## 0.16.0 打包验收

版本号及依赖锁文件同步到 0.16.0，`npm run verify-release-config` 5/5 通过，`npm run dist:dir` 类型检查、生产构建及目录打包成功。新程序为 `release/0.16.0/win-unpacked/抱一.exe`，沿用 AppData 数据模式，旧包保留原位。

`npm run verify-organize-ui -- release/0.16.0/win-unpacked/抱一.exe output/release-0.16.0/ui` 对真实发布程序重跑上述 10 组场景，10/10 通过，页面异常为 0。运行时确认 `isPackaged: true`、版本 0.16.0 以及本包 `resources/app.asar` 路径。完整结果在 `output/release-0.16.0/ui/run-5h0lul/verification.json`，同目录有界面截图。

`node scripts/verify-packaged-content.cjs release/0.16.0/win-unpacked` 确认 83 个编译文件与本轮构建逐字节一致，SQLite 原生模块、MediaInfo WASM 和存档索引存在且匹配，包内不含用户数据库或便携数据标记。构建日志为 `output/release-0.16.0/build.log`；包内容记录为 `output/release-0.16.0/packaged-content.json`。本地程序未签名。发布说明见 [0.16.0](../releases/0.16.0.md)。

## 0.16.1 实测反馈修复

用户确认移除链接后等待来自自动重新扫描。根因是已整理组件的每次刷新事件都调用 `initialLoad`，连带执行目录同步、所有待整理预览并卸载重建列表组件。现在只查询受影响 ID 的记录；移除链接后只为该 ID 补充待整理预览。其余行的编辑、搜索与类型筛选不被重置。孤立链接清理依主进程返回的成功路径更新，失败项继续勾选，不触发再次扫描。

列表新增绿色软件、链接软件、安装版和待确认类型筛选。磁盘路径仍存在时按实际链接属性显示；原链接被实体目录替换后，同步清除旧链接字段并保留原记录。列表检查主程序存在性，卸载留下目录也会显示异常。新分类归置后直接登记；非绿色实体目录移动预览补充安装路径风险提示。

先补复现用例，确认旧代码在自动重扫、按 ID 查询、实体替换旧链接和主程序缺失场景失败，再修复。最终目录 / 服务检查 28 项、前端及互斥检查 5 组通过；公共自检 634/0、模块 9 组 / 5 模块、发布配置 5/5 通过。日志位于 `output/release-0.16.1/`。

`npm run dist:dir` 通过。真正打包的 0.16.1 通过 12 组真实 Electron / SQLite / IPC 检查，页面异常 0；运行时确认 `isPackaged`、版本及 ASAR 路径。证据为 `output/release-0.16.1/ui/run-e7egKs/verification.json`，同目录有截图。包内 83 个编译文件逐字节一致，SQLite 原生模块和 MediaInfo WASM 检查通过。

卸载 / 重装测试通过合成目录及 EXE 的消失、重建模拟，不调用第三方安装器，也不读取或修改真实资料库。换安装路径或主程序文件名时不自动猜测新的启动端；记录仍保留，需核对。新版运行方式和重装目录约定见 [0.16.1](../releases/0.16.1.md)。
