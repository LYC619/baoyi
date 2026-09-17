import { computed, reactive, toRefs } from 'vue'
import type {
  VideoDownloadCatalog,
  VideoDownloadProgress,
  VideoDownloadResult
} from '@/types'
import { useTaskCenter } from '@/composables/useTaskCenter'

interface DownloadState {
  resourceId: string
  catalog: VideoDownloadCatalog | null
  selectedSourceId: string
  resolving: boolean
  downloading: boolean
  cancelling: boolean
  requestId: string
  progress: VideoDownloadProgress
  result: VideoDownloadResult | null
  error: string
  path: string
}

const states = new Map<string, DownloadState>()
let nextRequestId = 1

function stateFor(resourceId: string): DownloadState {
  let state = states.get(resourceId)
  if (!state) {
    state = reactive({
      resourceId,
      catalog: null,
      selectedSourceId: '',
      resolving: false,
      downloading: false,
      cancelling: false,
      requestId: '',
      progress: {
        requestId: '', resourceId, phase: 'choosing', receivedBytes: 0,
        totalBytes: 0, bytesPerSecond: 0, message: ''
      },
      result: null,
      error: '',
      path: ''
    }) as DownloadState
    states.set(resourceId, state)
  }
  return state
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Module-level download state. Detail.vue may unmount while the native save
 * dialog or transfer is active; neither operation is tied to component scope.
 */
export function useVideoDownload(resourceId: string) {
  const state = stateFor(resourceId)
  const taskCenter = useTaskCenter()

  async function resolve(): Promise<VideoDownloadCatalog | null> {
    if (state.resolving || state.downloading) return state.catalog
    state.resolving = true
    state.error = ''
    const taskId = taskCenter.start('video-download', '解析视频下载源', { current: resourceId })
    try {
      const catalog = await window.baoyi.video.downloadSources(resourceId)
      state.catalog = catalog
      state.selectedSourceId = catalog.sources[0]?.id ?? ''
      taskCenter.update(taskId, { processed: 1, total: 1, message: '解析完成' })
      taskCenter.finish(taskId, 'success', `已找到 ${catalog.sources.length} 个清晰度`)
      return catalog
    } catch (error) {
      state.error = errorMessage(error)
      taskCenter.finish(taskId, 'failed', '解析下载源失败', state.error)
      return null
    } finally {
      state.resolving = false
    }
  }

  async function download(sourceId = state.selectedSourceId): Promise<VideoDownloadResult | null> {
    if (state.downloading || state.resolving || !state.catalog || !sourceId) return null
    if (!state.catalog.sources.some(source => source.id === sourceId)) {
      state.error = '清晰度选项已失效，请重新解析'
      return null
    }
    const requestId = `download-${nextRequestId++}`
    const taskId = taskCenter.start('video-download', `下载：${state.catalog.title}`, {
      current: state.catalog.title, message: '准备保存位置'
    })
    state.requestId = requestId
    state.selectedSourceId = sourceId
    state.result = null
    state.path = ''
    state.error = ''
    state.downloading = true
    state.cancelling = false
    state.progress = {
      requestId, resourceId, phase: 'choosing', receivedBytes: 0,
      totalBytes: 0, bytesPerSecond: 0, message: '请选择保存位置'
    }
    let unsubscribe: (() => void) | undefined
    let lastMilestone = -1
    try {
      // Subscribe before invoke: main may emit synchronously after the save dialog returns.
      unsubscribe = window.baoyi.video.onDownloadProgress(progress => {
        if ('episodeIndex' in progress) return
        if (progress.requestId !== requestId || progress.resourceId !== resourceId) return
        state.progress = progress
        const percent = progress.totalBytes > 0 ? Math.floor(progress.receivedBytes * 100 / progress.totalBytes) : -1
        const milestone = percent >= 0 ? Math.floor(percent / 10) : progress.phase === 'finalizing' ? 101 : -1
        if (milestone !== lastMilestone) {
          lastMilestone = milestone
          taskCenter.update(taskId, {
            processed: progress.receivedBytes, total: progress.totalBytes,
            message: progress.message
          }, { message: progress.message })
        } else {
          taskCenter.update(taskId, { processed: progress.receivedBytes, total: progress.totalBytes, message: progress.message })
        }
      })
      const result = await window.baoyi.video.download({ requestId, resourceId, sourceId })
      state.result = result
      state.progress = {
        requestId, resourceId,
        phase: result.status === 'success' ? 'finalizing' : state.progress.phase,
        receivedBytes: result.receivedBytes, totalBytes: result.totalBytes,
        bytesPerSecond: result.bytesPerSecond, message: result.message
      }
      if (result.status === 'success') {
        state.path = result.path
        taskCenter.finish(taskId, 'success', result.message)
      } else if (result.status === 'cancelled') {
        taskCenter.finish(taskId, 'cancelled', result.message)
      } else {
        state.error = result.message
        taskCenter.finish(taskId, 'failed', '视频下载失败', result.message)
      }
      return result
    } catch (error) {
      state.error = errorMessage(error)
      taskCenter.finish(taskId, 'failed', '视频下载失败', state.error)
      return null
    } finally {
      unsubscribe?.()
      state.downloading = false
      state.cancelling = false
    }
  }

  async function cancel(): Promise<{ ok: boolean; message?: string }> {
    if (!state.downloading || !state.requestId || state.cancelling) return { ok: false, message: '当前没有可取消的下载' }
    state.cancelling = true
    try {
      const result = await window.baoyi.video.cancelDownload(state.requestId)
      if (!result.ok) state.cancelling = false
      return result
    } catch (error) {
      state.cancelling = false
      state.error = errorMessage(error)
      return { ok: false, message: state.error }
    }
  }

  async function reveal(): Promise<boolean> {
    if (!state.result || state.result.status !== 'success') return false
    try { return await window.baoyi.video.revealDownload(state.requestId) }
    catch (error) { state.error = errorMessage(error); return false }
  }

  return {
    ...toRefs(state),
    running: computed(() => state.resolving || state.downloading),
    busy: computed(() => state.resolving || state.downloading),
    resolve,
    download,
    cancel,
    reveal
  }
}
