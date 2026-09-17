<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, FolderOpen, Loader2, X } from 'lucide-vue-next'
import type { VideoItem } from '@/types'
import { errorMessage, videoTitle } from '@/utils'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ item: VideoItem }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const { success, toast } = useToast()
const dialog = ref<HTMLDialogElement | null>(null)
const name = ref(videoTitle(props.item))
const preview = ref<{ title: string; from: string; to: string } | null>(null)
const busy = ref(false), checking = ref(false), failure = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let request = 0, disposed = false
const canSave = computed(() => !!preview.value && preview.value.title === name.value.trim() && !checking.value && !busy.value)
watch(name, () => { preview.value = null; schedulePreview() })
function schedulePreview(): void {
  clearTimeout(timer)
  const round = ++request
  checking.value = true
  timer = setTimeout(async () => {
    try {
      const result = await window.baoyi.video.previewCollectionName(props.item.id, name.value.trim())
      if (round !== request || disposed) return
      preview.value = result; failure.value = ''
    } catch (error) { if (round === request && !disposed) failure.value = errorMessage(error) }
    finally { if (round === request && !disposed) checking.value = false }
  }, 180)
}
async function save(): Promise<void> {
  if (!canSave.value) return
  busy.value = true
  try {
    const result = await window.baoyi.video.renameCollection(props.item.id, name.value.trim())
    if (result.warnings.length) toast('合集已更名；' + result.warnings[0])
    else success('合集名称与目录已同步更新')
    emit('changed'); emit('close')
  } catch (error) { failure.value = errorMessage(error) }
  finally { busy.value = false }
}
onMounted(async () => { dialog.value?.showModal(); await nextTick(); dialog.value?.querySelector('input')?.select(); schedulePreview() })
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); request++; dialog.value?.close() })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="collection-name" aria-labelledby="collection-name-title" @cancel.prevent="!busy && emit('close')" @click="($event.target === dialog && !busy) && emit('close')">
      <form @submit.prevent="save">
        <header><div><h2 id="collection-name-title">修改合集名称</h2><p>合集标题、文件夹和本地资料一起更新。</p></div><button type="button" :disabled="busy" aria-label="关闭更名窗口" @click="emit('close')"><X :size="18" /></button></header>
        <label class="collection-name__field">合集名称<input v-model="name" class="input" maxlength="240" :disabled="busy" aria-label="合集名称" /></label>
        <div v-if="preview" class="collection-name__preview" aria-label="目录更名预览"><p><FolderOpen :size="15" /><span>{{ preview.from }}</span></p><ArrowDown :size="16" /><p><FolderOpen :size="15" /><strong>{{ preview.to }}</strong></p></div>
        <p v-else-if="checking" class="collection-name__checking">正在检查目录…</p>
        <p v-if="failure" class="collection-name__error" role="alert">{{ failure }}</p>
        <footer><button type="button" class="btn btn--ghost" :disabled="busy" @click="emit('close')">取消</button><button type="submit" class="btn btn--primary" :disabled="!canSave"><Loader2 v-if="busy" class="spin" :size="14" />{{ busy ? '正在更名…' : '保存名称并更名目录' }}</button></footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.collection-name { width: min(540px, calc(100vw - 36px)); margin: auto; border: 1px solid var(--divider); border-radius: 12px; background: var(--bg-elevated); color: var(--text-main); padding: 23px; box-shadow: var(--shadow-pop); }
.collection-name::backdrop { background: rgba(10, 10, 20, .55); }
.collection-name form { display: flex; flex-direction: column; gap: 20px; }
.collection-name header { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.collection-name header button { color: var(--text-sub); padding: 3px; }
.collection-name h2 { font-size: 17px; font-weight: 600; }
.collection-name header p { margin-top: 7px; color: var(--text-sub); font-size: 12px; }
.collection-name__field { display: grid; gap: 8px; font-size: 12px; color: var(--text-sub); }
.collection-name__preview { padding: 14px; display: grid; gap: 10px; background: var(--bg-main); border-radius: 7px; font-size: 12px; color: var(--text-sub); }
.collection-name__preview p { display: flex; align-items: start; gap: 9px; line-height: 1.65; overflow-wrap: anywhere; }
.collection-name__preview svg { flex: none; margin-top: 3px; }
.collection-name__preview strong { font-weight: 500; color: var(--text-main); }
.collection-name__checking { color: var(--text-sub); font-size: 12px; }
.collection-name__error { color: var(--danger); font-size: 12px; line-height: 1.7; }
.collection-name footer { display: flex; justify-content: flex-end; gap: 8px; }
.collection-name :is(button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
