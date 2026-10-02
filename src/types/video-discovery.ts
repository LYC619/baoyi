import type { WebBrowserApi } from './web-browser'
export interface DiscoveryDownload { label: string; url: string; extension: string }
export interface DiscoveryRanking { name: string; source: string; period: string; position: number }
export interface DiscoveryEntry {
  id: string
  code: string
  title: string
  description: string
  coverUrl: string
  pageUrl: string
  playUrl: string
  mediaUrl?: string
  tags: string[]
  year: number
  rating?: { value: number; scale: number; votes: number }
  rankings: DiscoveryRanking[]
  downloads: DiscoveryDownload[]
}
export interface DiscoverySource {
  schemaVersion: 1
  id: string
  name: string
  homeUrl: string
  entries: DiscoveryEntry[]
  online?: DiscoveryOnlineConfig
}
export interface DiscoveryOnlineConfig { adapter: 'video-object' | 'javdb'; url: string; nextPageUrl: string; visited: string[] }
export interface DiscoveryMark { favorite: boolean; watched: boolean; notes: string; userRating: number }
export interface DiscoveryCard { entry: DiscoveryEntry; mark: DiscoveryMark; resourceId: string }
export interface DiscoverySourceSummary { id: string; name: string; homeUrl: string; count: number; updatedAt: number; online?: DiscoveryOnlineConfig }
export interface DiscoverySelection { sourceId: string; entryId: string }
export interface DiscoveryApi {
  online: {
    connect(url: string): Promise<DiscoverySourceSummary>
    refresh(sourceId: string): Promise<DiscoverySourceSummary>
    next(sourceId: string): Promise<DiscoverySourceSummary>
    detail(selection: DiscoverySelection): Promise<DiscoveryCard>
  }
  web: WebBrowserApi
  sources(): Promise<DiscoverySourceSummary[]>
  entries(sourceId: string): Promise<DiscoveryCard[]>
  artwork(selection: DiscoverySelection): Promise<string>
  importSource(): Promise<DiscoverySourceSummary | null>
  exportSource(sourceId: string): Promise<boolean>
  removeSource(sourceId: string): Promise<void>
  mark(selection: DiscoverySelection, patch: Partial<DiscoveryMark>): Promise<DiscoveryMark>
  open(sourceId: string, entryId?: string, mode?: 'page' | 'play'): Promise<void>
  /** 资料站没有可内播文件时，按番号去在线播放站搜索页（用通用浏览窗口打开）。 */
  playExternal(selection: DiscoverySelection, siteId?: string): Promise<void>
  onDownload(cb: (selection: DiscoverySelection) => void): () => void
}
