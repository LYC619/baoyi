import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { getDb } from '../services/database.ts'
import { ImageLibrary } from '../kinds/image/library.ts'
import { isArchive, scanImageImport } from '../kinds/image/scanner.ts'
import { imageOperation } from '../kinds/image/activity.ts'
import type { ImageImportPreview, ImagePreferences, ImageType, ScannedImage } from '../../src/types/image.ts'

export function registerImageIpc(getWindow: () => BrowserWindow | null, ipc: Pick<IpcMain,'handle'>): void {
  const library = () => new ImageLibrary(getDb())
  let preview: { token: string; at: number; items: ScannedImage[] } | null = null
  const changed = () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('image:changed') }
  const main = (event: IpcMainInvokeEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许主窗口操作图片库')
  }
  const handle = (name: string, action: (...args: any[]) => unknown) => ipc.handle('image:' + name, (event, ...args) => { main(event); return action(...args) })
  handle('list', query => library().list(query))
  handle('get', id => library().get(id))
  handle('pages', (id, chapter) => library().pages(id, chapter).map(({ id, resourceId, chapterId, ordinal, size, missing }) => ({ id, resourceId, chapterId, ordinal, size, missing })))
  handle('save-chapter', (id, chapterId, title, move) => { library().saveChapter(id, chapterId, title, move); changed() })
  handle('groups', () => library().groups())
  handle('update', (id, patch) => { const item = library().update(id, patch); changed(); return item })
  handle('remove', id => { library().remove(id); changed() })
  handle('save-group', group => { const result = library().saveGroup(group); changed(); return result })
  handle('remove-group', id => { library().removeGroup(id); changed() })
  handle('progress', (id, pageId, offset) => library().saveProgress(id, pageId, offset))
  handle('preferences', (value?: ImagePreferences) => {
    const db = getDb()
    if (value) {
      if (!['single','double','scroll'].includes(value.mode) || !['ltr','rtl'].includes(value.direction) || !['screen','width','original'].includes(value.fit)) throw new Error('阅读设置无效')
      db.prepare("INSERT INTO settings(key,value) VALUES('_image_reader',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value))
    }
    const row = db.prepare("SELECT value FROM settings WHERE key='_image_reader'").get() as { value: string } | undefined
    try { return row ? JSON.parse(row.value) : { mode: 'single', direction: 'ltr', fit: 'screen' } } catch { return { mode: 'single', direction: 'ltr', fit: 'screen' } }
  })
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
