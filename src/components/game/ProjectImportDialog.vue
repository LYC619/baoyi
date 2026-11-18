<script setup lang="ts">
import { computed, ref } from 'vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import type { GameProjectPreview, GameArtworkChoices } from '@/types/game-project'
import { errorMessage, plain } from '@/utils'
const props = defineProps<{preview:GameProjectPreview}>()
const emit = defineEmits<{close:[]; completed:[message:string]}>()
const selected = ref(props.preview.candidates.filter(item=>!item.problem).map(item=>item.key)),busy=ref(false),failure=ref('')
const eligible = computed(()=>props.preview.candidates.filter(item=>!item.problem))
const keyword=ref('')
const visible=computed(()=>props.preview.candidates.filter(item=>!keyword.value.trim()||item.name.toLowerCase().includes(keyword.value.trim().toLowerCase())))
const artwork=ref<GameArtworkChoices>(Object.fromEntries(eligible.value.map(item=>[item.key,(item.artwork||[]).filter(image=>!['protected','unavailable','current'].includes(image.state)).map(image=>image.role)])))
const forms={original:'原图',adapted:'适配图',typography:'文字占位'}
const states={new:'新增',changed:'更新',current:'已一致',recover:'恢复缓存',track:'补来源记录',protected:'保留手选',unavailable:'来源不可用'}
async function apply(){
  busy.value=true;failure.value=''
  try { const choices=Object.fromEntries(selected.value.filter(key=>artwork.value[key]?.length).map(key=>[key,artwork.value[key]]));const result=await window.baoyi.game.importProjects(props.preview.token,plain(selected.value),plain(choices));emit('completed',`新增 ${result.created} 款，更新 ${result.updated} 款，已一致 ${result.unchanged} 款${result.artworkUpdated?`；登记 ${result.artworkUpdated} 张图片，可在“撤销项目图片更新”中恢复`:''}`) }
  catch(error){failure.value=errorMessage(error)}finally{busy.value=false}
}
</script>
<template>
  <ProjectDialog title="登记精修游戏项目" :busy="busy" wide @close="emit('close')">
    <p class="intro">带入精修记录、攻略、工具和横竖封面。图片可按方向选择；手选图与焦点保留，缺失缓存可从来源恢复。游玩记录、笔记与手写说明保留。安卓登记安装包与资料。</p>
    <p class="source">{{preview.source}}</p>
    <div class="selection"><strong>{{eligible.length}} 款可登记</strong><span>{{preview.excluded}} 项未满足精修、平台或本体条件</span><button class="btn btn--subtle" :disabled="busy" @click="selected=selected.length?[]:eligible.map(item=>item.key)">{{selected.length?'取消全选':'全选'}}</button></div>
    <div v-if="!preview.candidates.length" class="empty">这份清单中没有已完成精修整理、具有本体与精修记录的 Windows 或安卓游戏。</div>
    <input v-model="keyword" class="filter" type="search" aria-label="筛选项目" placeholder="按游戏名称筛选…"/>
    <p v-if="!visible.length&&preview.candidates.length" class="empty">没有匹配的项目。</p>
    <div v-for="item in visible" :key="item.key" class="candidate" :class="{blocked:item.problem}">
      <input v-model="selected" type="checkbox" :value="item.key" :disabled="busy||!!item.problem" :aria-label="`登记 ${item.name}`"/>
      <div><div class="name"><strong>{{item.name}}</strong><span>{{item.problem?'需要处理':item.relocate?'已在库 · 更新旧路径':item.existingId?'已在库 · 补充资料':'新增游戏'}}</span></div><p>{{item.platform}} · {{item.status==='runtime_verified'?'限定运行验证':'静态检查与隔离测试'}}{{item.platform==='Android'?' · 设备运行未认证':''}}</p><p>{{item.summary}}</p><p class="source">{{item.root}}</p><details class="diff"><summary>资料差异：新增 {{item.changes.added.length}} · 刷新 {{item.changes.refreshed.length}} · 保留旧资料 {{item.changes.retired.length}} · 缺失 {{item.changes.missing.length}}</summary><p v-if="item.changes.metadata">精修状态、问题或来源内容有变化</p><p v-for="(list,key) in item.changes" :key="key"><template v-if="Array.isArray(list)&&list.length">{{({added:'新增',refreshed:'刷新来源内容（手写内容保留）',retired:'来源不再提供，保留旧关联',missing:'原附件缺失'} as Record<string,string>)[key]}}：{{list.join('、')}}</template></p></details>
        <details v-if="item.artwork?.length" class="artwork-diff"><summary>封面：{{item.artwork.map(image=>`${image.role==='portrait'?'竖图':'横图'}${states[image.state]}`).join(' · ')}}</summary><div class="artwork-grid"><article v-for="image in item.artwork" :key="image.role"><label><input v-model="artwork[item.key]" type="checkbox" :value="image.role" :aria-label="`${item.name} ${image.role==='portrait'?'竖图':'横图'}`" :disabled="busy||!selected.includes(item.key)||['protected','unavailable','current'].includes(image.state)"/>{{image.role==='portrait'?'竖图':'横图'}} · {{states[image.state]}}</label><div class="pictures"><figure><img v-if="image.currentPreviewUrl" :src="image.currentPreviewUrl" alt="当前图片"/><span v-else>无可用图片</span><figcaption>当前</figcaption></figure><figure><img v-if="image.previewUrl" :src="image.previewUrl" alt="清单图片"/><span v-else>来源不可用</span><figcaption>清单 · {{forms[image.form]}}</figcaption></figure></div><p>{{image.detail}}</p><details><summary>图片来源与位置</summary><p>{{image.layout}}</p><p class="source">原图：{{image.source||'文字排版'}}</p><p v-if="image.page" class="source">来源页：{{image.page}}</p><p class="source">清单图片：{{image.path}}</p><p class="source">当前缓存：{{image.currentPath||'暂无'}}</p></details></article></div></details>
        <small>{{item.links.filter(link=>link.type==='trainer').length}} 个工具与说明 · {{item.links.filter(link=>link.type==='guide').length}} 份攻略与资料</small><p v-if="item.problem" class="failure">{{item.problem}}</p></div>
    </div>
    <p v-if="failure" class="failure" role="alert">{{failure}}</p>
    <template #footer><span>原文件保留；图片另存本机并记录撤销备份</span><button class="btn btn--primary" :disabled="busy||!selected.length" @click="apply">{{busy?'登记中…':`登记所选 ${selected.length} 款`}}</button></template>
  </ProjectDialog>
</template>
<style scoped>
.intro{line-height:1.8;color:var(--text-sub);margin:0 0 8px}.source{font-size:12px;color:var(--text-muted);overflow-wrap:anywhere}.selection{display:flex;align-items:center;gap:12px;margin:20px 0 8px}.selection>span{flex:1;color:var(--text-muted);font-size:12px}.candidate{display:flex;gap:14px;padding:18px 0;border-top:1px solid var(--divider);cursor:pointer}.candidate>input{margin-top:5px;accent-color:var(--accent)}.candidate>div{flex:1;min-width:0}.name{display:flex;gap:10px;align-items:baseline;justify-content:space-between}.name span{font-size:11px;color:var(--accent);white-space:nowrap}.candidate p{font-size:12px;line-height:1.7;margin:6px 0}.candidate small,.empty{color:var(--text-muted)}.failure{color:var(--danger,#b85b50)}.blocked{opacity:.75}.empty{padding:24px 0}footer span{font-size:12px}
</style>
<style scoped>
.filter{width:100%;padding:9px 12px;border:1px solid var(--divider);border-radius:8px;background:var(--bg-main);color:var(--text-main)}.artwork-diff{margin:10px 0}.artwork-diff summary{cursor:pointer}.artwork-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.artwork-grid article{min-width:0;padding:12px;border:1px solid var(--divider);border-radius:8px}.artwork-grid label{display:flex;align-items:center;gap:8px}.pictures{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.pictures figure{margin:0;min-width:0;text-align:center}.pictures img{width:100%;height:130px;object-fit:contain;background:var(--bg-main)}.pictures span{display:block;padding:45px 0;color:var(--text-muted)}figcaption{font-size:11px;color:var(--text-muted)}@media(max-width:650px){.artwork-grid{grid-template-columns:1fr}.name{flex-wrap:wrap}.selection{flex-wrap:wrap}}
</style>
