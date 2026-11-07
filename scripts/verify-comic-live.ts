/** Small explicit upstream example; isolated files, no daily library or credentials. */
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {ComicRuntime} from '../electron/kinds/image/comic-runtime.ts'
import {JM_API_HOSTS,JM_IMAGE_HOSTS,comicProxy} from '../electron/kinds/image/comic-source-rules.ts'
import {createComicVerifier} from '../electron/kinds/image/comic-verifier.ts'
const output=path.resolve('output/p1-p2-comic-2026-11-06/live');await fs.mkdir(output,{recursive:true})
const root=await fs.mkdtemp(path.join(output,'run-')),controller=new AbortController(),deadline=setTimeout(()=>controller.abort(new Error('实际来源验收达到三分钟上限')),180000)
const requested=process.argv.find(a=>a.startsWith('--proxy='))?.slice(8)||'127.0.0.1:7890',validated=comicProxy({mode:'custom',url:requested})
const proxy=process.argv.includes('--direct')?'':validated.mode==='custom'?validated.url:''
const runtime=new ComicRuntime({python:path.resolve('output/hermes-runtime/python/python.exe'),runtime:path.resolve('output/comic-runtime'),bridge:path.resolve('resources/comic/bridge.py'),proxies:async()=>Object.fromEntries([...JM_API_HOSTS,...JM_IMAGE_HOSTS].map(h=>[h,proxy]))})
const started=Date.now(),checks:string[]=[]
try{
  const catalog=await runtime.resolve('live-probe','350234',controller.signal)
  await fs.writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2));checks.push('锁定上游公开示例实际解析作品和章节')
  const chapter=catalog.chapters[0],pages:any[]=[]
  await runtime.download('live-pages',catalog.workId,root,[{id:chapter.id,directory:'sample',pageIds:chapter.pageIds,skip:chapter.pageIds.slice(2)}],controller.signal,p=>pages.push(p))
  const verifier=createComicVerifier(pathToFileURL(path.resolve('electron/kinds/image/comic-verify-worker.ts')))
  try{for(const page of pages)await verifier.verify(root,page)}finally{await verifier.close()}
  assert.equal(pages.length,Math.min(2,chapter.pageIds.length));checks.push('实际下载最多两页，经原版还原与独立主机解码核对')
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify({passed:checks.length,checks,adapter:catalog.adapterVersion,workId:catalog.workId,chapters:catalog.chapters.length,pageCount:chapter.pageIds.length,pages,elapsedMs:Date.now()-started,proxy:proxy?'custom loopback':'direct'},null,2))
  console.log('PASS '+checks.length+' live source groups; '+root)
}catch(error){await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({checks,error:String(error),elapsedMs:Date.now()-started,proxy:proxy?'custom loopback':'direct'},null,2));console.error(String(error));process.exitCode=1}
finally{clearTimeout(deadline)}
