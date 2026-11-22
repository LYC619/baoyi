import fs from 'node:fs/promises'
import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { getDb } from '../services/storage/database.ts'
import { getSettings } from '../services/storage/settings-store.ts'
import { imageCollections,saveImageCollection,removeImageCollection } from '../kinds/image/collections.ts'
import { assertImageFilesIdle,imageFileTarget,planImageMove,moveImageItems,removeImageFiles,rememberedImageDirectory } from '../kinds/image/management.ts'
import { ImageLibrary } from '../kinds/image/library.ts'
import { imageTagCounts, renameImageTag } from '../kinds/image/tags.ts'
import { isArchive, scanImageImport } from '../kinds/image/scanner.ts'
import { imageOperation } from '../kinds/image/activity.ts'
import { auditImage, imagePageInfo } from '../kinds/image/integrity.ts'
import { ImageReaderState } from '../kinds/image/reader-state.ts'
import { restoreWindowFocus } from '../services/system/window-focus.ts'
import type { ImageImportPreview, ImagePreferences, ImageType, ScannedImage } from '../../src/types/image.ts'
import { optBool, optId, optNumber, optRecord, optString, optStringArray, reqArray, reqBool, reqEnum, reqId, reqNumber, reqRecord, reqString, reqStringArray } from './validate.ts'

export function registerImageIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain,'handle'>): void {
  const library = () => new ImageLibrary(getDb())
  const reader = () => new ImageReaderState(getDb())
  let preview: { token: string; at: number; items: ScannedImage[] } | null = null
  const changed = () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('image:changed') }
  const focusBack = () => restoreWindowFocus(getWindow())
  const main = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作图片库')
  }
  const handle = (name: string, action: (...args: any[]) => unknown) => ipc.handle('image:' + name, (event, ...args) => { main(event); return action(...args) })
  handle('list', query => library().list(optRecord(query, 'query') as any))
  handle('get', id => library().get(reqId(id)))
  handle('gallery', (ids,offset,limit) => library().gallery(reqStringArray(ids,'ids',{max:5000}),optNumber(offset,'offset',{min:0,integer:true}),optNumber(limit,'limit',{min:1,max:5000,integer:true})))
  handle('reveal', async (id: string) => {
    id = reqId(id)
    const item = library().get(id)
    if (!item?.path || !existsSync(item.path)) return false
    try { if (!isArchive(item.path) && statSync(item.path).isDirectory()) { if (await shell.openPath(item.path)) return false } else shell.showItemInFolder(item.path) }
    catch { return false }
    focusBack()
    return true
  })
  handle('page-info', id => imageOperation(() => imagePageInfo(getDb(), reqId(id))))
  handle('audit', id => imageOperation(() => auditImage(getDb(), reqId(id))))
  handle('pages', (id, chapter) => library().pages(reqId(id), optString(chapter, 'chapter', { max: 256 })).map(({ id, resourceId, chapterId, ordinal, size, missing }) => ({ id, resourceId, chapterId, ordinal, size, missing })))
  handle('save-chapter', (id, chapterId, title, move) => { library().saveChapter(reqId(id), reqId(chapterId, 'chapterId'), reqString(title, 'title', { max: 300 }), reqNumber(move, 'move', { integer: true, min: -10000, max: 10000 })); changed() })
  handle('groups', () => library().groups())
  handle('tag-counts', () => imageTagCounts(getDb()))
  handle('rename-tag', (from: string, to: string | null) => { const count = renameImageTag(getDb(), reqString(from, 'from', { max: 200 }), to === null ? null : reqString(to, 'to', { max: 200 })); changed(); return count })
  handle('update', (id, patch) => { const item = library().update(reqId(id), reqRecord(patch, 'patch') as any); changed(); return item })
  handle('bulk-update', (ids, patch) => { const count = library().bulkUpdate(reqStringArray(ids, 'ids', { min: 1, max: 5000 }), reqRecord(patch, 'patch') as any); changed(); return count })
  const safePath=(name:Parameters<typeof app.getPath>[0])=>{try{return app.getPath(name)}catch{return ''}}
  const protectedPaths=()=>[safePath('home'),safePath('userData'),safePath('documents'),safePath('pictures'),safePath('videos'),...getSettings(getDb()).software_scan_dirs,...getSettings(getDb()).game_scan_dirs,...getSettings(getDb()).video_scan_dirs].filter(Boolean)
  handle('collections',()=>imageCollections(getDb()))
  handle('save-collection',(name,members,id)=>{const result=saveImageCollection(getDb(),reqString(name,'name',{max:200}),reqStringArray(members,'members',{max:5000}),optId(id));changed();return result})
  handle('remove-collection',id=>{removeImageCollection(getDb(),reqId(id));changed()})
  handle('move',async(ids:string[],byCategory=false,chooseTarget=false)=>{
    if(Array.isArray(ids)&&ids.length===0)throw new Error('请选择需要整理的作品')
    ids=reqStringArray(ids,'ids',{min:1,max:5000})
    byCategory=optBool(byCategory,'byCategory')??false
    chooseTarget=optBool(chooseTarget,'chooseTarget')??false
    let root=''
    if(chooseTarget || !byCategory || ids.some(id=>!rememberedImageDirectory(getDb(),library().get(id)?.groupId||null))){
      const selected=await dialog.showOpenDialog(getWindow()!,{title:'选择整理目标目录',properties:['openDirectory','createDirectory']})
      focusBack()
      if(selected.canceled||!selected.filePaths[0])return null
      root=selected.filePaths[0]
    }
    return imageOperation(async()=>{
      const plan=await planImageMove(getDb(),ids,root,byCategory,protectedPaths())
      if(!plan.length)return {moved:0,paths:[],warnings:[]}
      const confirmed=await dialog.showMessageBox(getWindow()!,{type:'question',title:'确认整理和移动',message:`移动 ${plan.length} 个作品目录${byCategory?'，按分类存放':''}`,detail:plan.slice(0,30).map(row=>row.source+'\n→ '+row.destination).join('\n\n')+(plan.length>30?`\n另有 ${plan.length-30} 项`:'')+'\n\n保留全部内容、分类、合集及阅读进度；同名目录不会覆盖。',buttons:['取消','确认移动'],defaultId:0,cancelId:0})
      focusBack()
      if(confirmed.response!==1)return null
      const result=await moveImageItems(getDb(),plan,file=>shell.trashItem(file),protectedPaths());changed();return result
    })
  })
  handle('remove', async(id:string,deleteFiles=false) => {
    id = reqId(id); deleteFiles = optBool(deleteFiles, 'deleteFiles') ?? false
    assertImageFilesIdle(id)
    if(deleteFiles){
      const target=await imageFileTarget(getDb(),id,protectedPaths())
      const confirmed=await dialog.showMessageBox(getWindow()!,{type:'warning',title:'删除原文件及全部内容',message:'将此作品的原文件夹及全部内容送入回收站？',detail:target+'\n\n包含图片、附带文件和子文件夹；同时移除库中记录。',buttons:['取消','删除原文件'],defaultId:0,cancelId:0})
      focusBack()
      if(confirmed.response!==1)return false
      await imageOperation(()=>removeImageFiles(getDb(),id,file=>shell.trashItem(file),protectedPaths()))
    }else library().remove(id)
    changed();return true
  })
  handle('save-group', group => { const result = library().saveGroup(reqRecord(group, 'group') as any); changed(); return result })
  handle('remove-group', id => { library().removeGroup(reqId(id)); changed() })
  handle('progress', (id, pageId, offset) => library().saveProgress(reqId(id), reqId(pageId, 'pageId'), reqNumber(offset, 'offset', { min: 0 })))
  handle('preferences', (value?: ImagePreferences) => reader().preferences(optRecord(value, 'value') as ImagePreferences | undefined))
  handle('reader-preferences', (id: string, value?: ImagePreferences | null) => reader().forWork(reqId(id), value === null ? null : optRecord(value, 'value') as ImagePreferences | undefined))
  handle('bookmarks', (id: string) => reader().bookmarks(reqId(id)))
  handle('save-bookmark', (id: string, pageId: string, offset: number, label?: string) => reader().saveBookmark(reqId(id), reqId(pageId, 'pageId'), reqNumber(offset, 'offset', { min: 0 }), optString(label, 'label', { max: 200 })))
  handle('remove-bookmark', (id: string, bookmarkId: string) => reader().removeBookmark(reqId(id), reqId(bookmarkId, 'bookmarkId')))
  handle('prepare-import', async (type: ImageType, multiple: boolean, archive: boolean, droppedPaths?: string[]): Promise<ImageImportPreview | null> => {
    type = reqEnum(type, ['photo', 'comic', 'misc'] as const, 'type'); multiple = reqBool(multiple, 'multiple'); archive = reqBool(archive, 'archive')
    const provided = optStringArray(droppedPaths, 'droppedPaths', { max: 500 })
    let targets: string[]
    if (provided && provided.length > 0) {
      for (const p of provided) {
        if (!path.isAbsolute(p)) throw new Error('仅支持拖入本地文件夹或归档文件')
        const st = await fs.lstat(p).catch(() => null)
        if (!st) throw new Error('未找到拖入的文件夹或归档文件')
        if (st.isSymbolicLink()) throw new Error('暂不支持直接导入符号链接，请拖入实际文件夹或归档包')
        if (!st.isDirectory() && !/\.(zip|cbz)$/i.test(p)) {
          throw new Error('请拖入相册或漫画文件夹，或 ZIP／CBZ 归档包；单张图片请放入文件夹后导入')
        }
      }
      targets = provided
    } else {
      const result = await dialog.showOpenDialog(getWindow()!, { title: archive ? '选择 ZIP／CBZ' : multiple ? '选择包含多个相册／作品的父目录' : '选择一个相册／漫画目录',
        properties: archive ? ['openFile'] : ['openDirectory'], ...(archive ? { filters: [{ name: '漫画归档', extensions: ['zip','cbz'] }] } : {}) })
      focusBack()
      if (result.canceled || !result.filePaths[0]) return null
      targets = [result.filePaths[0]]
    }
    return imageOperation(async () => {
      const items = []
      for (const t of targets) {
        const isZip = /\.(zip|cbz)$/i.test(t)
        items.push(...(await scanImageImport(t, type, multiple && !archive && !isZip)))
      }
      preview = { token: randomUUID(), at: Date.now(), items }
      return { token: preview.token, items: items.map((i,index) => ({ index, path: i.path, name: i.name, pages: i.chapters.reduce((n,c) => n+c.pages.length,0), chapters: type === 'comic' ? i.chapters.length : 0, warnings: i.warnings })) }
    })
  })
  handle('confirm-import', (token: string, selected: Array<{ index: number; name: string }>, folderCategories=false) => {
    token = reqString(token, 'token', { max: 256 }); selected = reqArray(selected, 'selected', { max: 5000 }); folderCategories = optBool(folderCategories, 'folderCategories') ?? false
    if (!preview || token !== preview.token || Date.now() - preview.at > 1800000) throw new Error('导入预览已过期，请重新选择')
    const snapshot = preview; preview = null
    let imported = 0
    const errors: string[] = []
    for (const selection of selected) {
      const item = snapshot.items[selection.index]
      if (!item || !item.chapters.some(c => c.pages.length)) continue
      getDb().exec('SAVEPOINT image_import_item')
      try {
        const lib=library(), registered=lib.register({ ...item, name: selection.name.trim().slice(0,300) || item.name })
        if(folderCategories && item.type!=='comic' && !registered.groupId){
          const name=path.basename(item.path).slice(0,80)
          const group=lib.groups().find(g=>g.type===item.type&&g.name===name)||lib.saveGroup({name,type:item.type,directory:isArchive(item.path)?path.dirname(item.path):item.path})
          lib.update(registered.id,{groupId:group.id})
        }
        getDb().exec('RELEASE image_import_item');imported++
      }
      catch (cause) { getDb().exec('ROLLBACK TO image_import_item; RELEASE image_import_item');errors.push(item.name + '：' + (cause as Error).message) }
    }
    changed()
    return { imported, errors }
  })
  handle('rescan', (id: string) => imageOperation(async () => {
    id = reqId(id)
    assertImageFilesIdle(id)
    const item = library().get(id)
    if (!item) throw new Error('资源不可用')
    const scanned = (await scanImageImport(item.path, item.type, false))[0]
    assertImageFilesIdle(id)
    if(library().get(id)?.path!==item.path)throw new Error('作品位置已改变，请重新扫描')
    if (!scanned.chapters.some(c => c.pages.length)) throw new Error(scanned.warnings.join('；') || '没有找到图片')
    const result = library().register(scanned); changed(); return result
  }))
  handle('relocate', async (id: string) => {
    id = reqId(id)
    assertImageFilesIdle(id)
    const item = library().get(id)
    if (!item) throw new Error('资源不可用')
    const result = await dialog.showOpenDialog(getWindow()!, { title: '重新定位相册／漫画', properties: isArchive(item.path) ? ['openFile'] : ['openDirectory'],
      ...(isArchive(item.path) ? { filters: [{ name: '漫画归档', extensions: ['zip','cbz'] }] } : {}) })
    focusBack()
    if (result.canceled || !result.filePaths[0]) return null
    return imageOperation(async () => {
      const scanned = (await scanImageImport(result.filePaths[0], item.type, false))[0]
      assertImageFilesIdle(id)
      if(library().get(id)?.path!==item.path)throw new Error('作品位置已改变，请重新定位')
      if (!scanned.chapters.some(c => c.pages.length)) throw new Error('新位置没有可读图片')
      const updated = library().register(scanned, id); changed(); return updated
    })
  })
}
