/**
 * Optional, main-process-only extension contract. No provider is installed or
 * enabled by this file. These types are not a public HTTP or renderer IPC API.
 */
export type VideoResolverConfig =
  | { enabled: false }
  | { enabled: true; adapterId: string; baseUrl: string; credentialId?: string }

export interface VideoResolverContext {
  config: Extract<VideoResolverConfig, { enabled: true }>
  /** In-memory service credential; never included in catalogue, jobs or logs. */
  credential?: string
  /** Aborts this request; remote job cancellation is a separate capability. */
  signal: AbortSignal
}

export interface VideoResolverFormat {
  /** Opaque service format selection, not a media URL or executable expression. */
  id: string
  label: string
}

export interface VideoResolverVideo {
  /** Stable site + video identity, independent of service host or signed URLs. */
  site: string
  id: string
  pageUrl: string
  title: string
  description?: string
  coverUrl?: string
  formats: VideoResolverFormat[]
}

export interface VideoResolverFile {
  /** Complete video with its available audio already combined by the service. */
  url: string
  extension: string
  /** Unix time in milliseconds, when supplied by the service. */
  expiresAt?: number
  /** Transient, target-scoped transport headers. Never persist or send via IPC. */
  requestHeaders?: Readonly<Record<string, string>>
}

export type VideoResolverPreparation =
  | { state: 'pending'; jobId: string; retryAfterMs?: number }
  | { state: 'ready'; file: VideoResolverFile }
  | { state: 'failed'; code: string; message: string }

export interface VideoResolverAdapter {
  id: string
  /** Metadata only. Browsing must not silently start a media download. */
  resolve(pageUrl: string, context: VideoResolverContext): Promise<VideoResolverVideo>
  /** Called only after the user chooses to save a video. May start remote work. */
  prepare(selection: { pageUrl: string; formatId: string }, context: VideoResolverContext): Promise<VideoResolverPreparation>
  /** Present only for services with asynchronous jobs. */
  poll?: (jobId: string, context: VideoResolverContext) => Promise<VideoResolverPreparation>
  /** Omission means the client cannot promise to stop server-side work. */
  cancel?: (jobId: string, context: VideoResolverContext) => Promise<void>
}
