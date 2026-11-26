<script setup lang="ts">
import { locale as appLocale } from '../../i18n/index.ts'

import { tr } from "../../i18n/index.ts"

import type { VideoOrganizeFileStatus, VideoOrganizeJournal } from '@/types/video-organize'

defineProps<{ journals: VideoOrganizeJournal[]; busy: boolean; loaded: boolean }>()
defineEmits<{ retry: [id: string]; rollback: [id: string]; refresh: [] }>()
const statusLabels: Record<VideoOrganizeJournal['status'], string> = { get running() { return tr('处理中 / 待恢复') }, get applied() { return tr('已完成') }, get partial() { return tr('部分完成') }, get 'rolled-back'() { return tr('已回退') }, get 'rollback-partial'() { return tr('部分回退') } }
const modeLabels: Record<VideoOrganizeJournal['mode'], string> = { get logical() { return tr('组建合集') }, get physical() { return tr('组建合集并整理文件') }, get rebind() { return tr('重绑目录') }, get copy() { return tr('复制整目录') } }
const fileLabels: Record<VideoOrganizeFileStatus, string> = { get pending() { return tr('待处理') }, get copying() { return tr('复制中') }, get copied() { return tr('已复制') }, get switched() { return tr('已更新位置') }, get unchanged() { return tr('保持原位置') }, get failed() { return tr('失败') }, get 'rolled-back'() { return tr('已回退') }, get retained() { return tr('保留文件') } }
const time = (value: number) => new Date(value).toLocaleString(appLocale.value, { hour12: false })
</script>

<template>
  <section class="organize-history" :aria-label="$t('整理记录')">
    <header><h3>{{ $t("整理记录") }}<span v-if="loaded">{{ $t("· {p0} 条", {p0: (journals.length)}) }}</span></h3><button type="button" class="btn btn--ghost" :disabled="busy" @click="$emit('refresh')">{{ $t("刷新记录") }}</button></header>
    <p class="organize-history__hint">{{ $t("重试会继续未完成的文件。回退恢复本次操作的资料与位置关联，保留原文件、副本和之后的用户修改；冲突会单独列出。") }}</p>
    <p v-if="!loaded && !journals.length" role="status">{{ $t("点击刷新记录，读取当前可见作品的历史。") }}</p>
    <p v-else-if="loaded && !journals.length" role="status">{{ $t("当前范围暂无可见的整理记录。") }}</p>
    <article v-for="journal in journals" :key="journal.id" class="organize-journal" :data-journal="journal.id">
      <header><h4>{{ modeLabels[journal.mode] }}</h4><strong class="organize-journal__status" :class="{ 'organize-journal__status--issue': journal.status === 'partial' || journal.status === 'rollback-partial' }">{{ statusLabels[journal.status] }}</strong></header>
      <p class="organize-path">{{ journal.targetDirectory || $t('文件保持原位置') }}</p>
      <small>{{ $t("{p0} · {p1} 部作品 · {p2} 个文件", {p0: (time(journal.updatedAt)), p1: (journal.sourceIds.length), p2: (journal.files.length)}) }}</small>
      <ul v-if="journal.warnings.length" class="organize-history__warnings"><li v-for="(warning, index) in journal.warnings" :key="index">{{ $systemMessage(warning) }}</li></ul>
      <ul v-if="journal.conflicts.length" class="organize-history__conflicts" :aria-label="$t('回退与恢复冲突')"><li v-for="(conflict, index) in journal.conflicts" :key="index">{{ conflict }}</li></ul>
      <details :open="journal.status !== 'applied' && journal.status !== 'rolled-back'">
        <summary>{{ $t("逐项文件结果 · {p0} 个失败", {p0: (journal.files.filter(file => file.status === 'failed').length)}) }}</summary>
        <ul class="organize-history__files"><li v-for="file in journal.files" :key="file.id" :data-file="file.id">
          <div><strong :class="{ failed: file.status === 'failed' }">{{ fileLabels[file.status] }}</strong><small>{{ $t("尝试 {p0} 次 · {p1}", {p0: (file.attempts), p1: (file.sourceRemoved ? $t('原文件已移除') : $t('原文件保留'))}) }}</small></div>
          <p class="organize-path">{{ $t("源：{p0}", {p0: (file.source)}) }}</p><p class="organize-path">→ {{ file.destination || $t('保持原位置') }}</p>
          <p v-if="file.error" class="failed">{{ $systemMessage(file.error) }}</p>
        </li></ul>
      </details>
      <div class="organize-history__actions">
        <button v-if="journal.canRetry" type="button" class="btn btn--ghost" :disabled="busy" @click="$emit('retry', journal.id)">{{ journal.status === 'running' ? $t('继续未完成项') : $t('重试未完成项') }}</button>
        <button v-if="journal.canRollback" type="button" class="btn btn--ghost" :disabled="busy" @click="$emit('rollback', journal.id)">{{ $t("回退本次操作") }}</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.organize-history { display: grid; gap: 14px; min-width: 0; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h3, h4 { font-size: 13px; font-weight: 600; }
p, li { font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.organize-history__hint, small { color: var(--text-sub); }
small { font-size: 11px; }
.organize-journal { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--divider); border-radius: 6px; background: var(--bg-card); }
.organize-journal__status { font-size: 12px; font-weight: 500; }
.organize-journal__status--issue, .failed { color: var(--warning); }
.organize-path { font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; }
.organize-history__warnings, .organize-history__conflicts { padding-left: 18px; margin: 0; }
.organize-history__conflicts { color: var(--warning); }
summary { font-size: 12px; cursor: pointer; padding-block: 5px; }
.organize-history__files { padding: 0; margin: 0; list-style: none; }
.organize-history__files li { display: grid; gap: 3px; padding: 8px 0; border-bottom: 1px solid var(--divider); }
.organize-history__files li > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.organize-history__actions { display: flex; flex-wrap: wrap; gap: 8px; }
:is(button, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
