import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { withImageCollections } from './collections.ts'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageBulkPatch, ImageChapter, ImageGroup, ImageItem, ImagePage, ImagePatch, ImageQuery, ScannedImage } from '../../../src/types/image.ts'

type Row = Record<string, any>
type IndexedImagePage = ImagePage & { file: string; entry: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const keyPath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const visible = "(m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))"
function imageItem(r: Row, chapters: ImageChapter[], count: number, p: Row | undefined, cover: string): ImageItem {
  return { id: r.id, type: r.item_type, path: r.path, sourceDir: r.source_dir || '', name: r.name_zh || r.file_name, description: r.description || '', tags: JSON.parse(r.tags || '[]'),
    groupId: r.group_id, favorite: !!r.favorite, read: !!r.is_read, publication: r.publication, coverPageId: cover, source: r.source, sourceId: r.source_id,
    pageCount: count, chapterCount: chapters.filter(c => c.pageCount).length, chapters, updatedAt: r.updated_at,
    progress: p ? { pageId: p.page_id, chapterId: p.chapter_id, ordinal: p.ordinal, offset: p.scroll_offset, updatedAt: p.updated_at } : null }
}
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
    if (query.read !== undefined) { where.push('COALESCE(s.is_read,0)=?'); args.push(Number(query.read)) }
    if (query.publication) { where.push('m.publication=?'); args.push(query.publication) }
    if (query.sourceDir) { where.push('r.source_dir=?'); args.push(query.sourceDir) }
    if (query.search?.trim()) { where.push("(instr(lower(r.name_zh || ' ' || r.description || ' ' || r.tags),lower(?))>0)"); args.push(query.search.trim()) }
    if (query.tag) { where.push('EXISTS(SELECT 1 FROM json_each(r.tags) WHERE value=?)'); args.push(query.tag) }
    const order = query.sort === 'name' ? 'r.name_zh COLLATE NOCASE' : query.sort === 'read' ? 'COALESCE(p.updated_at,0) DESC' : 'r.updated_at DESC'
    const joins = `FROM resource r JOIN image_meta m ON m.resource_id=r.id LEFT JOIN image_progress p ON p.resource_id=r.id LEFT JOIN image_reader_state s ON s.resource_id=r.id`
    const filter = where.join(' AND ')
    const rows = this.db.prepare(`SELECT r.*,m.*,s.is_read,
      (SELECT COUNT(*) FROM image_pages ip WHERE ip.resource_id=r.id AND ip.missing=0) AS page_count,
      COALESCE((SELECT ip.id FROM image_pages ip WHERE ip.id=m.cover_page_id AND ip.resource_id=r.id AND ip.missing=0),
        (SELECT ip.id FROM image_pages ip WHERE ip.resource_id=r.id AND ip.missing=0 ORDER BY ip.ordinal LIMIT 1)) AS selected_cover,
      rp.id AS progress_page_id,rp.chapter_id AS progress_chapter_id,rp.ordinal AS progress_ordinal,p.scroll_offset,p.updated_at AS progress_updated_at
      ${joins} LEFT JOIN image_pages rp ON rp.id=p.page_id AND rp.missing=0 WHERE ${filter} ORDER BY ${order},r.id`).all(...args) as Row[]
    if (!rows.length) return []
    const chapters = new Map<string, ImageChapter[]>()
    // Include resource_id in the page join to use the existing resource-first page index.
    const chapterRows = this.db.prepare(`SELECT c.*,COUNT(cp.id) AS page_count ${joins}
      JOIN image_chapters c ON c.resource_id=r.id LEFT JOIN image_pages cp ON cp.resource_id=c.resource_id AND cp.chapter_id=c.id AND cp.missing=0
      WHERE ${filter} GROUP BY c.id ORDER BY c.ordinal`).all(...args) as Row[]
    for (const c of chapterRows) {
      const list = chapters.get(c.resource_id) || []
      list.push({ id: c.id, title: c.title, ordinal: c.ordinal, pageCount: c.page_count, sourceId: c.source_id }); chapters.set(c.resource_id, list)
    }
    return withImageCollections(this.db, rows.map(r => imageItem(r, chapters.get(r.id) || [], r.page_count, r.progress_page_id ? { page_id: r.progress_page_id, chapter_id: r.progress_chapter_id, ordinal: r.progress_ordinal, scroll_offset: r.scroll_offset, updated_at: r.progress_updated_at } : undefined, r.selected_cover || '')))
  }
  get(id: string): ImageItem | null {
    const r = this.db.prepare(`SELECT r.*,m.*,s.is_read FROM resource r JOIN image_meta m ON m.resource_id=r.id LEFT JOIN image_reader_state s ON s.resource_id=r.id WHERE r.id=? AND ${visible}`).get(id) as Row | undefined
    if (!r) return null
    const chapters = (this.db.prepare(`SELECT c.*,COUNT(p.id) AS page_count FROM image_chapters c LEFT JOIN image_pages p ON p.resource_id=c.resource_id AND p.chapter_id=c.id AND p.missing=0 WHERE c.resource_id=? GROUP BY c.id ORDER BY c.ordinal`).all(id) as Row[])
      .map((c): ImageChapter => ({ id: c.id, title: c.title, ordinal: c.ordinal, pageCount: c.page_count, sourceId: c.source_id }))
    const count = (this.db.prepare('SELECT COUNT(*) n FROM image_pages WHERE resource_id=? AND missing=0').get(id) as Row).n
    const p = this.db.prepare('SELECT v.*,p.chapter_id,p.ordinal FROM image_progress v JOIN image_pages p ON p.id=v.page_id WHERE v.resource_id=? AND p.missing=0').get(id) as Row | undefined
    const cover = this.db.prepare('SELECT id FROM image_pages WHERE resource_id=? AND missing=0 ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,ordinal LIMIT 1').get(id, r.cover_page_id) as Row | undefined
    return withImageCollections(this.db,[imageItem(r, chapters, count, p, cover?.id || '')])[0]
  }
  bulkUpdate(ids: string[], patch: ImageBulkPatch): number {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new Error('请选择 1 到 5000 项资源')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['groupId', 'read', 'tags'].includes(key))) throw new Error('批量修改内容无效')
    if (patch.read !== undefined && typeof patch.read !== 'boolean') throw new Error('已读状态无效')
    if (patch.groupId !== undefined && patch.groupId !== null && (typeof patch.groupId !== 'string' || !patch.groupId)) throw new Error('分类无效')
    if (patch.tags !== undefined && (!patch.tags || typeof patch.tags !== 'object' || !['add', 'remove', 'replace'].includes(patch.tags.mode) || !Array.isArray(patch.tags.values) || patch.tags.values.length > 50 || patch.tags.values.some(t => typeof t !== 'string'))) throw new Error('标签修改无效')
    if (patch.read === undefined && patch.groupId === undefined && patch.tags === undefined) throw new Error('没有需要修改的内容')
    const values = [...new Set((patch.tags?.values || []).map(t => t.trim().slice(0, 80)).filter(Boolean))], unique = [...new Set(ids)]
    this.db.exec('SAVEPOINT image_bulk')
    try {
      if (patch.groupId && !this.db.prepare('SELECT 1 FROM image_groups WHERE id=? AND hidden=0').get(patch.groupId)) throw new Error('目标分类不可用或已隐藏')
      const lookup = this.db.prepare(`SELECT r.tags,m.item_type FROM resource r JOIN image_meta m ON m.resource_id=r.id WHERE r.id=? AND r.kind='image' AND ${visible}`)
      const changes = unique.map(id => {
        const item = lookup.get(id) as Row | undefined
        if (!item) throw new Error('所选资源不可用或已隐藏，请刷新后重试')
        if (patch.groupId !== undefined && item.item_type !== 'comic') throw new Error('相册不支持漫画分类')
        const old = JSON.parse(item.tags || '[]') as string[]
        const tags = patch.tags?.mode === 'replace' ? values : patch.tags?.mode === 'add' ? [...new Set([...old, ...values])] : old.filter(t => !values.includes(t))
        if (patch.tags && tags.length > 50) throw new Error('每项资源最多保留 50 个标签')
        return { id, tags }
      })
      const now = Date.now(), tagWrite = this.db.prepare('UPDATE resource SET tags=? WHERE id=?'), pool = this.db.prepare("INSERT OR IGNORE INTO tags(kind,name,source,created_at) VALUES('image',?,'user',?)")
      const groupWrite = this.db.prepare('UPDATE image_meta SET group_id=? WHERE resource_id=?'), readWrite = this.db.prepare('INSERT INTO image_reader_state(resource_id,is_read) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET is_read=excluded.is_read')
      const touch = this.db.prepare('UPDATE resource SET updated_at=? WHERE id=?')
      for (const change of changes) {
        if (patch.tags) { tagWrite.run(JSON.stringify(change.tags), change.id); for (const tag of change.tags) pool.run(tag, now) }
        if (patch.groupId !== undefined) groupWrite.run(patch.groupId, change.id)
        if (patch.read !== undefined) readWrite.run(change.id, Number(patch.read))
        touch.run(now, change.id)
      }
      this.db.exec('RELEASE image_bulk'); return unique.length
    } catch (cause) { this.db.exec('ROLLBACK TO image_bulk; RELEASE image_bulk'); throw cause }
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
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,source_dir=excluded.source_dir,file_name=excluded.file_name,updated_at=excluded.updated_at`).run(id, scan.path, Date.now(), Date.now(), path.basename(scan.path), scan.sourceDir, scan.name, scan.description || '', JSON.stringify(scan.tags || []), scan.type === 'comic' ? '漫画' : '照片')
      this.db.prepare(`INSERT INTO image_meta(resource_id,item_type,source,source_id,publication) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO NOTHING`).run(id, scan.type, scan.source || '', scan.sourceId || '', scan.publication || 'unknown')
      this.db.prepare('UPDATE image_pages SET missing=1 WHERE resource_id=?').run(id)
      const priorChapters = this.db.prepare('SELECT id,ordinal,customized FROM image_chapters WHERE resource_id=?').all(id) as Row[]
      const customOrder = priorChapters.some(c => c.customized === 1), priorOrder = new Map(priorChapters.map(c => [c.id, c.ordinal as number]))
      let nextChapter = Math.max(-1, ...priorChapters.map(c => c.ordinal as number)) + 1
      let ordinal = 0
      for (const [ci, chapter] of scan.chapters.entries()) {
        const cid = scan.type === 'comic' ? hash(id + ':chapter:' + chapter.key) : null
        if (cid) {
          const chapterOrdinal = customOrder ? priorOrder.get(cid) ?? nextChapter++ : ci
          this.db.prepare(`INSERT INTO image_chapters(id,resource_id,chapter_key,title,ordinal,source_id,customized) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=CASE WHEN image_chapters.customized=1 THEN image_chapters.ordinal ELSE excluded.ordinal END,customized=MAX(image_chapters.customized,excluded.customized)`).run(cid, id, chapter.key, chapter.title, chapterOrdinal, chapter.sourceId || '', Number(customOrder))
        }
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
    if (patch.read !== undefined && typeof patch.read !== 'boolean') throw new Error('已读状态无效')
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
    if (patch.read !== undefined) {
      this.db.prepare('INSERT INTO image_reader_state(resource_id,is_read) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET is_read=excluded.is_read').run(id, Number(patch.read))
    }
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
