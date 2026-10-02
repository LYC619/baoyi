/**
 * 在线播放站模板。作品资料来自资料站（JAVDB），真正观看去这些播放站按番号搜。
 *
 * 模板占位符：`{code}`（原样番号，URL 编码）、`{code_lower}`（小写番号）。
 * 第一版只内置常用几个；站点会换域名，`template` 以后可以做成设置项。
 */

export interface PlaybackSite { id: string; name: string; template: string }

export const PLAYBACK_SITES: PlaybackSite[] = [
  { id: 'missav', name: 'MissAV', template: 'https://missav.ws/search/{code}' },
  { id: 'jable', name: 'Jable', template: 'https://jable.tv/search/{code}/' },
  { id: 'supjav', name: 'SupJav', template: 'https://supjav.com/?s={code}' }
]

export const DEFAULT_PLAYBACK_SITE = 'missav'

/** 按番号拼播放站搜索地址。番号为空返回空串，不猜。 */
export function playbackUrl(siteId: string, code: string): string {
  const site = PLAYBACK_SITES.find(item => item.id === siteId)
  const value = String(code || '').trim()
  if (!site || !value) return ''
  try {
    return site.template
      .replace('{code_lower}', encodeURIComponent(value.toLowerCase()))
      .replace('{code}', encodeURIComponent(value))
  } catch {
    return ''
  }
}
