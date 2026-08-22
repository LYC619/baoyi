# 抱一 · BaoYi

> 知止而后得。
>
> 是以圣人抱一为天下式。——《道德经》第二十二章

本地资源掌控工具。帮你精选、理解、掌握自己的每一个本地数字资源，而非囤积。

**收藏的数量不重要，掌握的数量才重要。**

Obsidian 管理知识笔记，抱一管理一切非文本的本地资源。当前阶段（MVP）覆盖 Windows 软件工具管理。

---

## 功能

| 能力 | 说明 |
|---|---|
| 目录扫描 | 递归遍历指定目录，把每个软件目录整理成一份「待识别清单」。这一步不联网、不花钱、不写入软件条目 |
| AI 自主识别 | 把目录交给 agent 自己探索：它调用工具列目录、读 exe 的 PE 信息、读目录里的 README，判断哪个是主程序、哪些只是加载器，把 32/64 位合并成一个条目再落库。没有硬编码的文件名黑名单和合并规则 |
| 读本地说明 | 绿色软件目录里常带 `README.txt`、`使用说明.txt`、`changelog`，agent 会优先读它们——比联网更快、更准（写的就是这一份程序本身），且零成本。GBK / UTF-8 / UTF-16 自动识别 |
| 联网查证 | 本地实在看不出来时才联网。支持 Tavily / Exa / Firecrawl / Bing / SearXNG，可关闭 |
| 识别日志 | 每跑一次识别留一条完整记录：agent 调了哪些工具、看到了什么、最后怎么判断。识别结果不对时翻这里比猜快，能直接看到它在哪一步走偏 |
| 多启动端 | 一个软件可以挂多个启动端（64 位、32 位、命令行版、加载器等），详情页可逐个启动，也可切换默认启动端 |
| 卡片式展示 | 卡片墙展示图标、名称、一句话说明、分类标签、掌握度、上次使用时间。网格 / 列表双视图。标题用中文名还是官方原名（Process Monitor 这类）打头可在设置里选，另一个降为副标题 |
| 分类与标签 | 侧边栏虚拟分类，不移动任何实际文件。标签系统独立于分类，一个软件可有多个标签 |
| 搜索与筛选 | `Ctrl+K` 全局搜索，中英文模糊匹配名称 / 说明 / 标签 / 文件名。可按分类、标签、掌握度筛选，按最近使用 / 使用最多 / 名称 / 最近添加排序 |
| 快速启动 | 双击卡片启动（以 exe 所在目录为工作目录，兼容绿色软件），自动记录启动时间与次数 |
| 详情页 | 功能说明、为什么选它、使用场景、个人笔记、淘汰的同类、启动端列表与使用统计，全部字段可编辑 |
| 精简提醒 | 超过设定天数（默认 60 天）未启动的软件归入「长期未用」，辅助审视是否仍需保留 |
| 数据自主 | 全部数据存于本机 SQLite，不上传不同步，可一键导出 JSON |

---

## 识别是怎么工作的

抱一不用「拼 prompt → 等模型返回一坨 JSON → 解析入库」那套固定管线。
那套东西一遇到复杂情况（32/64 位要合并、附属程序要剔除）就得靠人往代码里加规则，加不完。

现在换成 agent：给它一个目录和六个工具，让它自己决定怎么看。

```
扫描  →  D:\Tools 拆成若干识别单元（每个子目录一个）
          ↓
识别  →  agent 拿到 D:\Tools\x64dbg
          list_directory  看到 release/ 里有 x32/ 和 x64/
          get_file_info   确认 x64dbg.exe 是 x64、x32dbg.exe 是 x86
          register_software  合并成一条，64 位设为默认启动端，
                             loaddll.exe 作为 kind=extra 的附属启动端挂在同一条下
```

工具集：

| 工具 | 作用 |
|---|---|
| `list_directory` | 列目录。子目录附带内部递归的 exe 数量，说明文档单独列一栏 |
| `get_file_info` | 读 exe 的大小、位数（直接读 PE 头的 machine 字段）、文件描述、公司、版本 |
| `read_text_file` | 读 README / changelog / 使用说明。自动识别 GBK、UTF-8、UTF-16，二进制文件挡下 |
| `register_software` | 注册一个软件条目，含全部启动端 |
| `skip_directory` | 判定为非软件目录，跳过并记录原因 |
| `web_search` | 前面几步都没结论时才联网。配置关闭时不会挂载这个工具 |

**查证顺序是先本地后联网**：PE 信息 → 本地说明文档 → 联网搜索。
本地文档往往比搜索更准——它写的就是这一份程序本身，而搜索结果可能是同名的另一个软件。

判断准则写在 `electron/services/agent/prompts.ts` 的 system prompt 里，不在代码里 ——
想调整识别行为改那份提示词即可。

几条护栏在代码里：单个目录最多 14 轮工具调用；同参数重复调用第 3 次后拦下；
所有路径参数强制限制在本次负责的那棵子树内（`agent/paths.ts`）。

每次识别的全过程都落进 `identify_logs` 表，在**设置 → 识别日志**里按轮次摊开看：
哪一轮调了什么工具、返回了什么、模型说了什么、为什么停（想清楚了收尾，还是撞上 14 轮上限）。
调 prompt 时对着日志改，比对着「未注册任何条目」这一句结论猜要快得多。
只保留最近 300 条，「清空识别数据」不动它 —— 留着和改 prompt 之前那一轮对照。

需要一个**支持 function calling** 的模型，deepseek-chat 够用。
设置页的「测试连接」会真的发一次工具调用来验证，而不只是验证能不能连通。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 37 |
| 前端框架 | Vue 3 + Composition API |
| 构建工具 | Vite 5 + vite-plugin-electron |
| 语言 | TypeScript |
| 状态管理 | Pinia |
| 样式方案 | SCSS + CSS Variables（主题切换） |
| 数据库 | better-sqlite3 |
| AI 调用 | fetch，OpenAI 兼容的 tool calling（agent loop 结构参考 [pi](https://github.com/earendil-works/pi)） |
| 网络搜索 | Tavily / Exa / Firecrawl / Bing / SearXNG，统一适配层 |
| 图标提取 | Electron `app.getFileIcon()` |
| PE 信息 | resedit（版本资源）+ 直接读 PE 头（位数） |
| 图标库 | Lucide Icons |
| 打包 | electron-builder |

---

## 开发

```bash
npm install          # 装依赖（postinstall 会自动为 Electron 重建 better-sqlite3）
npm run dev          # 启动开发环境（Vite + Electron 热更新）
npm run typecheck    # 类型检查
npm run selfcheck    # agent 回路、路径沙箱、日志与标题规则自检（不需要 API Key，不需要 Electron）
npm run inspect      # 命令行查看库里的识别结果，调 prompt 时用来核对合并对不对
npm run build        # 类型检查 + 构建产物
npm run dist         # 打包为 Windows 安装包（输出到 release/）
npm run dist:dir     # 只产出免安装目录，跳过 NSIS 打包
```

`better-sqlite3` 是原生模块。若 `npm install` 后启动报 ABI 不匹配，单独跑一次：

```bash
npm run rebuild
```

项目根目录的 `.npmrc` 把 Electron 运行时和 better-sqlite3 预编译产物的下载指向 npmmirror 镜像 ——
这两样都托管在 GitHub Releases，国内直连经常超时，超时后会退回本地编译，
而本地编译需要装了 Windows SDK 的 MSVC。网络通畅时可以直接删掉 `.npmrc`。

---

## 目录结构

```
baoyi/
├── electron/
│   ├── main.ts                 # 主进程入口：窗口、baoyi:// 图标协议、单实例锁
│   ├── preload.ts              # contextBridge 暴露 window.baoyi
│   ├── services/
│   │   ├── agent/
│   │   │   ├── loop.ts         # tool-calling 循环：轮数上限、重复调用检测、可中断
│   │   │   ├── tools.ts        # 六个工具的实现
│   │   │   ├── files.ts        # 说明文档读取与编码识别（GBK / UTF-8 / UTF-16）
│   │   │   ├── paths.ts        # 路径信任边界
│   │   │   └── prompts.ts      # 识别准则 —— 合并/过滤规则都写在这里，不在代码里
│   │   ├── scanner.ts          # 目录遍历，产出识别单元（不做识别判断）
│   │   ├── searchService.ts    # 各家搜索 API 的统一适配与缓存
│   │   ├── iconExtractor.ts    # 图标提取落盘
│   │   ├── peReader.ts         # PE 版本资源与位数读取
│   │   ├── aiService.ts        # agent 编排：并发跑单元、进度汇总、取消
│   │   ├── database.ts         # SQLite Schema 与全部读写
│   │   └── launcher.ts         # 启动软件（按启动端）与使用记录
│   └── ipc/handlers.ts         # 全部 IPC 通道
├── scripts/
│   ├── agent-selfcheck.ts      # npm run selfcheck：agent 回路 / 路径沙箱 / 文档编码
│   └── inspect-db.cjs          # npm run inspect：命令行查看识别结果
├── src/
│   ├── components/             # AppCard / CardGrid / Sidebar / SearchBar / IdentifyLog / MasteryDots …
│   ├── pages/                  # Onboarding / Home / Detail / Settings（左侧 Tab：扫描与识别 / AI 配置 / 搜索服务 / 外观 / 识别日志 / 数据管理）
│   ├── stores/                 # software / categories / settings
│   ├── composables/            # useSearch / useFilter / useAI / useScan / useToast
│   ├── styles/                 # variables / global / transitions
│   ├── types/                  # 主进程与渲染进程共享的类型
│   └── utils/
├── resources/                  # 应用图标等打包资源
└── electron-builder.yml
```

---

## 数据位置

| 内容 | 路径 |
|---|---|
| 数据库 | `%APPDATA%\抱一\baoyi.db` |
| 提取的图标 | `%APPDATA%\抱一\icons\` |

目录名取自 `package.json` 的 `productName`，所以是中文的「抱一」而不是 `baoyi`。
同目录下的 `Cache` / `GPUCache` / `Local Storage` 等是 Electron 自己的运行时数据，与抱一无关。

设置（含 API Key）存在数据库的 `settings` 表里，明文保存，仅本机可读。

设置页底部有两个重置入口，两者都只清抱一自己的记录，**不会删除磁盘上的任何实际软件文件**：

| 操作 | 清掉 | 保留 |
|---|---|---|
| 清空识别数据 | 软件条目、待识别目录、图标缓存 | API Key、搜索配置、扫描目录、自定义分类、识别日志 |
| 恢复出厂 | 上面的一切 + 设置 + 自定义分类 + 识别日志 | 无，会重走引导流程 |

反复调 prompt 试识别效果时用第一个，省得每次重填 Key，识别日志也留着好和上一轮对照。

---

## 设计规范

克制、干净、工具感。参考 Obsidian / Linear / Raycast 的设计语言，避免游戏化元素与花哨动效。

深色主题为默认：主背景 `#1E1E2E`，侧边栏 `#181825`，卡片 `#2A2A3C`，强调色 `#7C6AF6`。
卡片圆角 12px，内边距 16px，间距 16px，侧边栏宽 200px。
卡片悬浮上移 2px（150ms），页面切换淡入淡出（200ms），卡片依次淡入（间隔 30ms）。

---

## 路线

| 阶段 | 内容 |
|---|---|
| **MVP（当前）** | 软件工具管理：扫描 + agent 自主识别 + 卡片墙 + 启动 |
| 1.1 | 软链接接管（非绿色软件归拢） |
| 1.2 | 数据导入导出（JSON / Markdown） |
| 2.0 | 游戏资源管理模块 |
| 3.0 | 视频 / 电影本地管理模块 |
| 4.0 | 漫画 / 书籍管理模块 |
| 5.0 | 资源间关联（双链逻辑） |

---

## 已知边界

- 仅支持 Windows 的 PE 版本信息读取；其他平台会跳过该步骤，只靠文件名与 AI 识别。
- 图标经由 `app.getFileIcon()` 取得，Windows 上为 32×32，放大到卡片的 48px 会略糊。
- 超过 128MB 的 exe 跳过 PE 资源解析（需整文件读入内存）。
- 目录遍历深度上限 8 层，单个识别单元最多统计 2000 个 exe。
- 识别依赖模型支持 function calling。不支持的模型会在「测试连接」时被明确指出，而不是在扫描时静默失败。
- 识别单元的粒度是「扫描根的直接子目录」。如果你把 `D:\Tools\x64dbg` 本身设为扫描根，
  agent 拿到的就是它的子目录，合并 32/64 位的效果会不如把 `D:\Tools` 设为扫描根。
- `read_text_file` 单次最多读 256KB、回灌 4000 字符，只读说明类文件（扩展名白名单 + 无扩展名的
  README/LICENSE 类命名），含 NUL 字节的一律当二进制挡下。GBK 解码依赖运行时的 ICU 码表，
  Electron 自带完整 ICU，正常不会缺。
- 「不额外联网」选项的字面含义就是不联网：抱一不会替模型注入任何搜索工具，
  agent 只用模型自身知识判断。真正的联网能力来自另外五家搜索 API。
- 重跑一个已识别的目录时，上一轮留下、这一轮没再确认、你也没写过备注的条目会被清掉；
  写过备注、用过、归档过、调过熟练度的条目一律保留。
