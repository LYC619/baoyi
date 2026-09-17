# 2026-09-13 实测反馈修复记录

交付版本：[抱一.exe](D:/8.Project/0_0_维护/抱一/release/0.8.0-video-field-retest-20260913/win-unpacked/抱一.exe)。先退出旧版，并保留整个 `win-unpacked` 文件夹。上一版目录保留。

## 修复范围

| 实测反馈 | 修复 |
| --- | --- |
| 日志有日期，详情看不到 | 单集作品顶部显示已保存的发行日期和站点发布日期；默认单集简介可直接查看 |
| 导入日志没进入任务，完成下载占据上方 | 导入接入共享任务生命周期，保存进度和结果，可展开本次识别日志；下载历史移至下方并默认折叠 |
| 独立两集点击补齐误报多个作品 | 先按当前来源确认目标作品；其他独立作品的播放列表项保留原归属并禁选，真实来源冲突仍拒绝 |
| 单集简介需要反复向下滚动 | 桌面采用左图右文、下方标签；窄屏堆叠；刷新保留手动选中的查看范围 |
| 新增第二集仍显示未下载、删除预览缺少视频 | 未绑定目录的条目也能关联同目录中匹配已知单集的视频，不占用公共父目录，不认领其他作品文件 |
| 创建合集叫“新合集”，创建失败 | 从所选作品提取系列名称；旧来源重复绑定不再触发 UNIQUE；自身提交不再提示预览失效；完全未执行的失败记录可重新预览 |
| 海报存放在 C 盘 | 默认放在项目 `data/posters`；安全迁移旧缓存及数据库/下载/整理日志引用，整理回退不会恢复旧缓存路径 |

日期问题经只读查询确认：用户两集的发布日期已经保存为 `2026-06-04`。补齐报错的根因是整份播放列表跨越两个独立条目，不是把两个文件识别成同一个视频。

## 验证

- 35 组相关回归通过，覆盖下载、来源归属、合集整理与回退、扫描、本地 NFO、图片、任务、界面和备份恢复。
- 本轮反馈数据测试 8 项、导入任务流程 19 项、合集界面状态 14 项包含于上述回归。图片迁移补充目录别名保护后，单独复验 14 项通过。
- 本轮界面专项 4 项通过，检查日期默认展示、查看范围保留、960/1280 布局、导入识别日志及异作品下载禁选；已查看截图。
- 真实 Electron/SQLite 的默认目录与显式 profile 两种情况通过，覆盖启动迁移、图片解码、手选封面保存和重新开库。
- `npm run typecheck`、`npm run build`、`git -c core.safecrlf=false diff --check` 通过。
- 最终包的 **24 项原生检查通过**：本轮 6 项、既有反馈 12 项、目录结构与重启 6 项。本轮已读取真实来源 `406504` 和 `406505` 的播放列表，确认两条独立作品都能正常准备补齐，其他作品的集数保持独立归属。
- 最终包中 **53 个构建文件与本次构建逐字节一致**，已记录 EXE、ASAR、MediaInfo WASM 和 SQLite 原生模块的 SHA-256。

打包器最初停在运行时下载阶段，改用本机已验证的相同 Electron `37.10.3` 后完成目录打包。最后补入目录别名保护后，已重新构建、打包、核对产物并重跑全部 24 项原生检查。

从此交付路径正常启动时，受管图片目录已只读核验为 `D:\8.Project\0_0_维护\抱一\data\posters`。迁移会先校验副本、保存恢复映射与字段快照，再更新引用和清理旧文件；如果新旧目录实际是同一位置，则保留原图，避免把同一文件误当成两个副本。

正式资料库仅用于只读核对。功能验证使用临时资料库、合成视频和中性测试图；旧交付目录保留。图片迁移没有手动应用到正式资料库，会在用户启动新版后执行。

## 证据

- [35 组回归结果](../../output/video-field-retest-20260913/regression-results.json)
- [图片迁移最终复验](../../output/video-field-retest-20260913/poster-storage.log) · [真实 Electron 图片目录验证](../../output/video-field-retest-20260913/native-storage.log)
- [最终包原生检查汇总](../../output/video-field-retest-20260913/native-results-final.json)
- [本轮原生实测与真实来源](../../output/video-field-retest-20260913/native-field/evidence.json) · [既有反馈原生验证](../../output/video-field-retest-20260913/native-feedback/evidence.json) · [目录和重启验证](../../output/video-field-retest-20260913/native-local/evidence.json)
- [交付文件与 SHA-256](../../output/video-field-retest-20260913/package-manifest.json)
- [960 宽详情](../../output/video-field-retest-20260913/renderer/episode-layout-960.png) · [1280 宽详情](../../output/video-field-retest-20260913/renderer/episode-layout-1280.png)
- [任务内识别日志](../../output/video-field-retest-20260913/renderer/task-import-logs.png)
- [构建日志](../../output/video-field-retest-20260913/build.log) · [打包日志](../../output/video-field-retest-20260913/package.log)
- [复测步骤](2026-09-13-video-field-retest.md)
