import fs, { type FSWatcher } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ImageLibrary } from './library.ts'
import { scanImageImport } from './scanner.ts'
import { imageLibraryBusy } from './activity.ts'
import { assertImageFilesIdle } from './management.ts'
import type { SqlDb } from '../../services/storage/schema.ts'
import type { ImageType } from '../../../src/types/image.ts'

type Target = { id: string; path: string; type: ImageType; updated_at: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contains = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  )
}
const MAX_WATCHERS = 32

/** Follow registered works only; filesystem events never discover new works. */
export class ImageFolderSync {
  private getDb: () => SqlDb
  private changed: () => void
  private skip: (path: string) => boolean
  private scan: typeof scanImageImport
  private watchers = new Map<string, FSWatcher>()
  private watchRetry = new Map<string, number>()
  private targets = new Map<string, Target>()
  private offline = new Map<string, { retryAt: number; delay: number }>()
  private snapshots = new Map<string, string>()
  private archiveStats = new Map<string, string>()
  private candidates = new Map<string, string>()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private fullInterval: ReturnType<typeof setInterval> | undefined
  private fullPending = true
  private stopped = false
  private running = false
  private pending?: Promise<number>
  constructor(
    getDb: () => SqlDb,
    changed: () => void,
    skip: (path: string) => boolean = () => false,
    scan = scanImageImport
  ) {
    this.getDb = getDb
    this.changed = changed
    this.skip = skip
    this.scan = scan
  }
  start() {
    this.request(true)
    this.interval = setInterval(() => this.request(), 15000)
    this.interval.unref()
    this.fullInterval = setInterval(() => this.request(true), 30 * 60 * 1000)
    this.fullInterval.unref()
  }
  focus() {
    this.request()
  }
  request(full = false) {
    this.fullPending ||= full
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sync().catch((cause) => console.error('[图片目录同步]', cause))
    }, 1200)
    this.timer.unref()
  }
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.interval)
    clearInterval(this.fullInterval)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    return this.pending
  }
  sync(full = false): Promise<number> {
    this.fullPending ||= full
    if (this.stopped || this.running || imageLibraryBusy()) return Promise.resolve(0)
    return (this.pending = this.scanFolders())
  }
  private watchRoots(targets: Target[]) {
    // Share a storage parent; never widen a lone work to an entire drive.
    const roots: string[] = []
    const parents = [
      ...new Set(
        targets.map((target) => {
          const parent = path.dirname(target.path)
          return parent === path.parse(parent).root ? target.path : parent
        })
      )
    ].sort((a, b) => a.length - b.length)
    for (const root of parents)
      if (!roots.some((parent) => contains(parent, root))) roots.push(root)
    const selected = new Set(roots.slice(0, MAX_WATCHERS))
    for (const [root, watcher] of this.watchers)
      if (!selected.has(root)) {
        watcher.close()
        this.watchers.delete(root)
      }
    for (const root of this.watchRetry.keys()) if (!selected.has(root)) this.watchRetry.delete(root)
    for (const root of selected) {
      if (this.watchers.has(root) || (this.watchRetry.get(root) ?? 0) > Date.now()) continue
      const failed = (cause: unknown) => {
        this.watchers.get(root)?.close()
        this.watchers.delete(root)
        this.watchRetry.set(root, Date.now() + 60 * 1000)
        console.warn('[图片目录监听暂不可用]', root, cause)
      }
      try {
        const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
          const changed = filename ? path.resolve(root, String(filename)) : root
          let matched = false
          for (const target of this.targets.values())
            if (contains(target.path, changed) || contains(changed, target.path)) {
              this.dirty.add(target.id)
              this.offline.delete(target.id)
              matched = true
            }
          if (matched) this.request()
        })
        watcher.on('error', failed)
        watcher.unref()
        this.watchers.set(root, watcher)
      } catch (cause) {
        failed(cause)
      }
    }
  }
  private async scanFolders(): Promise<number> {
    this.running = true
    let updated = 0
    try {
      const db = this.getDb(),
        library = new ImageLibrary(db)
      const targets = db
        .prepare(
          `SELECT r.id,r.path,r.updated_at,m.item_type AS type FROM resource r JOIN image_meta m ON m.resource_id=r.id WHERE m.item_type IN ('photo','misc','comic') AND (m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))`
        )
        .all() as Target[]
      const active = new Map(targets.map((t) => [t.id, t.path]))
      for (const [id, target] of this.targets)
        if (active.get(id) !== target.path) {
          this.snapshots.delete(id)
          this.archiveStats.delete(id)
          this.candidates.delete(id)
          this.offline.delete(id)
        }
      this.targets = new Map(targets.map((target) => [target.id, target]))
      for (const map of [
        this.snapshots,
        this.candidates,
        this.archiveStats,
        this.dirty,
        this.offline
      ])
        for (const id of map.keys()) if (!active.has(id)) map.delete(id)
      this.watchRoots(targets)
      const all = this.fullPending
      this.fullPending = false
      for (const target of targets)
        if (all || !this.snapshots.has(target.id)) this.dirty.add(target.id)
      for (const target of targets) {
        if (this.stopped || imageLibraryBusy()) break
        if (!this.dirty.has(target.id) && !this.candidates.has(target.id)) continue
        if (!all && (this.offline.get(target.id)?.retryAt ?? 0) > Date.now()) continue
        if (this.skip(target.path)) continue
        try {
          assertImageFilesIdle(target.id)
        } catch {
          continue
        } // A file operation owns this resource; retry next tick.
        this.dirty.delete(target.id)
        try {
          const stat = await fsp.lstat(target.path)
          this.offline.delete(target.id)
          if (this.stopped) break
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
          const archive = stat.isFile() ? hash([target.path, stat.size, stat.mtimeMs]) : ''
          if (
            archive &&
            this.archiveStats.get(target.id) === archive &&
            !this.candidates.has(target.id)
          )
            continue
          const scan = (await this.scan(target.path, target.type, false))[0]
          // Incomplete traversals must never turn unreadable pages into missing pages.
          if (scan.warnings.some((w) => w !== '没有找到可导入的图片')) {
            this.candidates.delete(target.id)
            this.dirty.add(target.id)
            continue
          }
          const pages = scan.chapters.flatMap((c) => c.pages),
            stats = new Map<string, fs.Stats>()
          for (const page of pages)
            if (!stats.has(page.file)) stats.set(page.file, await fsp.stat(page.file))
          const fingerprint = hash([
            target.path,
            pages.map((p) => [p.file, p.entry, p.size, stats.get(p.file)!.mtimeMs])
          ])
          if (this.stopped || imageLibraryBusy()) {
            this.dirty.add(target.id)
            break
          }
          if (this.skip(target.path)) {
            this.dirty.add(target.id)
            continue
          }
          try {
            assertImageFilesIdle(target.id)
          } catch {
            this.dirty.add(target.id)
            continue
          }
          const current = library.get(target.id)
          if (!current || current.path !== target.path || current.updatedAt !== target.updated_at) {
            this.candidates.delete(target.id)
            this.dirty.add(target.id)
            continue
          }
          if (this.snapshots.get(target.id) === fingerprint) {
            this.candidates.delete(target.id)
            if (archive) this.archiveStats.set(target.id, archive)
            continue
          }
          if (!this.snapshots.has(target.id)) {
            const old = library.pages(target.id).map((p) => [p.file, p.entry, p.size]),
              newest = Math.max(0, ...[...stats.values()].map((s) => s.mtimeMs))
            if (
              hash(old) === hash(pages.map((p) => [p.file, p.entry, p.size])) &&
              newest <= target.updated_at
            ) {
              this.snapshots.set(target.id, fingerprint)
              if (archive) this.archiveStats.set(target.id, archive)
              continue
            }
          }
          if (this.candidates.get(target.id) !== fingerprint) {
            this.candidates.set(target.id, fingerprint)
            this.request()
            continue
          }
          library.register(scan)
          this.snapshots.set(target.id, fingerprint)
          if (archive) this.archiveStats.set(target.id, archive)
          this.candidates.delete(target.id)
          updated++
        } catch (cause) {
          this.dirty.add(target.id)
          const code = (cause as NodeJS.ErrnoException).code
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENODEV'].includes(code ?? '')) {
            const previous = this.offline.get(target.id)
            const delay = Math.min((previous?.delay ?? 30000) * 2, 30 * 60 * 1000)
            this.offline.set(target.id, { retryAt: Date.now() + delay, delay })
            this.candidates.delete(target.id)
            if (!previous) console.warn('[图片目录暂不可用，保留索引并延后重试]', target.path, code)
          } else console.error('[图片目录同步]', target.path, cause)
        }
      }
      if (updated && !this.stopped) this.changed()
      return updated
    } finally {
      this.running = false
    }
  }
}
