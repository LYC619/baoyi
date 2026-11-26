<script setup lang="ts">
import { errorMessage } from '@/utils'
import {computed,nextTick,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {TextLayer,type PDFDocumentProxy,type RenderTask} from 'pdfjs-dist'
const props=defineProps<{pdf:PDFDocumentProxy;page:number;width:number;zoom:number}>()
const emit=defineEmits<{rendered:[];error:[message:string]}>()
const paper=ref<HTMLElement>(),canvas=ref<HTMLCanvasElement>(),layer=ref<HTMLElement>(),aspect=ref(842/595),rendered=ref(false)
const displayWidth=computed(()=>Math.max(100,props.width-56)*props.zoom)
const displayHeight=computed(()=>displayWidth.value*aspect.value)
let observer:IntersectionObserver|undefined,task:RenderTask|undefined,text:TextLayer|undefined,disposed=false,revision=0,key='',pending:Promise<void>|undefined,wanted=false
async function ensure(){
  wanted=true
  const requested=props.width+':'+props.zoom
  if(key===requested&&(rendered.value||pending))return pending
  key=requested;rendered.value=false;const run=++revision;task?.cancel();text?.cancel()
  const work=async()=>{try{
    const page=await props.pdf.getPage(props.page);if(disposed||run!==revision)return
    const base=page.getViewport({scale:1}),scale=displayWidth.value/base.width,view=page.getViewport({scale}),ratio=Math.min(window.devicePixelRatio||1,2)
    aspect.value=base.height/base.width;await nextTick();if(disposed||run!==revision||!canvas.value||!layer.value||!paper.value)return
    canvas.value.width=Math.floor(view.width*ratio);canvas.value.height=Math.floor(view.height*ratio);canvas.value.style.width=view.width+'px';canvas.value.style.height=view.height+'px'
    paper.value.style.setProperty('--total-scale-factor',String(scale*page.userUnit));layer.value.replaceChildren()
    task=page.render({canvas:canvas.value,viewport:view,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});await task.promise
    const content=await page.getTextContent();if(disposed||run!==revision)return
    text=new TextLayer({textContentSource:content,container:layer.value,viewport:view});await text.render()
    if(!disposed&&run===revision){rendered.value=true;emit('rendered')}
  }catch(error){if(!disposed&&run===revision&&(error as Error).name!=='RenderingCancelledException'){key='';emit('error',errorMessage(error))}}finally{if(run===revision)pending=undefined}}
  pending=work();return pending
}
defineExpose({ensure})
watch(()=>[props.width,props.zoom],()=>{if(wanted)void ensure()})
onMounted(()=>{observer=new IntersectionObserver(entries=>{
  if(entries.some(e=>e.isIntersecting))void ensure()
  else if(rendered.value&&!pending&&canvas.value){canvas.value.width=1;canvas.value.height=1;key='';wanted=false}
},{root:paper.value?.closest('.reader-viewport'),rootMargin:'1200px'});if(paper.value)observer.observe(paper.value)})
onBeforeUnmount(()=>{disposed=true;revision++;observer?.disconnect();task?.cancel();text?.cancel()})
</script>
<template>
  <div ref="paper" class="pdf-page" :data-pdf-page="page" :data-rendered="rendered" :style="{width:displayWidth+'px',height:displayHeight+'px'}">
    <canvas ref="canvas"/><div ref="layer" class="textLayer"/>
  </div>
</template>
<style scoped>
.pdf-page{position:relative;margin:0 auto 24px;background:#fff;box-shadow:0 2px 8px #0002;user-select:text}.pdf-page canvas{display:block}
/* PDF.js text layer geometry (Apache-2.0); follows its per-span scale variables. */
.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;letter-spacing:normal;word-spacing:normal;text-size-adjust:none;transform-origin:0 0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}.textLayer :deep(span),.textLayer :deep(br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;user-select:text}.textLayer :deep(> :not(.markedContent)),.textLayer :deep(.markedContent span:not(.markedContent)){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}.textLayer :deep(.markedContent){display:contents}.textLayer :deep(::selection){background:#397d9b66;color:transparent}

</style>
