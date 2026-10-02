import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { getDb, getSettings } from '../services/database.ts'
import { imageCollections,saveImageCollection,removeImageCollection } from '../kinds/image/collections.ts'
import { imageFileTarget,planImageMove,moveImageItems,removeImageFiles } from '../kinds/image/management.ts'
import { ImageLibrary } from '../kinds/image/library.ts'
import { isArchive, scanImageImport } from '../kinds/image/scanner.ts'
import { imageOperation } from '../kinds/image/activity.ts'
import { auditImage, imagePageInfo } from '../kinds/image/integrity.ts'
import { ImageReaderState } from '../kinds/image/reader-state.ts'
import type { ImageImportPreview, ImagePreferences, ImageType, ScannedImage } from '../../src/types/image.ts'

export function registerImageIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain,'handle'>): void {
  const library = () => new ImageLibrary(getDb())
  const reader = () => new ImageReaderState(getDb())
  let preview: { token: string; at: number; items: ScannedImage[] } | null = null
  const changed = () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('image:changed') }
  const main = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作图片库')
  }
  const handle = (name: string, action: (...args: any[]) => unknown) => ipc.handle('image:' + name, (event, ...args) => { main(event); return action(...args) })
  handle('list', query => library().list(query))
  handle('get', id => library().get(id))
  handle('page-info', id => imageOperation(() => imagePageInfo(getDb(), id)))
  handle('audit', id => imageOperation(() => auditImage(getDb(), id)))
  handle('pages', (id, chapter) => library().pages(id, chapter).map(({ id, resourceId, chapterId, ordinal, size, missing }) => ({ id, resourceId, chapterId, ordinal, size, missing })))
  handle('save-chapter', (id, chapterId, title, move) => { library().saveChapter(id, chapterId, title, move); changed() })
  handle('groups', () => library().groups())
  handle('update', (id, patch) => { const item = library().update(id, patch); changed(); return item })
  handle('bulk-update', (ids, patch) => { const count = library().bulkUpdate(ids, patch); changed(); return count })
  const protectedPaths=()=>[app.getPath('home'),app.getPath('userData'),app.getPath('documents'),app.getPath('pictures'),app.getPath('videos'),...getSettings().software_scan_dirs,...getSettings().game_scan_dirs,...getSettings().video_scan_dirs]
  handle('collections',()=>imageCollections(getDb()))
  handle('save-collection',(name,members,id)=>{const result=saveImageCollection(getDb(),name,members,id);changed();return result})
  handle('remove-collection',id=>{removeImageCollection(getDb(),id);changed()})
  handle('move',async(ids:string[],byCategory=false)=>{
    const selected=await dialog.showOpenDialog(getWindow()!,{title:'选择整理目标目录',properties:['openDirectory','createDirectory']})
    if(selected.canceled||!selected.filePaths[0])return null
    return imageOperation(async()=>{
      const plan=await planImageMove(getDb(),ids,selected.filePaths[0],byCategory,protectedPaths())
      if(!plan.length)return {moved:0,paths:[],warnings:[]}
      const confirmed=await dialog.showMessageBox(getWindow()!,{type:'question',title:'确认整理和移动',message:`移动 ${plan.length} 个作品目录${byCategory?'，按分类存放':''}`,detail:plan.slice(0,30).map(row=>row.source+'\n→ '+row.destination).join('\n\n')+(plan.length>30?`\n另有 ${plan.length-30} 项`:'')+'\n\n保留全部内容、分类、合集及阅读进度；同名目录不会覆盖。',buttons:['取消','确认移动'],defaultId:0,cancelId:0})
      if(confirmed.response!==1)return null
      const result=await moveImageItems(getDb(),plan,file=>shell.trashItem(file),protectedPaths());changed();return result
    })
  })
  handle('remove', async(id:string,deleteFiles=false) => {
    if(deleteFiles){
      const target=await imageFileTarget(getDb(),id,protectedPaths())
      const confirmed=await dialog.showMessageBox(getWindow()!,{type:'warning',title:'删除原文件及全部内容',message:'将此作品的原文件夹及全部内容送入回收站？',detail:target+'\n\n包含图片、附带文件和子文件夹；同时移除库中记录。',buttons:['取消','删除原文件'],defaultId:0,cancelId:0})
      if(confirmed.response!==1)return false
      await imageOperation(()=>removeImageFiles(getDb(),id,file=>shell.trashItem(file),protectedPaths()))
    }else library().remove(id)
    changed();return true
  })
  handle('save-group', group => { const result = library().saveGroup(group); changed(); return result })
  handle('remove-group', id => { library().removeGroup(id); changed() })
  handle('progress', (id, pageId, offset) => library().saveProgress(id, pageId, offset))
  handle('preferences', (value?: ImagePreferences) => reader().preferences(value))
  handle('reader-preferences', (id: string, value?: ImagePreferences | null) => reader().forWork(id, value))
  handle('bookmarks', (id: string) => reader().bookmarks(id))
  handle('save-bookmark', (id: string, pageId: string, offset: number, label?: string) => reader().saveBookmark(id, pageId, offset, label))
  handle('remove-bookmark', (id: string, bookmarkId: string) => reader().removeBookmark(id, bookmarkId))
  handle('prepare-import', async (type: ImageType, multiple: boolean, archive: boolean): Promise<ImageImportPreview | null> => {
    const result = await dialog.showOpenDialog(getWindow()!, { title: archive ? '选择 ZIP／CBZ' : multiple ? '选择包含多个相册／作品的父目录' : '选择一个相册／漫画目录',
      properties: archive ? ['openFile'] : ['openDirectory'], ...(archive ? { filters: [{ name: '漫画归档', extensions: ['zip','cbz'] }] } : {}) })
    if (result.canceled || !result.filePaths[0]) return null
    return imageOperation(async () => {
      const items = await scanImageImport(result.filePaths[0], type, multiple && !archive)
      preview = { token: randomUUID(), at: Date.now(), items }
      return { token: preview.token, items: items.map((i,index) => ({ index, path: i.path, name: i.name, pages: i.chapters.reduce((n,c) => n+c.pages.length,0), chapters: type === 'comic' ? i.chapters.length : 0, warnings: i.warnings })) }
    })
  })
  handle('confirm-import', (token: string, selected: Array<{ index: number; name: string }>) => {
    if (!preview || token !== preview.token || Date.now() - preview.at > 1800000) throw new Error('导入预览已过期，请重新选择')
    const snapshot = preview; preview = null
    let imported = 0
    const errors: string[] = []
    for (const selection of selected) {
      const item = snapshot.items[selection.index]
      if (!item || !item.chapters.some(c => c.pages.length)) continue
      try { library().register({ ...item, name: selection.name.trim().slice(0,300) || item.name }); imported++ }
      catch (cause) { errors.push(item.name + '：' + (cause as Error).message) }
    }
    changed()
    return { imported, errors }
  })
  handle('rescan', (id: string) => imageOperation(async () => {
    const item = library().get(id)
    if (!item) throw new Error('资源不可用')
    const scanned = (await scanImageImport(item.path, item.type, false))[0]
    if (!scanned.chapters.some(c => c.pages.length)) throw new Error(scanned.warnings.join('；') || '没有找到图片')
    const result = library().register(scanned); changed(); return result
  }))
  handle('relocate', async (id: string) => {
    const item = library().get(id)
    if (!item) throw new Error('资源不可用')
    const result = await dialog.showOpenDialog(getWindow()!, { title: '重新定位相册／漫画', properties: isArchive(item.path) ? ['openFile'] : ['openDirectory'],
      ...(isArchive(item.path) ? { filters: [{ name: '漫画归档', extensions: ['zip','cbz'] }] } : {}) })
    if (result.canceled || !result.filePaths[0]) return null
    return imageOperation(async () => {
      const scanned = (await scanImageImport(result.filePaths[0], item.type, false))[0]
      if (!scanned.chapters.some(c => c.pages.length)) throw new Error('新位置没有可读图片')
      const updated = library().register(scanned, id); changed(); return updated
    })
  })
}
