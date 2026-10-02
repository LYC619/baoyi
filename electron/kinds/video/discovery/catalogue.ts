import type { SqlDb } from '../../../services/schema.ts'
import type { DiscoveryCard, DiscoveryEntry, DiscoveryMark, DiscoverySource, DiscoverySourceSummary, DiscoveryOnlineConfig } from '../../../../src/types/video-discovery.ts'

const extensions = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi', 'ogv', 'ogg', 'mpg', 'mpeg'])
const blankMark = (): DiscoveryMark => ({ favorite: false, watched: false, notes: '', userRating: 0 })
export const VIDEO_DISCOVERY_SQL = `CREATE TABLE IF NOT EXISTS video_discovery_sources (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS video_discovery_marks (source_id TEXT NOT NULL, entry_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(source_id,entry_id), FOREIGN KEY(source_id) REFERENCES video_discovery_sources(id) ON DELETE CASCADE);`
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('来源目录格式无效')
  return value as Record<string, unknown>
}
function text(value: unknown, name: string, max: number, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new Error(name + '无效或过长')
  return value.trim()
}
export function discoveryUrl(value: unknown, required = false): string {
  const raw = text(value, '地址', 4000, required)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    return url.href
  } catch { throw new Error('地址必须是不含账号密码的 HTTP(S) 链接') }
}
export function videoFileExtension(url: string): string {
  const suffix = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() || ''
  return extensions.has(suffix) ? suffix : ''
}
const ONLINE_ADAPTERS = ['video-object', 'javdb'] as const
function onlineConfig(value: unknown): DiscoveryOnlineConfig | undefined {
  if (value === undefined) return undefined
  const obj = record(value)
  if (typeof obj.adapter !== 'string' || !(ONLINE_ADAPTERS as readonly string[]).includes(obj.adapter)) throw new Error('不支持的在线来源适配器')
  const adapter = obj.adapter as DiscoveryOnlineConfig['adapter']
  const url = discoveryUrl(obj.url, true), origin = new URL(url).origin
  const sameSite = (value: unknown) => {
    const link = discoveryUrl(value)
    if (link && new URL(link).origin !== origin) throw new Error('下一页必须与来源为同站点')
    return link
  }
  return { adapter, url, nextPageUrl: sameSite(obj.nextPageUrl), visited: [...new Set(array(obj.visited, '已读取页面', 2000).map(sameSite).filter(Boolean))] }
}
function number(value: unknown, name: string, min: number, max: number, fallback = 0): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(name + '无效')
  return value
}
function array(value: unknown, name: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(name + '不能超过 ' + max + ' 项')
  return value
}
export function parseCatalogue(raw: unknown): DiscoverySource {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('来源目录不能超过 5 MB')
    try { raw = JSON.parse(raw) } catch { throw new Error('来源目录不是有效 JSON') }
  }
  const obj = record(raw)
  if (obj.schemaVersion !== 1) throw new Error('不支持的来源目录版本，应为 schemaVersion: 1')
  const id = text(obj.id, '来源编号', 48, true)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('来源编号仅支持小写字母、数字、下划线和短横线')
  if (!Array.isArray(obj.entries)) throw new Error('来源目录缺少 entries 作品列表')
  const seen = new Set<string>()
  const entries = array(obj.entries, '作品目录', 2000).map(value => {
    // Local source ownership is case-insensitive; catalogue keys must agree.
    const item = record(value), entryId = text(item.id, '作品编号', 160, true).toLowerCase()
    if (seen.has(entryId)) throw new Error('作品编号重复：' + entryId)
    seen.add(entryId)
    const entry: DiscoveryEntry = {
      id: entryId, code: text(item.code, '展示编号', 100), title: text(item.title, '作品标题', 240, true),
      description: text(item.description, '作品简介', 8000), coverUrl: discoveryUrl(item.coverUrl),
      pageUrl: discoveryUrl(item.pageUrl), playUrl: discoveryUrl(item.playUrl),
      mediaUrl: discoveryUrl(item.mediaUrl),
      tags: [...new Set(array(item.tags, '标签', 40).map(tag => text(tag, '标签', 80, true)))],
      year: number(item.year, '年份', 0, 9999),
      rankings: array(item.rankings, '榜单', 30).map(value => {
        const rank = record(value)
        return { name: text(rank.name, '榜单名称', 100, true), source: text(rank.source, '榜单出处', 100, true),
          period: text(rank.period, '榜单周期', 100), position: number(rank.position, '排名', 1, 1000000, 1) }
      }),
      downloads: array(item.downloads, '下载选项', 20).map(value => {
        const download = record(value), url = discoveryUrl(download.url, true)
        const suffix = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() || ''
        const extension = text(download.extension, '视频格式', 10).toLowerCase() || suffix
        if (!extensions.has(extension) || suffix && !extensions.has(suffix) || suffix && suffix !== extension) throw new Error('下载选项必须指向完整视频文件；不支持分片清单或其他文件格式')
        return { label: text(download.label, '下载画质', 40, true), url, extension }
      })
    }
    if (entry.mediaUrl && !videoFileExtension(entry.mediaUrl)) throw new Error('内置播放地址必须指向完整视频文件')
    if (new Set(entry.downloads.map(value => value.label)).size !== entry.downloads.length) throw new Error('下载画质名称重复')
    if (item.rating !== undefined) {
      const rating = record(item.rating), scale = number(rating.scale, '评分满分', 1, 100, 10)
      entry.rating = { value: number(rating.value, '评分', 0, scale), scale, votes: number(rating.votes, '评分人数', 0, 1e10) }
    }
    return entry
  })
  return { schemaVersion: 1, id, name: text(obj.name, '来源名称', 100, true), homeUrl: discoveryUrl(obj.homeUrl), entries, online: onlineConfig(obj.online) }
}

export function createDiscoveryCatalogue(db: SqlDb) {
  db.exec(VIDEO_DISCOVERY_SQL)
  function get(id: string): DiscoverySource {
    const row = db.prepare('SELECT payload FROM video_discovery_sources WHERE id=?').get(id) as { payload: string } | undefined
    if (!row) throw new Error('来源不存在，请重新选择')
    return JSON.parse(row.payload)
  }
  function sources(): DiscoverySourceSummary[] {
    return (db.prepare('SELECT payload,updated_at FROM video_discovery_sources ORDER BY updated_at DESC,id').all() as Array<{ payload: string; updated_at: number }>).map(row => {
      const value: DiscoverySource = JSON.parse(row.payload)
      return { id: value.id, name: value.name, homeUrl: value.homeUrl, count: value.entries.length, updatedAt: row.updated_at, online: value.online }
    })
  }
  function entries(id: string): DiscoveryCard[] {
    const source = get(id)
    const marks = new Map((db.prepare('SELECT entry_id,payload FROM video_discovery_marks WHERE source_id=?').all(id) as Array<{ entry_id: string; payload: string }>).map(row => [row.entry_id, JSON.parse(row.payload) as DiscoveryMark]))
    const local = new Map((db.prepare(`SELECT s.external_id,s.resource_id FROM video_sources s JOIN resource r ON r.id=s.resource_id
      WHERE s.provider=? AND r.is_archived=0`).all('catalogue:' + id) as Array<{ external_id: string; resource_id: string }>).map(row => [row.external_id, row.resource_id]))
    return source.entries.map(entry => ({ entry, mark: marks.get(entry.id) || blankMark(), resourceId: local.get(entry.id) || '' }))
  }
  function entry(sourceId: string, entryId: string): DiscoveryCard {
    const value = entries(sourceId).find(card => card.entry.id === entryId)
    if (!value) throw new Error('作品已不在来源目录中，请刷新')
    return value
  }
  function importSource(raw: unknown): DiscoverySourceSummary {
    const source = parseCatalogue(raw)
    db.prepare(`INSERT INTO video_discovery_sources(id,updated_at,payload) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload`).run(source.id, Date.now(), JSON.stringify(source))
    return sources().find(item => item.id === source.id)!
  }
  function mark(sourceId: string, entryId: string, patch: Partial<DiscoveryMark>): DiscoveryMark {
    const previous = entry(sourceId, entryId).mark, next = { ...previous }
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !['favorite', 'watched', 'notes', 'userRating'].includes(key))) throw new Error('个人标记无效')
    for (const key of ['favorite', 'watched'] as const) if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') throw new Error('个人标记无效')
      next[key] = patch[key]!
    }
    if (patch.notes !== undefined) next.notes = text(patch.notes, '备注', 4000)
    if (patch.userRating !== undefined) next.userRating = number(patch.userRating, '个人评分', 0, 5)
    db.prepare(`INSERT INTO video_discovery_marks(source_id,entry_id,payload) VALUES (?,?,?)
      ON CONFLICT(source_id,entry_id) DO UPDATE SET payload=excluded.payload`).run(sourceId, entryId, JSON.stringify(next))
    return next
  }
  function remove(id: string): void { db.prepare('DELETE FROM video_discovery_sources WHERE id=?').run(id) }
  return { get, sources, entries, entry, importSource, mark, remove }
}
export type DiscoveryCatalogue = ReturnType<typeof createDiscoveryCatalogue>
