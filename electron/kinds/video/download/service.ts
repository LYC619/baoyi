import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  VideoDownloadCatalog,
  VideoDownloadProgress,
  VideoDownloadRequest,
  VideoDownloadResult,
  VideoSeriesCatalog,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadRequest,
  VideoSeriesDownloadResult,
  VideoSeriesEpisodeResult
} from '../../../../src/types/video-download.ts'
import { watchUrl } from '../hentai/selectors.ts'
import { ensureWorkDirectory } from '../bundle.ts'
import { sourceEpisodeFacts } from '../episode-details.ts'
import { isVideoExtension, type SourceCandidate, type VideoSeries, type VideoSources } from './sources.ts'
import { DestinationExistsError, safeDownloadError, type TransferOptions, type TransferResult } from './transfer.ts'

interface Dependencies {
  getItem: (resourceId: string) => { id: string; hanime_id: string; name_zh?: string } | null | Promise<{ id: string; hanime_id: string; name_zh?: string } | null>
  resolveSources: (videoCode: string, options?: { signal?: AbortSignal }) => Promise<VideoSources>
  resolveSeries?: (videoCode: string, options?: { signal?: AbortSignal }) => Promise<VideoSeries>
  downloadsDirectory: () => string
  chooseFile: (options: { defaultPath: string; extension: string }) => Promise<string | null>
  chooseDirectory?: () => Promise<string | null>
  transfer: (options: Omit<TransferOptions, 'fetch'>) => Promise<TransferResult>
  log: (message: string) => void
  now?: () => number
  /** Registers a published file and updates its work without retransferring it. */
  registerDownloaded?: (input: { facts?: ReturnType<typeof sourceEpisodeFacts>; resourceId: string; directory: string; workTitle: string; episodeTitle: string; videoCode: string; episode?: number; path: string; label: string }) => Promise<{ warnings?: string[] } | void> | { warnings?: string[] } | void
}
interface SourceToken { facts?: ReturnType<typeof sourceEpisodeFacts>; resourceId: string; videoCode: string; title: string; candidate: SourceCandidate; expires: number }
const TOKEN_TTL = 10 * 60_000
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value) }
function filePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
}
export function downloadFilename(title: string, videoCode: string, label: string, extension: string): string {
  if (!/^\d{1,20}$/.test(videoCode) || !isVideoExtension(extension)) throw new Error('下载文件编号或扩展名无效')
  let name = filePart(title).slice(0, 110).replace(/[. ]+$/g, '') || '单集视频'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
  return name + ' [' + videoCode + '] ' + (filePart(label).slice(0, 20) || '原始画质') + '.' + extension.toLowerCase()
}
function chosenDestination(raw: string, extension: string): string {
  if (!path.isAbsolute(raw)) throw new Error('下载保存位置必须是绝对路径')
  const filename = path.basename(raw)
  if (!filename || /[<>:"/\\|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    throw new Error('保存文件名无效，请另选文件名')
  }
  const ext = path.extname(filename).slice(1).toLowerCase()
  if (ext && ext !== extension.toLowerCase()) throw new Error('请保留视频扩展名 .' + extension + '，不会将视频保存为其他类型')
  return path.resolve(ext ? raw : raw + '.' + extension)
}

/** Path authorization and single-transfer lock live here, not in the renderer. */
export function createVideoDownloadService(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const tokens = new Map<string, SourceToken>()
  const completed = new Map<string, string>()
  const completedDirectories = new Set<string>()
  const seriesCatalogs = new Map<string, { catalog: VideoSeriesCatalog; expires: number }>()
  let active: { requestId: string; controller: AbortController } | null = null
  let lastDirectory = ''
  const log = (message: string) => { try { deps.log('[视频下载] ' + safeDownloadError(message)) } catch { /* Logging is not a file operation. */ } }
  const prune = () => {
    for (const [key, value] of tokens) if (value.expires <= now()) tokens.delete(key)
    while (tokens.size > 200) tokens.delete(tokens.keys().next().value!)
    for (const [key, value] of seriesCatalogs) if (value.expires <= now()) seriesCatalogs.delete(key)
  }
  const rememberCompleted = (requestId: string, destination: string, directory = false) => {
    completed.set(requestId, destination)
    if (directory) completedDirectories.add(requestId)
    else completedDirectories.delete(requestId)
    while (completed.size > 100) {
      const oldest = completed.keys().next().value!
      completed.delete(oldest)
      completedDirectories.delete(oldest)
    }
  }
  async function sources(resourceId: string): Promise<VideoDownloadCatalog> {
    try {
      if (!identifier(resourceId)) throw new Error('资源编号无效')
      const item = await deps.getItem(resourceId)
      if (!item || item.id !== resourceId || !/^\d{1,20}$/.test(item.hanime_id)) throw new Error('资源没有有效的站点单集编号，请先识别')
      log(resourceId + '：开始解析单集 ' + item.hanime_id)
      const info = await deps.resolveSources(item.hanime_id)
      if (info.videoCode !== item.hanime_id) throw new Error('站点单集编号不一致，请重新解析')
      if (!info.candidates.length) throw new Error('没有可下载的完整视频直链')
      prune()
      const catalog: VideoDownloadCatalog = {
        resourceId, videoCode: info.videoCode, title: info.title, pageUrl: watchUrl(info.videoCode), warnings: info.warnings.map(safeDownloadError),
        sources: info.candidates.slice(0, 20).map(candidate => {
          if (!isVideoExtension(candidate.extension)) throw new Error('下载源不是受支持的视频类型')
          const id = randomUUID()
          tokens.set(id, { facts: sourceEpisodeFacts(info), resourceId, videoCode: info.videoCode, title: info.title, candidate, expires: now() + TOKEN_TTL })
          return { id, label: candidate.label, extension: candidate.extension }
        })
      }
      log(resourceId + '：解析完成，' + catalog.sources.length + ' 个直链清晰度')
      return catalog
    } catch (err) { const message = safeDownloadError(err); log('解析失败：' + message); throw new Error(message) }
  }

  async function series(resourceId: string): Promise<VideoSeriesCatalog> {
    try {
      if (!identifier(resourceId)) throw new Error('资源编号无效')
      seriesCatalogs.delete(resourceId)
      if (!deps.resolveSeries) throw new Error('当前下载服务未配置系列播放清单解析')
      const item = await deps.getItem(resourceId)
      if (!item || item.id !== resourceId || !/^\d{1,20}$/.test(item.hanime_id)) throw new Error('资源没有有效的站点系列编号，请先识别')
      log(resourceId + '：开始解析系列播放清单 ' + item.hanime_id)
      const info = await deps.resolveSeries(item.hanime_id)
      if (info.videoCode !== item.hanime_id) throw new Error('系列站点编号不一致，请重新解析')
      const seen = new Set<string>()
      const episodes = info.episodes
        .filter(episode => {
          if (!/^\d{1,20}$/.test(episode.videoCode) || seen.has(episode.videoCode)) return false
          seen.add(episode.videoCode)
          return true
        })
        .map(episode => ({ videoCode: episode.videoCode, title: episode.title || '站点单集 ' + episode.videoCode }))
      if (!episodes.length) throw new Error('这个站点条目没有可下载的系列集数')
      if (episodes.length > 500) throw new Error('系列超过 500 集，请分批选择其他播放清单')
      const catalog: VideoSeriesCatalog = { resourceId, videoCode: info.videoCode, title: info.title || '站点系列 ' + info.videoCode, episodes, warnings: info.warnings.map(safeDownloadError) }
      prune()
      seriesCatalogs.set(resourceId, { catalog, expires: now() + TOKEN_TTL })
      while (seriesCatalogs.size > 100) seriesCatalogs.delete(seriesCatalogs.keys().next().value!)
      log(resourceId + '：系列解析完成，共 ' + episodes.length + ' 集')
      return catalog
    } catch (err) {
      const message = safeDownloadError(err)
      log('系列解析失败：' + message)
      throw new Error(message)
    }
  }

  async function runSeries(
    input: VideoSeriesDownloadRequest,
    onProgress: (progress: VideoSeriesDownloadProgress) => void
  ): Promise<VideoSeriesDownloadResult> {
    const requestId = identifier(input?.requestId) ? input.requestId : ''
    const resourceId = identifier(input?.resourceId) ? input.resourceId : ''
    const empty = (status: VideoSeriesDownloadResult['status'], message: string, overrides: Partial<VideoSeriesDownloadResult> = {}): VideoSeriesDownloadResult => ({
      requestId, resourceId, status, path: '', message, total: 0, completed: 0, failed: 0, skipped: 0, fallback: 0, results: [], warnings: [], ...overrides
    })
    if (!requestId || !resourceId || typeof input?.sourceLabel !== 'string' || input.sourceLabel.length > 40) return empty('failed', '系列下载请求参数无效')
    if (active) return empty('failed', '已有视频下载正在进行，请等待完成或取消后再试')
    if (completed.has(requestId)) return empty('failed', '下载请求编号已使用，请重新发起下载')
    const cached = seriesCatalogs.get(resourceId)
    if (!cached || cached.expires <= now()) return empty('failed', '系列播放清单已过期，请重新解析')
    const videoCodes = input.videoCodes ?? cached.catalog.episodes.map(episode => episode.videoCode)
    if (!Array.isArray(videoCodes) || !videoCodes.length || videoCodes.length > 500 ||
      new Set(videoCodes).size !== videoCodes.length ||
      videoCodes.some(code => !cached.catalog.episodes.some(episode => episode.videoCode === code))) {
      return empty('failed', '所选集数无效，请重新解析并选择播放清单中的集数')
    }
    const episodes = cached.catalog.episodes.filter(episode => videoCodes.includes(episode.videoCode))
    const sourceLabel = input.sourceLabel
    const controller = new AbortController()
    active = { requestId, controller }
    const results: VideoSeriesEpisodeResult[] = []
    const warnings = [...cached.catalog.warnings]
    let directory = ''
    let current = { receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0 }
    let completedCount = 0; let failedCount = 0; let skippedCount = 0; let fallbackCount = 0
    const emit = (phase: VideoSeriesDownloadProgress['phase'], index: number, episode: { videoCode: string; title: string }, message: string, episodeResult?: VideoSeriesEpisodeResult) => {
      try { onProgress({ requestId, resourceId, phase, episodeIndex: index, episodeTotal: episodes.length, videoCode: episode.videoCode, title: episode.title, message, ...current, ...(episodeResult ? { episodeResult } : {}) }) }
      catch { /* A closed renderer cannot damage the queue. */ }
    }
    const record = (index: number, result: VideoSeriesEpisodeResult) => {
      results.push(result)
      warnings.push(...result.warnings)
      log(requestId + '：' + result.videoCode + ' ' + result.title + '：' + result.message + (result.path ? ' → ' + result.path : ''))
      result.warnings.forEach(warning => log(requestId + '：提醒：' + warning))
      emit('episode-done', index, result, result.message, result)
    }
    try {
      const item = await deps.getItem(resourceId)
      if (!item || item.id !== resourceId || item.hanime_id !== cached.catalog.videoCode) throw new Error('资源或站点系列编号已改变，请重新解析')
      controller.signal.throwIfAborted()
      if (!deps.chooseDirectory) throw new Error('当前下载服务未配置目录选择')
      emit('choosing', 0, { videoCode: cached.catalog.videoCode, title: cached.catalog.title }, '请选择系列保存目录；取消不会创建文件')
      const selected = await deps.chooseDirectory()
      controller.signal.throwIfAborted()
      if (!selected) return empty('cancelled', '已取消选择保存目录，未创建文件', { total: episodes.length })
      if (!path.isAbsolute(selected)) throw new Error('系列保存目录必须是绝对路径')
      directory = ensureWorkDirectory(path.resolve(selected), cached.catalog.title)
      for (let i = 0; i < episodes.length; i++) {
        const episode = { ...episodes[i] }
        controller.signal.throwIfAborted()
        current = { receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0 }
        emit('resolving', i + 1, episode, '正在解析第 ' + (i + 1) + ' 集下载地址')
        let selectedLabel = ''
        let destination = ''
        const episodeWarnings: string[] = []
        try {
          const info = await deps.resolveSources(episode.videoCode, { signal: controller.signal })
          controller.signal.throwIfAborted()
          if (info.videoCode !== episode.videoCode) throw new Error('单集编号不一致，请重新解析')
          episode.title = info.title || episode.title
          episodeWarnings.push(...info.warnings.map(safeDownloadError))
          const candidates = info.candidates.filter(candidate => isVideoExtension(candidate.extension))
          if (!candidates.length) throw new Error('没有可下载的完整视频直链')
          const selectedSource = sourceLabel ? candidates.find(candidate => candidate.label === sourceLabel) : undefined
          const candidate = selectedSource ?? candidates[0]
          selectedLabel = candidate.label
          const fallback = !!sourceLabel && !selectedSource
          if (fallback) {
            fallbackCount++
            episodeWarnings.push(episode.videoCode + '：没有 ' + sourceLabel + '，改用 ' + candidate.label)
          }
          const title = cached.catalog.title + ' - ' + episode.title
          destination = path.join(directory, downloadFilename(title, episode.videoCode, candidate.label, candidate.extension))
          emit('downloading', i + 1, episode, '正在下载第 ' + (i + 1) + ' 集')
          const saved = await deps.transfer({
            url: candidate.url, referer: watchUrl(episode.videoCode), destination, signal: controller.signal,
            onProgress: progress => {
              current = { receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes, bytesPerSecond: progress.bytesPerSecond }
              emit(progress.phase, i + 1, episode, progress.phase === 'finalizing' ? '正在安全保存第 ' + (i + 1) + ' 集' : '正在下载第 ' + (i + 1) + ' 集')
            }
          })
          current = { receivedBytes: saved.receivedBytes, totalBytes: saved.totalBytes, bytesPerSecond: saved.bytesPerSecond ?? 0 }
          if (deps.registerDownloaded) {
            try {
              const registered = await deps.registerDownloaded({ facts: sourceEpisodeFacts(info), resourceId, directory, workTitle: cached.catalog.title, episodeTitle: episode.title, videoCode: episode.videoCode, episode: i + 1, path: saved.destination, label: candidate.label })
              episodeWarnings.push(...(registered?.warnings || []).map(safeDownloadError))
            } catch (registrationError) { episodeWarnings.push('入库待重试：' + safeDownloadError(registrationError)) }
          }
          episodeWarnings.push(...saved.warnings.map(safeDownloadError))
          completedCount++
          record(i + 1, { ...episode, status: 'success', path: saved.destination, sourceLabel: candidate.label, message: '下载完成', warnings: episodeWarnings })
        } catch (err) {
          const message = safeDownloadError(err)
          if (controller.signal.aborted) {
            record(i + 1, { ...episode, status: 'cancelled', path: '', sourceLabel: selectedLabel, message, warnings: episodeWarnings })
            throw err
          }
          const skipped = err instanceof DestinationExistsError
          if (skipped) skippedCount++; else failedCount++
          record(i + 1, { ...episode, status: skipped ? 'skipped' : 'failed', path: skipped ? destination : '', sourceLabel: selectedLabel, message: skipped ? '目标文件已存在，未覆盖' : message, warnings: episodeWarnings })
        }
      }
      emit('done', episodes.length, { videoCode: cached.catalog.videoCode, title: cached.catalog.title }, '系列下载处理完成')
      const status: VideoSeriesDownloadResult['status'] = failedCount > 0 ? 'failed' : 'success'
      const message = status === 'success' ? '系列下载完成，已归档并入库' : '系列下载完成，但有 ' + failedCount + ' 集失败'
      log(requestId + '：' + message + '，完成 ' + completedCount + '，跳过 ' + skippedCount)
      return { requestId, resourceId, status, path: directory, message, total: episodes.length, completed: completedCount, failed: failedCount, skipped: skippedCount, fallback: fallbackCount, results, warnings }
    } catch (err) {
      const message = safeDownloadError(err)
      const cancelled = controller.signal.aborted
      log(requestId + '：系列' + (cancelled ? '取消收尾：' : '失败：') + message)
      return { requestId, resourceId, status: cancelled ? 'cancelled' : 'failed', path: directory, message: cancelled ? '系列下载已取消；' + message : message, total: episodes.length, completed: completedCount, failed: failedCount, skipped: skippedCount, fallback: fallbackCount, results, warnings }
    } finally {
      if (directory) rememberCompleted(requestId, directory, true)
      active = null
    }
  }
  async function run(input: VideoDownloadRequest, onProgress: (progress: VideoDownloadProgress) => void): Promise<VideoDownloadResult> {
    const requestId = identifier(input?.requestId) ? input.requestId : ''
    const resourceId = identifier(input?.resourceId) ? input.resourceId : ''
    let progress = { receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0 }
    const result = (status: VideoDownloadResult['status'], message: string, destination = '', warnings: string[] = []): VideoDownloadResult => ({
      requestId, resourceId, status, path: destination, message, ...progress, warnings
    })
    if (!requestId || !resourceId || !identifier(input?.sourceId)) return result('failed', '下载请求参数无效')
    if (active) return result('failed', '已有视频下载正在进行，请等待完成或取消后再试')
    if (completed.has(requestId)) return result('failed', '下载请求编号已使用，请重新发起下载')
    const controller = new AbortController()
    active = { requestId, controller }
    const emit = (phase: VideoDownloadProgress['phase'], message: string) => {
      try { onProgress({ requestId, resourceId, phase, message, ...progress }) } catch { /* A closed page cannot corrupt a download. */ }
    }
    try {
      prune()
      const token = tokens.get(input.sourceId)
      if (!token || token.resourceId !== resourceId) throw new Error('下载源无效或已过期，请重新解析')
      const item = await deps.getItem(resourceId)
      if (!item || item.id !== resourceId || item.hanime_id !== token.videoCode) throw new Error('资源或站点单集编号已改变，请重新解析')
      controller.signal.throwIfAborted()
      emit('choosing', '请选择保存位置；取消选择不会创建文件')
      log(requestId + '：选择保存位置，单集 ' + token.videoCode + ' / ' + token.candidate.label)
      const selected = await deps.chooseFile({
        defaultPath: path.join(lastDirectory || deps.downloadsDirectory(), downloadFilename(token.title, token.videoCode, token.candidate.label, token.candidate.extension)),
        extension: token.candidate.extension
      })
      controller.signal.throwIfAborted()
      if (!selected) { log(requestId + '：已取消保存选择'); return result('cancelled', '已取消选择保存位置，未创建文件') }
      const chosen = chosenDestination(selected, token.candidate.extension)
      const workDirectory = ensureWorkDirectory(path.dirname(chosen), token.title)
      const destination = path.join(workDirectory, path.basename(chosen))
      lastDirectory = workDirectory
      log(requestId + '：开始传输 → ' + destination)
      emit('downloading', '正在连接视频源')
      const saved = await deps.transfer({
        url: token.candidate.url, referer: watchUrl(token.videoCode), destination, signal: controller.signal,
        onProgress: update => {
          progress = { receivedBytes: update.receivedBytes, totalBytes: update.totalBytes, bytesPerSecond: update.bytesPerSecond }
          emit(update.phase, update.phase === 'finalizing' ? '正在校验并安全保存文件' : '正在下载')
        }
      })
      // transfer resolves only AFTER its commit point. Do not check cancellation here.
      progress = { receivedBytes: saved.receivedBytes, totalBytes: saved.totalBytes, bytesPerSecond: saved.bytesPerSecond ?? 0 }
      const registrationWarnings: string[] = []
      if (deps.registerDownloaded) {
        try {
          const registered = await deps.registerDownloaded({ facts: token.facts, resourceId, directory: path.dirname(saved.destination), workTitle: item.name_zh || token.title, episodeTitle: token.title, videoCode: token.videoCode, episode: 1, path: saved.destination, label: token.candidate.label })
          registrationWarnings.push(...(registered?.warnings || []).map(safeDownloadError))
        } catch (registrationError) { registrationWarnings.push('入库待重试：' + safeDownloadError(registrationError)) }
      }
      rememberCompleted(requestId, saved.destination)
      const warnings = [...saved.warnings.map(safeDownloadError), ...registrationWarnings]
      warnings.forEach(warning => log(requestId + '：警告：' + warning))
      log(requestId + '：下载完成，' + saved.receivedBytes + ' 字节 → ' + saved.destination)
      return result('success', warnings.some(warning => warning.startsWith('入库待重试')) ? '单集下载完成，入库待重试' : '单集下载完成，已归档并入库', saved.destination, warnings)
    } catch (err) {
      const message = safeDownloadError(err)
      const cancelled = controller.signal.aborted
      log(requestId + '：' + (cancelled ? '取消收尾：' : '下载失败：') + message)
      return result(cancelled ? 'cancelled' : 'failed', cancelled ? '下载已取消；' + message : message)
    } finally { active = null }
  }
  function cancel(requestId: string): { ok: boolean; message?: string } {
    if (!identifier(requestId) || active?.requestId !== requestId) return { ok: false, message: '该下载已结束或不存在' }
    active.controller.abort(new Error('用户取消下载'))
    log(requestId + '：收到取消请求，等待传输和临时文件清理结束')
    return { ok: true }
  }
  return {
    sources,
    series,
    run,
    runSeries,
    cancel,
    completedPath: (requestId: string): string | null => completed.get(requestId) ?? null,
    completedIsDirectory: (requestId: string): boolean => completedDirectories.has(requestId)
  }
}
