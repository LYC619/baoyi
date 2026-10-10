<script setup lang="ts">
import { computed,onMounted,ref } from 'vue'
import { FolderOpen,FolderSearch,FilePlus2,Check } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import {useProjectStore} from '@/stores/project'
import ProjectDialog from './ProjectDialog.vue'
import { type ProjectImportPreview,type ProjectSource,type ProjectItem } from '@/types/project'
const store=useProjectStore()
const { success } = useToast()
const emit=defineEmits<{close:[];imported:[]}>(),busy=ref(false),error=ref(''),preview=ref<ProjectImportPreview|null>(null),result=ref('')
const selected=ref<Array<{index:number;checked:boolean;name:string;category:string;source:ProjectSource;mergeInto:string}>>([])
const count=computed(()=>selected.value.filter(s=>s.checked).length)
const existing=ref<ProjectItem[]>([])
onMounted(async()=>{void store.refresh();try{existing.value=await window.baoyi.project.list()}catch{}})
function toggleAll(){const value=!selected.value.every(s=>s.checked);selected.value.forEach(s=>s.checked=value)}
async function scan(mode:'single'|'discover'|'file'){
  busy.value=true;error.value='';result.value=''
  try{const preferences=await window.baoyi.project.preferences();const value=await window.baoyi.project.prepareImport(mode);if(value){preview.value=value;selected.value=value.items.map((i,index)=>({index,checked:mode!=='discover'||i.suggested,name:i.name,category:i.category,source:i.source==='unknown'?preferences.defaultSource:i.source,mergeInto:''}))}}catch(e){error.value=(e as Error).message}finally{busy.value=false}
}
async function save(){if(busy.value||!preview.value||!count.value)return;busy.value=true;error.value='';try{
  const value=await window.baoyi.project.confirmImport(preview.value!.token,selected.value.filter(s=>s.checked).map(s=>({index:s.index,name:s.name,category:s.category,source:s.source,...(s.mergeInto.startsWith('existing:')?{existingId:s.mergeInto.slice(9)}:s.mergeInto!==''?{mergeInto:Number(s.mergeInto)}:{})})))
  if(value.imported)success('本地登记已完成，可在项目助手中补全资料');emit('imported');if(value.errors.length||value.warnings?.length){result.value=`已导入 ${value.imported} 个项目`;error.value=[...value.errors,...(value.warnings||[])].join('\n');preview.value=null}else emit('close')
}catch(e){error.value=(e as Error).message}finally{busy.value=false}}
</script>
<template><ProjectDialog title="添加项目" :busy="busy" wide @close="emit('close')"><p class="pj-muted">选一个完整项目，或从混合目录中发现项目。资料保留在原位置。</p><div class="pj-import-options"><button :disabled="busy" @click="scan('single')"><FolderOpen/><strong>导入一个项目</strong><span>已有清晰的项目目录</span></button><button :disabled="busy" @click="scan('discover')"><FolderSearch/><strong>从目录发现项目</strong><span>多个小项目放在一起</span></button><button :disabled="busy" @click="scan('file')"><FilePlus2/><strong>从文件建立项目</strong><span>从一份文稿或脚本开始</span></button></div>
<p v-if="busy" role="status">正在扫描或完成本地登记，请稍候…</p><p v-if="result">{{result}}</p><p v-if="error" class="pj-error" role="alert">{{error}}</p>
<template v-if="preview"><div class="pj-preview-title"><span class="pj-path">{{preview.root}}</span><button class="pj-button" :disabled="busy" @click="toggleAll()">切换全选</button></div><p class="pj-muted">选中 {{count}} / {{selected.length}} 项。合并为一个项目时，第一个项目的主目录作为移动范围，其余位置作为关联入口。</p>
<div v-if="!selected.length" class="pj-empty">没有找到候选，可使用“导入一个项目”手动登记此目录。</div>
<div class="pj-candidates"><article v-for="s in selected" :key="s.index" class="pj-candidate"><input v-model="s.checked" type="checkbox" :aria-label="'选择 '+s.name" :disabled="busy"/><div class="pj-candidate-fields"><input v-model="s.name" aria-label="候选项目名称" maxlength="160" :disabled="busy"/><span class="pj-path">{{preview.items[s.index].path}}</span><small>{{preview.items[s.index].evidence}}<span v-if="!preview.items[s.index].suggested"> · 待归属资料</span></small><div class="pj-inline"><select v-model="s.category" aria-label="候选分类" :disabled="busy"><option v-for="c in store.categories" :key="c">{{c}}</option></select><select v-model="s.source" aria-label="候选来源" :disabled="busy"><option value="unknown">来源未标记</option><option value="self">自己建立</option><option value="third-party">第三方项目</option><option value="mixed">混合来源</option></select><select v-model="s.mergeInto" aria-label="项目合并目标" :disabled="busy"><option value="">作为独立项目</option><option v-for="project in existing" :key="project.id" :value="'existing:'+project.id">加入已有项目：{{project.name}}</option><option v-for="other in selected.filter(x=>x.index!==s.index&&x.checked&&x.mergeInto==='')" :key="other.index" :value="String(other.index)">关联到 {{other.name}}</option></select></div></div></article></div></template>
<template #footer><button class="pj-button" :disabled="busy" @click="emit('close')">取消</button><button class="pj-button pj-primary" :disabled="busy||!preview||!count" @click="save"><Check :size="16"/>导入所选项目</button></template></ProjectDialog></template>
