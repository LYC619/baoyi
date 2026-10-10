# Project Library Implementation Plan

> 执行方式：遵循用户 AGENTS.md，主会话使用 executing-plans 串行实现、审查与验证。用户已授权开工，无需再次选择执行方式。

**Goal:** 交付项目品类、四类试点导入、外部打开及可恢复的项目移动。

**Architecture:** 新增 `electron/kinds/project`，复用 resource 总表，以 project_meta 保存结构化项目属性和入口。独立扫描器、资料库、路径重映射、移动事务；通过受主窗口校验的 IPC 暴露给 Vue 页面。

**Tech Stack:** Electron、Vue 3、Pinia、TypeScript、SQLite、Node 文件 API。

## 实施步骤

- [x] 1. `scripts/verify-project.ts`：先写 node:test，临时目录与 node:sqlite 验证软件/调研/混合扫描、导入不覆盖手工字段、入口/默认项、重映射、移动碰撞/回退/跨卷/恢复。
  验证：`node --experimental-strip-types --no-warnings --test scripts/verify-project.ts`，先确认缺失模块失败，再逐项通过。
- [x] 2. `src/types/project.ts`、`electron/kinds/project/{index,schema,scanner,library}.ts`：共享类型、v14 表、只读识别和校验后的 CRUD。注册 `KINDS`，关联入口支持原路径和已有资源。
  关键契约：`scanProjects(root, mode)` 返回候选；`ProjectLibrary.register(candidate)` 返回项目；手工字段只有显式 update 才改变。
- [x] 3. `electron/kinds/project/{paths,move,activity}.ts`：原位路径更新、移动预览、持久日志、同卷/跨卷执行与恢复。文件确认后再提交 SQLite，失败留下清楚路径及恢复操作。
  关键契约：`planProjectMove(db,id,target,options)` 和 `executeProjectMove(db,plan,options)`；执行再次校验源和目标，数据库修改采用 SAVEPOINT。
- [x] 4. `electron/ipc/project.ts`、preload、BaoyiApi：主窗口验证、文件选择、导入 token、外部打开、移动预览 token、完成通知。备份恢复和重置必须在项目操作闲置时执行。
- [x] 5. `src/pages/project/{Home,Detail}.vue`、`src/components/project/`、`src/stores/project.ts`：列表、导入预览、属性/入口编辑、移动预览及恢复记录；接入顶栏、路由、模块记忆。
- [x] 6. `src/types/library-backup.ts`、`electron/services/library-backup.ts` 与设置展示：项目备份校验、旧版本空项目表兼容、重置级联、项目计数。
- [x] 7. 串行审查安全和完整性；运行专项、类型检查、自检、备份/迁移与模块检查、生产构建；修复实际问题。
- [x] 8. 使用隔离 profile 验证 UI，扫描四个真实试点但不改原件，打包可运行目录，写发布与验证报告。

## 基线
2026-10-06：`npm run typecheck` 通过；`npm run selfcheck` 634 通过、0 失败。当前分支 `codex/project-library`；原有未跟踪的盘点计划保留。
