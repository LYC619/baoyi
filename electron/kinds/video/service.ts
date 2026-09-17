/**
 * 视频模块的服务层。**这个文件是 `kinds/video/` 里唯一允许 import
 * `services/database.ts` 的地方** —— 它只做绑定和汇总，真正的逻辑都在别处。
 *
 * 这条约定是 v0.5 立的、v0.6 验过的：`kinds/<kind>/` 下的逻辑只收 `SqlDb`，
 * 这样自检能拿 `node:sqlite` 驱动同一份代码，不用把整个 Electron 拉起来。
 * `service.ts` 是那个例外，代价是它自己测不了 —— 所以它必须薄。
 */

import fs, { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { app, nativeImage, net, shell } from 'electron'
import type {
  AgentEvent,
  Episode,
  VideoCounts,
  VideoItem,
  VideoQuery,
  VideoScanProgress,
  VideoScanResult
} from '../../../src/types'
import {
  getDb,
  getSettings,
  listCategories,
  postersDir,
  saveIdentifyLog,
  tagPool
} from '../../services/database.ts'
import { runAgent } from '../../services/agent/loop.ts'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoImportCommand } from './import-command.ts'
import { groupVideoImportCandidates } from './import-series.ts'
import { videoImportLibraryStamp } from './import-command.ts'
import { parseVideoName } from './filename.ts'
import { registeredVideoContent } from '../../../src/utils/video-content.ts'
import { searchAvailable } from '../../services/searchService.ts'
import {
  getEpisode,
  getVideo,
  listEpisodes,
  listVideos,
  nextEpisode,
  resumeEpisode,
  syncSeriesStatus,
  updateEpisode,
  restoreScrapedFields,
  updateVideo,
  videoCounts,
  videoCategoryOf,
  videoOwnerForFiles,
  videosUnder
} from './db.ts'
import { candidateFingerprint, unchangedCandidate, rememberCandidate } from './scan-state.ts'
import { ignoredVideoFile, clearVideoScanIgnores } from './scan-ignores.ts'
import { previewVideoRemoval, applyVideoRemoval } from './management.ts'
import { hanimeChannel, type HanimeReason } from './hentai/channel.ts'
import { scanVideoRoot, type VideoCandidate } from './scanner.ts'
import { buildFacts } from './facts.ts'
import { getVideoWorkLibrary } from './library.ts'
import { readVideoListState } from './list-state.ts'
import { bindVideoSource, registerVideoContent, managedVideoOwner, registerLocalVideoFacts, registerVideoBundle } from './registration.ts'
import { toVideoCode } from './hentai/selectors.ts'
import { HENTAI_CATEGORY } from './taxonomy.ts'
import { persistVideoWorkBundle, syncVideoWorkFiles } from './local-sync.ts'
import { applyVideoCatalogue } from './catalogue.ts'
import { loadVideoWork } from './download/sources.ts'
import { fillEpisodeDetails } from './episode-details.ts'
import { atomicWrite } from './bundle.ts'
import { selectVideoArtwork, type VideoArtwork } from './artwork.ts'
import { fillVideoSystem, videoCandidatePrompt } from './prompts.ts'
import { buildVideoTools, type VideoToolContext } from './tools.ts'
import { imageUrl, tmdbAvailable, tmdbDetail } from './tmdb.ts'
import { fetchHanimeResource, hanimeDetail, hanimeSearch, newBudget } from './hentai/hanime.ts'
import { isHanimeHost } from '../../services/hanime-network-rules.ts'
import {
  acceptExternalPosterUrl,
  acceptPosterUrl,
  extFromContentType,
  isLocalPoster,
  isPosterExt,
  isRemotePoster,
  MAX_POSTER_BYTES,
  pickSidecarPoster,
  posterFileName,
  posterSiblings,
  POSTER_EXTS
} from './posters.ts'

/** 一个条目最多几轮。事实已经很全，8 轮够用；prompt 里也写了这个数 */
const MAX_TURNS = 10

let controller: AbortController | null = null

export function cancelVideoScan(): void {
  controller?.abort()
}

/* ------------------------------ 读写绑定 ------------------------------ */

/**
 * 「隐藏里番」的判据只在这一处读设置。
 *
 * db.ts 那边收的是一个显式布尔，理由见 `listVideos` 的注释（纯数据层，
 * 自检拿内存库直驱）。这里是它和设置之间的唯一接缝 —— 加一处新的读取点之前，
 * 先想清楚为什么不能走这儿。
 */
const hideHentai = (): boolean => getSettings().hide_hentai === true

export async function listVideoItems(query: VideoQuery = {}): Promise<VideoItem[]> {
  const items = listVideos(getDb(), query, hideHentai()), summaries = await readVideoListState(getDb(), items)
  const result: VideoItem[] = []
  for (let offset = 0; offset < items.length; offset += 8) {
    result.push(...await Promise.all(items.slice(offset, offset + 8).map(async item => {
      const { metadataPending, ...summary } = summaries.get(item.id)!
      const poster = await cacheListedPoster(item.poster_path), thumbnail = await cacheListedPoster(item.thumbnail_path)
      return { ...item, ...summary, poster_path: poster.path, thumbnail_path: thumbnail.path,
        pending_reasons: [...(!poster.present ? ['poster'] : []), ...(summary.missing_files ? ['files'] : []), ...(item.needs_review || metadataPending ? ['metadata'] : [])] }
    })))
  }
  const hidden = hideHentai()
  return result.filter(item => (!hidden || item.category !== HENTAI_CATEGORY)
    && (!query.issue || (query.issue === 'any' ? !!item.pending_reasons?.length : item.pending_reasons?.includes(query.issue)))
    && (!query.local || (query.local === 'available' ? item.available_files! > 0 : query.local === 'missing' ? item.missing_files! > 0 : item.available_files === 0)))
}

const listedPosters = new Map<string, { stamp: string; path: string }>()
/** Avoid rereading/hashing unchanged covers on every background update. */
async function cacheListedPoster(source = ''): Promise<{ path: string; present: boolean }> {
  if (!source || !path.isAbsolute(source)) return { path: source, present: false }
  try {
    const stat = await fs.promises.stat(source)
    if (!stat.isFile()) return { path: source, present: false }
    const directory = postersDir()
    if (path.dirname(source) === directory || stat.size > MAX_POSTER_BYTES || !isPosterExt(source)) return { path: source, present: true }
    const key = directory + '\n' + source, stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    const cached = listedPosters.get(key)
    if (cached?.stamp === stamp && await fs.promises.stat(cached.path).then(value => value.isFile(), () => false)) return { path: cached.path, present: true }
    const bytes = await fs.promises.readFile(source)
    const target = path.join(directory, createHash('sha256').update(bytes).digest('hex').slice(0, 24) + path.extname(source).toLowerCase())
    await fs.promises.mkdir(directory, { recursive: true })
    try { await fs.promises.writeFile(target, bytes, { flag: 'wx' }) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    if (listedPosters.size >= 512) listedPosters.delete(listedPosters.keys().next().value!)
    listedPosters.set(key, { stamp, path: target })
    return { path: target, present: true }
  } catch { return { path: source, present: false } }
}
export const getVideoItem = (id: string): VideoItem | null => {
  const item = getVideo(getDb(), id)
  if (!item) return null
  const contents = getVideoWorkLibrary(getDb(), id).contents.filter(registeredVideoContent)
  return cacheLocalPoster({ ...item, episode_total: contents.length, episode_watched: contents.filter(episode => episode.watch_status === 'watched').length })
}

/** Portable posters remain in their work folder; the renderer uses a scoped cache copy. */
function cacheLocalPoster<T extends { poster_path?: string }>(item: T): T {
  const thumbnail = (item as T & { thumbnail_path?: string }).thumbnail_path
  if (thumbnail) {
    const cached = cacheLocalPoster({ poster_path: thumbnail }).poster_path
    if (cached !== thumbnail) item = { ...item, thumbnail_path: cached }
  }
  const source = item.poster_path
  if (!source || !path.isAbsolute(source) || path.dirname(source) === postersDir()) return item
  try {
    const stat = fs.statSync(source)
    if (!stat.isFile() || stat.size > MAX_POSTER_BYTES || !isPosterExt(source)) return item
    const bytes = fs.readFileSync(source)
    const target = path.join(postersDir(), createHash('sha256').update(bytes).digest('hex').slice(0, 24) + path.extname(source).toLowerCase())
    if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    return { ...item, poster_path: target }
  } catch { return item }
}
export const videoCountsOf = (): VideoCounts => videoCounts(getDb(), hideHentai())
export const getVideoLibrary = (id: string) => {
  const library = getVideoWorkLibrary(getDb(), id)
  return { ...library, contents: library.contents.filter(registeredVideoContent).map(cacheLocalPoster) }
}
export const listVideoEpisodes = (id: string): Episode[] => listEpisodes(getDb(), id).map(cacheLocalPoster)
export const getVideoEpisode = (episodeId: string): Episode | null => {
  const episode = getEpisode(getDb(), episodeId)
  return episode ? cacheLocalPoster(episode) : null
}
export const nextVideoEpisode = (id: string, season: number, episode: number): Episode | null =>
  nextEpisode(getDb(), id, season, episode)

export function updateVideoItem(id: string, patch: Partial<VideoItem>): VideoItem | null {
  updateVideo(getDb(), id, patch)
  return getVideoItem(id)
}

/**
 * 撤掉几个字段的「用户改过」标记，让它们下次重扫时重新跟着刮削走。
 * 传空数组 = 全撤。不改现在的值，见 `db.ts` 的 `restoreScrapedFields`。
 */
export function restoreVideoScraped(id: string, fields: string[] = []): VideoItem | null {
  restoreScrapedFields(getDb(), id, fields)
  return getVideoItem(id)
}

/**
 * 改一集的观看进度。改完把整部剧的状态刷一遍。
 *
 * 两件事必须一起做：用户标完最后一集「看完」，剧一级的状态就该变成「看完」，
 * 否则侧栏「在看」那个格子永远清不空，而他不知道还差什么。
 * 推导规则见 `db.ts` 的 `deriveSeriesStatus`（dropped 不参与推导）。
 */
export function updateVideoEpisode(episodeId: string, patch: Partial<Episode>): Episode | null {
  const d = getDb()
  const updated = updateEpisode(d, episodeId, patch)
  if (updated) syncSeriesStatus(d, updated.resource_id)
  if (updated && d.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(updated.resource_id)) persistVideoWorkBundle(d, updated.resource_id)
  return updated ? cacheLocalPoster(updated) : null
}

export async function searchVideoSource(query: string) {
  if (typeof query !== 'string' || !query.trim() || query.length > 240) throw new Error('请输入作品名（最多 240 字）')
  return hanimeSearch(query.trim(), newBudget())
}

/** An explicit source choice affects exactly the selected episode. */
export async function scrapeVideoEpisode(resourceId: string, episodeId = '', source = '') {
  const d = getDb(), item = getVideo(d, resourceId)
  if (!item) throw new Error('作品不存在')
  let episode = episodeId ? getEpisode(d, episodeId) : null
  if (episodeId && episode?.resource_id !== resourceId) throw new Error('单集不属于当前作品')
  const originalLibrary = getVideoWorkLibrary(d, resourceId)
  if (!episode) {
    if (originalLibrary.contents.length > 1) throw new Error('请在作品内容中选择要绑定的那一集')
    episode = originalLibrary.contents[0] || null
  }
  const initialEpisode = episode
  const artworkRevision = posterRevisions.get(episode?.id || resourceId) ?? 0
  const metadataStamp = (ep: Episode | null) => ep ? JSON.stringify([ep.resource_id,ep.title,ep.original_title,ep.description,ep.tags,ep.source_url,ep.published_at,ep.air_date,ep.duration_sec,ep.studio]) : ''
  const initialStamp = metadataStamp(episode)
  const linked = episode ? d.prepare("SELECT external_id FROM video_sources WHERE episode_id = ? AND provider = 'hanime'").get(episode.id) as { external_id: string } | undefined : undefined
  const rawSource = String(source || linked?.external_id || episode?.source_url || (!episode ? item.hanime_id : '')).trim()
  const code = /^\d{1,20}$/.test(rawSource) ? rawSource : toVideoCode(rawSource)
  if (!code) throw new Error('请先按片名搜索并选择来源，或填写 Hanime 视频链接')
  const checkSource = () => {
    const conflict = d.prepare("SELECT resource_id,episode_id FROM video_sources WHERE provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").all(code) as Array<{ resource_id: string; episode_id: string }>
    if (conflict.some(row => row.resource_id !== resourceId || episode && row.episode_id !== episode.id)) throw new Error('该来源已属于其他单集，请先核对或合并作品')
  }
  checkSource()
  const info = await loadVideoWork(code), details = info.currentEpisode
  if (!details || details.videoCode !== code) throw new Error('未能取得所选单集资料')
  if (!getVideo(d,resourceId) || initialEpisode && metadataStamp(getEpisode(d,initialEpisode.id)) !== initialStamp
    || !initialEpisode && listEpisodes(d,resourceId).length) throw new Error('单集或资料已变化，请重新选择来源')
  checkSource()
  d.exec('SAVEPOINT episode_source')
  try {
  if (!episode) {
    if (!episode) {
      registerVideoContent(d, { resourceId, title: item.name_zh || item.file_name, items: [{ title: details.title, order: 1,
        sources: [{ provider: 'hanime', externalId: code, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' }],
        files: originalLibrary.assets.filter(a => a.role === 'video').map(a => ({ path: a.path, size: a.file_size, quality: a.quality })) }] })
      episode = listEpisodes(d, resourceId)[0]
    }
  }
  if (!episode) throw new Error('未找到可绑定的内容项')
    if (source) d.prepare("DELETE FROM video_sources WHERE episode_id = ? AND provider = 'hanime'").run(episode.id)
    bindVideoSource(d, resourceId, { provider: 'hanime', externalId: code, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: source ? 'confirmed' : 'legacy' }, episode.id)
    updateEpisode(d, episode.id, { title: details.title, original_title: details.originalTitle, description: details.description,
      published_at: details.publishedAt || undefined, air_date: details.releaseDate || undefined, studio: details.artist || undefined,
      duration_sec: episode.duration_sec || details.durationSec || undefined,
      original_description: details.description, tags: details.tags || info.tags, poster_source: details.posterUrl,
      thumbnail_source: details.thumbnailUrl, source_url: 'https://hanime1.me/watch?v=' + code })
    d.prepare("UPDATE video_meta SET hanime_id = ? WHERE resource_id = ? AND (hanime_id = '' OR video_type = 'movie')").run(code, resourceId)
    if (listEpisodes(d, resourceId).length === 1) updateVideo(d, resourceId, { category: HENTAI_CATEGORY, name_zh: details.title,
      name_en: details.originalTitle, description: details.description, hanime_tags: details.tags || info.tags,
      poster_source: details.posterUrl, thumbnail_source: details.thumbnailUrl })
    clearVideoScanIgnores(d, resourceId, [episode.path, ...originalLibrary.assets.filter(a => a.role === 'video' && originalLibrary.contents.length <= 1).map(a => a.path)].filter(Boolean),
      [{ provider: 'hanime', externalId: code, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v='+code, evidence: 'confirmed' }])
    d.exec('RELEASE SAVEPOINT episode_source')
  } catch (error) { d.exec('ROLLBACK TO SAVEPOINT episode_source'); d.exec('RELEASE SAVEPOINT episode_source'); throw error }
  const warnings: string[] = []
  if (details.posterUrl || details.thumbnailUrl) {
    const result = await downloadArtworkPair(episode.id, details, episode.id, false, artworkRevision, resourceId)
    if (!result.ok) warnings.push(result.message)
  }
  const refreshed = getEpisode(d, episode.id)
  if (!refreshed || refreshed.resource_id !== resourceId) throw new Error('单集归属已变化，请重新打开资料')
  if (listEpisodes(d, resourceId).length === 1) {
    for (const field of ['poster_path', 'thumbnail_path'] as const) if (refreshed[field] && !(field === 'poster_path' && getVideo(d,resourceId)?.user_edited.includes(field))) d.prepare(`UPDATE video_meta SET ${field} = ? WHERE resource_id = ?`).run(refreshed[field], resourceId)
  }
  if (d.prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(resourceId)) warnings.push(...persistVideoWorkBundle(d, resourceId).warnings)
  return { episode: getVideoEpisode(episode.id), item: getVideoItem(resourceId), warnings }
}

export function setVideoEpisodeArtwork(episodeId: string, file: string, role: 'poster' | 'thumbnail') {
  const episode = getEpisode(getDb(), episodeId)
  if (!episode || !['poster', 'thumbnail'].includes(role)) throw new Error('单集或图片用途无效')
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > MAX_POSTER_BYTES || !isPosterExt(file)) throw new Error('请选择有效的图片文件')
  const cached = cacheLocalPoster({ poster_path: file }).poster_path!
  posterRevisions.set(episodeId, (posterRevisions.get(episodeId) || 0) + 1)
  return updateVideoEpisode(episodeId, { [role + '_path']: cached })
}

/**
 * 从库里移除。`video_meta` 和 `episode` 靠 ON DELETE CASCADE 跟着走。
 *
 * 不动磁盘上的视频文件 —— 和 `removeGame` 同一个约定：从抱一里移除一条记录，
 * 不等于用户愿意删掉那个几十 GB 的文件。
 */
export async function removeVideo(id: string): Promise<void> {
  await applyVideoRemoval(getDb(), previewVideoRemoval(getDb(), { resourceIds: [id], action: 'remove', deleteLocal: false }))
}

/** Resource shape and display type are independent: never execute a media file while revealing it. */
export function revealVideo(id: string): void {
  const item = getVideo(getDb(), id)
  if (!item?.path) return
  if (!existsSync(item.path)) return
  if (fs.statSync(item.path).isDirectory()) shell.openPath(item.path)
  else shell.showItemInFolder(item.path)
}

/* ------------------------------ 播放 ------------------------------ */

/**
 * 播放一个结果。`ok` 为 false 时 `message` 一定有内容 —— 界面直接显示它。
 *
 * 和 `revealVideo` 那几个 `return` 的区别是有意的：打开文件夹失败了用户
 * 自己能看出来（资源管理器没弹出来），而播放失败很容易被当成「点了没反应」。
 * v0.7 之前详情页上没有播放键，就是因为不想给一个点了没反应的按钮。
 */
export interface PlayOutcome {
  ok: boolean
  message: string
  /** 播放后的条目（观看状态可能从「未看」变成了「在看」）。失败时是 null */
  item: VideoItem | null
  /** 剧集：实际开的那一集。电影和失败时是 null */
  episode: Episode | null
}

/**
 * 交给系统默认播放器。**这就是 v0.7「播放」的全部实现。**
 *
 * 待拍板那一处（外置 mpv + IPC 拿真实进度）没有走，理由记在
 * `v0.7-进度.md`：v0.6 已经证明「猜一个会过期的判断写进库」比不写更糟，
 * 而 mpv 那条路本机连 mpv 都没装，发出去等于没测过。默认播放器这条无论如何
 * 都得有 —— 用 PotPlayer 的人不会为了进度条去换播放器。
 *
 * `shell.openPath` 的返回值是**空串表示成功**，出错时是一句错误描述。
 * 这个约定反直觉，但它是 Electron 的，别「修」成 boolean。
 */
async function openWithPlayer(filePath: string): Promise<string> {
  if (!filePath) return '这一条没有记下文件路径'
  if (!existsSync(filePath)) return `文件不在了：${filePath}`
  // 目录也能走到这儿（剧集的 path 是目录）。调用方保证传的是文件，
  // 这里不再判一次 —— 判了也只能给同一句话
  const err = await shell.openPath(filePath)
  // 最常见的失败是没有关联播放器，Windows 给的原文是英文的，补一句中文
  if (err) return `打不开：${err}（可能没有关联的播放器）`
  return ''
}

/**
 * 开一集，并把它标成「在看」。
 *
 * **只从 unwatched 改成 watching，其它状态一律不动。** 用户打开了这个文件是
 * 一个确定的事实，所以从「未看」改过来是有依据的；而「他看完了没有」我们
 * 不知道 —— 外部播放器不回报任何东西。标过 watched 的重看、标过 dropped 的
 * 又点开一次，都不该被这一下悄悄改掉。
 */
export async function playVideoEpisode(episodeId: string): Promise<PlayOutcome> {
  const d = getDb()
  const ep = getEpisode(d, episodeId)
  if (!ep) return { ok: false, message: '找不到这一集', item: null, episode: null }

  const err = await openWithPlayer(ep.path)
  if (err) return { ok: false, message: err, item: null, episode: ep }

  const patch: Partial<Episode> = { watched_at: Date.now() }
  if (ep.watch_status === 'unwatched') patch.watch_status = 'watching'
  const updated = updateVideoEpisode(episodeId, patch)

  return {
    ok: true,
    message: '',
    item: getVideo(d, ep.resource_id),
    episode: updated ?? ep
  }
}

/**
 * 在一个条目上点播放。电影开本体，剧集开「该接着看的那一集」。
 *
 * 剧集挑哪一集见 `db.ts` 的 `resumeEpisode`。挑集这件事放在库那一层而不是
 * 界面上，是因为侧栏「在看」那一格将来也要能一键接着看 —— 两处各写一份
 * 挑选规则，迟早出现「详情页开第 5 集、侧栏开第 3 集」。
 */
export async function playVideo(id: string): Promise<PlayOutcome> {
  const d = getDb()
  const item = getVideo(d, id)
  if (!item) return { ok: false, message: '找不到这个条目', item: null, episode: null }

  if (item.video_type === 'series') {
    const ep = resumeEpisode(d, id)
    if (!ep) {
      return {
        ok: false,
        // 这句话得说清是「没文件」而不是「坏了」：TMDB 补出来的集表可能
        // 有 16 集而磁盘上一个文件都没有，那时候详情页看着满满的
        message: '这部剧在磁盘上还没有任何一集的文件',
        item,
        episode: null
      }
    }
    return playVideoEpisode(ep.id)
  }

  const err = await openWithPlayer(item.path)
  if (err) return { ok: false, message: err, item, episode: null }

  // 电影的进度记在 video_meta 上，见 schema.ts。同样只从 unwatched 抬到 watching
  const patch: Partial<VideoItem> = { last_watched_at: Date.now() }
  if (item.watch_status === 'unwatched') patch.watch_status = 'watching'
  return { ok: true, message: '', item: updateVideo(d, id, patch) ?? item, episode: null }
}

/**
 * 在资源管理器里选中一个外挂字幕文件。
 *
 * 为什么要这个：字幕对不上的时候用户要做的事是去那个目录里换一个文件，
 * 而外挂字幕可能和视频不在同一层（`Subs/` 子目录是常见摆法）。
 * 详情页上把路径显示出来还不够 —— 那还得用户自己去翻。
 *
 * 只认这个条目自己名下的字幕路径，不接受任意路径：这个通道从渲染进程过来，
 * 而 `showItemInFolder` 能打开任何位置。
 */
export function revealSubtitle(id: string, target: string): boolean {
  const item = getVideo(getDb(), id)
  if (!item) return false
  const own = item.subtitle_tracks.some((t) => t.path && t.path === target)
  if (!own || !existsSync(target)) return false
  shell.showItemInFolder(target)
  return true
}

/* ------------------------------ 扫描识别 ------------------------------ */

/** 把 agent 的动作翻译成用户看得懂的一行字。同 game/service.ts 的同名函数 */
function describeEvent(e: AgentEvent): string {
  if (e.type !== 'tool_call') return ''
  const args = e.args as Record<string, any>
  switch (e.name) {
    case 'tmdb_search':
      return `搜 TMDB「${args.query ?? ''}」`
    case 'tmdb_detail':
      return `取 TMDB 详情 ${args.tmdb_id ?? ''}`
    case 'tmdb_find':
      return `按 ${args.external_id ?? ''} 反查 TMDB`
    case 'register_video':
      return `识别出「${args.name_zh ?? '?'}」`
    case 'skip_entry':
      return `跳过（${args.reason ?? ''}）`
    case 'douban_search':
      return `查豆瓣「${args.title ?? ''}」`
    case 'web_search':
      return `联网搜索「${args.query ?? ''}」`
    default:
      return `调用 ${e.name}`
  }
}

/**
 * 扫一批目录，串行读取本地事实并直接入库；资料不足时标记待复查。
 * 首轮不调用 Agent。重复扫描沿用已有归属，保留手动资料和观看进度；
 * 用户明确选择重新识别时，才通过 identifyOne 的 force 分支调用 Agent。
 */
export function importVideoBundle(directory: string, restoreRemoved = false) {
  const registered = registerVideoBundle(getDb(), directory, restoreRemoved)
  if (restoreRemoved && registered.resourceId) {
    try { registered.warnings = [...registered.warnings || [], ...persistVideoWorkBundle(getDb(), registered.resourceId, directory).warnings] }
    catch (error) { registered.warnings = [...registered.warnings || [], '已入库，本地清单待保存：' + String(error)] }
  }
  return registered
}

/** Explicit scratch context: no global DB swap, artwork download or sidecar writes. */
export interface VideoImportRuntime {
  db: SqlDb
  signal: AbortSignal
  capture: (command: VideoImportCommand) => void
  log: (path: string, text: string) => void
  sourceId?: string
}

export async function scanVideos(
  dirs: string[],
  onProgress: (p: VideoScanProgress) => void,
  restoreRemoved = false,
  runtime?: VideoImportRuntime
): Promise<VideoScanResult> {
  if (!runtime) controller = new AbortController()
  const signal = runtime?.signal || controller!.signal
  const result: VideoScanResult = {
    candidates: 0,
    registered: 0,
    skipped: 0,
    failed: 0,
    tokens: 0,
    episodes: 0,
    searches: 0
  }

  const report = (p: Partial<VideoScanProgress>): void =>
    onProgress({
      phase: 'identifying',
      current: '',
      processed: 0,
      total: result.candidates,
      registered: result.registered,
      failed: result.failed,
      log: '',
      ...p
    })

  /* -------- 第一截：扫目录 -------- */
  const candidates: VideoCandidate[] = []
  const seen = new Set<string>()
  const importedBundles = new Set<string>()
  const underBundle = (file: string) => [...importedBundles].some(dir => path.resolve(file).toLowerCase() === dir || path.resolve(file).toLowerCase().startsWith(dir + path.sep))
  for (const root of dirs) {
    if (signal.aborted) break
    report({ phase: 'scanning', current: root, total: 0 })
    const findBundles = (directory: string, depth: number): void => {
      if (depth > 8 || signal.aborted || !fs.existsSync(directory) || underBundle(directory)) return
      let stat: fs.Stats; try { stat = fs.statSync(directory) } catch { return }
      if (!stat.isDirectory()) return
      if (fs.existsSync(path.join(directory, 'baoyi.json'))) {
        importedBundles.add(path.resolve(directory).toLowerCase())
        result.candidates++
        try {
          const registered = runtime ? registerVideoBundle(runtime.db, directory, restoreRemoved) : importVideoBundle(directory, restoreRemoved)
          if (runtime && registered.resourceId && !registered.skipped) runtime.capture({ kind: 'bundle', path: directory, directory, restoreRemoved })
          if (registered.skipped) result.skipped++
          else { result.registered++; result.episodes += registered.itemsAdded }
          result.entries ||= []; result.entries.push({ path: directory, resourceId: registered.resourceId || undefined, status: registered.skipped ? 'skipped' : registered.created ? 'new' : 'updated', message: [registered.skipped ? '内容已移除，跳过重新入库' : '从资源清单离线导入', ...registered.warnings || []].join('；') })
        } catch (error) { result.failed++; result.entries ||= []; result.entries.push({ path: directory, status: 'failed', message: String(error) }) }
        return
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) findBundles(path.join(directory, entry.name), depth + 1)
    }
    findBundles(root, 0)
    for (const c of scanVideoRoot(root)) {
      if (underBundle(c.path)) continue
      // 两个扫描根有包含关系时，同一个条目会被扫出来两次
      const key = c.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(c)
    }
  }
  const availableCandidates = candidates.filter(c => !underBundle(c.path))
  const rawCandidates = runtime ? groupVideoImportCandidates(runtime.db, availableCandidates) : availableCandidates
  result.candidates += rawCandidates.length
  if (rawCandidates.length === 0 || signal.aborted) {
    report({ phase: 'done', total: result.candidates, processed: result.candidates })
    return result
  }

  /* -------- 第二截：逐个识别 -------- */
  await identifyCandidates(rawCandidates, result, report, signal, undefined, false, restoreRemoved, runtime)

  report({ phase: 'done', processed: result.candidates })
  return result
}

function candidateFiles(candidate: VideoCandidate): string[] {
  return [...new Set([...candidate.files, ...candidate.episodes.flatMap(ep => ep.files)].map(file => file.path))]
}

async function identifyCandidates(
  candidates: VideoCandidate[],
  result: VideoScanResult,
  report: (p: Partial<VideoScanProgress>) => void,
  signal: AbortSignal,
  channelOverride?: HanimeReason,
  force = false,
  restoreRemoved = false,
  runtime?: VideoImportRuntime
): Promise<void> {
  const db = runtime?.db || getDb()
  const planned = candidates.map(candidate => ({
    candidate, files: candidateFiles(candidate),
    owner: videoOwnerForFiles(db, candidateFiles(candidate)), splitFromId: ''
  }))
  const owners = new Set(planned.map(entry => entry.owner?.id).filter(Boolean))
  for (const id of owners) {
    const related = planned.filter(entry => entry.owner?.id === id)
    if (related.length < 2 || managedVideoOwner(db, related.flatMap(entry => entry.files)) === id) continue
    const item = getVideo(db, id!)!
    const previousFiles = [item.path, ...item.parts.map(part => part.path), ...listEpisodes(db, item.id).map(ep => ep.path)]
    const retained = previousFiles.map(file => related.find(entry => entry.files.some(candidate => candidate.toLowerCase() === file.toLowerCase())))
      .find(Boolean) ?? related[0]
    for (const entry of related) if (entry !== retained) entry.splitFromId = item.id
  }

  // Detach other works first, before their old season/episode slots can be reused.
  planned.sort((a, b) => Number(Boolean(b.splitFromId)) - Number(Boolean(a.splitFromId)))
  const blocked = new Set<string>()
  for (const [index, entry] of planned.entries()) {
    if (signal.aborted) break
    if (!entry.splitFromId && entry.owner && blocked.has(entry.owner.id)) {
      result.failed++
      result.entries ||= []; result.entries.push({ path: entry.candidate.path, resourceId: entry.owner.id, status: 'failed', message: '同目录作品尚未完成拆分，请重试扫描' })
      report({ current: entry.candidate.path, processed: index, log: '同目录作品尚未完成拆分，已保留原条目及播放进度，请重试扫描' })
      continue
    }
    const fingerprint = candidateFingerprint(entry.candidate)
    const ignored = !restoreRemoved && entry.files.length && entry.files.every(file => ignoredVideoFile(db, file))
    const known = !force && !entry.splitFromId ? unchangedCandidate(db, entry.candidate, fingerprint) : ''
    if (!force && (ignored || known)) {
      result.skipped++
      const item = known ? getVideo(db, known) : null
      const message = ignored ? '已按用户选择移除，跳过重新入库' : `已在「${item?.name_zh || item?.file_name || '资料库'}」，文件及资料未变化，未调用识别`
      result.entries ||= []; result.entries.push({ path: entry.candidate.path, resourceId: known || undefined, status: 'skipped', message })
      report({ current: entry.candidate.path, processed: index + 1, log: message })
      continue
    }
    const countBefore = result.registered
    await identifyOne(entry.candidate, result, report, signal, index, channelOverride, entry.splitFromId, force, runtime)
    if (runtime && fingerprint !== candidateFingerprint(entry.candidate)) {
      result.failed++; result.entries ||= []
      result.entries.push({ path: entry.candidate.path, status: 'failed', message: '识别期间文件或本地资料已变化，请重新检查目录' })
      continue
    }
    const currentOwner = videoOwnerForFiles(db, entry.files)
    if (result.registered > countBefore && currentOwner) {
      rememberCandidate(db, entry.candidate, fingerprint, currentOwner.id)
      if (force || restoreRemoved) {
        const sources = getVideoWorkLibrary(db, currentOwner.id).contents.filter(ep => entry.files.some(file => file.toLowerCase() === ep.path.toLowerCase())).flatMap(ep => ep.sources)
        clearVideoScanIgnores(db, currentOwner.id, entry.files, sources)
        if (!runtime && db.prepare('SELECT resource_id FROM video_directories WHERE resource_id=?').get(currentOwner.id)) persistVideoWorkBundle(db, currentOwner.id)
      }
    }
    if (entry.splitFromId) {
      const owner = videoOwnerForFiles(db, entry.files)
      if (!owner || owner.id === entry.splitFromId) blocked.add(entry.splitFromId)
    }
  }
}

/**
 * 识别**一个**候选条目。扫描循环和「单条重新识别」共用它。
 *
 * 抽出来不是为了少写几行 —— 是因为这里有一组必须同时成立的约束：
 * prompt 里那段话、挂上去的工具表、里番判据三者必须一致（一份 prompt 配两种
 * 工具表的话，模型会去调一个没注册的工具，白烧一轮；软件那边踩过这个坑）。
 * 两处各写一份的话，改了一处就会走岔，而走岔的表现是「偶尔白烧一轮」，
 * 不报错、不好复现。
 *
 * `channelOverride` 是用户在详情页说「这是里番，按里番刮」时传的 ——
 * 见 `reidentifyVideo`。不传就按判据自己算。
 */
async function identifyOne(
  c: VideoCandidate,
  result: VideoScanResult,
  report: (p: Partial<VideoScanProgress>) => void,
  signal: AbortSignal,
  index: number,
  channelOverride?: HanimeReason,
  splitFromId?: string,
  force = false,
  runtime?: VideoImportRuntime
): Promise<void> {
  const settings = getSettings()
  const withSearch = searchAvailable(settings.search)
  const withTmdb = tmdbAvailable(settings.tmdb)
  // 分类和标签池现读现填，且都按 kind='video' 取 ——
  // 软件的「开发工具」和游戏的「魂系」不能进这个 prompt
  const pool = tagPool('video')
  const categories = listCategories('video')
  const categoryNames = categories.map((c2) => c2.name)
  const db = runtime?.db || getDb()

  report({ current: c.path, processed: index, log: '读本地事实' })

  // 先读取本地文件与容器信息，供离线入库或显式 Agent 复查共同使用。
  const facts = await buildFacts(c)
  facts.hanime_id ||= runtime?.sourceId || ''
  if (signal.aborted) return
  const owner = videoOwnerForFiles(db, candidateFiles(c))
  const knownCategory = videoCategoryOf(db, c.path) || (owner ? getVideo(db, owner.id)?.category ?? '' : '')
  const hanimeReason = channelOverride ?? (facts.hentai ? 'category' :
    ([...facts.files.map(file => file.name), path.basename(c.path)].map(name => hanimeChannel(name, knownCategory)).find(Boolean) || ''))
  facts.hentai ||= !!hanimeReason
  if (!force || !settings.ai.enabled || !settings.ai.api_key.trim()) {
    try {
      const registered = registerLocalVideoFacts(db, facts, splitFromId)
      runtime?.capture({ kind: 'local', path: c.path, candidate: c, facts, splitFromId })
      result.registered++; result.episodes += registered.episodesAdded
      const review = getVideo(db, registered.id)?.needs_review
      const message = review ? '已按本地文件入库，资料不足；可选中后让 Agent 复查' : '已读取本地资料，无需调用 Agent'
      result.entries ||= []; result.entries.push({ path: c.path, resourceId: registered.id, status: review ? 'review' : registered.created ? 'new' : 'updated', message })
      try {
        const item = getVideo(db, registered.id)!
        const details = [message, `名称：${item.name_zh || item.name_en || item.file_name}`,
          item.published_start ? `发布时间：${new Date(item.published_start).toISOString().slice(0,10)}` : '',
          facts.local_metadata?.studio ? `厂牌：${facts.local_metadata.studio}` : '',
          `本地视频：${candidateFiles(c).length} 个`, `本地资料：${[...facts.nfo_files, ...facts.local_metadata?.attachments?.filter(a => /\.(json|nfo)$/i.test(a.path)).map(a => a.path) || []].map(p=>path.basename(p)).join('、') || '文件名与媒体信息'}`]
          .filter(Boolean).join('\n')
        if (runtime) runtime.log(c.path, details)
        else saveIdentifyLog({dir:facts.dir,label:item.name_zh || item.file_name,kind:'item',resource_kind:'video',status:'success',summary:message,
          registered:1,rounds:0,duration_ms:0,tokens:0,stop_reason:'done',events:[{type:'text',text:details}]})
      } catch { /* The completed registration must survive a log storage failure. */ }
      report({ current: c.path, processed: index + 1, log: message })
    } catch (error) { result.failed++; result.entries ||= []; result.entries.push({ path: c.path, status: 'failed', message: String(error) }); report({ log: '本地注册失败：' + String(error) }) }
    return
  }

  const countBefore = result.registered
  const skippedBefore = result.skipped
  const ctx: VideoToolContext = {
    facts,
    db,
    splitFromId,
    tagPool: pool,
    searchConfig: settings.search,
    tmdbConfig: settings.tmdb,
    onPayload: runtime ? (payload, sourceDetails) => runtime.capture({ kind: 'agent', path: c.path, candidate: c, payload, sourceDetails, splitFromId }) : undefined,
    onRegister: async (info) => {
      result.registered++
      result.episodes += info.episodesAdded
      result.entries ||= []; result.entries.push({ path: c.path, resourceId: info.id, status: info.created ? 'new' : 'updated', message: info.created ? '已识别并入库' : '已更新资料' })
      if (runtime || !info.hanime_id) return
      report({ current: c.path, processed: index, log: '下载 Hanime 封面' })
      try {
        const poster = info.episodeId && info.posterUrl ? await fetchVideoEpisodePoster(info.episodeId, info.posterUrl) : await fetchVideoPoster(info.id)
        if (!poster.ok) {
          report({ current: c.path, processed: index, log: `Hanime 封面下载失败：${poster.message}` })
        }
      } catch (err: any) {
        report({ current: c.path, processed: index, log: `Hanime 封面下载失败：${err?.message ?? '未知错误'}` })
      }
    },
    onSkip: (_path, reason) => {
      result.entries ||= []; result.entries.push({ path: c.path, status: 'skipped', message: reason })
      result.skipped++
    },
    // 按次计费的服务商，这个数就是这次扫描的账单。缓存命中不计
    onSearch: () => {
      result.searches++
    }
  }

  // 走不走里番通道。两条判据：库里已有的分类（用户手改过的永久保护，
  // 所以读一次就够）、文件名形状。见 hentai/channel.ts
  if (hanimeReason) {
    report({ current: c.path, processed: index, log: `走 hanime 通道（${hanimeReason}）` })
  }

  const trail: AgentEvent[] = []
  const run = await runAgent({
    config: settings.ai,
    system: fillVideoSystem(categories, pool, withSearch, withTmdb, hanimeReason),
    user: videoCandidatePrompt(facts, videosUnder(db, facts.dir)),
    tools: buildVideoTools(ctx, categoryNames, withSearch, withTmdb, hanimeReason !== ''),
    maxTurns: MAX_TURNS,
    signal,
    onEvent: (e) => {
      trail.push(e)
      if (runtime && (e.type === 'text' || e.type === 'tool_call')) runtime.log(c.path, e.type === 'text' ? e.text : describeEvent(e))
      report({ current: c.path, processed: index, log: describeEvent(e) })
    }
  })
  result.tokens += run.tokens

  // 落识别日志
  if (run.stopReason !== 'aborted' && !runtime) {
    const status = run.stopReason === 'error' ? 'failed' : result.registered > countBefore ? 'success' : 'skipped'
    const note = run.stopReason === 'error' ? '识别过程出错' :
                 run.stopReason === 'max_turns' ? '达到轮数上限' :
                 result.registered > countBefore ? '已注册' : '未注册任何条目'

    try {
      saveIdentifyLog({
        dir: facts.dir,
        label: path.basename(facts.dir),
        kind: 'unit',
        resource_kind: 'video',
        status,
        summary: note,
        registered: result.registered > countBefore ? 1 : 0,
        rounds: run.turns,
        duration_ms: 0,
        tokens: run.tokens,
        stop_reason: run.stopReason,
        events: trail
      })
    } catch {
      /* 日志写不进去不该让识别结果跟着失败 */
    }
  }

  if (run.stopReason === 'error') { result.failed++; result.entries ||= []; result.entries.push({ path: c.path, status: 'failed', message: '识别失败，可在详情中重试或绑定来源' }) }
  else if (result.registered === countBefore && result.skipped === skippedBefore) result.skipped++
}

export async function reviewVideoImportCandidate(command: VideoImportCommand, runtime: VideoImportRuntime,
  onProgress: (progress: VideoScanProgress) => void): Promise<VideoScanResult> {
  if (command.kind === 'bundle') throw new Error('资源清单请先确认入库，再按所选作品补资料')
  const readiness = videoScanReadiness(true)
  if (!readiness.ok) throw new Error(readiness.message)
  const result: VideoScanResult = { candidates: 1, registered: 0, skipped: 0, failed: 0, episodes: 0, searches: 0, tokens: 0 }
  await identifyOne(command.candidate, result, progress => onProgress({ phase: 'identifying', current: command.path,
    processed: 0, total: 1, registered: result.registered, failed: result.failed, log: '', ...progress }), runtime.signal, 0, undefined, command.splitFromId, true, runtime)
  return result
}

/** Enrich only the selected registered content. Artwork-only never replays Agent metadata. */
export async function enrichVideoWithAgent(id: string, actions: { artwork: boolean; metadata: boolean }, scratch: SqlDb,
  signal: AbortSignal, report: (message: string) => void): Promise<{ tokens: number; message: string; ok: boolean }> {
  const db = getDb(), item = getVideo(db, id)
  if (!item || item.is_archived) throw new Error('作品已变化，请重新选择')
  const library = getVideoWorkLibrary(db, id), contents = library.contents.filter(registeredVideoContent)
  const targets = contents.length ? contents.map(episode => ({ episodeId: episode.id, title: episode.title,
    files: [...new Set([episode.path, ...episode.assets.filter(asset => asset.role === 'video').map(asset => asset.path)].filter(Boolean))],
    code: episode.sources.find(source => source.provider === 'hanime')?.externalId || '' }))
    : [{ episodeId: '', title: item.name_zh || item.file_name, files: [...new Set(library.assets.filter(asset => asset.role === 'video').map(asset => asset.path))], code: item.hanime_id }]
  let tokens = 0, completed = 0; const failures: string[] = []
  for (const target of targets) {
    if (signal.aborted) break
    try {
      let episodeId = target.episodeId
      const current = episodeId ? getEpisode(db, episodeId) : getVideo(db, id)
      const havePoster = !!current?.poster_path && isLocalPoster(current.poster_path) && fs.existsSync(current.poster_path)
      if (!actions.metadata && havePoster) { completed++; continue }
      if (!actions.metadata && actions.artwork && target.code) {
        report('按已有来源补封面：' + target.title)
        try {
          const source = await loadVideoWork(target.code)
          if (signal.aborted) break
          const image = await downloadArtworkPair(episodeId || id, source.currentEpisode || source, episodeId || undefined, havePoster,
            posterRevisions.get(episodeId || id) ?? 0, episodeId ? id : undefined)
          if (image.ok) { completed++; continue }
        } catch { /* Let the explicit Agent request inspect alternative source evidence. */ }
      }
      const ready = videoScanReadiness(true)
      if (!ready.ok) throw new Error(ready.message)
      const files = target.files.flatMap(file => {
        try {
          const stat = fs.statSync(file)
          return stat.isFile() ? [{ path: file, name: path.basename(file), size: stat.size, parsed: parseVideoName(path.basename(file)), part: null }] : []
        } catch { return [] }
      })
      if (!files.length) throw new Error('已录入的视频文件当前不可用，请连接对应磁盘或检查文件')
      const c: VideoCandidate = { path: files[0].path, directory: path.dirname(files[0].path), video_type: 'movie', title_zh: target.title, title_en: '', year: item.year,
        files, episodes: [], sidecars: { nfo: [], images: [], subtitles: [] }, extras: [], evidence: ['用户选择此内容补充资料或封面；仅处理本条视频'] }
      const stamp = videoImportLibraryStamp(db), fileStamp = candidateFingerprint(c), commands: VideoImportCommand[] = []
      const result: VideoScanResult = { candidates: 1, registered: 0, skipped: 0, failed: 0, episodes: 0, searches: 0, tokens: 0 }
      report('Agent 正在查找：' + target.title)
      await identifyOne(c, result, progress => { if (progress.log) report(progress.log) }, signal, 0, item.category === HENTAI_CATEGORY ? 'category' : undefined,
        undefined, true, { db: scratch, signal, sourceId: target.code, capture: command => commands.push(command), log: (_path, text) => report(text) })
      tokens += result.tokens
      if (signal.aborted) break
      const command = commands.findLast(command => command.kind === 'agent')
      if (result.failed || !command || command.kind !== 'agent') throw new Error('Agent 未找到可用资料，原记录保留')
      if (videoImportLibraryStamp(db) !== stamp || candidateFingerprint(c) !== fileStamp) throw new Error('识别期间作品或文件已变化，未写入过期结果')
      const payload = command.payload, details = command.sourceDetails
      if (actions.metadata) {
        const existing = episodeId ? getEpisode(db, episodeId) : null
        registerVideoContent(db, { resourceId: id, title: item.name_zh || item.file_name, description: payload.description || payload.summary,
          items: [{ id: episodeId || undefined, title: existing?.title || payload.name_zh, season: existing?.season || 0, number: existing?.episode ?? 1, order: existing?.episode ?? 1,
            description: payload.description || payload.summary, originalDescription: payload.original_description, originalTitle: payload.name_en, tags: payload.hanime_tags?.length ? payload.hanime_tags : payload.tags,
            publishedAt: details?.publishedAt, airDate: details?.releaseDate, studio: details?.artist, durationSec: payload.duration_sec,
            sources: payload.hanime_id ? [{ provider: 'hanime', externalId: payload.hanime_id, scope: 'episode', pageUrl: 'https://hanime1.me/watch?v=' + payload.hanime_id, evidence: 'legacy' }] : [],
            files: files.map(file => ({ path: file.path, size: file.size })) }] })
        episodeId ||= listEpisodes(db, id).find(episode => target.files.includes(episode.path))?.id || ''
      }
      if (actions.artwork && !havePoster) {
        report('正在下载封面：' + target.title)
        const image = /^https?:/i.test(payload.poster_path)
          ? await downloadArtworkPair(episodeId || id, { posterUrl: payload.poster_path, thumbnailUrl: details?.thumbnailUrl, artworkUrls: details?.artworkUrls }, episodeId || undefined, false, posterRevisions.get(episodeId || id) ?? 0, episodeId ? id : undefined)
          : await downloadPoster(episodeId || id, payload.poster_path, 'tmdb', posterRevisions.get(episodeId || id) ?? 0, episodeId || undefined)
        if (!image.ok) throw new Error(image.message || '来源没有可用封面')
      }
      completed++
    } catch (cause) { failures.push(target.title + '：' + (cause instanceof Error ? cause.message : String(cause))) }
  }
  const cover = listEpisodes(db, id).find(episode => episode.poster_path && isLocalPoster(episode.poster_path) && fs.existsSync(episode.poster_path))
  const latest = getVideo(db, id)
  if (actions.artwork && cover && latest && !latest.user_edited.includes('poster_path') && (!latest.poster_path || !fs.existsSync(latest.poster_path))) {
    db.prepare('UPDATE video_meta SET poster_path=?,poster_source=?,thumbnail_path=?,thumbnail_source=? WHERE resource_id=?')
      .run(cover.poster_path, cover.poster_source || '', cover.thumbnail_path || '', cover.thumbnail_source || '', id)
  }
  return { tokens, ok: !failures.length && !signal.aborted, message: `已处理 ${completed}/${targets.length} 项内容` + (failures.length ? '；' + failures.join('；') : '') }
}

/**
 * 重新识别**已在库里**的一条，可以指定按里番通道刮。
 *
 * ## 为什么非要有这个入口
 *
 * v0.8 的里番通道有两条判据，第一条是「分类已经是里番」，理由写着「用户手改
 * 一次分类，下次识别就命中了」。**但那个「下次识别」在界面上不存在** ——
 * 影视模块从来没有单条重新识别（只有软件详情页有），用户改完分类没有任何办法
 * 让它重刮。于是那条判据在实际使用中等于不存在，而文档里写着它管用。
 *
 * `forceHentai` 比「改分类再重识别」更直接：用户看着这一条说「这是里番」，
 * 那就不必再绕分类和判据一圈。判据是启发式的，用户说的话不是。
 *
 * ## 为什么重扫一次目录而不是直接拿库里的记录
 *
 * 识别要的是**本地事实**（容器元数据、季集、侧车文件），那些只有走一遍扫描器
 * 才拿得到，而库里存的是识别**结果**。拿结果当输入等于让第二次识别继承第一次
 * 的错。
 */
export async function reidentifyVideo(
  id: string,
  forceHentai: boolean = false,
  onProgress: (p: VideoScanProgress) => void = () => {}
): Promise<VideoItem | null> {
  let item = getVideo(getDb(), id)
  if (!item) {
    onProgress({ phase: 'done', current: '', processed: 0, total: 0, registered: 0, failed: 0, log: '找不到这个视频条目' })
    return null
  }

  try {
    if (getDb().prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(id)) {
      const synced = syncVideoWorkFiles(getDb(), id, { roots: getSettings().video_scan_dirs })
      onProgress({ phase: 'identifying', current: item.path, processed: 0, total: 1, registered: 0, failed: 0, log: synced.message })
      item = getVideo(getDb(), id)!
      if (item.hanime_id) return await refreshManagedVideoEpisodes(id, onProgress)
    }
  } catch (error) {
    onProgress({ phase: 'done', current: item.path, processed: 0, total: 1, registered: 0, failed: 1, log: String(error) })
    return null
  }

  const ready = videoScanReadiness(true)
  if (!ready.ok) {
    onProgress({ phase: 'done', current: item.path, processed: 0, total: 0, registered: 0, failed: 0, log: ready.message || 'AI 未配置' })
    return null
  }

  controller = new AbortController()
  const signal = controller.signal
  const result: VideoScanResult = {
    candidates: 0,
    registered: 0,
    skipped: 0,
    failed: 0,
    tokens: 0,
    episodes: 0,
    searches: 0
  }
  const report = (p: Partial<VideoScanProgress>): void =>
    onProgress({
      phase: 'identifying',
      current: item.path,
      processed: 0,
      total: Math.max(1, result.candidates),
      registered: result.registered,
      failed: result.failed,
      log: '',
      ...p
    })

  let narrow = item.source_dir || path.dirname(item.path)
  try { narrow = fs.statSync(item.path).isDirectory() ? item.path : path.dirname(item.path) } catch { /* 后续报告文件缺失 */ }
  const key = item.path.toLowerCase()
  const belongs = (c: VideoCandidate): boolean => c.path.toLowerCase() === key ||
    videoOwnerForFiles(getDb(), candidateFiles(c))?.id === id
  let candidates = scanVideoRoot(narrow).filter(belongs)
  if (!candidates.length) {
    candidates = scanVideoRoot(path.dirname(narrow)).filter(belongs)
  }
  if (!candidates.length) {
    report({ phase: 'done', processed: 1, log: '扫描找不到这个文件，可能已被移动或删除' })
    return null
  }

  result.candidates = candidates.length
  await identifyCandidates(candidates, result, report, signal, forceHentai ? 'category' : undefined, true)
  try { if (getDb().prepare('SELECT resource_id FROM video_directories WHERE resource_id = ?').get(id)) persistVideoWorkBundle(getDb(), id) }
  catch (error) { report({ log: '单集已更新，本地资料待保存：' + String(error) }) }
  report({ phase: 'done', processed: candidates.length, total: candidates.length })

  return getVideoItem(id)
}

/** Known source IDs bypass ambiguous filename searches and only refresh that episode. */
async function refreshManagedVideoEpisodes(id: string, onProgress: (p: VideoScanProgress) => void): Promise<VideoItem | null> {
  const db = getDb(), item = getVideo(db, id)!
  controller = new AbortController()
  const signal = controller.signal
  let registered = 0, failed = 0
  const report = (log: string, processed: number, total: number, done = false) => onProgress({ phase: done ? 'done' : 'identifying', current: item.path, processed, total, registered, failed, log })
  report('按已确认的来源读取合集目录', 0, 1)
  const first = await loadVideoWork(item.hanime_id, { signal })
  const applied = applyVideoCatalogue(db, id, first)
  const codes = [...new Set(applied.catalogue.episodes.map(ep => ep.videoCode))]
  for (const [index, code] of codes.entries()) {
    if (signal.aborted) break
    const entry = applied.catalogue.episodes.find(ep => ep.videoCode === code)!
    report('更新单集资料 · ' + entry.title, index, codes.length)
    try {
      const info = code === first.videoCode ? first : await loadVideoWork(code, { signal })
      const details = info.currentEpisode
      if (!details || details.videoCode !== code) throw new Error('单集来源编号不一致')
      const row = db.prepare("SELECT episode_id FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND episode_id IS NOT NULL").get(id, code) as { episode_id: string } | undefined
      if (!row) throw new Error('单集尚未建立来源关联')
      fillEpisodeDetails(db, row.episode_id, { tags: details.tags || info.tags, posterSource: details.posterUrl, thumbnailSource: details.thumbnailUrl, originalTitle: details.originalTitle, description: details.description, sourceUrl: 'https://hanime1.me/watch?v=' + code })
      if (details.posterUrl || details.thumbnailUrl) {
        const poster = await downloadArtworkPair(row.episode_id, details, row.episode_id, false, undefined, id)
        if (!poster.ok) report('单集封面待补全：' + poster.message, index, codes.length)
      }
      registered++
    } catch (error) { failed++; report('单集资料更新失败：' + String(error), index, codes.length) }
  }
  const saved = persistVideoWorkBundle(db, id)
  report(`已更新 ${registered} 集资料` + (failed ? `，${failed} 集待重试` : '') + (saved.warnings.length ? '；' + saved.warnings[0] : ''), codes.length, codes.length, true)
  return getVideoItem(id)
}

/**
 * 设置页和库首页共用预检。普通扫描无需 AI；显式复查才检查模型配置。
 */
export function videoScanReadiness(forAgent = false): { ok: boolean; message: string } {
  if (!forAgent) return { ok: true, message: '' }
  const s = getSettings()
  if (!s.ai.enabled || !s.ai.api_key.trim()) {
    return { ok: false, message: 'Agent 复查需要先在设置中启用并配置 AI；本地扫描无需配置。' }
  }
  return { ok: true, message: '' }
}

/** 视频条目所在目录里已注册的那些。给 UI 提示重复用 */
export const videosInDir = (dir: string): Array<{ name: string; path: string }> =>
  videosUnder(getDb(), path.resolve(dir))

/* ------------------------------- 海报 ------------------------------- */

const NET_TIMEOUT = 20_000

/**
 * 海报相关的网络请求走 `net.fetch`，不用全局 `fetch`。理由和游戏封面那边一字不差
 * （见 `kinds/game/service.ts` 的同名函数）：它认系统代理，而且和渲染进程加载
 * `<img>` 走同一条路 —— 用另一条路「验证过」的地址，在页面里未必显示得出来。
 *
 * 对影视这边还多一层：TMDB 的图片域名在国内基本连不上，用户填反代是常态，
 * 而反代往往就配在系统代理里。
 */
async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return net.fetch(url, { ...init, signal: AbortSignal.timeout(NET_TIMEOUT) })
}

/** 清掉这个条目在海报目录里的所有文件（含换过扩展名留下的孤儿） */
function dropPosterFiles(id: string, keep = ''): void {
  const dir = postersDir()
  for (const name of posterSiblings(id)) {
    if (name === keep) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* 正被渲染进程占用之类，删不掉就留着，下次换海报会覆盖 */
    }
  }
}

/**
 * 把一张本地图片装成这个条目的海报：拷进 userData 下的 posters/，再写库。
 *
 * 拷而不是记原路径，理由和游戏封面同一条，而对影视更硬：海报的来路多半是
 * 片子**同目录**里的 `poster.jpg`，而那个目录很可能在一块没插的移动硬盘上。
 * 记路径的话，硬盘一拔整墙破图。加上打包后页面跑在 `file://` 下，
 * `<img src="D:\...">` 根本加载不出来，必须走 `baoyi://` 协议，
 * 而那个协议只在白名单目录里找文件（见 main.ts）。
 */
export function setVideoPoster(id: string, source: string, manual = true): { ok: boolean; message: string } {
  if (!getVideo(getDb(), id)) return { ok: false, message: '找不到这个条目' }

  const from = path.resolve(source)
  if (!isPosterExt(from)) return { ok: false, message: `只认这些格式：${POSTER_EXTS.join('、')}` }
  if (!existsSync(from)) return { ok: false, message: '这个文件不在了' }

  const name = posterFileName(id, from)
  const target = path.join(postersDir(), name)
  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    // 先准备新图，复制失败时原封面仍然完整；同一缓存文件不先删再拷。
    if (from !== target) {
      fs.copyFileSync(from, temporary)
      fs.renameSync(temporary, target)
    }
  } catch (err: any) {
    return { ok: false, message: `拷贝失败：${err?.message ?? '未知错误'}` }
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* 留待临时文件清理 */ }
  }

  dropPosterFiles(id, name)
  posterRevisions.set(id, (posterRevisions.get(id) ?? 0) + 1)
  updateVideo(getDb(), id, { poster_path: target })
  if (manual) { const item = getVideo(getDb(), id)!; getDb().prepare('UPDATE video_meta SET user_edited = ? WHERE resource_id = ?').run(JSON.stringify([...new Set([...item.user_edited, 'poster_path'])]), id) }
  return { ok: true, message: '海报已更换' }
}

/** 撤掉海报，退回首字占位。磁盘上那份拷贝一起删 */
export function clearVideoPoster(id: string): VideoItem | null {
  posterRevisions.set(id, (posterRevisions.get(id) ?? 0) + 1)
  dropPosterFiles(id)
  return updateVideo(getDb(), id, { poster_path: '' })
}

/**
 * 列一个目录里的图片文件（不递归）。
 *
 * 只看一层是刻意的：海报按约定就躺在片子旁边。往下递归会把剧集里每一季目录的
 * 季海报、甚至每一集的缩略图全捞上来，而那些图挑出来当整部剧的海报是错的。
 */
function imagesBesideVideo(item: VideoItem): string[] {
  try {
    const isDirectory = fs.statSync(item.path).isDirectory()
    const dir = isDirectory ? item.path : path.dirname(item.path)
    const bases = [item.file_name, item.name_zh, item.name_en, ...item.parts.map(part => path.basename(part.path))]
      .filter(Boolean).map(name => name.replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase())
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isPosterExt(e.name))
      .filter(e => isDirectory || bases.some(base => {
        const name = path.basename(e.name, path.extname(e.name)).toLowerCase()
        return name === base || ['-poster', '_poster', '-cover', '_cover', '.poster', '.cover'].some(suffix => name === base + suffix)
      }))
      .map((e) => path.join(dir, e.name))
  } catch {
    // 目录不在了（外置盘没插、文件被挪走）。这不是错误，只是这条来路走不通
    return []
  }
}

/**
 * 下载一张海报并装上。三道卡和游戏封面那边同构：URL 过白名单、
 * content-type 必须是图片（扩展名以它为准）、体积边下边数超了就断。
 *
 * 第一道按来源分两套，`source` 由**调用方**说明而不是在这儿嗅 URL ——
 * 两种地址都是 `https://`，靠形状分不开，而分错的方向是不对称的：
 * 把外站地址当 TMDB 会白挡掉（封面刮不到），把 TMDB 当外站会松掉那道
 * 「只许连用户配的那台机器」。
 *
 * 两套判据本身的理由写在 `posters.ts` 的 `acceptExternalPosterUrl` 上。
 */
async function downloadPoster(
  id: string,
  url: string,
  source: 'tmdb' | 'external',
  revision: number,
  episodeId?: string,
  role: 'poster' | 'thumbnail' = 'poster',
  cacheOnly = false
): Promise<{ ok: boolean; message: string; image?: VideoArtwork }> {
  const allowed =
    source === 'tmdb' ? acceptPosterUrl(url, getSettings().tmdb) : acceptExternalPosterUrl(url)
  if (!allowed) return { ok: false, message: '这个图片地址不在允许的来源里' }

  let tmp = ''
  try {
    const useHanimeSession = (() => {
      if (source !== 'external') return false
      try {
        return isHanimeHost(new URL(url).hostname)
      } catch {
        return false
      }
    })()
    const res = useHanimeSession ? await fetchHanimeResource(url) : await netFetch(url)
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` }

    const ext = extFromContentType(res.headers.get('content-type') ?? '')
    if (!ext) return { ok: false, message: '这个地址返回的不是图片' }

    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_POSTER_BYTES) {
      return { ok: false, message: `图太大了（${(declared / 1024 / 1024).toFixed(1)} MB）` }
    }
    if (!res.body) return { ok: false, message: '下载失败：没有响应内容' }

    // 显式 reader 而不是 for-await：net.fetch 回的是 web ReadableStream，
    // 它的异步迭代支持跟运行时版本有关，reader 在哪儿都成立
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      // 边下边数：content-length 可以撒谎，也可以干脆不给
      if (total > MAX_POSTER_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, message: '图太大了，已中止下载' }
      }
      chunks.push(Buffer.from(value))
    }
    if (total === 0) return { ok: false, message: '下载到的是空文件' }

    if ((posterRevisions.get(id) ?? 0) !== revision) return { ok: false, message: '封面已被手动更新，已保留新选择' }
    if (episodeId || role === 'thumbnail' || cacheOnly) {
      if (episodeId ? !getEpisode(getDb(), episodeId) : !getVideo(getDb(), id)) return { ok: false, message: '条目已不存在' }
      const decoded = nativeImage.createFromBuffer(Buffer.concat(chunks))
      if (decoded.isEmpty() || decoded.getSize().width < 64 || decoded.getSize().height < 64) return { ok: false, message: '单集封面无法解码或尺寸过小' }
      const destination = path.join(postersDir(), createHash('sha256').update(Buffer.concat(chunks)).digest('hex').slice(0, 24) + '.png')
      atomicWrite(destination, decoded.toPNG())
      const image = { path: destination, url, ...decoded.getSize() }
      if (cacheOnly) return { ok: true, message: '图片已读取', image }
      getDb().prepare(episodeId ? `UPDATE episode SET ${role}_path = ?, ${role}_source = ? WHERE id = ?`
        : `UPDATE video_meta SET ${role}_path = ?, ${role}_source = ? WHERE resource_id = ?`).run(destination, url, episodeId || id)
      return { ok: true, message: role === 'poster' ? '单集封面已保存' : '预览图已保存', image }
    }
    if (!getVideo(getDb(), id)) return { ok: false, message: '条目已被删除' }
    tmp = path.join(app.getPath('temp'), `baoyi-poster-${id}-${randomUUID()}${ext}`)
    fs.writeFileSync(tmp, Buffer.concat(chunks))
    const installed = setVideoPoster(id, tmp, false)
    if (installed.ok) getDb().prepare('UPDATE video_meta SET poster_source=? WHERE resource_id=?').run(url,id)
    return installed
  } catch (err: any) {
    const msg = err?.name === 'TimeoutError' ? '下载超时' : (err?.message ?? '未知错误')
    return { ok: false, message: `下载失败：${msg}` }
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 临时文件删不掉不影响海报已经装好这件事，系统会自己清 temp */
      }
    }
  }
}

/**
 * 给一个条目定海报。**本地优先，联网兜底。**
 *
 * 顺序不是随手排的：
 *   1. 已经是本地文件了就什么都不做 —— 那可能是用户自己挑的，重来一次会冲掉；
 *   2. 同目录的 `poster.jpg` / `folder.jpg` 那一类。免费、瞬间、离线可用，
 *      而且用户自己整理过的片库里这张图往往比 TMDB 那张更合他的意；
   *   3. 刮削时记下的 TMDB 相对路径，拼上配置里的图片域名下载；Hanime
   *      远程封面则走 Hanime 专用网络会话。
 *
 * 走不通就老实说走不通，不静默返回一个成功 —— 界面上那句「没找到海报，
 * 可以自己选一张」是这个函数唯一能给用户的下一步。
 */
const posterRevisions = new Map<string, number>()
const posterRequests = new Map<string, Promise<{ ok: boolean; message: string; changed: boolean }>>()

async function downloadArtworkPair(id: string, sources: { posterUrl?: string; thumbnailUrl?: string; artworkUrls?: string[] }, episodeId?: string,
  preservePoster = false, revision = posterRevisions.get(id) ?? 0, resourceId?: string): Promise<{ ok: boolean; message: string; changed: boolean }> {
  const images: VideoArtwork[] = [], failures: string[] = []
  const urls = [...new Set([sources.posterUrl, sources.thumbnailUrl, ...sources.artworkUrls || []].filter((url): url is string => !!url))].slice(0,6)
  for (const url of urls) {
    const result = await downloadPoster(id,url,'external',revision,episodeId,'poster',true)
    if (result.image) images.push(result.image); else failures.push(result.message)
    if ((posterRevisions.get(id) ?? 0) !== revision) return { ok: false, message: '图片已被手动更新，已保留新选择', changed: false }
  }
  const d = getDb(), target = episodeId ? getEpisode(d,episodeId) : getVideo(d,id)
  if (!target || resourceId && episodeId && (target as Episode).resource_id !== resourceId) return { ok: false, message: '条目或单集归属已变化', changed: false }
  const choice = selectVideoArtwork(images, sources.posterUrl, sources.thumbnailUrl)
  if (!choice.poster || !choice.thumbnail) return { ok: false, message: failures[0] || '来源未提供可用图片', changed: false }
  for (const [role, image] of [['poster',choice.poster],['thumbnail',choice.thumbnail]] as const) {
    if (role === 'poster' && preservePoster) continue
    d.prepare(episodeId ? `UPDATE episode SET ${role}_path=?,${role}_source=? WHERE id=?` : `UPDATE video_meta SET ${role}_path=?,${role}_source=? WHERE resource_id=?`).run(image.path,image.url,episodeId || id)
  }
  posterRevisions.set(id,revision+1)
  const message = preservePoster ? '已保留封面并补充预览图' : !choice.hasPortrait ? '已保存图片；来源暂无独立竖图，封面暂用预览图'
    : !choice.hasLandscape ? '已保存封面；来源暂无独立横图，预览暂用封面' : '已保存竖向封面与横向预览图'
  return { ok: true, message, changed: true }
}

export function fetchVideoEpisodePoster(episodeId: string, url: string): Promise<{ ok: boolean; message: string }> {
  return downloadPoster(episodeId, url, 'external', posterRevisions.get(episodeId) ?? 0, episodeId)
}

export function fetchVideoPoster(id: string): Promise<{ ok: boolean; message: string; changed: boolean }> {
  const pending = posterRequests.get(id)
  if (pending) return pending
  const job = fetchPosterOnce(id).finally(() => posterRequests.delete(id))
  posterRequests.set(id, job)
  return job
}

async function fetchPosterOnce(
  id: string
): Promise<{ ok: boolean; message: string; changed: boolean }> {
  const item = getVideo(getDb(), id)
  if (!item) return { ok: false, message: '找不到这个条目', changed: false }

  // 已经装好了。**不是「已经非空了」** —— 刮削阶段这一列存的是 TMDB 的相对路径，
  // 那种值在界面上是张破图，正是这个函数要来收拾的
  const localPortrait = (() => { try { const size = nativeImage.createFromPath(item.poster_path).getSize(); return size.width >= 64 && size.height > size.width * 1.05 } catch { return false } })()
  const havePoster = isLocalPoster(item.poster_path) && existsSync(item.poster_path)
  const keepPoster = havePoster && (localPortrait || item.user_edited.includes('poster_path'))
  const haveThumbnail = !!item.thumbnail_path && isLocalPoster(item.thumbnail_path) && existsSync(item.thumbnail_path)
  if (havePoster && (!item.hanime_id || keepPoster && haveThumbnail)) {
    return { ok: true, message: '已经有海报了', changed: false }
  }

  if (item.hanime_id) {
    const revision = posterRevisions.get(id) ?? 0
    try {
      const source = await loadVideoWork(item.hanime_id)
      const result = await downloadArtworkPair(id,source,undefined,keepPoster,revision)
      if (result.ok || (posterRevisions.get(id) ?? 0) !== revision) return result
    } catch { /* Local fallback still works without network. */ }
    if (keepPoster) return { ok: true, message: '已保留封面；预览图本次未取到，可稍后重试', changed: false }
  }
  const baseName = item.video_type === 'series'  ? path.basename(item.path) : item.file_name
  const sidecar = pickSidecarPoster(imagesBesideVideo(item), baseName)
  if (sidecar) {
    const r = setVideoPoster(id, sidecar)
    if (r.ok) return { ok: true, message: '用了同目录里的海报图', changed: true }
    // 拷贝失败（权限、盘满）不该让联网那条路也不许走
  }

  let rel = item.poster_source || (!isLocalPoster(item.poster_path) ? item.poster_path : '')
  const revision = posterRevisions.get(id) ?? 0
  const download = (source: string) => isRemotePoster(source)
    ? downloadPoster(id, source, 'external', revision)
    : downloadPoster(id, imageUrl(getSettings().tmdb, source, 'w500'), 'tmdb', revision)
  let failure = ''
  /*
   * 里番的封面是一个完整的 https 地址（hanime 的图床，主机名我们说不出来），
   * 这一支必须排在 TMDB 那支**前面**：`isLocalPoster('https://…')` 是 false，
   * 落到下面就会被当成 TMDB 的相对路径，拼出
   * `https://image.tmdb.org/t/p/w500/https://…` 这种地址然后 404。
   */
  if (rel && !isLocalPoster(rel)) {
    const r = await download(rel)
    if (r.ok) return { ok: true, message: '海报已下载', changed: true }
    failure = r.message
  }

  // 老缓存没有记录来源，或签名图片地址已过期时，用已核实的站方 ID 重取一次。
  if ((posterRevisions.get(id) ?? 0) !== revision) return { ok: false, message: failure || '封面已被手动更新', changed: false }
  try {
    let fresh = ''
    if (item.hanime_id) {
      const budget = newBudget()
      try {
        const hits = await hanimeSearch(item.name_en || item.name_zh || item.file_name, budget)
        fresh = hits.find(hit => hit.videoCode === item.hanime_id)?.coverUrl ?? ''
      } catch { /* 搜索失败仍可凭精确 ID 取详情 */ }
      if (!fresh) fresh = (await hanimeDetail(item.hanime_id, budget))?.coverUrl ?? ''
    } else if (item.tmdb_id && tmdbAvailable(getSettings().tmdb)) {
      fresh = (await tmdbDetail(getSettings().tmdb, item.video_type === 'series' ? 'tv' : 'movie', Number(item.tmdb_id)))?.poster_path ?? ''
    }
    if (fresh && fresh !== rel && (posterRevisions.get(id) ?? 0) === revision) {
      rel = fresh
      updateVideo(getDb(), id, { poster_source: rel })
      const r = await download(rel)
      if (r.ok) return { ok: true, message: '封面已恢复', changed: true }
      failure = r.message
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }

  return {
    ok: false,
    message: failure || (sidecar
      ? '同目录里那张图拷不过来，也没有可下载的海报'
      : '没找到可用的海报。可以在详情页自己选一张图。'),
    changed: false
  }
}
