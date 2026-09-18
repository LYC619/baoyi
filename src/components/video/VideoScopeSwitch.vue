<script setup lang="ts">
import { computed } from 'vue'
import type { Episode } from '@/types'
import { videoEpisodeLabel, videoSeasonLabel } from '@/utils/video-content'
const props = withDefaults(defineProps<{ modelValue:string; episodes:Episode[]; notes?:boolean; withoutSeason?:boolean }>(), { notes:false, withoutSeason:false })
defineEmits<{ 'update:modelValue':[id:string] }>()
// 有分部 / 分季时按 season 分段显示，段首一个小标题；全是 season 0 时不分段
const groups = computed(() => {
  const seasons = [...new Set(props.episodes.map(episode => episode.season))].sort((a, b) => a - b)
  if (seasons.length <= 1 && !seasons.some(season => season > 0)) return [{ season: 0, label: '', episodes: props.episodes }]
  return seasons.map(season => ({ season, label: videoSeasonLabel(season, props.withoutSeason) || (props.withoutSeason ? '未分部' : '未分季'), episodes: props.episodes.filter(episode => episode.season === season) }))
})
</script>
<template><div class="scope-switch" role="group" :aria-label="notes ? '选择笔记范围' : '选择简介范围'">
  <button type="button" :aria-pressed="!modelValue" @click="$emit('update:modelValue','')">{{ notes ? '作品笔记' : '作品简介' }}</button>
  <template v-for="group in groups" :key="group.season">
    <span v-if="group.label" class="scope-switch__season">{{ group.label }}</span>
    <button v-for="episode in group.episodes" :key="episode.id" type="button" :aria-pressed="modelValue === episode.id" :title="episode.original_title || episode.title" @click="$emit('update:modelValue',episode.id)">{{ group.label ? '第 ' + episode.episode + ' 集' : videoEpisodeLabel(episode, withoutSeason) }}</button>
  </template>
</div></template>
<style scoped>
.scope-switch { display:flex; flex-wrap:wrap; align-items:center; gap:6px; max-width:100%; max-height:120px; overflow:auto; padding:2px; }
.scope-switch__season { flex:none; padding:0 4px; color:var(--text-faint); font-size:11px; }
.scope-switch__season:not(:first-of-type) { margin-left:6px; }
button { flex:none; padding:7px 10px; border:1px solid var(--card-border); border-radius:6px; background:transparent; color:var(--text-sub); font-size:12px; cursor:pointer; }
button:hover { color:var(--text-main); background:var(--bg-side); }
button[aria-pressed="true"] { color:var(--accent); border-color:var(--accent); background:color-mix(in srgb,var(--accent) 8%,transparent); }
button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
</style>
