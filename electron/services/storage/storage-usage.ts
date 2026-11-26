import fs from 'node:fs/promises'
import path from 'node:path'
import type { StorageCategory, StorageUsage, StorageUsageItem } from '../../../src/types/storage.ts'

export const BROWSER_CACHE_BUDGET = 64 * 1024 * 1024
const labels: Record<StorageCategory, string> = {
  database: '资料数据库', snapshots: '快照与恢复备份', 'browser-cache': '浏览缓存',
  'site-data': '登录与站点数据', assets: '附图与存档', 'derived-cache': '阅读索引与缩略图', other: '其他数据与渲染缓存'
}
function category(relative: string[]): StorageCategory {
  const parts = relative.map(part => part.toLowerCase()), first = parts[0]
  if (/^baoyi\.db(?:-wal|-shm)?$/.test(first)) return 'database'
  if (['library-snapshots', 'recovery', 'artwork-migrations', 'library-layout'].includes(first) || /^baoyi\.db\..*\.bak$/.test(first)) return 'snapshots'
  if (['icons', 'covers', 'posters', 'save-backups'].includes(first)) return 'assets'
  if (first === 'cache' && ['novel-index', 'document-covers'].includes(parts[1])) return 'derived-cache'
  const profile = first === 'partitions' ? parts.slice(2) : parts
  if (['cache', 'code cache'].includes(profile[0])) return 'browser-cache'
  if (first === 'partitions' || ['network', 'local storage', 'session storage', 'indexeddb', 'webstorage', 'service worker', 'pica-auth.bin'].includes(first)) return 'site-data'
  return 'other'
}

/** Reports only this profile. No library source directories are followed. */
export async function readStorageUsage(directory: string): Promise<StorageUsage> {
  const root = path.resolve(directory), warnings: string[] = []
  const items = new Map<StorageCategory, StorageUsageItem>(Object.entries(labels).map(([key, label]) => [key as StorageCategory, { category: key as StorageCategory, label, bytes: 0, files: 0 }]))
  const stack = [root]; let totalBytes = 0, files = 0, visited = 0
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('数据目录不是普通目录')
  while (stack.length) {
    const current = stack.pop()!
    if (++visited > 100000) { warnings.push('目录数量较多，本次统计未完成'); break }
    try {
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const file = path.join(current, entry.name), relative = path.relative(root, file)
        try {
          const info = await fs.lstat(file)
          if (info.isSymbolicLink()) { warnings.push('已跳过链接：' + relative); continue }
          if (info.isDirectory()) stack.push(file)
          else if (info.isFile()) {
            const item = items.get(category(relative.split(path.sep)))!
            item.bytes += info.size; item.files++; totalBytes += info.size; files++
          }
        } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('未能读取：' + relative) }
      }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('未能读取目录：' + path.relative(root, current)) }
  }
  return { directory: root, totalBytes, files, measuredAt: Date.now(), items: [...items.values()], warnings }
}

export interface BrowserCacheSession { clearCache(): Promise<void>; clearCodeCaches(options: { urls: string[] }): Promise<void> }
/** Deliberately has no storage/cookie deletion capability. Each failure is reported. */
export async function clearBrowserCacheSessions(profiles: { name: string; session: BrowserCacheSession }[]): Promise<string[]> {
  const warnings: string[] = []
  for (const profile of profiles) {
    try { await profile.session.clearCache() } catch { warnings.push(profile.name + '：网页缓存未清理完成') }
    try { await profile.session.clearCodeCaches({ urls: [] }) } catch { warnings.push(profile.name + '：代码缓存未清理完成') }
  }
  return warnings
}
