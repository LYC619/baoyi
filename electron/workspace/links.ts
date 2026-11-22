import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SqlDb } from '../services/storage/schema.ts'
import { HENTAI_CATEGORY } from '../kinds/video/taxonomy.ts'
import type { LinkOwner, ResourceLink, ResourceOption, DocumentProjectReference } from '../../src/types/workspace.ts'
import * as v from './validation.ts'
import {DocumentLibrary} from './documents.ts'
type Row = Record<string, any>
export class WorkspaceLinks {
  db: SqlDb; hideHentai: boolean
  constructor(db: SqlDb, hideHentai = false) { this.db = db; this.hideHentai = hideHentai }
  owner(owner: LinkOwner, id: string): string {
    v.text(id, '关联编号', 128)
    const row = owner === 'project' ? this.db.prepare("SELECT name_zh AS name FROM resource WHERE id=? AND kind='project'").get(id)
      : owner === 'event' ? this.db.prepare('SELECT title AS name FROM project_events WHERE id=?').get(id)
      : ['skill', 'experience', 'asset'].includes(owner) ? this.db.prepare('SELECT name FROM personal_records WHERE id=? AND kind=?').get(id, owner) : null
    if (!row) throw new Error('关联所属记录不存在')
    return (row as { name: string }).name
  }
  private visible(id: string): boolean {
    return !!this.db.prepare(`SELECT r.id FROM resource r WHERE r.id=?
      AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
      AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1)`).get(id, HENTAI_CATEGORY, Number(this.hideHentai))
  }
  resources(): ResourceOption[] {
    return (this.db.prepare(`SELECT r.id,COALESCE(NULLIF(r.name_zh,''),r.file_name) AS name,r.path,r.kind FROM resource r
      WHERE NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored')
      AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
      AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1) ORDER BY r.updated_at DESC LIMIT 10000`).all(HENTAI_CATEGORY, Number(this.hideHentai)) as ResourceOption[])
  }
  counts(): Record<string, number> {
    const counts: Record<string,number> = {software:0,game:0,video:0,image:0,document:0}
    for (const row of this.db.prepare(`SELECT r.kind,COUNT(*) AS count FROM resource r
      WHERE NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=r.id AND x.state!='restored')
      AND NOT EXISTS(SELECT 1 FROM image_meta m JOIN image_groups g ON g.id=m.group_id WHERE m.resource_id=r.id AND g.hidden=1)
      AND NOT(r.kind='video' AND COALESCE(r.category,'')=? AND ?=1) GROUP BY r.kind`).all(HENTAI_CATEGORY,Number(this.hideHentai)) as Row[]) {
      if (row.kind in counts) counts[row.kind] = row.count
    }
    return counts
  }
  add(owner: LinkOwner, ownerId: string, resourceId: string, annotationId = ''): ResourceLink {
    this.owner(owner, ownerId)
    if (!this.visible(resourceId)) throw new Error('关联资源不存在或已隐藏')
    const resource = this.db.prepare('SELECT * FROM resource WHERE id=?').get(resourceId) as Row
    if(resource.kind==='document')new DocumentLibrary(this.db).require(resourceId)
    const annotation = annotationId ? this.db.prepare('SELECT * FROM document_annotations WHERE id=? AND resource_id=?').get(annotationId, resourceId) as Row | undefined : undefined
    if (annotationId && !annotation) throw new Error('摘录不属于此资料')
    const key = resourceId + ':' + annotationId
    this.db.prepare('INSERT OR IGNORE INTO resource_links(id,owner_type,owner_id,owner_resource_id,owner_event_id,owner_personal_id,target_key,resource_id,annotation_id,kind,name,path,quote,location,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), owner, ownerId, owner === 'project' ? ownerId : null, owner === 'event' ? ownerId : null, ['skill', 'experience', 'asset'].includes(owner) ? ownerId : null, key, resourceId, annotationId || null, resource.kind, resource.name_zh || resource.file_name, resource.path, annotation?.quote || '', annotation ? JSON.stringify({ page: annotation.page, offset: annotation.scroll_offset,...(annotation.anchor?{anchor:JSON.parse(annotation.anchor)}:{}) }) : '', Date.now())
    return this.list(owner, ownerId).find(x => x.resourceId === resourceId && x.annotationId === (annotationId || null))!
  }
  list(owner: LinkOwner, ownerId: string): ResourceLink[] {
    this.owner(owner, ownerId)
    return (this.db.prepare(`SELECT l.*,r.path AS live_path,r.name_zh AS live_name,a.quote AS live_quote,a.page AS live_page,a.scroll_offset AS live_offset,a.anchor AS live_anchor
      FROM resource_links l LEFT JOIN resource r ON r.id=l.resource_id LEFT JOIN document_annotations a ON a.id=l.annotation_id
      WHERE l.owner_type=? AND l.owner_id=? ORDER BY l.created_at DESC`).all(owner, ownerId) as Row[])
      .filter(r => !r.resource_id || this.visible(r.resource_id)).map(r => {const file=r.kind==='document'&&r.resource_id?new DocumentLibrary(this.db).get(r.resource_id)?.path||r.live_path||r.path:r.live_path||r.path;return ({ id: r.id, ownerType: owner, ownerId, resourceId: r.resource_id,
        annotationId: r.annotation_id, kind: r.kind, name: r.live_name || r.name, path: file,
        quote: r.live_quote ?? r.quote, location: r.live_page ? { page: r.live_page, offset: r.live_offset,...(r.live_anchor?{anchor:JSON.parse(r.live_anchor)}:{}) } : r.location ? JSON.parse(r.location) : null,
        missing: !r.resource_id || !existsSync(file) || (r.kind==='document'&&!new DocumentLibrary(this.db).get(r.resource_id)) })})
  }
  remove(owner: LinkOwner, ownerId: string, id: string): void { this.owner(owner, ownerId); this.db.prepare('DELETE FROM resource_links WHERE id=? AND owner_type=? AND owner_id=?').run(id, owner, ownerId) }
  projectReferences(documentIds: string[]): DocumentProjectReference[] {
    const ids = [...new Set(v.strings(documentIds, 500))]
    if (!ids.length) return []
    const targets = ids.map(() => '?').join(',')
    const visibleDocument = `d.kind='document' AND d.id IN (${targets})
      AND NOT EXISTS(SELECT 1 FROM document_recycle x WHERE x.resource_id=d.id AND x.state!='restored')`
    return this.db.prepare(`
      SELECT d.id AS documentId,l.annotation_id AS annotationId,l.id AS linkId,
        p.id AS projectId,p.name_zh AS projectName,l.owner_type AS ownerType,l.owner_id AS ownerId
      FROM resource_links l JOIN resource d ON d.id=l.resource_id
      JOIN resource p ON p.id=l.owner_resource_id AND p.kind='project'
      WHERE l.owner_type='project' AND ${visibleDocument}
      UNION ALL
      SELECT d.id,l.annotation_id,l.id,p.id,p.name_zh,l.owner_type,l.owner_id
      FROM resource_links l JOIN resource d ON d.id=l.resource_id
      JOIN project_events e ON e.id=l.owner_event_id
      JOIN resource p ON p.id=e.resource_id AND p.kind='project'
      WHERE l.owner_type='event' AND ${visibleDocument}
    `).all(...ids, ...ids) as unknown as DocumentProjectReference[]
  }
  backlinks(resourceId: string): Array<{ ownerType: LinkOwner; ownerId: string; name: string; projectId?: string }> {
    if (!this.visible(resourceId)) return []
    return (this.db.prepare('SELECT DISTINCT owner_type,owner_id FROM resource_links WHERE resource_id=?').all(resourceId) as Row[]).flatMap(r => {
      try { return [{ ownerType: r.owner_type, ownerId: r.owner_id, name: this.owner(r.owner_type, r.owner_id), ...(r.owner_type === 'event' ? { projectId: (this.db.prepare('SELECT resource_id FROM project_events WHERE id=?').get(r.owner_id) as Row).resource_id } : {}) }] } catch { return [] }
    })
  }
}
