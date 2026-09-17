import { computed, ref } from 'vue'
import { errorMessage, plain, videoTitle } from '@/utils'
import { useTaskCenter } from './useTaskCenter'
import type { GameScanProgress, GameScanResult, VideoItem, VideoScanResult } from '@/types'

type MediaKind = 'game' | 'video'
type Results = { game: GameScanResult; video: VideoScanResult }
function createState() {
  return {
    running: ref(false), stopping: ref(false), progress: ref<GameScanProgress | null>(null),
    result: ref<Results[MediaKind] | null>(null),
    taskId: null as string | null
  }
}
// 同一个 IPC 进度通道只对应一个运行任务。状态不跟路由卸载，返回库页仍可查看和停止。
const states = { game: createState(), video: createState() }
const tasks = useTaskCenter()
const names: Record<MediaKind, string> = { game: '游戏', video: '影视' }

async function execute<T>(kind: MediaKind, title: string, current: string, operation: (id: string) => Promise<T>): Promise<T> {
  const state = states[kind]
  if (state.running.value) throw new Error(names[kind] + '任务正在进行，请等待本轮结束')
  state.running.value = true
  state.stopping.value = false
  state.progress.value = { phase: 'scanning', current, processed: 0, total: 0, registered: 0, failed: 0, log: '' }
  const id = tasks.start(kind + '-scan' as 'game-scan' | 'video-scan', title, { current })
  state.taskId = id
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = window.baoyi[kind].onProgress((p) => {
      // 后端的 done 可能把候选总数当作 processed；停止后不能据此假报全部完成。
      const processed = state.stopping.value && p.phase === 'done' ? (state.progress.value?.processed ?? 0) : p.processed
      state.progress.value = { ...p, processed }
      const message = p.log || (p.phase === 'scanning' ? '正在扫描目录'
        : p.phase === 'done' ? '正在汇总识别结果' : `已处理 ${p.processed}${p.total > 0 ? '/' + p.total : ' 项，总数待确定'}，已注册 ${p.registered} 个`)
      tasks.update(id, {
        processed, total: p.total, current: p.current,
        message: state.stopping.value ? '正在停止，等待当前任务收尾…' : message
      }, { message: p.current ? message + ' · ' + p.current : message })
    })
    return await operation(id)
  } catch (err) {
    tasks.finish(id, 'failed', title + '失败', errorMessage(err))
    throw err
  } finally {
    // 订阅由任务而非页面持有，切页不丢进度，成功/失败后统一释放。
    unsubscribe?.()
    state.taskId = null
    state.running.value = false
  }
}

export function useMediaScan<K extends MediaKind>(kind: K) {
  const state = states[kind]
  async function run(dirs: string[], preflightWarning = ''): Promise<Results[K]> {
    if (!dirs.length) throw new Error('先添加至少一个扫描目录')
    return execute(kind, names[kind] + '目录扫描', dirs.join('；'), async (id) => {
      state.result.value = null
      if (preflightWarning.trim()) tasks.log(id, 'warn', preflightWarning)
      const result = await window.baoyi[kind].scan(plain(dirs)) as Results[K]
      state.result.value = result
      const entries = 'entries' in result ? result.entries ?? [] : []
      if (entries.length) tasks.setScanResults(id, entries)
      const processed = state.stopping.value
        ? Math.min(result.candidates, result.registered + result.skipped + result.failed) : result.candidates
      tasks.update(id, { processed, total: result.candidates })
      const episodes = 'episodes' in result && result.episodes > 0 ? `（${result.episodes} 集）` : ''
      const review = entries.filter(entry => entry.status === 'review').length
      const message = `${result.candidates} 个候选，${result.registered} 个注册${episodes}，${result.skipped} 个跳过，${result.failed} 个失败` + (review ? `，${review} 个待确认` : '')
      if (result.failed > 0) tasks.log(id, 'warn', '存在识别失败项，可在识别日志中查看原因')
      if (review > 0) tasks.log(id, 'warn', `${review} 个条目的资料或归属待确认，可打开作品修正，或选中后使用 Agent 复查`)
      tasks.log(id, 'info', `本轮消耗 ${result.tokens.toLocaleString()} tokens`)
      tasks.finish(id, state.stopping.value ? 'cancelled' : 'success', (state.stopping.value ? '扫描已停止，已完成结果保留：' : '扫描完成：') + message)
      return result
    })
  }
  function cancel(): void {
    if (!state.taskId || state.stopping.value || state.progress.value?.phase === 'done') return
    window.baoyi[kind].cancel()
    state.stopping.value = true
    tasks.update(state.taskId, { message: '正在停止，等待当前任务收尾…' })
    tasks.log(state.taskId, 'warn', '用户请求停止；已注册的结果保留，等待本轮返回')
  }
  return { running: state.running, stopping: state.stopping, progress: state.progress,
    result: computed(() => state.result.value as Results[K] | null), run, cancel }
}

/** Directory imports use the same task lifetime and progress subscription as scans. */
export async function importVideoDirectory(): Promise<Awaited<ReturnType<typeof window.baoyi.video.importBundle>>> {
  return execute('video', '影视目录导入', '', async id => {
    const result = await window.baoyi.video.importBundle()
    if (!result) { tasks.finish(id, 'cancelled', '未选择目录，已取消导入'); return null }
    const scan = result.scanResult
    if (scan) {
      states.video.result.value = scan
      if (scan.entries?.length) tasks.setScanResults(id, scan.entries)
      tasks.update(id, { processed: scan.registered + scan.skipped + scan.failed, total: scan.candidates })
      if (scan.failed) tasks.log(id, 'warn', `${scan.failed} 项识别失败，可展开识别日志查看原因`)
      tasks.log(id, 'info', `本轮消耗 ${scan.tokens.toLocaleString()} tokens`)
      tasks.finish(id, states.video.stopping.value ? 'cancelled' : 'success',
        `导入${states.video.stopping.value ? '已停止' : '完成'}：${scan.registered} 项入库，${scan.skipped} 项跳过，${scan.failed} 项失败`)
    } else {
      tasks.update(id, { processed: result.filesAdded, total: result.filesAdded })
      tasks.log(id, 'info', '已读取本地作品清单，无需调用在线识别')
      tasks.finish(id, 'success', `导入完成：新增 ${result.itemsAdded} 个内容项、${result.filesAdded} 个文件`)
    }
    for (const warning of result.warnings || []) tasks.log(id, 'warn', warning)
    return result
  })
}

/** 重识别与扫描共享视频进度通道/取消控制器，不能同时启动，否则进度和取消对象会串线。 */
export async function reidentifyVideo(item: VideoItem, forceHentai: boolean): Promise<VideoItem | null> {
  const title = (forceHentai ? '按里番重新识别：' : '重新识别：') + videoTitle(item)
  return execute('video', title, item.path, async (id) => {
    const updated = await window.baoyi.video.reidentify(item.id, forceHentai)
    const state = states.video
    if (state.stopping.value) {
      tasks.finish(id, 'cancelled', '重新识别已停止，已完成的结果保留')
      return null
    }
    // 主进程失败时有时仍返回原条目，不能把「找得到旧记录」当成刮削成功。
    if (!updated || (state.progress.value?.failed ?? 0) > 0) {
      throw new Error(state.progress.value?.log || '识别失败，可在识别日志中查看原因')
    }
    tasks.update(id, { processed: 1, total: 1 })
    tasks.finish(id, 'success', forceHentai ? '里番重新识别完成' : '重新识别完成')
    return updated
  })
}
