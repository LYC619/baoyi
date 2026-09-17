import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { getVideo } from '../electron/kinds/video/db.ts'
import * as organize from '../electron/kinds/video/organize.ts'
import { writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import type { BaoyiApi } from '../src/types'

assert.ok(fs.existsSync('electron/ipc/video-organize.ts'), 'The reviewed organize UI must be connected to the main process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-organize-ipc-'))
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
let checks = 0, hidden = false
try {
  function work(name: string, number: number) {
    const directory = path.join(root, name); fs.mkdirSync(directory)
    const file = path.join(directory, 'video.mp4'); fs.writeFileSync(file, name)
    const result = registerVideoContent(db, { title: name, directory, root, items: [
      { title: name, order: number, season: 1, number, files: [{ path: file }] }
    ] })
    writeBundleFiles({ directory, bundleId: result.bundleId, title: name, files: [{ path: file, title: name, order: number, season: 1, number }] })
    return { ...result, directory, file }
  }
  const a = work('first', 1), b = work('second', 2)
  const events: Array<[string, unknown]> = []
  const contents = { mainFrame: {}, send: (channel: string, value: unknown) => events.push([channel, value]) }
  const win = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const handlers = new Map<string, (...args: any[]) => unknown>()
  let api!: BaoyiApi
  const electron = {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    contextBridge: { exposeInMainWorld: (_name: string, value: BaoyiApi) => { api = value } },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel)
        assert.ok(handler, `Missing IPC handler: ${channel}`)
        return structuredClone(await handler(event, ...structuredClone(args)))
      },
      on: () => {}, off: () => {}, send: () => {}
    }
  }
  const load = createRendererLoader({ electron,
    '../services/database.ts': { getDb: () => db, getSettings: () => ({ hide_hentai: hidden }) },
    '../kinds/video/organize.ts': organize
  })
  load('electron/ipc/video-organize.ts').registerVideoOrganizeIpc(() => win, {
    handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)
  })
  load('electron/preload.ts')
  assert.ok(api.videoOrganize); checks++
  const preview = await api.videoOrganize.preview({ resourceIds: [a.resourceId, b.resourceId], survivorId: a.resourceId, targetDirectory: a.directory, root })
  assert.equal(preview.canMerge, true)
  assert.equal(getVideo(db, b.resourceId)?.is_archived, false); checks++
  const applied = await api.videoOrganize.apply({ preview, mode: 'logical' })
  assert.equal(applied.status, 'applied')
  assert.equal(getVideo(db, b.resourceId)?.is_archived, true)
  assert.deepEqual(new Set(events.filter(([channel]) => channel === 'video:library-changed').map(([, id]) => id)), new Set([a.resourceId, b.resourceId])); checks++
  assert.equal((await api.videoOrganize.list(a.resourceId))[0].id, applied.id); checks++
  assert.equal((await api.videoOrganize.rollback(applied.id)).status, 'rolled-back')
  assert.equal(getVideo(db, b.resourceId)?.is_archived, false); checks++
  await assert.rejects(async () => handlers.get('video-organize:list')!({ ...event, senderFrame: {} }), /主窗口/); checks++
  hidden = true; db.prepare("UPDATE resource SET category = '里番' WHERE id = ?").run(b.resourceId)
  assert.deepEqual(await api.videoOrganize.list(), [])
  await assert.rejects(api.videoOrganize.preview(preview.request), /隐藏|显示/); checks++
  hidden = false
  const target = path.join(root, 'relocated')
  const relocation = await api.videoOrganize.previewRelocate({ resourceId: a.resourceId, directory: target, root, mode: 'copy' })
  assert.equal(relocation.canApply, true, JSON.stringify(relocation.collisions))
  assert.equal((await api.videoOrganize.relocate({ preview: relocation })).status, 'applied')
  assert.equal(getVideo(db, a.resourceId)?.path, target)
  assert.equal(fs.readFileSync(a.file, 'utf8'), 'first')
  assert.equal(fs.readFileSync(path.join(target, 'video.mp4'), 'utf8'), 'first'); checks++
  assert.equal(await api.videoOrganize.pickDirectory(), null); checks++
  console.log(`Video organize IPC: ${checks} checks passed`)
} finally {
  db.close()
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('baoyi-organize-ipc-'))
  fs.rmSync(root, { recursive: true, force: true })
}
