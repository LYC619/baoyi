export interface VideoRemovalRequest { resourceIds: string[]; episodeId?: string; action: 'remove' | 'detach'; deleteLocal: boolean }
export interface VideoRemovalPreview {
  fingerprint: string; request: VideoRemovalRequest; titles: string[]; episodeCount: number
  files: Array<{ path: string; size: number; present: boolean; shared: boolean }>
}
export interface VideoBulkPatch { collection?: string; addTags?: string[]; removeTags?: string[] }
