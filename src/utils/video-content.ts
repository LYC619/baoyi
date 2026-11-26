
import { tr } from '../i18n/core.ts'
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
    ? tr('{p0} · 第 {p1} 集', {p0: videoSeasonLabel(episode.season, withoutSeason), p1: episode.episode}) : tr('第 {p0} 集', {p0: episode.episode})
  return episode.display_label || tr('未标注集数')
}

/** 分组标题：普通剧集「第 N 季」，里番「第 N 部」；season 0 不分组（返回空串） */
export function videoSeasonLabel(season: number, withoutSeason = false): string {
  return season > 0 ? (withoutSeason ? tr('第 {p0} 部', {p0: season}) : tr('第 {p0} 季', {p0: season})) : ''
}

/** Site catalogue entries have neither a recorded video path nor a video asset. */
export function registeredVideoContent(content: { path?: string; assets?: { role: string }[] }): boolean {
  return !!content.path || !!content.assets?.some(asset => asset.role === 'video')
}
