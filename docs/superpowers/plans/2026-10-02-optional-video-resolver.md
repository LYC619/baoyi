# 可选视频解析服务接口 Implementation Plan

> 按用户“没有，先保留可选 API 接口”决定，在当前工作区串行执行，保留已有修改，不提交。

**Goal:** 为外部视频解析服务预留代码契约，不增加主程序依赖、运行时行为或配置入口。

**Architecture:** 仅导出主进程 TypeScript 类型。区分资料解析、用户确认后的服务端准备、任务查询与完整文件交付；不将任意 yt-dlp JSON 当作现有目录或可下载文件。

**Tech Stack:** 现有 TypeScript；无新增包。

- [x] 创建 `electron/kinds/video/discovery/resolver-contract.ts`：默认禁用配置、服务上下文、作品和格式、准备状态、适配器方法。全部使用 `export interface` / `export type`，不注册 IPC、不实例化服务。
- [x] 创建 `docs/video-resolver.md`：记录接口语义、与 catalogue/workflow 的接入顺序、凭据及过期文件处理、候选服务核验和未实现范围。更新视频功能说明链接。
- [x] 执行 `node --max-old-space-size=768 node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json --pretty false`；检查差异。纯类型和文档变更不新增镜像测试，不重新打包预览。

验收：类型检查通过；无 package.json/lock、数据库、preload、IPC 或 UI 修改；无服务安装或网络后台任务；用户不配置服务时产品行为完全不变。

核验结果（2026-10-02）：项目类型检查退出码 0；类型文件转译结果仅为空模块 export {}，没有运行时实现；本轮仅新增契约、说明和计划并补充文档链接。未新增依赖、服务或产品入口，未重新打包。
