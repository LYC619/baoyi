<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ImagePageInfo } from '@/types/image'
import { formatBytes } from '@/utils'

const props = defineProps<{ pageId: string }>()
const info = ref<ImagePageInfo | null>(null), failed = ref(false)
let revision = 0
watch(() => props.pageId, async id => {
  const current = ++revision
  info.value = null; failed.value = false
  if (!id) return
  try { const result = await window.baoyi.image.pageInfo(id); if (current === revision) info.value = result }
  catch { if (current === revision) failed.value = true }
}, { immediate: true })
onBeforeUnmount(() => { revision++ })
</script>

<template>
  <output class="page-metadata" aria-label="当前图片规格" aria-live="polite">
    <template v-if="info">{{ info.width }} × {{ info.height }} · {{ info.format }}<br />{{ formatBytes(info.size) }}</template>
    <template v-else>{{ failed ? '规格不可用' : '读取规格中' }}</template>
  </output>
</template>

<style scoped>
.page-metadata { flex: 0 1 180px; min-width: 105px; color: #b9b9c8; font-size: 11px; line-height: 1.4; text-align: center; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
