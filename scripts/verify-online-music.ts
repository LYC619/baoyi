import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createMusicService,musicUrl,audioExtension} from '../electron/kinds/video/music.ts'
import {archiveTurnMode} from '../electron/archive/turn-policy.ts'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
const delay=()=>new Promise(r=>setTimeout(r,5))
async function fixture(t:any){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-music-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const audio=Buffer.concat([Buffer.from('fLaC'),Buffer.alloc(512,5)]),picture=Buffer.from([255,216,255,217]),registered:any[]=[],calls:string[]=[]
  let mode='ok',ready=true
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));calls.push(url.pathname+url.search)
    if(url.hostname==='music-api.gdstudio.xyz'){
      const kind=url.searchParams.get('types')
      if(mode==='unsupported')return Response.json({detail:'source not supported'},{status:400})
      if(mode==='lossless-fallback'&&kind==='url'&&url.searchParams.get('br')==='999')return Response.json({url:'',br:-1,size:0})
      return Response.json(kind==='search'?[{id:'1',name:'合成曲目',artist:['合成歌手'],album:'测试专辑',pic_id:'cover'}]:kind==='url'?{url:'https://media.example.com/music',br:999,size:audio.length}:kind==='pic'?{url:'https://media.example.com/cover'}:{lyric:'[00:00.00]合成歌词'})
    }
    if(url.pathname==='/cover')return new Response(mode==='bad-cover'?'html':picture)
    if(mode==='stall')return new Response(new ReadableStream({start(c){init?.signal?.addEventListener('abort',()=>c.error(init.signal?.reason),{once:true})}}))
    return new Response(mode==='html'?Buffer.from('<html>failed</html>'):audio,{status:mode==='partial'?206:200,headers:{'content-length':String(mode==='short'?audio.length+1:mode==='html'?19:audio.length),'content-type':'audio/flac'}})
  }
  const deps={fetch:fetcher,stateFile:path.join(root,'state.json'),root:()=>path.join(root,'music'),ready:()=>ready,changed:()=>{},register:(track:any,file:string,cover:string,lyric:string)=>{registered.push({track,file,cover,lyric});return registerVideoContent(db,{mediaKind:'audio',videoType:'movie',title:track.title,category:'音频',posterPath:cover,description:track.artists.join(' / '),tags:track.artists,sources:[{provider:'gd-'+track.source,externalId:track.id,scope:'work',pageUrl:'https://music.gdstudio.xyz',evidence:'confirmed'}],items:[{title:track.title,order:1,files:[{path:file}],attachments:lyric?[{path:lyric,role:'attachment'}]:[]}]}).resourceId}}
  const service=createMusicService(deps)
  t.after(async()=>{for(const job of service.list())service.cancel(job.id);while(service.busy())await delay();db.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true})})
  return {service,deps,root,db,audio,picture,registered,calls,mode:(value:string)=>mode=value,setReady:(value:boolean)=>ready=value}
}
async function done(service:ReturnType<typeof createMusicService>,id:string){for(let i=0;i<1000&&service.busy();i++)await delay();const job=service.list().find(j=>j.id===id)!;assert.equal(service.busy(),false);assert.notEqual(job.status,'running');return job}
test('search/opaque preview/download/cover/LRC register one local audio resource',async t=>{
  const {service,db,audio,picture,registered}=await fixture(t)
  const [track]=await service.search('netease','曲目');assert.equal(track.title,'合成曲目')
  const preview=await service.preview(track.key);assert.match(preview.url,/^baoyi:\/\/online-music\//)
  const response=await service.response(new Request(preview.url));assert.deepEqual(Buffer.from(await response.arrayBuffer()),audio)
  assert.equal((await service.response(new Request('baoyi://online-music/unknown'))).status,404)
  const started=service.download(track.key);assert.equal(service.download(track.key).id,started.id)
  const job=await done(service,started.id);assert.equal(job.status,'completed');assert.equal(registered.length,1)
  const item=registered[0];assert.deepEqual(await fs.readFile(item.file),audio);assert.deepEqual(await fs.readFile(item.cover),picture);assert.equal(await fs.readFile(item.lyric,'utf8'),'[00:00.00]合成歌词')
  assert.equal((db.prepare('SELECT media_kind FROM video_meta WHERE resource_id=?').get(job.resourceId!) as any).media_kind,'audio')
  assert.equal((db.prepare('SELECT category FROM resource WHERE id=?').get(job.resourceId!) as any).category,'音频')
  assert.equal(service.download(track.key).id,started.id);assert.equal(registered.length,1)
  assert.ok(!(await fs.readdir(job.directory)).includes('audio.part'))
  await fs.unlink(item.file);assert.equal(service.list()[0].status,'interrupted');const again=service.download(track.key);assert.notEqual(again.id,job.id);assert.equal((await done(service,again.id)).status,'completed')
})
test('fallback tries 16-bit lossless before MP3 and unavailable sources give a useful error',async t=>{
  const {service,mode,calls}=await fixture(t);mode('unsupported');await assert.rejects(service.search('tencent','a'),/暂未开放.*换平台/)
  mode('lossless-fallback');const [track]=await service.search('joox','a');assert.equal((await done(service,service.download(track.key).id)).status,'completed');assert.ok(calls.some(url=>url.includes('br=740')));assert.ok(!calls.some(url=>url.includes('br=320')))
})
test('invalid/truncated/partial content never registers; failed download can retry',async t=>{
  const {service,mode,registered}=await fixture(t);const [track]=await service.search('tencent','a')
  for(const failure of ['html','short','partial']){mode(failure);const job=await done(service,service.download(track.key).id);assert.equal(job.status,'failed');assert.equal(registered.length,0);assert.ok(!(await fs.readdir(job.directory)).includes('audio.part'))}
  mode('bad-cover');const job=await done(service,service.retry(service.list()[0].id).id);assert.equal(job.status,'completed');assert.match(job.message,/封面/);assert.equal(registered.length,1)
})
test('cancel/restore guard/restart retain recoverable task status',async t=>{
  const {service,deps,mode,setReady,registered}=await fixture(t);const [track]=await service.search('kuwo','a');setReady(false);assert.throws(()=>service.download(track.key),/恢复/);setReady(true);mode('stall')
  const job=service.download(track.key);await delay();const reopened=createMusicService(deps);assert.equal(reopened.list()[0].status,'interrupted')
  service.cancel(job.id);assert.equal((await done(service,job.id)).status,'cancelled');assert.equal(registered.length,0)
  mode('ok');assert.equal((await done(service,service.retry(job.id).id)).status,'completed')
})
test('source validation and task-aware conversation routing',()=>{
  for(const url of ['file:///a','http://127.0.0.1/a','http://192.168.1.1/a','https://user:secret@example.com/'])assert.throws(()=>musicUrl(url))
  assert.throws(()=>audioExtension(Buffer.from('<html>')))
  assert.equal(archiveTurnMode('你好',false,true),'chat');assert.equal(archiveTurnMode('好的',false,true),'archive')
  assert.equal(archiveTurnMode('解释彩虹',false,false),'chat');assert.equal(archiveTurnMode('精读这个文件',false,false),'archive');assert.equal(archiveTurnMode('你好',true,false),'archive')
})
