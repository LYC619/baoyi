
import { tr } from "../i18n/index.ts"
import { computed } from 'vue'
import { useImageDownloads } from './useImageDownloads'
import { useComicIngest } from './useComicIngest'
import type { ComicProxy } from '@/types/comic-ingest'
import type { ImageDownloadProgress } from '@/types/image'

export type ComicTaskAction = 'pause' | 'cancel' | 'retry' | 'dismiss' | 'open' | 'logs' | 'resume' | 'up' | 'down' | 'proxy' | 'revalidate' | 'clean'
export interface ComicTaskRow {
  provider: 'pica' | 'jm'; id: string; title: string; status: string
  phase: string; phaseLabel: string; processed: number; total: number; chapterDone: number; chapterTotal: number; error: string
  retryNotBefore?: number; resourceId: string; createdAt: number; queuePosition?: number; actions: ComicTaskAction[]
  current: string; totalKnown: boolean; requiresRevalidation?: boolean
  progress?: ImageDownloadProgress; chapterTitle?: string; queueTotal?: number
}
export const comicStatusLabels: Record<string, string> = { get queued() { return tr('排队中') }, get running() { return tr('正在下载') }, get paused() { return tr('已暂停') }, get success() { return tr('已入库') }, get failed() { return tr('需要处理') }, get cancelled() { return tr('已停止') }, get interrupted() { return tr('上次中断') } }
export const comicPhaseLabels: Record<string, string> = {
  get queued() { return tr('排队中') }, get catalog() { return tr('读取章节目录') }, get checking() { return tr('校验已有页面') }, get connecting() { return tr('连接图源') }, get receiving() { return tr('接收图片') },
  get retrying() { return tr('等待重试') }, get 'rate-limited'() { return tr('等待限流') }, get saving() { return tr('保存图片') }, get importing() { return tr('整理入库') }, idle: '',
  get resolving() { return tr('读取目录') }, get downloading() { return tr('下载页面') }, get verifying() { return tr('核验图片') }, get prepared() { return tr('准备保存') }, get placed() { return tr('已落盘，待登记') }, get indexing() { return tr('登记入库') }, get done() { return tr('已入库') },
}
export function useComicDownloads() {
  const pica = useImageDownloads(), jm = useComicIngest(), fallbackDates = new Map<string, number>()
  const rows = computed<ComicTaskRow[]>(() => {
    const date = (provider: string, job: { id: string; createdAt?: number; updatedAt: number }) => {
      const key = provider + ':' + job.id
      if (!fallbackDates.has(key)) fallbackDates.set(key, job.updatedAt)
      return job.createdAt ?? fallbackDates.get(key)!
    }
    const picaRows = pica.jobs.value.map(job => {
      const actions: ComicTaskAction[] = [], active = ['queued', 'running'].includes(job.status)
      if (job.resourceId) actions.push('open')
      if (job.status === 'queued') actions.push('up', 'down')
      if (active) actions.push('pause')
      if (job.status === 'paused') actions.push('resume')
      if (active || job.status === 'paused') actions.push('cancel')
      if (!active) {
        if (!['success', 'paused'].includes(job.status)) actions.push('retry')
        actions.push('dismiss')
      }
      actions.push('logs')
      return { provider: 'pica' as const, id: job.id, title: job.work.title, status: job.status,
        phase: job.progress?.phase || 'idle', phaseLabel: comicPhaseLabels[job.progress?.phase || 'idle'], processed: job.processed, total: job.total,
        chapterDone: job.completedChapters, chapterTotal: job.chapters.length, error: job.error,
        retryNotBefore: Math.max(job.retryNotBefore || 0, job.progress?.retryAt || 0), resourceId: job.resourceId,
        createdAt: date('pica', job), queuePosition: job.queuePosition, actions, current: job.current,
        totalKnown: job.status === 'success' || (job.progress?.totalKnown ?? job.total > 0), progress: job.progress,
        chapterTitle: job.chapters[(job.progress?.chapterIndex || 0) - 1]?.title || job.current,
        queueTotal: pica.jobs.value.filter(j => j.status === 'queued').length }
    })
    const jmRows = jm.jobs.value.map(job => {
      const actions: ComicTaskAction[] = [], active = ['queued', 'running'].includes(job.status)
      if (job.resourceId) actions.push('open')
      if (active) actions.push('pause')
      if (!active && job.status !== 'success' && !job.requiresRevalidation) actions.push('retry', 'proxy')
      if (job.requiresRevalidation && job.status !== 'success') actions.push('revalidate')
      if (active || job.status === 'paused') actions.push('cancel')
      else actions.push('dismiss')
      if (job.status !== 'success' && !job.requiresRevalidation) actions.push('clean')
      actions.push('logs')
      return { provider: 'jm' as const, id: job.id, title: job.name, status: job.status, phase: job.phase, phaseLabel: comicPhaseLabels[job.phase],
        processed: job.processed, total: job.total, chapterDone: job.completedChapters, chapterTotal: job.selectedChapters.length,
        error: job.error, retryNotBefore: job.retryNotBefore, resourceId: job.resourceId, createdAt: date('jm', job), actions,
        current: job.current, totalKnown: true, requiresRevalidation: job.requiresRevalidation }
    })
    const result = [...picaRows, ...jmRows].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const present = new Set(result.map(row => row.provider + ':' + row.id))
    for (const key of fallbackDates.keys()) if (!present.has(key)) fallbackDates.delete(key)
    return result
  })
  async function run(row: ComicTaskRow, action: ComicTaskAction, proxy?: ComicProxy) {
    if (row.provider === 'pica') {
      const api = window.baoyi.image
      if (action === 'retry') await api.retryJob(row.id)
      else if (action === 'cancel') await api.cancelJob(row.id)
      else if (action === 'pause') await api.pauseJob(row.id)
      else if (action === 'resume') await api.resumeJob(row.id)
      else if (action === 'up' || action === 'down') await api.moveJob(row.id, action)
      else if (action === 'dismiss') await api.dismissJob(row.id)
      await pica.refresh()
    } else {
      const api = window.baoyi.comic
      if (action === 'revalidate') { const job = jm.jobs.value.find(job => job.id === row.id)!; jm.show(job.workId, job); return }
      if (action === 'retry' || action === 'proxy') await api.retry(row.id, proxy)
      else if (action === 'clean') await api.clean(row.id)
      else if (action === 'dismiss') await api.dismiss(row.id)
      else if (action === 'pause' || action === 'cancel') await api.stop(row.id, action === 'cancel')
      await jm.refresh()
    }
  }
  const logs = (row: ComicTaskRow) => row.provider === 'pica' ? window.baoyi.image.jobLogs(row.id) : window.baoyi.comic.logs(row.id)
  return { rows, run, logs, options: pica.options, setOptions: pica.setOptions, error: jm.error }
}
