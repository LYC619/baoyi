/**
 * JAVDB 站点解析器（纯函数，不碰网络、不碰数据库）。
 *
 * 分工照 `video-object.ts` 与 `hentai/selectors.ts` 的既有约定：这一层只把
 * HTML 变成 `DiscoveryEntry`，取页面留给调用方（`online.ts` 的 fetcher）。
 *
 * 选择器来自公开项目 9E307/JavdbEmbySkin 的页面结构说明（BSD-3-Clause）：
 *   列表页: `.movie-list > .item > a.box`（内含 `.cover>img`、`.video-title`、`.score`、`.meta`、`.tags`）
 *   详情页: `.video-detail`（`h2.title`、`img.video-cover`、`.panel-block > .value`）
 *
 * **尚未对真实站点实测**：选择器需要真实页面样本复核。解析整体采取「取不到就留空」
 * 的降级策略，绝不因单个字段缺失抛错。
 */

import { parse } from 'node-html-parser'
import type { DiscoveryEntry } from '../../../../../src/types/video-discovery.ts'

/** 默认基准域名。站点会换镜像，实际基准以传入 URL 的 origin 为准。 */
export const JAVDB_BASE = 'https://javdb.com'

/** `/v/{uid}` 里的 uid。JAVDB 作品页的唯一标识。 */
const WORK_PATH = /\/v\/([A-Za-z0-9]+)/i

export function isJavdbUrl(raw: string): boolean {
  try {
    const url = new URL(String(raw || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return false
    return /(^|\.)javdb\d*\.(com|me|life|party|today|vip)$/i.test(url.hostname) || /(^|\.)jdforrepam\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

function originOf(raw: string): string {
  try { return new URL(raw).origin } catch { return '' }
}

/** 解析相对地址并校验为不含账号密码的 HTTP(S)。非法一律返回空串。 */
function absolute(value: string | undefined, base: string): string {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 4000) return ''
  try {
    const url = new URL(raw, base || JAVDB_BASE)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

/** 封面可能写在懒加载属性里，`src` 常是占位图。 */
function imageUrl(node: ReturnType<typeof parse> | null, base: string): string {
  if (!node) return ''
  return absolute(node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src'), base)
}

/** `/v/abc123` 形式或完整地址 → 小写 uid。取不到返回空串。 */
export function javdbUid(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  const fromPath = WORK_PATH.exec(value)?.[1]
  if (fromPath) return fromPath.toLowerCase()
  try { return (WORK_PATH.exec(new URL(value).pathname)?.[1] || '').toLowerCase() } catch { return '' }
}

/**
 * 从标题/文本里抽番号。支持 `ABC-123`、`ABC_123`、`ABC 123`、`FC2-PPV-1234567`。
 * 取不到返回空串（不是错误 —— 有些条目确实没有规范番号）。
 */
export function normalizeCode(value: string): string {
  const text = String(value || '').toUpperCase()
  const fc2 = /\bFC2[-_ ]?PPV[-_ ]?(\d{3,8})\b/.exec(text)
  if (fc2) return `FC2-PPV-${fc2[1]}`
  const match = /\b([A-Z]{2,8})[-_ ]?(\d{2,6})\b/.exec(text)
  return match ? `${match[1]}-${match[2]}` : ''
}

/** JAVDB 卡片标题是「番号 + 空格 + 标题」，展示时去掉重复的番号前缀。 */
function stripCodePrefix(title: string, code: string): string {
  let value = String(title || '').trim()
  if (!code) return value
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  value = value.replace(new RegExp('^' + escaped + '[\\s　:：-]*', 'i'), '')
  return value.trim()
}

function firstText(root: ReturnType<typeof parse>, selectors: string[]): string {
  for (const selector of selectors) {
    const node = root.querySelector(selector)
    const value = node?.text?.replace(/\s+/g, ' ').trim()
    if (value) return value
  }
  return ''
}

function metaContent(root: ReturnType<typeof parse>, property: string): string {
  const node = root.querySelector(`meta[property="${property}"],meta[name="${property}"]`)
  return node?.getAttribute('content')?.trim() || ''
}

function dateFrom(value: string): number {
  const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(value || ''))
  return match ? Number(match[1]) : 0
}

function scoreFrom(value: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)/.exec(String(value || ''))
  if (!match) return undefined
  const score = Number(match[1])
  return Number.isFinite(score) && score > 0 && score <= 10 ? score : undefined
}

/** 详情页 `.panel-block`：左侧标签（strong）+ 右侧 `.value`。 */
function panelValues(root: ReturnType<typeof parse>): Array<{ label: string; value: string; links: string[] }> {
  const result: Array<{ label: string; value: string; links: string[] }> = []
  for (const block of root.querySelectorAll('.panel-block')) {
    const label = block.querySelector('strong')?.text?.replace(/\s+/g, ' ').trim() || ''
    const valueNode = block.querySelector('.value')
    const value = valueNode?.text?.replace(/\s+/g, ' ').trim() || block.text?.replace(label, '').replace(/\s+/g, ' ').trim() || ''
    const links = (valueNode || block).querySelectorAll('a').map(anchor => anchor.text?.replace(/\s+/g, ' ').trim()).filter(Boolean)
    result.push({ label, value, links })
  }
  return result
}

export interface JavdbListResult {
  name: string
  entries: DiscoveryEntry[]
  nextPageUrl: string
}

/**
 * 解析列表/搜索页。返回按页面顺序排的作品，最多 2000 条（与目录上限一致）。
 * 同一 uid 只保留第一次出现的那条。
 */
export function parseJavdbList(input: { html: string; url: string; base?: string }): JavdbListResult {
  const base = input.base || originOf(input.url) || JAVDB_BASE
  const root = parse(String(input.html || ''))
  const entries: DiscoveryEntry[] = []
  const seen = new Set<string>()
  for (const item of root.querySelectorAll('.movie-list .item')) {
    const anchor = item.querySelector('a.box') || item.querySelector('a') || item.querySelector('.box')
    const pageUrl = absolute(anchor?.getAttribute('href'), base)
    const uid = javdbUid(pageUrl)
    if (!pageUrl || !uid || seen.has(uid)) continue
    seen.add(uid)
    const title = firstText(item, ['.video-title', '.video-title strong', 'a.box .video-title'])
    const code = normalizeCode(firstText(item, ['.video-title strong']) || title)
    const entry: DiscoveryEntry = {
      id: uid,
      code,
      title: stripCodePrefix(title, code) || code || uid,
      description: '',
      coverUrl: imageUrl(item.querySelector('.cover img') || item.querySelector('img'), base),
      pageUrl,
      playUrl: '',
      tags: item.querySelectorAll('.tags .tag, .tags a').map(tag => tag.text?.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40),
      rankings: [],
      year: dateFrom(firstText(item, ['.meta', '.meta .date'])),
      downloads: []
    }
    const score = scoreFrom(firstText(item, ['.score']))
    if (score !== undefined) entry.rating = { value: score, scale: 10, votes: 0 }
    entries.push(entry)
    if (entries.length >= 2000) break
  }
  const nextRaw = root.querySelector('a[rel="next"]')
    || root.querySelectorAll('.pagination a, .pagination-list a').find(anchor => /下一[頁页]|»|›/.test(anchor.text || ''))
  let nextPageUrl = absolute(nextRaw?.getAttribute('href'), base)
  if (nextPageUrl && originOf(nextPageUrl) !== originOf(input.url)) nextPageUrl = ''
  if (nextPageUrl === absolute(input.url, base)) nextPageUrl = ''
  const name = firstText(root, ['h1', '.title.is-4']) || metaContent(root, 'og:site_name') || new URL(base).hostname
  return { name, entries, nextPageUrl }
}

/**
 * 解析作品详情页，补全列表页给不全的字段（简介/演员/日期/评分/封面）。
 * 返回增量，由调用方与列表条目合并。
 */
export function parseJavdbDetail(input: { html: string; url: string; base?: string }): Partial<DiscoveryEntry> {
  const base = input.base || originOf(input.url) || JAVDB_BASE
  const root = parse(String(input.html || ''))
  const titleText = firstText(root, ['h2.title', '.video-detail h2.title', 'h1.title', 'h1'])
  const code = normalizeCode(firstText(root, ['h2.title strong', '.video-detail .title strong', 'h2.title']) || titleText)
  const panels = panelValues(root)
  const panel = (keywords: string[]) => panels.find(entry => keywords.some(keyword => entry.label.includes(keyword)))
  const detail: Partial<DiscoveryEntry> = {
    code,
    // 详情页 h2 里番号、中文标题、原日文标题混在一起；`current-title` 才是干净的展示标题。
    title: firstText(root, ['.current-title']) || stripCodePrefix(titleText, code) || code || '',
    // JAVDB 没有简介字段，`og:description` 是站点标语（「番號搜磁鏈…」），不能当作品简介。
    description: '',
    coverUrl: absolute(root.querySelector('img.video-cover')?.getAttribute('src'), base)
      || imageUrl(root.querySelector('img.video-cover'), base)
      || absolute(metaContent(root, 'og:image'), base),
    tags: [],
    rankings: [],
    downloads: []
  }
  const genre = panel(['類別', '类别', '標籤', '标签', '類型', '类型'])
  if (genre) detail.tags = [...new Set(genre.links.length ? genre.links : genre.value.split(/[,，\s]+/).filter(Boolean))].slice(0, 40)
  const studio = panel(['片商', '製作', '制作', '發行', '发行', '廠牌', '厂牌'])
  const actor = panel(['演員', '演员', '女優', '女优'])
  const date = panel(['日期', '發行日期', '发行日期', '上架'])
  if (date) detail.year = dateFrom(date.value)
  const score = scoreFrom(panel(['評分', '评分'])?.value || firstText(root, ['.score', '.rating .value']))
  if (score !== undefined) detail.rating = { value: score, scale: 10, votes: 0 }
  // 演员/片商没有独立字段承接，先并入 tags 供检索（保持通用 DiscoveryEntry 形状不变）
  for (const extra of [studio?.value, ...(actor?.links.length ? actor.links : actor ? [actor.value] : [])]) {
    const value = String(extra || '').trim()
    if (value && !detail.tags!.includes(value)) detail.tags!.push(value)
  }
  return detail
}
