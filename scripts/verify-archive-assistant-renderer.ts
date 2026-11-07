import test from 'node:test'
import assert from 'node:assert/strict'
import {webcrypto} from 'node:crypto'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'

function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes});return {promise,resolve}}
function fixture(overrides:Record<string,unknown>={}){
  let event:(value:any)=>void=()=>{}
  const api={onEvent:(fn:(value:any)=>void)=>{event=fn;return()=>{}},status:async()=>({configured:true,model:'fixture',profiles:[],active:null}),sessions:async()=>[],actions:async()=>[],...overrides}
  const load=createRendererLoader({vue:Vue},{window:{baoyi:{archive:api}},crypto:webcrypto})
  return {a:load('src/composables/useArchiveAssistant.ts').useArchiveAssistant(),event:(e:any)=>event(e)}
}
const run={sessionId:'new',status:'starting',text:'查找资料',error:'',startedAt:1,updatedAt:1}

test('a late send response does not take over a newly opened conversation or erase its draft',async()=>{
  const pending=deferred(),{a}=fixture({send:()=>pending.promise})
  a.draft.value='查找资料';const sent=a.send()
  a.newSession();a.draft.value='下一件事情'
  pending.resolve(run);await sent
  assert.equal(a.selected.value,'');assert.equal(a.draft.value,'下一件事情');assert.equal(a.active.value.sessionId,'new')
})

test('a fast finish before the send reply cannot leave the UI stuck running',async()=>{
  const pending=deferred(),{a,event}=fixture({send:()=>pending.promise})
  a.draft.value='查找资料';const sent=a.send()
  event({event:'run',sessionId:'new',run:{...run,status:'failed'}})
  event({event:'finished',sessionId:'new',previousSessionId:'new',run:{...run,status:'failed'}})
  pending.resolve(run);await sent
  assert.equal(a.active.value,null);assert.equal(a.lastRun.value.status,'failed')
})

test('privacy changes discard late steering acknowledgements and their private text',async()=>{
  const pending=deferred(),{a}=fixture({steer:()=>pending.promise})
  a.active.value=run;a.selected.value=run.sessionId;a.draft.value='完整范围的私人要求'
  const sending=a.send();a.privacyReset();pending.resolve(true);await sending
  assert.equal(a.visibleLive.value.length,0);assert.equal(a.notice.value,'');assert.equal(a.draft.value,'')
})

test('new conversation and privacy reset end a superseded history loading indicator',async()=>{
  for(const reset of ['newSession','privacyReset']){
    const pending=deferred(),{a}=fixture({session:()=>pending.promise})
    const loading=a.load('old');assert.equal(a.loading.value,true)
    a[reset]();assert.equal(a.loading.value,false)
    pending.resolve({session:{id:'old'},messages:[],lastRun:null});await loading
    assert.equal(a.selected.value,'');assert.equal(a.loading.value,false)
  }
})

test('an opening view cannot restore the old privacy scope after delayed sessions arrive',async()=>{
  const pending=deferred(),listed=deferred();let requests=0
  const {a}=fixture({status:async()=>({configured:true,model:'fixture',profiles:[],active:requests++===0?run:null}),sessions:()=>{listed.resolve(true);return pending.promise},session:async()=>null})
  const opening=a.show();await listed.promise;a.open.value=false;a.privacyReset()
  pending.resolve([]);await opening
  assert.equal(a.selected.value,'');assert.equal(a.error.value,'')
})
