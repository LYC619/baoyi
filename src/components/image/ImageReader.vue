<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, X, Maximize, RotateCw } from 'lucide-vue-next'
import type { ImageItem, ImagePage, ImagePreferences } from '@/types/image'
const props=defineProps<{item:ImageItem;pages:ImagePage[];startId?:string}>(), emit=defineEmits<{close:[]}>()
const root=ref<HTMLElement>(), viewport=ref<HTMLElement>(), index=ref(Math.max(0,props.pages.findIndex(p=>p.id===(props.startId||props.item.progress?.pageId))))
const prefs=ref<ImagePreferences>({mode:'single',direction:'ltr',fit:'screen'}), rotation=ref(0), error=ref(''), idle=ref(false), width=ref(800)
const ratios=ref<Record<string,number>>({}), failed=ref(new Set<string>())
let resize:ResizeObserver|undefined, hideTimer:ReturnType<typeof setTimeout>|undefined, saveTimer:ReturnType<typeof setTimeout>|undefined, frame=0, restoring=true
let neighbors:HTMLImageElement[]=[]
const page=computed(()=>props.pages[index.value]), chapter=computed(()=>page.value?.chapterId || '')
const sizes=computed(()=>props.pages.map(p=>Math.max(100,width.value*(ratios.value[p.id]||1.45))))
const starts=computed(()=>{const a=[0];for(const height of sizes.value)a.push(a.at(-1)!+height+12);return a})
const first=computed(()=>Math.max(0,index.value-2)), last=computed(()=>Math.min(props.pages.length,index.value+5))
const strip=computed(()=>props.pages.slice(first.value,last.value))
const spread=computed(()=>{
  const current=props.pages[index.value]
  if(!current)return []
  const next=props.pages[index.value+1]
  return prefs.value.mode==='double'&&props.item.type==='comic'&&next?.chapterId===current.chapterId?[current,next]:[current]
})
watch([index,()=>prefs.value.mode],()=>{
  neighbors=[]
  if(prefs.value.mode==='scroll')return
  for(const at of [index.value-1,index.value+spread.value.length]){
    const adjacent=props.pages[at]
    if(adjacent){const image=new Image();image.src=`baoyi://image/${adjacent.id}`;neighbors.push(image)}
  }
},{immediate:true})
function wake(){idle.value=false;clearTimeout(hideTimer);hideTimer=setTimeout(()=>{idle.value=true},2500)}
function offset(){return prefs.value.mode==='scroll'&&viewport.value ? Math.max(0,Math.min(1,(viewport.value.scrollTop-starts.value[index.value])/sizes.value[index.value])):0}
async function persist(){if(props.item.type!=='comic'||!page.value||restoring)return;try{await window.baoyi.image.saveProgress(props.item.id,page.value.id,offset())}catch(cause){error.value=(cause as Error).message}}
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{void persist()},350)}
async function go(value:number,relativeOffset=0){index.value=Math.max(0,Math.min(props.pages.length-1,value));rotation.value=0;await nextTick();if(viewport.value){viewport.value.scrollTop=prefs.value.mode==='scroll'?starts.value[index.value]+sizes.value[index.value]*relativeOffset:0}scheduleSave();wake()}
function step(delta:number){
  if(prefs.value.mode!=='double'||props.item.type!=='comic'){void go(index.value+delta);return}
  if(delta>0){void go(index.value+spread.value.length);return}
  const current=props.pages[index.value],previous=props.pages[index.value-1]
  const distance=previous?.chapterId===current?.chapterId&&props.pages[index.value-2]?.chapterId===current?.chapterId?2:1
  void go(index.value-distance)
}
function keys(event:KeyboardEvent){if((event.target as HTMLElement)?.matches('input,select,textarea'))return;if(event.key==='Escape'){event.preventDefault();void close()}else if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();step((event.key==='ArrowRight'?1:-1)*(prefs.value.direction==='rtl'?-1:1))}else if(event.key==='PageDown'||event.key===' '){event.preventDefault();step(1)}else if(event.key==='PageUp'){event.preventDefault();step(-1)}else if(event.key==='Home'){event.preventDefault();void go(0)}else if(event.key==='End'){event.preventDefault();void go(props.pages.length-1)}}
async function changePrefs(){await window.baoyi.image.preferences({...prefs.value});await go(index.value);wake()}
function changeChapter(event:Event){const id=(event.target as HTMLSelectElement).value;const at=props.pages.findIndex(p=>p.chapterId===id);if(at>=0)void go(at)}
function scroll(){if(prefs.value.mode!=='scroll'||restoring||frame)return;frame=requestAnimationFrame(()=>{frame=0;const top=viewport.value?.scrollTop||0;let low=0,high=props.pages.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(starts.value[mid]<=top+20)low=mid;else high=mid-1}index.value=low;scheduleSave()})}
async function loaded(event:Event,id:string){const img=event.target as HTMLImageElement;if(!img.naturalWidth)return;const previousOffset=offset(),at=index.value;ratios.value={...ratios.value,[id]:img.naturalHeight/img.naturalWidth};if(prefs.value.mode==='scroll'){await nextTick();if(viewport.value)viewport.value.scrollTop=starts.value[at]+sizes.value[at]*previousOffset}}
function imageFailed(id:string){failed.value=new Set([...failed.value,id])}
async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await root.value?.requestFullscreen()}catch{error.value='当前窗口无法进入全屏'}}
async function close(){clearTimeout(saveTimer);await persist();if(document.fullscreenElement)await document.exitFullscreen();emit('close')}
onMounted(async()=>{window.addEventListener('keydown',keys);try{prefs.value=await window.baoyi.image.preferences()}catch{error.value='无法读取阅读设置，已使用默认设置'}if(props.item.type==='photo')prefs.value.mode='single';resize=new ResizeObserver(()=>{width.value=Math.max(200,Math.min(1100,(viewport.value?.clientWidth||850)-80))});if(viewport.value)resize.observe(viewport.value);await nextTick();await go(index.value,props.startId?0:props.item.progress?.offset||0);restoring=false;wake();root.value?.focus()})
onBeforeUnmount(()=>{window.removeEventListener('keydown',keys);resize?.disconnect();clearTimeout(hideTimer);clearTimeout(saveTimer);cancelAnimationFrame(frame);neighbors=[];void persist()})
</script>
<template><Teleport to="body"><section ref="root" class="image-reader" :class="{idle}" tabindex="-1" role="dialog" aria-modal="true" :aria-label="`阅读 ${item.name}`" @pointermove="wake" @focusin="wake"><header class="reader-tools"><button aria-label="关闭阅读器" @click="close"><X :size="20"/></button><strong>{{item.name}}</strong><select v-if="item.type==='comic'" :value="chapter" aria-label="阅读章节" @change="changeChapter"><option v-for="c in item.chapters.filter(c=>c.pageCount)" :key="c.id" :value="c.id">{{c.title}}</option></select><select v-if="item.type==='comic'" v-model="prefs.mode" aria-label="阅读模式" @change="changePrefs"><option value="single">单页</option><option value="double">双页</option><option value="scroll">纵向连续</option></select><select v-if="item.type==='comic'" v-model="prefs.direction" aria-label="阅读方向" @change="changePrefs"><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select><select v-model="prefs.fit" aria-label="图片缩放" @change="changePrefs"><option value="screen">适屏</option><option value="width">适宽</option><option value="original">原始尺寸</option></select><button v-if="prefs.mode!=='scroll'" aria-label="旋转图片" @click="rotation=(rotation+90)%360"><RotateCw :size="18"/></button><button aria-label="全屏阅读" @click="fullscreen"><Maximize :size="19"/></button></header>
  <p v-if="error" class="reader-error" role="alert">{{error}}</p><div ref="viewport" class="reader-viewport" :class="['reader-'+prefs.mode,'reader-fit-'+prefs.fit]" @scroll.passive="scroll">
    <div v-if="prefs.mode==='scroll'" class="reader-strip" :style="{width:width+'px'}"><div :style="{height:starts[first]+'px'}"/><div v-for="(p,i) in strip" :key="p.id" class="reader-strip-page" :style="{height:sizes[first+i]+'px'}"><img v-if="!failed.has(p.id)" :src="`baoyi://image/${p.id}`" :alt="`第 ${p.ordinal+1} 页`" @load="loaded($event,p.id)" @error="imageFailed(p.id)"/><div v-else class="reader-missing">第 {{p.ordinal+1}} 页无法读取。请退出后重新扫描或重新定位。</div></div><div :style="{height:(starts[pages.length]-starts[last])+'px'}"/></div>
    <div v-else class="reader-spread" :class="{rtl:prefs.direction==='rtl'}"><div v-for="p in spread" :key="p.id" class="reader-sheet"><img v-if="!failed.has(p.id)" :src="`baoyi://image/${p.id}`" :alt="`第 ${p.ordinal+1} 页`" :style="{transform:`rotate(${rotation}deg)`}" @error="imageFailed(p.id)"/><div v-else class="reader-missing">这一页无法读取。<br/>请退出后重新扫描或重新定位。</div></div></div>
  </div><button v-if="prefs.mode!=='scroll'" class="reader-edge reader-left" :aria-label="prefs.direction==='rtl'?'下一页':'上一页'" @click="step(prefs.direction==='rtl'?1:-1)"><ArrowLeft :size="25"/></button><button v-if="prefs.mode!=='scroll'" class="reader-edge reader-right" :aria-label="prefs.direction==='rtl'?'上一页':'下一页'" @click="step(prefs.direction==='rtl'?-1:1)"><ArrowRight :size="25"/></button>
  <footer class="reader-bottom"><button aria-label="前一页" :disabled="index===0" @click="step(-1)"><ArrowLeft :size="17"/></button><span>{{index+1}} / {{pages.length}} 页</span><input type="range" aria-label="阅读进度" :min="0" :max="Math.max(0,pages.length-1)" :value="index" @input="go(Number(($event.target as HTMLInputElement).value))"/><button aria-label="后一页" :disabled="index>=pages.length-1" @click="step(1)"><ArrowRight :size="17"/></button></footer>
</section></Teleport></template>
<style scoped>
.image-reader{position:fixed;inset:var(--titlebar-h) 0 0;z-index:200;background:#111118;color:#e0e0ee;display:flex;flex-direction:column;font-size:12px;outline:none}.image-reader:fullscreen{inset:0}.reader-tools{position:absolute;left:0;right:0;top:0;z-index:3;height:55px;background:rgba(23,23,34,.97);display:flex;align-items:center;gap:10px;padding:8px 18px;transition:opacity .2s}.reader-tools strong{margin-right:auto;max-width:25%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500}.reader-tools select{color:#ddd;background:#282835;border:1px solid #40404f;border-radius:5px;padding:6px;max-width:170px;font-size:12px}.image-reader button{display:flex;align-items:center;justify-content:center;color:#ddd;padding:7px;border-radius:6px;cursor:pointer}.image-reader button:hover{background:#343446}.image-reader :focus-visible{outline:2px solid var(--accent)}.image-reader button:disabled{opacity:.3;cursor:default}.reader-viewport{flex:1;overflow:auto;padding:60px 0 55px;overscroll-behavior:contain}.reader-spread{display:flex;align-items:flex-start;justify-content:center;min-height:100%;gap:4px;padding:0 35px}.reader-spread.rtl{flex-direction:row-reverse}.reader-sheet{display:flex;align-items:center;justify-content:center;min-width:0}.reader-single .reader-sheet{min-height:100%}.reader-fit-screen .reader-spread{height:100%;align-items:center}.reader-fit-screen .reader-sheet{height:100%;max-width:100%}.reader-fit-screen .reader-sheet img{max-width:100%;max-height:100%;object-fit:contain;display:block}.reader-double .reader-sheet{max-width:50%}.reader-fit-width .reader-sheet{width:100%;display:block}.reader-fit-width .reader-sheet img{width:100%;display:block}.reader-fit-original .reader-sheet img{max-width:none}.reader-strip{margin:0 auto}.reader-strip-page{margin-bottom:12px;position:relative}.reader-strip-page img{width:100%;height:100%;object-fit:contain;display:block}.reader-missing{display:flex;align-items:center;justify-content:center;text-align:center;color:#aaa;min-height:250px;height:100%;padding:30px;line-height:1.8}.reader-edge{position:absolute;top:45%;z-index:2;width:40px;height:90px;background:#2226}.reader-left{left:8px}.reader-right{right:8px}.reader-bottom{position:absolute;bottom:0;left:0;right:0;background:rgba(23,23,34,.97);height:45px;display:flex;align-items:center;justify-content:center;gap:15px;transition:opacity .2s}.reader-bottom input{width:40%;max-width:650px;accent-color:var(--accent)}.reader-bottom span{min-width:80px;text-align:center;font-variant-numeric:tabular-nums}.idle .reader-tools:not(:focus-within),.idle .reader-bottom:not(:focus-within),.idle .reader-edge{opacity:0;pointer-events:none}.reader-error{position:absolute;top:56px;left:20%;right:20%;z-index:4;background:#542832;padding:10px}.reader-viewport.reader-scroll{padding-top:60px;padding-bottom:50px}
</style>
