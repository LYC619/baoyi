# 调查记录

- local-sync.ts 的 syncLooseCatalogue 只匹配 before.contents 中已有集号；新集不在列表就 continue，造成“检查完成：新增 0 个视频”。绑定目录的 localBundleItems 已会枚举新文件。
- locateVideoWorkDirectory 把所有 asset（包括项目 data/posters 图片）当作目录候选，逻辑合并后还可能跨多个视频目录，需要只以视频事实推断并支持多个已知目录。
- service.ts identifyOne 在有 NFO / hanime_id 或 AI 未启用时走 registerLocalVideoFacts；AI 已配置且本地缺准确来源时会自动调用 runAgent。用户要求首轮不用 Agent，需要改默认策略和后续待处理标记。
- videoScanReadiness 已允许无 AI 扫描，但前端仍以降级 confirm 打断流程，文案还称每项交给 Agent。
- proxy.ts openHanimeVerification 是临时挑战窗口，页面可用后自动关闭，2 分钟限时；可复用 getHanimeSession 和代理，不能直接作为常驻浏览入口。
- Detail.vue 仅单集在顶部显示 published_at / air_date；合集缺范围。简介目前 episode-artwork 两图纵排，切换是 select。
- 上轮两个黄色提示已只读核实为已完成合并后旧选择的预览冲突；当前真实库两个测试合集各 2 集，视频资产唯一，旧失败历史无实际改动。
- 只读检查两组实际 info.json：字段为 title/coverUrl/chineseTitle/introduction/uploadTime/videoUrls/tags/artist，无来源编号，uploadTime 是 YYYY-MM-DD。本地解析原先未读时间与厂牌，电影也未建立无来源的单集资料行，均已修复。
- 旧 NFO air_date 使用 Unix 秒，站点 published_at 使用毫秒；显示与筛选必须统一单位，避免把 NFO 日期显示到 1970 年。
- 本地 JSON 的 Date.parse 会把 2 月 31 日顺延到 3 月，已先校验实际日历日期；合法闰日和带时区日期保留。
- 旧版 video-feedback-v2 扫描缓存会跳过内容没变化的 info.json，无法补读新增的 uploadTime/artist。已版本化为 video-local-first-v3；复现后验证首次补读、观看进度保留、第二次继续跳过，均不调用 Agent。
- 设置页仍存在“影视扫描需要 AI”的旧提示，已改为本地优先说明；任务停止提示使用“当前任务”，待确认日志兼顾资料不足与归属问题。
- 原生浏览测试使用隔离持久会话与合成页面；真实菜单交接后，Chromium 网络栈从回环服务器保存 16 KiB 合成 MP4 容器，资料、两张中性图片、入库与重启均通过。未下载真实站点视频。
