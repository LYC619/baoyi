<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { latestOnly, STALE } from '@/composables/latestOnly'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { BookOpen, ExternalLink, FolderOpen, Plus, Search, Trash2, Wrench } from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { GameItem, LinkedFile } from '@/types'
import type { GameLinkState, GameLinkText } from '@/types/game-project'
import { errorMessage, LINK_TYPE_LABEL, plain } from '@/utils'
import { useToast } from '@/composables/useToast'
const props = defineProps<{game:GameItem;kind:'trainer'|'guide'|'other'}>()
const emit=defineEmits<{updated:[item:GameItem]}>()
const {error,toast}=useToast()
const keyword=ref(''),busy=ref(false),states=ref<GameLinkState[]>([]),selected=ref(''),document=ref<GameLinkText|null>(null),reading=ref(false),failure=ref('')
let resourceScope = new AbortController()
const readStates=latestOnly((id:string)=>window.baoyi.game.linkStates(id))
const readText=latestOnly((path:string|null)=>path===null?Promise.resolve(null):window.baoyi.game.readLink(props.game.id,path))
function closeReading(){void readText(null);selected.value='';document.value=null}
const links=computed(()=>props.game.linked_files.filter(link=>props.kind==='other'?!['trainer','guide'].includes(link.type):link.type===props.kind))
const visible=computed(()=>links.value.filter(link=>[link.label,link.path,link.note].join(' ').toLowerCase().includes(keyword.value.toLowerCase())))
const title=computed(()=>props.kind==='trainer'?tr('修改器与工具'):props.kind==='guide'?tr('攻略与说明'):tr('启动入口与其他附件'))
const current=computed(()=>links.value.find(link=>link.path===selected.value))
const state=(file:LinkedFile)=>states.value.find(value=>value.path===file.path)
const readable=(file:LinkedFile)=>state(file)?.readable===true
const html=computed(()=>document.value?.format==='markdown'?DOMPurify.sanitize(marked.parse(document.value.text,{async:false}) as string,{FORBID_TAGS:['img','video','audio','iframe','object','embed','form','input','style','svg','math'],FORBID_ATTR:['href','src','style','id','name']}):'')
watch(()=>[props.game.id,JSON.stringify(props.game.linked_files)],async()=>{
  resourceScope.abort();resourceScope=new AbortController();closeReading();failure.value='';reading.value=false;states.value=[]
  try{const result=await readStates(props.game.id);if(result!==STALE)states.value=result}catch(cause){error(errorMessage(cause))}
},{immediate:true})
onBeforeUnmount(()=>{resourceScope.abort();closeReading()})
async function read(file:LinkedFile){
  selected.value=file.path;document.value=null;failure.value='';reading.value=true
  try{const result=await readText(file.path);if(result===STALE)return;document.value=result}
  catch(cause){failure.value=errorMessage(cause)}
  reading.value=false
}
async function open(file:LinkedFile,reveal=false){try{const result=await (reveal?window.baoyi.game.revealLink:window.baoyi.game.openLink)(props.game.id,file.path);if(!result.ok)error(result.message)}catch(cause){error(errorMessage(cause))}}
async function add(directory=false){
  const id=props.game.id,{signal}=resourceScope;busy.value=true
  try{const before=props.game.linked_files.length;const result=await window.baoyi.game.pickLinks(id,directory?'dir':'file',props.kind);if(result&&!signal.aborted){emit('updated',result);toast(result.linked_files.length>before?tr("已关联到当前游戏"):tr("没有新增关联；已有条目或已达到 20 个上限"))}}catch(cause){error(errorMessage(cause))}finally{busy.value=false}
}
async function patch(file:LinkedFile,patch?:Partial<LinkedFile>){
  const id=props.game.id,{signal}=resourceScope;busy.value=true
  try{const updated=await window.baoyi.game.update(id,plain({linked_files:patch?props.game.linked_files.map(value=>value.path===file.path?{...value,...patch}:value):props.game.linked_files.filter(value=>value.path!==file.path)}));if(updated&&!signal.aborted)emit('updated',updated)}catch(cause){error(errorMessage(cause))}finally{busy.value=false}
}
const roleLabel=(file:LinkedFile)=>file.role==='usage'?tr('使用说明'):file.role==='report'?tr('验收记录'):file.role==='source'?tr('原帖快照'):file.role==='launcher'?tr('启动入口'):LINK_TYPE_LABEL[file.type]
</script>
<template>
  <section class="game-resources">
    <header><div><h2>{{title}} <span>{{links.length}}</span></h2><p>{{kind==='trainer'?$t('打开工具前先查看用法与适用版本。'):kind==='guide'?$t('攻略、操作说明和核验记录，随游戏保存在一起。'):$t('备用启动入口、MOD 和相关文件夹。')}}</p></div><button class="btn btn--subtle" :disabled="busy||game.linked_files.length>=20" @click="add()"><Plus :size="14"/>{{kind==='trainer'?$t('关联工具'):kind==='guide'?$t('关联资料'):$t('关联文件')}}</button><button v-if="kind!=='guide'" class="btn btn--subtle" :disabled="busy||game.linked_files.length>=20" @click="add(true)">{{ $t("关联文件夹") }}</button></header>
    <div class="resource-layout" :class="{'with-reader':selected}">
      <aside class="resource-list"><label v-if="links.length" class="resource-search"><Search :size="14"/><input v-model="keyword" :aria-label="$t('搜索{p0}', {p0: title})" :placeholder="$t('搜索名称、说明或路径')"/></label>
        <p v-if="!links.length" class="empty">{{kind==='trainer'?$t('还没有关联修改器。添加工具入口或使用说明，下次直接从这里打开。'):kind==='guide'?$t('还没有攻略。可以关联 Markdown、TXT、PDF 或本地网页。'):$t('还没有其他附件。')}}<small>{{ $t("解除关联会保留原文件。") }}</small></p>
        <p v-else-if="!visible.length" class="empty">{{ $t("没有匹配的资料。") }}</p>
        <article v-for="file in visible" :key="file.path" class="resource" :class="{selected:selected===file.path}">
          <div class="resource-heading"><Wrench v-if="kind==='trainer'&&file.role!=='usage'" :size="17"/><BookOpen v-else :size="17"/><strong>{{file.label}}</strong><span>{{roleLabel(file)}}</span></div>
          <p v-if="file.note" class="resource-note">{{file.note}}</p>
          <small v-if="state(file)&&!state(file)?.exists" class="missing">{{ $t("文件缺失或所在磁盘未连接") }}</small>
          <div class="resource-actions"><button v-if="readable(file)" class="btn btn--subtle" @click="read(file)"><BookOpen :size="13"/>{{ $t("阅读") }}</button><button class="btn btn--subtle" :disabled="!state(file)?.exists" @click="open(file)"><ExternalLink :size="13"/>{{file.role==='launcher'?$t('打开入口'):$t('系统打开')}}</button><button class="icon-button" :disabled="!state(file)?.exists" :aria-label="$t('定位 {p0}', {p0: file.label})" @click="open(file,true)"><FolderOpen :size="14"/></button></div>
          <details><summary>{{ $t("路径与管理") }}</summary><p class="file-path">{{file.path}}</p><div class="manage"><input :value="file.label" :disabled="busy" :aria-label="$t('名称 {p0}', {p0: file.label})" @change="patch(file,{label:($event.target as HTMLInputElement).value.trim().slice(0,100)||file.label})"/><select :value="file.type" :disabled="busy" :aria-label="$t('类型 {p0}', {p0: file.label})" @change="patch(file,{type:($event.target as HTMLSelectElement).value as LinkedFile['type']})"><option v-for="(label,type) in LINK_TYPE_LABEL" :key="type" :value="type">{{label}}</option></select><button class="icon-button" :disabled="busy" :aria-label="$t('解除关联 {p0}', {p0: file.label})" :title="$t('解除关联，保留原文件')" @click="patch(file)"><Trash2 :size="14"/></button></div></details>
        </article>
      </aside>
      <article v-if="selected" class="reader" :aria-label="$t('游戏资料阅读')"><header><div><small>{{ $t("本地资料") }}</small><h3>{{current?.label}}</h3></div><button class="btn btn--subtle" @click="closeReading">{{ $t("收起阅读") }}</button></header><p v-if="reading" role="status">{{ $t("正在读取…") }}</p><p v-else-if="failure" class="missing" role="alert">{{failure}}</p><div v-else-if="document?.format==='markdown'" class="prose" v-html="html"/><pre v-else-if="document">{{document.text}}</pre></article>
    </div>
  </section>
</template>
<style scoped>
.game-resources{width:100%;min-width:0}.game-resources>header{display:flex;gap:10px;align-items:center;margin-bottom:22px}.game-resources>header>div{flex:1}.game-resources h2{font-size:18px;margin:0 0 6px;font-weight:600}.game-resources h2 span{font-size:12px;color:var(--text-muted);margin-left:6px}.game-resources header p{color:var(--text-sub);font-size:12px;line-height:1.6;margin:0}.resource-layout{display:grid;grid-template-columns:minmax(0,1fr)}.resource-layout.with-reader{grid-template-columns:minmax(245px,.7fr) minmax(0,1.5fr);gap:28px}.resource-list{min-width:0}.resource-search{display:flex;gap:8px;align-items:center;padding:9px 12px;border:1px solid var(--divider);border-radius:6px;color:var(--text-muted);margin-bottom:12px}.resource-search input{border:0;background:none;outline:none;width:100%;font-size:12px;color:var(--text-main)}.resource{padding:18px 0;border-bottom:1px solid var(--divider)}.resource.selected{border-left:2px solid var(--accent);padding-left:14px}.resource-heading{display:flex;gap:9px;align-items:baseline}.resource-heading>svg{align-self:center;color:var(--accent);flex-shrink:0}.resource-heading strong{font-size:14px;font-weight:600;overflow-wrap:anywhere;flex:1}.resource-heading>span{font-size:10px;color:var(--text-muted);white-space:nowrap}.resource-note{font-size:12px;line-height:1.8;white-space:pre-wrap;color:var(--text-sub);margin:10px 0}.resource-actions{display:flex;gap:8px;align-items:center;margin:12px 0 8px}.icon-button{padding:7px;border-radius:5px;color:var(--text-sub)}.icon-button:hover{background:var(--active-surface)}.icon-button:disabled{opacity:.4;cursor:default}.resource details{color:var(--text-muted);font-size:11px}.resource summary{cursor:pointer;width:fit-content}.file-path{overflow-wrap:anywhere;line-height:1.7;user-select:text}.manage{display:flex;gap:6px;margin-top:10px}.manage input{min-width:0;flex:1}.manage input,.manage select{border:1px solid var(--divider);border-radius:4px;background:var(--bg-main);color:var(--text-main);font-size:12px;padding:6px}.empty{color:var(--text-muted);padding:35px 0;font-size:13px;line-height:1.8}.empty small{display:block;margin-top:8px}.missing{display:block;color:var(--danger,#b85b50);font-size:12px;margin:8px 0}.reader{min-width:0;border-left:1px solid var(--divider);padding-left:28px}.reader>header{display:flex;justify-content:space-between;gap:10px;margin:0 0 24px}.reader small{font-size:10px;letter-spacing:.1em;color:var(--accent)}.reader h3{font-size:15px;margin:8px 0;overflow-wrap:anywhere}.reader pre{white-space:pre-wrap;line-height:1.9;font-family:inherit;font-size:13px;overflow-wrap:anywhere;user-select:text}.prose{font-size:13px;line-height:1.95;overflow-wrap:anywhere;user-select:text}.prose :deep(h1){font-size:23px;line-height:1.5;margin:0 0 20px}.prose :deep(h2){font-size:18px;margin:28px 0 12px}.prose :deep(h3){font-size:15px}.prose :deep(p){margin:10px 0}.prose :deep(ul),.prose :deep(ol){padding-left:24px}.prose :deep(table){display:block;overflow-x:auto;border-collapse:collapse;max-width:100%;font-size:12px}.prose :deep(td),.prose :deep(th){padding:8px 10px;border:1px solid var(--divider);text-align:left}.prose :deep(pre){white-space:pre-wrap;background:var(--active-surface);padding:12px}.prose :deep(blockquote){margin:16px 0;padding-left:16px;border-left:2px solid var(--accent);color:var(--text-sub)}@media(max-width:1000px){.resource-layout.with-reader{grid-template-columns:minmax(0,1fr)}.reader{border-left:0;border-top:1px solid var(--divider);padding:24px 0}.game-resources>header{flex-wrap:wrap}.game-resources>header>div{flex-basis:100%}}
</style>
