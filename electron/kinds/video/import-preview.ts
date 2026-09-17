import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoScanResult, VideoScanProgress } from '../../../src/types/index.ts'
import type { VideoImportBatch, VideoImportEdits, VideoImportEntry, VideoImportSummary } from '../../../src/types/video-import.ts'
import type { VideoImportRuntime } from './service.ts'
import { getVideo, updateVideo, videoOwnerForFiles } from './db.ts'
import { replayVideoImport, videoImportFiles, verifyVideoImportFiles, videoImportLibraryStamp, type VideoImportCommand, type VideoImportFileStamp } from './import-command.ts'
import { candidateFingerprint, rememberCandidate } from './scan-state.ts'

interface DraftRow { commands: VideoImportCommand[]; files: VideoImportFileStamp[]; fingerprints?: string[]; edits: VideoImportEdits; originalOwner: string }
interface Draft { batch: VideoImportBatch; rows: Record<string, DraftRow>; libraryStamp: string }
interface Options {
  db: SqlDb
  cloneDb: () => { db: SqlDb; close: () => void }
  scan: (roots: string[], report: (progress: VideoScanProgress) => void, restore: boolean, runtime: VideoImportRuntime) => Promise<VideoScanResult>
  review: (command: VideoImportCommand, runtime: VideoImportRuntime, report: (progress: VideoScanProgress) => void) => Promise<VideoScanResult>
  artwork?: (resourceId: string) => Promise<void>
  changed?: (batch: VideoImportBatch) => void
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const key = (value: string) => path.resolve(value).toLowerCase()
const busyStates = new Set(['scanning', 'reviewing', 'committing'])
const pending = (entry: VideoImportEntry) => entry.status === 'ready' || entry.status === 'review'
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const commandFiles = (command: VideoImportCommand) => command.kind === 'bundle' ? [] :
  [...new Set([...command.candidate.files, ...command.candidate.episodes.flatMap(ep => ep.files)].map(file => file.path))]
const fingerprints = (commands: VideoImportCommand[]) => commands.map(command => command.kind === 'bundle' ? '' : candidateFingerprint(command.candidate))
function verifyRowFiles(row: DraftRow) {
  verifyVideoImportFiles(row.files)
  if (row.fingerprints && JSON.stringify(row.fingerprints) !== JSON.stringify(fingerprints(row.commands))) throw new Error('文件或本地资料已变化，请重新检查目录后确认')
}

/** Drafts persist only the reviewed proposals, never a serialized database or settings. */
export function createVideoImportManager(options: Options) {
  const d = options.db, active = new Map<string, AbortController>()
  d.exec('CREATE TABLE IF NOT EXISTS video_import_drafts (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)')
  function read(id: string): Draft {
    if (typeof id !== 'string') throw new Error('导入批次无效')
    const row = d.prepare('SELECT payload FROM video_import_drafts WHERE id=?').get(id) as { payload: string } | undefined
    if (!row) throw new Error('导入批次不存在，可能已被丢弃')
    return JSON.parse(row.payload)
  }
  function save(draft: Draft, publish = true): VideoImportBatch {
    draft.batch.updatedAt = Date.now(); draft.batch.revision++
    d.prepare('INSERT INTO video_import_drafts (id,updated_at,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload')
      .run(draft.batch.id, draft.batch.updatedAt, JSON.stringify(draft))
    const result = copy(draft.batch); if (publish) { try { options.changed?.(result) } catch { /* The saved draft remains recoverable if the window closes. */ } }; return result
  }
  // A terminated process cannot leave a draft permanently disabled.
  for (const row of d.prepare('SELECT id FROM video_import_drafts').all() as { id: string }[]) {
    const draft = read(row.id)
    if (busyStates.has(draft.batch.status)) {
      draft.batch.status = 'interrupted'; draft.batch.activeEntryId = ''; draft.batch.error = '上次处理已中断，已保存的预览仍在，可重新检查目录。'; save(draft)
    }
  }
  function assertIdle(draft: Draft) {
    if (active.has(draft.batch.id) || busyStates.has(draft.batch.status)) throw new Error('此批次正在处理，请稍后再试')
  }
  function assertFresh(draft: Draft, rows: DraftRow[]) {
    if (videoImportLibraryStamp(d) !== draft.libraryStamp) throw new Error('作品资料或文件归属已变化，请重新检查目录后确认')
    rows.forEach(verifyRowFiles)
  }
  function chosen(draft: Draft, ids: string[]): VideoImportEntry[] {
    if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !draft.batch.entries.some(entry => entry.id === id))) throw new Error('所选导入条目无效')
    return draft.batch.entries.filter(entry => ids.includes(entry.id))
  }
  function proposal(db: SqlDb, resourceId: string, base: VideoImportEntry): VideoImportEntry {
    const item = getVideo(db, resourceId)
    if (!item) return base
    return { ...base, title: item.name_zh || item.name_en || item.file_name, originalTitle: item.name_en,
      category: item.category, description: item.description || item.summary || item.original_description,
      tags: item.tags, episodeCount: item.episode_total || 1, publishedStart: item.published_start || 0, publishedEnd: item.published_end || 0 }
  }
  function edited(entry: VideoImportEntry, edits: VideoImportEdits): VideoImportEntry { return { ...entry, ...edits } }
  async function scan(draft: Draft): Promise<VideoImportBatch> {
    assertIdle(draft)
    if (active.size) throw new Error('已有导入批次正在识别，请等本轮完成')
    const controller = new AbortController(), scratch = options.cloneDb()
    active.set(draft.batch.id, controller)
    const oldEntries = draft.batch.entries, oldRows = draft.rows
    draft.batch.status = 'scanning'; draft.batch.error = ''; draft.libraryStamp = videoImportLibraryStamp(d)
    const commands: VideoImportCommand[] = [], logs = new Map<string, string[]>()
    const runtime: VideoImportRuntime = { db: scratch.db, signal: controller.signal,
      capture: command => {
        commands.push(copy(command))
        const captured = commands.filter(value => key(value.path) === key(command.path))
        const owner = command.kind === 'bundle'
          ? scratch.db.prepare("SELECT id FROM resource WHERE path=? COLLATE NOCASE AND kind='video'").get(command.path) as { id: string } | undefined
          : videoOwnerForFiles(scratch.db, commandFiles(command))
        const item = owner && getVideo(scratch.db, owner.id)
        if (!item) return
        const previous = draft.batch.entries.find(entry => key(entry.path) === key(command.path))
        if (previous?.status === 'confirmed') return
        const id = previous?.id || randomUUID(), edits = draft.rows[id]?.edits || {}, existing = getVideo(d, item.id)
        const entry = edited(proposal(scratch.db, item.id, { id, path: command.path, title: '', originalTitle: '', category: '', description: '', tags: [],
          status: item.needs_review ? 'review' : 'ready', action: existing ? 'update' : 'new', fileCount: new Set(captured.flatMap(commandFiles)).size,
          episodeCount: 0, publishedStart: 0, publishedEnd: 0, resourceId: existing?.id || '', message: '识别完成，等待确认入库',
          log: (logs.get(key(command.path)) || []).join('\n'), tokens: 0, selected: previous?.selected ?? !item.needs_review }), edits)
        const index = draft.batch.entries.findIndex(value => value.id === id)
        if (index < 0) draft.batch.entries.push(entry); else draft.batch.entries[index] = entry
        draft.rows[id] = { commands: captured, edits, files: videoImportFiles(captured), fingerprints: fingerprints(captured), originalOwner: videoOwnerForFiles(d, captured.flatMap(commandFiles))?.id || '' }
        save(draft)
      },
      log: (file, line) => {
        const lines = logs.get(key(file)) || []; lines.push(line); logs.set(key(file), lines)
        const entry = draft.batch.entries.find(entry => key(entry.path) === key(file))
        if (entry && entry.status !== 'confirmed') entry.log = lines.join('\n').slice(-150000)
      } }
    save(draft)
    try {
      const result = await options.scan(draft.batch.roots, progress => { draft.batch.progress = progress; save(draft) }, false, runtime)
      const entries: VideoImportEntry[] = oldEntries.filter(entry => entry.status === 'confirmed')
      const rows: Record<string, DraftRow> = Object.fromEntries(entries.map(entry => [entry.id, oldRows[entry.id]]))
      const results = new Map((result.entries || []).map(entry => [key(entry.path), entry]))
      for (const [file, resultEntry] of results) {
        if (entries.some(entry => key(entry.path) === file)) continue
        const previous = draft.batch.entries.find(entry => key(entry.path) === file && entry.status !== 'confirmed') || oldEntries.find(entry => key(entry.path) === file && entry.status !== 'confirmed')
        const captured = commands.filter(command => key(command.path) === file)
        const canRegister = captured.length > 0 && resultEntry.status !== 'failed'
        const status = !canRegister ? resultEntry.status === 'failed' ? 'failed' : 'skipped' : resultEntry.status === 'review' ? 'review' : 'ready'
        const id = previous?.id || randomUUID(), edits = previous ? (draft.rows[previous.id] || oldRows[previous.id])?.edits || {} : {}
        const existing = resultEntry.resourceId && getVideo(d, resultEntry.resourceId)
        const base: VideoImportEntry = { id, path: resultEntry.path, status, action: existing ? 'update' : 'new', title: path.basename(resultEntry.path),
          originalTitle: '', category: '其他', description: '', tags: [], fileCount: new Set(captured.flatMap(commandFiles)).size,
          episodeCount: 0, publishedStart: 0, publishedEnd: 0, resourceId: existing ? existing.id : '',
          message: canRegister ? status === 'review' ? '本地资料不足，可编辑或让 Agent 复查' : '识别完成，等待确认入库' : resultEntry.message,
          log: (logs.get(file) || [resultEntry.message]).join('\n').slice(-150000), tokens: 0, selected: canRegister && (previous?.selected ?? status === 'ready') }
        entries.push(edited(resultEntry.resourceId ? proposal(scratch.db, resultEntry.resourceId, base) : base, edits))
        rows[id] = { commands: captured, files: videoImportFiles(captured), fingerprints: fingerprints(captured), edits,
          originalOwner: videoOwnerForFiles(d, captured.flatMap(commandFiles))?.id || '' }
      }
      draft.batch.entries = entries; draft.rows = rows; draft.batch.tokens += result.tokens
      draft.batch.status = controller.signal.aborted ? 'interrupted' : 'ready'
      if (controller.signal.aborted) draft.batch.error = '识别已停止，已完成的预览保留。'
    } catch (error) { draft.batch.status = 'interrupted'; draft.batch.error = messageOf(error) }
    finally { scratch.close(); active.delete(draft.batch.id); draft.batch.activeEntryId = '' }
    return save(draft)
  }
  async function prepare(roots: string[]) {
    if (!Array.isArray(roots) || !roots.length || roots.length > 50 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || !fs.statSync(root).isDirectory())) throw new Error('请选择有效的视频目录')
    const now = Date.now()
    return scan({ batch: { id: randomUUID(), roots: [...new Set(roots.map(root => path.resolve(root)))], createdAt: now, updatedAt: now, revision: 0,
      status: 'ready', entries: [], progress: null, activeEntryId: '', error: '', tokens: 0 }, rows: {}, libraryStamp: '' })
  }
  function update(id: string, changes: { selectedIds?: string[]; entry?: { id: string; edits: VideoImportEdits } }) {
    const draft = read(id); assertIdle(draft)
    if (changes.selectedIds) {
      chosen(draft, changes.selectedIds)
      for (const entry of draft.batch.entries) entry.selected = pending(entry) && changes.selectedIds.includes(entry.id)
    }
    if (changes.entry) {
      const entry = chosen(draft, [changes.entry.id])[0]
      if (!pending(entry)) throw new Error('该条目当前不能编辑')
      const edits: VideoImportEdits = {}
      for (const field of ['title', 'originalTitle', 'category', 'description'] as const) if (changes.entry.edits[field] !== undefined) {
        const value = changes.entry.edits[field]
        if (typeof value !== 'string' || value.length > (field === 'description' ? 20000 : 240) || field === 'title' && !value.trim()) throw new Error('名称、分类或简介格式无效')
        edits[field] = value.trim()
      }
      if (changes.entry.edits.tags !== undefined) {
        const tags = changes.entry.edits.tags
        if (!Array.isArray(tags) || tags.length > 80 || tags.some(tag => typeof tag !== 'string' || tag.length > 80)) throw new Error('标签格式无效')
        edits.tags = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))]
      }
      Object.assign(draft.rows[entry.id].edits, edits); Object.assign(entry, edits)
    }
    return save(draft)
  }
  async function review(id: string, ids: string[]) {
    const draft = read(id); assertIdle(draft)
    if (active.size) throw new Error('已有导入批次正在识别，请等本轮完成')
    const entries = chosen(draft, ids).filter(pending)
    if (!entries.length) throw new Error('请选择需要复查的条目')
    assertFresh(draft, entries.map(entry => draft.rows[entry.id]))
    const controller = new AbortController(); active.set(id, controller)
    draft.batch.status = 'reviewing'; draft.batch.error = ''; save(draft)
    try {
      for (const entry of entries) {
        if (controller.signal.aborted) break
        entry.reviewError = ''
        draft.batch.activeEntryId = entry.id; save(draft)
        const scratch = options.cloneDb(), row = draft.rows[entry.id], commands: VideoImportCommand[] = [], lines: string[] = []
        let tokens = 0
        try {
          const original = row.commands[0]
          const result = await options.review(original, { db: scratch.db, signal: controller.signal,
            capture: command => commands.push(copy(command)), log: (_path, text) => lines.push(text) }, progress => { draft.batch.progress = progress; save(draft) })
          tokens = result.tokens
          if (controller.signal.aborted) throw new Error('复查已停止，保留原识别结果')
          const outcome = result.entries?.find(value => value.resourceId && value.status !== 'failed' && value.status !== 'skipped')
          if (result.failed || !outcome?.resourceId || !commands.length) throw new Error(result.entries?.find(value => value.status === 'failed')?.message || 'Agent 未给出可用结果，保留原识别结果')
          verifyRowFiles(row)
          const next = edited(proposal(scratch.db, outcome.resourceId, entry), row.edits)
          Object.assign(entry, next, { status: 'ready', message: 'Agent 复查完成，等待确认入库' })
          row.commands = commands; row.files = videoImportFiles(commands); row.fingerprints = fingerprints(commands)
        } catch (error) { entry.message = messageOf(error); entry.reviewError = entry.message; lines.push(entry.message) }
        finally { scratch.close(); entry.tokens += tokens; draft.batch.tokens += tokens; entry.log = (entry.log + '\n\nAgent 复查\n' + lines.join('\n')).slice(-150000); save(draft) }
      }
    } finally { active.delete(id); draft.batch.activeEntryId = ''; draft.batch.status = controller.signal.aborted ? 'interrupted' : 'ready' }
    return save(draft)
  }
  function confirm(id: string, ids: string[]) {
    const draft = read(id); assertIdle(draft)
    const entries = chosen(draft, ids).filter(entry => entry.status !== 'confirmed')
    if (!entries.length) return copy(draft.batch)
    if (entries.some(entry => !pending(entry))) throw new Error('失败或跳过的条目不能直接入库，请重新检查目录')
    assertFresh(draft, entries.map(entry => draft.rows[entry.id]))
    // Detaching one old mixed owner can affect its retained sibling. Keep that unit atomic.
    const splitOwners = new Set(Object.values(draft.rows).flatMap(row => row.commands.flatMap(command => command.kind !== 'bundle' && command.splitFromId ? [command.splitFromId] : [])))
    for (const owner of splitOwners) {
      const related = draft.batch.entries.filter(entry => pending(entry) && draft.rows[entry.id].originalOwner === owner)
      if (related.some(entry => entries.includes(entry)) && related.some(entry => !entries.includes(entry))) throw new Error('这些条目原属同一作品，需要一起确认拆分；其他条目不受影响')
    }
    d.exec('SAVEPOINT video_import_confirm')
    try {
      for (const entry of entries) {
        const row = draft.rows[entry.id]
        if (!row.commands.length) throw new Error('缺少可用识别结果，请重新检查目录')
        let resourceId = ''
        for (const command of row.commands) {
          const result = replayVideoImport(d, command); resourceId = result.resourceId
          if (!resourceId) throw new Error('登记未生成作品，已保留预览')
          if (command.kind !== 'bundle') rememberCandidate(d, command.candidate, candidateFingerprint(command.candidate), resourceId)
        }
        const patch: Record<string, unknown> = {}
        for (const [field, value] of Object.entries(row.edits)) patch[field === 'title' ? 'name_zh' : field === 'originalTitle' ? 'name_en' : field] = value
        if (Object.keys(patch).length) updateVideo(d, resourceId, patch)
        entry.resourceId = resourceId; entry.status = 'confirmed'; entry.selected = false; entry.message = '已确认入库'
      }
      draft.libraryStamp = videoImportLibraryStamp(d)
      draft.batch.status = draft.batch.entries.some(pending) ? 'ready' : 'complete'; draft.batch.error = ''
      // Store row outcomes in the same transaction: a repeated confirmation cannot duplicate writes.
      const result = save(draft, false)
      d.exec('RELEASE SAVEPOINT video_import_confirm')
      try { options.changed?.(result) } catch { /* Registration has committed; delivery can be recovered by reloading the draft. */ }
      return result
    } catch (error) { d.exec('ROLLBACK TO SAVEPOINT video_import_confirm'); d.exec('RELEASE SAVEPOINT video_import_confirm'); throw error }
  }
  async function confirmWithArtwork(id: string, ids: string[]) {
    const before = read(id).batch, batch = confirm(id, ids)
    const added = batch.entries.filter(entry => entry.status === 'confirmed' && before.entries.find(old => old.id === entry.id)?.status !== 'confirmed')
    if (!options.artwork || !added.length) return batch
    const draft = read(id), artworkIds = [...new Set(added.map(entry => entry.resourceId))]
    // A known post-commit artwork change may advance this draft, while any other
    // metadata, ownership or file change must still require a fresh preview.
    const contentStamp = videoImportLibraryStamp(d, artworkIds)
    const controller = new AbortController(); active.set(id, controller)
    draft.batch.status = 'committing'; save(draft)
    try {
      for (const resourceId of artworkIds) {
        if (controller.signal.aborted) break
        try { await options.artwork(resourceId) }
        catch (error) {
          const entry = draft.batch.entries.find(entry => entry.resourceId === resourceId)!
          entry.log += '\n封面可稍后重试：' + messageOf(error)
        }
      }
    } finally {
      active.delete(id)
      if (videoImportLibraryStamp(d, artworkIds) === contentStamp) draft.libraryStamp = videoImportLibraryStamp(d)
      draft.batch.status = draft.batch.entries.some(pending) ? 'ready' : 'complete'
      save(draft)
    }
    return copy(draft.batch)
  }
  return {
    prepare, update, review, confirm, confirmWithArtwork, busy: () => active.size > 0,
    refresh: (id: string) => scan(read(id)),
    get: (id: string): VideoImportBatch | null => { try { return copy(read(id).batch) } catch { return null } },
    list: (): VideoImportSummary[] => (d.prepare('SELECT id FROM video_import_drafts ORDER BY updated_at DESC').all() as { id: string }[]).map(row => {
      const batch = read(row.id).batch
      return { id: batch.id, roots: batch.roots, createdAt: batch.createdAt, updatedAt: batch.updatedAt, status: batch.status,
        total: batch.entries.length, pending: batch.entries.filter(pending).length, confirmed: batch.entries.filter(entry => entry.status === 'confirmed').length }
    }),
    cancel: (id: string) => { const controller = active.get(id); controller?.abort(); return !!controller },
    discard: (id: string) => { const draft = read(id); assertIdle(draft); return Number(d.prepare('DELETE FROM video_import_drafts WHERE id=?').run(id).changes) > 0 }
  }
}
