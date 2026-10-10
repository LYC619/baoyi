<script setup lang="ts">
import {ref,watch} from 'vue'
import type {ImagePage,ImagePageInfo} from '@/types/image'
import {formatBytes} from '@/utils'
const props=defineProps<{pages:ImagePage[];cover:string}>()
const selected=ref(''),info=ref<ImagePageInfo|null>(null),error=ref('')
let revision=0
watch(()=>props.cover,id=>{selected.value=id||props.pages[0]?.id||''},{immediate:true})
watch(selected,async id=>{const current=++revision;info.value=null;error.value='';if(!id)return;try{const result=await window.baoyi.image.pageInfo(id);if(current===revision)info.value=result}catch(e){if(current===revision)error.value=(e as Error).message}},{immediate:true})
</script>
<template><section class="photo-info" aria-label="照片元数据"><header><h2>照片信息</h2><select v-model="selected" aria-label="查看照片信息"><option v-for="p in pages" :key="p.id" :value="p.id">第 {{p.ordinal+1}} 张{{p.id===cover?' · 封面':''}}</option></select></header><p v-if="error" role="alert">{{error}}</p><dl v-else-if="info"><dt>图像规格</dt><dd>{{info.width}} × {{info.height}} · {{info.format}} · {{formatBytes(info.size)}}</dd><template v-if="info.photo?.takenAt"><dt>拍摄时间</dt><dd>{{info.photo.takenAt}}</dd></template><template v-if="info.photo?.camera"><dt>相机</dt><dd>{{info.photo.camera}}</dd></template><template v-if="info.photo?.lens"><dt>镜头</dt><dd>{{info.photo.lens}}</dd></template><template v-if="info.photo?.exposure||info.photo?.aperture||info.photo?.iso"><dt>曝光</dt><dd>{{[info.photo.exposure,info.photo.aperture,info.photo.iso?'ISO '+info.photo.iso:'',info.photo.focalLength].filter(Boolean).join(' · ')}}</dd></template></dl><p v-if="info && !Object.keys(info.photo||{}).length">此照片没有可读取的拍摄信息。</p></section></template>
<style scoped>.photo-info{margin:28px 0;padding:20px;background:var(--bg-card);border:1px solid var(--divider);border-radius:8px}.photo-info header{display:flex;align-items:center;gap:20px}.photo-info h2{font-size:18px;margin:0 auto 0 0}.photo-info select{max-width:220px}.photo-info dl{display:grid;grid-template-columns:90px 1fr;gap:12px;font-size:13px;margin:20px 0 0}.photo-info dt,.photo-info p{color:var(--text-sub)}.photo-info dd{margin:0;overflow-wrap:anywhere}</style>
