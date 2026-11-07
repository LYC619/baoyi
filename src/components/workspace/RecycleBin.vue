<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {workspace} from '@/utils/workspace-api'
import type {RecycleItem} from '@/types/workspace'
const rows=ref<RecycleItem[]>([]),busy=ref(false),error=ref('')
async function refresh(){try{rows.value=await workspace.recycle.list()}catch(e){error.value=(e as Error).message}}
const off=workspace.onChanged(()=>void refresh());onBeforeUnmount(off);onMounted(refresh)
async function run(fn:()=>Promise<unknown>){busy.value=true;error.value='';try{await fn();await refresh()}catch(e){error.value=(e as Error).message}finally{busy.value=false}}
const labels:Record<string,string>={indexed:'仅移除索引',recycled:'文件已回收',attention:'需要处理',purged:'文件已到期清理'}
</script>
<template><section class="ws ws-card recycle-bin"><header class="ws-section-head"><h3>回收站</h3><button class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.cleanup())">检查到期文件</button></header><p class="ws-muted">源文件保留一个自然月，月底取下月最后一天。应用启动及每天检查，只清理登记且核验一致的文件。恢复中断的记录保留，等待继续处理。</p><p v-if="error" class="ws-error" role="alert">{{error}}</p><p v-if="!rows.length" class="ws-muted">回收站为空。</p>
<article v-for="row in rows" :key="row.id" class="recycle-row"><strong>{{row.name}}</strong><span class="ws-badge">{{labels[row.state]||row.state}}</span><p class="ws-muted">移除：{{new Date(row.createdAt).toLocaleString()}}<template v-if="row.expiresAt"> · 到期：{{new Date(row.expiresAt).toLocaleString()}}</template></p><p v-for="file in row.files" :key="file.source" class="ws-path">{{file.source}}</p><p v-if="row.error" class="ws-error">{{row.error}}</p><p v-if="row.state==='purged'" class="ws-muted">文件已清理，仍可恢复资料索引、标注和引用，再重新定位文件。</p><div class="ws-toolbar"><button class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.restore(row.id))">{{row.state==='purged'?'恢复资料索引':'恢复资料'}}</button><button v-if="row.files.some(f=>f.state==='stored')" class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.restore(row.id,true))">恢复到新位置</button><button v-if="row.state==='attention'&&!row.restoring" class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.resume(row.id))">重试回收</button></div></article></section></template>
<style scoped>.recycle-bin{margin-top:24px}.recycle-row{padding:18px 0;border-top:1px solid var(--divider)}.recycle-row>.ws-badge{margin-left:12px}.recycle-row p{overflow-wrap:anywhere}</style>
