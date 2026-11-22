# 抱一 · BaoYi

> 知止而后得。

本地资源掌控工具。资源库管“物”，项目记录“事”，个人入口管理“我”；资料、摘录、项目与技能相互引用。

## 源码 0.20.4 · 2026-11-22

当前源码（Schema v33）包含六大库全局拖拽入库、媒体详情页「物·事·我」反向关联面板、原生模态确认与顶层轻提示、深浅色全局视觉统一、全应用自然中文润色，以及在线音乐通道、影视发现页、游戏项目横竖封面预览、归档助理 22 工具离线评测套件、七域主进程服务分层、全量 IPC 运行时参数校验与 GitHub Actions CI。0.20.4 已完成本地目录版打包与 50 组隔离成品 E2E 验证，尚未作为公开安装包附件发布。

- [0.20.4 版本说明](docs/releases/0.20.4.md) · [架构与 IPC 索引](docs/architecture-and-ipc.md)
- 最新公开下载仍是 [Windows x64 版本 0.19.1](https://github.com/LYC619/baoyi/releases/tag/v0.19.1) · [0.19.1 版本说明](docs/releases/0.19.1.md)

下载 `BaoYi-0.19.1-windows-x64.zip`，解压完整目录后启动 `抱一.exe`。请保留全部 DLL 与 resources 文件；标准版使用 AppData 资料库。升级前备份资料库，退出旧版后再启动新版。程序未进行代码签名。

## 功能

| 模块 | 已有能力 |
|---|---|
| 个人 | 总览、技能实践与自评、背包费用/续费/暂缓提醒、状态指标和趋势、奖项与经历、轻量待办；关联项目与凭证 |
| 软件 | 拖拽/目录扫描、智能识别、多启动端、分类标签、批量管理、使用记录、目录归置与链接整理 |
| 游戏工作区 | 拖拽/清单导入、横竖双版封面预览选择与撤销、简明游玩入口、修改器/攻略/MOD 关联与阅读、多篇笔记、存档核验与备份还原 |
| 影视与音乐 | 拖拽/目录扫描、课程合集、海报、智能整理、下载任务；内嵌试看、250ms 悬停代表帧；影视发现页；在线音乐搜索试听下载、全局播放与同步歌词 |
| 图片 / 漫画 | 拖拽导入、Pica 与 JM 来源、选章下载、代理选择、暂停续传、补章与恢复核验；缩放阅读、书签、进度、批量整理、选页封面和照片 EXIF |
| 资料 | 拖拽/预览导入、PDF/Markdown/TXT 四套纸色阅读与跨页拖选、书签摘录与引用；精读结论、原文证据与覆盖范围 |
| 项目 | 当前情况/下一步/关键 Prompt 自动保存，规则链接、Git 状态、多入口与编辑器；托管启动/停止、动态端口、限定范围的交接 Prompt |
| 归档助理 | 全局对话、资源与正文繁简检索、来源引用、分类保存与中文变更撤销、文件核验整理、记忆、方法及任务续接 |
| 公共能力 | 本地 SQLite、设置、代理、后台任务、资料库与助手备份恢复、升级前快照、媒体详情页反向关联面板 |

智能识别与归档助理需要配置支持工具调用的模型服务；在线来源受账号权限、代理、网络和站点可用性影响。Office/EPUB 调用外部应用；PDF 不含 OCR 或文字重排。归档助理嵌入 Hermes v0.22.7 原版 Python 内核，第三方许可声明见 `docs/third-party/`。

## 开发

技术栈：Electron 44、Vue 3、TypeScript、Vite 8、Pinia、SQLite。开发环境需要 Node.js 22.12 或更高版本。

```powershell
npm ci
npm run dev
npm run typecheck
npm run build
npm run docs:check
npm run selfcheck
npm run eval:archive
npm run test:unit
npm run prepare:hermes
npm run prepare:comic
npm run dist:dir
```

`prepare:hermes` 与 `prepare:comic` 首次需要开发机 Python 与联网，按固定摘要准备独立运行组件；成品用户无需安装 Python。`dist:dir` 输出到 `release/<package.json 版本>/win-unpacked/`，其他打包方式见 [发布与打包](docs/releases/README.md)。

## 数据与源码

源码不包含用户资料库、账号配置、阅读档案、会话记录或本机验证 profile。所有测试均使用独立隔离目录。标准目录版使用 `%APPDATA%\抱一`；便携数据模式是另一个构建目标。
