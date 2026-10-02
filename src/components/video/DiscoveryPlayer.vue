<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Download, ExternalLink, X } from 'lucide-vue-next'
import type { DiscoveryCard } from '@/types/video-discovery'
defineProps<{ card: DiscoveryCard; busy: boolean; error?: string }>()
const emit = defineEmits<{ close: []; download: []; page: [] }>()
const panel = ref<HTMLElement | null>(null), video = ref<HTMLVideoElement | null>(null), playbackError = ref('')
let previousFocus: HTMLElement | null = null
function stop() { if (video.value) { video.value.pause(); video.value.removeAttribute('src'); video.value.load() } }
function close() { stop(); emit('close') }
function download() { stop(); emit('download') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); close() }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),video')]
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { previousFocus = document.activeElement as HTMLElement | null; document.addEventListener('keydown', keydown); await nextTick(); panel.value?.querySelector('button')?.focus() })
onBeforeUnmount(() => { stop(); document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus() })
</script>
<template>
  <Teleport to="body">
    <div class="discovery-player-overlay" @click.self="close">
      <section ref="panel" class="discovery-player" role="dialog" aria-modal="true" aria-labelledby="discovery-player-title">
        <header><div><p>正在观看</p><h2 id="discovery-player-title">{{ card.entry.title }}</h2></div><button class="btn btn--primary" :disabled="busy || !card.entry.downloads.length" @click="download"><Download :size="16" />下载保存</button><button class="btn btn--ghost" aria-label="关闭播放器" @click="close"><X :size="20" /></button></header>
        <p v-if="busy" class="player-message" role="status">正在读取播放资料…</p>
        <video v-else-if="card.entry.mediaUrl" ref="video" :src="card.entry.mediaUrl" controls autoplay playsinline tabindex="0" @error="playbackError = '视频暂时无法播放，可能是来源限制或当前格式不受支持。可尝试下载保存或打开来源页面。'" />
        <div v-else class="player-empty"><p>此作品未提供可内置播放的媒体文件。</p><p>可以打开来源页面继续观看。</p></div>
        <footer><p v-if="error || playbackError" class="player-error" role="alert">{{ playbackError || error }}</p><button class="btn btn--ghost" :disabled="!card.entry.pageUrl && !card.entry.playUrl" @click="stop(); emit('page')"><ExternalLink :size="14" />打开来源页面</button></footer>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.discovery-player-overlay { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 26px; background: var(--overlay); -webkit-app-region: no-drag; }
.discovery-player { width: min(1100px, 100%); max-height: calc(100dvh - 52px); overflow-y: auto; border: 1px solid var(--divider); border-radius: 14px; background: var(--bg-main); color: var(--text-main); box-shadow: var(--shadow-pop); }
header { display: flex; align-items: center; gap: 14px; padding: 18px 22px; }header > div { flex: 1; min-width: 0; }header p { font-size: 11px; color: var(--text-sub); margin-bottom: 5px; }h2 { font-family: var(--font-display); font-weight: 500; font-size: 22px; overflow-wrap: anywhere; }header button { flex-shrink: 0; }
video { display: block; width: 100%; max-height: calc(100dvh - 240px); min-height: 180px; background: #000; }footer { padding: 12px 22px; }.player-message,.player-empty { padding: 65px 24px; text-align: center; color: var(--text-sub); font-size: 14px; line-height: 2; }.player-empty p + p { font-size: 12px; color: var(--text-faint); }.player-error { color: var(--danger); font-size: 12px; line-height: 1.7; margin-bottom: 8px; overflow-wrap: anywhere; }
@media(max-width: 700px) { .discovery-player-overlay { padding: 12px; }header { flex-wrap: wrap; padding: 16px; }header > div { flex-basis: 55%; }h2 { font-size: 19px; } }
</style>
