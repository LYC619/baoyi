# Contributing to BaoYi / 参与贡献

BaoYi is a Windows desktop project with a bilingual static product site. Start with [development instructions](docs/site/en/development.md) or [中文开发说明](docs/site/zh-CN/development.md).

## A focused change

1. Open an issue describing the problem or proposed behavior. Small fixes can go straight to a pull request.
2. Create a branch. Keep unrelated changes separate and preserve existing user data.
3. Add or adjust meaningful tests in the affected module. Register a new suite in `scripts/test-manifest.json`.
4. Run `npm run typecheck`, `npm run build`, `npm run i18n:check`, `npm run docs:check` and the relevant module tests. Run `npm run site:build` and `npm run site:check` for website changes.
5. Explain the user-facing before/after behavior and what you verified. List missing runtime or environment checks honestly.

界面改动同时维护中英文，复用既有 UI 组件和样式变量。路径、笔记、分类和数据库业务值不是翻译对象。新增路由、IPC 或数据契约时补齐边界校验并运行 `npm run docs:generate`。

## Reports and translations

Include your app version, Windows version, interface language, steps and expected result. Use synthetic files and redact credentials, account tokens and personal paths. Translation corrections should include the screen and source message; preserve every interpolation variable such as `{p0}`.

欢迎中文或英文反馈。请只提交产品源码与公开文档，不提交日常库、下载、密钥、私人阅读档案或本地测试数据。

## License

By contributing, you agree that your contribution is available under the project's MIT license. Retain upstream notices for third-party material and describe any new dependency and its license.
