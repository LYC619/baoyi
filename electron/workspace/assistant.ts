import type { SqlDb } from '../services/storage/schema.ts'
import type { AIConfig } from '../../src/types/index.ts'
import { createHash } from 'node:crypto'
import { collectEvidence } from './evidence.ts'
import { TimelineLibrary } from './timeline.ts'
export async function generateTimeline(db: SqlDb, id: string, ai = false, _config?: AIConfig) {
  if (ai) throw new Error('AI 整理已迁移，请使用持久项目会话入口')
  const evidence = await collectEvidence(db, id); if (!evidence.key) return null
  const timeline = new TimelineLibrary(db)
  if (evidence.source === 'git') {
    const known = new Set(timeline.events(id).flatMap(e=>e.evidence.map(s=>/^commit:([a-f0-9]+)/.exec(s)?.[1])))
    evidence.evidence = evidence.evidence.filter(s=>!known.has(/^commit:([a-f0-9]+)/.exec(s)?.[1]))
    if (!evidence.evidence.length) return null
    evidence.key = 'git:' + createHash('sha256').update(evidence.evidence.join('\n')).digest('hex')
    evidence.title = `${evidence.evidence.length} 次提交的事实草稿`
  }
  const body = `已观察到以下${evidence.source === 'git' ? '提交' : '文件变化'}，具体意图与完成情况可在确认前补充。\n\n${evidence.evidence.join('\n')}`
  const event = timeline.suggest(id, { title: evidence.title, body, source: evidence.source, sourceKey: evidence.key, evidence: evidence.evidence, occurredAt: evidence.occurredAt, version: evidence.version })
  if (evidence.snapshot) timeline.baseline(id, evidence.snapshot)
  return event
}
