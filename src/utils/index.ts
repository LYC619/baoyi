import type {
  AgentEvent,
  IdentifyLog,
  IdentifyLogStatus,
  MasteryLevel,
  SearchCallRecord,
  SoftwareItem,
  TitleLang
} from '@/types'

const DAY = 86_400_000

/**
 * 递给 window.baoyi.* 之前，把 Vue 的 reactive 代理拍平成普通值。
 *
 * 代理过不了 contextBridge 的结构化克隆，而且它是**同步**抛
 * 「An object could not be cloned.」—— 抛在 contextBridge 那一层，
 * preload 函数体根本没开始执行。所以这层拍平必须留在渲染进程侧：
 * 放进 preload.ts 是够不着的，参数在进门之前就已经炸了。
 *
 * 抛出点在 async 函数里，于是表现成一次静默 reject —— 「点了没反应」。
 */
export function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** 图标走 baoyi:// 自定义协议，主进程只按文件名在图标目录里找 */
export function iconUrl(iconPath: string): string {
  if (!iconPath) return ''
  const name = iconPath.split(/[\\/]/).pop() ?? ''
  return name ? `baoyi://icon/${encodeURIComponent(name)}` : ''
}

/**
 * 取名字只用得到这几个字段。写成结构类型而不是 SoftwareItem，
 * 是为了让确认面板里的暂存条目也能直接用同一套逻辑。
 */
export type NamedEntry = Pick<
  SoftwareItem,
  'name_zh' | 'name_en' | 'file_description' | 'file_name'
>

/** 兜底名：AI 还没识别出来时拿文件本身的信息顶上 */
function fallbackName(item: NamedEntry): string {
  return item.file_description || item.file_name.replace(/\.exe$/i, '')
}

/**
 * 卡片和详情页上打头的名字。
 *
 * lang='zh' 中文名优先，lang='en' 用官方原名优先 —— Process Monitor 这类软件
 * 本来就没有通行中文名，AI 硬译出来的「进程监视器」反而比原名难认。
 * 选中的那一侧没有值时自动落到另一侧，不会显示空标题。
 */
export function displayName(item: NamedEntry, lang: TitleLang = 'zh'): string {
  const [first, second] =
    lang === 'en' ? [item.name_en, item.name_zh] : [item.name_zh, item.name_en]
  return first || second || fallbackName(item)
}

/** 标题旁边那行小字。和标题同源时返回空，避免把同一个名字显示两遍 */
export function subtitleName(item: NamedEntry, lang: TitleLang = 'zh'): string {
  const other = lang === 'en' ? item.name_zh : item.name_en
  return other && other !== displayName(item, lang) ? other : ''
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 相对时间。0 表示从未启动过 */
export function formatRelative(ts: number): string {
  if (!ts) return '从未使用'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const days = Math.floor(diff / DAY)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

export function daysSince(ts: number): number {
  if (!ts) return Number.POSITIVE_INFINITY
  return Math.floor((Date.now() - ts) / DAY)
}

/** 这条「上次活跃」是抱一自己记的，还是从磁盘上推出来的 */
export type ActivitySource = 'baoyi' | 'external' | 'none'

export interface Activity {
  /** 用于「长期未用」判定的时间戳，0 表示读不出来 */
  at: number
  source: ActivitySource
  /** 卡片和详情页上那行字 */
  label: string
  /** 悬浮说明，讲清这个时间是哪来的 */
  hint: string
}

/**
 * 一个条目的「上次活跃」。
 *
 * 抱一启动过的以自己的记录为准；没启动过的退回外部活跃时间 —— 软件目录里
 * 配置文件的最新修改时间。两者都没有，才是真的「从未使用」。
 * 只看 last_used_at 会让刚导入的整个库都显示「从未使用」，那说的是抱一自己
 * 还没开始记账，不是用户没用过。
 */
export function activityOf(item: SoftwareItem): Activity {
  if (item.last_used_at > 0) {
    return {
      at: item.last_used_at,
      source: 'baoyi',
      label: formatRelative(item.last_used_at),
      hint: `由抱一启动 · ${formatDate(item.last_used_at)}`
    }
  }
  if (item.external_active_at > 0) {
    return {
      at: item.external_active_at,
      source: 'external',
      label: formatRelative(item.external_active_at),
      hint: `外部活跃 · ${formatDate(item.external_active_at)}（依据软件目录里配置文件的最后修改时间，未经抱一启动）`
    }
  }
  return {
    at: 0,
    source: 'none',
    label: '从未使用',
    hint: '抱一没记到过启动，目录里也读不出活跃痕迹'
  }
}

export const MASTERY_META: Record<MasteryLevel, { label: string; dots: number }> = {
  proficient: { label: '熟练', dots: 3 },
  familiar: { label: '会用', dots: 2 },
  learning: { label: '在学', dots: 1 },
  new: { label: '未上手', dots: 0 }
}

export const MASTERY_ORDER: MasteryLevel[] = ['proficient', 'familiar', 'learning', 'new']

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

/** 长路径中间省略，避免撑爆详情页 */
export function shortenPath(p: string, max = 52): string {
  if (p.length <= max) return p
  const head = p.slice(0, Math.ceil(max / 2) - 2)
  const tail = p.slice(-Math.floor(max / 2) + 1)
  return `${head}…${tail}`
}

/** 识别日志里的一轮：一个 turn 事件，加上这一轮里发生的所有调用与返回 */
export interface AgentRound {
  index: number
  /** i 是事件在原数组里的下标，用来做稳定的渲染 key */
  events: Array<{ event: AgentEvent; i: number }>
}

/**
 * 把 agent 事件流切成轮次。
 *
 * 依赖 loop.ts 每轮开头都发一个 type='turn' 的事件 —— 这是两边唯一的约定，
 * 所以 selfcheck 里拿真实的 runAgent 事件流跑一遍，约定破了当场就能发现。
 * 落在第一个 turn 之前的事件（日志被截断过时会出现）归到 0 轮，不会被丢掉。
 */
export function groupRounds(events: AgentEvent[]): AgentRound[] {
  const out: AgentRound[] = [{ index: 0, events: [] }]
  events.forEach((event, i) => {
    if (event.type === 'turn') {
      out.push({ index: event.index, events: [] })
      return
    }
    out[out.length - 1].events.push({ event, i })
  })
  return out.filter((r) => r.events.length > 0)
}

/* ------------------------------ 版本号比较 ------------------------------ */

/**
 * 从一段文字里抠出可比较的版本号。取**最后一个**像版本号的片段 ——
 * 路径里常有别的数字（`D:\Software\1.system\CC Switch\v3.16.5`），
 * 而版本号总在最靠近软件本身的那一段。
 *
 * 认不出来返回空数组，比较时排在所有能认出版本号的后面。
 */
export function parseVersion(text: string): number[] {
  const hits = text.match(/\d+(?:\.\d+){1,3}/g)
  if (!hits) return []
  return hits[hits.length - 1].split('.').map((n) => Number(n) || 0)
}

/** 逐段比大小。a 比 b 新返回正数。段数不同时缺的那几段按 0 算（3.16 < 3.16.1） */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 一个条目「有多新」。
 *
 * 优先信路径里的版本号：多版本并存时目录名就是用来区分版本的
 * （`CC Switch\v3.16.1` / `CC Switch\v3.16.5`），而 PE 版本号常常没跟着打包更新。
 * 路径里认不出来才退回 PE 的 version 字段。
 */
export function versionOf(item: { source_dir: string; exe_path: string; version: string }): number[] {
  const fromPath = parseVersion(item.source_dir || item.exe_path)
  return fromPath.length > 0 ? fromPath : parseVersion(item.version)
}

/* ------------------------------ 日志导出 ------------------------------ */

const LOG_STATUS_TEXT: Record<IdentifyLogStatus, string> = {
  success: '识别完成',
  skipped: '未注册任何条目',
  failed: '识别失败'
}

/**
 * 把一条识别日志摊成纯文本，用于复制到剪贴板。
 *
 * 页面上的折叠、截断、「展开全文」都是为了在一屏里放下几十条 —— 复制出去是要
 * 贴进 issue 或者对着看的，所以这里一个字不省：每一轮的调用、完整返回、模型原话。
 */
export function logToText(log: IdentifyLog): string {
  const seconds = (log.duration_ms / 1000).toFixed(1)
  const out = [
    `目录：${log.dir}`,
    `状态：${LOG_STATUS_TEXT[log.status]}${log.summary ? ` —— ${log.summary}` : ''}`,
    `轮次：${log.rounds} | 耗时：${seconds}s | Tokens：${log.tokens.toLocaleString()}`,
    ''
  ]
  if (log.stop_reason === 'max_turns') out.push('（达到轮数上限被强制结束，当时还没下结论）', '')

  for (const round of groupRounds(log.events)) {
    for (const { event } of round.events) {
      if (event.type === 'tool_call') {
        out.push(`[轮次 ${round.index}] → ${event.name} ${JSON.stringify(event.args)}`)
      } else if (event.type === 'tool_result') {
        out.push(`返回${event.isError ? '（错误）' : ''}：${event.text}`)
      } else if (event.type === 'text') {
        out.push(`[轮次 ${round.index}] 模型推理：${event.text}`)
      }
    }
  }
  return out.join('\n')
}

/* ------------------------------ 搜索调用记录 ------------------------------ */

/** webSearch 失败时不抛异常，而是把原因当正常返回喂回模型 —— 只能从文案上认 */
function searchStatus(text: string, isError: boolean): SearchCallRecord['status'] {
  if (/超时|timeout|timederror|aborted/i.test(text)) return 'timeout'
  if (isError || /^搜索「.*」失败/.test(text)) return 'failed'
  if (/没有搜到结果/.test(text)) return 'empty'
  return 'ok'
}

/**
 * 从识别日志里挖出 web_search 的调用流水。
 *
 * 刻意不为它单开一张表 —— 每一次搜索本来就已经完整记在 identify_logs 的事件流里，
 * 再存一份就有了两个会不一致的真相。代价是时间只精确到「所属那次识别」这一级。
 */
export function searchCalls(logs: IdentifyLog[], limit = 20): SearchCallRecord[] {
  const out: SearchCallRecord[] = []
  for (const log of logs) {
    log.events.forEach((event, i) => {
      if (event.type !== 'tool_call' || event.name !== 'web_search') return
      // 返回紧跟在调用后面。中间不会插进别的事件：loop 是一次调用一次返回
      const result = log.events[i + 1]
      const done = result?.type === 'tool_result' && result.name === 'web_search' ? result : null
      out.push({
        at: log.created_at,
        query: String(event.args.query ?? ''),
        status: done ? searchStatus(done.text, done.isError) : 'failed',
        ms: done?.ms ?? 0,
        label: log.label || log.dir
      })
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}
