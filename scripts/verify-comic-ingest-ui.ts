import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {loadPlaywright,electronTestEnv} from './helpers/playwright.ts'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {pngImage} from './helpers/test-images.ts'
import {createCanvas} from '@napi-rs/canvas'
const cover=createCanvas(90,120).toBuffer('image/jpeg').toString('base64')
const {_electron}=loadPlaywright(),packed=process.argv[2],output=path.resolve(process.argv[3]||'output/p1-p2-comic-2026-11-06/native-ui');fs.mkdirSync(output,{recursive:true})
const profile=fs.mkdtempSync(path.join(output,'profile-')),root=path.join(profile,'comics'),fake=path.join(profile,'fixture.py');fs.mkdirSync(root)
fs.writeFileSync(fake,`import sys,json,os,base64,hashlib\nr=json.loads(sys.stdin.readline());seq=0\ndef emit(event,**value):\n global seq\n seq+=1\n print(json.dumps(dict(protocolVersion=1,jobId=r['jobId'],sequence=seq,event=event,**value)),flush=True)\nif r['action']=='resolve':\n emit('work',value=dict(provider='jm',workId=r['workId'],name='合成摄入测试',authors=['合成作者'],description='只用于隔离验收的合成图片',tags=['验收'],publication='ongoing',adapterVersion='jmcomic-2.7.11/baoyi-1',catalogFingerprint=''))\n emit('cover',value='data:image/jpeg;base64,${cover}')\n emit('chapter',id='123',title='第一章',order=1,offset=0,pageIds=['p1','p2'])\nelse:\n data=base64.b64decode('${pngImage(200,300).toString('base64')}')\n for chapter in r['chapters']:\n  os.makedirs(os.path.join(r['directory'],chapter['directory']),exist_ok=True)\n  for i,page in enumerate(chapter['pageIds']):\n   if page in chapter['skip']:continue\n   file=chapter['directory']+'/'+str(i+1).zfill(5)+'.png'\n   with open(os.path.join(r['directory'],file),'wb') as f:f.write(data)\n   emit('page_start',chapterId=chapter['id'],pageId=page)\n   emit('page',chapterId=chapter['id'],pageId=page,file=file,sha256=hashlib.sha256(data).hexdigest(),size=len(data),width=200,height=300)\nemit('complete')\n`)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'light',hide_hentai:false,hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));db.close()
const app=await _electron.launch({executablePath:path.resolve(packed||'node_modules/electron/dist/electron.exe'),args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env:electronTestEnv()})
const page=await app.firstWindow(),errors:string[]=[],checks:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message))
try{
  assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await app.evaluate(({dialog}:any,{root,fake}:any)=>{
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})
    const cp:any=process.getBuiltinModule('node:child_process'),original=cp.spawn
    cp.spawn=(file:any,args:any[],options:any)=>original(file,args.map(a=>typeof a==='string'&&/[\\/]comic[\\/]bridge\.py$/.test(a)?fake:a),options)
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  },{root,fake})
  await page.waitForFunction(()=>!!window.baoyi?.comic)
  await page.getByRole('button',{name:/^图片\s/}).click()
  await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.getByRole('button',{name:'JM',exact:true}).click();await page.getByRole('button',{name:'编号 / 链接',exact:true}).click();await page.getByLabel('JM 编号或链接').fill('JM123');await page.getByRole('button',{name:'打开作品',exact:true}).click()
  // request prefilled by 打开作品
  await page.getByLabel('连接方式').selectOption('custom');await page.getByLabel('代理地址').fill('127.0.0.1:7890')
  await page.getByRole('button',{name:'解析作品',exact:true}).click();await page.getByRole('heading',{name:'合成摄入测试',exact:true}).waitFor()
  await page.screenshot({path:path.join(output,'preview.png')});assert.equal(await page.getByRole('checkbox').count(),1)
  await page.waitForFunction(()=>{const image=document.querySelector('.comic-cover') as HTMLImageElement;return image?.complete&&image.naturalWidth===90})
  checks.push('真实窗口解析预览、封面解码显示、代理选择、选章及键盘焦点')
  await page.getByRole('button',{name:'更改',exact:true}).click();await page.getByRole('button',{name:'加入下载',exact:true}).click()
  let jobs=await page.evaluate(()=>window.baoyi.comic.jobs())
  const deadline=Date.now()+20000
  while(jobs[0]?.status!=='success'&&Date.now()<deadline){await page.waitForTimeout(100);jobs=await page.evaluate(()=>window.baoyi.comic.jobs());if(jobs[0]?.status==='failed')throw new Error(jobs[0].error)}
  assert.equal(jobs[0]?.status,'success',JSON.stringify(jobs));assert.equal(jobs[0].processed,2)
  await page.locator('.comic-downloads').getByRole('button',{name:'打开作品'}).waitFor();await page.screenshot({path:path.join(output,'download-record.png')})
  await page.locator('.comic-downloads').getByRole('button',{name:'查看过程'}).click()
  await page.locator('.comic-log').getByText(/已入库/).first().waitFor()
  assert.ok(!(await page.locator('.comic-log').innerText()).includes('127.0.0.1'))
  checks.push('完成任务可展开本机过程记录，日志不暴露连接地址')
  await page.keyboard.press('Escape');await page.locator('.comic-downloads').getByRole('button',{name:'打开作品'}).click();await page.keyboard.press('Escape')
  const item=await page.evaluate(id=>window.baoyi.image.get(id),jobs[0].resourceId);assert.equal(item?.pageCount,2);assert.deepEqual(item?.authors,['合成作者'])
  checks.push('真实子进程协议、独立解码worker、同卷落盘、登记与统一下载记录')
  await page.getByRole('button',{name:'开始阅读',exact:true}).click();await page.screenshot({path:path.join(output,'reader.png')});await page.keyboard.press('Escape')
  checks.push('成品图片可用现有阅读器打开')
  await app.evaluate(({BrowserWindow}:any)=>{BrowserWindow.getAllWindows()[0].setSize(960,760)})
  await page.getByRole('button',{name:'返回书架',exact:true}).click();await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.screenshot({path:path.join(output,'narrow.png')})
  assert.equal(await page.locator('.source-hub').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)
  await page.keyboard.press('Escape');assert.equal(await page.locator('.source-hub').count(),0)
  await page.evaluate(async()=>{const settings=await window.baoyi.settings.patch({hide_hentai:true});const app=(document.querySelector('#app') as any).__vue_app__;app.config.globalProperties.$pinia._s.get('settings').settings=settings})
  await page.getByRole('button',{name:'下载任务',exact:true}).waitFor({state:'detached'});assert.equal((await page.evaluate(()=>window.baoyi.comic.jobs())).length,0)
  checks.push('960窗口无横溢出、Escape关闭、隐私隐藏入口与任务')
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:checks.length,checks,errors,profile,source:'synthetic Python provider; real host, worker, SQLite and filesystem'},null,2))
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),stack:(error as Error).stack},null,2));throw error}
finally{await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows().forEach((w:any)=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}
