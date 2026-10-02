<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X, Heart, Play, Download, ExternalLink, FolderOpen } from 'lucide-vue-next'
import type { DiscoveryCard, DiscoveryMark } from '@/types/video-discovery'
import DiscoveryPoster from './DiscoveryPoster.vue'
const props = defineProps<{ sourceId: string; sourceName: string; card: DiscoveryCard; busy: boolean; loading?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; mark: [patch: Partial<DiscoveryMark>]; play: []; page: []; download: []; local: [] }>()
const panel = ref<HTMLElement | null>(null), notes = ref(props.card.mark.notes)
let previousFocus: HTMLElement | null = null
watch(() => props.card.mark.notes, value => { notes.value = value })
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); emit('close') }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { previousFocus = document.activeElement as HTMLElement | null; document.addEventListener('keydown', keydown); await nextTick(); panel.value?.querySelector('button')?.focus() })
onBeforeUnmount(() => { document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus() })
</script>
<template>
  <Teleport to="body">
    <div class="discovery-detail-overlay" @click.self="emit('close')">
      <section ref="panel" class="discovery-detail" role="dialog" aria-modal="true" aria-labelledby="discovery-detail-title">
        <button class="detail-close btn btn--ghost" aria-label="关闭作品详情" @click="emit('close')"><X :size="20" /></button>
        <div class="detail-cover"><DiscoveryPoster :source-id="sourceId" :entry-id="card.entry.id" :title="card.entry.title" :cover-url="card.entry.coverUrl" /></div>
        <div class="detail-body">
          <p class="eyebrow">{{ sourceName }}<span v-if="card.entry.code"> · {{ card.entry.code }}</span></p>
          <h2 id="discovery-detail-title">{{ card.entry.title }}</h2>
          <p v-if="error" class="detail-error" role="alert">{{ error }}</p>
          <p class="detail-facts"><span v-if="card.entry.year">{{ card.entry.year }}</span><span v-if="card.entry.rating">来源评分 {{ Number(card.entry.rating.value.toFixed(1)) }} / {{ card.entry.rating.scale }} · {{ card.entry.rating.votes }} 人</span><span v-if="card.resourceId" class="owned">本地已收录</span></p>
          <div class="detail-tags"><span v-for="tag in card.entry.tags" :key="tag">{{ tag }}</span></div>
          <div class="detail-actions">
            <button class="btn btn--primary" :disabled="loading || (!card.entry.mediaUrl && !card.entry.playUrl && !card.entry.pageUrl && !card.entry.code)" @click="emit('play')"><Play :size="15" />观看</button>
            <button class="btn btn--subtle" :disabled="loading || (!card.entry.downloads.length && !card.entry.code)" @click="emit('download')"><Download :size="15" />下载保存</button>
            <button class="btn btn--ghost" :aria-pressed="card.mark.favorite" :disabled="busy" @click="emit('mark', { favorite: !card.mark.favorite })"><Heart :size="16" :fill="card.mark.favorite ? 'currentColor' : 'none'" />{{ card.mark.favorite ? '已收藏' : '收藏' }}</button>
          </div>
          <p v-if="loading" class="detail-hint" role="status">正在补齐作品详情和可用文件…</p>
          <p v-else-if="!card.entry.downloads.length && card.entry.code" class="detail-hint">在线片源将在下载时按番号自动解析（需要本机已安装 FFmpeg）。</p>
          <p v-else-if="!card.entry.downloads.length" class="detail-hint">此来源未提供可下载文件。</p>
          <p class="description">{{ card.entry.description || '来源暂未提供简介。' }}</p>
          <ul v-if="card.entry.rankings.length" class="detail-rankings"><li v-for="(ranking, index) in card.entry.rankings" :key="index"><strong>#{{ ranking.position }}</strong><span>{{ ranking.name }}<small>{{ ranking.source }}{{ ranking.period ? ' · ' + ranking.period : '' }}</small></span></li></ul>
          <div class="personal-state">
            <label>我的评分<select class="select" aria-label="我的评分" :value="card.mark.userRating" :disabled="busy" @change="emit('mark', { userRating: Number(($event.target as HTMLSelectElement).value) })"><option :value="0">未评分</option><option v-for="score in 5" :key="score" :value="score">{{ score }} 星</option></select></label>
            <button class="btn btn--ghost" :aria-pressed="card.mark.watched" :disabled="busy" @click="emit('mark', { watched: !card.mark.watched })">{{ card.mark.watched ? '已看过' : '标记看过' }}</button>
          </div>
          <label class="notes">我的备注<textarea v-model="notes" class="input" rows="3" maxlength="4000" placeholder="记下你的想法" @blur="notes !== card.mark.notes && emit('mark', { notes })" /></label>
          <div class="detail-links"><button class="btn btn--ghost" :disabled="!card.entry.pageUrl && !card.entry.playUrl" @click="emit('page')"><ExternalLink :size="14" />来源页面</button><button v-if="card.resourceId" class="btn btn--ghost" @click="emit('local')"><FolderOpen :size="14" />查看本地作品</button></div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.discovery-detail-overlay { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 26px; background: var(--overlay); -webkit-app-region: no-drag; }
.discovery-detail { position: relative; display: grid; grid-template-columns: minmax(160px, 30%) 1fr; width: min(960px, 100%); max-height: calc(100dvh - 52px); overflow-y: auto; gap: 28px; padding: 32px; border: 1px solid var(--divider); background: var(--bg-main); border-radius: 16px; box-shadow: var(--shadow-pop); }
.detail-close { position: absolute; right: 9px; top: 9px; z-index: 1; }
.detail-error { margin: 14px 0; padding: 10px 12px; background: var(--danger-bg); color: var(--danger); font-size: 12px; border-radius: 6px; overflow-wrap: anywhere; }
.detail-cover { align-self: start; padding-top: 8px; }
.detail-body { min-width: 0; }.eyebrow { color: var(--text-sub); font-size: 12px; margin-bottom: 10px; padding-right: 20px; overflow-wrap: anywhere; }
h2 { font-family: var(--font-display); font-weight: 500; font-size: 29px; line-height: 1.4; overflow-wrap: anywhere; }
.detail-facts { display: flex; gap: 12px; flex-wrap: wrap; color: var(--text-sub); font-size: 12px; margin: 14px 0; }.owned { color: var(--success); }
.detail-tags,.detail-actions,.personal-state,.detail-links { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.detail-tags span { padding: 4px 8px; border: 1px solid var(--divider); border-radius: 4px; color: var(--text-sub); font-size: 11px; }.detail-actions { margin: 22px 0 16px; }
.description { white-space: pre-wrap; line-height: 1.9; color: var(--text-sub); font-size: 13px; margin: 18px 0; overflow-wrap: anywhere; }
.detail-hint { color: var(--text-faint); font-size: 12px; }.detail-rankings { list-style: none; display: flex; flex-wrap: wrap; gap: 10px; padding: 0; margin: 18px 0; }
.detail-rankings li { display: flex; gap: 10px; padding: 10px 13px; background: var(--bg-card); border-radius: 8px; font-size: 12px; }.detail-rankings strong { color: var(--warning); font-size: 20px; }.detail-rankings small { display: block; color: var(--text-sub); margin-top: 3px; }
.personal-state { margin: 22px 0 14px; border-top: 1px solid var(--divider); padding-top: 18px; }.personal-state label { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.personal-state .select { padding: 7px 10px; border: 1px solid var(--divider); border-radius: 6px; background: var(--bg-card); color: var(--text-main); }
.notes { display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--text-sub); }.notes textarea { width: 100%; resize: vertical; min-height: 70px; line-height: 1.7; }.detail-links { margin-top: 14px; }
@media(max-width: 720px) { .discovery-detail { padding: 25px 18px; gap: 18px; grid-template-columns: 120px 1fr; } h2 { font-size: 23px; } }
@media(max-width: 500px) { .discovery-detail { display: block; }.detail-cover { width: 120px; margin-bottom: 16px; } }
</style>
