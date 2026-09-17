<script setup lang="ts">
/**
 * 识别日志：把 agent 每一轮做了什么原样摊开。
 *
 * 结论那一行（「未注册任何条目」）说不清任何事 —— 是判据不对，还是在子目录里
 * 兜圈子兜到轮数用光？两者要改的东西完全不同。这一页就是回答这个问题的。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Eraser,
  FileBarChart,
  Loader2,
  MinusCircle,
  RotateCcw,
  Search
} from 'lucide-vue-next'
import ReportDialog from '@/components/identify/ReportDialog.vue'
import type { IdentifyLog, IdentifyLogStatus, IdentifyReport } from '@/types'
import { useToast } from '@/composables/useToast'
import { formatDateTime, groupRounds, logToText } from '@/utils'

const props = defineProps<{
  /** 资源类型：software / game / video，用于过滤该模块的识别日志 */
  resourceKind: string
}>()

const emit = defineEmits<{ (e: 'retry', dir: string): void }>()

const { success, toast } = useToast()

type Filter = 'all' | IdentifyLogStatus

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'skipped', label: '跳过' },
  { value: 'failed', label: '失败' }
]

const STATUS_META: Record<IdentifyLogStatus, { label: string; icon: any; tone: string }> = {
  success: { label: '已注册', icon: CheckCircle2, tone: 'ok' },
  skipped: { label: '未注册', icon: MinusCircle, tone: 'warn' },
  failed: { label: '失败', icon: AlertTriangle, tone: 'bad' }
}

const logs = ref<IdentifyLog[]>([])
const reports = ref<IdentifyReport[]>([])
const openReport = ref<IdentifyReport | null>(null)
const loading = ref(false)
const filter = ref<Filter>('all')
const keyword = ref('')
/** 展开的日志 id。默认全收起，一页几十条时不至于一屏放不下一条 */
const opened = ref(new Set<string>())
/** 展开了全文的工具返回，键是「日志 id : 事件下标」 */
const spread = ref(new Set<string>())

/** 上次真正发起过查询的关键词。blur 在单纯移开焦点时也会触发，没改动就不该重打 IPC */
let queriedKeyword = ''

async function load(): Promise<void> {
  const kw = keyword.value.trim()
  queriedKeyword = kw
  loading.value = true
  try {
    logs.value = await window.baoyi.logs.list({
      status: filter.value === 'all' ? undefined : filter.value,
      keyword: kw || undefined,
      resource_kind: props.resourceKind
    })
  } finally {
    loading.value = false
  }
}

function blurSearch(): void {
  if (keyword.value.trim() !== queriedKeyword) void load()
}

// 切换模块时重新加载日志
watch(() => props.resourceKind, () => void load())

onMounted(async () => {
  await load()
  reports.value = await window.baoyi.logs.reports()
})

function pick(value: Filter): void {
  filter.value = value
  void load()
}

function toggle(id: string): void {
  const next = new Set(opened.value)
  next.has(id) ? next.delete(id) : next.add(id)
  opened.value = next
}

function toggleFull(key: string): void {
  const next = new Set(spread.value)
  next.has(key) ? next.delete(key) : next.add(key)
  spread.value = next
}

/**
 * 整条日志复制成纯文本。页面上的折叠和截断是为了在一屏里放下几十条 ——
 * 复制出去是要贴进 issue 或者对着排查的，所以一个字不省，格式化在 logToText 里。
 */
async function copyLog(log: IdentifyLog): Promise<void> {
  await window.baoyi.app.copyText(logToText(log))
  success('已复制')
}

async function clearAll(): Promise<void> {
  if (!window.confirm('清空所有识别日志和汇总报告？只删记录，软件条目和识别结果都不受影响。')) return
  const n = await window.baoyi.logs.clear(props.resourceKind)
  await load()
  reports.value = await window.baoyi.logs.reports(props.resourceKind)
  success(`已清空 ${n} 条日志`)
}

/** 退回待识别的实际动作交给设置页 —— 它还要顺带刷新计数和待识别列表 */
function retry(log: IdentifyLog): void {
  if (log.kind !== 'unit') {
    toast('单条补全请到卡片详情页重新识别')
    return
  }
  emit('retry', log.dir)
}

/* ------------------------------ 过程渲染 ------------------------------ */

/** 工具调用参数压成一行。路径只留最后一段，全路径在 title 里 */
function argLine(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : ''
  const tail = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  switch (name) {
    case 'list_directory':
    case 'get_file_info':
    case 'read_text_file':
    case 'skip_directory':
      return tail
    case 'register_software':
      return String(args.name_zh ?? args.name_en ?? '')
    case 'web_search':
      return String(args.query ?? '')
    default:
      return Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
  }
}

function fullArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** 折叠时露出的行数够看出「返回了什么」，不够就点开 */
const PREVIEW_LINES = 6

function preview(text: string): string {
  const lines = text.split('\n')
  return lines.length <= PREVIEW_LINES ? text : lines.slice(0, PREVIEW_LINES).join('\n')
}

function isLong(text: string): boolean {
  return text.split('\n').length > PREVIEW_LINES
}

function cost(log: IdentifyLog): string {
  const seconds = (log.duration_ms / 1000).toFixed(1)
  const turns = log.stop_reason === 'max_turns' ? `${log.rounds} 轮（达到上限）` : `${log.rounds} 轮`
  return `${turns}，${seconds}s，${log.tokens.toLocaleString()} tokens`
}

const empty = computed(() => !loading.value && logs.value.length === 0)
</script>

<template>
  <section class="panel">
    <div class="sec-head">
      <h2>识别日志</h2>
      <button v-if="logs.length" class="btn btn--subtle" @click="clearAll">
        <Eraser :size="14" />
        清空
      </button>
    </div>
    <p class="sec-desc">
      每跑一次识别留一条，记下 agent 调了哪些工具、看到了什么、最后怎么判断。
      识别结果不对时，翻这里比猜要快 —— 你能直接看到它是在哪一步走偏的。
      只保留最近 300 条。
    </p>

    <!-- 历史汇总报告。逐条日志说细节，报告说整体，两个都要够得着 -->
    <div v-if="reports.length > 0" class="reports">
      <p class="reports__title">历史汇总报告</p>
      <button
        v-for="r in reports.slice(0, 8)"
        :key="r.id"
        class="reports__row"
        @click="openReport = r"
      >
        <FileBarChart :size="13" />
        <span class="reports__time mono">{{ formatDateTime(r.created_at) }}</span>
        <span class="reports__sum">
          {{ r.processed }} 个目录 · 成功 {{ r.registered }} · 跳过 {{ r.skipped }} · 失败
          {{ r.failed }}
        </span>
        <span class="reports__cost mono">{{ r.tokens.toLocaleString() }} tk</span>
        <ChevronRight :size="13" />
      </button>
    </div>

    <div class="toolbar">
      <div class="chips">
        <button
          v-for="f in FILTERS"
          :key="f.value"
          :class="{ on: filter === f.value }"
          @click="pick(f.value)"
        >
          {{ f.label }}
        </button>
      </div>
      <label class="finder">
        <Search :size="14" />
        <input v-model="keyword" placeholder="搜索目录名" @keyup.enter="load" @blur="blurSearch" />
      </label>
    </div>

    <p v-if="loading" class="state">
      <Loader2 :size="14" class="spin" />
      读取中…
    </p>
    <p v-else-if="empty" class="state">
      还没有日志。跑一次识别后，过程就会记录在这里。
    </p>

    <ul v-else class="logs">
      <li v-for="log in logs" :key="log.id" class="log" :class="`log--${STATUS_META[log.status].tone}`">
        <button class="log__head" @click="toggle(log.id)">
          <ChevronRight :size="14" class="log__caret" :class="{ on: opened.has(log.id) }" />
          <component :is="STATUS_META[log.status].icon" :size="14" class="log__icon" />
          <span class="log__label truncate" :title="log.dir">{{ log.label }}</span>
          <span class="log__time mono">{{ formatDateTime(log.created_at) }}</span>
        </button>

        <div class="log__meta">
          <p class="log__summary">{{ log.summary || STATUS_META[log.status].label }}</p>
          <p class="log__cost mono">{{ cost(log) }}</p>
        </div>

        <div v-if="opened.has(log.id)" class="trace">
          <div class="trace__top">
            <p class="trace__dir mono truncate" :title="log.dir">{{ log.dir }}</p>
            <button class="btn btn--subtle" title="复制这条日志的完整内容" @click="copyLog(log)">
              <Clipboard :size="13" />
              复制
            </button>
          </div>

          <div v-for="round in groupRounds(log.events)" :key="round.index" class="round">
            <p class="round__no">轮次 {{ round.index }}</p>

            <template v-for="{ event, i } in round.events" :key="i">
              <div v-if="event.type === 'tool_call'" class="step step--call">
                <span class="step__arrow">→</span>
                <span class="step__tool mono">{{ event.name }}</span>
                <span class="step__arg truncate" :title="fullArgs(event.args)">
                  {{ argLine(event.name, event.args) }}
                </span>
              </div>

              <div
                v-else-if="event.type === 'tool_result'"
                class="step step--result"
                :class="{ 'step--error': event.isError }"
              >
                <pre class="step__text">{{
                  spread.has(`${log.id}:${i}`) ? event.text : preview(event.text)
                }}</pre>
                <button
                  v-if="isLong(event.text)"
                  class="step__more"
                  @click="toggleFull(`${log.id}:${i}`)"
                >
                  {{ spread.has(`${log.id}:${i}`) ? '收起' : '展开全文' }}
                </button>
              </div>

              <p v-else-if="event.type === 'text'" class="step step--say">{{ event.text }}</p>
            </template>
          </div>

          <p v-if="log.stop_reason === 'max_turns'" class="trace__stop">
            达到轮数上限，被强制结束 —— agent 当时还没下结论。
          </p>

          <div v-if="log.kind === 'unit' && log.status !== 'success'" class="trace__act">
            <button class="btn btn--ghost" @click="retry(log)">
              <RotateCcw :size="14" />
              退回待识别
            </button>
            <span class="hint">下次点「开始识别」时会重跑这个目录</span>
          </div>
        </div>
      </li>
    </ul>

    <ReportDialog v-if="openReport" :report="openReport" @close="openReport = null" />
  </section>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.sec-head h2 {
  font-size: 15px;
  font-weight: 500;
}

.sec-desc {
  font-size: var(--fs-tag);
  line-height: 1.8;
  color: var(--text-faint);
  margin-bottom: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.chips {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-btn);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.chips button {
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.chips button.on {
  background: var(--active-surface);
  color: var(--accent);
}

.finder {
  flex: 1;
  min-width: 160px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
  color: var(--text-faint);
}

.finder input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  font-size: var(--fs-tag);
  color: var(--text-main);
  font-family: inherit;
}

.state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  padding: 8px 0;
}

.logs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log {
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
  /* 状态用左边一条竖线表示，扫一眼就能找到失败的那几条 */
  border-left: 2px solid var(--text-faint);
  overflow: hidden;
}

.log--ok {
  border-left-color: var(--success);
}
.log--warn {
  border-left-color: var(--warning);
}
.log--bad {
  border-left-color: var(--danger);
}

.log__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 3px;
  text-align: left;
}

.log__caret {
  flex: none;
  color: var(--text-faint);
  transition: transform var(--t-fast) ease;
}
.log__caret.on {
  transform: rotate(90deg);
}

.log__icon {
  flex: none;
}
.log--ok .log__icon {
  color: var(--success);
}
.log--warn .log__icon {
  color: var(--warning);
}
.log--bad .log__icon {
  color: var(--danger);
}

.log__label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--text-main);
}

.log__time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.log__meta {
  padding: 0 12px 10px 42px;
}

.log__summary {
  font-size: var(--fs-tag);
  line-height: 1.7;
  color: var(--text-sub);
  word-break: break-word;
}

.log__cost {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 3px;
}

.trace {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--divider);
  background: var(--bg-side);
}

.trace__top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.trace__top .btn {
  flex: none;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
}

.trace__dir {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-faint);
}

/* ------------------------------ 历史报告 ------------------------------ */
.reports {
  margin-bottom: 16px;
  padding: 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.reports__title {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-faint);
  margin-bottom: 6px;
  padding-left: 2px;
}

.reports__row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-tag);
  color: var(--text-sub);
  font-size: var(--fs-tag);
  text-align: left;
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.reports__row:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

.reports__time {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
}

.reports__sum {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reports__cost {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.round {
  padding-left: 10px;
  border-left: 1px solid var(--divider);
  margin-bottom: 12px;
}

.round__no {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-faint);
  margin-bottom: 5px;
}

.step {
  font-size: var(--fs-tag);
  line-height: 1.7;
  margin-bottom: 5px;
}

.step--call {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.step__arrow {
  color: var(--accent);
}

.step__tool {
  flex: none;
  color: var(--accent);
}

.step__arg {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.step--result {
  padding: 6px 9px;
  border-radius: var(--radius-tag);
  background: var(--bg-main);
}

.step--error {
  background: var(--danger-bg);
}
.step--error .step__text {
  color: var(--danger);
}

.step__text {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-sub);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.step__more {
  margin-top: 4px;
  font-size: 11px;
  color: var(--accent);
}

.step--say {
  padding: 6px 9px;
  border-radius: var(--radius-tag);
  background: var(--active-surface);
  color: var(--text-main);
  white-space: pre-wrap;
  word-break: break-word;
}

.trace__stop {
  font-size: var(--fs-tag);
  line-height: 1.7;
  color: var(--warning);
  padding: 7px 10px;
  border-radius: var(--radius-tag);
  background: var(--warning-bg);
}

.trace__act {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
