# 运行期全局任务中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不增加数据库迁移和重启恢复复杂度的前提下，把当前运行期的扫描、识别、整理和 Hanime 验证汇总到标题栏任务面板，并保留可读日志。

**Architecture:** 在渲染进程增加模块级单例 `useTaskCenter`，所有任务入口通过稳定的 task id 写入同一份内存状态；标题栏挂载 `TaskCenter.vue` 展示状态。现有 IPC 进度事件和页面局部反馈保留，由各入口桥接更新，不新增主进程任务表或任务 IPC。

**Tech Stack:** Vue 3 Composition API、TypeScript、lucide-vue-next、现有 Electron preload API、Node `--experimental-strip-types` 离线回归脚本。

---

## 执行结果（2026-09-05）

**A 阶段源码与离线验收已完成，保留当前工作区，未提交、未发布。**

| 计划任务 | 最终状态 |
|---|---|
| 1. 任务状态模型 | 已完成；最近 30 项结束任务、每项最近 100 条事件；进度、警告和结果同步输出控制台 |
| 2. 标题栏入口与面板 | 已完成；真实 SFC 内存 renderer 回归通过 |
| 3. 软件扫描与 AI | 已完成；跨页面保留任务，取消等实际 IPC 收尾 |
| 4. 游戏、影视、重新识别 | 已完成；新增共享 useMediaScan，跨页面共享运行/停止状态；重新识别与视频扫描互斥 |
| 5. 整理与 Cloudflare 验证 | 已完成；区分成功、失败、取消与部分失败；辅助网络查询不覆盖主验证结果 |
| 6. 构建与差异检查 | 已完成；10 个验证命令全部退出 0；本阶段文件空白检查通过 |

本轮按用户要求串行执行，不再启动子 agent。没有创建工作树、执行提交/合并/推送、打包安装程序，也没有启动或关闭应用。当前 .git 为只读；此前 index.lock 写入已遭拒，本轮未重复尝试。

原始分步清单保留如下作为计划，不把每一项预期失败命令或提交步骤追溯标记为执行过。最终事实以同目录 2026-09-05-runtime-task-center-verification.md 为准。

---

### Task 1: 建立任务中心数据模型与状态机

**Files:**
- Modify: `src/types/index.ts`（在共享进度类型附近新增 `TaskKind`、`TaskStatus`、`TaskEvent`、`TaskRecord`）
- Create: `src/composables/useTaskCenter.ts`
- Create: `scripts/verify-task-center.ts`
- Modify: `package.json`（增加 `verify-task-center` script）

- [ ] **Step 1: Write the failing test**

在 `scripts/verify-task-center.ts` 导入真实的 `useTaskCenter`，断言新建任务返回 running 记录、`update` 改变计数并追加事件、`finish` 记录最终状态和摘要；再断言失败、取消、多任务计数、完成历史清除、历史 30 条上限和事件 100 条上限。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run verify-task-center`
Expected: FAIL，因为 `src/composables/useTaskCenter.ts` 尚不存在。

- [ ] **Step 3: Implement the minimal state machine**

`useTaskCenter.ts` 提供模块级 `tasks` ref，并导出 `useTaskCenter()`。`start(kind, title, options?)` 生成 `task-${counter}` id，写入 running 任务并追加“任务开始”；`update(id, patch, event?)` 只更新仍为 running 的任务，进度限制在 0–100；`finish(id, status, message, error?)` 只结束 running 任务并追加结束事件；`clearFinished()` 只删除非 running 任务。每个任务最多 100 条事件，任务历史最多保留 30 条；运行中任务永远不被历史淘汰。所有变更用普通对象替换，保证 Vue 响应式和组件读到的新快照。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run verify-task-center`
Expected: `Task center: ... passed, 0 failed`。

- [ ] **Step 5: Commit**

当前工作区 `.git` 在受限环境中不可写；若仍不能创建 `.git/index.lock`，保留文件并在最终报告注明未提交，不修改其他既有 dirty 文件。

### Task 2: 增加标题栏任务入口和面板

**Files:**
- Create: `src/components/tasks/TaskCenter.vue`
- Modify: `src/components/TitleBar.vue`

- [ ] **Step 1: Add component-level regression assertions**

扩展 `scripts/verify-task-center.ts` 的源码约束检查，确认 `TitleBar.vue` 挂载 `TaskCenter`、任务按钮使用 `-webkit-app-region: no-drag`、面板包含运行中/历史、进度和清理入口。

- [ ] **Step 2: Implement the task panel**

`TaskCenter.vue` 使用 `useTaskCenter()`，维护面板开关；入口展示运行数和失败数。面板在标题栏下方绝对定位，点击入口和清除按钮阻止冒泡；任务卡展示状态标签、进度、current/message、结束摘要和最近事件。扫描阶段 `total=0` 使用 CSS 不确定进度动画。面板保持暗色变量、现有圆角和紧凑间距，不引入全局依赖。

- [ ] **Step 3: Run build and regression**

Run: `npm run typecheck; npm run verify-task-center`
Expected: typecheck 退出 0，任务回归 0 failures。

- [ ] **Step 4: Commit**

按 Task 1 的工作区限制处理，不重置或提交其他用户改动。

### Task 3: 接入软件扫描和 AI 识别

**Files:**
- Modify: `src/composables/useScan.ts`
- Modify: `src/composables/useAI.ts`

- [ ] **Step 1: Extend the regression harness**

测试软件扫描和 AI 识别：开始时各出现对应 running 任务；进度事件更新 `processed/total/current/message`；正常结果为 success；异常为 failed 并保留异常文本；取消后不提前结束任务。

- [ ] **Step 2: Bridge the existing progress callbacks**

在 `useScan` 和 `useAI` 中创建 task id，订阅回调把现有进度映射到任务中心；对 `done` 只更新进度，不依赖事件单独结束，最终由 Promise 结果决定 success/部分失败摘要。`catch` 调用 failed，`finally` 保证旧 task id 不会泄漏。保留现有局部 progress 和 latest guard。

- [ ] **Step 3: Run regression**

Run: `npm run verify-task-center; npm run verify-settings-scan`
Expected: 新旧回归均 0 failures。

- [ ] **Step 4: Commit**

按工作区限制处理。

### Task 4: 接入游戏、影视扫描和详情页重新识别

**Files:**
- Modify: `src/pages/game/Home.vue`
- Modify: `src/pages/video/Home.vue`
- Modify: `src/pages/video/Detail.vue`

- [ ] **Step 1: Add failing integration assertions**

源码和离线行为检查确认三个入口都启动任务、收到现有进度、在结果/异常/取消路径结束任务；详情页重新识别使用 `video-scan` 类型并显示对象标题。

- [ ] **Step 2: Implement task bridges**

在游戏和影视 Home 的 `add*` 任务确定目录后创建任务，开始前的 readiness、选择目录取消和配置失败都写入失败或取消语义；扫描 Promise 结束后写摘要，`finally` 只清页面局部订阅。详情页 `reidentify` 创建独立任务，完成后写成功，异常写失败；不改海报补全流程。

- [ ] **Step 3: Run regression**

Run: `npm run typecheck; npm run verify-hentai-e2e; npm run verify-task-center`
Expected: 全部退出 0，海报测试保持 21/21。

- [ ] **Step 4: Commit**

按工作区限制处理。

### Task 5: 接入软件整理和 Hanime 验证、补齐日志语义

**Files:**
- Modify: `src/composables/useOrganize.ts`
- Modify: `src/pages/Settings.vue`
- Modify: `scripts/verify-task-center.ts`

- [ ] **Step 1: Add failing assertions**

测试整理正常/失败任务和 Settings 验证成功/失败/辅助 `proxyStatus` 悬挂时任务最终状态不被覆盖；确认事件包含开始、结束和错误文本。

- [ ] **Step 2: Implement bridges**

`useOrganize.run` 创建并结束 `organize` 任务；`Settings.verifyHanime` 创建 `hanime-verify` 任务，验证结果先写主任务，再执行辅助网络状态查询，辅助查询异常只写 warning，不改写验证结果。

- [ ] **Step 3: Run full regression**

Run: `npm run verify-task-center; npm run verify-settings-scan; npm run verify-hanime-verification; npm run verify-hentai-e2e; npm run selfcheck; npm run check-modules`
Expected: 全部退出 0。

- [ ] **Step 4: Commit**

按工作区限制处理。

### Task 6: 最终构建与差异检查

**Files:**
- No new production files; inspect all files above.

- [ ] **Step 1: Run production build**

Run: `npm run build`
Expected: Vite renderer/main/preload build succeeds; existing `MediaInfoModule.wasm` runtime URL warning may remain。

- [ ] **Step 2: Check whitespace and changed-file scope**

Run: `git diff --check -- ...` and `git status --short`.
Expected: no whitespace errors; no reset/revert of pre-existing changes; new task-center files are present。

- [ ] **Step 3: Report**

汇报任务中心入口、内存生命周期、日志规则、测试结果和未实现的下载阶段；明确没有打包、重启或修改用户正在运行的程序。
