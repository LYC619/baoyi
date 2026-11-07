import { createHash } from 'node:crypto'
import type { SqlDb } from '../services/schema.ts'
import { TimelineLibrary } from './timeline.ts'
import * as v from './validation.ts'

export interface AgentEventInput { title: string; body: string; commits: string[]; occurredAt: number; version?: string }
export class AgentJournal {
  db: SqlDb
  constructor(db: SqlDb) { this.db = db }
  record(projectId: string, sessionId: string, input: AgentEventInput) {
    const timeline = new TimelineLibrary(this.db)
    const commits = [...new Set(v.strings(input.commits, 100))].sort()
    if (!commits.length || commits.some(sha => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))) throw new Error('记录需要完整的提交 SHA 作为依据')
    const events = timeline.events(projectId)
    const covered = events.filter(e => e.evidence.some(s => commits.includes(/^commit:([a-f0-9]+)/.exec(s)?.[1] || '')))
    const known = new Set(covered.flatMap(e => e.evidence.map(s => /^commit:([a-f0-9]+)/.exec(s)?.[1])))
    if (commits.every(sha => known.has(sha))) return covered[0]
    if (commits.some(sha => known.has(sha))) throw new Error('部分提交已有记录，请仅选择尚未记录的提交，已有历史仍可读取和引用')
    return v.transaction(this.db, () => {
      const event = timeline.suggest(projectId, {
        title: input.title, body: input.body, occurredAt: input.occurredAt, version: input.version,
        source: 'git', sourceKey: 'agent:git:' + createHash('sha256').update(commits.join(',')).digest('hex'), evidence: commits.map(sha => 'commit:' + sha)
      })
      timeline.publish(projectId, event.id)
      this.db.prepare('INSERT INTO project_event_generation(event_id,resource_id,session_id,original,undone,created_at) VALUES(?,?,?,?,0,?)')
        .run(event.id, projectId, v.text(sessionId, '会话编号', 128), JSON.stringify(timeline.event(projectId, event.id)), Date.now())
      return timeline.event(projectId, event.id)
    })
  }
  private protectedReason(projectId: string, eventId: string): string {
    const event = new TimelineLibrary(this.db).event(projectId, eventId)
    if (!event.generated) throw new Error('此记录不是 agent 自动生成')
    if (event.revised) return '记录已人工修订，已保留；可在时间线中自行编辑或删除'
    if (this.db.prepare('SELECT 1 FROM resource_links WHERE owner_event_id=? LIMIT 1').get(eventId)) return '记录已添加后续关联，已保留'
    if (event.generated.undone || event.status === 'dismissed') return '记录已撤销或忽略'
    return ''
  }
  undoBatch(projectId: string, sessionId: string, apply = false) {
    const events = new TimelineLibrary(this.db).events(projectId).filter(e=>e.generated?.sessionId===sessionId && !e.generated.undone && e.status!=='dismissed')
    const eligible:Array<{id:string;title:string}>=[],retained:Array<{id:string;title:string;reason:string}>=[]
    for(const event of events){const reason=this.protectedReason(projectId,event.id);if(reason)retained.push({id:event.id,title:event.title,reason});else eligible.push({id:event.id,title:event.title})}
    const undone = apply ? v.transaction(this.db,()=>eligible.filter(e=>this.undo(projectId,e.id).undone).length) : 0
    return {eligible,retained,undone}
  }
  undo(projectId: string, eventId: string): { undone: boolean; reason: string } {
    const reason=this.protectedReason(projectId,eventId)
    if(reason)return {undone:false,reason}
    v.transaction(this.db, () => {
      this.db.prepare("UPDATE project_events SET status='dismissed',updated_at=? WHERE id=?").run(Date.now(), eventId)
      this.db.prepare('UPDATE project_event_generation SET undone=1 WHERE event_id=?').run(eventId)
    })
    return { undone: true, reason: '已撤销自动生成记录' }
  }
}
