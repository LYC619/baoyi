import { computed, ref } from 'vue'
import type { ModuleKey } from './useModules'
import type {
  TaskEvent,
  TaskEventLevel,
  TaskKind,
  TaskRecord,
  TaskStartOptions,
  TaskStatus,
  TaskUpdate,
  VideoScanResult
} from '@/types'

export type TaskScanEntry = NonNullable<VideoScanResult['entries']>[number]
export type TaskWithResults = TaskRecord & { scanEntries?: TaskScanEntry[] }

const MAX_TASKS = 30
const MAX_EVENTS = 100

/** 模块级单例：标题栏和所有路由看到同一份运行期任务。 */
const tasks = ref<TaskWithResults[]>([])
let nextId = 1
let hydrated = false
let hydrationStarted = false
const clearedIds = new Set<string>()
const videoHidden = ref(false)
const videoKinds = new Set<TaskKind>(['video-scan', 'video-download', 'video-series-download', 'hanime-verify'])
const taskModules: Record<TaskKind, ModuleKey> = {
  'software-scan': 'software', 'ai-identify': 'software', organize: 'software',
  'game-scan': 'game', 'video-scan': 'video', 'video-download': 'video',
  'video-series-download': 'video', 'hanime-verify': 'video'
}

async function hydrate(): Promise<void> {
  if (hydrated || hydrationStarted || typeof window === 'undefined' || !window.baoyi?.tasks) return
  hydrationStarted = true
  try {
    const saved = await window.baoyi.tasks.list()
    if (Array.isArray(saved)) {
      const liveIds = new Set(tasks.value.map(task => task.id))
      const history = saved.filter(task => !liveIds.has(task.id) && !clearedIds.has(task.id))
        .map(task => task.status === 'running' ? { ...task, status: 'interrupted' as const, message: '应用中断，可重新执行' } : task)
      tasks.value = trimHistory([...tasks.value, ...history])
      const max = saved.map(task => Number(String(task.id).replace(/^task-/, ''))).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0)
      nextId = Math.max(nextId, max + 1)
    }
  } catch { /* Task history is an aid; a database outage must not block the action. */ }
  hydrated = true
}

function persist(task: TaskRecord): void {
  if (typeof window === 'undefined' || !window.baoyi?.tasks) return
  try {
    // The context bridge clones arguments before preload runs; nested Vue proxies
    // must be removed here, including the task's event history.
    const snapshot: TaskRecord = JSON.parse(JSON.stringify(task))
    void window.baoyi.tasks.save(snapshot).catch(() => {})
  } catch { /* History persistence must not interrupt the action it describes. */ }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function percentOf(processed: number, total: number): number {
  return total > 0 ? clamp((processed / total) * 100) : 0
}

function taskIndex(id: string): number {
  return tasks.value.findIndex((task) => task.id === id)
}

function appendEvent(task: TaskRecord, level: TaskEventLevel, message: string): TaskEvent[] {
  const text = message.trim()
  if (!text) return task.events
  const last = task.events.at(-1)
  if (last?.level === level && last.message === text) return task.events
  const event = { at: Date.now(), level, message: text }
  // 面板只保留最近事件，控制台同步记录全部新增事件，避免长任务丢失早期进度。
  console.info(`[task:${task.kind}] ${text}`)
  const events = [...task.events, event]
  return events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events
}

function trimHistory(next: TaskWithResults[]): TaskWithResults[] {
  // 数组按最近开始/结束顺序排列，不依赖可能相同的毫秒时间戳。
  let finished = 0
  return next.filter((task) => task.status === 'running' || ++finished <= MAX_TASKS)
}

function replaceTask(id: string, change: (task: TaskWithResults) => TaskWithResults): void {
  const index = taskIndex(id)
  if (index < 0) return
  const current = tasks.value[index]
  tasks.value = tasks.value.with(index, change(current))
}

export function useTaskCenter(module?: () => ModuleKey) {
  void hydrate()
  const visibleTasks = computed(() => tasks.value.filter(task =>
    (!module || taskModules[task.kind] === module()) && (!videoHidden.value || !videoKinds.has(task.kind))))
  const runningTasks = computed(() => visibleTasks.value.filter((task) => task.status === 'running'))
  const history = computed(() => visibleTasks.value.filter((task) => task.status !== 'running'))
  const runningCount = computed(() => runningTasks.value.length)
  const failedCount = computed(() => history.value.filter((task) => task.status === 'failed').length)
  const attentionCount = computed(() => history.value.filter(task => task.status === 'failed' || task.status === 'interrupted'
    || task.scanEntries?.some(entry => entry.status === 'review' || entry.status === 'failed')).length)
  const hasAttention = computed(() => runningCount.value > 0 || failedCount.value > 0)

  function start(kind: TaskKind, title: string, options: TaskStartOptions = {}): string {
    const processed = Math.max(0, options.processed ?? 0)
    const total = Math.max(0, options.total ?? 0)
    const id = `task-${Date.now().toString(36)}-${nextId++}-${Math.random().toString(36).slice(2, 9)}`
    const task: TaskRecord = {
      id,
      kind,
      title,
      status: 'running',
      startedAt: Date.now(),
      processed,
      total,
      percent: percentOf(processed, total),
      current: options.current ?? '',
      message: options.message ?? '',
      events: [{ at: Date.now(), level: 'info', message: '任务开始' }]
    }
    tasks.value = trimHistory([task, ...tasks.value])
    persist(task)
    console.info(`[task:${kind}] 任务开始：${title}`)
    return id
  }

  function update(id: string, patch: TaskUpdate, event?: { level?: TaskEventLevel; message?: string }): void {
    const index = taskIndex(id)
    if (index < 0 || tasks.value[index].status !== 'running') return
    replaceTask(id, (task) => {
      const processed = patch.processed === undefined ? task.processed : Math.max(0, patch.processed)
      const total = patch.total === undefined ? task.total : Math.max(0, patch.total)
      const percent = patch.percent === undefined ? percentOf(processed, total) : clamp(patch.percent)
      const message = patch.message === undefined ? task.message : patch.message
      const next = {
        ...task,
        processed,
        total,
        percent,
        current: patch.current === undefined ? task.current : patch.current,
        message,
        events: event?.message ? appendEvent(task, event.level ?? 'info', event.message) : task.events
      }
      persist(next)
      return next
    })
  }

  function log(id: string, level: TaskEventLevel, message: string): void {
    const index = taskIndex(id)
    if (index < 0) return
    replaceTask(id, (task) => { const next = { ...task, events: appendEvent(task, level, message) }; persist(next); return next })
  }

  function finish(id: string, status: Exclude<TaskStatus, 'running'>, message: string, error?: string): void {
    const index = taskIndex(id)
    if (index < 0 || tasks.value[index].status !== 'running') return
    replaceTask(id, (task) => {
      const level: TaskEventLevel = status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'success'
      const finalMessage = message.trim() || (status === 'success' ? '任务完成' : status === 'cancelled' ? '任务已取消' : '任务失败')
      let events = appendEvent(task, level, finalMessage)
      if (error?.trim()) events = appendEvent({ ...task, events }, 'error', error)
      const next = {
        ...task,
        status,
        finishedAt: Date.now(),
        message: finalMessage,
        error: error?.trim() || undefined,
        events
      }
      persist(next)
      return next
    })
    const task = tasks.value[taskIndex(id)]
    if (task) {
      tasks.value = trimHistory([task, ...tasks.value.filter((item) => item.id !== id)])
    }
  }

  async function clearFinished(): Promise<void> {
    const ids = history.value.map(task => task.id)
    if (!ids.length) return
    if (typeof window !== 'undefined' && window.baoyi?.tasks) {
      if (!window.baoyi.tasks.clear || !(await window.baoyi.tasks.clear(ids))) throw new Error('未能清除历史，请重试')
    }
    ids.forEach(id => clearedIds.add(id))
    // Only the records reviewed when the user clicked are removed. Newly finished
    // tasks and hidden records remain, including a late history response.
    tasks.value = tasks.value.filter(task => task.status === 'running' || !clearedIds.has(task.id))
  }

  function setScanResults(id: string, entries: TaskScanEntry[]): void {
    replaceTask(id, task => {
      const next = { ...task, scanEntries: entries.map(entry => ({ ...entry })) }
      persist(next)
      return next
    })
  }

  return { tasks, runningTasks, history, runningCount, failedCount, attentionCount, hasAttention, start, update, log, finish, clearFinished, setScanResults,
    setVideoHidden: (hidden: boolean) => { videoHidden.value = hidden } }
}
