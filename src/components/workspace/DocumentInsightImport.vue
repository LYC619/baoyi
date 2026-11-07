<script setup lang="ts">
import {computed,ref,onMounted} from 'vue'
import type {DocumentInsightPolicy} from '@/types/document-insight'
const value=defineModel<string>({default:''}),policy=ref<DocumentInsightPolicy|null>(null)
const automatic=computed(()=>!!policy.value?.automatic&&policy.value.authorized)
const mode=computed({get:()=>value.value==='skip'?'skip':value.value?'all':automatic.value?'auto':'skip',set:(mode:string)=>{value.value=mode==='all'?policy.value!.provider:mode==='auto'?'':'skip'}})
onMounted(async()=>{try{policy.value=await window.baoyi.archive.insights.policy()}catch{/* Import remains available when model settings cannot load. */}})
</script>
<template><div v-if="policy" class="insight-import"><label>导入后精读<select v-model="mode" aria-label="本批精读方式"><option value="skip">本批不精读</option><option v-if="automatic" value="auto">按已授权分类自动精读</option><option value="all">精读本批资料（最多 20 份）</option></select></label><p v-if="mode!=='skip'">{{mode==='auto'?'仅已授权分类中的资料':'本批所选资料'}}将向 {{policy.provider}} 发送每份最多 {{policy.maxChars.toLocaleString()}} 字符；长 PDF 读取前 15 页＋后 10 页。生成失败不影响导入。</p></div></template>
<style scoped>.insight-import{font-size:12px;line-height:1.8;padding:10px 0}.insight-import label{display:flex;gap:8px;align-items:center}.insight-import p,.insight-import small{color:var(--text-sub);overflow-wrap:anywhere}</style>
