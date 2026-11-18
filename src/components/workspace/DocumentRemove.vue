<script setup lang="ts">
import { errorMessage } from '@/utils'
import {ref,watch,onMounted} from 'vue'
import {workspace} from '@/utils/workspace-api'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
const props=defineProps<{id:string}>(),emit=defineEmits<{close:[];removed:[]}>()
const files=ref<Awaited<ReturnType<typeof workspace.recycle.locations>>>([]),selected=ref<string[]>([]),withFiles=ref(false),busy=ref(false),error=ref('')
const preview=ref<Awaited<ReturnType<typeof workspace.recycle.preview>>|null>(null)
watch([selected,withFiles],()=>preview.value=null,{deep:true})
onMounted(async()=>{try{files.value=await workspace.recycle.locations(props.id)}catch(e){error.value=errorMessage(e)}})
async function run(fn:()=>Promise<void>){busy.value=true;error.value='';try{await fn()}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
async function check(){await run(async()=>{preview.value=await workspace.recycle.preview(props.id,withFiles.value?[...selected.value]:[])})}
async function remove(){await run(async()=>{if(!preview.value)return;await workspace.recycle.confirm(preview.value.token);emit('removed');emit('close')})}
</script>
<template><ProjectDialog title="移除资料" :busy="busy" @close="emit('close')"><div class="ws ws-form">
<p>默认只移除索引，原文件保留。资料信息、标注和已有引用会保留，可在资料设置的回收站恢复。</p>
<label class="check"><input v-model="withFiles" type="checkbox" :disabled="busy"/>同时删除源文件（先移入回收站）</label>
<template v-if="withFiles"><p class="ws-muted">仅处理勾选的位置。其他副本保留。</p><label v-for="file in files" :key="file.path" class="check"><input v-model="selected" type="checkbox" :value="file.path" :disabled="!file.available||busy"/><span class="ws-path">{{file.path}} {{file.available?'':'（暂不可用）'}}</span></label><button class="ws-button" :disabled="busy" @click="run(async()=>{await workspace.preferences.chooseDataDirectory();preview=null})">选择资料数据目录</button></template>
<div v-if="preview" class="ws-card"><strong>{{preview.name}}</strong><p>现有引用 {{preview.references}} 处；移除后保留来源与文件状态。</p><p v-if="!preview.files.length">本次仅移除索引，不处理任何文件。</p><p v-for="file in preview.files" :key="file.source" class="ws-path">{{file.source}} → {{file.stored}}</p><p v-if="preview.expiresAt">回收文件到期：{{new Date(preview.expiresAt).toLocaleString()}}。应用运行时检查并清理。</p></div>
<p v-if="error" class="ws-error" role="alert">{{error}}</p></div><template #footer><div class="ws"><button v-if="!preview" class="ws-button" :disabled="busy||(withFiles&&!selected.length)" @click="check">预览移除范围</button><button v-else class="ws-button danger" :disabled="busy" @click="remove">{{preview.files.length?'确认移入回收站':'确认仅移除索引'}}</button></div></template></ProjectDialog></template>
