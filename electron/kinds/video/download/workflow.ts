import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../../services/schema.ts'
import type { VideoDownloadDraft, VideoDownloadJob, VideoEnqueueRequest, VideoJobItem, VideoJobRetry } from '../../../../src/types/video-workflow.ts'
import type { VideoSourceRef } from '../../../../src/types/video-library.ts'
import { getVideo, listEpisodes } from '../db.ts'
import { resolveVideoOwnership } from '../identity.ts'
import { resolveVideoOrganizeOwner } from '../organize-owner.ts'
import { registerVideoContent } from '../registration.ts'
import { readVideoBundle, reserveWorkDirectory, safeWorkFolderName, writeBundleFiles } from '../bundle.ts'
import { toVideoCode, watchUrl } from '../hentai/selectors.ts'
import { createVideoJobStore, rebaseVideoJobDirectory } from './jobs.ts'
import { catalogueIdentity, episodeFilename, numberedEpisode } from '../episode-identity.ts'
import { fillEpisodeDetails, linkLegacyEpisode, reconcileEpisodeNumbers, sourceEpisodeFacts, type SourceEpisodeDetails } from '../episode-details.ts'
import { listVideoAssets } from '../library.ts'
import { downloadPlacement, promoteDownloadDirectory } from './placement.ts'
import { applyVideoCatalogue, canPromoteWorkTitle, moveWorkDescriptionToEpisode, releasePlaceholderClaims, videoCollectionTitle } from '../catalogue.ts'
import { persistVideoWorkBundle, syncVideoWorkFiles } from '../local-sync.ts'
import { DestinationExistsError, safeDownloadError, type TransferOptions, type TransferResult } from './transfer.ts'
import type { VideoSources } from './sources.ts'
import { selectVideoArtwork } from '../artwork.ts'

export interface VideoWorkSource { artworkUrls?: string[]; thumbnailUrl?: string; videoCode: string; title: string; description: string; posterUrl: string; tags: string[]; currentEpisode?: SourceEpisodeDetails; episodes: Array<{ videoCode: string; title: string }>; warnings: string[] }
interface Dependencies {
  db: SqlDb
  downloadsDirectory: () => string
  libraryRoots?: () => string[]
  resolveWork: (code: string, options?: { signal?: AbortSignal }) => Promise<VideoWorkSource>
  resolveSources: (code: string, options?: { signal?: AbortSignal }) => Promise<VideoSources>
  transfer: (options: Omit<TransferOptions, 'fetch'>) => Promise<TransferResult>
  savePoster?: (url: string, directory: string, signal?: AbortSignal) => Promise<string>
  artworkSize?: (file: string) => { width: number; height: number }
  onChange?: (job: VideoDownloadJob) => void
  onLibraryChange?: (resourceId: string) => void
  beforeRegister?: () => void
}
const sourceRef = (code: string): VideoSourceRef => ({ provider: 'hanime', externalId: code, scope: 'episode', pageUrl: watchUrl(code), evidence: 'playlist' })
function filePresent(file: string): boolean { try { return !!file && fs.statSync(file).isFile() && fs.statSync(file).size > 0 } catch { return false } }

export function createVideoWorkflow(deps: Dependencies) {
  const store = createVideoJobStore(deps.db)
  store.interrupt()
  const jobs = new Map(store.list().map(job => [job.id, job]))
  const refreshIdleJobs = () => {
    for (const job of store.list()) {
      const current = jobs.get(job.id)
      if (!current || current.status !== 'running' && current.status !== 'queued') jobs.set(job.id, job)
    }
  }
  const drafts = new Map<string, { draft: VideoDownloadDraft; info: VideoWorkSource }>()
  const queue: string[] = []
  let active: { id: string; controller: AbortController } | null = null
  let pumping: Promise<void> | null = null
  const changed = (job: VideoDownloadJob) => {
    job.updatedAt = Date.now(); store.save(job)
    try { deps.onChange?.(structuredClone(job)) } catch { /* Renderer lifetime does not own the job. */ }
  }
  const local = (resourceId: string, code: string) => deps.db.prepare(`SELECT DISTINCT a.path, a.quality FROM video_sources s
    JOIN video_episode_assets ea ON ea.episode_id = s.episode_id JOIN video_assets a ON a.id = ea.asset_id
    WHERE s.resource_id = ? AND s.provider = 'hanime' AND s.external_id = ? AND a.role = 'video'`).all(resourceId, code) as Array<{ path: string; quality: string }>

  async function prepare(input: { url?: string; resourceId?: string }): Promise<VideoDownloadDraft> {
    let existing = input.resourceId ? getVideo(deps.db, resolveVideoOrganizeOwner(deps.db, input.resourceId)) : null
    if (existing && deps.db.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(existing.id)) {
      syncVideoWorkFiles(deps.db, existing.id, { roots: deps.libraryRoots?.() || [], persist: false })
      existing = getVideo(deps.db, existing.id)
    }
    let videoCode = existing?.hanime_id || ''
    if (input.url) {
      if (!/^https?:\/\//i.test(input.url)) throw new Error('请输入支持站点的完整视频链接')
      videoCode = toVideoCode(input.url)
    }
    if (!/^\d{1,20}$/.test(videoCode)) throw new Error('当前支持 Hanime 视频链接；该作品还没有可用的来源编号')
    const info = await deps.resolveWork(videoCode)
    if (info.videoCode !== videoCode) throw new Error('来源编号不一致，请重新解析')
    const seen = new Set<string>()
    const episodes = [...info.episodes]
    if (!episodes.some(ep => ep.videoCode === videoCode)) episodes.push({ videoCode, title: info.title })
    const valid = episodes.filter(ep => /^\d{1,20}$/.test(ep.videoCode) && !seen.has(ep.videoCode) && !!seen.add(ep.videoCode))
    if (!valid.length || valid.length > 500) throw new Error('来源内容列表无效或超过 500 项')
    info.episodes = valid
    const catalogue = catalogueIdentity(info.title, valid)
    const currentOwner = resolveVideoOwnership(deps.db, { title: info.title, sources: [sourceRef(videoCode)] })
    const ownership = existing || currentOwner.state !== 'new' ? currentOwner
      : resolveVideoOwnership(deps.db, { title: info.title, sources: valid.map(ep => sourceRef(ep.videoCode)) })
    if (ownership.state === 'conflict' || (existing && ownership.resourceId && existing.id !== ownership.resourceId)) throw new Error('来源对应多个作品，请先在整理预览中确认归属')
    const resourceId = existing?.id || ownership.resourceId || ''
    const otherWorks = new Map<string, string>()
    if (resourceId) for (const ep of valid) {
      const owner = resolveVideoOwnership(deps.db, { title: ep.title, sources: [sourceRef(ep.videoCode)] })
      if (owner.state === 'conflict' || owner.resourceId && owner.resourceId !== resourceId) otherWorks.set(ep.videoCode, owner.resourceId)
    }
    if (otherWorks.size) {
      info.episodes = valid.filter(ep => !otherWorks.has(ep.videoCode))
      info.title = getVideo(deps.db, resourceId)?.name_zh || info.currentEpisode?.title || info.title
      info.warnings.push(`播放列表中 ${otherWorks.size} 集已有其他条目，保留原归属；可先组建合集后统一补齐。`)
    }
    if (resourceId && !existing && deps.db.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(resourceId)) {
      syncVideoWorkFiles(deps.db, resourceId, { roots: deps.libraryRoots?.() || [], persist: false })
    }
    let item = resourceId ? getVideo(deps.db, resourceId) : null
    if (resourceId) linkLegacyEpisode(deps.db, resourceId, catalogue.episodes, info.currentEpisode)
    const numberingWarnings = resourceId ? reconcileEpisodeNumbers(deps.db, resourceId, catalogue.episodes) : []
    if (resourceId && info.currentEpisode) {
      numberingWarnings.push(...applyVideoCatalogue(deps.db, resourceId, info).warnings || [])
      item = getVideo(deps.db, resourceId)
      if (item?.path && fs.existsSync(item.path)) numberingWarnings.push(...syncVideoWorkFiles(deps.db, resourceId, { roots: deps.libraryRoots?.() || [], persist: false }).warnings)
    }
    const binding = resourceId ? deps.db.prepare('SELECT directory_path, root FROM video_directories WHERE resource_id = ?').get(resourceId) as { directory_path: string; root: string } | undefined : undefined
    const promoteTitle = !otherWorks.size && !!item && canPromoteWorkTitle(deps.db, item.id, valid, catalogue.title)
    const title = promoteTitle ? videoCollectionTitle(info.title, info.episodes) : item?.name_zh || videoCollectionTitle(info.title, info.episodes) || '未命名作品'
    const placement = downloadPlacement(item, binding, title, deps.libraryRoots?.() || [], deps.downloadsDirectory())
    const episodeMetadata = !!info.currentEpisode && info.episodes.length > 1
    const description = episodeMetadata ? (item?.user_edited.includes('description') ? item.description : '') : item?.summary || info.description || ''
    const draft: VideoDownloadDraft = {
      id: randomUUID(), resourceId, videoCode, title, description, category: item?.category || '里番', pageUrl: watchUrl(videoCode),
      ...placement,
      warnings: [...info.warnings.map(safeDownloadError), ...numberingWarnings], missing: [...(!description && !episodeMetadata ? ['description'] : []), ...(!(item?.poster_path || info.posterUrl) ? ['poster'] : [])],
      episodes: catalogue.episodes.map(ep => {
        if (otherWorks.has(ep.videoCode)) return { ...ep, state: 'other-work' as const, resourceId: otherWorks.get(ep.videoCode), qualities: [] }
        const assets = resourceId ? local(resourceId, ep.videoCode) : []
        const available = assets.filter(a => filePresent(a.path))
        const localDetails = resourceId ? deps.db.prepare(`SELECT e.original_title FROM episode e JOIN video_sources s ON s.episode_id = e.id
          WHERE s.resource_id = ? AND s.provider = 'hanime' AND s.external_id = ? LIMIT 1`).get(resourceId, ep.videoCode) as { original_title: string } | undefined : undefined
        const queued = [...jobs.values()].some(j => (j.status === 'running' || j.status === 'queued') && j.items.some(i => i.videoCode === ep.videoCode))
        return { ...ep, originalTitle: localDetails?.original_title || (info.currentEpisode?.videoCode === ep.videoCode ? info.currentEpisode.originalTitle : ''),
          state: queued ? 'queued' : available.length ? 'local' : assets.length ? 'missing' : 'available', qualities: available.map(a => a.quality).filter(Boolean) }
      })
    }
    drafts.set(draft.id, { draft, info })
    while (drafts.size > 100) drafts.delete(drafts.keys().next().value!)
    return structuredClone(draft)
  }

  function setRoot(draftId: string, root: string): VideoDownloadDraft {
    const cached = drafts.get(draftId)
    if (!cached) throw new Error('下载草稿已失效，请重新解析')
    if (cached.draft.bound) throw new Error('作品已有固定目录，可在详情中重新定位')
    if (!path.isAbsolute(root)) throw new Error('请选择有效的影视库根目录')
    cached.draft.root = path.resolve(root); cached.draft.directory = path.join(root, safeWorkFolderName(cached.draft.title))
    return structuredClone(cached.draft)
  }

  function enqueue(request: VideoEnqueueRequest): VideoDownloadJob {
    const cached = drafts.get(request?.draftId)
    if (!cached) throw new Error('下载草稿已失效，请重新解析')
    if (!Array.isArray(request.videoCodes) || !request.videoCodes.length || request.videoCodes.length > 500 || new Set(request.videoCodes).size !== request.videoCodes.length || request.videoCodes.some(code => !cached.draft.episodes.some(ep => ep.videoCode === code))) throw new Error('请选择来源列表中的内容')
    if (request.videoCodes.some(code => cached.draft.episodes.some(ep => ep.videoCode === code && ep.state === 'other-work'))) throw new Error('所选内容已归属其他作品，请先组建合集或打开对应作品补齐')
    if (typeof request.sourceLabel !== 'string' || request.sourceLabel.length > 40) throw new Error('画质选择无效')
    const draft = cached.draft
    const title = request.title?.trim().slice(0, 240) || draft.title
    const job: VideoDownloadJob = {
      id: randomUUID(), resourceId: draft.resourceId, bundleId: '', title, category: draft.category, videoCode: draft.videoCode, root: draft.root,
      directory: draft.bound ? draft.directory : '', sourceLabel: request.sourceLabel, strictQuality: request.strictQuality === true, register: request.register !== false,
      ...(draft.directoryChange ? { directoryChange: structuredClone(draft.directoryChange) } : {}),
      episodeMetadata: !!cached.info.currentEpisode && cached.info.episodes.length > 1,
      status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), message: '已排队，等待前面的任务完成', description: draft.description,
      posterUrl: cached.info.posterUrl, posterPath: draft.resourceId ? getVideo(deps.db, draft.resourceId)?.poster_path || '' : '',
      sources: cached.info.episodes.map(ep => sourceRef(ep.videoCode)), warnings: [...draft.warnings],
      catalogue: draft.episodes.filter(ep => ep.state !== 'other-work').map(ep => ({ videoCode: ep.videoCode, title: ep.title, order: ep.order, numbered: ep.numbered === true })),
      items: draft.episodes.filter(ep => request.videoCodes.includes(ep.videoCode)).map(ep => ({ videoCode: ep.videoCode, title: ep.title, order: ep.order, path: '', sourceLabel: '', transfer: 'pending', metadata: 'pending', registration: 'pending', receivedBytes: 0, totalBytes: 0, error: '', warnings: [] }))
    }
    jobs.set(job.id, job); changed(job); queue.push(job.id); schedule()
    return structuredClone(job)
  }

  async function finishFile(job: VideoDownloadJob, item: VideoJobItem, signal: AbortSignal): Promise<void> {
    if (!filePresent(item.path)) throw new Error('已保存视频无法读取，请重新定位或重试下载')
    if (item.metadata !== 'complete' && job.retryStage !== 'registration') {
      item.metadata = 'running'; changed(job)
      try {
        if (job.retryStage === 'metadata' && job.episodeMetadata) {
          const details = (await deps.resolveWork(item.videoCode, { signal })).currentEpisode
          if (details?.videoCode === item.videoCode) { item.originalTitle ||= details.originalTitle; item.description ||= details.description; item.posterUrl ||= details.posterUrl; item.tags ||= details.tags; item.thumbnailUrl ||= details.thumbnailUrl; item.publishedAt ||= details.publishedAt; item.releaseDate ||= details.releaseDate; item.durationSec ||= details.durationSec; item.artist ||= details.artist }
        }
        if (!filePresent(job.posterPath) && job.posterUrl && deps.savePoster) {
          try { job.posterPath = await deps.savePoster(job.posterUrl, job.directory, signal) } catch (error) { item.warnings.push('封面待补全：' + safeDownloadError(error)) }
        }
        if (!filePresent(item.posterPath || '') && item.posterUrl && deps.savePoster) {
          try { item.posterPath = await deps.savePoster(item.posterUrl, job.directory, signal) } catch (error) { item.warnings.push('单集封面待补全：' + safeDownloadError(error)) }
        }
        if (!filePresent(item.thumbnailPath || '') && item.thumbnailUrl && deps.savePoster) {
          try { item.thumbnailPath = item.thumbnailUrl === item.posterUrl ? item.posterPath : await deps.savePoster(item.thumbnailUrl, job.directory, signal) }
          catch (error) { item.warnings.push('预览图待补全：' + safeDownloadError(error)) }
        }
        if (deps.artworkSize) {
          const images = [[item.posterPath,item.posterUrl],[item.thumbnailPath,item.thumbnailUrl]].flatMap(([file,url]) => {
            try { return file && filePresent(file) ? [{ path: file, url: url || '', ...deps.artworkSize!(file) }] : [] } catch { return [] }
          })
          const selected = selectVideoArtwork(images,item.posterUrl,item.thumbnailUrl)
          if (selected.poster && selected.thumbnail) {
            const previousPoster = item.posterPath
            item.posterPath = selected.poster.path; item.posterUrl = selected.poster.url
            item.thumbnailPath = selected.thumbnail.path; item.thumbnailUrl = selected.thumbnail.url
            if (job.posterPath === previousPoster && !getVideo(deps.db,job.resourceId)?.user_edited.includes('poster_path')) { job.posterPath = item.posterPath; job.posterUrl = item.posterUrl }
            if (!selected.hasPortrait && !item.warnings.some(w => w.includes('独立竖图'))) item.warnings.push('来源暂无独立竖图，封面暂用预览图')
          }
        }
        const previousFiles = job.resourceId ? listEpisodes(deps.db, job.resourceId).flatMap(episode => {
          const sources = deps.db.prepare('SELECT provider, external_id AS externalId, scope, page_url AS pageUrl, evidence FROM video_sources WHERE episode_id = ?').all(episode.id) as VideoSourceRef[]
          return listVideoAssets(deps.db, job.resourceId, episode.id).filter(asset => {
            const relative = path.relative(job.directory, asset.path)
            return asset.role === 'video' && filePresent(asset.path) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
          }).map(asset => ({ id: episode.id, path: asset.path, title: episode.title, order: episode.episode, season: episode.season, number: episode.episode, quality: asset.quality, size: asset.file_size,
            publishedAt: episode.published_at, airDate: episode.air_date, durationSec: episode.duration_sec, studio: episode.studio,
            sources, tags: episode.tags, thumbnailPath: episode.thumbnail_path, thumbnailSource: episode.thumbnail_source, posterSource: episode.poster_source, originalTitle: episode.original_title, description: episode.description, originalDescription: episode.original_description, posterPath: episode.poster_path, sourceUrl: episode.source_url, notes: episode.notes,
            watch: { status: episode.watch_status, position: episode.position_sec, watchedAt: episode.watched_at } }))
        }) : []
        const missingContents = (job.episodeMetadata ? job.catalogue || [] : []).filter(ep => ep.numbered && ep.videoCode !== item.videoCode
          && !previousFiles.some(file => file.sources.some(source => source.externalId === ep.videoCode)))
          .map(ep => ({ id: 'hanime:episode:' + ep.videoCode, title: ep.title, label: '', order: ep.order, season: 0, number: ep.order, sources: [sourceRef(ep.videoCode)], files: [] }))
        const wrote = writeBundleFiles({ directory: job.directory, bundleId: job.bundleId, title: job.title, description: job.description, descriptionOptional: job.episodeMetadata, category: job.category,
          contents: missingContents, replaceWorkTitle: true,
          sources: job.sources, poster: filePresent(job.posterPath) ? { path: job.posterPath, source: job.posterUrl } : undefined,
          thumbnail: filePresent(item.thumbnailPath || '') ? { path: item.thumbnailPath!, source: item.thumbnailUrl } : undefined,
          files: [...previousFiles, { path: item.path, title: item.title, order: item.order, number: item.order, quality: item.sourceLabel, sourceId: item.videoCode, size: item.receivedBytes,
            ...sourceEpisodeFacts(item), tags: item.tags, thumbnailPath: item.thumbnailPath, thumbnailSource: item.thumbnailUrl, posterSource: item.posterUrl, originalTitle: item.originalTitle, description: item.description, posterPath: item.posterPath, sourceUrl: watchUrl(item.videoCode) }] })
        job.bundleId = wrote.bundle.bundle_id
        item.missing = wrote.bundle.missing
        if (wrote.bundle.work.poster) job.posterPath = path.join(job.directory, wrote.bundle.work.poster)
        item.warnings.push(...wrote.warnings)
        item.metadata = wrote.bundle.missing.length || wrote.warnings.some(w => /保存失败/.test(w)) ? 'failed' : 'complete'
        if (wrote.bundle.missing.includes('poster')) item.warnings.push('封面待补全；视频与清单已保存')
        if (wrote.bundle.missing.includes('description')) item.warnings.push('简介待补全；视频与清单已保存')
      } catch (error) { item.metadata = 'failed'; item.warnings.push('资料待重试：' + safeDownloadError(error)) }
      changed(job)
    }
    if (!job.register) { item.registration = 'skipped'; return }
    if (job.retryStage === 'metadata' && item.registration === 'complete') {
      const linked = deps.db.prepare("SELECT DISTINCT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").all(job.resourceId, item.videoCode) as Array<{ episode_id: string }>
      for (const row of linked) fillEpisodeDetails(deps.db, row.episode_id, { ...sourceEpisodeFacts(item), tags: item.tags, thumbnailPath: item.thumbnailPath, thumbnailSource: item.thumbnailUrl, posterSource: item.posterUrl, originalTitle: item.originalTitle, description: item.description, posterPath: item.posterPath, sourceUrl: watchUrl(item.videoCode) })
      if (job.posterPath) deps.db.prepare("UPDATE video_meta SET poster_path = ?, poster_source = ? WHERE resource_id = ? AND poster_path = ''").run(job.posterPath, job.posterUrl, job.resourceId)
      deps.db.prepare('UPDATE video_directories SET metadata_state = ?, missing = ? WHERE resource_id = ?').run(item.metadata === 'complete' ? 'complete' : 'pending', JSON.stringify(item.metadata === 'complete' ? [] : item.missing || []), job.resourceId)
      try { deps.onLibraryChange?.(job.resourceId) } catch { /* The writes are complete. */ }
      return
    }
    if (item.registration !== 'complete') {
      item.registration = 'running'; changed(job)
      try {
        deps.beforeRegister?.()
        for (const released of releasePlaceholderClaims(deps.db, item.videoCode, job.resourceId)) { try { deps.onLibraryChange?.(released) } catch { /* 让出占位的作品刷新失败不影响登记 */ } }
        const registered = registerVideoContent(deps.db, { restoreRemoved: true, resourceId: job.resourceId || undefined, bundleId: job.bundleId, directory: job.directory, root: job.root,
          title: job.title, description: job.description, category: job.category, posterPath: job.posterPath, posterSource: job.posterUrl, thumbnailPath: item.thumbnailPath, thumbnailSource: item.thumbnailUrl, sources: job.sources,
          metadataState: item.metadata === 'complete' ? 'complete' : 'pending', missing: item.metadata === 'complete' ? [] : item.missing || [],
          items: [{ ...sourceEpisodeFacts(item), title: item.title, order: item.order, number: item.order, tags: item.tags, thumbnailPath: item.thumbnailPath, thumbnailSource: item.thumbnailUrl, posterSource: item.posterUrl, originalTitle: item.originalTitle, description: item.description, posterPath: item.posterPath, sourceUrl: watchUrl(item.videoCode),
            sources: [sourceRef(item.videoCode)], files: [{ path: item.path, quality: item.sourceLabel, size: item.receivedBytes }] }] })
        job.resourceId = registered.resourceId; job.bundleId = registered.bundleId; item.registration = 'complete'
        if (job.episodeMetadata && job.catalogue?.length) {
          const currentEpisode = { publishedAt: item.publishedAt, releaseDate: item.releaseDate, durationSec: item.durationSec, artist: item.artist, videoCode: item.videoCode, title: item.title, originalTitle: item.originalTitle, description: item.description, posterUrl: item.posterUrl }
          applyVideoCatalogue(deps.db, job.resourceId, { videoCode: item.videoCode, title: job.title, description: job.description,
            posterUrl: job.posterUrl, tags: [], warnings: [], currentEpisode, episodes: job.catalogue })
          try { item.warnings.push(...persistVideoWorkBundle(deps.db, job.resourceId, job.directory).warnings) }
          catch (error) { item.metadata = 'failed'; item.warnings.push('资料待保存：' + safeDownloadError(error)) }
        }
        try { deps.onLibraryChange?.(job.resourceId) } catch { /* Registration is already committed. */ }
      } catch (error) { item.registration = 'failed'; item.error = '入库待重试：' + safeDownloadError(error) }
      changed(job)
    }
  }

  async function processJob(job: VideoDownloadJob): Promise<void> {
    const controller = new AbortController(); const signal = controller.signal
    active = { id: job.id, controller }; job.status = 'running'; job.message = '准备作品目录'; changed(job)
    try {
      const same = (a: string, b: string) => path.resolve(a).normalize('NFC').toLowerCase() === path.resolve(b).normalize('NFC').toLowerCase()
      let binding = job.resourceId ? deps.db.prepare('SELECT directory_path FROM video_directories WHERE resource_id = ?').get(job.resourceId) as { directory_path: string } | undefined : undefined
      const recoveringRename = binding && job.directoryChange && !job.directoryChange.applied && same(binding.directory_path, job.directoryChange.from)
      if (binding && !fs.existsSync(binding.directory_path) && !recoveringRename) {
        syncVideoWorkFiles(deps.db, job.resourceId, { roots: deps.libraryRoots?.() || [], persist: false })
        binding = deps.db.prepare('SELECT directory_path FROM video_directories WHERE resource_id = ?').get(job.resourceId) as { directory_path: string } | undefined
      }
      if (job.directoryChange && job.resourceId) {
        if (binding && !same(binding.directory_path, job.directoryChange.from) && !same(binding.directory_path, job.directoryChange.to)) delete job.directoryChange
        else promoteDownloadDirectory(deps.db, job.resourceId, job.directoryChange, () => changed(job))
      }
      const ownership = resolveVideoOwnership(deps.db, { title: job.title, sources: job.sources })
      if (ownership.state === 'conflict') throw new Error('来源对应多个作品，请先确认归属')
      if (ownership.resourceId) job.resourceId = ownership.resourceId
      if (ownership.directory) {
        const target = ownership.directory
        if (job.directory) Object.assign(job, rebaseVideoJobDirectory(job, job.directory, target.path, target.root))
        if (job.directoryChange?.applied) Object.assign(job, rebaseVideoJobDirectory(job, job.directoryChange.from, target.path, target.root))
        job.directory = target.path; job.root = target.root; job.bundleId = target.bundleId
      }
      if (job.resourceId) {
        const work = getVideo(deps.db, job.resourceId)
        const sameSeries = !!work && (canPromoteWorkTitle(deps.db, work.id, job.catalogue || job.sources.map(source => ({ videoCode: source.externalId, title: '' })), job.title)
          || (!work.user_edited.includes('name_zh') && (numberedEpisode(work.name_zh)?.title === job.title || videoCollectionTitle(work.name_zh, job.catalogue || []) === job.title)))
        if (work && sameSeries && work.name_zh !== job.title) {
          deps.db.prepare('UPDATE resource SET name_zh = ?, updated_at = ? WHERE id = ?').run(job.title, Date.now(), work.id)
          if (job.episodeMetadata) {
            moveWorkDescriptionToEpisode(deps.db, work.id)
            for (const field of ['name_en', 'summary', 'description']) if (!work.user_edited.includes(field)) deps.db.prepare(`UPDATE resource SET ${field} = '' WHERE id = ?`).run(work.id)
            if (!work.user_edited.includes('original_description')) deps.db.prepare("UPDATE video_meta SET original_description = '' WHERE resource_id = ?").run(work.id)
          }
        }
        job.title = getVideo(deps.db, job.resourceId)?.name_zh || job.title
      }
      if (!job.directory) {
        const reserved = reserveWorkDirectory(job.root, job.title, job.sources.map(s => s.externalId).sort().join(','))
        job.directory = reserved.directory; job.bundleId = reserved.bundleId
        if (reserved.warning) job.warnings.push(reserved.warning)
      } else {
        if (!fs.existsSync(job.directory)) throw new Error('作品目录无法访问，可能磁盘离线；请重新连接或重新定位')
        const manifest = readVideoBundle(job.directory)
        job.bundleId ||= manifest?.bundle_id || ''
      }
      fs.accessSync(job.directory, fs.constants.W_OK); changed(job)
      if (job.retryStage === 'metadata') {
        try {
          const refreshed = await deps.resolveWork(job.videoCode, { signal })
          if (refreshed.videoCode !== job.videoCode) throw new Error('资料来源编号不一致')
          if (!job.episodeMetadata) job.description ||= refreshed.description
          job.posterUrl = refreshed.posterUrl || job.posterUrl
        } catch (error) { job.warnings.push('资料刷新失败：' + safeDownloadError(error)) }
      }
      for (const item of job.items) {
        if ((job.retryStage === 'metadata' || job.retryStage === 'registration') && item.transfer !== 'complete') continue
        signal.throwIfAborted()
        item.error = ''; item.warnings = []
        try {
          if (item.transfer !== 'complete') {
            item.transfer = 'running'; job.message = '正在解析 ' + item.title; changed(job)
            const info = await deps.resolveSources(item.videoCode, { signal })
            signal.throwIfAborted()
            if (info.videoCode !== item.videoCode) throw new Error('下载来源编号不一致')
            item.originalTitle = info.originalTitle || info.title || item.title
            item.description ||= info.description
            item.posterUrl ||= info.posterUrl; item.tags ||= info.tags; item.thumbnailUrl ||= info.thumbnailUrl
            item.publishedAt ||= info.publishedAt; item.releaseDate ||= info.releaseDate; item.durationSec ||= info.durationSec; item.artist ||= info.artist
            const exact = info.candidates.find(c => c.label === job.sourceLabel)
            if (job.sourceLabel && !exact && job.strictQuality) { item.transfer = 'skipped'; item.registration = 'skipped'; item.metadata = 'skipped'; item.error = '没有目标画质 ' + job.sourceLabel + '，已跳过'; changed(job); continue }
            const candidate = exact || info.candidates[0]
            if (!candidate) throw new Error('没有可用的完整视频下载源')
            if (job.sourceLabel && !exact) item.warnings.push('没有 ' + job.sourceLabel + '，使用 ' + candidate.label)
            item.sourceLabel = candidate.label
            item.path = path.join(job.directory, episodeFilename(item.originalTitle, item.order, candidate.label, candidate.extension))
            if (process.platform === 'win32' && item.path.length > 245) throw new Error('目标路径过长，请使用更短的库目录或作品名称')
            const known = job.resourceId ? local(job.resourceId, item.videoCode).find(a => a.quality === candidate.label && filePresent(a.path)) : undefined
            if (known) item.path = known.path
            // Only a manifest or the library proves that a colliding file belongs to this content.
            const manifest = readVideoBundle(job.directory)
            const recorded = manifest?.items.some(e => e.sources.some(s => s.provider === 'hanime' && s.externalId === item.videoCode) && e.files.some(f => path.resolve(job.directory, f.path).toLowerCase() === item.path.toLowerCase()))
            if (filePresent(item.path) && (known || recorded)) { item.receivedBytes = fs.statSync(item.path).size; item.totalBytes = item.receivedBytes }
            else {
              let lastPersist = 0
              job.message = '正在下载 ' + item.title; changed(job)
              const saved = await deps.transfer({ url: candidate.url, referer: watchUrl(item.videoCode), destination: item.path, signal, onProgress: progress => {
                item.receivedBytes = progress.receivedBytes; item.totalBytes = progress.totalBytes
                if (Date.now() - lastPersist > 500) { lastPersist = Date.now(); changed(job) }
              } })
              item.path = saved.destination; item.receivedBytes = saved.receivedBytes; item.totalBytes = saved.totalBytes; item.warnings.push(...saved.warnings)
            }
            item.transfer = 'complete'; changed(job)
          }
          // A cancellation after file publication must preserve and register the finished file.
          await finishFile(job, item, signal)
        } catch (error) {
          if (item.transfer !== 'complete') item.transfer = 'failed'
          item.error = error instanceof DestinationExistsError ? '同名文件已存在且归属未确认，未覆盖；请改名后重试' : safeDownloadError(error)
          changed(job)
          if (signal.aborted) throw error
        }
      }
      const saved = job.items.filter(i => i.transfer === 'complete').length
      const pending = job.items.some(i => i.transfer === 'failed' || i.metadata === 'failed' || i.registration === 'failed')
      job.status = pending ? (saved ? 'partial' : 'failed') : 'success'
      job.message = `${saved}/${job.items.length} 个视频已保存` + (job.register ? `，${job.items.filter(i => i.registration === 'complete').length} 个已入库` : '，仅保存文件') + (pending ? '；部分项目待处理' : '')
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed'; job.message = safeDownloadError(error)
    } finally { active = null; delete job.retryStage; changed(job) }
  }

  function schedule(): void {
    if (pumping) return
    pumping = Promise.resolve().then(async () => {
      while (queue.length) { const job = jobs.get(queue.shift()!); if (job?.status === 'queued') await processJob(job) }
    }).finally(() => { pumping = null; if (queue.length) schedule() })
  }
  function retry(id: string, stage: VideoJobRetry): VideoDownloadJob {
    refreshIdleJobs()
    const job = jobs.get(id)
    if (!job || job.status === 'running' || job.status === 'queued') throw new Error('该任务不存在或仍在处理')
    if (!['remaining', 'metadata', 'registration'].includes(stage)) throw new Error('重试阶段无效')
    job.retryStage = stage
    for (const item of job.items) {
      if (stage === 'remaining' && item.transfer !== 'complete') { item.transfer = 'pending'; item.metadata = 'pending'; item.registration = 'pending' }
      if (stage === 'metadata' && item.transfer === 'complete') item.metadata = 'pending'
      if (stage === 'registration' && item.transfer === 'complete' && item.registration !== 'complete') item.registration = 'pending'
    }
    job.status = 'queued'; job.message = stage === 'remaining' ? '已排队重试剩余项' : stage === 'metadata' ? '已排队补资料，无需重新下载视频' : '已排队重试入库，无需重新下载视频'
    changed(job); queue.push(id); schedule(); return structuredClone(job)
  }
  function cancel(id: string): boolean {
    const job = jobs.get(id)
    if (!job) return false
    if (active?.id === id) { active.controller.abort(new Error('下载已取消，已保存内容保留')); return true }
    if (job.status === 'queued') { job.status = 'cancelled'; job.message = '已取消排队'; changed(job); return true }
    return false
  }
  function clearHistory(): void {
    if (active || [...jobs.values()].some(job => job.status === 'running' || job.status === 'queued')) throw new Error('请先结束下载任务')
    queue.length = 0
    drafts.clear()
    jobs.clear()
  }
  /** 把一条已经结束的下载记录从列表里拿掉。文件、作品、日志都不动——只是用户看过了、不想再被角标数着（实测第四轮）。 */
  function dismiss(id: string): boolean {
    refreshIdleJobs()
    const job = jobs.get(id)
    if (!job || job.status === 'running' || job.status === 'queued') return false
    jobs.delete(id); store.remove(id)
    return true
  }
  return { prepare, setRoot, enqueue, retry, cancel, dismiss, clearHistory, list: () => { refreshIdleJobs(); return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(j => structuredClone(j)) },
    idle: async () => { while (pumping) await pumping } }
}
