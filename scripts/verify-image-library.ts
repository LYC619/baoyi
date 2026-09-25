import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KINDS } from '../electron/kinds/index.ts'
import { initSchema } from '../electron/services/schema.ts'
import { pngImage } from './helpers/test-images.ts'
import { zipFixture } from './helpers/test-zip.ts'
import { listArchive } from '../electron/kinds/image/archive.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

assert.ok(KINDS.some(kind => kind.kind === 'image'), '图片品类必须注册')
const { scanImageImport } = await import('../electron/kinds/image/scanner.ts')
const { ImageLibrary } = await import('../electron/kinds/image/library.ts')
const { readImagePage } = await import('../electron/kinds/image/files.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-images-'))
const db = new DatabaseSync(path.join(root, 'test.db'))
db.exec('PRAGMA foreign_keys=ON')
initSchema(db, KINDS)
const library = new ImageLibrary(db)
const work = path.join(root, '测试漫画')
fs.mkdirSync(path.join(work, '第10话'), { recursive: true })
fs.mkdirSync(path.join(work, '第2话'), { recursive: true })
for (const chapter of ['第10话', '第2话']) for (const n of [10, 2, 1]) {
  fs.writeFileSync(path.join(work, chapter, `${n}.png`), pngImage(20, 30))
}
const scan = await scanImageImport(work, 'comic', false)
assert.equal(scan.length, 1)
assert.deepEqual(scan[0].chapters.map(c => c.title), ['第2话', '第10话'])
assert.deepEqual(scan[0].chapters[0].pages.map(p => path.basename(p.file)), ['1.png', '2.png', '10.png'])
const item = library.register(scan[0])
assert.throws(()=>library.register({...scan[0],type:'photo'}),/另一图片类型/)
assert.equal(item.pageCount, 6)
assert.equal(item.chapterCount, 2)
library.update(item.id, { name: '人工命名', tags: ['旅行'], favorite: true })
const pages = library.pages(item.id, item.chapters[0].id)
library.saveProgress(item.id, pages[1].id, 0.25)
library.register(scan[0])
assert.equal(library.list({}).length, 1)
assert.equal(library.get(item.id)!.name, '人工命名')
assert.deepEqual(library.get(item.id)!.tags, ['旅行'])
assert.equal(library.get(item.id)!.progress?.pageId, pages[1].id)
assert.equal(library.get(item.id)!.progress?.offset, 0.25)
assert.ok((await readImagePage(db, pages[0].id)).data.length > 0)
await assert.rejects(readImagePage(db, '../test.db'))
const group = library.saveGroup({ name: '私人分组' })
library.update(item.id, { groupId: group.id })
library.saveGroup({ ...group, hidden: true })
assert.equal(library.list({ search: '人工' }).length, 0)
assert.equal(library.get(item.id), null)
await assert.rejects(readImagePage(db, pages[0].id))
library.saveGroup({ ...group, hidden: false })
assert.equal(library.list({ tag: '旅行', favorite: true }).length, 1)
fs.unlinkSync(pages[2].file)
library.register((await scanImageImport(work, 'comic', false))[0])
assert.equal(library.get(item.id)!.pageCount, 5)
assert.equal(library.get(item.id)!.progress?.pageId, pages[1].id)
assert.equal(library.pages(item.id, item.chapters[0].id).length, 2)
const before = db.prepare('SELECT COUNT(*) n FROM resource').get()
initSchema(db, KINDS)
assert.deepEqual(db.prepare('SELECT COUNT(*) n FROM resource').get(), before)
const cbz=path.join(root,'中文归档.cbz')
fs.writeFileSync(cbz,zipFixture([{name:'第1话/10.png',data:pngImage(12,18)},{name:'第1话/2.png',data:pngImage(12,18)}]))
const archived=library.register((await scanImageImport(cbz,'comic',false))[0])
assert.equal(archived.pageCount,2)
assert.equal(library.pages(archived.id)[0].entry,'第1话/2.png')
assert.ok((await readImagePage(db,library.pages(archived.id)[0].id)).data.equals(pngImage(12,18)))
for(const entry of [{name:'../escape.png'},{name:'/absolute.png'},{name:'C:/absolute.png'},{name:'link.png',attributes:0xa0000000},{name:'bomb.png',declaredSize:65*1024**2}]){
  const bad=path.join(root,'unsafe.cbz');fs.writeFileSync(bad,zipFixture([{...entry,data:pngImage(12,18)}]));await assert.rejects(listArchive(bad))
}
const outside=path.join(root,'outside.png');fs.writeFileSync(outside,pngImage(12,18))
db.prepare('UPDATE image_pages SET file=? WHERE id=?').run(outside,pages[0].id)
await assert.rejects(readImagePage(db,pages[0].id),/目录外/)
db.prepare('UPDATE image_pages SET file=? WHERE id=?').run(pages[0].file,pages[0].id)
db.exec(VIDEO_JOBS_SQL)
const backup=buildLibraryBackup(db),restored=new DatabaseSync(':memory:');restored.exec('PRAGMA foreign_keys=ON');initSchema(restored,KINDS);restored.exec(VIDEO_JOBS_SQL)
restoreLibraryBackup(restored,backup)
assert.equal(new ImageLibrary(restored).get(item.id)?.progress?.pageId,pages[1].id)
assert.equal(new ImageLibrary(restored).get(archived.id)?.pageCount,2)
restored.close()
library.remove(archived.id)
library.remove(item.id)
assert.equal((db.prepare('SELECT COUNT(*) n FROM image_pages').get() as { n: number }).n, 0)
assert.ok(fs.existsSync(work), '移除索引不删除文件')
db.close()
console.log('PASS 图片注册、自然顺序、重复导入、资料与进度保留、类型冲突、隐藏、缺页、CBZ、越界/链接/大小限制、备份恢复与级联移除')
