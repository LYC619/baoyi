<script setup lang="ts">
import { ref } from 'vue'
import { FolderOpen, X, Archive } from 'lucide-vue-next'
import type { ImageImportPreview, ImageType } from '@/types/image'
import { useImageStore } from '@/stores/image'
const props = defineProps<{ type: ImageType }>()
const emit = defineEmits<{ close: [] }>()
const store = useImageStore(), mode = ref('single'), busy = ref(false), error = ref('')
const preview = ref<ImageImportPreview | null>(null), selected = ref<number[]>([])
async function choose() {
  busy.value=true; error.value=''
  try {
    const result = await window.baoyi.image.prepareImport(props.type,mode.value==='multiple',mode.value==='archive')
    if (result) { preview.value=result; selected.value=result.items.filter(i=>i.pages>0).map(i=>i.index) }
  } catch(cause) { error.value=(cause as Error).message } finally { busy.value=false }
}
async function confirm() {
  if (!preview.value) return
  busy.value=true; error.value=''
  try {
    const result = await window.baoyi.image.confirmImport(preview.value.token,preview.value.items.filter(i=>selected.value.includes(i.index)).map(i=>({index:i.index,name:i.name})))
    await store.refresh()
    if (result.errors.length) { error.value=`已导入 ${result.imported} 项；${result.errors.join('；')}`; preview.value=null }
    else emit('close')
  } catch(cause) { error.value=(cause as Error).message } finally { busy.value=false }
}
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="!busy && emit('close')"><section class="im-dialog" role="dialog" aria-modal="true" aria-label="导入图片" @keydown.esc="!busy && emit('close')">
  <header><div><h2>导入{{ type==='comic'?'漫画':'相册' }}</h2><p>保留原文件位置，确认后加入本地资料库。</p></div><button class="im-icon" aria-label="关闭导入" :disabled="busy" @click="emit('close')"><X :size="20" /></button></header>
  <template v-if="!preview"><label class="im-field">导入方式<select v-model="mode"><option value="single">一个{{ type==='comic'?'漫画作品':'相册文件夹' }}</option><option value="multiple">父目录中的多个{{ type==='comic'?'作品':'相册' }}</option><option value="archive">ZIP／CBZ 归档</option></select></label>
    <div class="im-import-help"><Archive v-if="mode==='archive'" :size="34"/><FolderOpen v-else :size="34"/><p>{{ mode==='multiple' ? '每个子文件夹作为一张卡片。' : type==='comic' ? '作品内的子文件夹或 CBZ 作为章节，页码按自然顺序排列。' : '文件夹里的照片合并为一个相册。' }}</p><small>支持 JPG、PNG、WebP、GIF、BMP、AVIF；归档支持 ZIP／CBZ。</small></div>
  </template>
  <div v-else class="im-preview"><p>{{ preview.items.length }} 个候选 · 已选 {{ selected.length }} 个</p><article v-for="item in preview.items" :key="item.index"><input v-model="selected" type="checkbox" :value="item.index" :disabled="!item.pages" :aria-label="`导入 ${item.name}`"/><div><input v-model="item.name" aria-label="导入名称"/><small>{{ item.pages }} 页 <template v-if="item.chapters">· {{ item.chapters }} 章</template> · {{ item.path }}</small><p v-for="warning in item.warnings" :key="warning" class="im-warning">{{ warning }}</p></div></article><p v-if="!preview.items.length">此目录没有可导入的相册或漫画。</p></div>
  <p v-if="error" class="im-error" role="alert">{{ error }}</p><footer><button v-if="preview" class="im-button" :disabled="busy" @click="preview=null">重新选择</button><button class="im-button im-primary" :disabled="busy || (!!preview && !selected.length)" @click="preview?confirm():choose()">{{ busy?'正在处理…':preview?'确认导入':'选择文件'+(mode==='archive'?'':'夹') }}</button></footer>
</section></div></Teleport></template>
