<script setup lang="ts">
import {computed} from 'vue'
import {marked} from 'marked'
import DOMPurify from 'dompurify'
import {Check,LoaderCircle,ChevronRight,FileText,TriangleAlert} from 'lucide-vue-next'
import type {LiveBlock} from '@/composables/useArchiveAssistant'
const props=defineProps<{block:LiveBlock}>(),emit=defineEmits<{source:[id:string]}>()
const names:Record<string,string>={archive_result:'续读归档结果',archive_search:'查找归档',archive_get:'读取资料信息',archive_catalog:'查看分类',archive_web_search:'检索公开信息',archive_create_category:'建立归档分类',archive_read:'阅读原文',archive_search_text:'检索正文',archive_project_files:'查看项目文件',archive_project_search:'搜索项目内容',archive_update:'保存整理结果',archive_create_personal:'新增个人记录',archive_check:'核验文件',archive_locate:'寻找原文件',archive_relocate:'修复位置',archive_organize:'整理文件',archive_actions:'查阅修改记录',archive_undo:'撤销修改',archive_link:'处理资源关联',archive_skill:'处理技能记录',archive_history:'查找旧对话',memory:'维护记忆',todo_list:'更新任务进度',session_search:'找回历史',skill_manage:'保存归档方法',skill_view:'读取归档方法',skills_list:'查找归档方法'}
const result=computed(()=>{try{return JSON.parse(props.block.result||'null')}catch { return null /* 无法解析的结果按普通文本显示。 */ }})
const failure=computed(()=>result.value?.error)
const sources=computed(()=>{const value=result.value,items=Array.isArray(value)?value:value?.items||value?.matches||[value?.resource||value?.source||value];return items.filter((x:any)=>x?.id&&x?.kind&&x?.name).slice(0,20)})
const tasks=computed(()=>result.value?.todos||[])
const summary=computed(()=>failure.value||result.value?.reason||(typeof result.value?.changed==='number'?`已保存 ${result.value.changed} 项`:'')||(typeof result.value?.succeeded==='number'?`完成 ${result.value.succeeded} 项${result.value.failed?`，${result.value.failed} 项待处理`:''}`:'')||(typeof result.value?.total==='number'?`共 ${result.value.total} 项${result.value.next!==null&&result.value.next!==undefined?'，还有后续结果':''}`:'')||(props.block.pending?'正在处理':'已完成'))
const html=computed(()=>DOMPurify.sanitize(marked.parse(props.block.text||'',{async:false}) as string,{FORBID_TAGS:['img','video','audio','iframe','object','embed','form','input','style'],FORBID_ATTR:['style','src'],ALLOWED_URI_REGEXP:/^(?:(?:https?|baoyi):|#)/i}))
function follow(e:MouseEvent){const a=(e.target as HTMLElement).closest('a');if(!a)return;e.preventDefault();const href=a.getAttribute('href')||'';if(href.startsWith('baoyi://resource/'))emit('source',decodeURIComponent(href.slice(17).split(/[?#]/)[0]));else if(/^https?:\/\//.test(href))window.open(href,'_blank')}
</script>
<template>
  <article v-if="block.role!=='tool'" class="archive-message" :class="block.role">
    <span class="speaker">{{block.role==='user'?'你':'抱一'}}</span>
    <div v-if="block.role==='user'" class="user-text">{{block.text}}</div>
    <div v-else class="prose" v-html="html" @click="follow" />
  </article>
  <details v-else class="archive-tool" :class="{failed:failure}">
    <summary><LoaderCircle v-if="block.pending" class="spin" :size="13"/><TriangleAlert v-else-if="failure" :size="13"/><Check v-else :size="13"/><span>{{names[block.name||'']||'处理归档'}}</span><small>{{summary}}</small><ChevronRight class="chevron" :size="13"/></summary>
    <div class="tool-body">
      <ol v-if="tasks.length" class="tasks"><li v-for="task in tasks" :key="task.id" :class="task.status"><Check v-if="task.status==='completed'" :size="13"/><span v-else class="task-dot"/>{{task.content||task.text||task.title}}</li></ol>
      <button v-for="item in sources" :key="item.id" class="source-row" @click="emit('source',item.id)"><FileText :size="14"/><span>{{item.name}}</span><small>{{item.page?`第 ${item.page} 页`:item.kind}}</small></button>
      <p v-if="result?.text" class="source-text">{{result.text}}</p>
      <p v-if="failure" role="alert">{{failure}}</p>
      <p v-if="result?.unread?.length">{{result.unread.length}} 份未能读取：{{result.unread.map((x:any)=>`${x.name}（${x.reason}）`).join('；')}}</p>
      <details class="raw"><summary>查看操作明细</summary><pre>{{JSON.stringify(result||block.args,null,2)}}</pre></details>
    </div>
  </details>
</template>
<style scoped>
.archive-message{padding:20px 0;line-height:1.8;font-size:14px;overflow-wrap:anywhere}.speaker{display:block;font-size:11px;letter-spacing:.08em;color:var(--text-muted);margin-bottom:6px}.user{padding:16px 18px;background:var(--active-surface);border-radius:12px;margin:16px 0}.user .speaker{color:var(--accent)}.user-text{white-space:pre-wrap}.prose :deep(p){margin:0 0 12px}.prose :deep(p:last-child){margin-bottom:0}.prose :deep(ul),.prose :deep(ol){padding-left:24px}.prose :deep(a){color:var(--accent);text-decoration:underline;text-underline-offset:3px}.prose :deep(pre){white-space:pre-wrap;background:var(--bg-main);padding:12px;border:1px solid var(--divider);border-radius:8px}.prose :deep(table){border-collapse:collapse;font-size:12px;width:100%}.prose :deep(td),.prose :deep(th){padding:6px;border-bottom:1px solid var(--divider);text-align:left}.prose :deep(blockquote){border-left:2px solid var(--accent);margin:12px 0;padding-left:14px;color:var(--text-sub)}.archive-tool{margin:6px 0;border:1px solid var(--divider);border-radius:9px;font-size:12px}.archive-tool>summary{display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 12px;color:var(--text-sub);list-style:none}.archive-tool>summary>span{color:var(--text-main)}.archive-tool small{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.archive-tool[open] .chevron{transform:rotate(90deg)}.tool-body{padding:0 12px 12px}.source-row{display:flex;align-items:center;gap:8px;width:100%;padding:9px 0;border:0;border-bottom:1px solid var(--divider);background:none;color:var(--text-main);text-align:left;cursor:pointer}.source-row>span{flex:1}.source-text{white-space:pre-wrap;max-height:240px;overflow:auto;color:var(--text-sub)}.raw{margin-top:10px;color:var(--text-muted)}.raw summary{cursor:pointer}.raw pre{font-size:11px;max-height:240px;overflow:auto;white-space:pre-wrap}.tasks{list-style:none;padding:0}.tasks li{display:flex;gap:8px;align-items:center;padding:5px 0}.tasks .completed{color:var(--text-muted)}.tasks .in_progress{color:var(--accent)}.task-dot{width:7px;height:7px;border-radius:50%;border:1px solid currentColor}.failed{border-color:var(--danger,#bc685b)}.spin{animation:spin 1.2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
</style>
