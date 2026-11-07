import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { WorkspaceLinks } from '../electron/workspace/links.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { outlinePdf, textPdf } from './helpers/pdf-fixture.ts'

const output = path.resolve('output/document-experience')
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(output, 'experience-ui-')),
  db = new DatabaseSync(path.join(profile, 'baoyi.db'))
db.exec('PRAGMA foreign_keys=ON')
initSchema(db, KINDS)
db.exec(VIDEO_JOBS_SQL)
for (const [key, value] of Object.entries({
  onboarded: true,
  theme: 'light',
  hanime_builtin_hosts: false,
}))
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
    key,
    JSON.stringify(value),
  )
const docs = new DocumentLibrary(db),
  links = new WorkspaceLinks(db)
const p = new ProjectLibrary(db).register({
  path: profile,
  name: '阅读实践',
  summary: '',
  category: '调研写作',
  source: 'self',
  version: '',
  entries: [],
  evidence: '',
  suggested: true,
  warnings: [],
})
const qDir = path.join(profile, 'archived')
await fs.mkdir(qDir)
const q = new ProjectLibrary(db).register({
  path: qDir,
  name: '归档研究',
  summary: '',
  category: '调研写作',
  source: 'self',
  version: '',
  entries: [],
  evidence: '',
  suggested: true,
  warnings: [],
})
new ProjectLibrary(db).update(q.id, { state: 'archived' })
const rows: any[] = []
for (let i = 0; i < 16; i++) {
  const format = i === 3 ? 'md' : i === 4 ? 'txt' : i === 5 ? 'png' : 'pdf',
    file = path.join(profile, `${String(i).padStart(2, '0')}-资料.${format}`)
  const data =
    i === 2
      ? 'not a pdf'
      : i === 3
        ? '# 阅读与思考\n\n自己的资料留下可引用的来源。'
        : i === 4
          ? '文字资料\n\n保留原文件和想法。'
          : i === 5
            ? Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
                'base64',
              )
            : i === 1
              ? textPdf()
              : outlinePdf(
                  i === 0 ? 10 : i === 15 ? 100 : 3,
                  true,
                  `Research ${i}`,
                )
  await fs.writeFile(file, data)
  const row = await docs.register(file, i === 6 ? 'certificate' : 'book')
  docs.update(row.id, {
    name:
      i === 0
        ? '资料阅读与研究方法'
        : i === 6
          ? '资格证书'
          : i === 7
            ? '很长的资料标题：记录阅读、证据与研究工作中需要再次用到的完整上下文'
            : `资料 ${String(i).padStart(2, '0')}`,
    author: '测试资料',
    tags:
      i < 7
        ? [
            '研究',
            ...(i === 0
              ? [
                  '阅读',
                  ...Array.from({ length: 18 }, (_, n) => `研究分类 ${n + 1}`),
                ]
              : []),
          ]
        : ['其他'],
  })
  if (i === 0) {
    docs.savePosition(row.id, { page: 6, offset: 0.8 }, 10)
    db.prepare('UPDATE resource SET last_used_at=? WHERE id=?').run(100, row.id)
  }
  if (i === 3) {
    docs.savePosition(row.id, { page: 1, offset: 0.2 }, 3)
    db.prepare('UPDATE resource SET last_used_at=? WHERE id=?').run(200, row.id)
  }
  if (i === 8) docs.update(row.id, { readState: 'read' })
  rows.push(docs.require(row.id))
  db.prepare('UPDATE resource SET updated_at=? WHERE id=?').run(
    100000 - i,
    row.id,
  )
}
await fs.unlink(rows[9].path)
const mark = docs.annotate(rows[0].id, {
  kind: 'excerpt',
  quote: 'Evidence belongs to chapter 1.',
  note: '研究来源',
  location: { page: 1, offset: 0 },
})
const mark2 = docs.annotate(rows[0].id, {
  kind: 'excerpt',
  quote: 'Evidence belongs to chapter 2.',
  note: '另一条摘录',
  location: { page: 2, offset: 0 },
})
const event = new TimelineLibrary(db).save(p.id, {
  title: '阅读记录',
  body: '',
  occurredAt: Date.now(),
  milestone: false,
  version: '',
})
links.add('project', p.id, rows[0].id)
links.add('event', event.id, rows[0].id, mark.id)
db.close()
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined,
  ),
)
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
const launch = () =>
  _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: [path.resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'],
    env,
    timeout: 30000,
  })
let app = await launch(),
  page = await app.firstWindow()
const errors: string[] = [],
  checks: string[] = [],
  metrics: any = {},
  calls: any[] = []
function observe() {
  page.setDefaultTimeout(20000)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => void d.accept())
}
observe()
const nav = async (url: string) => {
  // Preload IPC exists before Vue finishes its initial router navigation.
  await page.locator('.app__view').waitFor()
  await page.evaluate((url) => {
    location.hash = url
  }, url)
}
const size = async (width: number, height = 900) => {
  await app.evaluate(
    ({ BrowserWindow }, s) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(600, 600)
      win.setSize(s.width, s.height)
    },
    { width, height },
  )
  await page.waitForFunction(
    (width) => innerWidth <= width && innerWidth >= width - 20,
    width,
  )
  metrics['viewport' + width] = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }))
}
const shot = async (name: string) =>
  page.screenshot({ path: path.join(output, name + '.png') })
async function instrument() {
  await app.evaluate(({ ipcMain }) => {
    const target = ipcMain as any
    target.__coverCalls = []
    for (const name of ['get', 'source', 'put']) {
      const channel = 'workspace:documents:covers:' + name,
        handler = target._invokeHandlers.get(channel)
      target._invokeHandlers.set(
        channel,
        async (event: any, ...args: any[]) => {
          const result = await handler(event, ...args)
          target.__coverCalls.push({
            name,
            id: args[0],
            state: result.state,
            stored: result.stored,
          })
          return result
        },
      )
    }
  })
}
const collect = () =>
  app.evaluate(({ ipcMain }) => (ipcMain as any).__coverCalls)
try {
  assert.equal(
    path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))),
    profile,
  )
  await page.waitForFunction(() => !!window.baoyi?.workspace)
  await instrument()
  await size(1280)
  await nav('/document')
  await page.locator('.document-row').first().waitFor()
  assert.equal(await page.locator('.document-row').count(), 16)
  assert.equal(
    await page.locator('.document-assistant-panel:visible').count(),
    0,
  )
  const first = page
    .locator('.document-row')
    .filter({ hasText: '资料阅读与研究方法' })
  await first.locator('.document-cover img').waitFor()
  await first.locator('img').evaluate((el: HTMLImageElement) => el.decode())
  assert.ok(
    await first
      .locator('img')
      .evaluate((el: HTMLImageElement) => el.naturalWidth > 0),
  )
  assert.equal(
    await first.getByRole('progressbar').getAttribute('aria-valuenow'),
    '58',
  )
  assert.match(await first.innerText(), /被 1 个项目引用/)
  assert.equal(
    await page
      .locator('.document-row')
      .filter({ hasText: '资格证书' })
      .getByRole('progressbar')
      .count(),
    0,
  )
  assert.match(
    await page
      .locator('.document-row')
      .filter({ hasText: '资料 01' })
      .innerText(),
    /进度待载入/,
  )
  const recent = page.locator('.document-section').filter({
    has: page.getByRole('heading', { name: '最近在读', exact: true }),
  })
  assert.equal(await recent.locator('.document-row').count(), 2)
  assert.match(
    await recent.locator('.document-row').first().innerText(),
    /资料 03/,
  )
  assert.equal(
    await page
      .locator('.document-row')
      .filter({ hasText: '资料阅读与研究方法' })
      .count(),
    1,
  )
  await first.click()
  await page.locator('.document-inspector img').waitFor()
  await shot('list-1280-light')
  const listKey = await first
    .locator('.document-cover')
    .getAttribute('data-cover-key')
  calls.push(...(await collect()))
  const sourceBefore = calls.filter(
    (c) => c.id === rows[0].id && c.name === 'source',
  ).length
  assert.equal(sourceBefore, 1, 'list and inspector share render task')
  assert.equal(
    calls.filter((c) => c.id === rows[15].id && c.name === 'source').length,
    0,
    'offscreen PDF is not read',
  )
  await page.getByRole('button', { name: '书架视图', exact: true }).click()
  await first.locator('img').waitFor()
  assert.equal(
    await first.locator('.document-cover').getAttribute('data-cover-key'),
    listKey,
  )
  const box = await first.locator('.document-cover').boundingBox()
  assert.ok(box!.width >= 110)
  await shot('grid-1280-light')
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await page.locator('.tag-pill').filter({ hasText: '阅读' }).click()
  assert.equal(await page.locator('.document-row').count(), 1)
  await page.getByRole('button', { name: /全部标签/ }).click()
  await page.getByLabel('资料排序', { exact: true }).selectOption('name')
  assert.equal(
    await page.getByRole('heading', { name: '最近在读', exact: true }).count(),
    0,
  )
  await page.getByLabel('资料排序', { exact: true }).selectOption('updated')
  await page.getByRole('button', { name: '资料助手', exact: true }).click()
  await page
    .getByLabel('给资料助手的消息', { exact: true })
    .fill('保留这份阅读草稿')
  await shot('assistant-open')
  await page.getByRole('button', { name: '收起资料助手', exact: true }).click()
  assert.equal(
    await page
      .getByRole('button', { name: '资料助手', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  )
  await page.getByRole('button', { name: '资料助手', exact: true }).click()
  assert.equal(
    await page.getByLabel('给资料助手的消息', { exact: true }).inputValue(),
    '保留这份阅读草稿',
  )
  await page.getByLabel('给资料助手的消息', { exact: true }).press('Escape')
  await size(960, 760)
  await first.click()
  await shot('home-960')
  assert.equal(
    await page
      .locator('body')
      .evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  )
  await size(800, 760)
  await first.click()
  await shot('home-800')
  assert.ok((await page.locator('.ws-main').boundingBox())!.width > 500)
  await page.getByRole('button', { name: '资料助手', exact: true }).click()
  assert.equal(await page.locator('.document-inspector:visible').count(), 0)
  await page.getByRole('button', { name: '展开资料详情', exact: true }).click()
  assert.equal(
    await page.locator('.document-assistant-panel:visible').count(),
    0,
  )
  await page.getByRole('button', { name: '资料助手', exact: true }).click()
  assert.equal(await page.locator('.document-inspector:visible').count(), 0)
  await page.getByRole('button', { name: '收起资料助手', exact: true }).click()
  await size(1280)
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark'),
  )
  await shot('home-dark')
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light'),
  )
  await page.getByLabel('搜索资料', { exact: true }).fill('不可能匹配的名称')
  await page
    .getByRole('heading', { name: '没有匹配的资料', exact: true })
    .waitFor()
  await shot('no-results')
  assert.equal(
    await page.getByRole('heading', { name: '最近在读', exact: true }).count(),
    0,
  )
  await page.getByLabel('搜索资料', { exact: true }).fill('很长')
  assert.equal(await page.locator('.document-row').count(), 1)
  await shot('long-title')
  await page.getByLabel('搜索资料', { exact: true }).fill('')
  checks.push(
    'actual-covers-shared-visible-queue',
    '58-percent-real-reading-order-reference-dedup-tags',
    'grid-cover-size',
    'assistant-draft-focus-panels',
    '1280-960-800-dark-empty-filter',
  )
  await nav('/document/' + rows[0].id)
  await page.locator('.textLayer span').first().waitFor()
  await page.getByLabel('切换阅读目录', { exact: true }).click()
  await page.getByRole('button', { name: 'Chapter two', exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('input[aria-label="跳转到页码"]')
        ?.getAttribute('value') === '2' ||
      (
        document.querySelector(
          'input[aria-label="跳转到页码"]',
        ) as HTMLInputElement
      )?.value === '2',
  )
  await page
    .getByRole('button', { name: 'Nested section', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="跳转到页码"]',
        ) as HTMLInputElement
      )?.value === '3',
  )
  await page.getByRole('button', { name: 'Broken target', exact: true }).click()
  await page.getByText('此章节无法定位', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('跳转到页码', { exact: true }).inputValue(),
    '3',
  )
  await page.getByLabel('切换阅读目录', { exact: true }).click()
  await page.getByLabel('切换阅读目录', { exact: true }).click()
  assert.equal(
    await page.getByLabel('跳转到页码', { exact: true }).inputValue(),
    '3',
  )
  await page.getByRole('button', { name: 'Chapter one', exact: true }).click()
  await shot('reader-outline')
  await page.getByRole('button', { name: '收起标注栏', exact: true }).click()
  assert.equal(
    await page
      .getByRole('button', { name: '切换标注栏', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  )
  await size(800, 760)
  await page.getByRole('button', { name: '切换标注栏', exact: true }).click()
  assert.equal(await page.locator('.reader-toc').count(), 0)
  await page.getByRole('button', { name: '切换阅读目录', exact: true }).click()
  assert.equal(await page.locator('.reader-annotations').count(), 0)
  await shot('reader-800')
  await size(1280)
  await page.getByRole('button', { name: '切换标注栏', exact: true }).click()
  const card = page.locator('#annotation-' + mark.id),
    otherCard = page.locator('#annotation-' + mark2.id)
  assert.equal(await otherCard.locator('.linked-project').count(), 0)
  assert.match(await card.innerText(), /已引用 → 阅读实践/)
  const before = await page
    .locator('.reader-viewport')
    .evaluate((el) => el.scrollTop)
  await card.getByRole('button', { name: '引用到项目', exact: true }).click()
  assert.equal(await card.getByRole('button', { name: /归档研究/ }).count(), 0)
  await card.getByLabel('显示归档项目', { exact: true }).check()
  await card.getByLabel('搜索引用项目', { exact: true }).fill('归档')
  await card.locator('.picker-project').filter({ hasText: '归档研究' }).click()
  await card
    .getByRole('button', { name: '已引用 → 归档研究', exact: true })
    .waitFor()
  assert.equal(
    await page.locator('.reader-viewport').evaluate((el) => el.scrollTop),
    before,
  )
  assert.equal(await otherCard.locator('.linked-project').count(), 0)
  await card.getByRole('button', { name: '引用到项目', exact: true }).click()
  await card.locator('.picker-project').filter({ hasText: '归档研究' }).click()
  assert.equal(
    (
      await page.evaluate(
        (id) => window.baoyi.workspace.links.list('project', id),
        q.id,
      )
    ).length,
    1,
  )
  await shot('annotation-project-linked')
  await card
    .getByRole('button', { name: '已引用 → 归档研究', exact: true })
    .click()
  await page
    .locator('.ws-link-main')
    .filter({ hasText: 'Evidence belongs to chapter 1.' })
    .click()
  await page.locator('.reader-viewport').waitFor()
  assert.ok(page.url().includes('annotation=' + mark.id))
  await nav('/document/' + rows[1].id)
  await page.locator('.textLayer span').first().waitFor()
  await page.getByLabel('切换阅读目录', { exact: true }).click()
  await page.getByText('此 PDF 未提供章节目录', { exact: true }).waitFor()
  const started = Date.now()
  await nav('/document/' + rows[15].id)
  await page.locator('.textLayer span').first().waitFor()
  metrics.hundredPage = {
    firstPageMs: Date.now() - started,
    pages: await page.locator('[data-pdf-page]').count(),
    rendered: await page
      .locator('[data-pdf-page][data-rendered="true"]')
      .count(),
  }
  assert.equal(metrics.hundredPage.pages, 100)
  assert.ok(metrics.hundredPage.rendered < 10)
  checks.push(
    'native-nested-named-invalid-and-empty-outline',
    'annotation-idempotent-link-precise-return',
    '100-page-lazy-render',
  )
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  observe()
  await page.waitForFunction(() => !!window.baoyi?.workspace)
  await instrument()
  await size(1280)
  await nav('/document')
  await page.getByLabel('搜索资料', { exact: true }).fill('资料阅读与研究方法')
  await page.locator('.document-row img').waitFor()
  const restartCalls: any[] = await collect()
  assert.equal(
    restartCalls.filter((c) => c.id === rows[0].id && c.name === 'source')
      .length,
    0,
  )
  assert.ok(
    restartCalls.some((c) => c.id === rows[0].id && c.state === 'ready'),
  )
  const oldKey = await page
    .locator('.document-row .document-cover')
    .getAttribute('data-cover-key')
  await fs.writeFile(rows[0].path, outlinePdf(10, true, 'Updated source'))
  await nav('/document/' + rows[1].id)
  await page.locator('.reader-viewport').waitFor()
  await nav('/document')
  await page.getByLabel('搜索资料', { exact: true }).fill('资料阅读与研究方法')
  await page.locator('.document-row img').waitFor()
  const newKey = await page
    .locator('.document-row .document-cover')
    .getAttribute('data-cover-key')
  assert.notEqual(newKey, oldKey)
  const moved = path.join(profile, 'relocated.pdf')
  await fs.rename(rows[0].path, moved)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, moved)
  await page.evaluate(
    (id) => window.baoyi.workspace.documents.relocate(id),
    rows[0].id,
  )
  await page.waitForFunction(
    (key) =>
      document
        .querySelector('.document-row .document-cover')
        ?.getAttribute('data-cover-key') !== key &&
      document
        .querySelector('.document-row .document-cover')
        ?.getAttribute('data-cover-state') === 'ready',
    newKey,
  )
  await nav('/document/' + rows[0].id)
  await page
    .locator('#annotation-' + mark.id + ' .linked-project')
    .first()
    .waitFor()
  await page.evaluate((id) => window.baoyi.project.remove(id), q.id)
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.reader-annotations')
        ?.textContent?.includes('已引用 → 归档研究'),
  )
  await fs.unlink(moved)
  await nav('/document/' + rows[1].id)
  await page.locator('.reader-viewport').waitFor()
  await nav('/document/' + rows[0].id)
  await page
    .getByRole('heading', { name: '原文件暂时找不到', exact: true })
    .waitFor()
  assert.equal(await page.locator('.annotation-card').count(), 2)
  checks.push(
    'restart-disk-hit-no-source-read',
    'source-change-relocate-regenerate',
    'restart-link-project-delete-missing-source-retains-notes',
  )
  await nav('/document')
  await page.getByLabel('搜索资料', { exact: true }).fill('')
  // Only the isolated profile above is modified; remove indexes, never source files.
  await page.evaluate(async () => {
    for (const row of await window.baoyi.workspace.documents.list())
      await window.baoyi.workspace.documents.remove(row.id)
  })
  await page
    .getByRole('heading', { name: '为下一次思考，留一份资料', exact: true })
    .waitFor()
  await shot('empty-library')
  checks.push('long-title-many-tags-empty-library-reader-narrow-focus')
  assert.deepEqual(errors, [])
  await fs.writeFile(
    path.join(output, 'experience-ui.json'),
    JSON.stringify(
      {
        status: 'passed',
        profile,
        checks,
        errors,
        metrics,
        calls: [...calls, ...(await collect())],
      },
      null,
      2,
    ),
  )
  console.log('PASS ' + checks.join(', '))
} catch (e) {
  await shot('experience-failure').catch(() => {})
  console.error('page errors', errors)
  throw e
} finally {
  await app.close()
}
