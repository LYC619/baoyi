/**
 * 网络搜索适配层。
 *
 * agent 遇到本地信息不足以判断的程序时（文件名无意义、PE 信息为空），
 * 通过这里查一下再下结论。各家返回结构不同，统一归一成 title / url / snippet。
 */

import type { SearchConfig, SearchProvider } from '../../src/types'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

const TIMEOUT = 20_000
const MAX_HITS = 5
const MAX_SNIPPET = 300

/**
 * 进程内缓存。一次扫描里同名程序反复出现很常见（同一套件的多个目录），
 * 缓存能直接省掉重复的搜索额度。抱一重启即清空，不做持久化。
 */
const cache = new Map<string, SearchHit[]>()

export function clearSearchCache(): void {
  cache.clear()
}

/** 缓存键。`search` 和 `searchCached` 共用，免得两边的归一规则各自漂 */
function cacheKey(query: string, cfg: SearchConfig): string {
  return `${cfg.provider}::${query.trim().toLowerCase()}`
}

/**
 * 这个查询已经在缓存里了吗 —— 也就是「再问一次不会真的发请求、不花钱」。
 *
 * 给按次计费对账用：调用方在搜之前问一句，命中就不计入本次扫描的搜索次数。
 * 不做这个判断的话，同一部剧的多季（每季是一个独立条目，查的是同一个剧名）
 * 会被报成好几次搜索，而服务商那边只扣了一次 —— 报出来的账单比真实的多，
 * 用户拿它去对账只会更糊涂。
 */
export function searchCached(query: string, cfg: SearchConfig): boolean {
  return cache.has(cacheKey(query, cfg))
}

function trimSnippet(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET)
}

function normalize(hits: Array<Partial<SearchHit>>): SearchHit[] {
  return hits
    .filter((h) => typeof h.url === 'string' && h.url.length > 0)
    .slice(0, MAX_HITS)
    .map((h) => ({
      title: trimSnippet(h.title) || '(无标题)',
      url: String(h.url),
      snippet: trimSnippet(h.snippet)
    }))
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  return res.json()
}

async function get(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  return res.json()
}

/* ------------------------------ 各家适配 ------------------------------ */

async function searchTavily(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  // 新版走 Bearer，旧版读 body 里的 api_key，两个都带上以兼容自建代理
  const json = await post(
    'https://api.tavily.com/search',
    { Authorization: `Bearer ${cfg.api_key}` },
    { api_key: cfg.api_key, query, max_results: MAX_HITS, search_depth: 'basic' }
  )
  const results: any[] = Array.isArray(json?.results) ? json.results : []
  return normalize(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })))
}

async function searchExa(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  const json = await post(
    'https://api.exa.ai/search',
    { 'x-api-key': cfg.api_key },
    {
      query,
      numResults: MAX_HITS,
      type: 'auto',
      contents: { text: { maxCharacters: MAX_SNIPPET * 2 } }
    }
  )
  const results: any[] = Array.isArray(json?.results) ? json.results : []
  return normalize(
    results.map((r) => ({ title: r.title, url: r.url, snippet: r.text ?? r.summary }))
  )
}

async function searchFirecrawl(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  const json = await post(
    'https://api.firecrawl.dev/v1/search',
    { Authorization: `Bearer ${cfg.api_key}` },
    { query, limit: MAX_HITS }
  )
  const results: any[] = Array.isArray(json?.data) ? json.data : []
  return normalize(
    results.map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? r.markdown }))
  )
}

async function searchBing(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  // endpoint 留空时用官方地址，填了就用自建/代理地址（Azure 各区域网关不同）
  const base = (cfg.endpoint || 'https://api.bing.microsoft.com/v7.0/search').replace(/\/+$/, '')
  const json = await get(
    `${base}?q=${encodeURIComponent(query)}&count=${MAX_HITS}&mkt=zh-CN`,
    { 'Ocp-Apim-Subscription-Key': cfg.api_key }
  )
  const results: any[] = Array.isArray(json?.webPages?.value) ? json.webPages.value : []
  return normalize(results.map((r) => ({ title: r.name, url: r.url, snippet: r.snippet })))
}

async function searchSearxng(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  const base = cfg.endpoint.replace(/\/+$/, '')
  if (!base) throw new Error('SearXNG 需要先填写实例地址')
  const json = await get(
    `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`
  )
  const results: any[] = Array.isArray(json?.results) ? json.results : []
  return normalize(results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })))
}

const ADAPTERS: Record<
  Exclude<SearchProvider, 'model_builtin'>,
  (query: string, cfg: SearchConfig) => Promise<SearchHit[]>
> = {
  tavily: searchTavily,
  exa: searchExa,
  firecrawl: searchFirecrawl,
  bing: searchBing,
  searxng: searchSearxng
}

export const PROVIDER_LABELS: Record<SearchProvider, string> = {
  model_builtin: '不额外联网（只用模型自身知识）',
  tavily: 'Tavily',
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  bing: 'Bing Web Search',
  searxng: 'SearXNG（自建）'
}

/** 该配置下 agent 是否应当拿到 web_search 工具 */
export function searchAvailable(cfg: SearchConfig): boolean {
  if (!cfg.enabled) return false
  if (cfg.provider === 'model_builtin') return false
  if (cfg.provider === 'searxng') return cfg.endpoint.trim().length > 0
  return cfg.api_key.trim().length > 0
}

export async function search(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  if (!searchAvailable(cfg)) return []

  const key = cacheKey(q, cfg)
  const hit = cache.get(key)
  if (hit) return hit

  const adapter = ADAPTERS[cfg.provider as Exclude<SearchProvider, 'model_builtin'>]
  const results = await adapter(q, cfg)
  cache.set(key, results)
  return results
}

export async function testSearch(cfg: SearchConfig): Promise<{ ok: boolean; message: string }> {
  if (cfg.provider === 'model_builtin') {
    return {
      ok: true,
      message: '当前选择的是「不额外联网」，agent 只依赖模型自身知识，无需测试。'
    }
  }
  if (!searchAvailable({ ...cfg, enabled: true })) {
    return {
      ok: false,
      message: cfg.provider === 'searxng' ? '请先填写 SearXNG 实例地址' : '请先填写 API Key'
    }
  }
  try {
    const hits = await search('7-Zip 是什么软件', { ...cfg, enabled: true })
    if (hits.length === 0) return { ok: false, message: '接口通了，但没有返回任何结果，请检查配置。' }
    return { ok: true, message: `搜索可用，返回 ${hits.length} 条结果，首条：${hits[0].title}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------ 图片搜索 ------------------------------ */

/**
 * 图片搜索。返回的是**图片本身的地址**，不是承载图片的网页。
 *
 * 只有两家做得到：Bing 有独立的 `/images/search` 端点，SearXNG 支持
 * `categories=images`。Tavily / Exa / Firecrawl 的接口只回网页，
 * 拿网页地址当封面塞进 `<img>` 只会得到一张破图，所以它们直接报「不支持」
 * 而不是勉强返回点什么 —— 让调用方能把这件事**说给用户听**。
 */
export function imageSearchAvailable(cfg: SearchConfig): boolean {
  if (!searchAvailable(cfg)) return false
  return cfg.provider === 'bing' || cfg.provider === 'searxng'
}

/** 当前配置为什么搜不了图 —— 这句话是要显示给用户的，所以分情况说清 */
export function imageSearchWhyNot(cfg: SearchConfig): string {
  if (!cfg.enabled) return '联网搜索没有开启'
  if (cfg.provider === 'model_builtin') return '当前是「不额外联网」，没有可用的图片搜索'
  if (cfg.provider === 'searxng' && !cfg.endpoint.trim()) return 'SearXNG 还没填实例地址'
  if (!imageSearchAvailable(cfg)) {
    return `${PROVIDER_LABELS[cfg.provider]} 的接口只返回网页、不返回图片地址，帮不上封面搜索`
  }
  return ''
}

export interface ImageHit {
  url: string
  title: string
}

export async function searchImages(query: string, cfg: SearchConfig): Promise<ImageHit[]> {
  const q = query.trim()
  if (!q || !imageSearchAvailable(cfg)) return []

  if (cfg.provider === 'bing') {
    const base = (cfg.endpoint || 'https://api.bing.microsoft.com/v7.0/images/search').replace(
      /\/+$/,
      ''
    )
    // endpoint 填的是网页搜索地址时，换成图片端点；否则原样用
    const url = base.includes('/images/') ? base : base.replace(/\/search$/, '/images/search')
    const json = await get(
      `${url}?q=${encodeURIComponent(q)}&count=${MAX_HITS}&mkt=zh-CN`,
      { 'Ocp-Apim-Subscription-Key': cfg.api_key }
    )
    const results: any[] = Array.isArray(json?.value) ? json.value : []
    return results
      .map((r) => ({ url: String(r?.contentUrl ?? ''), title: trimSnippet(r?.name) }))
      .filter((r) => r.url)
  }

  const base = cfg.endpoint.replace(/\/+$/, '')
  const json = await get(
    `${base}/search?q=${encodeURIComponent(q)}&format=json&categories=images`
  )
  const results: any[] = Array.isArray(json?.results) ? json.results : []
  return results
    .slice(0, MAX_HITS)
    .map((r) => ({
      url: String(r?.img_src ?? r?.thumbnail_src ?? ''),
      title: trimSnippet(r?.title)
    }))
    .filter((r) => r.url)
}

/** 把搜索结果转成回灌给模型的纯文本 */
export function formatHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `「${query}」没有搜到结果。请依据本地信息判断。`
  return [
    `「${query}」的搜索结果：`,
    ...hits.map((h, i) => `[${i + 1}] ${h.title}\n    ${h.url}\n    ${h.snippet || '(无摘要)'}`)
  ].join('\n')
}
