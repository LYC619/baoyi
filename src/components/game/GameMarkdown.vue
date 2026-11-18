<script setup lang="ts">
import {computed,ref} from 'vue'
import {marked,Renderer} from 'marked'
import DOMPurify from 'dompurify'
const props=defineProps<{text:string;editableTasks?:boolean}>(),emit=defineEmits<{toggle:[index:number]}>()
const root=ref<HTMLElement>()
const renderer=new Renderer();renderer.html=()=>''
const html=computed(()=>{const clean=DOMPurify.sanitize(marked.parse(props.text,{async:false,gfm:true,renderer}) as string,{FORBID_TAGS:['img','video','audio','iframe','object','embed','form','style','svg','math'],FORBID_ATTR:['href','src','style','id','name']});const parsed=new DOMParser().parseFromString(clean,'text/html');parsed.querySelectorAll('h2,h3').forEach((el,i)=>el.setAttribute('data-heading',String(i)));parsed.querySelectorAll('input').forEach((el,i)=>{if(el.type!=='checkbox'){el.remove();return}el.disabled=!props.editableTasks;el.setAttribute('data-task',String(i));el.setAttribute('aria-label',`切换待办 ${i+1}`)});return parsed.body.innerHTML})
const headings=computed(()=>{const doc=new DOMParser().parseFromString(html.value,'text/html');return [...doc.querySelectorAll('h2,h3')].map((el,index)=>({index,text:el.textContent||'',level:el.tagName==='H3'?3:2}))})
function jump(index:number){const el=root.value?.querySelector<HTMLElement>(`[data-heading="${index}"]`);el?.scrollIntoView({block:'nearest',behavior:'smooth'});el?.animate([{background:'var(--active-surface)'},{background:'transparent'}],{duration:1300})}
function change(e:Event){const input=e.target as HTMLInputElement;if(props.editableTasks&&input.matches('input[data-task]'))emit('toggle',Number(input.dataset.task))}
defineExpose({headings,jump})
</script>
<template><div ref="root" class="game-markdown" @change="change" v-html="html"/></template>
<style scoped>
.game-markdown{font-size:13px;line-height:1.85;overflow-wrap:anywhere;user-select:text}.game-markdown :deep(h1){font-size:23px;margin:0 0 18px}.game-markdown :deep(h2){font-size:18px;margin:24px 0 12px;scroll-margin-top:12px}.game-markdown :deep(h3){font-size:15px;margin:18px 0 9px}.game-markdown :deep(p){margin:10px 0}.game-markdown :deep(ul),.game-markdown :deep(ol){padding-left:24px}.game-markdown :deep(input[type=checkbox]){accent-color:var(--accent);margin-right:6px}.game-markdown :deep(table){border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}.game-markdown :deep(td),.game-markdown :deep(th){border:1px solid var(--divider-strong);padding:7px 12px;text-align:left}.game-markdown :deep(pre){background:var(--bg-main);padding:14px;overflow:auto;border-radius:6px}.game-markdown :deep(code){font-family:var(--font-mono);font-size:12px}.game-markdown :deep(blockquote){border-left:2px solid var(--accent);padding:4px 14px;margin:15px 0;color:var(--text-sub)}
</style>
