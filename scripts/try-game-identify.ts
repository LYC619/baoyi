/**
 * 拿真实的游戏目录跑一遍识别，不需要启动应用。
 *
 *   npm run try-game -- "D:\\Games"            扫一个根，逐个识别
 *   npm run try-game -- "D:\\Games\\空洞骑士"   只识别这一个目录
 *   npm run try-game -- "D:\\Games" --dry      只扫不识别，看看目录判断准不准
 *
 * 这是 Step 3 的验收出口：游戏模块还没有界面，识别链路又必须在接界面之前
 * 就确认是通的 —— 名字认得对不对、存档找不找得到，只有对着真目录跑才知道。
 *
 * 结果写进内存库，**不碰用户的真实库**。API Key 从真实库里读（只读打开），
 * 免得每次跑都要重新填一遍。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AIConfig, SearchConfig } from '../src/types/index.ts'
import { runAgent, type AgentEvent } from '../electron/services/agent/loop.ts'
import { searchAvailable } from '../electron/services/searchService.ts'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { gameKind } from '../electron/kinds/game/index.ts'
import { inspectDir, scanGameRoot, type GameCandidate } from '../electron/kinds/game/scanner.ts'
import { candidatePrompt, fillGameSystem } from '../electron/kinds/game/prompts.ts'
import { buildGameTools, type GameToolContext } from '../electron/kinds/game/tools.ts'
import { gamesUnder } from '../electron/kinds/game/db.ts'

const MAX_TURNS = 14

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry')

if (!target) {
  console.error('用法：npm run try-game -- "D:\\\\Games" [--dry]')
  process.exit(1)
}
if (!fs.existsSync(target)) {
  console.error(`目录不存在：${target}`)
  process.exit(1)
}

/** 从真实库里借一份接口配置。只读打开，一个字都不会写回去 */
function borrowConfig(): { ai: AIConfig; search: SearchConfig } {
  const file = path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')
  const fallback = {
    ai: { api_url: '', api_key: '', model: '', enabled: false },
    search: { provider: 'model_builtin', api_key: '', endpoint: '', enabled: false } as SearchConfig
  }
  if (!fs.existsSync(file)) return fallback
  try {
    const d = new DatabaseSync(file, { readOnly: true })
    const read = (key: string): any => {
      const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
      try {
        return row ? JSON.parse(row.value) : null
      } catch {
        return null
      }
    }
    const out = { ai: read('ai') ?? fallback.ai, search: read('search') ?? fallback.search }
    d.close()
    return out
  } catch {
    return fallback
  }
}

function describe(c: GameCandidate): void {
  console.log(`\n── ${c.dir}`)
  console.log(c.evidence.length ? c.evidence.map((e) => `   · ${e}`).join('\n') : '   · （无引擎特征）')
  console.log(`   exe ${c.exes.length} 个，疑似主程序：${c.likely_main || '（无把握）'}`)
}

async function main(): Promise<void> {
  // 传进来的可能是一个扫描根，也可能就是一个游戏目录本身。两种都得认
  const direct = inspectDir(target!, path.dirname(target!))
  const candidates = direct ? [direct] : await scanGameRoot(target!)

  console.log(`\n扫描 ${target}\n找到 ${candidates.length} 个候选目录`)
  for (const c of candidates) describe(c)

  if (dryRun || candidates.length === 0) return

  const { ai, search } = borrowConfig()
  if (!ai.api_key) {
    console.log('\n真实库里没有 API Key，只跑了目录判断。填好 Key 之后再跑一次就能验识别。')
    return
  }
  const withSearch = searchAvailable(search)

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  initSchema(db as any, KINDS)
  const pool = (
    db.prepare(`SELECT name FROM tags WHERE kind = 'game' ORDER BY name`).all() as any[]
  ).map((r) => r.name as string)
  const categories = gameKind.defaultCategories
  const system = fillGameSystem(categories, pool, withSearch)

  console.log(`\n模型 ${ai.model}　联网搜索 ${withSearch ? '开' : '关'}　结果写内存库，不动真实库`)

  for (const c of candidates) {
    console.log(`\n${'='.repeat(60)}\n识别 ${c.dir}`)
    const ctx: GameToolContext = {
      roots: [c.dir],
      gameDir: c.dir,
      db: db as any,
      tagPool: pool,
      searchConfig: search,
      onSkip: (_, reason) => console.log(`   → 跳过：${reason}`)
    }
    const onEvent = (e: AgentEvent): void => {
      if (e.type !== 'tool_call') return
      const a = e.args as Record<string, any>
      console.log(`   · ${e.name}(${a.path ?? a.query ?? a.name_zh ?? ''})`)
    }

    const result = await runAgent({
      config: ai,
      system,
      user: candidatePrompt(c, gamesUnder(db as any, c.dir)),
      tools: buildGameTools(ctx, categories.map((x) => x.name), withSearch),
      maxTurns: MAX_TURNS,
      onEvent
    })
    console.log(`   停因 ${result.stopReason}，${result.turns} 轮，${result.tokens} token`)
    if (result.stopReason === 'error') console.log(`   错误：${result.error}`)
  }

  console.log(`\n${'='.repeat(60)}\n识别结果`)
  const rows = db.prepare('SELECT * FROM game ORDER BY created_at').all() as any[]
  if (rows.length === 0) console.log('（一条都没识别出来）')
  for (const r of rows) {
    const saves = JSON.parse(r.save_paths) as Array<{ path: string }>
    console.log(`\n  ${r.name_zh}${r.name_en ? ` / ${r.name_en}` : ''}`)
    console.log(`    ${r.summary}`)
    console.log(`    分类 ${r.category}　标签 ${JSON.parse(r.tags).join('、') || '（无）'}`)
    console.log(`    主程序 ${r.path}`)
    console.log(`    存档   ${saves.length ? saves.map((s) => s.path).join('\n           ') : '（未找到）'}`)
  }
  db.close()
}

void main()
