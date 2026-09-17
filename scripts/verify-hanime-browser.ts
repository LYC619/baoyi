import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { isHanimeHost } from '../electron/services/hanime-network-rules.ts'

let passed=0, failed=0
function harness() {
  const session = new EventEmitter(), sent: unknown[][] = [], windows: FakeWindow[]=[]
  let hidden=false
  class Contents extends EventEmitter {
    url=''; destroyed=false; popup:any; navigationHistory={canGoBack:()=>false,canGoForward:()=>false,goBack:()=>{},goForward:()=>{}}
    getURL(){return this.url} isDestroyed(){return this.destroyed} setUserAgent(){} setWindowOpenHandler(fn:any){this.popup=fn}
    async loadURL(url:string){this.url=url;this.emit('did-navigate',{},url);return undefined} reload(){} send(...args:unknown[]){sent.push(args)}
  }
  class FakeWindow extends EventEmitter {
    webContents=new Contents(); destroyed=false; menu:any; options:any; focuses=0
    constructor(options:any){super();this.options=options;windows.push(this)}
    isDestroyed(){return this.destroyed} isMinimized(){return false} restore(){} show(){} focus(){this.focuses++} setTitle(){} setMenu(menu:any){this.menu=menu} setMenuBarVisibility(){}
    loadURL(url:string){return this.webContents.loadURL(url)} close(){this.destroyed=true;this.webContents.destroyed=true;this.emit('closed')}
  }
  const main=new FakeWindow({})
  const load=createRendererLoader({electron:{BrowserWindow:FakeWindow,Menu:{buildFromTemplate:(items:unknown[])=>({items})},clipboard:{writeText:()=>{}}}}, {URL,Buffer,setTimeout,clearTimeout})
  const module=load('electron/services/hanime-browser.ts') as typeof import('../electron/services/hanime-browser.ts')
  const browser=module.createHanimeBrowser({getSession:()=>session as any,getMainWindow:()=>main as any,isHidden:()=>hidden})
  return {browser,main,session,windows,sent,hide:()=>{hidden=true}}
}
async function test(name:string,run:(h:ReturnType<typeof harness>)=>void|Promise<void>){
  let h:ReturnType<typeof harness>|undefined
  try{h=harness();await run(h);passed++}catch(e){failed++;console.error('FAIL '+name+': '+(e instanceof Error?e.message:e))}finally{h?.browser.close()}
}
await test('browser uses the verified session without exposing application preload',h=>{
  h.browser.open();const win=h.windows.at(-1)!
  assert.equal(win.options.webPreferences.session,h.session)
  assert.equal(win.options.webPreferences.preload,undefined)
  assert.equal(win.options.webPreferences.nodeIntegration,false)
  assert.equal(win.options.webPreferences.sandbox,true)
  assert.equal(isHanimeHost(new URL(win.webContents.url).hostname),true)
  win.webContents.emit('did-finish-load');assert.equal(win.destroyed,false)
  h.browser.open();assert.equal(h.windows.length,2)
})
await test('download sends only the current validated watch page to the main window',async h=>{
  h.browser.open();const win=h.windows.at(-1)!
  assert.equal(win.menu.items.find((i:any)=>i.label==='下载当前视频').enabled,false)
  await win.loadURL('https://hanime1.me/watch?v=800001')
  const download=win.menu.items.find((i:any)=>i.label==='下载当前视频');assert.equal(download.enabled,true);download.click()
  assert.deepEqual(h.sent,[['hanime-browser:download','https://hanime1.me/watch?v=800001']])
})
await test('foreign pages and popups cannot become privileged or downloadable',h=>{
  assert.throws(()=>h.browser.open('https://example.com/watch?v=800001'),/Hanime|站点/)
  h.browser.open();const win=h.windows.at(-1)!
  let stopped=false;win.webContents.emit('will-navigate',{preventDefault:()=>{stopped=true}},'file:///C:/Windows/win.ini');assert.equal(stopped,true)
  assert.equal(win.webContents.popup({url:'https://example.com'}).action,'deny')
  assert.equal(win.webContents.popup({url:'https://hanime1.me/watch?v=800002'}).action,'deny')
  assert.match(win.webContents.url,/800002/)
})
await test('privacy and parent window closure end the browser session window',h=>{
  h.hide();assert.throws(()=>h.browser.open(),/隐藏/)
})
await test('closing the main window closes the site window and releases session listeners',h=>{
  h.browser.open();const win=h.windows.at(-1)!;h.main.close();assert.equal(win.destroyed,true)
  assert.equal(h.session.listenerCount('will-download'),0)
})
console.log(`Hanime browser: ${passed} passed / ${failed} failed`);process.exitCode=failed?1:0
