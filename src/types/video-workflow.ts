import type { Episode } from './index'
import type { VideoAsset, VideoDirectory, VideoSourceRef } from './video-library'

export interface VideoWorkContent extends Episode { assets: VideoAsset[]; sources: VideoSourceRef[] }
export interface VideoWorkLibrary { resourceId: string; directory: VideoDirectory | null; contents: VideoWorkContent[]; assets: VideoAsset[] }
export interface VideoLibrarySyncResult { library: VideoWorkLibrary; itemsAdded: number; filesAdded: number; pathsRepaired: number; duplicatesMerged: number; warnings: string[]; message: string }

export interface VideoDownloadDraft {
  id: string
  resourceId: string
  videoCode: string
  title: string
  description: string
  category: string
  pageUrl: string
  root: string
  directory: string
  bound: boolean
  directoryChange?: VideoDirectoryChange
  warnings: string[]
  missing: string[]
  episodes: Array<{ videoCode: string; title: string; originalTitle?: string; order: number; numbered?: boolean; state: 'local' | 'missing' | 'available' | 'queued' | 'other-work'; resourceId?: string; qualities: string[] }>
}
export interface VideoEnqueueRequest {
  draftId: string
  videoCodes: string[]
  sourceLabel: string
  strictQuality: boolean
  register: boolean
  title?: string
}
export type VideoJobStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type VideoJobStage = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
export interface VideoJobItem {
  publishedAt?: number
  releaseDate?: number
  durationSec?: number
  artist?: string
  tags?: string[]
  thumbnailUrl?: string
  thumbnailPath?: string
  videoCode: string
  title: string
  order: number
  originalTitle?: string
  description?: string
  posterUrl?: string
  posterPath?: string
  path: string
  sourceLabel: string
  transfer: VideoJobStage
  metadata: VideoJobStage
  registration: VideoJobStage
  receivedBytes: number
  totalBytes: number
  error: string
  warnings: string[]
}
export interface VideoDownloadJob {
  id: string
  resourceId: string
  bundleId: string
  title: string
  category: string
  videoCode: string
  root: string
  directory: string
  directoryChange?: VideoDirectoryChange
  episodeMetadata?: boolean
  sourceLabel: string
  strictQuality: boolean
  register: boolean
  status: VideoJobStatus
  createdAt: number
  updatedAt: number
  message: string
  description: string
  posterUrl: string
  posterPath: string
  sources: VideoSourceRef[]
  catalogue?: Array<{ videoCode: string; title: string; order: number; numbered: boolean }>
  items: VideoJobItem[]
  warnings: string[]
  retryStage?: VideoJobRetry
}
export type VideoJobRetry = 'remaining' | 'metadata' | 'registration'

export interface VideoDirectoryChange {
  from: string
  to: string
  identity?: { dev: number; ino: number }
  applied?: boolean
}
