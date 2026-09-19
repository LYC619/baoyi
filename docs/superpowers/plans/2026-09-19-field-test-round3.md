# 影视库实测第三轮 · 计划与决定（2026-09-19）

用户 9-19 晚的实测反馈五条。前四条这轮做完，「详情页排版 / 整体交互」等设计 Agent 出方案后再做。
交付说明在 `docs/changes/2026-09-19-video-field-test-round3.md`。

## 问题定位与改法

1. **占位集挡住同系列分部**。根因在 `applyVideoCatalogue`：播放列表每一条都建成占位集并绑来源，
   `resolveVideoOwnership` 查到来源就判「已在其他作品」。改三处：只给 `catalogueIdentity` 判为
   同系列（numbered）的建占位；占位集不算归属（`identity.ts` 查询排除）；登记有文件的集时把别人的
   占位让出去（`placeholders.ts`，挂在 `registerVideoContent` 这个所有入口都经过的地方，下载流程另外
   通知被让出的作品刷新）。启动时 `pruneStrayPlaceholders` 一次性清历史遗留，幂等。
2. **简介页播放**。`Detail.vue` 的 `resumeContent` 优先取当前选中的集；简介区多一个「播放这一集」。
3. **简繁搜索**。SQL 端注册 `zh_key()` 函数（better-sqlite3 和 node:sqlite 的 `.function()` 签名一样，
   自检和真库同一条路），字段和关键词两边都过。渲染层单集筛选用同一个 `zhSearchKey`。字表从 opencc-js
   的 TSCharacters 抽单字对，生成 `src/utils/zh-table.ts`，不加运行时依赖。
4. **卡片大小**。CSS 变量 `--card-min` + 设置 `video_card_size`，滑块在工具栏。
5. **统一移动**。`layout.ts`：绑定目录的整目录 rename + `rebaseMovedVideoDirectory`（顺带修了它不改
   `video_scan_ignores` / `video_scan_state` 的问题，且 root 可传）；散文件走现成 `previewVideoOrganize` /
   `applyVideoOrganize`。跨盘、目标已存在、目录里有别的作品都标 skip。

## 决定

- 「分组名」= 收藏分组 `collection_name`，不是分类。
- 整理根目录复用设置里的 `video_organize_root`，不另加设置项。
- 整目录 rename 不进整理日志，只留 `userData/library-layout/` 记录（ponytail 注释里写了升级路径）。
- 不提交 `抱一.7z`（工作区里 9-19 20:09 出现的源码压缩包，不是本轮产物）。

## 验证

新增 `scripts/verify-video-field-round3.ts`（离线 7 项）和 `scripts/verify-video-field-round3-real-db.ts`
（打包产物 + 真库副本 5 项，只开统一移动预览不点开始）。其余闸门和结果见交付说明。
