import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'
const tick=async()=>{await new Promise(setImmediate);await Vue.nextTick()}
test('comic refresh coalesces in-flight requests, keeps row references, and discards hidden responses',async()=>{
  const settings=Vue.reactive({loaded:true,settings:{hide_hentai:false}}),scope=Vue.effectScope()
  let calls=0,resolve!:(value:any)=>void
  const load=createRendererLoader({vue:Vue,'@/stores/settings':{useSettingsStore:()=>settings}}, {window:{baoyi:{comic:{jobs:()=>{calls++;return new Promise(r=>resolve=r)}},image:{onJobsChanged:()=>{},onChanged:()=>{}}}},setTimeout,clearTimeout})
  const ingest=scope.run(()=>load('src/composables/useComicIngest.ts').useComicIngest())
  const job={id:'a',status:'running',createdAt:1,updatedAt:1,processed:1,authors:['a'],selectedChapters:['c']}
  try{
    assert.equal(calls,1);resolve([job]);await tick()
    const rows=ingest.jobs.value,row=rows[0],chapters=row.selectedChapters
    const pending=ingest.refresh();for(let i=0;i<30;i++)void ingest.refresh();assert.equal(calls,2)
    resolve([{...job,processed:2,updatedAt:2}]);await tick();assert.equal(calls,3)
    resolve([{...job,processed:3,updatedAt:3}]);await pending
    assert.equal(ingest.jobs.value,rows);assert.equal(ingest.jobs.value[0],row);assert.equal(row.selectedChapters,chapters);assert.equal(row.processed,3)
    const hidden=ingest.refresh();settings.settings.hide_hentai=true;await tick();resolve([{...job,processed:4}]);await hidden;assert.equal(ingest.jobs.value.length,0)
  }finally{scope.stop()}
})
test('method loading preserves an unsent question, attaches documents and never sends automatically',async()=>{
  let sends=0
  const load=createRendererLoader({vue:Vue},{window:{baoyi:{archive:{onEvent:()=>{},status:async()=>({configured:true,model:'fixture',profiles:[],active:null}),sessions:async()=>[],source:async(id:string)=>({id,name:'合成资料',kind:'document'}),send:async()=>{sends++}}}}})
  const assistant=load('src/composables/useArchiveAssistant.ts').useArchiveAssistant()
  assistant.draft.value='重点分析结论依据'
  await assistant.loadMethod('document-deep-reader',['doc'])
  assert.match(assistant.draft.value,/document-deep-reader/);assert.match(assistant.draft.value,/重点分析/)
  assert.equal(assistant.context.value[0].id,'doc');assert.equal(sends,0)
  await assistant.loadMethod('document-deep-reader',['doc']);assert.equal(assistant.draft.value.match(/document-deep-reader/g).length,1)
})

test('privacy watchers survive unmount of their first component and stay single on remount', async () => {
  const settings = Vue.reactive({loaded:true,settings:{hide_hentai:false}})
  let cancels=0, comicEvents=0, videoEvents=0
  const api={comic:{jobs:async()=>[{id:'comic'}]},image:{onJobsChanged:()=>{comicEvents++},onChanged:()=>{}},video:{
    onUpdateCheck:()=>{videoEvents++}, cancelUpdateCheck:async()=>{cancels++},
    updateCheckStatus:async()=>({rows:settings.settings.hide_hentai?[]:[{id:'video'}]})}}
  const load=createRendererLoader({vue:Vue,'@/stores/settings':{useSettingsStore:()=>settings}},{window:{baoyi:api},localStorage:{getItem:()=>null},setTimeout,clearTimeout})
  const comic=load('src/composables/useComicIngest.ts'), video=load('src/composables/useVideoUpdates.ts')
  const renderer=Vue.createRenderer<any,any>({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),insert(){},remove(){},patchProp(){},setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null})
  let c:any,v:any
  function mount(){const app=renderer.createApp({setup(){c=comic.useComicIngest();v=video.useVideoUpdates();return ()=>Vue.h('span')}});app.mount({});return app}
  const first=mount();await tick();assert.equal(c.jobs.value.length,1);assert.equal(v.state.value.rows.length,1);first.unmount()
  settings.settings.hide_hentai=true;await tick();assert.equal(c.jobs.value.length,0);assert.equal(v.state.value.rows.length,0);assert.equal(cancels,1)
  const second=mount();settings.settings.hide_hentai=false;await tick();assert.equal(c.jobs.value.length,1);assert.equal(v.state.value.rows.length,1)
  assert.equal(comicEvents,1);assert.equal(videoEvents,1);second.unmount()
})
