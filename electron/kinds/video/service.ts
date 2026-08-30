/**
 * 视频模块的服务层。**这个文件是 `kinds/video/` 里唯一允许 import
 * `services/database.ts` 的地方** —— 它只做绑定和汇总，真正的逻辑都在别处。
 *
 * 这条约定是 v0.5 立的、v0.6 验过的：`kinds/<kind>/` 下的逻辑只收 `SqlDb`，
 * 这样自检能拿 `node:sqlite` 驱动同一份代码，不用把整个 Electron 拉起来。
 * `service.ts` 是那个例外，代价是它自己测不了 —— 所以它必须薄。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type {
  AgentEvent,
  Episode,
  VideoCounts,
  VideoItem,
  VideoQuery,
  VideoScanProgress,
  VideoScanResult
} from '../../../src/types'
import { getDb, getSettings, listCategories, tagPool } from '../../services/database.ts'
import { runAgent } from '../../services/agent/loop.ts'
import { searchAvailable } from '../../services/searchService.ts'
import {
  deleteVideo,
  getEpisode,
  getVideo,
  listEpisodes,
  listVideos,
  nextEpisode,
  syncSeriesStatus,
  updateEpisode,
  updateVideo,
  videoCounts,
  videosUnder
} from './db.ts'
import { scanVideoRoot, type VideoCandidate } from './scanner.ts'
import { buildFacts } from './facts.ts'
import { fillVideoSystem, videoCandidatePrompt } from './prompts.ts'
import { buildVideoTools, type VideoToolContext } from './tools.ts'
import { tmdbAvailable } from './tmdb.ts'

/** 一个条目最多几轮。事实已经很全，8 轮够用；prompt 里也写了这个数 */
const MAX_TURNS = 10

let controller: AbortController | null = null

export function cancelVideoScan(): void {
  controller?.abort()
}

/* ------------------------------ 读写绑定 ------------------------------ */

export const listVideoItems = (query: VideoQuery = {}): VideoItem[] => listVideos(getDb(), query)
export const getVideoItem = (id: string): VideoItem | null => getVideo(getDb(), id)
export const videoCountsOf = (): VideoCounts => videoCounts(getDb())
export const listVideoEpisodes = (id: string): Episode[] => listEpisodes(getDb(), id)
export const getVideoEpisode = (episodeId: string): Episode | null => getEpisode(getDb(), episodeId)
export const nextVideoEpisode = (id: string, season: number, episode: number): Episode | null =>
  nextEpisode(getDb(), id, season, episode)

export function updateVideoItem(id: string, patch: Partial<VideoItem>): VideoItem | null {
  return updateVideo(getDb(), id, patch)
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
  return updated
}

/**
 * 从库里移除。`video_meta` 和 `episode` 靠 ON DELETE CASCADE 跟着走。
 *
 * 不动磁盘上的视频文件 —— 和 `removeGame` 同一个约定：从抱一里移除一条记录，
 * 不等于用户愿意删掉那个几十 GB 的文件。
 */
export function removeVideo(id: string): void {
  deleteVideo(getDb(), id)
}

/** 在资源管理器里选中。剧集选中目录，电影选中文件 */
export function revealVideo(id: string): void {
  const item = getVideo(getDb(), id)
  if (!item?.path) return
  if (!existsSync(item.path)) return
  if (item.video_type === 'series') shell.openPath(item.path)
  else shell.showItemInFolder(item.path)
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
    case 'web_search':
      return `联网搜索「${args.query ?? ''}」`
    default:
      return `调用 ${e.name}`
  }
}

/**
 * 扫一批目录，逐个交给 agent 识别，直接落库。
 *
 * 和游戏那边一样**不走暂存确认**：一个条目一条记录，识别错了在详情页改个名字
 * 就完了，为它专门做一屏确认面板不划算。已注册的条目会被告知 agent
 * （`videosUnder`），所以重复扫同一个根是安全的 —— `insertVideo` 以 path
 * 为唯一键，重扫是更新，而观看进度不会被清掉。
 *
 * 串行而不是并发：并发时进度条上那句「正在识别 X」只是三个里的某一个，
 * 而且 TMDB 有速率限制，三路并发很容易撞上 429。
 */
export async function scanVideos(
  dirs: string[],
  onProgress: (p: VideoScanProgress) => void
): Promise<VideoScanResult> {
  controller = new AbortController()
  const signal = controller.signal
  const result: VideoScanResult = {
    candidates: 0,
    registered: 0,
    skipped: 0,
    failed: 0,
    tokens: 0,
    episodes: 0
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
  for (const root of dirs) {
    if (signal.aborted) break
    report({ phase: 'scanning', current: root, total: 0 })
    for (const c of scanVideoRoot(root)) {
      // 两个扫描根有包含关系时，同一个条目会被扫出来两次
      const key = c.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(c)
    }
  }
  result.candidates = candidates.length
  if (candidates.length === 0 || signal.aborted) {
    report({ phase: 'done', total: 0 })
    return result
  }

  /* -------- 第二截：逐个识别 -------- */
  const settings = getSettings()
  const withSearch = searchAvailable(settings.search)
  const withTmdb = tmdbAvailable(settings.tmdb)
  // 分类和标签池现读现填，且都按 kind='video' 取 ——
  // 软件的「开发工具」和游戏的「魂系」不能进这个 prompt
  const pool = tagPool('video')
  const categories = listCategories('video')
  const categoryNames = categories.map((c) => c.name)
  const system = fillVideoSystem(categories, pool, withSearch, withTmdb)
  const db = getDb()

  for (const [i, c] of candidates.entries()) {
    if (signal.aborted) break
    report({ current: c.path, processed: i, log: '读本地事实' })

    // 本地事实先凑齐再进 prompt。这一步是同步磁盘 IO + WASM 解析，
    // 比一次模型往返快得多，而它省下的往返不止一次
    const facts = await buildFacts(c)
    if (signal.aborted) break

    const ctx: VideoToolContext = {
      facts,
      db,
      tagPool: pool,
      searchConfig: settings.search,
      tmdbConfig: settings.tmdb,
      onRegister: (info) => {
        result.registered++
        result.episodes += info.episodesAdded
      },
      onSkip: () => {
        result.skipped++
      }
    }

    const run = await runAgent({
      config: settings.ai,
      system,
      user: videoCandidatePrompt(facts, videosUnder(db, facts.dir)),
      tools: buildVideoTools(ctx, categoryNames, withSearch, withTmdb),
      maxTurns: MAX_TURNS,
      signal,
      onEvent: (e) => report({ current: c.path, processed: i, log: describeEvent(e) })
    })
    result.tokens += run.tokens
    if (run.stopReason === 'error') result.failed++
  }

  report({ phase: 'done', processed: candidates.length })
  return result
}

/**
 * 扫描前的可用性检查。给设置页和扫描按钮用。
 *
 * 分三档而不是一个布尔：三种状态的下一步动作完全不同。
 * 没配 AI 是硬拦（识别整个跑不起来）；没配 TMDB 只是降级
 * （条目照样能入库，只是没有海报、简介和完整季集表），
 * 那句话要说给用户听，让他知道自己会少拿到什么。
 */
export function videoScanReadiness(): { ok: boolean; message: string } {
  const s = getSettings()
  if (!s.ai.enabled || !s.ai.api_key.trim()) {
    return { ok: false, message: '还没配置 AI 接口，识别跑不起来。请先去设置里填 API Key。' }
  }
  if (!tmdbAvailable(s.tmdb)) {
    return {
      ok: true,
      message:
        '没有配置 TMDB，本次只按本地信息识别 —— 条目能入库，但不会有官方简介、评分和完整季集表。' +
        '在设置里填一个免费的 TMDB API Key 可以补上。'
    }
  }
  return { ok: true, message: '' }
}

/** 视频条目所在目录里已注册的那些。给 UI 提示重复用 */
export const videosInDir = (dir: string): Array<{ name: string; path: string }> =>
  videosUnder(getDb(), path.resolve(dir))
