import test from 'node:test'
import assert from 'node:assert/strict'
import {comicWorkId,comicName,comicDirectory,comicCatalog,comicProxy,JM_ADAPTER_VERSION} from '../electron/kinds/image/comic-source-rules.ts'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'

test('统一下载行映射来源、稳定时间排序和按钮；所有操作按来源分发',async()=>{
  const pica={jobs:Vue.ref<any[]>([{id:'b',work:{title:'哔咔'},chapters:[{title:'第一章'}],status:'queued',processed:2,total:9,completedChapters:0,error:'',resourceId:'',createdAt:10,updatedAt:100,queuePosition:1}]),refresh:async()=>{},options:Vue.ref({concurrency:2}),setOptions:async()=>{}}
  const shown:any[]=[],jm={jobs:Vue.ref<any[]>([{id:'a',name:'JM',workId:'123',selectedChapters:['c'],status:'failed',phase:'placed',processed:3,total:3,completedChapters:1,error:'登记失败',resourceId:'',updatedAt:20,retryNotBefore:0,requiresRevalidation:false}]),error:Vue.ref(''),refresh:async()=>{},show:(...args:any[])=>shown.push(args)}
  const calls:any[]=[],record=(name:string)=>(...args:any[])=>{calls.push([name,...args]);return Promise.resolve([])}
  const image=Object.fromEntries(['retryJob','cancelJob','pauseJob','resumeJob','moveJob','dismissJob','jobLogs'].map(name=>[name,record('pica:'+name)]))
  const comic=Object.fromEntries(['retry','stop','dismiss','clean','logs'].map(name=>[name,record('jm:'+name)]))
  const load=createRendererLoader({vue:Vue,'./useImageDownloads':{useImageDownloads:()=>pica},'./useComicIngest':{useComicIngest:()=>jm}},{window:{baoyi:{image,comic}}})
  const downloads=load('src/composables/useComicDownloads.ts').useComicDownloads()
  const row=(provider:string)=>downloads.rows.value.find((r:any)=>r.provider===provider)
  assert.deepEqual([...downloads.rows.value.map((r:any)=>r.id)],['a','b'])
  assert.equal(row('jm').phaseLabel,'已落盘，待登记');assert.equal(row('pica').chapterTotal,1);assert.equal(row('pica').queuePosition,1)
  assert.deepEqual([...row('pica').actions],['up','down','pause','cancel','logs'])
  assert.deepEqual([...row('jm').actions],['retry','proxy','dismiss','clean','logs'])
  pica.jobs.value[0].updatedAt=999;jm.jobs.value[0].updatedAt=1000;jm.jobs.value[0].processed=2
  assert.deepEqual([...downloads.rows.value.map((r:any)=>r.id)],['a','b'],'进度变化不能改变首次确定的顺序')
  assert.equal(row('jm').createdAt,20)
  pica.jobs.value[0].createdAt=20;assert.deepEqual([...downloads.rows.value.map((r:any)=>r.id)],['a','b'],'同时间按 id')
  for(const action of ['retry','cancel','pause','resume','up','down','dismiss'])await downloads.run(row('pica'),action)
  await downloads.logs(row('pica'))
  for(const action of ['retry','pause','cancel','dismiss','clean'])await downloads.run(row('jm'),action)
  await downloads.run(row('jm'),'proxy',{mode:'custom',url:'127.0.0.1:7890'});await downloads.logs(row('jm'))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
    ['pica:retryJob','b'],['pica:cancelJob','b'],['pica:pauseJob','b'],['pica:resumeJob','b'],['pica:moveJob','b','up'],['pica:moveJob','b','down'],['pica:dismissJob','b'],['pica:jobLogs','b'],
    ['jm:retry','a',null],['jm:stop','a',false],['jm:stop','a',true],['jm:dismiss','a'],['jm:clean','a'],['jm:retry','a',{mode:'custom',url:'127.0.0.1:7890'}],['jm:logs','a']
  ])
  jm.jobs.value[0].requiresRevalidation=true;assert.deepEqual([...row('jm').actions],['revalidate','dismiss','logs'])
  await downloads.run(row('jm'),'revalidate');assert.equal(shown[0][0],'123');assert.equal(shown[0][1].id,'a')
  pica.jobs.value[0].status='paused';assert.deepEqual([...row('pica').actions],['resume','cancel','dismiss','logs'])
  pica.jobs.value[0].status='success';pica.jobs.value[0].resourceId='book';assert.deepEqual([...row('pica').actions],['open','dismiss','logs'])
})
test('只识别明确作品 ID 与固定站点链接，目录适配 Windows',()=>{
  for(const input of ['123','JM123','jm123','https://18comic.vip/album/123/'])assert.equal(comicWorkId(input),'123')
  for(const input of ['随便写123','https://example.org/album/123','file:///album/123','https://18comic.vip.evil/album/123','https://user@18comic.vip/album/123','https://18comic.vip/album/123?token=x','0','01'])assert.throws(()=>comicWorkId(input))
  assert.equal(comicName('CON'),'_CON');assert.equal(comicName('a/b. '),'a_b');assert.equal(comicName('e\u0301'),'é');assert.equal(comicDirectory({name:'作品',authors:[]}),'[未知作者] 作品')
})
test('三种代理可选择，裸地址规范化，拒绝凭据或脚本规则',()=>{
  assert.deepEqual(comicProxy({mode:'system'}),{mode:'system'});assert.deepEqual(comicProxy({mode:'builtin'}),{mode:'builtin'})
  assert.deepEqual(comicProxy({mode:'custom',url:'127.0.0.1:7890'}),{mode:'custom',url:'http://127.0.0.1:7890'})
  for(const url of ['http://user:secret@localhost:7890','direct://','http=foo:123;socks=bar:456','localhost:99999'])assert.throws(()=>comicProxy({mode:'custom',url}))
})
test('目录指纹固定页面身份顺序，不混入来源 URL；重复页面或改变指纹拒绝',()=>{
  const source={provider:'jm',workId:'123',name:'示例',authors:[],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:'123',title:'第一章',order:1,pageIds:['00001.jpg']}]}
  const a=comicCatalog(source),b=comicCatalog({...source,name:'改名'});assert.equal(a.catalogFingerprint,b.catalogFingerprint)
  assert.throws(()=>comicCatalog({...a,chapters:[{...a.chapters[0],pageIds:['00002.jpg']}]}),/指纹/)
  assert.throws(()=>comicCatalog({...source,chapters:[{...source.chapters[0],pageIds:['p1','p1']}]}),/清单/)
})
