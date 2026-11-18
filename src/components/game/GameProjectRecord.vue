<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue'
import {useRouter} from 'vue-router'
import type {GameItem} from '@/types'
import {projectOf} from '@/utils/game-project'
import {errorMessage,formatDateTime,gameTitle} from '@/utils'
import {useToast} from '@/composables/useToast'
const props=defineProps<{game:GameItem}>(),emit=defineEmits<{read:[path:string]}>()
const project=computed(()=>projectOf(props.game)),related=ref<GameItem[]>([]),router=useRouter(),{error}=useToast()
let disposed=false
onBeforeUnmount(()=>{disposed=true})
onMounted(async()=>{try{const games=await window.baoyi.game.list();if(!disposed)related.value=games.filter(g=>g.id!==props.game.id&&projectOf(g)?.family===project.value?.family&&projectOf(g)?.source===project.value?.source)}catch(e){if(!disposed)error(errorMessage(e))}})
const labels={open:'待处理',deferred:'游玩时验证',fixed:'已修复（范围见说明）'}
const issueCounts=computed(()=>Object.entries(labels).map(([status,label])=>({status,label,count:project.value?.issues.filter(i=>i.status===status).length||0})))
</script>
<template>
  <section v-if="project" class="project-detail" aria-label="精修状态与问题">
    <header><div><strong>{{project.platform}} · {{project.version||'版本见记录'}}</strong><p>{{project.synopsis}}</p></div><button v-if="project.guidePath" class="btn btn--ghost" @click="emit('read',project.guidePath)">使用与攻略导航</button></header>
    <div class="issue-overview"><span v-for="row in issueCounts" :key="row.status" :class="row.status">{{row.label}} <b>{{row.count}}</b></span></div>
    <details class="verification-details"><summary>工具、攻略与验证范围</summary><div class="facets"><article v-for="facet in project.facets" :key="facet.label"><strong>{{facet.label}}</strong><span>{{facet.state}}</span><p>{{facet.detail}}</p></article></div></details>
    <div v-if="related.length" class="siblings"><strong>同作其他版本</strong><button v-for="g in related" :key="g.id" class="btn btn--subtle" @click="router.push({name:'game-detail',params:{id:g.id}})">{{gameTitle(g)}} · {{projectOf(g)?.platform}}</button><small>版本差异与存档兼容性分别记录。</small></div>
    <details v-for="(label,status) in labels" :key="status" ><summary>{{label}} · {{project.issues.filter(i=>i.status===status).length}}</summary><ul><li v-for="issue in project.issues.filter(i=>i.status===status)" :key="issue.text">{{issue.text}}<details v-if="issue.evidence" class="issue-evidence"><summary>查看依据</summary><small>{{issue.evidence}}</small></details></li></ul><p v-if="!project.issues.some(i=>i.status===status)">此类暂无记录。</p></details>
    <details><summary>资料更新记录 · {{project.history.length}}</summary><p>来源：{{project.source}}</p><p v-for="h in project.history.slice().reverse()" :key="h.at">{{formatDateTime(h.at)}} · {{h.summary}}</p><p>“检查资料更新”只读取来源；重新导入前可预览差异，旧资料与个人修改保留。</p></details>
  </section>
</template>
<style scoped>
.project-detail{grid-column:1/-1;border:1px solid var(--card-border);border-radius:12px;padding:22px;background:var(--bg-card);font-size:12px;line-height:1.8;overflow-wrap:anywhere}.project-detail header{display:flex;align-items:flex-start;gap:18px}.project-detail header>div{flex:1;min-width:0}.project-detail p{color:var(--text-sub);white-space:pre-wrap}.facets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}.facets article{padding:14px;background:var(--bg-main);border-radius:8px}.facets strong,.facets span{display:block}.facets span{color:var(--accent-ink);margin-top:6px}.facets p{margin-bottom:0}.siblings{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.siblings small{width:100%;color:var(--text-faint)}details{border-top:1px solid var(--divider);padding:12px 0}summary{cursor:pointer;font-weight:500}li{margin:9px 0}li small{display:block;color:var(--text-faint)}@media(max-width:1000px){.facets{grid-template-columns:1fr 1fr}.project-detail header{flex-wrap:wrap}}
.issue-overview{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 18px}.issue-overview>span{background:var(--bg-main);border:1px solid var(--divider);border-radius:6px;padding:5px 10px;color:var(--text-sub)}.issue-overview b{margin-left:8px;color:var(--text-main)}.issue-overview .open b{color:var(--warning)}.issue-evidence{border:0;padding:4px 0;font-size:11px}.issue-evidence summary{color:var(--text-faint)}.project-detail header p{margin:6px 0;font-size:13px;line-height:1.8}
</style>
