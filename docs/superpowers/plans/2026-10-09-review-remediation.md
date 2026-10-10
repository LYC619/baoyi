# 代码与前端体验审查整改总方案

> **For agentic workers:** 使用 `executing-plans` 技能按工作包串行执行，并用下方复选框记录进度。项目 AGENTS.md 明确要求默认不创建子代理。用户计划在新会话执行；本文件编写阶段只制定方案，未实施修复。

**Goal:** 修复两轮审查确认的 2 项 P1、4 项 P2 问题，消除重复界面层级，让五库的浏览和批量操作在小窗口中保持可用。

**Architecture:** 延续 Electron 主进程、Vue 页面和 Pinia store 的现有分工。详情使用请求归属和明确加载状态；批量操作绑定已成功加载的查询；项目导入与模型分析分离；界面统一信息层级，保留各模块的专属行为。

**Tech Stack:** Electron 37、Vue 3、Pinia、TypeScript、SQLite、现有 Node 验证脚本与 Electron/Playwright 界面检查。

**基准:** 2026-10-09，版本 0.15.0；当时 HEAD 为 `efedf66`，但审查基于包含大量未提交修改的实际工作区，不能用该提交替代审查版本。

**执行状态（2026-10-09）：** E0—E7 已在原工作区串行完成，无新增子代理；专项、构建和 34 项隔离 UI 检查通过，自检 634/0。详见 [整改验收报告](../../verification/2026-10-09-review-remediation.md) 与 [执行记录](../../../.planning/review-remediation-20261009/progress.md)。本轮未提交、推送或发布。

---

## 一、执行入口与范围

工作目录：[抱一](D:/8.Project/0_0_维护/抱一)。先阅读以下文件：

- [项目协作约定](D:/8.Project/0_0_维护/抱一/AGENTS.md)
- [代码与使用体验报告](D:/8.Project/0_0_维护/抱一/docs/verification/2026-10-08-code-ux-review.md)
- [前端专项报告](D:/8.Project/0_0_维护/抱一/docs/verification/2026-10-09-frontend-layout-review.md)
- [已完成的审查记录](D:/8.Project/0_0_维护/抱一/.planning/review-20261008/progress.md)

本次范围是审查发现的正确性、等待体验和界面空间问题。保留现有主题、五库能力、数据格式和文件操作语义；只整理本次触及的过长单行代码，不进行全仓格式化、框架重写或资源库迁移。审查中未证实的项目路径/junction 猜测不作为已确认缺陷处理。

**已经确定的方案选择：**

1. 先修复错误操作对象，再优化界面；保留操作期间的必要锁定。
2. 项目导入只完成本地登记及登记记录。AI 补全改为导入后从已有“让助手了解项目”入口主动启动，沿用停止、重试及应用建议流程。**这会取消导入时的自动模型调用**，是本方案明确的行为调整。
3. 本轮不新建自动 AI 批量后台队列。现有 `initialize()` 同时负责登记与远程分析，且整个过程持有项目操作锁；拆开它比扩大后台调度、数据库生命周期和锁设计更适合本次整改。
4. 软件批量入口放到现有工具栏；批量模式以紧凑选择栏为基础，必要表单和错误信息按状态展开。
5. 工具收纳通过“视图”和“更多”完成；保留可读字号和操作目标，不用整体缩放掩盖排版问题。

## 二、工作区与证据保护

- [x] **E0. 记录开始状态。** 保存 `git status --short`、`git diff --stat` 和涉及文件的当前差异到新的执行记录。建立 `.planning/review-remediation-20261009/` 下的 `task_plan.md`、`findings.md`、`progress.md`。
- [x] 确认新会话仍在同一工作目录。默认直接在当前工作区执行；新建 worktree 不会包含现有未提交修改，不能直接从 HEAD 开始修复。
- [x] 按工作包编辑和验证。不得使用 `reset --hard`、`clean -fd` 或整文件回退清理旧改动；不要用 `git add .` 混入用户已有工作。本方案不要求提交、推送或打包发布。
- [x] 所有动态验证新建独立 `--user-data-dir`，使用合成文件、临时数据库和本地模拟模型，不读取真实 AppData 资料库、不启动合成 EXE。
- [x] 先检查 `rtk` 是否可用；不可用时直接运行原命令。审查时 `rtk` 不可用。PowerShell 命令按顺序执行，避免启动并行测试应用。

原始复现脚本和截图在 `output/review-20261008/`，属于 Git 忽略目录。可以作为测试素材，但新验证结果写到 `output/review-remediation-20261009/`，保留旧证据用于前后对照。若旧目录缺失，根据报告中的复现场景重新建立夹具即可，不依赖聊天历史。

## 三、交付顺序和覆盖关系

| 工作包 | 覆盖的问题 | 完成结果 | 前置 |
|---|---|---|---|
| E1 | P1 图片旧响应覆盖；P2 加载误报不可用 | 详情、页面和操作目标始终属于同一资源 | E0 |
| E2 | P1 影视查询未就绪时提交旧选择 | 搜索、防抖、失败期间无法批量提交旧范围 | E0 |
| E3 | P2 项目导入等待 AI 无法退出 | 本地登记不等待网络，后续助手可停止/重试 | E1、E2 |
| E4 | 软件独立批量行；P2 照片分组空白；P2 列表图标遮字 | 直接修复三个局部前端问题 | E1、E2 |
| E5 | 五库批量模式过度占用高度 | 紧凑选择栏与按需操作表单 | E2、E4 |
| E6 | 游戏/影视工具堆叠；图片/项目重复标题统计行 | 浏览区空间增加，功能入口仍可发现 | E5 |
| E7 | 综合回归与文档 | 可复查的修复结果、截图及剩余限制 | E1—E6 |

每个工作包完成定向检查并更新进度后，继续下一个。发现当前代码已修复某问题时，先运行相应验收，再记录“已由现有改动满足”，不要重复修改。一个用例失败时只扩大与失败相关的调查范围。

## 四、E1：图片详情的请求与操作归属

**主要文件：**

- 修改 [图片详情](D:/8.Project/0_0_维护/抱一/src/pages/image/Detail.vue)。
- 复用 [请求轮次工具](D:/8.Project/0_0_维护/抱一/src/utils/index.ts) 的 `createLatestGuard`，或页面内部的递增请求号。
- 新建 `scripts/verify-review-boundaries.ts`，复用 [实际 renderer 加载器](D:/8.Project/0_0_维护/抱一/scripts/helpers/renderer-harness.ts)。
- 参考旧复现 `output/review-20261008/repro-boundaries.ts`、`review-ui.ts`。旧脚本断言的是缺陷存在，不能把它原样通过当作修复通过。

- [x] 先补失败用例：延迟 A、切到 B、B 完成后释放 A，确认当前实现会混合状态；测试加载实际 SFC，不另外复制一份加载算法当作被测对象。
- [x] 为详情设置 `loading / ready / missing / error` 状态。请求开始固定 `id` 和轮次，所有 await 都使用该 ID；条目与页面读取完成后统一提交，旧请求的成功、异常及 finally 均不能影响新请求。
- [x] 切换 ID 时重置章节、封面选择、预览上限及错误信息；卸载时使未完成请求失效。`read=1` 自动打开也必须属于当前成功请求。
- [x] 保存、移动、移除、重扫、重新定位在入口处检查显示对象与路由 ID 一致，然后固定目标 ID；await 后重新校验归属，防止旧操作响应回写新页面或把新页面导航走。
- [x] 保留重新扫描/重新定位在适用的失效状态下的恢复能力；加载中禁用依赖详情的操作。读取失败显示可重试提示，读取完成确实为空才显示“资源不可用”。
- [x] 将本次触及的 `load/patch/rescan/remove/move` 展开为可读函数，避免继续把校验与多次 await 压在同一行。

实现应满足以下状态约束；这是验收关系，不要求新增公共框架：

```ts
// 各操作共享的含义：加载成功，且显示对象仍属于当前路由。
const currentReady = computed(() =>
  !loading.value && item.value !== null && item.value.id === props.id
)
// 每次请求保存 requestId、requestEpoch；只在二者都仍有效时提交结果。
// 每次写操作在第一次 await 之前保存 targetId；后续不得重新取 props.id 当目标。
```

**验收：** A 慢 B 快、A 失败 B 成功、A/B/A 快速切换、页面卸载、正常慢加载、确实不存在、读取失败后重试、保存期间切路由、`read=1` 自动阅读。任何场景不得出现 `item=A/pages=B`；编辑 B 只更新 B。加载中不显示资源丢失文案。

**命令：** `node --experimental-strip-types --no-warnings scripts/verify-review-boundaries.ts`。预期退出码 0，所有资源归属断言通过。

## 五、E2：影视批量操作绑定成功查询

**主要文件：**

- 修改 [影视 store](D:/8.Project/0_0_维护/抱一/src/stores/video.ts)、[影视首页](D:/8.Project/0_0_维护/抱一/src/pages/video/Home.vue)、[影视批量面板](D:/8.Project/0_0_维护/抱一/src/components/video/VideoBulkPanel.vue)。
- 扩展 [查询边界验证](D:/8.Project/0_0_维护/抱一/scripts/verify-library-query.ts)，必要时扩展 [选择验证](D:/8.Project/0_0_维护/抱一/scripts/verify-library-selection.ts)。
- 复用软件/游戏查询签名的约定；影视已经有请求合并循环，保留其合并突发请求和轮次控制。

- [x] 先将影视加入查询边界用例，覆盖输入已改变但防抖请求尚未发出的时间窗。
- [x] 从真实 `buildQuery()` 生成当前签名；发请求时固定查询快照，只有当前有效请求成功才能记录已加载签名。
- [x] 暴露 `queryPending`；其含义包括请求中、当前签名与成功签名不同、当前刷新失败且尚未恢复。失败时可保留旧卡片供查看，但不能解除批量锁定。
- [x] 在输入/筛选范围变化时撤销危险操作确认和 Shift 连选锚点，清空旧选择；新结果到达后仍将选择限制在可见 ID 内。
- [x] 全选、单项勾选、Shift 连选、加/移除标签、分组、创建合集、复查所选及相关移动入口统一检查查询就绪。按入口实际接收的 ID 核对，不仅禁用主按钮。
- [x] 表单按钮与处理函数都检查 `pending`；提交前固定 IDs 与参数，处理中保持批次不变。保留部分失败只重试失败项的机制。
- [x] 查询失败时提供明确“刷新结果”，恢复成功后再允许选择与提交；查询 pending 本身不应剥夺清空选择/退出模式的能力，写操作 busy 的既有保护保留。

关键状态公式：

```ts
const loadedQuery = ref<string | null>(null)
const loadFailed = ref(false)
const queryPending = computed(() =>
  loading.value || loadFailed.value || loadedQuery.value !== JSON.stringify(buildQuery())
)
// 在 load 的合并循环内固定 query；成功提交 items 时一并提交 JSON.stringify(query)。
// 每次有效请求的失败/成功分别设置 loadFailed，旧轮次不得改写它。
```

**验收：** 先选 A+B，再搜索仅匹配 B；防抖、等待、失败三个阶段调用批量处理都不得写入 A 或 B。成功加载 B 后只能选择并更新 B。另覆盖分类、标签、收藏分组、音频/影视切换、可见性变化，以及同一查询的刷新失败。锁定既要经实际点击验证，也要经直接调用处理函数验证。

**命令：** `npm run verify-library-query`、`npm run verify-library-selection`。预期软件、游戏既有用例及影视新增用例均通过。真实 IPC/测试数据库的 A/B 写入结果在 E7 的 UI 脚本复核。

## 六、E3：项目先登记，再主动分析

**主要文件：**

- 修改 [项目 IPC](D:/8.Project/0_0_维护/抱一/electron/ipc/project.ts)、[项目助手服务](D:/8.Project/0_0_维护/抱一/electron/kinds/project/agent.ts)。
- 修改 [项目导入](D:/8.Project/0_0_维护/抱一/src/components/project/ProjectImport.vue)、[项目工作台](D:/8.Project/0_0_维护/抱一/src/components/project/ProjectWorkbench.vue)。
- 扩展 [项目助手验证](D:/8.Project/0_0_维护/抱一/scripts/verify-project-agent.ts)。复核 [项目 API 类型](D:/8.Project/0_0_维护/抱一/src/types/project.ts) 和 [项目操作锁](D:/8.Project/0_0_维护/抱一/electron/kinds/project/activity.ts)。

**交互决定：** 导入成功即出现可用项目并关闭导入流程；提示“本地登记已完成，可在项目助手中补全资料”。新项目保留“导入登记”会话。用户点“让助手了解项目”后开始模型请求，可停止；建议按现有“应用”流程写入。模型失败不改变导入成功状态。

- [x] 新增行为测试：即使 AI 配置有效、模拟模型永不返回，确认导入也完成，模型调用计数为 0，项目和登记会话均已持久化。
- [x] 将现有 `initialize(projectId)` 拆出纯本地的 `recordImport(projectId): ProjectSession`。它复用已有登记记录或创建“导入登记”会话，只保存本地名称、依据和入口数量；不调用 `send()`。
- [x] `confirm-import` 对新项目调用 `recordImport`，逐项统计本地成功/失败并发布 changed；删除其等待模型及自动套用模型建议的路径。保留候选 token、合并、重复导入、人工名称/分类/来源/状态保护。
- [x] 替换“已配置 AI 时会自动读取说明并补全资料”的等待文案。扫描与本地登记期间保留短期 busy 防重复提交，不修改通用 `ProjectDialog` 的 busy 规则去影响其他模态操作。
- [x] 在 ProjectWorkbench 清楚显示“已登记，可分析”；沿用现有发送/停止/应用能力。重试使用已有会话，不因重试创建重复项目。分析停止后的记录可再次进入查看。
- [x] 不将远程分析从当前锁中简单移到一个无人跟踪的 Promise。此方案取消导入内的模型请求，手动助手的文件操作锁和备份恢复保护沿用原实现。

**验收：** AI 开/关均能登记；导入本身不向模型发请求；重复导入不重复登记会话、不覆盖人工状态；关联到已有项目仍只合并入口；部分本地失败显示具体条目；后续手动分析可停止、失败可重试、应用旧建议仍校验项目是否变化。

**命令：** `node --experimental-strip-types --no-warnings scripts/verify-project-agent.ts`、`node --experimental-strip-types --no-warnings scripts/verify-project.ts`。另在 E7 用本地延迟 HTTP 模型验证“导入完成 → 手动分析 → 停止”的界面流程。

## 七、E4：三项局部前端修正

### E4.1 软件批量入口

文件：[软件首页](D:/8.Project/0_0_维护/抱一/src/pages/software/Home.vue)。

- [x] 将“批量管理”按钮移入 `.toolbar__actions`，放在“新增”之前；删除普通浏览状态下独立的 `.management-entry` 容器和专用 padding。
- [x] 保留原 disabled 条件、批量事件及退出逻辑。进入模式后由选择栏提供退出入口，避免又出现第二个独占行。
- [x] 复核 960×640、1280×820，工具栏不因移动按钮增高，搜索仍可输入。使用同一夹具，首卡 Y 应从 186 降至约 142（允许 2 px 舍入差），内容区增加约 44 px。

参考：[已测量的临时排布对比](D:/8.Project/0_0_维护/抱一/output/review-20261008/frontend/software-inline-comparison.png)。这项只需定向 UI 验证，不为 DOM 位置编写静态源码字符串测试。

### E4.2 照片有效分组

文件：[图片首页](D:/8.Project/0_0_维护/抱一/src/pages/image/Home.vue)，保留 [视图偏好](D:/8.Project/0_0_维护/抱一/src/composables/useLibraryView.ts) 的现有存储键。

- [x] 增加页面级有效分组 computed，选择框与 ImageShelf 都绑定它；删除只在书架 props 上单独映射的表达式。

```ts
const effectiveGrouping = computed({
  get: () => store.query.type === 'photo' && grouping.value === 'category'
    ? 'directory' : grouping.value,
  set: value => { grouping.value = value }
})
```

- [x] 保持现有默认语义：漫画 category、照片在该偏好下显示 directory；用户主动选择 none/directory 仍保存到既有视图偏好。无需迁移数据或新建两套设置。
- [x] 验收首次打开、漫画 category→照片→漫画、照片选择 none 后切换/刷新、损坏 localStorage 回退。选择框始终有选中文字，且与实际分组一致。

### E4.3 软件列表右侧操作列

文件：[软件卡片](D:/8.Project/0_0_维护/抱一/src/components/software/AppCard.vue)。

- [x] 为普通列表的叶子图标/启动按钮预留约 36 px 右侧空间（以实际按钮宽度及边距验证）；限制在 list 模式，不挤压网格卡片。
- [x] 列表标题仍可截断，摘要允许收缩；批量模式无叶子/启动按钮时不要保留无意义操作空位。
- [x] 覆盖短/长标题、多标签、不同使用状态、鼠标悬浮和键盘焦点。文字 Range 与图标/按钮 rect 的交集面积应为 0；不能只靠图标淡出遮住问题。

E4 的三项统一纳入 E7 的 Electron 脚本，保留前后截图。布局修复无需新增与 CSS 实现一一对应的单元测试。

## 八、E5：统一批量模式的空间分配

**主要文件：** [公共批量面板](D:/8.Project/0_0_维护/抱一/src/components/library/LibraryBulkPanel.vue)、[影视批量面板](D:/8.Project/0_0_维护/抱一/src/components/video/VideoBulkPanel.vue)、[图片批量面板](D:/8.Project/0_0_维护/抱一/src/components/image/ImageBulkPanel.vue)、[图片书架](D:/8.Project/0_0_维护/抱一/src/components/image/ImageShelf.vue)，以及五库 Home 接入处。

使用下列统一状态约定，保留图片/影视的专属命令，不把五库强行重写成一个巨型组件：

| 状态 | 常驻内容 | 按需内容 |
|---|---|---|
| 未选中 | 已选 0、全选当前结果、退出；简短范围提示 | 不展开完整参数表单 |
| 已选中 | 已选数量、全选、清空、退出 | 操作选择 + 当前操作参数 + 执行按钮，一至两行 |
| 查询未就绪 | 保留选择状态，显示刷新/等待信息 | 禁止提交；允许非写入状态下退出 |
| 正在执行 | 操作名、数量与进度 | 维持原固定批次和防重复提交约束 |
| 需要确认 | 操作对象与数量、确认/取消 | 保留原文件保留/删除语义 |
| 部分失败 | 成功/失败数量、失败项选择、重试 | 可展开失败详情，不能仅依赖消失的 toast |

- [x] 先收紧公共面板的选择 header；零选择且无执行结果时折叠表单，消除三层固定占位。修改分类等表单控件仍保留可访问名称。
- [x] 选中资源后显示当前操作所需的参数；可将可视标签与控件排在同行，避免每个标签再占一行。操作切换和选择变化仍撤销旧确认。
- [x] 图片和影视采用相同层级，合并散落在 summary、shelf-controls、表单之间的重复选择信息；保留各自分页范围、Shift 连选、标签追加等原有含义。
- [x] 结果/失败信息出现时允许面板变高或展开详情；不要为了高度指标隐藏失败、危险操作说明及查询锁定提示。
- [x] 切换筛选、退出模式、返回首页、部分失败重试后，核对选择和焦点；输入框 Ctrl+A 仍是文本全选，页面 Ctrl+A 才是当前结果全选，Esc 遵守写入保护。

**设计目标（同一夹具、默认字号、960×640）：** 零选择的批量区域尽量控制在 64 px 内；普通已选择表单尽量在 110 px 内。错误和确认态不套用高度上限。最终以游戏首排至少可看到名称、影视首排可看到名称及关键本地状态、勾选时无需反复上下找操作区为验收，必要时结合 E6 一起达到。

**回归命令：** `npm run verify-library-selection`。新增 UI 检查覆盖五库零选中、单选、多选、处理中、部分失败，不只截零选中状态。

## 九、E6：收紧各库工具栏和信息行

布局保持共同次序：“标题/数量、搜索、主操作”在主要工具区；视图选项和低频维护命令收纳；资源区从其下方直接开始。菜单需要键盘可达、Esc 关闭、关闭后焦点回触发按钮，不能依赖 hover 才能操作。

| 页面与修改文件 | 具体调整 | 保留的能力与验收 |
|---|---|---|
| [游戏 Home](D:/8.Project/0_0_维护/抱一/src/pages/game/Home.vue) | 分组和卡片大小收进“视图”；补齐封面收进“更多”；添加与批量保留可见，扫描作为明确的添加/更多选项 | 960 宽普通工具栏从三行收至不超过两行；排序、扫描、补封面及原禁用状态仍可到达 |
| [影视 Home](D:/8.Project/0_0_维护/抱一/src/pages/video/Home.vue) | 合并“扫描本地”/“导入目录”，保留调用统一 `videoImport.begin()` 的入口；补海报、Agent 整理、统一移动收纳到“更多”；尺寸/布局收进“视图” | 音频范围继续显示“导入音频”，影视目录和资源包仍可导入；“找视频”、筛选及导入待确认提示保留 |
| [图片 Home](D:/8.Project/0_0_维护/抱一/src/pages/image/Home.vue) 与 [ImageShelf](D:/8.Project/0_0_维护/抱一/src/components/image/ImageShelf.vue) | 图片数量和批量入口放在一个有效内容标题行；无“继续阅读”等区块时去掉“我的相册/相册”重复标题；将分页和选择栏统筹排布 | 有“继续阅读”时保留区块标题语义；不改变相册/漫画分组、分页、导入来源和收藏筛选 |
| [项目 Home](D:/8.Project/0_0_维护/抱一/src/pages/project/Home.vue) 与 [project.css](D:/8.Project/0_0_维护/抱一/src/styles/project.css) | 数量并入主标题；去掉独立 result-count 行的上下间距；缩短引导语占用，压缩标题到搜索区的间隔 | 添加、搜索、来源/状态筛选、刷新、置顶和项目入口均保留；卡片内容不因追求高度而删减 |

- [x] 按表格逐库调整，每改一库用 960×640 检查菜单、搜索和进入批量；通过后再改下一库。
- [x] 仅在确有重复菜单交互时提取小型展示组件，优先复用仓库已有做法；不引入新 UI 组件库或修改全局字号比例。
- [x] 检查深色与浅色、默认与最大卡片尺寸、列表与网格、普通与批量模式。用户设置导致卡片变大时，不要求完整卡片数量与默认尺寸相同。
- [x] 记录各库首张卡片 Y、操作区高度、可见关键字段；图片目录样本稀疏不能据此判定网格只能显示一列。

**量化参照：** 原软件/游戏/影视/图片/项目在 960×640 普通模式首卡 Y 分别为 `186 / 226 / 217 / 298 / 237.5`；批量为 `306.2 / 390.2 / 344 / 454 / 407.7`。软件应达到 E4 的 44 px 收益；其余页面普通状态不得比基准更占高度，图片和项目以至少释放一行约 36 px 为设计目标。记录实测值，不用“控件未越界”替代空间和可读性验收。

## 十、E7：整体验收与交接

### 固化测试与运行顺序

- [x] 新建 `scripts/verify-review-ux-ui.ts`，使用旧审查脚本的独立 profile/合成数据方法，但改成修复后的断言；同时覆盖 E1/E2 的真实 IPC 写入、E3 的本地模拟模型和 E4—E6 布局。
- [x] 测试启动后断言 `app.getPath('userData')` 等于测试路径。所有 Electron、本地 HTTP 服务和文件句柄在 finally 中关闭。递归清理之前校验目标位于该次临时目录内。
- [x] 截图等待 Vue 更新、页面过渡和实际绘制完成；审查时直接 capture 曾得到旧帧，不能只相信截图文件存在。使用 `showInactive()` 和绘制等待后捕获，不抢用户焦点。
- [x] 不强依赖审查机器的 Playwright 绝对安装路径；执行时先确认当前依赖位置，并允许通过环境变量指定。不因 UI 脚本运行需要改产品依赖版本。

从仓库根目录顺序运行（文件已在相应工作包创建后）：

```powershell
npm run typecheck
npm run verify-library-query
npm run verify-library-selection
node --experimental-strip-types --no-warnings scripts/verify-review-boundaries.ts
node --experimental-strip-types --no-warnings scripts/verify-project-agent.ts
node --experimental-strip-types --no-warnings scripts/verify-project.ts
npm run selfcheck
npm run check-modules
npm run build
node --experimental-strip-types --no-warnings scripts/verify-review-ux-ui.ts
```

类型检查、脚本和构建预期退出码均为 0；自检不得出现失败，审查基线为 634 通过。新增用例后以断言完整性和零失败为准，不硬编码总数。原有 MediaInfo WASM URL 构建提示单独记录，不把旧提示误认成此次回归，也不掩盖新增错误。UI 必须使用刚构建的产物。

检查通过后不无理由重跑全部专项。若改动触及公共图片阅读或任务持久化等额外边界，才补对应脚本，并在执行记录解释原因。

### 最终验收清单

- [x] 2 项 P1：旧详情不污染新对象；旧查询选择不能写入。
- [x] 4 项 P2：导入不等模型；加载不误报不可用；照片分组有有效选项；软件列表文字无遮挡。
- [x] 五库在两种尺寸、深浅主题下的普通/批量/失败状态均可操作；关键按钮无横向越界，菜单焦点行为正确。
- [x] 软件独立行消失且回收约 44 px；其他页面提供真实前后测量和截图，不宣称必然多出整排卡片。
- [x] AI 手动分析的停止、重试及应用建议正常；本地导入和项目人工资料不受模型失败影响。
- [x] 所有测试仅使用隔离资料，测试进程已关闭；无真实资源移动、删除或模型调用。
- [x] 输出 `docs/verification/2026-10-09-review-remediation.md`（若跨日执行，文件日期使用实际验收日），逐项对应 E1—E6 的改动、命令、结果、证据及未覆盖范围。
- [x] 在现有文档目录索引中添加验收入口；只有需要记录用户行为变化时更新对应说明，不冒充发布新版本。
- [x] 核对最终 diff 未夹入无关改动；在 `.planning/review-remediation-20261009/progress.md` 写明完成项、仍待做项、测试证据和下次继续位置。

## 十一、新会话启动文本

复制下面这段到本项目的新会话即可开始执行：

> 请执行 `D:\8.Project\0_0_维护\抱一\docs\superpowers\plans\2026-10-09-review-remediation.md`，先读方案和两份审查报告，再按 E0—E7 串行实施和验证。方案中的“本地导入不等待 AI，后续从项目助手主动分析”按既定设计落实。遵守 AGENTS.md，不新增子代理，保留当前所有已有未提交改动；不要从干净 HEAD 代替当前工作区。所有动态测试使用独立资料库及合成数据。每个工作包通过定向验收后继续下一包，更新执行记录，完成后交付验收报告和前后截图。本次授权实施及验证，不要求提交、推送或发布。
