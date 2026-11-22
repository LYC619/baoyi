import type { SqlDb } from '../services/storage/schema.ts'
import { ProjectLibrary } from '../kinds/project/library.ts'
import { projectHistory } from './project-history.ts'
interface Options { head?:(root:string)=>Promise<string>;busy:()=>boolean;start:(id:string,after:string)=>Promise<string> }
interface Row { resource_id:string;enabled:number;last_head:string;observed_head:string;pending_since:number;session_id:string;last_error:string }
export class ProjectAutomation {
  db: SqlDb
  options: Options
  private checking = false
  private stopped = false
  constructor(db: SqlDb, options: Options) { this.db = db; this.options = options }
  preferences(id: string, enabled?: boolean) {
    if (!new ProjectLibrary(this.db).get(id)) throw new Error('项目不存在')
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw new Error('自动记录设置无效')
      this.db.prepare('INSERT INTO project_automation(resource_id,enabled) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET enabled=excluded.enabled').run(id, Number(enabled))
    }
    const row = this.db.prepare('SELECT * FROM project_automation WHERE resource_id=?').get(id) as Row | undefined
    return { enabled: !!row?.enabled, lastHead: row?.last_head || '', sessionId: row?.session_id || '', error: row?.last_error || '' }
  }
  completed(id: string, head: string) {
    this.db.prepare("INSERT INTO project_automation(resource_id,enabled,last_head) VALUES(?,1,?) ON CONFLICT(resource_id) DO UPDATE SET last_head=excluded.last_head,observed_head='',pending_since=0,session_id='',last_error=''").run(id, head)
  }
  failed(id: string, error: string) { this.db.prepare('UPDATE project_automation SET last_error=? WHERE resource_id=?').run(error.slice(0, 2000), id) }
  stop() { this.stopped = true }
  async tick(now = Date.now()) {
    if (this.stopped || this.checking || this.options.busy()) return
    this.checking = true
    try {
      for (const row of this.db.prepare('SELECT * FROM project_automation WHERE enabled=1 AND session_id=\'\'').all() as Row[]) {
        if (this.stopped || this.options.busy()) break
        const item = new ProjectLibrary(this.db).get(row.resource_id); if (!item?.available) continue
        try {
          const head = await (this.options.head ? this.options.head(item.path) : projectHistory(item.path, { limit: 1 }).then(page => page.head))
          if (this.stopped) break
          if (head === row.last_head) continue
          if (head !== row.observed_head) { this.db.prepare('UPDATE project_automation SET observed_head=?,pending_since=? WHERE resource_id=?').run(head, now, row.resource_id); continue }
          if (now - row.pending_since < 15000) continue
          const sessionId = await this.options.start(row.resource_id, row.last_head)
          if (!this.stopped) this.db.prepare('UPDATE project_automation SET session_id=?,last_error=\'\' WHERE resource_id=?').run(sessionId, row.resource_id)
        } catch (error) { if (!this.stopped) this.failed(row.resource_id, (error as Error).message) }
      }
    } finally { this.checking = false }
  }
}
