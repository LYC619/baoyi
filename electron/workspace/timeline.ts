import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../services/schema.ts'
import type { TimelineEvent, EventInput, EventSuggestion, ProjectContext } from '../../src/types/workspace.ts'
import * as v from './validation.ts'
import { WorkspaceLinks } from './links.ts'
import { validateProjectContext } from '../kinds/project/context.ts'
type Row = Record<string, any>
export class TimelineLibrary {
  db: SqlDb
  constructor(db: SqlDb) { this.db = db }
  require(id: string): Row { const row = this.db.prepare("SELECT * FROM resource WHERE id=? AND kind='project'").get(v.text(id, '项目编号', 128)) as Row | undefined; if (!row) throw new Error('项目不存在'); return row }
  context(id: string): ProjectContext {
    this.require(id)
    const row=this.db.prepare('SELECT * FROM project_context WHERE resource_id=?').get(id) as Row|undefined
    return {current:row?.current_text||'',next:row?.next_text||'',prompt:row?.prompt_text||'',rules:JSON.parse(row?.rules||'[]'),version:1,revision:row?.revision||0,updatedAt:row?.updated_at||0}
  }
  updateContext(id: string, input: ProjectContext): ProjectContext {
    this.require(id)
    const next=validateProjectContext(input)
    const entries=JSON.parse((this.db.prepare('SELECT entries FROM project_meta WHERE resource_id=?').get(id) as Row|undefined)?.entries||'[]') as Array<{id:string}>
    if(next.rules.some(r=>r.type==='entry'&&!entries.some(e=>e.id===r.value)))throw new Error('规则入口不属于此项目或已移除')
    this.db.exec('SAVEPOINT save_project_context')
    try {
      this.db.prepare('INSERT INTO project_context(resource_id) VALUES(?) ON CONFLICT DO NOTHING').run(id)
      const result=this.db.prepare('UPDATE project_context SET current_text=?,next_text=?,prompt_text=?,rules=?,revision=revision+1,updated_at=? WHERE resource_id=? AND revision=?')
        .run(next.current,next.next,next.prompt,JSON.stringify(next.rules),Date.now(),id,next.revision)
      if(!result.changes)throw new Error('便签已被其他页面更新；你的输入仍保留，请比较最新内容后保存')
      this.db.exec('RELEASE save_project_context')
    }catch(error){this.db.exec('ROLLBACK TO save_project_context; RELEASE save_project_context');throw error}
    return this.context(id)
  }
  baseline(id: string, value?: string): string {
    this.require(id)
    if (value !== undefined) this.db.prepare('INSERT INTO project_context(resource_id,baseline) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET baseline=excluded.baseline').run(id, v.text(value, '目录快照', 4 * 1024 * 1024))
    return (this.db.prepare('SELECT baseline FROM project_context WHERE resource_id=?').get(id) as Row | undefined)?.baseline || ''
  }
  private item(r: Row): TimelineEvent {
    const generated = this.db.prepare('SELECT session_id,undone,created_at FROM project_event_generation WHERE event_id=?').get(r.id) as Row | undefined
    return { id: r.id, projectId: r.resource_id, title: r.title, body: r.body, occurredAt: r.occurred_at, milestone: !!r.milestone, version: r.version, source: r.source, sourceKey: r.source_key, evidence: JSON.parse(r.evidence), status: r.status, revised: !!r.revised, createdAt: r.created_at, updatedAt: r.updated_at,
      ...(generated ? { generated: { sessionId: generated.session_id, undone: !!generated.undone, createdAt: generated.created_at } } : {}) }
  }
  events(id: string): TimelineEvent[] { this.require(id); return (this.db.prepare('SELECT * FROM project_events WHERE resource_id=? ORDER BY occurred_at DESC,created_at DESC').all(id) as Row[]).map(r => this.item(r)) }
  event(projectId: string, id: string): TimelineEvent { this.require(projectId); const row = this.db.prepare('SELECT * FROM project_events WHERE id=? AND resource_id=?').get(id, projectId) as Row | undefined; if (!row) throw new Error('记录不属于此项目'); return this.item(row) }
  save(projectId: string, input: EventInput): TimelineEvent {
    this.require(projectId); v.keys(input, ['id', 'title', 'body', 'occurredAt', 'milestone', 'version'])
    const title = v.name(input.title), body = v.text(input.body, '记录内容', 50000), occurred = v.number(input.occurredAt, '记录时间', 0, 8640000000000000), version = v.text(input.version, '版本', 80)
    if (typeof input.milestone !== 'boolean') throw new Error('里程碑状态无效')
    const id = input.id || randomUUID(), now = Date.now()
    if (input.id) {
      this.event(projectId, input.id)
      this.db.prepare('UPDATE project_events SET title=?,body=?,occurred_at=?,milestone=?,version=?,revised=1,updated_at=? WHERE id=?').run(title, body, occurred, Number(input.milestone), version, now, id)
    } else this.db.prepare("INSERT INTO project_events(id,resource_id,title,body,occurred_at,milestone,version,source,source_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'manual',?,'published',?,?)").run(id, projectId, title, body, occurred, Number(input.milestone), version, 'manual:' + id, now, now)
    return this.event(projectId, id)
  }
  suggest(projectId: string, input: EventSuggestion): TimelineEvent {
    this.require(projectId)
    if (!['git', 'directory'].includes(input.source)) throw new Error('建议来源无效')
    const key = v.text(input.sourceKey, '来源编号', 500); if (!key) throw new Error('缺少建议依据编号')
    const previous = this.db.prepare('SELECT * FROM project_events WHERE resource_id=? AND source_key=?').get(projectId, key) as Row | undefined
    if (previous) return this.item(previous)
    const id = randomUUID(), now = Date.now()
    this.db.prepare("INSERT INTO project_events(id,resource_id,title,body,occurred_at,version,source,source_key,evidence,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)")
      .run(id, projectId, v.name(input.title), v.text(input.body, '建议内容', 50000), v.number(input.occurredAt ?? now, '时间', 0, 8640000000000000), v.text(input.version || '', '版本', 80), input.source, key, JSON.stringify(v.strings(input.evidence, 500)), now, now)
    return this.event(projectId, id)
  }
  publish(projectId: string, id: string): void { this.event(projectId, id); this.db.prepare("UPDATE project_events SET status='published',updated_at=? WHERE id=?").run(Date.now(), id) }
  dismiss(projectId: string, id: string): void { const event = this.event(projectId, id); if (event.status !== 'draft') throw new Error('只能忽略待确认建议'); this.db.prepare("UPDATE project_events SET status='dismissed',updated_at=? WHERE id=?").run(Date.now(), id) }
  remove(projectId: string, id: string): void { this.event(projectId, id); this.db.prepare('DELETE FROM project_events WHERE id=? AND resource_id=?').run(id, projectId) }
  export(projectId: string, links = new WorkspaceLinks(this.db)): string {
    const item = this.require(projectId), context = this.context(projectId)
    const references = (owner: 'event'|'project', id: string) => links.list(owner,id).map(l => `### 关联：${l.name}\n\n来源：${l.path}${l.location ? ` · 第 ${l.location.page} 页/段` : ''}\n\n${l.quote ? l.quote.split('\n').map(line=>'> '+line).join('\n')+'\n\n' : ''}`).join('')
    return `# ${item.name_zh} · 项目日志\n\n当前情况：${context.current}\n\n下一步：${context.next}\n\n` + this.events(projectId).filter(e => e.status === 'published').map(e => `## ${new Date(e.occurredAt).toLocaleDateString('sv-SE')} · ${e.title}${e.version ? ' · ' + e.version : ''}\n\n${e.body}\n\n${e.evidence.length ? '依据：\n' + e.evidence.map(x => '- ' + x).join('\n') + '\n' : ''}` + references('event',e.id)).join('\n') + '\n## 项目关联资料\n\n' + references('project',projectId)
  }
}
