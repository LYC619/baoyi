import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoDirectoryChange } from '../../../src/types/video-workflow.ts'
import { getVideo, updateVideo } from './db.ts'
import { atomicWrite, safeWorkFolderName } from './bundle.ts'
import { locateVideoWorkDirectory, persistVideoWorkBundle, syncVideoWorkFiles } from './local-sync.ts'
import { promoteDownloadDirectory } from './download/placement.ts'
import { videoPathKey } from './local-files.ts'

export function previewVideoCollectionName(d: SqlDb, resourceId: string, title: string, roots: string[] = []) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240) throw new Error('请输入 1–240 字的合集名称')
  const from = locateVideoWorkDirectory(d, resourceId, roots)
  if (videoPathKey(from) === videoPathKey(path.parse(from).root) || roots.some(root => videoPathKey(root) === videoPathKey(from))) throw new Error('影视库根目录不能作为单个合集更名')
  const to = path.join(path.dirname(from), safeWorkFolderName(title))
  if (videoPathKey(from) !== videoPathKey(to) && fs.existsSync(to)) throw new Error('目标目录已存在，请换一个名称；现有文件已保留')
  return { title: title.trim(), from, to }
}

/** Explicit collection rename, with a local recovery record and atomic database updates. */
export function renameVideoCollection(d: SqlDb, resourceId: string, title: string, roots: string[] = []) {
  const proposed = previewVideoCollectionName(d, resourceId, title, roots)
  if (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_download_jobs'").get()) {
    const active = (d.prepare('SELECT payload FROM video_download_jobs').all() as Array<{ payload: string }>).some(row => {
      const job = JSON.parse(row.payload)
      return job.resourceId === resourceId && ['running', 'queued'].includes(job.status)
    })
    if (active) throw new Error('请等当前合集下载结束后再更名')
  }
  syncVideoWorkFiles(d, resourceId, { roots, persist: false })
  const change: VideoDirectoryChange = { from: proposed.from, to: proposed.to }
  const recordName = '.baoyi-rename-' + createHash('sha256').update(resourceId).digest('hex').slice(0, 12) + '.json'
  const persist = () => atomicWrite(path.join(fs.existsSync(change.from) ? change.from : change.to, recordName),
    JSON.stringify({ kind: 'collection-rename', resourceId, title: proposed.title, previousTitle: getVideo(d, resourceId)?.name_zh, change }, null, 2))
  d.exec('SAVEPOINT rename_video_collection')
  try {
    if (videoPathKey(change.from) !== videoPathKey(change.to)) promoteDownloadDirectory(d, resourceId, change, persist)
    updateVideo(d, resourceId, { name_zh: proposed.title })
    d.exec('RELEASE SAVEPOINT rename_video_collection')
  } catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT rename_video_collection'); d.exec('RELEASE SAVEPOINT rename_video_collection')
    if (change.applied && !fs.existsSync(change.from) && path.dirname(change.from) === path.dirname(change.to)) {
      const target = fs.lstatSync(change.to)
      if (target.ino === change.identity?.ino && target.dev === change.identity.dev) fs.renameSync(change.to, change.from)
    }
    throw error
  }
  const warnings: string[] = []
  try { warnings.push(...persistVideoWorkBundle(d, resourceId, proposed.to).warnings) }
  catch (error) { warnings.push('更名已完成，本地资料待保存：' + String(error)) }
  return { ...proposed, warnings }
}
