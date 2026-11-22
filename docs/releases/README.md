# 发布与打包约定

当前版本以 `package.json` 为准；`package-lock.json` 顶层及根包版本必须同步。
新增完整模块升次版本，后续缺陷修复升补丁版本；不要长期把不同交付都标成 0.8.0。

## 产物和数据模式

| 命令 | 输出 | 数据目录 |
|---|---|---|
| `npm run dist:dir` | `release/<版本>/win-unpacked/` | 默认 `%APPDATA%\抱一`，本次交付采用此模式 |
| `npm run dist` | `release/<版本>/` 下的单文件免安装程序 | 默认 AppData；electron-builder 的 portable 目标不等于应用的便携数据模式 |
| `npm run dist:portable` | `release/<版本>-portable/win-unpacked/` | exe 同级 `data/` |
| `npm run dist:green` | `release/<版本>-green/` 下的 ZIP 及解包目录 | exe 同级 `data/` |

后两种配置都携带中文和 ASCII 标记文件，且与标准版使用不同输出目录。
本次交付只构建和运行验证标准目录版；其他分发方式的配置通过检查，不代表其产物已实测。
目录版复制或压缩时必须包含整个 `win-unpacked`，不要单独复制 exe。

## 发布顺序

1. 正常退出目标目录里的应用；不要覆盖正在运行的包，也不要把现有用户 `data/` 混入新包。
2. 同步版本信息，运行 `npm run verify-release-config` 和相关功能回归。
3. 运行 `npm run dist:dir`，含类型检查和构建；复用 `node_modules/electron/dist`，无需再次下载 Electron。
4. 在独立临时资料库上运行打包验证，例如 `node --experimental-strip-types --no-warnings scripts/verify-image-source-ui.ts release/<版本>/win-unpacked/抱一.exe`。
5. 更新该版本说明、`release/README.md` 和 `release/current.json`，记录构建源码状态及 SHA-256。
6. 旧版只在确认无人使用且需要整理时原样归档到 `release/archive/<归档日期>/`，保留搬迁清单，不自动删除数据库或下载。0.10.0 交付保留 0.9.0 原位。

`release/` 和 `output/` 均不进 Git；长期发布说明保存在 `docs/releases/`。
0.10.0 的内容核对用 `node scripts/verify-packaged-content.cjs`；写入验收记录后可运行
`./scripts/finalize-local-release.ps1` 生成源码 ZIP 和摘要，`-VerifyOnly` 会重新核对 ZIP 与全部摘要。
该脚本拒绝覆盖已有证据；只选构建源码与发布文档，不收集用户库或过程目录。
尚未提交的源码不能用一个旧 Git 提交号冒充完整版本来源，应记录基线、脏工作区状态及源码文件摘要。

## 旧包

`release/archive/2026-09-29/` 保存 21 个旧版本 / 实验目录。
`output/archive/2026-09-29/` 保存原测试截图、报告、临时资料库和验证包。
部分旧目录含数据库快照，只用于本机恢复或追溯，不对外分发。
历史路径到归档路径的完整对应表在 `archive/2026-09-29/moves.json`。
