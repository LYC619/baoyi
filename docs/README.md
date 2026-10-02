# 文档导航

## 当前入口

- [在线来源适配：新会话实施交接（待实施）](superpowers/reports/2026-10-01-online-source-adapter-handoff.md)
- [通用网页浏览预览验收](superpowers/reports/2026-10-01-web-browser-entry.md)
- [在线资料库重规划：网页体验优先](superpowers/plans/2026-10-01-online-library-replan.md)
- [视频来源与海报墙](video-discovery.md)
- [视频海报墙预览验收](superpowers/reports/2026-10-01-video-discovery.md)
- [0.10.1 发布说明](releases/0.10.1.md)
- [图片体验优化验收](superpowers/reports/2026-09-30-image-ux.md)
- [图片优化七项总验收](superpowers/reports/2026-09-30-image-optimization-release.md)
- [打包与版本约定](releases/README.md)
- [2026-09-29 文件整理记录](maintenance/2026-09-29-release-cleanup.md)

## 设计与验证

- `superpowers/specs/`：模块设计，含图片 / 漫画模块。
- `superpowers/plans/`：按日期保存的实施计划，历史状态不代表当前待办。
- `superpowers/reports/`：按阶段保存交付证据，本轮体验验收见 `2026-09-30-image-ux.md`，0.10.0 七项功能验收见 `2026-09-30-image-optimization-release.md`。
- `changes/`：影视实测各轮修复说明。
- `verification/`：测试范围、实测结果及已知限制。
- `third-party/`：随程序打包的第三方声明，不归入历史目录。
- `../doc/hanime-api-notes.md`：仍被源码和验证脚本引用的接口笔记。

## 历史与证据

- [早期版本台账](history/README.md)：原根目录的 v0.6 / v0.7 / v0.8 文档和旧 README。
- `../.planning/`：分任务执行记录；保留原有路径，避免破坏交接引用。
- 历史报告中的 `release/0.6.0`、`release/0.7.0`、`release/0.8.0*` 路径已统一移到 `../release/archive/2026-09-29/` 下，末级目录名不变。
- 2026-09-29 整理前的测试证据移到 `../output/archive/2026-09-29/`，仅正在使用的 `pica-network-verification` 保留原位。
- 整理后的 `../output/pica-browse-verification/` 是 0.9.0 的新验证，不是旧的浏览修复包。

历史文档保留当时的描述和结论，不批量改写其路径。精确搬迁对应关系见本机 `../archive/2026-09-29/moves.json`。
