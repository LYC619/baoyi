import type { VideoAssetState, VideoDirectory } from './video-library.ts'

export type VideoOrganizeMode = 'logical' | 'physical'
export interface VideoOrganizeRequest {
  transfer?: 'copy' | 'move'
  /** Explicit order of selected works; the survivor must be included. */
  resourceIds: string[]
  survivorId: string
  collectionTitle?: string
  /** 合集名是用户改过的（不是程序按作品名算出来的建议名）。只有这时才标 user_edited: name_zh，
   * 否则之后下载补全 / 重新识别永远不能再把名字纠正过来（B7） */
  titleEdited?: boolean
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

/** 统一移动（实测第三轮）：把已入库作品挪成「整理根目录 / 收藏分组 / 作品文件夹」 */
export interface VideoLayoutEntry {
  resourceId: string
  title: string
  group: string
  from: string
  to: string
  /** move-directory：整个作品目录改名搬走；move-files：散文件走整理流程搬进新目录；in-place：已就位；skip：这次不动 */
  action: 'move-directory' | 'move-files' | 'in-place' | 'skip'
  reason: string
  files: number
  /** move-files 且带这个字段：顺着这条没收尾的整理日志重试，而不是另起一次 */
  journal?: string
}
export interface VideoLayoutPreview { root: string; entries: VideoLayoutEntry[]; movable: number }
export interface VideoLayoutResult { root: string; record: string; outcomes: Array<{ resourceId: string; title: string; ok: boolean; message: string }> }

export interface VideoOrganizeApi {
  layoutPreview(resourceIds: string[]): Promise<VideoLayoutPreview>
  layoutApply(resourceIds: string[]): Promise<VideoLayoutResult>
  preview(request: VideoOrganizeRequest): Promise<VideoOrganizePreview>
  apply(request: VideoOrganizeApplyRequest): Promise<VideoOrganizeJournal>
  retry(id: string): Promise<VideoOrganizeJournal>
  rollback(id: string): Promise<VideoOrganizeJournal>
  list(resourceId?: string): Promise<VideoOrganizeJournal[]>
  previewRelocate(request: VideoRelocateRequest): Promise<VideoRelocatePreview>
  relocate(request: VideoRelocateApplyRequest): Promise<VideoOrganizeJournal>
  pickDirectory(): Promise<string | null>
}
