import type {
  AgentEvent,
  IdentifyLog,
  IdentifyLogStatus,
  LinkedFile,
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

/**
 * IPC 报错的原文。参数侧有 plain() 挡着，返回侧的失败散落在各个 catch 里 ——
 * 拼这句话的格式统一放这里，别每处各写各的。
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 图标走 baoyi:// 自定义协议，主进程只按文件名在图标目录里找 */
export function iconUrl(iconPath: string): string {
  if (!iconPath) return ''
  const name = iconPath.split(/[\\/]/).pop() ?? ''
  return name ? `baoyi://icon/${encodeURIComponent(name)}` : ''
}

/**
 * 封面同样走 baoyi://，但多一个 `?v=` —— 那是**必需的**，不是保险。
 *
 * 封面文件名是按游戏 id 定的（见 kinds/game/links.ts 的 coverFileName），所以换一张
 * 封面之后 URL 一个字符都不会变，Chromium 会继续拿内存里那张旧图。换封面时库里的
 * `updated_at` 一定会被推到当下，拿它当版本号，换过就自然破缓存，没换过就仍然命中。
 */
export function coverUrl(coverPath: string, version = 0): string {
  if (!coverPath) return ''
  const name = coverPath.split(/[\\/]/).pop() ?? ''
  return name ? `baoyi://cover/${encodeURIComponent(name)}?v=${version}` : ''
}

/** 关联文件类型显示成什么词。label 为空时才用得上，是最后的退路 */
export const LINK_TYPE_LABEL: Record<LinkedFile['type'], string> = {
  guide: '攻略',
  trainer: '修改器',
  mod: 'MOD',
  emulator: '模拟器',
  other: '其他'
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

/** 日期 + 时分。识别日志的时间戳精确到分就够用 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

/**
 * 游玩时长。0 秒说的是「还没在抱一里玩过」，不是「玩了 0 小时」。
 *
 * 这个区分在开始计时之后反而更要紧了：太短的那些游玩（启动器一闪而过）刻意不计入
 * 总时长，所以 0 是个会长期存在的合法值，不是「功能还没做」的临时态。
 * 那种情况下卡片退回显示 last_played_at，说的是「今天玩过，但时长没跟到」。
 */
export function formatPlaytime(sec: number): string {
  if (!sec) return '未记录'
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分钟`
  const hours = sec / 3600
  return hours < 10 ? `${hours.toFixed(1)} 小时` : `${Math.round(hours)} 小时`
}

/**
 * 受保护字段的界面说法（「改过的字段」那一格用它）。
 *
 * 键要和 `electron/kinds/video/db.ts` 的 `PROTECTED_FIELDS` 一一对应 ——
 * 少一个，那个字段在面板里就显示成裸列名（`douban_rating`）。自检里有一条
 * 双向盯着这件事。
 *
 * 放在 utils 而不是 stores/video.ts：自检载不进 pinia（`defineStore` 要活的
 * Vue 应用），而这张表是纯数据，跟 store 没关系。放在 store 里的话自检就
 * 验不到「名单和文案对不对得上」，而那正是最容易漏的一处。
 */
export const PROTECTED_FIELD_LABEL: Record<string, string> = {
  name_zh: '片名',
  name_en: '原名',
  summary: '简介',
  description: '详细说明',
  category: '分类',
  tags: '标签',
  official_url: '官网',
  video_type: '类型',
  year: '年份',
  end_year: '完结年份',
  rating: 'TMDB 评分',
  tmdb_id: 'TMDB id',
  imdb_id: 'IMDb id',
  douban_id: '豆瓣 id',
  douban_rating: '豆瓣评分'
}

/** 游戏卡片 / 详情页打头的名字。中文名优先，都没有就退回主程序文件名 */
export function gameTitle(g: { name_zh: string; name_en: string; file_name: string }): string {
  return g.name_zh || g.name_en || g.file_name.replace(/\.exe$/i, '')
}

/**
 * 影视卡片 / 详情页打头的名字。中文名优先，都没有就退回文件名。
 *
 * 比 gameTitle 多剥一层扩展名：视频的扩展名有一长串（mkv / mp4 / avi / ts…），
 * 而剧集那条记录的 file_name 是目录名、压根没有扩展名。所以用 lastIndexOf
 * 判一下再剥，而不是拿一个正则去套 —— 套不全的那些会露出 `.mkv` 结尾。
 */
export function videoTitle(v: { name_zh: string; name_en: string; file_name: string }): string {
  if (v.name_zh) return v.name_zh
  if (v.name_en) return v.name_en
  const name = v.file_name ?? ''
  const dot = name.lastIndexOf('.')
  const tail = dot > 0 ? name.slice(dot) : ''
  // 只剥看起来像扩展名的那一截：位置靠后、长度 2-4、纯字母数字。
  // 纯数字的那截不剥 —— 认的容器扩展名里没有一个是纯数字（见 scanner.ts 的
  // VIDEO_EXTS），所以 `.2021` 一定是年份而不是扩展名，剥掉就是把「沙丘.2021」
  // 显示成「沙丘」，白丢一个用户拿来分辨重拍片的信息
  const looksLikeExt = /^\.[a-z0-9]{2,4}$/i.test(tail) && !/^\.\d+$/.test(tail)
  return looksLikeExt ? name.slice(0, dot) : name
}

/**
 * 海报走 baoyi://poster/，`?v=` 的理由和封面一字不差（文件名按 id 定，换图 URL 不变）。
 *
 * 多一件事：这一列有可能存着 TMDB 的**相对路径**（刮削先落，下载后才覆盖成本机路径）。
 * 那种值拼进协议地址是一张必然 404 的破图，所以这里直接返回空串，
 * 让界面走首字占位那条路 —— 占位比破图诚实。判据同 posters.ts 的 isLocalPoster。
 */
export function posterUrl(posterPath: string, version = 0): string {
  if (!posterPath) return ''
  if (!isLocalPosterPath(posterPath)) return ''
  const name = posterPath.split(/[\\/]/).pop() ?? ''
  return name ? `baoyi://poster/${encodeURIComponent(name)}?v=${version}` : ''
}

/**
 * `poster_path` 里这个值是不是本机文件。
 *
 * 和主进程 `kinds/video/posters.ts` 的 `isLocalPoster` 是同一份判断，刻意各写一份：
 * 那边在 Node 里、这边在浏览器里，中间隔着 contextBridge，import 不过来。
 * 两份漂了的后果是海报显示不出来，所以自检里盯着同一组用例。
 */
export function isLocalPosterPath(value: string): boolean {
  const v = String(value ?? '').trim()
  if (!v) return false
  if (/^[a-z]:[\\/]/i.test(v)) return true
  if (v.startsWith('\\\\')) return true
  if (v.startsWith('/')) return v.slice(1).includes('/')
  return false
}

/**
 * 片长。0 表示读不出来（容器元数据缺失、或者文件已经不在了），不是「零分钟」。
 *
 * 电影按「x 小时 y 分」，剧集单集按分钟 —— 一集 42 分钟写成「0.7 小时」没人这么说话。
 * 分界线放在 90 分钟：比这短的多半是单集或短片。
 */
export function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '—'
  const mins = Math.round(sec / 60)
  if (mins < 90) return `${mins} 分钟`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/**
 * 播放进度显示成「看到 1:23:45」那种。
 *
 * 用绝对时刻而不是百分比：用户下次要接着看，脑子里记的是「上次看到那个转场」，
 * 而 37% 换算不成任何他认得的东西。总时长读不出来时也照样能显示，
 * 这一点百分比做不到。
 */
export function formatPosition(sec: number): string {
  if (!sec || sec < 0) return ''
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 季集号写成 `S01E02`。季号为 0 是特别篇，TMDB 的约定 */
export function episodeCode(season: number, episode: number): string {
  const pad = (n: number) => String(Math.max(0, n)).padStart(2, '0')
  return `S${pad(season)}E${pad(episode)}`
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

/* ------------------------------ 并发收尾令牌 ------------------------------ */

export interface LatestGuard {
  /** 每次调用开始时领一个号 */
  begin(): number
  /** 这个号还是不是最新的一次调用。过期的调用在收尾处一律安静退出 */
  isCurrent(n: number): boolean
}

/**
 * 「只认最新一次调用」的令牌，管的是同一类竞态：旧调用的收尾代码，
 * 执行时新调用已经开始。收尾想动共享状态前先 isCurrent() 问一句。
 *
 *   · 列表查询（software store 的 load）：先点慢分组再点快分组，
 *     慢的那个晚 resolve 会把列表覆盖回旧分组的数据。
 *   · 可取消的任务（useAI / useScan 的 complete）：cancel 之后立刻点出
 *     第二轮，旧轮的 finally 会把新轮的 running 清掉。
 *
 * 两个场景共用一个实现，因为规矩是同一条：过期者不写状态。
 */
export function createLatestGuard(): LatestGuard {
  let latest = 0
  return {
    begin: () => ++latest,
    isCurrent: (n) => n === latest
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
