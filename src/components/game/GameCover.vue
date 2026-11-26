<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {GameItem} from '@/types'
import {coverUrl,gameTitle} from '@/utils'
const props=withDefaults(defineProps<{item:GameItem;shape?:'vert'|'wide'}>(),{shape:'vert'})
const emit=defineEmits<{loaded:[value:{width:number;height:number;composed:boolean}];failed:[]}>()
const title=computed(()=>gameTitle(props.item)),bad=ref(new Set<string>()),dimensions=ref({width:0,height:0})
const primary=computed(()=>props.shape==='wide'?props.item.background_path:props.item.cover_path)
const alternate=computed(()=>props.shape==='wide'?props.item.cover_path:props.item.background_path)
const source=computed(()=>[primary.value,alternate.value].find(p=>p&&!bad.value.has(p))||'')
const url=computed(()=>coverUrl(source.value,props.item.updated_at))
const ratio=computed(()=>dimensions.value.width/(dimensions.value.height||1))
const composed=computed(()=>!props.item.cover_focus&&ratio.value>0&&Math.abs(ratio.value/(props.shape==='wide'?16/9:2/3)-1)>.22)
const hue=computed(()=>{let h=0;for(const c of title.value)h=(h*31+c.charCodeAt(0))%360;return h})
const latin=computed(()=>(title.value.match(/[A-Za-z]/g)||[]).length>title.value.length/2)
const focus=computed(()=>{const parts=(props.item.cover_focus||'50,35').split(',').map(Number);return parts.length===2&&parts.every(p=>Number.isFinite(p)&&p>=0&&p<=100)?`${parts[0]}% ${parts[1]}%`:'50% 35%'})
watch(()=>[props.item.id,props.item.cover_path,props.item.background_path,props.item.updated_at],()=>{bad.value=new Set();dimensions.value={width:0,height:0}})
watch(source,()=>{dimensions.value={width:0,height:0}})
function loaded(e:Event){const img=e.target as HTMLImageElement;dimensions.value={width:img.naturalWidth,height:img.naturalHeight};emit('loaded',{...dimensions.value,composed:composed.value})}
function failed(){bad.value=new Set([...bad.value,source.value]);emit('failed')}
</script>
<template>
  <div class="game-cover" :class="'game-cover--'+shape" :style="{'--h':hue,'--tfs':title.length<=4?'15cqw':title.length<=6?'12cqw':'10cqw','--arn':ratio||1,'--focus':focus}" role="img" :aria-label="title" :data-mode="!source?'fallback':composed?'composed':'image'">
    <template v-if="source"><img class="cv-bg" :src="url" alt="" aria-hidden="true"/><img class="cv-img" :class="{'cv-img--hidden':composed}" :src="url" alt="" @load="loaded" @error="failed"/>
      <div v-if="composed" class="cv-comp" :class="shape==='wide'?'cv-comp--h':'cv-comp--v'"><div class="cv-art"><img :src="url" alt=""/></div><div class="cv-cap"><b>{{title}}</b><span v-if="item.name_en&&item.name_en!==title">{{item.name_en}}</span></div></div>
    </template>
    <div v-else class="fb" :class="{'fb--wide':shape==='wide','fb--latin':latin}"><div class="fb__frame"/><span class="fb__wm">{{title[0]}}</span><div class="fb__col"><b class="fb__title">{{title}}</b><span v-if="item.name_en&&item.name_en!==title" class="fb__sub">{{item.name_en}}</span></div><span class="fb__cat">{{item.category||'GAME'}}</span><span class="fb__seal">{{title[0]}}</span></div>
    <slot/>
  </div>
</template>
<style scoped src="./game-cover.css"/>
