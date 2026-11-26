# 从源码构建

抱一使用 Electron、Vue 3、TypeScript、Vite 与 SQLite。桌面交付目标为 Windows x64；静态官网可在 Windows、macOS 或 Linux 构建。

## 准备环境

- Node.js **22.12 或更新版本**与 npm，CI 使用 Node 22。
- Git；准备 Windows 内置运行组件时使用 Python **3.12**。
- 首次安装依赖和运行组件时需要联网。
- 视频抽帧及相关测试可按需配置 FFmpeg。

```powershell
git clone https://github.com/LYC619/baoyi.git
cd baoyi
npm ci
npm run dev
```

`npm ci` 安装 Electron 并检查原生 SQLite。关闭安装脚本的环境须先运行 `npm run rebuild`，再打开桌面程序。SQLite 使用随包提供的 N-API 文件，通常无需 Visual Studio 重编译。

需要独立开发资料库时先构建，再运行 `npx electron . --user-data-dir="<output 下新目录的绝对路径>"`。测试导入、移动和恢复时不要指向日常资料库；测试入口会自行创建独立目录。

## 检查改动

```powershell
npm run typecheck
npm run build
npm run i18n:check
npm run docs:check
npm run selfcheck
npm run eval:archive
npm run test:unit
```

按修改范围补跑模块套件，例如 `npm run test:settings`。测试入口使用独立资料库，Windows 窗口测试放在隐藏桌面。需要 FFmpeg 的用例可用 `BAOYI_TEST_FFMPEG` 指向本机程序；缺少外部组件应记录为验证限制，不能算通过。

## 生成 Windows 程序

```powershell
npm run prepare:hermes
npm run prepare:comic
npm run check:hermes
npm run check:comic
npm run dist:dir
```

准备步骤分别构建归档助理与漫画所用的固定版本运行组件，不把依赖装进系统 Python。目录版位于 `release/<版本>/win-unpacked/`，交付时保留完整目录；成品用户无需 Node 或 Python。

`npm run dist` 使用标准分发配置；`npm run dist:green` 生成明确使用便携数据的 ZIP。单文件分发不等于便携数据模式。打包包装脚本和公开源码导出见[部署说明](deployment.md)。

## 界面翻译

中文原文作为消息标识，英文词库位于 `src/i18n/en.json`。模板使用 `$t('原文', { p0: 值 })`，脚本使用 `tr(...)`。完整句子应放在一起，让英文可以调整变量顺序，不把一句话拆成多个译文片段拼接。

只翻译应用自己的标签与提示，保留路径、文件标题、笔记、分类、模型输出和数据库业务值。界面语言与资料标题语言分别设置。运行 `npm run i18n:check` 检查缺译和占位符变化。

检查器也覆盖原生对话框和静态系统报错。共享或主进程代码使用不依赖 Vue 的 `src/i18n/core.ts`；渲染层仅在应用提示的显示边界使用 `systemMessage`，不得用于资料标题、用户笔记或模型正文。未知的上游提示保留原文；原生对话框跟随已保存的语言，第三方网页和模型回复由各自的语言设置决定。


## 参与贡献

用独立分支处理明确问题，说明用户之前遇到什么、现在如何操作，并把必要测试补进现有套件。不要提交资料库、密钥、下载和个人档案。详见 [CONTRIBUTING.md](https://github.com/LYC619/baoyi/blob/main/CONTRIBUTING.md)。
