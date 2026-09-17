import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { createVideoAgentOrganizer } from '../electron/kinds/video/agent-organize.ts'
import { videoImportLibraryStamp } from '../electron/kinds/video/import-command.ts'
import { listVideoOrganizeJournal } from '../electron/kinds/video/organize.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { runAgent, type AgentRunOptions, type AgentRunResult } from '../electron/services/agent/loop.ts'
import type { VideoAgentActions, VideoAgentProgress } from '../src/types/video-agent-organize.ts'

const actions: VideoAgentActions = { merge: true, artwork: false, metadata: false, transfer: 'none' }
const result = (text = '', stopReason: AgentRunResult['stopReason'] = 'done'): AgentRunResult => ({ text, stopReason, tokens: 17, turns: 1, error: '' })
type InputWork = { id: string; title: string; series: { title: string; season: number; number: number } }
const inputWorks = (options: AgentRunOptions): InputWork[] => JSON.parse(options.user)
function proposals(options: AgentRunOptions) {
  const families = new Map<string, string[]>()
  for (const work of inputWorks(options)) families.set(work.series.title, [...(families.get(work.series.title) || []), work.id])
  return { groups: [...families.values()].filter(ids => ids.length > 1).map(resourceIds => ({ resourceIds, reason: 'Same series, distinct episodes' })) }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-grouping-regression-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  const work = (title: string, count = 1) => registerVideoContent(db, { title, category: '动画', items: Array.from({ length: count }, (_, i) => {
    const file = path.join(root, title, `episode-${i + 1}.mp4`)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic media')
    return { title: count === 1 ? title : `Episode ${i + 1}`, order: i + 1, number: i + 1, files: [{ path: file }] }
  }) }).resourceId
  const progress: VideoAgentProgress[] = [], enriched: string[] = []
  const make = (agent: (options: AgentRunOptions) => Promise<AgentRunResult>, changed?: (id: string) => void) => createVideoAgentOrganizer({ db,
    config: () => ({ enabled: true, api_key: 'synthetic-only', api_url: 'http://127.0.0.1', model: 'fixture' }), root: () => '', runAgent: agent,
    changed, progress: value => progress.push(value), enrich: async id => { enriched.push(id); return { tokens: 0, ok: true, message: 'Fixture artwork' } } })
  return { db, root, work, progress, enriched, make, close: () => {
    db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true })
  } }
}
let passed = 0, failed = 0
async function test(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++; console.log('PASS ' + name) }
  catch (cause) { failed++; console.error('FAIL ' + name + ': ' + (cause instanceof Error ? cause.message : cause)) }
  finally { f.close() }
}

await test('137 selections use bounded sequential series batches without writes before confirmation', async f => {
  const ids: string[] = [], candidateIds: string[] = []
  const sizes = [6, 4, 4, 3, 3, ...Array(24).fill(2)]
  sizes.forEach((count, series) => { for (let n = 1; n <= count; n++) candidateIds.push(f.work(`Series ${series + 1} E${String(n).padStart(2, '0')}`)) })
  ids.push(...candidateIds)
  for (let i = 0; i < 9; i++) ids.push(f.work(`Existing ${i} E01`, 2))
  for (let i = 0; i < 60; i++) ids.push(f.work(i < 9 ? `Existing ${i} E03` : `Independent [${i}]`))
  assert.equal(ids.length, 137)
  const batches: InputWork[][] = []; let active = 0, peak = 0
  const manager = f.make(async options => {
    active++; peak = Math.max(peak, active)
    const batch = inputWorks(options); batches.push(batch)
    assert.ok(batch.length <= 24, 'one request must not contain all 137 selections')
    assert.ok(batch.every(work => /^w\d+$/.test(work.id)), 'model receives short references, not database UUIDs')
    assert.ok(!options.user.includes(f.root), 'local paths are unnecessary for grouping')
    await options.tools[0].execute(proposals(options)); active--; return result()
  })
  const before = videoImportLibraryStamp(f.db), plan = await manager.prepare(ids, actions)
  assert.equal(plan.groups.length, 29); assert.equal(plan.works.length, 137); assert.equal(peak, 1)
  assert.ok(batches.length > 1); assert.equal(batches.flat().length, 68)
  assert.deepEqual(plan.groups.flatMap(group => group.resourceIds).sort(), candidateIds.sort())
  assert.equal(plan.tokens, batches.length * 17); assert.equal(plan.groupingStatus, 'complete')
  assert.equal(videoImportLibraryStamp(f.db), before); assert.equal(listVideoOrganizeJournal(f.db).length, 0)
})

await test('one invalid proposal cannot discard valid groups or claim their members', async f => {
  const ids = ['First E01', 'First E02', 'Second E01', 'Second E02'].map(title => f.work(title))
  const manager = f.make(async options => {
    const [a, b, c, d] = inputWorks(options).map(work => work.id)
    await options.tools[0].execute({ groups: [
      { resourceIds: [a, 'outside-selection'], reason: 'Invalid reference' },
      { resourceIds: [a, b], reason: 'Valid first family' },
      { resourceIds: [b, c], reason: 'Duplicate assignment' },
      { resourceIds: [c, d], reason: 'Valid second family' }
    ] }); return result()
  })
  const before = videoImportLibraryStamp(f.db), plan = await manager.prepare(ids, actions)
  assert.equal(plan.groups.length, 2); assert.equal(plan.groupingStatus, 'partial')
  assert.ok(plan.warnings.some(message => /本批|本次所选/.test(message)))
  assert.ok(plan.warnings.some(message => /重复/.test(message)))
  assert.equal(new Set(plan.groups.flatMap(group => group.resourceIds)).size, 4)
  assert.equal(videoImportLibraryStamp(f.db), before)
})

await test('unrelated titles and duplicated episode numbers cannot form a collection', async f => {
  const ids = ['First E01', 'First E02', 'Second E01', 'Second E02', 'First EP01'].map(title => f.work(title))
  const manager = f.make(async options => {
    const ref = (title: string) => inputWorks(options).find(work => work.title === title)!.id
    await options.tools[0].execute({ groups: [
      { resourceIds: [ref('First E01'), ref('Second E02')], reason: 'Same author is not sufficient' },
      { resourceIds: [ref('First E01'), ref('First EP01')], reason: 'Two encodes of episode one' }
    ] }); return result()
  })
  const before = videoImportLibraryStamp(f.db), plan = await manager.prepare(ids, actions)
  assert.equal(plan.groups.length, 0); assert.equal(plan.groupingStatus, 'failed')
  assert.ok(plan.warnings.some(message => /系列名|不同集数/.test(message)))
  assert.equal(videoImportLibraryStamp(f.db), before)
})

await test('text-only replies retain diagnostics and do not block the selected artwork action', async f => {
  const ids = [f.work('Morning E01'), f.work('Morning E02')]
  const manager = f.make(async () => result('我检查了这两项，但未提供结构化结果。'))
  const before = videoImportLibraryStamp(f.db), plan = await manager.prepare(ids, { ...actions, artwork: true })
  assert.equal(plan.groupingStatus, 'failed'); assert.equal(plan.groups.length, 0)
  assert.match(plan.warnings.join('\n'), /未提交|没有提交/); assert.match(plan.log, /我检查了这两项/)
  assert.match(f.progress.map(value => value.log || '').join('\n'), /未提交|没有提交/)
  assert.equal(videoImportLibraryStamp(f.db), before)
  await manager.run(plan.id, []); assert.deepEqual(f.enriched, ids)
})

await test('whole JSON and fenced JSON replies pass the identical grouping validator', async f => {
  const ids = [f.work('Morning E01'), f.work('Morning E02')]
  for (const fence of [false, true]) {
    const manager = f.make(async options => { const json = JSON.stringify(proposals(options)); return result(fence ? '```json\n' + json + '\n```' : json) })
    const plan = await manager.prepare(ids, actions)
    assert.equal(plan.groups.length, 1); assert.equal(plan.groupingStatus, 'complete'); assert.match(plan.log, /JSON/)
  }
  const manager = f.make(async options => result('建议如下：' + JSON.stringify(proposals(options))))
  assert.equal((await manager.prepare(ids, actions)).groupingStatus, 'failed', 'do not scrape arbitrary prose into a merge')
})

await test('model tool errors and max-turns survive in both preview and task progress logs', async f => {
  const ids = [f.work('Morning E01'), f.work('Morning E02')]
  const manager = f.make(async options => {
    options.onEvent?.({ type: 'tool_result', name: 'propose_collections', text: '错误：参数不是合法的 JSON', isError: true })
    return result('', 'max_turns')
  })
  const plan = await manager.prepare(ids, actions)
  assert.equal(plan.groupingStatus, 'failed')
  for (const log of [plan.log, f.progress.map(value => value.log || '').join('\n')]) {
    assert.match(log, /不是合法的 JSON/); assert.match(log, /max_turns|轮数上限/)
  }
})

await test('a rejected submission returns its exact validation error so the model can correct it', async f => {
  const ids = [f.work('Morning E01'), f.work('Morning E02')]
  const manager = f.make(async options => {
    const first = inputWorks(options)[0].id
    await assert.rejects(options.tools[0].execute({ groups: [{ resourceIds: [first, 'outside-selection'], reason: 'Wrong reference' }] }), /本批所选/)
    await options.tools[0].execute(proposals(options))
    return result()
  })
  const plan = await manager.prepare(ids, actions)
  assert.equal(plan.groups.length, 1); assert.equal(plan.groupingStatus, 'complete'); assert.equal(plan.warnings.length, 0)
  assert.match(plan.log, /本批所选/)
})

await test('a failed batch preserves suggestions from subsequent batches', async f => {
  const ids = Array.from({ length: 13 }, (_, i) => [f.work(`Batch ${i} E01`), f.work(`Batch ${i} E02`)]).flat()
  let requests = 0
  const manager = f.make(async options => { if (++requests === 1) throw new Error('测试连接中断'); await options.tools[0].execute(proposals(options)); return result() })
  const plan = await manager.prepare(ids, actions)
  assert.equal(requests, 2); assert.equal(plan.groups.length, 1); assert.equal(plan.groupingStatus, 'partial')
  assert.match(plan.log, /测试连接中断/); assert.match(plan.warnings.join('\n'), /第 1/)
})

await test('one large series remains one reviewed collection across bounded overlapping batches', async f => {
  const ids = Array.from({ length: 49 }, (_, i) => f.work(`Long Series E${String(i + 1).padStart(2, '0')}`))
  let requests = 0
  const manager = f.make(async options => {
    requests++; assert.ok(inputWorks(options).length <= 24)
    await options.tools[0].execute(proposals(options)); return result()
  })
  const plan = await manager.prepare(ids, actions)
  assert.equal(requests, 3); assert.equal(plan.groups.length, 1)
  assert.deepEqual(plan.groups[0].resourceIds.slice().sort(), ids.slice().sort()); assert.equal(plan.groups[0].preview.episodes.length, 49)
})

await test('no local series candidates is different from an Agent failure and needs no request', async f => {
  const ids = [f.work('Unrelated Alpha'), f.work('Unrelated Beta')]
  const plan = await f.make(async () => { throw new Error('should not contact model') }).prepare(ids, actions)
  assert.equal(plan.groupingStatus, 'no-candidates'); assert.equal(plan.warnings.length, 0); assert.equal(plan.tokens, 0)
})

await test('library refresh after each applied group does not invalidate the rest of the confirmed batch', async f => {
  const ids = Array.from({ length: 3 }, (_, i) => [f.work(`Refresh ${i} E01`), f.work(`Refresh ${i} E02`)]).flat()
  ids.forEach(id => getVideoWorkLibrary(f.db, id))
  const manager = f.make(async options => { await options.tools[0].execute(proposals(options)); return result() },
    () => ids.forEach(id => getVideoWorkLibrary(f.db, id)))
  const plan = await manager.prepare(ids, actions), applied = await manager.run(plan.id, plan.groups.map(group => group.id))
  assert.equal(applied.outcomes.length, 3); assert.ok(applied.outcomes.every(outcome => outcome.ok), JSON.stringify(applied.outcomes))
})

await test('cancelling a grouping request stops subsequent batches and leaves the library intact', async f => {
  const ids = Array.from({ length: 13 }, (_, i) => [f.work(`Cancel ${i} E01`), f.work(`Cancel ${i} E02`)]).flat()
  let requests = 0
  const manager = f.make(async () => { requests++; manager.cancel(); return result('', 'aborted') })
  const before = videoImportLibraryStamp(f.db)
  await assert.rejects(manager.prepare(ids, actions), /停止|取消/)
  assert.equal(requests, 1); assert.equal(videoImportLibraryStamp(f.db), before); assert.equal(manager.busy(), false)
})

async function modelFixture(run: (config: AgentRunOptions['config'], requests: any[]) => Promise<void>, invalidFirst = false) {
  const requests: any[] = []
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => {
      requests.push(JSON.parse(body))
      const turn = requests.length, done = turn > (invalidFirst ? 2 : 1)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: done ? { content: 'Finished' } : { content: null, tool_calls: [
        { id: 'call-' + turn, type: 'function', function: { name: 'submit', arguments: invalidFirst && turn === 1 ? '{broken' : '{"ok":true}' } }
      ] } }], usage: { total_tokens: 5 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run({ enabled: true, api_key: 'synthetic-only', model: 'fixture', api_url: 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port }, requests) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
const tool = { name: 'submit', description: 'Submit', parameters: { type: 'object', properties: { ok: { type: 'boolean' } } }, execute: async () => 'Accepted' }
await test('required tool submission stops immediately after success without a needless follow-up request', async () => {
  await modelFixture(async (config, requests) => {
    const completed = await runAgent({ config, system: 'Fixture', user: 'Submit', tools: [tool], toolChoice: 'required', stopAfterToolSuccess: 'submit' } as AgentRunOptions)
    assert.equal(requests[0].tool_choice, 'required'); assert.equal(requests.length, 1); assert.equal(completed.turns, 1)
    assert.equal(completed.stopReason, 'done'); assert.equal(completed.tokens, 5)
  })
})
await test('required submission still feeds invalid arguments back for correction before stopping', async () => {
  await modelFixture(async (config, requests) => {
    const completed = await runAgent({ config, system: 'Fixture', user: 'Submit', tools: [tool], toolChoice: 'required', stopAfterToolSuccess: 'submit' } as AgentRunOptions)
    assert.equal(requests.length, 2); assert.match(requests[1].messages.find((message: any) => message.role === 'tool').content, /JSON/)
    assert.equal(completed.stopReason, 'done')
  }, true)
})
await test('other Agent callers retain the default automatic tool and follow-up behavior', async () => {
  await modelFixture(async (config, requests) => {
    const completed = await runAgent({ config, system: 'Fixture', user: 'Submit', tools: [tool] })
    assert.equal(requests[0].tool_choice, 'auto'); assert.equal(requests.length, 2); assert.equal(completed.text, 'Finished')
  })
})

console.log(`Video Agent grouping: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
