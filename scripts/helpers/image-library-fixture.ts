import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../electron/services/schema.ts'
import { pngImage } from './test-images.ts'
import { zipFixture } from './test-zip.ts'

export function seedImageLibrary(db: SqlDb, root: string, count: number, media = false) {
  for(let i=0;i<4;i++)db.prepare('INSERT OR IGNORE INTO image_groups(id,name,sort_order) VALUES(?,?,?)').run('image-group-'+i,'合成分类 '+i,i)
  const png = pngImage(480, 720, [75, 125, 110])
  const archive = media ? zipFixture(Array.from({ length: 24 }, (_, n) => ({ name: n + '.png', data: png }))) : null
  const resource = db.prepare("INSERT INTO resource(id,kind,path,created_at,updated_at,file_name,source_dir,name_zh,tags,description) VALUES(?,'image',?,1,?,?,'synthetic',?,?,?)")
  const meta = db.prepare("INSERT INTO image_meta(resource_id,item_type,group_id,cover_page_id,publication) VALUES(?,'comic',?,?,?)")
  const chapter = db.prepare('INSERT INTO image_chapters(id,resource_id,chapter_key,title,ordinal) VALUES(?,?,?,?,?)')
  const page = db.prepare('INSERT INTO image_pages(id,resource_id,chapter_id,file,entry,ordinal,size,missing) VALUES(?,?,?,?,?,?,100,?)')
  const progress = db.prepare('INSERT INTO image_progress(resource_id,page_id,scroll_offset,updated_at) VALUES(?,?,0.4,?)')
  const state = db.prepare('INSERT INTO image_reader_state(resource_id,is_read) VALUES(?,?)')
  db.exec('BEGIN')
  try {
    for (let i = 0; i < count; i++) {
      const id = 'fixture-' + i, title = '作品 ' + String(i).padStart(5, '0')
      const pageId = (n: number) => media ? createHash('sha256').update(id + '-page-' + n).digest('hex').slice(0, 32) : id + '-page-' + n
      const file = path.join(root, id + '.cbz')
      if (archive) fs.writeFileSync(file, archive)
      resource.run(id, file, i + 1, title, title, JSON.stringify(['fixture', i % 2 ? 'odd' : 'even']), 'Synthetic library benchmark')
      meta.run(id, 'image-group-' + i % 4, pageId(3), i % 2 ? 'ongoing' : 'completed')
      for (let c = 0; c < 2; c++) {
        const cid = id + '-chapter-' + c; chapter.run(cid, id, 'chapter-' + c, 'Chapter ' + (c + 1), c)
        for (let n = 0; n < 12; n++) { const ordinal = c * 12 + n; page.run(pageId(ordinal), id, cid, file, ordinal + '.png', ordinal, Number(ordinal === 23)) }
      }
      if (i % 20 === 0) progress.run(id, pageId(3), i + 1)
      state.run(id, Number(i % 3 === 0))
    }
    db.exec('COMMIT')
  } catch (cause) { db.exec('ROLLBACK'); throw cause }
}
