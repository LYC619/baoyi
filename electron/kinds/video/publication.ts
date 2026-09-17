/** Older NFO imports store seconds; site metadata stores milliseconds. */
const preferred = '(CASE WHEN e.published_at > 0 THEN e.published_at ELSE e.air_date END)'
export const episodePublicationSql = `(CASE WHEN ${preferred} > 0 AND ${preferred} < 100000000000 THEN ${preferred} * 1000 ELSE NULLIF(${preferred}, 0) END)`
export const videoWithPublicationSql = `SELECT video.*,
  COALESCE((SELECT MIN(${episodePublicationSql}) FROM episode e WHERE e.resource_id=video.id), 0) AS published_start,
  COALESCE((SELECT MAX(${episodePublicationSql}) FROM episode e WHERE e.resource_id=video.id), 0) AS published_end FROM video`

export function publicationBounds(from?: string, to?: string): { from?: number; until?: number } {
  const parse = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请输入有效的发布日期')
    const stamp = Date.parse(value + 'T00:00:00Z')
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== value) throw new Error('请输入有效的发布日期')
    return stamp
  }
  const start = from ? parse(from) : undefined, end = to ? parse(to) : undefined
  if (start !== undefined && end !== undefined && start > end) throw new Error('开始日期不能晚于结束日期')
  return { from: start, until: end === undefined ? undefined : end + 86_400_000 }
}
