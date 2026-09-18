<script setup lang="ts">
/** 从单集的封面 / 预览图里挑一张当作品封面（B1）。图是主进程按路径放行的，这里只列出来点一下 */
import { computed, onMounted, ref } from 'vue'
import type { VideoItem } from '@/types'
import type { VideoWorkContent } from '@/types/video-workflow'
import { errorMessage, posterUrl } from '@/utils'
import { videoEpisodeLabel } from '@/utils/video-content'
const props = withDefaults(defineProps<{ item: VideoItem; episodes: VideoWorkContent[]; withoutSeason?: boolean }>(), { withoutSeason: false })
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), busy = ref(''), failure = ref('')
const choices = computed(() => props.episodes.flatMap(episode => (['poster', 'thumbnail'] as const)
  .filter(role => episode[role === 'poster' ? 'poster_path' : 'thumbnail_path'])
  .map(role => ({ key: episode.id + ':' + role, episodeId: episode.id, role, path: episode[role === 'poster' ? 'poster_path' : 'thumbnail_path']!,
    label: videoEpisodeLabel(episode, props.withoutSeason) + (role === 'poster' ? ' · 封面' : ' · 预览图'), title: episode.title || episode.original_title || '' }))))
onMounted(() => dialog.value?.showModal())
async function choose(choice: (typeof choices.value)[number]) {
  if (busy.value) return
  busy.value = choice.key; failure.value = ''
  try {
    const result = await window.baoyi.video.useEpisodeArtwork(props.item.id, choice.episodeId, choice.role)
    if (!result.ok) { failure.value = result.message; return }
    emit('changed'); emit('close')
  } catch (e) { failure.value = errorMessage(e) } finally { busy.value = '' }
}
</script>
<template>
  <dialog ref="dialog" class="episode-artwork-dialog" aria-labelledby="episode-artwork-title" @cancel.prevent="!busy && emit('close')">
    <header><h2 id="episode-artwork-title">从单集选封面</h2><button class="btn btn--ghost" :disabled="!!busy" @click="emit('close')">关闭</button></header>
    <p>点一张图就换成作品封面；换过的封面会记为你亲手选的，重扫和补封面不会再改它。</p>
    <ul v-if="choices.length" class="choices" aria-label="单集图片">
      <li v-for="choice in choices" :key="choice.key">
        <button type="button" class="choice" :class="'choice--' + choice.role" :disabled="!!busy" :aria-label="'用' + choice.label + '作为作品封面'" @click="choose(choice)">
          <img :src="posterUrl(choice.path)" :alt="choice.label" loading="lazy" />
          <span class="choice__label">{{ choice.label }}</span>
          <span v-if="choice.title" class="choice__title">{{ choice.title }}</span>
        </button>
      </li>
    </ul>
    <p v-else>这部作品的单集还没有封面或预览图。</p>
    <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
  </dialog>
</template>
<style scoped>
.episode-artwork-dialog { width: min(760px, 92vw); max-height: 86vh; overflow: auto; padding: 24px; border: 1px solid var(--card-border); border-radius: 12px; background: var(--bg-card); color: var(--text-main); }
.episode-artwork-dialog::backdrop { background: #0009; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
h2 { font-size: 18px; }
p { line-height: 1.7; color: var(--text-sub); font-size: var(--fs-tag); }
.choices { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.choice { display: grid; gap: 6px; width: 100%; padding: 8px; border: 1px solid var(--card-border); border-radius: 8px; background: var(--bg-side); text-align: left; cursor: pointer; }
.choice:hover:not(:disabled) { border-color: var(--accent); }
.choice:disabled { opacity: .5; cursor: default; }
.choice img { width: 100%; height: 150px; object-fit: contain; border-radius: 5px; background: var(--bg-main); }
.choice__label { font-size: 12px; color: var(--text-main); }
.choice__title { font-size: 11px; color: var(--text-sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.failure { color: var(--danger); }
</style>
