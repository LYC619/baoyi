<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { errorMessage } from '@/utils'
import { onMounted, ref } from 'vue'
import { FolderOpen, X, Archive } from 'lucide-vue-next'
import type { ImageImportPreview, ImageType } from '@/types/image'
import { useImageStore } from '@/stores/image'
const props = defineProps<{ type: ImageType; initialPaths?: string[] }>()
const emit = defineEmits<{ close: [] }>()
const store = useImageStore(), mode = ref('single'), busy = ref(false), error = ref('')
const folderCategories=ref(props.type!=='comic')
const preview = ref<ImageImportPreview | null>(null), selected = ref<number[]>([])
async function choose(droppedPaths?: string[]) {
  busy.value=true; error.value=''
  try {
    if (droppedPaths?.length && droppedPaths.every((p) => /\.(zip|cbz)$/i.test(p))) mode.value = 'archive'
    const result = await window.baoyi.image.prepareImport(props.type,mode.value==='multiple',mode.value==='archive',droppedPaths)
    if (result) { preview.value=result; selected.value=result.items.filter(i=>i.pages>0).map(i=>i.index) }
  } catch(cause) { error.value=errorMessage(cause) } finally { busy.value=false }
}
onMounted(() => { if (props.initialPaths?.length) void choose(props.initialPaths) })
async function confirm() {
  if (!preview.value) return
  busy.value=true; error.value=''
  try {
    const result = await window.baoyi.image.confirmImport(preview.value.token,preview.value.items.filter(i=>selected.value.includes(i.index)).map(i=>({index:i.index,name:i.name})),folderCategories.value)
    await store.refresh()
    if (result.errors.length) { error.value=tr("已导入 {p0} 项；{p1}", {p0: (result.imported), p1: (result.errors.join('；'))}); preview.value=null }
    else emit('close')
  } catch(cause) { error.value=errorMessage(cause) } finally { busy.value=false }
}
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="!busy && emit('close')"><section class="im-dialog" role="dialog" aria-modal="true" :aria-label="$t('导入图片')" @keydown.esc="!busy && emit('close')">
  <header><div><h2>{{ $t("导入{p0}", {p0: (type==='comic'?$t('漫画'):type==='misc'?$t('杂图'):$t('照片'))}) }}</h2><p>{{ $t("保留原文件位置，确认后加入本地资料库。") }}</p></div><button class="im-icon" :aria-label="$t('关闭导入')" :disabled="busy" @click="emit('close')"><X :size="20" /></button></header>
  <template v-if="!preview"><label class="im-field">{{ $t("导入方式") }}<select v-model="mode"><option value="single">{{ $t("一个{p0}", {p0: (type==='comic'?$t('漫画作品'):$t('图片文件夹'))}) }}</option><option value="multiple">{{ $t("父目录中的多个{p0}", {p0: (type==='comic'?$t('作品'):$t('组合'))}) }}</option><option value="archive">{{ $t("ZIP／CBZ 归档") }}</option></select></label><label v-if="type!=='comic'"><input v-model="folderCategories" type="checkbox"/>{{ $t("按每个导入文件夹建立分类并记住目录（保留已有分类）") }}</label>
    <div class="im-import-help"><Archive v-if="mode==='archive'" :size="34"/><FolderOpen v-else :size="34"/><p>{{ mode==='multiple' ? $t('每个子文件夹作为一张卡片。') : type==='comic' ? $t('作品内的子文件夹或 CBZ 作为章节，页码按自然顺序排列。') : $t('文件夹里的照片合并为一个相册。') }}</p><small>{{ $t("支持 JPG、PNG、WebP、GIF、BMP、AVIF；归档支持 ZIP／CBZ。") }}</small></div>
  </template>
  <div v-else class="im-preview"><p>{{ $t("{p0} 个候选 · 已选 {p1} 个", {p0: (preview.items.length), p1: (selected.length)}) }}</p><article v-for="item in preview.items" :key="item.index"><input v-model="selected" type="checkbox" :value="item.index" :disabled="!item.pages" :aria-label="$t('导入 {p0}', {p0: item.name})"/><div><input v-model="item.name" :aria-label="$t('导入名称')"/><small>{{ $t("{p0} 页", {p0: (item.pages)}) }}<template v-if="item.chapters">{{ $t("· {p0} 章", {p0: (item.chapters)}) }}</template> · {{ item.path }}</small><p v-for="warning in item.warnings" :key="warning" class="im-warning">{{ $systemMessage(warning) }}</p></div></article><p v-if="!preview.items.length">{{ $t("此目录没有可导入的相册或漫画。") }}</p></div>
  <p v-if="error" class="im-error" role="alert">{{ $systemMessage(error) }}</p><footer><button v-if="preview" class="im-button" :disabled="busy" @click="preview=null">{{ $t("重新选择") }}</button><button class="im-button im-primary" :disabled="busy || (!!preview && !selected.length)" @click="preview?confirm():choose()">{{ busy?$t('正在处理…'):preview?$t('确认导入'):$t('选择文件')+(mode==='archive'?'':$t('夹')) }}</button></footer>
</section></div></Teleport></template>
