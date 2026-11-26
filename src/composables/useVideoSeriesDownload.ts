
import { tr } from "../i18n/index.ts"
import { computed, reactive, toRefs } from 'vue'
import type {
  VideoSeriesCatalog,
  VideoSeriesDownloadProgress,
  VideoSeriesDownloadResult,
  VideoSeriesEpisodeResult
} from '@/types'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { errorMessage, formatBytes } from '@/utils'

interface SeriesDownloadState {
  resourceId: string
  catalog: VideoSeriesCatalog | null
  sourceLabel: string
  selectedVideoCodes: string[]
  queuedVideoCodes: string[]
  episodeResults: VideoSeriesEpisodeResult[]
  resolving: boolean
  downloading: boolean
  cancelling: boolean
  requestId: string
  progress: VideoSeriesDownloadProgress
  result: VideoSeriesDownloadResult | null
  error: string
}

const states = new Map<string, SeriesDownloadState>()
let nextRequestId = 1

function stateFor(resourceId: string): SeriesDownloadState {
  let state = states.get(resourceId)
  if (!state) {
    state = reactive({
      resourceId,
      catalog: null,
      sourceLabel: '',
      selectedVideoCodes: [],
      queuedVideoCodes: [],
      episodeResults: [],
      resolving: false,
      downloading: false,
      cancelling: false,
      requestId: '',
      progress: {
        requestId: '', resourceId, phase: 'choosing', episodeIndex: 0,
        episodeTotal: 0, videoCode: '', title: '', receivedBytes: 0,
        totalBytes: 0, bytesPerSecond: 0, message: ''
      },
      result: null,
      error: ''
    }) as SeriesDownloadState
    states.set(resourceId, state)
  }
  return state
}

/**
 * Series download state is process-wide so navigating away from the detail
 * page does not detach the native directory dialog or an active transfer.
 */
export function useVideoSeriesDownload(resourceId: string) {
  const state = stateFor(resourceId)
  const taskCenter = useTaskCenter()

  async function resolve(): Promise<VideoSeriesCatalog | null> {
    if (state.resolving || state.downloading) return state.catalog
    state.resolving = true
    state.error = ''
    state.catalog = null
    state.selectedVideoCodes = []
    const taskId = taskCenter.start('video-series-download', tr("解析系列播放清单"), { current: resourceId })
    try {
      const catalog = await window.baoyi.video.downloadSeries(resourceId)
      state.catalog = catalog
      state.selectedVideoCodes = catalog.episodes.map(episode => episode.videoCode)
      taskCenter.update(taskId, { processed: catalog.episodes.length, total: catalog.episodes.length, current: catalog.title, message: tr("已找到 {p0} 集", {p0: (catalog.episodes.length)}) })
      catalog.warnings.forEach(warning => taskCenter.log(taskId, 'warn', warning))
      taskCenter.finish(taskId, 'success', tr("已找到 {p0} 集", {p0: (catalog.episodes.length)}))
      return catalog
    } catch (error) {
      state.error = errorMessage(error)
      taskCenter.finish(taskId, 'failed', tr("解析系列失败"), state.error)
      return null
    } finally {
      state.resolving = false
    }
  }

  async function download(sourceLabel = state.sourceLabel): Promise<VideoSeriesDownloadResult | null> {
    if (state.downloading || state.resolving || !state.catalog) return null
    if (sourceLabel.length > 40) {
      state.error = tr("清晰度选项无效")
      return null
    }
    const videoCodes = [...state.selectedVideoCodes]
    if (!videoCodes.length || new Set(videoCodes).size !== videoCodes.length ||
      videoCodes.some(code => !state.catalog!.episodes.some(episode => episode.videoCode === code))) {
      state.error = tr("请从播放清单中选择要下载的集数")
      return null
    }
    const requestId = `series-download-${nextRequestId++}`
    const taskId = taskCenter.start('video-series-download', tr("下载系列：{p0}", {p0: (state.catalog.title)}), {
      current: state.catalog.title, total: videoCodes.length, message: tr("准备选择保存目录")
    })
    state.sourceLabel = sourceLabel
    state.requestId = requestId
    state.result = null
    state.queuedVideoCodes = videoCodes
    state.episodeResults = []
    state.error = ''
    state.downloading = true
    state.cancelling = false
    state.progress = {
      requestId, resourceId, phase: 'choosing', episodeIndex: 0,
      episodeTotal: videoCodes.length, videoCode: state.catalog.videoCode,
      title: state.catalog.title, receivedBytes: 0, totalBytes: 0,
      bytesPerSecond: 0, message: tr("请选择系列保存目录")
    }
    let unsubscribe: (() => void) | undefined
    let milestone = ''
    const logged = new Set<string>()
    const logEpisode = (episode: VideoSeriesEpisodeResult) => {
      if (logged.has(episode.videoCode)) return
      logged.add(episode.videoCode)
      state.episodeResults.push(episode)
      const level = episode.status === 'failed' ? 'error' : episode.status === 'success' ? 'success' : 'warn'
      taskCenter.log(taskId, level, `${episode.videoCode} ${episode.title}：${episode.message}${episode.path ? ` → ${episode.path}` : ''}`)
      episode.warnings.forEach(warning => taskCenter.log(taskId, 'warn', warning))
    }
    try {
      // Subscribe before invoke: choosing a directory can return and emit immediately.
      unsubscribe = window.baoyi.video.onDownloadProgress(progress => {
        if (!('episodeIndex' in progress)) return
        if (progress.requestId !== requestId || progress.resourceId !== resourceId) return
        state.progress = progress
        const completed = progress.phase === 'done'
          ? progress.episodeTotal
          : progress.phase === 'episode-done' && progress.episodeResult?.status !== 'cancelled'
            ? progress.episodeIndex
          : Math.max(0, progress.episodeIndex - 1)
        const current = progress.episodeIndex > 0
          ? `${progress.episodeIndex}/${progress.episodeTotal} · ${progress.title} [${progress.videoCode}]`
          : state.catalog?.title ?? resourceId
        const transferring = progress.phase === 'downloading' || progress.phase === 'finalizing'
        const message = transferring
          ? tr('{p0} · {p1} / {p2} · {p3}/秒', {p0: progress.message, p1: formatBytes(progress.receivedBytes), p2: progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : tr('大小未知'), p3: formatBytes(progress.bytesPerSecond)})
          : progress.message
        const nextMilestone = `${progress.episodeIndex}:${progress.phase}:${progress.totalBytes > 0 ? Math.floor(progress.receivedBytes * 10 / progress.totalBytes) : 0}`
        taskCenter.update(taskId, {
          processed: completed,
          total: progress.episodeTotal,
          current,
          message
        }, nextMilestone !== milestone ? { message: `${current}：${message}` } : undefined)
        milestone = nextMilestone
        if (progress.episodeResult) logEpisode(progress.episodeResult)
      })
      const result = await window.baoyi.video.downloadSeriesRun({ requestId, resourceId, sourceLabel, videoCodes })
      result.results.forEach(logEpisode)
      state.episodeResults = result.results
      state.result = result
      state.error = result.status === 'failed' ? result.message : ''
      state.progress = { ...state.progress, episodeTotal: result.total, message: result.message }
      const summary = tr("{p0}；完成 {p1}，失败 {p2}，跳过 {p3}，未完成 {p4}", {p0: (result.message), p1: (result.completed), p2: (result.failed), p3: (result.skipped), p4: (Math.max(0, result.total - result.completed - result.failed - result.skipped))})
      taskCenter.update(taskId, { processed: result.completed + result.failed + result.skipped, total: result.total, message: summary })
      result.warnings.forEach(warning => taskCenter.log(taskId, 'warn', warning))
      if (result.path) taskCenter.log(taskId, 'info', tr("保存目录：{p0}", {p0: (result.path)}))
      if (result.status === 'success') {
        taskCenter.finish(taskId, 'success', summary)
      } else if (result.status === 'cancelled') {
        taskCenter.finish(taskId, 'cancelled', summary)
      } else {
        taskCenter.finish(taskId, 'failed', summary, result.message)
      }
      return result
    } catch (error) {
      state.error = errorMessage(error)
      taskCenter.finish(taskId, 'failed', tr("系列下载失败"), state.error)
      return null
    } finally {
      unsubscribe?.()
      state.downloading = false
      state.cancelling = false
    }
  }

  async function cancel(): Promise<{ ok: boolean; message?: string }> {
    if (!state.downloading || !state.requestId || state.cancelling) return { ok: false, message: tr("当前没有可取消的系列下载") }
    const requestId = state.requestId
    state.cancelling = true
    try {
      const result = await window.baoyi.video.cancelDownload(requestId)
      if (state.requestId === requestId && state.downloading && !result.ok) {
        state.cancelling = false
        state.error = result.message || tr("取消下载失败")
      }
      return result
    } catch (error) {
      const message = errorMessage(error)
      if (state.requestId === requestId && state.downloading) {
        state.cancelling = false
        state.error = message
      }
      return { ok: false, message }
    }
  }

  async function retryFailed(): Promise<VideoSeriesDownloadResult | null> {
    if (state.downloading || state.resolving) return null
    const failed = state.result?.results.filter(episode => episode.status === 'failed').map(episode => episode.videoCode) ?? []
    if (!failed.length) return null
    const catalog = await resolve()
    if (!catalog) return null
    if (failed.some(code => !catalog.episodes.some(episode => episode.videoCode === code))) {
      state.error = tr("部分失败集数已不在播放清单中，请重新选择")
      return null
    }
    state.selectedVideoCodes = failed
    return download()
  }

  async function reveal(): Promise<boolean> {
    if (!state.result?.path) return false
    try {
      const ok = await window.baoyi.video.revealDownload(state.result.requestId)
      if (!ok) state.error = tr("无法打开保存目录，请确认目录仍然存在")
      return ok
    }
    catch (error) { state.error = errorMessage(error); return false }
  }

  return {
    ...toRefs(state),
    running: computed(() => state.resolving || state.downloading),
    busy: computed(() => state.resolving || state.downloading),
    processedCount: computed(() => state.result
      ? state.result.completed + state.result.failed + state.result.skipped
      : state.progress.phase === 'done' ? state.progress.episodeTotal
        : state.progress.phase === 'episode-done' && state.progress.episodeResult?.status !== 'cancelled'
          ? state.progress.episodeIndex : Math.max(0, state.progress.episodeIndex - 1)),
    resolve,
    download,
    cancel,
    reveal,
    retryFailed
  }
}
