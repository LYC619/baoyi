<script setup lang="ts">
import {useRouter} from 'vue-router'
import {useVideoUpdates} from '@/composables/useVideoUpdates'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import DownloadPanel from './DownloadPanel.vue'
import {useVideoWorkflow} from '@/composables/useVideoWorkflow'
import {computed,ref,watch} from 'vue'
import {useSettingsStore} from '@/stores/settings'
const updates=useVideoUpdates(),router=useRouter(),downloadId=ref('')
const settings=useSettingsStore()
const attention=computed(()=>updates.rows.value.filter(row=>row.newEpisodes>0||row.missingFiles>0))
const failures=computed(()=>updates.rows.value.filter(row=>row.status==='failed'))
watch(()=>router.currentRoute.value.fullPath,()=>{if(downloadId.value)useVideoWorkflow(downloadId.value).open.value=false;updates.open.value=false;downloadId.value=''})
watch(()=>settings.settings.hide_hentai,()=>{if(downloadId.value)useVideoWorkflow(downloadId.value).open.value=false;downloadId.value='';updates.open.value=false})
async function supplement(id:string){downloadId.value=id;const flow=useVideoWorkflow(id);flow.url.value='';await flow.prepare()}
function detail(id:string){updates.open.value=false;void router.push('/video/'+id)}
</script>
<template>
  <ProjectDialog v-if="updates.open.value&&!downloadId" :title="$t('批量检查视频更新')" @close="updates.open.value=false">
    <p>{{ $t("仅检查已绑定支持来源的剧集和里番；检查不会自动下载或修改作品资料。") }}</p>
    <p role="status">{{updates.state.value.running?$t('正在检查 ')+updates.state.value.checked+' / '+updates.state.value.total+$t(' 部作品'):$t('当前范围已检查 ')+updates.rows.value.length+$t(' 部作品')}}{{updates.state.value.cancelled?$t('（已停止）'):''}}</p>
    <p v-if="updates.error.value" role="alert">{{$systemMessage(updates.error.value)}}</p>
    <p v-if="!updates.state.value.running&&!updates.rows.value.length">{{ $t("当前范围没有绑定有效来源的系列作品。") }}</p>
    <p v-else-if="!updates.state.value.running&&!attention.length&&!failures.length&&!updates.state.value.cancelled">{{ $t("共检查 {p0} 部作品，均无新集或缺失。", {p0: (updates.rows.value.length)}) }}</p>
    <details v-if="failures.length"><summary>{{ $t("{p0} 部作品检查失败，可稍后重试", {p0: (failures.length)}) }}</summary><p v-for="row in failures" :key="row.id">{{row.title}}：{{$systemMessage(row.message)}}</p></details>
    <article v-for="row in attention" :key="row.id" class="update-row">
      <strong>{{row.title}}</strong><span>{{ $t("新集 {p0} · 缺失文件 {p1}", {p0: (row.newEpisodes), p1: (row.missingFiles)}) }}</span>
      <p :role="row.status==='failed'?'alert':undefined">{{row.status==='failed'?$t('检查失败：'):''}}{{$systemMessage(row.message)}}</p>
      <button class="pj-button" @click="detail(row.id)">{{ $t("查看作品 / 定位文件") }}</button>
      <button v-if="row.source" class="pj-button" :disabled="updates.state.value.running" @click="supplement(row.id)">{{ $t("下载 / 补齐") }}</button>
    </article>
    <template #footer><button v-if="updates.state.value.running" class="pj-button" @click="updates.cancel">{{ $t("停止检查") }}</button><button class="pj-button" @click="updates.open.value=false">{{ $t("关闭") }}</button></template>
  </ProjectDialog>
  <DownloadPanel v-if="downloadId" :key="downloadId" :id="downloadId" updates-only @close="useVideoWorkflow(downloadId).open.value=false;downloadId=''" />
</template>
<style scoped>.update-row{padding:14px 0;border-bottom:1px solid var(--divider)}.update-row>span{margin-left:12px;font-size:12px;color:var(--text-sub)}.update-row p{font-size:12px;line-height:1.6}.update-row button{margin-right:8px}</style>
