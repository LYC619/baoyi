import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { resolveVideoOwnership } from '../electron/kinds/video/identity.ts'
import { listVideoAssets, checkVideoAssets } from '../electron/kinds/video/library.ts'
import { getVideo, listEpisodes, updateEpisode, updateVideo } from '../electron/kinds/video/db.ts'
import type { VideoRegistration, VideoSourceRef } from '../src/types/video-library.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-works-'))
const dbPath = path.join(root, 'library.db')
let db = new DatabaseSync(dbPath)
function open() { db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS) }
open()
const source = (code: string): VideoSourceRef => ({ provider: 'hanime', scope: 'episode', externalId: code, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'playlist' })
const folder = path.join(root, 'Example')
fs.mkdirSync(folder)
function input(code: string, quality = '1080p'): VideoRegistration {
  const file = path.join(folder, code + '-' + quality + '.mp4')
  fs.writeFileSync(file, 'fixture-video')
  return { title: 'Example', directory: folder, root, sources: [source('1'), source('4'), source('5')], items: [{ title: 'Example ' + code, order: Number(code), number: Number(code), sources: [source(code)], files: [{ path: file, quality }] }] }
}
try {
  const first = registerVideoContent(db, input('4'))
  const originalEpisode = listEpisodes(db, first.resourceId)[0]
  updateEpisode(db, originalEpisode.id, { position_sec: 42, watch_status: 'watching' })
  updateVideo(db, first.resourceId, { name_zh: 'User title', notes: 'Keep me', collection_name: 'Favorites' })
  db.close(); db = new DatabaseSync(dbPath); open()
  const ownership = resolveVideoOwnership(db, { title: 'Example 5', sources: [source('5')] })
  assert.equal(ownership.resourceId, first.resourceId)
  assert.equal(ownership.directory?.path, folder)
  const second = registerVideoContent(db, { ...input('1'), resourceId: ownership.resourceId })
  assert.equal(second.resourceId, first.resourceId)
  registerVideoContent(db, { ...input('4', '720p'), resourceId: first.resourceId })
  const again = registerVideoContent(db, { ...input('4', '720p'), resourceId: first.resourceId })
  assert.equal(again.filesAdded, 0)
  assert.equal(listEpisodes(db, first.resourceId).length, 2)
  const ep4 = listEpisodes(db, first.resourceId).find(e => e.id === originalEpisode.id)!
  assert.equal(ep4.position_sec, 42)
  assert.equal(listVideoAssets(db, first.resourceId, ep4.id).length, 2)
  assert.equal(getVideo(db, first.resourceId)?.name_zh, 'User title')
  assert.equal(getVideo(db, first.resourceId)?.notes, 'Keep me')
  assert.equal(getVideo(db, first.resourceId)?.collection_name, 'Favorites')
  assert.equal(resolveVideoOwnership(db, { title: 'Example', sources: [source('1984')] }).state, 'new')
  assert.equal(resolveVideoOwnership(db, { title: 'Example 2', sources: [] }).state, 'new')
  const label = input('5')
  label.items[0].number = null; label.items[0].label = 'Bonus'
  registerVideoContent(db, { ...label, resourceId: first.resourceId })
  assert.equal(listEpisodes(db, first.resourceId).at(-1)?.display_label, 'Bonus')
  const multi = input('6')
  multi.items.push({ ...multi.items[0], title: 'Part two', order: 7, number: 7, sources: [source('7')] })
  registerVideoContent(db, { ...multi, resourceId: first.resourceId })
  assert.equal(listVideoAssets(db, first.resourceId).length, 5)
  fs.unlinkSync(ep4.path)
  checkVideoAssets(db, first.resourceId, false)
  assert.equal(listVideoAssets(db, first.resourceId, ep4.id).find(a => a.path === ep4.path)?.state, 'missing')
  assert.equal(listEpisodes(db, first.resourceId).find(e => e.id === ep4.id)?.position_sec, 42)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  console.log('PASS video work identity, restart, versions, history, labels, shared files and availability')
} finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
