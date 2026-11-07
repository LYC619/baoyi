import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { createWorkspaceAgent } from '../electron/workspace/agent.ts'
import { clearSearchCache } from '../electron/services/searchService.ts'
import type { SearchConfig } from '../src/types/index.ts'

test('document assistant web_search tool injection and search configuration states', async (t) => {
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  t.after(() => db.close())

  let currentSearchConfig: SearchConfig = {
    enabled: false,
    provider: 'tavily',
    api_key: '',
    endpoint: ''
  }

  let capturedTools: any[] = []
  const manager = createWorkspaceAgent({
    db,
    config: () => ({ enabled: true, api_key: 'test', api_url: 'http://test', model: 'test' }),
    searchConfig: () => currentSearchConfig,
    run: async (opts) => {
      capturedTools = opts.tools
      return { stopReason: 'done', text: '完成', turns: 1, tokens: 10, error: '' }
    }
  })

  const session = manager.create('document')
  await manager.send(session.id, '请帮我补全书籍信息')

  const webSearchTool = capturedTools.find((t) => t.name === 'web_search')
  assert.ok(webSearchTool, 'web_search 工具必须注册在资料助手中')

  // 1. Disabled
  const resDisabled = JSON.parse(await webSearchTool.execute({ query: '三体 刘慈欣' }))
  assert.equal(resDisabled.ok, false)
  assert.equal(resDisabled.reason, 'disabled')
  assert.ok(resDisabled.error.includes('设置 - 全局设置 - 网络搜索'))

  // 2. Model builtin
  currentSearchConfig = { enabled: true, provider: 'model_builtin', api_key: '', endpoint: '' }
  const resBuiltin = JSON.parse(await webSearchTool.execute({ query: '三体 刘慈欣' }))
  assert.equal(resBuiltin.ok, false)
  assert.equal(resBuiltin.reason, 'model_builtin')
  assert.ok(resBuiltin.error.includes('不额外联网'))

  // 3. Missing credentials
  currentSearchConfig = { enabled: true, provider: 'tavily', api_key: '', endpoint: '' }
  const resMissing = JSON.parse(await webSearchTool.execute({ query: '三体 刘慈欣' }))
  assert.equal(resMissing.ok, false)
  assert.equal(resMissing.reason, 'missing_credentials')
  assert.ok(resMissing.error.includes('Tavily'))

  // 4. Privacy leak protection (reject paths)
  currentSearchConfig = { enabled: true, provider: 'tavily', api_key: 'tvly-test', endpoint: '' }
  await assert.rejects(webSearchTool.execute({ query: 'C:\\Users\\admin\\SecretNovel.txt' }), /本地文件路径/)
  await assert.rejects(webSearchTool.execute({ query: '/home/user/document.pdf' }), /本地文件路径/)
})

test('document assistant web_search turn limit and cache behavior', async (t) => {
  clearSearchCache()
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  t.after(() => db.close())

  let mockNetworkSearches = 0
  const searchConfig: SearchConfig = {
    enabled: true,
    provider: 'searxng',
    api_key: '',
    endpoint: 'http://127.0.0.1:9999' // mock endpoint
  }

  // Intercept global fetch to simulate search hits
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: any) => {
    mockNetworkSearches++
    return {
      ok: true,
      json: async () => ({
        results: [
          { title: '三体 - 维基百科', url: 'https://zh.wikipedia.org/wiki/三体', content: '刘慈欣创作的长篇科幻小说' }
        ]
      })
    } as any
  }) as any
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  let toolResults: any[] = []
  const manager = createWorkspaceAgent({
    db,
    config: () => ({ enabled: true, api_key: 'test', api_url: 'http://test', model: 'test' }),
    searchConfig: () => searchConfig,
    run: async (opts) => {
      const tool = opts.tools.find((t) => t.name === 'web_search')!
      // Call 1: new query
      toolResults.push(JSON.parse(await tool.execute({ query: '三体' })))
      // Call 2: repeated query (should hit cache, not increment turn count or network count)
      toolResults.push(JSON.parse(await tool.execute({ query: '三体' })))
      // Call 3: new query
      toolResults.push(JSON.parse(await tool.execute({ query: '黑暗森林' })))
      // Call 4: new query
      toolResults.push(JSON.parse(await tool.execute({ query: '死神永生' })))
      // Call 5: exceeds 3 turn searches limit
      toolResults.push(JSON.parse(await tool.execute({ query: '超新星纪元' })))
      return { stopReason: 'done', text: '检索完毕', turns: 1, tokens: 50, error: '' }
    }
  })

  const session = manager.create('document')
  await manager.send(session.id, '查一下刘慈欣的书')

  assert.equal(toolResults[0].ok, true)
  assert.equal(toolResults[0].cached, false)
  assert.equal(toolResults[0].results.length, 1)

  // Repeated call hit cache
  assert.equal(toolResults[1].ok, true)
  assert.equal(toolResults[1].cached, true)

  assert.equal(toolResults[2].ok, true)
  assert.equal(toolResults[3].ok, true)

  // 4th un-cached search in this turn should be blocked by limit
  assert.equal(toolResults[4].ok, false)
  assert.equal(toolResults[4].limitReached, true)
  assert.ok(toolResults[4].error.includes('单轮调用上限'))

  // Exactly 3 network requests were sent
  assert.equal(mockNetworkSearches, 3)
})

test('book metadata update protects human edited fields and tracks proposals', async (t) => {
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  t.after(() => db.close())

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-book-meta-'))
  t.after(async () => {
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })

  const filePath = path.join(root, 'santi.txt')
  await fs.writeFile(filePath, '三体小说正文')

  const docs = new DocumentLibrary(db)
  const item = await docs.register(filePath, 'book', false, 'reading')

  let updateTool: any
  const manager = createWorkspaceAgent({
    db,
    config: () => ({ enabled: true, api_key: 'test', api_url: 'http://test', model: 'test' }),
    run: async (opts) => {
      updateTool = opts.tools.find((t) => t.name === 'update_document_metadata')
      return { stopReason: 'done', text: '完成', turns: 1, tokens: 10, error: '' }
    }
  })

  const session = manager.create('document')
  await manager.send(session.id, '测试准备')

  // Step 1: Update unedited fields automatically applied
  const update1 = JSON.parse(
    await updateTool.execute({
      id: item.id,
      patch: {
        author: '刘慈欣',
        notes: '科幻小说巨作',
        tags: ['科幻', '雨果奖']
      }
    })
  )
  assert.equal(update1.state, 'applied', '未被人为锁定的字段应直接应用')

  const docAfter1 = docs.get(item.id)!
  assert.equal(docAfter1.author, '刘慈欣')
  assert.equal(docAfter1.notes, '科幻小说巨作')
  assert.equal(docAfter1.readState, 'unread')
  assert.deepEqual(docAfter1.tags, ['科幻', '雨果奖', '未读'], '保留分类已有的阅读状态展示标签')

  // Step 2: Simulate human editing the author field
  docs.update(item.id, { author: '刘慈欣（经人工校对）' })
  db.prepare('UPDATE document_meta SET edited_fields=? WHERE resource_id=?').run(
    JSON.stringify(['author']),
    item.id
  )

  // Step 3: Assistant attempts to overwrite the author field with web search result
  const update2 = JSON.parse(
    await updateTool.execute({
      id: item.id,
      patch: {
        author: '刘慈欣 Cixin Liu'
      }
    })
  )
  assert.equal(update2.state, 'proposed', '人工修改过的字段必须生成待确认建议，不得静默覆盖')

  // The actual document author remains untouched
  const docAfter2 = docs.get(item.id)!
  assert.equal(docAfter2.author, '刘慈欣（经人工校对）')

  // User applies the proposal
  const applied = manager.apply(session.id, update2.id)
  assert.equal(applied.state, 'applied')
  const docAfter3 = docs.get(item.id)!
  assert.equal(docAfter3.author, '刘慈欣 Cixin Liu')
})
