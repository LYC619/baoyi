/** Real preload/IPC/source/download flow with synthetic responses. Optional argument: packaged executable. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { pngImage } from './helpers/test-images.ts'
import type { ImageDownloadJob, ImageItem } from '../src/types/image.ts'
const require=createRequire(import.meta.url)
const {_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output=path.resolve(process.env.BAOYI_IMAGE_SOURCE_OUTPUT||'output/pica-browse-verification');fs.mkdirSync(output,{recursive:true})
const packed=!!process.argv[2],suffix=packed?'-packaged':''
const executable=path.resolve(process.argv[2]||'node_modules/electron/dist/electron.exe')
const profile=fs.mkdtempSync(path.join(output,'profile-')),downloadRoot=path.join(profile,'downloads');fs.mkdirSync(downloadRoot)
const db=new DatabaseSync(path.join(profile,'baoyi.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,theme:'dark',hanime_builtin_hosts:false}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
db.close()
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const application=await _electron.launch({executablePath:executable,args:[...(packed?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
try{
  assert.equal(path.resolve(await application.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  await application.evaluate(({net,dialog}:any,{downloadRoot,png}:any)=>{
    const state={calls:[] as string[],expired:false};(globalThis as any).__picaFixture=state
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[downloadRoot]})
    net.request=(options:any)=>{
      const {EventEmitter}=process.getBuiltinModule('node:events'),{PassThrough}=process.getBuiltinModule('node:stream')
      const request=Object.assign(new EventEmitter(),{setHeader:()=>{},abort:()=>{},end:()=>{}})
      request.end=()=>queueMicrotask(()=>{
        const url=new URL(options.url);state.calls.push(url.pathname+url.search)
        if(options.credentials!=='omit'){request.emit('error',new Error('Media must omit credentials'));return}
        if(url.pathname.startsWith('/static/')){request.emit('redirect',301,'GET','https://img.picacomic.com'+url.pathname.replace('/static/','/media/'));return}
        if(url.hostname!=='img.picacomic.com'||!url.pathname.startsWith('/media/')){request.emit('error',new Error('Unexpected media request'));return}
        const response=Object.assign(new PassThrough(),{statusCode:200,headers:{'content-type':'image/png'}})
        request.emit('response',response);response.end(Buffer.from(png,'base64'))
      })
      return request
    }
    net.fetch=async(raw:string,init:any)=>{
      const url=new URL(raw);state.calls.push(url.pathname+url.search)
      const ok=(data:any)=>Response.json({code:200,data})
      if(url.pathname==='/auth/sign-in')return ok({token:'synthetic-token'})
      if(state.expired)return new Response('',{status:401})
      const row=(id:string,title:string)=>({_id:id,title,author:'合成作者',description:'仅用于离线界面验证',tags:['示例'],epsCount:2,pagesCount:2,finished:true,allowDownload:true,thumb:{fileServer:'https://images.picacomic.com',path:'cover/'+id}})
      if(url.pathname==='/users/favourite')return ok({comics:{docs:[row('favorite'+url.searchParams.get('page'),'收藏第'+url.searchParams.get('page')+'页作品')],pages:2}})
      if(url.pathname==='/comics/leaderboard')return ok({comics:[row('rank1',url.searchParams.get('tt')+'榜单作品'),{...row('rank2','无封面作品'),thumb:null}]})
      if(url.pathname==='/comics/advanced-search')return ok({comics:{docs:[row('search1',JSON.parse(init.body).keyword+'搜索作品')],pages:1}})
      if(url.pathname.endsWith('/eps'))return ok({eps:{docs:[{_id:'chapter2',title:'第2话',order:2},{_id:'chapter1',title:'第1话',order:1}],pages:1}})
      if(url.pathname.endsWith('/pages'))return ok({pages:{docs:[{_id:'page1',media:{fileServer:'https://images.picacomic.com',path:'page/1'}}],pages:1}})
      if(url.pathname.startsWith('/comics/'))return ok({comic:row(url.pathname.split('/')[2],'榜单下载作品')})
      throw new Error('Unexpected fixture request: '+url.pathname)
    }
  },{downloadRoot,png:pngImage(160,240,[70,95,150]).toString('base64')})
  const page=await application.firstWindow();page.setDefaultTimeout(15000)
  const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.waitForFunction(()=>!!window.baoyi?.image)
  await page.evaluate(()=>{location.hash='/image'})
  await page.getByRole('button',{name:'从哔咔添加',exact:true}).click()
  await page.getByLabel('用户名',{exact:true}).fill('fixture')
  await page.getByLabel('密码',{exact:true}).fill('synthetic')
  await page.getByRole('button',{name:'登录哔咔',exact:true}).click()
  await page.getByRole('button',{name:'我的收藏',exact:true}).click()
  await page.getByRole('button',{name:/收藏第1页作品/}).waitFor()
  await page.waitForFunction(()=>{const img=document.querySelector('.source-results img') as HTMLImageElement;return img?.naturalWidth>0})
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:/收藏第2页作品/}).waitFor()
  await page.getByLabel('收藏排序',{exact:true}).selectOption('da')
  await page.getByRole('button',{name:/收藏第1页作品/}).waitFor()
  await page.getByRole('button',{name:'排行榜',exact:true}).click()
  await page.getByRole('button',{name:/H24榜单作品/}).waitFor()
  for(const period of ['D7','D30']){await page.getByLabel('榜单周期',{exact:true}).selectOption(period);await page.getByRole('button',{name:new RegExp(period+'榜单作品')}).waitFor()}
  assert.equal(await page.getByText('暂无封面',{exact:true}).count(),1)
  await page.waitForFunction(()=>{const img=document.querySelector('.source-results img') as HTMLImageElement;return img?.naturalWidth>0})
  await page.screenshot({path:path.join(output,'ranking-desktop'+suffix+'.png')})
  await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setSize(960,640))
  await page.screenshot({path:path.join(output,'ranking'+suffix+'.png')})
  assert.equal(await page.locator('.source-dialog').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth),false)
  await page.getByRole('button',{name:/D30榜单作品/}).click()
  await page.getByLabel('全选章节',{exact:true}).uncheck()
  await page.getByLabel('第2话',{exact:true}).check()
  await page.waitForFunction(()=>{const img=document.querySelector('.source-detail-heading img') as HTMLImageElement;return img?.naturalWidth>0})
  await page.screenshot({path:path.join(output,'chapter-selection'+suffix+'.png')})
  await page.getByRole('button',{name:'选择目录并下载',exact:true}).click()
  let jobs:ImageDownloadJob[]=[]
  const deadline=Date.now()+15000
  while(Date.now()<deadline){
    jobs=await page.evaluate(()=>window.baoyi.image.jobs())
    if(jobs[0]&&!['queued','running'].includes(jobs[0].status))break
    await delay(50)
  }
  assert.equal(jobs[0]?.status,'success',jobs[0]?.error||'下载未在期限内完成')
  assert.ok(jobs[0].resourceId,'下载完成后必须返回入库资源编号')
  assert.deepEqual(jobs[0].chapters.map(c=>c.id),['chapter2'])
  const item:ImageItem|null=await page.evaluate((id:string)=>window.baoyi.image.get(id),jobs[0].resourceId)
  assert.equal(item?.pageCount,1)
  assert.equal(item?.sourceId,'rank1')
  assert.deepEqual(item?.chapters.map(c=>c.sourceId),['chapter2'])
  await page.getByRole('button',{name:'返回列表',exact:true}).click()
  await page.getByRole('button',{name:/D30榜单作品/}).waitFor()
  const ownedBadge=page.locator('.source-flag').filter({hasText:'已入库'})
  await ownedBadge.first().waitFor()
  assert.equal(await ownedBadge.count(),1,'已入库的作品必须被标注出来')
  assert.equal(await page.locator('.source-results article').filter({hasText:'D30榜单作品'}).locator('input[type=checkbox]').isDisabled(),true,'已入库的作品不该再被批量勾选')
  await page.getByLabel('全选当前页',{exact:true}).check()
  assert.equal(await page.locator('.source-results article').filter({hasText:'无封面作品'}).locator('input[type=checkbox]').isChecked(),true)
  await page.getByRole('button',{name:'批量下载（1）',exact:true}).click()
  await page.getByRole('status').filter({hasText:'已加入 1 部'}).waitFor()
  await page.waitForFunction(async()=>{const jobs=await window.baoyi.image.jobs();return jobs.some(j=>j.work.id==='rank2'&&j.status==='success')})
  await page.getByRole('button',{name:'我的收藏',exact:true}).click()
  await page.getByLabel('全选当前页',{exact:true}).check()
  await page.getByRole('button',{name:'批量下载（1）',exact:true}).click()
  await page.getByRole('status').filter({hasText:'已加入 1 部'}).waitFor()
  await page.waitForFunction(async()=>{const jobs=await window.baoyi.image.jobs();return jobs.some(j=>j.work.id==='favorite1'&&j.status==='success')})
  await page.getByRole('button',{name:'搜索',exact:true}).click()
  await page.getByLabel('搜索哔咔',{exact:true}).fill('星际')
  await page.getByRole('button',{name:'搜索作品',exact:true}).click()
  await page.getByRole('button',{name:/星际搜索作品/}).waitFor()
  await application.evaluate(()=>{(globalThis as any).__picaFixture.expired=true})
  await page.getByRole('button',{name:'我的收藏',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'登录已过期'}).waitFor()
  await page.getByRole('button',{name:'退出登录',exact:true}).click()
  await page.getByLabel('用户名',{exact:true}).waitFor()
  await assert.rejects(page.evaluate(()=>window.baoyi.image.sourceFavorites(1,'dd')),/请先登录/)
  const calls=await application.evaluate(()=>(globalThis as any).__picaFixture.calls)
  assert.ok(calls.includes('/users/favourite?s=da&page=1'))
  assert.ok(calls.includes('/comics/rank1/order/2/pages?page=1'))
  assert.ok(calls.includes('/media/cover/rank1'))
  assert.ok(calls.includes('/media/page/1'))
  assert.equal(calls.includes('/comics/rank1/order/1/pages?page=1'),false)
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'report'+suffix+'.json'),JSON.stringify({profile,executable,checks:['login','favorites-pagination-sort','rank-periods','cover-and-placeholder','media-cdn-redirects','desktop-and-minimum-window','chapter-selection-download-import','return-list','search','expired-auth-logout'],calls,errors},null,2))
  console.log('PASS 真实 IPC 收藏/榜单/封面、分页排序、选章下载入库、搜索、认证过期及退出登录')
}finally{await application.close()}
