import { tr } from '../services/system/language.ts'
import { dialog, shell, type BrowserWindow } from 'electron'
import type { mainWindowIpc } from './main-window.ts'
import { optBool, optRecord, optStringArray, reqArray, reqBool, reqEnum, reqId, reqRecord, reqString, reqStringArray } from './validate.ts'
import type { Episode, VideoItem, VideoQuery } from '../../src/types'
import type { VideoTaxonomyEdit } from '../../src/types/video-taxonomy'
import { getDb } from '../services/storage/database'
import { videoTaxonomy, editVideoTaxonomy } from '../kinds/video/taxonomy-settings.ts'
import { previewVideoRemoval, applyVideoRemoval, bulkUpdateVideos } from '../kinds/video/management.ts'
import { readLocalVideoBundle } from '../kinds/video/local-files.ts'
import { POSTER_EXTS } from '../kinds/video/posters'
import {
  cancelVideoScan,
  clearVideoPoster,
  fetchVideoPoster,
  getVideoItem,
  importVideoBundle,
  listVideoEpisodes,
  listVideoItems,
  playVideo,
  playVideoEpisode,
  reidentifyVideo,
  removeVideo,
  renumberVideoEpisodes,
  restoreVideoScraped,
  revealSubtitle,
  revealVideo,
  scanVideos,
  scrapeVideoEpisode,
  searchVideoSource,
  setVideoEpisodeArtwork,
  setVideoPoster,
  updateVideoEpisode,
  updateVideoItem,
  useVideoEpisodeArtwork,
  videoCountsOf,
  videoScanReadiness
} from '../kinds/video/service'

type MainIpc = ReturnType<typeof mainWindowIpc>

export function registerVideoCoreIpc(
  getWindow: () => BrowserWindow | null,
  ipcMain: MainIpc,
  send: (channel: string, payload: unknown) => void
): void {
  ipcMain.handle('video:taxonomy', (_event, hentai: boolean) => videoTaxonomy(getDb(), reqBool(hentai, 'hentai')))
  ipcMain.handle('video:edit-taxonomy', (_event, edit: VideoTaxonomyEdit) => {
    const count = editVideoTaxonomy(getDb(), reqRecord(edit, 'edit') as any)
    send('video:library-changed', undefined)
    return count
  })
  ipcMain.handle('video:list', (_e, query: VideoQuery = {}) =>
    listVideoItems((optRecord(query, 'query') ?? {}) as VideoQuery)
  )
  ipcMain.handle('video:get', (_e, id: string) => getVideoItem(reqId(id)))
  ipcMain.handle('video:update', (_e, id: string, patch: Partial<VideoItem>) =>
    updateVideoItem(reqId(id), reqRecord(patch, 'patch') as Partial<VideoItem>)
  )
  ipcMain.handle('video:restore-scraped', (_e, id: string, fields: string[] = []) =>
    restoreVideoScraped(reqId(id), optStringArray(fields, 'fields', { max: 100 }) ?? [])
  )
  ipcMain.handle('video:remove', async (_e, id: string) => {
    const safeId = reqId(id)
    await removeVideo(safeId)
    send('video:library-changed', safeId)
  })
  ipcMain.handle('video:counts', () => videoCountsOf())
  ipcMain.handle('video:reveal', (_e, id: string) => revealVideo(reqId(id)))
  ipcMain.handle('video:reveal-subtitle', (_e, id: string, target: string) =>
    revealSubtitle(reqId(id), reqString(target, 'target', { max: 4096 }))
  )
  ipcMain.handle('video:play', (_e, id: string) => playVideo(reqId(id)))
  ipcMain.handle('video:play-episode', (_e, episodeId: string) =>
    playVideoEpisode(reqId(episodeId, 'episodeId'))
  )
  ipcMain.handle('video:readiness', (_e, forAgent?: boolean) =>
    videoScanReadiness(optBool(forAgent, 'forAgent') === true)
  )
  ipcMain.handle('video:scan', (_e, dirs: string[]) =>
    scanVideos(reqStringArray(dirs, 'dirs', { min: 1, max: 500 }), (p) => send('video:progress', p))
  )
  ipcMain.on('video:cancel', () => cancelVideoScan())
  ipcMain.handle('video:reidentify', (_e, id: string, forceHentai: boolean = false) =>
    reidentifyVideo(reqId(id), optBool(forceHentai, 'forceHentai') ?? false, (p) => send('video:progress', p))
  )

  ipcMain.handle('video:pick-dirs', async () => {
    const win = getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: tr("选择影视目录（可多选）"),
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('video:episodes', (_e, id: string) => listVideoEpisodes(reqId(id)))
  ipcMain.handle('video:source-search', (_e, query: string) =>
    searchVideoSource(reqString(query, 'query', { max: 512 }))
  )
  ipcMain.handle('video:episode-scrape', async (_e, resourceId: string, episodeId: string, source: string) => {
    const safeId = reqId(resourceId, 'resourceId')
    const result = await scrapeVideoEpisode(
      safeId,
      reqId(episodeId, 'episodeId'),
      reqString(source, 'source', { max: 512 })
    )
    send('video:library-changed', safeId)
    return result
  })
  ipcMain.handle('video:episode-artwork', async (_e, episodeId: string, role: 'poster' | 'thumbnail') => {
    const safeEpisodeId = reqId(episodeId, 'episodeId')
    const safeRole = reqEnum(role, ['poster', 'thumbnail'] as const, 'role')
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const picked = await dialog.showOpenDialog(win, {
      title: safeRole === 'poster' ? tr("选择单集封面") : tr("选择单集预览图"),
      properties: ['openFile'],
      filters: [{ name: tr("图片"), extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return setVideoEpisodeArtwork(safeEpisodeId, picked.filePaths[0], safeRole)
  })
  ipcMain.handle('video:renumber-episodes', (_e, id: string, changes: Array<{ episodeId: string; season: number; number: number }>) => {
    const safeId = reqId(id)
    const result = renumberVideoEpisodes(safeId, reqArray(changes, 'changes', { max: 5000 }))
    if (result.ok) send('video:library-changed', safeId)
    return result
  })
  ipcMain.handle('video:use-episode-artwork', (_e, id: string, episodeId: string, role: 'poster' | 'thumbnail') => {
    const safeId = reqId(id)
    const result = useVideoEpisodeArtwork(
      safeId,
      reqId(episodeId, 'episodeId'),
      reqEnum(role, ['poster', 'thumbnail'] as const, 'role')
    )
    if (result.ok) send('video:library-changed', safeId)
    return result
  })
  ipcMain.handle('video:removal-preview', (_e, input) =>
    previewVideoRemoval(getDb(), reqRecord(input, 'input') as any)
  )
  ipcMain.handle('video:removal-apply', async (_e, preview) => {
    const safe = reqRecord(preview, 'preview') as any
    const result = await applyVideoRemoval(getDb(), safe, (file) => shell.trashItem(file))
    send('video:library-changed', safe.request?.resourceIds?.[0])
    return result
  })
  ipcMain.handle('video:bulk-update', (_e, ids: string[], patch) => {
    const safeIds = reqStringArray(ids, 'ids', { min: 1, max: 5000 })
    const result = bulkUpdateVideos(getDb(), safeIds, reqRecord(patch, 'patch') as any)
    send('video:library-changed', safeIds[0])
    return result
  })
  ipcMain.handle('video:import-bundle', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: tr("导入视频目录（支持本地视频或抱一资源包）"),
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = result.filePaths[0]
    if (readLocalVideoBundle(directory)) return importVideoBundle(directory, true)
    const scanResult = await scanVideos([directory], (p) => send('video:progress', p), true)
    return {
      resourceId: scanResult.entries?.find((e) => e.resourceId)?.resourceId || '',
      bundleId: '',
      created: false,
      itemsAdded: scanResult.episodes,
      filesAdded: 0,
      scanResult
    }
  })

  ipcMain.handle('video:update-episode', (_e, episodeId: string, patch: Partial<Episode>) => {
    const episode = updateVideoEpisode(reqId(episodeId, 'episodeId'), reqRecord(patch, 'patch') as Partial<Episode>)
    return { episode, item: episode ? getVideoItem(episode.resource_id) : null }
  })

  ipcMain.handle('video:fetch-poster', async (_e, id: string) => {
    const safeId = reqId(id)
    const outcome = await fetchVideoPoster(safeId)
    return { ok: outcome.ok, message: outcome.message, item: outcome.ok ? getVideoItem(safeId) : null }
  })

  ipcMain.handle('video:pick-poster', async (_e, id: string) => {
    const safeId = reqId(id)
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      title: getVideoItem(safeId)?.media_kind === 'audio' ? tr("选择音频封面（方形效果最好）") : tr("选择海报图（竖版 2:3 效果最好）"),
      properties: ['openFile'],
      filters: [{ name: tr("图片"), extensions: POSTER_EXTS.map((e) => e.slice(1)) }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const outcome = setVideoPoster(safeId, result.filePaths[0])
    return { ...outcome, item: outcome.ok ? getVideoItem(safeId) : null }
  })

  ipcMain.handle('video:clear-poster', (_e, id: string) => clearVideoPoster(reqId(id)))
}
