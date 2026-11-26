import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent,bindVideoSource} from '../electron/kinds/video/registration.ts'
import {createVideoWorkflow} from '../electron/kinds/video/download/workflow.ts'
import {createVideoUpdateCheck,weeklyCheckDue} from '../electron/kinds/video/update-check.ts'
import {createRendererLoader} from './helpers/renderer-harness.ts'
import {filterProjects} from '../src/utils/project-view.ts'
import * as Vue from 'vue'
const tick=()=>new Promise(resolve=>setTimeout(resolve,10))
async function done(service:ReturnType<typeof createVideoUpdateCheck>){for(let n=0;n<300&&service.status().running;n++)await tick();assert.equal(service.status().running,false);return service.status()}
async function fixture(t:any){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-feedback2-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const file=path.join(root,'present.mp4');await fs.writeFile(file,'synthetic')
  const a=registerVideoContent(db,{title:'Public series',category:'剧集',items:[{title:'First',order:1,files:[{path:file}],sources:[{provider:'hanime',externalId:'101',scope:'episode',pageUrl:'',evidence:'playlist'}]}]}).resourceId
  db.prepare('UPDATE video_meta SET hanime_id=? WHERE resource_id=?').run('101',a)
  // Simulate an existing manually classified work; source registration defaults to its source category.
  db.prepare("UPDATE resource SET category='剧集' WHERE id=?").run(a)
  const b=registerVideoContent(db,{title:'Local movie',category:'电影',items:[{title:'Missing',order:1,files:[{path:path.join(root,'missing.mp4')}]}]}).resourceId
  let hidden=false,ready=true,last=0,enabled=false,calls=0
  const deps={db,hidden:()=>hidden,ready:()=>ready,resolve:async(code:string,_signal:AbortSignal)=>{calls++;return {videoCode:code,title:'Source',description:'',posterUrl:'',tags:[],warnings:[],episodes:['101','102','103'].map(videoCode=>({videoCode,title:videoCode}))}},jobs:()=>[{status:'queued',items:[{videoCode:'103'}]}] as any,weekly:()=>({enabled,last}),completed:(at:number)=>{last=at},changed:()=>{}}
  const service=createVideoUpdateCheck(deps)
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  return {db,a,b,file,deps,service,setHidden:(value:boolean)=>{hidden=value},setReady:(value:boolean)=>{ready=value},setWeekly:()=>{enabled=true},last:()=>last,calls:()=>calls}
}
test('batch checks bound series only without catalogue mutations or automatic downloads',async t=>{
  const {db,a,b,service,calls,last}=await fixture(t),before=db.prepare('SELECT total_changes() AS n').get()
  service.start([a,b]);const result=await done(service)
  assert.equal(result.rows.length,1);assert.equal(result.rows.find(r=>r.id===a)?.newEpisodes,1)
  assert.equal(result.rows.find(r=>r.id===b),undefined)
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),before);assert.equal(calls(),1);assert.equal(last(),0,'partial checks must not postpone full weekly check')
})
test('weekly starts are opt in and skip the next startup; failures remain retryable',async t=>{
  const {service,setWeekly,last,calls,deps}=await fixture(t)
  service.start(undefined,true);assert.equal(calls(),0)
  setWeekly();service.start(undefined,true);await done(service);assert.ok(last()>0)
  service.start(undefined,true);assert.equal(calls(),1)
  assert.equal(weeklyCheckDue(true,1000,1000+7*86400000-1),false)
  assert.equal(weeklyCheckDue(true,1000,1000+7*86400000),true)
  assert.equal(weeklyCheckDue(false,0),false)
  let saved=false
  const failed=createVideoUpdateCheck({...deps,weekly:()=>({enabled:true,last:0}),completed:()=>{saved=true},resolve:async()=>{throw new Error('network failure')}})
  failed.start(undefined,true);assert.ok((await done(failed)).rows.some(r=>r.status==='failed'));assert.equal(saved,false)
})

test('unbound series, invalid source ids, audio and source-bound movies are all skipped',async t=>{
  const {db,a,b,file,service,calls}=await fixture(t)
  db.prepare("UPDATE video_meta SET hanime_id='444' WHERE resource_id=?").run(b)
  const unbound=registerVideoContent(db,{title:'Unbound',category:'剧集',videoType:'series',items:[{title:'Unbound',order:1,files:[{path:path.join(path.dirname(file),'unbound.mp4')}]}]}).resourceId
  const audio=registerVideoContent(db,{title:'Audio',category:'剧集',mediaKind:'audio',items:[{title:'Audio',order:1,files:[{path:path.join(path.dirname(file),'audio.mp3')}]}]}).resourceId
  db.prepare("UPDATE video_meta SET hanime_id='555' WHERE resource_id=?").run(audio)
  db.prepare("UPDATE video_meta SET hanime_id='invalid' WHERE resource_id=?").run(a)
  service.start([a,b,unbound,audio]);const result=await done(service);assert.equal(result.total,0);assert.deepEqual(result.rows,[]);assert.equal(calls(),0)
})
test('source-only public series can be checked and supplemented; local movies are skipped',async t=>{
  const {db,a,b,service,deps}=await fixture(t)
  db.prepare("UPDATE video_meta SET hanime_id='' WHERE resource_id=?").run(a)
  bindVideoSource(db,a,{provider:'hanime',externalId:'101',scope:'work',pageUrl:'',evidence:'confirmed'})
  db.prepare("UPDATE resource SET category='剧集' WHERE id=?").run(a)
  db.prepare('DELETE FROM video_episode_assets WHERE episode_id IN (SELECT id FROM episode WHERE resource_id=?)').run(b)
  db.prepare('DELETE FROM video_assets WHERE resource_id=?').run(b)
  db.prepare("UPDATE episode SET path='' WHERE resource_id=?").run(b)
  service.start([a,b]);const result=await done(service)
  assert.equal(result.rows.find(r=>r.id===a)?.source,true)
  assert.equal(result.rows.find(r=>r.id===a)?.newEpisodes,1)
  assert.equal(result.rows.find(r=>r.id===b),undefined)
  const workflow=createVideoWorkflow({db,downloadsDirectory:()=>os.tmpdir(),
    resolveWork:code=>deps.resolve(code,new AbortController().signal),
    resolveSources:async()=>{throw new Error('checking must not resolve downloads')},
    transfer:async()=>{throw new Error('checking must not start downloads')}})
  const draft=await workflow.prepare({resourceId:a})
  assert.equal(draft.resourceId,a);assert.equal(draft.videoCode,'101');assert.equal(draft.category,'剧集')
  assert.equal(workflow.list().length,0)
})
test('privacy, cancellation, restore and duplicate starts preserve the running check boundary',async t=>{
  const {db,a,b,deps,setHidden,setReady}=await fixture(t)
  db.prepare("UPDATE resource SET category='里番' WHERE id=?").run(a)
  let release!:()=>void,calls=0
  const service=createVideoUpdateCheck({...deps,resolve:async(code,signal)=>{calls++;await new Promise<void>(r=>release=r);signal.throwIfAborted();return deps.resolve(code,signal)}})
  service.start([a]);while(!release)await tick();service.start([b]);assert.equal(calls,1)
  setHidden(true);service.cancel();release();assert.equal((await done(service)).rows.length,0)
  assert.equal(service.status().cancelled,true)
  service.start([a,b]);const visible=await done(service);assert.equal(visible.total,0);assert.equal(visible.rows.length,0)
  setReady(false);assert.throws(()=>service.start([b]),/恢复/)
})
test('archive IPC sends while downloads are busy, while writes and restore remain guarded',async()=>{
  const handlers=new Map<string,Function>(),db={},webContents={mainFrame:{}},win={webContents,isDestroyed:()=>false}
  let restore=false,sent=0,operation:Function=()=>{}
  class Assistant{constructor(options:any){operation=options.operation}async send(){sent++;return {status:'running'}}}
  const load=createRendererLoader({'node:path':{default:path},electron:{app:{getPath:()=>os.tmpdir(),getAppPath:()=>process.cwd(),on:()=>{}},},
    '../services/storage/database.ts': { getDb:()=>db },
    '../services/storage/settings-store.ts': { getSettings:()=>({hide_hentai:false,ai:{},ai_profiles:[]}) },
    '../kinds/game/service.ts':{},'../kinds/video/service.ts':{},'../kinds/project/handoff.ts':{},'../workspace/timeline.ts':{},
    '../workspace/document-insight-service.ts':{},'../workspace/document-insights.ts':{},'../workspace/documents.ts':{},'../workspace/preferences.ts':{},
    '../archive/service.ts':{ArchiveAssistant:Assistant},'../workspace/activity.ts':{workspaceOperation:(fn:Function)=>fn()},
    './library-backup.ts':{assertLibraryIdle:()=>{throw new Error('下载进行中')},libraryRestoreInProgress:()=>restore}
  },{process})
  load('electron/ipc/archive.ts').registerArchiveIpc(()=>win,{handle:(key:string,fn:Function)=>handlers.set(key,fn)})
  const event={sender:webContents,senderFrame:webContents.mainFrame}
  await handlers.get('archive:send')!(event,{text:'精读'});assert.equal(sent,1)
  assert.throws(()=>operation(()=>{}),/下载进行中/)
  restore=true;await assert.rejects(handlers.get('archive:send')!(event,{text:'精读'}),/恢复/);assert.equal(sent,1)
})
test('project tags match exactly and landscape preference survives recreation',async()=>{
  const rows=[{id:'a',name:'A',summary:'',path:'',category:'',group:'',tags:['web'],entries:[],pinned:false,updatedAt:1,lastOpenedAt:0},{id:'b',name:'B',summary:'',path:'',category:'',group:'',tags:['webapp'],entries:[],pinned:false,updatedAt:1,lastOpenedAt:0}] as any
  assert.deepEqual(filterProjects(rows,{search:'',category:'',group:'',source:'',state:'',pinned:false,availability:'',sort:'name',tag:'web'}).map(i=>i.id),['a'])
  const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k),setItem:(k:string,v:string)=>data.set(k,v)}
  const scope=Vue.effectScope(),load=createRendererLoader({vue:Vue},{localStorage:storage})
  const view=scope.run(()=>load('src/composables/useLibraryView.ts').useLibraryView('game'))
  view.coverShape.value='landscape';await Vue.nextTick()
  const restored=scope.run(()=>load('src/composables/useLibraryView.ts').useLibraryView('game'));assert.equal(restored.coverShape.value,'landscape');scope.stop()
})
