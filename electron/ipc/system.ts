import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcActivity, mainWindowIpc } from './main-window.ts'
import { optRecord, optString, optStringArray, reqArray, reqEnum, reqId, reqNumber, reqRecord, reqString, reqStringArray } from './validate.ts'
import type { AIConfig, AppSettings, Category, IdentifyLogQuery, SearchConfig, TaskRecord, TmdbConfig } from '../../src/types'
import { assertProjectRunsStopped } from '../kinds/project/activity.ts'
import { assertLibraryIdle } from './library-backup.ts'
import { stopServices } from '../services/system/lifecycle.ts'
import { removeProfileEntry } from '../services/storage/reset-files.ts'
import { cancelAi, completeWithAi, listModels, testConnection } from '../kinds/software/aiService'
import { clearIdentifyLogs, listIdentifyLogs, listIdentifyReports } from '../services/storage/identify-records.ts'
import { exportSoftwareList } from '../kinds/software/db.ts'
import {
  createTag,
  listCategories,
  listTags,
  mergeTags,
  moveCategory,
  removeCategory,
  removeTag,
  renameTag,
  upsertCategory
} from '../services/taxonomy/taxonomy-store.ts'
import { dataStats, getDb, resetData, saveBackupRoot } from '../services/storage/database'
import { getSettings, patchSettings } from '../services/storage/settings-store.ts'
import { clearTaskRecords, listTaskRecords, saveTaskRecord } from '../services/storage/task-records.ts'
import { isPortable } from '../services/storage/portable'
import { testTmdb } from '../kinds/video/tmdb'
import { testSearch } from '../services/network/searchService'
import {
  getHanimeNetworkStatus,
  getHanimeSession,
  normalizeProxyRules,
  openHanimeVerification,
  reapplyProxy,
  resolveProxyFor,
  setHanimeHostsEnabled
} from '../services/network/proxy'
import { createHanimeBrowser } from '../services/hanime/hanime-browser.ts'
import { ensureOnlineNetwork } from '../services/network/online-network.ts'
import { parseProxyInput } from '../services/network/proxy-rules.ts'
import { closeArchiveAssistant } from './archive.ts'
import { closeVideoPreview } from './video-preview.ts'
import { reopenComicIngest, stopComicIngest } from './comic-ingest.ts'

type MainIpc = ReturnType<typeof mainWindowIpc>

export interface SystemIpcDeps {
  activity: IpcActivity
  send: (channel: string, payload: unknown) => void
  resetVideoHistory: () => void
  imageSource: { stop: () => Promise<void> | void; reset: (all: boolean) => void }
  resetComic: (all: boolean) => Promise<void>
}

export function registerSystemIpc(
  getWindow: () => BrowserWindow | null,
  ipcMain: MainIpc,
  deps: SystemIpcDeps
): void {
  const { activity, send, resetVideoHistory, imageSource, resetComic } = deps
  const hanimeBrowser = createHanimeBrowser({
    getSession: getHanimeSession,
    getMainWindow: getWindow,
    isHidden: () => getSettings(getDb()).hide_hentai === true
  })

  ipcMain.handle('hanime-browser:open', async (_event, url?: string) => {
    url = optString(url, 'url', { max: 8192 })
    await reapplyProxy(getSettings(getDb()).proxy)
    return hanimeBrowser.open(url)
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDirectory: app.getPath('userData'),
    portable: isPortable()
  }))

  ipcMain.handle('app:stat-paths', async (_e, paths: string[]) => {
    const safePaths = reqStringArray(paths, 'paths', { min: 1, max: 500 })
    return Promise.all(
      safePaths.map(async (p) => {
        if (!path.isAbsolute(p)) return { path: p, kind: 'missing' as const }
        try {
          const st = await fs.lstat(p)
          if (st.isSymbolicLink()) return { path: p, kind: 'symlink' as const }
          if (st.isDirectory()) return { path: p, kind: 'directory' as const }
          if (st.isFile()) return { path: p, kind: 'file' as const }
          return { path: p, kind: 'missing' as const }
        } catch {
          return { path: p, kind: 'missing' as const }
        }
      })
    )
  })

  ipcMain.handle('app:copy', (_e, text: string) => {
    clipboard.writeText(reqString(text, 'text', { allowEmpty: true, max: 1_000_000 }))
  })

  ipcMain.handle('app:open-url', async (_event, value: string) => {
    const raw = reqString(value, 'url', { max: 8192, trim: true })
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error('外部链接格式不正确，请确认以 http:// 或 https:// 开头')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
    await shell.openExternal(url.href)
  })

  ipcMain.on('win:minimize', () => getWindow()?.minimize())
  ipcMain.on('win:toggle-maximize', () => {
    const win = getWindow()
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', () => getWindow()?.close())
  ipcMain.handle('win:is-maximized', () => getWindow()?.isMaximized() ?? false)

  ipcMain.handle('tasks:list', () => listTaskRecords(getDb()))
  ipcMain.handle('tasks:save', (_e, task: TaskRecord) => {
    saveTaskRecord(getDb(), reqRecord(task, 'task') as any)
    return true
  })
  ipcMain.handle('tasks:clear', (_e, ids?: string[]) => {
    clearTaskRecords(getDb(), optStringArray(ids, 'ids', { max: 5000 }))
    return true
  })

  ipcMain.handle('categories:list', (_e, kind?: string) =>
    listCategories(getDb(), optString(kind, 'kind', { max: 64 }))
  )
  ipcMain.handle('categories:upsert', (_e, category: Category, kind?: string) =>
    upsertCategory(
      getDb(),
      reqRecord(category, 'category') as unknown as Category,
      optString(kind, 'kind', { max: 64 })
    )
  )
  ipcMain.handle('categories:remove', (_e, id: string) => removeCategory(getDb(), reqId(id)))
  ipcMain.handle('categories:move', (_e, id: string, delta: number) =>
    moveCategory(getDb(), reqId(id), reqNumber(delta, 'delta', { min: -1000, max: 1000, integer: true }))
  )

  ipcMain.handle('tags:list', (_e, kind?: string) => listTags(getDb(), optString(kind, 'kind', { max: 64 })))
  ipcMain.handle('tags:create', (_e, name: string, kind?: string) =>
    createTag(getDb(), reqString(name, 'name', { max: 120, trim: true }), optString(kind, 'kind', { max: 64 }))
  )
  ipcMain.handle('tags:rename', (_e, id: number, name: string) =>
    renameTag(getDb(), reqNumber(id, 'id', { min: 1, integer: true }), reqString(name, 'name', { max: 120, trim: true }))
  )
  ipcMain.handle('tags:merge', (_e, fromIds: number[], intoId: number) =>
    mergeTags(
      getDb(),
      reqArray<number>(fromIds, 'fromIds', { min: 1, max: 1000 }).map((v, i) =>
        reqNumber(v, `fromIds[${i}]`, { min: 1, integer: true })
      ),
      reqNumber(intoId, 'intoId', { min: 1, integer: true })
    )
  )
  ipcMain.handle('tags:remove', (_e, id: number) =>
    removeTag(getDb(), reqNumber(id, 'id', { min: 1, integer: true }))
  )

  ipcMain.handle('settings:get', () => getSettings(getDb()))
  ipcMain.handle('settings:patch', async (_e, patch: Partial<AppSettings>) => {
    patch = reqRecord(patch, 'patch') as Partial<AppSettings>
    if ('video_online_proxy' in patch) parseProxyInput(patch.video_online_proxy ?? 'system://')
    const previousPrivacy = getSettings(getDb()).hide_hentai
    const next = patchSettings(getDb(), patch)
    if (previousPrivacy !== next.hide_hentai) {
      await Promise.all([closeVideoPreview(), closeArchiveAssistant(), stopComicIngest()])
      if (!next.hide_hentai) reopenComicIngest()
    }
    if (next.hide_hentai) hanimeBrowser.close()
    if ('proxy' in patch) await reapplyProxy(next.proxy)
    if ('video_online_proxy' in patch) await ensureOnlineNetwork()
    if ('hanime_builtin_hosts' in patch) setHanimeHostsEnabled(next.hanime_builtin_hosts !== false)
    return next
  })

  ipcMain.handle('settings:proxy-status', async (_e, url?: string) => {
    const targetUrl = optString(url, 'url', { max: 2048, trim: true }) || 'https://hanime1.me/'
    return {
      ...getHanimeNetworkStatus(targetUrl),
      rules: normalizeProxyRules(getSettings(getDb()).proxy),
      resolved: await resolveProxyFor(targetUrl)
    }
  })
  ipcMain.handle('settings:hanime-verify', async (_e, url?: string) =>
    openHanimeVerification(optString(url, 'url', { max: 2048, trim: true }) || 'https://hanime1.me/')
  )

  ipcMain.handle('ai:complete', async (_e, ids?: string[]) =>
    completeWithAi(optStringArray(ids, 'ids', { max: 5000 }), (p) => send('ai:progress', p))
  )
  ipcMain.on('ai:cancel', () => cancelAi())
  ipcMain.handle('ai:test', (_e, config: AIConfig) => testConnection(reqRecord(config, 'config') as unknown as AIConfig))
  ipcMain.handle('ai:models', (_e, config: AIConfig) => listModels(reqRecord(config, 'config') as unknown as AIConfig))
  ipcMain.handle('ai:test-search', (_e, config: SearchConfig) =>
    testSearch(reqRecord(config, 'config') as unknown as SearchConfig)
  )
  ipcMain.handle('ai:test-tmdb', (_e, config: TmdbConfig) =>
    testTmdb(reqRecord(config, 'config') as unknown as TmdbConfig)
  )

  ipcMain.handle('logs:list', (_e, query: IdentifyLogQuery = {}) =>
    listIdentifyLogs(getDb(), (optRecord(query, 'query') ?? {}) as IdentifyLogQuery)
  )
  ipcMain.handle('logs:clear', (_e, resourceKind?: string) =>
    clearIdentifyLogs(getDb(), optString(resourceKind, 'resourceKind', { max: 64 }))
  )
  ipcMain.handle('logs:reports', (_e, resourceKind?: string) =>
    listIdentifyReports(getDb(), optString(resourceKind, 'resourceKind', { max: 64 }))
  )

  ipcMain.handle('data:dir', () => app.getPath('userData'))
  ipcMain.handle('data:open-dir', async () => {
    const dir = app.getPath('userData')
    await fs.mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) throw new Error('无法打开数据目录：' + err)
    return ''
  })
  ipcMain.handle('data:stats', () => dataStats())
  ipcMain.handle('data:save-backup-root', () => saveBackupRoot())
  ipcMain.handle('data:open-save-backup-root', async () => {
    const dir = saveBackupRoot()
    const customRoot = getSettings(getDb()).save_backup_root.trim()
    if (!customRoot) {
      await fs.mkdir(dir, { recursive: true })
    } else {
      await fs.access(dir).catch(() => {
        throw new Error('未找到存档备份目录，请确认所在磁盘已连接')
      })
    }
    const err = await shell.openPath(dir)
    if (err) throw new Error('无法打开存档备份目录：' + err)
    return ''
  })
  ipcMain.handle('data:pick-save-backup-root', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择存档备份存放目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('data:reset', (_e, mode: 'library' | 'all') =>
    activity.reset(async () => {
      mode = reqEnum(mode, ['library', 'all'] as const, 'mode')
      assertProjectRunsStopped()
      assertLibraryIdle()
      const all = mode === 'all'
      const profile = app.getPath('userData')
      try {
        await stopServices(closeArchiveAssistant, () => closeVideoPreview(true), stopComicIngest, imageSource.stop)
        assertLibraryIdle()
        const entries = [
          'cache/comic-covers',
          'comic-logs',
          ...(all
            ? ['archive-assistant', 'comic-preferences.json', 'comic-download-targets.json', 'comic-authorizations']
            : [])
        ]
        for (const entry of entries) await removeProfileEntry(profile, entry)
        const summary = resetData(all ? 'all' : 'library')
        resetVideoHistory()
        imageSource.reset(all)
        await resetComic(all)
        return { summary, settings: getSettings(getDb()) }
      } finally {
        reopenComicIngest()
      }
    })
  )

  ipcMain.handle('data:export-markdown', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出为 Markdown',
      defaultPath: path.join('抱一.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, toMarkdown(exportSoftwareList(getDb())), 'utf-8')
    return result.filePath
  })
}

function toMarkdown(data: ReturnType<typeof exportSoftwareList>): string {
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
