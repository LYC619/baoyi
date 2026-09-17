# 抱一实测修复验收记录

日期：2026-09-08。接续任务：01a0752a-91e3-7da3-af05-244fb8b9e298。

## 交付

- 单文件测试包：`release/0.8.0-field-test-20260908/BaoYi-0.8.0-field-test-20260908-x64.exe`，87,945,106 字节。
- 解包版本：`release/0.8.0-field-test-20260908/win-unpacked/抱一.exe`。
- SHA-256：`569455d6b7bdc4bd03f1fb00ce7714374a1cb55cf60455f2219ca26ce98e75c1`。
- 分支：`codex/field-test-fixes-20260908`。保留此前未提交工作，本次未创建提交。

## 修复行为

1. 下载沿用内置代理和验证 Cookie 所在的 Chromium 会话，显式指定 Referer 策略，解决完整跨域 Referer 导致的 `ERR_BLOCKED_BY_CLIENT`。
2. 识别事实包含原始视频文件名、解析片名、实际目录及同目录作品。混合目录按作品拆分，同作品的季集和特别篇保持归属；支持 agent 指定及用户编辑命名分组。录屏、短视频可登记到“其他分类”。
3. “里番”位于类型区，只在显式选择该类型时进入列表及相应标签、分组、归档筛选。默认全部影视、搜索、观看状态和普通类型计数排除里番，全局隐藏开关继续有效。
4. 重扫新增作品或更早集时保持原 ID、用户分组及观看进度。旧库误合并的混合作品先迁移需要拆出的集记录，再更新保留原 ID 的作品；支持单条重新识别。拆分失败时暂停原条目更新，迁移错误使用保存点回滚。
5. 封面依据实际目录和作品文件名匹配，持久保存远程来源，可恢复丢失的旧缓存及重新解析过期来源。原子替换、同条目请求合并和版本检查保护用户自选封面；界面加载失败会显示占位并纳入补海报。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run build`，含完整类型检查 | 通过 |
| `npm run selfcheck` | 627/627 |
| `npm run check-modules` | 9 组、3 个模块通过 |
| 文件名扫描 / 数据库 / 识别服务 / 界面回归 | 10/10、9/9、7/7、4/4 |
| 封面服务回归 | 7/7 |
| Hanime 链路回归 | 21/21 |
| 真实 Electron 下载会话、请求头、Cookie、重定向与代理 | 4/4 |
| 下载流 / 下载服务 / Chromium 网络适配回归 | 29/29、20/20、9/9 |
| 系列下载 / 系列下载界面回归 | 18/18、12/12 |
| 最终包真实界面检查 | 8/8，无页面运行错误 |
| 便携启动、原生 SQLite IPC、独立 profile、正常退出 | 通过 |
| 包内一致性 | 52 个编译文件、2 个外置资源逐字节一致，运行清单字段一致 |
| `git diff --check` | 通过 |

任务中心、任务操作、单集下载界面、扫描设置及 Hanime 验证流程的既有专项回归也已通过。完整日志位于 `.recover/field-test-fixes/`；最终构建、数据、封面、自检等采用 `*-final.log`，识别服务采用 `verify-video-library-service.log`。

真实界面通过独立 profile 的成品应用验证分组编辑和跳转、其他分类、里番类型与标签、详情类型编辑、全局隐藏、缺失海报修复和 `baoyi://` 资源加载。1280 与 960 宽度的片库、详情截图均已检查，未见文字遮挡或错位。960 是应用原生最小窗口宽度。

证据：`.recover/field-test-fixes/packaged-ui/evidence.json`、同目录四张 PNG、`.recover/field-test-fixes/portable-evidence.json`。

## 验证范围和异常

测试使用临时视频树、内存数据库和隔离 Electron profile，未修改正在使用的片库。识别服务回归使用真实扫描、事实、注册工具和数据库，模拟 LLM 与媒体解码边界；未调用真实 LLM 验证识别准确率。没有执行真实网站登录后的整段视频下载，动态验证及链接时效仍需用户实际环境确认。本地 Electron 网络 fixture 已覆盖原始 Chromium 拦截问题及内置代理路径。

下载流回归初次发生本机 HTTP fixture 的 `fetch failed`，为 28/29；诊断重跑及最终留档重跑均为 29/29。首次失败保留在 `verify-video-download.log`，成功结果在 `verify-video-download-rerun.log`，未把偶发失败的原因认定为已解决。

新增测试的 Sample 文件名命中既有样片过滤、打包器精简开发清单及 Windows ASAR 路径分隔符曾导致验收脚本失败，定位并修正测试后均通过；这些不属于应用故障。

## 复验入口

```powershell
npm run verify-video-library-service
npm run verify-video-library-db
npm run verify-video-packaged-ui
node .recover/field-test-fixes/verify-portable.cjs
```

便携包由 `npx --no-install electron-builder --config.directories.output=release/0.8.0-field-test-20260908 --config.artifactName=BaoYi-0.8.0-field-test-20260908-x64.exe` 生成；打包前已执行最终生产构建。
