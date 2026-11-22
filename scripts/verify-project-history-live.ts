/** Explicit live acceptance. Reads only AI settings from the source DB; all writes use a fixture. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { createProjectAgent,projectPreferences } from '../electron/kinds/project/agent.ts'
import type { AIConfig } from '../src/types/index.ts'
import type { ProjectSession } from '../src/types/project.ts'
import {AgentJournal} from '../electron/workspace/agent-journal.ts'

const sourceFile = process.env.BAOYI_LIVE_AI_DB || path.join(process.env.APPDATA || '', '抱一', 'baoyi.db')
const source = new DatabaseSync(sourceFile, { readOnly: true })
let config: AIConfig
try { config = JSON.parse(String(source.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value || '{}')) } finally { source.close() }
assert.ok(config.enabled && config.api_key && config.api_url && config.model, '现有模型配置未启用或不完整')
const output = path.resolve('output/agent-revision'), root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-live-history-'))
await fs.mkdir(output, { recursive: true })
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
let manager: ReturnType<typeof createProjectAgent> | undefined, timer: ReturnType<typeof setTimeout> | undefined, sessionId = ''
try {
  git('init', '-q'); git('config','core.autocrlf','false'); git('config', 'user.name', 'BaoYi fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await fs.writeFile(path.join(root, 'README.md'), '# 示例清单\n\n用于保存本地事项的独立验收样本，不含个人资料。\n')
  git('add', 'README.md'); git('commit', '-q', '-m', '建立本地清单的说明文档')
  const first = git('rev-parse', 'HEAD')
  await fs.writeFile(path.join(root, 'tasks.ts'), 'export const tasks = [{ title: "验证自动记录", done: false }]\n')
  git('add', 'tasks.ts'); git('commit', '-q', '-m', '加入待办清单样本数据')
  for(let index=3;index<=121;index++){
    await fs.writeFile(path.join(root,'tasks.ts'),`export const checkpoint = ${index}\n`)
    git('add','tasks.ts');git('commit','-q','-m',`样本阶段 ${Math.ceil(index/20)}：保存清单检查点 ${index}`)
  }
  const all=git('rev-list','HEAD').split('\n'),second = all[0]
  assert.equal(all.length,121)
  projectPreferences(db,{maxTurns:2,contextMessages:4,defaultSource:'unknown',defaultState:'active'})
  const project = new ProjectLibrary(db).register({ path: root, name: '本地清单验收样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  let finish!: (session: ProjectSession) => void, lastLabel = ''
  const done = new Promise<ProjectSession>(resolve => { finish = resolve })
  manager = createProjectAgent({ db, config: () => config, changed: session => {
    const label = session.messages.at(-1)?.events.at(-1)?.label || session.status
    if (label !== lastLabel) { lastLabel = label; console.log('Agent:', label) }
    if (session.workflow && session.workflow.state !== 'running') finish(session)
  } })
  console.log('Live model:', config.model)
  const prior=manager.create(project.id)
  new AgentJournal(db).record(project.id,prior.id,{title:'已有基础记录',body:'手工核对过的起始提交记录。',commits:[first],occurredAt:Date.now()})
  const session = manager.organize(project.id); sessionId = session.id
  timer = setTimeout(() => manager!.cancel(sessionId), 480000)
  const result = await done
  clearTimeout(timer)
  assert.equal(result.workflow?.state, 'complete', result.error)
  const events = new TimelineLibrary(db).events(project.id), evidence = events.flatMap(e => e.evidence)
  assert.ok(events.length > 1 && events.every(e => e.status === 'published'))
  assert.ok(all.every(sha=>evidence.includes('commit:'+sha)),'所有 121 条提交都有已存日志依据')
  const pages=result.messages.flatMap(m=>m.events).filter(e=>e.label==='read_project_history 结果'&&!e.error).map(e=>JSON.parse(e.detail))
  assert.ok(pages.length>1,'真实模型必须完成多页历史')
  assert.equal(new Set(pages.flatMap(p=>p.commits.map((c:any)=>c.sha))).size,121)
  assert.ok(result.contextCheckpoint)
  manager.dispose();manager=createProjectAgent({db,config:()=>config})
  projectPreferences(db,{maxTurns:8,contextMessages:4,defaultSource:'unknown',defaultState:'active'})
  assert.ok(evidence.includes('commit:' + first) && evidence.includes('commit:' + second))
  timer = setTimeout(() => manager!.cancel(sessionId), 120000)
  const followup = await manager.send(sessionId, '读取刚保存的项目日志，列出事件编号和对应提交，简述下一步。不要重复保存事件。')
  clearTimeout(timer)
  assert.equal(followup.status, 'idle', followup.error)
  assert.equal(new TimelineLibrary(db).events(project.id).length, events.length)
  const report = { status: 'passed', at: new Date().toISOString(), model: config.model, checks: ['121-commits','existing-log-does-not-filter-history','multi-page-live-model','two-turn-checkpoints','restart-followup','no-duplicate'],pageCount:pages.length,events,session:manager.get(sessionId) }
  await fs.writeFile(path.join(output, 'project-history-live.json'), JSON.stringify(report, null, 2))
  console.log(`PASS: live agent saved ${events.length} events and continued the same session.`)
} catch (error) {
  const message = String(error).replaceAll(config.api_key, '[redacted]')
  await fs.writeFile(path.join(output, 'project-history-live.json'), JSON.stringify({ status: 'failed', at: new Date().toISOString(), model: config.model, error: message, session: manager?.get(sessionId) }, null, 2))
  console.error(message); process.exitCode = 1
} finally {
  clearTimeout(timer);manager?.dispose(); db.close()
  assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true })
}
