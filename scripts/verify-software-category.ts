import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-category-'))
const db = new DatabaseSync(':memory:')
initSchema(db, KINDS)
const connection = Object.assign(db, {
  pragma: () => {},
  transaction: (fn: (...args: any[]) => unknown) => (...args: any[]) => { db.exec('BEGIN'); try { const result = fn(...args); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e } }
})
const prepare = db.prepare.bind(db)
connection.prepare = (sql: string) => {
  const statement = prepare(sql), run = statement.run.bind(statement)
  const names = new Set([...sql.matchAll(/[@:$](\w+)/g)].map(match => match[1]))
  statement.run = (...args: any[]) => run(...args.map(value => value && typeof value === 'object' && !ArrayBuffer.isView(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => names.has(key))) : value))
  return statement
}
const load = createRendererLoader({
  'node:path': { default: path, ...path },
  'node:fs': { default: fs, ...fs },
  'better-sqlite3': { default: class {} },
  electron: { app: { getPath: () => root, getAppPath: () => root, getVersion: () => 'test', commandLine: { hasSwitch: () => false } } },
  './library-snapshots.ts': { openUpgradedDatabase: () => connection },
  './poster-storage.ts': { migratePosterStorage: () => ({ warnings: [] }), resolvePosterDirectory: () => root },
  './artwork-migration.ts': { migrateArtworkIntoLibrary: () => ({ warnings: [] }) },
  './portable': { isPortable: () => false }
}, { process, Buffer, Date, Set, Map, JSON })
try {
  const api = load('electron/services/database.ts')
  const facts = { file_name: 'app.exe', file_description: '', company: '', version: '', file_size: 1, external_active_at: 0 }
  const payload = (exe: string, category = '开发工具') => ({ name_zh: '新版名称', name_en: '', summary: '新版简介', description: '', category, tags: [], official_url: '', source_dir: root, is_portable: true, move_risk: 'safe', launchers: [{ path: exe, label: '', kind: 'main', is_default: true }] })
  const scanned = (name: string) => api.insertScanned([{ ...facts, exe_path: path.join(root, name + '.exe') }])[0]
  const item = scanned('first')
  api.updateSoftware(item.id, { category: '用户分类' })
  api.registerSoftware(payload(item.exe_path), facts)
  assert.equal(api.getSoftware(item.id).category, '用户分类', 'AI must preserve a category chosen before registration')
  assert.equal(api.getSoftware(item.id).summary, '新版简介')
  const other = scanned('other')
  api.updateSoftware(other.id, { category: '其他' })
  api.registerSoftware(payload(other.exe_path), facts)
  assert.equal(api.getSoftware(other.id).category, '其他', 'explicit Other is a category choice')
  const fresh = scanned('fresh')
  api.registerSoftware(payload(fresh.exe_path), facts)
  assert.equal(api.getSoftware(fresh.id).category, '开发工具', 'default placeholder still receives first AI category')
  api.registerSoftware(payload(fresh.exe_path, '媒体娱乐'), facts)
  assert.equal(api.getSoftware(fresh.id).category, '开发工具', 'existing AI category is also preserved')
  const legacy = scanned('legacy')
  db.prepare("UPDATE resource SET category = '旧分类' WHERE id = ?").run(legacy.id)
  api.registerSoftware(payload(legacy.exe_path), facts)
  assert.equal(api.getSoftware(legacy.id).category, '旧分类')
  const completedOther = scanned('completed-other')
  db.prepare("UPDATE resource SET ai_status = 'done' WHERE id = ?").run(completedOther.id)
  api.registerSoftware(payload(completedOther.exe_path), facts)
  assert.equal(api.getSoftware(completedOther.id).category, '其他')
  initSchema(db, KINDS)
  assert.equal(api.getSoftware(other.id).category, '其他', 'migration must be idempotent')
  const staged=api.stagePending(payload(item.exe_path,'媒体娱乐'),facts,'','')
  assert.equal(api.listPending().find((value:any)=>value.id===staged.id).category,'用户分类','confirmation should show the preserved category')
  api.updateSoftware(item.id,{category:'识别期间的选择'})
  api.confirmPending([staged.id])
  assert.equal(api.getSoftware(item.id).category,'识别期间的选择','confirmation must read the latest user choice')
  api.patchSettings({video_download_concurrency:4,video_download_connections:8})
  assert.throws(()=>api.patchSettings({video_download_concurrency:0}),/整数/)
  assert.throws(()=>api.patchSettings({video_download_connections:9}),/整数/)
  const oldCategory=api.getSoftware(item.id).category
  const removedTag=db.prepare("SELECT id FROM tags WHERE kind = 'software' LIMIT 1").get() as {id:number}
  db.prepare('DELETE FROM tags WHERE id = ?').run(removedTag.id)
  db.exec('ALTER TABLE software_meta DROP COLUMN category_locked')
  db.prepare("UPDATE settings SET value = '15' WHERE key = '_schema'").run()
  initSchema(db,KINDS)
  assert.equal(api.getSoftware(item.id).category,oldCategory,'upgrading a version-15 library must retain categories')
  assert.equal(db.prepare('SELECT id FROM tags WHERE id = ?').get(removedTag.id),undefined,'classification migration must not re-add removed tags')
  api.registerSoftware(payload(item.exe_path),facts)
  assert.equal(api.getSoftware(item.id).category,oldCategory)
  const chosenOther=scanned('chosen-other-unidentified')
  api.updateSoftware(chosenOther.id,{category:'其他'})
  const stale=scanned('unclassified-stale')
  assert.equal(api.pruneStaleBySourceDir(root,Date.now()+1000),1,'cleanup must only remove unclassified untouched placeholders')
  assert.equal(api.getSoftware(stale.id),null)
  assert.equal(api.getSoftware(item.id).category,oldCategory,'AI directory cleanup must retain classified software')
  assert.equal(api.getSoftware(chosenOther.id).category,'其他')
  console.log('PASS software category: user choices, Other, first recognition, existing AI and legacy categories, other fields and migration')
} finally {
  db.close()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  fs.rmSync(root, { recursive: true, force: true })
}
