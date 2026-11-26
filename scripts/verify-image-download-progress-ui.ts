import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { normalizeDownloadProgress } from '../electron/kinds/image/download-progress.ts'
import { randomUUID } from 'node:crypto'
import { comicCatalog, JM_ADAPTER_VERSION } from '../electron/kinds/image/comic-source-rules.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'
import type { ComicIngestJob } from '../src/types/comic-ingest.ts'
import type { ImageDownloadJob } from '../src/types/image.ts'
import { loadPlaywright } from './helpers/playwright.ts'

const { _electron } = loadPlaywright() as any
const output = path.resolve('output/image-optimization/progress-ui' + (process.argv[2] ? '-packaged' : ''))
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, theme: 'dark', hide_hentai: false, hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
const job: ImageDownloadJob = {
  id: randomUUID(), work: { id: 'synthetic', title: '长标题与下载状态验证'.repeat(12), author: 'fixture', description: '', tags: [], chapters: 2, pages: 100, finished: true },
  chapters: [{ id: 'one', title: '第一章', order: 1 }, { id: 'two', title: '第二章', order: 2 }],
  root: profile, groupId: null, status: 'running', processed: 30, total: 100, completedChapters: 0,
  current: '第一章', error: '', createdAt: 100, updatedAt: Date.now(), resourceId: '',
  progress: normalizeDownloadProgress({ phase: 'receiving', totalKnown: true, catalogChapters: 2, chapterIndex: 1, chapterProcessed: 30, chapterTotal: 50, storedBytes: 1024 ** 2, receivedBytes: 1024 ** 2, bytesPerSecond: 128 * 1024 }),
}

const bookDirectory=path.join(profile,'book');fs.mkdirSync(bookDirectory);fs.writeFileSync(path.join(bookDirectory,'1.png'),pngImage(20,30))
const book=new ImageLibrary(db).register((await scanImageImport(bookDirectory,'comic',false))[0])
const catalog=comicCatalog({provider:'jm',workId:'123',name:'JM 合成下载',authors:[],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:'123',title:'第一章',order:1,pageIds:['p1','p2']}]})
const jm:ComicIngestJob={version:2,provider:'jm',id:randomUUID(),workId:'123',name:catalog.name,authors:[],selectedChapters:['123'],catalog,root:profile,directory:'JM 合成下载',groupId:null,operationId:randomUUID(),requestId:randomUUID(),status:'failed',phase:'downloading',processed:1,total:2,completedChapters:0,current:'第一章',error:'合成网络中断',errorCode:'NETWORK',resourceId:'',createdAt:200,updatedAt:200,retryNotBefore:0,requiresRevalidation:false,adapterVersion:catalog.adapterVersion,catalogFingerprint:catalog.catalogFingerprint,manifestDigest:''}
for(const fixture of [{...job,status:'paused',resourceId:book.id},jm])db.prepare('INSERT INTO image_download_jobs(id,status,updated_at,payload) VALUES(?,?,?,?)').run(fixture.id,fixture.status,fixture.updatedAt,JSON.stringify(fixture))
const logRoot=path.join(profile,'comic-logs');fs.mkdirSync(logRoot)
for(const [file,phase] of [['pica-'+job.id,'idle'],[jm.id,'downloading']])fs.writeFileSync(path.join(logRoot,file+'.jsonl'),JSON.stringify({at:1,status:'paused',phase,processed:1,total:2,completedChapters:0,errorCode:''})+'\n')
db.close()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const executable = path.resolve(process.argv[2] || 'node_modules/electron/dist/electron.exe')
const application = await _electron.launch({ executablePath: executable, args: [...(process.argv[2] ? [] : [path.resolve('.')]), '--user-data-dir=' + profile, '--disable-gpu'], env, timeout: 30000 })
try {
  assert.equal(path.resolve(await application.evaluate(({ app }: any) => app.getPath('userData'))), profile)
  const page = await application.firstWindow(); page.setDefaultTimeout(6000)
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.waitForFunction(() => !!window.baoyi?.image)
  await page.getByRole('button', {name:/^图片\s/}).click()
  await page.getByRole('button', {name:'在线漫画',exact:true}).click()
  await page.getByRole('button', {name:'下载任务与记录',exact:true}).click()
  let panel = page.locator('.source-hub .comic-downloads')
  const article=(id:string)=>panel.locator(`article[data-job-id="${id}"]`)
  await article(jm.id).waitFor();await article(job.id).waitFor()
  assert.equal((await page.evaluate(()=>window.baoyi.image.jobs())).length,1)
  assert.equal((await page.evaluate(()=>window.baoyi.comic.jobs())).length,1)
  const rows=await panel.locator('article').allTextContents()
  assert.match(rows[0],/JM 合成下载/)
  await page.getByRole('button',{name:'关闭在线漫画',exact:true}).click()
  await page.locator('.task-trigger').click();await page.locator('.task-tabs button').filter({hasText:'下载记录'}).click()
  await page.getByLabel('下载记录范围',{exact:true}).selectOption('all')
  panel=page.locator('.task-panel__downloads .comic-downloads')
  await article(jm.id).waitFor();assert.deepEqual(await panel.locator('article').allTextContents(),rows)
  await page.getByRole('button',{name:'关闭日志面板',exact:true}).click()
  await page.getByRole('button',{name:'在线漫画',exact:true}).click();await page.getByRole('button',{name:'下载任务与记录',exact:true}).click()
  panel=page.locator('.source-hub .comic-downloads')
  for(const id of [job.id,jm.id]){
    await article(id).getByRole('button',{name:'查看过程',exact:true}).click()
    await page.locator('.comic-log').getByText(/1 \/ 2 页/).waitFor()
    await page.getByRole('button',{name:'关闭对话框',exact:true}).click()
  }
  await application.evaluate(({ ipcMain, BrowserWindow }: any, fixture: any) => {
    const state={pica:[fixture.job],jm:[fixture.jm],calls:[] as any[]};(globalThis as any).__downloadRows=state
    const handle=(name:string,fn:any)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn)}
    handle('image:jobs',()=>state.pica);handle('comic:jobs',()=>state.jm)
    for(const channel of ['image:pause-job','image:cancel-job','image:retry-job','image:resume-job','image:move-job','image:dismiss-job','comic:stop','comic:retry','comic:clean','comic:dismiss'])handle(channel,(_e:any,...args:any[])=>{state.calls.push([channel,...args])})
    handle('comic:defaults',()=>({proxy:{mode:'system'}}))
    handle('comic:preview',(_e:any,...args:any[])=>{state.calls.push(['comic:preview',...args]);return {token:'fixture',catalog:fixture.jm.catalog,directory:fixture.jm.directory,existingId:'',existingChapters:[]}})
    handle('image:download-target',()=>({root:fixture.job.root,locked:false}))
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  }, {job,jm})
  await article(job.id).getByText('正在下载',{exact:true}).waitFor()
  await article(job.id).getByRole('progressbar', { name: '整部页数', exact: true }).waitFor()
  assert.equal(await article(job.id).getByRole('progressbar', { name: '整部页数', exact: true }).getAttribute('max'), '100')
  assert.equal(await article(job.id).getByRole('progressbar', { name: '当前章节页数', exact: true }).getAttribute('max'), '50')
  await panel.getByText('128 KB/s', { exact: true }).waitFor()
  for (const [width, height] of [[1440, 960], [960, 640]]) {
    await application.evaluate(({ BrowserWindow }: any, size: number[]) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
    await panel.scrollIntoViewIfNeeded()
    assert.equal(await article(job.id).evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth), false)
    await page.screenshot({ path: path.join(output, `progress-${width}.png`) })
  }
  await application.evaluate(({ BrowserWindow }: any) => {
    Object.assign((globalThis as any).__downloadRows.pica[0].progress, { phase: 'rate-limited', retryAt: Date.now() + 5000, bytesPerSecond: 0 })
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  })
  await panel.getByText(/等待限流/).waitFor()
  assert.equal(await panel.getByText('128 KB/s', { exact: true }).count(), 0)
  await application.evaluate(({ BrowserWindow }: any) => {
    Object.assign((globalThis as any).__downloadRows.pica[0].progress, { phase: 'catalog', totalKnown: false, catalogChapters: 1 })
    BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')
  })
  await panel.getByText('读取章节目录', { exact: true }).waitFor()
  assert.equal(await article(job.id).getByRole('progressbar', { name: '整部页数', exact: true }).getAttribute('value'), null)
  const mutate=async(provider:'pica'|'jm',patch:any)=>{
    await application.evaluate(({BrowserWindow}:any,{provider,patch}:any)=>{Object.assign((globalThis as any).__downloadRows[provider][0],patch);BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')},{provider,patch})
  }
  const calls=()=>application.evaluate(()=>(globalThis as any).__downloadRows.calls)
  const click=async(id:string,label:string,expected:any[])=>{
    await article(id).getByRole('button',{name:label,exact:true}).click()
    const until=Date.now()+5000
    while(JSON.stringify((await calls()).at(-1))!==JSON.stringify(expected)&&Date.now()<until)await page.waitForTimeout(30)
    assert.deepEqual((await calls()).at(-1),expected)
  }
  await click(job.id,'暂停下载',['image:pause-job',job.id]);await click(job.id,'停止下载',['image:cancel-job',job.id])
  await mutate('pica',{status:'paused'});await click(job.id,'继续下载',['image:resume-job',job.id]);await click(job.id,'移除记录',['image:dismiss-job',job.id])
  await mutate('pica',{status:'failed',retryNotBefore:0,progress:{...job.progress,retryAt:0}});await click(job.id,'重试剩余页',['image:retry-job',job.id])
  await application.evaluate(({BrowserWindow}:any)=>{const state=(globalThis as any).__downloadRows;state.pica[0].status='queued';state.pica[0].queuePosition=2;state.pica.push({...state.pica[0],id:'other-a',createdAt:1,queuePosition:1},{...state.pica[0],id:'other-b',createdAt:2,queuePosition:3});BrowserWindow.getAllWindows()[0].webContents.send('image:jobs-changed')})
  await click(job.id,'上移任务',['image:move-job',job.id,'up']);await click(job.id,'下移任务',['image:move-job',job.id,'down'])
  await article(job.id).getByText(/排队第 2/).waitFor()
  await click(jm.id,'重试剩余页',['comic:retry',jm.id,undefined])
  await article(jm.id).getByRole('button',{name:'更换连接方式',exact:true}).click()
  await article(jm.id).getByLabel('重试连接方式').selectOption('custom');await article(jm.id).getByLabel('重试代理地址').fill('127.0.0.1:7891')
  await click(jm.id,'保存并重试',['comic:retry',jm.id,{mode:'custom',url:'127.0.0.1:7891'}])
  const before=(await calls()).length
  await article(jm.id).getByRole('button',{name:'停止并清理暂存',exact:true}).click();await page.locator('.app-dialog [data-dialog-cancel]').click()
  assert.equal((await calls()).length,before)
  await article(jm.id).getByRole('button',{name:'停止并清理暂存',exact:true}).click();await page.locator('.app-dialog [data-dialog-confirm]').click();assert.deepEqual((await calls()).at(-1),['comic:clean',jm.id])
  await click(jm.id,'移除记录',['comic:dismiss',jm.id])
  await mutate('jm',{status:'running'});await click(jm.id,'暂停下载',['comic:stop',jm.id,false]);await click(jm.id,'停止下载',['comic:stop',jm.id,true])
  await mutate('jm',{status:'failed',requiresRevalidation:true})
  await article(jm.id).getByRole('button',{name:'重新核验',exact:true}).click()
  const input=page.getByLabel('作品编号或链接',{exact:true});await input.waitFor();assert.equal(await input.inputValue(),'123')
  await page.getByRole('button',{name:'解析作品',exact:true}).click()
  await page.getByRole('heading',{name:catalog.name,exact:true}).waitFor()
  assert.equal((await calls()).at(-1)[0],'comic:preview')
  await page.getByRole('button',{name:'关闭在线漫画',exact:true}).click()
  await mutate('pica',{status:'success',resourceId:book.id});await page.locator('.task-trigger').click();await page.locator('.task-tabs button').filter({hasText:'下载记录'}).click();await page.getByLabel('下载记录范围',{exact:true}).selectOption('all')
  panel=page.locator('.task-panel__downloads .comic-downloads')
  await article(job.id).getByRole('button',{name:'打开作品',exact:true}).click()
  await page.getByRole('button',{name:'关闭日志面板',exact:true}).click()
  await page.getByRole('button',{name:'开始阅读',exact:true}).waitFor()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ profile, executable, checks: ['database-seeded-two-providers', 'same-list-in-task-center-and-online-comic', 'real-log-ipc-both-providers', 'all-provider-actions-ipc', 'clean-confirmation', 'revalidation', 'open-local-work', 'job-progress', 'chapter-progress', 'speed', 'task-only-event', 'rate-limited', 'indeterminate-catalog', 'long-title', '1440x960', '960x640'], errors }, null, 2))
  console.log('PASS 下载进度 UI、速率、独立任务通知、限流状态和长标题窄窗口')
} catch (error) {
  const page = await application.firstWindow()
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally { await application.close() }
