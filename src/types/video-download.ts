/** Single-episode downloads live only for the current process; never update the media library. */
export interface VideoDownloadSource {
  id: string
  label: string
  extension: string
}
export interface VideoDownloadCatalog {
  resourceId: string
  videoCode: string
  title: string
  pageUrl: string
  sources: VideoDownloadSource[]
  warnings: string[]
}
export interface VideoDownloadRequest {
  requestId: string
  resourceId: string
  sourceId: string
}
export interface VideoDownloadProgress {
  requestId: string
  resourceId: string
  phase: 'choosing' | 'downloading' | 'finalizing'
  receivedBytes: number
  /** 0 means unknown. */
  totalBytes: number
  bytesPerSecond: number
  message: string
}
export interface VideoDownloadResult {
  requestId: string
  resourceId: string
  status: 'success' | 'failed' | 'cancelled'
  path: string
  message: string
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  warnings: string[]
}

export interface VideoSeriesEpisode {
  videoCode: string
  title: string
}
export interface VideoSeriesCatalog {
  resourceId: string
  videoCode: string
  title: string
  episodes: VideoSeriesEpisode[]
  warnings: string[]
}
export interface VideoSeriesDownloadRequest {
  requestId: string
  resourceId: string
  /** Empty means use the highest available source for each episode. */
  sourceLabel: string
  /** Omitted selects the entire cached playlist; otherwise a nonempty subset. */
  videoCodes?: string[]
}
export type VideoSeriesDownloadPhase = 'choosing' | 'resolving' | 'downloading' | 'finalizing' | 'episode-done' | 'done'
export interface VideoSeriesDownloadProgress {
  requestId: string
  resourceId: string
  phase: VideoSeriesDownloadPhase
  episodeIndex: number
  episodeTotal: number
  videoCode: string
  title: string
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  message: string
  episodeResult?: VideoSeriesEpisodeResult
}
export interface VideoSeriesEpisodeResult {
  videoCode: string
  title: string
  status: 'success' | 'failed' | 'skipped' | 'cancelled'
  path: string
  sourceLabel: string
  message: string
  warnings: string[]
}
export interface VideoSeriesDownloadResult {
  requestId: string
  resourceId: string
  status: 'success' | 'failed' | 'cancelled'
  path: string
  message: string
  total: number
  completed: number
  failed: number
  skipped: number
  fallback: number
  results: VideoSeriesEpisodeResult[]
  warnings: string[]
}
