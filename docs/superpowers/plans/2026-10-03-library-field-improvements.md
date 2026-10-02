# Library Field Improvements Implementation Plan

> 主会话按 executing-plans 串行实施；用户明确不使用子代理。进度见 .planning/field-improvements-20261003。

**Goal:** 完成用户实测列出的四库功能强化与修复，交付新打包。

**Architecture:** Vue 页内子页、持久化展示偏好与已有 store/IPC 服务结合。复用漫画 group 与本地文件安全边界，重要数据操作留在主进程。

**Tech Stack:** Electron 37、Vue 3、TypeScript、Pinia、SQLite、Node 原生测试脚本。

## A 视频可靠性
- [x] 检查 web-browser/discovery-browser、ffmpeg/hls、JAV 解析器，写本地故障夹具。
- [x] 新窗口策略与 FFmpeg 配置检测实现，Settings/preload/types/IPC 连通。
- [x] 修复 HLS IV/恢复/worker 生命周期，验证下载和取消。
- [x] 主页最近发布日期展示；定向回归后提交。

## B 软件与游戏
- [x] 参考 video/Detail 的 tab，将 software/Detail 与 game/Detail 按职责分块。
- [x] game/Home、Sidebar、store 与通用展示偏好：分类/根下一级目录分组、未分类、卡片尺寸。
- [x] game service/db/IPC/types：失效状态和重新定位，临时文件验证历史 id 保持与路径安全。
- [x] 查识别日志、identity/service/tools/agent；修复有证据的问题并做离线回归，提交。

## C 漫画管理与下载
- [x] image downloads/source/IPC：有界并发，SourceDialog 收藏/排行多选批量入队；测试暂停、取消、去重。
- [x] image Home/Shelf/preferences：分类语义、分组和尺寸；group 管理沿用旧数据。
- [x] image schema/library/IPC/store/types：合集增删/排序/拆分、目录整理移动与全目录删除；真实临时文件夹验证。
- [x] WebP 扫描/下载/protocol/render 回归并提交。

## D 阅读器
- [x] 检查现有 ImageReader 事件与布局；非模态、右上关闭、两侧控件、最大化。
- [x] 验证图片无遮挡、焦点/快捷键、阅读进度与后台交互，提交。

## E 交付
- [x] 逐项自审需求覆盖，执行定向回归、typecheck/selfcheck/build。
- [x] 新版本打包，临时资料验证主界面、路径修复、漫画管理/阅读与下载。
- [x] 写变更说明、测试证据、限制与产物路径，提交并完成 goal。
