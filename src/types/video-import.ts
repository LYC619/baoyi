import type { VideoScanProgress } from './index'

export type VideoImportState = 'scanning' | 'reviewing' | 'ready' | 'committing' | 'complete' | 'interrupted'
export type VideoImportEntryState = 'ready' | 'review' | 'skipped' | 'failed' | 'confirmed'
export interface VideoImportEdits {
  title?: string
  originalTitle?: string
  category?: string
  description?: string
  tags?: string[]
}
export interface VideoImportEntry {
  id: string
  path: string
  status: VideoImportEntryState
  action: 'new' | 'update'
  title: string
  originalTitle: string
  category: string
  description: string
  tags: string[]
  fileCount: number
  episodeCount: number
  publishedStart: number
  publishedEnd: number
  resourceId: string
  message: string
  reviewError?: string
  log: string
  tokens: number
  selected: boolean
}
export interface VideoImportBatch {
  id: string
  roots: string[]
  createdAt: number
  updatedAt: number
  revision: number
  status: VideoImportState
  entries: VideoImportEntry[]
  progress: VideoScanProgress | null
  activeEntryId: string
  error: string
  tokens: number
}
export interface VideoImportSummary {
  id: string
  roots: string[]
  createdAt: number
  updatedAt: number
  status: VideoImportState
  total: number
  pending: number
  confirmed: number
}
export interface VideoImportApi {
  list(): Promise<VideoImportSummary[]>
  get(id: string): Promise<VideoImportBatch | null>
  prepare(roots?: string[]): Promise<VideoImportBatch | null>
  refresh(id: string): Promise<VideoImportBatch>
  update(id: string, changes: { selectedIds?: string[]; entry?: { id: string; edits: VideoImportEdits } }): Promise<VideoImportBatch>
  review(id: string, entryIds: string[]): Promise<VideoImportBatch>
  confirm(id: string, entryIds: string[]): Promise<VideoImportBatch>
  discard(id: string): Promise<boolean>
  cancel(id: string): Promise<boolean>
  onChanged(callback: (batch: VideoImportBatch) => void): () => void
}
