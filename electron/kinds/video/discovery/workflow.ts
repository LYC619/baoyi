import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../../services/schema.ts'
import type { DiscoveryCatalogue } from './catalogue.ts'
import type { DiscoveryEntry, DiscoverySelection } from '../../../../src/types/video-discovery.ts'
import type { VideoDownloadDraft, VideoDownloadJob, VideoEnqueueRequest, VideoJobRetry } from '../../../../src/types/video-workflow.ts'
import type { VideoSourceRef } from '../../../../src/types/video-library.ts'
import { createVideoJobStore } from '../download/jobs.ts'
import { safeDownloadError, type TransferOptions, type TransferResult } from '../download/transfer.ts'
import type { HlsProgress } from '../download/hls.ts'
import type { MissavResolved } from './missav.ts'
import { reserveWorkDirectory, safeWorkFolderName, writeBundleFiles } from '../bundle.ts'
import { registerVideoContent } from '../registration.ts'
import { resolveVideoOwnership } from '../identity.ts'
import { getVideo } from '../db.ts'

interface Dependencies {
  db: SqlDb
  catalogue: DiscoveryCatalogue
  downloadsDirectory: () => string
  transfer: (options: Omit<TransferOptions, 'fetch'>) => Promise<TransferResult>
  savePoster?: (url: string, directory: string, signal?: AbortSignal, referer?: string) => Promise<string>
  /** 资料站没有可下载文件时，按番号去在线播放站解析 HLS 片源。 */
  resolvePlayback?: (code: string, signal: AbortSignal) => Promise<MissavResolved>
  /** HLS 分片下载 + 合并 + FFmpeg 封装。未接线时在线下载不可用。 */
  hlsTransfer?: (options: { url: string; destination: string; headers: Record<string, string>; signal: AbortSignal; onProgress: (progress: HlsProgress) => void }) => Promise<{ destination: string; warnings: string[] }>
  onChange?: (job: VideoDownloadJob) => void
  onLibraryChange?: (resourceId: string) => void
  beforeRegister?: () => void
}
const busy = (job: VideoDownloadJob) => job.status === 'queued' || job.status === 'running'
const filePresent = (file: string): boolean => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0 } catch { return false } }
const sourceRef = (sourceId: string, entry: DiscoveryEntry): VideoSourceRef => ({ provider: 'catalogue:' + sourceId, externalId: entry.id, scope: 'work', pageUrl: entry.pageUrl || entry.playUrl, evidence: 'confirmed' })
const codeFor = (sourceId: string, entryId: string) => 'catalogue_' + createHash('sha256').update(JSON.stringify([sourceId, entryId])).digest('hex').slice(0, 32)

/** User-provided, explicit media choices. No website scraping or script execution. */
export function createDiscoveryWorkflow(deps: Dependencies) {
  const store = createVideoJobStore(deps.db, job => !!job.discovery)
  store.interrupt()
  const jobs = new Map(store.list().map(job => [job.id, job]))
  const drafts = new Map<string, { draft: VideoDownloadDraft; entry: DiscoveryEntry }>()
  const queue: string[] = []
  let active: { id: string; controller: AbortController } | null = null
  let pumping: Promise<void> | null = null
  function changed(job: VideoDownloadJob) {
    job.updatedAt = Date.now(); store.save(job)
    try { deps.onChange?.(structuredClone(job)) } catch { /* UI does not own a transfer. */ }
  }
  function list(): VideoDownloadJob[] {
    for (const job of store.list()) if (!busy(jobs.get(job.id) || job)) jobs.set(job.id, job)
    return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(job => structuredClone(job))
  }
  async function prepare(selection: DiscoverySelection): Promise<VideoDownloadDraft> {
    const source = deps.catalogue.get(selection.sourceId), entry = deps.catalogue.entry(selection.sourceId, selection.entryId).entry
    // 资料站（JAVDB）不给下载文件，只给番号；在线片源在真正下载时才解析。
    const onlinePlayback = !entry.downloads.length && source.online?.adapter === 'javdb' && !!entry.code
    if (!entry.downloads.length && !onlinePlayback) throw new Error('此作品没有提供可下载文件，可以先打开来源观看')
    const ownership = resolveVideoOwnership(deps.db, { title: entry.title, sources: [sourceRef(source.id, entry)] })
    if (ownership.state === 'conflict') throw new Error('来源对应多个本地作品，请先确认归属')
    const resourceId = ownership.resourceId, existing = resourceId ? getVideo(deps.db, resourceId) : null
    const binding = resourceId ? deps.db.prepare('SELECT directory_path,root FROM video_directories WHERE resource_id=?').get(resourceId) as { directory_path: string; root: string } | undefined : undefined
    const assets = resourceId ? deps.db.prepare("SELECT path FROM video_assets WHERE resource_id=? AND role='video'").all(resourceId) as Array<{ path: string }> : []
    const videoCode = codeFor(source.id, entry.id), root = binding?.root || deps.downloadsDirectory()
    const present = assets.some(asset => filePresent(asset.path)) || !!existing && filePresent(existing.path)
    const draft: VideoDownloadDraft = { id: 'discovery-' + randomUUID(), discovery: selection, sourceName: source.name,
      qualities: entry.downloads.length ? entry.downloads.map(value => value.label) : ['在线片源'], resourceId, videoCode, title: existing?.name_zh || entry.title,
      description: existing?.description || entry.description, category: existing?.category || '其他', pageUrl: entry.pageUrl || entry.playUrl,
      root, directory: binding?.directory_path || path.join(root, safeWorkFolderName(entry.title)), bound: !!binding,
      warnings: [], missing: [...(!entry.description ? ['description'] : []), ...(!entry.coverUrl ? ['poster'] : [])],
      episodes: [{ videoCode, title: entry.title, order: 1, numbered: false,
        state: [...jobs.values()].some(job => busy(job) && job.videoCode === videoCode) ? 'queued' : present ? 'local' : assets.length ? 'missing' : 'available', qualities: [] }] }
    drafts.set(draft.id, { draft: structuredClone(draft), entry: structuredClone(entry) })
    while (drafts.size > 100) drafts.delete(drafts.keys().next().value!)
    return draft
  }
  function setRoot(id: string, root: string): VideoDownloadDraft {
    const value = drafts.get(id)
    if (!value) throw new Error('下载草稿已失效，请重新选择作品')
    if (value.draft.bound || !path.isAbsolute(root)) throw new Error('保存目录不可更改或路径无效')
    value.draft.root = path.resolve(root); value.draft.directory = path.join(root, safeWorkFolderName(value.draft.title))
    return structuredClone(value.draft)
  }
  function enqueue(request: VideoEnqueueRequest): VideoDownloadJob {
    const cached = drafts.get(request?.draftId)
    if (!cached) throw new Error('下载草稿已失效，请重新选择作品')
    const { draft, entry } = cached
    if (!Array.isArray(request.videoCodes) || request.videoCodes.length !== 1 || request.videoCodes[0] !== draft.videoCode) throw new Error('所选作品不在下载草稿中')
    if ([...jobs.values()].some(job => busy(job) && job.videoCode === draft.videoCode)) throw new Error('此作品已在排队或下载中')
    if (typeof request.sourceLabel !== 'string' || request.sourceLabel.length > 40) throw new Error('清晰度无效')
    if (request.strictQuality && request.sourceLabel && !entry.downloads.some(option => option.label === request.sourceLabel)) throw new Error('来源没有提供所选清晰度')
    const job: VideoDownloadJob = { id: 'discovery-' + randomUUID(), discovery: { sourceId: draft.discovery!.sourceId, entry: structuredClone(entry) },
      resourceId: draft.resourceId, bundleId: '', title: draft.bound ? draft.title : request.title?.trim().slice(0, 240) || draft.title,
      category: draft.category, videoCode: draft.videoCode, root: draft.root, directory: draft.bound ? draft.directory : '',
      sourceLabel: request.sourceLabel, strictQuality: request.strictQuality === true, register: request.register !== false,
      status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), message: '已排队', description: draft.description,
      posterUrl: entry.coverUrl, posterPath: draft.resourceId ? getVideo(deps.db, draft.resourceId)?.poster_path || '' : '',
      sources: [sourceRef(draft.discovery!.sourceId, entry)], warnings: [],
      items: [{ videoCode: draft.videoCode, title: entry.title, order: 1, path: '', sourceLabel: '', transfer: 'pending', metadata: 'pending', registration: 'pending', receivedBytes: 0, totalBytes: 0, error: '', warnings: [] }] }
    jobs.set(job.id, job); changed(job); queue.push(job.id); schedule()
    return structuredClone(job)
  }
  async function run(job: VideoDownloadJob, signal: AbortSignal) {
    const item = job.items[0], entry = job.discovery!.entry
    job.status = 'running'; job.message = '准备保存视频'; item.error = ''; changed(job)
    try {
      if (!job.directory) {
        const reserved = reserveWorkDirectory(job.root, job.title, job.videoCode)
        job.directory = reserved.directory; job.bundleId = reserved.bundleId
        if (reserved.warning) job.warnings.push(reserved.warning)
      }
      if (!fs.statSync(job.directory).isDirectory()) throw new Error('保存目录不可用，请连接磁盘后重试')
      if (job.resourceId && !job.bundleId) {
        const binding = deps.db.prepare('SELECT bundle_id FROM video_directories WHERE resource_id=?').get(job.resourceId) as { bundle_id: string } | undefined
        job.bundleId = binding?.bundle_id || randomUUID()
      }
      if (item.transfer !== 'complete') {
        if (entry.downloads.length) {
          const options = [...entry.downloads].sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0))
          const candidate = options.find(option => option.label === job.sourceLabel) || options[0]
          if (!candidate) throw new Error('来源没有提供可下载文件')
          if (job.sourceLabel && candidate.label !== job.sourceLabel) item.warnings.push('目标清晰度不可用，使用 ' + candidate.label)
          const destination = path.join(job.directory, safeWorkFolderName(entry.title) + ' [' + job.videoCode.slice(-8) + '] ' + safeWorkFolderName(candidate.label) + '.' + candidate.extension)
          item.transfer = 'running'; item.sourceLabel = candidate.label; job.message = '正在下载视频'; changed(job)
          const result = await deps.transfer({ url: candidate.url, destination, referer: entry.pageUrl || entry.playUrl || candidate.url, signal,
            onProgress: progress => { item.receivedBytes = progress.receivedBytes; item.totalBytes = progress.totalBytes; changed(job) } })
          item.path = result.destination; item.receivedBytes = result.receivedBytes; item.totalBytes = result.totalBytes
          item.warnings.push(...result.warnings); item.transfer = 'complete'; changed(job)
        } else {
          if (!deps.resolvePlayback || !deps.hlsTransfer) throw new Error('在线片源下载未启用（缺少 HLS 或解析通道）')
          if (!entry.code) throw new Error('这部作品没有番号，无法解析在线片源')
          item.transfer = 'running'; item.sourceLabel = '在线片源'; job.message = '正在解析在线片源'; changed(job)
          const resolved = await deps.resolvePlayback(entry.code, signal)
          if (!job.posterUrl && resolved.coverUrl) job.posterUrl = resolved.coverUrl
          const destination = path.join(job.directory, safeWorkFolderName(job.title) + '.mp4')
          job.message = '正在下载视频（HLS 分片）'; changed(job)
          const result = await deps.hlsTransfer({ url: resolved.m3u8, destination, headers: resolved.headers, signal,
            onProgress: progress => { item.receivedBytes = progress.receivedBytes; item.totalBytes = progress.totalBytes; if (!item.path) item.path = destination; changed(job) } })
          item.path = result.destination; item.warnings.push(...result.warnings); item.transfer = 'complete'; changed(job)
        }
      }
      signal.throwIfAborted()
      if (!filePresent(item.path)) throw new Error('已保存的视频无法访问，请连接磁盘或重新定位')
      if (item.metadata !== 'complete') {
        item.metadata = 'running'; changed(job)
        try {
          if (entry.coverUrl && !filePresent(job.posterPath) && deps.savePoster) job.posterPath = await deps.savePoster(entry.coverUrl, job.directory, signal, entry.pageUrl)
          signal.throwIfAborted()
          const result = writeBundleFiles({ videoType: (job.resourceId ? getVideo(deps.db, job.resourceId)?.video_type : undefined) || 'movie', directory: job.directory, bundleId: job.bundleId, title: job.title, description: job.description,
            category: job.category, tags: entry.tags, sources: job.sources, poster: { path: job.posterPath, source: entry.coverUrl },
            files: [{ path: item.path, title: entry.title, order: 1, quality: item.sourceLabel, size: item.receivedBytes, sourceUrl: entry.pageUrl, sources: job.sources, description: entry.description }] })
          job.bundleId = result.bundle.bundle_id; item.warnings.push(...result.warnings); item.metadata = 'complete'
        } catch (error) { signal.throwIfAborted(); item.metadata = 'failed'; item.warnings.push('资料待补：' + safeDownloadError(error)) }
      }
      signal.throwIfAborted()
      if (job.register && (item.registration !== 'complete' || job.retryStage === 'metadata')) {
        item.registration = 'running'; job.message = '正在登记到本地库'; changed(job); deps.beforeRegister?.()
        const result = registerVideoContent(deps.db, { videoType: (job.resourceId ? getVideo(deps.db, job.resourceId)?.video_type : undefined) || 'movie', resourceId: job.resourceId || undefined,
          bundleId: job.bundleId, directory: job.directory, root: job.root, title: job.title, description: job.description,
          category: job.category, tags: entry.tags, sources: job.sources, posterPath: job.posterPath, posterSource: entry.coverUrl,
          metadataState: item.metadata === 'complete' ? 'complete' : 'pending',
          items: [{ title: entry.title, order: 1, description: entry.description, tags: entry.tags, sources: job.sources,
            posterPath: job.posterPath, posterSource: entry.coverUrl, sourceUrl: entry.pageUrl,
            files: [{ path: item.path, quality: item.sourceLabel, size: item.receivedBytes }] }] })
        job.resourceId = result.resourceId; job.bundleId = result.bundleId; item.registration = 'complete'
        try { deps.onLibraryChange?.(job.resourceId) } catch { /* Registration is already persisted. */ }
      } else if (!job.register) item.registration = 'skipped'
      job.status = item.metadata === 'failed' ? 'partial' : 'success'
      job.message = item.metadata === 'failed' ? '视频已保存，部分资料待补全' : job.register ? '视频已保存并加入本地库' : '视频已保存'
    } catch (error) {
      item.error = safeDownloadError(error)
      if (item.transfer === 'running') item.transfer = 'failed'
      if (item.metadata === 'running') item.metadata = 'failed'
      if (item.registration === 'running') item.registration = 'failed'
      job.status = signal.aborted ? 'cancelled' : item.transfer === 'complete' ? 'partial' : 'failed'
      job.message = signal.aborted ? '已取消，完整保存的文件保留' : item.error
    }
    changed(job)
  }
  function schedule() {
    if (pumping) return
    pumping = Promise.resolve().then(async () => {
      while (queue.length) {
        const id = queue.shift()!, job = jobs.get(id)
        if (!job || job.status !== 'queued') continue
        active = { id, controller: new AbortController() }
        await run(job, active.controller.signal); active = null
      }
    }).finally(() => { active = null; pumping = null })
  }
  function retry(id: string, stage: VideoJobRetry): VideoDownloadJob {
    list()
    const job = jobs.get(id)
    if (!job || !['remaining', 'metadata', 'registration'].includes(stage)) throw new Error('下载任务或重试阶段无效')
    if (busy(job) || [...jobs.values()].some(other => other.id !== id && busy(other) && other.videoCode === job.videoCode)) throw new Error('此作品正在排队或下载中')
    const item = job.items[0]
    if (item.transfer === 'complete' && !filePresent(item.path)) throw new Error('已保存的视频无法访问，请连接磁盘或重新定位')
    if (stage !== 'remaining' && item.transfer !== 'complete') throw new Error('视频尚未下载完成，请先重试下载')
    if (stage === 'metadata') item.metadata = 'pending'
    job.retryStage = stage; job.status = 'queued'; job.message = '已排队重试'; changed(job); queue.push(id); schedule()
    return structuredClone(job)
  }
  function cancel(id: string): boolean {
    const job = jobs.get(id)
    if (active?.id === id) { active.controller.abort(new Error('用户取消下载')); return true }
    if (job?.status === 'queued') { job.status = 'cancelled'; job.message = '已取消排队'; changed(job); return true }
    return false
  }
  function dismiss(id: string): boolean {
    const job = jobs.get(id)
    if (!job || busy(job)) return false
    jobs.delete(id); store.remove(id); return true
  }
  function clearHistory(): void {
    if ([...jobs.values()].some(busy)) throw new Error('请先结束下载任务')
    jobs.clear(); drafts.clear(); queue.length = 0
  }
  return { prepare, setRoot, enqueue, list, retry, cancel, dismiss, clearHistory, idle: async () => { while (pumping) await pumping } }
}
