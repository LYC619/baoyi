# 部署官网与打包程序

公开网站只承载产品介绍与使用文档，桌面程序仍在 Windows 本机运行。发布网站不会让浏览器访问你的资料库。

## 本地预览官网

```powershell
npm ci --ignore-scripts
npm run site:build
npm run site:check
npm run site:preview
```

打开预览命令显示的本机地址。生成内容在 `output/site`，包含中英 HTML 页面、本地素材、站点地图和 robots.txt。阅读与语言切换不依赖 JavaScript 或第三方字体服务。

## GitHub Pages

1. 按下文生成公开源码目录，并检查清单。
2. 按正常审阅流程把确认过的产品源码发布到公开仓库 `main`。
3. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
4. 在 Actions 中运行 **Deploy website**；以后公开 `main` 中的网站改动会自动触发。
5. 查看部署结果，并打开中英两个入口。流程只上传 `output/site`。

部署流程从 GitHub Pages 读取网站实际基础地址，因此 Fork 会使用自己的账号与仓库路径。地址格式不正确时构建失败。源码和下载入口配置在 `docs/site/site.json`，Fork 后也应修改。

自定义域名先完成 DNS 和 Pages 域名设置，本地构建通过 `SITE_URL` 指定，例如 `$env:SITE_URL='https://example.org/'`。构建器会同步生成规范地址、语言对应关系、站点地图与 CNAME。本地预览通过不等于公网部署成功。

## 导出公开源码

```powershell
npm run export:public
```

命令在 `output/public-export` 下新建带时间戳的目录，按允许清单复制产品文件并生成清单，不推送历史、不修改远程。维护笔记、`.user`、`data`、`archive`、`reference`、构建产物、凭据和日常测试资料不在导出范围。公开版 `AGENTS.md` 由精简模板生成，不复制本地约定。

导出保留可移植的单元测试、界面测试和明确列出的构建工具；本机修复工具、实测脚本、历史成品检查及对应命令会排除，测试清单随实际文件同步筛选。

将目录带入公开源码分支前，检查内容并执行构建。本地维护用 `main` 可能保留私人历史，不能直接推送；维护者工作区继续使用既有 `release/public → origin/main` 对应关系。

## Windows 打包入口

运行 `pwsh -File scripts/package-windows.ps1` 可预览命令和输出目录，不会开始构建；加 `-Build` 执行检查和目录版打包。仅在确需准备运行组件时加 `-PrepareRuntimes`。脚本拒绝覆盖已有版本目录，保留旧程序。

脚本不发布 Release，也不复制日常资料库。上传前用独立资料检查成品，并核对完整输出。源码包与公开标签应对应同一份审阅后的源码；高级分发仍可使用原有打包命令。

## 搜索与分享

每种语言有独立地址、规范地址和语言对应关系。页面提供标题、摘要、社交分享卡与结构化信息，构建同时生成站点地图和 robots.txt。这些便于搜索引擎识别网站，但不能保证收录或排名。
