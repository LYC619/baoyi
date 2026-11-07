import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as files from '../electron/kinds/project/workspace.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-file-search-'))
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  return root
}
test('目录分页列出所有文件、可按名称筛选，目录变化使旧游标失效', async t => {
  const root = await fixture(t)
  for (let i = 0; i < 205; i++) await fs.writeFile(path.join(root, `entry-${i}.md`), '资料')
  await fs.writeFile(path.join(root, '.env'), 'do not expose')
  await fs.mkdir(path.join(root, 'node_modules'))
  assert.equal(typeof files.listProjectFilesPage, 'function', '应提供完整目录分页')
  const first = await files.listProjectFilesPage(root, '', { limit: 80 })
  const all = [...first.files]; let cursor = first.next
  while (cursor) { const page = await files.listProjectFilesPage(root, '', { limit: 80, cursor }); all.push(...page.files); cursor = page.next }
  assert.equal(all.length, 205); assert.equal(new Set(all.map(f => f.path)).size, 205)
  assert.equal((await files.listProjectFilesPage(root, '', { query: 'entry-204' })).files.length, 1)
  await fs.writeFile(path.join(root, 'new.md'), '新文件')
  await assert.rejects(files.listProjectFilesPage(root, '', { cursor: first.next! }), /失效|变化/)
})
test('大文本搜索可续查所有匹配，UTF-8 长行分页无丢字，变更使游标失效', async t => {
  const root = await fixture(t), file = path.join(root, 'large.md')
  const original = '前文😀'.repeat(150000) + '\n' + Array.from({ length: 91 }, (_, i) => `第 ${i} 条目标😀\n`).join('')
  await fs.writeFile(file, original)
  assert.equal(typeof files.searchProjectText, 'function', '应提供大文本搜索')
  const matches: Array<{line:number}> = []; let cursor: files.ProjectTextCursor | null = null
  do { const page = await files.searchProjectText(root, 'large.md', '目标😀', cursor || undefined); matches.push(...page.matches); cursor = page.next } while (cursor)
  assert.equal(matches.length, 91); assert.deepEqual(matches.map(m => m.line), Array.from({ length: 91 }, (_, i) => i + 2))
  const small = '😀汉字'.repeat(4000); await fs.writeFile(path.join(root, 'unicode.md'), small)
  let actual = '', next: files.ProjectTextCursor | null = null
  do { const page = await files.readProjectTextPage(root, 'unicode.md', 1, next || undefined); actual += page.text; next = page.next } while (next)
  assert.equal(actual, small)
  const first = await files.readProjectTextPage(root, 'large.md')
  await fs.appendFile(file, 'changed')
  await assert.rejects(files.readProjectTextPage(root, 'large.md', 1, first.next!), /失效/)
  await assert.rejects(files.searchProjectText(root, '../outside.md', '目标'), /范围/)
})
