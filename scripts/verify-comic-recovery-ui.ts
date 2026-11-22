import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ComicIngestService} from '../electron/kinds/image/comic-ingest.ts'
import {comicCatalog,JM_ADAPTER_VERSION} from '../electron/kinds/image/comic-source-rules.ts'
import {backupComicJob} from '../electron/kinds/image/comic-job.ts'
import {createComicVerifier} from '../electron/kinds/image/comic-verifier.ts'
import {pngImage} from './helpers/test-images.ts'
const {_electron}=loadPlaywright(),packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-comic-2026-11-06/native-recovery')
await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'profile-')),root=path.join(profile,'comics'),fake=path.join(profile,'fixture.py'),trace=path.join(profile,'requests.jsonl');await fs.mkdir(root)
const image=pngImage(200,300),db=new DatabaseSync(path.join(profile,'baoyi.db'))
initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
const queue=new ComicIngestService({db,authorizationDirectory:path.join(profile,'comic-authorizations'),allowed:()=>true,assertIdle:()=>{},changed:()=>{},jobsChanged:()=>{},verifier:()=>createComicVerifier(pathToFileURL(path.resolve('electron/kinds/image/comic-verify-worker.ts'))),runtime:()=>({
  resolve:async(_id,input)=>comicCatalog({provider:'jm',workId:input,name:'合成恢复 '+input,authors:['合成作者'],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:input,title:'第一章',order:1,pageIds:['p1','p2']}]}),
  download:async(_id,_work,directory,chapters,_signal,onPage)=>{const chapter=chapters[0],file=chapter.directory+'/00001.png';await fs.mkdir(path.join(directory,chapter.directory));await fs.writeFile(path.join(directory,file),image);onPage({chapterId:chapter.id,pageId:'p1',file,size:image.length,sha256:createHash('sha256').update(image).digest('hex'),width:200,height:300});throw new Error('合成网络中断')}
})})
const ids:Record<string,string>={}
for(const work of ['321','654','987']){
  const preview=await queue.preview(work,{mode:'system'});ids[work]=await queue.enqueue(preview.token,[work],root,preview.directory,null)
  for(let n=0;n<300&&queue.list().find(j=>j.id===ids[work])?.status!=='failed';n++)await new Promise(r=>setTimeout(r,20))
  assert.equal(queue.list().find(j=>j.id===ids[work])?.status,'failed')
}
await queue.stopAll()
const restored=backupComicJob(JSON.parse(String((db.prepare('SELECT payload FROM image_download_jobs WHERE id=?').get(ids['321']) as any).payload)))
db.prepare('UPDATE image_download_jobs SET payload=? WHERE id=?').run(JSON.stringify(restored),restored.id);db.close()
await fs.writeFile(fake,`import sys,json,os,base64,hashlib\nr=json.loads(sys.stdin.readline());seq=0\nwith open(${JSON.stringify(trace)},'a',encoding='utf-8') as t:t.write(json.dumps(r)+'\\n')\ndef emit(event,**value):\n global seq\n seq+=1\n print(json.dumps(dict(protocolVersion=1,jobId=r['jobId'],sequence=seq,event=event,**value)),flush=True)\nif r['action']=='resolve':\n emit('work',value=dict(provider='jm',workId=r['workId'],name='合成恢复 '+r['workId'],authors=['合成作者'],description='',tags=[],publication='ongoing',adapterVersion='jmcomic-2.7.11/baoyi-1',catalogFingerprint=''))\n emit('chapter',id=r['workId'],title='第一章',order=1,offset=0,pageIds=['p1','p2'])\nelse:\n data=base64.b64decode('${image.toString('base64')}')\n for c in r['chapters']:\n  os.makedirs(os.path.join(r['directory'],c['directory']),exist_ok=True)\n  for i,p in enumerate(c['pageIds']):\n   if p in c['skip']:continue\n   file=c['directory']+'/'+str(i+1).zfill(5)+'.png'\n   with open(os.path.join(r['directory'],file),'wb') as f:f.write(data)\n   emit('page_start',chapterId=c['id'],pageId=p)\n   emit('page',chapterId=c['id'],pageId=p,file=file,sha256=hashlib.sha256(data).hexdigest(),size=len(data),width=200,height=300)\nemit('complete')\n`)
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()}),page=await app.firstWindow(),checks:string[]=[],errors:string[]=[]
page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
async function completed(id:string){const until=Date.now()+20000;while(Date.now()<until){const jobs=await page.evaluate(()=>window.baoyi.comic.jobs()),job=jobs.find(j=>j.id===id);if(job?.status==='success')return job;if(job?.status==='failed')throw new Error(job.error);await page.waitForTimeout(100)}throw new Error('任务未完成')}
try{
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await app.evaluate(({dialog}:any,{root,fake,profile}:any)=>{const nFs:any=process.getBuiltinModule('node:fs'),nPath:any=process.getBuiltinModule('node:path'),dev=nFs.statSync(root).dev;for(const dir of [nPath.join(root,'.baoyi-ingest'),nPath.join(profile,'comic-authorizations')]){if(!nFs.existsSync(dir))continue;for(const entry of nFs.readdirSync(dir)){const file=entry.endsWith('.json')?nPath.join(dir,entry):nPath.join(dir,entry,'intent.json');if(!nFs.existsSync(file))continue;const data=JSON.parse(nFs.readFileSync(file,'utf8'));if(data.root&&typeof data.root.dev==='number'){data.root.dev=dev;nFs.writeFileSync(file,JSON.stringify(data))}}};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});dialog.showMessageBox=async()=>({response:1});const cp:any=process.getBuiltinModule('node:child_process'),original=cp.spawn;cp.spawn=(file:any,args:any[],options:any)=>original(file,args.map(a=>typeof a==='string'&&/[\\/]comic[\\/]bridge\.py$/.test(a)?fake:a),options);process.getBuiltinModule('node:module').syncBuiltinESMExports()},{root,fake,profile})
  await page.waitForFunction(()=>!!window.baoyi?.comic);await page.waitForTimeout(250);assert.equal(await fs.stat(trace).catch(()=>null),null,'启动未自动联网')
  await page.getByRole('button',{name:/^图片\s/}).click();await page.getByRole('button',{name:'下载任务',exact:true}).click()
  let row=page.locator('.comic-downloads article[data-provider="jm"]').filter({hasText:'合成恢复 321'})
  await row.getByRole('button',{name:'重新核验',exact:true}).click();await page.getByRole('button',{name:'解析作品',exact:true}).click();await page.getByRole('heading',{name:'合成恢复 321',exact:true}).waitFor()
  await page.getByRole('button',{name:'核验并继续',exact:true}).click();await page.locator('.comic-dialog').waitFor({state:'hidden'});await completed(ids['321'])
  let requests=(await fs.readFile(trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.deepEqual(requests.find(r=>r.action==='download'&&r.workId==='321').chapters[0].skip,['p1'])
  checks.push('备份任务冷启动不联网；界面重新核验后复用原页并入库')
  row=page.locator('.comic-downloads article[data-provider="jm"]').filter({hasText:'合成恢复 654'})
  await row.getByRole('button',{name:'更换连接方式',exact:true}).click();await page.getByLabel('重试连接方式').selectOption('custom');await page.getByLabel('重试代理地址').fill('127.0.0.1:7890');await row.getByRole('button',{name:'保存并重试',exact:true}).click();await page.getByLabel('重试连接方式').waitFor({state:'detached'});await completed(ids['654'])
  const defaults=await page.evaluate(()=>window.baoyi.comic.defaults());assert.deepEqual(defaults.proxy,{mode:'custom',url:'http://127.0.0.1:7890'})
  requests=(await fs.readFile(trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s));const download=requests.find(r=>r.action==='download'&&r.workId==='654');assert.ok(Object.values(download.proxies).every(p=>p==='http://127.0.0.1:7890'));assert.deepEqual(download.chapters[0].skip,['p1'])
  checks.push('失败记录更换代理并续传，记住最近连接方式')
  row=page.locator('.comic-downloads article[data-provider="jm"]').filter({hasText:'合成恢复 987'});await row.getByRole('button',{name:'停止并清理暂存',exact:true}).click();await page.locator('.app-dialog [data-dialog-confirm]').click();await row.waitFor({state:'detached'})
  assert.equal(await fs.stat(path.join(root,'.baoyi-ingest',ids['987'])).catch(()=>null),null)
  assert.ok(await fs.stat(path.join(root,'[合成作者] 合成恢复 321')))
  checks.push('确认后清理未入库暂存，已完成作品保留')
  await page.screenshot({path:path.join(output,'recovery-complete.png')});assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,source:'synthetic provider; real Electron, Python transport, worker and files'},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().forEach((w:any)=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}
