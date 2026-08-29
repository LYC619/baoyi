/**
 * 游戏模块的编排层：把 Step 3 的扫描器、提示词、工具接到真实的库和界面上。
 *
 * 和 db.ts / scanner.ts / tools.ts 的分工是明确的 —— 那三个刻意不碰
 * services/database.ts，好让自检能用 node:sqlite 驱动同一份逻辑；这个文件
 * 是它们与 Electron 之间唯一的接缝，所以它是整条链路里唯一不可自检的一层，
 * 因此它只做绑定和汇总，不放任何判断规则。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  GameCounts,
  GameItem,
  GameQuery,
  GameScanProgress,
  GameScanResult,
  SaveBackup,
  SaveBackupResult,
  SavePath,
  SavePathAlert,
  SavePathCheck,
  SaveRestoreResult
} from '../../../src/types'
import { app, shell } from 'electron'
import { runAgent, type AgentEvent } from '../../services/agent/loop'
import {
  getDb,
  getSettings,
  listCategories,
  saveBackupRoot,
  tagPool
} from '../../services/database'
import { searchAvailable } from '../../services/searchService'
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
export const removeGame = (id: string): void => deleteGame(getDb(), id)

export function updateGameItem(id: string, patch: Partial<GameItem>): GameItem | null {
  return updateGame(getDb(), id, patch)
}

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
