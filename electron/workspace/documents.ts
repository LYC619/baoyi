import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SqlDb } from '../services/schema.ts'
import { TextStreamService, type NovelIndexResult } from './text-stream.ts'
import {
  type DocumentCategory,
  type DocumentCustomGroup,
  type DocumentSubmodule,
  type DocumentItem,
  type DocumentPatch,
  type DocumentScan,
  type DocumentAnnotation,
  type AnnotationInput,
  type ReadingLocation,
} from '../../src/types/workspace.ts'
import * as v from './validation.ts'

type Row = Record<string, any>
const extensions = new Set(['pdf', 'md', 'txt', 'markdown', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'png', 'jpg', 'jpeg'])
const ignored = new Set(['node_modules', 'dist', 'dist-electron', 'release', 'build', 'cache', '__pycache__', '$recycle.bin', 'system volume information'])
ignored.add('回收站')
const stateLabels = { unread: '未读', reading: '在读', read: '已读' } as const
const stateTags = Object.values(stateLabels) as string[]

function inferCategory(filePath: string, format: string): { suggestedSubmodule?: DocumentSubmodule; suggestedCategoryId?: string; suggestedReason?: string } {
  const lower = filePath.toLowerCase()
  if (/(?:证书|执业|聘书|奖状|认证|证明|资格|聘任)/i.test(lower)) {
    return { suggestedSubmodule: 'archive', suggestedCategoryId: 'certificate', suggestedReason: '路径包含证书相关关键字' }
  }
  if (/(?:简历|证件|身份证|护照|户口|驾照|社保|档案|resume|cv)/i.test(lower)) {
    return { suggestedSubmodule: 'archive', suggestedCategoryId: 'id_resume', suggestedReason: '路径包含简历或证件相关关键字' }
  }
  if (/(?:合同|协议|报价|发票|账单|收据|contract|invoice|agreement)/i.test(lower)) {
    return { suggestedSubmodule: 'archive', suggestedCategoryId: 'archive_other', suggestedReason: '路径包含合同凭据相关关键字' }
  }
  if (/(?:小说|传记|演义|章节|novel|fiction)/i.test(lower)) {
    return { suggestedSubmodule: 'reading', suggestedCategoryId: 'novel', suggestedReason: '路径包含小说关键字' }
  }
  if (/(?:论文|期刊|综述|研报|paper|journal|thesis|dissertation)/i.test(lower)) {
    return { suggestedSubmodule: 'reading', suggestedCategoryId: 'paper', suggestedReason: '路径包含论文或学术关键字' }
  }
  if (/(?:书籍|教程|指南|手册|规范|导论|概论|深入|核心|编程|book|manual|guide)/i.test(lower)) {
    return { suggestedSubmodule: 'reading', suggestedCategoryId: 'book', suggestedReason: '路径包含书籍或指南关键字' }
  }
  if (format === 'txt') {
    return { suggestedSubmodule: 'reading', suggestedCategoryId: 'novel', suggestedReason: 'TXT文本默认推测为小说/读物' }
  }
  if (format === 'epub') {
    return { suggestedSubmodule: 'reading', suggestedCategoryId: 'book', suggestedReason: 'EPUB电子书默认推测为书籍' }
  }
  if (['png', 'jpg', 'jpeg'].includes(format)) {
    return { suggestedSubmodule: 'archive', suggestedCategoryId: 'archive_other', suggestedReason: '单张图片档案' }
  }
  return {}
}

export class DocumentLibrary {
  db: SqlDb
  textStream: TextStreamService
  constructor(db: SqlDb, cacheDir?: string) {
    this.db = db
    this.textStream = new TextStreamService(cacheDir || path.join(os.tmpdir(), 'baoyi-novel-cache'))
  }

  categories(submodule?: DocumentSubmodule): DocumentCategory[] {
    const rows = submodule
      ? (this.db.prepare('SELECT * FROM document_categories WHERE submodule=? ORDER BY sort_order,name').all(submodule) as Row[])
      : (this.db.prepare('SELECT * FROM document_categories ORDER BY submodule,sort_order,name').all() as Row[])
    return rows.map(r => ({
      id: r.id,
      submodule: r.submodule || 'reading',
      name: r.name,
      description: r.description,
      behavior: r.behavior,
      order: r.sort_order,
    }))
  }

  category(id: string): DocumentCategory {
    const all = this.categories()
    let c = all.find(c => c.id === id)
    if (!c && id === 'other') {
      c = all.find(c => c.id === 'reading_other') || all.find(c => c.id === 'archive_other')
    }
    if (!c) throw new Error('资料分类不存在，请重新选择')
    return c
  }

  saveCategory(input: Omit<DocumentCategory, 'id' | 'submodule'> & { id?: string; submodule?: DocumentSubmodule }): DocumentCategory {
    v.keys(input, ['id', 'submodule', 'name', 'description', 'behavior', 'order'])
    const id = input.id || randomUUID(),
      submodule = input.submodule || 'reading',
      name = v.name(input.name),
      description = v.text(input.description, '分类说明', 2000),
      order = v.number(input.order, '分类顺序', 0, 10000)
    if (!['archive', 'reading'].includes(submodule) || !Number.isInteger(order) || !['reading', 'contract', 'certificate', 'other'].includes(input.behavior)) {
      throw new Error('分类参数无效')
    }
    if (input.id) this.category(id)
    if (this.categories(submodule).some(c => c.id !== id && c.name === name)) {
      throw new Error(`该子模块下已存在“${name}”分类`)
    }
    this.db.prepare(
      'INSERT INTO document_categories(id,submodule,name,description,behavior,sort_order) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET submodule=excluded.submodule,name=excluded.name,description=excluded.description,behavior=excluded.behavior,sort_order=excluded.sort_order',
    ).run(id, submodule, name, description, input.behavior, order)
    return this.category(id)
  }

  removeCategory(id: string, target?: string): void {
    const current = this.category(id)
    if (id === 'archive_other' || id === 'reading_other' || id === 'other') {
      throw new Error('其他是保留分类，不能删除')
    }
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM document_meta WHERE COALESCE(category_id,document_type)=?').get(id) as { n: number }).n
    if (count && !target) throw new Error('此分类包含资料，请选择转移分类')
    if (target) {
      const tgt = this.category(target)
      if (tgt.id === id) throw new Error('不能转移到同一分类')
      if (tgt.submodule !== current.submodule) throw new Error('目标分类必须属于同一子模块')
    }
    v.transaction(this.db, () => {
      if (target) {
        this.db.prepare('UPDATE document_meta SET category_id=?,document_type=? WHERE COALESCE(category_id,document_type)=?').run(target, this.legacyType(target), id)
      }
      this.db.prepare('DELETE FROM document_categories WHERE id=?').run(id)
    })
  }

  customGroups(submodule?: DocumentSubmodule, categoryId?: string): DocumentCustomGroup[] {
    const conditions: string[] = []
    const params: any[] = []
    if (submodule) {
      conditions.push('submodule=?')
      params.push(submodule)
    }
    if (categoryId) {
      conditions.push('category_id=?')
      params.push(categoryId)
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
    const rows = this.db.prepare(`SELECT * FROM document_custom_groups${where} ORDER BY sort_order,name`).all(...params) as Row[]
    return rows.map(r => ({
      id: r.id,
      submodule: r.submodule,
      categoryId: r.category_id || undefined,
      name: r.name,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }

  saveCustomGroup(input: { id?: string; submodule: DocumentSubmodule; categoryId?: string; name: string; sortOrder?: number }): DocumentCustomGroup {
    const id = input.id || randomUUID(),
      submodule = input.submodule,
      categoryId = input.categoryId || (submodule === 'archive' ? 'archive_other' : 'novel'),
      name = v.name(input.name),
      order = input.sortOrder !== undefined ? v.number(input.sortOrder, '分组排序', 0, 10000) : 0,
      now = Date.now()
    if (!['archive', 'reading'].includes(submodule)) throw new Error('分组子模块无效')
    if (this.customGroups(submodule, categoryId).some(g => g.id !== id && g.name === name)) {
      throw new Error(`该分类下已存在“${name}”分组`)
    }
    this.db.prepare(
      'INSERT INTO document_custom_groups(id,submodule,category_id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET submodule=excluded.submodule,category_id=excluded.category_id,name=excluded.name,sort_order=excluded.sort_order,updated_at=excluded.updated_at',
    ).run(id, submodule, categoryId, name, order, now, now)
    return this.customGroups().find(g => g.id === id)!
  }

  removeCustomGroup(id: string): void {
    v.transaction(this.db, () => {
      this.db.prepare('UPDATE document_meta SET custom_group_id=NULL WHERE custom_group_id=?').run(id)
      this.db.prepare('DELETE FROM document_custom_groups WHERE id=?').run(id)
    })
  }

  private legacyType(id: string) {
    // This compatibility column still has a six-value CHECK in upgraded libraries.
    if (['book', 'paper', 'reference', 'contract', 'certificate', 'other'].includes(id)) return id
    const cat = this.categories().find(c => c.id === id)
    return cat ? (cat.behavior === 'reading' ? 'book' : cat.behavior) : 'other'
  }

  private item(r: Row): DocumentItem {
    const category = this.category(r.category_id || r.document_type)
    const file = existsSync(r.path)
      ? r.path
      : (this.db.prepare('SELECT path FROM document_files WHERE resource_id=? ORDER BY created_at').all(r.id) as { path: string }[]).find(f => existsSync(f.path))?.path || r.path
    const submodule: DocumentSubmodule = r.submodule || category.submodule
    const editedFields: string[] = JSON.parse(r.edited_fields || '[]')
    const tags: string[] = JSON.parse(r.tags || '[]')
    if (submodule === 'reading' && category.behavior === 'reading' && !editedFields.includes('readStateTagHidden')) {
      tags.push(stateLabels[r.read_state as keyof typeof stateLabels])
    }
    return {
      id: r.id,
      name: r.name_zh || r.file_name,
      path: file,
      format: r.format,
      type: category.id,
      typeName: category.name,
      typeLocked: !!r.type_locked,
      behavior: category.behavior,
      submodule,
      customGroupId: r.custom_group_id || undefined,
      favorite: !!r.favorite,
      sourceDir: r.source_dir || '',
      editedFields,
      author: r.author,
      counterpart: r.counterpart,
      issuedOn: r.issued_on,
      expiresOn: r.expires_on,
      notes: r.notes || '',
      tags: [...new Set(tags)],
      size: r.file_size || 0,
      available: existsSync(file),
      readable: submodule === 'reading' && category.behavior === 'reading',
      readState: r.read_state,
      position: { page: r.page, offset: r.scroll_offset },
      pageCount: r.page_count,
      updatedAt: r.updated_at,
      lastReadAt: Number(r.last_used_at || 0),
      ...(r.insight_core?{insight:{coreValue:r.insight_core,conclusions:[r.insight_first,r.insight_second,r.insight_third],userEdited:!!r.insight_edited,revision:r.insight_revision}}:{}),
    }
  }

  list(options?: { submodule?: DocumentSubmodule; uncategorized?: boolean; customGroupId?: string }): DocumentItem[] {
    let sql = "SELECT r.*,d.*,i.core_value AS insight_core,i.user_edited AS insight_edited,i.revision AS insight_revision,json_extract(i.conclusions,'$[0].text') AS insight_first,json_extract(i.conclusions,'$[1].text') AS insight_second,json_extract(i.conclusions,'$[2].text') AS insight_third FROM resource r JOIN document_meta d ON r.id=d.resource_id LEFT JOIN document_insights i ON i.resource_id=r.id AND i.active=1 WHERE r.kind='document' AND NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored')"
    const params: unknown[] = []
    if (options?.uncategorized) {
      sql += ' AND d.submodule IS NULL'
    } else if (options?.submodule) {
      sql += ' AND d.submodule=?'
      params.push(options.submodule)
    }
    if (options?.customGroupId) {
      sql += ' AND d.custom_group_id=?'
      params.push(options.customGroupId)
    }
    sql += ' ORDER BY r.updated_at DESC'
    return (this.db.prepare(sql).all(...params) as Row[]).map(r => this.item(r))
  }

  get(id: string): DocumentItem | null {
    const cleanId = String(id || '').trim()
    if (!cleanId) return null
    let row = this.db.prepare("SELECT r.*,d.* FROM resource r JOIN document_meta d ON r.id=d.resource_id WHERE r.id=? AND r.kind='document' AND NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored')").get(cleanId) as Row | undefined
    if (!row && /^[0-9a-fA-F-]{6,}$/.test(cleanId)) {
      const candidates = this.db.prepare("SELECT r.*,d.* FROM resource r JOIN document_meta d ON r.id=d.resource_id WHERE r.id LIKE ? || '%' AND r.kind='document' AND NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored') LIMIT 2").all(cleanId) as Row[]
      if (candidates.length === 1) {
        row = candidates[0]
      }
    }
    if (!row) {
      const byName = this.db.prepare("SELECT r.*,d.* FROM resource r JOIN document_meta d ON r.id=d.resource_id WHERE (r.name_zh=? OR r.file_name=?) AND r.kind='document' AND NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored') LIMIT 2").all(cleanId, cleanId) as Row[]
      if (byName.length === 1) {
        row = byName[0]
      }
    }
    return row ? this.item(row) : null
  }

  require(id: string): DocumentItem {
    const item = this.get(id)
    if (!item) throw new Error('资料不存在')
    return item
  }

  async inspect(file: string, allowOther = false) {
    if (!path.isAbsolute(file)) throw new Error('请选择完整文件路径')
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择实际资料文件')
    const format = path.extname(file).slice(1).toLowerCase()
    if (!allowOther && !extensions.has(format)) throw new Error('暂不支持此文件类型，请使用外部应用打开')
    return { format, size: stat.size }
  }

  async register(file: string, categoryId?: string, allowOther = false, submodule?: DocumentSubmodule | null, customGroupId?: string): Promise<DocumentItem> {
    file = path.resolve(file)
    const { format, size } = await this.inspect(file, allowOther)
    const copy = this.db.prepare('SELECT resource_id FROM document_files WHERE path=? COLLATE NOCASE').get(file) as { resource_id: string } | undefined
    if (copy) return this.require(copy.resource_id)
    const old = this.db.prepare('SELECT id,kind FROM resource WHERE path=? COLLATE NOCASE').get(file) as Row | undefined
    if (old) {
      if (old.kind !== 'document') throw new Error('文件已在其他资源库登记，请直接关联已有资源')
      return this.require(old.id)
    }
    let catId = categoryId
    if (!catId) {
      catId = submodule === 'archive' ? 'archive_other' : 'reading_other'
    } else if (catId === 'other') {
      catId = submodule === 'archive' ? 'archive_other' : 'reading_other'
    }
    const cat = this.category(catId)
    const finalSubmodule: DocumentSubmodule = submodule || cat.submodule
    if (finalSubmodule && cat.submodule !== finalSubmodule) throw new Error('所选分类不属于目标子模块')
    if (customGroupId) {
      const g = this.customGroups().find(x => x.id === customGroupId)
      if (!g || g.submodule !== finalSubmodule) {
        customGroupId = undefined
      }
    }
    const id = randomUUID(), now = Date.now(), title = path.basename(file, path.extname(file))
    return v.transaction(this.db, () => {
      this.db.prepare("INSERT INTO resource(id,kind,path,file_name,file_size,source_dir,name_zh,created_at,updated_at,ai_status) VALUES(?,'document',?,?,?,?,?,?,?,'done')").run(id, file, path.basename(file), size, path.dirname(file), title, now, now)
      this.db.prepare('INSERT INTO document_meta(resource_id,format,document_type,category_id,type_locked,submodule,custom_group_id) VALUES(?,?,?,?,?,?,?)').run(
        id,
        format,
        this.legacyType(cat.id),
        cat.id,
        Number(!!categoryId),
        finalSubmodule,
        customGroupId || null,
      )
      return this.require(id)
    })
  }

  moveToSubmodule(id: string, targetSubmodule: DocumentSubmodule, targetCategoryId?: string): DocumentItem {
    this.require(id)
    if (!['archive', 'reading'].includes(targetSubmodule)) throw new Error('目标子模块无效')
    let catId = targetCategoryId
    if (!catId) {
      catId = targetSubmodule === 'archive' ? 'archive_other' : 'reading_other'
    } else if (catId === 'other') {
      catId = targetSubmodule === 'archive' ? 'archive_other' : 'reading_other'
    }
    const cat = this.category(catId)
    if (cat.submodule !== targetSubmodule) {
      throw new Error('所选分类不属于目标子模块')
    }
    return v.transaction(this.db, () => {
      this.db.prepare('UPDATE document_meta SET submodule=?,category_id=?,document_type=?,custom_group_id=NULL WHERE resource_id=?').run(
        targetSubmodule,
        cat.id,
        this.legacyType(cat.id),
        id,
      )
      this.db.prepare('UPDATE resource SET updated_at=? WHERE id=?').run(Date.now(), id)
      return this.require(id)
    })
  }

  async scan(roots: string[]): Promise<DocumentScan> {
    const items: DocumentScan['items'] = [], warnings: string[] = [], seen = new Set<string>()
    let visited = 0
    const visit = async (file: string, depth: number): Promise<void> => {
      if (visited++ >= 20000 || items.length >= 2000 || depth > 15) {
        if (!warnings.includes('扫描已达到本次上限，请分批导入')) warnings.push('扫描已达到本次上限，请分批导入')
        return
      }
      try {
        const stat = await fs.lstat(file)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
          const entries = await fs.readdir(file, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue
            if (visited >= 20000 || items.length >= 2000) {
              warnings.push('扫描已达到本次上限，请分批导入')
              break
            }
            await visit(path.join(file, entry.name), depth + 1)
          }
        } else if (stat.isFile() && extensions.has(path.extname(file).slice(1).toLowerCase()) && !seen.has(file.toLowerCase())) {
          seen.add(file.toLowerCase())
          const format = path.extname(file).slice(1).toLowerCase()
          const inferred = inferCategory(file, format)
          items.push({
            path: file,
            name: path.basename(file),
            format,
            size: stat.size,
            existing: !!(
              this.db.prepare('SELECT 1 FROM resource WHERE path=? COLLATE NOCASE').get(file) ||
              this.db.prepare('SELECT 1 FROM document_files WHERE path=? COLLATE NOCASE').get(file)
            ),
            ...inferred,
          })
        }
      } catch (e) {
        if (warnings.length < 30) warnings.push(`${path.basename(file)}：${(e as Error).message}`)
      }
    }
    for (const root of v.strings(roots, 100)) {
      if (!path.isAbsolute(root)) throw new Error('请选择完整文件路径')
      await visit(path.resolve(root), 0)
    }
    return { items, warnings: [...new Set(warnings)] }
  }

  async searchText(id:string, query:string, page=1, start=0, encoding?:string):Promise<{page:number;start:number;occurrence:number}|null> {
    query=v.text(query,'搜索词',300).trim().toLowerCase()
    if(!query)return null
    const index=await this.textIndex(id,encoding), first=Math.max(0,Math.min(index.chapters.length-1,Math.floor(page)-1))
    if(!Number.isSafeInteger(start)||start<0)throw new Error('搜索起点无效')
    for(let step=0;step<=index.chapters.length;step++){
      const n=(first+step)%index.chapters.length, chapter=index.chapters[n]
      if(!chapter) return null
      const {text}=await this.textSlice(id,chapter.byteOffset,chapter.byteLength,index.encoding)
      const lower=text.toLowerCase(), from=step===0?start:0
      const found=lower.indexOf(query,from)
      if(found>=0){
        let occurrence=0,cursor=lower.indexOf(query)
        while(cursor>=0&&cursor<found){occurrence++;cursor=lower.indexOf(query,cursor+query.length)}
        return {page:n+1,start:found,occurrence}
      }
    }
    return null
  }

  update(id: string, patch: DocumentPatch, source: 'user' | 'agent' = 'user'): DocumentItem {
    v.keys(patch, ['name', 'type', 'author', 'counterpart', 'issuedOn', 'expiresOn', 'notes', 'tags', 'readState', 'submodule', 'customGroupId', 'favorite'])
    const previous = this.require(id), next = { ...previous, ...patch }
    if (!next.submodule) next.submodule = this.category(next.type).submodule
    let editedFields = [...previous.editedFields]
    if (source === 'user' && patch.tags !== undefined) {
      const labels = v.strings(patch.tags).filter(tag => stateTags.includes(tag))
      if (labels.length > 1) throw new Error('阅读状态标签只能保留一个：未读、在读或已读')
      if (labels[0]) next.readState = (Object.keys(stateLabels) as Array<keyof typeof stateLabels>).find(key => stateLabels[key] === labels[0])!
      // Only lock automatic state when the user changes/removes that tag.
      const previousLabel = previous.tags.find(tag => stateTags.includes(tag))
      if (labels[0] !== previousLabel) editedFields.push('readState')
      editedFields = editedFields.filter(key => key !== 'readStateTagHidden')
      if (!labels.length) editedFields.push('readStateTagHidden')
    }
    next.tags = next.tags.filter(tag => !stateTags.includes(tag))
    if (patch.type !== undefined && patch.type !== null) {
      const category = this.category(next.type)
      if (patch.submodule !== undefined && patch.submodule !== null && patch.submodule !== category.submodule) throw new Error('所选分类不属于目标子模块')
      next.submodule = category.submodule
      if (next.customGroupId) {
        const currentGroup = this.customGroups().find(g => g.id === next.customGroupId)
        if (currentGroup && (currentGroup.submodule !== next.submodule || (currentGroup.categoryId && currentGroup.categoryId !== next.type))) {
          next.customGroupId = undefined
        }
      }
    }
    if (patch.favorite !== undefined && typeof patch.favorite !== 'boolean') throw new Error('收藏状态无效')
    if (patch.submodule !== undefined && patch.submodule !== null && !['archive', 'reading'].includes(patch.submodule)) {
      throw new Error('子模块无效')
    }
    if (patch.customGroupId) {
      const g = this.customGroups().find(x => x.id === patch.customGroupId)
      if (!g || (next.submodule && g.submodule !== next.submodule) || (g.categoryId && next.type && g.categoryId !== next.type)) throw new Error('自定义分组不存在或不属于该分类')
    }
    if (source === 'agent' && previous.typeLocked && patch.type !== undefined && next.type !== previous.type) {
      throw new Error('用户已明确选择分类，不能自动覆盖')
    }
    if (!['unread', 'reading', 'read'].includes(next.readState)) throw new Error('阅读状态无效')
    next.name = v.name(next.name); next.author = v.text(next.author, '作者', 300); next.counterpart = v.text(next.counterpart, '相关方', 300)
    next.issuedOn = v.date(next.issuedOn); next.expiresOn = v.date(next.expiresOn); next.notes = v.text(next.notes, '备注', 20000); next.tags = v.strings(next.tags)
    return v.transaction(this.db, () => {
      this.db.prepare('UPDATE resource SET name_zh=?,notes=?,tags=?,updated_at=? WHERE id=?').run(next.name, next.notes, JSON.stringify(next.tags), Date.now(), id)
      this.db.prepare('UPDATE document_meta SET favorite=? WHERE resource_id=?').run(Number(!!next.favorite), id)
      this.db.prepare(
        'UPDATE document_meta SET document_type=?,category_id=?,type_locked=?,author=?,counterpart=?,issued_on=?,expires_on=?,read_state=?,submodule=?,custom_group_id=? WHERE resource_id=?'
      ).run(
        this.legacyType(next.type),
        next.type,
        Number(previous.typeLocked || (source === 'user' && patch.type !== undefined)),
        next.author,
        next.counterpart,
        next.issuedOn,
        next.expiresOn,
        next.readState,
        next.submodule || null,
        next.customGroupId || null,
        id,
      )
      if (source === 'user') this.db.prepare('UPDATE document_meta SET edited_fields=? WHERE resource_id=?').run(JSON.stringify([...new Set([...editedFields, ...Object.keys(patch)])]), id)
      return this.require(id)
    })
  }

  savePosition(id: string, position: ReadingLocation, pageCount: number): void {
    const item = this.require(id), loc = v.location(position), count = v.number(pageCount, '总页数', 1, 1000000)
    if (!Number.isInteger(count) || loc.page > count) throw new Error('阅读位置超出文档范围')
    const state = item.readable && !item.editedFields.includes('readState')
      ? loc.page === count && loc.offset >= .98 ? 'read' : item.readState === 'read' ? 'read' : 'reading'
      : item.readState
    this.db.prepare('UPDATE document_meta SET page=?,scroll_offset=?,page_count=?,read_state=? WHERE resource_id=?').run(loc.page, loc.offset, count, state, id)
    this.db.prepare('UPDATE resource SET last_used_at=?,updated_at=? WHERE id=?').run(Date.now(), Date.now(), id)
  }

  annotations(id: string): DocumentAnnotation[] {
    this.require(id)
    return (this.db.prepare('SELECT * FROM document_annotations WHERE resource_id=? ORDER BY page,created_at').all(id) as Row[]).map(r => ({
      id: r.id,
      documentId: id,
      kind: r.kind,
      quote: r.quote,
      note: r.note,
      location: { page: r.page, offset: r.scroll_offset, ...(r.anchor ? { anchor: JSON.parse(r.anchor) } : {}) },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }

  annotate(id: string, input: AnnotationInput): DocumentAnnotation {
    this.require(id); v.keys(input, ['id', 'kind', 'quote', 'note', 'location'])
    if (!['bookmark', 'excerpt'].includes(input.kind)) throw new Error('标注类型无效')
    const quote = v.text(input.quote, '摘录', 30000), note = v.text(input.note, '笔记', 20000), loc = v.location(input.location)
    if (input.kind === 'excerpt' && !quote) throw new Error('请先选择或填写摘录原文')
    const now = Date.now(), annotationId = input.id || randomUUID()
    if (input.id) {
      if (!this.db.prepare('SELECT 1 FROM document_annotations WHERE id=? AND resource_id=?').get(input.id, id)) throw new Error('标注不属于此资料')
      this.db.prepare('UPDATE document_annotations SET kind=?,quote=?,note=?,page=?,scroll_offset=?,anchor=?,updated_at=? WHERE id=?').run(input.kind, quote, note, loc.page, loc.offset, loc.anchor ? JSON.stringify(loc.anchor) : '', now, input.id)
    } else {
      this.db.prepare('INSERT INTO document_annotations(id,resource_id,kind,quote,note,page,scroll_offset,anchor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(annotationId, id, input.kind, quote, note, loc.page, loc.offset, loc.anchor ? JSON.stringify(loc.anchor) : '', now, now)
    }
    return this.annotations(id).find(a => a.id === annotationId)!
  }

  removeAnnotation(id: string, annotationId: string): void {
    this.require(id)
    this.db.prepare('DELETE FROM document_annotations WHERE id=? AND resource_id=?').run(annotationId, id)
  }

  remove(id: string): void {
    this.require(id)
    this.db.prepare("DELETE FROM resource WHERE id=? AND kind='document'").run(id)
  }

  async relocate(id: string, file: string): Promise<DocumentItem> {
    const current = this.require(id)
    if (current.available) throw new Error('原文件仍存在，请先在文件管理器中移动文件')
    const inspected = await this.inspect(file)
    if (inspected.format !== current.format) throw new Error('请选择相同格式的原资料，以保留阅读定位')
    file = path.resolve(file)
    return v.transaction(this.db, () => {
      const latest = this.require(id)
      if (latest.path !== current.path || latest.available) throw new Error('原文件或资料位置已变化，请重新定位')
      const owner = this.db.prepare('SELECT id FROM resource WHERE path=? COLLATE NOCASE AND id<>? UNION ALL SELECT resource_id AS id FROM document_files WHERE path=? COLLATE NOCASE AND resource_id<>?').get(file, id, file, id)
      if (owner) throw new Error('新位置已登记为其他资料，请选择当前资料的文件')
      this.db.prepare('UPDATE resource SET path=?,file_name=?,source_dir=?,file_size=?,updated_at=? WHERE id=?').run(file, path.basename(file), path.dirname(file), inspected.size, Date.now(), id)
      return this.require(id)
    })
  }

  async content(id: string): Promise<{ format: string; text: string; data?: Uint8Array; isLarge?: boolean; size?: number }> {
    const item = this.require(id), stat = await this.inspect(item.path)
    if (item.format === 'pdf') {
      if (stat.size > 32 * 1024 * 1024) {
        return { format: 'pdf', text: '', isLarge: true, size: stat.size }
      }
      return { format: item.format, text: '', data: new Uint8Array(await fs.readFile(item.path)), size: stat.size }
    }
    if (['png', 'jpg', 'jpeg'].includes(item.format)) {
      return { format: item.format, text: '', data: new Uint8Array(await fs.readFile(item.path)), size: stat.size }
    }
    if (['md', 'markdown', 'txt'].includes(item.format)) {
      if (stat.size > 4 * 1024 * 1024) {
        return { format: item.format, text: '', isLarge: true, size: stat.size }
      }
      return { format: item.format, text: (await fs.readFile(item.path, 'utf8')).replace(/^\uFEFF/, ''), size: stat.size }
    }
    throw new Error('此格式请使用外部应用打开')
  }

  async textIndex(id: string, encoding?: string): Promise<NovelIndexResult> {
    const item = this.require(id)
    return this.textStream.indexNovel(item.path, encoding)
  }

  async textSlice(id: string, byteOffset: number, byteLength: number, encoding?: string): Promise<{ text: string; byteOffset: number; byteLength: number }> {
    const item = this.require(id)
    return this.textStream.sliceText(item.path, byteOffset, byteLength, encoding)
  }

  async pdfRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    const item = this.require(id)
    return this.textStream.readPdfRange(item.path, offset, length)
  }

  export(id: string, ids: string[]): string {
    const item = this.require(id), selected = new Set(v.strings(ids, 2000)), rows = this.annotations(id).filter(a => selected.has(a.id))
    if (!rows.length || rows.length !== selected.size) throw new Error('请选择有效的摘录或书签')
    return `# ${item.name}\n\n来源：${item.path}\n\n` + rows.map(a => `## ${a.kind === 'excerpt' ? '摘录' : '书签'} · 第 ${a.location.page}${a.location.anchor?.pages?.length ? '–' + a.location.anchor.pages.at(-1)!.page : ''} 页/段\n\n${a.quote.split('\n').map(line => '> ' + line).join('\n')}\n\n${a.note}\n\n<!-- baoyi-annotation:${a.id} -->\n`).join('\n')
  }
}
