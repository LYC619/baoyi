import type { SqlDb } from '../../services/schema.ts'

/** 占位集的判定和让出，单独一个文件：registration.ts 和 catalogue.ts 都要用，放任一边都成环 */
export function placeholderEpisodeIds(d: SqlDb, code: string, exceptResourceId = ''): Array<{ episode_id: string; resource_id: string }> {
  return (d.prepare(`SELECT DISTINCT s.episode_id, s.resource_id FROM video_sources s JOIN episode e ON e.id = s.episode_id
    WHERE s.provider = 'hanime' AND s.external_id = ? AND s.episode_id IS NOT NULL AND e.path = '' AND e.position_sec = 0 AND e.watch_status = 'unwatched'
      AND NOT EXISTS (SELECT 1 FROM video_episode_assets ea JOIN video_assets a ON a.id = ea.asset_id WHERE ea.episode_id = e.id AND a.role = 'video')`)
    .all(code) as Array<{ episode_id: string; resource_id: string }>).filter(row => row.resource_id !== exceptResourceId)
}

/** 把其他作品对这一集的占位让出来；有文件或看过的集不动。返回让出的作品 id */
export function releasePlaceholderClaims(d: SqlDb, code: string, keepResourceId: string): string[] {
  const rows = placeholderEpisodeIds(d, code, keepResourceId)
  for (const row of rows) {
    d.prepare('DELETE FROM episode WHERE id = ?').run(row.episode_id)
    d.prepare("UPDATE video_meta SET hanime_id = '' WHERE resource_id = ? AND hanime_id = ?").run(row.resource_id, code)
  }
  return [...new Set(rows.map(row => row.resource_id))]
}

