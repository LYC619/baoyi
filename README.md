# 抱一 · BaoYi

**简体中文** · [English](README.en.md)

> 知止而后得。

管理文件、项目与个人记录的本地 Windows 工作区。把值得留下的内容放在一起，也保留它们之间的关系：资料关联项目，项目连接技能，笔记跟着事情走。

## 从这里开始

- **下载程序：** [GitHub Releases](https://github.com/LYC619/baoyi/releases)。以各版本说明和实际附件为准，源码与文档可能领先于公开程序。
- **开始使用：** [使用指南](docs/site/zh-CN/guide.md)、[常见问题](docs/site/zh-CN/faq.md)、[隐私说明](docs/site/zh-CN/privacy.md)。
- **自行构建：** [开发说明](docs/site/zh-CN/development.md)。
- **部署官网与打包：** [部署说明](docs/site/zh-CN/deployment.md)。

完整解压 Windows 程序后打开 `抱一.exe`，保留同目录下的运行库与资源。首次启动可选择简体中文或 English，之后从「设置 → 外观」切换；AI 配置可以跳过。

## 日常能做什么

| 入口 | 主要用途 |
| --- | --- |
| 文库 | 阅读 PDF、Markdown、TXT，保存书签摘录，为项目关联资料和证据 |
| 项目 | 集中当前进展、下一步、相关文件、编辑器、终端和本地启动命令 |
| 个人 | 记录技能实践、背包费用与到期、状态指标、经历和轻量待办 |
| 软件和游戏 | 扫描目录、确认入库、启动程序、关联攻略和管理已支持的存档备份 |
| 影音与图片 | 整理影视音频，浏览照片漫画，按需使用在线来源 |
| 归档助理 | 检索和阅读收藏，维护已支持的记录，预览文件整理 |

核心浏览使用本地存储；AI 识别需要兼容模型服务，在线来源受权限和可用性影响。桌面交付面向 Windows x64，当前不提供托管个人资料库的网页版。

## 本地开发

需要 Node.js 22.12 或更新版本，桌面打包使用 Windows。

```powershell
npm ci
npm run dev
npm run typecheck
npm run build
npm run i18n:check
```

按修改范围运行模块测试、`npm run selfcheck`、`npm run eval:archive` 和 `npm run docs:check`。归档助理、漫画和部分媒体测试需要对应运行组件或 FFmpeg，准备步骤见开发说明。

官网可独立构建：

```powershell
npm ci --ignore-scripts
npm run site:build
npm run site:check
npm run site:preview
```

网站源码在 `docs/site`，生成内容在 `output/site`，GitHub Pages 部署流程位于 `.github/workflows/pages.yml`。仓库包含可部署网站不代表公网已经启用。

## 数据与恢复

从「设置 → 数据管理」查看实际数据位置。标准版通常使用 `%APPDATA%\抱一`，明确标注为便携数据的版本使用程序旁的 `data`。资料库与关联源文件分别保留备份；仅移除库记录和删除本地文件是两种操作。

不要把日常资料库直接作为问题附件。截图和日志先去除密钥、账户令牌、私人路径与正文；向远程 AI 提交敏感资料前先阅读隐私说明。

## 参与与许可

[贡献说明](CONTRIBUTING.md) · [安全问题](SECURITY.md) · [架构索引](docs/architecture-and-ipc.md)

抱一源码使用 [MIT 许可](LICENSE)，第三方组件保留各自许可与[声明](docs/third-party)。
