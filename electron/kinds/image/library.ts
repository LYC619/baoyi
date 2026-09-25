import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageChapter, ImageGroup, ImageItem, ImagePage, ImagePatch, ImageQuery, ScannedImage } from '../../../src/types/image.ts'

type Row = Record<string, any>
type IndexedImagePage = ImagePage & { file: string; entry: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const keyPath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const visible = "(m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))"
export class ImageLibrary {
  private db: SqlDb
  constructor(db: SqlDb) { this.db = db }
  groups(): ImageGroup[] {
    return (this.db.prepare('SELECT * FROM image_groups ORDER BY sort_order, name').all() as Row[]).map(r => ({ id: r.id, name: r.name, sortOrder: r.sort_order, hidden: !!r.hidden }))
  }
  saveGroup(group: Partial<ImageGroup> & { name: string }): ImageGroup {
    const name = String(group.name).trim().slice(0, 80)
    if (!name) throw new Error('类型名称不能为空')
    const existing = this.groups().find(g => g.id === group.id)
    const result = { id: existing?.id || randomUUID(), name, sortOrder: group.sortOrder ?? existing?.sortOrder ?? this.groups().length, hidden: group.hidden ?? existing?.hidden ?? false }
    if (!Number.isSafeInteger(result.sortOrder)) throw new Error('无效的类型顺序')
    this.db.prepare('INSERT INTO image_groups(id,name,sort_order,hidden) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order,hidden=excluded.hidden').run(result.id, name, result.sortOrder, Number(result.hidden))
    return result
  }
  removeGroup(id: string): void { this.db.prepare('DELETE FROM image_groups WHERE id=?').run(id) }
  list(query: ImageQuery = {}): ImageItem[] {
    const args: unknown[] = []
    const where = ["r.kind='image'", visible]
    if (query.type) { where.push('m.item_type=?'); args.push(query.type) }
    if (query.groupId) { where.push('m.group_id=?'); args.push(query.groupId) }
    if (query.favorite) where.push('m.favorite=1')
    if (query.publication) { where.push('m.publication=?'); args.push(query.publication) }
    if (query.sourceDir) { where.push('r.source_dir=?'); args.push(query.sourceDir) }
    if (query.search?.trim()) { where.push("(instr(lower(r.name_zh || ' ' || r.description || ' ' || r.tags),lower(?))>0)"); args.push(query.search.trim()) }
    if (query.tag) { where.push('EXISTS(SELECT 1 FROM json_each(r.tags) WHERE value=?)'); args.push(query.tag) }
    const order = query.sort === 'name' ? 'r.name_zh COLLATE NOCASE' : query.sort === 'read' ? 'COALESCE(p.updated_at,0) DESC' : 'r.updated_at DESC'
    return (this.db.prepare(`SELECT r.id FROM resource r JOIN image_meta m ON m.resource_id=r.id LEFT JOIN image_progress p ON p.resource_id=r.id WHERE ${where.join(' AND ')} ORDER BY ${order}, r.id`).all(...args) as Row[]).map(r => this.get(r.id)!).filter(Boolean)
  }
  get(id: string): ImageItem | null {
    const r = this.db.prepare(`SELECT r.*,m.* FROM resource r JOIN image_meta m ON m.resource_id=r.id WHERE r.id=? AND ${visible}`).get(id) as Row | undefined
    if (!r) return null
    const chapters = (this.db.prepare(`SELECT c.*,COUNT(p.id) AS page_count FROM image_chapters c LEFT JOIN image_pages p ON p.chapter_id=c.id AND p.missing=0 WHERE c.resource_id=? GROUP BY c.id ORDER BY c.ordinal`).all(id) as Row[])
      .map((c): ImageChapter => ({ id: c.id, title: c.title, ordinal: c.ordinal, pageCount: c.page_count, sourceId: c.source_id }))
    const count = (this.db.prepare('SELECT COUNT(*) n FROM image_pages WHERE resource_id=? AND missing=0').get(id) as Row).n
    const p = this.db.prepare('SELECT v.*,p.chapter_id,p.ordinal FROM image_progress v JOIN image_pages p ON p.id=v.page_id WHERE v.resource_id=? AND p.missing=0').get(id) as Row | undefined
    const cover = this.db.prepare('SELECT id FROM image_pages WHERE resource_id=? AND missing=0 ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,ordinal LIMIT 1').get(id, r.cover_page_id) as Row | undefined
    return { id, type: r.item_type, path: r.path, sourceDir: r.source_dir || '', name: r.name_zh || r.file_name, description: r.description || '', tags: JSON.parse(r.tags || '[]'),
      groupId: r.group_id, favorite: !!r.favorite, publication: r.publication, coverPageId: cover?.id || '', source: r.source, sourceId: r.source_id,
      pageCount: count, chapterCount: chapters.filter(c => c.pageCount).length, chapters, updatedAt: r.updated_at,
      progress: p ? { pageId: p.page_id, chapterId: p.chapter_id, ordinal: p.ordinal, offset: p.scroll_offset, updatedAt: p.updated_at } : null }
  }
  pages(id: string, chapterId?: string): IndexedImagePage[] {
    if (!this.get(id)) return []
    const rows = this.db.prepare('SELECT * FROM image_pages WHERE resource_id=? AND missing=0' + (chapterId ? ' AND chapter_id=?' : '') + ' ORDER BY ordinal')
      .all(...(chapterId ? [id, chapterId] : [id])) as Row[]
    return rows.map(p => ({ id: p.id, resourceId: id, chapterId: p.chapter_id, file: p.file, entry: p.entry, ordinal: p.ordinal, size: p.size, missing: !!p.missing }))
  }
  register(scan: ScannedImage, relocateId?: string): ImageItem {
    const old = this.db.prepare('SELECT r.id,r.kind,m.source_id FROM resource r LEFT JOIN image_meta m ON m.resource_id=r.id WHERE r.path=? COLLATE NOCASE').get(scan.path) as Row | undefined
    if (old && old.kind !== 'image') throw new Error('这个目录已由其他模块登记')
    if (old && (this.db.prepare('SELECT item_type FROM image_meta WHERE resource_id=?').get(old.id) as Row)?.item_type !== scan.type) throw new Error('此目录已经以另一图片类型导入，请先移除旧索引再更换类型')
    const sourced = scan.sourceId ? this.db.prepare('SELECT resource_id AS id FROM image_meta WHERE source=? AND source_id=?').get(scan.source || '', scan.sourceId) as Row | undefined : undefined
    const id = relocateId || sourced?.id || old?.id || randomUUID()
    if (relocateId && !this.get(relocateId)) throw new Error('资源不可用')
    if (sourced && old && sourced.id !== old.id) throw new Error('来源与目录属于不同作品，请选择原下载位置')
    this.db.exec('SAVEPOINT image_register')
    try {
      this.db.prepare(`INSERT INTO resource(id,kind,path,created_at,updated_at,file_name,source_dir,name_zh,description,tags,category,ai_status) VALUES(?,'image',?,?,?,?,?,?,?,?,?,'done')
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,updated_at=excluded.updated_at`).run(id, scan.path, Date.now(), Date.now(), path.basename(scan.path), scan.sourceDir, scan.name, scan.description || '', JSON.stringify(scan.tags || []), scan.type === 'comic' ? '漫画' : '照片')
      this.db.prepare(`INSERT INTO image_meta(resource_id,item_type,source,source_id,publication) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO NOTHING`).run(id, scan.type, scan.source || '', scan.sourceId || '', scan.publication || 'unknown')
      this.db.prepare('UPDATE image_pages SET missing=1 WHERE resource_id=?').run(id)
      let ordinal = 0
      for (const [ci, chapter] of scan.chapters.entries()) {
        const cid = scan.type === 'comic' ? hash(id + ':chapter:' + chapter.key) : null
        if (cid) this.db.prepare(`INSERT INTO image_chapters(id,resource_id,chapter_key,title,ordinal,source_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=CASE WHEN image_chapters.customized=1 THEN image_chapters.ordinal ELSE excluded.ordinal END`).run(cid, id, chapter.key, chapter.title, ci, chapter.sourceId || '')
        for (const page of chapter.pages) {
          const relative = keyPath(page.file) === keyPath(scan.path) ? '.' : path.relative(scan.path, page.file).replaceAll('\\', '/')
          const pid = hash(id + ':page:' + relative + ':' + page.entry)
          this.db.prepare(`INSERT INTO image_pages(id,resource_id,chapter_id,file,entry,ordinal,size,missing) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET chapter_id=excluded.chapter_id,file=excluded.file,ordinal=excluded.ordinal,size=excluded.size,missing=0`).run(pid, id, cid, page.file, page.entry, ordinal++, page.size)
        }
      }
      if (scan.type === 'comic') this.reorderPages(id)
      this.db.exec('RELEASE image_register')
    } catch (cause) { this.db.exec('ROLLBACK TO image_register; RELEASE image_register'); throw cause }
    const result = this.get(id)
    if (!result) throw new Error('资源位于隐藏类型，请在类型管理中取消隐藏后查看')
    return result
  }
  update(id: string, patch: ImagePatch): ImageItem {
    const item = this.get(id)
    if (!item) throw new Error('资源不可用')
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 300)
      if (!name) throw new Error('名称不能为空')
      this.db.prepare('UPDATE resource SET name_zh=? WHERE id=?').run(name, id)
    }
    if (patch.description !== undefined) this.db.prepare('UPDATE resource SET description=? WHERE id=?').run(patch.description.slice(0, 50000), id)
    if (patch.tags) {
      const tags = [...new Set(patch.tags.map(t => String(t).trim().slice(0, 80)).filter(Boolean))].slice(0, 50)
      this.db.prepare('UPDATE resource SET tags=? WHERE id=?').run(JSON.stringify(tags), id)
      for (const tag of tags) this.db.prepare("INSERT OR IGNORE INTO tags(kind,name,source,created_at) VALUES('image',?,'user',?)").run(tag, Date.now())
    }
    if (patch.groupId !== undefined) {
      if (patch.groupId && !this.groups().some(g => g.id === patch.groupId)) throw new Error('类型不存在')
      this.db.prepare('UPDATE image_meta SET group_id=? WHERE resource_id=?').run(patch.groupId, id)
    }
    if (patch.favorite !== undefined) this.db.prepare('UPDATE image_meta SET favorite=? WHERE resource_id=?').run(Number(!!patch.favorite), id)
    if (patch.publication && ['unknown','ongoing','completed'].includes(patch.publication)) this.db.prepare('UPDATE image_meta SET publication=? WHERE resource_id=?').run(patch.publication, id)
    if (patch.coverPageId !== undefined) {
      if (patch.coverPageId && !this.pages(id).some(p => p.id === patch.coverPageId)) throw new Error('封面必须是作品中的页面')
      this.db.prepare('UPDATE image_meta SET cover_page_id=? WHERE resource_id=?').run(patch.coverPageId, id)
    }
    this.db.prepare('UPDATE resource SET updated_at=? WHERE id=?').run(Date.now(), id)
    return this.get(id) || { ...item, ...patch }
  }
  saveProgress(id: string, pageId: string, offset: number): void {
    if (!this.get(id) || !this.db.prepare('SELECT 1 FROM image_pages WHERE id=? AND resource_id=? AND missing=0').get(pageId, id)) throw new Error('阅读页面不可用')
    if (!Number.isFinite(offset)) throw new Error('无效阅读位置')
    this.db.prepare(`INSERT INTO image_progress(resource_id,page_id,scroll_offset,updated_at) VALUES(?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET page_id=excluded.page_id,scroll_offset=excluded.scroll_offset,updated_at=excluded.updated_at`).run(id, pageId, Math.max(0, Math.min(1, offset)), Date.now())
  }
  private reorderPages(id: string): void {
    const rows = this.db.prepare('SELECT p.id FROM image_pages p JOIN image_chapters c ON c.id=p.chapter_id WHERE p.resource_id=? AND p.missing=0 ORDER BY c.ordinal,c.id,p.ordinal').all(id) as Row[]
    for (const [order,row] of rows.entries()) this.db.prepare('UPDATE image_pages SET ordinal=? WHERE id=?').run(order,row.id)
  }
  saveChapter(id:string,chapterId:string,title:string,move:number):void {
    const item=this.get(id)
    if(!item||!item.chapters.some(c=>c.id===chapterId)||![-1,0,1].includes(move)||!title.trim())throw new Error('章节资料无效')
    const chapters=item.chapters.slice(),at=chapters.findIndex(c=>c.id===chapterId),target=Math.max(0,Math.min(chapters.length-1,at+move))
    const [moved]=chapters.splice(at,1);chapters.splice(target,0,moved)
    this.db.exec('SAVEPOINT image_chapter')
    try{
      this.db.prepare('UPDATE image_chapters SET title=? WHERE id=?').run(title.trim().slice(0,300),chapterId)
      for(const [order,c]of chapters.entries())this.db.prepare('UPDATE image_chapters SET ordinal=?,customized=1 WHERE id=?').run(order,c.id)
      this.reorderPages(id);this.db.exec('RELEASE image_chapter')
    }catch(cause){this.db.exec('ROLLBACK TO image_chapter; RELEASE image_chapter');throw cause}
  }
  remove(id: string): void { if (!this.get(id)) throw new Error('资源不可用'); this.db.prepare("DELETE FROM resource WHERE id=? AND kind='image'").run(id) }
}
