// Run after building the current sources. Uses only an isolated Electron profile.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { expect } from 'playwright/test'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { WorkspaceChanges } from '../electron/workspace/agent-changes.ts'
import { createWorkspaceAgent } from '../electron/workspace/agent.ts'

const output = path.resolve('output/document-feedback-round4-review')
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, 'ui-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
const names = ['读过甲', '读过乙', '读过丙', '最近读过丁', '刚导入未读']
const groupName = '最近四本验收'
let groupId = ''
try {
  for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false })) {
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
  }
  const docs = new DocumentLibrary(db)
  const group = docs.saveCustomGroup({ submodule: 'reading', categoryId: 'novel', name: groupName })
  groupId = group.id
  let targetId = ''
  const agent = createWorkspaceAgent({ db: db as any, config: () => ({ enabled: true, api_key: 'fixture', api_url: 'http://localhost', model: 'fixture' }), run: async ({ tools }) => {
    const tool = tools.find(tool => tool.name === 'update_document_metadata')!
    await tool.execute({ id: targetId, patch: { customGroupId: group.id } })
    return { stopReason: 'done', text: '分组已保存', turns: 1, tokens: 0, error: '' }
  } })
  const session = agent.create('document')
  for (let index = 0; index < names.length; index++) {
    const file = path.join(profile, names[index] + '.txt')
    await fs.writeFile(file, '第一章\n用于隔离验收的小说正文。')
    const item = await docs.register(file, 'novel')
    if (index < 4) {
      db.prepare("UPDATE document_meta SET read_state='read' WHERE resource_id=?").run(item.id)
      db.prepare('UPDATE resource SET last_used_at=? WHERE id=?').run([1000, 4000, 2000, 5000][index], item.id)
    }
    if (index === 0) targetId = item.id
    else docs.update(item.id, { customGroupId: group.id })
    if (index === 4) db.prepare('UPDATE resource SET updated_at=? WHERE id=?').run(Date.now() + 10000, item.id)
  }
  const reply = await agent.send(session.id, '按方案整理小说分组')
  assert.equal(reply.status, 'idle', reply.error)
  assert.equal(new WorkspaceChanges(db as any).list(session.id).length, 1)
  agent.dispose()
} finally { db.close() }

const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
const executable = process.env.BAOYI_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe')
const launch = () => _electron.launch({ executablePath: executable, args: [...(process.env.BAOYI_TEST_EXE ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
let app = await launch(), page = await app.firstWindow()
const errors: string[] = []
const checks: string[] = []
async function enterDocument() {
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  await page.waitForFunction(() => !!window.baoyi?.workspace)
  await page.evaluate(() => { location.hash = '/document' })
}
async function inspectHistory() {
  await page.getByRole('button', { name: '资料助手', exact: true }).click()
  const change = page.locator('.assistant-change').first()
  await expect(change).toContainText(groupName)
  await expect(change).not.toContainText(groupId)
  await expect(change).toContainText('未分组')
  await page.getByRole('button', { name: '收起资料助手', exact: true }).click()
}
try {
  await enterDocument()
  const group = page.locator('.document-group-card').filter({ hasText: groupName })
  await expect(group).toBeVisible()
  await expect.poll(() => group.locator('.quad-item .document-cover').evaluateAll(nodes => nodes.map(node =>
    node.querySelector('img')?.getAttribute('alt')?.replace(/的首页封面$/, '') || node.querySelector('.cover-fallback strong')?.textContent,
  ))).toEqual([names[3], names[1], names[2], names[0]])
  checks.push('group-cover-renders-four-recently-read-books-before-new-unread')
  await page.getByRole('button', { name: '批量管理', exact: true }).click()
  await page.getByRole('button', { name: '退出批量', exact: true }).click()
  await expect(page.getByRole('button', { name: '批量管理', exact: true })).toBeVisible()
  checks.push('bulk-toggle-label')
  await inspectHistory()
  checks.push('history-group-names-without-sending-a-message')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await enterDocument()
  await inspectHistory()
  checks.push('history-group-names-after-native-restart')
  await page.screenshot({ path: path.join(output, 'round4-review.png') })
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'ui-result.json'), JSON.stringify({ status: 'passed', checks, errors, profile }, null, 2))
  console.log('PASS ' + checks.join(', '))
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
