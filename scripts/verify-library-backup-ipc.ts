import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { LIBRARY_BACKUP_TABLE_NAMES } from '../src/types/library-backup.ts'
import * as backup from '../electron/services/library-backup.ts'
import { atomicWrite } from '../electron/kinds/video/bundle.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { librarySafetyInfo } from '../electron/services/library-snapshots.ts'

assert.ok(fs.existsSync('electron/ipc/library-backup.ts'), 'Full metadata backups need a reviewed restore entry point')
let passed = 0, failed = 0
async function test(name: string, action: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture()
  try { await action(f); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error) }
  finally {
    f.db.close()
    assert.equal(path.dirname(path.resolve(f.root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(f.root).startsWith('baoyi-backup-ipc-'))
    fs.rmSync(f.root, { recursive: true, force: true })
  }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-backup-ipc-'))
  const db = new DatabaseSync(path.join(root, 'baoyi.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
  initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('test-only-secret', 'local setting sentinel')
  const media = path.join(root, 'media'); fs.mkdirSync(media)
  const file = path.join(media, 'sample.mp4'); fs.writeFileSync(file, 'original file sentinel')
  const work = registerVideoContent(db, { title: 'Backup title', directory: media, root, items: [
    { title: 'Content', order: 1, files: [{ path: file }] }
  ] })
  const backupPath = path.join(root, 'backup.json')
  fs.writeFileSync(backupPath, JSON.stringify(backup.buildLibraryBackup(db)))
  db.prepare('UPDATE resource SET name_zh = ? WHERE id = ?').run('Current title', work.resourceId)
  const controls = { cancelOpen: false, confirm: false, busy: false, messages: [] as any[], restarts: [] as string[] }
  const handlers = new Map<string, (...args: any[]) => any>()
  const contents = { mainFrame: {} }, win = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const load = createRendererLoader({
    electron: {
      app: { getPath: () => root, relaunch: () => controls.restarts.push('relaunch'), exit: () => controls.restarts.push('exit') },
      dialog: {
        showOpenDialog: async () => ({ canceled: controls.cancelOpen, filePaths: [backupPath] }),
        showSaveDialog: async () => ({ canceled: controls.cancelOpen, filePath: path.join(root, 'export.json') }),
        showMessageBox: async (_win: unknown, options: unknown) => { controls.messages.push(options); return { response: controls.confirm ? 1 : 0 } }
      }
    },
    'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path },
    '../services/database.ts': { getDb: () => db, exportAll: () => backup.buildLibraryBackup(db) },
    '../services/library-backup.ts': backup,
    '../kinds/video/bundle.ts': { atomicWrite },
    './video-organize.ts': { videoOrganizationBusy: () => controls.busy },
    './video-agent-organize.ts': { videoAgentOrganizationBusy: () => false },
    './video-import.ts': { videoImportBusy: () => false }
  }, { Buffer, JSON, Object, Array })
  load('electron/ipc/library-backup.ts').registerLibraryBackupIpc(() => win, {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)
  })
  return { root, db, backupPath, work, file, controls, handlers, event,
    invoke: (name: string) => Promise.resolve().then(() => { assert.ok(handlers.has(name), name); return handlers.get(name)!(event) }) }
}

await test('export includes every metadata table and excludes app settings', async f => {
  const target = await f.invoke('data:export-json')
  const raw = fs.readFileSync(target, 'utf8'), result = JSON.parse(raw)
  assert.equal(result.format, 'baoyi-library-metadata')
  assert.equal(Object.keys(result.tables).length, LIBRARY_BACKUP_TABLE_NAMES.length)
  assert.equal(result.tables.resource[0].name_zh, 'Current title')
  assert.ok(!raw.includes('local setting sentinel'))
  const info = librarySafetyInfo(f.db, f.root, '0.10.0')
  assert.equal(info.lastExport?.file, target); assert.equal(info.lastExport?.state, 'available')
  assert.equal(info.lastExport?.size, Buffer.byteLength(raw))
  assert.ok(!JSON.stringify(info).includes('local setting sentinel'))
})
await test('canceling selection or confirmation makes no changes', async f => {
  f.controls.cancelOpen = true
  assert.equal(await f.invoke('data:restore-json'), null)
  assert.equal(f.controls.messages.length, 0)
  f.controls.cancelOpen = false
  assert.equal(await f.invoke('data:restore-json'), null)
  assert.equal(f.controls.messages.length, 1)
  assert.match(f.controls.messages[0].detail, /1/)
  assert.equal(f.db.prepare('SELECT name_zh FROM resource WHERE id = ?').get(f.work.resourceId)!.name_zh, 'Current title')
  assert.deepEqual(f.controls.restarts, [])
  assert.ok(!fs.existsSync(path.join(f.root, 'recovery')))
})
await test('confirmed restore snapshots the full current WAL database and restarts', async f => {
  f.controls.confirm = true
  const result = await f.invoke('data:restore-json')
  assert.equal(f.db.prepare('SELECT name_zh FROM resource WHERE id = ?').get(f.work.resourceId)!.name_zh, 'Backup title')
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key = ?').get('test-only-secret')!.value, 'local setting sentinel')
  const original = new DatabaseSync(result.backupPath, { readOnly: true })
  try {
    assert.equal(original.prepare('SELECT name_zh FROM resource WHERE id = ?').get(f.work.resourceId)!.name_zh, 'Current title')
    assert.equal(original.prepare('SELECT value FROM settings WHERE key = ?').get('test-only-secret')!.value, 'local setting sentinel')
  } finally { original.close() }
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original file sentinel')
  assert.deepEqual(f.controls.restarts, ['relaunch', 'exit'])
})
await test('invalid payload fails before confirmation or replacement', async f => {
  fs.writeFileSync(f.backupPath, JSON.stringify({ version: 3, software: [] }))
  f.controls.confirm = true
  await assert.rejects(f.invoke('data:restore-json'))
  assert.equal(f.controls.messages.length, 0)
  assert.equal(f.db.prepare('SELECT name_zh FROM resource WHERE id = ?').get(f.work.resourceId)!.name_zh, 'Current title')
  assert.deepEqual(f.controls.restarts, [])
})
await test('in-flight file organization prevents library replacement', async f => {
  f.controls.busy = true; f.controls.confirm = true
  await assert.rejects(f.invoke('data:restore-json'), /任务|整理/)
  assert.deepEqual(f.controls.restarts, [])
})
await test('active persisted tasks are preserved instead of being overwritten', async f => {
  f.db.prepare("INSERT INTO task_records (id, kind, title, status, started_at) VALUES ('busy', 'video-scan', 'Scan', 'running', 1)").run()
  f.controls.confirm = true
  await assert.rejects(f.invoke('data:restore-json'), /任务/)
  assert.ok(f.db.prepare("SELECT id FROM task_records WHERE id = 'busy'").get())
})
await test('foreign frames cannot export or restore the library', async f => {
  const event = { ...f.event, senderFrame: {} }
  await assert.rejects(async () => f.handlers.get('data:export-json')!(event), /主窗口/)
  await assert.rejects(async () => f.handlers.get('data:restore-json')!(event), /主窗口/)
})
console.log(`Library backup IPC: ${passed} passed / ${failed} failed`)
if (failed) process.exitCode = 1
