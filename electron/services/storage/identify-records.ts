import { randomUUID } from 'node:crypto'
import type { AgentEvent, IdentifyLog, IdentifyLogQuery, IdentifyLogStatus, IdentifyReport, IdentifyReportEntry } from '../../../src/types/index.ts'
import type { SqlDb } from './schema.ts'
import { transaction } from '../../workspace/validation.ts'

type Row = Record<string, any>

/* ------------------------------ 识别日志 ------------------------------ */

/** 保留的日志条数。够翻完最近几轮识别，又不会让 db 无限长大 */
const LOG_KEEP = 300

/** 单条工具返回回放时截断的长度。原文回灌给模型时本就只有 6000 字符 */
const LOG_TEXT_MAX = 4000

/** 单条日志最多存几个事件，兜住模型疯狂打转的极端情况 */
const LOG_EVENT_MAX = 400

/** 事件里真正占空间的只有文本，落库前先削一刀 */
function trimEvents(events: AgentEvent[]): AgentEvent[] {
  return events.slice(0, LOG_EVENT_MAX).map((e) => {
    if (e.type === 'tool_result' && e.text.length > LOG_TEXT_MAX) {
      return { ...e, text: `${e.text.slice(0, LOG_TEXT_MAX)}\n…（已截断，共 ${e.text.length} 字符）` }
    }
    if (e.type === 'text' && e.text.length > LOG_TEXT_MAX) {
      return { ...e, text: `${e.text.slice(0, LOG_TEXT_MAX)}\n…（已截断）` }
    }
    return e
  })
}

export function saveIdentifyLog(d: SqlDb, log: Omit<IdentifyLog, 'id' | 'created_at'>): string {

  const id = randomUUID()
  transaction(d, () => {
    d.prepare(
      `INSERT INTO identify_logs
         (id, dir, label, kind, resource_kind, status, summary, registered, rounds,
          duration_ms, tokens, stop_reason, events, created_at)
       VALUES
         (@id, @dir, @label, @kind, @resource_kind, @status, @summary, @registered, @rounds,
          @duration_ms, @tokens, @stop_reason, @events, @created_at)`
    ).run({
      id,
      dir: log.dir,
      label: log.label,
      kind: log.kind,
      resource_kind: log.resource_kind,
      status: log.status,
      summary: log.summary.slice(0, 500),
      registered: log.registered,
      rounds: log.rounds,
      duration_ms: log.duration_ms,
      tokens: log.tokens,
      stop_reason: log.stop_reason,
      events: JSON.stringify(trimEvents(log.events)),
      created_at: Date.now()
    })
    d.prepare(
      `DELETE FROM identify_logs WHERE id NOT IN (
         SELECT id FROM identify_logs ORDER BY created_at DESC LIMIT ?
       )`
    ).run(LOG_KEEP)
  })

  return id
}

function rowToLog(row: Row): IdentifyLog {
  let events: AgentEvent[] = []
  try {
    const parsed = JSON.parse(row.events ?? '[]')
    if (Array.isArray(parsed)) events = parsed
  } catch {
    /* 存进去的是我们自己序列化的，解析失败就当没有过程记录，不影响结论那几行 */
  }
  return {
    id: row.id,
    dir: row.dir,
    label: row.label ?? '',
    kind: row.kind === 'item' ? 'item' : 'unit',
    resource_kind: row.resource_kind ?? 'software',
    status: (row.status ?? 'failed') as IdentifyLogStatus,
    summary: row.summary ?? '',
    registered: row.registered ?? 0,
    rounds: row.rounds ?? 0,
    duration_ms: row.duration_ms ?? 0,
    tokens: row.tokens ?? 0,
    stop_reason: row.stop_reason ?? '',
    events,
    created_at: row.created_at
  }
}

export function listIdentifyLogs(d: SqlDb, query: IdentifyLogQuery = {}): IdentifyLog[] {
  const where: string[] = []
  const params: unknown[] = []
  if (query.status) {
    where.push('status = ?')
    params.push(query.status)
  }
  if (query.resource_kind) {
    where.push('resource_kind = ?')
    params.push(query.resource_kind)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    where.push('(dir LIKE ? OR label LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  params.push(Math.min(Math.max(query.limit ?? 100, 1), LOG_KEEP))

  const rows = d
    .prepare(
      `SELECT * FROM identify_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as Row[]
  return rows.map(rowToLog)
}

export function clearIdentifyLogs(d: SqlDb, resourceKind?: string): number {

  // 报告只是这些日志的汇总视图，日志清了它就没有依据了 —— 一起清掉
  if (resourceKind) {
    const n = Number(d.prepare('DELETE FROM identify_logs WHERE resource_kind = ?').run(resourceKind).changes)
    d.prepare('DELETE FROM identification_reports WHERE resource_kind = ?').run(resourceKind)
    return n
  } else {
    const n = Number(d.prepare('DELETE FROM identify_logs').run().changes)
    d.prepare('DELETE FROM identification_reports').run()
    return n
  }
}

/* ------------------------------ 汇总报告 ------------------------------ */

/** 保留的报告条数。一轮识别一条，够翻回前几周 */
const REPORT_KEEP = 50

export function saveIdentifyReport(
  d: SqlDb, report: Omit<IdentifyReport, 'id' | 'created_at'>
): string {

  const id = randomUUID()
  transaction(d, () => {
    d.prepare(
      `INSERT INTO identification_reports
         (id, created_at, resource_kind, processed, registered, skipped, failed,
          duration_ms, tokens, searches, entries)
       VALUES
         (@id, @created_at, @resource_kind, @processed, @registered, @skipped, @failed,
          @duration_ms, @tokens, @searches, @entries)`
    ).run({
      id,
      created_at: Date.now(),
      resource_kind: report.resource_kind,
      processed: report.processed,
      registered: report.registered,
      skipped: report.skipped,
      failed: report.failed,
      duration_ms: report.duration_ms,
      tokens: report.tokens,
      searches: report.searches,
      entries: JSON.stringify(report.entries)
    })
    d.prepare(
      `DELETE FROM identification_reports WHERE id NOT IN (
         SELECT id FROM identification_reports ORDER BY created_at DESC LIMIT ?
       )`
    ).run(REPORT_KEEP)
  })

  return id
}

export function listIdentifyReports(d: SqlDb, resourceKind?: string): IdentifyReport[] {

  const rows = resourceKind
    ? (d.prepare('SELECT * FROM identification_reports WHERE resource_kind = ? ORDER BY created_at DESC').all(resourceKind) as Row[])
    : (d.prepare('SELECT * FROM identification_reports ORDER BY created_at DESC').all() as Row[])
  return rows.map((row) => {
    let entries: IdentifyReportEntry[] = []
    try {
      const parsed = JSON.parse(row.entries ?? '[]')
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      /* 解析不出来就只剩总览那几个数字，它们本身就是独立存的列 */
    }
    return {
      id: row.id,
      created_at: row.created_at,
      resource_kind: row.resource_kind ?? 'software',
      processed: row.processed ?? 0,
      registered: row.registered ?? 0,
      skipped: row.skipped ?? 0,
      failed: row.failed ?? 0,
      duration_ms: row.duration_ms ?? 0,
      tokens: row.tokens ?? 0,
      searches: row.searches ?? 0,
      entries
    }
  })
}
