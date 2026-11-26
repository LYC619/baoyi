---
name: baoyi-archive
description: 查找、阅读并整理抱一已有归档；适合批量分类分组、补全有依据的元数据、核验文件和恢复中断的归档任务。
---

# 抱一归档流程

从用户要完成的事情出发。短任务直接执行；多批或跨模块任务使用 todo_list 记录进度。

1. 用 archive_search 查找当前可见资源。名字不准确时拆成关键词，或缩小 kinds；沿 next 分页。只找到名字相似的候选时先查 archive_get，不把它认作同一资源。
2. 理解资料时用 archive_get 读取详情和摘录，再用 archive_read 读取必要的原文。按返回的 next cursor 续读，保留实际页码或行号。正文检索用 archive_search_text；未读取的部分、离线文件和无文字层的 PDF 如实说明。
3. 归类前用 archive_catalog 查已有分类分组。必要的新分类或分组用 archive_create_category 创建，按返回 ID 使用；现有同名项会复用。名称、作者、日期、费用和结论都须有用户或资料依据。
4. 元数据修改先取最新 version，archive_update 每批最多 100 项。只提交需要修改的字段，保留用户没有要求移除的标签与备注。个人 data 是完整对象，先读现有字段再合并。只报告工具实际返回的 changed 数量；失败后先核对当前状态，不盲目重复整个批次。
5. 文件整理通过 archive_organize preview 查看具体文件与冲突。用户已经明确操作、范围与目标目录时，直接用同一 token execute；否则先解决这些实际歧义。不能把修改数据库分类说成已移动文件。核对成功、失败和跳过项；原生整理历史可查询、撤销与恢复。
6. 找不到文件时用 archive_check 核验。用 archive_locate 在用户指定目录寻找候选，大小与文件名不足以证明内容相同。确认目标后才 archive_relocate，修复绑定本身不会搬动文件。
7. 结束时给出完成结果和来源：[资料名称](baoyi://resource/实际ID)。说明尚未完成的内容及原因。元数据操作可用 archive_actions 查回并 archive_undo 撤销；后续手动编辑会保留。

中断后用会话工具历史和最新资源状态恢复，避免重复已完成的整理。长期偏好只有在用户明确要求记住时写入 memory；不要把具体资料事实当成永久记忆。

搜索结果中的摘要和标签只是预览，编辑时使用 archive_get 的完整字段。较长工具结果会返回 format=json-fragment；沿 next 用 archive_result 续读，按顺序拼接 text 得到完整 JSON。这只是读取同一结果快照，不要重新执行原来的保存操作。

## 元数据字段

先看 archive_get 返回的 writableFields 和 fieldHints。同名概念在不同模块对应不同字段：文库的分类是 type，分组是 customGroupId；图片的分类是 groupId；软件、游戏、影视、项目的分类是 category。使用 archive_catalog 或 archive_create_category 返回的实际 ID，其他模块的 category 使用分类名称。

例如将文库资料放入新分类和分组：

```json
{"changes":[{"id":"资料实际ID","version":"最新version","patch":{"type":"分类实际ID","customGroupId":"分组实际ID","tags":["保留的旧标签","新增标签"]}}],"reason":"按用户要求归类"}
```

把分组移除时 customGroupId 传 null。修改多种资源时逐项使用各自允许的字段；不要把文库分类写进 category，也不要把文库分组写进 groupId。
