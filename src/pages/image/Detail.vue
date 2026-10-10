<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, Heart, RefreshCw, FolderOpen, Trash2, Images } from 'lucide-vue-next'
import { useImageStore } from '@/stores/image'
import ImagePhotoInfo from '@/components/image/ImagePhotoInfo.vue'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import ImageCover from '@/components/image/ImageCover.vue'
import { useImageReader } from '@/composables/useImageReader'
import ImageIntegrityPanel from '@/components/image/ImageIntegrityPanel.vue'
import ImageUpdatePanel from '@/components/image/ImageUpdatePanel.vue'
import '@/components/image/image.css'
import type { ImageItem, ImagePage, ImagePatch } from '@/types/image'
const props=defineProps<{id:string}>(), route=useRoute(),router=useRouter(),store=useImageStore()
const item=ref<ImageItem|null>(null),pages=ref<ImagePage[]>([]),error=ref(''),busy=ref(false),limit=ref(120),tagText=ref('')
const choosingCover=ref(false), coverLimit=ref(120)
const detailTabs=[{id:'pages',label:'内容预览'},{id:'info',label:'资料信息'},{id:'files',label:'文件管理'}]
const activeTab=ref('pages')
watch(()=>route.query.tab,tab=>{activeTab.value=detailTabs.some(t=>t.id===tab)?String(tab):'pages'},{immediate:true})
watch(activeTab,tab=>{if(route.query.tab!==tab)void router.replace({query:{...route.query,tab}})})
async function choosePage(id:string){if(choosingCover.value){if(await patch({coverPageId:id}))choosingCover.value=false}else read(id)}
const selectedChapter=ref<string|null>(null)
const reader=useImageReader()
const previewPages=computed(()=>item.value?.type==='comic' && selectedChapter.value?pages.value.filter(p=>p.chapterId===selectedChapter.value):pages.value)
const shown=computed(()=>previewPages.value.slice(0,limit.value))
const previewChapter=computed(()=>item.value?.chapters.find(c=>c.id===selectedChapter.value))
function selectChapter(id:string){selectedChapter.value=id;limit.value=120}
const status = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
let requestEpoch = 0, routeEpoch = 0, disposed = false
const currentReady = computed(() => status.value === 'ready' && item.value?.id === props.id)
const canRecover = computed(() => !busy.value && status.value !== 'loading' && (currentReady.value || !item.value))
function owner() {
  const id = props.id, epoch = routeEpoch
  return { id, current: () => !disposed && props.id === id && routeEpoch === epoch }
}
async function load(autoRead = false) {
  const target = owner(), request = ++requestEpoch
  const current = () => target.current() && request === requestEpoch
  status.value = 'loading'
  error.value = ''
  try {
    const nextItem = await window.baoyi.image.get(target.id)
    if (!current()) return
    const nextPages = nextItem ? await window.baoyi.image.pages(target.id) : []
    if (!current()) return
    await store.refresh()
    if (!current()) return
    item.value = nextItem
    pages.value = nextPages
    status.value = nextItem ? 'ready' : 'missing'
    if (selectedChapter.value === null || selectedChapter.value && !nextItem?.chapters.some(c => c.id === selectedChapter.value)) {
      selectedChapter.value = nextItem?.progress?.chapterId || nextItem?.chapters[0]?.id || ''
    }
    tagText.value = nextItem?.tags.join('，') || ''
    if (autoRead && currentReady.value) read()
  } catch (cause) {
    if (!current()) return
    item.value = null
    pages.value = []
    status.value = 'error'
    error.value = (cause as Error).message
  }
}
async function patch(value: ImagePatch) {
  if (!currentReady.value || busy.value) return false
  const target = owner()
  busy.value = true
  error.value = ''
  try {
    const updated = await window.baoyi.image.update(target.id, value)
    if (!target.current()) return false
    await store.refresh()
    if (!target.current()) return false
    item.value = updated
    tagText.value = updated?.tags.join('，') || ''
    status.value = updated ? 'ready' : 'missing'
    return true
  } catch (cause) {
    if (target.current()) error.value = (cause as Error).message
    return false
  } finally {
    if (target.current()) busy.value = false
  }
}
function read(id = '') {
  if (currentReady.value && item.value) reader.open(item.value, pages.value, id)
}
watch(reader.session, value => { if (!value && !disposed) void load() })
async function rescan(relocate = false) {
  if (!canRecover.value) return
  const target = owner()
  busy.value = true
  error.value = ''
  try {
    if (relocate) await window.baoyi.image.relocate(target.id)
    else await window.baoyi.image.rescan(target.id)
    if (target.current()) await load()
  } catch (cause) {
    if (target.current()) error.value = (cause as Error).message
  } finally {
    if (target.current()) busy.value = false
  }
}
async function remove(deleteFiles = false) {
  if (!currentReady.value || busy.value) return
  if (!deleteFiles && !confirm('仅从图片库移除此项？原文件会保留。')) return
  const target = owner()
  busy.value = true
  error.value = ''
  try {
    await window.baoyi.image.remove(target.id, deleteFiles)
    if (!target.current()) return
    const remaining = await window.baoyi.image.get(target.id)
    if (!target.current() || remaining) return
    await store.refresh()
    if (target.current()) await router.push('/image')
  } catch (cause) {
    if (target.current()) error.value = (cause as Error).message
  } finally {
    if (target.current()) busy.value = false
  }
}
async function move() {
  if (!currentReady.value || busy.value) return
  const target = owner()
  busy.value = true
  error.value = ''
  try {
    const result = await window.baoyi.image.move([target.id], false)
    if (!target.current()) return
    await load()
    if (target.current() && result?.warnings.length) error.value = result.warnings.join('\n')
  } catch (cause) {
    if (target.current()) error.value = (cause as Error).message
  } finally {
    if (target.current()) busy.value = false
  }
}
async function reveal() {
  if (!currentReady.value || busy.value) return
  const target = owner()
  try {
    const opened = await window.baoyi.image.reveal(target.id)
    if (target.current() && !opened) error.value = '找不到这个作品的目录，可能已被移动、删除，或所属分类已隐藏'
  } catch (cause) {
    if (target.current()) error.value = (cause as Error).message
  }
}
watch(() => props.id, () => {
  routeEpoch++
  item.value = null
  pages.value = []
  selectedChapter.value = null
  limit.value = coverLimit.value = 120
  choosingCover.value = busy.value = false
  tagText.value = error.value = ''
  void load(route.query.read === '1')
}, { immediate: true, flush: 'sync' })
onUnmounted(() => { disposed = true; requestEpoch++; routeEpoch++ })
</script>
<template><main class="im-page image-detail"><header class="detail-toolbar"><button class="im-button" @click="router.push('/image')"><ArrowLeft :size="17"/>{{item?.type==='photo'?'返回相册':'返回书架'}}</button><span/><button class="im-button" :disabled="!canRecover" @click="rescan()"><RefreshCw :size="16"/>重新扫描</button><button class="im-button" :disabled="!canRecover" @click="rescan(true)"><FolderOpen :size="17"/>重新定位</button><button class="im-icon" aria-label="移除图片资源" :disabled="busy || !currentReady" @click="remove()"><Trash2 :size="18"/></button></header><p v-if="error" role="alert" class="im-error">{{error}}</p>
  <div v-if="status==='loading'" class="im-empty" role="status"><Images :size="40"/><h2>正在读取资源…</h2></div><div v-else-if="status==='error'" class="im-empty"><h2>读取失败</h2><button class="im-button" @click="load()">重试</button></div><div v-else-if="status==='missing'" class="im-empty"><Images :size="40"/><h2>资源不可用</h2><p>资源可能已移除，或所属类型已隐藏。</p></div><template v-else-if="item"><section class="detail-info"><button class="detail-cover-button" :class="{photo:item.type==='photo'}" :disabled="busy || !currentReady || !pages.length" aria-label="选择或替换封面" title="选择或替换封面" @click="coverLimit=120;choosingCover=true"><ImageCover :page-id="item.coverPageId" :name="item.name" :photo="item.type==='photo'"/><span>更换封面</span></button><div class="detail-fields"><input class="detail-title" :disabled="busy || !currentReady" :value="item.name" aria-label="图片资源名称" @change="patch({name:($event.target as HTMLInputElement).value})"/><p class="detail-meta">{{item.type==='comic'?'漫画':'相册'}} · {{item.chapterCount?item.chapterCount+' 章 · ':''}}{{item.pageCount}} 页 <span v-if="item.source">· {{item.source==='pica'?'哔咔':item.source}}</span></p><p class="detail-path">{{item.path}}</p><div class="detail-actions"><button class="im-button im-primary" :disabled="busy || !currentReady || !pages.length" @click="read()"><BookOpen :size="18"/>{{item.type==='photo'?'浏览照片':item.progress?'继续阅读':'开始阅读'}}</button><button class="im-button" :disabled="busy || !currentReady" :class="{favorite:item.favorite}" @click="patch({favorite:!item.favorite})"><Heart :size="17"/>{{item.favorite?'已收藏':'收藏'}}</button><span v-if="item.progress && item.type==='comic'">读到第 {{item.progress.ordinal+1}} 页</span></div></div></section>
  <DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="image" label="图片详情"/>
  <div id="image-panel-files" v-show="activeTab==='files'" role="tabpanel" aria-labelledby="image-tab-files"><div class="detail-utilities" aria-label="作品工具">
    <button class="im-button" :disabled="busy || !currentReady" @click="reveal"><FolderOpen :size="16"/>打开所在文件夹</button><button class="im-button" :disabled="busy || !currentReady" @click="move"><FolderOpen :size="16"/>整理和移动</button><button class="im-button" :disabled="busy || !currentReady" @click="remove(true)"><Trash2 :size="16"/>删除原文件夹</button><label class="detail-read-state"><input type="checkbox" :checked="item.read" @change="patch({read:($event.target as HTMLInputElement).checked})"/>已读</label>
    <ImageIntegrityPanel :key="item.id" :resource-id="item.id" compact @repaired="load"/>
    <ImageUpdatePanel v-if="item.type==='comic' && item.source==='pica'" :key="'updates:'+item.id" :resource-id="item.id" compact @updated="load"/>
  </div>
  </div><div id="image-panel-pages" v-show="activeTab==='pages'" role="tabpanel" aria-labelledby="image-tab-pages"><section v-if="item.type==='comic'" class="detail-chapters"><header><h2>章节 <small>选择章节查看预览</small></h2><button class="im-button chapter-all" :aria-pressed="selectedChapter===''" @click="selectChapter('')">全部页面</button></header><div><button v-for="c in item.chapters" :key="c.id" :class="{current:c.id===selectedChapter}" :aria-pressed="c.id===selectedChapter" @click="selectChapter(c.id)"><BookOpen :size="18"/><strong>{{c.title}}<small v-if="c.id===item.progress?.chapterId">上次阅读</small></strong><span>{{c.pageCount?c.pageCount+' 页':'页面缺失'}}</span></button></div></section>
  <section class="detail-pages"><header><h2>{{item.type==='photo'?'相册照片':previewChapter?previewChapter.title+' · 预览':'全部页面'}}<small>{{previewPages.length}} 页 · {{item.type==='photo'?'点击浏览':'点击阅读'}}，右键设为封面</small></h2><button v-if="previewChapter" class="im-button" :disabled="!previewPages.length" @click="read(previewPages[0]?.id)"><BookOpen :size="16"/>阅读本章</button></header><p v-if="!previewPages.length" class="preview-empty">本章暂无本地页面，可通过文件检查查看缺失情况。</p><div><button v-for="p in shown" :key="p.id" :aria-label="`打开第 ${p.ordinal+1} 页`" @click="read(p.id)" @contextmenu.prevent="patch({coverPageId:p.id})"><ImageCover :page-id="p.id" :name="`第 ${p.ordinal+1} 页`" :photo="item.type==='photo'"/><span>{{p.ordinal+1}}</span></button></div><button v-if="limit<previewPages.length" class="im-button detail-more" @click="limit+=120">显示更多（{{limit}} / {{previewPages.length}}）</button></section>
  </div><section id="image-panel-info" v-show="activeTab==='info'" role="tabpanel" aria-labelledby="image-tab-info"><label class="im-field">简介<textarea :value="item.description" placeholder="添加说明…" @change="patch({description:($event.target as HTMLTextAreaElement).value})"/></label><div class="detail-options"><label v-if="item.type==='comic'" class="im-field">分类<select :value="item.groupId||''" @change="patch({groupId:($event.target as HTMLSelectElement).value||null})"><option value="">未分类</option><option v-for="group in store.groups.filter(g=>!g.hidden)" :key="group.id" :value="group.id">{{group.name}}</option></select></label><label class="im-field detail-tags">标签<input v-model="tagText" placeholder="用逗号分隔" @change="patch({tags:tagText.split(/[，,]/).map(t=>t.trim()).filter(Boolean)})"/></label></div><ImagePhotoInfo v-if="item.type==='photo'" :pages="pages" :cover="item.coverPageId"/><p v-else class="detail-path">{{item.chapterCount}} 章 · {{item.pageCount}} 页 · {{item.source==='pica'?'哔咔来源':'本地导入'}}</p><p class="detail-path">{{item.path}}</p></section>
  <ProjectDialog v-if="choosingCover" title="选择封面" wide @close="choosingCover=false"><p class="detail-path">点击一张图片作为封面。关闭窗口不会更改当前封面。</p><p v-if="error" class="im-error" role="alert">{{error}}</p><div class="cover-picker"><button v-for="p in pages.slice(0,coverLimit)" :key="p.id" :aria-label="`设第 ${p.ordinal+1} 页为封面`" :aria-pressed="item.coverPageId===p.id" @click="choosePage(p.id)"><ImageCover :page-id="p.id" :name="`第 ${p.ordinal+1} 页`" :photo="item.type==='photo'"/><span>{{p.ordinal+1}}</span></button></div><button v-if="coverLimit<pages.length" class="im-button" @click="coverLimit+=120">显示更多</button></ProjectDialog>
  </template>
</main></template>
<style scoped>
.detail-cover-button{width:210px;flex:none;position:relative;overflow:hidden;border-radius:8px}.detail-cover-button.photo{width:260px}.detail-cover-button>span{position:absolute;bottom:0;left:0;right:0;padding:10px;background:#0009;color:white;opacity:0}.detail-cover-button:hover>span,.detail-cover-button:focus-visible>span{opacity:1}.cover-picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px}.cover-picker button[aria-pressed=true]{outline:2px solid var(--accent)}.detail-info{margin-bottom:24px}.detail-actions{flex-wrap:wrap}.cover-instruction{padding:14px;background:var(--active-surface);color:var(--accent);border-radius:8px}
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
