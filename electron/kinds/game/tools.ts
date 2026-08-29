/**
 * 交给游戏识别 agent 的工具集。
 *
 * 工具参数由模型生成，不可信：所有落到文件系统上的路径都必须先过一道边界。
 * 这里有**两道**，因为游戏识别比软件多一件事 —— 找存档，而存档几乎总在
 * 游戏目录之外：
 *   · 游戏目录内的浏览（list_directory / read_text_file / register_game）
 *     走 paths.ts 的 resolveInside，白名单就是本次负责的那棵子树；
 *   · detect_save_path 必须能走出去，走的是 scanner.ts 的 saveRoots 白名单
 *     —— 「游戏可能存档的地方」，不是「用户的整个主目录」。它只读不写。
 *
 * 不 import services/database.ts：那条链路依赖 electron 和 better-sqlite3，
 * 一旦引进来，整套识别就只能在应用跑起来之后才验证得了。落库走 ctx.db
 * 这个最小 SQL 句柄，见 db.ts 顶上的说明。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LinkedFile, SavePath, SearchConfig } from '../../../src/types'
import type { AgentTool } from '../../services/agent/loop.ts'
import type { SqlDb } from '../../services/schema.ts'
import { formatSize, isReadableName, readTextFile } from '../../services/agent/files.ts'
import { resolveInside as resolveInsideRoots } from '../../services/agent/paths.ts'
import { formatHits, search } from '../../services/searchService.ts'
import { expandSavePath, probeSave, saveRootOf, saveRoots } from './scanner.ts'
import { insertGame, type GamePayload } from './db.ts'

/** 单次 list_directory 最多列出的条目数 */
const LIST_LIMIT = 120
/** 一次识别最多验几个存档路径。上限在 prompt 里也写了一遍，这里是执行它的那一半 */
const MAX_SAVE_PROBES = 6

export interface GameToolContext {
  /** 允许浏览的目录白名单，通常就是本次负责的那个游戏目录 */
  roots: string[]
  /** 本次负责的目录，落库时作为 source_dir */
  gameDir: string
  /** 落库句柄 */
  db: SqlDb
  /** 现有标签池，用来收敛模型新造标签的冲动 */
  tagPool: string[]
  searchConfig: SearchConfig
  onRegister?: (info: { name: string; exe_path: string; created: boolean }) => void
  onSkip?: (dir: string, reason: string) => void
}

function resolveInside(ctx: GameToolContext, raw: unknown): string {
  return resolveInsideRoots(ctx.roots, raw)
}

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

/* ------------------------------ 目录浏览 ------------------------------ */

async function listDirectory(ctx: GameToolContext, args: any): Promise<string> {
  const dir = resolveInside(ctx, args?.path)

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(`目录不存在：${dir}`)
    if (err?.code === 'ENOTDIR') throw new Error(`${dir} 不是目录`)
    throw new Error(`无法读取目录 ${dir}：${err?.code ?? err?.message ?? '未知错误'}`)
  }

  const dirs: string[] = []
  const exes: string[] = []
  const docs: string[] = []
  const others: string[] = []

  for (const entry of entries.slice(0, LIST_LIMIT)) {
    if (entry.isDirectory()) {
      dirs.push(entry.name)
      continue
    }
    if (!entry.isFile()) continue

    const ext = path.extname(entry.name).toLowerCase()
    if (ext === '.exe') {
      let size = 0
      try {
        size = (await fsp.stat(path.join(dir, entry.name))).size
      } catch {
        /* 读不到大小不影响列出 */
      }
      exes.push(`  ${entry.name}  ${formatSize(size)}`)
    } else if (isReadableName(entry.name)) {
      docs.push(entry.name)
    } else {
      others.push(entry.name)
    }
  }

  const lines = [`目录：${dir}`]
  lines.push(dirs.length ? `子目录（${dirs.length}）：${dirs.join('、')}` : '子目录：无')
  lines.push(exes.length ? `本级 exe（${exes.length}）：\n${exes.join('\n')}` : '本级 exe：无')
  if (docs.length) {
    lines.push(`可读文档（${docs.length}，用 read_text_file 读）：${docs.slice(0, 20).join('、')}`)
  }
  if (others.length) {
    lines.push(
      `其他文件（${others.length}）：${others.slice(0, 20).join('、')}${others.length > 20 ? ' …' : ''}`
    )
  }
  if (entries.length > LIST_LIMIT) {
    lines.push(`（该目录共 ${entries.length} 项，只列出了前 ${LIST_LIMIT} 项）`)
  }
  return lines.join('\n')
}

/* ------------------------------ 存档探测 ------------------------------ */

/** 上一次验证成功的路径，register_game 拿它核对模型有没有编 */
type ProbeLedger = Map<string, number>

function describeProbe(target: string, probe: ReturnType<typeof probeSave>): string {
  if (!probe.exists) {
    return `${target}\n不存在。换一个写法或换一个位置再试，或者放弃 —— save_paths 留空是可以接受的。`
  }
  if (probe.files === 0) {
    return `${target}\n目录存在，但**一个文件都没有**。这多半不是这个游戏的存档目录，不要填进 save_paths。`
  }
  const age = Date.now() - probe.newest
  const days = Math.floor(age / 86_400_000)
  return [
    `${target}`,
    `存在，${probe.files} 个文件，共 ${formatSize(probe.bytes)}`,
    `最后修改：${days} 天前`,
    `文件示例：${probe.sample.join('、')}`,
    days > 3650
      ? '注意：十年没动过了，八成不是这个游戏的存档，谨慎填入。'
      : '看起来是有效的存档目录，可以填进 save_paths。'
  ].join('\n')
}

async function detectSavePath(
  ctx: GameToolContext,
  ledger: ProbeLedger,
  args: any
): Promise<string> {
  if (ledger.size >= MAX_SAVE_PROBES) {
    return (
      `已经验过 ${MAX_SAVE_PROBES} 个路径了，不要再试。` +
      `把已经验证存在的那些填进 save_paths（一个都没有就留空），然后调用 register_game。`
    )
  }

  const raw = str(args?.path, 400)
  if (!raw) throw new Error('path 不能为空')

  const target = expandSavePath(raw)
  // 游戏目录自己也算合法的存档位置：绿色版、汉化版、RPG Maker 大多就地存档
  const allowed = [...saveRoots(), ...ctx.roots]
  if (!saveRootOf(target, allowed)) {
    throw new Error(
      `路径越界：${target} 不在允许查看的范围内。` +
        `存档只可能在这些位置之下：${allowed.join('、')}。` +
        `如果你写的是 %XXX% 变量而它没有被展开，说明那个变量名不认识，请改用完整路径。`
    )
  }

  const probe = probeSave(target)
  ledger.set(target.toLowerCase(), probe.exists && probe.files > 0 ? Date.now() : 0)
  return describeProbe(target, probe)
}

/* ------------------------------ 注册游戏 ------------------------------ */

/**
 * 标签收敛，和 prompt 里「最多新增 1 个」是同一条规则的两半：
 * prompt 负责说，这里负责在模型不听话时执行。池内的照单全收，
 * 池外的只留第一个，总数封顶 3 个。逻辑与 software/prompts.ts 的 limitTags
 * 一致，但刻意各留一份 —— 跨品类 import 会让两边的规则从此绑死。
 */
export function limitGameTags(raw: unknown, pool: Set<string>): string[] {
  const all = (Array.isArray(raw) ? raw : [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 12))
  const known = all.filter((t) => pool.has(t))
  const fresh = all.filter((t) => !pool.has(t)).slice(0, 1)
  return [...new Set([...known, ...fresh])].slice(0, 3)
}

/**
 * 只收 detect_save_path 亲自验过、且确实有文件的路径。
 *
 * 这一道不是形式主义：prompt 已经写了「一条都不许编」，但模型编路径是
 * 最常见的失手，而编出来的后果是「备份存档」备份一个空文件夹 ——
 * 用户以为自己有备份，真丢档的那天才发现没有。宁可留空。
 */
export function acceptSavePaths(raw: unknown, ledger: ProbeLedger): {
  kept: SavePath[]
  rejected: string[]
} {
  const kept: SavePath[] = []
  const rejected: string[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const p = typeof item === 'string' ? item : (item as any)?.path
    if (typeof p !== 'string' || !p.trim()) continue
    const resolved = expandSavePath(p)
    const verified = ledger.get(resolved.toLowerCase())
    if (verified) kept.push({ path: resolved, verified_at: verified })
    else rejected.push(resolved)
  }
  return { kept, rejected }
}

const LINK_TYPES = new Set(['guide', 'trainer', 'mod', 'emulator', 'other'])

function coerceLinkedFiles(ctx: GameToolContext, raw: unknown): LinkedFile[] {
  const out: LinkedFile[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const src = (item && typeof item === 'object' ? item : { path: item }) as Record<string, unknown>
    let target: string
    try {
      target = resolveInside(ctx, src.path)
    } catch {
      continue // 关联文件是锦上添花，越界的悄悄丢掉即可，不必打断注册
    }
    if (!fs.existsSync(target)) continue
    const type = String(src.type ?? 'other')
    out.push({
      path: target,
      label: str(src.label, 20) || path.basename(target),
      type: (LINK_TYPES.has(type) ? type : 'other') as LinkedFile['type']
    })
  }
  return out.slice(0, 10)
}

async function register(ctx: GameToolContext, ledger: ProbeLedger, args: any): Promise<string> {
  const exePath = resolveInside(ctx, args?.exe_path)
  if (!fs.existsSync(exePath)) {
    throw new Error(`主程序不存在：${exePath}。请只填写你在目录线索或 list_directory 里真实看到的文件。`)
  }

  const nameZh = str(args?.name_zh, 60)
  if (!nameZh) throw new Error('name_zh 不能为空')

  let url = str(args?.official_url, 200)
  if (url && !/^https?:\/\//i.test(url)) url = ''

  let size = 0
  try {
    size = fs.statSync(exePath).size
  } catch {
    /* 保持 0 */
  }

  const { kept, rejected } = acceptSavePaths(args?.save_paths, ledger)

  const payload: GamePayload = {
    exe_path: exePath,
    name_zh: nameZh,
    name_en: str(args?.name_en, 80),
    summary: str(args?.summary, 60) || '未填写说明',
    description: str(args?.description, 400),
    // 分类不强行改写成「其他」：模型提了个新分类是有信息量的，交给用户裁决。空的才兜底
    category: str(args?.category, 20) || '其他',
    tags: limitGameTags(args?.tags, new Set(ctx.tagPool)),
    official_url: url,
    source_dir: ctx.gameDir,
    file_size: size,
    save_paths: kept,
    linked_files: coerceLinkedFiles(ctx, args?.linked_files)
  }

  const outcome = insertGame(ctx.db, payload)
  ctx.onRegister?.({ name: nameZh, exe_path: exePath, created: outcome.created })

  const lines = [
    `${outcome.created ? '已注册' : '已更新'}游戏「${nameZh}」`,
    `主程序：${exePath}`,
    `分类：${payload.category}　标签：${payload.tags.join('、') || '（无）'}`,
    kept.length ? `存档路径 ${kept.length} 条：${kept.map((s) => s.path).join('；')}` : '存档路径：未找到（已留空）'
  ]
  if (rejected.length) {
    // 回灌而不是静默丢弃：模型下一次调用能看见自己编了什么，比事后翻日志有用
    lines.push(
      `以下路径没有经过 detect_save_path 验证，已被丢弃：${rejected.join('；')}。` +
        `如果你确信它们存在，先用 detect_save_path 验一遍再重新注册。`
    )
  }
  lines.push('这个目录处理完了，直接回复一句总结，不要再调用工具。')
  return lines.join('\n')
}

/* ------------------------------ 跳过 ------------------------------ */

async function skip(ctx: GameToolContext, args: any): Promise<string> {
  const dir = resolveInside(ctx, args?.path)
  const reason = str(args?.reason, 200) || '未说明原因'
  ctx.onSkip?.(dir, reason)
  return `已记录跳过：${dir}（${reason}）。直接回复一句总结即可，不要再调用工具。`
}

/* ------------------------------ 联网搜索 ------------------------------ */

async function webSearch(ctx: GameToolContext, args: any): Promise<string> {
  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')
  try {
    return formatHits(query, await search(query, ctx.searchConfig))
  } catch (err) {
    // 搜索挂了不该拖垮识别，让 agent 退回本地信息继续判断
    return `搜索「${query}」失败：${err instanceof Error ? err.message : String(err)}。请依据本地信息判断。`
  }
}

/* ------------------------------ 工具定义 ------------------------------ */

export function buildGameTools(
  ctx: GameToolContext,
  categoryNames: string[],
  withSearch: boolean
): AgentTool[] {
  // 每次识别一个新的 ctx，账本跟着它走：模型不能靠上一个游戏验过的路径蒙混过关
  const ledger: ProbeLedger = new Map()

  const tools: AgentTool[] = [
    {
      name: 'list_directory',
      description: '列出指定目录下的文件和文件夹。任务描述里的「目录线索」通常已经够用，不够时再调。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要列出的目录的绝对路径' } },
        required: ['path']
      },
      execute: (args) => listDirectory(ctx, args)
    },
    {
      name: 'read_text_file',
      description:
        '读取说明文档：readme、使用说明.txt、安装说明、汉化说明等。汉化版和整合包的说明文件里' +
        '常常直接写着游戏原名和存档位置，读它比联网搜索更快更准。自动处理 GBK / UTF-8 编码。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文本文件的绝对路径' } },
        required: ['path']
      },
      execute: (args) => readTextFile(resolveInside(ctx, args?.path))
    },
    {
      name: 'detect_save_path',
      description:
        '验证一个候选存档路径是否真实存在，返回文件数、总大小、最后修改时间和文件名示例。' +
        `支持 %APPDATA%、%LOCALAPPDATA%、%USERPROFILE% 等变量。一次只验一个，最多验 ${MAX_SAVE_PROBES} 个。` +
        '**只有这个工具确认存在且有文件的路径，才允许填进 register_game 的 save_paths。**',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '候选存档路径，例如 %LOCALAPPDATA%Low\\Team Cherry\\Hollow Knight ' +
              '或 %USERPROFILE%\\Documents\\My Games\\某游戏，也可以是游戏目录下的 save 文件夹'
          }
        },
        required: ['path']
      },
      execute: (args) => detectSavePath(ctx, ledger, args)
    },
    {
      name: 'register_game',
      description: '把识别结果注册为一个游戏条目。一个游戏调用一次，填它的主程序路径。',
      parameters: {
        type: 'object',
        properties: {
          exe_path: {
            type: 'string',
            description: '游戏主程序的绝对路径。不是崩溃上报程序、不是安装器、不是卸载器。'
          },
          name_zh: { type: 'string', description: '通行中文名，不带书名号；没有通行译名就填英文原名' },
          name_en: { type: 'string', description: '官方英文名，保持官方大小写和空格' },
          summary: { type: 'string', description: '一句话说明，15-20 字' },
          description: { type: 'string', description: '中文描述玩法和特色，50-100 字' },
          category: {
            type: 'string',
            description: `按玩法类型分类，只能从以下选择：${categoryNames.join('、')}`,
            enum: categoryNames
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: ctx.tagPool.length
              ? `1-3 个标签，描述玩法特征、题材或来源，不要重复分类已经表达的类型。优先从现有标签池里选：${ctx.tagPool.join('、')}。确实都不合适时最多新增 1 个。`
              : '1-3 个标签，描述玩法特征、题材或来源（开放世界、像素、汉化、独立游戏…）。'
          },
          official_url: { type: 'string', description: '官网或商店页地址，不确定就传空字符串' },
          save_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              '存档目录的绝对路径。**每一条都必须先用 detect_save_path 验证过存在且有文件**，' +
              '没验证过的会被直接丢弃。一个都没找到就传空数组 —— 留空是可以接受的答案。'
          },
          linked_files: {
            type: 'array',
            description: '游戏目录内的攻略、修改器、MOD 等附属文件。没有就不填。',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '绝对路径，必须在游戏目录内' },
                label: { type: 'string', description: '展示名，如「修改器」「图文攻略」' },
                type: { type: 'string', enum: ['guide', 'trainer', 'mod', 'emulator', 'other'] }
              },
              required: ['path', 'label', 'type']
            }
          }
        },
        required: ['exe_path', 'name_zh', 'summary', 'category', 'save_paths']
      },
      execute: (args) => register(ctx, ledger, args)
    },
    {
      name: 'skip_directory',
      description:
        '判断这个目录不是游戏（模拟器本体、MOD 工具、纯攻略文档、普通软件、空壳目录等），跳过并记录原因。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要跳过的目录绝对路径' },
          reason: { type: 'string', description: '跳过原因，一句话' }
        },
        required: ['path', 'reason']
      },
      execute: (args) => skip(ctx, args)
    }
  ]

  if (withSearch) {
    tools.push({
      name: 'web_search',
      description:
        '搜索互联网了解这是什么游戏。最后手段：先看目录线索，再读目录里的说明文档，都判断不出来时才用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，建议「游戏名 + 游戏」，优先中文' }
        },
        required: ['query']
      },
      execute: (args) => webSearch(ctx, args)
    })
  }

  return tools
}
