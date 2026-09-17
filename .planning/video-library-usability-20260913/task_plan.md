# 2026-09-13 视频目录同步与体验改进

## 目标与约定

按用户完成实测后的反馈修复目录新增视频识别，并实现时间、筛选、本地优先识别、Hanime 浏览下载入口及简介排版。使用 writing-plans、systematic-debugging、planning-with-files、frontend-design 和行为回归流程。主会话串行实现和审查，不新增代理。沿用当前未提交成果，不提交或回退其他变更；正式资料库与真实媒体仅用于只读调查。新包另存。

## 已确定设计

- 未绑定目录的作品按相同系列标题与集号、准确来源或侧车记录发现新集，同时保留跨作品归属、主动移除及重复文件保护；合并后的作品要检查所有已知视频目录，受管图片目录不参与推断。
- 首轮导入、扫描均只读本地 NFO、HanimeViewer JSON、文件名和媒体事实，不自动调用 Agent。资料不足登记为待处理；提供明确的 Agent 复查操作，可串行处理选中项，结果纳入任务日志。
- 发布时间沿用 episode.published_at，缺失时取 air_date；作品列表返回聚合最早/最晚日期。无日期显示未知，不以入库时间冒充发布时间。筛选支持日期范围、观看状态、本地内容状态，并增加发布时间排序。
- 里番范围的搜索栏左侧提供“打开 Hanime”。常驻浏览窗口复用 persist:hanime-network 与既有代理和验证机制，在原生窗口菜单提供后退、前进、刷新和当前视频下载入口；远程页面不获得应用 IPC 权限。点击下载交给主窗口既有预览流程。
- 简介：竖图、横图并排等高，无填充黑边；名称/简介在右，标签在下。窄屏正文移至图片下方但两张图片仍并排。点击图片放大，作品/各集用直接按钮切换。

## 执行与验证

- [x] 核对现有扫描、目录同步、日期、详情与验证窗口代码。
- [x] 在 scripts/verify-video-library-usability.ts 建立目录新增集失败复现：未知新集、已有集缺文件、多目录逻辑合集、外部作品与忽略项；修复 local-sync.ts。
- [x] 明确本地识别状态和默认扫描路径，复用待处理与任务执行器增加 Agent 复查；验证未配置/已配置 Agent 的首轮均不调用模型。
- [x] 聚合列表时间、查询筛选与顶部展示；回归日期边界、空日期、合集范围和组合筛选。
- [x] 用独立 Hanime 浏览模块和原生窗口菜单接入浏览/下载；验证导航来源、会话复用、当前 watch URL 交接及窗口生命周期。
- [x] 优化等高图片、放大查看和简介快捷范围；渲染验证宽屏/窄屏、键盘与真实交互。
- [x] 完成相关回归、类型检查、生产构建及隔离 profile 的打包原生验证。
- [x] 独立目录打包、核对产物、记录变更和实测说明。

## 影响文件

electron/kinds/video/{local-sync,local-files,service,registration,db}.ts；src/types/index.ts；src/stores/video.ts；src/pages/video/{Home,Detail}.vue；src/components/video；electron/services/proxy.ts 与新建 Hanime 浏览模块；electron/ipc、preload、main.ts；scripts/verify-video-library-usability*.ts/cjs。

## 验证命令

行为用例使用 node --experimental-strip-types --no-warnings scripts/verify-video-library-usability.ts；类型与生产构建沿用 npm run build。相关既有 verify-video-*、verify-task-* 和 Hanime 网络回归按变更范围串行运行。打包使用本地 Electron 37.10.3，避免重复下载。布局用合成图片，原生测试使用隔离资料库。

## 交付

release/0.8.0-video-library-usability-20260913/win-unpacked/抱一.exe；说明见 docs/video-library-usability-20260913.md。本轮行为 14/14、新包原生 8/8、原生兼容 5/5，25 套相关回归通过；包内 53 个构建文件和 MediaInfo WASM 逐个一致。
