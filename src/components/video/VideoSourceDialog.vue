<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { VideoItem } from '@/types'
import type { VideoWorkContent } from '@/types/video-workflow'
import { errorMessage } from '@/utils'
const props = defineProps<{ item: VideoItem; episodes: VideoWorkContent[]; episodeId?: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), busy = ref(false), failure = ref('')
const episode = ref(props.episodeId || (props.episodes.length === 1 ? props.episodes[0].id : ''))
const query = ref(props.episodes.find(e => e.id === props.episodeId)?.original_title || props.item.name_en || props.item.name_zh)
const source = ref(''), hits = ref<Array<{ videoCode: string; title: string; coverUrl: string }>>([])
const searched = ref(false)
onMounted(() => dialog.value?.showModal())
async function search() {
  busy.value = true; failure.value = ''
  try { hits.value = await window.baoyi.video.searchSource(query.value); searched.value = true }
  catch (e) { failure.value = errorMessage(e) } finally { busy.value = false }
}
async function bind(code: string) {
  if (props.episodes.length > 1 && !episode.value) { failure.value = '先选择这一来源对应的本地单集'; return }
  busy.value = true; failure.value = ''
  try {
    const result = await window.baoyi.video.scrapeEpisode(props.item.id, episode.value, code)
    emit('changed')
    if (result.warnings.length) failure.value = '来源与资料已保存；' + result.warnings.join('；')
    else emit('close')
  } catch (e) { failure.value = errorMessage(e) } finally { busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="video-source" aria-labelledby="video-source-title" @cancel.prevent="!busy && emit('close')">
    <header><h2 id="video-source-title">匹配单集来源</h2><button class="btn btn--ghost" :disabled="busy" @click="emit('close')">关闭</button></header>
    <p>选择对应的视频后，会保存这一集的简介、标签与图片，供后续下载和补集使用。</p>
    <label v-if="episodes.length > 1">本地单集<select v-model="episode" class="input" :disabled="busy"><option value="">请选择对应的一集</option><option v-for="e in episodes" :key="e.id" :value="e.id">{{ e.title || e.original_title }}</option></select></label>
    <form @submit.prevent="search"><label>作品名<input v-model="query" class="input" maxlength="240" :disabled="busy" /></label><button class="btn btn--primary" :disabled="busy || !query.trim()">{{ busy ? '正在读取…' : '搜索来源' }}</button></form>
    <ul v-if="hits.length"><li v-for="hit in hits" :key="hit.videoCode"><span>{{ hit.title }}<small>Hanime · {{ hit.videoCode }}</small></span><button class="btn btn--subtle" :disabled="busy" @click="bind(hit.videoCode)">选用并刮削</button></li></ul>
    <p v-else-if="searched && !busy">没有找到匹配结果，可修改片名或直接填写链接。</p>
    <form @submit.prevent="bind(source)"><label>视频链接或来源编号<input v-model="source" class="input" placeholder="https://hanime1.me/watch?v=…" :disabled="busy" /></label><button class="btn btn--subtle" :disabled="busy || !source.trim()">绑定并刮削</button></form>
    <p v-if="failure" class="failure" role="alert">{{ failure }}</p>
  </dialog>
</template>
<style scoped>
.video-source{width:min(680px,90vw);max-height:85vh;overflow:auto;padding:24px;border:1px solid var(--card-border);border-radius:12px;background:var(--bg-card);color:var(--text-main)}
.video-source::backdrop{background:#0009}header,form,li{display:flex;align-items:center;gap:12px;justify-content:space-between}header{margin-bottom:14px}h2{font-size:18px}p{line-height:1.7;color:var(--text-muted);margin:12px 0}form{margin-top:18px;align-items:flex-end}label{display:grid;gap:7px;flex:1}small{display:block;color:var(--text-faint)}ul{list-style:none;padding:0;max-height:260px;overflow:auto}li{padding:12px 0;border-bottom:1px solid var(--card-border)}.failure{color:var(--danger,#d66)}
</style>
