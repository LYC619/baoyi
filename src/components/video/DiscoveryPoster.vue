<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Film } from 'lucide-vue-next'
import { posterUrl } from '@/utils'
const props = defineProps<{ sourceId: string; entryId: string; title: string; coverUrl: string }>()
const root = ref<HTMLElement | null>(null), localPath = ref(''), visible = ref(false), failed = ref(false)
let observer: IntersectionObserver | undefined, revision = 0
const url = computed(() => posterUrl(localPath.value))
async function load() {
  const current = ++revision; localPath.value = ''; failed.value = false
  if (!visible.value || !props.coverUrl) return
  try {
    const value = await window.baoyi.video.discovery.artwork({ sourceId: props.sourceId, entryId: props.entryId })
    if (current === revision) { localPath.value = value; failed.value = !value }
  } catch { if (current === revision) failed.value = true }
}
onMounted(() => {
  observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer?.disconnect(); void load() } }, { rootMargin: '160px' })
  if (root.value) observer.observe(root.value)
})
watch(() => [props.sourceId, props.entryId, props.coverUrl], load)
onBeforeUnmount(() => { revision++; observer?.disconnect() })
</script>
<template>
  <div ref="root" class="discovery-poster">
    <img v-if="url && !failed" :src="url" :alt="title + '封面'" @error="failed = true" />
    <div v-else class="discovery-poster__fallback"><Film :size="28" :stroke-width="1" /><span>{{ title }}</span><small v-if="failed">封面暂不可用</small></div>
    <slot />
  </div>
</template>
<style scoped>
.discovery-poster { position: relative; aspect-ratio: 2 / 3; overflow: hidden; background: var(--bg-side); border-radius: var(--radius-input); }
img { width: 100%; height: 100%; object-fit: contain; display: block; }
.discovery-poster__fallback { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 22px; color: var(--text-sub); text-align: center; background: linear-gradient(150deg, var(--bg-card-hover), var(--bg-side)); }
.discovery-poster__fallback span { font-family: var(--font-display); font-size: 19px; line-height: 1.6; overflow-wrap: anywhere; }
small { font-size: 11px; color: var(--text-faint); }
</style>
