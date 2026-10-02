<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, Heart, RefreshCw, FolderOpen, Trash2, Images } from 'lucide-vue-next'
import { useImageStore } from '@/stores/image'
import ImageCover from '@/components/image/ImageCover.vue'
import ImageReader from '@/components/image/ImageReader.vue'
import ImageIntegrityPanel from '@/components/image/ImageIntegrityPanel.vue'
import ImageUpdatePanel from '@/components/image/ImageUpdatePanel.vue'
import '@/components/image/image.css'
import type { ImageItem, ImagePage, ImagePatch } from '@/types/image'
const props=defineProps<{id:string}>(), route=useRoute(),router=useRouter(),store=useImageStore()
const item=ref<ImageItem|null>(null),pages=ref<ImagePage[]>([]),error=ref(''),busy=ref(false),reading=ref(false),start=ref(''),limit=ref(120),tagText=ref('')
const selectedChapter=ref<string|null>(null)
let readerTrigger:HTMLElement|null=null
const previewPages=computed(()=>item.value?.type==='comic' && selectedChapter.value?pages.value.filter(p=>p.chapterId===selectedChapter.value):pages.value)
const shown=computed(()=>previewPages.value.slice(0,limit.value))
const previewChapter=computed(()=>item.value?.chapters.find(c=>c.id===selectedChapter.value))
function selectChapter(id:string){selectedChapter.value=id;limit.value=120}
async function load(){try{
  item.value=await window.baoyi.image.get(props.id);pages.value=await window.baoyi.image.pages(props.id)
  if(selectedChapter.value===null || selectedChapter.value && !item.value?.chapters.some(c=>c.id===selectedChapter.value)){
    selectedChapter.value=item.value?.progress?.chapterId || item.value?.chapters[0]?.id || ''
  }
  tagText.value=item.value?.tags.join('，')||'';await store.refresh()
}catch(cause){error.value=(cause as Error).message}}
async function patch(value:ImagePatch){try{item.value=await window.baoyi.image.update(props.id,value);await store.refresh()}catch(cause){error.value=(cause as Error).message}}
function read(id=''){if(!pages.value.length)return;readerTrigger=document.activeElement as HTMLElement;start.value=id;reading.value=true}
async function close(){reading.value=false;await load();await nextTick();if(readerTrigger?.isConnected)readerTrigger.focus()}
async function rescan(relocate=false){busy.value=true;error.value='';try{if(relocate)await window.baoyi.image.relocate(props.id);else await window.baoyi.image.rescan(props.id);await load()}catch(cause){error.value=(cause as Error).message}finally{busy.value=false}}
async function remove(){if(!confirm('仅从图片库移除此项？原文件会保留。'))return;try{await window.baoyi.image.remove(props.id);await store.refresh();await router.push('/image')}catch(cause){error.value=(cause as Error).message}}
onMounted(async()=>{await load();if(route.query.read==='1')read()})
</script>
<template><main class="im-page image-detail"><header class="detail-toolbar"><button class="im-button" @click="router.push('/image')"><ArrowLeft :size="17"/>返回书架</button><span/><button class="im-button" :disabled="busy" @click="rescan()"><RefreshCw :size="16"/>重新扫描</button><button class="im-button" :disabled="busy" @click="rescan(true)"><FolderOpen :size="17"/>重新定位</button><button class="im-icon" aria-label="移除图片资源" @click="remove"><Trash2 :size="18"/></button></header><p v-if="error" role="alert" class="im-error">{{error}}</p>
  <div v-if="!item" class="im-empty"><Images :size="40"/><h2>资源不可用</h2><p>资源可能已移除，或所属类型已隐藏。</p></div><template v-else><section class="detail-info"><ImageCover :page-id="item.coverPageId" :name="item.name" :photo="item.type==='photo'"/><div class="detail-fields"><input class="detail-title" :value="item.name" aria-label="图片资源名称" @change="patch({name:($event.target as HTMLInputElement).value})"/><p class="detail-meta">{{item.type==='comic'?'漫画':'相册'}} · {{item.chapterCount?item.chapterCount+' 章 · ':''}}{{item.pageCount}} 页 <span v-if="item.source">· {{item.source==='pica'?'哔咔':item.source}}</span></p><p class="detail-path">{{item.path}}</p><label class="im-field">简介<textarea :value="item.description" placeholder="添加说明…" @change="patch({description:($event.target as HTMLTextAreaElement).value})"/></label><div class="detail-options"><label v-if="item.type==='comic'" class="im-field">类型<select :value="item.groupId||''" @change="patch({groupId:($event.target as HTMLSelectElement).value||null})"><option value="">未分类</option><option v-for="group in store.groups.filter(g=>!g.hidden)" :key="group.id" :value="group.id">{{group.name}}</option></select></label><label v-if="item.type==='comic'" class="im-field">连载状态<select :value="item.publication" @change="patch({publication:($event.target as HTMLSelectElement).value as ImageItem['publication']})"><option value="unknown">未标注</option><option value="ongoing">连载中</option><option value="completed">完结</option></select></label><label class="im-field detail-tags">标签<input v-model="tagText" placeholder="用逗号分隔" @change="patch({tags:tagText.split(/[，,]/).map(t=>t.trim()).filter(Boolean)})"/></label></div><div class="detail-actions"><button class="im-button im-primary" :disabled="!pages.length" @click="read()"><BookOpen :size="18"/>{{item.type==='photo'?'浏览照片':item.progress?'继续阅读':'开始阅读'}}</button><button class="im-button" :class="{favorite:item.favorite}" @click="patch({favorite:!item.favorite})"><Heart :size="17"/>{{item.favorite?'已收藏':'收藏'}}</button><span v-if="item.progress && item.type==='comic'">读到第 {{item.progress.ordinal+1}} 页</span></div></div></section>
  <div class="detail-utilities" aria-label="作品工具">
    <label class="detail-read-state"><input type="checkbox" :checked="item.read" @change="patch({read:($event.target as HTMLInputElement).checked})"/>已读</label>
    <ImageIntegrityPanel :key="item.id" :resource-id="item.id" compact @repaired="load"/>
    <ImageUpdatePanel v-if="item.type==='comic' && item.source==='pica'" :key="'updates:'+item.id" :resource-id="item.id" compact @updated="load"/>
  </div>
  <section v-if="item.type==='comic'" class="detail-chapters"><header><h2>章节 <small>选择章节查看预览</small></h2><button class="im-button chapter-all" :aria-pressed="selectedChapter===''" @click="selectChapter('')">全部页面</button></header><div><button v-for="c in item.chapters" :key="c.id" :class="{current:c.id===selectedChapter}" :aria-pressed="c.id===selectedChapter" @click="selectChapter(c.id)"><BookOpen :size="18"/><strong>{{c.title}}<small v-if="c.id===item.progress?.chapterId">上次阅读</small></strong><span>{{c.pageCount?c.pageCount+' 页':'页面缺失'}}</span></button></div></section>
  <section class="detail-pages"><header><h2>{{item.type==='photo'?'相册照片':previewChapter?previewChapter.title+' · 预览':'全部页面'}}<small>{{previewPages.length}} 页 · 点击阅读，右键设为封面</small></h2><button v-if="previewChapter" class="im-button" :disabled="!previewPages.length" @click="read(previewPages[0]?.id)"><BookOpen :size="16"/>阅读本章</button></header><p v-if="!previewPages.length" class="preview-empty">本章暂无本地页面，可通过文件检查查看缺失情况。</p><div><button v-for="p in shown" :key="p.id" :aria-label="`打开第 ${p.ordinal+1} 页`" @click="read(p.id)" @contextmenu.prevent="patch({coverPageId:p.id})"><ImageCover :page-id="p.id" :name="`第 ${p.ordinal+1} 页`" :photo="item.type==='photo'"/><span>{{p.ordinal+1}}</span></button></div><button v-if="limit<previewPages.length" class="im-button detail-more" @click="limit+=120">显示更多（{{limit}} / {{previewPages.length}}）</button></section>
  <ImageReader v-if="reading" :item="item" :pages="pages" :start-id="start" @close="close"/></template>
</main></template>
<style scoped>
.detail-utilities{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:22px 0 24px;padding:10px 0;border-block:1px solid var(--divider)}
.detail-read-state{display:flex;align-items:center;gap:8px;margin-right:auto;color:var(--text-sub);font-size:13px}.detail-read-state input{accent-color:var(--accent)}
.detail-chapters>header,.detail-pages>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.detail-chapters>header h2,.detail-pages>header h2{margin:0;line-height:1.8}
.detail-chapters h2 small{font-size:12px;font-weight:400;color:var(--text-sub);margin-left:10px}
.detail-chapters strong small{display:block;margin-top:4px;color:var(--text-sub);font-size:10px;font-weight:400}
.detail-chapters .chapter-all{padding:6px 11px;font-size:12px}.chapter-all[aria-pressed=true]{color:var(--accent)}
.preview-empty{padding:22px;color:var(--text-sub);background:var(--bg-card);border-radius:8px}
.image-detail{overflow:auto;padding:22px 32px 50px}.detail-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:24px}.detail-toolbar>span{flex:1}.detail-info{display:flex;align-items:flex-start;gap:30px;max-width:1180px}.detail-info>.image-cover{width:210px;border-radius:8px}.detail-info>.image-cover--photo{width:280px}.detail-fields{flex:1;min-width:0}.detail-fields .detail-title{font-size:26px;font-weight:600;border-color:transparent;background:transparent;padding:0 0 8px;width:100%;border-radius:0}.detail-meta{color:var(--text-sub);margin:0 0 12px}.detail-path{color:var(--text-faint);font-size:11px;overflow-wrap:anywhere;line-height:1.6}.detail-options{display:flex;gap:14px;align-items:center}.detail-options>.im-field{flex:1;min-width:0}.detail-tags{flex:2!important}.detail-actions{display:flex;align-items:center;gap:12px;margin-top:18px}.detail-actions>span{color:var(--text-sub);font-size:12px}.favorite{color:var(--accent)}.detail-chapters{margin-top:32px}.detail-chapters h2,.detail-pages h2{font-size:19px;margin:0 0 18px}.detail-chapters>div{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}.detail-chapters button{display:flex;align-items:center;gap:10px;background:var(--bg-card);padding:17px;border:1px solid var(--divider);border-radius:8px;text-align:left;color:var(--text-main)}.detail-chapters strong{flex:1;font-weight:500}.detail-chapters span{color:var(--text-sub);font-size:11px}.detail-chapters .current{border-color:var(--accent);color:var(--accent)}.detail-pages{margin-top:32px}.detail-pages h2 small{font-weight:400;font-size:11px;color:var(--text-faint);margin-left:14px}.detail-pages>div{display:grid;grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:15px}.detail-pages button{min-width:0;position:relative;border-radius:6px;overflow:hidden}.detail-pages button>span{position:absolute;bottom:6px;right:6px;background:#111b;color:white;border-radius:4px;padding:3px 6px;font-size:10px}.detail-more{margin-top:24px}@media(max-width:1100px){.detail-info{gap:20px}.detail-info>.image-cover{width:170px}.image-detail{padding:20px}.detail-options{gap:8px}}
</style>
