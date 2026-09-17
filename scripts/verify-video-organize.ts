import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { initSchema, type SqlDb } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent, registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { writeBundleFiles, readVideoBundle } from '../electron/kinds/video/bundle.ts'
import { checkVideoAssets, getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import {
  previewVideoOrganize, applyVideoOrganize, retryVideoOrganize, rollbackVideoOrganize,
  listVideoOrganizeJournal, previewVideoRelocate, relocateVideoDirectory, resolveVideoOrganizeOwner
} from '../electron/kinds/video/organize.ts'

// A child really exits during a SQLite trigger, leaving a durable journal and uncommitted DB transaction.
if (process.argv[2] === '--interrupt') {
  const interrupted = new DatabaseSync(process.argv[3])
  interrupted.exec('PRAGMA foreign_keys = ON')
  interrupted.function('interrupt_process', () => process.exit(86))
  await applyVideoOrganize(interrupted, { preview: JSON.parse(fs.readFileSync(process.argv[4], 'utf8')), mode: 'physical' })
  process.exit(87)
}

if (process.argv[2] === '--interrupt-without-links') {
  // The host has NTFS fixtures. Only emulate the filesystem's lack of hard links;
  // staging, exclusive publication, durable journal writes and interruption are real.
  fs.linkSync = () => { throw Object.assign(new Error('fixture: hard links unavailable'), { code: 'ENOTSUP' }) }
  const interrupted = new DatabaseSync(process.argv[3])
  interrupted.exec('PRAGMA foreign_keys = ON')
  const connection: SqlDb = {
    exec: sql => interrupted.exec(sql),
    prepare(sql) {
      const statement: ReturnType<SqlDb['prepare']> = interrupted.prepare(sql)
      return {
        all: (...args) => statement.all(...args),
        get: (...args) => statement.get(...args),
        run(...args) {
          const result = statement.run(...args)
          if (sql.startsWith('UPDATE video_organize_journal')) {
            const journal = JSON.parse(String(args[2]))
            const pending = journal.files.find((file: any) => file.status === 'copying' && file.targetIdentity)
            if (pending) {
              const length = Number(process.argv[5])
              if (length) fs.appendFileSync(pending.destination, fs.readFileSync(pending.stage).subarray(0, length))
              process.exit(86)
            }
          }
          return result
        }
      }
    }
  }
  await applyVideoOrganize(connection, { preview: JSON.parse(fs.readFileSync(process.argv[4], 'utf8')), mode: 'physical' })
  process.exit(87)
}

// Stop after a real SQLite commit, before cleanup/final journal publication can run.
if (process.argv[2] === '--interrupt-relocate-commit' || process.argv[2] === '--interrupt-rollback-commit') {
  const interrupted = new DatabaseSync(process.argv[3])
  interrupted.exec('PRAGMA foreign_keys = ON')
  const relocating = process.argv[2] === '--interrupt-relocate-commit'
  const connection: SqlDb = {
    prepare: sql => interrupted.prepare(sql),
    exec(sql) {
      interrupted.exec(sql)
      if (sql.startsWith('RELEASE SAVEPOINT') && interrupted.prepare(relocating
        ? "SELECT id FROM video_organize_journal WHERE json_extract(data, '$.bound') = 1 AND status = 'running'"
        : "SELECT id FROM video_organize_journal WHERE status IN ('rolled-back', 'rollback-partial')").get()) process.exit(86)
    }
  }
  if (relocating) await relocateVideoDirectory(connection, { preview: JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) })
  else await rollbackVideoOrganize(connection, process.argv[4])
  process.exit(87)
}

type Fixture = { db: DatabaseSync; root: string }
let passed = 0
let failed = 0
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice('--filter='.length)
async function test(name: string, run: (f: Fixture) => void | Promise<void>) {
  if (filter && !name.includes(filter)) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-video-organize-'))
  const db = new DatabaseSync(path.join(root, 'fixture.sqlite'))
  try {
    db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
    await run({ db, root })
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'foreign keys remain intact')
    passed++
  } catch (error) {
    failed++; console.error('FAIL', name, error)
  } finally {
    db.close()
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('baoyi-video-organize-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

function file(root: string, relative: string, bytes = relative): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  return target
}
function work(f: Fixture, name: string, number: number, relative = `${name}/${name}.mp4`) {
  const video = file(f.root, relative, 'video-content:' + name)
  const result = registerVideoContent(f.db, {
    title: name,
    items: [{ title: name + ' item', order: number, season: 1, number,
      sources: [{ provider: 'fixture', externalId: name, scope: 'episode', pageUrl: '', evidence: 'confirmed' }],
      files: [{ path: video, quality: '1080p', size: fs.statSync(video).size }] }]
  })
  const ep = row(f.db, 'episode', 'resource_id', result.resourceId)
  return { id: result.resourceId, epId: String(ep.id), path: video }
}
function row(db: SqlDb, table: string, field: string, value: string): Record<string, any> {
  return db.prepare(`SELECT * FROM ${table} WHERE ${field} = ?`).get(value) as Record<string, any>
}
function request(f: Fixture, a: { id: string }, b: { id: string }) {
  return { resourceIds: [a.id, b.id], survivorId: a.id, root: f.root, targetDirectory: path.join(f.root, 'organized') }
}
function snapshot(db: SqlDb) {
  return JSON.stringify(['resource', 'video_meta', 'episode', 'video_sources', 'video_assets', 'video_episode_assets', 'video_directories']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
}

await test('preview and schema rerun never change records or files', f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const before = snapshot(f.db)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  assert.equal(snapshot(f.db), before)
  assert.equal(listVideoOrganizeJournal(f.db).length, 0)
  assert.equal(preview.survivor.resourceId, a.id)
  assert.deepEqual(preview.works.map(x => x.resourceId), [a.id, b.id])
  assert.ok(preview.files.some(x => x.source === b.path && path.isAbsolute(x.destination)))
  assert.equal(fs.existsSync(preview.targetDirectory), false)
  initSchema(f.db, KINDS)
  assert.equal(snapshot(f.db), before)
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'video-content:one')
})

await test('logical merge preserves IDs, ordering, versions, history, notes and source rows', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const alternate = file(f.root, 'two/alternate.mp4', 'second version')
  registerVideoContent(f.db, { resourceId: b.id, title: 'two', items: [{ id: b.epId, title: 'two item', order: 2, files: [{ path: alternate, quality: '720p' }] }] })
  f.db.prepare("UPDATE episode SET position_sec = 67, watch_status = 'watching', watched_at = 1234 WHERE id = ?").run(b.epId)
  f.db.prepare("UPDATE resource SET notes = 'source notes' WHERE id = ?").run(b.id)
  f.db.prepare("UPDATE video_meta SET user_edited = '[\"name_zh\"]' WHERE resource_id = ?").run(b.id)
  const assetIds = f.db.prepare('SELECT id FROM video_assets ORDER BY id').all()
  const sourceIds = f.db.prepare('SELECT id FROM video_sources ORDER BY id').all()
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  assert.equal(journal.status, 'applied')
  const episode = row(f.db, 'episode', 'id', b.epId)
  assert.equal(episode.resource_id, a.id); assert.equal(episode.episode, 2); assert.equal(episode.position_sec, 67)
  assert.equal(episode.watch_status, 'watching'); assert.equal(episode.watched_at, 1234)
  assert.equal(row(f.db, 'resource', 'id', b.id).notes, 'source notes')
  assert.equal(row(f.db, 'resource', 'id', b.id).is_archived, 1)
  assert.equal(row(f.db, 'video_meta', 'resource_id', b.id).user_edited, '["name_zh"]')
  assert.deepEqual(f.db.prepare('SELECT id FROM video_assets ORDER BY id').all(), assetIds)
  assert.deepEqual(f.db.prepare('SELECT id FROM video_sources ORDER BY id').all(), sourceIds)
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), a.id)
  assert.equal(fs.existsSync(journal.targetDirectory), false)
  assert.equal(listVideoOrganizeJournal(f.db, b.id)[0].id, journal.id)
})

await test('legacy donors follow explicit input order even when the survivor is in the middle', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2), c = work(f, 'three', 3)
  for (const item of [a, b, c]) f.db.prepare('DELETE FROM episode WHERE resource_id = ?').run(item.id)
  f.db.prepare("UPDATE video_meta SET position_sec = 52, watch_status = 'watching' WHERE resource_id = ?").run(c.id)
  const before = snapshot(f.db)
  const preview = previewVideoOrganize(f.db, { resourceIds: [c.id, b.id, a.id], survivorId: b.id })
  assert.equal(snapshot(f.db), before)
  assert.equal(preview.survivor.resourceId, b.id)
  assert.deepEqual(preview.works.map(x => x.resourceId), [c.id, b.id, a.id])
  assert.deepEqual(preview.episodes.map(x => [x.resourceId, x.season, x.episode]), [[c.id, 0, 1], [b.id, 0, 2], [a.id, 0, 3]])
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'logical' })
  assert.equal(journal.status, 'applied')
  assert.equal(row(f.db, 'episode', 'id', preview.episodes[0].id).position_sec, 52)
  assert.ok(preview.episodes.every(ep => row(f.db, 'episode', 'id', ep.id).resource_id === b.id))
})

await test('duplicate episode slots are explicit blockers, never silent renumbering', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 1)
  const preview = previewVideoOrganize(f.db, request(f, a, b)), before = snapshot(f.db)
  assert.equal(preview.canMerge, false)
  assert.ok(preview.collisions.some(x => x.code === 'episode-slot'))
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'logical' }))
  assert.equal(snapshot(f.db), before)
})

await test('physical organization copies, verifies, binds and publishes portable paths', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  assert.equal(journal.status, 'applied')
  for (const result of journal.files) {
    assert.equal(result.status, 'switched')
    assert.ok(result.sha256.length === 64)
    assert.deepEqual(fs.readFileSync(result.source), fs.readFileSync(result.destination))
  }
  const directory = row(f.db, 'video_directories', 'resource_id', a.id)
  assert.equal(directory.directory_path, journal.targetDirectory)
  assert.equal(directory.relative_path, 'organized')
  assert.equal(row(f.db, 'resource', 'id', a.id).path, journal.targetDirectory)
  const bundle = readVideoBundle(journal.targetDirectory)!
  assert.equal(bundle.bundle_id, directory.bundle_id)
  assert.deepEqual(bundle.items.map(x => x.id).sort(), [a.epId, b.epId].sort())
  assert.ok(bundle.items.every(x => x.files.every(y => !path.isAbsolute(y.path))))
  const restored = new DatabaseSync(':memory:')
  try {
    restored.exec('PRAGMA foreign_keys = ON'); initSchema(restored, KINDS)
    const imported = registerVideoBundle(restored, journal.targetDirectory)
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM episode WHERE resource_id = ?').get(imported.resourceId)?.n, 2)
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { restored.close() }
})

await test('missing file gives a partial result; retry survives a new database connection', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  fs.unlinkSync(b.path)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  assert.equal(journal.status, 'partial')
  assert.equal(journal.files.filter(x => x.status === 'switched').length, 1)
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, b.path)
  file(f.root, 'two/two.mp4', 'video-content:two')
  const reopened = new DatabaseSync(path.join(f.root, 'fixture.sqlite'))
  try {
    reopened.exec('PRAGMA foreign_keys = ON')
    const retried = await retryVideoOrganize(reopened, journal.id)
    assert.equal(retried.status, 'applied')
    assert.equal(retried.files[0].attempts, journal.files[0].attempts, 'completed copies are not repeated')
    assert.equal(row(reopened, 'episode', 'id', b.epId).resource_id, a.id)
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { reopened.close() }
})

await test('existing destinations and planned name collisions are never overwritten', async f => {
  const a = work(f, 'one', 1, 'one/shared.mp4'), b = work(f, 'two', 2, 'two/shared.mp4')
  let preview = previewVideoOrganize(f.db, request(f, a, b))
  assert.ok(preview.collisions.some(x => x.code === 'planned-destination-collision'))
  const names = Object.fromEntries(preview.files.map((x, i) => [x.id, `${i + 1}.mp4`]))
  preview = previewVideoOrganize(f.db, { ...request(f, a, b), fileNames: names })
  const stolen = preview.files[1].destination
  file(f.root, path.relative(f.root, stolen), 'someone else')
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'physical' }), /预览|变化|冲突/)
  assert.equal(fs.readFileSync(stolen, 'utf8'), 'someone else')
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, b.id)
})

await test('retry succeeds after a user moves an existing destination conflict out of the way', async f => {
  const item = managed(f), b = work(f, 'two', 2, 'two/occupied.mp4')
  const occupied = file(f.root, 'managed/occupied.mp4', 'a separate user file')
  const preview = previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId })
  assert.ok(preview.collisions.some(c => c.code === 'destination-exists'))
  const partial = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(partial.status, 'partial')
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'a separate user file')
  const preserved = path.join(item.directory, 'occupied.user.mp4')
  fs.renameSync(occupied, preserved)
  const retried = await retryVideoOrganize(f.db, partial.id)
  assert.equal(retried.status, 'applied', JSON.stringify(retried.files.map(x => x.error)))
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'a separate user file')
  assert.deepEqual(fs.readFileSync(occupied), fs.readFileSync(b.path))
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, occupied)
})

await test('invalid absolute/escaping destinations and unavailable roots are rejected without writes', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  assert.throws(() => previewVideoOrganize(f.db, { ...request(f, a, b), targetDirectory: '../escape' }))
  const preview = previewVideoOrganize(f.db, { ...request(f, a, b), root: path.join(f.root, 'offline'), targetDirectory: path.join(f.root, 'offline', 'work') })
  assert.equal(preview.canOrganize, false)
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'physical' }))
  assert.equal(fs.existsSync(path.join(f.root, 'offline')), false)
  const valid = previewVideoOrganize(f.db, request(f, a, b))
  const escaped = previewVideoOrganize(f.db, { ...request(f, a, b), fileNames: { [valid.files[0].id]: '../outside.mp4' } })
  assert.ok(escaped.collisions.some(x => x.code === 'unsafe-path'))
})

await test('stale previews cannot discard new episodes or work edits', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  f.db.prepare("UPDATE resource SET notes = 'edited after preview' WHERE id = ?").run(b.id)
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'logical' }), /预览|变化/)
  assert.equal(row(f.db, 'resource', 'id', b.id).notes, 'edited after preview')
})

await test('rollback preserves later progress, notes, versions and source metadata', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  f.db.prepare("UPDATE episode SET position_sec = 181, watch_status = 'watched', watched_at = 5678 WHERE id = ?").run(b.epId)
  f.db.prepare("UPDATE resource SET notes = 'new surviving note' WHERE id = ?").run(a.id)
  f.db.prepare("UPDATE resource SET notes = 'new source note' WHERE id = ?").run(b.id)
  f.db.prepare("UPDATE video_sources SET page_url = 'https://new.invalid' WHERE episode_id = ?").run(b.epId)
  f.db.prepare("UPDATE video_assets SET quality = 'user quality' WHERE resource_id = ?").run(a.id)
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(undone.status, 'rolled-back')
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, b.id)
  assert.equal(row(f.db, 'episode', 'id', b.epId).position_sec, 181)
  assert.equal(row(f.db, 'episode', 'id', b.epId).watched_at, 5678)
  assert.equal(row(f.db, 'resource', 'id', a.id).notes, 'new surviving note')
  assert.equal(row(f.db, 'resource', 'id', b.id).notes, 'new source note')
  assert.equal(row(f.db, 'resource', 'id', b.id).is_archived, 0)
  assert.equal(row(f.db, 'video_sources', 'episode_id', b.epId).page_url, 'https://new.invalid')
  assert.equal(row(f.db, 'video_assets', 'resource_id', b.id).quality, 'user quality')
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, b.path)
  assert.ok(journal.files.every(x => fs.existsSync(x.destination)))
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), b.id)
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
})

await test('rollback keeps a later user path choice instead of restoring stale file references', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  const selected = file(f.root, 'user-selected.mp4', 'new user file')
  f.db.prepare('UPDATE episode SET path = ? WHERE id = ?').run(selected, b.epId)
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, selected)
  assert.ok(undone.conflicts.length > 0)
})

await test('movie legacy fields are materialized only on apply and recoverable on rollback', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  f.db.prepare('DELETE FROM episode WHERE resource_id = ?').run(b.id)
  f.db.prepare("UPDATE video_meta SET position_sec = 82, watch_status = 'watching' WHERE resource_id = ?").run(b.id)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  assert.ok(preview.episodes.some(x => x.resourceId === b.id && x.generated))
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'logical' })
  const generated = preview.episodes.find(x => x.resourceId === b.id && x.generated)!
  assert.equal(row(f.db, 'episode', 'id', generated.id).position_sec, 82)
  f.db.prepare('UPDATE episode SET position_sec = 99 WHERE id = ?').run(generated.id)
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(row(f.db, 'episode', 'id', generated.id).position_sec, 99)
  assert.equal(row(f.db, 'episode', 'id', generated.id).resource_id, b.id)
  assert.ok(['rolled-back', 'rollback-partial'].includes(undone.status))
})

await test('library observation timestamps do not invalidate a confirmed collection preview', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  getVideoWorkLibrary(f.db, a.id); getVideoWorkLibrary(f.db, b.id)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  const before = snapshot(f.db), now = Date.now
  Date.now = () => now() + 1000
  try { getVideoWorkLibrary(f.db, a.id); getVideoWorkLibrary(f.db, b.id) } finally { Date.now = now }
  assert.notEqual(snapshot(f.db), before, 'real library reads refresh their observation timestamps')
  assert.equal(previewVideoOrganize(f.db, preview.request).fingerprint, preview.fingerprint)
  assert.equal((await applyVideoOrganize(f.db, { preview, mode: 'physical' })).status, 'applied')
})

await test('library observation tolerance still rejects changed files and asset metadata', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  fs.appendFileSync(b.path, 'changed bytes')
  checkVideoAssets(f.db, b.id)
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'physical' }), /预览|变化/)
  const fresh = previewVideoOrganize(f.db, request(f, a, b))
  f.db.prepare("UPDATE video_assets SET quality = 'changed metadata' WHERE resource_id = ?").run(a.id)
  await assert.rejects(applyVideoOrganize(f.db, { preview: fresh, mode: 'physical' }), /预览|变化/)
  assert.equal(listVideoOrganizeJournal(f.db).length, 0)
})

await test('ordinary library checks do not block rollback or retain generated legacy rows', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  f.db.prepare('DELETE FROM episode WHERE resource_id = ?').run(b.id)
  f.db.prepare('DELETE FROM video_assets WHERE resource_id = ?').run(b.id)
  const preview = previewVideoOrganize(f.db, { ...request(f, a, b), transfer: 'move' })
  const generated = preview.episodes.find(ep => ep.resourceId === b.id && ep.generated)!
  assert.ok(generated)
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const moved = row(f.db, 'episode', 'id', generated.id).path
  const asset = row(f.db, 'video_assets', 'path', moved)
  const now = Date.now
  Date.now = () => Number(asset.checked_at) + 1000
  try { getVideoWorkLibrary(f.db, a.id) } finally { Date.now = now }
  assert.ok(row(f.db, 'video_assets', 'id', asset.id).checked_at > asset.checked_at)
  // An ordinary check may observe an unavailable drive/file before it becomes available again.
  fs.renameSync(moved, moved + '.temporarily-unavailable')
  try { checkVideoAssets(f.db, a.id) } finally { fs.renameSync(moved + '.temporarily-unavailable', moved) }
  assert.equal(row(f.db, 'video_assets', 'id', asset.id).state, 'missing')
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(undone.status, 'rolled-back', JSON.stringify(undone.conflicts))
  assert.ok(!undone.warnings.some(warning => warning.includes('保留整理后修改或新增关联')))
  assert.equal(row(f.db, 'episode', 'id', generated.id), undefined)
  assert.equal(row(f.db, 'video_assets', 'id', asset.id), undefined)
  assert.equal(row(f.db, 'episode', 'id', a.epId).path, a.path)
  assert.equal(row(f.db, 'video_assets', 'resource_id', a.id).path, a.path)
  assert.equal(row(f.db, 'resource', 'id', b.id).is_archived, 0)
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'video-content:two')
})

await test('a user quality edit still retains a generated asset after library checks', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  f.db.prepare('DELETE FROM episode WHERE resource_id = ?').run(b.id)
  f.db.prepare('DELETE FROM video_assets WHERE resource_id = ?').run(b.id)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  const generated = preview.episodes.find(ep => ep.resourceId === b.id && ep.generated)!
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'logical' })
  getVideoWorkLibrary(f.db, a.id)
  const asset = row(f.db, 'video_assets', 'path', b.path)
  f.db.prepare('UPDATE video_assets SET quality = ? WHERE id = ?').run('user quality', asset.id)
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(undone.status, 'rolled-back', JSON.stringify(undone.conflicts))
  assert.equal(row(f.db, 'video_assets', 'id', asset.id).quality, 'user quality')
  assert.equal(row(f.db, 'video_assets', 'id', asset.id).resource_id, b.id)
  assert.equal(row(f.db, 'episode', 'id', generated.id).resource_id, b.id)
  assert.ok(row(f.db, 'video_episode_assets', 'asset_id', asset.id))
})

function managed(f: Fixture) {
  const video = file(f.root, 'managed/episode.mp4', 'portable video')
  const side = file(f.root, 'managed/subfolder/user-notes.txt', 'my notes')
  writeBundleFiles({ directory: path.dirname(video), title: 'Managed', description: 'Metadata', files: [{ path: video, title: 'Episode', order: 1 }] })
  const registered = registerVideoBundle(f.db, path.dirname(video))
  const ep = row(f.db, 'episode', 'resource_id', registered.resourceId)
  f.db.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 123 WHERE id = ?").run(ep.id)
  return { ...registered, directory: path.dirname(video), video, side, epId: String(ep.id) }
}

await test('whole-directory copy preserves untracked files, UUID, IDs, progress and rollback', async f => {
  const item = managed(f), destination = path.join(f.root, 'relocated')
  const preview = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'copy' })
  assert.equal(preview.canApply, true)
  assert.equal(fs.existsSync(destination), false)
  const journal = await relocateVideoDirectory(f.db, { preview })
  assert.equal(journal.status, 'applied')
  assert.equal(fs.readFileSync(path.join(destination, 'subfolder/user-notes.txt'), 'utf8'), 'my notes')
  assert.ok(fs.existsSync(item.video))
  assert.equal(row(f.db, 'episode', 'id', item.epId).position_sec, 123)
  assert.equal(row(f.db, 'video_directories', 'resource_id', item.resourceId).bundle_id, item.bundleId)
  assert.equal(row(f.db, 'episode', 'id', item.epId).path, path.join(destination, 'episode.mp4'))
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  assert.equal(row(f.db, 'episode', 'id', item.epId).path, item.video)
  assert.ok(fs.existsSync(path.join(destination, 'episode.mp4')))
})

await test('explicit rebind of a copied manifest keeps history; ordinary registration cannot steal it', async f => {
  const item = managed(f), destination = path.join(f.root, 'copy')
  fs.cpSync(item.directory, destination, { recursive: true })
  assert.throws(() => registerVideoBundle(f.db, destination), /副本|绑定/)
  const preview = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'rebind' })
  const journal = await relocateVideoDirectory(f.db, { preview })
  assert.equal(journal.status, 'applied')
  assert.equal(row(f.db, 'episode', 'id', item.epId).position_sec, 123)
  assert.equal(row(f.db, 'video_directories', 'resource_id', item.resourceId).directory_path, destination)
  assert.equal(registerVideoBundle(f.db, destination).resourceId, item.resourceId)
})

await test('relocation rejects wrong UUID, escaping manifest and mismatched files', async f => {
  const item = managed(f), destination = path.join(f.root, 'bad-copy')
  fs.cpSync(item.directory, destination, { recursive: true })
  const manifestPath = path.join(destination, 'baoyi.json')
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  fs.writeFileSync(manifestPath, JSON.stringify({ ...original, bundle_id: randomUUID() }))
  const bad = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'rebind' })
  assert.equal(bad.canApply, false)
  await assert.rejects(relocateVideoDirectory(f.db, { preview: bad }))
  original.items[0].files[0].path = '../escape.mp4'
  fs.writeFileSync(manifestPath, JSON.stringify(original))
  assert.equal(previewVideoRelocate(f.db, bad.request).canApply, false)
  fs.copyFileSync(path.join(item.directory, 'baoyi.json'), manifestPath)
  fs.writeFileSync(path.join(destination, 'episode.mp4'), 'wrong content!')
  const mismatched = previewVideoRelocate(f.db, bad.request)
  if (mismatched.canApply) assert.equal((await relocateVideoDirectory(f.db, { preview: mismatched })).status, 'partial')
  assert.equal(row(f.db, 'video_directories', 'resource_id', item.resourceId).directory_path, item.directory)
})

await test('symlink or junction destination cannot escape the approved root', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const outside = path.join(f.root, 'outside'), root = path.join(f.root, 'safe')
  fs.mkdirSync(outside); fs.mkdirSync(root)
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const preview = previewVideoOrganize(f.db, { ...request(f, a, b), root, targetDirectory: path.join(root, 'link', 'work') })
  assert.equal(preview.canOrganize, false)
  await assert.rejects(applyVideoOrganize(f.db, { preview, mode: 'physical' }))
  assert.deepEqual(fs.readdirSync(outside), [])
})

await test('a reference transaction failure retains the verified copy and retries without overwriting', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const bAsset = row(f.db, 'video_assets', 'resource_id', b.id)
  f.db.exec(`CREATE TRIGGER reject_path BEFORE UPDATE OF path ON video_assets WHEN OLD.id = '${bAsset.id}' BEGIN SELECT RAISE(ABORT, 'fixture reference failure'); END`)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  assert.equal(journal.status, 'partial')
  assert.equal(journal.files.find(x => x.source === b.path)?.status, 'failed')
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, b.path)
  const copied = journal.files.find(x => x.source === b.path)!.destination
  const before = fs.statSync(copied)
  f.db.exec('DROP TRIGGER reject_path')
  const retried = await retryVideoOrganize(f.db, journal.id)
  assert.equal(retried.status, 'applied')
  assert.equal(fs.statSync(copied).ino, before.ino)
  assert.equal(fs.statSync(copied).mtimeMs, before.mtimeMs)
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, copied)
})

await test('retry preserves user edits to a verified output whose reference transaction failed', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const bAsset = row(f.db, 'video_assets', 'resource_id', b.id)
  f.db.exec(`CREATE TRIGGER reject_path BEFORE UPDATE OF path ON video_assets WHEN OLD.id = '${bAsset.id}' BEGIN SELECT RAISE(ABORT, 'fixture reference failure'); END`)
  const partial = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  assert.equal(partial.status, 'partial')
  const copied = partial.files.find(x => x.source === b.path)!.destination
  fs.writeFileSync(copied, 'later user content')
  f.db.exec('DROP TRIGGER reject_path')
  const retried = await retryVideoOrganize(f.db, partial.id)
  assert.equal(retried.status, 'partial')
  assert.equal(fs.readFileSync(copied, 'utf8'), 'later user content')
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, b.path)
  await rollbackVideoOrganize(f.db, partial.id)
  assert.equal(fs.readFileSync(copied, 'utf8'), 'later user content')
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, b.id)
})

await test('relocation and rollback preserve external asset paths and their later file edits', async f => {
  const item = managed(f), external = file(f.root, 'outside/version.mp4', 'external version')
  const poster = file(f.root, 'outside/poster.jpg', 'external poster')
  registerVideoContent(f.db, { resourceId: item.resourceId, title: 'Managed', items: [{ id: item.epId, title: 'Episode', order: 1, files: [{ path: external, quality: 'external' }] }] })
  f.db.prepare('UPDATE video_meta SET poster_path = ?, fanart_path = ? WHERE resource_id = ?').run(poster, poster, item.resourceId)
  const assetId = row(f.db, 'video_assets', 'path', external).id
  const preview = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: path.join(f.root, 'relocated-external'), root: f.root, mode: 'copy' })
  assert.ok(preview.files.every(x => x.source !== external && x.source !== poster))
  const journal = await relocateVideoDirectory(f.db, { preview })
  assert.equal(journal.status, 'applied')
  assert.equal(row(f.db, 'video_assets', 'id', assetId).path, external)
  fs.writeFileSync(external, 'later external content')
  fs.writeFileSync(poster, 'later external poster')
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  assert.equal(row(f.db, 'video_assets', 'id', assetId).path, external)
  assert.equal(row(f.db, 'video_meta', 'resource_id', item.resourceId).poster_path, poster)
  assert.equal(fs.readFileSync(external, 'utf8'), 'later external content')
  assert.equal(fs.readFileSync(poster, 'utf8'), 'later external poster')
})

await test('a new version and source added after merging follows its episode during rollback', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  const added = file(f.root, 'later-version.mp4', 'later alternate quality')
  registerVideoContent(f.db, { resourceId: a.id, title: 'one', items: [{ id: b.epId, title: 'two', order: 2, files: [{ path: added, quality: 'new version' }],
    sources: [{ provider: 'later-source', externalId: 'new-id', scope: 'episode', pageUrl: 'https://new.invalid', evidence: 'confirmed' }] }] })
  const versionId = row(f.db, 'video_assets', 'path', added).id
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(undone.status, 'rolled-back')
  assert.equal(row(f.db, 'video_assets', 'id', versionId).resource_id, b.id)
  assert.equal(row(f.db, 'video_assets', 'id', versionId).quality, 'new version')
  assert.equal(row(f.db, 'video_sources', 'provider', 'later-source').resource_id, b.id)
  assert.ok(f.db.prepare('SELECT * FROM video_episode_assets WHERE asset_id = ? AND episode_id = ?').get(versionId, b.epId))
})

await test('edited legacy lists retain later attachments while old paths are rolled back', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const sub = file(f.root, 'one/sub.srt', 'old subtitles')
  f.db.prepare('UPDATE video_meta SET linked_files = ? WHERE resource_id = ?').run(JSON.stringify([{ path: sub, label: '字幕', type: 'other' }]), a.id)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
  const extra = file(f.root, 'later-notes.txt', 'later notes')
  const links = JSON.parse(row(f.db, 'video_meta', 'resource_id', a.id).linked_files)
  links[0].label = 'user changed label'; links.push({ path: extra, label: 'later', type: 'other' })
  f.db.prepare('UPDATE video_meta SET linked_files = ? WHERE resource_id = ?').run(JSON.stringify(links), a.id)
  await rollbackVideoOrganize(f.db, journal.id)
  const restored = JSON.parse(row(f.db, 'video_meta', 'resource_id', a.id).linked_files)
  assert.equal(restored[0].path, sub); assert.equal(restored[0].label, 'user changed label'); assert.equal(restored[1].path, extra)
})

await test('an offline source volume is distinguished from a missing file', async f => {
  if (process.platform !== 'win32') return
  const letter = [...'ZYXWVUTSRQPONMLKJIH'].find(c => !fs.existsSync(c + ':\\'))
  assert.ok(letter, 'test requires one unavailable drive letter')
  const a = work(f, 'one', 1), b = work(f, 'two', 2), offline = letter + ':\\baoyi-isolated-fixture\\two.mp4'
  f.db.prepare('UPDATE video_assets SET path = ? WHERE resource_id = ?').run(offline, b.id)
  f.db.prepare('UPDATE episode SET path = ? WHERE id = ?').run(offline, b.epId)
  f.db.prepare('UPDATE resource SET path = ? WHERE id = ?').run(offline, b.id)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  assert.equal(preview.files.find(x => x.source === offline)?.state, 'offline')
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(journal.status, 'partial')
  assert.equal(row(f.db, 'episode', 'id', b.epId).path, offline)
})

await test('a source directory moved externally can be rebound while preserving history', async f => {
  const item = managed(f), destination = path.join(f.root, 'externally-moved')
  fs.renameSync(item.directory, destination)
  const journal = await relocateVideoDirectory(f.db, { preview: previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'rebind' }) })
  assert.equal(journal.status, 'applied')
  assert.equal(row(f.db, 'episode', 'id', item.epId).position_sec, 123)
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rollback-partial')
  assert.equal(row(f.db, 'episode', 'id', item.epId).path, path.join(destination, 'episode.mp4'))
})

for (const interruption of ['references', 'manifest'] as const) await test('process interruption after verified publication recovers: ' + interruption, async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  const previewFile = file(f.root, 'preview.json', JSON.stringify(preview))
  f.db.exec(interruption === 'references'
    ? 'CREATE TRIGGER interrupt_operation BEFORE UPDATE OF path ON video_assets BEGIN SELECT interrupt_process(); END'
    : "CREATE TRIGGER interrupt_operation BEFORE UPDATE OF data ON video_organize_journal WHEN json_extract(NEW.data, '$.manifest.afterHash') != '' BEGIN SELECT interrupt_process(); END")
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt', path.join(f.root, 'fixture.sqlite'), previewFile], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  f.db.exec('DROP TRIGGER interrupt_operation')
  const [journal] = listVideoOrganizeJournal(f.db)
  assert.equal(journal.status, 'running')
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path))
  const recovered = await retryVideoOrganize(f.db, journal.id)
  assert.equal(recovered.status, 'applied', JSON.stringify(recovered.conflicts))
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, a.id)
  assert.equal(readVideoBundle(recovered.targetDirectory)?.items.length, 2)
})

await test('process interruption after relocation commit retries without rebinding old paths', async f => {
  const item = managed(f), destination = path.join(f.root, 'committed-relocation')
  const preview = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'copy' })
  const previewFile = file(f.root, 'preview.json', JSON.stringify(preview))
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt-relocate-commit', path.join(f.root, 'fixture.sqlite'), previewFile], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  const [journal] = listVideoOrganizeJournal(f.db)
  assert.equal(journal.status, 'running')
  assert.equal(row(f.db, 'video_directories', 'resource_id', item.resourceId).directory_path, destination)
  f.db.prepare('UPDATE episode SET position_sec = 321 WHERE id = ?').run(item.epId)
  const recovered = await retryVideoOrganize(f.db, journal.id)
  assert.equal(recovered.status, 'applied', JSON.stringify(recovered.conflicts))
  assert.equal(row(f.db, 'episode', 'id', item.epId).position_sec, 321)
  assert.ok(fs.existsSync(item.video))
  assert.ok(!fs.readdirSync(destination).some(name => name.endsWith('.part')))
})

await test('process interruption after rollback commit still restores the original manifest', async f => {
  const item = managed(f), b = work(f, 'two', 2)
  const manifestFile = path.join(item.directory, 'baoyi.json'), before = fs.readFileSync(manifestFile, 'utf8')
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId }), mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt-rollback-commit', path.join(f.root, 'fixture.sqlite'), journal.id], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, b.id)
  assert.notEqual(fs.readFileSync(manifestFile, 'utf8'), before)
  const recovered = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(recovered.status, 'rolled-back', JSON.stringify(recovered.conflicts))
  assert.ok(fs.readFileSync(manifestFile, 'utf8') === before, 'original manifest bytes are restored')
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), b.id)
})

await test('rollback recognizes a manifest published before its completion journal was saved', async f => {
  const item = managed(f), b = work(f, 'two', 2)
  const manifestFile = path.join(item.directory, 'baoyi.json'), before = fs.readFileSync(manifestFile, 'utf8')
  const preview = previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId })
  const previewFile = file(f.root, 'preview.json', JSON.stringify(preview))
  f.db.exec("CREATE TRIGGER interrupt_operation BEFORE UPDATE OF data ON video_organize_journal WHEN json_extract(NEW.data, '$.manifest.afterHash') != '' BEGIN SELECT interrupt_process(); END")
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt', path.join(f.root, 'fixture.sqlite'), previewFile], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  f.db.exec('DROP TRIGGER interrupt_operation')
  const [journal] = listVideoOrganizeJournal(f.db)
  const pending = JSON.parse(row(f.db, 'video_organize_journal', 'id', journal.id).data)
  assert.ok(pending.manifest.pendingHash)
  assert.equal(pending.manifest.afterHash, '')
  assert.notEqual(fs.readFileSync(manifestFile, 'utf8'), before)
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  assert.ok(fs.readFileSync(manifestFile, 'utf8') === before, 'pending publication is undone too')
})

for (const length of [0, 8]) await test('interrupted publication without hard links resumes owned output bytes: ' + length, async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const preview = previewVideoOrganize(f.db, request(f, a, b))
  const previewFile = file(f.root, 'preview.json', JSON.stringify(preview))
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt-without-links', path.join(f.root, 'fixture.sqlite'), previewFile, String(length)], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  const [journal] = listVideoOrganizeJournal(f.db)
  const destination = journal.files[0].destination
  const identity = fs.statSync(destination).ino
  assert.equal(fs.statSync(destination).size, length)
  const recorded = JSON.parse(row(f.db, 'video_organize_journal', 'id', journal.id).data).files[0].targetIdentity
  assert.deepEqual({ dev: recorded?.dev, ino: recorded?.ino }, { dev: fs.statSync(destination).dev, ino: identity }, 'published file identity is durable')
  const recovered = await retryVideoOrganize(f.db, journal.id)
  assert.equal(recovered.status, 'applied', JSON.stringify(recovered.files.map(x => x.error)))
  assert.equal(fs.statSync(destination).ino, identity, 'recovery appends rather than replacing output')
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(a.path))
  assert.equal(row(f.db, 'episode', 'id', a.epId).path, destination)
})

await test('interrupted publication without hard links preserves later edits to partial output', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const previewFile = file(f.root, 'preview.json', JSON.stringify(previewVideoOrganize(f.db, request(f, a, b))))
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt-without-links', path.join(f.root, 'fixture.sqlite'), previewFile, '8'], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  const [journal] = listVideoOrganizeJournal(f.db)
  const destination = journal.files[0].destination
  fs.writeFileSync(destination, 'user edit')
  const recovered = await retryVideoOrganize(f.db, journal.id)
  assert.equal(recovered.status, 'partial')
  assert.equal(fs.readFileSync(destination, 'utf8'), 'user edit')
  assert.equal(row(f.db, 'episode', 'id', a.epId).path, a.path)
})

await test('interrupted publication without hard links never adopts another file with matching prefix bytes', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const previewFile = file(f.root, 'preview.json', JSON.stringify(previewVideoOrganize(f.db, request(f, a, b))))
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), '--interrupt-without-links', path.join(f.root, 'fixture.sqlite'), previewFile, '8'], { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 86, child.stderr || child.error?.message)
  const [journal] = listVideoOrganizeJournal(f.db)
  const destination = journal.files[0].destination, prefix = fs.readFileSync(destination)
  const original = destination + '.user-retained'
  fs.renameSync(destination, original)
  fs.writeFileSync(destination, prefix)
  assert.notEqual(fs.statSync(destination).ino, fs.statSync(original).ino)
  assert.equal((await retryVideoOrganize(f.db, journal.id)).status, 'partial')
  assert.deepEqual(fs.readFileSync(destination), prefix)
  assert.deepEqual(fs.readFileSync(original), prefix)
  assert.equal(row(f.db, 'episode', 'id', a.epId).path, a.path)
})

await test('exclusive publication without hard links verifies every copied file', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const link = fs.linkSync
  try {
    fs.linkSync = () => { throw Object.assign(new Error('fixture: hard links unavailable'), { code: 'ENOTSUP' }) }
    const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'physical' })
    assert.equal(journal.status, 'applied', JSON.stringify(journal.files.map(x => x.error)))
    for (const result of journal.files) {
      assert.equal(result.status, 'switched')
      assert.equal(result.sha256.length, 64)
      assert.deepEqual(fs.readFileSync(result.source), fs.readFileSync(result.destination))
    }
    assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  } finally { fs.linkSync = link }
})

await test('a real cross-volume copy verifies bytes and retains original source files', async f => {
  const otherVolume = path.parse(process.cwd()).root
  // Node reports dev=0 on this Windows host; distinct resolved drive roots are the available evidence.
  const differentVolume = process.platform === 'win32'
    ? path.parse(fs.realpathSync(otherVolume)).root.toLowerCase() !== path.parse(fs.realpathSync(f.root)).root.toLowerCase()
    : fs.statSync(otherVolume).dev !== fs.statSync(f.root).dev
  if (!differentVolume) {
    console.log('SKIP actual cross-volume scenario: only one volume is available')
    return
  }
  const crossRoot = fs.mkdtempSync(path.join(otherVolume, 'baoyi-video-organize-cross-'))
  try {
    const a = work(f, 'one', 1), b = work(f, 'two', 2)
    const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { ...request(f, a, b), root: crossRoot, targetDirectory: path.join(crossRoot, 'work') }), mode: 'physical' })
    assert.equal(journal.status, 'applied')
    if (process.platform === 'win32') assert.notEqual(path.parse(journal.files[0].source).root.toLowerCase(), path.parse(journal.files[0].destination).root.toLowerCase())
    else assert.notEqual(fs.statSync(journal.files[0].source).dev, fs.statSync(journal.files[0].destination).dev)
    assert.deepEqual(fs.readFileSync(journal.files[0].source), fs.readFileSync(journal.files[0].destination))
    assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  } finally {
    const resolved = path.resolve(crossRoot)
    assert.equal(path.dirname(resolved), path.resolve(otherVolume))
    assert.ok(path.basename(resolved).startsWith('baoyi-video-organize-cross-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

await test('an already archived source still resolves to its merged survivor', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  f.db.prepare('UPDATE resource SET is_archived = 1 WHERE id = ?').run(b.id)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), a.id)
  await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), b.id)
  assert.equal(row(f.db, 'resource', 'id', b.id).is_archived, 1)
})

await test('rollback slot conflicts preserve ownership of files, sources and existing progress', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  const later = randomUUID()
  f.db.prepare('INSERT INTO episode (id, resource_id, season, episode, position_sec) VALUES (?, ?, 1, 2, 91)').run(later, b.id)
  const undone = await rollbackVideoOrganize(f.db, journal.id)
  assert.equal(undone.status, 'rollback-partial')
  assert.equal(row(f.db, 'episode', 'id', later).position_sec, 91)
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, a.id)
  assert.equal(row(f.db, 'video_sources', 'episode_id', b.epId).resource_id, a.id)
  const assets = f.db.prepare('SELECT a.resource_id FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id WHERE ea.episode_id = ?').all(b.epId)
  assert.ok(assets.every(asset => asset.resource_id === a.id))
})

await test('two pending organizations cannot reserve the same physical directory', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2), c = work(f, 'three', 3), e = work(f, 'four', 4)
  const firstPreview = previewVideoOrganize(f.db, request(f, a, b))
  const otherPreview = previewVideoOrganize(f.db, request(f, c, e))
  const first = applyVideoOrganize(f.db, { preview: firstPreview, mode: 'physical' })
  try { await assert.rejects(applyVideoOrganize(f.db, { preview: otherPreview, mode: 'physical' })) }
  finally { await first }
  assert.equal(row(f.db, 'episode', 'id', e.epId).resource_id, e.id)
})

await test('whole-directory copy includes empty directories', async f => {
  const item = managed(f), destination = path.join(f.root, 'all-folders')
  fs.mkdirSync(path.join(item.directory, 'empty', 'nested'), { recursive: true })
  const result = await relocateVideoDirectory(f.db, { preview: previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'copy' }) })
  assert.equal(result.status, 'applied')
  assert.ok(fs.statSync(path.join(destination, 'empty', 'nested')).isDirectory())
})

await test('files added during whole-directory copying prevent an incomplete rebind', async f => {
  const item = managed(f), destination = path.join(f.root, 'during-copy')
  const preview = previewVideoRelocate(f.db, { resourceId: item.resourceId, directory: destination, root: f.root, mode: 'copy' })
  const running = relocateVideoDirectory(f.db, { preview })
  const added = file(f.root, 'managed/later.txt', 'new user file')
  const result = await running
  assert.equal(result.status, 'partial')
  assert.equal(fs.readFileSync(added, 'utf8'), 'new user file')
  assert.equal(row(f.db, 'video_directories', 'resource_id', item.resourceId).directory_path, item.directory)
})

await test('existing bundle-only entries and custom metadata survive manifest synchronization', async f => {
  const item = managed(f), b = work(f, 'two', 2)
  const extra = file(f.root, 'managed/unregistered.mp4', 'an unregistered version')
  const manifestFile = path.join(item.directory, 'baoyi.json')
  const bundle = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  bundle.user_annotation = { text: 'keep custom bundle note' }
  bundle.work.custom_credit = 'original credit'
  bundle.items.push({ id: 'extra-item', title: 'Extra in bundle', label: 'Bonus', order: 99, season: 0, number: 99, sources: [], files: [{ path: path.basename(extra), quality: 'archive', size: fs.statSync(extra).size }], custom_note: 'keep item note' })
  fs.writeFileSync(manifestFile, JSON.stringify(bundle))
  const preview = previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId })
  const journal = await applyVideoOrganize(f.db, { preview, mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.deepEqual(saved.user_annotation, bundle.user_annotation)
  assert.equal(saved.work.custom_credit, 'original credit')
  assert.equal(saved.items.find((x: any) => x.id === 'extra-item')?.custom_note, 'keep item note')
  assert.equal(saved.items.filter((x: any) => x.files.some((v: any) => v.path === 'episode.mp4')).length, 1, 'legacy manifest IDs match their registered content by files')
})

await test('matched bundle items retain unregistered versions and nested file/source metadata', async f => {
  const item = managed(f), b = work(f, 'two', 2)
  const extra = file(f.root, 'managed/unregistered-version.mp4', 'an additional archived version')
  const manifestFile = path.join(item.directory, 'baoyi.json')
  const bundle = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const old = bundle.items[0]
  old.custom_note = 'a manually recorded item note'
  old.files[0].custom_credit = { encoder: 'local archive' }
  old.files.push({ path: path.basename(extra), quality: 'archive', size: fs.statSync(extra).size, custom_note: 'keep extra version' })
  const known = { provider: 'fixture', externalId: 'known', scope: 'episode', pageUrl: 'https://fixture.invalid/old', evidence: 'confirmed', custom_note: 'keep source credit' }
  const extraSource = { provider: 'fixture', externalId: 'unregistered', scope: 'episode', pageUrl: 'https://fixture.invalid/extra', evidence: 'confirmed' }
  old.sources = [known, extraSource]
  f.db.prepare("INSERT INTO video_sources (id, resource_id, episode_id, provider, external_id, scope, page_url, evidence, created_at, updated_at) VALUES (?, ?, ?, 'fixture', 'known', 'episode', 'https://fixture.invalid/new', 'confirmed', 1, 1)").run(randomUUID(), item.resourceId, item.epId)
  bundle.work.sources = [{ provider: 'work-fixture', externalId: 'unregistered-work', scope: 'work', pageUrl: '', evidence: 'confirmed', custom_note: 'keep work source' }]
  fs.writeFileSync(manifestFile, JSON.stringify(bundle))
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId }), mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const savedItem = saved.items.find((x: any) => x.id === item.epId)
  assert.equal(savedItem.custom_note, old.custom_note)
  assert.deepEqual(savedItem.files.find((x: any) => x.path === 'unregistered-version.mp4'), old.files[1])
  assert.deepEqual(savedItem.files.find((x: any) => x.path === 'episode.mp4').custom_credit, old.files[0].custom_credit)
  assert.deepEqual(savedItem.sources.find((x: any) => x.externalId === 'unregistered'), extraSource)
  assert.equal(savedItem.sources.find((x: any) => x.externalId === 'known').custom_note, known.custom_note)
  assert.equal(savedItem.sources.find((x: any) => x.externalId === 'known').pageUrl, 'https://fixture.invalid/new')
  assert.ok(saved.work.sources.some((x: any) => x.externalId === 'unregistered-work' && x.custom_note === 'keep work source'))
})

await test('manifest synchronization retains unregistered assets and a bundle-only poster', async f => {
  const item = managed(f), b = work(f, 'two', 2)
  const attachment = file(f.root, 'managed/archive-notes.txt', 'unregistered attachment')
  file(f.root, 'managed/user-poster.jpg', 'poster fixture')
  const manifestFile = path.join(item.directory, 'baoyi.json')
  const bundle = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const asset = row(f.db, 'video_assets', 'resource_id', item.resourceId)
  bundle.assets = [
    { id: asset.id, path: 'episode.mp4', role: 'video', quality: asset.quality, size: asset.file_size, episode_ids: [item.epId], custom_note: 'keep known asset note' },
    { id: 'bundle-only-asset', path: path.basename(attachment), role: 'attachment', quality: '', size: fs.statSync(attachment).size, episode_ids: [], custom_note: 'keep extra asset' }
  ]
  bundle.work.poster = 'user-poster.jpg'; bundle.work.poster_source = 'manual archive'
  fs.writeFileSync(manifestFile, JSON.stringify(bundle))
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [item.resourceId, b.id], survivorId: item.resourceId }), mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.deepEqual(saved.assets.find((x: any) => x.id === 'bundle-only-asset'), bundle.assets[1])
  assert.equal(saved.assets.find((x: any) => x.id === asset.id).custom_note, 'keep known asset note')
  assert.equal(saved.work.poster, 'user-poster.jpg')
  assert.equal(saved.work.poster_source, 'manual archive')
})

await test('exact bundle item identity wins over an earlier unregistered source alias', async f => {
  const item = managed(f)
  const bonus = file(f.root, 'managed/bonus.mp4', 'unregistered bonus')
  const manifestFile = path.join(item.directory, 'baoyi.json')
  const bundle = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const source = { provider: 'fixture', externalId: 'shared-claim', scope: 'episode', pageUrl: '', evidence: 'confirmed' }
  bundle.items[0].id = item.epId
  bundle.items[0].sources = [source]
  bundle.items[0].custom_note = 'canonical item note'
  const extra = { id: 'unregistered-first', title: 'Bonus', label: '', order: 99, season: 0, number: 99, sources: [source], files: [{ path: path.basename(bonus), quality: 'archive', size: fs.statSync(bonus).size }], custom_note: 'extra item note' }
  bundle.items.unshift(extra)
  fs.writeFileSync(manifestFile, JSON.stringify(bundle))
  f.db.prepare("INSERT INTO video_sources (id, resource_id, episode_id, provider, external_id, scope, created_at, updated_at) VALUES (?, ?, ?, 'fixture', 'shared-claim', 'episode', 1, 1)").run(randomUUID(), item.resourceId, item.epId)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [item.resourceId], survivorId: item.resourceId }), mode: 'physical' })
  assert.equal(journal.status, 'applied')
  const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.equal(saved.items.find((x: any) => x.id === item.epId).custom_note, 'canonical item note')
  assert.deepEqual(saved.items.find((x: any) => x.id === extra.id), extra)
})

await test('later shared assets keep the full ownership graph intact on partial rollback', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  const shared = file(f.root, 'shared-later.mp4', 'two contents share this file')
  f.db.prepare("INSERT INTO video_assets (id, resource_id, path, role, created_at) VALUES ('zzzz-shared', ?, ?, 'video', 1)").run(a.id, shared)
  for (const ep of [a.epId, b.epId]) f.db.prepare("INSERT INTO video_episode_assets (episode_id, asset_id) VALUES (?, 'zzzz-shared')").run(ep)
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rollback-partial')
  const mismatch = f.db.prepare('SELECT a.id FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id JOIN episode e ON e.id = ea.episode_id WHERE a.resource_id != e.resource_id').all()
  assert.deepEqual(mismatch, [])
})

await test('transitive shared assets keep chained merge aliases until ownership rollback completes', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2), c = work(f, 'three', 3)
  const first = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  const second = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { ...request(f, a, c), survivorId: c.id }), mode: 'logical' })
  f.db.prepare('UPDATE episode SET position_sec = 411 WHERE id = ?').run(b.epId)
  const asset = row(f.db, 'video_assets', 'path', b.path)
  f.db.prepare('INSERT INTO video_episode_assets (episode_id, asset_id) VALUES (?, ?)').run(a.epId, asset.id)
  const shared = file(f.root, 'transitive-shared.mp4', 'shared across two generations')
  f.db.prepare("INSERT INTO video_assets (id, resource_id, path, role, created_at) VALUES ('zzzz-transitive', ?, ?, 'video', 1)").run(c.id, shared)
  for (const epId of [a.epId, c.epId]) f.db.prepare("INSERT INTO video_episode_assets (episode_id, asset_id) VALUES (?, 'zzzz-transitive')").run(epId)
  assert.equal((await rollbackVideoOrganize(f.db, second.id)).status, 'rollback-partial')
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), c.id)
  assert.equal(resolveVideoOrganizeOwner(f.db, a.id), c.id)
  assert.deepEqual(f.db.prepare('SELECT a.id FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id JOIN episode e ON e.id = ea.episode_id WHERE a.resource_id != e.resource_id').all(), [])
  assert.deepEqual(f.db.prepare('SELECT s.id FROM video_sources s JOIN episode e ON e.id = s.episode_id WHERE s.resource_id != e.resource_id').all(), [])
  await assert.rejects(rollbackVideoOrganize(f.db, first.id), /后续|较新/)
  f.db.prepare("DELETE FROM video_episode_assets WHERE asset_id = 'zzzz-transitive' AND episode_id = ?").run(a.epId)
  f.db.prepare('DELETE FROM video_episode_assets WHERE asset_id = ? AND episode_id = ?').run(asset.id, a.epId)
  const recovered = await rollbackVideoOrganize(f.db, second.id)
  assert.equal(recovered.status, 'rolled-back', JSON.stringify(recovered.conflicts))
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), a.id)
  const finalRollback = await rollbackVideoOrganize(f.db, first.id)
  assert.equal(finalRollback.status, 'rolled-back', JSON.stringify(finalRollback.conflicts))
  assert.equal(resolveVideoOrganizeOwner(f.db, b.id), b.id)
  assert.equal(row(f.db, 'episode', 'id', b.epId).position_sec, 411)
  assert.equal(row(f.db, 'video_assets', 'id', 'zzzz-transitive').resource_id, c.id)
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared across two generations')
})

await test('rollback database failure cannot leave episode and asset owners split', async f => {
  const a = work(f, 'one', 1), b = work(f, 'two', 2)
  const journal = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, request(f, a, b)), mode: 'logical' })
  f.db.exec("CREATE TRIGGER reject_undo BEFORE UPDATE OF resource_id ON episode BEGIN SELECT RAISE(ABORT, 'fixture rollback failure'); END")
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rollback-partial')
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, a.id)
  assert.equal(row(f.db, 'video_sources', 'episode_id', b.epId).resource_id, a.id)
  assert.deepEqual(f.db.prepare('SELECT a.id FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id JOIN episode e ON e.id = ea.episode_id WHERE a.resource_id != e.resource_id').all(), [])
  f.db.exec('DROP TRIGGER reject_undo')
  assert.equal((await rollbackVideoOrganize(f.db, journal.id)).status, 'rolled-back')
  assert.equal(row(f.db, 'episode', 'id', b.epId).resource_id, b.id)
})

console.log(`Video organization: ${passed} passed / ${failed} failed`)
if (failed || !passed) process.exitCode = 1
