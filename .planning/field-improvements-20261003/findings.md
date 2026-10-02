# 发现

- Electron 37 + Vue 3 + Pinia + SQLite。package 0.11.0；现有功能分支 codex/field-test-fixes-20260908。
- 启动前 238 个文件变更已完整 checkpoint 为 b9799b0，未修改个人资料库。
- web-browser.ts 和 discovery-browser.ts 的 setWindowOpenHandler 都把新窗口导航强行写入原窗口，直接解释广告覆盖。
- locateFfmpeg 只查 PATH 和少数固定位置，缓存 null 无法重新探测；尚无用户配置入口。
- HLS 初查：隐式 IV 写入高 64 位（应低 64 位）、worker fail-fast 后仍可能写临时目录、旧分片没有清单身份校验，需离线回归。
- 游戏主页当前只有平铺网格；软件/游戏详情都是独立 route，但内部无视频式详情 tab。漫画已有 group、批量管理和阅读器，应沿用数据结构逐步增强。
- rg 未找到 2026-10-02-1.png 实体；后续查看本地错误日志，记录可核实结论。
- rtk 当前 shell 不可用，直接运行原命令。
