import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import type { RegisterPayload } from '../src/types/index.ts'
import * as api from '../electron/kinds/software/db.ts'
import { getSettings, patchSettings } from '../electron/services/storage/settings-store.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-category-'))
const db = new DatabaseSync(':memory:')
initSchema(db, KINDS)
const prepare = db.prepare.bind(db)
db.prepare = (sql: string) => {
  const statement = prepare(sql), run = statement.run.bind(statement)
  const names = new Set([...sql.matchAll(/[@:$](\w+)/g)].map(match => match[1]))
  statement.run = (...args: any[]) => run(...args.map(value => value && typeof value === 'object' && !ArrayBuffer.isView(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => names.has(key))) : value))
  return statement
}
try {
  const facts = { file_name: 'app.exe', file_description: '', company: '', version: '', file_size: 1, external_active_at: 0 }
  const payload = (exe: string, category = '开发工具'): RegisterPayload => ({ name_zh: '新版名称', name_en: '', summary: '新版简介', description: '', category, tags: [], official_url: '', source_dir: root, is_portable: true, move_risk: 'safe', launchers: [{ path: exe, label: '', kind: 'main', is_default: true }] })
  const scanned = (name: string) => api.insertScanned(db, [{ ...facts, exe_path: path.join(root, name + '.exe') }])[0]
  const item = scanned('first')
  api.updateSoftware(db, item.id, { category: '用户分类' })
  api.registerSoftware(db, payload(item.exe_path), facts)
  assert.equal(api.getSoftware(db, item.id)!.category, '用户分类', 'AI must preserve a category chosen before registration')
  assert.equal(api.getSoftware(db, item.id)!.summary, '新版简介')
  const other = scanned('other')
  api.updateSoftware(db, other.id, { category: '其他' })
  api.registerSoftware(db, payload(other.exe_path), facts)
  assert.equal(api.getSoftware(db, other.id)!.category, '其他', 'explicit Other is a category choice')
  const fresh = scanned('fresh')
  api.registerSoftware(db, payload(fresh.exe_path), facts)
  assert.equal(api.getSoftware(db, fresh.id)!.category, '开发工具', 'default placeholder still receives first AI category')
  api.registerSoftware(db, payload(fresh.exe_path, '媒体娱乐'), facts)
  assert.equal(api.getSoftware(db, fresh.id)!.category, '开发工具', 'existing AI category is also preserved')
  const legacy = scanned('legacy')
  db.prepare("UPDATE resource SET category = '旧分类' WHERE id = ?").run(legacy.id)
  api.registerSoftware(db, payload(legacy.exe_path), facts)
  assert.equal(api.getSoftware(db, legacy.id)!.category, '旧分类')
  const completedOther = scanned('completed-other')
  db.prepare("UPDATE resource SET ai_status = 'done' WHERE id = ?").run(completedOther.id)
  api.registerSoftware(db, payload(completedOther.exe_path), facts)
  assert.equal(api.getSoftware(db, completedOther.id)!.category, '其他')
  initSchema(db, KINDS)
  assert.equal(api.getSoftware(db, other.id)!.category, '其他', 'migration must be idempotent')
  const staged=api.stagePending(db, payload(item.exe_path,'媒体娱乐'),facts,'','')
  assert.ok(staged)
  assert.equal(api.listPending(db).find(value=>value.id===staged.id)!.category,'用户分类','confirmation should show the preserved category')
  api.updateSoftware(db, item.id,{category:'识别期间的选择'})
  api.confirmPending(db, [staged.id])
  assert.equal(api.getSoftware(db, item.id)!.category,'识别期间的选择','confirmation must read the latest user choice')
  patchSettings(db, {video_download_concurrency:4,video_download_connections:8})
  assert.throws(()=>patchSettings(db, {video_download_concurrency:0}),/整数/)
  assert.throws(()=>patchSettings(db, {video_download_connections:9}),/整数/)
  assert.ok(Object.keys(getSettings(db)).every(key => !key.startsWith('_')), 'internal schema keys must not be exposed as settings')
  const oldCategory=api.getSoftware(db, item.id)!.category
  const removedTag=db.prepare("SELECT id FROM tags WHERE kind = 'software' LIMIT 1").get() as {id:number}
  db.prepare('DELETE FROM tags WHERE id = ?').run(removedTag.id)
  db.exec('ALTER TABLE software_meta DROP COLUMN category_locked')
  db.prepare("UPDATE settings SET value = '15' WHERE key = '_schema'").run()
  initSchema(db,KINDS)
  assert.equal(api.getSoftware(db, item.id)!.category,oldCategory,'upgrading a version-15 library must retain categories')
  assert.equal(db.prepare('SELECT id FROM tags WHERE id = ?').get(removedTag.id),undefined,'classification migration must not re-add removed tags')
  api.registerSoftware(db, payload(item.exe_path),facts)
  assert.equal(api.getSoftware(db, item.id)!.category,oldCategory)
  const chosenOther=scanned('chosen-other-unidentified')
  api.updateSoftware(db, chosenOther.id,{category:'其他'})
  const stale=scanned('unclassified-stale')
  assert.equal(api.pruneStaleBySourceDir(db, root,Date.now()+1000),1,'cleanup must only remove unclassified untouched placeholders')
  assert.equal(api.getSoftware(db, stale.id),null)
  assert.equal(api.getSoftware(db, item.id)!.category,oldCategory,'AI directory cleanup must retain classified software')
  assert.equal(api.getSoftware(db, chosenOther.id)!.category,'其他')
  const beforeFailure = api.getSoftware(db, item.id)
  db.exec(`CREATE TRIGGER fail_software_write BEFORE UPDATE ON software_meta
    WHEN NEW.version = 'rollback-fixture' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`)
  assert.throws(() => api.updateSoftware(db, item.id, { category: 'must roll back', version: 'rollback-fixture' }), /fixture write failure/)
  assert.deepEqual(api.getSoftware(db, item.id), beforeFailure, 'a failed metadata write must roll back resource and category updates')
  db.exec('DROP TRIGGER fail_software_write; BEGIN')
  api.updateSoftware(db, item.id, { summary: 'inside outer transaction' })
  db.exec('ROLLBACK')
  assert.deepEqual(api.getSoftware(db, item.id), beforeFailure, 'the shared transaction helper must preserve an enclosing transaction')
  console.log('PASS software category: user choices, Other, first recognition, existing AI and legacy categories, other fields and migration')
} finally {
  db.close()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  fs.rmSync(root, { recursive: true, force: true })
}
