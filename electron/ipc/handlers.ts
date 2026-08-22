import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AIConfig,
  AppSettings,
  Category,
  IdentifyLogQuery,
  PendingItem,
  SearchConfig,
  SoftwareItem,
  SoftwareQuery
} from '../../src/types'
import { cancelAi, completeWithAi, testConnection } from '../services/aiService'
import {
  clearIdentifyLogs,
  clearSkipped,
  confirmPending,
  countPending,
  countSkipped,
  counts,
  createTag,
  dataStats,
  deleteSoftware,
  exportAll,
  getSettings,
  getSoftware,
  listCategories,
  listIdentifyLogs,
  listPending,
  listScanUnits,
  listSoftware,
  listTags,
  mergeTags,
  moveCategory,
  patchSettings,
  removeCategory,
  removeTag,
  renameTag,
  resetData,
  resetScanUnit,
  resetScanUnits,
  skipPending,
  updatePending,
  updateSoftware,
  upsertCategory
} from '../services/database'
import { launchSoftware, revealInFolder } from '../services/launcher'
import { addSingleExe, cancelScan, scanDirectories } from '../services/scanner'
import { testSearch } from '../services/searchService'

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /* ------------------------------ 应用 ------------------------------ */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }))

  /* ------------------------------ 窗口 ------------------------------ */
  ipcMain.on('win:minimize', () => getWindow()?.minimize())
  ipcMain.on('win:toggle-maximize', () => {
    const win = getWindow()
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', () => getWindow()?.close())
  ipcMain.handle('win:is-maximized', () => getWindow()?.isMaximized() ?? false)

  /* ------------------------------ 软件 ------------------------------ */
  ipcMain.handle('software:list', (_e, query: SoftwareQuery = {}) => listSoftware(query))
  ipcMain.handle('software:get', (_e, id: string) => getSoftware(id))
  ipcMain.handle('software:update', (_e, id: string, patch: Partial<SoftwareItem>) =>
    updateSoftware(id, patch)
  )
  ipcMain.handle('software:remove', (_e, id: string) => deleteSoftware(id))
  ipcMain.handle('software:counts', (_e, unusedDays: number) => counts(unusedDays))
  ipcMain.handle('software:launch', (_e, id: string, launcherPath?: string) =>
    launchSoftware(id, launcherPath)
  )
  ipcMain.handle('software:reveal', (_e, id: string, launcherPath?: string) =>
    revealInFolder(id, launcherPath)
  )

  ipcMain.handle('software:add-manual', async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '选择要添加的程序',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    })
    if (result.canceled) return []

    const added: SoftwareItem[] = []
    for (const file of result.filePaths) {
      added.push(...(await addSingleExe(file)))
    }
    return added
  })

  /* ------------------------------ 分类 ------------------------------ */
  ipcMain.handle('categories:list', () => listCategories())
  ipcMain.handle('categories:upsert', (_e, category: Category) => upsertCategory(category))
  ipcMain.handle('categories:remove', (_e, id: string) => removeCategory(id))
  ipcMain.handle('categories:move', (_e, id: string, delta: number) => moveCategory(id, delta))

  /* ------------------------------ 标签 ------------------------------ */
  ipcMain.handle('tags:list', () => listTags())
  ipcMain.handle('tags:create', (_e, name: string) => createTag(name))
  ipcMain.handle('tags:rename', (_e, id: number, name: string) => renameTag(id, name))
  ipcMain.handle('tags:merge', (_e, fromIds: number[], intoId: number) => mergeTags(fromIds, intoId))
  ipcMain.handle('tags:remove', (_e, id: number) => removeTag(id))

  /* ---------------------------- 待确认条目 ---------------------------- */
  ipcMain.handle('pending:list', () => listPending())
  ipcMain.handle('pending:count', () => countPending())
  ipcMain.handle('pending:update', (_e, id: string, patch: Partial<PendingItem>) =>
    updatePending(id, patch)
  )
  ipcMain.handle('pending:confirm', (_e, ids: string[]) => confirmPending(ids))
  ipcMain.handle('pending:skip', (_e, ids: string[]) => skipPending(ids))
  ipcMain.handle('pending:skipped-count', () => countSkipped())
  ipcMain.handle('pending:clear-skipped', () => clearSkipped())

  /* ------------------------------ 设置 ------------------------------ */
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:patch', (_e, patch: Partial<AppSettings>) => patchSettings(patch))

  /* ------------------------------ 扫描 ------------------------------ */
  ipcMain.handle('scan:pick-dir', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择要扫描的目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('scan:run', async (_e, dirs: string[]) =>
    scanDirectories(dirs, (p) => send('scan:progress', p))
  )
  ipcMain.on('scan:cancel', () => cancelScan())
  ipcMain.handle('scan:units', () => listScanUnits())
  ipcMain.handle('scan:reset', () => resetScanUnits())
  ipcMain.handle('scan:reset-one', (_e, dir: string) => resetScanUnit(dir))

  /* ------------------------------- AI ------------------------------- */
  ipcMain.handle('ai:complete', async (_e, ids?: string[]) =>
    completeWithAi(ids, (p) => send('ai:progress', p))
  )
  ipcMain.on('ai:cancel', () => cancelAi())
  ipcMain.handle('ai:test', (_e, config: AIConfig) => testConnection(config))
  ipcMain.handle('ai:test-search', (_e, config: SearchConfig) => testSearch(config))

  /* ---------------------------- 识别日志 ---------------------------- */
  ipcMain.handle('logs:list', (_e, query: IdentifyLogQuery = {}) => listIdentifyLogs(query))
  ipcMain.handle('logs:clear', () => clearIdentifyLogs())

  /* ------------------------------ 数据 ------------------------------ */
  ipcMain.handle('data:dir', () => app.getPath('userData'))
  ipcMain.handle('data:open-dir', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('data:stats', () => dataStats())

  ipcMain.handle('data:reset', (_e, mode: 'library' | 'all') => {
    const summary = resetData(mode === 'all' ? 'all' : 'library')
    return { summary, settings: getSettings() }
  })

  ipcMain.handle('data:export-json', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出数据',
      defaultPath: path.join('baoyi-export.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, JSON.stringify(exportAll(), null, 2), 'utf-8')
    return result.filePath
  })

  ipcMain.handle('data:export-markdown', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出为 Markdown',
      defaultPath: path.join('抱一.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, toMarkdown(exportAll()), 'utf-8')
    return result.filePath
  })
}

/**
 * 导出成人直接能读的清单：按分类分节，每个软件一段。
 *
 * 和 JSON 的分工是明确的 —— JSON 是给程序看的备份，字段一个不落；
 * 这份是给人看的，只留读起来有意义的东西，路径和使用统计那些不进正文。
 * 目标是能直接贴进 Obsidian。
 */
function toMarkdown(data: ReturnType<typeof exportAll>): string {
  const esc = (s: string) => s.replace(/\r?\n+/g, ' ').trim()
  const out: string[] = [
    '# 抱一 · 本地软件清单',
    '',
    `导出时间：${new Date(data.exported_at).toLocaleString('sv')}　共 ${data.software.length} 个`,
    ''
  ]

  const byCategory = new Map<string, typeof data.software>()
  for (const item of data.software) {
    const key = item.category || '未分类'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key)!.push(item)
  }

  for (const [category, items] of byCategory) {
    out.push(`## ${category}`, '')
    for (const item of items) {
      const title = [item.name_zh, item.name_en].filter(Boolean).join(' · ') || item.file_name
      out.push(`### ${title}${item.is_archived ? '（已归档）' : ''}`, '')
      if (item.summary) out.push(esc(item.summary), '')
      if (item.tags.length) out.push(`标签：${item.tags.join('、')}`, '')
      if (item.official_url) out.push(`官网：${item.official_url}`, '')
      if (item.description) out.push(esc(item.description), '')
      if (item.why_choose) out.push(`**为什么选它**：${esc(item.why_choose)}`, '')
      if (item.use_cases) out.push(`**使用场景**：${esc(item.use_cases)}`, '')
      if (item.notes) out.push(`**备注**：${esc(item.notes)}`, '')
      if (item.alternatives.length) out.push(`**淘汰的同类**：${item.alternatives.join('、')}`, '')
    }
  }
  return out.join('\n')
}
