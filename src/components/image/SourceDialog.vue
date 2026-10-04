<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue'
import { X, Search, ArrowLeft, Download } from 'lucide-vue-next'
import { useImageStore } from '@/stores/image'
import ImageDownloadList from './ImageDownloadList.vue'
import SourceCover from './SourceCover.vue'
import type { ImageSourceWork,ImageSourceChapter,ImageSourceRank,ImageSourceSort } from '@/types/image'
type BrowseMode='search'|'favorites'|'ranking'
const emit=defineEmits<{close:[]}>(),store=useImageStore(),logged=ref(false),account=ref(''),password=ref(''),busy=ref(false),error=ref(''),query=ref(''),page=ref(1),total=ref(0)
const mode=ref<BrowseMode>('search'),sort=ref<ImageSourceSort>('dd'),period=ref<ImageSourceRank>('H24'),searched=ref(false),activeQuery=ref('')
const results=ref<ImageSourceWork[]>([]),detail=ref<{work:ImageSourceWork;chapters:ImageSourceChapter[]}|null>(null),selected=ref<string[]>([]),group=ref(''),message=ref('')
const selectedWorks=ref<string[]>([])
const owned=ref<string[]>([]),queued=ref<string[]>([]),ownedChapters=ref<Record<string,string[]>>({})
const selectableResults=computed(()=>results.value.filter(work=>!owned.value.includes(work.id)))
const sourceState=(workId:string)=>owned.value.includes(workId)?'已入库':queued.value.includes(workId)?'下载中':''
async function refreshOwned(){
  const ids=[...new Set([...results.value.map(work=>work.id),...(detail.value?[detail.value.work.id]:[])])]
  if(!ids.length){owned.value=[];queued.value=[];ownedChapters.value={};return}
  try{const state=await window.baoyi.image.sourceOwned(ids);owned.value=state.owned;queued.value=state.queued;ownedChapters.value=state.chapters}
  catch{/* 标注只是辅助信息：取不到也不该挡住浏览和下载 */}
}
async function downloadBatch(){
  busy.value=true;error.value='';message.value=''
  try {const result=await window.baoyi.image.downloadBatch([...selectedWorks.value],group.value||null);if(result){message.value=`已加入 ${result.enqueued} 部，跳过已入库或排队的 ${result.skipped} 部。`;error.value=result.errors.join('\n');selectedWorks.value=[]}}
  catch(cause){error.value=(cause as Error).message}finally{busy.value=false}
}
async function login(){busy.value=true;error.value='';try{await window.baoyi.image.sourceLogin(account.value,password.value);logged.value=true}catch(cause){error.value=(cause as Error).message}finally{password.value='';busy.value=false}}
async function logout(){busy.value=true;error.value='';try{await window.baoyi.image.sourceLogout();logged.value=false;results.value=[];detail.value=null;total.value=0;mode.value='search';searched.value=false;query.value='';activeQuery.value='';message.value=''}catch(cause){error.value=(cause as Error).message}finally{busy.value=false}}
async function browse(at=1){
  if(busy.value)return
  busy.value=true;error.value='';detail.value=null;message.value='';results.value=[];total.value=0;selectedWorks.value=[]
  try{
    const response=mode.value==='favorites'?await window.baoyi.image.sourceFavorites(at,sort.value):mode.value==='ranking'?await window.baoyi.image.sourceRanking(period.value):await window.baoyi.image.sourceSearch(activeQuery.value,at)
    results.value=response.items;page.value=at;total.value=response.pages;searched.value=true;await refreshOwned()
  }catch(cause){error.value=(cause as Error).message}finally{busy.value=false}
}
async function switchMode(next:BrowseMode){
  if(busy.value)return
  mode.value=next;detail.value=null;results.value=[];total.value=0;page.value=1;error.value='';message.value='';searched.value=false
  if(next!=='search'||activeQuery.value)await browse()
}
async function search(){if(!query.value.trim()||busy.value)return;mode.value='search';activeQuery.value=query.value.trim();await browse()}
async function open(work:ImageSourceWork){busy.value=true;error.value='';message.value='';selected.value=[];try{detail.value=await window.baoyi.image.sourceDetail(work.id);selected.value=detail.value.chapters.map(c=>c.id);await refreshOwned()}catch(cause){error.value=(cause as Error).message}finally{busy.value=false}}
async function download(){if(!detail.value)return;busy.value=true;error.value='';try{const job=await window.baoyi.image.download(detail.value.work.id,[...selected.value],group.value||null);if(job)message.value='已加入下载队列。完成后会自动加入漫画书架。'}catch(cause){error.value=(cause as Error).message}finally{busy.value=false}}
onMounted(async()=>{busy.value=true;try{logged.value=await window.baoyi.image.sourceStatus()}catch(cause){error.value=(cause as Error).message}finally{busy.value=false}})
watch(()=>store.items,()=>void refreshOwned())
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="!busy&&emit('close')"><section class="im-dialog source-dialog" role="dialog" aria-modal="true" aria-label="从哔咔添加"><header><div><h2>从哔咔添加</h2><p>浏览收藏与榜单，选好章节下载到本地。</p></div><button class="im-icon" aria-label="关闭哔咔" @click="emit('close')"><X :size="20"/></button></header>
  <form v-if="!logged" class="source-login" @submit.prevent="login"><label class="im-field">用户名<input v-model="account" type="text" autocomplete="username" required/></label><label class="im-field">密码<input v-model="password" type="password" autocomplete="current-password" required/></label><p>使用系统网络与代理。登录状态由系统加密保存，密码不保留。</p><button class="im-button im-primary" :disabled="busy">{{busy?'登录中…':'登录哔咔'}}</button></form>
  <template v-else>
    <nav class="source-tabs" aria-label="哔咔浏览方式">
      <button class="im-button" :class="{'im-primary':mode==='search'}" :aria-pressed="mode==='search'" :disabled="busy" @click="switchMode('search')">搜索</button>
      <button class="im-button" :class="{'im-primary':mode==='favorites'}" :aria-pressed="mode==='favorites'" :disabled="busy" @click="switchMode('favorites')">我的收藏</button>
      <button class="im-button" :class="{'im-primary':mode==='ranking'}" :aria-pressed="mode==='ranking'" :disabled="busy" @click="switchMode('ranking')">排行榜</button>
      <button class="im-button source-logout" :disabled="busy" @click="logout">退出登录</button>
    </nav>
    <template v-if="detail">
      <button class="im-icon" :disabled="busy" @click="detail=null;error='';message=''"><ArrowLeft :size="16"/>返回列表</button>
      <div class="source-detail-heading"><SourceCover :url="detail.work.coverUrl" :title="detail.work.title"/><div><h3>{{detail.work.title}}<small v-if="sourceState(detail.work.id)" class="source-flag" :class="{'source-flag--queued':!owned.includes(detail.work.id)}">{{sourceState(detail.work.id)}}</small></h3><p class="source-meta">{{detail.work.author||'作者未标注'}} · {{detail.work.pages}} 页 · {{detail.work.finished?'完结':'连载中'}}</p><p class="source-meta">{{detail.work.tags.join(' · ')}}</p></div></div>
      <p class="source-description">{{detail.work.description}}</p><div class="source-selection"><label><input type="checkbox" :checked="selected.length===detail.chapters.length&&detail.chapters.length>0" @change="selected=($event.target as HTMLInputElement).checked?detail.chapters.map(c=>c.id):[]"/>全选章节</label><span>已选 {{selected.length}} 章</span></div><div class="source-chapters"><label v-for="chapter in detail.chapters" :key="chapter.id" :class="{owned:ownedChapters[detail.work.id]?.includes(chapter.id)}"><input v-model="selected" type="checkbox" :value="chapter.id"/>{{chapter.title}}<small v-if="ownedChapters[detail.work.id]?.includes(chapter.id)" class="source-flag">已入库</small></label></div><p v-if="!detail.chapters.length" class="source-meta">暂无可下载章节。</p><footer><select v-model="group" aria-label="下载漫画分类"><option value="">未分类</option><option v-for="g in store.groups.filter(g=>!g.hidden)" :key="g.id" :value="g.id">{{g.name}}</option></select><button class="im-button im-primary" :disabled="busy||!selected.length" @click="download"><Download :size="17"/>选择目录并下载</button></footer><p v-if="message" role="status">{{message}}</p>
    </template>
    <template v-else>
      <form v-if="mode==='search'" class="source-search" @submit.prevent="search"><Search :size="18"/><input v-model="query" placeholder="搜索漫画名称、作者…" aria-label="搜索哔咔"/><button class="im-button im-primary" :disabled="busy||!query.trim()">搜索作品</button></form>
      <div v-else class="source-filters"><label v-if="mode==='favorites'">收藏排序 <select v-model="sort" aria-label="收藏排序" :disabled="busy" @change="browse()"><option value="dd">最新收藏</option><option value="da">最早收藏</option></select></label><label v-else>榜单周期 <select v-model="period" aria-label="榜单周期" :disabled="busy" @change="browse()"><option value="H24">日榜</option><option value="D7">周榜</option><option value="D30">月榜</option></select></label><button class="im-button" :disabled="busy" @click="browse(page)">刷新</button></div>
      <div v-if="results.length" class="source-batch"><label><input type="checkbox" :disabled="busy||!selectableResults.length" :checked="selectableResults.length>0&&selectedWorks.length===selectableResults.length" @change="selectedWorks=($event.target as HTMLInputElement).checked?selectableResults.map(w=>w.id):[]"/>全选当前页</label><span>已选 {{selectedWorks.length}} 部</span><select v-model="group" aria-label="批量下载分类"><option value="">未分类</option><option v-for="g in store.groups.filter(g=>!g.hidden)" :key="g.id" :value="g.id">{{g.name}}</option></select><button class="im-button im-primary" :disabled="busy||!selectedWorks.length" @click="downloadBatch">批量下载（{{selectedWorks.length}}）</button></div>
      <div class="source-results"><article v-for="(work,index) in results" :key="work.id"><input v-model="selectedWorks" :value="work.id" type="checkbox" :aria-label="'选择下载 '+work.title" :disabled="busy||owned.includes(work.id)"/><button :disabled="busy" @click="open(work)"><SourceCover :url="work.coverUrl" :title="work.title"/><div class="source-card-copy"><small v-if="mode==='ranking'" class="source-rank">第 {{index+1}} 名</small><strong>{{work.title}}</strong><small v-if="sourceState(work.id)" class="source-flag" :class="{'source-flag--queued':!owned.includes(work.id)}">{{sourceState(work.id)}}</small><span>{{work.author||'作者未标注'}} · {{work.chapters}} 章 · {{work.finished?'完结':'连载中'}}</span><small>{{work.tags.join(' · ')}}</small></div></button></article></div><p v-if="message" role="status">{{message}}</p>
      <div v-if="total>0&&mode!=='ranking'" class="source-pagination"><button class="im-button" :disabled="page<=1||busy" @click="browse(page-1)">上一页</button><span>{{page}} / {{total}}</span><button class="im-button" :disabled="page>=total||busy" @click="browse(page+1)">下一页</button></div>
      <p v-if="!busy&&!results.length&&!error" class="source-meta">{{mode==='favorites'?'账号暂无收藏作品。':mode==='ranking'?'当前榜单暂无作品。':searched?'没有找到匹配的作品。':'输入名称搜索，或查看账号收藏和排行榜。'}}</p>
    </template>
  </template><p v-if="busy" class="source-meta" role="status">正在连接来源…</p><p v-if="error" class="im-error" role="alert">{{error}}</p><ImageDownloadList/>
</section></div></Teleport></template>
<style scoped>
.source-dialog{width:820px}.source-login{max-width:400px;margin:0 auto}.source-login p,.source-meta{color:var(--text-sub);line-height:1.7;font-size:12px}.source-tabs,.source-filters{display:flex;align-items:center;gap:9px;margin-bottom:18px;flex-wrap:wrap}.source-logout{margin-left:auto}.source-filters{justify-content:space-between}.source-search{display:flex;align-items:center;gap:9px;margin-bottom:22px}.source-search>input{flex:1;min-width:0}.source-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.source-results article>button{display:flex;align-items:flex-start;text-align:left;gap:13px;padding:12px;border:1px solid var(--divider);border-radius:7px;background:var(--bg-card);color:var(--text-main);min-width:0}.source-results article>button:hover{border-color:var(--accent)}.source-card-copy{display:flex;flex-direction:column;gap:8px;min-width:0;overflow-wrap:anywhere}.source-results span{color:var(--text-sub);font-size:11px}.source-results small{color:var(--text-faint);font-size:10px}.source-results .source-rank{color:var(--accent)}.source-results .source-flag,.source-chapters .source-flag,.source-detail-heading .source-flag{margin-left:7px;padding:1px 6px;border:1px solid var(--accent);border-radius:99px;color:var(--accent);font-size:10px;white-space:nowrap;flex:none}.source-flag--queued{border-color:var(--text-faint)!important;color:var(--text-sub)!important}.source-chapters label.owned{border-color:var(--accent)}.source-results strong{font-weight:500;line-height:1.6}.source-pagination{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:20px}.source-detail-heading{display:flex;gap:18px;margin-top:16px;overflow-wrap:anywhere}.source-detail-heading>div{min-width:0}.source-description{max-height:170px;overflow:auto;white-space:pre-wrap;line-height:1.7;color:var(--text-sub)}.source-selection{display:flex;justify-content:space-between;padding:12px 0}.source-chapters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;max-height:210px;overflow:auto}.source-chapters label{display:flex;align-items:center;gap:8px;background:var(--bg-card);padding:10px;border-radius:5px;overflow-wrap:anywhere}.source-selection label{display:flex;gap:8px}.source-chapters input{flex:none}@media(max-width:650px){.source-results{grid-template-columns:1fr}.source-chapters{grid-template-columns:1fr 1fr}}
</style>

<style scoped>.source-batch{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;font-size:12px;color:var(--text-sub)}.source-batch label{display:flex;gap:7px}.source-batch .im-primary{margin-left:auto}.source-results article{position:relative;min-width:0}.source-results article>input{position:absolute;top:8px;left:8px;z-index:1;width:17px;height:17px}.source-results article>button{width:100%;height:100%;padding-left:30px}</style>
