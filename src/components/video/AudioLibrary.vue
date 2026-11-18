<script setup lang="ts">
import {ref,watch,onBeforeUnmount} from 'vue'
import {Music2,Play,Pause,ArrowUpRight,Loader2} from 'lucide-vue-next'
import {useAudioStore} from '@/stores/audio'
import {audioTracks,type AudioTrack} from '@/utils/audio'
import {posterUrl,formatPosition} from '@/utils'
import type {VideoItem} from '@/types'
const props=defineProps<{items:VideoItem[];view:'cards'|'list'}>()
const emit=defineEmits<{open:[item:VideoItem,episode?:string]}>(),audio=useAudioStore()
const tracks=ref<AudioTrack[]>([]),failure=ref(''),loading=ref(false),broken=ref(new Set<string>())
let revision=0
async function load(){
  const round=++revision;failure.value='';tracks.value=[];loading.value=true
  const items=[...props.items],rows:AudioTrack[]=[]
  for(let start=0;start<items.length;start+=4){
    const batch=await Promise.all(items.slice(start,start+4).map(async item=>{try{return audioTracks(item,await window.baoyi.video.library(item.id))}catch{if(round===revision)failure.value='部分曲目暂时无法读取，请重试';return []}}))
    if(round!==revision)return
    rows.push(...batch.flat())
  }
  if(round===revision){tracks.value=rows;loading.value=false}
}
watch(()=>props.items,load,{immediate:true})
onBeforeUnmount(()=>revision++)
const title=(item:VideoItem)=>item.name_zh||item.file_name
function play(track:AudioTrack){void audio.play(track,tracks.value)}
function playAlbum(item:VideoItem){const own=tracks.value.filter(t=>t.resource.id===item.id&&t.available!==false);const track=own.find(t=>t.id===audio.current?.id)||own[0];if(track)void audio.play(track,own)}
</script>
<template>
  <section class="audio-library" aria-label="我的音频">
    <header><div class="audio-disc"><Music2 :size="32"/></div><div><span class="audio-eyebrow">音乐 · 播客 · 有声书</span><h2>我的音频</h2><p>{{items.length}} 个专辑或文件夹 · {{loading?'正在读取曲目…':tracks.length+' 首曲目'}}</p></div></header>
    <p v-if="failure" class="audio-error" role="alert">{{failure}} <button class="btn btn--ghost" @click="load">重试</button></p>
    <p v-if="!items.length" class="audio-empty">选择「找音乐」在线搜索试听，或「导入音频」添加本地专辑、播客和有声书。</p>
    <div v-else-if="view==='cards'" class="audio-cards">
      <article v-for="item in items" :key="item.id" class="audio-card" :class="{current:audio.current?.resource.id===item.id}">
        <div class="audio-card-art">
          <button class="audio-card-open" :aria-label="'查看音频 '+title(item)" @click="emit('open',item)"><img v-if="posterUrl(item.poster_path)&&!broken.has(item.id)" :src="posterUrl(item.poster_path,item.updated_at)" :alt="title(item)" loading="lazy" @error="broken.add(item.id)"/><span v-else class="audio-cover-fallback"><Music2 :size="38"/><small>{{title(item).slice(0,1)}}</small></span></button>
          <button class="audio-card-play" :aria-label="(audio.current?.resource.id===item.id&&audio.playing?'暂停 ':'播放 ')+title(item)" :disabled="loading||!tracks.some(t=>t.resource.id===item.id&&t.available!==false)" @click="playAlbum(item)"><Loader2 v-if="loading" :size="18" class="spin"/><Pause v-else-if="audio.current?.resource.id===item.id&&audio.playing" :size="19"/><Play v-else :size="19"/></button>
        </div>
        <button class="audio-card-title audio-name" @click="emit('open',item)">{{title(item)}}</button>
        <p>{{item.tags.slice(0,2).join(' · ')||item.category||'音频'}}<span>{{item.episode_total||1}} 首</span></p>
      </article>
    </div>
    <div v-else class="audio-table">
      <div class="audio-row audio-head"><span>#</span><span>曲目</span><span>专辑 / 文件夹</span><span>时长</span><span/></div>
      <div v-for="(track,i) in tracks" :key="track.id" class="audio-row" :class="{current:audio.current?.id===track.id}">
        <button :aria-label="(audio.current?.id===track.id&&audio.playing?'暂停 ':'播放 ')+track.title" :disabled="track.available===false" @click="play(track)"><Pause v-if="audio.current?.id===track.id&&audio.playing" :size="15"/><Play v-else-if="audio.current?.id===track.id" :size="15"/><span v-else>{{i+1}}</span></button>
        <button class="audio-name" @click="emit('open',track.resource,track.episode)">{{track.title}}<small v-if="track.available===false">文件缺失</small></button>
        <button class="audio-album" @click="emit('open',track.resource)">{{title(track.resource)}}</button><span>{{formatPosition(track.duration)||'—'}}</span>
        <button :aria-label="'查看 '+track.title" @click="emit('open',track.resource,track.episode)"><ArrowUpRight :size="16"/></button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.audio-library{padding:10px 6px 32px}.audio-library>header{display:flex;gap:22px;align-items:center;margin-bottom:28px}.audio-disc{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;border:12px double var(--divider);background:var(--active-surface);color:var(--accent)}.audio-eyebrow{font-size:11px;letter-spacing:2px;color:var(--text-sub)}.audio-library h2{font-size:27px;margin:8px 0}.audio-library p{font-size:12px;color:var(--text-sub)}.audio-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-min,190px),1fr));gap:28px 22px}.audio-card{min-width:0}.audio-card-art{position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--active-surface)}.audio-card-open{width:100%;height:100%;display:block}.audio-card-art img{width:100%;height:100%;object-fit:cover;transition:transform .2s}.audio-card-open:hover img{transform:scale(1.035)}.audio-cover-fallback{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;height:100%;color:var(--accent);background:radial-gradient(circle at 50% 44%,transparent 27%,var(--divider) 28%,transparent 29%,transparent 37%,var(--divider) 38%,transparent 39%)}.audio-cover-fallback small{font-size:15px}.audio-card-play{position:absolute;right:12px;bottom:12px;border-radius:50%;width:40px;height:40px;background:var(--bg-card);color:var(--accent);display:grid;place-items:center;box-shadow:0 3px 12px #0002}.audio-card-play:disabled{opacity:.5}.audio-card-title{font-size:14px;font-weight:600;display:block;margin-top:12px;max-width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.audio-card p{display:flex;justify-content:space-between;gap:8px;margin-top:7px}.audio-card p span{white-space:nowrap;color:var(--text-faint)}.audio-card.current .audio-card-title{color:var(--accent)}.audio-table{border-top:1px solid var(--divider)}.audio-row{display:grid;grid-template-columns:35px minmax(0,2fr) minmax(0,1fr) 65px 30px;align-items:center;gap:15px;padding:13px 10px;border-bottom:1px solid var(--divider);font-size:13px}.audio-row.current{background:var(--active-surface);color:var(--accent)}.audio-row button{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.audio-row button:disabled{opacity:.4}.audio-head{font-size:11px;color:var(--text-faint)}.audio-album,.audio-row>span{color:var(--text-sub)}.audio-name{font-weight:500}.audio-name small{display:block;font-size:11px;color:var(--text-faint);margin-top:4px}.audio-error{color:var(--danger)!important}.audio-library button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@media(max-width:800px){.audio-row{grid-template-columns:28px minmax(0,1fr) 48px 24px;gap:8px}.audio-album,.audio-head>span:nth-child(3){display:none}.audio-cards{grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr))}}
</style>
