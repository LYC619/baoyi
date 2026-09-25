import { computed, ref, watch } from 'vue'
import type { VideoItem } from '@/types'
import type {
  VideoOrganizeJournal, VideoOrganizeMode, VideoOrganizePreview, VideoOrganizeRequest,
  VideoRelocatePreview, VideoRelocateRequest
} from '@/types/video-organize'
import { errorMessage, plain, videoTitle } from '@/utils'
import { collectionName } from '@/utils/video-series'

type Preview = VideoOrganizePreview | VideoRelocatePreview
type Operation = '' | 'preview' | 'pick' | 'apply' | 'retry' | 'rollback' | 'history'
interface SessionOptions {
  works: () => VideoItem[]
  resourceId?: string
  privacyReady: () => boolean
  privateHidden: () => boolean
  kind?: Preview['kind']
  autoPreview?: () => boolean
  changed?: (journal: VideoOrganizeJournal) => void
}

/**
 * Journals have no category field. Check every contributor, including archived sources,
 * before rendering paths, messages or even a count. Shared by the organize panel and the log panel.
 */
export async function filterVisibleJournals(saved: VideoOrganizeJournal[], privateHidden: boolean): Promise<VideoOrganizeJournal[]> {
  if (!privateHidden) return saved
  const ids = [...new Set(saved.flatMap(journal => [journal.survivorId, ...journal.sourceIds, ...journal.files.flatMap(file => file.resourceIds)]))]
  const checked = await Promise.all(ids.map(async id => {
    try { const work = await window.baoyi.video.get(id); return work && work.category !== '里番' ? id : null }
    catch { return null }
  }))
  const allowed = new Set(checked.filter((id): id is string => id !== null))
  return saved.filter(journal => [journal.survivorId, ...journal.sourceIds, ...journal.files.flatMap(file => file.resourceIds)].every(id => allowed.has(id)))
}

/** Read-only collection previews follow inputs; all writes require a reviewed snapshot. */
export function useOrganizeSession(options: SessionOptions) {
  const works = computed(() => options.works().filter(work => !options.privateHidden() || work.category !== '里番'))
  const survivorId = ref(works.value.find(work => work.video_type === 'series' && work.episode_total > 1)?.id ?? works.value[0]?.id ?? '')
  const collectionAction = ref<'create' | 'join'>('create')
  let suggestedTitle = collectionName(works.value.map(videoTitle))
  const collectionTitle = ref(suggestedTitle)
  const episodeNumbers = ref<NonNullable<VideoOrganizeRequest['episodeNumbers']>>({})
  const copyFiles = ref(false)
  const transfer = ref<'copy' | 'move'>('copy')
  const targetDirectory = ref('')
  const root = ref('')
  const fileNames = ref<Record<string, string>>({})
  const relocateMode = ref<VideoRelocateRequest['mode']>('rebind')
  const preview = ref<Preview | null>(null)
  const journals = ref<VideoOrganizeJournal[]>([])
  const historyLoaded = ref(false)
  const busy = ref<Operation>('')
  const error = ref('')
  const notice = ref('')
  const reviewedKey = ref('')
  const invalidated = ref(false)
  const libraryRevision = ref(0)
  let privacyRevision = 0
  let disposed = false
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  if (options.kind !== 'relocate') void window.baoyi.settings?.getAll?.().then(settings => {
    if (!disposed && !targetDirectory.value) targetDirectory.value = settings.video_organize_root || ''
  }).catch(() => {})
  const stopSuggestedName = watch(() => [works.value.map(videoTitle), episodeNumbers.value, preview.value?.kind === 'organize' ? preview.value.episodes.map(episode => episode.episode) : []], () => {
    const numbers = preview.value?.kind === 'organize' ? preview.value.episodes.map(episode => episodeNumbers.value[episode.id]?.episode ?? episode.episode) : []
    const next = collectionName(works.value.map(videoTitle), numbers)
    if (!collectionTitle.value || collectionTitle.value === suggestedTitle) collectionTitle.value = next
    suggestedTitle = next
  }, { deep: true })

  const requestKey = computed(() => JSON.stringify({
    works: works.value.map(work => [work.id, work.updated_at, work.category]), survivor: survivorId.value,
    collectionAction: collectionAction.value, collectionTitle: collectionTitle.value.trim(), episodeNumbers: episodeNumbers.value,
    copyFiles: copyFiles.value, transfer: transfer.value, target: targetDirectory.value.trim(), root: root.value.trim(), fileNames: fileNames.value,
    relocateMode: relocateMode.value, libraryRevision: libraryRevision.value
  }))
  const stale = computed(() => !preview.value || invalidated.value || reviewedKey.value !== requestKey.value)
  const canPreview = computed(() => options.privacyReady() && works.value.length > 0 && works.value.length <= 500
    && works.value.some(work => work.id === survivorId.value)
    && (options.kind === 'relocate' || collectionAction.value === 'join' || !!collectionTitle.value.trim())
    && (options.kind === 'relocate' || !copyFiles.value || !!targetDirectory.value.trim())
    && Object.values(episodeNumbers.value).every(value => Number.isInteger(value.season) && value.season >= 0 && Number.isInteger(value.episode) && value.episode >= 0 && value.episode <= 10000))

  function schedulePreview(): void {
    clearTimeout(autoTimer)
    if (disposed || !options.autoPreview?.() || !canPreview.value) return
    autoTimer = setTimeout(() => {
      if (!disposed && options.autoPreview?.() && !busy.value && canPreview.value) void previewChanges('organize')
    }, 240)
  }

  const stopPrivacy = watch(() => [options.privacyReady(), options.privateHidden()], () => {
    privacyRevision++
    preview.value = null
    journals.value = []
    historyLoaded.value = false
    error.value = ''
    collectionTitle.value = ''
    episodeNumbers.value = {}
    fileNames.value = {}
    targetDirectory.value = ''
    root.value = ''
    copyFiles.value = false
    notice.value = '显示范围已变化，请重新选择作品或刷新整理记录。'
    if (!works.value.some(work => work.id === survivorId.value)) survivorId.value = ''
  }, { flush: 'sync' })
  const stopInput = watch(requestKey, () => {
    if (preview.value) notice.value = options.autoPreview?.() ? '' : '选择、资料或目标已变化，请重新预览。'
    error.value = ''
    schedulePreview()
  }, { flush: 'sync', immediate: true })

  function bridge() {
    const api = window.baoyi.videoOrganize
    if (!api) throw new Error('当前版本尚未提供整理功能，请更新应用后重试')
    return api
  }
  function usable(revision: number): boolean { return !disposed && revision === privacyRevision && options.privacyReady() }
  function invalidate(): void {
    if (busy.value === 'apply' || busy.value === 'retry' || busy.value === 'rollback') return
    libraryRevision.value++
    if (preview.value) notice.value = '作品资料或文件已变化，请重新预览。'
  }
  function organizeRequest(): VideoOrganizeRequest {
    const names = Object.fromEntries(Object.entries(fileNames.value).filter(([, name]) => name.trim()).map(([id, name]) => [id, name.trim()]))
    return {
      transfer: transfer.value, resourceIds: works.value.map(work => work.id), survivorId: survivorId.value,
      ...(collectionAction.value === 'create' ? { collectionTitle: collectionTitle.value.trim(), ...(collectionTitle.value.trim() !== suggestedTitle.trim() ? { titleEdited: true } : {}) } : {}),
      ...(Object.keys(episodeNumbers.value).length ? { episodeNumbers: plain(episodeNumbers.value) } : {}),
      ...(copyFiles.value && targetDirectory.value.trim() ? { targetRoot: targetDirectory.value.trim() } : {}),
      ...(copyFiles.value && root.value.trim() ? { root: root.value.trim() } : {}),
      ...(copyFiles.value && Object.keys(names).length ? { fileNames: names } : {})
    }
  }
  async function previewChanges(kind: Preview['kind']): Promise<void> {
    if (disposed || busy.value || !canPreview.value) return
    if (kind === 'relocate' && (!options.resourceId || !targetDirectory.value.trim())) {
      error.value = '请填写完整的新作品目录'; return
    }
    const revision = privacyRevision, key = requestKey.value
    busy.value = 'preview'
    error.value = ''
    notice.value = ''
    invalidated.value = true
    try {
      const value: Preview = kind === 'organize'
        ? await bridge().preview(organizeRequest())
        : await bridge().previewRelocate({ resourceId: options.resourceId!, directory: targetDirectory.value.trim(),
          mode: relocateMode.value, ...(root.value.trim() ? { root: root.value.trim() } : {}) })
      if (!usable(revision) || key !== requestKey.value) return
      const ids = new Set(works.value.map(work => work.id))
      if (value.kind === 'organize' && value.works.some(work => !ids.has(work.resourceId))) throw new Error('作品范围已变化，请重新选择后预览')
      preview.value = value
      reviewedKey.value = key
      invalidated.value = false
    } catch (cause) {
      if (usable(revision)) { preview.value = null; error.value = errorMessage(cause) }
    } finally {
      busy.value = ''
      if (usable(revision) && key !== requestKey.value) schedulePreview()
    }
  }
  async function pickDirectory(): Promise<void> {
    if (disposed || busy.value) return
    const revision = privacyRevision
    busy.value = 'pick'
    error.value = ''
    try {
      const directory = await bridge().pickDirectory()
      if (usable(revision) && directory) targetDirectory.value = directory
    } catch (cause) { if (usable(revision)) error.value = errorMessage(cause) }
    finally { busy.value = ''; schedulePreview() }
  }
  function remember(journal: VideoOrganizeJournal): void {
    journals.value = [journal, ...journals.value.filter(value => value.id !== journal.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
    // The list may only contain this operation until the user requests history.
    options.changed?.(journal)
  }
  async function write(operation: 'apply' | 'retry' | 'rollback', action: () => Promise<VideoOrganizeJournal>): Promise<VideoOrganizeJournal | null> {
    if (disposed || busy.value || !options.privacyReady()) return null
    const revision = privacyRevision
    busy.value = operation
    error.value = ''
    notice.value = ''
    try {
      const journal = await action()
      if (!usable(revision)) return null
      invalidated.value = true
      preview.value = null
      reviewedKey.value = ''
      notice.value = ''
      remember(journal)
      return journal
    } catch (cause) {
      if (usable(revision)) {
        invalidated.value = true
        error.value = errorMessage(cause)
        notice.value = '请重新预览；如果操作已经开始，可刷新整理记录查看逐项结果。'
      }
      return null
    } finally { busy.value = '' }
  }
  async function apply(mode: VideoOrganizeMode): Promise<VideoOrganizeJournal | null> {
    const value = preview.value
    if (!value || value.kind !== 'organize' || stale.value || !canPreview.value) return null
    // A physical collision or absent directory must not disable a logical merge.
    if (mode === 'logical' ? !value.canMerge : !value.canOrganize) return null
    return write('apply', () => bridge().apply({ preview: plain(value), mode }))
  }
  async function relocate(): Promise<VideoOrganizeJournal | null> {
    const value = preview.value
    if (!value || value.kind !== 'relocate' || stale.value || !canPreview.value || !value.canApply) return null
    return write('apply', () => bridge().relocate({ preview: plain(value) }))
  }
  async function refreshHistory(): Promise<void> {
    if (disposed || busy.value || !options.privacyReady()) return
    const revision = privacyRevision
    busy.value = 'history'
    error.value = ''
    try {
      const saved: VideoOrganizeJournal[] = await bridge().list(options.resourceId)
      if (!usable(revision)) return
      const visible = await filterVisibleJournals(saved, options.privateHidden())
      if (!usable(revision)) return
      journals.value = visible
      historyLoaded.value = true
      notice.value = ''
    } catch (cause) { if (usable(revision)) error.value = options.privateHidden() ? '读取整理记录失败，请重试。' : errorMessage(cause) }
    finally { busy.value = '' }
  }
  async function retry(id: string): Promise<VideoOrganizeJournal | null> {
    if (!journals.value.some(journal => journal.id === id && journal.canRetry)) return null
    return write('retry', () => bridge().retry(id))
  }
  async function rollback(id: string): Promise<VideoOrganizeJournal | null> {
    if (!journals.value.some(journal => journal.id === id && journal.canRollback)) return null
    return write('rollback', () => bridge().rollback(id))
  }
  function dispose(): void {
    disposed = true
    privacyRevision++
    clearTimeout(autoTimer)
    stopPrivacy()
    stopInput()
    stopSuggestedName()
  }
  return { works, survivorId, collectionAction, collectionTitle, episodeNumbers, transfer, copyFiles, targetDirectory, root, fileNames, relocateMode, preview, journals, historyLoaded,
    busy, error, notice, stale, canPreview, previewChanges, pickDirectory, apply, relocate, refreshHistory, retry, rollback, invalidate, dispose }
}
