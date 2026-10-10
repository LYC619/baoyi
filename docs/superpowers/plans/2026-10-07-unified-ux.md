# 统一体验 Implementation Plan

> 主会话使用 executing-plans 串行执行。用户已确认总体方案；不派发子代理，不重问执行方式。

**Goal:** 补齐五库基础管理并消除返回、滚动、分类入口及反馈的体验断点。

**Architecture:** 新增公共列表选择 composable 与批量面板，使用既有软件/游戏/项目 IPC。修复流程出口和 flex 内容裁切；视频来源条件与分类/隐私一致。现有图片/视频专业面板按共同体验标准检查。

**Tech Stack:** Vue 3、TypeScript、Electron、SQLite、Playwright。

## 1. 行为复现与基线
- [x] 新建 scripts/verify-unified-ux.ts：独立 profile 和源文件，加载现有生产包记录长整理列表、当前标签回首页和来源入口失败证据。
- [x] 保存 output/unified-ux/ 中的截图、尺寸和断言；不操作真实库。

## 2. 导航与来源边界
- [x] src/components/TitleBar.vue 当前模块点击使用 MODULE_TABS 对应 home；其他模块仍 moduleTarget。
- [x] src/pages/software/Organize.vue、Confirm.vue 用 router.push({name:'home'}) 提供固定出口；整理的 .body > * 设置 flex-shrink:0，头尾可见。
- [x] src/pages/video/Home.vue 根据当前 type/category 里番以及 privateHidden 判定 Hanime 入口，普通空库提示使用扫描/导入。
- [x] 运行对应 Electron 断言，确认长列表最后一项可见、设置返回不循环、类型和隐私切换正确。

## 3. 共同管理体验
- [x] src/composables/useLibrarySelection.ts：可见 ID 集合、选择、当前结果全选、Esc/Ctrl+A（排除输入元素）。
- [x] src/components/library/LibraryBulkPanel.vue：显示计数、分类/标签及适用动作、进行状态、逐项失败明细；调用既有 window.baoyi API，移出需确认。
- [x] src/components/software/AppCard.vue 与 CardGrid.vue 增加选择状态和明确复选框；Home 接入。
- [x] src/pages/game/Home.vue 复用已有卡片选择，增加共用面板；项目 Home 接入同规则选择。
- [x] scripts/verify-library-selection.ts 行为验证：筛选收敛、文本输入保护、重复提交保护与部分失败保留。
- [x] Electron 实测三库批量修改/归档/恢复/移出，检查数据库和源文件。

## 4. 横向复核
- [x] 图片/视频既有批量管理操作、空筛选清理、窄窗与键盘可达性核对；修复每个明确缺陷。
- [x] 五模块入口、详情返回与位置记忆逐一实测；整合能力矩阵与验证结果。

## 5. 交付
- [x] npm run typecheck、npm run selfcheck、npm run check-modules 及本轮专项通过。
- [x] npm run build、npm run verify-release-config；构建统一版并在包中复测关键场景。
- [x] 更新 README、版本说明与 docs/verification/2026-10-07-unified-ux.md；只声明实测覆盖的范围。

## 完成记录

2026-10-08 接续验收完成。行为、构建、打包及源码摘要证据见 docs/verification/2026-10-07-unified-ux.md 与 release/0.15.0/verification.json。当前分支保留；前轮及本轮未提交成果由 556 文件源码快照追溯。软件 Confirm 原已有固定首页出口，经核对无需额外修改；五库详情及子页记忆由模块记忆、既有 UI 回归与统一体验导航场景共同覆盖。
