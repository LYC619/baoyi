import type { VideoAssetState, VideoDirectory } from './video-library.ts'

export type VideoOrganizeMode = 'logical' | 'physical'
export interface VideoOrganizeRequest {
  transfer?: 'copy' | 'move'
  /** Explicit order of selected works; the survivor must be included. */
  resourceIds: string[]
  survivorId: string
  collectionTitle?: string
  episodeNumbers?: Record<string, { season: number; episode: number }>
  targetDirectory?: string
  /** Parent chosen in settings. A safe collection-named child is created under it. */
  targetRoot?: string
  root?: string
  /** File ID from the preview -> a relative destination, never an absolute path. */
  fileNames?: Record<string, string>
}

export interface VideoOrganizeWork {
  resourceId: string
  name: string
  path: string
  notes: string
  archived: boolean
  watchStatus: string
  positionSec: number
  directory: VideoDirectory | null
  fileIds: string[]
}

export interface VideoOrganizeEpisode {
  id: string
  resourceId: string
  title: string
  season: number
  episode: number
  generated: boolean
  fileIds: string[]
}

export interface VideoOrganizeFile {
  id: string
  resourceIds: string[]
  assetIds: string[]
  episodeIds: string[]
  source: string
  destination: string
  relativePath: string
  size: number
  state: VideoAssetState
  action: 'copy' | 'move' | 'keep' | 'verify' | 'none'
}

export interface VideoOrganizeCollision {
  code: string
  /** File errors allow the remaining files to complete; other scopes block apply. */
  scope: 'logical' | 'physical' | 'file'
  message: string
  fileId?: string
  path?: string
  resourceIds?: string[]
}

export interface VideoOrganizePreview {
  kind: 'organize'
  request: VideoOrganizeRequest
  fingerprint: string
  works: VideoOrganizeWork[]
  survivor: VideoOrganizeWork
  targetDirectory: string
  root: string
  bundleId: string
  episodes: VideoOrganizeEpisode[]
  files: VideoOrganizeFile[]
  collisions: VideoOrganizeCollision[]
  warnings: string[]
  canMerge: boolean
  canOrganize: boolean
}

export interface VideoRelocateRequest {
  resourceId: string
  directory: string
  root?: string
  /** Rebind a directory already moved/copied by the user, or copy the whole directory. */
  mode: 'rebind' | 'copy'
}

export interface VideoRelocatePreview {
  kind: 'relocate'
  request: VideoRelocateRequest
  fingerprint: string
  resourceId: string
  name: string
  sourceDirectory: string
  targetDirectory: string
  root: string
  bundleId: string
  /** All subdirectories, including empty ones, relative to the managed directory. */
  directories: string[]
  files: VideoOrganizeFile[]
  collisions: VideoOrganizeCollision[]
  warnings: string[]
  canApply: boolean
}

export type VideoOrganizeFileStatus = 'pending' | 'copying' | 'copied' | 'switched' | 'unchanged' | 'failed' | 'rolled-back' | 'retained'
export interface VideoOrganizeFileResult extends VideoOrganizeFile {
  sourceRemoved?: boolean
  status: VideoOrganizeFileStatus
  error: string
  attempts: number
  sha256: string
  /** False only after a verified move removes the source; rollback retains the target copy. */
  originalRetained: boolean
}

export interface VideoOrganizeJournal {
  id: string
  kind: 'organize' | 'relocate'
  mode: VideoOrganizeMode | 'rebind' | 'copy'
  status: 'running' | 'applied' | 'partial' | 'rolled-back' | 'rollback-partial'
  survivorId: string
  sourceIds: string[]
  createdAt: number
  updatedAt: number
  targetDirectory: string
  files: VideoOrganizeFileResult[]
  warnings: string[]
  conflicts: string[]
  canRetry: boolean
  canRollback: boolean
}

export interface VideoOrganizeApplyRequest {
  preview: VideoOrganizePreview
  mode: VideoOrganizeMode
}

export interface VideoRelocateApplyRequest {
  preview: VideoRelocatePreview
}

export interface VideoOrganizeApi {
  preview(request: VideoOrganizeRequest): Promise<VideoOrganizePreview>
  apply(request: VideoOrganizeApplyRequest): Promise<VideoOrganizeJournal>
  retry(id: string): Promise<VideoOrganizeJournal>
  rollback(id: string): Promise<VideoOrganizeJournal>
  list(resourceId?: string): Promise<VideoOrganizeJournal[]>
  previewRelocate(request: VideoRelocateRequest): Promise<VideoRelocatePreview>
  relocate(request: VideoRelocateApplyRequest): Promise<VideoOrganizeJournal>
  pickDirectory(): Promise<string | null>
}
