<script setup lang="ts">
import { errorMessage } from '@/utils'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRouter,useRoute } from 'vue-router'
import { Plus,Link2,X } from 'lucide-vue-next'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import ProjectFiles from './ProjectFiles.vue'
import { workspace,openResource,kindLabels } from '@/utils/workspace-api'
import type { LinkOwner,ResourceLink,ResourceOption,DocumentAnnotation } from '@/types/workspace'
const props=withDefaults(defineProps<{owner:LinkOwner;id:string;title?:string}>(),{title:'相关实践与资源'})
const router=useRouter(),route=useRoute(),rows=ref<ResourceLink[]>([]),options=ref<ResourceOption[]>([]),show=ref(false),selected=ref(''),annotation=ref(''),annotations=ref<DocumentAnnotation[]>([]),query=ref(''),busy=ref(false),error=ref('')
const readLinks=latestOnly((owner:LinkOwner,id:string)=>workspace.links.list(owner,id))
const readAnnotations=latestOnly((id:string)=>options.value.find(x=>x.id===id)?.kind==='document'?workspace.documents.annotations(id):Promise.resolve([]))
const filtered=computed(()=>options.value.filter(r=>r.id!==props.id&&`${r.name} ${kindLabels[r.kind]}`.toLowerCase().includes(query.value.toLowerCase())).slice(0,300))
async function load(){try{const value=await readLinks(props.owner,props.id);if(value!==STALE)rows.value=value}catch(e){error.value=errorMessage(e)}}
watch(()=>[props.owner,props.id],()=>{rows.value=[];show.value=false;error.value='';void load()},{immediate:true})
const unsubscribe=workspace.onChanged(()=>void load());onBeforeUnmount(unsubscribe)
async function start(){error.value='';try{options.value=await workspace.links.resources();selected.value='';query.value='';show.value=true}catch(e){error.value=errorMessage(e)}}
watch(selected,async id=>{annotations.value=[];annotation.value='';try{const value=await readAnnotations(id);if(value!==STALE)annotations.value=value}catch(e){error.value=errorMessage(e)}})
async function add(){if(busy.value||!selected.value)return;busy.value=true;error.value='';try{await workspace.links.add(props.owner,props.id,selected.value,annotation.value||undefined);await load();show.value=false}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
async function remove(row:ResourceLink){if(!confirm('移除这条关联？原资料和记录保留。'))return;try{await workspace.links.remove(props.owner,props.id,row.id);await load()}catch(e){error.value=errorMessage(e)}}
async function open(row:ResourceLink){try{await openResource(router,row,route.fullPath)}catch(e){error.value=errorMessage(e)}}
</script>
<template><section class="ws-links"><header class="ws-section-head"><h3>{{title}} <span class="ws-muted">{{rows.length}}</span></h3><button class="ws-icon" :aria-label="'添加'+title" @click="start"><Plus :size="17"/></button></header><p v-if="error&&!show" class="ws-error" role="alert">{{error}}</p><p v-if="!rows.length" class="ws-muted">关联项目、资料或摘录，留下可以回看的来源。</p><article v-for="row in rows" :key="row.id" class="ws-link"><Link2 :size="16"/><button class="ws-link-main" @click="open(row)"><strong>{{row.name}}</strong><small>{{kindLabels[row.kind]}}<template v-if="row.missing"> · 原文件或索引暂不可用</template></small><p v-if="row.quote" class="ws-pre">{{row.quote}}</p></button><button class="ws-icon" :aria-label="'移除关联 '+row.name" @click="remove(row)"><X :size="14"/></button></article>
<ProjectFiles v-if="owner==='project'" :project-id="id"/>
<ProjectDialog v-if="show" title="关联资源" :busy="busy" @close="show=false"><div class="ws ws-form"><p v-if="error" class="ws-error" role="alert">{{error}}</p><label>筛选资源<input v-model="query" placeholder="名称或资源类型"/></label><label>资源<select v-model="selected" aria-label="选择关联资源"><option value="">请选择</option><option v-for="r in filtered" :key="r.id" :value="r.id">{{kindLabels[r.kind]}} · {{r.name}}</option></select></label><label v-if="annotations.length">摘录或书签<select v-model="annotation" aria-label="选择关联摘录"><option value="">关联整份资料</option><option v-for="a in annotations" :key="a.id" :value="a.id">第 {{a.location.page}} 页/段 · {{(a.quote||a.note||'书签').slice(0,70)}}</option></select></label><p class="ws-muted">选择摘录会保留原文位置。此操作只添加关联。</p></div><template #footer><div class="ws"><button class="ws-button primary" :disabled="busy||!selected" @click="add">保存关联</button></div></template></ProjectDialog></section></template>
