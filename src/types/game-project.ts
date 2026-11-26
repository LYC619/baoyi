import type { LinkedFile } from './index'

export interface GameProjectRecord {
  artwork?: Partial<Record<GameArtworkRole, GameProjectArtwork & { installedPath: string }>>
  key: string
  source: string
  root: string
  platform: 'Windows' | 'Android'
  family: string
  version: string
  synopsis: string
  revision: string
  facets: Array<{label:string;state:string;detail:string}>
  issues: Array<{text:string;status:'open'|'deferred'|'fixed';evidence:string}>
  saveScope: string
  guidePath: string
  history: Array<{at:number;summary:string;revision:string}>
}
export interface GameProjectChanges {
  added: string[]
  refreshed: string[]
  retired: string[]
  missing: string[]
  metadata: boolean
}
export interface GameProjectCheck {id:string;state:'current'|'changed'|'unavailable';detail:string}

export interface GameProjectCandidate {
  artwork?: GameArtworkDifference[]
  key: string
  name: string
  platform: 'Windows' | 'Android'
  status: 'runtime_verified' | 'static_complete'
  root: string
  previousRoots: string[]
  relocate?: boolean
  launcher: string
  launchers: string[]
  category: string
  summary: string
  description: string
  links: LinkedFile[]
  changes: GameProjectChanges
  existingStamp?: string
  existingId?: string
  problem: string
}
export interface GameProjectPreview {
  token: string
  source: string
  digest: string
  candidates: GameProjectCandidate[]
  excluded: number
}
export interface GameProjectImportResult {
  artworkUpdated?: number
  artworkReceipt?: string
  created: number
  updated: number
  unchanged: number
  items: Array<{ key: string; id: string; name: string; action: 'created' | 'updated' | 'unchanged' }>
}
export type GameArtworkRole = 'portrait' | 'wide'
export interface GameProjectArtwork {
  path: string
  sha256: string
  kind: string
  source: string
  page: string
  layout: string
  form: 'original' | 'adapted' | 'typography'
}
export interface GameArtworkDifference extends GameProjectArtwork {
  role: GameArtworkRole
  currentPath: string
  currentSha256: string
  state: 'new' | 'changed' | 'current' | 'recover' | 'track' | 'protected' | 'unavailable'
  detail: string
  previewUrl?: string
  currentPreviewUrl?: string
}
export type GameArtworkChoices = Record<string, GameArtworkRole[]>
export interface GameLinkState { path: string; exists: boolean; readable: boolean }
export interface GameLinkText { path: string; text: string; format: 'markdown' | 'text' }
