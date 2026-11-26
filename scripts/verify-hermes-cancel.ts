import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {HermesRuntime} from '../electron/archive/hermes.ts'
import {archiveRunSlot} from '../electron/archive/run-slot.ts'
test('排队不启动期限，忽略取消的模型进程被限时退出并释放槽，下一次能重启',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-hermes-cancel-')),bridge=path.join(root,'bridge.py')
  await fs.writeFile(bridge,'import sys,json\nprint(json.dumps({"type":"ready"}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n if r.get("method")!="run": print(json.dumps({"type":"response","id":r["id"],"value":True}),flush=True)\n')
  const runtime=new HermesRuntime({runtime:path.resolve('output/hermes-runtime'),bridge,home:path.join(root,'home'),event:()=>{},execute:async()=>''})
  t.after(async()=>{await runtime.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-hermes-cancel-')));await fs.rm(root,{recursive:true,force:true})})
  let release!:()=>void,started=false
  const blocker=archiveRunSlot.run(()=>new Promise<void>(resolve=>release=resolve))
  const controller=new AbortController(),work=runtime.run({},{priority:'background',signal:controller.signal,cancelGraceMs:30,onStart:()=>{started=true;controller.abort(new Error('期限已到'))}})
  const rejected=assert.rejects(work,/期限已到/)
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(started,false);release();await blocker
  await rejected;assert.equal(started,true);assert.equal(await runtime.request('status'),true)
})

test('控制请求超时后仍可用，失败的启动可重试且隔离宿主 Python',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-hermes-control-')), runtime=path.resolve('output/hermes-runtime'), home=path.join(root,'home'), bridge=path.join(root,'bridge.py')
  const client=new HermesRuntime({runtime,home,bridge,event:()=>{},execute:async()=>'',controlTimeoutMs:100})
  t.after(async()=>{await client.close();assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true})})
  await assert.rejects(client.start())
  await fs.writeFile(bridge,'import os,sys,json,time\nprint(json.dumps({"type":"ready"}),flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n if r["method"]=="memory": continue\n if r["method"]=="run": time.sleep(.25)\n print(json.dumps({"type":"response","id":r["id"],"value": [os.getenv(k) for k in ("PYTHONPATH","PYTHONHOME","PYTHONSTARTUP")]}),flush=True)\n')
  const names=['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP'],old=names.map(k=>process.env[k]);names.forEach(k=>{process.env[k]=root})
  try{await client.start()}finally{names.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i]})}
  await assert.rejects(client.request('memory'),/超时/)
  assert.deepEqual(await client.request('status'),[null,null,null]);assert.deepEqual(await client.run({}),[null,null,null])
})
