<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref} from 'vue'
import {Play} from 'lucide-vue-next'
import {formatPosition} from '@/utils'
import type {VideoFrameState} from '@/types/video-preview'
const props=defineProps<{anchor:HTMLElement;closing?:boolean;state:VideoFrameState|null;message:string;label:string;position:number}>()
const emit=defineEmits<{enter:[];leave:[];close:[];seek:[number];play:[];open:[]}>()
const box=ref({left:0,top:0,width:320}),root=ref<HTMLElement>()
function place(){const a=props.anchor.getBoundingClientRect(),width=Math.min(320,window.innerWidth-24),height=width*9/16+48;box.value={width,left:Math.max(12,Math.min(window.innerWidth-width-12,a.left+(a.width-width)/2)),top:Math.max(48,Math.min(window.innerHeight-height-12,a.top>=height+60?a.top-height-8:a.bottom+8))}}
const frameIndex=computed(()=>{const times=props.state?.times||[],target=props.position*(props.state?.duration||0);return Math.max(0,times.reduce((best,time,index)=>Math.abs(time-target)<Math.abs(times[best]-target)?index:best,0))})
const frameStyle=computed(()=>({backgroundImage:`url("${props.state?.url||''}")`,backgroundSize:'600% 400%',backgroundPosition:`${frameIndex.value%6*20}% ${Math.floor(frameIndex.value/6)*100/3}%`}))
let animation=0,pendingPosition=0
function move(event:PointerEvent){const b=(event.currentTarget as HTMLElement).getBoundingClientRect();pendingPosition=Math.min(1,Math.max(0,(event.clientX-b.left)/b.width));if(!animation)animation=requestAnimationFrame(()=>{animation=0;emit('seek',pendingPosition)})}
function key(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();emit('close')}else if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();emit('seek',event.key==='Home'?0:event.key==='End'?1:Math.min(1,Math.max(0,props.position+(event.key==='ArrowRight'?.05:-.05))))}}
const close=()=>emit('close')
onMounted(()=>{place();window.addEventListener('resize',close);window.addEventListener('scroll',close,true)})
onBeforeUnmount(()=>{cancelAnimationFrame(animation);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true)})
</script>
<template>
  <Teleport to="body"><section ref="root" class="video-hover" :class="{closing}" :style="{left:box.left+'px',top:box.top+'px',width:box.width+'px'}" :aria-label="$t('视频悬浮预览')" @pointerenter="emit('enter')" @pointerleave="emit('leave')" @focusin="emit('enter')" @focusout="!root?.contains($event.relatedTarget as Node)&&emit('leave')" @keydown="key">
    <button class="video-hover-picture" :style="state?.url?frameStyle:{}" :aria-label="$t('打开视频详情')" @pointermove="move" @click="emit('open')"><span v-if="!state?.url" role="status">{{message||state?.message||$t('正在准备预览帧…')}}</span></button>
    <div class="video-hover-track" role="slider" tabindex="0" :aria-label="$t('预览时间')" :aria-valuenow="Math.round(position*(state?.duration||0))" :aria-valuemin="0" :aria-valuemax="state?.duration||0" @pointermove="move"><i :style="{width:position*100+'%'}"/></div>
    <footer><span :title="label">{{label||$t('本地视频')}}</span><time>{{formatPosition(state?.times[frameIndex]||0)||'0:00'}} / {{formatPosition(state?.duration||0)||'0:00'}}</time><button :aria-label="$t('从当前帧试看')" @click="emit('play')"><Play :size="15"/></button></footer>
  </section></Teleport>
</template>
<style scoped>
.video-hover{position:fixed;z-index:90;overflow:hidden;border:1px solid #ffffff24;border-radius:10px;background:#17191c;color:#fff;box-shadow:0 12px 36px #0005;animation:preview-in .14s ease-out}.video-hover.closing{opacity:0;transition:opacity .12s ease}.video-hover-picture{display:block;position:relative;width:100%;aspect-ratio:16/9;background-color:#121416;border:0;padding:0;background-repeat:no-repeat;color:#ddd}.video-hover-picture span{display:block;padding:20px;font-size:12px;line-height:1.7}.video-hover-track{height:5px;background:#ffffff24;cursor:ew-resize}.video-hover-track i{display:block;height:100%;background:var(--accent)}.video-hover footer{display:flex;align-items:center;gap:12px;min-height:39px;padding:4px 10px;font-size:11px}.video-hover footer>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c4c6ca}.video-hover time{font-variant-numeric:tabular-nums}.video-hover footer button{display:grid;place-items:center;width:28px;height:28px;border-radius:5px;color:#fff}.video-hover footer button:hover{background:#ffffff20}.video-hover :focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@keyframes preview-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.video-hover{animation:none}}
</style>
