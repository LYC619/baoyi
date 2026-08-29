/**
 * 游戏模块的编排层：把 Step 3 的扫描器、提示词、工具接到真实的库和界面上。
 *
 * 和 db.ts / scanner.ts / tools.ts 的分工是明确的 —— 那三个刻意不碰
 * services/database.ts，好让自检能用 node:sqlite 驱动同一份逻辑；这个文件
 * 是它们与 Electron 之间唯一的接缝，所以它是整条链路里唯一不可自检的一层，
 * 因此它只做绑定和汇总，不放任何判断规则。
 */

import path from 'node:path'
import type {
  GameCounts,
  GameItem,
  GameQuery,
  GameScanProgress,
  GameScanResult
} from '../../../src/types'
import { runAgent, type AgentEvent } from '../../services/agent/loop'
import { getDb, getSettings, listCategories, tagPool } from '../../services/database'
import { searchAvailable } from '../../services/searchService'
import {
  deleteGame,
  gameCounts,
  gamesUnder,
  getGame,
  listGames,
  updateGame
} from './db'
import { candidatePrompt, fillGameSystem } from './prompts'
import { inspectDir, scanGameRoot, type GameCandidate } from './scanner'
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

/* ------------------------------ 读写转发 ------------------------------ */

export const listGameItems = (query: GameQuery = {}): GameItem[] => listGames(getDb(), query)
export const getGameItem = (id: string): GameItem | null => getGame(getDb(), id)
export const gameCountsOf = (): GameCounts => gameCounts(getDb())
export const removeGame = (id: string): void => deleteGame(getDb(), id)

export function updateGameItem(id: string, patch: Partial<GameItem>): GameItem | null {
  return updateGame(getDb(), id, patch)
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
