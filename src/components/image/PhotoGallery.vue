<script setup lang="ts">
import { errorMessage } from '@/utils'
import { computed, ref, watch, onUnmounted } from 'vue'
import type { ImageApi,ImageItem,ImageGroup } from '@/types/image'
import type { PhotoView } from '@/composables/usePhotoView'
import { useImageReader } from '@/composables/useImageReader'
import ImageCover from './ImageCover.vue'
import { vMasonry } from '@/composables/masonry'
const props=defineProps<{items:ImageItem[];groups:ImageGroup[];view:PhotoView;queryKey:string}>()
const emit=defineEmits<{manage:[]}>()
type Page=Awaited<ReturnType<ImageApi['gallery']>>['pages'][number]
const pages=ref<Page[]>([]),total=ref(0),page=ref(1),busy=ref(false),error=ref(''),opening=ref(false),root=ref<HTMLElement>()
let revision=0,disposed=false
const reader=useImageReader(), pageSize=120
const items=computed(()=>new Map(props.items.map(item=>[item.id,item])))
const pageCount=computed(()=>Math.max(1,Math.ceil(total.value/pageSize)))
async function load() {
  const token=++revision;busy.value=true;error.value='';pages.value=[]
  try {const result=await window.baoyi.image.gallery(props.items.map(item=>item.id),(page.value-1)*pageSize,pageSize);if(token!==revision||disposed)return;pages.value=result.pages;total.value=result.total}
  catch(cause){if(token===revision&&!disposed)error.value=errorMessage(cause)}
  finally{if(token===revision&&!disposed)busy.value=false}
}
watch(()=>[props.queryKey,props.items.map(i=>i.id+':'+i.updatedAt).join('|')],()=>{page.value=1;void load()},{immediate:true})
onUnmounted(()=>{disposed=true;revision++})
const blocks=computed(()=>{
  const blocks=new Map<string,{key:string;name:string;path:string;pages:Page[]}>()
  for(const p of pages.value){
    const item=items.value.get(p.resourceId);if(!item)continue
    const group=props.groups.find(g=>g.id===item.groupId)
    const folder=p.folder==='.'?'':p.folder
    const key=props.view.grouping==='directory'?item.id+'/'+folder:props.view.grouping==='category'?group?.id||'uncategorized':'all'
    const name=props.view.grouping==='directory'?item.name+(folder?' / '+folder:''):props.view.grouping==='category'?group?.name||'未分类':''
    if(!blocks.has(key))blocks.set(key,{key,name,path:props.view.grouping==='directory'?item.path:'',pages:[]})
    blocks.get(key)!.pages.push(p)
  }
  return [...blocks.values()]
})
async function open(p:Page){
  if(opening.value)return;opening.value=true;error.value=''
  try{const item=items.value.get(p.resourceId);if(!item)return;const all=await window.baoyi.image.pages(item.id);if(!disposed)reader.open(item,all,p.id)}
  catch(cause){if(!disposed)error.value=errorMessage(cause)}finally{opening.value=false}
}
async function turn(value:number){page.value=value;await load();root.value?.scrollIntoView({block:'start'})}
</script>
<template>
  <section ref="root" class="photo-gallery" :aria-busy="busy">
    <header class="gallery-summary"><span>{{total}} 张图片<span v-if="items.size>1"> · {{items.size}} 个文件夹</span></span><button class="im-button" @click="emit('manage')">管理组合</button><nav v-if="pageCount>1" aria-label="图片分页"><button class="im-button" :disabled="busy||page===1" @click="turn(page-1)">上一页</button><span>{{page}} / {{pageCount}}</span><button class="im-button" :disabled="busy||page===pageCount" @click="turn(page+1)">下一页</button></nav></header>
    <p v-if="error" class="im-error" role="alert">{{error}} <button class="im-button" @click="load">重试</button></p><p v-if="busy" role="status">正在载入图片…</p>
    <p v-if="!busy&&!error&&!total" class="im-empty">文件夹中暂无图片，放入新图片后会自动显示。</p>
    <section v-for="block in blocks" :key="block.key" class="photo-folder">
      <header v-if="block.name"><h2>{{block.name}}</h2><small>{{block.pages.length}} 张<span v-if="pageCount>1"> · 本页</span></small><p v-if="block.path" :title="block.path">{{block.path}}</p></header>
      <div class="photo-tiles" :class="'photo-tiles--'+view.layout" :style="{'--photo-size':view.cardSize+'px'}">
        <button v-for="p in block.pages" :key="p.id" v-masonry="view.layout==='adaptive'" class="photo-tile" :disabled="opening" :aria-label="`浏览 ${p.name} · ${items.get(p.resourceId)?.name}`" @click="open(p)">
          <ImageCover :page-id="p.id" :revision="items.get(p.resourceId)?.updatedAt" :name="p.name" photo :shape="view.layout"/><span>{{p.name}}<small>{{items.get(p.resourceId)?.name}}</small></span>
        </button>
      </div>
    </section>
    <nav v-if="pageCount>1" class="gallery-summary gallery-bottom" aria-label="底部图片分页"><button class="im-button" :disabled="busy||page===1" @click="turn(page-1)">上一页</button><span>{{page}} / {{pageCount}}</span><button class="im-button" :disabled="busy||page===pageCount" @click="turn(page+1)">下一页</button></nav>
  </section>
</template>
<style scoped>
.gallery-summary{display:flex;gap:14px;align-items:center;margin:0 0 24px;color:var(--text-sub);font-size:12px;flex-wrap:wrap}.gallery-summary nav{margin-left:auto;display:flex;align-items:center;gap:12px}.photo-folder{margin-bottom:32px}.photo-folder>header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--divider);padding-bottom:12px;margin-bottom:16px}.photo-folder h2{font-size:17px;font-weight:500;margin:0}.photo-folder header small{color:var(--text-sub)}.photo-folder header p{flex-basis:100%;margin:0;color:var(--text-faint);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.photo-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,var(--photo-size)),1fr));gap:14px;align-items:start}.photo-tiles--adaptive{grid-auto-rows:4px;grid-auto-flow:row dense;row-gap:0}.photo-tile{width:100%;min-width:0;display:block;overflow:hidden;border:1px solid var(--divider);border-radius:8px;background:var(--bg-card);text-align:left;color:var(--text-main);break-inside:avoid}.photo-tiles--adaptive .photo-tile{align-self:start}.photo-tile:hover{border-color:var(--accent)}.photo-tile>span{display:block;padding:9px 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.photo-tile small{display:block;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--text-faint);margin-top:4px}.gallery-bottom{justify-content:center}
</style>
