import type { SqlDb } from '../../../services/schema.ts'
import type { VideoDownloadJob } from '../../../../src/types/video-workflow.ts'
import path from 'node:path'

export const VIDEO_JOBS_SQL = `CREATE TABLE IF NOT EXISTS video_download_jobs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
);`

/** Only paths inside the proven collection move; source URLs and recovery journals stay unchanged. */
export function rebaseVideoJobDirectory(job: VideoDownloadJob, from: string, to: string, root: string): VideoDownloadJob {
  const move = (file: string) => {
    if (!file || !path.isAbsolute(file)) return file
    const relative = path.relative(from, file)
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? path.join(to, relative) : file
  }
  return { ...job, root, directory: move(job.directory), posterPath: move(job.posterPath),
    items: job.items.map(item => ({ ...item, path: move(item.path), ...(item.posterPath ? { posterPath: move(item.posterPath) } : {}) })) }
}

export function rebaseStoredVideoJobs(db: SqlDb, resourceId: string, from: string, to: string, root: string): void {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_download_jobs'").get()) return
  for (const row of db.prepare('SELECT id,payload FROM video_download_jobs').all() as Array<{ id: string; payload: string }>) {
    let job: VideoDownloadJob
    try { job = JSON.parse(row.payload) } catch { continue }
    if (job.resourceId !== resourceId || !Array.isArray(job.items)) continue
    db.prepare('UPDATE video_download_jobs SET payload = ? WHERE id = ?').run(JSON.stringify(rebaseVideoJobDirectory(job, from, to, root)), row.id)
  }
}

export function createVideoJobStore(db: SqlDb) {
  db.exec(VIDEO_JOBS_SQL)
  function list(): VideoDownloadJob[] {
    const rows = db.prepare('SELECT payload FROM video_download_jobs ORDER BY updated_at DESC').all() as Array<{ payload: string }>
    return rows.flatMap(row => {
      try { const job = JSON.parse(row.payload); return job?.id && Array.isArray(job.items) ? [job as VideoDownloadJob] : [] } catch { return [] }
    })
  }
  function save(job: VideoDownloadJob): void {
    db.prepare(`INSERT INTO video_download_jobs (id, status, updated_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload`).run(job.id, job.status, job.updatedAt, JSON.stringify(job))
  }
  function remove(id: string): void { db.prepare('DELETE FROM video_download_jobs WHERE id = ?').run(id) }
  function interrupt(): void {
    for (const job of list()) if (job.status === 'running' || job.status === 'queued') {
      job.status = 'interrupted'; job.updatedAt = Date.now(); job.message = '应用关闭前未完成，已保存的内容保留；可重试剩余项'
      for (const item of job.items) {
        if (item.transfer === 'running') item.transfer = 'pending'
        if (item.metadata === 'running') item.metadata = 'pending'
        if (item.registration === 'running') item.registration = 'pending'
      }
      save(job)
    }
  }
  return { list, save, remove, interrupt }
}
