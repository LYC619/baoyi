import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AIConfig,
  AppSettings,
  Category,
  GameItem,
  GameQuery,
  IdentifyLogQuery,
  OrganizeCommand,
  Episode,
  PendingItem,
  SearchConfig,
  SoftwareItem,
  SoftwareQuery,
  TmdbConfig,
  VideoItem,
  VideoQuery
} from '../../src/types'
import { cancelAi, completeWithAi, listModels, testConnection } from '../kinds/software/aiService'
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
  listIdentifyReports,
  listOrganizePlans,
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
  saveBackupRoot,
  skipPending,
  updatePending,
  updateSoftware,
  upsertCategory
} from '../services/database'
import { launchSoftware, revealInFolder } from '../kinds/software/launcher'
import {
  addGameLinks,
  backupSavePath,
  cancelGameScan,
  checkAllSavePaths,
  checkSavePath,
  clearGameCover,
  deleteSaveBackup,
  gameCountsOf,
  getGameItem,
  getSaveBackup,
  isGameRunning,
  launchGame,
  listGameItems,
  listSaveBackups,
  onGameSession,
  openGameLink,
  removeGame,
  restoreSaveBackup,
  reverifySavePath,
  scanGames,
  searchGameCovers,
  setGameCover,
  setGameCoverFromUrl,
  updateGameItem
} from '../kinds/game/service'
import { COVER_EXTS } from '../kinds/game/links'
import {
  cancelVideoScan,
  clearVideoPoster,
  fetchVideoPoster,
  getVideoItem,
  listVideoEpisodes,
  listVideoItems,
  removeVideo,
  revealVideo,
  scanVideos,
  setVideoPoster,
  updateVideoEpisode,
  updateVideoItem,
  videoCountsOf,
  videoScanReadiness
} from '../kinds/video/service'
import { POSTER_EXTS } from '../kinds/video/posters'
import { testTmdb } from '../kinds/video/tmdb'
import {
  materialize,
  previewOrganize,
  runOrganize,
  undoOrganize,
  unlink
} from '../kinds/software/organize'
import { addSingleExe, cancelScan, scanDirectories } from '../kinds/software/scanner'
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

  ipcMain.handle('app:copy', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

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

  /* ------------------------------ 游戏 ------------------------------ */
  ipcMain.handle('game:list', (_e, query: GameQuery = {}) => listGameItems(query))
  ipcMain.handle('game:get', (_e, id: string) => getGameItem(id))
  ipcMain.handle('game:update', (_e, id: string, patch: Partial<GameItem>) =>
    updateGameItem(id, patch)
  )
  ipcMain.handle('game:remove', (_e, id: string) => removeGame(id))
  ipcMain.handle('game:counts', () => gameCountsOf())
  ipcMain.handle('game:scan', (_e, dirs: string[]) =>
    scanGames(dirs, (p) => send('game:progress', p))
  )
  ipcMain.on('game:cancel', () => cancelGameScan())

  // 在资源管理器里选中主程序。Step 6 才做「启动并计时」，在那之前
  // 用户至少得有一条路走到游戏本体，否则详情页上那个路径只是一行不能用的字
  ipcMain.handle('game:reveal', (_e, id: string) => {
    const game = getGameItem(id)
    if (game?.path) shell.showItemInFolder(game.path)
  })

  // 游戏目录是用户一个个指的，不像软件那样配一批扫描根反复扫 ——
  // 一次装一个游戏，多选省下的是几次点击，不值得为它再加一处设置项
  ipcMain.handle('game:pick-dirs', async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '选择游戏目录（可多选）',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  /* -------------------------- 存档与备份 -------------------------- */

  // 只选和探测，不写库：目录是空的时候界面要先问一句，问完了才走 game:update。
  // 这就是识别时刻意留下的那个缺口 —— 详情页原先只能删存档路径，不能加
  ipcMain.handle('game:pick-save-dir', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择这个游戏的存档目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return checkSavePath(result.filePaths[0])
  })

  ipcMain.handle('game:verify-save', (_e, id: string, target: string) =>
    reverifySavePath(id, target)
  )
  ipcMain.handle('game:check-save-paths', () => checkAllSavePaths())

  ipcMain.handle('game:launch', (_e, id: string) => launchGame(id))
  ipcMain.handle('game:running', (_e, id: string) => isGameRunning(id))
  // 一段游玩结束时主动推给界面：退出时刻由游戏进程决定，渲染进程没法自己等
  onGameSession((id, outcome) => send('game:session', { id, ...outcome }))
  ipcMain.handle('game:backup-save', (_e, id: string, savePath: string) =>
    backupSavePath(id, savePath)
  )
  ipcMain.handle('game:backups', (_e, id: string) => listSaveBackups(id))
  ipcMain.handle('game:restore-backup', (_e, backupId: string) => restoreSaveBackup(backupId))
  ipcMain.handle('game:delete-backup', (_e, backupId: string) => deleteSaveBackup(backupId))

  ipcMain.handle('game:open-backup', async (_e, backupId: string) => {
    const backup = getSaveBackup(backupId)
    if (backup?.backup_dir) await shell.openPath(backup.backup_dir)
  })

  /* -------------------------- 关联文件 -------------------------- */

  /**
   * 选文件或选目录，两个入口。
   *
   * Windows 的对话框不支持同时选文件和目录（openFile + openDirectory 一起给的话
   * 只有前者生效），所以这里按调用方要的那种开，界面上是两个按钮。
   * MOD 通常是一个目录，攻略和修改器通常是单个文件，两种都要能加。
   */
  ipcMain.handle('game:pick-links', async (_e, id: string, kind: 'file' | 'dir' = 'file') => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'dir' ? '选择要关联的文件夹（MOD、整合包…）' : '选择要关联的文件（攻略、修改器…）',
      properties:
        kind === 'dir' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return addGameLinks(id, result.filePaths)
  })

  ipcMain.handle('game:open-link', (_e, id: string, target: string) => openGameLink(id, target))
  ipcMain.handle('game:reveal-link', (_e, id: string, target: string) =>
    openGameLink(id, target, 'reveal')
  )

  /* ---------------------------- 封面 ---------------------------- */

  ipcMain.handle('game:pick-cover', async (_e, id: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择封面图（竖版 2:3 效果最好）',
      properties: ['openFile'],
      // 扩展名名单来自 links.ts，和真正执行校验的那份是同一个来源 ——
      // 对话框过滤器和校验规则分开写，迟早出现「选得进来但存不下去」
      filters: [{ name: '图片', extensions: COVER_EXTS.map((e) => e.slice(1)) }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const outcome = setGameCover(id, result.filePaths[0])
    return { ...outcome, item: outcome.ok ? getGameItem(id) : null }
  })

  ipcMain.handle('game:clear-cover', (_e, id: string) => clearGameCover(id))

  ipcMain.handle('game:search-covers', (_e, id: string) => searchGameCovers(id))

  ipcMain.handle('game:set-cover-url', async (_e, id: string, url: string) => {
    const outcome = await setGameCoverFromUrl(id, url)
    return { ...outcome, item: outcome.ok ? getGameItem(id) : null }
  })

  /* ------------------------------ 影视 ------------------------------ */
  ipcMain.handle('video:list', (_e, query: VideoQuery = {}) => listVideoItems(query))
  ipcMain.handle('video:get', (_e, id: string) => getVideoItem(id))
  ipcMain.handle('video:update', (_e, id: string, patch: Partial<VideoItem>) =>
    updateVideoItem(id, patch)
  )
  ipcMain.handle('video:remove', (_e, id: string) => removeVideo(id))
  ipcMain.handle('video:counts', () => videoCountsOf())
  ipcMain.handle('video:reveal', (_e, id: string) => revealVideo(id))
  ipcMain.handle('video:readiness', () => videoScanReadiness())
  ipcMain.handle('video:scan', (_e, dirs: string[]) =>
    scanVideos(dirs, (p) => send('video:progress', p))
  )
  ipcMain.on('video:cancel', () => cancelVideoScan())

  ipcMain.handle('video:pick-dirs', async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: '选择影视目录（可多选）',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('video:episodes', (_e, id: string) => listVideoEpisodes(id))

  /**
   * 改一集，顺带把整部剧的条目取回来。
   *
   * 两个值一起返回而不是让界面改完再查一次：`updateVideoEpisode` 内部会把剧一级的
   * 观看状态刷一遍（标完最后一集，整部剧就该变成「看完」），而界面上那句「3/12 集」
   * 和侧栏计数都靠条目那一行。分两趟拿的话，中间那一瞬界面显示的是自相矛盾的两个数。
   */
  ipcMain.handle('video:update-episode', (_e, episodeId: string, patch: Partial<Episode>) => {
    const episode = updateVideoEpisode(episodeId, patch)
    return { episode, item: episode ? getVideoItem(episode.resource_id) : null }
  })

  /* ---------------------------- 海报 ---------------------------- */

  ipcMain.handle('video:fetch-poster', async (_e, id: string) => {
    const outcome = await fetchVideoPoster(id)
    // changed 为 false 时也把条目带回去：那可能是「已经有海报了」，
    // 而界面此刻手里那份可能是刮削阶段那个还没下载的相对路径
    return { ok: outcome.ok, message: outcome.message, item: outcome.ok ? getVideoItem(id) : null }
  })

  ipcMain.handle('video:pick-poster', async (_e, id: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择海报图（竖版 2:3 效果最好）',
      properties: ['openFile'],
      // 名单来自 posters.ts，和真正执行校验的那份是同一个来源 ——
      // 对话框过滤器和校验规则分开写，迟早出现「选得进来但存不下去」
      filters: [{ name: '图片', extensions: POSTER_EXTS.map((e) => e.slice(1)) }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const outcome = setVideoPoster(id, result.filePaths[0])
    return { ...outcome, item: outcome.ok ? getVideoItem(id) : null }
  })

  ipcMain.handle('video:clear-poster', (_e, id: string) => clearVideoPoster(id))

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
  ipcMain.handle('ai:models', (_e, config: AIConfig) => listModels(config))
  ipcMain.handle('ai:test-search', (_e, config: SearchConfig) => testSearch(config))
  ipcMain.handle('ai:test-tmdb', (_e, config: TmdbConfig) => testTmdb(config))

  /* ---------------------------- 识别日志 ---------------------------- */
  ipcMain.handle('logs:list', (_e, query: IdentifyLogQuery = {}) => listIdentifyLogs(query))
  ipcMain.handle('logs:clear', () => clearIdentifyLogs())
  ipcMain.handle('logs:reports', () => listIdentifyReports())

  /* ---------------------------- 目录整理 ---------------------------- */
  ipcMain.handle('organize:pick-root', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择整理目标根目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('organize:preview', (_e, ids?: string[]) => previewOrganize(ids))
  ipcMain.handle('organize:run', (_e, commands: OrganizeCommand[]) =>
    runOrganize(commands, (p) => send('organize:progress', p))
  )
  ipcMain.handle('organize:plans', () => listOrganizePlans())
  ipcMain.handle('organize:undo', (_e, planId: string) => undoOrganize(planId))
  ipcMain.handle('organize:materialize', (_e, id: string) => materialize(id))
  ipcMain.handle('organize:unlink', (_e, id: string) => unlink(id))

  /* ------------------------------ 数据 ------------------------------ */
  ipcMain.handle('data:dir', () => app.getPath('userData'))
  ipcMain.handle('data:open-dir', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('data:stats', () => dataStats())

  // 备份根是「设置里那个值，空就退回默认」，渲染进程不该自己拼这个默认值
  ipcMain.handle('data:save-backup-root', () => saveBackupRoot())
  ipcMain.handle('data:open-save-backup-root', () => shell.openPath(saveBackupRoot()))

  ipcMain.handle('data:pick-save-backup-root', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择存档备份存放目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

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
