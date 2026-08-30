/**
 * 豆瓣：走用户已配置的搜索服务商查条目页，不碰私有接口。
 *
 * ## 为什么不走 frodo
 *
 * MoviePilot 的豆瓣数据走 `frodo.douban.com/api/v2` —— 那是豆瓣**安卓客户端的
 * 私有接口**，从客户端逆出来的。它的代码里硬编码着一个 api_key 和一个 secret，
 * 每个请求还要按那套规则算 HMAC 签名冒充客户端。豆瓣的官方开放 API 2013 年就
 * 关了，**不存在一条合法的公开端点**。抱一不带别人逆出来的密钥。
 *
 * 于是换一条路：用用户**自己配的**搜索服务商，打 `site:movie.douban.com`，
 * 从返回的条目页 URL 里取 subject id，从标题和摘要里解片名和评分。
 * 不新增配置项，不新增传输层 —— 和 `web_search` 共用一个闸门。
 *
 * ## 这条路拿得到什么，拿不到什么
 *
 * 拿得到：**subject id**（在 URL 的路径里，结构性可验证）、**中文片名**、
 * **豆瓣评分**（多数服务商的摘要里带）。
 *
 * 拿不到：演职员表、剧照、分季结构 —— 那些得抓页面正文。TMDB 已经把它们给全了，
 * 豆瓣在这里补的只是「中文语境下的那个名字和那个分数」。
 *
 * ## 评分是二手的，所以它单独存一列
 *
 * 评分从**搜索服务商的摘要**里解出来，不是从豆瓣读的。摘要可能是几个月前抓的
 * 快照，也可能来自另一个版本的条目页。所以它落在 `douban_rating`，不去覆盖
 * `rating`：界面能写「豆瓣 8.1」，用户点 subject 链接自己就能核对。
 * 把它混进 `rating` 只会得到一个不知来源的数字，那才是真的帮不上忙。
 *
 * ## `site:` 不是所有服务商都认
 *
 * Bing 认，SearXNG 看它背后的引擎，Tavily / Exa / Firecrawl 的语义搜索会把它
 * 当普通词处理。所以**不靠 `site:` 保证结果干净** —— `mapDoubanHit` 只收
 * host 真的是豆瓣、路径真的是 `/subject/<数字>` 的那些。服务商不认这个语法时
 * 结果是「候选少」，不是「候选脏」。
 *
 * ## 纯逻辑和 IO 分开
 *
 * 除了最后那个 `doubanLookup`，这个文件里所有东西都不发请求 —— URL 认不认、
 * 评分怎么解、候选怎么排，自检能拿固定语料整个跑一遍。
 * 和 `tmdb.ts`、`mediainfo.ts` 同一个约定。
 */

import type { SearchConfig } from '../../../src/types'
import { search, searchAvailable, type SearchHit } from '../../services/searchService.ts'
import { normTitle } from './tmdb.ts'

export interface DoubanCandidate {
  /** subject id。从 URL 路径里取的，不是模型说的 */
  id: string
  /** 条目页地址，从 id 拼出来 —— 不用服务商给的那个原始 URL，见 doubanUrl */
  url: string
  title: string
  /** 十分制。0 = 摘要里没解出来，**不是零分** */
  rating: number
  /** 0 = 标题和摘要里都没有年份 */
  year: number
  /** 排序用。和 tmdb 的 scoreCandidate 同一个约定：只排名，不做取舍 */
  score: number
}

/* ============================== 纯逻辑 ============================== */

/** 豆瓣自己的几个主机名。`movie.` 是条目页，`m.` 是移动版，`www.`/裸域也能落到条目 */
const DOUBAN_HOSTS = new Set([
  'movie.douban.com',
  'm.douban.com',
  'www.douban.com',
  'douban.com'
])

/**
 * 从一个 URL 里取 subject id，不是豆瓣条目页就返回空串。
 *
 * **用 URL 解析而不是正则匹配整串**，因为要判断的是 host 而不是「串里有没有
 * douban.com」。搜索结果是外部输入：`https://evil.com/movie.douban.com/subject/1292052/`
 * 用正则一扫就过了，而它根本不是豆瓣的页面。这和 game/covers.ts 那份图片主机
 * 白名单是同一类判断 —— 差别是那边挡的是「去连哪台机器」,这边挡的是
 * 「把谁的 id 当成豆瓣 id 存进库」。
 *
 * 认这几种路径：
 *   movie.douban.com/subject/1292052/
 *   m.douban.com/movie/subject/1292052/
 *   movie.douban.com/subject/1292052/?from=xxx
 */
export function doubanSubjectId(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  if (!DOUBAN_HOSTS.has(u.hostname.toLowerCase())) return ''
  const m = /^(?:\/movie)?\/subject\/(\d{4,12})(?:\/|$)/.exec(u.pathname)
  return m ? m[1] : ''
}

/**
 * 条目页地址。**从 id 重新拼，不用服务商返回的原始 URL。**
 *
 * 原始 URL 上常挂着服务商或推荐系统的跟踪参数（`?from=`、`?dt_dapp=`），
 * 存进库就等于把一个第三方的跟踪串写进用户的数据，而且移动版地址在桌面端
 * 打开会被跳一次。统一成规范形状。
 */
export function doubanUrl(id: string): string {
  return id ? `https://movie.douban.com/subject/${id}/` : ''
}

/**
 * 从摘要里认评分的几种写法，从强到弱。
 *
 * **每一条都必须带锚点词**（`评分` 或 `/10` 或 `分`），不接受「摘要里随便一个
 * 一位小数」。豆瓣的摘要里到处是数字：年份、集数、时长、评价人数、榜单排名。
 * 没有锚点就去捞小数，最典型的失手是把 `8.5万人评价` 认成 8.5 分 ——
 * 那个数字是人数，而它恰好落在合法评分区间里，**看不出错**。
 *
 * 几个负向断言各挡一种具体的误读：
 * - `(?![\d.万人次])`：挡 `8.5万人`、挡 `9.75`（多一位小数说明这不是豆瓣评分）
 * - `(?![钟数])`：挡 `120分钟` 里的 `0分`、挡 `评分数`
 * - 只收 1..10（`10` 单列一支）：`\d(?:\.\d)?` 一位数写法配上 `(?!\d)`，
 *   顺手把 `评分：2021年` 这种把年份当分数的读法挡掉了
 */
const RATING_PATTERNS: RegExp[] = [
  /豆瓣评分[：:\s]{0,3}(10(?:\.0)?|\d(?:\.\d)?)(?![\d.万人次])/g,
  /评分[：:\s]{0,3}(10(?:\.0)?|\d(?:\.\d)?)(?![\d.万人次])/g,
  /(10(?:\.0)?|\d(?:\.\d)?)\s*\/\s*10(?![\d.])/g,
  /(10(?:\.0)?|\d(?:\.\d)?)\s*分(?![钟数])/g
]

/**
 * 从标题 + 摘要里解豆瓣评分。解不出来返回 0。
 *
 * **0 的意思是「没解出来」，不是「零分」** —— 和 `video_meta.rating` 那一列
 * 同一个约定。解不出来是常态而不是故障：不同服务商的摘要格式差很远，
 * 有的干脆只给一句剧情简介。拿不到评分不影响这次查询的主要价值
 * （subject id 和中文片名照样拿到了）。
 */
export function parseDoubanRating(text: unknown): number {
  const s = String(text ?? '')
  if (!s) return 0
  for (const re of RATING_PATTERNS) {
    // matchAll 会克隆正则，不会把 lastIndex 写回模块级的那个对象
    for (const m of s.matchAll(re)) {
      const n = Number(m[1])
      if (!Number.isFinite(n) || n <= 0 || n > 10) continue
      return Math.round(n * 10) / 10
    }
  }
  return 0
}

/**
 * 把服务商给的标题洗成片名。
 *
 * 各家给的形状不一样，同一个页面可能是
 * `肖申克的救赎 (豆瓣)` / `肖申克的救赎 The Shawshank Redemption (1994) - 豆瓣电影`
 * / `豆瓣电影: 肖申克的救赎`。这里只剥站点后缀和年份括号，**英文副标题留着** ——
 * 它对模型判断是哪一部片有用（同名中文译名靠英文原名分开）。
 */
export function cleanDoubanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/^\s*豆瓣(?:电影|读书)?\s*[:：]\s*/u, '')
    .replace(/\s*[（(]\s*豆瓣\s*[)）]\s*/gu, ' ')
    .replace(/\s*[-—_|｜]\s*豆瓣(?:电影)?\s*$/u, '')
    .replace(/\s*豆瓣电影\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * 从标题或摘要里取年份。
 *
 * 只认**有边界的四位数**：`(1994)`、`/ 1994 /`、`1994年`。裸着的四位数不认 ——
 * 摘要里的 `2160p`、`1080` 会撞上，而认错年份的后果是排序把对的候选压下去。
 */
export function parseDoubanYear(text: unknown): number {
  const s = String(text ?? '')
  const m =
    /[（(]\s*((?:19|20)\d{2})\s*[)）]/.exec(s) ??
    /((?:19|20)\d{2})\s*年/.exec(s) ??
    /[/／|｜]\s*((?:19|20)\d{2})\s*(?:[/／|｜]|$)/.exec(s)
  return m ? Number(m[1]) : 0
}

/**
 * 一条搜索结果 -> 一个候选。不是豆瓣条目页就返回 null。
 *
 * 这个函数是**这条路的整道闸门**：`site:` 语法不被服务商认时，返回结果里会混
 * 进影评站、盗版站、豆瓣的非条目页（影人页、榜单页、小组帖）。它们在这里
 * 全部落地为 null，所以下游看到的候选一定带一个真实的 subject id。
 */
export function mapDoubanHit(hit: SearchHit): DoubanCandidate | null {
  const id = doubanSubjectId(hit?.url)
  if (!id) return null
  const title = cleanDoubanTitle(hit?.title)
  if (!title) return null
  const blob = `${hit?.title ?? ''} ${hit?.snippet ?? ''}`
  return {
    id,
    url: doubanUrl(id),
    title,
    rating: parseDoubanRating(blob),
    year: parseDoubanYear(blob),
    score: 0
  }
}

/**
 * 给候选打分排序。**只排名，不做取舍** —— 同 `tmdb.ts` 的 `scoreCandidate`。
 *
 * 权重比 TMDB 那份少几项，因为信号本来就少：这条路上没有 media_type、
 * 没有票数、没有海报。剩下的就是标题和年份，而年份还经常解不出来。
 *
 * `rating > 0` 给 +5 不是因为「分高的更可能对」，而是因为**摘要里带评分的那条
 * 结果更可能真是条目页**（影人页和小组帖的摘要里不会有豆瓣评分）。
 */
export function scoreDoubanCandidate(
  c: Pick<DoubanCandidate, 'title' | 'year' | 'rating'>,
  want: { title: string; year: number }
): number {
  let score = 0
  const wantNorm = normTitle(want.title)
  const got = normTitle(c.title)

  if (wantNorm && got) {
    if (got === wantNorm) score += 100
    else if (got.includes(wantNorm) || wantNorm.includes(got)) score += 40
  }

  if (want.year > 0 && c.year > 0) {
    const gap = Math.abs(want.year - c.year)
    if (gap === 0) score += 50
    else if (gap === 1) score += 20
    else score -= 30
  }

  if (c.rating > 0) score += 5
  return score
}

/**
 * 一批搜索结果 -> 排好序的候选。
 *
 * **按 subject id 去重并合并**：同一个条目常常以桌面版和移动版两条结果出现，
 * 而两条的摘要不一样 —— 一条可能带评分、另一条带年份。丢掉后来的那条等于
 * 丢掉它带的那半信息，所以缺什么就从后来的那条补什么。
 */
export function rankDoubanHits(
  hits: SearchHit[],
  want: { title: string; year: number }
): DoubanCandidate[] {
  const byId = new Map<string, DoubanCandidate>()
  for (const h of hits) {
    const c = mapDoubanHit(h)
    if (!c) continue
    const prev = byId.get(c.id)
    if (!prev) {
      byId.set(c.id, c)
      continue
    }
    if (!prev.rating && c.rating) prev.rating = c.rating
    if (!prev.year && c.year) prev.year = c.year
    // 标题取更长的那个：短的那条通常是被服务商截断的
    if (c.title.length > prev.title.length) prev.title = c.title
  }

  const list = [...byId.values()]
  for (const c of list) c.score = scoreDoubanCandidate(c, want)
  return list.sort((a, b) => b.score - a.score || b.rating - a.rating)
}

/**
 * 拼查询词。
 *
 * `site:movie.douban.com` 放最前面：认这个语法的服务商（Bing、多数 SearXNG
 * 后端）会直接把结果限死在条目站内；不认的会把它当普通词，那也没坏处 ——
 * 「douban」这个词本身就把结果往豆瓣方向拉，而真正的闸门在 `mapDoubanHit`。
 *
 * 带年份但**不带「电影」「电视剧」这类形态词**：豆瓣的条目页标题里没有这些词，
 * 加进去只会让语义搜索的服务商跑偏到影单和影评。
 */
export function doubanQuery(title: string, year = 0): string {
  const t = String(title ?? '').trim()
  if (!t) return ''
  return `site:movie.douban.com ${t}${year > 0 ? ` ${year}` : ''}`
}

/**
 * 豆瓣这条路能不能用 = 搜索能不能用。
 *
 * **刻意复用 `searchAvailable`，不引入第二个配置项。** 豆瓣在这里不是一个
 * 「数据源」而是「一种搜索用法」，给它单独一个开关只会让用户在设置里多面对
 * 一个不知道该不该开的东西，而它的答案永远和联网搜索那个开关一样。
 * `model_builtin` 在 `searchAvailable` 里返回 false，所以「不额外联网」时
 * 这条路自动关掉，符合预期。
 */
export function doubanAvailable(cfg: SearchConfig): boolean {
  return searchAvailable(cfg)
}

/* ============================== IO ============================== */

/**
 * 查一次豆瓣。这个文件里**唯一**发请求的函数，其余全是纯逻辑。
 *
 * 走 `searchService.search`，所以自动继承了那边的进程内缓存 —— 一次扫描里
 * 同一部剧的多季会命中同一个查询，不重复烧用户的搜索额度。
 */
export async function doubanLookup(
  cfg: SearchConfig,
  title: string,
  year = 0
): Promise<DoubanCandidate[]> {
  const q = doubanQuery(title, year)
  if (!q || !doubanAvailable(cfg)) return []
  return rankDoubanHits(await search(q, cfg), { title, year })
}

