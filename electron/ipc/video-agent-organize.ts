import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getDb, getSettings } from '../services/database.ts'
import { runAgent } from '../services/agent/loop.ts'
import { createVideoAgentOrganizer } from '../kinds/video/agent-organize.ts'
import { enrichVideoWithAgent } from '../kinds/video/service.ts'
import type { VideoAgentActions } from '../../src/types/video-agent-organize.ts'
import { cloneVideoDatabase } from '../kinds/video/snapshot.ts'
let running: (() => boolean) | undefined
export const videoAgentOrganizationBusy = () => running?.() || false
export function registerVideoAgentOrganizeIpc(getWindow: () => BrowserWindow | null, ipcMain: Pick<Electron.IpcMain, 'handle'>) {
  let manager: ReturnType<typeof createVideoAgentOrganizer> | undefined, db: ReturnType<typeof getDb> | undefined
  function current() {
    const live = getDb()
    if (!manager || db !== live) {
      db = live
      manager = createVideoAgentOrganizer({ db: live, config: () => getSettings().ai, root: () => getSettings().video_organize_root || '', runAgent,
        enrich: async (id, actions, signal, report) => { const scratch = cloneVideoDatabase(live)
          try { return await enrichVideoWithAgent(id, actions, scratch, signal, report) } finally { scratch.close() } },
        progress: progress => { const win = getWindow(); if (win && !win.isDestroyed() && !getSettings().hide_hentai) win.webContents.send('video-agent:progress', progress) },
        changed: id => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('video:library-changed', id) } })
      running = manager.busy
    }
    return manager
  }
  function guard(event: IpcMainInvokeEvent, ids: string[] = []) {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许主窗口操作 Agent 整理')
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('作品范围无效')
    if (getSettings().hide_hentai && ids.some(id => (getDb().prepare('SELECT category FROM resource WHERE id=?').get(id) as { category: string } | undefined)?.category === '里番')) throw new Error('所选作品包含隐藏内容，请调整显示设置')
  }
  ipcMain.handle('video-agent:prepare', (event, ids: string[], actions: VideoAgentActions) => { guard(event, ids); return current().prepare(ids, actions) })
  ipcMain.handle('video-agent:run', (event, id: string, groups: string[]) => { guard(event, current().get(id)?.works.map(work => work.id) || []); return current().run(id, groups) })
  ipcMain.handle('video-agent:cancel', event => { guard(event); return current().cancel() })
}
