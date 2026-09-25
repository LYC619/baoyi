import fs from 'node:fs/promises'
import path from 'node:path'
import { listArchive, MAX_IMAGE_BYTES } from './archive.ts'
import type { ImageType, ScannedImage, ScannedImagePage } from '../../../src/types/image.ts'

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
export const isArchive = (file: string) => /\.(zip|cbz)$/i.test(file)
const compare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare
const ignored = (name: string) => name.startsWith('.') || name === '__MACOSX'

async function collect(file: string, warnings: string[], depth = 0): Promise<ScannedImagePage[]> {
  if (depth > 20) { warnings.push('目录层级超过 20 层：' + path.basename(file)); return [] }
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink()) { warnings.push('已跳过链接：' + path.basename(file)); return [] }
  if (stat.isDirectory()) {
    const result: ScannedImagePage[] = []
    for (const entry of (await fs.readdir(file)).filter(n => !ignored(n)).sort(compare)) {
      try { result.push(...await collect(path.join(file, entry), warnings, depth + 1)) }
      catch (cause) { warnings.push(path.basename(entry) + '：' + (cause as Error).message) }
      if (result.length > 20000) throw new Error('单个相册或章节超过 20000 页，请拆分目录')
    }
    return result
  }
  if (isArchive(file)) return (await listArchive(file)).filter(e => IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !e.name.split('/').some(ignored)).sort((a,b) => compare(a.name,b.name)).map(e => ({ file, entry: e.name, size: e.size }))
  if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) return []
  if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) { warnings.push('图片为空或超过 64 MB：' + path.basename(file)); return [] }
  return [{ file, entry: '', size: stat.size }]
}
async function scanOne(input: string, type: ImageType): Promise<ScannedImage> {
  const file = await fs.realpath(input), stat = await fs.stat(file)
  const result: ScannedImage = { path: file, type, name: path.basename(file, isArchive(file) ? path.extname(file) : ''), sourceDir: path.dirname(file), chapters: [], warnings: [] }
  if (type === 'photo' || !stat.isDirectory()) {
    result.chapters.push({ key: '.', title: result.name, pages: await collect(file, result.warnings) })
  } else {
    const loose: ScannedImagePage[] = []
    for (const entry of (await fs.readdir(file, { withFileTypes: true })).filter(e => !ignored(e.name)).sort((a,b) => compare(a.name,b.name))) {
      const full = path.join(file, entry.name)
      try {
        if (entry.isSymbolicLink()) { result.warnings.push('已跳过链接：' + entry.name); continue }
        const pages = await collect(full, result.warnings)
        if (entry.isDirectory() || isArchive(full)) { if (pages.length) result.chapters.push({ key: entry.name, title: path.basename(entry.name, isArchive(full) ? path.extname(full) : ''), pages }) }
        else loose.push(...pages)
      } catch (cause) { result.warnings.push(entry.name + '：' + (cause as Error).message) }
    }
    if (loose.length) result.chapters.unshift({ key: '.', title: '未分章', pages: loose })
  }
  if (!result.chapters.some(c => c.pages.length)) result.warnings.push('没有找到可导入的图片')
  if (stat.isDirectory()) {
    try {
      const metadata = path.join(file, '.baoyi-image.json'), info = await fs.lstat(metadata)
      if (!info.isSymbolicLink() && info.size < 8 * 1024 ** 2) {
        const saved = JSON.parse(await fs.readFile(metadata, 'utf8'))
        if (saved.version === 1 && saved.source === 'pica' && typeof saved.sourceId === 'string' && Array.isArray(saved.chapters)) {
          result.source = 'pica'; result.sourceId = saved.sourceId; result.name = String(saved.name || result.name).slice(0,300)
          result.description = String(saved.description || '').slice(0,50000); result.tags = Array.isArray(saved.tags) ? saved.tags.filter((t:unknown)=>typeof t==='string').slice(0,50) : []
          result.publication = saved.publication === 'completed' ? 'completed' : 'ongoing'
          for (const chapter of result.chapters) { const match = saved.chapters.find((c:any)=>c.directory===chapter.key); if(match && typeof match.id === 'string'){chapter.key=match.id;chapter.sourceId=match.id;chapter.title=String(match.title||chapter.title).slice(0,300)} }
        }
      }
    } catch { /* An optional sidecar cannot prevent a local folder from being read. */ }
  }
  if (result.chapters.reduce((sum,c) => sum + c.pages.length, 0) > 50000) throw new Error('单部作品超过 50000 页，请分卷导入')
  return result
}
export async function scanImageImport(root: string, type: ImageType, multiple: boolean): Promise<ScannedImage[]> {
  if (!['photo','comic'].includes(type)) throw new Error('未知图片类型')
  if (!multiple) return [await scanOne(root, type)]
  const result: ScannedImage[] = []
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(e => !ignored(e.name) && !e.isSymbolicLink() && (e.isDirectory() || isArchive(e.name))).sort((a,b) => compare(a.name,b.name))
  if (entries.length > 1000) throw new Error('一次最多导入 1000 个相册／作品')
  for (const entry of entries) {
    try { result.push(await scanOne(path.join(root, entry.name), type)) }
    catch (cause) { result.push({ path: path.join(root, entry.name), type, name: entry.name, sourceDir: root, chapters: [], warnings: [(cause as Error).message] }) }
  }
  return result
}
