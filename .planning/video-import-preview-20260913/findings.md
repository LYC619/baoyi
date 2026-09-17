# 调查

- 用户正在手工整理和剪切已导入视频；本轮仅修改源码及生成隔离测试数据，不操作正式资料库或媒体。
- useMediaScan 的 execute('video') 在扫描与单项 reidentify 时均重置同一 progress；Home 将其作为扫描进度显示。旧结果虽然有单独 result，但 importedResult 只在页面内存中，缺少可恢复的批次确认状态。
- 现有视频 scanVideos/importVideoBundle 直接写正式表；软件已有 pending_software 和 Confirm.vue 的识别后确认模式。
- 视频登记集中在 registerLocalVideoFacts/registerVideoPayload/registerVideoBundle，均接收 SqlDb。Agent tools 使用 ctx.db，只有登记后来源事实补写和 service.onRegister 的封面下载需要额外隔离。
- 预览不能使用全局 getDb 临时切换，否则并行 UI 请求可能误读草稿。采用显式上下文和独立内存数据库快照，持久化的草稿仅包含本批提案，不保存设置或 API Key。
- 实际 better-sqlite3 WAL 库 serialize 后的快照保留 WAL 文件头，匿名内存 deserialize 读表报 unable to open database file；只把快照字节 18/19 改为 rollback-journal 格式即可，原库及 WAL 不变。两个 Agent/导入快照入口共用 cloneVideoDatabase，并由最终包原生测试覆盖。
- 库读取会刷新 checked_at，并可能对旧 Hanime 条目投影 source_url 等资料。版本检查不包含派生检查/更新时间；原生用例等待首页加载后再触发操作，真正资料变化仍需重查。
- 确认入库后的封面处理在批次内跟踪，仅允许当次已确认作品的封面字段变化推进基准。下载期间如有其他资料或归属修改，剩余批次保持失效保护。
