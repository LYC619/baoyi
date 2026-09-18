export type VideoAssetState = 'unchecked' | 'present' | 'missing' | 'offline'
export interface VideoAsset {
  id: string
  resource_id: string
  path: string
  role: 'video' | 'subtitle' | 'poster' | 'attachment'
  quality: string
  file_size: number
  state: VideoAssetState
  checked_at: number
  created_at: number
}
export interface VideoSourceRef {
  provider: string
  externalId: string
  scope: 'work' | 'episode'
  pageUrl: string
  evidence: 'confirmed' | 'playlist' | 'bundle' | 'nfo' | 'legacy'
}
export interface VideoDirectory {
  resourceId: string
  bundleId: string
  root: string
  relativePath: string
  path: string
  metadataState: string
  /** 清单里缺什么：description / poster / files:<集 id>。老库没有这一列时为空数组 */
  missing?: string[]
}
export interface VideoOwnership {
  state: 'known' | 'new' | 'conflict'
  resourceId: string
  candidates: string[]
  title: string
  reason: string
  directory: VideoDirectory | null
}
export interface VideoContentInput {
  publishedAt?: number
  airDate?: number
  durationSec?: number
  studio?: string
  id?: string
  title: string
  label?: string
  order: number
  season?: number | null
  number?: number | null
  originalTitle?: string
  description?: string
  originalDescription?: string
  posterPath?: string
  posterSource?: string
  thumbnailPath?: string
  thumbnailSource?: string
  tags?: string[]
  attachments?: Array<{ path: string; role: "subtitle" | "poster" | "attachment" }>
  sourceUrl?: string
  notes?: string
  watch?: { status: 'unwatched' | 'watching' | 'watched' | 'dropped'; position: number; watchedAt: number }
  sources?: VideoSourceRef[]
  files: Array<{ path: string; quality?: string; size?: number }>
}
export interface VideoRegistration {
  restoreRemoved?: boolean
  resourceId?: string
  bundleId?: string
  directory?: string
  root?: string
  title: string
  nameEn?: string
  description?: string
  originalDescription?: string
  category?: string
  tags?: string[]
  posterPath?: string
  posterSource?: string
  thumbnailPath?: string
  thumbnailSource?: string
  sources?: VideoSourceRef[]
  items: VideoContentInput[]
  metadataState?: string
  missing?: string[]
}
export interface VideoRegistrationResult {
  skipped?: boolean
  resourceId: string
  bundleId: string
  created: boolean
  itemsAdded: number
  filesAdded: number
  pathsRepaired?: number
  duplicatesMerged?: number
  warnings?: string[]
}
export interface VideoBundle {
  excluded_files?: string[]
  excluded_sources?: string[]
  schema_version: 1
  bundle_id: string
  revision: number
  updated_at: number
  work: {
    title: string
    name_en: string
    description: string
    original_description: string
    category: string
    tags: string[]
    sources: VideoSourceRef[]
    poster: string
    poster_source: string
    thumbnail?: string
    thumbnail_source?: string
    provenance: Record<string, string>
  }
  items: Array<{
    published_at?: number
    air_date?: number
    duration_sec?: number
    studio?: string
    id: string
    title: string
    label: string
    order: number
    season: number | null
    number: number | null
    original_title?: string
    description?: string
    original_description?: string
    poster?: string
    poster_source?: string
    thumbnail?: string
    thumbnail_source?: string
    tags?: string[]
    attachments?: Array<{ path: string; role: "subtitle" | "poster" | "attachment" }>
    source_url?: string
    notes?: string
    watch?: { status: 'unwatched' | 'watching' | 'watched' | 'dropped'; position: number; watchedAt: number }
    sources: VideoSourceRef[]
    files: Array<{ path: string; quality: string; size: number }>
  }>
  managed_files: Record<string, string>
  missing: string[]
}
