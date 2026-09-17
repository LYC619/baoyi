# Hanime 注册元数据设计

## 目标

Hanime 详情成功后，注册流程必须可靠保存并展示站方封面、全部站方标签、中文译文、日文原文和 Hanime 条目链接，不再依赖 agent 把结构化站方数据逐项抄进 `register_video`。

## 数据模型

- `resource.description` 继续保存 agent 生成的中文简介，保持现有编辑和搜索行为。
- `video_meta.original_description` 保存 Hanime 原始简介，默认空串；重刮时由已验证的 `hanime_detail` 结果直接覆盖。
- `video_meta.hanime_tags` 保存站方全部标签的 JSON 数组，和普通 `resource.tags` 分离。普通标签规则仍保持最多 3 个，Hanime 标签不截断。
- `official_url` 在没有更优官网时继续保存 `https://hanime1.me/watch?v=<id>`，详情页增加可见入口。

## 注册与封面

`register_video` 根据已核验的 Hanime ledger 直接取 `introduction`、`tags` 和 `coverUrl`。agent 只提交中文 `description`，不能决定或删减原文、站方标签和封面 URL。注册完成后，服务层对该条目立即调用现有 `fetchVideoPoster`，让远程封面经 Hanime 专用 Chromium session 下载到本地；下载失败不撤销已完成的注册，并在识别进度中留下说明。

## 界面

- 详情页简介先显示可编辑的中文译文；存在原文时，下方提供“查看日文原文”的折叠区，原文只读。
- 详情页标签区同时显示普通标签和全部 Hanime 站方标签，站方标签可点击筛选。
- 详情页信息区显示 Hanime 链接。
- 影视首页侧栏的“标签”区：仅当当前选择为分类“里番”时显示 Hanime 标签；处于“全部”、类型、观看状态、其他分类时不显示 Hanime 标签。点击 Hanime 标签后保持里番分类范围并叠加标签条件。

## 迁移与兼容

新增列使用“列是否存在”的幂等迁移方式，并在视图缺列时重建视图。旧条目默认得到空原文和空 Hanime 标签，不影响普通影视。已有 Hanime 条目重新执行“按里番刮削”即可补齐数据。

## 验证

回归测试覆盖：ledger 数据直接落库、全部标签不截断、原文与译文分列、Hanime 标签仅在里番分类计数中出现、点击标签组合查询、远程封面注册后触发下载，以及详情页具备折叠原文和链接展示。
