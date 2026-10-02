# AV 接入参考项目评估

日期：2026-09-30。范围：用户提供的帖子、三个 GitHub 项目的选定源码，以及抱一现有视频模块。本文是接入建议，不是已批准的实施方案；本轮未修改产品代码，未安装扩展或运行外部脚本，也未验证第三方站点当前的访问和播放情况。

## 判断

有参考价值。根据用户后续明确的使用场景，接入目标调整为“浏览 → 选择 → 在线观看 → 感兴趣时下载并登记到本地”。AV 文件较大，不能把用户已有本地 AV 库作为设计前提。抱一现有“从 Hanime 添加”应扩展为可选择内容来源的获取入口；本地管理承接用户主动保留的作品。

此前建议的“先补本地资料、再做无文件收藏”优先级不符合本次需求，予以撤回。作品资料和文件分离仍可作为内部设计参考，但独立建设无文件收藏库不再是第一阶段前提。

三个项目分别偏向资料与收藏管理、外部播放桥接、番号识别与榜单发现，合起来仍不等于一个可直接使用的 AV 后端。

## 核对版本

| 仓库 | 阅读版本 | 代码许可证 |
| --- | --- | --- |
| 9E307/JavdbEmbySkin | `b80a02e130916a37784f9d92cfde7264602432bc` | BSD-3-Clause |
| aizhimou/jav-play | `79aa5514d58426dd3915ba95384f30453caca342` | Apache-2.0 |
| aizhimou/javranking-extension | `206ec971b618e4a4e946604b6d333dc9222e616f` | MIT |

源码阅读副本保存在 `output/av-integration-research/`。以下链接固定到核对版本，避免后续仓库变化影响结论。许可证只描述代码，不能据此推断外部数据服务的可用性。

## 三个项目分别能提供什么

### JavdbEmbySkin：最值得参考数据组织和导入方式

- 把作品资料留在本地数据库，收藏与本地视频文件没有强绑定。
- 来源评分 `rating` 带分值、人数和原文；个人评分另存为 `userScore`，二者不混用。
- `customMeta` 表达用户对来源资料的订正；读取时计算有效资料，而不是只能覆盖原始记录。
- 提供 JSON 备份与导入。导出对象标记 `app: javdb-emby-fav`、`version: 4`，包含作品、清单等，未来可研究为抱一增加兼容导入器。
- 数据同步考虑失败清单与同步期间的新修改；演员关注同步另有数量骤降保护。

代码证据：[作品记录与解析](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L16546)、[个人评分](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L16628)、[导出格式](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L18426)。

有三个不能照搬的细节：

1. **备份合并不等于多端同步。** `importJSON` 合并收藏取并集，个人评分优先现有非零值，备注取导入非空值或旧值；可能恢复已取消的收藏，不能可靠表达清空。`fieldRichness` 是比较字段数量后选择整条记录，不是逐字段验证正确性。抱一应区分“追加导入”“更新资料”“恢复快照”，为主动删除和清空保留明确语义。
2. **解析器有重复实现。** 界面用的 `detailBlockVal` 调用支持多语言标签，但收藏用的 `FAV.parseDetail` 仍有多处中文标签和中文评分格式匹配，不能把文档的“全语言完整解析”推广到所有采集路径。抱一应让展示与入库复用同一个解析结果，并用不同语言的 HTML 样本验证。
3. **订正自动撤销有边界。** `tryAutoHealCustomMeta` 会在来源结果看似已包含订正时移除本地订正，并对缺失的演员/分类调整删除记录。若解析不完整，空列表不能当成来源已确认删除。抱一宜保留订正，展示来源差异，让用户决定何时撤销。

对应源码：[导入合并](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L18479)、[界面多语言解析](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L22937)、[自动撤销订正](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L17374)。

数量保护也要准确理解：[30% 阈值](https://github.com/9E307/JavdbEmbySkin/blob/b80a02e130916a37784f9d92cfde7264602432bc/JavdbEmbySkin.user.js#L11866) 出现在演员关注同步，且要求本地数量至少为 10；不能据此声称全部作品同步都有同样保护。值得借鉴的是“请求失败、解析失败和来源真实为空必须区分”，不必照抄阈值。

### jav-play：参考操作入口，不作为播放底座

源码流程是从特定详情页 DOM 取编号，检查外部页面，解析特定页面内容，再通过已注册的播放器协议调用外部播放器。它解决的是网页到播放器的衔接，不包含完整资料库、文件管理或稳定的通用播放服务。

抱一可以借鉴“同一作品详情页集中展示可用操作”，例如本地播放与打开已绑定来源页面。具体页面解析规则、硬编码站点和流地址推导维护成本高；本轮没有验证它们仍然有效。代码还把部分网络失败映射为不可用/404 展示，抱一应区分暂时无法检查和确实不存在。

代码证据：[页面识别与连接流程](https://github.com/aizhimou/jav-play/blob/79aa5514d58426dd3915ba95384f30453caca342/entrypoints/content/index.ts)、[播放器桥接](https://github.com/aizhimou/jav-play/blob/79aa5514d58426dd3915ba95384f30453caca342/components/PlayerButtons.ts)、[网络检查](https://github.com/aizhimou/jav-play/blob/79aa5514d58426dd3915ba95384f30453caca342/entrypoints/background.ts)。

### javranking-extension：最值得参考番号输入和本地匹配

它先提取页面文本中的候选编号，再对编号做 NFKC、大小写与分隔符归一化，并和下载到本地的索引匹配、去重。未匹配候选有独立展示。这适合转化为抱一的“粘贴一段文本，批量识别作品”入口，初期无需配套浏览器扩展。

源码有输入长度和候选数量上限，也支持自定义正则。但默认表达式并不覆盖所有番号形式，文本提取与页面注入版本还存在校验差异。归一化适合找候选，不能单独充当永久作品身份：抱一仍应保留原始编号、来源站点及该站记录 ID；碰撞和歧义应进入预览。

榜单索引来自作者独立站点的 JSON 文件，扩展负责缓存与匹配。默认软刷新窗口为 12 小时、硬过期为 30 天，并用 manifest revision 检测版本变化。这说明开源扩展不等于开源了榜单采集和生成后端；服务可靠性、数据完整性及更新机制仍需另行评估。

其 `RankingAppearance` 已能表达榜单名称、来源、范围、年份、排名。抱一应保留这些信息以及抓取时间，避免把不同站点、年份、周期的排名揉成一个“品质分”。未匹配也不代表作品不存在或质量差。

代码证据：[编号归一化](https://github.com/aizhimou/javranking-extension/blob/206ec971b618e4a4e946604b6d333dc9222e616f/src/lib/normalize-code.ts)、[候选提取](https://github.com/aizhimou/javranking-extension/blob/206ec971b618e4a4e946604b6d333dc9222e616f/src/lib/extract-codes.ts)、[索引下载缓存](https://github.com/aizhimou/javranking-extension/blob/206ec971b618e4a4e946604b6d333dc9222e616f/src/lib/index-cache.ts)、[匹配流程](https://github.com/aizhimou/javranking-extension/blob/206ec971b618e4a4e946604b6d333dc9222e616f/entrypoints/sidepanel/App.tsx#L192)、[榜单字段](https://github.com/aizhimou/javranking-extension/blob/206ec971b618e4a4e946604b6d333dc9222e616f/src/lib/types.ts)。

## 抱一的现有基础与缺口

| 能力 | 当前依据 | 接入含义 |
| --- | --- | --- |
| 通用来源绑定 | `VideoSourceRef`、`video_sources`、`bindVideoSource` | 可以复用 provider、externalId、作品/单集范围、来源页面与证据；仍需 AV 适配器 |
| 归属识别 | `resolveVideoOwnership` | 按来源映射或目录找归属，保留冲突；番号只参与候选识别，不用标题强行合并 |
| 手改保护 | `user_edited`、`markUserEdited`，登记时仅补空字段 | 已有基础；新增演员、编号、个人评分等字段仍需明确保护规则 |
| 导入预览 | `createVideoImportManager` | 可参考草稿、检查、确认写入的流程；当前命令与文件校验偏向本地导入，不能直接接上远端数据 |
| 本地文件与播放 | `VideoAsset`、`playVideo`、`playVideoEpisode` | AV 本地文件可沿用已有播放能力，不必重建播放器 |
| 纯资料收藏 | `registerVideoContent` 第 191–192 行要求目录或文件 | 是未来可选扩展；当前目标在下载后入库，不必先解决无文件入库 |
| AV 专属资料 | 本轮定向检索未发现现成 JAV 适配器或完整番号模型 | 来源记录 ID、发行编号、别名、演员、片商、日期、各站评分需设计映射 |

本地依据：[来源类型](D:/8.Project/0_0_维护/抱一/src/types/video-library.ts:13)、[来源登记](D:/8.Project/0_0_维护/抱一/electron/kinds/video/registration.ts:148)、[路径要求](D:/8.Project/0_0_维护/抱一/electron/kinds/video/registration.ts:191)、[手改保护](D:/8.Project/0_0_维护/抱一/electron/kinds/video/db.ts:966)、[导入预览](D:/8.Project/0_0_维护/抱一/electron/kinds/video/import-preview.ts:38)、[本地播放](D:/8.Project/0_0_维护/抱一/electron/kinds/video/service.ts:415)。

## 修订后的建议范围与顺序

**第一步：验证一条完整观看流程。** 参考现成项目，在抱一的浏览窗口内验证从浏览、选择作品到实际观看的衔接。需要区分资料站与播放来源：JavDB 提供作品资料，观看通常还需要连接其他来源。仓库有实现不代表这些连接今天仍然有效；必须先实际确认关键步骤，才能承诺支持。当前仅完成源码评估。

**第二步：扩展现有获取入口。** 用户选择“里番 / Hanime”或“AV”，进入对应浏览体验。推荐第一版保留站点已有浏览能力，由抱一衔接来源选择、窗口导航和后续保存操作。另一种方案是把榜单、搜索、详情全部重做成抱一原生页面，维护范围明显更大，暂不作为首选。成熟脚本可参考或有选择地适配，不应原封不动混入所有皮肤、同步和收藏功能。

**第三步：接上选择性下载和本地登记。** 浏览、观看本身不向本地影视库新增作品；用户选择保留后，确认可用下载选项与位置，交给现有任务流程下载，成功后登记文件、封面、作品资料和来源。对重复下载、失败重试、空间不足和“可播放但不能下载”分别处理。不能把一个能打开的观看页面直接当作可下载文件。

现有代码基础：`electron/services/hanime-browser.ts` 已有独立浏览窗口和“下载当前视频”菜单；`src/components/video/DownloadPanel.vue` 接收选中的页面链接，提供下载和登记选项；`electron/kinds/video/download/workflow.ts` 已处理文件、资料与登记，但 `sourceRef` 等处仍固定为 Hanime，需要按来源扩展，不能只在界面增加按钮。

未来验证重点应是：选择后确实能进入对应作品并观看；跨站跳转后仍保留作品身份；浏览和观看不自动建本地条目；可下载时能完整保存并正确登记；下载失败不产生假完成或重复作品；Hanime 原有流程继续可用。本文未对未实现的功能声称测试通过。
