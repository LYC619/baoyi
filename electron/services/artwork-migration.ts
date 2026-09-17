/**
 * 一次性迁移：把缓存目录里的海报搬进各自的作品目录（用户 9-18 拍板：所有图最终都进视频库）。
 *
 * 复用 poster-storage 那套机制（复制 → 校验哈希 → 写恢复映射 → 改库里引用 → 删旧文件），
 * 区别是目标不是一个固定目录，而是**按作品算**：每条缓存引用 → `artworkDirFor()`。
 * 目录里已经有同哈希的文件就直接改指向，不再复制。算不出目录的作品（库里只有链接）留在缓存。
 *
 * 来源同时认 `%APPDATA%\抱一\posters` 和项目下的 `data/posters`（0.8 开发期那一版的位置），
 * 用户没启动过把缓存搬回 userData 的那一版也不要紧。
 *
 * 无引用的缓存文件：按 sha256 在扫描目录下所有 `.baoyi/artwork` 里找同内容，找到的删；
 * 找不到的**不删**，只报数（计划 §D.2：默认留着交给用户）。
 *
 * 恢复映射写到 `%APPDATA%\抱一\artwork-migrations/<hash>/`，每次改引用另存一份变更记录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlDb } from './schema.ts'
import { cells, imageHash, keyPath, visit, writeJson, type Cell } from './poster-storage.ts'
import { isPosterExt } from '../kinds/video/posters.ts'
import { artworkDirFor, insideArtworkDir } from '../kinds/video/artwork-dir.ts'

export interface ArtworkMigrationResult {
  /** 搬进作品目录的引用数 */
  moved: number
  /** 目录里已有同内容、只改了指向的引用数 */
  relinked: number
  /** 改过的库单元格数 */
  updated: number
  /** 删掉的缓存文件数（已搬走的 + 无引用但在视频库里找到同内容的） */
  removed: number
  /** 算不出作品目录、留在缓存里的引用数 */
  keptInCache: number
  /** 无引用且视频库里没有同内容、留着交给用户的缓存文件数 */
  orphans: number
  warnings: string[]
}

interface Mapping { from: string; to: string; sha256: string; resourceId: string }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
function statOrNull(file: string): fs.Stats | null { try { return fs.lstatSync(file) } catch { return null } }
function isDirectory(file: string): boolean { try { return fs.statSync(file).isDirectory() } catch { return false } }

/** 一个单元格属于哪部作品。episode / video_assets 记的是 resource_id，video_meta 的 key 就是它 */
function ownerOf(db: SqlDb, cell: Cell): string {
  if (cell.table === 'video_meta') return String(cell.id)
  if (cell.table === 'resource') return String(cell.id)
  if (cell.table === 'episode' || cell.table === 'video_assets') {
    const row = db.prepare(`SELECT resource_id FROM ${cell.table} WHERE id = ?`).get(cell.id) as { resource_id: string } | undefined
    return row?.resource_id || ''
  }
  return ''
}

/** 扫描目录下所有 .baoyi/artwork 里的文件，按 sha256 建索引（只用来认无引用缓存文件的同内容副本） */
function indexLibraryArtwork(roots: string[]): Map<string, string> {
  const index = new Map<string, string>()
  let visited = 0
  const walk = (directory: string, depth: number) => {
    if (depth > 8 || ++visited > 20000 || !isDirectory(directory)) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === '.baoyi') {
          const art = path.join(full, 'artwork')
          if (isDirectory(art)) for (const image of fs.readdirSync(art)) {
            const file = path.join(art, image)
            if (isPosterExt(file) && statOrNull(file)?.isFile()) { try { index.set(imageHash(file), file) } catch { /* 读不了就不算 */ } }
          }
        } else if (!entry.name.startsWith('.')) walk(full, depth + 1)
      }
    }
  }
  for (const root of roots) walk(path.resolve(root), 0)
  return index
}

export function migrateArtworkIntoLibrary(db: SqlDb, options: {
  cacheDirs: string[]
  fallbackDir: string
  recoveryRoot: string
  scanRoots: string[]
}): ArtworkMigrationResult {
  const result: ArtworkMigrationResult = { moved: 0, relinked: 0, updated: 0, removed: 0, keptInCache: 0, orphans: 0, warnings: [] }
  const caches = [...new Set(options.cacheDirs.filter(dir => isDirectory(dir)).map(dir => path.resolve(dir)))]
  if (!caches.length) return result
  const inCache = (file: string) => path.isAbsolute(file) && caches.some(dir => keyPath(path.dirname(file)) === keyPath(dir)) && isPosterExt(file)
  const fallback = path.resolve(options.fallbackDir)

  // 1. 收集库里指向缓存目录的引用，按作品算目标
  const values = cells(db)
  const mappings = new Map<string, Mapping>()
  const referenced = new Set<string>()
  for (const cell of values) visit(cell.value, value => {
    if (!inCache(value)) return value
    referenced.add(keyPath(value))
    if (mappings.has(keyPath(value))) return value
    const resourceId = ownerOf(db, cell)
    if (!resourceId) return value
    let target: string
    try { target = artworkDirFor(db, resourceId, () => fallback) } catch (cause) { result.warnings.push('算不出作品目录：' + value + '（' + errorText(cause) + '）'); return value }
    if (keyPath(target) === keyPath(fallback) || caches.some(dir => keyPath(target) === keyPath(dir))) { result.keptInCache++; return value }
    const info = statOrNull(value)
    if (!info?.isFile() || info.isSymbolicLink()) return value
    let digest: string
    try { digest = imageHash(value) } catch (cause) { result.warnings.push('读不了缓存图：' + value + '（' + errorText(cause) + '）'); return value }
    const to = path.join(target, digest.slice(0, 24) + path.extname(value).toLowerCase())
    mappings.set(keyPath(value), { from: path.resolve(value), to, sha256: digest, resourceId })
    return value
  })

  // 2. 复制（目录里已有同哈希文件就跳过复制）并校验
  const ready = new Map<string, Mapping>()
  for (const [key, mapping] of mappings) {
    try {
      fs.mkdirSync(path.dirname(mapping.to), { recursive: true })
      const existing = statOrNull(mapping.to)
      if (existing?.isFile()) {
        if (imageHash(mapping.to) !== mapping.sha256) throw new Error('目标已有另一张同名图，保留缓存副本')
        result.relinked++
      } else {
        fs.copyFileSync(mapping.from, mapping.to, fs.constants.COPYFILE_EXCL)
        if (imageHash(mapping.to) !== mapping.sha256) { fs.rmSync(mapping.to, { force: true }); throw new Error('复制校验失败，保留缓存副本') }
        result.moved++
      }
      ready.set(key, mapping)
    } catch (cause) { result.warnings.push('图片尚未迁移：' + mapping.from + '（' + errorText(cause) + '）') }
  }

  // 3. 写恢复映射，再改库里的引用（savepoint 内，任一条落空整体回滚）
  const recovery = path.join(options.recoveryRoot, 'artwork-migrations', 'into-library')
  if (ready.size) {
    writeJson(path.join(recovery, Date.now() + '-' + randomUUID() + '.json'), { version: 1, kind: 'into-library', mappings: [...ready.values()] })
    const changes: Array<Cell & { after: unknown }> = []
    for (const cell of values) {
      const after = visit(cell.value, file => path.isAbsolute(file) ? ready.get(keyPath(file))?.to || file : file)
      if (after !== cell.value) changes.push({ ...cell, after })
    }
    const savepoint = 'artwork_into_library_' + randomUUID().replaceAll('-', '')
    db.exec('SAVEPOINT ' + savepoint)
    try {
      for (const change of changes) {
        const outcome = db.prepare(`UPDATE ${change.table} SET ${change.column} = ? WHERE ${change.key} = ? AND ${change.column} IS ?`).run(change.after, change.id, change.value)
        if (Number(outcome.changes) !== 1) throw new Error('图片资料在迁移期间变化，已保留缓存副本')
      }
      db.exec('RELEASE SAVEPOINT ' + savepoint); result.updated = changes.length
    } catch (cause) {
      db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); db.exec('RELEASE SAVEPOINT ' + savepoint)
      result.warnings.push('库引用未改：' + errorText(cause))
      return result
    }
    // 4. 引用改完、新文件校验过，删缓存里的原件
    for (const mapping of ready.values()) {
      try {
        if (imageHash(mapping.to) !== mapping.sha256) throw new Error('目标内容变化')
        fs.unlinkSync(mapping.from); result.removed++
      } catch (cause) { result.warnings.push('旧缓存图尚未清理：' + mapping.from + '（' + errorText(cause) + '）') }
    }
  }

  // 5. 无引用的缓存文件：视频库里有同内容的删掉，其余留着报数
  let index: Map<string, string> | null = null
  for (const dir of caches) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (!isPosterExt(file) || referenced.has(keyPath(file)) || !statOrNull(file)?.isFile()) continue
      try {
        index ??= indexLibraryArtwork(options.scanRoots)
        const twin = index.get(imageHash(file))
        if (twin && insideArtworkDir(twin) && statOrNull(twin)?.isFile()) { fs.unlinkSync(file); result.removed++ }
        else result.orphans++
      } catch { result.orphans++ }
    }
  }
  return result
}
