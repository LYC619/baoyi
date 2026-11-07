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
