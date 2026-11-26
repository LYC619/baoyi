<script setup lang="ts">
import {computed,ref} from 'vue'
import type {VideoFrameState} from '@/types/video-preview'
import {formatPosition} from '@/utils'
const props=defineProps<{state:VideoFrameState;contact?:boolean}>(),emit=defineEmits<{seek:[seconds:number]}>(),index=ref(0)
const current=computed(()=>Math.min(index.value,Math.max(0,props.state.times.length-1)))
const sprite=(i:number)=>({backgroundImage:`url("${props.state.url}")`,backgroundSize:'600% 400%',backgroundPosition:`${(i%6)*20}% ${Math.floor(i/6)*100/3}%`})
</script>
<template><div class="video-frame-strip"><template v-if="state.url">
  <div v-if="contact" class="frame-contact"><button v-for="(seconds,i) in state.times" :key="seconds" :aria-label="$t('从 ')+(formatPosition(seconds)||'0:00')+$t(' 试看')" @click="emit('seek',seconds)"><span :style="sprite(i)"/><small>{{(formatPosition(seconds)||'0:00')}}</small></button></div>
  <template v-else><div class="frame-single" :style="sprite(current)"/><input v-model.number="index" type="range" min="0" :max="state.times.length-1" step="1" :aria-label="$t('预览时间')"/><button @click="emit('seek',state.times[current])">{{ $t("从 {p0} 试看", {p0: ((formatPosition(state.times[current])||'0:00'))}) }}</button></template>
  <p>{{ $t("{p0} 张代表帧", {p0: (state.times.length)}) }}<span v-if="state.partial">{{ $t("· 部分预览：{p0}", {p0: (state.message)}) }}</span><span v-if="state.audioTracks===0">{{ $t("· 无音轨") }}</span></p>
  </template><p v-else role="status">{{state.status==='failed'?state.message:state.status==='queued'?$t('等待生成预览帧'):$t('正在生成预览帧（已完成 {p0} 张）', {p0: state.completed})}}</p></div></template>
<style scoped>.video-frame-strip{font-size:12px;line-height:1.7;color:var(--text-sub)}.frame-single{width:100%;aspect-ratio:16/9;background-color:#111}.frame-contact{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.frame-contact button{padding:0;text-align:left;border:1px solid var(--divider);border-radius:4px;overflow:hidden}.frame-contact span{display:block;width:100%;aspect-ratio:16/9;background-color:#111}.frame-contact small{padding:3px 6px;display:block}.video-frame-strip input{width:100%}.video-frame-strip p{margin:8px 0;overflow-wrap:anywhere}.video-frame-strip>button{border:1px solid var(--divider);padding:5px 8px;border-radius:5px}@media(max-width:600px){.frame-contact{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>
