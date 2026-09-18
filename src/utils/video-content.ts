import type { Episode } from '@/types'

export function videoDateLabel(stamp?: number): string {
  if (!stamp || !Number.isFinite(stamp)) return ''
  const date = new Date(stamp > 0 && stamp < 100_000_000_000 ? stamp * 1000 : stamp)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * 集标签。普通剧集：「第 1 季 · 第 2 集」；里番这类没有"季"的作品（withoutSeason）
 * 把 season 当「部」：season > 0 显示「第 N 部 · 第 M 集」，0 仍只显示「第 M 集」（B8）
 */
export function videoEpisodeLabel(episode: Pick<Episode, 'season' | 'episode' | 'display_label'>, withoutSeason = false): string {
  if (episode.episode >= 0) return episode.season > 0
    ? `${withoutSeason ? '第 ' + episode.season + ' 部' : '第 ' + episode.season + ' 季'} · 第 ${episode.episode} 集` : `第 ${episode.episode} 集`
  return episode.display_label || '未标注集数'
}

/** 分组标题：普通剧集「第 N 季」，里番「第 N 部」；season 0 不分组（返回空串） */
export function videoSeasonLabel(season: number, withoutSeason = false): string {
  return season > 0 ? (withoutSeason ? `第 ${season} 部` : `第 ${season} 季`) : ''
}

/** Site catalogue entries have neither a recorded video path nor a video asset. */
export function registeredVideoContent(content: { path?: string; assets?: { role: string }[] }): boolean {
  return !!content.path || !!content.assets?.some(asset => asset.role === 'video')
}
