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


test('show with explicit resource ids opens a clean session instead of mixing into an unrelated idle session',async()=>{
  const {a}=fixture({
    source:async(id:string)=>({id,kind:'document',name:'当前文档',path:'',summary:'',tags:[],updatedAt:1}),
    session:async(id:string)=>({session:{id,title:'旧对话',started_at:1,last_active:1,message_count:2},messages:[{id:1,role:'user',content:'旧内容',timestamp:1}],lastRun:null})
  })
  await a.load('old-session')
  assert.equal(a.selected.value,'old-session')
  await a.show('整理这份文档',['doc-1'])
  assert.equal(a.selected.value,'')
  assert.equal(a.messages.value.length,0)
  assert.equal(a.context.value.length,1)
  assert.equal(a.context.value[0].id,'doc-1')
})

test('undoAll reverses only current-turn actions of the selected session and ignores empty sessions',async()=>{
  const undone:string[]=[],queries:Array<string|undefined>=[]
  const list=[
    {id:'new-2',sessionId:'s1',targetId:'d1',kind:'document',name:'文档1',reason:'本轮改标签',before:{},after:{},state:'applied',createdAt:120},
    {id:'new-1',sessionId:'s1',targetId:'d1',kind:'document',name:'文档1',reason:'本轮改备注',before:{},after:{},state:'applied',createdAt:110},
    {id:'old-1',sessionId:'s1',targetId:'d2',kind:'document',name:'文档2',reason:'旧轮修改',before:{},after:{},state:'applied',createdAt:10},
    {id:'other-1',sessionId:'s2',targetId:'d3',kind:'document',name:'文档3',reason:'其他对话',before:{},after:{},state:'applied',createdAt:130}
  ]
  const {a}=fixture({
    actions:async(sid?:string)=>{
      queries.push(sid)
      return list.filter(x=>!sid||x.sessionId===sid).map(x=>({...x,state:undone.includes(x.id)?'undone':'applied'}))
    },
    undo:async(id:string)=>{undone.push(id);return {undone:true,reason:'已恢复修改前内容'}}
  })
  // Empty session must never query undefined or undo across conversations.
  await a.undoAll()
  assert.deepEqual(queries,[])
  assert.deepEqual(undone,[])

  a.selected.value='s1'
  a.lastRun.value={sessionId:'s1',status:'completed',text:'本轮',error:'',startedAt:100,updatedAt:130}
  a.actions.value=list.filter(x=>x.sessionId==='s1')
  assert.deepEqual(a.turnActions.value.map((x:any)=>x.id),['new-2','new-1'])

  await a.undoAll()
  assert.deepEqual(queries,['s1','s1'])
  assert.deepEqual(undone,['new-2','new-1'])
  assert.equal(a.turnActions.value.length,0)
  assert.equal(a.actions.value.find((x:any)=>x.id==='old-1')?.state,'applied')
  assert.equal(a.notice.value,'已撤回本轮 2 项修改')
})

test('undoAll reports honest counts and reasons when backend preserves later manual edits',async()=>{
  const list=[
    {id:'act-2',sessionId:'s1',targetId:'d1',kind:'document',name:'文档1',reason:'改标签',before:{},after:{},state:'applied',createdAt:120},
    {id:'act-1',sessionId:'s1',targetId:'d2',kind:'document',name:'文档2',reason:'改备注',before:{},after:{},state:'applied',createdAt:110}
  ]
  const {a}=fixture({
    actions:async()=>list,
    undo:async()=>({undone:false,reason:'记录已有后续修改，已保留现状'})
  })
  a.selected.value='s1'
  a.lastRun.value={sessionId:'s1',status:'completed',text:'本轮',error:'',startedAt:100,updatedAt:130}
  await a.undoAll()
  assert.match(a.notice.value,/未撤回任何修改/)
  assert.match(a.notice.value,/2 项已保留现状/)
  assert.match(a.notice.value,/后续修改/)
  assert.equal(a.actions.value.filter((x:any)=>x.state==='applied').length,2)
})
