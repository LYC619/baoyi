import { app, dialog, safeStorage, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../services/database.ts'
import { PicacomicSource } from '../kinds/image/source.ts'
import { createImageSourceFetch } from '../kinds/image/network.ts'
import { createImageDownloads } from '../kinds/image/downloads.ts'
import { imageOperation } from '../kinds/image/activity.ts'
import { createImageUpdates } from '../kinds/image/updates.ts'

export function registerImageSourceIpc(getWindow:()=>BrowserWindow|null,ipc:Pick<IpcMain,'handle'>):void{
  const credentialFile=path.join(app.getPath('userData'),'pica-auth.bin')
  let token=''
  try{if(safeStorage.isEncryptionAvailable()&&fs.existsSync(credentialFile))token=safeStorage.decryptString(fs.readFileSync(credentialFile))}catch{/* A moved profile requires a new login on this machine. */}
  const source=new PicacomicSource({fetch:createImageSourceFetch(),token:()=>token})
  const changed=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('image:changed')}
  const jobsChanged=()=>{const win=getWindow();if(win&&!win.isDestroyed())win.webContents.send('image:jobs-changed')}
  const queue=createImageDownloads({db:getDb(),source,changed,jobsChanged})
  const updates=createImageUpdates({db:getDb(),source,queue})
  function handle(name:string,fn:(...args:any[])=>unknown){ipc.handle('image:'+name,(event:IpcMainInvokeEvent,...args)=>{const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('只允许主窗口操作图片来源');return fn(...args)})}
  handle('source-status',()=>!!token)
  handle('repair',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>queue.repair(id))})
  handle('check-updates',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>updates.check(id))})
  handle('download-updates',(id:string,chapters:string[])=>{if(!token)throw new Error('请先登录哔咔');return imageOperation(()=>updates.download(id,chapters))})
  handle('source-login',async(account:string,password:string)=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('系统加密服务不可用，无法安全保存登录状态')
    const next=await source.login(account,password),encrypted=safeStorage.encryptString(next),temporary=credentialFile+'.tmp'
    fs.writeFileSync(temporary,encrypted);fs.renameSync(temporary,credentialFile);token=next
  })
  handle('source-logout',()=>{token='';if(fs.existsSync(credentialFile))fs.unlinkSync(credentialFile)})
  handle('source-search',(query:string,page:number)=>{if(!token)throw new Error('请先登录哔咔');return source.search(query,page)})
  handle('source-favorites',(page,sort)=>{if(!token)throw new Error('请先登录哔咔');return source.favorites(page,sort)})
  handle('source-ranking',period=>{if(!token)throw new Error('请先登录哔咔');return source.ranking(period)})
  handle('source-cover',url=>{if(!token)throw new Error('请先登录哔咔');return source.cover(url)})
  handle('source-detail',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return source.detail(id)})
  handle('download',async(workId:string,selected:string[],groupId:string|null)=>{
    if(!token)throw new Error('请先登录哔咔')
    const {work,chapters}=await source.detail(workId),chosen=chapters.filter(c=>selected.includes(c.id))
    if(!chosen.length)throw new Error('请选择有效章节')
    const result=await dialog.showOpenDialog(getWindow()!,{title:'选择漫画下载根目录（补章请选择原根目录）',properties:['openDirectory','createDirectory']})
    if(result.canceled||!result.filePaths[0])return null
    return queue.enqueue(work,chosen,result.filePaths[0],groupId)
  })
  handle('jobs',()=>queue.list());handle('retry-job',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return queue.retry(id)});handle('cancel-job',(id:string)=>queue.cancel(id));handle('dismiss-job',(id:string)=>queue.dismiss(id))
  handle('pause-job',(id:string)=>queue.pause(id))
  handle('resume-job',(id:string)=>{if(!token)throw new Error('请先登录哔咔');return queue.resume(id)})
  handle('move-job',(id:string,direction:'up'|'down')=>queue.move(id,direction))
  handle('download-options',value=>queue.options(value))
}
