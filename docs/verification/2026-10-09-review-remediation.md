# 代码与前端整改验收 · 2026-10-09

按 [整改方案](../superpowers/plans/2026-10-09-review-remediation.md) 完成 E0—E7 串行实施和验证。两轮审查中的 2 项 P1、4 项 P2 已修复；五库的工具栏和批量状态已收紧。最后一轮隔离 Electron 验证 **34 项通过、0 项失败、0 条 renderer error**，自检 **634 通过、0 失败**，类型检查、专项脚本和生产构建通过。

验收对象是 `codex/project-library` 分支的实际工作区，包含执行前已有的未提交修改。本轮没有创建子代理、提交、推送或打包发布；版本仍为 0.15.0，现有发布包未替换。以下描述的是源码及本地构建后的行为。

## 改动与验收对应

| 工作包 | 实施结果 | 验证及证据 |
|---|---|---|
| E0 工作区保护 | 保存 743 个非忽略文件的原始字节及 SHA256，另存 status、工作区差异和暂存区差异。原地执行，保留原有审查资料。 | [基线](../../output/review-remediation-20261009/baseline/hashes.json)、[最终比较](../../output/review-remediation-20261009/baseline-comparison.json) |
| E1 图片详情 | 请求固定 ID 与轮次，条目和页面一起提交；旧响应、错误和卸载后的响应均不能污染当前详情。区分加载、成功、缺失、失败；保存、移动、移除、重扫和重新定位固定操作对象，旧操作不能回写或导航当前页面。 | [详情实现](../../src/pages/image/Detail.vue)、[边界专项](../../scripts/verify-review-boundaries.ts)；慢 A/快 B、旧请求失败、A/B/A、卸载、重试、操作中切换和 `read=1` 全部通过。真实 IPC 验证编辑 B 只改变 B。 |
| E2 影视查询 | 从实际查询生成签名，只有当前查询成功才解除锁定。防抖、等待、失败阶段保护勾选、全选、批量表单、移除、移动、整理和复查；范围变化清除旧选择及确认。处理函数也校验状态，写入前固定批次。 | [查询专项](../../scripts/verify-library-query.ts)加载实际 store、Home 和批量面板；[UI 结果](../../output/review-remediation-20261009/ui-E7.json)中 A 标签仍为空，成功查询后的 B 才新增测试标签。 |
| E3 项目导入 | `recordImport` 只做本地登记，不调用模型、不自动应用建议。导入后从项目助手主动分析，沿用停止、重试和显式应用；重复导入、已有项目关联和人工资料保护保持有效。 | [项目助手](../../electron/kinds/project/agent.ts)、[项目 IPC](../../electron/ipc/project.ts)；助手 6/6、项目 13/13。真实导入 IPC 在模型配置有效时调用数为 0；本地 HTTP 模型完成停止→失败→重试→应用，始终使用同一登记会话。 |
| E4 局部布局 | 软件批量入口进入工具栏；列表按需预留操作空间，启动按钮可通过键盘焦点显示。照片下拉框与书架共用有效分组；损坏 JSON、null、字符串和非法偏好字段均安全回退，存储键不变。 | 软件两尺寸内容区均增加 44 px，工具栏保持 64 px。长标题、多标签、最近使用/从未使用及 hover/focus 下，文字与图标交集为 0。照片首次打开、双向切换、none 刷新和损坏偏好回退通过。 |
| E5 批量状态 | 零选中折叠参数，选中后只显示当前操作所需控件；查询等待、写入 busy、确认和错误仍明确可见。补齐退出焦点、图片类型切换后的操作复位、图片/项目刷新失败期间提交保护。 | 五库 × 两主题 × 两尺寸，覆盖零选、单选、多选、处理中、失败及重试。输入框 Ctrl+A 保持文本全选；Esc 退出后焦点回入口。公共面板在 960 宽时为 56/98 px。 |
| E6 工具收纳 | 游戏、影视使用小型 [工具菜单](../../src/components/library/LibraryToolbarMenu.vue)；视图与低频维护操作收纳，影视本地导入入口合并，音频仍显示“导入音频”。图片合并数量/控制行，项目数量并入标题。 | 按游戏→影视→图片→项目逐库构建和验证。菜单键盘打开、Esc 关闭与焦点返回通过；覆盖默认/最大卡片、软件与影视列表/网格。首屏测量见下表。 |

项目导入的用户流程现为：确认导入 → 本地登记完成 → 项目助手显示“已登记，可分析” → 点击“让助手了解项目” → 核对并应用资料建议。模型失败不撤销已导入项目；重试不会创建重复项目或登记会话，过期建议仍校验项目变更。历史发布说明保留当时的自动补全行为，本报告记录本轮调整。

批量失败语义没有改变：软件、游戏、项目逐项执行，保留成功/失败统计并只重试失败项；图片标签和影视批量更新使用原有原子事务，失败时整体不提交，重试原批次。没有把事务型写入改成部分提交。查询等待时可以清空或退出，正在写入时继续保留防重复提交与退出保护。

## 首屏测量与截图

使用与原审查相同规模的合成资料：24 个软件、24 个游戏、24 个影视条目、12 个相册、12 个项目。默认字号和卡片尺寸，滚动位置在顶部；数值为第一张卡片顶部的 CSS 像素坐标。旧值来自 [前端专项报告](2026-10-09-frontend-layout-review.md)，新值来自最后一轮 `ui-E7.json`，以下使用深色主题记录。

### 960 × 640

| 资源库 | 普通：修改前 → 后 | 零选择批量：修改前 → 后 | 修改后单选/多选 | 普通模式释放高度 |
|---|---:|---:|---:|---:|
| 软件 | 186 → 142 | 306.2 → 210 | 252 | 44 |
| 游戏 | 226 → 182 | 390.2 → 204 | 246 | 44 |
| 影视 | 217 → 184 | 344 → 184 | 240 | 33 |
| 图片 | 298 → 240 | 454 → 240 | 299 | 58 |
| 项目 | 237.5 → 171.5 | 407.7 → 245.5 | 287.5 | 66 |

软件工具栏仍高 64 px，内容区由 456 增至 500 px。游戏普通工具栏由 150 降至 106 px，影视由 137 降至 104 px。公共批量面板零选择/普通已选中为 56/98 px；影视选择行加表单为 40/96 px；图片选择控制行加表单为 36/83 px（表单外间距另计）。错误、确认和执行结果允许额外展开。

游戏选中后的首排名称、影视首排名称和本地状态均在窗口内。收益是测得的可用高度增加，不据此宣称必然多出整排卡片。图片按来源目录分组的稀疏样本，也不用于判断网格最大列数。

| 资源库 | 普通修改前 | 普通修改后 | 批量修改前 | 批量零选修改后 | 批量已选修改后 |
|---|---|---|---|---|---|
| 软件 | [截图](../../output/review-20261008/frontend/software-browse-960.png) | [截图](../../output/review-remediation-20261009/software-browse-dark-960.png) | [截图](../../output/review-20261008/frontend/software-bulk-960.png) | [截图](../../output/review-remediation-20261009/software-bulk-zero-dark-960.png) | [截图](../../output/review-remediation-20261009/software-bulk-selected-dark-960.png) |
| 游戏 | [截图](../../output/review-20261008/frontend/game-browse-960.png) | [截图](../../output/review-remediation-20261009/game-browse-dark-960.png) | [截图](../../output/review-20261008/frontend/game-bulk-960.png) | [截图](../../output/review-remediation-20261009/game-bulk-zero-dark-960.png) | [截图](../../output/review-remediation-20261009/game-bulk-selected-dark-960.png) |
| 影视 | [截图](../../output/review-20261008/frontend/video-browse-960.png) | [截图](../../output/review-remediation-20261009/video-browse-dark-960.png) | [截图](../../output/review-20261008/frontend/video-bulk-960.png) | [截图](../../output/review-remediation-20261009/video-bulk-zero-dark-960.png) | [截图](../../output/review-remediation-20261009/video-bulk-selected-dark-960.png) |
| 图片 | [截图](../../output/review-20261008/frontend/image-browse-960.png) | [截图](../../output/review-remediation-20261009/image-browse-dark-960.png) | [截图](../../output/review-20261008/frontend/image-bulk-960.png) | [截图](../../output/review-remediation-20261009/image-bulk-zero-dark-960.png) | [截图](../../output/review-remediation-20261009/image-bulk-selected-dark-960.png) |
| 项目 | [截图](../../output/review-20261008/frontend/project-browse-960.png) | [截图](../../output/review-remediation-20261009/project-browse-dark-960.png) | [截图](../../output/review-20261008/frontend/project-bulk-960.png) | [截图](../../output/review-remediation-20261009/project-bulk-zero-dark-960.png) | [截图](../../output/review-remediation-20261009/project-bulk-selected-dark-960.png) |

### 1280 × 820

| 资源库 | 普通：修改前 → 后 | 零选择批量：修改前 → 后 | 修改后单选/多选 |
|---|---:|---:|---:|
| 软件 | 186 → 142 | 310.2 → 206 | 248 |
| 游戏 | 182 → 136 | 304.2 → 200 | 242 |
| 影视 | 190 → 140 | 281 → 140 | 196 |
| 图片 | 255.5 → 197.5 | 411.5 → 197.5 | 256.5 |
| 项目 | 244.5 → 178.5 | 418.7 → 248.5 | 290.5 |

软件内容区由 636 增至 680 px。五库在两种尺寸、深浅主题下的已检查状态均没有可见控件横向越界。完整矩阵的截图保存为 `<库>-browse/bulk-zero/bulk-selected/bulk-busy/bulk-failure-<dark/light>-<960/1280>.png`。例如：[浅色项目](../../output/review-remediation-20261009/project-browse-light-1280.png)、[浅色图片失败](../../output/review-remediation-20261009/image-bulk-failure-light-1280.png)、[软件执行中](../../output/review-remediation-20261009/software-bulk-busy-dark-960.png)。

### 正确性与恢复证据

- 图片：[加载中](../../output/review-remediation-20261009/image-loading-final.png)、[当前对象详情](../../output/review-remediation-20261009/image-owned-detail-final.png)。
- 影视：[查询等待](../../output/review-remediation-20261009/video-pending-final.png)、[刷新失败](../../output/review-remediation-20261009/video-query-failed-final.png)、[当前查询写入](../../output/review-remediation-20261009/video-current-query-write-final.png)。
- 项目：[本地登记](../../output/review-remediation-20261009/project-local-registration-final.png)、[分析停止](../../output/review-remediation-20261009/project-analysis-stopped-final.png)、[分析失败](../../output/review-remediation-20261009/project-analysis-failed-final.png)、[建议应用](../../output/review-remediation-20261009/project-analysis-applied-final.png)。
- 查询恢复：[图片刷新失败](../../output/review-remediation-20261009/image-refresh-failed-final.png)、[项目刷新失败](../../output/review-remediation-20261009/project-refresh-failed-final.png)。

## 验证命令

从仓库根目录按方案顺序执行以下命令，均退出 0。最终 UI 使用最新构建产物；末次行为补修后重跑了相关选择/详情脚本、构建和完整 UI 矩阵。

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck` | 通过；最终 build 也执行 vue-tsc | [日志](../../output/review-remediation-20261009/typecheck.log) |
| `npm run verify-library-query` | 三库查询边界、影视真实组件处理函数通过 | [日志](../../output/review-remediation-20261009/verify-library-query.log) |
| `npm run verify-library-selection` | 可见选择、快捷键、固定批次、失败重试和图片操作切换通过 | [日志](../../output/review-remediation-20261009/verify-library-selection.log) |
| `node --experimental-strip-types --no-warnings scripts/verify-review-boundaries.ts` | 图片归属及非法偏好回退通过 | [日志](../../output/review-remediation-20261009/verify-review-boundaries.log) |
| `node --experimental-strip-types --no-warnings scripts/verify-project-agent.ts` | 6/6 | [日志](../../output/review-remediation-20261009/verify-project-agent.log) |
| `node --experimental-strip-types --no-warnings scripts/verify-project.ts` | 13/13 | [日志](../../output/review-remediation-20261009/verify-project.log) |
| `npm run selfcheck` | 634 通过、0 失败 | [日志](../../output/review-remediation-20261009/selfcheck.log) |
| `npm run check-modules` | 9 组 / 5 模块通过 | [日志](../../output/review-remediation-20261009/check-modules.log) |
| `npm run build` | 通过 | [日志](../../output/review-remediation-20261009/build.log) |
| `node --experimental-strip-types --no-warnings scripts/verify-review-ux-ui.ts` | 34 项通过、0 失败、0 renderer error | [日志](../../output/review-remediation-20261009/ui.log)、[结构化结果](../../output/review-remediation-20261009/ui-E7.json) |

补充运行 `node --experimental-strip-types --no-warnings scripts/verify-field-20261007.ts`，4/4 通过。原因是该既有脚本仍调用被移除的 `initialize` 并断言自动应用；已按 E3 更新为本地登记、主动发送、显式应用，保留人工资料保护断言。

构建仍有原有提示：`new URL('MediaInfoModule.wasm', import.meta.url) doesn't exist at build time`，由运行时解析；本次未改动 MediaInfo 加载方式。未新增构建失败。最终差异检查按 Windows 行尾处理，清除了本次加入的空白行空格；没有为格式清理改写原有无关文件。

## 隔离、复核与覆盖限制

UI 脚本使用独立 `profile-*` 和 `fixtures-*`，启动后断言 `app.getPath('userData')` 等于测试目录。模型只连本地 `127.0.0.1` 模拟服务，导入阶段计数为 0；所有测试数据库写入及文件操作使用隔离资料，未启动合成 EXE，未操作真实用户资料库。补充 field 脚本沿用只读扫描本仓库的输入，数据库使用内存。Electron 和本地 HTTP 服务已关闭，测试资料与日志留作证据。

截图在页面过渡、Vue 更新及实际绘制后生成；使用 `showInactive()`。Playwright 可通过 `BAOYI_PLAYWRIGHT` 指定模块位置，也可使用已安装模块或用户运行时缓存，没有新增产品依赖。最终检查未发现属于本任务的残留 Electron 进程。

主会话对照 E0 快照复核本次差异：743 个基线文件无缺失、快照哈希全部一致，暂存区未变；未触及的基线文件保持字节一致。差异仅涉及本轮实现、相应专项脚本及验收记录。见 [本次差异](../../output/review-remediation-20261009/task-delta.patch)、[最终状态](../../output/review-remediation-20261009/final-status.txt)及[执行记录](../../.planning/review-remediation-20261009/progress.md)。

本轮使用小规模合成资料与本地模型，未验证大库性能、外部模型/资源站兼容性、真实用户资源移动删除或打包发布后的安装体验。最大卡片尺寸和列表模式做了定向检查，不将其等同于全部主题、尺寸、模式的笛卡尔积。`output/` 属于 Git 忽略目录，截图和原始日志链接依赖本机保留这些文件。

E0—E7 无剩余实施项。文档导航已加入本报告，历史审查报告及原始截图继续保留。
