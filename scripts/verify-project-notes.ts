import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectNotesSession } from '../src/utils/project-notes.ts'
import { emptyProjectContext,type ProjectContext } from '../src/types/workspace.ts'

const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}}
test('500ms 去抖及 IME 期间不保存，结束组合后才提交',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const writes:ProjectContext[]=[]
  const session=new ProjectNotesSession('a',{context:async()=>emptyProjectContext(),updateContext:async(_id,v)=>{writes.push(v);return {...v,revision:v.revision+1}}},()=>{})
  await session.load();session.edit({current:'进展'})
  t.mock.timers.tick(499);assert.equal(writes.length,0)
  session.composition(true);t.mock.timers.tick(1000);assert.equal(writes.length,0)
  session.edit({current:'正在输入'});assert.equal(await session.flush(),false)
  session.composition(false);t.mock.timers.tick(499);assert.equal(writes.length,0)
  t.mock.timers.tick(1);await session.flush();assert.equal(writes.length,1);assert.equal(writes[0].current,'正在输入')
  session.dispose()
})
test('保存期间新输入不被旧响应覆盖，flush 等待后续保存且项目身份固定',async()=>{
  const first=deferred<ProjectContext>(),writes:Array<{id:string;v:ProjectContext}>=[]
  const session=new ProjectNotesSession('original',{context:async()=>emptyProjectContext(),updateContext:async(id,v)=>{writes.push({id,v});return writes.length===1?first.promise:{...v,revision:v.revision+1}}},()=>{})
  await session.load();session.edit({current:'第一段'});const saving=session.flush()
  session.edit({current:'第一段加第二段'});await session.load()
  assert.equal(session.value.current,'第一段加第二段')
  first.resolve({...writes[0].v,revision:1});assert.equal(await saving,true)
  assert.deepEqual(writes.map(w=>[w.id,w.v.current,w.v.revision]),[['original','第一段',0],['original','第一段加第二段',1]])
  assert.equal(session.dirty,false);session.dispose()
})
test('保存失败保留输入并阻止切换，显式比较后可选保留我的版本',async()=>{
  let stored={...emptyProjectContext(),current:'其他页面',revision:2},fail=true
  const session=new ProjectNotesSession('a',{context:async()=>stored,updateContext:async(_id,v)=>{if(fail)throw new Error('版本已变化');stored={...v,revision:v.revision+1};return stored}},()=>{})
  await session.load();session.edit({current:'我的未存内容'})
  assert.equal(await session.flush(),false);assert.equal(session.value.current,'我的未存内容')
  stored={...stored,current:'更新的内容',revision:3};await session.compare()
  assert.equal(session.latest?.current,'更新的内容');assert.equal(session.value.current,'我的未存内容')
  fail=false;assert.equal(await session.keepMine(),true);assert.equal(stored.revision,4);assert.equal(stored.current,'我的未存内容')
  session.dispose()
})
test('旧刷新在保存完成后才返回，不得把成功保存的内容改回旧版本',async()=>{
  const stale=deferred<ProjectContext>();let reads=0
  const session=new ProjectNotesSession('a',{context:()=>++reads===1?Promise.resolve(emptyProjectContext()):stale.promise,updateContext:async(_id,v)=>({...v,revision:v.revision+1})},()=>{})
  await session.load();const refresh=session.load();session.edit({next:'已保存的新计划'});await session.flush()
  stale.resolve(emptyProjectContext());await refresh
  assert.equal(session.value.next,'已保存的新计划');assert.equal(session.value.revision,1);session.dispose()
})
