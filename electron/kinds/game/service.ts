/**
 * 游戏模块的编排层：把 Step 3 的扫描器、提示词、工具接到真实的库和界面上。
 *
 * 和 db.ts / scanner.ts / tools.ts 的分工是明确的 —— 那三个刻意不碰
 * services/database.ts，好让自检能用 node:sqlite 驱动同一份逻辑；这个文件
 * 是它们与 Electron 之间唯一的接缝，所以它是整条链路里唯一不可自检的一层，
 * 因此它只做绑定和汇总，不放任何判断规则。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { app, net, nativeImage, session, shell } from 'electron'
import { runAgent, type AgentEvent } from '../../services/agent/loop'
import {
  coversDir,
  getDb,
  getSettings,
  listCategories,
  saveBackupRoot,
  saveIdentifyLog,
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
  isGenericGameName,
  isLocalCoverUrl,
  extFromContentType,
  finalizeCandidates,
  pickSteamApps,
  steamCoverCandidates,
  steamSearchUrl,
  MAX_COVER_BYTES,
  MIN_COVER_SHORT_EDGE,
  MIN_COVER_LONG_EDGE,
  MAX_COVER_EDGE,
  MAX_COVER_PIXELS,
  type CoverCandidate,
  type GameCoverDiagnostic
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
  insertGame,
  listGames,
  updateGame
} from './db'
import {
  addLinks,
  coverSiblings,
  guessLinkType,
  hasLink,
  isCoverExt,
  COVER_EXTS,
  MAX_LINKS
} from './links'
import { candidatePrompt, fillGameSystem } from './prompts'
import { configUrlsFromLauncher, confirmedGameIdentity, isGenshinAlias, isGenshinLauncherAlias, knownGameIdentity, parseOfficialConfig } from './identity'
import { loadSaveDb, type SaveDbHandle } from './savedb'
import { elapsedSeconds, endSession, type SessionOutcome } from './session'
import { inspectDir, probeSave, scanGameRoot, type GameCandidate } from './scanner'
import { buildGameTools, type GameToolContext } from './tools'
import { gamePathState } from './files'

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

export const listGameItems = (query: GameQuery = {}): GameItem[] => listGames(getDb(), query).map(gamePathState)
export const getGameItem = (id: string): GameItem | null => {
  const game = getGame(getDb(), id)
  return game ? gamePathState(refreshKnownIdentity(game).game) : null
}
export const gameCountsOf = (): GameCounts => gameCounts(getDb())

export function updateGameItem(id: string, patch: Partial<GameItem>): GameItem | null {
  if (Object.keys(patch).some(key => key.startsWith('cover_') || key.startsWith('identity_') || key === 'name_zh' || key === 'name_en')) {
    advanceCoverRevision(id)
  }
  const current = getGame(getDb(), id)
  if (!current) return null
  if ((patch.identity_confirmed ?? current.identity_confirmed) && (patch.identity_name !== undefined || patch.identity_confirmed === true)) {
    const known = confirmedGameIdentity(patch.identity_name ?? current.identity_name)
    if (known) patch = { ...normalizedIdentityPatch({ ...current, ...patch }, known), ...patch, identity_name: known.identity_name }
  }
  return updateGame(getDb(), id, patch)
}

/** 本地登记只读取所选入口；识别和补图可在登记后单独进行。 */
export function registerManualGame(exePath: string): { ok: boolean; message: string; item?: GameItem } {
  try {
    const target = path.resolve(exePath)
    if (!/\.(?:exe|lnk|bat|cmd)$/i.test(target)) return { ok: false, message: '请选择游戏程序、快捷方式或启动脚本' }
    const stat = fs.statSync(target)
    if (!stat.isFile()) return { ok: false, message: '所选入口不是文件' }
    const db = getDb()
    const existing = db.prepare('SELECT id, kind FROM resource WHERE path = ? COLLATE NOCASE').get(target) as { id: string; kind: string } | undefined
    if (existing) {
      const item = existing.kind === 'game' ? getGame(db, existing.id) : null
      return item ? { ok: true, message: '这个游戏已在库中', item } : { ok: false, message: '这个入口已登记在其他资源库中' }
    }
    const name = path.basename(target, path.extname(target))
    db.exec('SAVEPOINT register_manual_game')
    try {
      const { id } = insertGame(db, {
        exe_path: target, source_dir: path.dirname(target), file_size: stat.size,
        name_zh: /[\u3400-\u9fff]/.test(name) ? name : '', name_en: /[\u3400-\u9fff]/.test(name) ? '' : name,
        summary: '', description: '', category: '其他', tags: [], official_url: '', save_paths: [], linked_files: []
      })
      db.prepare("UPDATE resource SET ai_status = 'pending' WHERE id = ?").run(id)
      const item = getGameItem(id)!
      db.exec('RELEASE SAVEPOINT register_manual_game')
      return { ok: true, message: '游戏已登记，可在详情页确认名称和存档位置', item }
    } catch (err) {
      db.exec('ROLLBACK TO SAVEPOINT register_manual_game')
      db.exec('RELEASE SAVEPOINT register_manual_game')
      throw err
    }
  } catch (err: any) {
    return { ok: false, message: `登记失败：${err?.message ?? '无法读取所选文件'}` }
  }
}

/**
 * 从库里移除一个游戏，顺手删掉它的封面文件。
 *
 * 封面能删是因为它是**我们**拷进 userData 的一份副本，用户原来那张图还在他自己的
 * 目录里 —— 删掉不丢东西。存档备份不能这么处理（deleteGame 那边刻意不删），
 * 那是他的存档，不是我们生成的缓存。这两件事的判据是「这份文件是谁的」。
 */
export function removeGame(id: string): void {
  advanceCoverRevision(id)
  deleteGame(getDb(), id)
  dropCoverFiles(id)
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

// A slow search/download may finish after the user picked or cleared another image.
const coverRevisions = new Map<string, number>()
const coverRevision = (id: string): number => coverRevisions.get(id) ?? 0
function advanceCoverRevision(id: string): number {
  const next = coverRevision(id) + 1
  coverRevisions.set(id, next)
  return next
}

function gameDirectories(game: GameItem): string[] {
  return [...new Set([path.dirname(game.path), game.source_dir].filter(Boolean).map(dir => path.resolve(dir)))].slice(0, 2)
}

function normalizedIdentityPatch(game: GameItem, known: NonNullable<ReturnType<typeof knownGameIdentity>>): Partial<GameItem> {
  const patch: Partial<GameItem> = {}
  for (const field of ['name_zh', 'name_en', 'identity_name'] as const) {
    if ((isGenericGameName(game[field]) || isGenshinLauncherAlias(game[field])) && game[field] !== known[field]) patch[field] = known[field]
  }
  return patch
}

function refreshKnownIdentity(game: GameItem): { game: GameItem; known: ReturnType<typeof knownGameIdentity> } {
  // A nearby installation is not evidence for an unrelated entry point, and an
  // explicitly confirmed product takes precedence over shared launcher files.
  const entry = path.basename(game.path)
  if (game.identity_confirmed || (!isGenericGameName(entry) && !/^(?:YuanShen|GenshinImpact)\.exe$/i.test(entry))) {
    return { game, known: null }
  }
  const executables: string[] = []
  const configs: string[] = []
  for (const dir of gameDirectories(game)) {
    for (const name of ['YuanShen.exe', 'GenshinImpact.exe', 'StarRail.exe', 'ZenlessZoneZero.exe', 'BH3.exe']) {
      for (const subdir of ['', 'YuanShen Game', 'Genshin Impact Game']) {
        try { if (fs.statSync(path.join(dir, subdir, name)).isFile()) executables.push(name) } catch { /* absent */ }
      }
    }
    for (const name of ['config.ini', 'config.json']) {
      try {
        const file = path.join(dir, name)
        const stat = fs.statSync(file)
        if (stat.isFile() && stat.size <= 256 * 1024) configs.push(fs.readFileSync(file, 'utf8'))
      } catch { /* no product config */ }
    }
  }
  const known = knownGameIdentity({ executables, configs, selectedExecutable: executables.some(name => name.toLowerCase() === entry.toLowerCase()) ? entry : undefined })
  if (!known || game.identity_confirmed) return { game, known }
  const patch = normalizedIdentityPatch(game, known)
  return { game: Object.keys(patch).length ? updateGame(getDb(), game.id, patch)! : game, known }
}

/** 清掉这个游戏在封面目录里的所有文件（含换过扩展名留下的孤儿） */
function dropCoverFiles(id: string, keep = ''): void {
  const dir = coversDir()
  const owned = new Set(coverSiblings(id))
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${id}.`) && /^[a-f0-9-]{36}\.[a-z]+$/i.test(name.slice(id.length + 1)) && isCoverExt(name)) owned.add(name)
    }
  } catch { /* no cached covers */ }
  for (const name of owned) {
    if (name.toLowerCase() === keep.toLowerCase()) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* 正被渲染进程占用之类，删不掉就留着，下次换封面会覆盖 */
    }
  }
}

export function validateCoverFile(file: string): { ok: boolean; message: string; width?: number; height?: number; bytes?: number } {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return { ok: false, message: '封面文件为空' }
    if (stat.size > MAX_COVER_BYTES) return { ok: false, message: '封面文件太大' }
    const image = nativeImage.createFromPath(file)
    const size = image.getSize()
    if (!size.width || !size.height) return { ok: false, message: '文件不是可解码的图片' }
    if (Math.min(size.width, size.height) < MIN_COVER_SHORT_EDGE || Math.max(size.width, size.height) < MIN_COVER_LONG_EDGE) {
      return { ok: false, message: `图片尺寸太小（${size.width} × ${size.height}），短边至少 ${MIN_COVER_SHORT_EDGE}、长边至少 ${MIN_COVER_LONG_EDGE} 像素` }
    }
    if (Math.max(size.width, size.height) > MAX_COVER_EDGE || size.width * size.height > MAX_COVER_PIXELS) {
      return { ok: false, message: '图片像素尺寸超出封面限制' }
    }
    return { ok: true, message: '', width: size.width, height: size.height, bytes: stat.size }
  } catch (err: any) {
    return { ok: false, message: `读取图片失败：${err?.message ?? '未知错误'}` }
  }
}

/** Publish an immutable file, commit its reference, then retire the previous image. */
export function replaceCoverFile(
  id: string, source: string, ext: string, commit?: (file: string) => void
): { ok: boolean; message: string; path?: string } {
  const dir = coversDir()
  if (!COVER_EXTS.includes(ext.toLowerCase())) return { ok: false, message: '不支持的封面格式' }
  const token = randomUUID()
  const destination = path.join(dir, `${id}.${token}${ext}`)
  const staging = path.join(dir, `.${id}.${token}.tmp`)
  let installed = false
  try {
    fs.copyFileSync(source, staging)
    const valid = validateCoverFile(staging)
    if (!valid.ok) return valid
    fs.renameSync(staging, destination)
    installed = true
    commit?.(destination)
    dropCoverFiles(id, path.basename(destination))
    return { ok: true, message: '', path: destination }
  } catch (err: any) {
    try { if (installed) fs.rmSync(destination, { force: true }) } catch { /* unreferenced new file; old cover is intact */ }
    return { ok: false, message: `写入封面失败：${err?.message ?? '未知错误'}` }
  } finally {
    try { if (existsSync(staging)) fs.rmSync(staging, { force: true }) } catch { /* best effort */ }
  }
}

function commitGameCover(id: string, sourceFile: string, source: GameItem['cover_source'], sourceUrl: string): { ok: boolean; message: string } {
  const db = getDb()
  return replaceCoverFile(id, sourceFile, path.extname(sourceFile).toLowerCase(), file => {
    db.exec('SAVEPOINT game_cover_write')
    try {
      updateGame(db, id, { cover_path: file, cover_source: source, cover_source_url: sourceUrl, cover_status: 'ready', cover_detail: '' })
      db.exec('RELEASE SAVEPOINT game_cover_write')
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT game_cover_write')
      db.exec('RELEASE SAVEPOINT game_cover_write')
      throw error
    }
  })
}

function recordCoverFailure(id: string, revision: number, message: string): void {
  const game = getGame(getDb(), id)
  if (!game || coverRevision(id) !== revision) return
  try {
    updateGame(getDb(), id, {
      cover_status: game.cover_path && validateCoverFile(game.cover_path).ok ? 'ready' : 'failed',
      cover_detail: message
    })
  } catch { /* Reporting a DB write failure must not hide the original error. */ }
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
  advanceCoverRevision(id)

  const from = path.resolve(source)
  if (!isCoverExt(from)) {
    return { ok: false, message: `只认这些格式：${COVER_EXTS.join('、')}` }
  }
  if (!existsSync(from)) return { ok: false, message: '这个文件不在了' }

  const valid = validateCoverFile(from)
  if (!valid.ok) return valid
  const replaced = commitGameCover(id, from, 'manual', '')
  if (!replaced.ok) return replaced
  return { ok: true, message: '封面已更换' }
}

/** 撤掉封面，退回首字占位。磁盘上那份拷贝一起删，留着只是占地方 */
export function clearGameCover(id: string): GameItem | null {
  advanceCoverRevision(id)
  if (!getGame(getDb(), id)) return null
  const updated = updateGame(getDb(), id, {
    cover_path: '', cover_source: '', cover_source_url: '', cover_status: 'missing', cover_detail: ''
  })
  dropCoverFiles(id)
  return updated
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
async function netFetch(url: string, imageOnly = false): Promise<Response> {
  const signal = AbortSignal.timeout(NET_TIMEOUT)
  let current = url
  for (let i = 0; i < 5; i++) {
    if (imageOnly && !acceptImageUrl(current)) throw new Error('图片跳转到了不支持的来源')
    if (!imageOnly) {
      const host = new URL(current).hostname
      if (new URL(current).protocol !== 'https:' || !(host === 'store.steampowered.com' || host === 'launcher.mihoyo.com' || host.endsWith('.mihoyo.com'))) {
        throw new Error('查询跳转到了不支持的来源')
      }
    }
    const response = await net.fetch(current, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const next = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!next) throw new Error('跳转缺少目标地址')
    current = new URL(next, current).href
  }
  throw new Error('来源跳转次数过多')
}

async function networkRoute(url: string): Promise<string> {
  try { return (await session.defaultSession.resolveProxy(url)) || 'DIRECT' }
  catch { return '系统网络（路由信息不可用）' }
}

async function readCoverBytes(response: Response, limit = MAX_COVER_BYTES): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('响应内容超出大小限制')
  }
  if (!response.body) throw new Error('来源没有返回内容')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) throw new Error('响应内容超出大小限制')
      chunks.push(Buffer.from(value))
    }
    if (!total) throw new Error('来源返回了空内容')
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function previewFile(url: string): string | undefined {
  if (isLocalCoverUrl(url)) return path.join(coversDir(), new URL(url).pathname.slice(1))
  const key = createHash('sha1').update(url).digest('hex').slice(0, 20)
  return COVER_EXTS.map(ext => path.join(coversDir(), `preview-${key}${ext}`)).find(file => existsSync(file) && validateCoverFile(file).ok)
}

function readyCandidate(candidate: CoverCandidate, file: string, route: string): CoverCandidate {
  const valid = validateCoverFile(file)
  if (!valid.ok) throw new Error(valid.message)
  return {
    ...candidate, title: candidate.title || candidate.label, status: 'ready', stage: undefined, message: '',
    width: valid.width, height: valid.height, bytes: valid.bytes, portrait: valid.height! > valid.width!, route,
    preview_url: `baoyi://cover/${encodeURIComponent(path.basename(file))}?v=${fs.statSync(file).mtimeMs}`
  }
}

/** Fetch, decode and cache are one operation; a URL alone is never a ready preview. */
async function cacheCandidatePreview(candidate: CoverCandidate): Promise<CoverCandidate> {
  let tmp = ''
  let stage: NonNullable<CoverCandidate['stage']> = 'network'
  let route = ''
  try {
    if (!acceptImageUrl(candidate.url)) throw new Error('图片地址不在允许的来源里')
    const cached = previewFile(candidate.url)
    if (cached) return readyCandidate(candidate, cached, '本地缓存')
    route = await networkRoute(candidate.url)
    const res = await netFetch(candidate.url, true)
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`HTTP ${res.status}`)
    }
    stage = 'decode'
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      await res.body?.cancel().catch(() => undefined)
      throw new Error('来源返回 HTML 网页，可能需要验证或登录，没有收到图片')
    }
    const ext = extFromContentType(contentType)
    if (!ext) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error('来源返回的不是受支持的图片')
    }
    stage = 'network'
    const bytes = await readCoverBytes(res)
    stage = 'decode'
    if (/^\s*(?:<!doctype\s+html\b|<(?:html|head|body)\b)/i.test(bytes.subarray(0, 512).toString('utf8'))) {
      throw new Error('来源返回 HTML 网页，可能需要验证或登录，没有收到图片')
    }
    const key = createHash('sha1').update(candidate.url).digest('hex').slice(0, 20)
    const file = path.join(coversDir(), `preview-${key}${ext}`)
    tmp = `${file}.${randomUUID()}.tmp`
    stage = 'cache'
    fs.writeFileSync(tmp, bytes)
    stage = 'decode'
    const valid = validateCoverFile(tmp)
    if (!valid.ok) throw new Error(valid.message)
    stage = 'cache'
    fs.renameSync(tmp, file)
    tmp = ''
    return readyCandidate(candidate, file, route)
  } catch (err: any) {
    return { ...candidate, title: candidate.title || candidate.label, status: 'failed', stage, message: err?.message || '候选图不可用', route, preview_url: undefined }
  } finally {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
  }
}

function localCoverCandidates(game: GameItem): CoverCandidate[] {
  const out: CoverCandidate[] = []
  for (const dir of gameDirectories(game)) {
    let names: string[]
    try { names = fs.readdirSync(dir).filter(name => /^(?:poster|cover|folder)\.(?:png|jpe?g|webp|avif|gif|bmp)$/i.test(name)) }
    catch { continue }
    for (const name of names.slice(0, 6)) {
      let tmp = ''
      let candidate: CoverCandidate = { url: '', title: game.identity_name || game.name_en || game.name_zh, label: `本地 ${name}`, source: 'local', portrait: false, rank: /^(?:poster)/i.test(name) ? 0 : /^cover/i.test(name) ? 1 : 2, route: '本地文件' }
      let stage: NonNullable<CoverCandidate['stage']> = 'decode'
      try {
        const source = path.join(dir, name)
        const stat = fs.statSync(source)
        const key = createHash('sha1').update(`${source}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 20)
        const cacheName = `preview-local-${key}${path.extname(name).toLowerCase()}`
        const file = path.join(coversDir(), cacheName)
        candidate = { ...candidate, url: `baoyi://cover/${cacheName}` }
        const valid = validateCoverFile(source)
        if (!valid.ok) throw new Error(valid.message)
        stage = 'cache'
        tmp = `${file}.${randomUUID()}.tmp`
        fs.copyFileSync(source, tmp)
        const staged = validateCoverFile(tmp)
        if (!staged.ok) { stage = 'decode'; throw new Error(staged.message) }
        fs.renameSync(tmp, file)
        tmp = ''
        out.push(readyCandidate(candidate, file, '本地文件'))
      } catch (err: any) {
        out.push({ ...candidate, status: 'failed', stage, message: err?.message || '本地图片不可用' })
      } finally {
        if (tmp) { try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ } }
      }
    }
  }
  return finalizeCandidates(out)
}

const OFFICIAL_GENSHIN_COVERS: CoverCandidate[] = [
  {
    url: 'https://act-webstatic.mihoyo.com/puzzle/hyp/pz_Bur_m6Btc7/resource/puzzle/2024/04/11/014eb24be7604aad6c6b289ac01d57f5_3910634999481955313.png',
    label: '原神官方图', source: 'official', portrait: true, rank: -10
  },
  {
    url: 'https://act-webstatic.mihoyo.com/puzzle/hyp/pz_Bur_m6Btc7/resource/puzzle/2024/04/11/014eb24be7604aad6c6b289ac01d57f5_2164983007399311744.png',
    label: '原神官方图（备用）', source: 'official', portrait: true, rank: -9
  }
]

async function officialGenshinCandidates(diagnostics: GameCoverDiagnostic[]): Promise<CoverCandidate[]> {
  const route = await networkRoute('https://launcher.mihoyo.com/')
  try {
    const page = await netFetch('https://launcher.mihoyo.com/')
    if (!page.ok) throw new Error(`官方启动器页面 HTTP ${page.status}`)
    const html = (await readCoverBytes(page, 1_000_000)).toString('utf8')
    const urls = configUrlsFromLauncher(html).slice(0, 4)
    for (const configUrl of urls) {
      try {
        const script = await netFetch(configUrl)
        if (!script.ok) throw new Error(`官方配置 HTTP ${script.status}`)
        const identity = parseOfficialConfig((await readCoverBytes(script, 2_000_000)).toString('utf8'), configUrl)
        if (!identity) continue
        return identity.candidates.map((url, rank) => ({ url, title: '原神 / Genshin Impact', label: `原神官方图${rank ? '（备用）' : ''}`, source: 'official', portrait: true, rank: rank - 10 }))
      } catch (err: any) {
        diagnostics.push({ source: 'official', stage: 'lookup', status: 'failed', message: err?.message || '官方配置读取失败', route, url: configUrl })
      }
    }
    diagnostics.push({ source: 'official', stage: 'lookup', status: 'failed', message: '官方配置中没有找到可确认的原神图片', route })
  } catch (err: any) {
    diagnostics.push({ source: 'official', stage: 'network', status: 'failed', message: err?.message || '官方来源访问失败', route })
  }
  return []
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
  const json: any = JSON.parse((await readCoverBytes(res, 2_000_000)).toString('utf8'))
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
export async function searchGameCovers(id: string, recoverStored = false): Promise<GameCoverSearchResult> {
  const original = getGame(getDb(), id)
  if (!original) return { ok: false, message: '找不到这个游戏', candidates: [], query: '', diagnostics: [] }
  const revision = coverRevision(id)
  const { game, known } = refreshKnownIdentity(original)
  const queries = coverQueries(game)
  let usedQuery = queries[0] || ''
  const diagnostics: GameCoverDiagnostic[] = []
  if (known) diagnostics.push({ source: 'local', stage: 'identity', status: 'ready', message: `${known.evidence}确认了原神身份`, route: '本地文件' })
  const found: CoverCandidate[] = []
  const record = (candidates: CoverCandidate[]): void => {
    for (const c of candidates) diagnostics.push({ source: c.source, stage: c.stage || 'cache', status: c.status === 'ready' ? 'ready' : 'failed', message: c.message || `${c.label}：${c.width} × ${c.height}，已缓存`, route: c.route, url: c.url })
  }
  const finish = (): GameCoverSearchResult => {
    const candidates = finalizeCandidates(found)
    const ready = candidates.filter(c => c.status === 'ready')
    const failures = diagnostics.filter(d => d.status === 'failed')
    const message = ready.length ? '' : `${[...new Set(failures.map(d => d.message))].slice(0, 3).join('；') || '没有找到可用封面'}。可调整封面关键词，或手动选一张图。`
    if (!ready.length) recordCoverFailure(id, revision, message)
    return { ok: ready.length > 0, message, candidates, query: usedQuery, diagnostics }
  }
  const cache = async (candidates: CoverCandidate[]): Promise<void> => {
    const checked = await inBatches(finalizeCandidates(candidates), 3, cacheCandidatePreview)
    found.push(...checked)
    record(checked)
  }

  if (recoverStored && game.cover_source_url) {
    const url = game.cover_source_url
    const candidate: CoverCandidate = {
      url, source: isLocalCoverUrl(url) ? 'local' : game.cover_source === 'official' ? 'official' : game.cover_source === 'steam' ? 'steam' : 'search',
      title: game.identity_name || game.name_en || game.name_zh, label: '上次选择的封面', portrait: false, rank: -20
    }
    if (isLocalCoverUrl(url)) {
      try {
        const recovered = readyCandidate(candidate, previewFile(url)!, '本地缓存')
        found.push(recovered)
        record([recovered])
      } catch (err: any) {
        diagnostics.push({ source: 'local', stage: 'cache', status: 'failed', message: `上次选择的本地缓存不可用：${err?.message || '文件丢失'}`, route: '本地缓存' })
      }
    } else if (acceptImageUrl(url)) await cache([candidate])
    if (found.some(c => c.status === 'ready')) return finish()
  }
  const localCandidates = localCoverCandidates(game)
  found.push(...localCandidates)
  record(localCandidates)
  if (!localCandidates.length) diagnostics.push({ source: 'local', stage: 'lookup', status: 'skipped', message: '游戏目录中没有 poster、cover 或 folder 图片', route: '本地文件' })
  if (found.some(c => c.status === 'ready')) return finish()
  if (!queries.length) {
    diagnostics.push({ source: 'local', stage: 'identity', status: 'failed', message: '尚未确认游戏名称，启动器名称不能用于查找封面', route: '本地文件' })
    return finish()
  }

  const officialGenshin = !!known || (game.identity_confirmed && isGenshinLauncherAlias(game.identity_name)) ||
    /^(?:原神|genshin\s+impact)$/i.test(usedQuery) ||
    (isGenshinAlias(usedQuery) && (!!known || game.identity_confirmed))
  if (officialGenshin) {
    await cache(OFFICIAL_GENSHIN_COVERS.map(c => ({ ...c, title: '原神 / Genshin Impact' })))
    if (!found.some(c => c.status === 'ready')) await cache(await officialGenshinCandidates(diagnostics))
    return finish()
  }

  let appid = ''
  if (!game.identity_query.trim()) {
    for (const dir of gameDirectories(game)) {
      try {
        const file = path.join(dir, 'steam_appid.txt')
        if (fs.statSync(file).size > 64) continue
        const value = fs.readFileSync(file, 'utf8').trim()
        if (/^[1-9]\d{0,9}$/.test(value)) { appid = value; break }
      } catch { /* no declared Steam app */ }
    }
  }
  if (appid) {
    diagnostics.push({ source: 'steam', stage: 'lookup', status: 'ready', message: `本地 Steam AppID：${appid}`, route: '本地文件' })
    await cache(steamCoverCandidates(appid, usedQuery).map(c => ({ ...c, title: usedQuery })))
  } else {
    for (const query of queries) {
      usedQuery = query
      const route = await networkRoute(steamSearchUrl(query))
      try {
        const apps = await steamApps(query)
        diagnostics.push({ source: 'steam', stage: 'lookup', status: apps.length ? 'ready' : 'failed', message: apps.length ? `Steam 找到 ${apps.length} 个相关游戏` : `Steam 未找到「${query}」的相关游戏`, route })
        await cache(apps.flatMap(a => steamCoverCandidates(a.id, a.name).map(c => ({ ...c, title: a.name }))))
        if (found.some(c => c.status === 'ready')) break
      } catch (err: any) {
        diagnostics.push({ source: 'steam', stage: 'network', status: 'failed', message: `Steam 搜索失败：${err?.message || '网络不可用'}`, route })
        break
      }
    }
  }

  const cfg = getSettings().search
  if (!found.some(c => c.status === 'ready') && imageSearchAvailable(cfg)) {
    try { await cache(candidatesFromSearch(await searchImages(`${usedQuery} game cover art`, cfg))) }
    catch (err: any) { diagnostics.push({ source: 'search', stage: 'lookup', status: 'failed', message: `图片搜索失败：${err?.message || '未知错误'}`, route: '已配置的图片搜索服务' }) }
  } else if (!found.some(c => c.status === 'ready')) {
    const why = imageSearchWhyNot(cfg)
    if (why) diagnostics.push({ source: 'search', stage: 'lookup', status: 'skipped', message: why })
  }
  return finish()
}

export interface GameCoverBatchResult {
  processed: number
  updated: number
  failed: number
  skipped: number
}

let coverBatchRunning = false

/** 为当前筛选列表批量补图；只处理没有 ready 本地封面的条目。 */
export async function rebuildMissingGameCovers(
  ids: string[] = [],
  onProgress?: (progress: { processed: number; total: number; current: string; message: string }) => void
): Promise<GameCoverBatchResult> {
  if (coverBatchRunning) throw new Error('已有封面补齐任务正在进行，请等待它完成')
  coverBatchRunning = true
  try {
  const db = getDb()
  const all = [...new Set(ids)].map(id => getGame(db, id)).filter((g): g is GameItem => !!g)
  // Snapshot every revision at batch start, including games still waiting in line.
  const pending = all.filter(g => !g.cover_path || !validateCoverFile(g.cover_path).ok)
    .map(game => ({ game, revision: coverRevision(game.id) }))
  let updated = 0
  let failed = 0
  let skipped = 0
  const report = (processed: number, current: string, message: string): void => {
    // A closed renderer cannot turn a completed file write into a failed operation.
    try { onProgress?.({ processed, total: pending.length, current, message }) } catch { /* progress sink gone */ }
  }
  report(0, '', `当前范围 ${all.length} 个游戏，待补齐 ${pending.length} 个`)
  for (let i = 0; i < pending.length; i++) {
    const { game, revision } = pending[i]
    const name = game.name_zh || game.name_en || game.file_name
    const current = getGame(db, game.id)
    if (!current || coverRevision(game.id) !== revision || (current.cover_path && validateCoverFile(current.cover_path).ok)) {
      skipped++
      report(i + 1, name, '已跳过：条目或封面已有更新')
      continue
    }
    report(i, name, '正在查找和恢复封面')
    try {
      const result = await searchGameCovers(game.id, true)
      if (coverRevision(game.id) !== revision || !getGame(db, game.id)) {
        skipped++
        report(i + 1, name, '已跳过：保留较新的选择')
        continue
      }
      let applied = false
      let reason = result.message || '没有可用封面'
      for (const candidate of result.candidates.filter(c => c.status === 'ready')) {
        const chosen = await setGameCoverFromUrl(game.id, candidate.url, revision)
        if (chosen.ok) { applied = true; break }
        reason = chosen.message
        if (coverRevision(game.id) !== revision) break
      }
      if (applied) {
        updated++
        report(i + 1, name, '封面已补齐')
      } else if (coverRevision(game.id) === revision) {
        failed++
        report(i + 1, name, `补图失败：${reason}`)
      } else {
        skipped++
        report(i + 1, name, '已跳过：保留较新的选择')
      }
    } catch (err: any) {
      if (coverRevision(game.id) === revision) {
        failed++
        recordCoverFailure(game.id, revision, `补图失败：${err?.message || '未知错误'}`)
        report(i + 1, name, `补图失败：${err?.message || '未知错误'}`)
      } else {
        skipped++
        report(i + 1, name, '已跳过：保留较新的选择')
      }
    }
  }
  report(pending.length, '', pending.length
    ? `封面处理结束：补齐 ${updated} 个，失败 ${failed} 个，跳过 ${skipped} 个`
    : '当前范围的封面已齐全')
  return { processed: pending.length, updated, failed, skipped }
  } finally { coverBatchRunning = false }
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
  url: string,
  expectedRevision?: number
): Promise<{ ok: boolean; message: string }> {
  if (!getGame(getDb(), id)) return { ok: false, message: '找不到这个游戏' }
  if (expectedRevision !== undefined && coverRevision(id) !== expectedRevision) return { ok: false, message: '封面已有更新，已取消旧选择' }
  const revision = expectedRevision ?? advanceCoverRevision(id)
  const fail = (message: string): { ok: false; message: string } => {
    recordCoverFailure(id, revision, message)
    return { ok: false, message }
  }
  if (!acceptImageUrl(url) && !isLocalCoverUrl(url)) return fail('这个图片地址不在允许的来源里')
  try {
    const local = isLocalCoverUrl(url)
    const host = new URL(url).hostname
    const source: CoverCandidate['source'] = local ? 'local' : host.endsWith('.mihoyo.com') ? 'official' : /(?:steamstatic\.com|steampowered\.com|steamcdn-a\.akamaihd\.net)$/.test(host) ? 'steam' : 'search'
    let file = previewFile(url)
    if (local) {
      if (!file || !existsSync(file)) return fail('本地预览缓存不存在，请重新搜索封面')
      const valid = validateCoverFile(file)
      if (!valid.ok) return fail(`本地预览图片校验失败：${valid.message}`)
    } else if (!file) {
      const candidate = await cacheCandidatePreview({ url, source, label: '所选封面', portrait: false, rank: 0 })
      if (coverRevision(id) !== revision || !getGame(getDb(), id)) return { ok: false, message: '封面已有更新，已取消旧选择' }
      if (candidate.status !== 'ready') return fail(`${candidate.stage === 'decode' ? '图片解码' : candidate.stage === 'cache' ? '缓存写入' : '网络请求'}失败：${candidate.message}`)
      file = previewFile(url)
    }
    if (coverRevision(id) !== revision || !getGame(getDb(), id)) return { ok: false, message: '封面已有更新，已取消旧选择' }
    if (!file) return fail('候选缓存不存在，请重新搜索封面')
    const replaced = commitGameCover(id, file, source, url)
    if (!replaced.ok) return fail(`写入失败：${replaced.message}`)
    return { ok: true, message: '封面已设置' }
  } catch (err: any) {
    return fail(`封面设置失败：${err?.message || '未知错误'}`)
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

    const trail: AgentEvent[] = []
    const registeredBefore = result.registered, skippedBefore = result.skipped
    const identifyStarted = Date.now()
    const run = await runAgent({
      config: settings.ai,
      system,
      user: candidatePrompt(c, gamesUnder(db, c.dir)),
      tools: buildGameTools(ctx, categoryNames, withSearch),
      maxTurns: MAX_TURNS,
      finalTools: ['register_game', 'skip_directory'],
      finalTurns: 2,
      signal,
      onEvent: (e) => {
        trail.push(e)
        report({ current: c.dir, processed: i, log: describeEvent(e) })
      }
    })
    result.tokens += run.tokens

    // 落识别日志
    if (run.stopReason !== 'aborted') {
      const registered = result.registered - registeredBefore
      const failed = !registered && result.skipped === skippedBefore
      const status = registered ? 'success' : failed ? 'failed' : 'skipped'
      const note = registered ? '已注册' : run.stopReason === 'error' ? `识别失败：${run.error}` :
                   run.stopReason === 'max_turns' ? '达到识别预算，未登记；可手动选择主程序后补充资料' : failed ? '未完成登记，可手动添加主程序' : '已明确跳过'

      try {
        saveIdentifyLog({
          dir: c.dir,
          label: path.basename(c.dir),
          kind: 'unit',
          resource_kind: 'game',
          status,
          summary: note,
          registered,
          rounds: run.turns,
          duration_ms: Date.now() - identifyStarted,
          tokens: run.tokens,
          stop_reason: run.stopReason,
          events: trail
        })
      } catch {
        /* 日志写不进去不该让识别结果跟着失败 */
      }
    }

    if (run.stopReason !== 'aborted' && result.registered === registeredBefore && result.skipped === skippedBefore) result.failed++
  }

  report({ phase: 'done', processed: candidates.length })
  return result
}
