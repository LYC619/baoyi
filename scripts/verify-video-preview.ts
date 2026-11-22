import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {byteRange,VideoPreviewService} from '../electron/kinds/video/preview.ts'
import {createHash} from 'node:crypto'
import {discoveryPoster,posterReferenced,posterResponse,resolvePosterRequest} from '../electron/services/media/poster-protocol.ts'
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-video-preview-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const file=path.join(root,'video.mp4'),alternate=path.join(root,'other.webm');await fs.writeFile(file,Buffer.from('0123456789'));await fs.writeFile(alternate,'abcdefghij')
  const registration=registerVideoContent(db,{title:'合成视频',category:'其他',videoType:'movie',items:[{title:'内容一',order:1,files:[{path:file},{path:alternate}]}]})
  let hidden=false,blocked=false,now=Date.now()
  const service=new VideoPreviewService({db:()=>db,hidden:()=>hidden,blocked:()=>blocked,now:()=>now})
  t.after(async()=>{service.close();db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-video-preview-')));await fs.rm(root,{recursive:true,force:true})})
  return {root,file,alternate,db,service,id:registration.resourceId,hide:()=>hidden=true,block:()=>blocked=true,expire:()=>now+=16*60000}
}
test('Range整数、后缀、开放区间、空文件及非法范围',()=>{
  assert.deepEqual(byteRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(byteRange('bytes=5-',10),{start:5,end:9})
  for(const range of ['bytes=10-','bytes=7-4','bytes=0-1,3-4','bytes=-0','bytes=9007199254740992-','bytes=-','items=0-5'])assert.equal(byteRange(range,10),false,range)
  assert.equal(byteRange('bytes=0-',0),false);assert.equal(byteRange(null,0),null)
})
test('隐私模式不能通过海报缓存或作品图片目录读取无公开引用的图片',async t=>{
  const {root}=await fixture(t),postersDir=path.join(root,'posters')
  for(const file of [path.join(postersDir,'hidden.jpg'),path.join(root,'.baoyi','artwork','hidden.jpg')]){
    const url='baoyi://poster/?p='+encodeURIComponent(file)
    assert.equal(resolvePosterRequest(url,{postersDir,hideHentai:true,isReferenced:()=>false}),'')
    assert.equal(resolvePosterRequest(url,{postersDir,hideHentai:false,isReferenced:()=>false}),file)
  }
})
test('精确副本签发与真实文件Range/HEAD，不接受其他文件或任意路径',async t=>{
  const {service,id}=await fixture(t),choices=await service.choices(id)
  assert.equal(choices.assets.length,2);const chosen=choices.assets.find(asset=>asset.name==='other.webm')!,session=await service.open(id,chosen.key)
  const request=(headers:Record<string,string>={},method='GET')=>service.response(new Request(session.url,{headers,method}))
  let response=await request({range:'bytes=2-5'});assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),'bytes 2-5/10');assert.equal(await response.text(),'cdef')
  response=await request({range:'bytes=-2'});assert.equal(await response.text(),'ij')
  response=await request({},'HEAD');assert.equal(response.headers.get('Content-Length'),'10');assert.equal(await response.text(),'')
  response=await request({range:'bytes=10-'});assert.equal(response.status,416);assert.equal(response.headers.get('Content-Range'),'bytes */10')
  assert.equal((await service.response(new Request('baoyi://video/C:/test.mp4'))).status,404)
  service.release(session.token);assert.equal((await request()).status,404)
})
test('作品、单集和共享海报随隐私范围即时变化，成功与拒绝均不缓存',async t=>{
  const {root,db,id}=await fixture(t),postersDir=path.join(root,'posters')
  const hidden=registerVideoContent(db,{title:'合成隐藏作品',category:'里番',items:[{title:'合成单集',order:1,files:[{path:path.join(root,'hidden.mp4')}]}]}).resourceId
  const work=path.join(postersDir,'work.jpg'),episode=path.join(root,'.baoyi','artwork','100%.jpg'),shared=path.join(root,'shared.png')
  db.prepare('UPDATE video_meta SET poster_path=?,thumbnail_path=? WHERE resource_id=?').run(work,shared,id)
  db.prepare('UPDATE episode SET poster_path=? WHERE resource_id=?').run(episode,hidden)
  db.prepare('UPDATE video_meta SET poster_path=? WHERE resource_id=?').run(shared,hidden)
  async function check(file:string,hideHentai:boolean,status:number){
    const res=await posterResponse('baoyi://poster/?p='+encodeURIComponent(file),{postersDir,hideHentai,isReferenced:p=>posterReferenced(db,p,hideHentai)},async()=>new Response('fixture'))
    assert.equal(res.status,status);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(await res.text(),status===200?'fixture':'')
  }
  await check(episode,false,200);await check(episode,true,404);await check(work,true,200);await check(shared,true,200)
  db.prepare('UPDATE resource SET category=? WHERE id=?').run('里番',id)
  await check(work,true,404);await check(shared,true,404);await check(episode,false,200)
})
test('来源海报按当前条目授权，隐藏已入库作品和移除来源会撤销原地址', async t => {
  const {root, db} = await fixture(t)
  const remote = 'https://fixture.invalid/art.png', postersDir = path.join(root, 'posters')
  const file = path.join(postersDir, '123456789abcdef123456789.png')
  const hash = createHash('sha256').update(remote).digest('hex')
  db.prepare('INSERT INTO video_discovery_sources VALUES(?,1,?)').run('demo', JSON.stringify({entries:[{id:'a',coverUrl:remote}]}))
  db.prepare('INSERT INTO video_discovery_artwork VALUES(?,?)').run(hash,file)
  const ctx = { postersDir, hideHentai:true, isReferenced:()=>false, discoveryFile:(s:string,e:string)=>discoveryPoster(db,s,e,true) }
  const url = 'baoyi://poster/?source=demo&entry=a'
  assert.equal(resolvePosterRequest(url,ctx),file)
  assert.equal(resolvePosterRequest('baoyi://poster/?p='+encodeURIComponent(file),ctx),'')
  const id = registerVideoContent(db,{title:'合成',category:'里番',items:[{title:'合成',order:1,files:[{path:path.join(root,'catalogue.mp4')}],sources:[{provider:'catalogue:demo',externalId:'a',scope:'work',pageUrl:remote,evidence:'confirmed'}]}]}).resourceId
  assert.equal(resolvePosterRequest(url,ctx),'')
  db.prepare('UPDATE resource SET category=? WHERE id=?').run('其他',id)
  assert.equal(resolvePosterRequest(url,ctx),file)
  db.prepare('DELETE FROM video_discovery_sources WHERE id=?').run('demo')
  assert.equal(resolvePosterRequest(url,ctx),'')
})
test('poster authorization uses four NOCASE path indexes after upgrading schema 32', async t => {
  const {db, root, id} = await fixture(t)
  const file = path.join(root, 'MixedCase.jpg')
  db.prepare('UPDATE video_meta SET poster_path=? WHERE resource_id=?').run(file, id)
  const plans: string[] = []
  const explainDb = {
    exec: (sql:string) => db.exec(sql),
    prepare: (sql:string) => {
      const statement = db.prepare(sql)
      return {...statement, get: (params: any) => {
        plans.push(...db.prepare('EXPLAIN QUERY PLAN ' + sql).all(params).map((row:any) => row.detail))
        return statement.get(params)
      }}
    }
  }
  assert.equal(posterReferenced(explainDb as any, file.toUpperCase(), true), true)
  for (const table of ['video_meta', 'episode']) for (const column of ['poster', 'thumbnail']) {
    assert.ok(plans.some(detail => detail.includes(`idx_${table}_${column}_nocase`)), plans.join('\n'))
  }
  assert.ok(!plans.some(detail => /SCAN (?:a|video_meta|episode)\b/.test(detail)), plans.join('\n'))
  for (const table of ['video_meta', 'episode']) for (const column of ['poster', 'thumbnail']) db.exec(`DROP INDEX idx_${table}_${column}_nocase`)
  db.prepare("UPDATE settings SET value='32' WHERE key='_schema'").run()
  initSchema(db, KINDS)
  plans.length = 0
  assert.equal(posterReferenced(explainDb as any, file.toUpperCase(), true), true)
  assert.equal(plans.filter(detail => /USING INDEX idx_.*_nocase/.test(detail)).length, 4)
})
test('源变化、过期、隐私、恢复全部撤销访问，删除后没有迟到流',async t=>{
  const {service,id,file,hide,expire,block}=await fixture(t),choices=await service.choices(id),chosen=choices.assets.find(asset=>asset.name==='video.mp4')!
  let session=await service.open(id,chosen.key);await fs.appendFile(file,'changed');assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);expire();assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);hide();assert.equal((await service.response(new Request(session.url))).status,404)
  session=await service.open(id,chosen.key);block();assert.equal((await service.response(new Request(session.url))).status,404)
})
