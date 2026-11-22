import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY, SCHEMA_VERSION } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { DocumentFiles } from '../electron/workspace/document-files.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { APP_VERSION_KEY } from '../electron/services/storage/library-snapshots.ts'
import { pngImage } from './helpers/test-images.ts'

const require = createRequire(import.meta.url), { _electron } = require('playwright')
const packed = process.argv[2], output = path.resolve(process.argv[3] || 'output/resource-reliability-2026-11-04/native-ui')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-')), database = path.join(profile, 'baoyi.db')
const db = new DatabaseSync(database); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'light', hanime_builtin_hosts: false, [APP_VERSION_KEY]: '0.17.8' })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const docs = new DocumentLibrary(db), files = new DocumentFiles(db), images = new ImageLibrary(db)
const source = path.join(profile, 'source.txt'), destination = path.join(profile, 'moved.txt')
fs.writeFileSync(source, 'original note')
const doc = await docs.register(source, 'novel'); docs.update(doc.id, { name: '恢复演练资料', tags: ['保留'] })
docs.savePosition(doc.id, { page: 2, offset: .3 }, 4)
const note = docs.annotate(doc.id, { kind: 'excerpt', quote: 'original', note: '人工想法', location: { page: 2, offset: .3 } })
const relocationSource = path.join(profile, 'relocation.txt'), relocationTarget = path.join(profile, 'relocated.txt'), ownedCopy = path.join(profile, 'owned-copy.txt')
fs.writeFileSync(relocationSource, 'relocation original')
const relocationDoc = await docs.register(relocationSource, 'novel')
await files.execute(await files.plan(undefined, source, 'copy', ownedCopy))
fs.renameSync(relocationSource, relocationTarget)
const op = await files.execute(await files.plan(undefined, source, 'move', destination))
const unlink = fsp.unlink
fsp.unlink = async file => { if (file === destination) throw new Error('验收：文件暂时被占用'); return unlink(file) }
try { await assert.rejects(files.undo(op.id), /暂时被占用/) } finally { fsp.unlink = unlink }
const photos = path.join(profile, 'photos'); fs.mkdirSync(photos)
const image1 = path.join(photos, '1.png'), image2 = path.join(photos, '2.png')
fs.writeFileSync(image1, pngImage(20, 30)); fs.writeFileSync(image2, pngImage(30, 20))
const photo = images.register((await scanImageImport(photos, 'photo', false))[0]), pages = images.pages(photo.id)
images.saveProgress(photo.id, pages[1].id, .2)
fs.writeFileSync(image2, '')
db.prepare('UPDATE settings SET value=? WHERE key=?').run('25', SCHEMA_KEY)
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const launch = () => _electron.launch({ executablePath: path.resolve(packed || 'node_modules/electron/dist/electron.exe'), args: [...(packed ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env })
let app: any, page: any
const checks: string[] = [], errors: string[] = []
async function open() {
  app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000)
  const documents = path.join(profile, 'documents'); fs.mkdirSync(documents, {recursive:true})
  await app.evaluate(({app}: any, directory: string) => app.setPath('documents', directory), documents)
  page.on('pageerror', (e: Error) => errors.push(e.message))
  assert.equal(path.resolve(await app.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  await page.locator('.titlebar').waitFor()
}
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log('PASS ' + name) }
try {
  await open()
  await check('schema-25 upgrade creates verified pre-upgrade snapshot and retains records', async () => {
    const safety = await page.evaluate(() => (window as any).baoyi.data.snapshotInfo())
    assert.equal(safety.schema, SCHEMA_VERSION); assert.equal(safety.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version)
    const snapshot = safety.inventory.snapshots.find((s: any) => s.fromSchema === 25)
    assert.ok(snapshot)
    const old = new DatabaseSync(path.join(safety.inventory.directory, snapshot.file), { readOnly: true })
    try { assert.equal(old.prepare('SELECT value FROM settings WHERE key=?').get(SCHEMA_KEY)!.value, '25'); assert.ok(old.prepare('SELECT id FROM document_annotations WHERE id=?').get(note.id)) } finally { old.close() }
    const exported = path.join(profile, 'snapshot-export.db')
    await app.evaluate(({ dialog }: any, target: string) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, exported)
    await page.evaluate((id: string) => (window as any).baoyi.data.exportSnapshot(id), snapshot.id)
    const restored = new DatabaseSync(exported, { readOnly: true })
    try { assert.ok(restored.prepare('SELECT id FROM resource WHERE id=?').get(doc.id)); assert.equal(restored.prepare('PRAGMA quick_check').get()!.quick_check, 'ok') } finally { restored.close() }
  })
  await check('incomplete rescan retains pages and position; complete rescan recovers', async () => {
    await assert.rejects(page.evaluate((id: string) => (window as any).baoyi.image.rescan(id), photo.id), /扫描不完整/)
    const before = await page.evaluate(async (id: string) => ({ item: await (window as any).baoyi.image.get(id), pages: await (window as any).baoyi.image.pages(id) }), photo.id)
    assert.equal(before.pages.length, 2); assert.equal(before.item.progress.pageId, pages[1].id)
    fs.writeFileSync(image2, pngImage(40, 20))
    await page.evaluate((id: string) => (window as any).baoyi.image.rescan(id), photo.id)
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.image.pages(id), photo.id)).length, 2)
  })
  await check('history UI resumes persisted undo after restart and keeps annotations', async () => {
    await page.evaluate(() => { location.hash = '/settings?module=document&tab=organize' })
    await page.getByRole('button', { name: '整理历史与撤销' }).click()
    await page.getByText('撤销待完成', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'undo-pending.png') })
    await page.getByRole('button', { name: '继续完成撤销', exact: true }).click()
    await page.getByText('已撤销', { exact: true }).waitFor()
    assert.equal(fs.existsSync(destination), false); assert.equal(fs.readFileSync(source, 'utf8'), 'original note')
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.workspace.documents.annotations(id), doc.id))[0].id, note.id)
    await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].setSize(1024, 768))
    await page.screenshot({ path: path.join(output, 'undo-complete-1024.png') })
  })
  await check('native relocation rejects another document copy then retains the original ID', async () => {
    await app.evaluate(({ dialog }: any, file: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, ownedCopy)
    await assert.rejects(page.evaluate((id: string) => (window as any).baoyi.workspace.documents.relocate(id), relocationDoc.id), /其他资料/)
    await app.evaluate(({ dialog }: any, file: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, relocationTarget)
    const relocated = await page.evaluate((id: string) => (window as any).baoyi.workspace.documents.relocate(id), relocationDoc.id)
    assert.equal(relocated.id, relocationDoc.id); assert.equal(relocated.path, relocationTarget)
  })
  await check('metadata export, actual restore handler and cold restart preserve IDs, notes, progress and files', async () => {
    const backup = path.join(profile, 'library-export.json')
    await app.evaluate(({ dialog }: any, file: string) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, backup)
    await page.evaluate(() => (window as any).baoyi.data.exportJson())
    await page.evaluate((id: string) => (window as any).baoyi.workspace.documents.update(id, { name: '恢复前临时修改' }), doc.id)
    // Native file selection/confirmation and process-control boundaries only;
    // use the real restore handler and then explicitly close/relaunch this isolated app.
    await app.evaluate(({ dialog, app }: any, file: string) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      dialog.showMessageBox = async () => ({ response: 1 })
      app.relaunch = () => {}; app.exit = () => {}
    }, backup)
    const result = await page.evaluate(() => (window as any).baoyi.data.restoreJson())
    assert.ok(fs.existsSync(result.backupPath))
    await app.close(); await open()
    const item = await page.evaluate((id: string) => (window as any).baoyi.workspace.documents.get(id), doc.id)
    assert.equal(item.name, '恢复演练资料'); assert.deepEqual(item.position, { page: 2, offset: .3 }); assert.deepEqual(item.tags, ['保留'])
    assert.equal(fs.readFileSync(source, 'utf8'), 'original note')
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.workspace.documents.annotations(id), doc.id))[0].note, '人工想法')
    assert.equal((await page.evaluate((id: string) => (window as any).baoyi.image.get(id), photo.id)).progress.pageId, pages[1].id)
    const recovery = new DatabaseSync(result.backupPath, { readOnly: true })
    try { assert.equal(recovery.prepare('SELECT name_zh FROM resource WHERE id=?').get(doc.id)!.name_zh, '恢复前临时修改') } finally { recovery.close() }
  })
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', checks, errors, profile, executable: packed || 'development', processRestartControlledByTest: true }, null, 2))
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally { if (app) await app.close() }
