import type { Episode } from '@/types'

export function videoDateLabel(stamp?: number): string {
  if (!stamp || !Number.isFinite(stamp)) return ''
  const date = new Date(stamp > 0 && stamp < 100_000_000_000 ? stamp * 1000 : stamp)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

export function videoEpisodeLabel(episode: Pick<Episode, 'season' | 'episode' | 'display_label'>, withoutSeason = false): string {
  if (episode.episode >= 0) return episode.season > 0 && !withoutSeason
    ? `第 ${episode.season} 季 · 第 ${episode.episode} 集` : `第 ${episode.episode} 集`
  return episode.display_label || '未标注集数'
}

/** Site catalogue entries have neither a recorded video path nor a video asset. */
export function registeredVideoContent(content: { path?: string; assets?: { role: string }[] }): boolean {
  return !!content.path || !!content.assets?.some(asset => asset.role === 'video')
}
