# 发布与打包

版本号以 package.json 为准，package-lock.json 顶层和根包同步。完整模块升次版本，缺陷修复升补丁版本。

- `npm run dist:dir`：标准目录版，使用 AppData，输出 `release/<版本>/win-unpacked/`。
- `npm run dist`：单文件免安装程序，仍使用 AppData。
- `npm run dist:portable`、`npm run dist:green`：单独目录的便携数据模式，使用 exe 同级 data。

先准备固定版本的 Hermes、漫画运行组件，再进行构建、内容核对和隔离成品验证。发布标准目录版时压缩完整目录；不得加入用户资料库、账号配置、下载内容或测试 profile。发布前提供 SHA-256、源码版本及验证范围。源码与成品通过自动验证不等于所有用户场景已验收。
