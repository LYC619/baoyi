/** Native Electron IPC/session acceptance with a local source; --live additionally probes JAVDB. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
const output=path.resolve('output/release-0.17.5/online-native');await fs.mkdir(output,{recursive:true})
const profile=await fs.mkdtemp(path.join(output,'profile-'));const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
for(const [key,value] of Object.entries({onboarded:true,hanime_builtin_hosts:false,video_online_proxy:'',ai:{enabled:false,api_key:'',api_url:'',model:''}}))db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));db.close()
const requests:Array<{url:string;cookie:boolean;ua:string}>=[]
let failDetail=false
const server=http.createServer((req,res)=>{
 const cookie=(req.headers.cookie||'').includes('fixture=verified');requests.push({url:req.url||'',cookie,ua:req.headers['user-agent']||''})
 if(req.url==='/film' && (!cookie||failDetail)){res.writeHead(403,{'Content-Type':'text/html'});res.end('Forbidden');return}
 if(req.headers['sec-fetch-mode']==='navigate')res.setHeader('Set-Cookie','fixture=verified; Path=/; HttpOnly; SameSite=Lax')
 res.setHeader('Content-Type','text/html');res.end('<title>验收来源</title><script type="application/ld+json">'+JSON.stringify({'@type':'VideoObject',name:'隔离视频',url:'/film',description:req.url==='/film'?'详情已更新':'列表缓存'})+'</script>')
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const base='http://127.0.0.1:'+(server.address() as any).port
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const executable=process.env.BAOYI_TEST_EXE||path.resolve('node_modules/electron/dist/electron.exe')
const app=await _electron.launch({executablePath:executable,args:[...(process.env.BAOYI_TEST_EXE?[]:[path.resolve('.')]),'--user-data-dir='+profile,'--disable-gpu'],env,timeout:30000})
const page=await app.firstWindow();const checks:string[]=[],live:any[]=[]
try{
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),profile)
 await page.waitForFunction(()=>!!window.baoyi?.video?.discovery)
 const source=await page.evaluate(url=>window.baoyi.video.discovery.online.connect(url),base+'/list')
 const cards=await page.evaluate(id=>window.baoyi.video.discovery.entries(id),source.id);assert.equal(cards.length,1)
 const selection={sourceId:source.id,entryId:cards[0].entry.id}
 await assert.rejects(page.evaluate(selection=>window.baoyi.video.discovery.online.detail(selection),selection),/403/)
 await page.evaluate(id=>window.baoyi.video.discovery.open(id),source.id)
 await page.waitForFunction(()=>true)
 const deadline=Date.now()+10000
 while(!await app.evaluate(async({session})=>(await session.fromPartition('persist:video-discovery').cookies.get({name:'fixture'})).length>0)){
  if(Date.now()>deadline)throw new Error('source window failed to set cookie');await new Promise(resolve=>setTimeout(resolve,100))
 }
 const enriched=await page.evaluate(selection=>window.baoyi.video.discovery.online.detail(selection),selection);assert.equal(enriched.entry.description,'详情已更新')
 failDetail=true;await assert.rejects(page.evaluate(selection=>window.baoyi.video.discovery.online.detail(selection),selection),/403/)
 const cached=await page.evaluate(id=>window.baoyi.video.discovery.entries(id),source.id);assert.equal(cached[0].entry.description,'详情已更新')
 assert.ok(requests.some(r=>r.url==='/film'&&r.cookie));assert.ok(requests.every(r=>!r.ua.includes('Electron/')))
 checks.push('real-ipc-fetch-browser-cookie-sharing','http-failure-keeps-enriched-cache','same-browser-user-agent')
 await page.evaluate(()=>window.baoyi.settings.patch({video_online_proxy:'http://127.0.0.1:19876'}))
 const route=await page.evaluate(()=>window.baoyi.video.discovery.online.networkStatus('https://example.org/'));assert.match(route.resolved,/127\.0\.0\.1:19876/)
 const separate=await app.evaluate(({session})=>session.fromPartition('persist:general-web-browser').resolveProxy('https://example.org/'));assert.match(separate,/127\.0\.0\.1:19876/)
 checks.push('native-proxy-change-applies-to-both-online-sessions')
 if(process.argv.includes('--live')){
  for(const rule of ['system://','']){
   await page.evaluate(rule=>window.baoyi.settings.patch({video_online_proxy:rule}),rule)
   const target='https://javdb.com/search?q=ssis-001&f=all'
   const route=await page.evaluate(url=>window.baoyi.video.discovery.online.networkStatus(url),target)
   try{const source=await page.evaluate(url=>window.baoyi.video.discovery.online.connect(url),target);const entries=await page.evaluate(id=>window.baoyi.video.discovery.entries(id),source.id);const row:any={rule,route:route.resolved,list:'passed',count:entries.length};if(entries.length){try{await page.evaluate(selection=>window.baoyi.video.discovery.online.detail(selection),{sourceId:source.id,entryId:entries[0].entry.id});row.detail='passed'}catch(error){row.detail=String(error)}}live.push(row)}catch(error){live.push({rule,route:route.resolved,error:String(error)})}
  }
 }
 const report={status:'passed',executable,profile,checks,live};await fs.writeFile(path.join(output,process.env.BAOYI_TEST_EXE?'packaged.json':'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await app.close().catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
