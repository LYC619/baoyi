import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ARCHIVE_SYSTEM, ARCHIVE_TOOLS } from '../../electron/archive/tools.ts'
import { archiveTurnMode } from '../../electron/archive/turn-policy.ts'
import { validateAgainstSchema, TOOL_MAP, type EvalCase } from './mock-runner.ts'

export const ARCHIVE_EVAL_CASES: EvalCase[] = [
  /* ===================== Group A: turn-policy 路由与边界 (12 cases) ===================== */
  {
    id: 'A01', group: 'turn-policy', title: '纯问候语路由至轻量 chat 模式', tools: [],
    run: () => {
      for (const msg of ['你好', '您好！', '嗨', '早上好', '谢谢', 'hello', 'thanks!']) {
        assert.equal(archiveTurnMode(msg, false, false), 'chat', `greeting: ${msg}`)
      }
    }
  },
  {
    id: 'A02', group: 'turn-policy', title: '附带资源上下文时即便问候也强制走 archive 模式', tools: [],
    run: () => {
      assert.equal(archiveTurnMode('你好', true, false), 'archive')
      assert.equal(archiveTurnMode('帮我看看', true, false), 'archive')
    }
  },
  {
    id: 'A03', group: 'turn-policy', title: '已有任务会话中的短追问保持在 archive 模式', tools: [],
    run: () => {
      assert.equal(archiveTurnMode('继续', false, true), 'archive')
      assert.equal(archiveTurnMode('换一个', false, true), 'archive')
      assert.equal(archiveTurnMode('谢谢', false, true), 'chat')
    }
  },
  {
    id: 'A04', group: 'turn-policy', title: '超长消息 (>1200 字) 自动升级为 archive 模式', tools: [],
    run: () => {
      assert.equal(archiveTurnMode('这是一段很长的背景说明。'.repeat(120), false, false), 'archive')
    }
  },
  {
    id: 'A05', group: 'turn-policy', title: '游戏/软件/影视/漫画/图片等品类查询路由至 archive', tools: [],
    run: () => {
      for (const msg of ['我有哪些游戏？', '看看我装了哪些软件', '最近看过的影视有哪些', '帮我找一部漫画', '查一下我的图片相册']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },
  {
    id: 'A06', group: 'turn-policy', title: '笔记/摘录/书签/高亮/精读请求路由至 archive', tools: [],
    run: () => {
      for (const msg of ['帮我查一下之前的笔记', '把这本书的摘录列出来', '看看我标过的书签', '高亮内容里提到过什么']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },
  {
    id: 'A07', group: 'turn-policy', title: '个人模块（背包/资产/经历/指标/技能卡）查询路由至 archive', tools: [],
    run: () => {
      for (const msg of ['列出我的背包资产', '查看我的工作经历', '记录一下今天的指标测量', '看看我的技能卡进度']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },
  {
    id: 'A08', group: 'turn-policy', title: '文件核验/重定位/恢复/回滚/重命名请求路由至 archive', tools: [],
    run: () => {
      for (const msg of ['核验一下简历原文件还在不在', '帮我定位丢失的合同', '回滚刚才的改动', '重命名一下这批证书']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },
  {
    id: 'A09', group: 'turn-policy', title: '项目工作台（便签/Prompt/Git/关联）请求路由至 archive', tools: [],
    run: () => {
      for (const msg of ['看看这个的便签和 Prompt', '查一下 git 状态', '把这份合同关联到工作台']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },
  {
    id: 'A10', group: 'turn-policy', title: '英文核心动作关键词路由至 archive', tools: [],
    run: () => {
      for (const msg of ['search my notes', 'undo last change', 'check library status', 'link this pdf']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `english archive: ${msg}`)
      }
    }
  },
  {
    id: 'A11', group: 'turn-policy', title: '纯百科闲聊问题停留在轻量 chat 模式', tools: [],
    run: () => {
      for (const msg of ['地球到月球有多远？', '写一首关于秋天的五言绝句', '解释一下什么是光合作用']) {
        assert.equal(archiveTurnMode(msg, false, false), 'chat', `general chat: ${msg}`)
      }
    }
  },
  {
    id: 'A12', group: 'turn-policy', title: '历史会话追溯与书籍/小说/论文查找路由至 archive', tools: [],
    run: () => {
      for (const msg of ['找一下旧的历史会话', '看看有哪些小说和论文', '我买过哪些音频或视频']) {
        assert.equal(archiveTurnMode(msg, false, false), 'archive', `should route to archive: ${msg}`)
      }
    }
  },

  /* ===================== Group B: 长 PDF / MD / 项目游标分块精读与结果分页 (10 multi-turn cases) ===================== */
  {
    id: 'B01', group: 'cursor-reading', title: '多轮：长 PDF 按页游标精读直到末页', tools: ['archive_search', 'archive_read'],
    run: async ctx => {
      const found = await ctx.callTool('archive_search', { query: '长篇技术手册', kinds: ['document'] })
      assert.equal(found.items[0].id, ctx.ids.pdfDoc)
      let pageRes = await ctx.callTool('archive_read', { id: ctx.ids.pdfDoc, page: 1 })
      assert.ok(pageRes.text.includes('ALPHA-PAGE-1'))
      let turns = 1
      let sawLastPage = pageRes.text.includes('ALPHA-PAGE-12')
      while (pageRes.next && turns < 15) {
        pageRes = await ctx.callTool('archive_read', { id: ctx.ids.pdfDoc, cursor: pageRes.next })
        turns++
        if (pageRes.text.includes('ALPHA-PAGE-12')) sawLastPage = true
      }
      assert.ok(turns >= 2, `expected multi-turn PDF pagination, got ${turns} turn(s)`)
      assert.equal(sawLastPage, true, 'must reach page 12 via cursor')
    }
  },
  {
    id: 'B02', group: 'cursor-reading', title: 'PDF 直接跳转到指定中间页并保留正确页码定位', tools: ['archive_read'],
    run: async ctx => {
      const mid = await ctx.callTool('archive_read', { id: ctx.ids.pdfDoc, page: 7 })
      assert.ok(mid.text.includes('ALPHA-PAGE-7'))
      assert.ok(!mid.text.includes('ALPHA-PAGE-1\n'))
    }
  },
  {
    id: 'B03', group: 'cursor-reading', title: '多轮：长 Markdown 文件沿 next cursor 完整分块精读不丢行', tools: ['archive_read'],
    run: async ctx => {
      let res = await ctx.callTool('archive_read', { id: ctx.ids.longMdDoc, line: 1 })
      let combined = res.text || ''
      let chunks = 1
      while (res.next && chunks < 20) {
        res = await ctx.callTool('archive_read', { id: ctx.ids.longMdDoc, cursor: res.next })
        combined += '\n' + (res.text || '')
        chunks++
      }
      assert.ok(chunks >= 2, `expected >=2 chunks for 420-line MD, got ${chunks}`)
      assert.ok(combined.includes('MARKER-LINE-001'))
      assert.ok(combined.includes('MARKER-LINE-210'))
      assert.ok(combined.includes('MARKER-LINE-420'))
    }
  },
  {
    id: 'B04', group: 'cursor-reading', title: '长 Markdown 从指定行号起读并衔接 cursor', tools: ['archive_read'],
    run: async ctx => {
      const res = await ctx.callTool('archive_read', { id: ctx.ids.longMdDoc, line: 350 })
      assert.ok(res.text.includes('MARKER-LINE-350'))
      assert.ok(!res.text.includes('MARKER-LINE-001'))
    }
  },
  {
    id: 'B05', group: 'cursor-reading', title: '多轮：正文搜索定位关键词后按返回页码/行号精读原文', tools: ['archive_search_text', 'archive_read'],
    run: async ctx => {
      const hit = await ctx.callTool('archive_search_text', { query: 'ALPHA-PAGE-9' })
      assert.equal(hit.matches.length, 1)
      assert.equal(hit.matches[0].id, ctx.ids.pdfDoc)
      assert.equal(hit.matches[0].page, 9)
      const excerpt = await ctx.callTool('archive_read', { id: hit.matches[0].id, page: hit.matches[0].page })
      assert.ok(excerpt.text.includes('ALPHA-PAGE-9'))
    }
  },
  {
    id: 'B06', group: 'cursor-reading', title: '正文搜索限定 ids 且如实报告离线缺失文件在 unread 中', tools: ['archive_search_text'],
    run: async ctx => {
      const res = await ctx.callTool('archive_search_text', { query: '北斗七星', ids: [ctx.ids.missingDoc, ctx.ids.longMdDoc] })
      assert.equal(res.matches.length, 0)
      assert.ok(res.unread.some((u: any) => u.id === ctx.ids.missingDoc))
    }
  },
  {
    id: 'B07', group: 'cursor-reading', title: '正文搜索分页（limit=1 -> offset/next 续读全部命中）', tools: ['archive_search_text'],
    run: async ctx => {
      const p1 = await ctx.callTool('archive_search_text', { query: '归档', offset: 0, limit: 1 })
      assert.ok(p1.next !== null && p1.next >= 1)
      const p2 = await ctx.callTool('archive_search_text', { query: '归档', offset: p1.next, limit: 10 })
      assert.ok(Array.isArray(p2.matches))
    }
  },
  {
    id: 'B08', group: 'cursor-reading', title: '多轮：超长工具输出触发 json-fragment 并用 archive_result 拼接还原完整 JSON', tools: ['archive_search', 'archive_result'],
    run: async ctx => {
      // Seed enough items to push archive_search output past 18000 bytes
      for (let i = 0; i < 95; i++) {
        ctx.personal.save({ kind: 'todo', name: `批量分页条目 ${String(i).padStart(3, '0')}`, body: '较长的说明文本用于测试 json-fragment 分段续读机制。'.repeat(4), data: {} })
      }
      let page = await ctx.callTool('archive_search', { query: '批量分页条目', limit: 100 })
      assert.equal(page.format, 'json-fragment')
      assert.ok(page.next && page.next.token)
      let raw = page.text
      let hops = 1
      while (page.next && hops < 20) {
        page = await ctx.callTool('archive_result', { cursor: page.next })
        assert.equal(page.format, 'json-fragment')
        raw += page.text
        hops++
      }
      assert.ok(hops >= 2)
      const parsed = JSON.parse(raw)
      assert.equal(parsed.total, 95)
      assert.equal(parsed.items.length, 95)
    }
  },
  {
    id: 'B09', group: 'cursor-reading', title: 'archive_result 跨会话或失效 token 明确报错不重复执行原操作', tools: ['archive_result'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_result', { cursor: { token: 'expired-token-id', offset: 0 } }, /快照已失效/)
    }
  },
  {
    id: 'B10', group: 'cursor-reading', title: '多轮：项目文件枚举 -> 项目正文搜索 -> 逐段读取项目源码', tools: ['archive_project_files', 'archive_project_search', 'archive_read'],
    run: async ctx => {
      const files = await ctx.callTool('archive_project_files', { id: ctx.ids.project, path: 'src', query: 'index' })
      assert.ok(files.files.some((f: any) => f.path.includes('index.ts')))
      const hits = await ctx.callTool('archive_project_search', { id: ctx.ids.project, path: 'src/index.ts', query: 'TOKEN_88' })
      assert.ok(hits.matches.some((m: any) => m.line === 88))
      const read = await ctx.callTool('archive_read', { id: ctx.ids.project, path: 'src/index.ts', line: 85 })
      assert.ok(read.text.includes('TOKEN_88'))
    }
  },

  /* ===================== Group C: protectedFields 保护与原子元数据更新 (10 multi-turn cases) ===================== */
  {
    id: 'C01', group: 'protected-fields', title: 'archive_get 返回文库人工编辑字段 protectedFields 与 typeLocked', tools: ['archive_get'],
    run: async ctx => {
      const detail = await ctx.callTool('archive_get', { id: ctx.ids.protectedDoc })
      assert.ok(detail.protectedFields.includes('notes'))
      assert.ok(detail.protectedFields.includes('author'))
      assert.ok(detail.protectedFields.includes('type'))
      assert.ok(detail.version && Array.isArray(detail.writableFields))
    }
  },
  {
    id: 'C02', group: 'protected-fields', title: 'archive_get 返回软件 category_locked 与影视 user_edited 到 protectedFields', tools: ['archive_get'],
    run: async ctx => {
      const soft = await ctx.callTool('archive_get', { id: ctx.ids.software })
      assert.deepEqual(soft.protectedFields, ['category'])
      const video = await ctx.callTool('archive_get', { id: ctx.ids.video })
      assert.deepEqual(video.protectedFields, ['summary'])
    }
  },
  {
    id: 'C03', group: 'protected-fields', title: '多轮：补充未保护字段（tags）时完整保留已保护字段（notes/author/type）', tools: ['archive_get', 'archive_update'],
    run: async ctx => {
      const before = await ctx.callTool('archive_get', { id: ctx.ids.protectedDoc })
      const updated = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.protectedDoc, version: before.version, patch: { tags: ['资质', '已核对'] } }],
        reason: '保留已保护字段，仅补充标签'
      })
      assert.equal(updated.changed, 1)
      const after = await ctx.callTool('archive_get', { id: ctx.ids.protectedDoc })
      assert.equal(after.metadata.notes, before.metadata.notes)
      assert.equal(after.metadata.author, before.metadata.author)
      assert.equal(after.metadata.type, 'certificate')
      assert.ok(after.metadata.tags.includes('资质'))
    }
  },
  {
    id: 'C04', group: 'protected-fields', title: '乐观锁：资源在读取后被外部修改，旧 version 提交被拒绝且不覆盖', tools: ['archive_get', 'archive_update'],
    run: async ctx => {
      const stale = await ctx.callTool('archive_get', { id: ctx.ids.longMdDoc })
      ctx.docs.update(ctx.ids.longMdDoc, { notes: '用户刚刚手写的重要补充' })
      await ctx.callToolExpectError('archive_update', {
        changes: [{ id: ctx.ids.longMdDoc, version: stale.version, patch: { notes: '过期的覆盖' } }],
        reason: '测试乐观锁'
      }, /发生变化/)
      assert.equal(ctx.docs.get(ctx.ids.longMdDoc)!.notes, '用户刚刚手写的重要补充')
    }
  },
  {
    id: 'C05', group: 'protected-fields', title: '整批原子性：批量修改第 2 项非法时第 1 项完全回滚不落盘', tools: ['archive_get', 'archive_update', 'archive_actions'],
    run: async ctx => {
      const d1 = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const d2 = await ctx.callTool('archive_get', { id: ctx.ids.todo })
      await ctx.callToolExpectError('archive_update', {
        changes: [
          { id: ctx.ids.pdfDoc, version: d1.version, patch: { notes: '不应提交的修改' } },
          { id: ctx.ids.todo, version: d2.version, patch: { notes: 'personal 不支持的字段' } },
        ],
        reason: '测试原子回滚'
      }, /不支持字段/)
      assert.equal(ctx.docs.get(ctx.ids.pdfDoc)!.notes, '')
      assert.equal((await ctx.callTool('archive_actions', {})).length, 0)
    }
  },
  {
    id: 'C06', group: 'protected-fields', title: '幂等重试：相同 patch 再次提交返回 changed=0 不产生重复操作记录', tools: ['archive_get', 'archive_update', 'archive_actions'],
    run: async ctx => {
      const s1 = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const r1 = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: s1.version, patch: { notes: '已核对一次' } }],
        reason: '首次整理'
      })
      assert.equal(r1.changed, 1)
      const s2 = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const r2 = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: s2.version, patch: { notes: '已核对一次' } }],
        reason: '重复提交'
      })
      assert.equal(r2.changed, 0)
      assert.equal((await ctx.callTool('archive_actions', {})).length, 1)
    }
  },
  {
    id: 'C07', group: 'protected-fields', title: '多轮：创建文库分类与分组并自动复用同名项，随后归类资料', tools: ['archive_create_category', 'archive_get', 'archive_update'],
    run: async ctx => {
      const cat1 = await ctx.callTool('archive_create_category', { kind: 'document_category', name: '技术规范', submodule: 'reading', behavior: 'reading', description: '工程标准' })
      const cat2 = await ctx.callTool('archive_create_category', { kind: 'document_category', name: '技术规范', submodule: 'reading' })
      assert.equal(cat1.created, true)
      assert.equal(cat2.created, false)
      assert.equal(cat1.item.id, cat2.item.id)
      const grp = await ctx.callTool('archive_create_category', { kind: 'document_group', name: '第一季度', submodule: 'reading', categoryId: cat1.item.id })
      const before = await ctx.callTool('archive_get', { id: ctx.ids.longMdDoc })
      await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.longMdDoc, version: before.version, patch: { type: cat1.item.id, customGroupId: grp.item.id } }],
        reason: '按新建分类与分组归档'
      })
      const after = await ctx.callTool('archive_get', { id: ctx.ids.longMdDoc })
      assert.equal(after.metadata.type, cat1.item.id)
      assert.equal(after.metadata.customGroupId, grp.item.id)
    }
  },
  {
    id: 'C08', group: 'protected-fields', title: '多轮：创建图片分类并把图片归入新分类', tools: ['archive_create_category', 'archive_get', 'archive_update'],
    run: async ctx => {
      const imgGrp = await ctx.callTool('archive_create_category', { kind: 'image_group', name: '精选画集', imageType: 'comic' })
      const before = await ctx.callTool('archive_get', { id: ctx.ids.image })
      await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.image, version: before.version, patch: { groupId: imgGrp.item.id, favorite: true } }],
        reason: '归入新画集分类'
      })
      const after = await ctx.callTool('archive_get', { id: ctx.ids.image })
      assert.equal(after.metadata.groupId, imgGrp.item.id)
      assert.equal(after.metadata.favorite, true)
    }
  },
  {
    id: 'C09', group: 'protected-fields', title: '跨品类修改软件/游戏/项目元数据并保留其他字段', tools: ['archive_get', 'archive_update'],
    run: async ctx => {
      const g = await ctx.callTool('archive_get', { id: ctx.ids.game })
      const p = await ctx.callTool('archive_get', { id: ctx.ids.project })
      const res = await ctx.callTool('archive_update', {
        changes: [
          { id: ctx.ids.game, version: g.version, patch: { notes: '已通关主线', tags: ['單機', 'RPG'] } },
          { id: ctx.ids.project, version: p.version, patch: { group: '核心研发', pinned: true } },
        ],
        reason: '跨品类补充元数据'
      })
      assert.equal(res.changed, 2)
      assert.equal((await ctx.callTool('archive_get', { id: ctx.ids.project })).metadata.pinned, true)
    }
  },
  {
    id: 'C10', group: 'protected-fields', title: '个人记录 data 修改需传完整对象并保留既有字段', tools: ['archive_get', 'archive_update'],
    run: async ctx => {
      const before = await ctx.callTool('archive_get', { id: ctx.ids.asset })
      await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.asset, version: before.version, patch: { data: { ...before.metadata.data, expiresOn: '2027-06-01' } } }],
        reason: '补充订阅到期日'
      })
      const after = await ctx.callTool('archive_get', { id: ctx.ids.asset })
      assert.equal(after.metadata.data.cost, 198)
      assert.equal(after.metadata.data.expiresOn, '2027-06-01')
    }
  },

  /* ===================== Group D: archive_undo 与操作历史回滚 (8 multi-turn cases) ===================== */
  {
    id: 'D01', group: 'undo-rollback', title: '多轮：修改文库元数据 -> 查询 actions -> archive_undo 完整恢复', tools: ['archive_get', 'archive_update', 'archive_actions', 'archive_undo'],
    run: async ctx => {
      const initial = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const mod = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: initial.version, patch: { notes: '临时备注', author: '临时作者' } }],
        reason: '临时标注'
      })
      const list = await ctx.callTool('archive_actions', {})
      assert.equal(list[0].id, mod.changes[0].id)
      const undone = await ctx.callTool('archive_undo', { id: list[0].id })
      assert.equal(undone.undone, true)
      const restored = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      assert.deepEqual(restored.metadata, initial.metadata)
      assert.deepEqual(restored.protectedFields, initial.protectedFields)
    }
  },
  {
    id: 'D02', group: 'undo-rollback', title: '重复撤销同一 action 幂等返回 undone=false', tools: ['archive_get', 'archive_update', 'archive_undo'],
    run: async ctx => {
      const initial = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const mod = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: initial.version, patch: { notes: '一次修改' } }],
        reason: '测试重复撤销'
      })
      assert.equal((await ctx.callTool('archive_undo', { id: mod.changes[0].id })).undone, true)
      const second = await ctx.callTool('archive_undo', { id: mod.changes[0].id })
      assert.equal(second.undone, false)
      assert.match(second.reason, /已经撤销/)
    }
  },
  {
    id: 'D03', group: 'undo-rollback', title: '后续发生人工手动修改时 archive_undo 保护现状不覆盖', tools: ['archive_get', 'archive_update', 'archive_undo'],
    run: async ctx => {
      const initial = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      const mod = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: initial.version, patch: { notes: '助理写入' } }],
        reason: '助理整理'
      })
      ctx.docs.update(ctx.ids.pdfDoc, { notes: '人工二次精修' })
      const res = await ctx.callTool('archive_undo', { id: mod.changes[0].id })
      assert.equal(res.undone, false)
      assert.match(res.reason, /后续修改/)
      assert.equal(ctx.docs.get(ctx.ids.pdfDoc)!.notes, '人工二次精修')
    }
  },
  {
    id: 'D04', group: 'undo-rollback', title: '多轮：新增个人记录 -> 去重拦截 -> archive_undo 删除新建记录并留痕', tools: ['archive_create_personal', 'archive_undo', 'archive_actions'],
    run: async ctx => {
      const payload = { kind: 'todo', name: '新增评测待办', body: '核对回滚', data: { dueOn: '2026-12-15', done: false } }
      const c1 = await ctx.callTool('archive_create_personal', payload)
      assert.equal(c1.created, true)
      const c2 = await ctx.callTool('archive_create_personal', payload)
      assert.equal(c2.created, false)
      const undo = await ctx.callTool('archive_undo', { id: c1.action.id })
      assert.equal(undo.undone, true)
      assert.equal(ctx.personal.get(c1.source.id), null)
      const acts = await ctx.callTool('archive_actions', {})
      assert.equal(acts.find((a: any) => a.id === c1.action.id).state, 'undone')
    }
  },
  {
    id: 'D05', group: 'undo-rollback', title: '已建立资源关联的新建个人资产撤销时受保护不强删', tools: ['archive_create_personal', 'archive_link', 'archive_undo'],
    run: async ctx => {
      const created = await ctx.callTool('archive_create_personal', { kind: 'asset', name: '待关联主机', data: { category: '设备' } })
      await ctx.callTool('archive_link', { action: 'add', owner: 'asset', ownerId: created.source.id, resourceId: ctx.ids.pdfDoc })
      const undo = await ctx.callTool('archive_undo', { id: created.action.id })
      assert.equal(undo.undone, false)
      assert.match(undo.reason, /关联/)
      assert.ok(ctx.personal.get(created.source.id))
    }
  },
  {
    id: 'D06', group: 'undo-rollback', title: '多轮：连续两次更新仅能按逆序撤销，旧步受保护防冲突', tools: ['archive_get', 'archive_update', 'archive_undo'],
    run: async ctx => {
      const s0 = await ctx.callTool('archive_get', { id: ctx.ids.longMdDoc })
      const a1 = (await ctx.callTool('archive_update', { changes: [{ id: ctx.ids.longMdDoc, version: s0.version, patch: { notes: '步骤一' } }], reason: 'r1' })).changes[0]
      const s1 = await ctx.callTool('archive_get', { id: ctx.ids.longMdDoc })
      const a2 = (await ctx.callTool('archive_update', { changes: [{ id: ctx.ids.longMdDoc, version: s1.version, patch: { notes: '步骤二' } }], reason: 'r2' })).changes[0]
      assert.equal((await ctx.callTool('archive_undo', { id: a1.id })).undone, false)
      assert.equal((await ctx.callTool('archive_undo', { id: a2.id })).undone, true)
      assert.equal((await ctx.callTool('archive_undo', { id: a1.id })).undone, true)
      assert.equal(ctx.docs.get(ctx.ids.longMdDoc)!.notes, '')
    }
  },
  {
    id: 'D07', group: 'undo-rollback', title: '把资源 ID 误传给 archive_undo 时明确报错', tools: ['archive_undo'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_undo', { id: ctx.ids.pdfDoc }, /操作记录.*不可用/)
    }
  },
  {
    id: 'D08', group: 'undo-rollback', title: '隐私范围隔离：完整范围下的操作记录在隐藏隐私模式下不可见且不可撤销', tools: ['archive_get', 'archive_update', 'archive_actions', 'archive_undo'],
    run: async ctx => {
      ctx.hideHentai = false
      const before = await ctx.callTool('archive_get', { id: ctx.ids.todo })
      const mod = await ctx.callTool('archive_update', {
        changes: [{ id: ctx.ids.todo, version: before.version, patch: { body: '完整范围修改' } }],
        reason: '隐私范围测试'
      }, { sessionId: 'private-session' })
      ctx.hideHentai = true
      assert.equal((await ctx.callTool('archive_actions', { sessionId: 'private-session' })).length, 0)
      await ctx.callToolExpectError('archive_undo', { id: mod.changes[0].id }, /不可用/)
    }
  },

  /* ===================== Group E: 真实文件批量整理、冲突与路径修复 (10 multi-turn cases) ===================== */
  {
    id: 'E01', group: 'file-organize', title: '多轮：archive_organize preview -> execute (copy) 保留源文件并落盘副本', tools: ['archive_organize'],
    run: async ctx => {
      const preview = await ctx.callTool('archive_organize', {
        action: 'preview', ids: [ctx.ids.conflictDoc], rootDir: ctx.paths.organizeRoot, mode: 'copy', useCustomGroups: true
      })
      assert.ok(preview.token && preview.items.length === 1)
      const exec = await ctx.callTool('archive_organize', { action: 'execute', token: preview.token })
      assert.equal(exec.succeeded, 1)
      assert.ok(await fs.stat(ctx.paths.conflictFile))
      assert.ok(await fs.stat(preview.items[0].destination))
    }
  },
  {
    id: 'E02', group: 'file-organize', title: '多轮：archive_organize move -> history -> undo 还原原路径', tools: ['archive_organize', 'archive_check'],
    run: async ctx => {
      const preview = await ctx.callTool('archive_organize', {
        action: 'preview', ids: [ctx.ids.conflictDoc], rootDir: ctx.paths.organizeRoot, mode: 'move', useCustomGroups: false
      })
      const exec = await ctx.callTool('archive_organize', { action: 'execute', token: preview.token })
      assert.equal(exec.succeeded, 1)
      await assert.rejects(fs.stat(ctx.paths.conflictFile))
      const history = await ctx.callTool('archive_organize', { action: 'history' })
      assert.ok(history.length >= 1)
      const opId = history[0].id
      await ctx.callTool('archive_organize', { action: 'undo', operationId: opId })
      assert.ok(await fs.stat(ctx.paths.conflictFile))
      const chk = await ctx.callTool('archive_check', { ids: [ctx.ids.conflictDoc] })
      assert.equal(chk.items[0].available, true)
    }
  },
  {
    id: 'E03', group: 'file-organize', title: '目标目录已存在同名冲突文件时 preview 明确标出冲突状态', tools: ['archive_organize'],
    run: async ctx => {
      const firstPreview = await ctx.callTool('archive_organize', {
        action: 'preview', ids: [ctx.ids.conflictDoc], rootDir: ctx.paths.organizeRoot, mode: 'copy', useCustomGroups: false
      })
      const targetPath = firstPreview.items[0].destination as string
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, '已占用的不同内容', 'utf8')
      const secondPreview = await ctx.callTool('archive_organize', {
        action: 'preview', ids: [ctx.ids.conflictDoc], rootDir: ctx.paths.organizeRoot, mode: 'copy', useCustomGroups: false
      })
      assert.equal(secondPreview.items[0].status, 'conflict')
      assert.ok(secondPreview.items[0].reason)
    }
  },
  {
    id: 'E04', group: 'file-organize', title: 'preview 后资料发生变动，再用旧 token execute 被拦截要求重新预览', tools: ['archive_organize'],
    run: async ctx => {
      const preview = await ctx.callTool('archive_organize', {
        action: 'preview', ids: [ctx.ids.conflictDoc], rootDir: ctx.paths.organizeRoot, mode: 'copy', useCustomGroups: false
      })
      ctx.docs.update(ctx.ids.conflictDoc, { type: 'paper' })
      await ctx.callToolExpectError('archive_organize', { action: 'execute', token: preview.token }, /重新预览/)
    }
  },
  {
    id: 'E05', group: 'file-organize', title: '未经 preview 直接传入虚假 token 执行 organize 被拒绝', tools: ['archive_organize'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_organize', { action: 'execute', token: 'fake-token' }, /请先预览/)
    }
  },
  {
    id: 'E06', group: 'file-organize', title: 'archive_organize 拒绝非文库资源（如项目/游戏）', tools: ['archive_organize'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_organize', {
        action: 'preview', ids: [ctx.ids.project], rootDir: ctx.paths.organizeRoot, mode: 'copy'
      }, /仅支持文库/)
    }
  },
  {
    id: 'E07', group: 'file-organize', title: 'archive_check 同时核验存在、离线与个人记录状态', tools: ['archive_check'],
    run: async ctx => {
      const res = await ctx.callTool('archive_check', { ids: [ctx.ids.pdfDoc, ctx.ids.missingDoc, ctx.ids.todo] })
      const byId = new Map(res.items.map((x: any) => [x.id, x]))
      assert.equal((byId.get(ctx.ids.pdfDoc) as any).available, true)
      assert.equal((byId.get(ctx.ids.missingDoc) as any).available, false)
      assert.equal((byId.get(ctx.ids.todo) as any).available, true)
    }
  },
  {
    id: 'E08', group: 'file-organize', title: '多轮：archive_check 发现缺失 -> archive_locate 寻找候选 -> archive_relocate 修复绑定 -> archive_read 成功', tools: ['archive_check', 'archive_locate', 'archive_relocate', 'archive_read'],
    run: async ctx => {
      const chk = await ctx.callTool('archive_check', { ids: [ctx.ids.missingDoc] })
      assert.equal(chk.items[0].available, false)
      const located = await ctx.callTool('archive_locate', { id: ctx.ids.missingDoc, directory: path.join(ctx.root, 'relocated-store') })
      assert.equal(located.matches.length, 1)
      assert.equal(located.matches[0].file, ctx.paths.movedFile)
      const reloc = await ctx.callTool('archive_relocate', { id: ctx.ids.missingDoc, file: located.matches[0].file })
      assert.equal(reloc.relocated, true)
      const text = await ctx.callTool('archive_read', { id: ctx.ids.missingDoc })
      assert.ok(text.text.includes('北斗七星'))
    }
  },
  {
    id: 'E09', group: 'file-organize', title: 'archive_locate 拒绝非文库资源', tools: ['archive_locate'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_locate', { id: ctx.ids.software, directory: ctx.root }, /文库/)
    }
  },
  {
    id: 'E10', group: 'file-organize', title: 'archive_organize recover 对不存在的 operationId 返回明确错误', tools: ['archive_organize'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_organize', { action: 'recover', operationId: 'non-existent-op' }, /文件操作不存在/)
    }
  },

  /* ===================== Group F: 跨库模糊检索、关联、技能、工作台、历史与公网搜索 (10 multi-turn cases) ===================== */
  {
    id: 'F01', group: 'cross-library', title: '跨库繁简模糊检索：简体关键词命中繁体软件/游戏/影视标题', tools: ['archive_search'],
    run: async ctx => {
      const s1 = await ctx.callTool('archive_search', { query: '繁体 编辑器' })
      assert.ok(s1.items.some((x: any) => x.id === ctx.ids.software), 'Simplified query must match 繁體編輯器')
      const s2 = await ctx.callTool('archive_search', { query: '龙之传说' })
      assert.ok(s2.items.some((x: any) => x.id === ctx.ids.game), 'Simplified query must match 龍之傳說')
      const s3 = await ctx.callTool('archive_search', { query: '纪录片' })
      assert.ok(s3.items.some((x: any) => x.id === ctx.ids.video), 'Simplified query must match 紀錄片')
    }
  },
  {
    id: 'F02', group: 'cross-library', title: '跨库检索按 kinds 精准过滤且遵循隐私隐藏范围', tools: ['archive_search', 'archive_get'],
    run: async ctx => {
      const pub = await ctx.callTool('archive_search', { query: '里番', kinds: ['video'] })
      assert.equal(pub.items.length, 0)
      await ctx.callToolExpectError('archive_get', { id: ctx.ids.hiddenVideo }, /不可用/)
      ctx.hideHentai = false
      const all = await ctx.callTool('archive_search', { query: '里番', kinds: ['video'] })
      assert.ok(all.items.some((x: any) => x.id === ctx.ids.hiddenVideo))
    }
  },
  {
    id: 'F03', group: 'cross-library', title: 'archive_search 分页 offset/limit/next 一致性校验', tools: ['archive_search'],
    run: async ctx => {
      const p1 = await ctx.callTool('archive_search', { limit: 3, offset: 0 })
      assert.equal(p1.items.length, 3)
      assert.equal(p1.next, 3)
      const p2 = await ctx.callTool('archive_search', { limit: 3, offset: p1.next })
      assert.equal(p2.items.length, 3)
      assert.notEqual(p1.items[0].id, p2.items[0].id)
    }
  },
  {
    id: 'F04', group: 'cross-library', title: 'archive_catalog 返回所有品类的分类与分组字典', tools: ['archive_catalog'],
    run: async ctx => {
      const cat = await ctx.callTool('archive_catalog', {})
      assert.ok(cat.documentCategories.length >= 7)
      assert.ok(Array.isArray(cat.documentGroups))
      assert.ok(Array.isArray(cat.imageGroups))
      assert.ok(Array.isArray(cat.categories) && cat.categories.length > 0)
    }
  },
  {
    id: 'F05', group: 'cross-library', title: 'archive_project_workbench 只读返回便签、关键 Prompt 与规则链接', tools: ['archive_project_workbench'],
    run: async ctx => {
      const wb = await ctx.callTool('archive_project_workbench', { id: ctx.ids.project })
      assert.equal(wb.context.current, '正在推进归档评测')
      assert.equal(wb.context.prompt, '先读工具再执行')
      assert.ok(Array.isArray(wb.context.rules) && wb.context.rules.length === 1)
    }
  },
  {
    id: 'F06', group: 'cross-library', title: '多轮：archive_link 建立项目与文库关联 -> 列出 -> 移除', tools: ['archive_link'],
    run: async ctx => {
      const added = await ctx.callTool('archive_link', { action: 'add', owner: 'project', ownerId: ctx.ids.project, resourceId: ctx.ids.pdfDoc })
      assert.ok(added.id)
      const listed = await ctx.callTool('archive_link', { action: 'list', owner: 'project', ownerId: ctx.ids.project })
      assert.ok(listed.some((l: any) => l.id === added.id && l.resourceId === ctx.ids.pdfDoc))
      const removed = await ctx.callTool('archive_link', { action: 'remove', owner: 'project', ownerId: ctx.ids.project, linkId: added.id })
      assert.equal(removed.removed, true)
      const after = await ctx.callTool('archive_link', { action: 'list', owner: 'project', ownerId: ctx.ids.project })
      assert.equal(after.some((l: any) => l.id === added.id), false)
    }
  },
  {
    id: 'F07', group: 'cross-library', title: '多轮：archive_skill 提出技能卡草案 -> list 查看草案 -> 不冒充已确认卡', tools: ['archive_skill'],
    run: async ctx => {
      const prop = await ctx.callTool('archive_skill', {
        action: 'propose',
        input: {
          name: '系统架构评审',
          summary: '定期核对模块边界与数据迁移安全',
          metrics: [{ key: 'reviews', label: '评审次数', unit: '次', type: 'number' }]
        }
      })
      assert.ok(prop.id)
      const listed = await ctx.callTool('archive_skill', { action: 'list' })
      assert.ok(listed.proposals.some((p: any) => p.id === prop.id))
      assert.equal(listed.cards.length, 0, 'proposal must remain a draft, not a confirmed card')
    }
  },
  {
    id: 'F08', group: 'cross-library', title: '多轮：archive_create_personal 创建 metric 测量值并写入关联', tools: ['archive_create_personal', 'archive_search'],
    run: async ctx => {
      const m = await ctx.callTool('archive_create_personal', {
        kind: 'measurement', name: '本周阅读统计', body: '完成长手册精读',
        data: { metricId: ctx.ids.metric, value: 120, date: '2026-11-21' }
      })
      assert.equal(m.created, true)
      assert.equal(m.source.metadata.data.value, 120)
      const found = await ctx.callTool('archive_search', { query: '本周阅读统计', kinds: ['personal'] })
      assert.ok(found.items.some((x: any) => x.id === m.source.id))
    }
  },
  {
    id: 'F09', group: 'cross-library', title: 'archive_history 隐私模式下返回说明，开放后可搜索并按 id+kind 读原会话', tools: ['archive_history'],
    run: async ctx => {
      const hidden = await ctx.callTool('archive_history', { query: '合同' })
      assert.equal(hidden.items.length, 0)
      assert.match(hidden.reason, /隐私/)
      ctx.hideHentai = false
      const list = await ctx.callTool('archive_history', { query: '合同', kind: 'workspace' })
      assert.equal(list.items.length, 1)
      const full = await ctx.callTool('archive_history', { id: 'legacy-ws-1', kind: 'workspace' })
      assert.equal(full.items.length, 1)
      assert.ok(Array.isArray(full.items[0].history) && full.items[0].history.length === 2)
    }
  },
  {
    id: 'F10', group: 'cross-library', title: 'archive_web_search 拦截本地路径泄露且未配置搜索服务时给出明确原因', tools: ['archive_web_search'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_web_search', { query: 'C:\\Users\\alice\\secret.pdf' }, /不要包含本地路径/)
      await ctx.callToolExpectError('archive_web_search', { query: '/Users/alice/notes.md' }, /不要包含本地路径/)
      await ctx.callToolExpectError('archive_web_search', { query: 'SQLite WAL mode official docs' }, /未启用或配置不完整/)
    }
  },

  /* ===================== Group G: 非法参数容错与 22 工具 Schema/Prompt 质量门禁 (8 cases) ===================== */
  {
    id: 'G01', group: 'invalid-params', title: '未知工具名明确报错', tools: [],
    run: async ctx => {
      await ctx.callToolExpectError('archive_nonexistent_tool', {}, /未知归档工具/)
    }
  },
  {
    id: 'G02', group: 'invalid-params', title: 'archive_update 拒绝重复 ID、空批次、超长字符串及越权字段', tools: ['archive_get', 'archive_update'],
    run: async ctx => {
      const s = await ctx.callTool('archive_get', { id: ctx.ids.pdfDoc })
      await ctx.callToolExpectError('archive_update', { changes: [], reason: '空批' }, /1–100/)
      await ctx.callToolExpectError('archive_update', {
        changes: [
          { id: ctx.ids.pdfDoc, version: s.version, patch: { notes: 'a' } },
          { id: ctx.ids.pdfDoc, version: s.version, patch: { notes: 'b' } },
        ],
        reason: '重复 ID'
      }, /重复修改/)
      await ctx.callToolExpectError('archive_update', {
        changes: [{ id: ctx.ids.pdfDoc, version: s.version, patch: { path: 'D:/hacked.pdf' } }],
        reason: '越权字段'
      }, /不支持字段/)
    }
  },
  {
    id: 'G03', group: 'invalid-params', title: 'archive_create_personal 拒绝无效类型及缺失 metricId 的 measurement', tools: ['archive_create_personal'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_create_personal', { kind: 'skill', name: '应走 archive_skill' }, /支持的个人记录类型/)
      await ctx.callToolExpectError('archive_create_personal', { kind: 'measurement', name: '缺少指标', data: { value: 10 } }, /指标|metric/i)
    }
  },
  {
    id: 'G04', group: 'invalid-params', title: 'archive_project_files / archive_project_search 拦截路径穿越与非项目资源', tools: ['archive_project_files', 'archive_project_search'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_project_files', { id: ctx.ids.pdfDoc }, /项目资源/)
      await ctx.callToolExpectError('archive_project_search', { id: ctx.ids.project, path: '../../etc/passwd', query: 'root' }, /目录|路径|不能|超出/)
    }
  },
  {
    id: 'G05', group: 'invalid-params', title: 'archive_organize / archive_link / archive_skill 拒绝非法 action 与缺失模式', tools: ['archive_organize', 'archive_link', 'archive_skill'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_organize', { action: 'delete_all' }, /操作无效/)
      await ctx.callToolExpectError('archive_organize', { action: 'preview', ids: [ctx.ids.pdfDoc], rootDir: ctx.paths.organizeRoot, mode: 'symlink' }, /移动或复制/)
      await ctx.callToolExpectError('archive_link', { action: 'merge', owner: 'project', ownerId: ctx.ids.project }, /关联操作无效/)
      await ctx.callToolExpectError('archive_skill', { action: 'delete' }, /技能操作无效/)
    }
  },
  {
    id: 'G06', group: 'invalid-params', title: 'archive_read 拒绝不存在的资源与非文本/项目路径越界', tools: ['archive_read'],
    run: async ctx => {
      await ctx.callToolExpectError('archive_read', { id: 'missing-resource-id' }, /不可用|不存在/)
      await ctx.callToolExpectError('archive_read', { id: ctx.ids.project, path: '../docs/long-design-notes.md' }, /目录|路径|超出|不能/)
    }
  },
  {
    id: 'G07', group: 'schema-quality', title: '22 工具 Schema 严格性审计：名称唯一、边界约束、additionalProperties: false 与关键提示完整', tools: [],
    run: () => {
      assert.equal(ARCHIVE_TOOLS.length, 22, `Expected 22 tools, got ${ARCHIVE_TOOLS.length}`)
      assert.equal(TOOL_MAP.size, 22, 'All 22 tool names must be unique')

      // Check strict bounds on key tools so models don't emit out-of-range args
      const searchProps = (TOOL_MAP.get('archive_search')!.parameters as any).properties
      assert.equal(searchProps.offset.minimum, 0, 'archive_search.offset must specify minimum: 0')
      assert.equal(searchProps.limit.minimum, 1, 'archive_search.limit must specify minimum: 1')
      assert.equal(searchProps.limit.maximum, 100, 'archive_search.limit must specify maximum: 100')

      const readProps = (TOOL_MAP.get('archive_read')!.parameters as any).properties
      assert.equal(readProps.line.minimum, 1, 'archive_read.line must specify minimum: 1')
      assert.equal(readProps.page.minimum, 1, 'archive_read.page must specify minimum: 1')

      const updateParams = TOOL_MAP.get('archive_update')!.parameters as any
      assert.equal(updateParams.properties.changes.items.additionalProperties, false, 'archive_update.changes.items must set additionalProperties: false')
      assert.equal(updateParams.properties.changes.items.properties.patch.additionalProperties, false, 'archive_update patch must set additionalProperties: false')

      const checkProps = (TOOL_MAP.get('archive_check')!.parameters as any).properties
      assert.equal(checkProps.ids.minItems, 1, 'archive_check.ids must require minItems: 1')

      // Schema must reject unknown patch key at validation layer too
      const badPatchErrs = validateAgainstSchema(
        { changes: [{ id: 'x', version: 'v1', patch: { path: 'C:/bad' } }], reason: 'test' },
        updateParams
      )
      assert.ok(badPatchErrs.length > 0, 'archive_update schema must reject unknown patch field `path`')
    }
  },
  {
    id: 'G08', group: 'schema-quality', title: '22 工具描述与 ARCHIVE_SYSTEM 关键消歧规则审计', tools: [],
    run: () => {
      assert.match(TOOL_MAP.get('archive_get')!.description, /protectedFields/, 'archive_get description must document protectedFields')
      assert.match(TOOL_MAP.get('archive_undo')!.description, /操作.*ID|action/i, 'archive_undo description must clarify id is action ID, not resource ID')
      assert.match(TOOL_MAP.get('archive_organize')!.description, /operationId|preview.*token/, 'archive_organize description must clarify action parameters')
      assert.match(TOOL_MAP.get('archive_read')!.description, /cursor/, 'archive_read description must clarify cursor continuation')
      assert.match(ARCHIVE_SYSTEM, /protectedFields/)
      assert.match(ARCHIVE_SYSTEM, /archive_undo/)
      assert.match(ARCHIVE_SYSTEM, /json-fragment/)
    }
  },
]
