import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'

assert.ok(fs.existsSync(new URL('../electron/kinds/image/integrity.ts', import.meta.url)), '必须提供只读完整性检查')
const { auditImage, imagePageInfo } = await import('../electron/kinds/image/integrity.ts')
const { inspectImage } = await import('../electron/kinds/image/metadata.ts')
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
assert.deepEqual(inspectImage(webp), { width: 1, height: 1, format: 'WEBP', size: webp.length })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-image-audit-'))
const directory = path.join(root, 'comic'), chapterDir = path.join(directory, 'chapter1')
fs.mkdirSync(chapterDir, { recursive: true })
const bytes = pngImage(24, 36), hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
for (const name of ['p1', 'p2', 'p3']) fs.writeFileSync(path.join(chapterDir, name + '.png'), bytes)
const manifest = { version: 1, source: 'pica', sourceId: 'work1', name: 'fixture', description: '', tags: [], publication: 'ongoing',
  chapters: [{ id: 'c1', directory: 'chapter1', title: 'Chapter 1', order: 1, pageIds: ['p1', 'p2', 'p3', 'p4'] }, { id: 'c2', directory: 'chapter2', title: 'Chapter 2', order: 2, pageIds: ['p5'] }],
  pages: Object.fromEntries(['p1', 'p2', 'p3'].map(id => ['c1:' + id, { file: `chapter1/${id}.png`, sha256: hash(bytes) }])) }
const manifestFile = path.join(directory, '.baoyi-image.json')
fs.writeFileSync(manifestFile, JSON.stringify(manifest))
const db = new DatabaseSync(path.join(root, 'fixture.db')); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
try {
  const library = new ImageLibrary(db), item = library.register((await scanImageImport(directory, 'comic', false))[0])
  library.update(item.id, { name: 'Customized', tags: ['local'] })
  const pages = library.pages(item.id)
  const info = await imagePageInfo(db, pages[0].id)
  assert.deepEqual({ width: info.width, height: info.height, format: info.format, size: info.size }, { width: 24, height: 36, format: 'PNG', size: bytes.length })
  fs.unlinkSync(path.join(chapterDir, 'p2.png'))
  fs.writeFileSync(path.join(chapterDir, 'p3.png'), pngImage(24, 36, [9, 8, 7]))
  const before = JSON.stringify(db.prepare('SELECT * FROM resource').all()), savedManifest = fs.readFileSync(manifestFile)
  const mtime = fs.statSync(path.join(chapterDir, 'p1.png')).mtimeMs
  const report = await auditImage(db, item.id)
  assert.deepEqual([report.total, report.ok, report.missing, report.damaged, report.unverified], [5, 1, 3, 1, 0])
  assert.equal(report.catalogComplete, true)
  assert.deepEqual(report.entries.filter(e => e.repairable).map(e => e.sourcePageId).sort(), ['p2', 'p3', 'p4', 'p5'])
  assert.equal(fs.statSync(path.join(chapterDir, 'p1.png')).mtimeMs, mtime)
  assert.deepEqual(fs.readFileSync(manifestFile), savedManifest)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM resource').all()), before)
  const legacy = structuredClone(manifest)
  for (const chapter of legacy.chapters) delete (chapter as any).pageIds
  fs.writeFileSync(manifestFile, JSON.stringify(legacy))
  assert.equal((await auditImage(db, item.id)).catalogComplete, false)
  const unsafe = structuredClone(manifest); unsafe.pages['c1:p1'].file = '../outside.png'
  fs.writeFileSync(manifestFile, JSON.stringify(unsafe))
  await assert.rejects(auditImage(db, item.id), /路径|清单/)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  const linked = path.join(directory, 'linked'), outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'p1.png'), bytes); fs.symlinkSync(outside, linked, 'junction')
  const external = structuredClone(manifest)
  external.chapters[0].directory = 'linked'
  for (const entry of Object.values(external.pages)) entry.file = entry.file.replace('chapter1/', 'linked/')
  fs.writeFileSync(manifestFile, JSON.stringify(external))
  const symlinks = await auditImage(db, item.id)
  assert.ok(symlinks.entries.some(e => /目录之外/.test(e.reason)))
  fs.unlinkSync(linked)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  const group = library.saveGroup({ name: 'private' }); library.update(item.id, { groupId: group.id }); library.saveGroup({ ...group, hidden: true })
  await assert.rejects(auditImage(db, item.id), /不可用/)
  await assert.rejects(imagePageInfo(db, pages[0].id), /不可用/)
  const localDir = path.join(root, 'local'); fs.mkdirSync(localDir); fs.writeFileSync(path.join(localDir, 'photo.png'), bytes)
  const local = library.register((await scanImageImport(localDir, 'photo', false))[0])
  const localReport = await auditImage(db, local.id)
  assert.deepEqual([localReport.ok, localReport.unverified, localReport.entries[0].repairable], [0, 1, false])
  fs.writeFileSync(path.join(localDir, 'photo.png'), Buffer.alloc(32))
  assert.equal((await auditImage(db, local.id)).damaged, 1)
  db.prepare('UPDATE image_pages SET missing=1 WHERE resource_id=?').run(local.id)
  fs.writeFileSync(path.join(localDir, 'photo.png'), bytes)
  assert.equal((await auditImage(db, local.id)).unverified, 1, '文件已恢复时按磁盘现状检查，不沿用过期的 missing 标记')
  const badExtension = structuredClone(manifest); badExtension.pages['c1:p1'].file = 'chapter1/wrong.jpg'
  fs.writeFileSync(path.join(chapterDir, 'wrong.jpg'), bytes); fs.writeFileSync(manifestFile, JSON.stringify(badExtension))
  library.saveGroup({ ...group, hidden: false })
  assert.equal((await auditImage(db, item.id)).entries.find(e => e.sourcePageId === 'p1')?.status, 'damaged', '清单里的格式错误也要报告')
  console.log('PASS 图片规格、完整/旧清单、缺失/损坏页、只读审计、本地未校验和隐藏保护')
} finally { db.close() }
