import type { DiscoveryCard, DiscoveryEntry, DiscoverySelection, DiscoverySource, DiscoverySourceSummary } from '../../../../src/types/video-discovery.ts'
import type { DiscoveryCatalogue } from './catalogue.ts'
import { canonicalOnlineUrl, onlineId, parseVideoObjectPage } from './adapters/video-object.ts'
import { isJavdbUrl, parseJavdbDetail, parseJavdbList } from './adapters/javdb.ts'

type AdapterId = 'video-object' | 'javdb'
interface LoadedList { name: string; url: string; entries: DiscoveryEntry[]; nextPageUrl: string }

const MAX_BYTES = 2 * 1024 * 1024
/** 装成一个普通 Chrome。Electron 默认 UA 带 `Electron/`，会被站点当成非浏览器。 */
const JAVDB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7'
}
/** 挑战页也是 200，只能看内容分辨；命中就当被拦，别当成「没有作品」。 */
const looksBlocked = (html: string) => /cf-browser-verification|__cf_chl|Just a moment|Checking your browser|Attention Required|you have been blocked/i.test(String(html || '').slice(0, 200_000))

/** Explicit redirects and streamed accounting keep both redirects and decompressed bodies bounded. */
export async function readOnlinePage(rawUrl: string, fetchPage: typeof fetch, sameSite?: string, extraHeaders: Record<string, string> = {}): Promise<{ html: string; url: string }> {
  let url = canonicalOnlineUrl(rawUrl)
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
  const checkSite = () => { if (sameSite && new URL(url).origin !== new URL(sameSite).origin) throw new Error('下一页必须与来源为同站点') }
  try {
    for (let hop = 0; hop <= 5; hop++) {
      checkSite()
      const response = await fetchPage(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'text/html,application/xhtml+xml', ...extraHeaders } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (hop === 5 || !location) throw new Error('网页重定向次数超过 5 次或缺少目标')
        url = canonicalOnlineUrl(new URL(location, url).href); continue
      }
      try {
        if (!response.ok) throw new Error('读取网页失败：HTTP ' + response.status)
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (type && !['text/html', 'application/xhtml+xml'].includes(type)) throw new Error('来源必须是 HTML 网页')
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('网页不能超过 2 MB')
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0
        if (reader) {
          try {
            while (true) {
              const { value, done } = await reader.read(); if (done) break
              size += value.byteLength; if (size > MAX_BYTES) throw new Error('网页不能超过 2 MB')
              chunks.push(value)
            }
          } finally { await reader.cancel(); reader.releaseLock() }
        }
        return { html: Buffer.concat(chunks).toString('utf8'), url }
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}) }
    }
    throw new Error('网页重定向次数超过 5 次')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('读取网页超时（15 秒），请稍后重试')
    throw error
  } finally { clearTimeout(timer) }
}

function mergeEntry(previous: DiscoveryEntry, incoming: DiscoveryEntry): DiscoveryEntry {
  return { ...previous, ...incoming, id: previous.id,
    description: incoming.description || previous.description, coverUrl: incoming.coverUrl || previous.coverUrl,
    mediaUrl: incoming.mediaUrl || previous.mediaUrl, playUrl: incoming.playUrl || previous.playUrl,
    downloads: incoming.downloads.length ? incoming.downloads : previous.downloads,
    tags: incoming.tags.length ? incoming.tags : previous.tags, year: incoming.year || previous.year, rating: incoming.rating || previous.rating }
}

/** 详情增量只覆盖有值的字段，避免解析不到时把列表已有的封面/年份冲成空。 */
function mergeDetail(entry: DiscoveryEntry, detail: Partial<DiscoveryEntry>): DiscoveryEntry {
  const next = { ...entry }
  if (detail.code) next.code = detail.code
  if (detail.title) next.title = detail.title
  if (detail.description) next.description = detail.description
  if (detail.coverUrl) next.coverUrl = detail.coverUrl
  if (detail.year) next.year = detail.year
  if (detail.rating) next.rating = detail.rating
  if (detail.tags?.length) next.tags = detail.tags
  return next
}

const adapterForUrl = (url: string): AdapterId => isJavdbUrl(url) ? 'javdb' : 'video-object'
const idPrefix = (adapter: AdapterId) => adapter === 'javdb' ? 'javdb-' : 'online-'

export function createOnlineSource(catalogue: DiscoveryCatalogue, fetchPage: typeof fetch) {
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> { const next = queue.then(run); queue = next.catch(() => {}); return next }
  function source(id: string): DiscoverySource {
    const value = catalogue.get(id)
    if (!value.online) throw new Error('此来源不是在线来源')
    return value
  }
  async function loadList(adapter: AdapterId, url: string, sameSite?: string): Promise<LoadedList> {
    const page = await readOnlinePage(url, fetchPage, sameSite, adapter === 'javdb' ? JAVDB_HEADERS : {})
    if (looksBlocked(page.html)) throw new Error('来源返回了人机验证页，请更换网络或代理后重试')
    if (adapter === 'javdb') {
      const parsed = parseJavdbList({ html: page.html, url: page.url })
      if (!parsed.entries.length) throw new Error('这个页面没有解析到 JAVDB 作品，请确认是列表 / 搜索 / 排行榜页')
      return { name: parsed.name, url: page.url, entries: parsed.entries, nextPageUrl: parsed.nextPageUrl }
    }
    const parsed = parseVideoObjectPage(page)
    if (!parsed.entries.length) throw new Error('此网页未提供可接入的 VideoObject 资料。可选择“打开网页”浏览来源。')
    return { ...parsed, url: page.url }
  }
  function save(page: LoadedList, id: string, adapter: AdapterId, previous?: DiscoverySource, append = false): DiscoverySourceSummary {
    const merged = new Map((previous?.entries || []).map(entry => [entry.id, entry]))
    for (const entry of page.entries) merged.set(entry.id, merged.has(entry.id) ? mergeEntry(merged.get(entry.id)!, entry) : entry)
    if (merged.size > 2000) throw new Error('来源作品不能超过 2000 项；已缓存资料保留')
    const url = previous?.online?.url || page.url
    const visited = [...new Set([...(append ? previous?.online?.visited || [] : [url]), page.url])]
    return catalogue.importSource({ schemaVersion: 1, id, name: append ? previous!.name : page.name, homeUrl: url, entries: [...merged.values()],
      online: { adapter, url, visited, nextPageUrl: visited.includes(page.nextPageUrl) ? '' : page.nextPageUrl } })
  }
  return {
    connect(raw: string) { return serial(async () => {
      const url = canonicalOnlineUrl(raw), adapter = adapterForUrl(url), page = await loadList(adapter, url)
      const existing = catalogue.sources().find(item => item.online && [url, page.url].includes(item.online.url))
      const id = existing?.id || onlineId(idPrefix(adapter), page.url)
      return save(page, id, adapter, existing ? source(id) : undefined)
    }) },
    refresh(id: string) { return serial(async () => {
      const previous = source(id), config = previous.online!
      const page = await loadList(config.adapter, config.url, config.url)
      return save(page, id, config.adapter, previous)
    }) },
    next(id: string) { return serial(async () => {
      const previous = source(id), config = previous.online!
      if (!config.nextPageUrl || config.visited.includes(config.nextPageUrl)) return catalogue.sources().find(item => item.id === id)!
      const page = await loadList(config.adapter, config.nextPageUrl, config.url)
      if (config.visited.includes(page.url)) return catalogue.importSource({ ...source(id), online: { ...config, nextPageUrl: '' } })
      return save(page, id, config.adapter, previous, true)
    }) },
    detail(selection: DiscoverySelection): Promise<DiscoveryCard> { return serial(async () => {
      const previous = source(selection.sourceId), config = previous.online!, card = catalogue.entry(previous.id, selection.entryId)
      if (!card.entry.pageUrl) return card
      if (config.adapter === 'javdb') {
        const page = await readOnlinePage(card.entry.pageUrl, fetchPage, undefined, JAVDB_HEADERS)
        if (looksBlocked(page.html)) throw new Error('来源返回了人机验证页，请更换网络或代理后重试')
        const updated = mergeDetail(card.entry, parseJavdbDetail({ html: page.html, url: page.url }))
        catalogue.importSource({ ...previous, entries: previous.entries.map(entry => entry.id === card.entry.id ? updated : entry) })
        return catalogue.entry(previous.id, card.entry.id)
      }
      const page = await loadList('video-object', card.entry.pageUrl)
      // Exact identity first; a final redirected page identity is safe only when unambiguous.
      const matches = page.entries.filter(entry => entry.id === card.entry.id || entry.pageUrl === card.entry.pageUrl)
      const redirected = page.entries.filter(entry => canonicalOnlineUrl(entry.pageUrl) === page.url)
      const found = matches.length === 1 ? matches[0] : matches.length === 0 && redirected.length === 1 ? redirected[0] : undefined
      if (!found) throw new Error('详情页未找到可明确对应作品的资料，已保留缓存')
      const current = source(previous.id), currentCard = catalogue.entry(previous.id, selection.entryId)
      const updated = mergeEntry(currentCard.entry, { ...found, pageUrl: currentCard.entry.pageUrl })
      catalogue.importSource({ ...current, entries: current.entries.map(entry => entry.id === card.entry.id ? updated : entry) })
      return catalogue.entry(previous.id, card.entry.id)
    }) }
  }
}
