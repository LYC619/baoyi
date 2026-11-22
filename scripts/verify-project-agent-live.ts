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
import { createProjectAgent } from '../electron/kinds/project/agent.ts'
import type { AIConfig } from '../src/types/index.ts'
import type { ProjectSession } from '../src/types/project.ts'
import {ProjectSummaries} from '../electron/workspace/project-summaries.ts'
import {summaryGroup} from '../src/utils/project-summary.ts'

const sourceFile = process.env.BAOYI_LIVE_AI_DB || path.join(process.env.APPDATA || '', '抱一', 'baoyi.db')
const source = new DatabaseSync(sourceFile, { readOnly: true })
let config: AIConfig
try { config = JSON.parse(String(source.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value || '{}')) } finally { source.close() }
assert.ok(config.enabled && config.api_key && config.api_url && config.model, '现有模型配置未启用或不完整')
const output = path.resolve('output/agent-revision'), root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-live-agent-'))
await fs.mkdir(output, { recursive: true })
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
let manager: ReturnType<typeof createProjectAgent> | undefined, timer: ReturnType<typeof setTimeout> | undefined, sessionId = ''
try {
  git('init', '-q'); git('config', 'user.name', 'BaoYi fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await fs.writeFile(path.join(root, 'README.md'), '# 示例清单\n\n用于保存本地事项的独立验收样本，不含个人资料。\n')
  git('add', 'README.md'); git('commit', '-q', '-m', '建立本地清单的说明文档')
  const first = git('rev-parse', 'HEAD')
  await fs.writeFile(path.join(root, 'tasks.ts'), 'export const tasks = [{ title: "验证自动记录", done: false }]\n')
  git('add', 'tasks.ts'); git('commit', '-q', '-m', '加入待办清单样本数据')
  const second = git('rev-parse', 'HEAD')
  const project = new ProjectLibrary(db).register({ path: root, name: '本地清单验收样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  let finish!: (session: ProjectSession) => void, lastLabel = ''
  const done = new Promise<ProjectSession>(resolve => { finish = resolve })
  manager = createProjectAgent({ db, config: () => config, changed: session => {
    const label = session.messages.at(-1)?.events.at(-1)?.label || session.status
    if (label !== lastLabel) { lastLabel = label; console.log('Agent:', label) }
    if (session.workflow && session.workflow.state !== 'running') finish(session)
  } })
  console.log('Live model:', config.model)
  const session = manager.organize(project.id); sessionId = session.id
  timer = setTimeout(() => manager!.cancel(sessionId), 240000)
  const result = await done
  clearTimeout(timer)
  assert.equal(result.workflow?.state, 'complete', result.error)
  const events = new TimelineLibrary(db).events(project.id), evidence = events.flatMap(e => e.evidence)
  assert.ok(events.length > 0 && events.every(e => e.status === 'published' && e.generated?.sessionId === sessionId))
  assert.ok(evidence.includes('commit:' + first) && evidence.includes('commit:' + second))
  timer = setTimeout(() => manager!.cancel(sessionId), 120000)
  const followup = await manager.send(sessionId, '读取刚保存的项目日志，列出事件编号和对应提交，简述下一步。不要重复保存事件。')
  clearTimeout(timer)
  assert.equal(followup.status, 'idle', followup.error)
  assert.equal(new TimelineLibrary(db).events(project.id).length, events.length)
  timer=setTimeout(()=>manager!.cancel(sessionId),120000)
  const summarized=await manager.send(sessionId,`请为 ${JSON.stringify({kind:'day',key:summaryGroup(events[0],'day')})} 生成并保存一份摘要。使用 read_project_summary_sources 完整读取本组原始日志，再用 save_project_summary 保存。不要重复添加日志，不把代码提交说成已经实测通过。`)
  clearTimeout(timer);assert.equal(summarized.status,'idle',summarized.error)
  const summaries=new ProjectSummaries(db).list(project.id);assert.equal(summaries.length,1);assert.equal(summaries[0].sources.length,events.length);assert.equal(summaries[0].sessionId,sessionId)
  assert.equal(new TimelineLibrary(db).events(project.id).length,events.length)
  const report = { status: 'passed', at: new Date().toISOString(), model: config.model, checks: ['visible-session', 'read-committed-history', 'automatic-event-save', 'source-sha', 'followup-context', 'no-duplicate','actual-day-summary-preserves-original-evidence'], events,summaries, session: manager.get(sessionId) }
  await fs.writeFile(path.join(output, 'project-agent-live.json'), JSON.stringify(report, null, 2))
  console.log(`PASS: live agent saved ${events.length} events and continued the same session.`)
} catch (error) {
  const message = String(error).replaceAll(config.api_key, '[redacted]')
  await fs.writeFile(path.join(output, 'project-agent-live.json'), JSON.stringify({ status: 'failed', at: new Date().toISOString(), model: config.model, error: message, session: manager?.get(sessionId) }, null, 2))
  console.error(message); process.exitCode = 1
} finally {
  clearTimeout(timer);manager?.dispose(); db.close()
  assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true })
}
