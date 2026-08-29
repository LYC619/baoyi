/**
 * 游戏模块的编排层：把 Step 3 的扫描器、提示词、工具接到真实的库和界面上。
 *
 * 和 db.ts / scanner.ts / tools.ts 的分工是明确的 —— 那三个刻意不碰
 * services/database.ts，好让自检能用 node:sqlite 驱动同一份逻辑；这个文件
 * 是它们与 Electron 之间唯一的接缝，所以它是整条链路里唯一不可自检的一层，
 * 因此它只做绑定和汇总，不放任何判断规则。
 */

import { spawn } from 'node:child_process'
import fs, { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  GameCounts,
  GameCoverSearchResult,
  GameItem,
  GameQuery,
  GameScanProgress,
  GameScanResult,
  LinkedFile,
  SaveBackup,
  SaveBackupResult,
  SavePath,
  SavePathAlert,
  SavePathCheck,
  SaveRestoreResult
} from '../../../src/types'
import { app, net, shell } from 'electron'
import { runAgent, type AgentEvent } from '../../services/agent/loop'
import {
  coversDir,
  getDb,
  getSettings,
  listCategories,
  saveBackupRoot,
  tagPool
} from '../../services/database'
import {
  imageSearchAvailable,
  imageSearchWhyNot,
  searchAvailable,
  searchImages
} from '../../services/searchService'
import {
  acceptImageUrl,
  candidatesFromSearch,
  coverQueries,
  extFromContentType,
  finalizeCandidates,
  pickSteamApps,
  steamCoverCandidates,
  steamSearchUrl,
  MAX_COVER_BYTES,
  type CoverCandidate
} from './covers'
import {
  createBackup,
  deleteBackup,
  getBackup,
  listBackups,
  overRetention,
  restoreBackup,
  type GameLike
} from './backup'
import {
  deleteGame,
  gameCounts,
  gamesUnder,
  getGame,
  listGames,
  updateGame
} from './db'
import {
  addLinks,
  coverFileName,
  coverSiblings,
  guessLinkType,
  hasLink,
  isCoverExt,
  COVER_EXTS,
  MAX_LINKS
} from './links'
import { candidatePrompt, fillGameSystem } from './prompts'
import { loadSaveDb, type SaveDbHandle } from './savedb'
import { elapsedSeconds, endSession, type SessionOutcome } from './session'
import { inspectDir, probeSave, scanGameRoot, type GameCandidate } from './scanner'
import { buildGameTools, type GameToolContext } from './tools'

/**
 * 单个游戏目录的轮数上限。
 *
 * 12 而不是软件那边的 20：游戏是「一个目录一个游戏」，不需要在同一次会话里
 * 注册出好几条。真机上跑下来，找到存档的那次用了 7 轮，跳过的用了 3 轮。
 */
const MAX_TURNS = 12

let controller: AbortController | null = null

export function cancelGameScan(): void {
  controller?.abort()
}

/**
 * 已知存档位置索引在磁盘上的位置。
 *
 * 打包后它在 `process.resourcesPath` 下（electron-builder 的 extraResources 放过去的），
 * 开发时在仓库的 `resources/` 里。这个判断只能在这一层做 —— savedb.ts 刻意不 import
 * electron，所以它认不得 app.isPackaged。
 */
function saveDbPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'save-manifest.json')
    : path.join(app.getAppPath(), 'resources', 'save-manifest.json')
}

/** 索引读一次就缓存在 savedb.ts 里；读不到返回 null，前两层照样工作 */
function gameSaveDb(): SaveDbHandle | null {
  return loadSaveDb(saveDbPath())
}

/* ------------------------------ 读写转发 ------------------------------ */

export const listGameItems = (query: GameQuery = {}): GameItem[] => listGames(getDb(), query)
export const getGameItem = (id: string): GameItem | null => getGame(getDb(), id)
export const gameCountsOf = (): GameCounts => gameCounts(getDb())

export function updateGameItem(id: string, patch: Partial<GameItem>): GameItem | null {
  return updateGame(getDb(), id, patch)
}

/**
 * 从库里移除一个游戏，顺手删掉它的封面文件。
 *
 * 封面能删是因为它是**我们**拷进 userData 的一份副本，用户原来那张图还在他自己的
 * 目录里 —— 删掉不丢东西。存档备份不能这么处理（deleteGame 那边刻意不删），
 * 那是他的存档，不是我们生成的缓存。这两件事的判据是「这份文件是谁的」。
 */
export function removeGame(id: string): void {
  dropCoverFiles(id)
  deleteGame(getDb(), id)
}

/* ------------------------------ 关联文件 ------------------------------ */

/**
 * 把用户选的几个文件/目录挂到一个游戏上。
 *
 * 和识别时的 coerceLinkedFiles 分开走两条路，因为边界不同：那边的路径是模型给的，
 * 必须锁在游戏目录里；这里的路径是用户在系统对话框里亲手点的，攻略放在
 * `D:\资料\攻略` 是完全正常的事，锁在游戏目录里等于这个功能一半用不了。
 * 判断规则本身（去重、封顶、类型猜测）两边共用 links.ts，不各写一份。
 */
export function addGameLinks(id: string, targets: string[]): GameItem | null {
  const game = getGame(getDb(), id)
  if (!game) return null

  const incoming: LinkedFile[] = []
  for (const raw of targets) {
    const target = path.resolve(raw)
    let isDir = false
    try {
      isDir = fs.statSync(target).isDirectory()
    } catch {
      continue // 选完到落库之间被删掉了，跳过而不是记一条指不到的路径
    }
    incoming.push({
      path: target,
      label: path.basename(target),
      type: guessLinkType(target, isDir)
    })
  }
  if (incoming.length === 0) return game

  return updateGame(getDb(), id, { linked_files: addLinks(game.linked_files, incoming) })
}

/**
 * 打开一条关联文件（或在资源管理器里选中它）。
 *
 * 先核对它在不在这个游戏的名单里 —— 否则这就是一个「让渲染进程指定打开任意路径」
 * 的口子。名单里的那些是用户自己加的或识别时验过的，这一步只确认来路。
 */
export async function openGameLink(
  id: string,
  target: string,
  mode: 'open' | 'reveal' = 'open'
): Promise<{ ok: boolean; message: string }> {
  const game = getGame(getDb(), id)
  if (!game) return { ok: false, message: '找不到这个游戏' }
  if (!hasLink(game.linked_files, target)) {
    return { ok: false, message: '这条路径不在这个游戏的关联文件里，已拒绝' }
  }
  if (!existsSync(target)) {
    return { ok: false, message: `这个文件不在了：${target}` }
  }

  if (mode === 'reveal') {
    shell.showItemInFolder(target)
    return { ok: true, message: '' }
  }
  // openPath 返回的是错误字符串，空串才是成功 —— 双击打不开的类型（没有关联程序）
  // 会走到这里，得把系统那句话原样交给用户
  const err = await shell.openPath(target)
  return err ? { ok: false, message: err } : { ok: true, message: '' }
}

/* ------------------------------ 封面 ------------------------------ */

/** 清掉这个游戏在封面目录里的所有文件（含换过扩展名留下的孤儿） */
function dropCoverFiles(id: string): void {
  const dir = coversDir()
  for (const name of coverSiblings(id)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* 正被渲染进程占用之类，删不掉就留着，下次换封面会覆盖 */
    }
  }
}

/**
 * 换封面：把用户选的图**拷进** userData 下的 covers/，再把路径写进库。
 *
 * 拷而不是记一个指向原图的路径，有两个理由，第二个才是决定性的：
 *   · 原图被挪走、被删、在没插的移动硬盘上时，封面墙会整片破图；
 *   · 打包后页面跑在 `file://` 下，`<img src="C:\...">` 加载不出来 ——
 *     必须走 `baoyi://` 协议，而那个协议只在白名单目录里找文件（见 main.ts）。
 *     所以「拷进来」不是一个保守的选择，是这个功能唯一能成立的形态。
 */
export function setGameCover(id: string, source: string): { ok: boolean; message: string } {
  const game = getGame(getDb(), id)
  if (!game) return { ok: false, message: '找不到这个游戏' }

  const from = path.resolve(source)
  if (!isCoverExt(from)) {
    return { ok: false, message: `只认这些格式：${COVER_EXTS.join('、')}` }
  }
  if (!existsSync(from)) return { ok: false, message: '这个文件不在了' }

  // 换扩展名时旧文件不会被覆盖，先整个清一遍再拷 —— 不清就会留下一个
  // 谁也不引用的孤儿，而它和新封面同名不同扩展名，看着像是没换成功
  dropCoverFiles(id)

  const name = coverFileName(id, from)
  try {
    fs.copyFileSync(from, path.join(coversDir(), name))
  } catch (err: any) {
    return { ok: false, message: `拷贝失败：${err?.message ?? '未知错误'}` }
  }

  // 存完整路径而不是只存文件名，和 resource.icon_path 一个约定：
  // 渲染进程那边统一用 coverUrl() 取 basename 拼协议地址
  updateGame(getDb(), id, { cover_path: path.join(coversDir(), name) })
  return { ok: true, message: '封面已更换' }
}

/** 撤掉封面，退回首字占位。磁盘上那份拷贝一起删，留着只是占地方 */
export function clearGameCover(id: string): GameItem | null {
  dropCoverFiles(id)
  return updateGame(getDb(), id, { cover_path: '' })
}

/* ---------------------------- 封面联网搜索 ---------------------------- */

const NET_TIMEOUT = 20_000

/**
 * 封面相关的网络请求一律走 `net.fetch`（Chromium 的网络栈），不用全局 `fetch`。
 *
 * 两个理由，第二个是决定性的：
 *
 * 1. **它认系统代理。** 全局 fetch 是 Node 的 undici，不读系统代理也不读
 *    HTTP_PROXY。这台机器上实测：同一个商店接口 `net.fetch` 965ms 拿到 200，
 *    全局 fetch 10.7 秒后 `fetch failed`。配了代理的用户正是最需要这个功能的人
 *    （直连不稳），走 undici 等于对他们直接失效。
 * 2. **它和渲染进程加载 `<img>` 走的是同一条路。** 候选图要先在界面上预览，
 *    那张预览是 Chromium 发起的。用 undici 去「验证」一个地址可用，
 *    再让 Chromium 去加载，两条路的代理、证书、UA 策略都不同 ——
 *    可能验过了却显示不出来，那种不一致比验不过更难查。
 *
 * `net.fetch` 只在主进程可用，而这个文件本来就是那道 Electron 接缝。
 */
async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return net.fetch(url, { ...init, signal: AbortSignal.timeout(NET_TIMEOUT) })
}

/**
 * 探一个候选图是否真的存在。
 *
 * 用 `Range: bytes=0-1023` 的 GET 而不是 HEAD：HEAD 在部分 CDN 上会被拒或不返回
 * content-type。只拉 1 KB，十几个候选探一遍的代价可以忽略。
 *
 * 判据是 content-type 而不只是状态码。实测 Steam 对缺图的地址回的是规规矩矩的
 * 404 + text/html（老游戏没有 library_600x900、DLC 和原声带条目四种图全缺），
 * 状态码这一关就能挡住；但 content-type 这一关同时也挡住了「200 却不是图片」
 * 那一类（图搜返回的地址里有这种），两道一起卡的成本是零。
 */
async function probeImage(url: string): Promise<{ ok: boolean; ext: string }> {
  try {
    const res = await netFetch(url, { headers: { Range: 'bytes=0-1023' } })
    if (!res.ok && res.status !== 206) return { ok: false, ext: '' }
    const ext = extFromContentType(res.headers.get('content-type') ?? '')
    // 读掉这一小段，别让连接挂着
    await res.arrayBuffer().catch(() => undefined)
    return { ok: ext !== '', ext }
  } catch {
    return { ok: false, ext: '' }
  }
}

/** 分批并发，别一次把十几个请求全甩出去 */
async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

/** 查一次 Steam 商店搜索，返回它认得的几个 app */
async function steamApps(query: string): Promise<Array<{ id: number; name: string }>> {
  const res = await netFetch(steamSearchUrl(query))
  if (!res.ok) throw new Error(`Steam 搜索返回 HTTP ${res.status}`)
  const json: any = await res.json()
  const items: any[] = Array.isArray(json?.items) ? json.items : []
  return pickSteamApps(items, query)
}

/**
 * 搜封面：Steam 为主，配置了图搜的话再补一轮。
 *
 * 空结果**一定带原因**（`message`），不静默返回空数组 —— 用户按了按钮什么都没发生
 * 是最难排查的一种失败，而原因基本只有三类：网络不通、这个游戏不在 Steam 上、
 * 服务商不支持图搜。三类的下一步动作完全不同，必须说清是哪一类。
 */
export async function searchGameCovers(id: string): Promise<GameCoverSearchResult> {
  const game = getGame(getDb(), id)
  if (!game) return { ok: false, message: '找不到这个游戏', candidates: [], query: '' }

  const queries = coverQueries(game)
  if (queries.length === 0) {
    return { ok: false, message: '这个游戏没有可用的名字，先在详情页填一个再搜', candidates: [], query: '' }
  }

  const cfg = getSettings().search
  const notes: string[] = []
  const found: CoverCandidate[] = []
  let usedQuery = queries[0]
  let steamFailed = ''

  for (const q of queries) {
    usedQuery = q
    let apps: Array<{ id: number; name: string }> = []
    try {
      apps = await steamApps(q)
    } catch (err: any) {
      // 网络层的失败要跟「查到了但没有」分开报：前者重试有用，后者重试没用
      steamFailed = err?.message ?? '网络请求失败'
      break
    }
    if (apps.length === 0) continue

    const probed = await inBatches(
      apps.flatMap((a) => steamCoverCandidates(a.id, a.name)),
      5,
      async (c) => ({ c, hit: await probeImage(c.url) })
    )
    found.push(...probed.filter((p) => p.hit.ok).map((p) => p.c))
    if (found.length > 0) break // 第一个查到东西的名字就够了，不必把三个名字都烧一遍
  }

  // 图搜补一轮：Steam 上没有的小作品、模拟器 ROM、国产单机全靠这一层
  if (imageSearchAvailable(cfg)) {
    try {
      const hits = await searchImages(`${usedQuery} game cover art`, cfg)
      found.push(...candidatesFromSearch(hits))
    } catch (err: any) {
      notes.push(`图片搜索失败：${err?.message ?? '未知错误'}`)
    }
  } else {
    const why = imageSearchWhyNot(cfg)
    if (why) notes.push(`${why}，这次只查了 Steam`)
  }

  const candidates = finalizeCandidates(found)
  if (candidates.length > 0) {
    return {
      ok: true,
      message: notes.join('；'),
      candidates,
      query: usedQuery
    }
  }

  // 一张都没有：把已知的原因拼齐，最后一定落到「手动选一张」这个可行动作上
  const reasons = [
    steamFailed ? `连不上 Steam（${steamFailed}）` : `Steam 上没找到「${usedQuery}」`,
    ...notes
  ]
  return {
    ok: false,
    message: `${reasons.join('；')}。可以改一下游戏名再搜，或者直接手动选一张图。`,
    candidates: [],
    query: usedQuery
  }
}

/**
 * 下载一个候选封面并设成封面。
 *
 * 下完落到临时文件，再交给 `setGameCover` —— 拷进 covers/、清孤儿、写 cover_path
 * 那一整套已经在那儿了，重写一遍迟早会漂。
 *
 * 三道卡：URL 必须过白名单（`acceptImageUrl`，挡的是「远端决定我们连哪台机器」）、
 * content-type 必须是图片（扩展名以它为准，不信 URL 上写的）、
 * 体积边下边数超了就断（content-length 可以撒谎，也可以干脆不给）。
 */
export async function setGameCoverFromUrl(
  id: string,
  url: string
): Promise<{ ok: boolean; message: string }> {
  if (!getGame(getDb(), id)) return { ok: false, message: '找不到这个游戏' }
  if (!acceptImageUrl(url)) return { ok: false, message: '这个图片地址不在允许的来源里' }

  let tmp = ''
  try {
    const res = await netFetch(url)
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` }

    const ext = extFromContentType(res.headers.get('content-type') ?? '')
    if (!ext) return { ok: false, message: '这个地址返回的不是图片' }

    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_COVER_BYTES) {
      return { ok: false, message: `图太大了（${(declared / 1024 / 1024).toFixed(1)} MB）` }
    }
    if (!res.body) return { ok: false, message: '下载失败：没有响应内容' }

    // 用显式 reader 而不是 for-await：net.fetch 回的是 web ReadableStream，
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
      if (total > MAX_COVER_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, message: '图太大了，已中止下载' }
      }
      chunks.push(Buffer.from(value))
    }
    if (total === 0) return { ok: false, message: '下载到的是空文件' }

    tmp = path.join(app.getPath('temp'), `baoyi-cover-${id}${ext}`)
    fs.writeFileSync(tmp, Buffer.concat(chunks))

    const r = setGameCover(id, tmp)
    return r.ok ? { ok: true, message: '封面已设置' } : r
  } catch (err: any) {
    const msg = err?.name === 'TimeoutError' ? '下载超时' : (err?.message ?? '未知错误')
    return { ok: false, message: `下载失败：${msg}` }
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 临时文件删不掉不影响封面已经设好这件事，系统会自己清 temp */
      }
    }
  }
}

/** 关联文件的条数上限，给界面上那句提示用 —— 不让渲染进程自己写一个 20 */
export const gameLinkLimit = (): number => MAX_LINKS

/* ------------------------------ 存档与备份 ------------------------------ */

/**
 * 探测一个候选存档目录。
 *
 * 和识别时的 detect_save_path 是同一个 probeSave，但**不过白名单** ——
 * 那道墙拦的是模型编出来的路径，而这里的路径是用户在系统对话框里亲手指的。
 * 用户指着自己的桌面说「存档在这儿」是他的权利，不是越界。
 */
export function checkSavePath(target: string): SavePathCheck {
  const resolved = path.resolve(target)
  const probe = probeSave(resolved)
  return {
    path: resolved,
    exists: probe.exists,
    files: probe.files,
    bytes: probe.bytes,
    newest: probe.newest,
    sample: probe.sample
  }
}

/** 备份记录里要用到的那几个字段。找不到条目时返回 null，由上层决定怎么办 */
function gameLike(id: string): GameLike | null {
  const g = getGame(getDb(), id)
  return g ? { id: g.id, name_zh: g.name_zh, name_en: g.name_en, file_name: g.file_name } : null
}

/**
 * 备份一条存档路径。
 *
 * savePath 来自渲染进程，但必须是这条游戏**已经记下**的存档路径之一 ——
 * 否则这就成了一个「让页面指定往哪儿读、往备份根写」的口子。
 * 详情页上那些路径本身是经过验证才存进去的，这里只核对它在不在名单里。
 */
export async function backupSavePath(id: string, savePath: string): Promise<SaveBackupResult> {
  const game = getGame(getDb(), id)
  if (!game) return { ok: false, message: '找不到这个游戏', backup: null, over: [] }

  const known = game.save_paths.some(
    (s) => path.resolve(s.path).toLowerCase() === path.resolve(savePath).toLowerCase()
  )
  if (!known) {
    return { ok: false, message: '这条存档路径不在这个游戏名下，已拒绝', backup: null, over: [] }
  }

  const made = await createBackup(
    getDb(),
    { id: game.id, name_zh: game.name_zh, name_en: game.name_en, file_name: game.file_name },
    savePath,
    { backupRoot: saveBackupRoot() }
  )
  // 超出保留上限的名单只在备份成功之后算，而且只是**报告**：删不删由用户在界面上决定。
  // 失败时不报 —— 那时候没有新增任何一份，谈不上超出。
  if (!made.ok || !made.backup) return made
  return {
    ...made,
    over: overRetention(getDb(), game.id, made.backup.save_path, getSettings().save_backup_keep)
  }
}

export const listSaveBackups = (id: string): SaveBackup[] => listBackups(getDb(), id)
export const getSaveBackup = (backupId: string): SaveBackup | null => getBackup(getDb(), backupId)

/**
 * 还原一份备份。
 *
 * 游戏条目可能已经被移除了（save_backups 刻意没有外键，见 schema.ts），
 * 那种情况下还原依然要能走通 —— 用户要的是他的存档，不是库里那一行。
 */
export async function restoreSaveBackup(backupId: string): Promise<SaveRestoreResult> {
  const backup = getBackup(getDb(), backupId)
  if (!backup) return { ok: false, message: '找不到这条备份记录', safety: null }
  return restoreBackup(getDb(), backupId, gameLike(backup.resource_id), {
    backupRoot: saveBackupRoot()
  })
}

export const deleteSaveBackup = (backupId: string): Promise<{ ok: boolean; message: string }> =>
  deleteBackup(getDb(), backupId)

/**
 * 重新验一条已记下的存档路径，验过了就把 verified_at 往前推。
 *
 * 存在但空的目录**不**更新时间戳：那个时间戳的含义是「这一刻它确实有存档」，
 * 备份那一层也是照这个标准拒绝空目录的，两边得说同一句话。
 */
export function reverifySavePath(id: string, target: string): SavePathCheck {
  const check = checkSavePath(target)
  const game = getGame(getDb(), id)
  if (!game) return check

  const hit = game.save_paths.find(
    (s) => path.resolve(s.path).toLowerCase() === check.path.toLowerCase()
  )
  if (!hit) return check

  if (check.exists && check.files > 0) {
    const next: SavePath[] = game.save_paths.map((s) =>
      s === hit ? { ...s, verified_at: Date.now() } : s
    )
    updateGame(getDb(), id, { save_paths: next })
  }
  return check
}

/* ------------------------------ 启动与时长 ------------------------------ */

/**
 * 正在进行的游玩：resource_id → 开始时刻。
 *
 * 只在内存里。进程内的一次游玩天然活不过应用本身，而应用退出前会把还开着的那些
 * 结掉（见 finalizeGameSessions），所以不需要把它落盘。
 *
 * 同一个游戏重复点启动不新开一段：Map 的键就是游戏 id，第二次点的时候已经在跑了。
 * 那种情况下开始时刻保持第一次的 —— 用户点第二下通常是以为没启动起来，
 * 而不是真的开了第二份。
 */
const playing = new Map<string, number>()

/** 一次游玩结束时通知渲染进程，界面靠它刷新时长和状态 */
type SessionSink = (id: string, outcome: SessionOutcome) => void
let sessionSink: SessionSink | null = null
export function onGameSession(sink: SessionSink): void {
  sessionSink = sink
}

/** 收一段游玩。id 已经不在 playing 里就什么都不做 —— 退出事件和退出前收尾会撞车 */
function closeSession(id: string): void {
  const startedAt = playing.get(id)
  if (startedAt === undefined) return
  playing.delete(id)
  const outcome = endSession(getDb(), id, elapsedSeconds(startedAt, Date.now()))
  if (outcome) sessionSink?.(id, outcome)
}

/**
 * 启动一个游戏，并从这一刻开始算时长。
 *
 * 和软件那边的 launchSoftware 是两回事，所以没有复用：软件只需要记一个「启动过」
 * 的时间点，游戏要的是一段有始有终的时长，因此必须留住 child 句柄等它的 exit。
 *
 * detached + unref 照旧：游戏是长时间运行的东西，不能让它拖着抱一不能退出。
 * unref 之后 exit 事件仍然会到（它只是不再替这个句柄吊着事件循环），
 * 而抱一自己的事件循环由应用本身撑着 —— 所以这两件事不冲突。
 */
export function launchGame(id: string): { ok: boolean; message: string } {
  const game = getGame(getDb(), id)
  if (!game) return { ok: false, message: '找不到这个游戏' }
  if (!existsSync(game.path)) {
    return { ok: false, message: `主程序不在了：${game.path}` }
  }
  if (playing.has(id)) return { ok: true, message: '这个游戏已经在运行了' }

  playing.set(id, Date.now())
  try {
    const child = spawn(game.path, [], {
      detached: true,
      stdio: 'ignore',
      // 和软件同一个理由：游戏普遍依赖同目录的资源和 dll，cwd 不对直接起不来
      cwd: path.dirname(game.path),
      windowsHide: false
    })
    child.on('error', () => {
      // spawn 失败（要提权之类）时这一段游玩根本没开始，撤掉它而不是记一段假的
      playing.delete(id)
      void shell.openPath(game.path)
    })
    child.on('exit', () => closeSession(id))
    child.unref()
  } catch {
    playing.delete(id)
    void shell.openPath(game.path)
    // 交给系统 shell 之后就跟不到进程了，这次不记时长 —— 记不到就不装作记到了
    return { ok: true, message: '已交给系统打开，这次的时长跟不到' }
  }
  return { ok: true, message: `已启动${gameName(game)}` }
}

/**
 * 应用退出前把还开着的那几段结掉。
 *
 * 不结的话，用户开着游戏顺手关掉抱一，这一段时长就整个丢了。结掉的话记到的是
 * 「从启动到抱一退出」这一段，比整段丢掉更接近真实。差额是他关掉抱一之后继续玩的
 * 那部分，我们确实不知道。
 */
export function finalizeGameSessions(): void {
  for (const id of [...playing.keys()]) closeSession(id)
}

/** 这个游戏此刻是不是正被抱一跟着 */
export const isGameRunning = (id: string): boolean => playing.has(id)

/**
 * 打开游戏库时扫一遍所有已记下的存档路径，把当下不存在的那些报回去。
 *
 * 只 existsSync，**一个字节都不写库**。写库的话，外置硬盘没插、网络盘没连上这种
 * 一时的情况会被固化成一条「路径失效」永久留在记录里 —— 而它下一分钟就不成立了。
 * 判断存放在哪里决定了它什么时候会过期：进程内的瞬时状态跟着这次会话消失，
 * 正好和「这条路径此刻在不在」这个问题的有效期对上。
 *
 * 逐条 existsSync 是同步阻塞的，但量级是几十到几百次 stat，且只在开库时跑一次；
 * 换成异步并发要多一层调度，省下的毫秒数用户感觉不到。
 * 归档区一起查：归档只是不在主列表显示，存档还是他的存档。
 */
export function checkAllSavePaths(): SavePathAlert[] {
  const alerts: SavePathAlert[] = []
  for (const g of listGames(getDb(), { group: 'all' }).concat(
    listGames(getDb(), { group: 'archived' })
  )) {
    const missing = g.save_paths.map((s) => s.path).filter((p) => !existsSync(p))
    if (missing.length > 0) alerts.push({ id: g.id, name: gameName(g), missing })
  }
  return alerts
}

/** 详情页标题用的那套取名顺序，这里报警文案也用它，免得两处叫法不一样 */
function gameName(g: GameItem): string {
  return g.name_zh || g.name_en || g.file_name
}

/* ------------------------------ 扫描识别 ------------------------------ */

/** 把 agent 的动作翻译成用户看得懂的一行字，同 aiService 的 describeEvent */
function describeEvent(e: AgentEvent): string {
  if (e.type !== 'tool_call') return ''
  const args = e.args as Record<string, any>
  switch (e.name) {
    case 'list_directory':
      return `查看 ${path.basename(String(args.path ?? ''))}`
    case 'read_text_file':
      return `阅读 ${path.basename(String(args.path ?? ''))}`
    case 'detect_save_path':
      return `验证存档路径 ${args.path ?? ''}`
    case 'register_game':
      return `识别出「${args.name_zh ?? '?'}」`
    case 'skip_directory':
      return `跳过 ${path.basename(String(args.path ?? ''))}`
    case 'web_search':
      return `联网搜索「${args.query ?? ''}」`
    default:
      return `调用 ${e.name}`
  }
}

/**
 * 扫一批目录，逐个交给 agent 识别，直接落库。
 *
 * 和软件那边最大的不同是**不走暂存确认**：软件的一个目录可能拆出好几条，
 * 拆错了得有地方拦；游戏是一个目录一条，识别错了在详情页改一个名字就完了，
 * 为它专门做一屏确认面板不划算。已注册的目录会被跳过（gamesUnder 告诉 agent），
 * 所以重复扫同一个根是安全的。
 */
export async function scanGames(
  dirs: string[],
  onProgress: (p: GameScanProgress) => void
): Promise<GameScanResult> {
  controller = new AbortController()
  const signal = controller.signal
  const result: GameScanResult = { candidates: 0, registered: 0, skipped: 0, failed: 0, tokens: 0 }

  const report = (p: Partial<GameScanProgress>): void =>
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
  const candidates: GameCandidate[] = []
  const seen = new Set<string>()
  for (const root of dirs) {
    if (signal.aborted) break
    // 用户可能直接指着一个游戏目录说「就认这个」，也可能给一个收纳根
    const direct = inspectDir(root, path.dirname(root))
    const found = direct ? [direct] : await scanGameRoot(root, {
      onDir: (dir) => report({ phase: 'scanning', current: dir, total: 0 }),
      cancelled: () => signal.aborted
    })
    // 两个扫描根有包含关系时，同一个目录会被扫出来两次
    for (const c of found) {
      if (seen.has(c.dir.toLowerCase())) continue
      seen.add(c.dir.toLowerCase())
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
  // 分类和标签池现读现填，且都按 kind='game' 取 —— 软件的「开发工具」不能进这个 prompt
  const pool = tagPool('game')
  const categories = listCategories('game')
  const categoryNames = categories.map((c) => c.name)
  const system = fillGameSystem(categories, pool, withSearch)
  const db = getDb()
  const saveDb = gameSaveDb()

  // 串行而不是像 aiService 那样开三路并发：游戏一次扫出来通常是个位数，
  // 而串行时进度条上的「正在识别 X」是一句真话，并发时它只是三个里的某一个
  for (const [i, c] of candidates.entries()) {
    if (signal.aborted) break
    report({ current: c.dir, processed: i })

    const ctx: GameToolContext = {
      roots: [c.dir],
      gameDir: c.dir,
      db,
      tagPool: pool,
      searchConfig: settings.search,
      saveDb,
      onRegister: () => {
        result.registered++
      },
      onSkip: () => {
        result.skipped++
      }
    }

    const run = await runAgent({
      config: settings.ai,
      system,
      user: candidatePrompt(c, gamesUnder(db, c.dir)),
      tools: buildGameTools(ctx, categoryNames, withSearch),
      maxTurns: MAX_TURNS,
      signal,
      onEvent: (e) => report({ current: c.dir, processed: i, log: describeEvent(e) })
    })
    result.tokens += run.tokens
    if (run.stopReason === 'error') result.failed++
  }

  report({ phase: 'done', processed: candidates.length })
  return result
}
