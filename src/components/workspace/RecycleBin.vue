<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { errorMessage } from '@/utils'
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {workspace} from '@/utils/workspace-api'
import type {RecycleItem} from '@/types/workspace'
const rows=ref<RecycleItem[]>([]),busy=ref(false),error=ref('')
async function refresh(){try{rows.value=await workspace.recycle.list()}catch(e){error.value=errorMessage(e)}}
const off=workspace.onChanged(()=>void refresh());onBeforeUnmount(off);onMounted(refresh)
async function run(fn:()=>Promise<unknown>){busy.value=true;error.value='';try{await fn();await refresh()}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
const labels:Record<string,string>={get indexed() { return tr('仅移除索引') },get recycled() { return tr('文件已回收') },get attention() { return tr('需要处理') },get purged() { return tr('文件已到期清理') }}
</script>
<template><section class="ws ws-card recycle-bin"><header class="ws-section-head"><h3>{{ $t("回收站") }}</h3><button class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.cleanup())">{{ $t("检查到期文件") }}</button></header><p class="ws-muted">{{ $t("源文件保留一个自然月，月底取下月最后一天。应用启动及每天检查，只清理登记且核验一致的文件。恢复中断的记录保留，等待继续处理。") }}</p><p v-if="error" class="ws-error" role="alert">{{$systemMessage(error)}}</p><p v-if="!rows.length" class="ws-muted">{{ $t("回收站为空。") }}</p>
<article v-for="row in rows" :key="row.id" class="recycle-row"><strong>{{row.name}}</strong><span class="ws-badge">{{labels[row.state]||row.state}}</span><p class="ws-muted">{{ $t("移除：{p0}", {p0: (new Date(row.createdAt).toLocaleString($locale))}) }}<template v-if="row.expiresAt">{{ $t("· 到期：{p0}", {p0: (new Date(row.expiresAt).toLocaleString($locale))}) }}</template></p><p v-for="file in row.files" :key="file.source" class="ws-path">{{file.source}}</p><p v-if="row.error" class="ws-error">{{$systemMessage(row.error)}}</p><p v-if="row.state==='purged'" class="ws-muted">{{ $t("文件已清理，仍可恢复资料索引、标注和引用，再重新定位文件。") }}</p><div class="ws-toolbar"><button class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.restore(row.id))">{{row.state==='purged'?$t('恢复资料索引'):$t('恢复资料')}}</button><button v-if="row.files.some(f=>f.state==='stored')" class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.restore(row.id,true))">{{ $t("恢复到新位置") }}</button><button v-if="row.state==='attention'&&!row.restoring" class="ws-button" :disabled="busy" @click="run(()=>workspace.recycle.resume(row.id))">{{ $t("重试回收") }}</button></div></article></section></template>
<style scoped>.recycle-bin{margin-top:24px}.recycle-row{padding:18px 0;border-top:1px solid var(--divider)}.recycle-row>.ws-badge{margin-left:12px}.recycle-row p{overflow-wrap:anywhere}</style>
