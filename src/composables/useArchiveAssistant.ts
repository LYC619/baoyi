import { latestOnly, STALE } from './latestOnly'
import { errorMessage } from '@/utils'
import { computed, ref } from 'vue'
import type { ArchiveAction, ArchiveMessage, ArchiveRun, ArchiveSession, ArchiveSource } from '@/types/archive'

export interface LiveBlock {
  key: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  name?: string
  args?: any
  result?: string
  pending?: boolean
}

const open = ref(false)
const wide = ref(false)
const draft = ref('')
const error = ref('')
const notice = ref('')
const loading = ref(false)
const sending = ref(false)
const sessions = ref<ArchiveSession[]>([])
const selected = ref('')
const messages = ref<ArchiveMessage[]>([])
const actions = ref<ArchiveAction[]>([])
const context = ref<ArchiveSource[]>([])
const active = ref<ArchiveRun | null>(null)
const lastRun = ref<ArchiveRun | null>(null)
const live = ref<LiveBlock[]>([])
const liveSession = ref('')
const configured = ref(false)
const model = ref('')
const profileId = ref('')
const profiles = ref<Array<{ id: string; name: string; model: string }>>([])
const privacyRevision = ref(0)
const methodRevision = ref(0)

let initialized = false
let revision = 0
let generation = 0
let liveRevision = 0
let latestRun: ArchiveRun | null = null

const busy = computed(() => !!active.value)
const visibleLive = computed(() => (liveSession.value === selected.value ? live.value : []))

function init() {
  if (initialized) return
  initialized = true
  window.baoyi?.archive?.onEvent?.((event) => {
    if (event.event === 'run') {
      latestRun = event.run
      active.value = ['starting', 'running'].includes(event.run.status) ? event.run : null
      if (selected.value === event.sessionId) lastRun.value = event.run
      return
    }
    if (event.event === 'finished') {
      latestRun = event.run
      if (selected.value === event.previousSessionId || selected.value === event.sessionId) {
        const previousLive = liveRevision
        selected.value = event.sessionId
        lastRun.value = event.run
        void load(event.sessionId).then((ok) => {
          if (ok && previousLive === liveRevision) live.value = []
        })
      }
      active.value = null
      void refreshSessions().catch((e) => {
        error.value = errorMessage(e)
      })
      return
    }
    if (event.sessionId !== liveSession.value) {
      liveSession.value = event.sessionId
      live.value = []
    }
    if (event.event === 'delta') {
      const previous = live.value.at(-1)
      if (previous?.role === 'assistant') previous.text += event.text
      else live.value.push({ key: crypto.randomUUID(), role: 'assistant', text: event.text })
    }
    if (event.event === 'tool_start') {
      live.value.push({ key: event.callId, role: 'tool', text: '', name: event.name, args: event.args, pending: true })
    }
    if (event.event === 'tool_end') {
      const block = live.value.find((x) => x.key === event.callId)
      if (block) {
        block.pending = false
        block.result = String(event.result)
      }
    }
  })
}

const readSessions = latestOnly((query: string | null) =>
  query === null ? Promise.resolve(null) : window.baoyi.archive.sessions(query)
)

async function refreshSessions(query = '') {
  const result = await readSessions(query)
  if (result !== STALE && result) sessions.value = result
}

async function load(id: string) {
  const request = ++revision
  loading.value = true
  error.value = ''
  try {
    const [state, audit] = await Promise.all([window.baoyi.archive.session(id), window.baoyi.archive.actions(id)])
    if (request !== revision) return false
    if (!state) {
      error.value = '这段对话已不可用'
      return false
    }
    selected.value = state.session.id
    lastRun.value = state.lastRun
    const current = active.value?.sessionId === id ? active.value : null
    messages.value =
      current && liveSession.value === id
        ? state.messages.filter((m) => m.timestamp < current.startedAt / 1000)
        : state.messages
    actions.value = audit
    return true
  } catch (e) {
    if (request === revision) error.value = errorMessage(e)
    return false
  } finally {
    if (request === revision) loading.value = false
  }
}

async function show(text?: string, ids: string[] = []) {
  init()
  open.value = true
  if (text) draft.value = text
  error.value = ''
  const opening = generation
  try {
    const status = await window.baoyi.archive.status()
    if (opening !== generation) return
    configured.value = status.configured
    model.value = status.model
    profiles.value = status.profiles
    active.value = status.active
    if (ids.length) {
      const sources = await Promise.all(ids.map((id) => window.baoyi.archive.source(id)))
      if (opening !== generation) return
      if (!status.active) {
        revision++
        loading.value = false
        selected.value = ''
        messages.value = []
        actions.value = []
        lastRun.value = null
      }
      context.value = sources
    }
    await refreshSessions()
    if (opening !== generation) return
    if (!selected.value && status.active) selected.value = status.active.sessionId
    if (selected.value) await load(selected.value)
  } catch (e) {
    if (opening === generation) error.value = errorMessage(e)
  }
}

function newSession(keepContext = false) {
  revision++
  loading.value = false
  selected.value = ''
  messages.value = []
  actions.value = []
  lastRun.value = null
  error.value = ''
  if (!keepContext) context.value = []
}

async function loadMethod(name: string, ids: string[] = []) {
  const scope = generation
  await show(undefined, ids)
  if (scope !== generation || error.value) return
  const instruction = `请加载归档方法 ${JSON.stringify(name)}，按该方法处理${ids.length ? '附带的资料' : '我指定的资料'}。`
  if (!draft.value.includes(instruction)) draft.value = instruction + (draft.value ? '\n\n' + draft.value : '')
  notice.value = '方法已加入输入框；补充问题后发送即可开始。'
  methodRevision.value++
}

async function send() {
  const originalDraft = draft.value
  const text = originalDraft.trim()
  if (!text || sending.value) return
  sending.value = true
  error.value = ''
  notice.value = ''
  const sendingGeneration = generation
  try {
    if (active.value) {
      if (selected.value !== active.value.sessionId) {
        throw new Error('请先返回正在进行的对话，或停止后新建对话')
      }
      const accepted = await window.baoyi.archive.steer(text)
      if (sendingGeneration !== generation) return
      if (!accepted) throw new Error('当前步骤正在收尾，请稍后发送；输入已保留')
      live.value.push({ key: crypto.randomUUID(), role: 'user', text })
      notice.value = '补充已送达当前任务'
      draft.value = ''
      return
    }
    const request = ++revision
    liveRevision++
    const run = await window.baoyi.archive.send({
      sessionId: selected.value || undefined,
      text,
      contextIds: context.value.map((x) => x.id),
      profileId: profileId.value || undefined
    })
    if (sendingGeneration !== generation) return
    const current = latestRun?.startedAt === run.startedAt ? latestRun : run
    active.value = ['starting', 'running'].includes(current.status) ? current : null
    if (liveSession.value !== current.sessionId) {
      liveSession.value = current.sessionId
      live.value = []
    }
    live.value.unshift({ key: crypto.randomUUID(), role: 'user', text })
    if (draft.value === originalDraft) draft.value = ''
    if (request === revision) {
      selected.value = current.sessionId
      lastRun.value = current
      if (!active.value) {
        const previousLive = liveRevision
        if ((await load(current.sessionId)) && previousLive === liveRevision) live.value = []
      }
    }
  } catch (e) {
    if (sendingGeneration === generation) error.value = errorMessage(e)
  } finally {
    sending.value = false
  }
}

async function stop() {
  error.value = ''
  try {
    await window.baoyi.archive.cancel()
    notice.value = '正在停止，已完成的整理会保留'
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function undo(id: string) {
  try {
    const result = await window.baoyi.archive.undo(id)
    notice.value = result.reason
    actions.value = await window.baoyi.archive.actions(selected.value || undefined)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function undoAll() {
  error.value = ''
  try {
    const list = await window.baoyi.archive.actions(selected.value || undefined)
    const pending = list.filter((item) => item.state !== 'undone')
    if (!pending.length) return
    let count = 0
    for (const item of pending) {
      await window.baoyi.archive.undo(item.id)
      count++
    }
    actions.value = await window.baoyi.archive.actions(selected.value || undefined)
    notice.value = `已撤回 ${count} 项修改`
  } catch (e) {
    error.value = errorMessage(e)
    try {
      actions.value = await window.baoyi.archive.actions(selected.value || undefined)
    } catch { /* best-effort */ }
  }
}

function privacyReset() {
  generation++
  privacyRevision.value = generation
  revision++
  void readSessions(null)
  liveRevision++
  latestRun = null
  loading.value = false
  selected.value = ''
  messages.value = []
  live.value = []
  sessions.value = []
  context.value = []
  actions.value = []
  lastRun.value = null
  active.value = null
  draft.value = ''
  notice.value = ''
  error.value = ''
  if (open.value) void show()
}

export function useArchiveAssistant() {
  init()
  return {
    open,
    wide,
    draft,
    error,
    notice,
    loading,
    sending,
    sessions,
    selected,
    messages,
    actions,
    context,
    active,
    lastRun,
    visibleLive,
    busy,
    configured,
    model,
    profileId,
    profiles,
    privacyRevision,
    methodRevision,
    loadMethod,
    show,
    load,
    refreshSessions,
    newSession,
    send,
    stop,
    undo,
    undoAll,
    privacyReset
  }
}
