<script setup lang="ts">
import {onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {X,ExternalLink,FolderOpen} from 'lucide-vue-next'
import {useVideoPreview} from '@/composables/useVideoPreview'
import {useVideoFrames} from '@/composables/useVideoFrames'
import VideoFrameStrip from './VideoFrameStrip.vue'
import { errorMessage, formatPosition } from '@/utils'
const preview=useVideoPreview(),dialog=ref<HTMLDialogElement>(),video=ref<HTMLVideoElement>(),playbackError=ref(''),notice=ref(''),playing=ref(false)
const frames=useVideoFrames(),contact=ref(false)
let timer:ReturnType<typeof setTimeout>|undefined
function unload(){clearTimeout(timer);const element=video.value;if(element){element.pause();element.removeAttribute('src');element.load()}playing.value=false}
watch(preview.session,()=>{unload();frames.stop();contact.value=false;playbackError.value='';notice.value='';if(preview.session.value)timer=setTimeout(()=>playbackError.value='视频加载超时；可用系统播放器打开或检查文件是否离线。',20000)},{flush:'pre'})
onMounted(()=>{dialog.value?.showModal();dialog.value?.querySelector<HTMLElement>('button')?.focus()})
onBeforeUnmount(unload)
function close(){unload();preview.close()}
async function showFrames(retry=false){contact.value=true;if(preview.session.value)await frames.start(preview.session.value.token,retry)}
function seek(seconds:number){if(video.value){video.value.currentTime=seconds;video.value.focus()}}
function loaded(){clearTimeout(timer);const target=video.value;if(target&&preview.startAt.value>0)target.currentTime=Math.min(preview.startAt.value,Math.max(0,target.duration-.1))}
function ready(){clearTimeout(timer)}
function failed(){clearTimeout(timer);const code=video.value?.error?.code;playbackError.value=code===2?'文件读取中断，请检查磁盘或重新打开。':code===3?'当前视频无法解码，可使用系统播放器继续。':code===4?'当前容器或音视频编码不受内嵌播放器支持。':'视频未能加载，可使用系统播放器或检查文件位置。'}
async function external(custom=false){try{if(preview.session.value)await window.baoyi.video.preview.external(preview.session.value.token,custom)}catch(e){playbackError.value=errorMessage(e)}}
async function player(){try{if(await window.baoyi.video.preview.pickPlayer())await external(true)}catch(e){playbackError.value=errorMessage(e)}}
async function copy(){try{if(preview.session.value){await window.baoyi.video.preview.copyPath(preview.session.value.token);notice.value='文件路径已复制'}}catch(e){playbackError.value=errorMessage(e)}}
async function reveal(){try{if(preview.session.value)await window.baoyi.video.preview.reveal(preview.session.value.token)}catch(e){playbackError.value=errorMessage(e)}}
</script>
<template><Teleport to="body"><dialog ref="dialog" class="video-preview" aria-label="视频试看" @cancel.prevent="close">
  <header><div><h2>{{preview.selection.value?.title||'视频试看'}}</h2><p>仅试看 · 不改变观看记录</p></div><button aria-label="关闭试看" @click="close"><X :size="20"/></button></header>
  <main>
    <label v-if="preview.selection.value&&preview.selection.value.assets.length>1" class="preview-choice">选择本地视频<select :value="preview.session.value?.asset.key||''" :disabled="preview.busy.value" @change="preview.choose(($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择集数或文件版本</option><option v-for="asset in preview.selection.value.assets" :key="asset.key" :value="asset.key">{{asset.label?asset.label+' · ':''}}{{asset.quality?asset.quality+' · ':''}}{{asset.name}}</option></select></label>
    <p v-if="preview.busy.value" role="status">正在打开所选视频…</p>
    <template v-if="preview.session.value"><p class="preview-meta">{{preview.session.value.asset.name}} · {{preview.session.value.asset.format.toUpperCase()}} <span v-if="preview.session.value.asset.duration">· {{formatPosition(preview.session.value.asset.duration)}}</span></p><video :key="preview.session.value.token" ref="video" :src="preview.session.value.url" controls muted playsinline preload="metadata" tabindex="0" @loadedmetadata="loaded" @loadeddata="ready" @playing="playing=true;ready()" @pause="playing=false" @error="failed"/><p class="preview-help">默认静音，可在播放器中开启声音。若没有声音，请检查静音状态或用系统播放器核对音轨。</p></template>
    <div v-if="preview.session.value" class="preview-frames"><button v-if="!contact" @click="showFrames()">展开代表帧</button><template v-else><VideoFrameStrip v-if="frames.state.value" :state="frames.state.value" contact @seek="seek"/><p v-if="frames.busy.value">正在准备代表帧…</p><p v-if="frames.error.value" role="alert">{{frames.error.value}}</p><button v-if="frames.state.value?.status==='failed'||frames.error.value" @click="showFrames(true)">重新生成预览帧</button><button @click="frames.stop();contact=false">收起代表帧</button></template></div>
    <p v-if="preview.error.value||playbackError" class="preview-error" role="alert">{{preview.error.value||playbackError}}</p><p v-if="notice" role="status">{{notice}}</p>
  </main>
  <footer v-if="preview.session.value"><button @click="external()"><ExternalLink :size="15"/>系统播放器</button><button @click="player">选择 PotPlayer / VLC</button><button @click="external(true)">使用已选播放器</button><button @click="copy">复制路径</button><button @click="reveal"><FolderOpen :size="15"/>在文件夹中显示</button></footer>
</dialog></Teleport></template>
<style scoped>
.video-preview{position:fixed;inset:0 0 0 auto;margin:0;width:min(760px,100vw);max-width:100vw;height:100%;max-height:100%;box-sizing:border-box;padding:0;border:0;border-left:1px solid var(--divider);background:var(--bg-main);color:var(--text-main);box-shadow:var(--shadow-pop)}.video-preview::backdrop{background:#0007}.video-preview header{display:flex;align-items:flex-start;justify-content:space-between;padding:24px;gap:20px;border-bottom:1px solid var(--divider)}.video-preview h2{font-size:19px;line-height:1.5;margin:0;overflow-wrap:anywhere}.video-preview header p,.preview-meta,.preview-help{font-size:12px;color:var(--text-sub);line-height:1.8;overflow-wrap:anywhere}.video-preview main{padding:24px}.video-preview video{display:block;width:100%;max-height:60vh;background:#111;aspect-ratio:16/9}.video-preview button{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border-radius:5px;background:var(--hover-surface);color:var(--text-main);border:1px solid var(--divider);cursor:pointer}.video-preview footer{display:flex;flex-wrap:wrap;gap:8px;padding:0 24px 24px}.preview-choice{display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:16px}.preview-choice select{max-width:100%;padding:8px;background:var(--bg-main);color:var(--text-main);border:1px solid var(--divider)}.preview-error{color:var(--danger,#d66);line-height:1.8;font-size:13px}@media(max-width:900px){.video-preview{width:100vw}}
</style>
