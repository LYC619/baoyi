# 抱一 · BaoYi

> 知止而后得。

本地资源掌控工具。资源库管“物”，项目记录“事”，个人入口管理“我”；资料、摘录、项目与技能相互引用。

## 0.19.1 · 2026-11-07

[下载 Windows x64 版本](https://github.com/LYC619/baoyi/releases/tag/v0.19.1) · [版本说明](docs/releases/0.19.1.md)

下载 `BaoYi-0.19.1-windows-x64.zip`，解压完整目录后启动 `抱一.exe`。请保留全部 DLL 与 resources 文件；标准版使用 AppData 资料库。升级前备份资料库，退出旧版后再启动新版。程序未进行代码签名。

本版包含项目便签与托管启动、资料精读、视频悬停预览、全局音频和哔咔/JM 漫画中心，以及 18 项交互与状态修订。在线来源需要相应账号与网络条件，AI 功能需要配置模型服务。

## 功能


| 模块 | 已有能力 |
|---|---|
| 个人 | 总览、技能实践与自评、背包费用与到期、状态指标和趋势、奖项与经历、轻量待办；关联项目与凭证 |
| 软件 | 目录扫描、AI 识别、多启动端、分类标签、批量管理、使用记录、目录整理 |
| 游戏 | 游戏识别与资料、启动管理、批量管理、存档位置及备份 |
| 影视 | 本地扫描、课程合集、分集资料、海报、整理预览、下载任务、音频播放；内嵌试看、250ms 悬停代表帧、时间滑块与接触表 |
| 图片 / 漫画 | Pica 与 JM 来源、选章下载、代理选择、暂停续传、补章与恢复核验；缩放阅读、书签、进度、批量整理、选页封面和照片 EXIF |
| 资料 | 文件/目录预览导入、PDF/Markdown/TXT 阅读、书签摘录与引用；精读结论、原文证据、覆盖范围、人工修订、版本与建议采用撤销 |
| 项目 | 当前情况/下一步/关键 Prompt 自动保存，规则链接、Git 状态、多入口与编辑器；托管启动/停止、动态端口、上次命令重跑、限定范围的交接 Prompt |
| 归档助理 | 全局对话、资源与正文查询、来源引用、分类保存与撤销、文件核验整理、记忆、方法及任务续接 |
| 公共能力 | 本地 SQLite、设置、代理、后台任务、资料库与助手备份恢复、升级前快照 |

AI 识别需要用户配置支持工具调用的模型服务；在线来源受账号权限、代理、网络和站点可用性影响。
项目 AI 日志自动保存并标记来源，可编辑和撤销；应用运行时可监测新提交。没有配置时仍可手写和生成事实草稿。Office/EPUB 调用外部应用；PDF 不含 OCR 或文字重排。
归档助理嵌入 Hermes v0.22.7 原版 Python 内核，其他参考项目的使用方式见相关模块文档与第三方声明。

## 开发


技术栈：Electron 44、Vue 3、TypeScript、Vite 8、Pinia、SQLite。开发环境需要 Node.js 22.12 或更高版本。

```powershell
npm install
npm run dev
npm run typecheck
npm run verify:core
npm run verify-native-runtime
npm run prepare:hermes
npm run dist:dir
```

`prepare:hermes` 首次需要开发机 Python 与联网，按固定摘要获取原版 Hermes、独立 Python 和锁定依赖。漫画组件用 `python -X utf8 scripts/prepare-comic-runtime.py` 单独准备，固定 jmcomic 2.7.11，不安装进 Hermes 依赖目录；`check:hermes` 同时核对两套组件。成品用户无需安装 Python，视频代表帧使用已有 FFmpeg 设置。

`dist:dir` 输出到 `release/<package.json 版本>/win-unpacked/`，复用本机安装的 Electron 运行时。
`better-sqlite3` 13 使用随包提供的 N-API 原生文件；无需 Visual Studio 重编译。运行 `npm run rebuild` 可重新安装 Electron 运行时并验证 SQLite 读写。关闭安装脚本的环境应手动执行该命令。
UI 验证使用项目的 Playwright 开发依赖，也可用 `BAOYI_PLAYWRIGHT` 指定已安装的兼容包；Electron 测试无需另外下载浏览器。
免安装分发与便携数据模式并不是同一回事，其他打包命令及数据差异见[发布约定](docs/releases/README.md)。

## 数据与源码

源码不包含用户资料库、账号配置、阅读档案、会话记录或本机验证 profile。所有测试应使用隔离数据。标准目录版使用 `%APPDATA%\抱一`；便携数据模式是另一个构建目标。

发布附件提供 Windows 程序目录 ZIP、产品源码 ZIP、SHA-256 校验表和来源/验证清单。第三方许可声明位于 `docs/third-party/`，随包运行组件另附各自声明。
