<script setup lang="ts">
import type { Episode } from '@/types'
import { videoEpisodeLabel } from '@/utils/video-content'
withDefaults(defineProps<{ modelValue:string; episodes:Episode[]; notes?:boolean; withoutSeason?:boolean }>(), { notes:false, withoutSeason:false })
defineEmits<{ 'update:modelValue':[id:string] }>()
</script>
<template><div class="scope-switch" role="group" :aria-label="notes ? '选择笔记范围' : '选择简介范围'">
  <button type="button" :aria-pressed="!modelValue" @click="$emit('update:modelValue','')">{{ notes ? '作品笔记' : '作品简介' }}</button>
  <button v-for="episode in episodes" :key="episode.id" type="button" :aria-pressed="modelValue === episode.id" :title="episode.original_title || episode.title" @click="$emit('update:modelValue',episode.id)">{{ videoEpisodeLabel(episode, withoutSeason) }}</button>
</div></template>
<style scoped>
.scope-switch { display:flex; flex-wrap:wrap; gap:6px; max-width:100%; max-height:120px; overflow:auto; padding:2px; }
button { flex:none; padding:7px 10px; border:1px solid var(--card-border); border-radius:6px; background:transparent; color:var(--text-sub); font-size:12px; cursor:pointer; }
button:hover { color:var(--text-main); background:var(--bg-side); }
button[aria-pressed="true"] { color:var(--accent); border-color:var(--accent); background:color-mix(in srgb,var(--accent) 8%,transparent); }
button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
</style>
