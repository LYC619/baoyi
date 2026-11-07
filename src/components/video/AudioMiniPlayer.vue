<script setup lang="ts">
import {onBeforeUnmount,ref,watch} from 'vue'
import {useDockBoundary} from '@/composables/useFloatingDock'
import {useRouter} from 'vue-router'
import {Music2,Play,Pause,SkipBack,SkipForward,X} from 'lucide-vue-next'
import {useAudioStore} from '@/stores/audio'
import {formatPosition} from '@/utils'
const audio=useAudioStore(),router=useRouter(),player=ref<HTMLAudioElement>()
const bar=ref<HTMLElement>()
useDockBoundary(bar,'footer',()=>!!audio.current)
watch(player,value=>audio.attach(value||null))
onBeforeUnmount(()=>{audio.close();audio.attach(null)})
</script>
<template>
  <section ref="bar" v-if="audio.current" class="audio-mini" aria-label="全局音频播放器">
    <Music2 :size="23"/>
    <button class="audio-mini-title" :title="audio.current.title" @click="router.push('/video/'+audio.current.resource.id)"><strong>{{audio.current.title}}</strong><small>{{[audio.music?.artist,audio.music?.album].filter(Boolean).join(' · ')||audio.current.resource.name_zh||audio.current.resource.file_name}}</small></button>
    <button aria-label="上一曲" :disabled="!audio.hasPrevious" @click="audio.next(-1)"><SkipBack :size="17"/></button>
    <button :aria-label="audio.playing?'暂停音频':'播放音频'" @click="audio.toggle"><Pause v-if="audio.playing" :size="20"/><Play v-else :size="20"/></button>
    <button aria-label="下一曲" :disabled="!audio.hasNext" @click="audio.next()"><SkipForward :size="17"/></button>
    <input type="range" aria-label="音频播放进度" min="0" :max="audio.duration||0" step="0.1" :value="audio.position" @input="audio.seek(Number(($event.target as HTMLInputElement).value))"/>
    <span class="audio-mini-time">{{formatPosition(audio.position)||'0:00'}} / {{formatPosition(audio.duration)||'0:00'}}</span>
    <button aria-label="关闭音频播放器" @click="audio.close"><X :size="18"/></button>
    <audio ref="player" :src="audio.source" preload="metadata" @loadedmetadata="audio.loaded" @timeupdate="audio.position=player?.currentTime||0" @play="audio.playing=true" @pause="audio.playing=false" @ended="audio.next()" @error="audio.failure='此文件无法内置播放，可在详情中使用系统播放器打开。'"/>
    <p v-if="audio.failure" class="audio-mini-error" role="alert">{{audio.failure}}</p>
  </section>
</template>
<style scoped>
.audio-mini{position:relative;z-index:70;flex-shrink:0;min-height:66px;display:flex;align-items:center;gap:12px;padding:10px 24px;border-top:1px solid var(--divider);background:var(--bg-card);color:var(--text-main)}.audio-mini button{display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:6px;border-radius:6px}.audio-mini button:disabled{opacity:.35}.audio-mini button:hover:not(:disabled){background:var(--hover-surface)}.audio-mini .audio-mini-title{display:grid;gap:4px;text-align:left;justify-content:start;min-width:80px;max-width:260px;flex:1}.audio-mini-title strong,.audio-mini-title small{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.audio-mini-title strong{font-size:13px}.audio-mini-title small,.audio-mini-time{font-size:11px;color:var(--text-sub)}.audio-mini input{min-width:60px;flex:1;accent-color:var(--accent)}.audio-mini-error{position:absolute;bottom:100%;left:16px;background:var(--bg-card);color:var(--danger);font-size:12px;padding:10px}.audio-mini :focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:800px){.audio-mini{padding:8px 12px;gap:6px}.audio-mini>svg,.audio-mini-time{display:none}.audio-mini .audio-mini-title{max-width:170px}}
</style>
