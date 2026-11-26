import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { readImagePage } from '../electron/kinds/image/files.ts'
import * as imageFiles from '../electron/kinds/image/files.ts'
import { inspectImage } from '../electron/kinds/image/metadata.ts'
import { imageThumbnail, closeImageThumbnails } from '../electron/kinds/image/thumbnails.ts'
import { pngImage } from './helpers/test-images.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-webp-')),
  db = new DatabaseSync(':memory:')
try {
  initSchema(db, KINDS)
  const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
  await fs.writeFile(path.join(root, '1.webp'), bytes)
  await fs.writeFile(path.join(root, '2.jpg'), bytes)
  const library = new ImageLibrary(db),
    item = library.register((await scanImageImport(root, 'comic', false))[0])
  assert.equal(item.pageCount, 2)
  for (const page of library.pages(item.id)) {
    const data = await readImagePage(db, page.id)
    assert.equal(data.mime, 'image/webp')
    assert.equal(inspectImage(data.data).width, 1)
  }
  const thumb = await imageThumbnail(bytes)
  assert.ok(thumb)
  assert.equal(inspectImage(thumb).width, 1)
  const large = pngImage(3000, 4500)
  let beats = 0
  const heartbeat = setInterval(() => beats++, 1)
  try {
    const rendered = await imageThumbnail(large)
    assert.ok(rendered)
    const info = inspectImage(rendered)
    assert.equal(info.height, 440)
    assert.ok(info.width <= 440)
    assert.ok(beats > 0, 'main thread continues processing timers while decoding a large image')
    assert.equal(
      await imageThumbnail(Buffer.from('broken image')),
      null,
      'unsupported decoder input falls back'
    )
    await closeImageThumbnails()
    assert.ok(await imageThumbnail(bytes), 'next request can start a fresh worker after close')
  } finally {
    clearInterval(heartbeat)
    await closeImageThumbnails()
  }
  let begin!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const suspended = new Promise<void>((resolve) => {
    release = resolve
  })
  const protocol = createRendererLoader(
    {
      '../../services/storage/database.ts': { getDb: () => db },
      './files.ts': imageFiles,
      './thumbnails.ts': {
        imageThumbnail: async () => {
          begin()
          await suspended
          return thumb
        }
      }
    },
    { Response, URL, Uint8Array }
  )('electron/kinds/image/protocol.ts')
  const response = protocol.imageResponse(
    new URL('baoyi://image/' + library.pages(item.id)[0].id + '?thumb=1')
  )
  await started
  const group = library.saveGroup({ name: '处理中隐藏', type: 'comic' })
  library.update(item.id, { groupId: group.id })
  library.saveGroup({ ...group, hidden: true })
  release()
  assert.equal(
    (await response).status,
    404,
    'hiding a work revokes an in-flight thumbnail before delivery'
  )
  console.log('PASS local WebP and WebP data behind legacy JPG filenames')
} finally {
  await closeImageThumbnails()
  db.close()
  assert.equal(path.dirname(root), os.tmpdir())
  await fs.rm(root, { recursive: true, force: true })
}
