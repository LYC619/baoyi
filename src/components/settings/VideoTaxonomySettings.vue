<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { computed, onMounted, ref } from 'vue'
import { useVideoStore } from '@/stores/video'
import type { VideoTaxonomy } from '@/types/video-taxonomy'
import '@/styles/workspace.css'
const props = defineProps<{ section: 'groups' | 'tags'; hentai: boolean }>()
const emit = defineEmits<{ updated: [] }>()
const data = ref<VideoTaxonomy>({ groups: [], tags: [], works: [] }), selected = ref<string[]>([]), name = ref(''), error = ref(''), message = ref(''), busy = ref(false)
const store = useVideoStore(), label = computed(() => props.section === 'groups' ? tr('分组') : tr('标签'))
async function load() { data.value = await window.baoyi.video.taxonomy(props.hentai) }
onMounted(() => void load().catch(cause => { error.value = errorMessage(cause) }))
async function edit(from: string | null, to: string | null) {
  if (busy.value || (to !== null && (!to.trim() || from === to.trim()))) return
  if (from !== null && !(await confirmDialog({ title: to === null ? tr("移除{p0}「{p1}」？", {p0: (label.value), p1: (from || tr('未分组'))}) : tr("修改{p0}「{p1}」？", {p0: (label.value), p1: (from || tr('未分组'))}), message: to === null ? tr("作品记录与本地原文件均会保留。") : tr("将改为「{p0}」，同名{p1}会自动合并。", {p0: (to), p1: (label.value)}), confirmText: to === null ? tr("确认移除") : tr("确认修改"), tone: to === null ? 'danger' : 'default' }))) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const count = await window.baoyi.video.editTaxonomy({ hentai: props.hentai, field: props.section, from, to, ...(from === null ? { ids: [...selected.value] } : {}) })
    if ((store.selection.kind === 'tag' || store.selection.kind === 'collection') && store.selection.value === from && store.inHentaiScope === props.hentai) store.select({ kind: 'group', value: 'all' })
    await load(); await store.reload(); message.value = tr("已更新 {p0} 个作品", {p0: (count)}); name.value = ''; emit('updated')
  } catch (cause) { error.value = errorMessage(cause) } finally { busy.value = false }
}
</script>
<template>
  <section class="ws ws-card">
    <h2>{{ hentai ? $t('里番') : $t('影视') }}{{ label }}</h2><p class="ws-muted">{{ $t("仅管理{p0}，包含已归档作品。{p1}", {p0: (hentai ? $t('里番区') : $t('普通影视')), p1: (section === 'tags' ? $t('标签修改同时更新作品、来源标签与分集标签。') : $t('分组不移动磁盘文件；删除分组后作品回到未分组。'))}) }}</p>
    <p v-if="error" class="ws-error" role="alert">{{ $systemMessage(error) }}</p><p v-if="message" role="status">{{ message }}</p>
    <div v-for="row in data[section]" :key="row.name" class="manage-row">
      <input :value="row.name" :placeholder="$t('未分组')" :aria-label="$t('重命名{p0} {p1}', {p0: label, p1: row.name || $t('未分组')})" :disabled="busy" @change="edit(row.name, ($event.target as HTMLInputElement).value)" />
      <span>{{ $t("{p0} 个作品", {p0: (row.count)}) }}</span><button class="ws-button" :disabled="busy || !row.name" @click="edit(row.name, null)">{{ $t("删除") }}</button>
    </div>
    <p v-if="!data[section].length" class="ws-muted">{{ $t("暂无{p0}。", {p0: (label)}) }}</p>
    <h3>{{ $t("为作品指定{p0}", {p0: (label)}) }}</h3><p class="ws-muted">{{ $t("选择作品后输入新{p0}或已有名称。", {p0: (label)}) }}</p>
    <div class="works"><label v-for="work in data.works" :key="work.id"><input v-model="selected" type="checkbox" :value="work.id" :disabled="busy" />{{ work.name }}</label></div>
    <div class="ws-toolbar"><input v-model="name" :placeholder="$t('{p0}名称', {p0: label})" :aria-label="$t('{p0}名称', {p0: label})" maxlength="80" :disabled="busy" /><button class="ws-button primary" :disabled="busy || !selected.length || !name.trim()" @click="edit(null, name)">{{ $t("应用到所选（{p0}）", {p0: (selected.length)}) }}</button></div>
  </section>
</template>
<style scoped>h2{font-size:18px;margin:0 0 12px}h3{margin-top:28px}.manage-row{display:flex;gap:10px;align-items:center;margin:12px 0}.manage-row input{min-width:0;flex:1}.manage-row span{color:var(--text-faint)}.works{max-height:260px;overflow:auto;margin:16px 0}.works label{display:flex;gap:8px;padding:6px 0}</style>
