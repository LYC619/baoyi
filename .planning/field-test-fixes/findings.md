# 调查记录

- 用户实测反馈五项：下载、文件名识别及分组、里番显式类型、其他分类、封面。
- 原会话最新轮因 API 错误中断，系列下载此前已经完成。本轮继续其后新增的实测修复。
- 既有工作区大量修改均须保留；rtk 在当前 shell 不可用，直接执行原命令。
- 下载使用内置代理所在的 Chromium 会话；原会话真实 Electron fixture 已证明完整 Referer 与默认策略冲突。chromium-fetch.ts 已设置 referrerPolicy=unsafe-url，verify-video-download-electron.cjs 尚未接入 package.json。
- 既有计划选择保留底层 movie/series 结构，将里番作为显式界面类型；默认查询及统计排除里番，兼容现有播放和季集。
- 视频分类已有“其他”兜底，但 prompt 明确跳过录屏、会议录像、家庭视频及游戏直播，需要调整。
- 封面模块为 electron/kinds/video/posters.ts；service.ts 的 fetchVideoPoster 负责实际抓取及缓存。

## 最终核验

- Chromium Referer 策略修复已通过本次真实 Electron fixture 4/4；标准 npm 入口已接入。
- 原始文件名既进入识别 prompt，也用于启用 Hanime 工具；旧文件归属提供历史分类。服务级回归 7/7。
- 旧库误合并的多作品在重扫时有集号槽位冲突，必须先拆出其他作品再更新原条目。事务迁移集记录保留集 ID 和进度，失败时暂停保留条目的更新；数据库回归 9/9。
- 最终单文件包、成品界面、隔离启动退出和包内文件一致性均已验证。证据和真实网站/LLM 实测边界见 docs/verification/2026-09-08-field-test-fixes.md。
