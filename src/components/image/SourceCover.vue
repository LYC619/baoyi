<script setup lang="ts">
import { ref, watch } from 'vue'
const props=defineProps<{url?:string;title:string}>()
const image=ref(''),failed=ref(false),loading=ref(false)
let revision=0
watch(()=>props.url,async url=>{
  const current=++revision
  image.value='';failed.value=false;loading.value=!!url
  if(!url)return
  try{const result=await window.baoyi.image.sourceCover(url);if(current===revision)image.value=result}
  catch{if(current===revision)failed.value=true}
  finally{if(current===revision)loading.value=false}
},{immediate:true})
</script>
<template><div class="source-cover"><img v-if="image&&!failed" :src="image" :alt="title+'封面'" @error="failed=true"/><span v-else>{{loading?'加载封面…':failed?'封面加载失败':'暂无封面'}}</span></div></template>
<style scoped>
.source-cover{width:86px;aspect-ratio:2/3;flex:none;overflow:hidden;border-radius:5px;background:var(--bg-main);display:flex;align-items:center;justify-content:center}.source-cover img{width:100%;height:100%;object-fit:cover}.source-cover span{padding:8px;font-size:11px;color:var(--text-faint);text-align:center}
</style>
