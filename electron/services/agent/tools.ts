/**
 * 交给识别 agent 的工具集。
 *
 * 工具参数由模型生成，不可信：所有路径参数都必须先过 paths.ts 的 resolveInside()，
 * 越界一律拒绝并把原因回灌给模型。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Launcher, RegisterPayload, SearchConfig } from '../../../src/types'
import { readExternalActiveAt } from '../activity'
import { extractIcon } from '../iconExtractor'
import { readPeArch, readPeInfo } from '../peReader'
import { formatHits, search } from '../searchService'
import {
  listCategories,
  registerSoftware,
  updateSoftware,
  type RegisterFileFacts
} from '../database'
import type { AgentTool } from './loop'
import { formatSize, isReadableName, readTextFile } from './files'
import { resolveInside as resolveInsideRoots } from './paths'

/** 统计子目录里的 exe 时的护栏，避免在 node_modules 之类的目录里空转 */
const COUNT_MAX_DEPTH = 3
const COUNT_MAX_ENTRIES = 3000
/** 单次 list_directory 最多列出的条目数 */
const LIST_LIMIT = 120

export interface ToolContext {
  /** 允许访问的目录白名单，通常是本次负责的那棵子树 */
  roots: string[]
  /** 本次运行负责的目录 */
  unitDir: string
  /** 只识别 unitDir 直属的 exe（扫描根里的散装程序） */
  looseOnly: boolean
  searchConfig: SearchConfig
  onRegister?: (info: { name: string; exe_path: string; created: boolean }) => void
  onSkip?: (dir: string, reason: string) => void
}

function resolveInside(ctx: ToolContext, raw: unknown): string {
  return resolveInsideRoots(ctx.roots, raw)
}

/* ------------------------------ 目录浏览 ------------------------------ */

/** 递归数一个目录下有多少 exe，用来告诉 agent 值不值得进去看 */
function countExes(dir: string): number {
  let count = 0
  let visited = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]

  while (stack.length > 0) {
    const { dir: current, depth } = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > COUNT_MAX_ENTRIES) return count
      if (entry.isDirectory()) {
        if (depth < COUNT_MAX_DEPTH) stack.push({ dir: path.join(current, entry.name), depth: depth + 1 })
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') {
        count++
      }
    }
  }
  return count
}

async function listDirectory(ctx: ToolContext, args: any): Promise<string> {
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
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const n = countExes(full)
      dirs.push(`  ${entry.name}/  —— 内含 ${n} 个 exe`)
      continue
    }
    if (!entry.isFile()) continue

    const ext = path.extname(entry.name).toLowerCase()
    if (ext === '.exe') {
      let size = 0
      try {
        size = (await fsp.stat(full)).size
      } catch {
        /* 读不到大小不影响列出 */
      }
      exes.push(`  ${entry.name}  ${formatSize(size)}`)
    } else if (isReadableName(entry.name)) {
      // 说明文档单独列出来，别让它淹没在几百个 dll 里 —— 读它往往比联网搜索更快更准
      docs.push(entry.name)
    } else {
      others.push(entry.name)
    }
  }

  const lines = [`目录：${dir}`]
  lines.push(dirs.length ? `子目录（${dirs.length}）：\n${dirs.join('\n')}` : '子目录：无')
  lines.push(exes.length ? `本级 exe（${exes.length}）：\n${exes.join('\n')}` : '本级 exe：无')
  if (docs.length) {
    lines.push(`可读文档（${docs.length}，用 read_text_file 读）：${docs.slice(0, 20).join('、')}`)
  }
  if (others.length) {
    lines.push(`其他文件（${others.length}）：${others.slice(0, 20).join('、')}${others.length > 20 ? ' …' : ''}`)
  }
  if (entries.length > LIST_LIMIT) {
    lines.push(`（该目录共 ${entries.length} 项，只列出了前 ${LIST_LIMIT} 项）`)
  }
  return lines.join('\n')
}

/* ------------------------------ 读文本文件 ------------------------------ */

async function readDoc(ctx: ToolContext, args: any): Promise<string> {
  return readTextFile(resolveInside(ctx, args?.path))
}

/* ------------------------------ 文件信息 ------------------------------ */

function fileFacts(exePath: string): RegisterFileFacts & { arch: string } {
  let size = 0
  try {
    size = fs.statSync(exePath).size
  } catch {
    /* 保持 0 */
  }
  const pe = readPeInfo(exePath, size)
  return {
    file_name: path.basename(exePath),
    file_description: pe.file_description || pe.product_name,
    company: pe.company,
    version: pe.version,
    file_size: size,
    external_active_at: readExternalActiveAt(exePath),
    arch: readPeArch(exePath)
  }
}

async function getFileInfo(ctx: ToolContext, args: any): Promise<string> {
  const file = resolveInside(ctx, args?.path)
  let stat: fs.Stats
  try {
    stat = await fsp.stat(file)
  } catch {
    throw new Error(`文件不存在或无法访问：${file}`)
  }
  if (!stat.isFile()) throw new Error(`${file} 不是文件`)

  const facts = fileFacts(file)
  const pe = readPeInfo(file, facts.file_size)
  return [
    `文件：${file}`,
    `大小：${formatSize(facts.file_size)}`,
    `位数：${facts.arch || '未知'}`,
    `PE 文件描述：${pe.file_description || '（无）'}`,
    `PE 产品名：${pe.product_name || '（无）'}`,
    `PE 公司：${pe.company || '（无）'}`,
    `PE 版本：${pe.version || '（无）'}`
  ].join('\n')
}

/* ------------------------------ 注册软件 ------------------------------ */

function coerceLaunchers(ctx: ToolContext, raw: unknown): Launcher[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('launchers 必须是非空数组，至少包含主程序一项')
  }
  const out: Launcher[] = []
  for (const item of raw) {
    const src = (item && typeof item === 'object' ? item : { path: item }) as Record<string, unknown>
    const target = resolveInside(ctx, src.path)
    if (!fs.existsSync(target)) {
      throw new Error(`启动端不存在：${target}。请只填写你在 list_directory 里真实看到的文件。`)
    }
    out.push({
      path: target,
      label: typeof src.label === 'string' ? src.label.trim().slice(0, 20) : '',
      kind: src.kind === 'extra' ? 'extra' : 'main',
      is_default: src.is_default === true
    })
  }
  return out
}

function coerceStringList(raw: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, itemMax))
    .slice(0, max)
}

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

async function register(ctx: ToolContext, args: any): Promise<string> {
  const known = listCategories().map((c) => c.name)
  const launchers = coerceLaunchers(ctx, args?.launchers)

  const nameZh = str(args?.name_zh, 40)
  if (!nameZh) throw new Error('name_zh 不能为空')

  let url = str(args?.official_url, 200)
  if (url && !/^https?:\/\//i.test(url)) url = ''

  const category = known.includes(str(args?.category, 20)) ? str(args?.category, 20) : '其他'

  const payload: RegisterPayload = {
    name_zh: nameZh,
    name_en: str(args?.name_en, 60),
    summary: str(args?.summary, 60) || '未填写说明',
    description: str(args?.description, 400),
    category,
    tags: coerceStringList(args?.tags, 5, 12),
    official_url: url,
    launchers,
    source_dir: ctx.unitDir
  }

  const primary = launchers.find((l) => l.is_default && l.kind === 'main')
    ?? launchers.find((l) => l.kind === 'main')
    ?? launchers[0]
  const { arch: _arch, ...facts } = fileFacts(primary.path)

  const outcome = registerSoftware(payload, facts)
  if (!outcome) throw new Error('注册失败：没有可用的启动端')

  // 图标只取默认启动端的；失败不影响注册结果
  const icon = await extractIcon(outcome.exe_path)
  if (icon) updateSoftware(outcome.id, { icon_path: icon })

  ctx.onRegister?.({ name: nameZh, exe_path: outcome.exe_path, created: outcome.created })

  const extras = launchers.filter((l) => l !== primary)
  return [
    `${outcome.created ? '已注册' : '已更新'}「${nameZh}」`,
    `默认启动端：${primary.path}`,
    extras.length
      ? `其余启动端 ${extras.length} 个：${extras.map((l) => `${path.basename(l.path)}${l.label ? `(${l.label})` : ''}`).join('、')}`
      : '无其他启动端',
    '如果这个目录里还有别的独立软件，继续处理；都处理完就直接回复一句总结，不要再调用工具。'
  ].join('\n')
}

/* ------------------------------ 跳过目录 ------------------------------ */

async function skip(ctx: ToolContext, args: any): Promise<string> {
  const dir = resolveInside(ctx, args?.path)
  const reason = str(args?.reason, 200) || '未说明原因'
  ctx.onSkip?.(dir, reason)
  return `已记录跳过：${dir}（${reason}）。如果本次任务没有别的目录要处理了，直接回复一句总结即可。`
}

/* ------------------------------ 联网搜索 ------------------------------ */

async function webSearch(ctx: ToolContext, args: any): Promise<string> {
  const query = str(args?.query, 120)
  if (!query) throw new Error('query 不能为空')
  try {
    const hits = await search(query, ctx.searchConfig)
    return formatHits(query, hits)
  } catch (err) {
    // 搜索挂了不该拖垮识别，让 agent 退回本地信息继续判断
    return `搜索「${query}」失败：${err instanceof Error ? err.message : String(err)}。请依据本地信息判断。`
  }
}

/* ------------------------------ 工具定义 ------------------------------ */

export function buildTools(ctx: ToolContext, withSearch: boolean): AgentTool[] {
  const categories = listCategories().map((c) => c.name)

  const tools: AgentTool[] = [
    {
      name: 'list_directory',
      description:
        '列出指定目录下的所有文件和文件夹。子目录会附带它内部递归的 exe 数量，用来判断要不要进去看。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要列出的目录的绝对路径' }
        },
        required: ['path']
      },
      execute: (args) => listDirectory(ctx, args)
    },
    {
      name: 'get_file_info',
      description:
        '读取一个 exe 的详细信息：文件大小、位数（x64/x86）、PE 资源里的文件描述、产品名、公司和版本号。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'exe 文件的绝对路径' }
        },
        required: ['path']
      },
      execute: (args) => getFileInfo(ctx, args)
    },
    {
      name: 'read_text_file',
      description:
        '读取说明文档的内容：README、changelog、使用说明.txt、LICENSE 等。绿色软件目录里常有这类文件，一读就知道是什么软件，比联网搜索更快更准。自动处理 GBK / UTF-8 编码。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文本文件的绝对路径。只能读 list_directory 里「可读文档」那一栏列出的文件。'
          }
        },
        required: ['path']
      },
      execute: (args) => readDoc(ctx, args)
    },
    {
      name: 'register_software',
      description:
        '把识别结果注册为一个软件条目。同一个软件的 32/64 位、GUI/命令行版本要合并成一次调用，通过 launchers 数组列出各个启动端。',
      parameters: {
        type: 'object',
        properties: {
          name_zh: { type: 'string', description: '中文名称；没有通行中文名就用英文原名' },
          name_en: { type: 'string', description: '英文原名' },
          summary: { type: 'string', description: '一句话功能说明，15-20 字' },
          description: { type: 'string', description: '详细功能描述，50-100 字' },
          category: {
            type: 'string',
            description: `分类，只能从以下选择：${categories.join('/')}`,
            enum: categories
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '2-3 个标签，每个不超过 6 个字'
          },
          official_url: { type: 'string', description: '官网地址，不确定就留空字符串' },
          launchers: {
            type: 'array',
            description:
              '该软件的全部启动端。主程序 kind 填 main，加载器/配置工具等附属程序 kind 填 extra。有且只有一个 is_default 为 true，64 位优先。',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'exe 绝对路径' },
                label: { type: 'string', description: '展示名，如「64 位」「32 位」「命令行」' },
                kind: { type: 'string', enum: ['main', 'extra'] },
                is_default: { type: 'boolean' }
              },
              required: ['path', 'label', 'kind', 'is_default']
            }
          }
        },
        required: ['name_zh', 'summary', 'category', 'launchers']
      },
      execute: (args) => register(ctx, args)
    },
    {
      name: 'skip_directory',
      description:
        '判断某个目录不是软件目录（依赖库、资源、文档、空目录等），跳过它并记录原因。',
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
        '搜索互联网获取软件相关信息。这是最后手段：先看 PE 信息，再读目录里的 README / 说明文档，两者都判断不出来时才用它。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词，建议用「软件名 + 功能/用途」，优先中文'
          }
        },
        required: ['query']
      },
      execute: (args) => webSearch(ctx, args)
    })
  }

  return tools
}
