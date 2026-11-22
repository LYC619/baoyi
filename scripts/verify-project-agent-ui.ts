import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const output = path.resolve('output/agent-revision'); await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, 'ui-profile-')), root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-agent-ui-'))
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('commit', '--allow-empty', '-q', '-m', '建立界面验收样本')
let stage = 0, calls = 0, latest = git('rev-parse', 'HEAD')
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk
  JSON.parse(text); calls++
  const tool = (name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'ui-' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const message = stage === 0 ? tool('read_project_history', { limit: 50 }) : stage === 1 ? tool('record_project_event', { title: '自动整理样本进展', body: '已建立项目记录，保存可回看的提交依据。', commits: [latest] }) : { role: 'assistant', content: '已保存记录，可从时间线回看。' }
  stage++; await new Promise(resolve => setTimeout(resolve, 150))
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 1 } }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false, ai: { enabled: true, api_key: 'local-ui-fixture', api_url: `http://127.0.0.1:${(server.address() as {port:number}).port}`, model: 'fixture' } })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const project = new ProjectLibrary(db).register({ path: root, name: '项目 agent 窗口验收', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] }); db.close()
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const launch = () => _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [path.resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
let application = await launch(), page = await application.firstWindow()
const errors: string[] = [], checks: string[] = []
page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept())
try {
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), profile)
  await page.waitForFunction(() => !!window.baoyi?.project?.organize)
  await page.evaluate(id => { location.hash = '/project/' + id }, project.id)
  await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
  await page.locator('.timeline-workflow').waitFor()
  await page.waitForFunction(() => document.querySelector('.timeline-workflow')?.textContent?.includes('本次整理已完成'))
  assert.equal(await page.getByRole('button', { name: 'AI 生成', exact: true }).count(), 1)
  await page.getByRole('button', { name: '自动记录：开', exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('.timeline-workflow').innerText(), /record_project_event|read_project_history/)
  checks.push('create-session-visible-progress-auto-save')
  await page.screenshot({ path: path.join(output, 'project-agent-timeline.png') })
  await page.getByRole('button', { name: '查看会话', exact: true }).click()
  await page.locator('.project-chat').waitFor({ state: 'visible' })
  assert.match(await page.locator('.chat-messages').innerText(), /已保存记录/)
  assert.match(await page.locator('.chat-trace').textContent() || '', /read_project_history/)
  checks.push('same-session-and-tool-evidence')
  await page.getByRole('tab', { name: '项目日志', exact: true }).click()
  await page.getByRole('button', { name: '撤销生成', exact: true }).click()
  assert.equal(await page.locator('.timeline-event:not(.draft)').count(), 0)
  checks.push('undo-generated-event')
  // The app's real monitor detects a new commit; no synthetic IPC generates its log.
  git('commit', '--allow-empty', '-q', '-m', '自动监测下一次提交'); latest = git('rev-parse', 'HEAD'); stage = 0
  await page.getByRole('button', { name: 'AI 生成', exact: true }).waitFor({ timeout: 65000 })
  await page.waitForFunction(() => document.querySelector('.timeline-workflow')?.textContent?.includes('本次整理已完成'))
  checks.push('automatic-new-commit-monitor')
  const beforeRestart = calls
  await application.close(); application = await launch(); page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message)); await page.waitForFunction(() => !!window.baoyi?.project)
  await page.evaluate(id => { location.hash = '/project/' + id }, project.id)
  await page.getByRole('button', { name: 'AI 生成', exact: true }).waitFor()
  assert.equal(calls, beforeRestart)
  checks.push('restart-keeps-events-without-regeneration')
  await page.getByRole('button',{name:'撤销本次生成',exact:true}).click()
  await page.getByRole('button',{name:'确认撤销 1 条',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.timeline-event:not(.draft)').length===0)
  checks.push('batch-undo-preview-and-apply')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'project-agent-ui.json'), JSON.stringify({ status: 'passed', checks, errors, profile }, null, 2))
  console.log('PASS: ' + checks.join(', '))
} catch (error) {
  await page.screenshot({ path: path.join(output, 'project-agent-ui-failure.png') }).catch(() => {})
  await fs.writeFile(path.join(output, 'project-agent-ui.json'), JSON.stringify({ status: 'failed', error: String(error), errors, profile }, null, 2))
  throw error
} finally {
  await application.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
  assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true })
}
