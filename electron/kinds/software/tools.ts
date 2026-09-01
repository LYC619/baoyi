/**
 * 交给识别 agent 的工具集。
 *
 * 工具参数由模型生成，不可信：所有路径参数都必须先过 paths.ts 的 resolveInside()，
 * 越界一律拒绝并把原因回灌给模型。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Launcher, MoveRisk, RegisterPayload, SearchConfig } from '../../../src/types'
import { readExternalActiveAt } from '../../services/activity'
import { extractIcon } from '../../services/iconExtractor'
import { timeAsync, timeSync } from '../../services/timing.ts'
import { countExes } from './exeCount'
import { isManualIcon } from './icons.ts'
import { readPeArch, readPeInfo } from './peReader'
// skippable 和扫描时用的是同一份名单：同一棵目录树，扫描不进去的地方
// agent 也不该为了数 exe 进去
import { skippable } from './scanPlan'
import { formatHits, search } from '../../services/searchService'
import {
  getSoftware,
  isSkipped,
  listCategories,
  registerSoftware,
  stagePending,
  tagPool,
  updateSoftware,
  type RegisterFileFacts
} from '../../services/database'
import type { AgentTool } from '../../services/agent/loop'
import { formatSize, isReadableName, readTextFile } from '../../services/agent/files'
import { limitTags as limitTagsTo } from './prompts'
import { resolveInside as resolveInsideRoots } from '../../services/agent/paths'

/** 统计子目录里的 exe 时的护栏，避免在 node_modules 之类的目录里空转 */
const COUNT_MAX_DEPTH = 3
/**
 * **一次 list_directory 的总遍历预算**，所有子目录共用。
 *
 * 从前这个上限是「每个子目录 3000 项」，于是一次工具调用最坏要访问
 * 120 × 3000 = 36 万个目录项 —— 这是界面卡死的直接原因。改成整次调用共用一份预算，
 * 最坏就是这个数。花完了后面的子目录报一个带 `+` 的下界，agent 照样能判断
 * 「值不值得进去看」，那本来就是这个数字的唯一用途。
 */
const COUNT_BUDGET = 20_000
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
  /**
   * false 表示识别结果先进暂存区等用户确认（整目录识别走这条）。
   * true 表示直接写进 software —— 只有「用户点着某一条说重新识别」时才这样，
   * 那种情况用户已经明确指定了对象，再拦一道确认只是碍事。
   */
  direct: boolean
  onRegister?: (info: { name: string; exe_path: string; created: boolean }) => void
  onSkip?: (dir: string, reason: string) => void
}

function resolveInside(ctx: ToolContext, raw: unknown): string {
  return resolveInsideRoots(ctx.roots, raw)
}

/* ------------------------------ 目录浏览 ------------------------------ */

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

  // 整次调用共用的遍历预算，见 COUNT_BUDGET
  let budget = COUNT_BUDGET

  for (const entry of entries.slice(0, LIST_LIMIT)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const { count, truncated, visited } = await timeAsync(`countExes ${entry.name}`, () =>
        countExes(full, {
          maxDepth: COUNT_MAX_DEPTH,
          maxEntries: budget,
          skip: skippable
        })
      )
      budget = Math.max(0, budget - visited)
      // 带 `+` 是在说「至少这么多，没数完」。别把下界写成确切值 ——
      // agent 拿这个数决定要不要进去，「0 个 exe」和「没数完」对它是两回事
      dirs.push(`  ${entry.name}/  —— 内含 ${count}${truncated ? '+' : ''} 个 exe`)
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

/**
 * is_portable 是三态的，所以不能用 `=== true` 一刀切 —— 那会把「模型没填」
 * 和「模型判断为不是」压成同一个值，而整理时这两者的处理方式相反。
 * 只认真正的布尔（含模型爱输出的 "true"/"false" 字符串），其余一律 null。
 */
function triBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function moveRisk(raw: unknown): MoveRisk {
  return raw === 'safe' || raw === 'risky' ? raw : 'unknown'
}

/**
 * 收口到 prompts.ts 里那份实现 —— 它和「最多新增 1 个」那句提示词写在一起，
 * 是同一条规则的两半，分开放迟早会各改各的。这里只负责把模型给的原始参数洗干净。
 */
function limitTags(raw: unknown, pool: Set<string>): string[] {
  return limitTagsTo(coerceStringList(raw, 8, 12), pool)
}

async function register(ctx: ToolContext, args: any): Promise<string> {
  const launchers = coerceLaunchers(ctx, args?.launchers)

  const nameZh = str(args?.name_zh, 40)
  if (!nameZh) throw new Error('name_zh 不能为空')

  let url = str(args?.official_url, 200)
  if (url && !/^https?:\/\//i.test(url)) url = ''

  // 分类不再强行改写成「其他」：模型提了一个新分类是有信息量的，
  // 交给确认面板高亮成「新分类」，由用户决定要不要建。空的才兜底。
  const category = str(args?.category, 20) || '其他'

  const payload: RegisterPayload = {
    name_zh: nameZh,
    name_en: str(args?.name_en, 60),
    summary: str(args?.summary, 60) || '未填写说明',
    description: str(args?.description, 400),
    category,
    tags: limitTags(args?.tags, new Set(tagPool())),
    official_url: url,
    launchers,
    source_dir: ctx.unitDir,
    is_portable: triBool(args?.is_portable),
    move_risk: moveRisk(args?.move_risk)
  }

  const primary = launchers.find((l) => l.is_default && l.kind === 'main')
    ?? launchers.find((l) => l.kind === 'main')
    ?? launchers[0]
  const { arch: _arch, ...facts } = fileFacts(primary.path)

  // 图标先取好：暂存条目也要在确认面板上显示图标，失败不影响识别结果
  const icon = (await extractIcon(primary.path)) ?? ''

  if (ctx.direct) {
    const outcome = timeSync(`registerSoftware ${nameZh}`, () => registerSoftware(payload, facts))
    if (!outcome) throw new Error('注册失败：没有可用的启动端')
    // 用户亲手换过的图标不许覆盖。「重新识别」是针对**识别结果**的，
    // 不是「把我调过的样子还原」—— 而自动提取的那张覆盖掉无所谓，它本来就是提的
    const existing = getSoftware(outcome.id)
    const manual = existing ? isManualIcon(outcome.id, existing.icon_path) : false
    if (icon && !manual) updateSoftware(outcome.id, { icon_path: icon })
    ctx.onRegister?.({ name: nameZh, exe_path: outcome.exe_path, created: outcome.created })
    return registerReply(nameZh, primary, launchers, outcome.created ? '已注册' : '已更新', payload)
  }

  if (isSkipped(primary.path)) {
    // 用户之前明确说过不要它。别再塞进确认面板让他否决第二次
    return `「${nameZh}」（${primary.path}）之前已被用户标记为不注册，本次不再收录。继续处理这个目录里的其他程序。`
  }

  const outcome = timeSync(`stagePending ${nameZh}`, () =>
    stagePending(payload, facts, ctx.unitDir, icon)
  )
  if (!outcome) throw new Error('暂存失败：没有可用的启动端')
  ctx.onRegister?.({ name: nameZh, exe_path: outcome.exe_path, created: outcome.created })
  return registerReply(nameZh, primary, launchers, '已记录（待用户确认）', payload)
}

function registerReply(
  name: string,
  primary: Launcher,
  launchers: Launcher[],
  verb: string,
  payload: RegisterPayload
): string {
  const extras = launchers.filter((l) => l !== primary)
  const portable =
    payload.is_portable === null ? '未判断' : payload.is_portable ? '是' : '否'
  return [
    `${verb}「${name}」`,
    `默认启动端：${primary.path}`,
    // 把这两个字段回读一遍：它们决定抱一敢不敢搬这个目录，
    // 而识别日志是事后唯一能查「当时凭什么这么判断」的地方
    `绿色软件：${portable}　移动风险：${payload.move_risk}`,
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
  const categories = listCategories()
  const categoryNames = categories.map((c) => c.name)
  const pool = tagPool()

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
            description: `按**用途**分类，只能从以下选择：${categories.map((c) => `${c.name}（${c.description}）`).join('；')}`,
            enum: categoryNames
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: pool.length
              ? `1-3 个标签，描述类型特征或技术属性，不要重复分类已经表达的用途。优先从现有标签池里选：${pool.join('、')}。确实都不合适时，最多新增 1 个。`
              : '1-3 个标签，描述类型特征或技术属性（便携、开源、CLI、GUI、单文件…），不要重复分类已经表达的用途。'
          },
          official_url: { type: 'string', description: '官网地址，不确定就留空字符串' },
          is_portable: {
            type: ['boolean', 'null'],
            description:
              '是不是绿色软件（解压即用、无安装器、配置在自身目录下、有 portable 标记）。' +
              '判断不了就填 null —— 抱一会因此不去移动它的目录，这是安全的一侧。不要猜。'
          },
          move_risk: {
            type: 'string',
            enum: ['safe', 'risky', 'unknown'],
            description:
              '把它的目录挪到别处会不会出事。safe = 只是一堆文件，挪走照样跑；' +
              'risky = 注册了服务/驱动/COM、装在系统保护目录、或被别的程序按固定路径依赖；' +
              'unknown = 判断不了。risky 和 unknown 都只会做链接不做移动，但要分开填。'
          },
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
        required: ['name_zh', 'summary', 'category', 'launchers', 'move_risk']
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
