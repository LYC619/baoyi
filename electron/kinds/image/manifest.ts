import fs from 'node:fs/promises'
import path from 'node:path'
import { imageMime } from './files.ts'

export interface ImageManifest {
  version: 1; source: 'pica'; sourceId: string; name: string; description: string; tags: string[];
  publication: 'completed' | 'ongoing';
  chapters: Array<{ directory: string; id: string; title: string; order: number; pageIds?: string[] }>;
  pages: Record<string, { file: string; sha256: string }>;
}
export interface ImageManifestV2 extends Omit<ImageManifest,'version'|'source'|'chapters'|'pages'> {
  version:2;source:'jm';authors:string[];adapterVersion:string;catalogFingerprint:string;selectionComplete:boolean;
  chapters:Array<{directory:string;id:string;title:string;order:number;pageIds:string[]}>;
  pages:Record<string,{file:string;sha256:string;size:number}>;
}
export type AnyImageManifest=ImageManifest|ImageManifestV2
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300
export function manifestPath(root: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('下载清单中的路径无效')
  const file = path.resolve(root, relative), inside = path.relative(root, file)
  if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('下载清单中的路径越界')
  return file
}
export function readImageManifest(directory:string):Promise<AnyImageManifest|null>
export function readImageManifest(directory:string,sourceId:string):Promise<ImageManifest|null>
export function readImageManifest(directory:string,sourceId:string,source:'jm'):Promise<ImageManifestV2|null>
export function readImageManifest(directory:string,sourceId:string,source:'pica'):Promise<ImageManifest|null>
export async function readImageManifest(directory: string, sourceId?: string,source?:'pica'|'jm'): Promise<AnyImageManifest | null> {
  const file = path.join(directory, '.baoyi-image.json')
  let saved: AnyImageManifest
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2) throw new Error('下载清单不安全或过大')
    saved = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
  if (!saved || !(saved.version===1&&saved.source==='pica'||saved.version===2&&saved.source==='jm') || !identifier(saved.sourceId) || sourceId!==undefined&&(saved.sourceId!==sourceId||saved.source!==(source||'pica')) || !Array.isArray(saved.chapters) || !saved.pages || typeof saved.pages !== 'object' || Array.isArray(saved.pages)) throw new Error('目录已有其他作品的清单或清单无效')
  if(saved.version===2){
    if(!/^\d{1,12}$/.test(saved.sourceId)||!Array.isArray(saved.authors)||saved.authors.length>50||saved.authors.some(author=>typeof author!=='string'||!author.trim()||author.length>300)||new Set(saved.authors).size!==saved.authors.length||!identifier(saved.adapterVersion)||!/^[a-f0-9]{64}$/.test(saved.catalogFingerprint)||typeof saved.selectionComplete!=='boolean'||typeof saved.name!=='string'||!saved.name.trim()||saved.name.length>300||typeof saved.description!=='string'||saved.description.length>50000||!Array.isArray(saved.tags)||saved.tags.length>50||saved.tags.some(tag=>typeof tag!=='string'||tag.length>80)||!['ongoing','completed'].includes(saved.publication))throw new Error('漫画来源清单资料无效')
    if(!saved.chapters.length||saved.chapters.length>1000||Object.keys(saved.pages).length>50000)throw new Error('章节或页面清单超出范围')
  }
  const ids = new Set<string>(), dirs = new Set<string>(), files = new Set<string>()
  const orders=new Set<number>(),pageKeys=new Set<string>()
  for (const chapter of saved.chapters) {
    if (!chapter || !identifier(chapter.id) || typeof chapter.title !== 'string' || !Number.isSafeInteger(chapter.order) || ids.has(chapter.id) || typeof chapter.directory!=='string'||dirs.has(chapter.directory.toLowerCase())) throw new Error('章节清单无效')
    manifestPath(directory, chapter.directory)
    if (chapter.directory.includes('/')) throw new Error('章节目录路径无效')
    ids.add(chapter.id); dirs.add(chapter.directory.toLowerCase())
    if (chapter.pageIds !== undefined && (!Array.isArray(chapter.pageIds) || chapter.pageIds.some(id => !identifier(id)) || new Set(chapter.pageIds).size !== chapter.pageIds.length)) throw new Error('页面目录清单无效')
    if(saved.version===2){
      if(!/^\d{1,12}$/.test(chapter.id)||chapter.order<1||orders.has(chapter.order)||!chapter.pageIds?.length||chapter.pageIds.length>20000||chapter.pageIds.some(id=>!/^[a-zA-Z0-9_.-]{1,200}$/.test(id)))throw new Error('章节或页面顺序清单无效')
      if(/[<>:"|?*\x00-\x1f]/.test(chapter.directory)||/[. ]$/.test(chapter.directory)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(chapter.directory))throw new Error('章节目录名称无效')
      orders.add(chapter.order)
      for(const id of chapter.pageIds)pageKeys.add(chapter.id+':'+id)
    }
  }
  for (const [key, page] of Object.entries(saved.pages)) {
    const chapter = saved.chapters.find(c => key.startsWith(c.id + ':'))
    if (!chapter || !identifier(key.slice(chapter.id.length + 1)) || !page || typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error('页面校验清单无效')
    manifestPath(directory, page.file)
    if (page.file.split('/').length !== 2 || !page.file.startsWith(chapter.directory + '/') || files.has(page.file.toLowerCase())) throw new Error('下载清单中的页面路径无效')
    files.add(page.file.toLowerCase())
    if(saved.version===2){
      const size=(page as ImageManifestV2['pages'][string]).size
      if(!/^\d{5}\.png$/.test(page.file.split('/')[1]))throw new Error('漫画页面名称无效')
      if(!pageKeys.has(key)||!Number.isSafeInteger(size)||size<=0||size>64*1024**2)throw new Error('页面校验清单无效')
    }
  }
  if(saved.version===2&&saved.selectionComplete&&pageKeys.size!==Object.keys(saved.pages).length)throw new Error('所选章节页面清单不完整')
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
