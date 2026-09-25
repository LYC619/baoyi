import { computed, reactive, ref, toRefs } from 'vue'
import type { AppSettings } from '@/types'
import type { VideoDownloadDraft, VideoDownloadJob, VideoJobRetry } from '@/types/video-workflow'

interface DraftState {
  url: string
  open: boolean
  draft: VideoDownloadDraft | null
  title: string
  selectedVideoCodes: string[]
  sourceLabel: string
  strictQuality: boolean
  register: boolean
  preparing: boolean
  picking: boolean
  enqueuing: boolean
  error: string
  lastJobId: string
  preparedUrl: string
  revision: number
}

// A preview belongs to the work (or the URL entry), never to a mounted route.
const drafts = new Map<string, DraftState>()
export const videoLibraryView = reactive({ compact: false, pendingOnly: false, issue: 'any' as NonNullable<import('@/types').VideoQuery['issue']> })
const allJobs = ref<VideoDownloadJob[]>([])
const hideHentai = ref(false)
const privacyReady = ref(typeof window === 'undefined' || !window.baoyi?.settings?.getAll)
const jobsError = ref('')
const actionIds = ref(new Set<string>())
const submittingCodes = ref(new Set<string>())
const preferences = reactive({ quality: '', strictQuality: false, register: true })
let subscribed = false
let initialLoad: Promise<void> | null = null
let refreshRound = 0
let preferencesRevision = 0

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const visible = (category: string): boolean => category !== '里番' || (privacyReady.value && !hideHentai.value)
const active = (job: VideoDownloadJob): boolean => job.status === 'queued' || job.status === 'running'
const codeBusy = (code: string, except = ''): boolean => submittingCodes.value.has(code)
  || allJobs.value.some(job => job.id !== except && active(job) && job.items.some(item => item.videoCode === code))

export function videoJobRetryStages(job: VideoDownloadJob): VideoJobRetry[] {
  if (active(job)) return []
  const stages: VideoJobRetry[] = []
  if (job.items.some(item => item.transfer !== 'complete')) stages.push('remaining')
  if (job.items.some(item => item.transfer === 'complete' && item.metadata !== 'complete' && item.metadata !== 'skipped')) stages.push('metadata')
  if (job.register && job.items.some(item => item.transfer === 'complete' && item.registration !== 'complete')) stages.push('registration')
  return stages
}

function mergeJob(job: VideoDownloadJob): void {
  const old = allJobs.value.find(value => value.id === job.id)
  if (old && old.updatedAt > job.updatedAt) return
  allJobs.value = [job, ...allJobs.value.filter(value => value.id !== job.id)]
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
}

function applyPreferences(settings: Pick<AppSettings, 'hide_hentai' | 'video_download_quality' | 'video_download_strict_quality' | 'video_download_register'>): void {
  preferencesRevision++
  hideHentai.value = settings.hide_hentai === true
  privacyReady.value = true
  if (hideHentai.value) jobsError.value = ''
  preferences.quality = settings.video_download_quality || ''
  preferences.strictQuality = settings.video_download_strict_quality === true
  preferences.register = settings.video_download_register !== false
}

async function refresh(): Promise<void> {
  if (typeof window === 'undefined' || !window.baoyi) return
  const round = ++refreshRound
  const preferencesAtStart = preferencesRevision
  const [saved, settings] = await Promise.allSettled([
    window.baoyi.video?.downloadJobs?.() ?? Promise.resolve([]),
    window.baoyi.settings?.getAll?.() ?? Promise.resolve(null)
  ])
  if (saved.status === 'fulfilled') {
    saved.value.forEach(mergeJob)
    if (round === refreshRound) jobsError.value = ''
  } else if (round === refreshRound) jobsError.value = '读取下载任务失败：' + message(saved.reason)
  if (settings.status === 'fulfilled' && settings.value && round === refreshRound && preferencesAtStart === preferencesRevision) applyPreferences(settings.value)
}

function initialize(): void {
  if (typeof window === 'undefined' || !window.baoyi) return
  if (!subscribed && window.baoyi.video?.onDownloadJob) {
    window.baoyi.video.onDownloadJob(mergeJob)
    subscribed = true
  }
  if (!initialLoad) initialLoad = refresh()
}

export function useVideoWorkflow(resourceId = '') {
  initialize()
  const key = resourceId || 'url-entry'
  let state = drafts.get(key)
  if (!state) {
    state = reactive<DraftState>({
      url: '', open: false, draft: null, title: '', selectedVideoCodes: [],
      sourceLabel: '', strictQuality: false, register: true, preparing: false,
      picking: false, enqueuing: false, error: '', lastJobId: '', preparedUrl: '', revision: 0
    })
    drafts.set(key, state)
  }
  const current = state
  const jobs = computed(() => allJobs.value.filter(job => visible(job.category)))
  const currentJob = computed(() => jobs.value.find(job => job.id === current.lastJobId) ?? null)
  const draftHidden = computed(() => !!current.draft && !visible(current.draft.category))
  const needsPrepare = computed(() => !!current.draft && current.url.trim() !== current.preparedUrl)
  const episodes = computed(() => (current.draft?.episodes ?? []).map(episode => {
    if (episode.state === 'other-work') return episode
    if (codeBusy(episode.videoCode)) return { ...episode, state: 'queued' as const }
    if (episode.state === 'queued') {
      const finished = allJobs.value.find(job => !active(job) && job.items.some(item => item.videoCode === episode.videoCode))
      const item = finished?.items.find(item => item.videoCode === episode.videoCode)
      if (item) return { ...episode, state: item.transfer === 'complete' ? 'local' as const : 'available' as const }
    }
    return episode
  }))

  async function prepare(): Promise<VideoDownloadDraft | null> {
    if (current.preparing || current.picking || current.enqueuing) return current.draft
    if (!resourceId && !current.url.trim()) { current.error = '先粘贴来源页面链接'; return null }
    const revision = ++current.revision
    current.preparing = true
    current.open = true
    current.error = ''
    current.lastJobId = ''
    const inputUrl = current.url.trim()
    try {
      const [draft] = await Promise.all([
        window.baoyi.video.prepareDownload({ ...(resourceId ? { resourceId } : {}), ...(inputUrl ? { url: inputUrl } : {}) }),
        refresh()
      ])
      if (revision !== current.revision) return null
      current.draft = draft
      current.preparedUrl = inputUrl
      current.title = draft.title
      current.selectedVideoCodes = episodes.value.filter(episode => episode.state === 'missing' || episode.state === 'available').map(episode => episode.videoCode)
      current.sourceLabel = preferences.quality
      current.strictQuality = preferences.strictQuality
      current.register = preferences.register
      return draft
    } catch (error) {
      if (revision === current.revision) { current.draft = null; current.error = message(error) }
      return null
    } finally {
      if (revision === current.revision) current.preparing = false
    }
  }

  async function pickRoot(): Promise<void> {
    if (!current.draft || current.draft.bound || current.preparing || current.picking || current.enqueuing) return
    const revision = current.revision
    current.picking = true
    current.error = ''
    try {
      const next = await window.baoyi.video.pickDownloadRoot(current.draft.id)
      if (next && revision === current.revision) current.draft = next
    } catch (error) { if (revision === current.revision) current.error = message(error) }
    finally { if (revision === current.revision) current.picking = false }
  }

  async function enqueue(): Promise<VideoDownloadJob | null> {
    const draft = current.draft
    if (!draft || current.enqueuing || current.preparing || current.picking) return null
    if (draftHidden.value) { current.error = '此分类已隐藏，请先在设置中恢复显示'; return null }
    if (needsPrepare.value) { current.error = '链接已更改，请重新解析后再下载'; return null }
    const videoCodes = [...new Set(current.selectedVideoCodes)]
    if (!videoCodes.length) { current.error = '请选择要下载的内容'; return null }
    if (videoCodes.some(code => !episodes.value.some(episode => episode.videoCode === code && episode.state !== 'queued' && episode.state !== 'other-work'))) {
      current.error = '部分内容已排队或不在来源列表中，请重新解析'; return null
    }
    if (!current.title.trim()) { current.error = '请填写作品名称'; return null }
    current.enqueuing = true
    submittingCodes.value = new Set([...submittingCodes.value, ...videoCodes])
    current.error = ''
    try {
      const job = await window.baoyi.video.enqueueDownload({
        draftId: draft.id, videoCodes, sourceLabel: current.sourceLabel,
        strictQuality: !!current.sourceLabel && current.strictQuality, register: current.register,
        ...(draft.bound ? {} : { title: current.title.trim() })
      })
      mergeJob(job)
      current.lastJobId = job.id
      current.draft = { ...draft, episodes: draft.episodes.map(episode => videoCodes.includes(episode.videoCode) ? { ...episode, state: 'queued' } : episode) }
      current.selectedVideoCodes = []
      return job
    } catch (error) { current.error = message(error); return null }
    finally {
      submittingCodes.value = new Set([...submittingCodes.value].filter(code => !videoCodes.includes(code)))
      current.enqueuing = false
    }
  }

  function reset(): void {
    if (current.enqueuing) return
    current.revision++
    current.open = false
    current.preparing = false
    current.picking = false
    current.draft = null
    current.selectedVideoCodes = []
    current.title = ''
    current.error = ''
    current.lastJobId = ''
    current.preparedUrl = ''
  }

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    if (actionIds.value.has(id)) return
    const job = allJobs.value.find(value => value.id === id)
    if (job && !visible(job.category)) return
    actionIds.value = new Set([...actionIds.value, id])
    jobsError.value = ''
    try { await action() }
    catch (error) { if (!job || visible(job.category)) jobsError.value = message(error) }
    finally { const next = new Set(actionIds.value); next.delete(id); actionIds.value = next }
  }

  const retry = (id: string, stage: VideoJobRetry) => act(id, async () => {
    const job = jobs.value.find(job => job.id === id)
    if (!job || active(job)) throw new Error('该任务不可重试或仍在处理中')
    const codes = job.items.filter(item => stage !== 'remaining' || item.transfer !== 'complete').map(item => item.videoCode)
    if (codes.some(code => codeBusy(code, id))) throw new Error('这些内容已在其他下载任务中，请等待当前任务结束')
    submittingCodes.value = new Set([...submittingCodes.value, ...codes])
    try { mergeJob(await window.baoyi.video.retryDownloadJob(id, stage)) }
    finally { submittingCodes.value = new Set([...submittingCodes.value].filter(code => !codes.includes(code))) }
  })
  const cancel = (id: string) => act(id, async () => {
    if (!(await window.baoyi.video.cancelDownloadJob(id))) throw new Error('任务已结束，无法停止')
    await refresh()
  })
  const dismiss = (id: string) => act(id, async () => {
    if (!(await window.baoyi.video.dismissDownloadJob(id))) throw new Error('任务仍在处理，先停止再移除')
    allJobs.value = allJobs.value.filter(job => job.id !== id)
  })
  const reveal = (id: string) => act(id, async () => {
    if (!(await window.baoyi.video.revealDownloadJob(id))) throw new Error('保存位置暂不可用，请检查磁盘是否在线')
  })

  return { ...toRefs(current), jobs, currentJob, draftHidden, hideHentai, privacyReady, needsPrepare, episodes, jobsError, actionIds,
    prepare, pickRoot, enqueue, reset, refresh, retry, cancel, dismiss, reveal, applyPreferences }
}
