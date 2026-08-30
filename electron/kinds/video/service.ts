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
import { app, net, shell } from 'electron'
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
  tagPool
} from '../../services/database.ts'
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
import { imageUrl, tmdbAvailable } from './tmdb.ts'
import {
  acceptPosterUrl,
  extFromContentType,
  isLocalPoster,
  isPosterExt,
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
    case 'douban_search':
      return `查豆瓣「${args.title ?? ''}」`
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
      },
      // 按次计费的服务商，这个数就是这次扫描的账单。缓存命中不计
      onSearch: () => {
        result.searches++
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
function dropPosterFiles(id: string): void {
  const dir = postersDir()
  for (const name of posterSiblings(id)) {
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
export function setVideoPoster(id: string, source: string): { ok: boolean; message: string } {
  if (!getVideo(getDb(), id)) return { ok: false, message: '找不到这个条目' }

  const from = path.resolve(source)
  if (!isPosterExt(from)) return { ok: false, message: `只认这些格式：${POSTER_EXTS.join('、')}` }
  if (!existsSync(from)) return { ok: false, message: '这个文件不在了' }

  // 换扩展名时旧文件不会被覆盖，先整个清一遍再拷 —— 不清会留下一个谁也不引用的
  // 孤儿，而它和新海报同名不同扩展名，看着像是没换成功
  dropPosterFiles(id)

  const name = posterFileName(id, from)
  try {
    fs.copyFileSync(from, path.join(postersDir(), name))
  } catch (err: any) {
    return { ok: false, message: `拷贝失败：${err?.message ?? '未知错误'}` }
  }

  updateVideo(getDb(), id, { poster_path: path.join(postersDir(), name) })
  return { ok: true, message: '海报已更换' }
}

/** 撤掉海报，退回首字占位。磁盘上那份拷贝一起删 */
export function clearVideoPoster(id: string): VideoItem | null {
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
  // 剧集的 path 是目录，电影的 path 是文件 —— 后者要退一层到它所在的目录
  const dir = item.video_type === 'series' ? item.path : path.dirname(item.path)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isPosterExt(e.name))
      .map((e) => path.join(dir, e.name))
  } catch {
    // 目录不在了（外置盘没插、文件被挪走）。这不是错误，只是这条来路走不通
    return []
  }
}

/**
 * 下载一张海报并装上。三道卡和游戏封面那边同构：URL 过白名单、
 * content-type 必须是图片（扩展名以它为准）、体积边下边数超了就断。
 */
async function downloadPoster(id: string, url: string): Promise<{ ok: boolean; message: string }> {
  const cfg = getSettings().tmdb
  if (!acceptPosterUrl(url, cfg)) return { ok: false, message: '这个图片地址不在允许的来源里' }

  let tmp = ''
  try {
    const res = await netFetch(url)
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

    tmp = path.join(app.getPath('temp'), `baoyi-poster-${id}${ext}`)
    fs.writeFileSync(tmp, Buffer.concat(chunks))
    return setVideoPoster(id, tmp)
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
 *   3. 刮削时记下的 TMDB 相对路径，拼上配置里的图片域名下载。
 *
 * 走不通就老实说走不通，不静默返回一个成功 —— 界面上那句「没找到海报，
 * 可以自己选一张」是这个函数唯一能给用户的下一步。
 */
export async function fetchVideoPoster(
  id: string
): Promise<{ ok: boolean; message: string; changed: boolean }> {
  const item = getVideo(getDb(), id)
  if (!item) return { ok: false, message: '找不到这个条目', changed: false }

  // 已经装好了。**不是「已经非空了」** —— 刮削阶段这一列存的是 TMDB 的相对路径，
  // 那种值在界面上是张破图，正是这个函数要来收拾的
  if (isLocalPoster(item.poster_path) && existsSync(item.poster_path)) {
    return { ok: true, message: '已经有海报了', changed: false }
  }

  const baseName = item.video_type === 'series' ? path.basename(item.path) : item.file_name
  const sidecar = pickSidecarPoster(imagesBesideVideo(item), baseName)
  if (sidecar) {
    const r = setVideoPoster(id, sidecar)
    if (r.ok) return { ok: true, message: '用了同目录里的海报图', changed: true }
    // 拷贝失败（权限、盘满）不该让联网那条路也不许走
  }

  const rel = item.poster_path
  if (rel && !isLocalPoster(rel)) {
    const cfg = getSettings().tmdb
    // w500 而不是原图：海报墙的框宽 150px，2x 屏也就 300px。原图动辄 2000px 宽、
    // 几 MB 一张，下几百张纯属浪费用户的带宽和磁盘
    const r = await downloadPoster(id, imageUrl(cfg, rel, 'w500'))
    if (r.ok) return { ok: true, message: '海报已下载', changed: true }
    return { ok: false, message: r.message, changed: false }
  }

  return {
    ok: false,
    message: sidecar
      ? '同目录里那张图拷不过来，也没有可下载的海报'
      : '没找到可用的海报。可以在详情页自己选一张图。',
    changed: false
  }
}
