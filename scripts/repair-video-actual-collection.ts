/** One explicitly authorized example. Default is a database-copy rehearsal; --apply changes the guarded live work. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { getVideo, listEpisodes } from '../electron/kinds/video/db.ts'
import { syncVideoWorkFiles, persistVideoWorkBundle } from '../electron/kinds/video/local-sync.ts'
import { applyVideoCatalogue } from '../electron/kinds/video/catalogue.ts'
import { catalogueIdentity } from '../electron/kinds/video/episode-identity.ts'
import { fillEpisodeDetails } from '../electron/kinds/video/episode-details.ts'
import { previewVideoCollectionName, renameVideoCollection } from '../electron/kinds/video/collection-name.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { registerVideoBundle } from '../electron/kinds/video/registration.ts'
import { readVideoBundle, readEpisodeSidecar, atomicWrite } from '../electron/kinds/video/bundle.ts'
import type { VideoWorkSource } from '../electron/kinds/video/download/workflow.ts'

const apply = process.argv.includes('--apply')
const evidence = path.resolve('output/video-local-structure-20260912')
const database = 'C:/Users/yicha/AppData/Roaming/抱一/baoyi.db'
const root = path.resolve('E:/视频')
const original = path.join(root, '妻NTR・凌辱輪迴 4')
const title = '妻NTR・凌辱輪迴 0-4'
const destination = path.join(root, title)
const resourceId = 'b1200803-90dc-4289-8161-fd853f71f0df'
const duplicateId = 'aa6df460-4f3f-4c90-9dc2-bd0d06a0a4c6'
const bundleId = '1097fbdf-fe59-4dbd-8b11-6c78a3b589a4'
const affectedIds = new Set([resourceId, duplicateId])
const codes = ['100012', '12617', '13313', '39425', '87022']
const source = (code: string) => JSON.parse(fs.readFileSync(path.join(evidence, 'source', code + '.json'), 'utf8')) as VideoWorkSource
const expected = JSON.parse(fs.readFileSync(path.join(evidence, 'baseline/media-before.json'), 'utf8')) as { files: Array<{ name: string; size: number; sha256: string }> }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const stringify = (value: unknown) => JSON.stringify(value, (_, part) => typeof part === 'bigint' ? part.toString() : part)
const names = (directory: string) => fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
  assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'The example must remain a flat directory of regular files')
  return entry.name
})

async function mediaSnapshot(directory: string) {
  const media = names(directory).filter(name => /\.(mp4|mkv|avi|mov|m4v|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i.test(name)).sort()
  assert.deepEqual(media, expected.files.map(file => file.name).sort(), 'Actual media membership changed since the baseline')
  const result = []
  for (const file of expected.files) {
    const location = path.join(directory, file.name), hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(location)) hash.update(chunk)
    result.push({ name: file.name, size: fs.statSync(location).size, sha256: hash.digest('hex') })
  }
  assert.deepEqual(result, expected.files, 'A media file changed since the baseline')
  return result
}

function tables(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
}
function isAffected(table: string, row: any, episodeIds: Set<string>, assetIds: Set<string>) {
  if (table === 'resource') return affectedIds.has(row.id)
  if (['video_meta', 'episode', 'video_sources', 'video_assets', 'video_directories'].includes(table)) return affectedIds.has(row.resource_id)
  if (table === 'video_episode_assets') return episodeIds.has(row.episode_id) || assetIds.has(row.asset_id)
  if (table === 'video_download_jobs') {
    try { return affectedIds.has(JSON.parse(row.payload).resourceId) } catch { return false }
  }
  return false
}
function state(db: DatabaseSync) {
  const episodeIds = new Set((db.prepare('SELECT id,resource_id FROM episode').all() as Array<{ id: string; resource_id: string }>).filter(row => affectedIds.has(row.resource_id)).map(row => row.id))
  const assetIds = new Set((db.prepare('SELECT id,resource_id FROM video_assets').all() as Array<{ id: string; resource_id: string }>).filter(row => affectedIds.has(row.resource_id)).map(row => row.id))
  const all: Record<string, string> = {}, unrelated: Record<string, string> = {}, scoped: Record<string, unknown[]> = {}
  for (const table of tables(db)) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/i)
    const rows = db.prepare('SELECT * FROM "' + table + '"').all()
    all[table] = digest(rows.map(stringify).sort().join('\n'))
    unrelated[table] = digest(rows.filter(row => !isAffected(table, row, episodeIds, assetIds)).map(stringify).sort().join('\n'))
    const selected = rows.filter(row => isAffected(table, row, episodeIds, assetIds))
    if (selected.length) scoped[table] = selected
  }
  return { all, unrelated, scoped }
}

assert.equal(path.dirname(original), root); assert.equal(path.dirname(destination), root)
assert.ok(!fs.lstatSync(root).isSymbolicLink() && !fs.lstatSync(original).isSymbolicLink())
assert.ok(!fs.existsSync(destination), 'Destination already exists; this repair never replaces it')
assert.ok(!fs.existsSync('E:/下载/抱一影视/妻NTR・凌辱輪迴 4'), 'The old download copy is still live')
assert.equal(readVideoBundle(original)?.bundle_id, bundleId)
for (const code of codes) {
  assert.equal(source(code).currentEpisode?.videoCode, code)
  assert.ok(fs.statSync(path.join(evidence, 'source', code + '.png')).size > 0)
}
const catalogue = catalogueIdentity(source('87022').title, source('87022').episodes)
assert.deepEqual(catalogue.episodes.map(entry => [entry.videoCode, entry.order]), codes.map((code, number) => [code, number]))
if (apply) {
  const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name = \'抱一.exe\'" | Select-Object -ExpandProperty ProcessId'], { encoding: 'utf8', windowsHide: true }).trim()
  assert.equal(running, '', 'Close the application before the scoped live database repair')
}
const mediaBefore = await mediaSnapshot(original)
const run = fs.mkdtempSync(path.join(evidence, apply ? 'actual-apply-' : 'actual-rehearsal-'))
const snapshot = path.join(run, 'library-before.db')
const backup = path.join(run, 'metadata-before'); fs.mkdirSync(backup)
const beforeMetadata = names(original).filter(name => !expected.files.some(file => file.name === name))
for (const name of beforeMetadata) fs.copyFileSync(path.join(original, name), path.join(backup, name))
fs.writeFileSync(path.join(run, 'media-before.json'), JSON.stringify(mediaBefore, null, 2))
const readonly = new DatabaseSync(database, { readOnly: true })
let beforeState: ReturnType<typeof state>
try {
  assert.equal((readonly.prepare('SELECT bundle_id FROM video_directories WHERE resource_id = ?').get(resourceId) as any)?.bundle_id, bundleId)
  assert.equal(readonly.prepare('PRAGMA foreign_key_check').all().length, 0)
  readonly.prepare('VACUUM INTO ?').run(snapshot)
  beforeState = state(readonly)
} finally { readonly.close() }
fs.writeFileSync(path.join(run, 'scoped-rows-before.json'), JSON.stringify(beforeState.scoped, null, 2))
const workingCopy = path.join(run, 'rehearsal.db')
if (!apply) fs.copyFileSync(snapshot, workingCopy)
const db = new DatabaseSync(apply ? database : workingCopy)
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE')
let committed = false
const originalIdentity = fs.statSync(original)
let currentDirectory = original
try {
  assert.deepEqual(state(db).all, beforeState.all, 'Database changed after the backup; start again with a fresh snapshot')
  const episodesBefore = listEpisodes(db, resourceId)
  assert.deepEqual(episodesBefore.map(ep => ep.id).sort(), ['c2c3530d-23ec-49c8-aa4e-bf3aa22fe9c1', '7d892dc8-70c5-44c3-be9d-8a434e92d486', 'f7b20ed0-0b4f-4566-abc8-8a804a75ff83'].sort())
  const synced = syncVideoWorkFiles(db, resourceId, { roots: [root], persist: false })
  assert.equal(synced.pathsRepaired, 1); assert.equal(synced.filesAdded, 1); assert.equal(synced.duplicatesMerged, 1)
  const applied = applyVideoCatalogue(db, resourceId, source('87022'))
  assert.equal(applied.title, title)
  for (const code of codes) {
    const details = source(code).currentEpisode!
    const row = db.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(resourceId, code) as { episode_id: string }
    assert.ok(row)
    fillEpisodeDetails(db, row.episode_id, { originalTitle: details.originalTitle, description: details.description, sourceUrl: 'https://hanime1.me/watch?v=' + code })
    db.prepare('UPDATE episode SET poster_path = ? WHERE id = ?').run(path.join(evidence, 'source', code + '.png'), row.episode_id)
  }
  const warnings: string[] = []
  assert.equal(previewVideoCollectionName(db, resourceId, title, [root]).to, destination)
  if (apply) {
    warnings.push(...persistVideoWorkBundle(db, resourceId, original).warnings)
    const renamed = renameVideoCollection(db, resourceId, title, [root])
    assert.equal(renamed.to, destination); currentDirectory = destination
    warnings.push(...renamed.warnings)
    const stableIds = listEpisodes(db, resourceId).map(ep => ep.id)
    for (let repetition = 0; repetition < 2; repetition++) {
      const checked = syncVideoWorkFiles(db, resourceId, { roots: [root] })
      assert.equal(checked.filesAdded, 0); assert.equal(checked.itemsAdded, 0); assert.equal(checked.duplicatesMerged, 0)
      const imported = registerVideoBundle(db, currentDirectory)
      assert.equal(imported.resourceId, resourceId); assert.equal(imported.itemsAdded, 0)
      assert.deepEqual(listEpisodes(db, resourceId).map(ep => ep.id), stableIds)
      warnings.push(...checked.warnings)
    }
    const manifest = readVideoBundle(currentDirectory)!
    assert.equal(manifest.work.title, title); assert.equal(manifest.items.length, 5)
    assert.equal(manifest.items.find(ep => ep.number === 0)?.files.length, 0)
    assert.equal(manifest.items.filter(ep => ep.files.length).length, 4)
    for (const file of expected.files) {
      const sidecar = readEpisodeSidecar(path.join(currentDirectory, file.name))!
      assert.equal(sidecar.bundle_id, bundleId); assert.equal(sidecar.work_title, title)
      assert.ok(sidecar.episode.description && sidecar.episode.original_title && sidecar.episode.poster)
      assert.ok(fs.existsSync(path.join(currentDirectory, sidecar.episode.poster)))
    }
  }
  const episodes = listEpisodes(db, resourceId), library = getVideoWorkLibrary(db, resourceId)
  assert.equal(getVideo(db, resourceId)?.name_zh, title)
  assert.equal(library.directory?.path, currentDirectory)
  assert.deepEqual(episodes.map(ep => ep.episode), [0, 1, 2, 3, 4])
  assert.equal(episodes[0].path, '')
  assert.equal(library.assets.filter(asset => asset.role === 'video' && asset.state === 'present').length, 4)
  for (const previous of episodesBefore) {
    const current = episodes.find(ep => ep.id === previous.id)!
    assert.ok(current, 'Original episode ID was lost')
    assert.equal(current.watch_status, previous.watch_status)
    assert.ok(current.position_sec >= previous.position_sec); assert.ok(current.watched_at >= previous.watched_at)
    assert.equal(current.notes, previous.notes)
  }
  assert.ok(episodes.every(ep => ep.description && ep.original_title && ep.poster_path && fs.existsSync(ep.poster_path)))
  assert.equal(getVideo(db, duplicateId)?.is_archived, true)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  const afterState = state(db)
  assert.deepEqual(afterState.unrelated, beforeState.unrelated, 'Unrelated data changed; repair is rolled back')
  const mediaAfter = await mediaSnapshot(currentDirectory)
  const report = { applied: apply, resourceId, duplicateArchived: duplicateId, title, from: original, directory: currentDirectory,
    backup: snapshot, metadataBackup: backup, filesAdded: synced.filesAdded, directoriesRepaired: synced.pathsRepaired,
    duplicatesMerged: synced.duplicatesMerged, mediaCount: mediaAfter.length, mediaBytes: mediaAfter.reduce((sum, file) => sum + file.size, 0),
    allMediaHashesUnchanged: true, originalEpisodeIdsAndHistoryPreserved: true, unrelatedTableFingerprintsUnchanged: true, foreignKeyErrors: 0,
    warnings: [...new Set(warnings)], episodes: episodes.map(ep => ({ id: ep.id, number: ep.episode, title: ep.title,
      localFile: ep.path ? path.basename(ep.path) : '', descriptionCharacters: (ep.description || '').length, poster: path.basename(ep.poster_path || ''),
      watchStatus: ep.watch_status, position: ep.position_sec, watchedAt: ep.watched_at })) }
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(run, 'media-after.json'), JSON.stringify(mediaAfter, null, 2))
  fs.writeFileSync(path.join(run, 'scoped-rows-after.json'), JSON.stringify(afterState.scoped, null, 2))
  fs.writeFileSync(path.join(run, 'unrelated-fingerprints.json'), JSON.stringify(afterState.unrelated, null, 2))
  db.exec('COMMIT'); committed = true
  console.log(JSON.stringify({ applied: apply, directory: currentDirectory, episodes: '0–4; 0 missing, 1–4 local', mediaCount: report.mediaCount,
    mediaBytes: report.mediaBytes, preservedHashesAndHistory: true, unrelatedDataUnchanged: true, warnings: report.warnings, report: path.join(run, 'report.json') }, null, 2))
} catch (error) {
  if (!committed) db.exec('ROLLBACK')
  if (apply && !committed) {
    if (!fs.existsSync(original) && fs.existsSync(destination)) {
      const moved = fs.lstatSync(destination)
      assert.equal(moved.ino, originalIdentity.ino); assert.equal(moved.dev, originalIdentity.dev)
      assert.equal(path.dirname(path.resolve(destination)), root); assert.equal(path.dirname(path.resolve(original)), root)
      fs.renameSync(destination, original)
    }
    // Preserve generated recovery files, then restore only the pre-existing metadata.
    const generated = path.join(run, 'metadata-generated'); fs.mkdirSync(generated)
    for (const name of names(original)) if (!beforeMetadata.includes(name) && !expected.files.some(file => file.name === name)) {
      fs.copyFileSync(path.join(original, name), path.join(generated, name))
    }
    for (const name of beforeMetadata) atomicWrite(path.join(original, name), fs.readFileSync(path.join(backup, name)))
    await mediaSnapshot(original)
  }
  fs.writeFileSync(path.join(run, 'failure.txt'), String(error))
  throw error
} finally { db.close() }
