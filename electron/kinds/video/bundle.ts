import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ensureBundleId } from './identity.ts'
import { numberedEpisode } from './episode-identity.ts'
import type { VideoBundle, VideoSourceRef } from '../../../src/types/video-library.ts'

const INVALID = /[<>:"/\\|?*\x00-\x1f\x7f]/g
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

export function safeWorkFolderName(title: string): string {
  let name = String(title || '未命名作品').normalize('NFC').replace(INVALID, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  name = name.replace(/\s*(?:第\s*\d+\s*集|ep(?:isode)?\s*\d+|s\d{1,2}e\d{1,3})\s*$/i, '').trim() || name
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name
  return name.length > 90 ? name.slice(0, 78).replace(/[. ]+$/g, '') + '-' + hash(name).slice(0, 8) : name || '未命名作品'
}

/** Reject absolute paths, traversal, and links escaping the work directory. */
export function resolveBundlePath(directory: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /[\x00-\x1f]/.test(relative)) throw new Error('资源包路径无效')
  const root = path.resolve(directory)
  const target = path.resolve(root, relative)
  const rel = path.relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('资源包包含目录外路径：' + relative)
  if (fs.existsSync(root)) {
    let ancestor = target
    while (!fs.existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor)
    const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor))
    if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new Error('资源包路径通过链接指向目录外')
  }
  return target
}

export function readVideoBundle(directory: string): VideoBundle | null {
  const file = path.join(directory, 'baoyi.json')
  if (!fs.existsSync(file)) return null
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('清单超过大小上限')
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8')) as VideoBundle
    if (bundle.schema_version !== 1 || !/^[0-9a-f-]{16,64}$/i.test(bundle.bundle_id || '') || !bundle.work?.title?.trim() || !Array.isArray(bundle.work.sources) || !Array.isArray(bundle.items) || bundle.items.length > 10000) throw new Error('版本不受支持或缺少作品资料')
    if (bundle.work.poster) resolveBundlePath(directory, bundle.work.poster)
    if (bundle.work.thumbnail) resolveBundlePath(directory, bundle.work.thumbnail)
    for (const item of bundle.items) {
      if (!item || !Array.isArray(item.files) || !Array.isArray(item.sources) || item.number != null && !Number.isInteger(item.number) || item.season != null && !Number.isInteger(item.season)) throw new Error('内容列表格式无效')
      if (item.poster) resolveBundlePath(directory, item.poster)
      if (item.thumbnail) resolveBundlePath(directory, item.thumbnail)
      for (const a of item.attachments || []) resolveBundlePath(directory, a.path)
      for (const asset of item.files) resolveBundlePath(directory, asset.path)
    }
    return bundle
  } catch (error) { throw new Error('资源清单无法读取，已保留原文件：' + (error instanceof Error ? error.message : String(error))) }
}

export interface VideoEpisodeSidecar {
  schema_version: 1
  kind: 'video-episode'
  bundle_id: string
  work_title: string
  file: { name: string; quality: string; size: number }
  episode: Omit<VideoBundle['items'][number], 'files'>
}

export function episodeSidecarPath(videoPath: string): string {
  const file = path.parse(videoPath)
  return path.join(file.dir, file.name + '.baoyi.json')
}

export function readEpisodeSidecar(videoPath: string): VideoEpisodeSidecar | null {
  const file = episodeSidecarPath(videoPath)
  if (!fs.existsSync(file)) return null
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('单集资料超过大小上限')
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as VideoEpisodeSidecar
  if (data.schema_version !== 1 || data.kind !== 'video-episode' || !/^[0-9a-f-]{16,64}$/i.test(data.bundle_id || '')
    || !data.episode?.id || typeof data.episode.title !== 'string' || !Array.isArray(data.episode.sources) || data.file?.name !== path.basename(videoPath)
    || data.episode.number != null && !Number.isInteger(data.episode.number) || data.episode.season != null && !Number.isInteger(data.episode.season)) throw new Error('单集资料与视频文件不匹配：' + path.basename(file))
  if (data.episode.poster) resolveBundlePath(path.dirname(videoPath), data.episode.poster)
  if (data.episode.thumbnail) resolveBundlePath(path.dirname(videoPath), data.episode.thumbnail)
  return data
}

export function atomicWrite(file: string, contents: string | Buffer): void {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + randomUUID())
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx'); fs.writeFileSync(fd, contents); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

/** Used by downloads, local sync and physical organization. Existing user files are preserved. */
export function writeVideoEpisodeSidecars(directory: string, bundle: VideoBundle): string[] {
  const warnings: string[] = []
  const save = (relative: string, contents: string | Buffer) => {
    let target = resolveBundlePath(directory, relative)
    const digest = hash(contents)
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) !== digest && bundle.managed_files[relative] !== hash(fs.readFileSync(target))) {
      const parsed = path.parse(relative)
      relative = path.join(parsed.dir, parsed.name + '.baoyi-' + digest.slice(0, 8) + parsed.ext).split(path.sep).join('/')
      target = resolveBundlePath(directory, relative)
      warnings.push('保留已有用户资料：' + parsed.base)
    }
    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== digest) { fs.mkdirSync(path.dirname(target), { recursive: true }); atomicWrite(target, contents) }
    bundle.managed_files[relative] = digest
    return relative
  }
  for (const item of bundle.items) for (const file of item.files) {
    const videoPath = resolveBundlePath(directory, file.path)
    if (!fs.existsSync(videoPath)) continue
    const { files: _versions, ...episode } = item
    for (const role of ['poster', 'thumbnail'] as const) if (episode[role]) {
      const image = resolveBundlePath(directory, episode[role]!)
      if (!fs.existsSync(image)) { episode[role] = ''; continue }
      const relative = path.relative(path.dirname(videoPath), image)
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) episode[role] = relative.split(path.sep).join('/')
      else {
        const bytes = fs.readFileSync(image)
        const local = path.join(path.dirname(file.path), '.baoyi', 'artwork', hash(bytes).slice(0, 24) + path.extname(image))
        const copied = save(local.split(path.sep).join('/'), bytes)
        episode[role] = path.relative(path.dirname(videoPath), resolveBundlePath(directory, copied)).split(path.sep).join('/')
      }
    }
    episode.attachments = (item.attachments || []).flatMap(a => {
      const relative = path.relative(path.dirname(videoPath), resolveBundlePath(directory, a.path))
      return relative.startsWith('..') || path.isAbsolute(relative) ? [] : [{ ...a, path: relative.split(path.sep).join('/') }]
    })
    const sidecar: VideoEpisodeSidecar = { schema_version: 1, kind: 'video-episode', bundle_id: bundle.bundle_id, work_title: bundle.work.title,
      file: { name: path.basename(file.path), quality: file.quality, size: file.size }, episode }
    save(path.relative(directory, episodeSidecarPath(videoPath)).split(path.sep).join('/'), JSON.stringify(sidecar, null, 2) + '\n')
  }
  return warnings
}

export function ensureWorkDirectory(root: string, title: string): string {
  const directory = path.join(path.resolve(root), safeWorkFolderName(title))
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

/** Reserve a directory without creating an empty library card. */
export function reserveWorkDirectory(root: string, title: string, identity: string, bundleId = ensureBundleId()): { directory: string; bundleId: string; warning: string } {
  const base = path.join(path.resolve(root), safeWorkFolderName(title))
  fs.mkdirSync(path.resolve(root), { recursive: true })
  let directory = base
  for (let attempt = 0; attempt < 100; attempt++) {
    if (attempt) directory = base + ' [' + hash(identity).slice(0, 8) + (attempt > 1 ? '-' + attempt : '') + ']'
    if (!fs.existsSync(directory)) fs.mkdirSync(directory)
    if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) continue
    const marker = path.join(directory, '.baoyi-owner.json')
    if (fs.existsSync(marker)) {
      try { const owner = JSON.parse(fs.readFileSync(marker, 'utf8')); if (owner.identity === identity) return { directory, bundleId: ensureBundleId(owner.bundleId), warning: attempt ? '同名目录已被占用，使用独立作品目录' : '' } } catch { /* Preserve unknown directories. */ }
      continue
    }
    if (fs.readdirSync(directory).length) continue
    fs.writeFileSync(marker, JSON.stringify({ identity, bundleId }), { flag: 'wx' })
    return { directory, bundleId, warning: attempt ? '同名目录已被占用，使用独立作品目录' : '' }
  }
  throw new Error('无法分配作品目录，请更换影视库根目录')
}

export function writeBundleFiles(input: {
  directory: string; bundleId?: string; title: string; description?: string; originalDescription?: string; category?: string; tags?: string[]; source?: string; sources?: VideoSourceRef[]
  files: Array<{ publishedAt?: number; airDate?: number; durationSec?: number; studio?: string; id?: string; path: string; title: string; order: number; label?: string; season?: number | null; number?: number | null; quality?: string; size?: number; sourceId?: string; sources?: VideoSourceRef[]; originalTitle?: string; description?: string; originalDescription?: string; tags?: string[]; thumbnailPath?: string; thumbnailSource?: string; posterSource?: string; attachments?: VideoBundle['items'][number]['attachments']; posterPath?: string; sourceUrl?: string; notes?: string; watch?: VideoBundle['items'][number]['watch'] }>
  thumbnail?: { path: string; source?: string };
  replaceContents?: boolean; excludedFiles?: string[]; excludedSources?: string[];
  poster?: { path: string; source?: string }; missing?: string[]; descriptionOptional?: boolean
  contents?: VideoBundle['items']; replaceWorkTitle?: boolean; episodePosters?: Record<string, string>
}): { bundle: VideoBundle; warnings: string[] } {
  const directory = path.resolve(input.directory)
  fs.mkdirSync(directory, { recursive: true })
  const previous = readVideoBundle(directory)
  if (previous && input.bundleId && previous.bundle_id !== input.bundleId) throw new Error('目录已有另一作品清单，未覆盖')
  const warnings: string[] = []
  const managedFiles = { ...(previous?.managed_files || {}) }
  const saveManaged = (relative: string, contents: string | Buffer): string => {
    let target = resolveBundlePath(directory, relative)
    const digest = hash(contents)
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) !== digest && managedFiles[relative] !== hash(fs.readFileSync(target))) {
      const parsed = path.parse(relative)
      relative = path.join(parsed.dir, parsed.name + '.baoyi-' + digest.slice(0, 8) + parsed.ext).split(path.sep).join('/')
      target = resolveBundlePath(directory, relative)
      warnings.push('保留已有用户资料：' + path.basename(parsed.base))
    }
    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== digest) { fs.mkdirSync(path.dirname(target), { recursive: true }); atomicWrite(target, contents) }
    managedFiles[relative] = digest
    return relative
  }
  const portableImage = (file?: string): string => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || !/\.(jpg|jpeg|png|webp|avif|gif)$/i.test(file)) return ''
    const relative = path.relative(directory, path.resolve(file)).split(path.sep).join('/')
    if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)) { resolveBundlePath(directory, relative); return relative }
    const bytes = fs.readFileSync(file)
    return saveManaged('.baoyi/artwork/' + hash(bytes).slice(0, 24) + path.extname(file).toLowerCase(), bytes)
  }
  const posterRelative = portableImage(input.poster?.path) || previous?.work.poster || ''
  const thumbnailRelative = portableImage(input.thumbnail?.path) || previous?.work.thumbnail || ''
  const items = new Map((input.replaceContents ? [] : previous?.items || []).map(item => [item.id || item.files[0]?.path, item]))
  for (const entry of input.contents || []) {
    const known = [...items.entries()].find(([, old]) => old.id === entry.id || entry.sources.some(source => old.sources.some(value => value.provider === source.provider && value.externalId === source.externalId)))
    if (known) items.delete(known[0])
    items.set(entry.id, { ...known?.[1], ...entry, files: entry.files })
  }
  for (const [index, file] of input.files.entries()) {
    const relative = path.relative(directory, path.resolve(file.path)).split(path.sep).join('/')
    resolveBundlePath(directory, relative)
    const nextFile = { path: relative, quality: file.quality || '', size: file.size || fs.statSync(file.path).size }
    const sources = file.sources || (file.sourceId ? [{ provider: 'hanime', externalId: file.sourceId, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + file.sourceId, evidence: 'playlist' as const }] : [])
    const sourceKey = (s: VideoSourceRef) => `${s.provider}:${s.scope}:${s.externalId}`.toLowerCase()
    const sourceKeys = new Set(sources.map(sourceKey))
    const matched = [...items.values()].find(item => item.id === file.id || (item.sources || []).some(s => sourceKeys.has(sourceKey(s))) || item.files.some(asset => asset.path.toLowerCase() === relative.toLowerCase()))
    const id = matched?.id || file.id || (sources.length ? sourceKey(sources[0]) : `season:${file.season ?? 0}:item:${file.number ?? file.order ?? index + 1}`)
    const old = items.get(id)
    const episodePoster = portableImage(file.posterPath) || old?.poster || ''
    const episodeThumbnail = portableImage(file.thumbnailPath) || old?.thumbnail || ''
    const explicitNumber = Number.isInteger(file.number) && Number(file.number) >= 0
    items.set(id, { ...old, id, title: old?.title || file.title, label: old?.label || file.label || '', order: explicitNumber ? file.order : old?.order ?? file.order, season: explicitNumber ? file.season ?? old?.season ?? null : old?.season ?? file.season ?? null,
      number: explicitNumber ? file.number! : old?.number ?? file.number ?? file.order, sources: old?.sources?.length ? old.sources : sources,
      original_title: old?.original_title || file.originalTitle || '', description: old?.description || file.description || '',
      original_description: old?.original_description || file.originalDescription || '',
      published_at: file.publishedAt || old?.published_at || 0, air_date: file.airDate || old?.air_date || 0,
      duration_sec: file.durationSec || old?.duration_sec || 0, studio: file.studio?.trim() || old?.studio || '',
      tags: file.tags || old?.tags || [], thumbnail: episodeThumbnail, thumbnail_source: file.thumbnailSource || old?.thumbnail_source || '', poster_source: file.posterSource || old?.poster_source || '', attachments: file.attachments || old?.attachments || [],
      poster: episodePoster, source_url: old?.source_url || file.sourceUrl || '', notes: old?.notes || file.notes || '', watch: file.watch || old?.watch,
      files: [...(old?.files || []).filter(existing => existing.path.toLowerCase() !== relative.toLowerCase()), nextFile] })
  }
  const sourceMap = new Map<string, VideoSourceRef>()
  for (const [id, file] of Object.entries(input.episodePosters || {})) {
    const entry = items.get(id)
    if (!entry || entry.files.length || !file || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    const ext = path.extname(file).toLowerCase()
    if (!/^\.(jpg|jpeg|png|webp|avif)$/.test(ext)) continue
    entry.poster = portableImage(file)
  }
  for (const source of [...(previous?.work.sources || []), ...(input.sources || []), ...(input.source ? [{ provider: 'hanime', externalId: input.source, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + input.source, evidence: 'playlist' as const }] : [])]) sourceMap.set(`${source.provider}:${source.scope}:${source.externalId}`.toLowerCase(), source)
  const promoted = !!input.descriptionOptional && !!previous && numberedEpisode(previous.work.title)?.title === input.title.replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  const description = (promoted ? '' : previous?.work.description) || input.description || ''
  const missing = [...new Set([...(input.missing || []), ...(!description && !input.descriptionOptional ? ['description'] : []), ...(!posterRelative ? ['poster'] : [])])]
  const bundle: VideoBundle = {
    excluded_files: input.excludedFiles || previous?.excluded_files || [], excluded_sources: input.excludedSources || previous?.excluded_sources || [],
    schema_version: 1, bundle_id: previous?.bundle_id || ensureBundleId(input.bundleId), revision: (previous?.revision || 0) + 1, updated_at: Date.now(),
    work: { title: (promoted || input.replaceWorkTitle ? '' : previous?.work.title) || input.title, name_en: (promoted ? '' : previous?.work.name_en) || '', description, original_description: (promoted ? '' : previous?.work.original_description) || input.originalDescription || '',
      category: previous?.work.category || input.category || '其他', tags: previous?.work.tags || input.tags || [], sources: [...sourceMap.values()], poster: posterRelative,
      thumbnail: thumbnailRelative, thumbnail_source: input.thumbnail?.source || previous?.work.thumbnail_source || '',
      poster_source: previous?.work.poster_source || input.poster?.source || '', provenance: { ...(previous?.work.provenance || {}), title: 'source', description: description ? 'source' : 'missing' } },
    items: [...items.values()].sort((a, b) => (a.season || 0) - (b.season || 0) || a.order - b.order),
    managed_files: managedFiles, missing
  }
  warnings.push(...writeVideoEpisodeSidecars(directory, bundle))
  const intro = ['# ' + bundle.work.title, '', description || '单集资料见下方各集。', '', '## 已保存内容', ...bundle.items.flatMap(item => [`### ${item.label || '第 ' + item.order + ' 集'} · ${item.original_title || item.title}`, '', item.description || '单集简介暂未取得。', ''])].join('\n') + '\n'
  const introPath = path.join(directory, '简介.md')
  if (!fs.existsSync(introPath) || (previous?.managed_files['简介.md'] && previous.managed_files['简介.md'] === hash(fs.readFileSync(introPath)))) {
    try { atomicWrite(introPath, intro); bundle.managed_files['简介.md'] = hash(intro) } catch (error) { warnings.push('简介保存失败：' + String(error)) }
  } else warnings.push('简介.md 已有用户内容，保留原文件；最新资料已写入清单')
  const manifest = path.join(directory, 'baoyi.json')
  if (previous) atomicWrite(path.join(directory, 'baoyi.json.bak'), fs.readFileSync(manifest))
  atomicWrite(manifest, JSON.stringify(bundle, null, 2) + '\n')
  return { bundle, warnings }
}
