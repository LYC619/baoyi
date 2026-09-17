import { readVideoLocalMetadata } from './local-metadata.ts'
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoBundle, VideoDirectory, VideoSourceRef } from '../../../src/types/video-library.ts'
import type {
  VideoOrganizeApplyRequest, VideoOrganizeCollision, VideoOrganizeEpisode, VideoOrganizeFile,
  VideoOrganizeFileResult, VideoOrganizeJournal, VideoOrganizePreview, VideoOrganizeRequest,
  VideoOrganizeWork, VideoRelocateApplyRequest, VideoRelocatePreview, VideoRelocateRequest
} from '../../../src/types/video-organize.ts'
import { atomicWrite, readVideoBundle, resolveBundlePath, safeWorkFolderName, writeVideoEpisodeSidecars } from './bundle.ts'
import { ensureBundleId } from './identity.ts'
import { upsertVideoDirectory } from './library.ts'
import { resolveVideoOrganizeOwner } from './organize-owner.ts'
import { cleanEpisodeTitle } from './episode-identity.ts'
import { seriesPart as numberedEpisode } from '../../../src/utils/video-series.ts'
import { referencedVideoFiles, videoFileKey } from './file-references.ts'

export { resolveVideoOrganizeOwner } from './organize-owner.ts'

// No getDb(), configuration access, startup recovery, or filesystem mutation in either preview.
type Row = Record<string, any>
type Table = 'resource' | 'video_meta' | 'episode' | 'video_sources' | 'video_assets' | 'video_episode_assets' | 'video_directories'
type Snapshot = Record<Table, Row[]>
const tables: Table[] = ['resource', 'video_meta', 'episode', 'video_sources', 'video_assets', 'video_episode_assets', 'video_directories']
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
const keyPath = (input: string) => path.resolve(input).normalize('NFC').toLowerCase()
const samePath = (a: string, b: string) => !!a && !!b && keyPath(a) === keyPath(b)
const textError = (error: unknown) => error instanceof Error ? error.message : String(error)
const stableId = (kind: string, value: string) => `organize-${kind}-${hash(value).slice(0, 32)}`
const stagingPath = (directory: string, identity: string) => path.join(directory, `.baoyi-organize-${hash(identity).slice(0, 24)}.part`)
const bundleUuid = (value: string) => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}` }
const locks = new WeakMap<SqlDb, Set<string>>()

interface Change {
  table: Table
  key: Row
  before: Row | null
  after: Row
  undone?: boolean
  pathMap?: { field: string; from: string; to: string }
  originId?: string
}
interface Identity { dev: number; ino: number; size: number; mtimeMs: number }
interface FileResult extends VideoOrganizeFileResult {
  stage?: string
  stageIdentity?: Identity
  targetIdentity?: Identity
  sourceIdentity?: Identity
}
interface Journal extends Omit<VideoOrganizeJournal, 'files' | 'canRetry' | 'canRollback'> {
  version: 1
  preview: VideoOrganizePreview | VideoRelocatePreview
  snapshot: Snapshot
  files: FileResult[]
  changes: Change[]
  logicalApplied: boolean
  bound: boolean
  manifest: { before: string | null; beforeHash: string; afterHash: string; pendingHash?: string }
}
interface Prepared {
  preview: VideoOrganizePreview
  snapshot: Snapshot
  assets: Row[]
  episodes: Row[]
  links: Row[]
}

function all(d: SqlDb, sql: string, ...args: unknown[]): Row[] { return d.prepare(sql).all(...args) as Row[] }
function one(d: SqlDb, sql: string, ...args: unknown[]): Row | undefined { return d.prepare(sql).get(...args) as Row | undefined }
function jsonArray(value: unknown): Row[] {
  if (!value) return []
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new Error('历史资源列表格式无效，请先修复该条资料')
  return parsed
}
function rowKey(table: Table, row: Row): Row {
  if (table === 'video_meta' || table === 'video_directories') return { resource_id: row.resource_id }
  if (table === 'video_episode_assets') return { episode_id: row.episode_id, asset_id: row.asset_id }
  return { id: row.id }
}
function getRow(d: SqlDb, table: Table, key: Row): Row | undefined {
  return one(d, `SELECT * FROM ${table} WHERE ${Object.keys(key).map(k => `${k} IS ?`).join(' AND ')}`, ...Object.values(key))
}
function snapshot(d: SqlDb, ids: string[]): Snapshot {
  const marks = ids.map(() => '?').join(',')
  const result = {} as Snapshot
  for (const table of tables) {
    if (table === 'video_episode_assets') result[table] = all(d, `SELECT ea.* FROM video_episode_assets ea JOIN episode e ON e.id = ea.episode_id WHERE e.resource_id IN (${marks}) ORDER BY ea.episode_id, ea.asset_id`, ...ids)
    else result[table] = all(d, `SELECT * FROM ${table} WHERE ${table === 'resource' ? 'id' : 'resource_id'} IN (${marks}) ORDER BY ${table === 'video_meta' || table === 'video_directories' ? 'resource_id' : 'id'}`, ...ids)
  }
  return result
}
function confirmationSnapshot(snap: Snapshot): Snapshot {
  // A list refresh checks every asset again. Its observation time is not a change to the reviewed files or metadata.
  return { ...snap, video_assets: snap.video_assets.map(row => { const value = { ...row }; delete value.checked_at; return value }) }
}
function directoryRow(row?: Row): VideoDirectory | null {
  return row ? { resourceId: row.resource_id, bundleId: row.bundle_id, root: row.root, relativePath: row.relative_path, path: row.directory_path, metadataState: row.metadata_state } : null
}
function identity(stat: fs.Stats): Identity { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } }
// On Windows Node can report dev=0 for lstat, but a volume serial for the same open file.
function sameDevice(a: Identity, b: Identity): boolean { return a.dev === b.dev || process.platform === 'win32' && (a.dev === 0 || b.dev === 0) }
function sameIdentity(a: Identity, b: Identity): boolean { return sameDevice(a, b) && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs }
function sameInode(a: Identity, b: Identity): boolean { return sameDevice(a, b) && a.ino === b.ino && a.ino !== 0 }
function inspectFile(file: string): { state: VideoOrganizeFile['state']; size: number; stamp: Identity | null } {
  try {
    const stat = fs.lstatSync(file)
    return { state: stat.isFile() && !stat.isSymbolicLink() ? 'present' : 'missing', size: stat.size, stamp: identity(stat) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { state: code === 'EACCES' || code === 'EPERM' || !fs.existsSync(path.parse(file).root) ? 'offline' : 'missing', size: 0, stamp: null }
  }
}
function absolute(input: string): string {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input) || /^\\\\[?.]\\/.test(input)) throw new Error('必须选择实际的绝对路径')
  return path.resolve(input)
}
function inside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(root, target)
  return (allowRoot || !!relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function safeComponents(relative: string): void {
  for (const component of relative.split(/[\\/]/)) {
    if (!component || component === '.' || component === '..' || /[<>:"|?*\x00-\x1f]/.test(component) || /[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw new Error('目标路径包含无效名称或目录穿越')
  }
}
/** Check both lexical and actual ancestry. Never create a missing library root (offline disks). */
function checkDestination(root: string, target: string): void {
  root = absolute(root); target = absolute(target)
  if (!inside(root, target)) throw new Error('目标必须位于所选根目录内')
  safeComponents(path.relative(root, target))
  if (target.length > 240) throw new Error('目标路径过长，请选择更短的目录或文件名')
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('根目录不可用或为目录链接')
  const realRoot = fs.realpathSync(root)
  let current = root
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part)
    try {
      const st = fs.lstatSync(current)
      if (st.isSymbolicLink() || !inside(realRoot, fs.realpathSync(current), true)) throw new Error('目标路径通过链接指向其他目录')
      if (current !== target && !st.isDirectory()) throw new Error('目标的上级路径不是目录')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
function actualKey(directory: string): string {
  try { return keyPath(fs.realpathSync(directory)) } catch { return keyPath(directory) }
}
function manifestText(directory: string): string | null {
  const file = path.join(directory, 'baoyi.json')
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('资源清单不是有效普通文件或超过大小上限')
  return fs.readFileSync(file, 'utf8')
}
function validateBundle(directory: string): VideoBundle {
  manifestText(directory)
  const bundle = readVideoBundle(directory)
  if (!bundle) throw new Error('目录中没有 baoyi.json 资源清单')
  const ids = new Set<string>()
  for (const item of bundle.items) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Number.isFinite(item.order)) throw new Error('资源清单内容身份或顺序无效')
    ids.add(item.id)
    for (const source of item.sources || []) validateSource(source)
    for (const file of item.files) {
      if (!Number.isFinite(file.size) || file.size < 0) throw new Error('资源清单文件大小无效')
      resolveBundlePath(directory, file.path)
    }
  }
  for (const source of bundle.work.sources || []) validateSource(source)
  for (const relative of Object.keys(bundle.managed_files || {})) resolveBundlePath(directory, relative)
  return bundle
}
function validateSource(source: VideoSourceRef): void {
  if (!source || !['work', 'episode'].includes(source.scope) || typeof source.provider !== 'string' || !source.provider.trim() || typeof source.externalId !== 'string' || !source.externalId.trim()) throw new Error('资源清单来源无效')
}
function checkDirectoryOwner(d: SqlDb, resourceId: string, directory: string, bundleId: string, permitRebind = false): void {
  for (const row of all(d, 'SELECT * FROM video_directories')) {
    if (row.resource_id === resourceId) {
      if (!permitRebind && !samePath(row.directory_path, directory)) throw new Error('作品已绑定另一目录，请先使用整目录重新定位')
      if (row.bundle_id !== bundleId) throw new Error('所选作品的清单 UUID 已变化')
    } else if (String(row.bundle_id).toLowerCase() === bundleId.toLowerCase() || actualKey(row.directory_path) === actualKey(directory)) throw new Error('目录或清单 UUID 已绑定其他作品，不能接管副本')
  }
  for (const row of all(d, 'SELECT id, path FROM resource')) {
    if (row.id !== resourceId && actualKey(row.path) === actualKey(directory)) throw new Error('目标目录已属于另一资源')
  }
}
function addCollision(list: VideoOrganizeCollision[], code: string, scope: VideoOrganizeCollision['scope'], message: string, extra: Partial<VideoOrganizeCollision> = {}): void {
  list.push({ code, scope, message, ...extra })
}

function prepareOrganize(d: SqlDb, input: VideoOrganizeRequest): Prepared {
  if (!input || !Array.isArray(input.resourceIds) || !input.resourceIds.length || input.resourceIds.length > 500 || input.resourceIds.some(id => typeof id !== 'string' || !id) || !input.resourceIds.includes(input.survivorId)) throw new Error('请明确选择源作品及要保留的主作品')
  const ids = [...new Set(input.resourceIds)]
  if (input.transfer && !['copy', 'move'].includes(input.transfer)) throw new Error('文件整理方式无效')
  const request: VideoOrganizeRequest = { resourceIds: ids, survivorId: input.survivorId, ...(input.transfer ? { transfer: input.transfer } : {}) }
  if (input.collectionTitle !== undefined) {
    if (typeof input.collectionTitle !== 'string' || !input.collectionTitle.trim() || input.collectionTitle.length > 240) throw new Error('请填写合集名称（最多 240 字）')
    request.collectionTitle = input.collectionTitle.trim()
  }
  if (input.episodeNumbers) {
    if (typeof input.episodeNumbers !== 'object' || Array.isArray(input.episodeNumbers)) throw new Error('集数列表无效')
    for (const value of Object.values(input.episodeNumbers)) if (!value || !Number.isInteger(value.season) || value.season < 0 || !Number.isInteger(value.episode) || value.episode < 0 || value.episode > 10000) throw new Error('请填写有效的季号和集数')
    request.episodeNumbers = structuredClone(input.episodeNumbers)
  }
  if (input.targetDirectory) request.targetDirectory = absolute(input.targetDirectory)
  if (input.targetRoot) {
    if (input.targetDirectory) throw new Error('整理根目录与完整目标目录不能同时指定')
    request.targetRoot = absolute(input.targetRoot)
  }
  if (input.root) request.root = absolute(input.root)
  if (input.fileNames) {
    if (typeof input.fileNames !== 'object' || Array.isArray(input.fileNames) || Object.values(input.fileNames).some(v => typeof v !== 'string')) throw new Error('目标文件名列表无效')
    request.fileNames = { ...input.fileNames }
  }
  const snap = snapshot(d, ids)
  if (snap.resource.length !== ids.length || snap.resource.some(r => r.kind !== 'video')) throw new Error('源作品已不存在或不属于影视库')
  const survivorRow = snap.resource.find(r => r.id === request.survivorId)!
  const bound = snap.video_directories.find(r => r.resource_id === request.survivorId)
  const target = request.targetRoot ? path.join(request.targetRoot, safeWorkFolderName(request.collectionTitle || survivorRow.name_zh || survivorRow.file_name))
    : request.targetDirectory || bound?.directory_path || (request.root ? path.join(request.root, safeWorkFolderName(request.collectionTitle || survivorRow.name_zh || survivorRow.file_name)) : '')
  const root = request.targetRoot || request.root || bound?.root || (target ? path.dirname(target) : '')
  const bundleId = ensureBundleId(bound?.bundle_id || bundleUuid(request.survivorId))
  const collisions: VideoOrganizeCollision[] = [], warnings: string[] = []
  for (const id of ids) if (resolveVideoOrganizeOwner(d, id) !== id) addCollision(collisions, 'already-merged', 'logical', '源作品已经合并，请打开其当前主作品', { resourceIds: [id] })
  const assets: Row[] = snap.video_assets.map(r => ({ ...r })), episodes = snap.episode.map(r => ({ ...r })), links = snap.video_episode_assets.map(r => ({ ...r }))
  const fileMap = new Map<string, VideoOrganizeFile>()
  const addFile = (source: string, resourceId: string, role: string, episodeId?: string): VideoOrganizeFile | undefined => {
    if (!source || !path.isAbsolute(source) || /^https?:/i.test(source)) return undefined
    source = absolute(source)
    if (fs.existsSync(source) && fs.statSync(source).isDirectory()) return undefined
    const key = keyPath(source), id = stableId('file', key)
    let f = fileMap.get(key)
    if (!f) {
      const stat = inspectFile(source)
      f = { id, resourceIds: [], assetIds: [], episodeIds: [], source, destination: '', relativePath: '', size: stat.size, state: stat.state, action: target ? request.transfer === 'move' ? 'move' : 'copy' : 'none' }
      fileMap.set(key, f)
    }
    if (!f.resourceIds.includes(resourceId)) f.resourceIds.push(resourceId)
    let asset = assets.find(a => a.resource_id === resourceId && samePath(a.path, source) && a.role === role)
    if (!asset) {
      asset = { id: stableId('asset', `${resourceId}:${key}:${role}`), resource_id: resourceId, path: source, role, quality: '', file_size: f.size, state: f.state, checked_at: 0, created_at: 0 }
      assets.push(asset)
    }
    if (!f.assetIds.includes(asset.id)) f.assetIds.push(asset.id)
    if (episodeId) {
      if (!f.episodeIds.includes(episodeId)) f.episodeIds.push(episodeId)
      if (!links.some(l => l.episode_id === episodeId && l.asset_id === asset.id)) links.push({ episode_id: episodeId, asset_id: asset.id })
    }
    return f
  }
  for (const r of ids.map(id => snap.resource.find(row => row.id === id)!)) {
    const meta = snap.video_meta.find(m => m.resource_id === r.id) || {}
    if (!snap.video_meta.some(m => m.resource_id === r.id)) addCollision(collisions, 'missing-metadata', 'logical', '作品缺少影视元数据', { resourceIds: [r.id] })
    for (const asset of snap.video_assets.filter(a => a.resource_id === r.id)) addFile(asset.path, r.id, asset.role)
    for (const ep of snap.episode.filter(e => e.resource_id === r.id)) if (ep.path) addFile(ep.path, r.id, 'video', ep.id)
    if (meta.video_type === 'movie' && (!fs.existsSync(r.path) || !fs.statSync(r.path).isDirectory())) addFile(r.path, r.id, 'video')
    for (const part of jsonArray(meta.parts)) if (part.path) addFile(part.path, r.id, 'video')
    for (const linked of jsonArray(meta.linked_files)) if (linked.path) addFile(linked.path, r.id, /\.(srt|ass|ssa|vtt|sub)$/i.test(linked.path) ? 'subtitle' : 'attachment')
    for (const poster of [meta.poster_path, meta.fanart_path, r.icon_path]) if (poster) addFile(poster, r.id, 'poster')
    for (const link of links) {
      const asset = assets.find(a => a.id === link.asset_id && a.resource_id === r.id)
      if (asset) addFile(asset.path, r.id, asset.role, link.episode_id)
    }
    const owned = [...fileMap.values()].filter(f => f.resourceIds.includes(r.id) && f.assetIds.some(id => assets.some(a => a.id === id && a.resource_id === r.id && a.role === 'video')))
    const hasEpisodes = snap.episode.some(e => e.resource_id === r.id)
    const orphaned = owned.filter(f => !f.episodeIds.length)
    const parts = jsonArray(meta.parts)
    const groups = !hasEpisodes && parts.length <= 1 ? (orphaned.length ? [orphaned] : []) : orphaned.map(f => [f])
    for (const [index, group] of groups.entries()) {
      const numbered = request.collectionTitle && groups.length === 1 ? numberedEpisode(r.name_zh || r.file_name) : null
      let number = numbered?.number ?? 1
      if (!numbered) while (episodes.some(e => e.season === 0 && e.episode === number)) number++
      const id = stableId('episode', `${r.id}:${index}:${group[0].id}`)
      episodes.push({ id, resource_id: r.id, season: numbered?.season || 0, episode: number, title: groups.length === 1 ? r.name_zh || r.file_name : path.basename(group[0].source), display_label: parts[index]?.label || '', path: group[0].source, file_size: group[0].size,
        original_title: groups.length === 1 && r.name_en || cleanEpisodeTitle(path.basename(group[0].source)),
        description: groups.length === 1 ? r.description || r.summary || meta.original_description || '' : '',
        original_description: groups.length === 1 ? meta.original_description || '' : '',
        tags: meta.hanime_tags && meta.hanime_tags !== '[]' ? meta.hanime_tags : r.tags || '[]', thumbnail_path: meta.thumbnail_path || '', thumbnail_source: meta.thumbnail_source || '', poster_source: meta.poster_source || '',
        notes: groups.length === 1 ? r.notes || '' : '', poster_path: meta.poster_path || '', source_url: meta.hanime_id ? 'https://hanime1.me/watch?v=' + meta.hanime_id : r.official_url || '',
        duration_sec: Number(meta.duration_sec) || 0, watch_status: meta.watch_status || 'unwatched', position_sec: Number(meta.position_sec) || 0, watched_at: Number(meta.last_watched_at) || 0, air_date: 0 })
      for (const f of group) addFile(f.source, r.id, 'video', id)
    }
    const own = episodes.filter(episode => episode.resource_id === r.id)
    if (own.length === 1) {
      const episode = own[0]
      episode.original_title ||= r.name_en || cleanEpisodeTitle(path.basename(episode.path || r.path))
      episode.description ||= r.description || r.summary || meta.original_description || ''
      episode.original_description ||= meta.original_description || ''
      episode.tags = episode.tags && episode.tags !== '[]' ? episode.tags : meta.hanime_tags && meta.hanime_tags !== '[]' ? meta.hanime_tags : r.tags || '[]'
      episode.thumbnail_path ||= meta.thumbnail_path || ''
      episode.thumbnail_source ||= meta.thumbnail_source || ''
      episode.poster_source ||= meta.poster_source || ''
      episode.notes ||= r.notes || ''
      episode.poster_path ||= meta.poster_path || ''
      episode.source_url ||= meta.hanime_id ? 'https://hanime1.me/watch?v=' + meta.hanime_id : r.official_url || ''
    }
    for (const episode of own) {
      if (episode.poster_path) addFile(episode.poster_path, r.id, 'poster', episode.id)
      if (episode.thumbnail_path) addFile(episode.thumbnail_path, r.id, 'poster', episode.id)
      if (episode.path) {
        const metadata = readVideoLocalMetadata(episode.path)
        for (const attachment of metadata.attachments || []) addFile(attachment.path, r.id, attachment.role, episode.id)
        const marker = path.join(path.dirname(episode.path), '.nomedia')
        if (fs.existsSync(marker) && fs.statSync(marker).size === 0 && ![...fileMap.values()].some(f => path.basename(f.source) === '.nomedia')) addFile(marker, r.id, 'attachment')
      }
    }
  }
  const slotMap = new Map<string, Row>()
  for (const [id, number] of Object.entries(request.episodeNumbers || {})) {
    const row = episodes.find(episode => episode.id === id)
    if (!row) throw new Error('合集内容已变化，请重新选择')
    row.season = number.season; row.episode = number.episode
  }
  for (const e of episodes) {
    const key = `${e.season}:${e.episode}`, other = slotMap.get(key)
    if (other) addCollision(collisions, 'episode-slot', 'logical', `季 ${e.season} / 集 ${e.episode} 同时属于多个内容项；保留编号，未自动改序`, { resourceIds: [other.resource_id, e.resource_id] })
    else slotMap.set(key, e)
  }
  const assetSlots = new Map<string, Row>()
  for (const a of assets) {
    const key = `${keyPath(a.path)}:${a.role}`, other = assetSlots.get(key)
    if (other && other.id !== a.id) addCollision(collisions, 'asset-slot', 'logical', '同一路径存在不同资产身份，需先明确保留方式', { resourceIds: [other.resource_id, a.resource_id], path: a.path })
    else assetSlots.set(key, a)
  }
  const files = [...fileMap.values()]
  const stamps = files.map(f => [f.id, inspectFile(f.source).stamp])
  const destinations = new Map<string, VideoOrganizeFile>()
  for (const f of files) {
    if (!target) continue
    try {
      const roles = assets.filter(a => f.assetIds.includes(a.id)).map(a => a.role)
      const metadataName = /^info\d*\.json$/i.test(path.basename(f.source))
      const defaultName = metadataName ? '.baoyi/originals/' + hash(f.episodeIds[0] || keyPath(path.dirname(f.source))).slice(0,24) + '/' + path.basename(f.source)
        : roles.length && roles.every(role => role === 'poster') ? '.baoyi/artwork/' + hash(keyPath(f.source)).slice(0,24) + path.extname(f.source) : path.basename(f.source)
      const relative = request.fileNames?.[f.id] || (inside(target, f.source) ? path.relative(target, f.source) : defaultName)
      safeComponents(relative)
      f.destination = resolveBundlePath(target, relative)
      f.relativePath = path.relative(target, f.destination).split(path.sep).join('/')
      checkDestination(root, f.destination)
      if (/^(?:baoyi\.json(?:\.bak)?|\.baoyi-owner\.json)$/i.test(f.relativePath)) throw new Error('目标名称由作品清单保留，请选择其他名称')
      f.action = samePath(f.source, f.destination) ? 'keep' : request.transfer === 'move' ? 'move' : 'copy'
      const other = destinations.get(keyPath(f.destination))
      if (other && !samePath(other.source, f.source)) {
        for (const item of [other, f]) addCollision(collisions, 'planned-destination-collision', 'file', '多个源文件使用相同的实际目标，请分别命名', { fileId: item.id, path: item.destination })
      } else destinations.set(keyPath(f.destination), f)
      if (['copy','move'].includes(f.action) && fs.existsSync(f.destination)) addCollision(collisions, 'destination-exists', 'file', '目标文件已存在，不会覆盖', { fileId: f.id, path: f.destination })
    } catch (error) { addCollision(collisions, 'unsafe-path', 'file', textError(error), { fileId: f.id, path: f.destination }) }
    if (f.state !== 'present') addCollision(collisions, f.state, 'file', f.state === 'offline' ? '源文件所在磁盘离线或不可读' : '源文件缺失或不是普通文件', { fileId: f.id, path: f.source })
  }
  let manifest: string | null = null
  if (target) {
    try {
      checkDestination(root, target)
      checkDestination(root, stagingPath(target, 'preview'))
      checkDirectoryOwner(d, request.survivorId, target, bundleId)
      if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new Error('目标不是目录')
      manifest = manifestText(target)
      if (manifest) {
        const bundle = validateBundle(target)
        if (!bound || bundle.bundle_id !== bundleId) throw new Error('目标目录已有其他或尚未绑定的资源清单，不能接管')
      } else if (!bound && fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('目标目录非空且未绑定本作品，请选择独立目录')
      const marker = path.join(target, '.baoyi-owner.json')
      if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).bundleId !== bundleId) throw new Error('目录占用标记属于另一资源清单')
    } catch (error) { addCollision(collisions, 'directory-conflict', 'physical', textError(error), { path: target }) }
  }
  if (!target) warnings.push('尚未选择物理目标；可以仅逻辑合并')
  warnings.push(request.transfer === 'move' ? '源作品保留为归档记录；全部校验完成后移除专属原文件，回退可恢复原位置并保留副本' : '源作品保留为归档记录；复制后仍保留原文件，回滚也不会删除副本')
  const works: VideoOrganizeWork[] = ids.map(id => {
    const r = snap.resource.find(row => row.id === id)!, m = snap.video_meta.find(row => row.resource_id === id) || {}
    return { resourceId: id, name: r.name_zh || r.name_en || r.file_name, path: r.path, notes: r.notes || '', archived: !!r.is_archived, watchStatus: m.watch_status || 'unwatched', positionSec: m.position_sec || 0,
      directory: directoryRow(snap.video_directories.find(row => row.resource_id === id)), fileIds: files.filter(f => f.resourceIds.includes(id)).map(f => f.id) }
  })
  const previewEpisodes: VideoOrganizeEpisode[] = episodes.map(e => ({ id: e.id, resourceId: e.resource_id, title: e.title, season: e.season, episode: e.episode, generated: !snap.episode.some(old => old.id === e.id), fileIds: files.filter(f => f.episodeIds.includes(e.id)).map(f => f.id) }))
  const canMerge = !collisions.some(c => c.scope === 'logical')
  const preview: VideoOrganizePreview = { kind: 'organize', request, fingerprint: '', works, survivor: works.find(w => w.resourceId === request.survivorId)!, targetDirectory: target, root, bundleId, episodes: previewEpisodes, files, collisions, warnings, canMerge, canOrganize: canMerge && !!target && !collisions.some(c => c.scope === 'physical') }
  preview.fingerprint = hash(JSON.stringify({ preview, snapshot: confirmationSnapshot(snap), stamps, manifest }))
  return { preview, snapshot: snap, assets, episodes, links }
}

/** A preview does not create a journal, directory, asset row, or change a watch status. */
export function previewVideoOrganize(d: SqlDb, request: VideoOrganizeRequest): VideoOrganizePreview { return prepareOrganize(d, request).preview }

function publicJournal(j: Journal): VideoOrganizeJournal {
  return { id: j.id, kind: j.kind, mode: j.mode, status: j.status, survivorId: j.survivorId, sourceIds: [...j.sourceIds], createdAt: j.createdAt, updatedAt: j.updatedAt, targetDirectory: j.targetDirectory,
    files: j.files.map(({ stage: _stage, stageIdentity: _stageIdentity, targetIdentity: _targetIdentity, sourceIdentity: _sourceIdentity, ...file }) => file),
    warnings: [...j.warnings], conflicts: [...j.conflicts], canRetry: j.status === 'partial' || j.status === 'running', canRollback: j.status !== 'rolled-back' }
}
function readJournal(d: SqlDb, id: string): Journal {
  const row = one(d, 'SELECT data FROM video_organize_journal WHERE id = ?', id)
  if (!row) throw new Error('整理日志不存在')
  const j = JSON.parse(row.data) as Journal
  if (j.version !== 1 || j.id !== id || !Array.isArray(j.changes) || !tables.every(t => Array.isArray(j.snapshot[t]))) throw new Error('整理日志格式无效，未修改任何资源')
  return j
}
export function listVideoOrganizeJournal(d: SqlDb, resourceId?: string): VideoOrganizeJournal[] {
  return all(d, 'SELECT data FROM video_organize_journal ORDER BY created_at DESC, rowid DESC').map(row => JSON.parse(row.data) as Journal)
    .filter(j => !resourceId || j.sourceIds.includes(resourceId)).map(publicJournal)
}
function save(d: SqlDb, j: Journal): void {
  j.updatedAt = Date.now()
  d.prepare('UPDATE video_organize_journal SET status = ?, updated_at = ?, data = ? WHERE id = ?').run(j.status, j.updatedAt, JSON.stringify(j), j.id)
}
function tx(d: SqlDb, j: Journal, run: () => void): void {
  const before = structuredClone(j), name = 'organize_' + randomUUID().replaceAll('-', '')
  d.exec('SAVEPOINT ' + name)
  try { run(); save(d, j); d.exec('RELEASE SAVEPOINT ' + name) }
  catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT ' + name); d.exec('RELEASE SAVEPOINT ' + name)
    // The file loop holds these objects. Preserve their identity so its failure result is durable too.
    const files = j.files
    Object.assign(j, before)
    j.files = before.files.map(saved => {
      const existing = files.find(file => file.id === saved.id)
      return existing ? Object.assign(existing, saved) : saved
    })
    throw error
  }
}
function patch(d: SqlDb, j: Journal, table: Table, key: Row, fields: Row, pathMap?: Change['pathMap']): void {
  const current = getRow(d, table, key)
  if (!current) throw new Error('整理期间资源记录已被删除：' + table)
  const after = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== current[k]))
  if (!Object.keys(after).length) return
  const before = Object.fromEntries(Object.keys(after).map(k => [k, current[k]]))
  d.prepare(`UPDATE ${table} SET ${Object.keys(after).map(k => `${k} = ?`).join(', ')} WHERE ${Object.keys(key).map(k => `${k} IS ?`).join(' AND ')}`).run(...Object.values(after), ...Object.values(key))
  j.changes.push({ table, key, before, after, pathMap })
}
function insert(d: SqlDb, j: Journal, table: Table, row: Row, originId?: string): void {
  const key = rowKey(table, row)
  if (getRow(d, table, key)) throw new Error('预留记录身份已被占用：' + table)
  d.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row))
  j.changes.push({ table, key, before: null, after: getRow(d, table, key)!, originId })
}
function makeJournal(d: SqlDb, preview: Journal['preview'], snap: Snapshot, mode: Journal['mode']): Journal {
  const ids = preview.kind === 'organize' ? preview.request.resourceIds : [preview.resourceId]
  for (const old of listVideoOrganizeJournal(d)) {
    if (!['running', 'partial', 'rollback-partial'].includes(old.status)) continue
    const pending = readJournal(d, old.id)
    // A fully rolled-back SQL failure never owned files or changed the library. A new
    // preview can replace that attempt; real partial copies and moves still block it.
    if (pending.status !== 'rollback-partial' && pending.logicalApplied === false && pending.bound === false &&
      pending.changes.length === 0 && !pending.manifest.afterHash && !pending.manifest.pendingHash &&
      pending.files.every(file => file.status === 'pending' && file.attempts === 0 && !file.sha256 && !file.stage && !file.sourceRemoved)) continue
    if (old.sourceIds.some(id => ids.includes(id))) throw new Error('这些作品还有未完成的整理，请先重试或回退原日志')
    if (mode !== 'logical' && old.mode !== 'logical' && old.targetDirectory && preview.targetDirectory && (
      actualKey(old.targetDirectory) === actualKey(preview.targetDirectory) || inside(actualKey(old.targetDirectory), actualKey(preview.targetDirectory)) || inside(actualKey(preview.targetDirectory), actualKey(old.targetDirectory))
    )) throw new Error('目标目录已有正在进行的整理，未占用其他任务的目录')
  }
  const before = preview.targetDirectory ? manifestText(preview.targetDirectory) : null
  const now = Date.now()
  const j: Journal = { version: 1, id: randomUUID(), kind: preview.kind === 'organize' ? 'organize' : 'relocate', mode, status: 'running', survivorId: preview.kind === 'organize' ? preview.request.survivorId : preview.resourceId,
    sourceIds: ids, createdAt: now, updatedAt: now, targetDirectory: preview.targetDirectory, preview, snapshot: snap,
    files: preview.files.map(f => ({ ...f, status: 'pending', error: '', attempts: 0, sha256: '', originalRetained: true })), warnings: [...preview.warnings], conflicts: [], changes: [], logicalApplied: false, bound: false,
    manifest: { before, beforeHash: before === null ? '' : hash(before), afterHash: '' } }
  d.prepare('INSERT INTO video_organize_journal (id, resource_id, kind, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(j.id, j.survivorId, j.kind, j.status, now, now, JSON.stringify(j))
  return j
}
async function locked<T>(d: SqlDb, ids: string[], run: () => Promise<T>): Promise<T> {
  const active = locks.get(d) || new Set<string>(); locks.set(d, active)
  if (ids.some(id => active.has(id))) throw new Error('作品整理正在进行，请等待当前操作完成')
  ids.forEach(id => active.add(id))
  try { return await run() } finally { ids.forEach(id => active.delete(id)) }
}
function applyLogical(d: SqlDb, j: Journal, prepared: Prepared): void {
  tx(d, j, () => {
    const targetId = j.survivorId
    let temporary = -10001
    for (const ep of prepared.episodes) if (prepared.snapshot.episode.some(e => e.id === ep.id)) {
      while (one(d, 'SELECT id FROM episode WHERE episode = ?', temporary)) temporary--
      patch(d, j, 'episode', { id: ep.id }, { episode: temporary-- })
    }
    for (const ep of prepared.episodes) {
      if (!prepared.snapshot.episode.some(e => e.id === ep.id)) insert(d, j, 'episode', { ...ep, resource_id: targetId }, ep.resource_id)
      else patch(d, j, 'episode', { id: ep.id }, { resource_id: targetId, season: ep.season, episode: ep.episode,
        ...Object.fromEntries(['tags', 'poster_source', 'thumbnail_path', 'thumbnail_source', 'original_title', 'description', 'original_description', 'notes', 'poster_path', 'source_url'].map(field => [field, ep[field] || ''])) })
    }
    for (const asset of prepared.assets) {
      if (!prepared.snapshot.video_assets.some(a => a.id === asset.id)) insert(d, j, 'video_assets', { ...asset, resource_id: targetId, created_at: j.createdAt }, asset.resource_id)
      else if (asset.resource_id !== targetId) patch(d, j, 'video_assets', { id: asset.id }, { resource_id: targetId })
    }
    for (const link of prepared.links) if (!getRow(d, 'video_episode_assets', rowKey('video_episode_assets', link))) insert(d, j, 'video_episode_assets', link)
    for (const source of prepared.snapshot.video_sources) if (source.resource_id !== targetId) patch(d, j, 'video_sources', { id: source.id }, { resource_id: targetId })
    for (const meta of prepared.snapshot.video_meta) if (meta.hanime_id) {
      const own = prepared.episodes.filter(ep => ep.resource_id === meta.resource_id)
      if (own.length !== 1) continue
      const source = one(d, "SELECT * FROM video_sources WHERE resource_id = ? AND provider = 'hanime' AND external_id = ? AND scope = 'episode' ORDER BY episode_id IS NULL, confirmed DESC LIMIT 1", targetId, meta.hanime_id)
      if (source && !source.episode_id) patch(d, j, 'video_sources', { id: source.id }, { episode_id: own[0].id })
      else if (!source) insert(d, j, 'video_sources', { id: randomUUID(), resource_id: targetId, episode_id: own[0].id, provider: 'hanime', external_id: meta.hanime_id,
        scope: 'episode', page_url: 'https://hanime1.me/watch?v=' + meta.hanime_id, evidence: 'legacy', confirmed: 0, created_at: j.createdAt, updated_at: j.createdAt }, meta.resource_id)
    }
    for (const id of j.sourceIds) if (id !== targetId) patch(d, j, 'resource', { id }, { is_archived: 1 })
    if (prepared.episodes.length) patch(d, j, 'video_meta', { resource_id: targetId }, { video_type: 'series' })
    if (prepared.preview.request.collectionTitle) {
      const meta = getRow(d, 'video_meta', { resource_id: targetId })!
      const original = prepared.snapshot.resource.find(resource => resource.id === targetId)!
      const originalMeta = prepared.snapshot.video_meta.find(row => row.resource_id === targetId)!
      const standalone = prepared.snapshot.episode.filter(episode => episode.resource_id === targetId).length <= 1
        && (originalMeta.video_type === 'movie' || !!numberedEpisode(original.name_zh || original.file_name))
      patch(d, j, 'resource', { id: targetId }, { name_zh: prepared.preview.request.collectionTitle,
        ...(standalone ? { summary: '', description: '', name_en: '' } : {}) })
      const edited = [...new Set([...jsonArray(meta.user_edited) as unknown as string[], 'name_zh'])]
      patch(d, j, 'video_meta', { resource_id: targetId }, { user_edited: JSON.stringify(edited), ...(standalone ? { original_description: '' } : {}) })
    }
    j.logicalApplied = true
  })
}

async function fileHash(file: string, length?: number): Promise<string> {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文件不可读或为链接：' + file)
  if (length !== undefined && (length < 0 || length > stat.size)) throw new Error('待校验的文件片段不完整')
  const digest = createHash('sha256')
  if (length !== 0) for await (const chunk of fs.createReadStream(file, length === undefined ? undefined : { start: 0, end: length - 1 })) digest.update(chunk)
  return digest.digest('hex')
}
async function appendStagedFile(handle: FileHandle, stage: string, start = 0): Promise<void> {
  for await (const chunk of fs.createReadStream(stage, { start })) {
    const bytes = chunk as Buffer
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
      if (!bytesWritten) throw new Error('目标文件无法继续写入，暂存文件已保留')
      offset += bytesWritten
    }
  }
  await handle.sync()
}
function pathFields(value: string, from: string, to: string): string {
  const items = jsonArray(value)
  let changed = false
  const next = items.map(item => {
    if (item && typeof item.path === 'string' && samePath(item.path, from)) { changed = true; return { ...item, path: to } }
    return item
  })
  return changed ? JSON.stringify(next) : value
}
function patchPathArray(d: SqlDb, j: Journal, id: string, field: 'parts' | 'linked_files', from: string, to: string): void {
  const meta = getRow(d, 'video_meta', { resource_id: id })
  if (!meta) return
  const next = pathFields(meta[field], from, to)
  if (next !== meta[field]) patch(d, j, 'video_meta', { resource_id: id }, { [field]: next }, { field, from, to })
}
function ensureTargetDirectory(j: Journal, directory = j.targetDirectory): void {
  checkDestination(j.preview.root, directory)
  fs.mkdirSync(directory, { recursive: true })
  checkDestination(j.preview.root, directory)
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('目标不是普通目录')
}
/** A private staging copy is retained on failure. Publication is exclusive on every filesystem. */
async function copyVerified(d: SqlDb, j: Journal, f: FileResult): Promise<void> {
  checkDestination(j.preview.root, f.destination)
  const source = inspectFile(f.source)
  if (source.state !== 'present' || !source.stamp) throw new Error(source.state === 'offline' ? '源磁盘离线或不可读' : '源文件不存在或不是普通文件')
  if (f.action === 'keep') {
    f.sha256 = await fileHash(f.source); f.sourceIdentity = source.stamp
    f.status = 'unchanged'; save(d, j); return
  }
  // A restart may find the verified output before its reference transaction committed.
  if (fs.existsSync(f.destination)) {
    const target = inspectFile(f.destination)
    let owned = !!f.targetIdentity && !!target.stamp && sameInode(f.targetIdentity, target.stamp)
    if (!owned && f.stage && fs.existsSync(f.stage) && target.stamp) {
      const stage = inspectFile(f.stage)
      owned = !!stage.stamp && sameInode(stage.stamp, target.stamp)
    }
    if (!owned || !f.sha256 || target.state !== 'present' || !target.stamp) throw new Error('实际目标已存在或已被修改，未覆盖：' + f.destination)
    if (await fileHash(f.source) !== f.sha256) throw new Error('复制后的源文件已变化，未切换引用')
    let targetStamp = target.stamp
    const targetHash = await fileHash(f.destination)
    if (targetHash !== f.sha256) {
      // On filesystems without hard links, a crash can interrupt exclusive publication. Only
      // extend our own inode when all existing bytes match the verified staging file's prefix.
      const stage = f.stage ? inspectFile(f.stage) : null
      if (!f.targetIdentity || !f.stage || !f.stageIdentity || !stage?.stamp || stage.state !== 'present' ||
        !sameInode(stage.stamp, f.stageIdentity) || target.size >= stage.size || await fileHash(f.stage) !== f.sha256 ||
        await fileHash(f.stage, target.size) !== targetHash) throw new Error('实际目标已被修改或无法证明未完成复制，未覆盖：' + f.destination)
      checkDestination(j.preview.root, f.destination)
      const handle = await fs.promises.open(f.destination, fs.constants.O_WRONLY | fs.constants.O_APPEND)
      try {
        if (!sameIdentity(target.stamp, identity(await handle.stat()))) throw new Error('目标文件在恢复前变化，未修改')
        // O_APPEND cannot overwrite existing bytes, even if another writer appends concurrently.
        await appendStagedFile(handle, f.stage, target.size)
      } finally { await handle.close() }
      targetStamp = identity(fs.lstatSync(f.destination))
      if (!sameInode(target.stamp, targetStamp) || await fileHash(f.destination) !== f.sha256) throw new Error('恢复后的目标校验失败，未切换引用')
    }
    if (!sameIdentity(source.stamp, identity(fs.lstatSync(f.source))) || !sameIdentity(targetStamp, identity(fs.lstatSync(f.destination)))) throw new Error('恢复期间文件变化，未切换引用')
    f.targetIdentity = targetStamp; f.status = 'copied'; save(d, j); return
  }
  ensureTargetDirectory(j, path.dirname(f.destination))
  checkDestination(j.preview.root, f.destination)
  f.sourceIdentity = source.stamp
  f.sha256 = await fileHash(f.source)
  if (!sameIdentity(source.stamp, identity(fs.lstatSync(f.source)))) throw new Error('读取期间源文件变化，请重新预览')
  f.stage = stagingPath(j.targetDirectory, `${j.id}:${f.id}:${f.attempts}`)
  checkDestination(j.preview.root, f.stage)
  f.status = 'copying'; save(d, j)
  await fs.promises.copyFile(f.source, f.stage, fs.constants.COPYFILE_EXCL)
  const stageHandle = await fs.promises.open(f.stage, 'r+')
  try { await stageHandle.sync() } finally { await stageHandle.close() }
  f.stageIdentity = identity(fs.lstatSync(f.stage))
  if (await fileHash(f.stage) !== f.sha256 || !sameIdentity(source.stamp, identity(fs.lstatSync(f.source)))) throw new Error('复制校验失败或源文件在复制期间变化；原件和暂存文件已保留')
  checkDestination(j.preview.root, f.destination)
  try {
    // A hard link publishes the verified bytes without a rename-overwrite race.
    fs.linkSync(f.stage, f.destination)
    f.targetIdentity = identity(fs.lstatSync(f.destination)); save(d, j)
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    // FAT/exFAT and some network shares have no hard links. Open exclusively and verify again.
    const handle = await fs.promises.open(f.destination, 'wx')
    try {
      const opened = identity(await handle.stat()), published = identity(fs.lstatSync(f.destination))
      if (!sameInode(opened, published)) throw new Error('发布目标的身份已变化，未继续写入')
      f.targetIdentity = published; save(d, j)
      await appendStagedFile(handle, f.stage)
    } finally { await handle.close() }
    f.targetIdentity = identity(fs.lstatSync(f.destination))
  }
  if (await fileHash(f.destination) !== f.sha256 || !sameIdentity(source.stamp, identity(fs.lstatSync(f.source)))) throw new Error('发布后校验失败；原文件未动，未切换引用')
  f.targetIdentity = identity(fs.lstatSync(f.destination)); f.status = 'copied'; save(d, j)
}
function switchFile(d: SqlDb, j: Journal, f: FileResult): void {
  tx(d, j, () => {
    const source = f.source, target = f.destination
    for (const id of f.assetIds) {
      const a = getRow(d, 'video_assets', { id })
      if (!a || a.resource_id !== j.survivorId || (!samePath(a.path, source) && !samePath(a.path, target))) throw new Error('资产归属或路径已由其他操作修改，保留当前选择')
      patch(d, j, 'video_assets', { id }, { path: target, file_size: fs.statSync(target).size, state: 'present', checked_at: Date.now() })
    }
    for (const id of f.episodeIds) {
      const e = getRow(d, 'episode', { id })
      if (e && e.resource_id === j.survivorId && samePath(e.path, source)) patch(d, j, 'episode', { id }, { path: target, file_size: fs.statSync(target).size })
      for (const field of ['poster_path', 'thumbnail_path']) if (e && e.resource_id === j.survivorId && samePath(e[field], source)) patch(d, j, 'episode', { id }, { [field]: target })
    }
    const r = getRow(d, 'resource', { id: j.survivorId })
    if (r && samePath(r.path, source)) patch(d, j, 'resource', { id: j.survivorId }, { path: target })
    const meta = getRow(d, 'video_meta', { resource_id: j.survivorId })
    if (meta) for (const field of ['poster_path', 'thumbnail_path', 'fanart_path']) if (samePath(meta[field], source)) patch(d, j, 'video_meta', { resource_id: j.survivorId }, { [field]: target })
    if (r?.icon_path && samePath(r.icon_path, source)) patch(d, j, 'resource', { id: j.survivorId }, { icon_path: target })
    for (const field of ['parts', 'linked_files'] as const) patchPathArray(d, j, j.survivorId, field, source, target)
    f.status = 'switched'
  })
}
function expectedValue(j: Journal, table: Table, key: Row, field: string): unknown {
  for (let index = j.changes.length - 1; index >= 0; index--) {
    const c = j.changes[index]
    if (c.table === table && JSON.stringify(c.key) === JSON.stringify(key) && field in c.after) return c.after[field]
  }
  return j.snapshot[table].find(row => Object.entries(key).every(([k, v]) => row[k] === v))?.[field]
}
function bindOrganizedDirectory(d: SqlDb, j: Journal): void {
  const p = j.preview
  if (p.kind !== 'organize') throw new Error('整理计划类型不匹配')
  ensureTargetDirectory(j)
  checkDirectoryOwner(d, j.survivorId, j.targetDirectory, p.bundleId)
  tx(d, j, () => {
    const key = { resource_id: j.survivorId }, before = getRow(d, 'video_directories', key)
    const resource = getRow(d, 'resource', { id: j.survivorId })
    if (!resource || resource.path !== expectedValue(j, 'resource', { id: j.survivorId }, 'path')) throw new Error('作品路径已由用户修改，未重绑目录')
    if (before && before.directory_path !== expectedValue(j, 'video_directories', key, 'directory_path')) throw new Error('目录绑定已变化，未覆盖')
    upsertVideoDirectory(d, { resourceId: j.survivorId, root: p.root, directory: j.targetDirectory, bundleId: p.bundleId, metadataState: 'pending' })
    const after = getRow(d, 'video_directories', key)!
    if (!before) j.changes.push({ table: 'video_directories', key, before: null, after })
    else {
      const fields = Object.keys(after).filter(k => after[k] !== before[k])
      if (fields.length) j.changes.push({ table: 'video_directories', key, before: Object.fromEntries(fields.map(k => [k, before[k]])), after: Object.fromEntries(fields.map(k => [k, after[k]])) })
    }
    patch(d, j, 'resource', { id: j.survivorId }, { path: j.targetDirectory, source_dir: j.targetDirectory, file_name: path.basename(j.targetDirectory) })
    j.bound = true
  })
}
function sources(d: SqlDb, resourceId: string, episodeId?: string): VideoSourceRef[] {
  const rows = all(d, `SELECT provider, external_id AS externalId, scope, page_url AS pageUrl, evidence FROM video_sources WHERE resource_id = ?${episodeId ? ' AND episode_id = ?' : ''} ORDER BY id`, ...[resourceId, ...(episodeId ? [episodeId] : [])])
  const unique = new Map<string, VideoSourceRef>()
  for (const s of rows) unique.set(`${s.provider}:${s.scope}:${s.externalId}`.toLowerCase(), s as VideoSourceRef)
  return [...unique.values()]
}
async function syncManifest(d: SqlDb, j: Journal): Promise<void> {
  if (j.preview.kind !== 'organize') return
  checkDestination(j.preview.root, j.targetDirectory)
  const current = manifestText(j.targetDirectory)
  if (j.manifest.pendingHash && current !== null && hash(current) === j.manifest.pendingHash) {
    // The last process published precisely these bytes and exited before recording completion.
    j.manifest.afterHash = j.manifest.pendingHash; j.manifest.pendingHash = ''; save(d, j)
  }
  if ((current === null ? '' : hash(current)) !== (j.manifest.afterHash || j.manifest.beforeHash)) throw new Error('资源清单在整理期间被修改，已保留用户清单；需要重新预览后同步')
  const previous = current ? validateBundle(j.targetDirectory) : null
  if (previous && previous.bundle_id !== j.preview.bundleId) throw new Error('资源清单 UUID 已变化，未覆盖')
  const r = getRow(d, 'resource', { id: j.survivorId })!, m = getRow(d, 'video_meta', { resource_id: j.survivorId })!
  const episodes = all(d, 'SELECT * FROM episode WHERE resource_id = ? ORDER BY season, episode, id', j.survivorId)
  const assets = all(d, 'SELECT * FROM video_assets WHERE resource_id = ? ORDER BY id', j.survivorId)
  const missing = new Set<string>()
  const relative = (file: string) => path.relative(j.targetDirectory, file).split(path.sep).join('/')
  const items: VideoBundle['items'] = episodes.map(e => {
    const linked = all(d, 'SELECT a.* FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id WHERE ea.episode_id = ? AND a.role = ? ORDER BY a.id', e.id, 'video')
    const included = linked.filter(a => inside(j.targetDirectory, a.path) && inspectFile(a.path).state === 'present')
    if (included.length !== linked.length || !included.length) missing.add('files:' + e.id)
    return { id: e.id, title: e.title, label: e.display_label, order: e.episode, season: e.season, number: e.episode,
      published_at: Number(e.published_at) || 0, air_date: Number(e.air_date) || 0, duration_sec: Number(e.duration_sec) || 0, studio: e.studio || '',
      tags: JSON.parse(e.tags || '[]'), poster_source: e.poster_source || '', thumbnail_source: e.thumbnail_source || '',
      thumbnail: e.thumbnail_path && inside(j.targetDirectory, e.thumbnail_path) ? relative(e.thumbnail_path) : '',
      attachments: all(d, "SELECT a.* FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id=a.id WHERE ea.episode_id=? AND a.role!='video'", e.id).filter(a => inside(j.targetDirectory, a.path)).map(a => ({ path: relative(a.path), role: a.role })),
      original_title: e.original_title || '', description: e.description || '', original_description: e.original_description || '', notes: e.notes || '', source_url: e.source_url || '',
      watch: { status: e.watch_status, position: e.position_sec, watchedAt: e.watched_at },
      poster: e.poster_path && inside(j.targetDirectory, e.poster_path) && inspectFile(e.poster_path).state === 'present' ? relative(e.poster_path) : '',
      sources: sources(d, j.survivorId, e.id), files: included.map(a => ({ path: relative(a.path), quality: a.quality, size: a.file_size })) }
  })
  const sourceKey = (s: VideoSourceRef) => `${s.provider}:${s.scope}:${s.externalId}`.toLowerCase()
  const mergeEntries = <T extends object>(old: T[], next: T[], key: (entry: T) => string): T[] => {
    const entries = new Map(old.map(entry => [key(entry), entry]))
    for (const entry of next) entries.set(key(entry), { ...entries.get(key(entry)), ...entry })
    return [...entries.values()]
  }
  const fileKey = (entry: { path: string }) => keyPath(resolveBundlePath(j.targetDirectory, entry.path))
  const used = new Set<string>()
  const registeredIds = new Set(items.map(item => item.id))
  const mergedItems = items.map(item => {
    const sourceIds = new Set(item.sources.map(sourceKey))
    // Exact IDs reserve their metadata before legacy source/file aliases are considered.
    const previousItem = previous?.items.find(old => old.id === item.id) || previous?.items.find(old => !used.has(old.id) && !registeredIds.has(old.id) && (
      old.sources?.some(s => sourceIds.has(sourceKey(s))) ||
      (old.season ?? 0) === (item.season ?? 0) && (old.number ?? old.order) === (item.number ?? item.order) && old.files.some(f => item.files.some(next => next.path.toLowerCase() === f.path.toLowerCase()))
    ))
    if (previousItem) used.add(previousItem.id)
    return { ...previousItem, ...item,
      sources: mergeEntries(previousItem?.sources || [], item.sources, sourceKey),
      files: mergeEntries(previousItem?.files || [], item.files, fileKey) }
  })
  const extraItems = previous?.items.filter(item => !used.has(item.id) && !items.some(current => current.id === item.id)) || []
  if (extraItems.length) j.warnings.push('清单中尚未入库的额外内容和自定义资料已保留')
  const poster = m.poster_path && inside(j.targetDirectory, m.poster_path) && inspectFile(m.poster_path).state === 'present' ? relative(m.poster_path) : previous?.work.poster || ''
  if (!poster || inspectFile(resolveBundlePath(j.targetDirectory, poster)).state !== 'present') missing.add('poster')
  const renamed = !!j.preview.request.collectionTitle
  const description = (renamed ? '' : previous?.work.description) || r.summary || r.description || ''
  if (!description) missing.add('description')
  // Extra assets preserve subtitle/attachment identities without pretending they are playable videos.
  const bundle: VideoBundle & { assets: Row[] } = {
    ...previous,
    schema_version: 1, bundle_id: j.preview.bundleId, revision: (previous?.revision || 0) + 1, updated_at: Date.now(),
    work: { ...previous?.work, title: (renamed ? '' : previous?.work.title) || r.name_zh || r.file_name, name_en: (renamed ? '' : previous?.work.name_en) || r.name_en || '', description,
      original_description: (renamed ? '' : previous?.work.original_description) || m.original_description || '', category: previous?.work.category || r.category,
      tags: previous?.work.tags || jsonArray(r.tags) as unknown as string[], sources: mergeEntries(previous?.work.sources || [], sources(d, j.survivorId), sourceKey), poster, thumbnail: m.thumbnail_path && inside(j.targetDirectory, m.thumbnail_path) ? relative(m.thumbnail_path) : '', thumbnail_source: m.thumbnail_source || '', poster_source: m.poster_source || previous?.work.poster_source || '', provenance: { ...(previous?.work.provenance || {}), organization: j.id } },
    items: [...mergedItems, ...extraItems].sort((a, b) => (a.season || 0) - (b.season || 0) || a.order - b.order), managed_files: { ...(previous?.managed_files || {}) }, missing: [...missing],
    assets: mergeEntries((previous as (VideoBundle & { assets?: Row[] }) | null)?.assets || [],
      assets.filter(a => inside(j.targetDirectory, a.path) && inspectFile(a.path).state === 'present').map(a => ({ id: a.id, path: relative(a.path), role: a.role, quality: a.quality, size: a.file_size,
        episode_ids: all(d, 'SELECT episode_id FROM video_episode_assets WHERE asset_id = ? ORDER BY episode_id', a.id).map(row => row.episode_id) })), a => String(a.id))
  }
  for (const f of j.files) if (['switched', 'unchanged'].includes(f.status) && f.sha256) bundle.managed_files[f.relativePath] = f.sha256
  j.warnings.push(...writeVideoEpisodeSidecars(j.targetDirectory, bundle))
  const output = JSON.stringify(bundle, null, 2) + '\n'
  const manifest = path.join(j.targetDirectory, 'baoyi.json')
  j.manifest.pendingHash = hash(output); save(d, j)
  // A unique, immutable recovery copy never overwrites an existing .bak or a user file.
  if (current !== null) {
    const backup = path.join(j.targetDirectory, `.baoyi-organize-${j.id}-${hash(current).slice(0, 12)}.json.bak`)
    checkDestination(j.preview.root, backup)
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, current, { flag: 'wx' })
    if (manifestText(j.targetDirectory) !== current) throw new Error('资源清单在发布前发生变化，未覆盖')
    atomicWrite(manifest, output)
  } else {
    fs.writeFileSync(manifest, output, { flag: 'wx' })
  }
  j.manifest.afterHash = hash(output); j.manifest.pendingHash = ''
  save(d, j)
  tx(d, j, () => patch(d, j, 'video_directories', { resource_id: j.survivorId }, { metadata_state: missing.size ? 'pending' : 'complete' }))
}
async function cleanupStage(f: FileResult): Promise<void> {
  if (!f.stage || !f.stageIdentity || !fs.existsSync(f.stage)) return
  const now = inspectFile(f.stage)
  if (now.stamp && sameInode(now.stamp, f.stageIdentity)) {
    // Only unlink our private filename. Even a hard-linked output and any later edits remain intact.
    await fs.promises.unlink(f.stage)
  }
}
async function runOrganize(d: SqlDb, j: Journal): Promise<VideoOrganizeJournal> {
  if (j.preview.kind !== 'organize') throw new Error('整理计划类型不匹配')
  j.status = 'running'; j.conflicts = []; save(d, j)
  try {
    ensureTargetDirectory(j)
    checkDirectoryOwner(d, j.survivorId, j.targetDirectory, j.preview.bundleId)
    for (const f of j.files) {
      if (['switched', 'unchanged'].includes(f.status)) continue
      // Existing destinations are checked live by copyVerified so a resolved conflict can retry.
      const blocked = j.preview.collisions.find(c => c.fileId === f.id && ['unsafe-path', 'planned-destination-collision'].includes(c.code))
      f.attempts++; f.error = ''; save(d, j)
      try {
        if (blocked) throw new Error(blocked.message)
        await copyVerified(d, j, f)
        if (f.status !== 'unchanged') switchFile(d, j, f)
        await cleanupStage(f)
      } catch (error) { f.status = 'failed'; f.error = textError(error); save(d, j) }
    }
    if (j.files.some(f => ['switched', 'unchanged'].includes(f.status))) {
      bindOrganizedDirectory(d, j)
      await syncManifest(d, j)
      if (j.preview.request.transfer === 'move' && j.files.every(f => ['switched','unchanged'].includes(f.status))) {
        for (const f of j.files) {
          if (f.action !== 'move' || f.sourceRemoved || f.status === 'unchanged') continue
          if (await fileHash(f.destination) !== f.sha256) throw new Error('移动目标已变化，保留剩余源文件')
          const shared = referencedVideoFiles(d).has(videoFileKey(f.source))
          if (shared) { j.warnings.push('共享源文件仍被使用，已保留：' + f.source); continue }
          if (fs.existsSync(f.source)) {
            const current = inspectFile(f.source)
            if (!current.stamp || !f.sourceIdentity || !sameIdentity(current.stamp,f.sourceIdentity) || await fileHash(f.source) !== f.sha256) throw new Error('移动源文件已变化，保留原件：' + f.source)
            await fs.promises.unlink(f.source)
          }
          f.sourceRemoved = true; f.originalRetained = false; save(d,j)
        }
      }
    }
  } catch (error) { j.conflicts.push(textError(error)) }
  j.status = j.files.some(f => !['switched', 'unchanged'].includes(f.status)) || j.conflicts.length ? 'partial' : 'applied'
  save(d, j)
  return publicJournal(j)
}

export async function applyVideoOrganize(d: SqlDb, input: VideoOrganizeApplyRequest): Promise<VideoOrganizeJournal> {
  if (!input || !['logical', 'physical'].includes(input.mode) || input.preview?.kind !== 'organize') throw new Error('请明确选择仅逻辑合并或合并并整理文件')
  return locked(d, input.preview.request.resourceIds, async () => {
    const prepared = prepareOrganize(d, input.preview.request), preview = prepared.preview
    if (preview.fingerprint !== input.preview.fingerprint) throw new Error('资料或实际路径已变化，请重新预览')
    if (!preview.canMerge || input.mode === 'physical' && !preview.canOrganize) throw new Error(preview.collisions.filter(c => c.scope !== 'file').map(c => c.message).join('；') || '缺少物理目标')
    const j = makeJournal(d, preview, prepared.snapshot, input.mode)
    try { applyLogical(d, j, prepared) }
    catch (error) { j.status = 'partial'; j.conflicts.push(textError(error)); save(d, j); throw error }
    if (input.mode === 'logical') {
      j.files.forEach(f => { f.status = 'unchanged' }); j.status = 'applied'; save(d, j); return publicJournal(j)
    }
    return runOrganize(d, j)
  })
}

function directoryFiles(directory: string, directories: string[] = []): string[] {
  const result: string[] = []
  const walk = (dir: string) => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('整目录迁移不跟随目录链接')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('整目录含有链接，请先明确链接归属：' + file)
      if (entry.isDirectory()) {
        directories.push(path.relative(directory, file).split(path.sep).join('/'))
        if (directories.length > 20000) throw new Error('目录数量超过单次迁移上限')
        walk(file)
      }
      else if (entry.isFile()) {
        if (/\.part(?:-|$)|\.tmp(?:-|$)/i.test(entry.name)) throw new Error('目录含有未完成的传输或暂存文件，请先恢复该任务')
        result.push(file)
        if (result.length > 20000) throw new Error('目录文件数量超过单次迁移上限')
      } else throw new Error('目录中包含非普通文件：' + file)
    }
  }
  walk(directory)
  return result
}
function referencedPaths(snap: Snapshot): string[] {
  return [...new Set([
    ...snap.resource.flatMap(r => [r.path, r.icon_path, r.source_dir]),
    ...snap.episode.flatMap(e => [e.path, e.poster_path]), ...snap.video_assets.map(a => a.path),
    ...snap.video_meta.flatMap(m => [m.poster_path, m.fanart_path, ...jsonArray(m.parts).map(x => x.path), ...jsonArray(m.linked_files).map(x => x.path)])
  ].filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))) ]
}

/** Explicit relocation is the only operation allowed to rebind an existing bundle UUID. */
export function previewVideoRelocate(d: SqlDb, input: VideoRelocateRequest): VideoRelocatePreview {
  if (!input || !['copy', 'rebind'].includes(input.mode) || !input.resourceId) throw new Error('请选择复制整目录或重绑已有目录')
  const target = absolute(input.directory), root = absolute(input.root || path.dirname(target))
  const request: VideoRelocateRequest = { resourceId: input.resourceId, directory: target, root, mode: input.mode }
  const snap = snapshot(d, [input.resourceId]), r = snap.resource[0], binding = snap.video_directories[0]
  if (!r || r.kind !== 'video' || !binding) throw new Error('作品没有可重新定位的受管理目录')
  const source = absolute(binding.directory_path), collisions: VideoOrganizeCollision[] = [], warnings: string[] = []
  const files: VideoOrganizeFile[] = [], directories: string[] = []
  let manifest: string | null = null
  try {
    if (samePath(source, target) || inside(source, target) || inside(target, source)) throw new Error('新旧目录必须互不包含且为不同目录')
    checkDestination(root, target)
    if (input.mode === 'copy') checkDestination(root, stagingPath(target, 'preview'))
    checkDirectoryOwner(d, input.resourceId, target, binding.bundle_id, true)
    const bundleDirectory = input.mode === 'copy' ? source : target
    const bundle = validateBundle(bundleDirectory)
    if (bundle.bundle_id !== binding.bundle_id) throw new Error('目标清单 UUID 与作品不符，不能重绑其他作品')
    manifest = manifestText(bundleDirectory)
    if (input.mode === 'copy' && fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) throw new Error('整目录复制的目标必须不存在或为空目录')
    const paths = new Map<string, string>()
    if (input.mode === 'copy') for (const file of directoryFiles(source, directories)) paths.set(keyPath(file), file)
    for (const file of referencedPaths(snap)) if (inside(source, file)) {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) continue
      paths.set(keyPath(file), file)
    }
    for (const item of bundle.items) for (const file of item.files) {
      const old = resolveBundlePath(source, file.path); paths.set(keyPath(old), old)
    }
    if (bundle.work.poster) { const old = resolveBundlePath(source, bundle.work.poster); paths.set(keyPath(old), old) }
    for (const name of Object.keys(bundle.managed_files || {})) { const old = resolveBundlePath(source, name); paths.set(keyPath(old), old) }
    for (const old of paths.values()) {
      const relative = path.relative(source, old).split(path.sep).join('/'), dest = resolveBundlePath(target, relative)
      checkDestination(root, dest)
      const stat = inspectFile(input.mode === 'copy' ? old : dest)
      const assets = snap.video_assets.filter(a => samePath(a.path, old)), episodes = snap.episode.filter(e => samePath(e.path, old))
      const f: VideoOrganizeFile = { id: stableId('file', keyPath(old)), resourceIds: [r.id], assetIds: assets.map(a => a.id), episodeIds: episodes.map(e => e.id), source: old, destination: dest,
        relativePath: relative, size: stat.size, state: stat.state, action: input.mode === 'copy' ? 'copy' : 'verify' }
      files.push(f)
      if (stat.state !== 'present') addCollision(collisions, stat.state, 'file', '目录中有缺失或不可读文件，完成前不会切换整目录', { fileId: f.id, path: input.mode === 'copy' ? old : dest })
      const expected = bundle.items.flatMap(i => i.files).find(b => b.path.replaceAll('\\', '/') === relative)?.size || assets.find(a => a.file_size > 0)?.file_size
      if (expected && stat.state === 'present' && stat.size !== expected) addCollision(collisions, 'size-mismatch', 'file', '实际文件大小与清单或资产记录不符', { fileId: f.id, path: dest })
    }
    if (input.mode === 'rebind') warnings.push('这是显式目录重绑；复制品中的观看状态不会导入或覆盖本库历史')
  } catch (error) { addCollision(collisions, 'directory-conflict', 'physical', textError(error), { path: target }) }
  const p: VideoRelocatePreview = { kind: 'relocate', request, fingerprint: '', resourceId: r.id, name: r.name_zh || r.file_name, sourceDirectory: source, targetDirectory: target, root, bundleId: binding.bundle_id, directories, files, collisions,
    warnings: [...warnings, '保留原目录和所有用户文件；任何文件失败都不会切换整个目录绑定'], canApply: !collisions.length }
  p.fingerprint = hash(JSON.stringify({ preview: p, snapshot: confirmationSnapshot(snap), manifest, stamps: files.map(f => [f.id, inspectFile(f.source).stamp, inspectFile(f.destination).stamp]) }))
  return p
}

function pathGraph(snap: Snapshot): string {
  return JSON.stringify({
    resources: snap.resource.map(r => [r.id, r.path, r.source_dir, r.icon_path]),
    episodes: snap.episode.map(e => [e.id, e.resource_id, e.path, e.poster_path]),
    assets: snap.video_assets.map(a => [a.id, a.resource_id, a.path, a.role]),
    links: snap.video_episode_assets,
    meta: snap.video_meta.map(m => [m.resource_id, m.poster_path, m.fanart_path, jsonArray(m.parts).map(p => p.path), jsonArray(m.linked_files).map(p => p.path)])
  })
}

function rebindReferences(d: SqlDb, j: Journal): void {
  const p = j.preview
  if (p.kind !== 'relocate') throw new Error('整理计划类型不匹配')
  const changePath = (old: string) => old && (samePath(old, p.sourceDirectory) || inside(p.sourceDirectory, old)) ? path.join(p.targetDirectory, path.relative(p.sourceDirectory, old)) : old
  tx(d, j, () => {
    if (pathGraph(snapshot(d, j.sourceIds)) !== pathGraph(j.snapshot)) throw new Error('目录迁移期间新增或改变了文件关联；保留原绑定，请回退并重新预览')
    const binding = getRow(d, 'video_directories', { resource_id: j.survivorId })
    if (!binding || !samePath(binding.directory_path, p.sourceDirectory) || binding.bundle_id !== p.bundleId) throw new Error('目录绑定在迁移期间已变化，未覆盖')
    for (const [table, fields] of [['resource', ['path', 'source_dir', 'icon_path']], ['episode', ['path', 'poster_path', 'thumbnail_path']], ['video_assets', ['path']], ['video_meta', ['poster_path', 'thumbnail_path', 'fanart_path']]] as Array<[Table, string[]]>) {
      for (const original of j.snapshot[table]) {
        const key = rowKey(table, original), current = getRow(d, table, key)
        if (!current) throw new Error('迁移期间存在删除操作，请重新预览')
        for (const field of fields) {
          const old = original[field]
          if (typeof old !== 'string' || !path.isAbsolute(old)) continue
          const next = changePath(old)
          if (next === old) continue
          if (current[field] !== old) throw new Error('迁移期间用户选择了其他路径，未覆盖')
          patch(d, j, table, key, { [field]: next })
        }
      }
    }
    for (const file of j.files) for (const field of ['parts', 'linked_files'] as const) patchPathArray(d, j, j.survivorId, field, file.source, file.destination)
    patch(d, j, 'resource', { id: j.survivorId }, { file_name: path.basename(p.targetDirectory) })
    patch(d, j, 'video_directories', { resource_id: j.survivorId }, { root: p.root, directory_path: p.targetDirectory, relative_path: path.relative(p.root, p.targetDirectory), updated_at: Date.now() })
    j.bound = true
    j.files.forEach(f => { f.status = 'switched' })
  })
}
async function runRelocate(d: SqlDb, j: Journal): Promise<VideoOrganizeJournal> {
  const p = j.preview
  if (p.kind !== 'relocate') throw new Error('整理计划类型不匹配')
  j.status = 'running'; j.conflicts = []; save(d, j)
  try {
    if (j.bound) {
      // The reference graph and this flag committed together. A restart only owes cleanup;
      // rebinding from the old snapshot would reject our own changes or overwrite later edits.
      for (const f of j.files) await cleanupStage(f)
      j.status = 'applied'; save(d, j); return publicJournal(j)
    }
    checkDestination(p.root, p.targetDirectory)
    checkDirectoryOwner(d, j.survivorId, p.targetDirectory, p.bundleId, true)
    if (p.request.mode === 'copy') {
      ensureTargetDirectory(j)
      for (const relative of p.directories || []) ensureTargetDirectory(j, resolveBundlePath(p.targetDirectory, relative))
    }
    const bundle = validateBundle(p.request.mode === 'copy' ? p.sourceDirectory : p.targetDirectory)
    if (bundle.bundle_id !== p.bundleId) throw new Error('清单 UUID 已变化，未重绑目录')
    for (const f of j.files) {
      if (['switched', 'copied'].includes(f.status)) continue
      f.attempts++; f.error = ''; save(d, j)
      try {
        if (p.request.mode === 'copy') await copyVerified(d, j, f)
        else {
          checkDestination(p.root, f.destination)
          if (inspectFile(f.destination).state !== 'present') throw new Error('重绑目标文件不可读')
          const expected = j.snapshot.video_assets.find(a => f.assetIds.includes(a.id) && a.file_size > 0)?.file_size || f.size
          if (expected && fs.statSync(f.destination).size !== expected) throw new Error('重绑目标大小不符')
          f.sha256 = await fileHash(f.destination)
          if (inspectFile(f.source).state === 'present' && await fileHash(f.source) !== f.sha256) throw new Error('新旧目录文件内容不同，未切换引用')
          f.status = 'copied'; save(d, j)
        }
      } catch (error) { f.status = 'failed'; f.error = textError(error); save(d, j) }
    }
    if (j.files.every(f => f.status === 'copied' || f.status === 'switched')) {
      const targetBundle = validateBundle(p.targetDirectory)
      if (targetBundle.bundle_id !== p.bundleId) throw new Error('复制后的清单 UUID 不一致，未切换目录')
      if (p.request.mode === 'copy' && manifestText(p.sourceDirectory) !== manifestText(p.targetDirectory)) throw new Error('复制期间清单发生变化，请重新预览')
      if (p.request.mode === 'copy') {
        const currentDirectories: string[] = [], currentFiles = directoryFiles(p.sourceDirectory, currentDirectories)
        if (JSON.stringify(currentFiles.map(keyPath).sort()) !== JSON.stringify(j.files.map(f => keyPath(f.source)).sort()) || JSON.stringify(currentDirectories.sort()) !== JSON.stringify([...(p.directories || [])].sort())) throw new Error('原目录在复制期间新增或移除了内容，保留原绑定，请回退并重新预览')
      }
      // Recheck every verified destination immediately before switching the directory as one unit.
      for (const f of j.files) {
        if (await fileHash(f.destination) !== f.sha256) throw new Error('目标文件在校验后被修改，未切换目录')
        if ((p.request.mode === 'copy' || inspectFile(f.source).state === 'present') && await fileHash(f.source) !== f.sha256) throw new Error('原文件在复制期间被修改，未切换目录')
      }
      rebindReferences(d, j)
      for (const f of j.files) await cleanupStage(f)
    }
  } catch (error) { j.conflicts.push(textError(error)) }
  j.status = j.bound && !j.conflicts.length ? 'applied' : 'partial'; save(d, j)
  return publicJournal(j)
}
export async function relocateVideoDirectory(d: SqlDb, input: VideoRelocateApplyRequest): Promise<VideoOrganizeJournal> {
  if (input?.preview?.kind !== 'relocate') throw new Error('请先预览目录迁移')
  return locked(d, [input.preview.resourceId], async () => {
    const preview = previewVideoRelocate(d, input.preview.request)
    if (preview.fingerprint !== input.preview.fingerprint) throw new Error('目录或资料已变化，请重新预览')
    if (!preview.canApply) throw new Error(preview.collisions.map(c => c.message).join('；'))
    return runRelocate(d, makeJournal(d, preview, snapshot(d, [preview.resourceId]), preview.request.mode))
  })
}
export async function retryVideoOrganize(d: SqlDb, journalId: string): Promise<VideoOrganizeJournal> {
  const initial = readJournal(d, journalId)
  return locked(d, initial.sourceIds, async () => {
    const j = readJournal(d, journalId)
    if (j.status === 'applied') return publicJournal(j)
    if (j.status === 'rolled-back' || j.status === 'rollback-partial') throw new Error('该日志已经开始回退，请继续回退或重新预览')
    if (j.kind === 'relocate') return runRelocate(d, j)
    if (!j.logicalApplied) {
      if (j.preview.kind !== 'organize') throw new Error('日志中的整理计划无效')
      const prepared = prepareOrganize(d, j.preview.request)
      if (prepared.preview.fingerprint !== j.preview.fingerprint) throw new Error('合并尚未执行且资源已变化，请回退日志并重新预览')
      applyLogical(d, j, prepared)
    }
    if (j.mode === 'logical') { j.status = 'applied'; j.files.forEach(f => { f.status = 'unchanged' }); save(d, j); return publicJournal(j) }
    return runOrganize(d, j)
  })
}

function deleteRow(d: SqlDb, table: Table, key: Row): void {
  d.prepare(`DELETE FROM ${table} WHERE ${Object.keys(key).map(k => `${k} IS ?`).join(' AND ')}`).run(...Object.values(key))
}
function updateFields(d: SqlDb, table: Table, key: Row, fields: Row): void {
  if (!Object.keys(fields).length) return
  d.prepare(`UPDATE ${table} SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE ${Object.keys(key).map(k => `${k} IS ?`).join(' AND ')}`).run(...Object.values(fields), ...Object.values(key))
}
function isAssetObservation(table: Table, field: string): boolean {
  // Library reads refresh these observations; they are neither user edits nor values to restore.
  return table === 'video_assets' && (field === 'state' || field === 'checked_at')
}
function retainedInserts(d: SqlDb, j: Journal): { episodes: Set<string>; assets: Set<string> } {
  const episodes = new Set<string>(), assets = new Set<string>()
  const inserts = j.changes.filter(c => c.before === null)
  const addedEpisodes = new Set(inserts.filter(c => c.table === 'episode').map(c => String(c.key.id)))
  const addedAssets = new Set(inserts.filter(c => c.table === 'video_assets').map(c => String(c.key.id)))
  for (const c of inserts) {
    if (c.table !== 'episode' && c.table !== 'video_assets') continue
    const current = getRow(d, c.table, c.key)
    if (!current) continue
    if (Object.keys(c.after).some(field => !isAssetObservation(c.table, field) && current[field] !== expectedValue(j, c.table, c.key, field))) (c.table === 'episode' ? episodes : assets).add(String(c.key.id))
    if (c.table === 'episode' && all(d, 'SELECT id FROM video_sources WHERE episode_id = ?', c.key.id).some(source => !inserts.some(change => change.table === 'video_sources' && change.key.id === source.id))) episodes.add(String(c.key.id))
  }
  const links = all(d, 'SELECT * FROM video_episode_assets')
  for (const l of links) {
    if (addedEpisodes.has(l.episode_id) && !inserts.some(c => c.table === 'video_episode_assets' && c.key.episode_id === l.episode_id && c.key.asset_id === l.asset_id)) episodes.add(l.episode_id)
    if (addedAssets.has(l.asset_id) && !inserts.some(c => c.table === 'video_episode_assets' && c.key.episode_id === l.episode_id && c.key.asset_id === l.asset_id)) assets.add(l.asset_id)
  }
  let changed = true
  while (changed) {
    const size = episodes.size + assets.size
    for (const link of links) {
      if (episodes.has(link.episode_id) && addedAssets.has(link.asset_id)) assets.add(link.asset_id)
      if (assets.has(link.asset_id) && addedEpisodes.has(link.episode_id)) episodes.add(link.episode_id)
    }
    changed = size !== episodes.size + assets.size
  }
  return { episodes, assets }
}

function rollbackOwnership(d: SqlDb, j: Journal, retained: ReturnType<typeof retainedInserts>) {
  const existing = all(d, 'SELECT id, resource_id, season, episode FROM episode')
  const desired = new Map(existing.map(e => [String(e.id), String(e.resource_id)]))
  for (const c of j.changes) {
    if (c.table !== 'episode') continue
    if (c.before?.resource_id && desired.get(String(c.key.id)) === c.after.resource_id) desired.set(String(c.key.id), String(c.before.resource_id))
    if (c.before === null && c.originId && retained.episodes.has(String(c.key.id)) && desired.get(String(c.key.id)) === j.survivorId) desired.set(String(c.key.id), c.originId)
  }
  const blockedAssets = new Set<string>(), blockedEpisodes = new Set<string>()
  const slots = new Map<string, string>()
  for (const ep of existing) {
    const slot = `${desired.get(ep.id)}:${ep.season}:${ep.episode}`, other = slots.get(slot)
    if (other) { blockedEpisodes.add(other); blockedEpisodes.add(ep.id) }
    else slots.set(slot, ep.id)
  }
  for (const asset of all(d, 'SELECT id FROM video_assets')) {
    const links = all(d, 'SELECT episode_id FROM video_episode_assets WHERE asset_id = ?', asset.id)
    const owners = new Set(links.map(l => desired.get(l.episode_id)).filter(Boolean))
    if (owners.size > 1 || links.some(l => blockedEpisodes.has(l.episode_id))) {
      blockedAssets.add(asset.id)
      for (const l of links) blockedEpisodes.add(l.episode_id)
    }
  }
  // Shared files form a graph. A conflict found late must also protect earlier assets of that episode.
  const relations = all(d, 'SELECT * FROM video_episode_assets')
  let changed = true
  while (changed) {
    const count = blockedAssets.size + blockedEpisodes.size
    for (const link of relations) {
      if (blockedAssets.has(link.asset_id)) blockedEpisodes.add(link.episode_id)
      if (blockedEpisodes.has(link.episode_id)) blockedAssets.add(link.asset_id)
    }
    changed = count !== blockedAssets.size + blockedEpisodes.size
  }
  return { blockedAssets, blockedEpisodes }
}
function carryEpisodeDependencies(d: SqlDb, episodeId: string, from: string, to: string): void {
  // These can have been added by the user after the merge. Their identity/metadata remain untouched.
  for (const a of all(d, 'SELECT a.* FROM video_assets a JOIN video_episode_assets ea ON ea.asset_id = a.id WHERE ea.episode_id = ?', episodeId)) {
    if (a.resource_id === from) updateFields(d, 'video_assets', { id: a.id }, { resource_id: to })
  }
  for (const s of all(d, 'SELECT id FROM video_sources WHERE episode_id = ? AND resource_id = ?', episodeId, from)) updateFields(d, 'video_sources', { id: s.id }, { resource_id: to })
}

/** Undo only our fields. Later progress, notes, metadata, extra versions and file choices survive. */
export async function rollbackVideoOrganize(d: SqlDb, journalId: string): Promise<VideoOrganizeJournal> {
  const initial = readJournal(d, journalId)
  return locked(d, initial.sourceIds, async () => {
    const j = readJournal(d, journalId)
    const manifestUndoPending = j.kind === 'organize' && j.manifest.before !== null && !!(j.manifest.afterHash || j.manifest.pendingHash)
    if (j.status === 'rolled-back' && !manifestUndoPending) return publicJournal(j)
    j.conflicts = []
    const newer = all(d, 'SELECT id, data FROM video_organize_journal WHERE rowid > (SELECT rowid FROM video_organize_journal WHERE id = ?)', j.id)
      .map(row => JSON.parse(row.data) as Journal).find(other => other.status !== 'rolled-back' && other.sourceIds.some(id => j.sourceIds.includes(id)))
    if (newer) throw new Error('这些作品还有后续整理，请先回退较新的日志：' + newer.id)
    const unsafeSources = new Set<string>()
    if (j.mode !== 'logical') for (const f of j.files) {
      if (!f.sha256 || f.action === 'keep' || f.status === 'unchanged') continue
      const affected = j.changes.some(c => !c.undone && (Object.values(c.before || {}).includes(f.source) || c.pathMap?.from === f.source))
      if (!affected) continue
      try {
        if (f.action === 'move' && !fs.existsSync(f.source)) {
          if (await fileHash(f.destination) !== f.sha256) throw new Error('移动后的文件已变化，不能回退覆盖原位置')
          fs.mkdirSync(path.dirname(f.source), { recursive: true })
          checkDestination(path.dirname(f.source), f.source)
          await fs.promises.copyFile(f.destination, f.source, fs.constants.COPYFILE_EXCL)
          f.sourceRemoved = false; f.originalRetained = true; save(d,j)
          j.warnings.push('已恢复移动的源文件，目标校验副本保留：' + f.source)
        }
        if (await fileHash(f.source) !== f.sha256) throw new Error('原文件内容已变化')
        if (await fileHash(f.destination) !== f.sha256) throw new Error('副本含有后续文件修改')
      } catch (error) {
        unsafeSources.add(keyPath(f.source))
        j.conflicts.push(`保留当前文件引用：${f.source}（${textError(error)}）`)
      }
    }
    if (j.preview.kind === 'relocate' && !fs.existsSync(j.preview.sourceDirectory)) {
      j.status = 'rollback-partial'; j.conflicts.push('原目录离线或已移走，保留当前目录绑定和观看历史'); save(d, j); return publicJournal(j)
    }
    const retained = retainedInserts(d, j)
    const ownership = rollbackOwnership(d, j, retained)
    const knownEpisodes = new Set([...j.snapshot.episode.map(e => e.id), ...j.changes.filter(c => c.table === 'episode' && c.before === null).map(c => c.key.id)])
    const newUserEpisodes = all(d, 'SELECT id FROM episode WHERE resource_id = ?', j.survivorId).some(e => !knownEpisodes.has(e.id))
    const retainedAtSurvivor = j.changes.some(c => c.table === 'episode' && c.before === null && c.originId === j.survivorId && retained.episodes.has(String(c.key.id)))
    try { tx(d, j, () => {
      for (let index = j.changes.length - 1; index >= 0; index--) {
        const c = j.changes[index]
        if (c.undone) continue
        const current = getRow(d, c.table, c.key)
        if (!current) {
          if (c.before === null) c.undone = true
          else j.conflicts.push('记录已被后续操作删除，未从旧快照覆盖恢复：' + c.table + ' ' + JSON.stringify(c.key))
          continue
        }
        try {
          // Keep the temporary-number and ownership changes together across partial rollback.
          if (c.table === 'episode' && ownership.blockedEpisodes.has(String(c.key.id))) throw new Error('共享文件归属尚未解除，保留这一集的编号和归属')
          if (c.before === null) {
            const keepEpisode = c.table === 'episode' && retained.episodes.has(String(c.key.id))
            const keepAsset = c.table === 'video_assets' && retained.assets.has(String(c.key.id))
            const keepLink = c.table === 'video_episode_assets' && (retained.episodes.has(String(c.key.episode_id)) || retained.assets.has(String(c.key.asset_id)))
            if (keepEpisode || keepAsset || keepLink) {
              if ((keepEpisode || keepAsset) && c.originId && current.resource_id === j.survivorId) {
                if (!getRow(d, 'resource', { id: c.originId })) throw new Error('原作品不存在，保留修改后的内容项')
                if (keepEpisode && ownership.blockedEpisodes.has(String(c.key.id)) || keepAsset && ownership.blockedAssets.has(String(c.key.id))) throw new Error('后续共享资产跨越回退后的作品，保留当前归属')
                if (keepEpisode) carryEpisodeDependencies(d, String(c.key.id), j.survivorId, c.originId)
                updateFields(d, c.table, c.key, { resource_id: c.originId })
                if (keepEpisode) updateFields(d, 'video_meta', { resource_id: c.originId }, { video_type: 'series' })
              }
              j.warnings.push('保留整理后修改或新增关联的内容：' + c.table + ' ' + JSON.stringify(c.key))
              c.undone = true; continue
            }
            if (c.table === 'video_directories' && (unsafeSources.size || newUserEpisodes || retainedAtSurvivor)) throw new Error('目录中仍有后续内容或当前文件引用，保留绑定')
            if (Object.keys(c.after).some(field => !isAssetObservation(c.table, field) && current[field] !== c.after[field])) throw new Error('新增记录已被后续操作修改，未删除')
            if (c.table === 'video_assets' && one(d, 'SELECT episode_id FROM video_episode_assets WHERE asset_id = ?', c.key.id)) throw new Error('新增资产仍有关联内容，未删除')
            if (c.table === 'episode' && (one(d, 'SELECT id FROM video_sources WHERE episode_id = ?', c.key.id) || one(d, 'SELECT asset_id FROM video_episode_assets WHERE episode_id = ?', c.key.id))) throw new Error('新增内容仍有后续关联，未删除')
            deleteRow(d, c.table, c.key); c.undone = true; continue
          }
          if (c.pathMap) {
            if (unsafeSources.has(keyPath(c.pathMap.from))) throw new Error('原文件不可安全恢复，保留当前列表路径')
            updateFields(d, c.table, c.key, { [c.pathMap.field]: pathFields(current[c.pathMap.field], c.pathMap.to, c.pathMap.from) })
            c.undone = true; continue
          }
          const restore: Row = {}
          let conflict = false
          if (c.table === 'video_directories' && unsafeSources.size) throw new Error('有文件无法回退，保留当前目录绑定')
          if (c.table === 'video_directories' && Object.keys(c.after).some(field => current[field] !== c.after[field] && current[field] !== c.before![field])) throw new Error('目录绑定已被后续操作修改，未覆盖')
          for (const [field, after] of Object.entries(c.after)) {
            if (isAssetObservation(c.table, field)) continue
            const before = c.before[field]
            if (current[field] === before) continue
            if (field === 'video_type' && before === 'movie' && (newUserEpisodes || retainedAtSurvivor)) { j.warnings.push('保留后续内容所需的多视频展示方式'); continue }
            if (current[field] !== after) { conflict = true; j.conflicts.push(`保留后续字段修改：${c.table}.${field} ${JSON.stringify(c.key)}`); continue }
            if (field === 'resource_id' && (c.table === 'episode' && ownership.blockedEpisodes.has(String(c.key.id)) || c.table === 'video_assets' && ownership.blockedAssets.has(String(c.key.id)) || c.table === 'video_sources' && ownership.blockedEpisodes.has(String(current.episode_id)))) {
              conflict = true; j.conflicts.push('后续共享资产跨越原作品，保留当前归属：' + c.table + ' ' + JSON.stringify(c.key)); continue
            }
            if (typeof before === 'string' && path.isAbsolute(before) && ['path', 'source_dir', 'poster_path', 'fanart_path', 'icon_path', 'directory_path', 'root'].includes(field)) {
              if (unsafeSources.has(keyPath(before)) || unsafeSources.size && c.table === 'resource' && field === 'path' && samePath(String(after), j.targetDirectory)) { conflict = true; continue }
            }
            restore[field] = before
          }
          if (c.table === 'episode' && restore.resource_id) carryEpisodeDependencies(d, String(c.key.id), String(current.resource_id), String(restore.resource_id))
          updateFields(d, c.table, c.key, restore)
          c.undone = !conflict
        } catch (error) {
          // A failed write can follow restored sibling owners. Roll the entire transaction back,
          // including journal progress, rather than committing a split episode/asset/source graph.
          if (/^(?:ERR_SQLITE|SQLITE_)/.test(String((error as { code?: string })?.code || ''))) throw error
          j.conflicts.push(`${c.table} ${JSON.stringify(c.key)}：${textError(error)}`)
        }
      }
      for (const f of j.files) f.status = unsafeSources.has(keyPath(f.source)) ? 'retained' : 'rolled-back'
      // File publication is outside SQLite. Keep rollback resumable until its manifest is restored.
      j.status = j.conflicts.length || manifestUndoPending ? 'rollback-partial' : 'rolled-back'
    }) } catch (error) {
      j.status = 'rollback-partial'; j.conflicts.push('数据库回退失败，已保留完整归属，可重试：' + textError(error))
      save(d, j); return publicJournal(j)
    }
    if (manifestUndoPending) {
      try {
        const current = manifestText(j.targetDirectory)
        if (current !== j.manifest.before && current !== null && [j.manifest.afterHash, j.manifest.pendingHash].includes(hash(current))) {
          checkDestination(j.preview.root, path.join(j.targetDirectory, 'baoyi.json'))
          atomicWrite(path.join(j.targetDirectory, 'baoyi.json'), j.manifest.before!)
        } else if (current !== j.manifest.before) throw new Error('资源清单已有后续修改，保留当前清单')
        j.manifest.afterHash = ''; j.manifest.pendingHash = ''
      } catch (error) { j.conflicts.push(textError(error)) }
    }
    j.status = j.conflicts.length ? 'rollback-partial' : 'rolled-back'
    j.warnings = [...new Set(j.warnings)]; j.conflicts = [...new Set(j.conflicts)]
    save(d, j)
    return publicJournal(j)
  })
}
