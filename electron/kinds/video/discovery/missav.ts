/**
 * MissAV 播放页解析：取 m3u8 直链。
 *
 * 播放地址藏在页面内嵌的 Dean Edwards 压缩脚本里（`eval(function(p,a,c,k,e,d){...})`），
 * 解包后从里面找 `.m3u8`。规矩照 `adapters/javdb.ts`：解析纯函数、取页面交给调用方。
 *
 * 解析规则参考公开项目 xin0907/vget-cli（Apache-2.0）与 9E307/JavdbEmbySkin（BSD-3-Clause）。
 */

/** 备选镜像。站点会换域名，第一个不通就换下一个。 */
export const MISSAV_HOSTS = ['missav.ws', 'missav.ai', 'missav.live', 'missav123.com'] as const

export const MISSAV_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function missavHeaders(host: string): Record<string, string> {
  return { 'User-Agent': MISSAV_UA, Referer: `https://${host}/`, Origin: `https://${host}`, 'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7' }
}

/** 播放页里可能有多套清晰度（f/d/b 等变量），取第一个 m3u8 即可（通常是主清单）。 */
function decodePacked(script: string): string | null {
  const match = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'\s*\.split\('\|'\)/.exec(script)
  if (!match) return null
  const packed = match[1]
  const base = Number(match[2]), count = Number(match[3])
  const keys = match[4].split('|')
  if (base < 2 || base > 36 || count < 0 || count > 200_000) return null
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  const toBase = (value: number): string => { if (value === 0) return '0'; let out = ''; while (value) { out = digits[value % base] + out; value = Math.floor(value / base) } return out }
  const lookup: Record<string, string> = {}
  for (let index = 0; index < count; index++) lookup[toBase(index)] = index < keys.length && keys[index] ? keys[index] : toBase(index)
  return packed.replace(/\b\w+\b/g, word => lookup[word] ?? word)
}

const M3U8_PATTERN = /https?:\/\/[^\s'"<>\\]+\.m3u8(?:\?[^\s'"<>\\]*)?/i

/** 从页面 HTML 抽 m3u8 地址。抽不到返回空串，不抛错。 */
export function extractMissavM3u8(html: string): string {
  const scripts = [...String(html || '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1])
  for (const script of scripts) {
    if (!script.includes('eval(function') || !script.includes('m3u8')) continue
    const decoded = decodePacked(script)
    if (!decoded) continue
    const hit = M3U8_PATTERN.exec(decoded.replace(/\\\//g, '/'))
    if (hit) return hit[0]
  }
  const direct = M3U8_PATTERN.exec(String(html || '').replace(/\\\//g, '/'))
  return direct ? direct[0] : ''
}

function meta(html: string, property: string): string {
  const match = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html)
  return match ? match[1].trim() : ''
}

export interface MissavResolved {
  host: string
  pageUrl: string
  m3u8: string
  headers: Record<string, string>
  title: string
  coverUrl: string
  durationSec: number
  actors: string[]
}

/** 详情候选地址：先直连 `/{code}`，再退到站内搜索。 */
export function missavPageCandidates(code: string, host: string): string[] {
  const lower = encodeURIComponent(String(code || '').trim().toLowerCase())
  if (!lower) return []
  return [`https://${host}/${lower}`, `https://${host}/search/${lower}`]
}

export interface MissavSearchHit { url: string; title: string }

/** 站内搜索结果里找番号对应的详情页地址。 */
export function findMissavDetail(html: string, code: string, host: string): MissavSearchHit | null {
  const needle = String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!needle) return null
  const anchors = [...String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  for (const [, href, inner] of anchors) {
    const title = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const slug = String(href || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!slug.includes(needle)) continue
    const url = href.startsWith('http') ? href : `https://${host}${href.startsWith('/') ? '' : '/'}${href}`
    return { url, title }
  }
  return null
}

/**
 * 按番号在 MissAV 上解析出可下载片源。
 * 先直连 `/{code}`，不行再走站内搜索；镜像逐个尝试。全部失败抛最后一个错。
 */
export async function resolveMissav(code: string, fetchPage: typeof fetch, signal: AbortSignal): Promise<MissavResolved> {
  let lastError: unknown
  for (const host of MISSAV_HOSTS) {
    const headers = missavHeaders(host)
    for (const candidate of missavPageCandidates(code, host)) {
      if (signal.aborted) throw signal.reason
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      try {
        const response = await fetchPage(candidate, { headers, signal: requestSignal, redirect: 'follow' })
        if (!response.ok) { lastError = new Error('MissAV HTTP ' + response.status); continue }
        const html = await response.text()
        if (extractMissavM3u8(html)) return parseMissavDetail(html, candidate, host)
        const hit = findMissavDetail(html, code, host)
        if (hit && hit.url !== candidate) {
          const detailResponse = await fetchPage(hit.url, { headers, signal: requestSignal, redirect: 'follow' })
          if (detailResponse.ok) {
            const detailHtml = await detailResponse.text()
            if (extractMissavM3u8(detailHtml)) return parseMissavDetail(detailHtml, hit.url, host)
          }
        }
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MissAV 上没找到这部作品，或镜像都不可达')
}

/** 把详情页 HTML + 最终地址解析成可下载的信息。抽不到 m3u8 抛错（由调用方决定降级）。 */
export function parseMissavDetail(html: string, pageUrl: string, host: string): MissavResolved {
  const m3u8 = extractMissavM3u8(html)
  if (!m3u8) throw new Error('MissAV 页面没有找到可用 M3U8 地址（可能需要人机验证或站点结构已变）')
  const actors = [...String(html).matchAll(/<meta[^>]+property=["']og:video:actor["'][^>]+content=["']([^"']*)["']/gi)].map(match => match[1].trim()).filter(Boolean)
  const duration = Number(meta(html, 'og:video:duration')) || 0
  return {
    host, pageUrl, m3u8, headers: missavHeaders(host),
    title: meta(html, 'og:title'),
    coverUrl: meta(html, 'og:image'),
    durationSec: Number.isFinite(duration) ? duration : 0,
    actors
  }
}
