import fs from 'node:fs/promises'
import path from 'node:path'
import { imageMime } from './files.ts'

export interface ImageManifest {
  version: 1; source: 'pica'; sourceId: string; name: string; description: string; tags: string[];
  publication: 'completed' | 'ongoing';
  chapters: Array<{ directory: string; id: string; title: string; order: number; pageIds?: string[] }>;
  pages: Record<string, { file: string; sha256: string }>;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300
export function manifestPath(root: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('下载清单中的路径无效')
  const file = path.resolve(root, relative), inside = path.relative(root, file)
  if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('下载清单中的路径越界')
  return file
}
export async function readImageManifest(directory: string, sourceId: string): Promise<ImageManifest | null> {
  const file = path.join(directory, '.baoyi-image.json')
  let saved: ImageManifest
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2) throw new Error('下载清单不安全或过大')
    saved = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
  if (!saved || saved.version !== 1 || saved.source !== 'pica' || saved.sourceId !== sourceId || !Array.isArray(saved.chapters) || !saved.pages || typeof saved.pages !== 'object' || Array.isArray(saved.pages)) throw new Error('目录已有其他作品的清单或清单无效')
  const ids = new Set<string>(), dirs = new Set<string>(), files = new Set<string>()
  for (const chapter of saved.chapters) {
    if (!chapter || !identifier(chapter.id) || typeof chapter.title !== 'string' || !Number.isSafeInteger(chapter.order) || ids.has(chapter.id) || dirs.has(chapter.directory)) throw new Error('章节清单无效')
    manifestPath(directory, chapter.directory)
    if (chapter.directory.includes('/')) throw new Error('章节目录路径无效')
    ids.add(chapter.id); dirs.add(chapter.directory)
    if (chapter.pageIds !== undefined && (!Array.isArray(chapter.pageIds) || chapter.pageIds.some(id => !identifier(id)) || new Set(chapter.pageIds).size !== chapter.pageIds.length)) throw new Error('页面目录清单无效')
  }
  for (const [key, page] of Object.entries(saved.pages)) {
    const chapter = saved.chapters.find(c => key.startsWith(c.id + ':'))
    if (!chapter || !identifier(key.slice(chapter.id.length + 1)) || !page || typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error('页面校验清单无效')
    manifestPath(directory, page.file)
    if (page.file.split('/').length !== 2 || !page.file.startsWith(chapter.directory + '/') || files.has(page.file.toLowerCase())) throw new Error('下载清单中的页面路径无效')
    files.add(page.file.toLowerCase())
  }
  return saved
}
export async function readManifestPage(directory: string, relative: string): Promise<Buffer> {
  const file = manifestPath(directory, relative), stat = await fs.lstat(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('页面不是普通文件')
  if (stat.size <= 0 || stat.size > 64 * 1024 ** 2) throw new Error('图片为空或超过 64 MB')
  const root = await fs.realpath(directory), actual = await fs.realpath(file), inside = path.relative(root, actual)
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('页面路径指向作品目录之外')
  const data = await fs.readFile(actual), extension = path.extname(file).toLowerCase()
  const expected: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' }
  if (imageMime(data) !== expected[extension]) throw new Error('图片格式与扩展名不符')
  return data
}
