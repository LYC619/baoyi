import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { seedImageLibrary } from './helpers/image-library-fixture.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-bulk-')), db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS); seedImageLibrary(db, root, 6)
const library = new ImageLibrary(db)
try {
  assert.equal(typeof library.bulkUpdate, 'function', 'atomic image bulk operation is required')
  const before = library.get('fixture-0')!, second = library.get('fixture-1')!, ids = [before.id, second.id]
  db.prepare('UPDATE image_pages SET missing=1 WHERE id=?').run('fixture-0-page-3')
  const missing = library.list().find(i => i.id === before.id)!
  assert.deepEqual(missing, library.get(before.id)); assert.equal(missing.progress, null); assert.notEqual(missing.coverPageId, before.coverPageId)
  db.prepare('UPDATE image_pages SET missing=0 WHERE id=?').run('fixture-0-page-3')
  for (const query of [{ read: true }, { read: false }, { tag: 'even' }, { groupId: 'image-group-1' }, { search: '00000' }, { type: 'photo' as const }, { sort: 'read' as const }]) {
    for (const item of library.list(query)) assert.deepEqual(item, library.get(item.id))
  }
  assert.equal(library.bulkUpdate([...ids, before.id], { read: true, groupId: 'image-group-2', tags: { mode: 'add', values: [' reviewed ', 'reviewed'] } }), 2)
  for (const id of ids) { const item = library.get(id)!; assert.equal(item.read, true); assert.equal(item.groupId, 'image-group-2'); assert.ok(item.tags.includes('reviewed')); assert.ok(item.tags.includes('fixture')) }
  assert.equal(library.get('fixture-0')!.publication, before.publication)
  assert.deepEqual(library.get('fixture-0')!.progress, before.progress)
  library.bulkUpdate(ids, { groupId: null, read: false, tags: { mode: 'remove', values: ['reviewed', 'fixture'] } })
  assert.deepEqual(library.get(before.id)!.tags, ['even']); assert.deepEqual(library.get(second.id)!.tags, ['odd'])
  assert.equal(library.get(before.id)!.groupId, null); assert.equal(library.get(before.id)!.read, false)
  library.bulkUpdate(ids, { tags: { mode: 'replace', values: [] } }); assert.deepEqual(library.get(before.id)!.tags, [])
  const unchanged = library.list()
  for (const patch of [{ read: 'yes' }, { groupId: 'missing' }, { tags: { mode: 'unknown', values: [] } }, { tags: { mode: 'add', values: [12] } }, { favorite: true }, {}, { tags: null }, { groupId: 1 }]) {
    assert.throws(() => library.bulkUpdate(ids, patch as any)); assert.deepEqual(library.list(), unchanged)
  }
  for (const selection of [[], ['fixture-0', 'missing'], ['fixture-0', 1], Array(5001).fill('fixture-0'), 'fixture-0']) {
    assert.throws(() => library.bulkUpdate(selection as any, { read: true })); assert.deepEqual(library.list(), unchanged)
  }
  const group = library.saveGroup({ name: 'hidden-group' }); library.update('fixture-2', { groupId: group.id }); library.saveGroup({ ...group, hidden: true })
  const visibleBefore = library.list()
  for (const query of [{ search: 'fixture' }, { read: false }, { groupId: group.id }, { tag: 'even' }, { sort: 'read' as const }]) assert.equal(library.list(query).some(i => i.id === 'fixture-2'), false)
  assert.throws(() => library.bulkUpdate(['fixture-0', 'fixture-2'], { read: true }), /不可用|隐藏/)
  assert.throws(() => library.bulkUpdate(ids, { groupId: group.id }), /不可用|隐藏/)
  assert.deepEqual(library.list(), visibleBefore)
  db.exec("CREATE TRIGGER bulk_fail BEFORE UPDATE OF tags ON resource WHEN NEW.id='fixture-1' BEGIN SELECT RAISE(ABORT,'injected bulk write error'); END")
  assert.throws(() => library.bulkUpdate(ids, { read: true, tags: { mode: 'add', values: ['rollback'] } }), /injected/)
  assert.deepEqual(library.list(), visibleBefore, 'later write failure must roll back every selected resource')
  assert.equal(db.prepare("SELECT 1 FROM tags WHERE kind='image' AND name='rollback'").get(), undefined)
  db.exec('DROP TRIGGER bulk_fail')
  library.bulkUpdate(ids, { read: true })
  assert.equal(library.list({ read: true }).filter(i => ids.includes(i.id)).length, 2)
  assert.equal(library.list({ read: false }).some(i => ids.includes(i.id)), false)
  assert.deepEqual(fs.readdirSync(root), [], 'metadata changes must not write image files')
  console.log('PASS bulk classification/tags/read, hidden rules, validation, rollback and independent progress/publication')
} finally { db.close() }
