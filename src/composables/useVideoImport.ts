import { computed, ref } from 'vue'
import type { VideoImportBatch, VideoImportEdits, VideoImportSummary } from '@/types/video-import'
import { errorMessage, plain } from '@/utils'
import { useTaskCenter } from './useTaskCenter'

const open = ref(false), batches = ref<VideoImportSummary[]>([]), batch = ref<VideoImportBatch | null>(null)
const busy = ref(''), error = ref(''), useAgent = ref(false)
let initialized = false, acceptingNew = false, taskId = '', privacyHidden = false
const tasks = useTaskCenter()
const eligible = (entry: VideoImportBatch['entries'][number]) => entry.status === 'ready' || entry.status === 'review'
function merge(value: VideoImportBatch) {
  if (privacyHidden && value.entries.some(entry => entry.category === '里番')) return
  if ((!batch.value || acceptingNew || batch.value.id === value.id) && (!batch.value || batch.value.id !== value.id || batch.value.revision <= value.revision)) batch.value = value
  const summary: VideoImportSummary = { id: value.id, roots: value.roots, createdAt: value.createdAt, updatedAt: value.updatedAt, status: value.status,
    total: value.entries.length, pending: value.entries.filter(eligible).length, confirmed: value.entries.filter(entry => entry.status === 'confirmed').length }
  batches.value = [summary, ...batches.value.filter(row => row.id !== value.id)].sort((a, b) => b.createdAt - a.createdAt)
  if (taskId && value.progress) tasks.update(taskId, { current: value.progress.current, processed: value.progress.processed, total: value.progress.total, message: value.progress.log || '正在识别预览' })
}
async function refreshList() { batches.value = await window.baoyi.videoImport.list() }
async function perform<T>(name: string, action: () => Promise<T>): Promise<T | null> {
  if (busy.value) return null
  busy.value = name; error.value = ''
  try { return await action() } catch (cause) { error.value = errorMessage(cause); return null } finally { busy.value = '' }
}
export function useVideoImport() {
  if (!initialized && typeof window !== 'undefined' && window.baoyi?.videoImport) {
    initialized = true; window.baoyi.videoImport.onChanged(merge)
    void refreshList().catch(() => {})
    void window.baoyi.settings.getAll().then(settings => { useAgent.value = settings.video_import_agent === true }).catch(() => {})
  }
  async function review(ids: string[]) {
    if (!batch.value || !ids.length) return
    await perform('review', async () => {
      taskId = tasks.start('video-scan', '视频导入 · Agent 复查')
      try {
        const value = await window.baoyi.videoImport.review(batch.value!.id, plain(ids)); merge(value)
        const failures = value.entries.filter(entry => ids.includes(entry.id) && entry.reviewError)
        tasks.finish(taskId, value.status === 'interrupted' ? 'cancelled' : failures.length ? 'failed' : 'success',
          failures.length ? `${failures.length} 项复查未完成，原识别结果已保留` : '复查结束，结果保留在导入确认窗口',
          failures.map(entry => `${entry.title}：${entry.reviewError}`).join('\n'))
      }
      catch (cause) { tasks.finish(taskId, 'failed', '复查未完成', errorMessage(cause)); throw cause }
      finally { taskId = '' }
    })
  }
  async function begin(roots?: string[]) {
    if (busy.value) { open.value = true; return }
    const autoAgent = useAgent.value
    open.value = true; acceptingNew = true
    const value = await perform('scan', async () => {
      taskId = tasks.start('video-scan', '视频导入 · 识别预览')
      try {
        const value = await window.baoyi.videoImport.prepare(roots && plain(roots))
        if (value) { merge(value); tasks.finish(taskId, value.status === 'interrupted' ? 'cancelled' : 'success', `${value.entries.length} 项识别结果，等待确认入库`) }
        else tasks.finish(taskId, 'cancelled', '未选择目录，已取消导入')
        return value
      } catch (cause) { tasks.finish(taskId, 'failed', '识别预览失败', errorMessage(cause)); throw cause }
      finally { taskId = ''; acceptingNew = false }
    })
    if (value && autoAgent) await review(value.entries.filter(eligible).map(entry => entry.id))
  }
  async function show(id?: string) {
    open.value = true
    await perform('load', async () => {
      await refreshList()
      const target = id || batch.value?.id || batches.value.find(row => row.pending)?.id || batches.value[0]?.id
      if (target) { const value = await window.baoyi.videoImport.get(target); if (value) batch.value = value }
    })
  }
  return { open, batch, batches, busy, error, useAgent, begin, show, review,
    pendingCount: computed(() => batches.value.reduce((count, row) => count + row.pending, 0)),
    setAgent: async (enabled: boolean) => { useAgent.value = enabled; try { await window.baoyi.settings.patch({ video_import_agent: enabled }) } catch (cause) { error.value = errorMessage(cause) } },
    update: async (changes: { selectedIds?: string[]; entry?: { id: string; edits: VideoImportEdits } }) => {
      if (!batch.value) return null
      return perform('save', async () => { const value = await window.baoyi.videoImport.update(batch.value!.id, plain(changes)); merge(value); return value })
    },
    refresh: async () => { if (batch.value) await perform('scan', async () => merge(await window.baoyi.videoImport.refresh(batch.value!.id))) },
    confirm: async (ids: string[]) => { if (batch.value) await perform('confirm', async () => merge(await window.baoyi.videoImport.confirm(batch.value!.id, plain(ids)))) },
    discard: async () => { if (batch.value) await perform('discard', async () => { await window.baoyi.videoImport.discard(batch.value!.id); batch.value = null; await refreshList() }) },
    cancel: async () => { if (batch.value) await window.baoyi.videoImport.cancel(batch.value.id) },
    setPrivacy: (hidden: boolean) => { privacyHidden = hidden; if (hidden) { open.value = false; batch.value = null; batches.value = [] } },
    hide: () => { open.value = false; batch.value = null; batches.value = [] }
  }
}
