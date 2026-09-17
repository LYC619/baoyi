import type { VideoOrganizePreview } from './video-organize.ts'
export interface VideoAgentActions { merge: boolean; artwork: boolean; metadata: boolean; transfer: 'none' | 'copy' | 'move' }
export interface VideoAgentPlan {
  id: string
  actions: VideoAgentActions
  works: { id: string; title: string }[]
  groups: { id: string; title: string; resourceIds: string[]; reason: string; preview: VideoOrganizePreview }[]
  tokens: number
  log: string
  groupingStatus: 'not-requested' | 'no-candidates' | 'complete' | 'partial' | 'failed'
  warnings: string[]
}
export interface VideoAgentOutcome { id: string; title: string; ok: boolean; message: string }
export interface VideoAgentResult { planId: string; outcomes: VideoAgentOutcome[]; tokens: number; cancelled: boolean }
export interface VideoAgentProgress {
  current: string
  processed: number
  total: number
  message: string
  log?: string
  level?: 'info' | 'warn' | 'error'
}
export interface VideoAgentOrganizeApi {
  prepare(ids: string[], actions: VideoAgentActions): Promise<VideoAgentPlan>
  run(id: string, groupIds: string[]): Promise<VideoAgentResult>
  cancel(): Promise<boolean>
  onProgress(callback: (value: VideoAgentProgress) => void): () => void
}
