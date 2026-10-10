export type ImageType = 'photo' | 'comic'
export type ImageReadMode = 'single' | 'double' | 'scroll'
export interface ImagePreferences { mode: ImageReadMode; direction: 'ltr' | 'rtl'; fit: 'screen' | 'width' | 'original'; coverSingle?: boolean; zoom?: number }
export interface ImageReaderPreferences { preferences: Required<ImagePreferences>; customized: boolean }
export interface ImageBookmark { id: string; resourceId: string; pageId: string; ordinal: number; offset: number; label: string; missing: boolean; createdAt: number }
export interface ImageGroup { id: string; name: string; sortOrder: number; hidden: boolean }
export interface ImageCollection { id:string; name:string; members:string[] }
export interface ImageMoveResult { moved:number; paths:string[]; warnings:string[] }
export interface ImagePage { id: string; resourceId: string; chapterId: string | null; ordinal: number; size: number; missing: boolean }
export interface PhotoMetadata { takenAt?:string; camera?:string; lens?:string; exposure?:string; aperture?:string; iso?:number; focalLength?:string; orientation?:string }
export interface ImagePageInfo { width: number; height: number; format: string; size: number; photo?:PhotoMetadata }
export interface ImageAuditEntry {
  key: string; chapterId: string; sourcePageId: string; pageId: string; title: string; ordinal: number;
  status: 'ok' | 'missing' | 'damaged' | 'unverified'; reason: string; repairable: boolean; info?: ImagePageInfo;
}
export interface ImageAudit {
  resourceId: string; checkedAt: number; total: number; ok: number; missing: number; damaged: number;
  unverified: number; catalogComplete: boolean; entries: ImageAuditEntry[];
}
export interface ImageChapter { id: string; title: string; ordinal: number; pageCount: number; sourceId: string }
export interface ImageProgress { pageId: string; chapterId: string | null; ordinal: number; offset: number; updatedAt: number }
export interface ImageItem {
  collectionId?: string; collectionName?: string; collectionOrder?: number;
  id: string; type: ImageType; path: string; sourceDir: string; name: string; description: string; tags: string[]; groupId: string | null;
  favorite: boolean; read: boolean; publication: 'unknown' | 'ongoing' | 'completed'; coverPageId: string; pageCount: number;
  chapterCount: number; chapters: ImageChapter[]; progress: ImageProgress | null; updatedAt: number; source: string; sourceId: string;
}
export interface ImageQuery { type?: ImageType; search?: string; groupId?: string; uncategorized?:boolean; tag?: string; sourceDir?: string; favorite?: boolean; read?: boolean; publication?: string; sort?: 'updated' | 'name' | 'read' }
export interface ImageBulkPatch { groupId?: string | null; read?: boolean; tags?: { mode: 'add' | 'remove' | 'replace'; values: string[] } }
export interface ImagePatch { name?: string; description?: string; tags?: string[]; groupId?: string | null; favorite?: boolean; read?: boolean; publication?: ImageItem['publication']; coverPageId?: string }
export interface ScannedImagePage { file: string; entry: string; size: number }
export interface ScannedImageChapter { key: string; title: string; sourceId?: string; pages: ScannedImagePage[] }
export interface ScannedImage {
  path: string; type: ImageType; name: string; sourceDir: string; chapters: ScannedImageChapter[]; warnings: string[];
  source?: string; sourceId?: string; description?: string; tags?: string[]; publication?: ImageItem['publication'];
}
export interface ImageImportPreview { token: string; items: Array<{ index: number; path: string; name: string; pages: number; chapters: number; warnings: string[] }> }
export type ImageSourceRank = 'H24' | 'D7' | 'D30'
export type ImageSourceSort = 'dd' | 'da'
export interface ImageSourceWork { id: string; title: string; author: string; description: string; tags: string[]; chapters: number; pages: number; finished: boolean; coverUrl?: string }
export interface ImageSourceChapter { id: string; title: string; order: number }
export interface ImageSourcePage { id: string; url: string }
/** 哔咔浏览界面的本地标注：哪些作品已入库、哪些正在下载、已入库作品本地已有哪些章。 */
export interface ImageSourceOwned { owned: string[]; queued: string[]; chapters: Record<string, string[]> }
export interface ImageChapterUpdate extends ImageSourceChapter {
  status: 'new' | 'downloaded' | 'incomplete' | 'unverified' | 'unavailable';
  localTitle: string; localPages: number; expectedPages: number | null;
}
export interface ImageUpdateCheck {
  resourceId: string; checkedAt: number; sourceTitle: string; sourcePublication: 'ongoing' | 'completed';
  chapters: ImageChapterUpdate[];
}
export type ImageTransferPhase = 'connecting' | 'receiving' | 'retrying' | 'rate-limited'
export interface ImageTransferEvent { phase: ImageTransferPhase; bytes?: number; waitMs?: number }
export interface ImageDownloadProgress {
  phase: ImageTransferPhase | 'queued' | 'catalog' | 'checking' | 'saving' | 'importing' | 'idle';
  totalKnown: boolean; catalogChapters: number; chapterIndex: number; chapterProcessed: number; chapterTotal: number;
  reusedPages: number; storedBytes: number; receivedBytes: number; bytesPerSecond: number; retryAt: number;
  effectiveConcurrency: number;
}
export interface ImageDownloadOptions { concurrency: number; jobConcurrency?: number }
export interface ImageBatchDownloadResult { enqueued: number; skipped: number; errors: string[] }
export interface ImageDownloadJob {
  id: string; work: ImageSourceWork; chapters: ImageSourceChapter[]; root: string; groupId: string | null;
  status: 'queued' | 'running' | 'paused' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  processed: number; total: number; completedChapters: number; current: string; error: string; updatedAt: number; resourceId: string;
  progress?: ImageDownloadProgress;
  queueOrder?: number; queuePosition?: number;
  retryNotBefore?: number;
  repairPages?: Record<string, string[]>;
}
export interface ImageApi {
  list(query?: ImageQuery): Promise<ImageItem[]>; get(id: string): Promise<ImageItem | null>;
  pages(id: string, chapterId?: string): Promise<ImagePage[]>;
  pageInfo(pageId: string): Promise<ImagePageInfo>; audit(id: string): Promise<ImageAudit>;
  repair(id: string): Promise<ImageDownloadJob | null>;
  checkUpdates(id: string): Promise<ImageUpdateCheck>;
  downloadUpdates(id: string, chapters: string[]): Promise<ImageDownloadJob>;
  saveChapter(id: string, chapterId: string, title: string, move: number): Promise<void>;
  update(id: string, patch: ImagePatch): Promise<ImageItem>; remove(id: string, deleteFiles?:boolean): Promise<boolean | void>;
  collections():Promise<ImageCollection[]>; saveCollection(name:string,members:string[],id?:string):Promise<ImageCollection>; removeCollection(id:string):Promise<void>;
  move(ids:string[],byCategory?:boolean):Promise<ImageMoveResult|null>;
  bulkUpdate(ids: string[], patch: ImageBulkPatch): Promise<number>;
  groups(): Promise<ImageGroup[]>; saveGroup(group: Partial<ImageGroup> & { name: string }): Promise<ImageGroup>; removeGroup(id: string): Promise<void>;
  prepareImport(type: ImageType, multiple: boolean, archive: boolean): Promise<ImageImportPreview | null>;
  confirmImport(token: string, selected: Array<{ index: number; name: string }>): Promise<{ imported: number; errors: string[] }>;
  rescan(id: string): Promise<ImageItem>; relocate(id: string): Promise<ImageItem | null>; reveal(id: string): Promise<boolean>;
  saveProgress(id: string, pageId: string, offset: number): Promise<void>;
  preferences(value?: ImagePreferences): Promise<ImagePreferences>;
  readerPreferences(id: string, value?: ImagePreferences | null): Promise<ImageReaderPreferences>;
  bookmarks(id: string): Promise<ImageBookmark[]>;
  saveBookmark(id: string, pageId: string, offset: number, label?: string): Promise<ImageBookmark>;
  removeBookmark(id: string, bookmarkId: string): Promise<void>;
  sourceStatus(): Promise<boolean>; sourceLogin(account: string, password: string): Promise<void>; sourceLogout(): Promise<void>;
  sourceSearch(query: string, page: number): Promise<{ items: ImageSourceWork[]; pages: number }>;
  sourceFavorites(page: number, sort: ImageSourceSort): Promise<{ items: ImageSourceWork[]; pages: number }>;
  sourceRanking(period: ImageSourceRank): Promise<{ items: ImageSourceWork[]; pages: number }>;
  sourceCover(url: string): Promise<string>;
  sourceDetail(id: string): Promise<{ work: ImageSourceWork; chapters: ImageSourceChapter[] }>;
  sourceOwned(workIds: string[]): Promise<ImageSourceOwned>;
  download(workId: string, chapters: string[], groupId: string | null): Promise<ImageDownloadJob | null>;
  downloadBatch(workIds: string[], groupId: string | null): Promise<ImageBatchDownloadResult | null>;
  jobs(): Promise<ImageDownloadJob[]>; retryJob(id: string): Promise<void>; cancelJob(id: string): Promise<void>; dismissJob(id: string): Promise<void>;
  pauseJob(id: string): Promise<void>; resumeJob(id: string): Promise<void>;
  moveJob(id: string, direction: 'up' | 'down'): Promise<void>;
  downloadOptions(value?: ImageDownloadOptions): Promise<ImageDownloadOptions>;
  onChanged(callback: () => void): () => void;
  onJobsChanged(callback: () => void): () => void;
}
