/** Isolated SQLite coverage for settings taxonomy; no real files or user database. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { imageTagCounts, renameImageTag } from '../electron/kinds/image/tags.ts'
import { videoTaxonomy, editVideoTaxonomy } from '../electron/kinds/video/taxonomy-settings.ts'

const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
const resource = db.prepare(`INSERT INTO resource(id,kind,path,file_name,name_zh,category,tags,is_archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)`)
function add(id: string, kind: string, category: string, archived = 0) { resource.run(id, kind, 'D:/fixture/' + id, id, id, category, '["old","target"]', archived) }
function tags(id: string) { return JSON.parse(String(db.prepare('SELECT tags FROM resource WHERE id=?').get(id)?.tags)) as string[] }
try {
  add('image-a', 'image', ''); add('image-hidden', 'image', ''); add('video-main', 'video', '电影'); add('video-hentai', 'video', '里番', 1)
  db.prepare('INSERT INTO image_groups(id,name,hidden) VALUES(?,?,1)').run('hidden', 'Hidden')
  db.prepare("INSERT INTO image_meta(resource_id,item_type) VALUES('image-a','comic')").run()
  db.prepare("INSERT INTO image_meta(resource_id,item_type,group_id) VALUES('image-hidden','comic','hidden')").run()
  assert.equal(imageTagCounts(db).find(tag => tag.name === 'old')?.count, 2)
  assert.equal(renameImageTag(db, 'old', 'target'), 2)
  assert.deepEqual(tags('image-a'), ['target']); assert.deepEqual(tags('image-hidden'), ['target']); assert.deepEqual(tags('video-main'), ['old', 'target'])
  assert.equal(renameImageTag(db, 'target', null), 2); assert.deepEqual(tags('image-hidden'), [])

  for (const id of ['video-main', 'video-hentai']) {
    db.prepare('INSERT INTO video_meta(resource_id,collection_name,hanime_tags) VALUES(?,?,?)').run(id, 'group', '["old","source"]')
    db.prepare('INSERT INTO episode(id,resource_id,episode,tags) VALUES(?,?,1,?)').run(id + '-ep', id, '["old","episode"]')
  }
  assert.equal(videoTaxonomy(db, true).tags.find(tag => tag.name === 'old')?.count, 1, 'count distinct works across all tag fields, including archive')
  assert.equal(editVideoTaxonomy(db, { hentai: true, field: 'tags', from: 'old', to: 'target' }), 1)
  assert.deepEqual(tags('video-hentai'), ['target']); assert.deepEqual(tags('video-main'), ['old', 'target'])
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT tags FROM episode WHERE id=?').get('video-hentai-ep')?.tags)), ['target', 'episode'])
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT hanime_tags FROM video_meta WHERE resource_id=?').get('video-hentai')?.hanime_tags)), ['target', 'source'])
  assert.equal(editVideoTaxonomy(db, { hentai: true, field: 'tags', from: 'episode', to: null }), 1)
  assert.equal(videoTaxonomy(db, true).tags.some(tag => tag.name === 'episode'), false)
  assert.equal(editVideoTaxonomy(db, { hentai: true, field: 'groups', from: 'group', to: null }), 1)
  assert.equal(videoTaxonomy(db, false).groups[0].name, 'group')
  assert.throws(() => editVideoTaxonomy(db, { hentai: true, field: 'groups', from: null, to: 'new', ids: ['video-hentai', 'video-main'] }), /范围/)
  assert.equal(videoTaxonomy(db, true).groups[0].name, '')

  // A failure after the resource tag update must roll the whole edit back.
  const before = tags('video-hentai')
  db.exec("CREATE TRIGGER reject_episode_tag BEFORE UPDATE OF tags ON episode BEGIN SELECT RAISE(ABORT,'fixture rejection'); END")
  assert.throws(() => editVideoTaxonomy(db, { hentai: true, field: 'tags', from: 'target', to: 'renamed' }), /fixture rejection/)
  assert.deepEqual(tags('video-hentai'), before)
  console.log('PASS hidden image tags, video scopes, archived works, episode tags, group removal, cross-scope rejection and rollback')
} finally { db.close() }
