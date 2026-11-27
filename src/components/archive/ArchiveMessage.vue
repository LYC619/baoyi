<script lang="ts">
let lastCopyAnnouncement = ''
</script>

<script setup lang="ts">
import { systemMessage, tr } from '../../i18n/index.ts'

import { computed, onBeforeUnmount, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Check, ChevronRight, Copy, FileText, LoaderCircle, TriangleAlert } from 'lucide-vue-next'
import type { LiveBlock } from '@/composables/useArchiveAssistant'

const props = defineProps<{ block: LiveBlock }>()
const emit = defineEmits<{ source: [id: string] }>()

const copyBtn = ref<HTMLButtonElement | null>(null)
const copyTip = ref<HTMLSpanElement | null>(null)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | undefined

function reportCopy(ok: boolean): void {
  const btn = copyBtn.value
  const tip = copyTip.value
  clearTimeout(copyTimer)
  copyState.value = 'idle'
  btn?.removeAttribute('data-copied')
  btn?.removeAttribute('data-failed')
  let message = ok ? tr('已复制') : tr('复制失败')
  if (message === lastCopyAnnouncement) message += '\u00A0'
  lastCopyAnnouncement = message
  if (tip) tip.textContent = ''
  if (btn) void btn.offsetWidth
  copyState.value = ok ? 'copied' : 'failed'
  btn?.setAttribute(ok ? 'data-copied' : 'data-failed', '')
  requestAnimationFrame(() => {
    if (tip) tip.textContent = message
  })
  copyTimer = setTimeout(() => {
    copyState.value = 'idle'
    btn?.removeAttribute('data-copied')
    btn?.removeAttribute('data-failed')
    if (tip) tip.textContent = ''
  }, 2000)
}

async function copyReply(): Promise<void> {
  const text = (props.block.text || '').trim()
  if (!text) return
  try {
    if (window.baoyi?.app?.copyText) {
      await window.baoyi.app.copyText(text)
    } else {
      await navigator.clipboard.writeText(text)
    }
    reportCopy(true)
  } catch {
    reportCopy(false)
  }
}

onBeforeUnmount(() => {
  clearTimeout(copyTimer)
})

const names: Record<string, string> = {
  get archive_result() { return tr("续读归档结果") },
  get archive_search() { return tr("查找归档") },
  get archive_get() { return tr("读取资料信息") },
  get archive_catalog() { return tr("查看分类") },
  get archive_web_search() { return tr("检索公开信息") },
  get archive_create_category() { return tr("建立归档分类") },
  get archive_read() { return tr("阅读原文") },
  get archive_search_text() { return tr("检索正文") },
  get archive_project_files() { return tr("查看项目文件") },
  get archive_project_search() { return tr("搜索项目内容") },
  get archive_update() { return tr("保存整理结果") },
  get archive_create_personal() { return tr("新增个人记录") },
  get archive_check() { return tr("核验文件") },
  get archive_locate() { return tr("寻找原文件") },
  get archive_relocate() { return tr("修复位置") },
  get archive_organize() { return tr("整理文件") },
  get archive_actions() { return tr("查阅修改记录") },
  get archive_undo() { return tr("撤销修改") },
  get archive_link() { return tr("处理资源关联") },
  get archive_skill() { return tr("处理技能记录") },
  get archive_history() { return tr("查找旧对话") },
  get memory() { return tr("维护记忆") },
  get todo_list() { return tr("更新任务进度") },
  get session_search() { return tr("找回历史") },
  get skill_manage() { return tr("保存归档方法") },
  get skill_view() { return tr("读取归档方法") },
  get skills_list() { return tr("查找归档方法") }
}

const result = computed(() => {
  try {
    return JSON.parse(props.block.result || 'null')
  } catch {
    return null
  }
})
const failure = computed(() => result.value?.error)
const sources = computed(() => {
  const value = result.value
  const items = Array.isArray(value)
    ? value
    : value?.items || value?.matches || [value?.resource || value?.source || value]
  return items.filter((x: any) => x?.id && x?.kind && x?.name).slice(0, 20)
})
const KIND_LABELS: Record<string, string> = {
  get software() { return tr('软件') },
  get game() { return tr('游戏') },
  get video() { return tr('影视') },
  get image() { return tr('图片') },
  get document() { return tr('文库') },
  get project() { return tr('项目') },
  get personal() { return tr('个人') }
}
const tasks = computed(() => result.value?.todos || [])
const summary = computed(
  () =>
    (failure.value ? systemMessage(failure.value) : '') ||
    (result.value?.reason ? systemMessage(result.value.reason) : '') ||
    (typeof result.value?.changed === 'number' ? tr("已保存 {p0} 项", {p0: (result.value.changed)}) : '') ||
    (typeof result.value?.succeeded === 'number'
      ? result.value.failed ? tr('完成 {p0} 项，{p1} 项待处理', { p0: result.value.succeeded, p1: result.value.failed }) : tr('完成 {p0} 项', { p0: result.value.succeeded })
      : '') ||
    (typeof result.value?.total === 'number'
      ? result.value.next !== null && result.value.next !== undefined ? tr('共 {p0} 项，还有后续结果', { p0: result.value.total }) : tr('共 {p0} 项', { p0: result.value.total })
      : '') ||
    (props.block.pending ? tr("正在处理") : tr("已完成"))
)
const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.block.text || '', { async: false }) as string, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
    FORBID_ATTR: ['style', 'src'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|baoyi):|#)/i
  })
)

function follow(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (href.startsWith('baoyi://resource/')) {
    emit('source', decodeURIComponent(href.slice(17).split(/[?#]/)[0]))
  } else if (/^https?:\/\//.test(href)) {
    window.open(href, '_blank')
  }
}
</script>

<template>
  <article v-if="block.role !== 'tool'" class="archive-message" :class="block.role">
    <div class="msg-head">
      <span class="speaker">{{ block.role === 'user' ? $t('你') : $t('抱一') }}</span>
      <span v-if="block.role === 'assistant' && block.text" class="copy-wrap">
        <button
          ref="copyBtn"
          type="button"
          class="copy-button"
          :aria-label="$t('复制这条回复')"
          @click="copyReply"
        >
          <Check v-if="copyState === 'copied'" :size="13" aria-hidden="true" />
          <Copy v-else :size="13" aria-hidden="true" />
        </button>
        <span ref="copyTip" class="copy-tip" role="status"></span>
      </span>
    </div>
    <div v-if="block.role === 'user'" class="user-text">{{ block.text }}</div>
    <div v-else class="prose" v-html="html" @click="follow" />
  </article>
  <details v-else class="archive-tool" :class="{ failed: failure }">
    <summary>
      <LoaderCircle v-if="block.pending" class="spin" :size="13" />
      <TriangleAlert v-else-if="failure" :size="13" />
      <Check v-else :size="13" />
      <span>{{ names[block.name || ''] || $t('处理归档') }}</span>
      <small>{{ summary }}</small>
      <ChevronRight class="chevron" :size="13" />
    </summary>
    <div class="tool-body">
      <ol v-if="tasks.length" class="tasks">
        <li v-for="task in tasks" :key="task.id" :class="task.status">
          <Check v-if="task.status === 'completed'" :size="13" />
          <span v-else class="task-dot" />
          {{ task.content || task.text || task.title }}
        </li>
      </ol>
      <button v-for="item in sources" :key="item.id" class="source-row" @click="emit('source', item.id)">
        <FileText :size="14" />
        <span>{{ item.name }}</span>
        <small>{{ item.page ? $t('第 {p0} 页', {p0: item.page}) : (KIND_LABELS[item.kind] || item.kind) }}</small>
      </button>
      <p v-if="result?.text" class="source-text">{{ result.text }}</p>
      <p v-if="failure" role="alert">{{ $systemMessage(failure) }}</p>
      <p v-if="result?.unread?.length">
        {{ $t("{p0} 份未能读取：{p1}", {p0: (result.unread.length), p1: (result.unread.map((x: any) => $locale === 'en' ? `${x.name} (${$systemMessage(x.reason)})` : `${x.name}（${$systemMessage(x.reason)}）`).join($locale === 'en' ? '; ' : '；'))}) }}
      </p>
      <details class="raw">
        <summary>{{ $t("查看操作明细") }}</summary>
        <pre>{{ JSON.stringify(result || block.args, null, 2) }}</pre>
      </details>
    </div>
  </details>
</template>

<style scoped>
.archive-message {
  padding: 20px 0;
  line-height: 1.8;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.msg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.speaker {
  display: block;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.copy-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 24px;
  min-block-size: 24px;
  padding: 3px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.copy-button:hover,
.copy-button:focus-visible {
  color: var(--text-main);
  background: var(--hover-surface);
  border-color: var(--divider);
}

.copy-button[data-copied] {
  color: var(--success);
}

.copy-button[data-failed] {
  color: var(--danger);
}

.copy-tip {
  font-size: 11px;
  color: var(--text-sub);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  transition: opacity 0.15s ease;
}

.copy-button[data-copied] + .copy-tip,
.copy-button[data-failed] + .copy-tip {
  opacity: 1;
}

@media (hover: hover) {
  .copy-button {
    opacity: 0;
  }
  .archive-message:hover .copy-button,
  .archive-message:focus-within .copy-button,
  .copy-button:focus-visible,
  .copy-button[data-copied],
  .copy-button[data-failed] {
    opacity: 1;
  }
}

.user {
  padding: 16px 18px;
  background: var(--active-surface);
  border-radius: 12px;
  margin: 16px 0;
}

.user .speaker {
  color: var(--accent);
}

.user-text {
  white-space: pre-wrap;
}

.prose :deep(p) {
  margin: 0 0 12px;
}

.prose :deep(p:last-child) {
  margin-bottom: 0;
}

.prose :deep(ul),
.prose :deep(ol) {
  padding-left: 24px;
}

.prose :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.prose :deep(pre) {
  white-space: pre-wrap;
  background: var(--bg-main);
  padding: 12px;
  border: 1px solid var(--divider);
  border-radius: 8px;
}

.prose :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}

.prose :deep(td),
.prose :deep(th) {
  padding: 6px;
  border-bottom: 1px solid var(--divider);
  text-align: left;
}

.prose :deep(blockquote) {
  border-left: 2px solid var(--accent);
  margin: 12px 0;
  padding-left: 14px;
  color: var(--text-sub);
}

.archive-tool {
  margin: 6px 0;
  border: 1px solid var(--divider);
  border-radius: 9px;
  font-size: 12px;
}

.archive-tool > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 10px 12px;
  color: var(--text-sub);
  list-style: none;
}

.archive-tool > summary > span {
  color: var(--text-main);
}

.archive-tool small {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.archive-tool[open] .chevron {
  transform: rotate(90deg);
}

.tool-body {
  padding: 0 12px 12px;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 0;
  border: 0;
  border-bottom: 1px solid var(--divider);
  background: none;
  color: var(--text-main);
  text-align: left;
  cursor: pointer;
}

.source-row > span {
  flex: 1;
}

.source-text {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
  color: var(--text-sub);
}

.raw {
  margin-top: 10px;
  color: var(--text-muted);
}

.raw summary {
  cursor: pointer;
}

.raw pre {
  font-size: 11px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
}

.tasks {
  list-style: none;
  padding: 0;
}

.tasks li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 0;
}

.tasks .completed {
  color: var(--text-muted);
}

.tasks .in_progress {
  color: var(--accent);
}

.task-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid currentColor;
}

.failed {
  border-color: var(--danger, #bc685b);
}

.spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .copy-button,
  .copy-tip {
    transition: opacity 0.1s linear;
  }
  .spin {
    animation: none;
  }
}
</style>
