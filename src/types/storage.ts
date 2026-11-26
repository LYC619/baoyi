export type StorageCategory = 'database' | 'snapshots' | 'browser-cache' | 'site-data' | 'assets' | 'derived-cache' | 'other'
export interface StorageUsageItem { category: StorageCategory; label: string; bytes: number; files: number }
export interface StorageUsage { directory: string; totalBytes: number; files: number; measuredAt: number; items: StorageUsageItem[]; warnings: string[] }
export interface BrowserCacheClearResult { reclaimedBytes: number; warnings: string[]; usage: StorageUsage }
