export type ImageType = 'photo' | 'comic'
export type ImageReadMode = 'single' | 'double' | 'scroll'
export interface ImagePreferences { mode: ImageReadMode; direction: 'ltr' | 'rtl'; fit: 'screen' | 'width' | 'original' }
export interface ImageGroup { id: string; name: string; sortOrder: number; hidden: boolean }
export interface ImagePage { id: string; resourceId: string; chapterId: string | null; ordinal: number; size: number; missing: boolean }
export interface ImageChapter { id: string; title: string; ordinal: number; pageCount: number; sourceId: string }
export interface ImageProgress { pageId: string; chapterId: string | null; ordinal: number; offset: number; updatedAt: number }
export interface ImageItem {
  id: string; type: ImageType; path: string; sourceDir: string; name: string; description: string; tags: string[]; groupId: string | null;
  favorite: boolean; publication: 'unknown' | 'ongoing' | 'completed'; coverPageId: string; pageCount: number;
  chapterCount: number; chapters: ImageChapter[]; progress: ImageProgress | null; updatedAt: number; source: string; sourceId: string;
}
export interface ImageQuery { type?: ImageType; search?: string; groupId?: string; tag?: string; sourceDir?: string; favorite?: boolean; publication?: string; sort?: 'updated' | 'name' | 'read' }
export interface ImagePatch { name?: string; description?: string; tags?: string[]; groupId?: string | null; favorite?: boolean; publication?: ImageItem['publication']; coverPageId?: string }
export interface ScannedImagePage { file: string; entry: string; size: number }
export interface ScannedImageChapter { key: string; title: string; sourceId?: string; pages: ScannedImagePage[] }
export interface ScannedImage {
  path: string; type: ImageType; name: string; sourceDir: string; chapters: ScannedImageChapter[]; warnings: string[];
  source?: string; sourceId?: string; description?: string; tags?: string[]; publication?: ImageItem['publication'];
}
export interface ImageImportPreview { token: string; items: Array<{ index: number; path: string; name: string; pages: number; chapters: number; warnings: string[] }> }
export interface ImageSourceWork { id: string; title: string; author: string; description: string; tags: string[]; chapters: number; pages: number; finished: boolean }
export interface ImageSourceChapter { id: string; title: string; order: number }
export interface ImageSourcePage { id: string; url: string }
export interface ImageDownloadJob {
  id: string; work: ImageSourceWork; chapters: ImageSourceChapter[]; root: string; groupId: string | null;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  processed: number; total: number; completedChapters: number; current: string; error: string; updatedAt: number; resourceId: string;
}
export interface ImageApi {
  list(query?: ImageQuery): Promise<ImageItem[]>; get(id: string): Promise<ImageItem | null>;
  pages(id: string, chapterId?: string): Promise<ImagePage[]>;
  saveChapter(id: string, chapterId: string, title: string, move: number): Promise<void>;
  update(id: string, patch: ImagePatch): Promise<ImageItem>; remove(id: string): Promise<void>;
  groups(): Promise<ImageGroup[]>; saveGroup(group: Partial<ImageGroup> & { name: string }): Promise<ImageGroup>; removeGroup(id: string): Promise<void>;
  prepareImport(type: ImageType, multiple: boolean, archive: boolean): Promise<ImageImportPreview | null>;
  confirmImport(token: string, selected: Array<{ index: number; name: string }>): Promise<{ imported: number; errors: string[] }>;
  rescan(id: string): Promise<ImageItem>; relocate(id: string): Promise<ImageItem | null>;
  saveProgress(id: string, pageId: string, offset: number): Promise<void>;
  preferences(value?: ImagePreferences): Promise<ImagePreferences>;
  sourceStatus(): Promise<boolean>; sourceLogin(account: string, password: string): Promise<void>; sourceLogout(): Promise<void>;
  sourceSearch(query: string, page: number): Promise<{ items: ImageSourceWork[]; pages: number }>;
  sourceDetail(id: string): Promise<{ work: ImageSourceWork; chapters: ImageSourceChapter[] }>;
  download(workId: string, chapters: string[], groupId: string | null): Promise<ImageDownloadJob | null>;
  jobs(): Promise<ImageDownloadJob[]>; retryJob(id: string): Promise<void>; cancelJob(id: string): Promise<void>; dismissJob(id: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}
