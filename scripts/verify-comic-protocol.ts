import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {ComicRuntime} from '../electron/kinds/image/comic-runtime.ts'
const python=path.resolve('output/hermes-runtime/python/python.exe'),root=path.resolve('output/p1-p2-comic-2026-11-06/protocol')
await fs.mkdir(root,{recursive:true})
async function runtime(t:test.TestContext,body:string){
  const folder=await fs.mkdtemp(path.join(root,'run-')),bridge=path.join(folder,'fake.py')
  await fs.writeFile(bridge,`import json,sys,os,time\nr=json.loads(sys.stdin.readline())\nassert 'PYTHONPATH' not in os.environ and 'OPENAI_API_KEY' not in os.environ\nseq=0\ndef emit(event,**fields):\n global seq\n seq+=1\n print(json.dumps(dict(protocolVersion=1,jobId=r['jobId'],sequence=seq,event=event,**fields)),flush=True)\n${body}`)
  t.after(()=>fs.rm(folder,{recursive:true,force:true}))
  return new ComicRuntime({python,bridge,runtime:folder,proxies:async()=>({})})
}
test('分片 JSONL 组装来源清单，进程环境不继承模型凭据',async t=>{
  const source=await runtime(t,`emit('work',value=dict(provider='jm',workId='123',name='fixture',authors=[],description='',tags=[],publication='ongoing',adapterVersion='jmcomic-2.7.11/baoyi-1',catalogFingerprint=''))\nemit('chapter',id='123',title='Chapter 1',order=1,offset=0,pageIds=['p1'])\nemit('chapter',id='123',title='Chapter 1',order=1,offset=1,pageIds=['p2'])\nemit('complete')\n`)
  const catalog=await source.resolve('fixture','123',new AbortController().signal);assert.deepEqual(catalog.chapters[0].pageIds,['p1','p2'])
})
test('事件越界拒绝；不响应取消的子进程在五秒后退出',async t=>{
  const invalid=await runtime(t,`emit('chapter',id='123',title='bad',order=1,offset=5,pageIds=['p1'])\ntime.sleep(60)\n`)
  await assert.rejects(invalid.resolve('fixture','123',new AbortController().signal),/顺序/)
  const blocked=await runtime(t,`emit('heartbeat')\ntime.sleep(60)\n`),controller=new AbortController(),begin=Date.now()
  const result=blocked.resolve('fixture','123',controller.signal);setTimeout(()=>controller.abort(new Error('合成取消')),200)
  await assert.rejects(result,/合成取消/);assert.ok(Date.now()-begin<8000)
})
