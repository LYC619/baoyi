import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import { IMAGE_EXTENSIONS } from './scanner.ts'
import { MAX_IMAGE_BYTES, readArchiveEntry } from './archive.ts'

const MIME: Record<string,string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.bmp':'image/bmp', '.avif':'image/avif' }
export function imageMime(data: Uint8Array): string {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (b.length < 12) throw new Error('图片数据不完整')
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (b.length < 24 || b.readUInt32BE(16) * b.readUInt32BE(20) > 100000000) throw new Error('图片像素数过大')
    return 'image/png'
  }
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.toString('ascii',0,3) === 'GIF') return 'image/gif'
  if (b.toString('ascii',0,2) === 'BM') return 'image/bmp'
  if (b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return 'image/webp'
  if (b.toString('ascii',4,8) === 'ftyp' && /avif|avis/.test(b.toString('ascii',8,24))) return 'image/avif'
  throw new Error('不是受支持的图片数据')
}
/** Identity-based protocol: the renderer never supplies filesystem paths. */
export async function readImagePage(db: SqlDb, id: string, includeMissing = false): Promise<{ data: Buffer; mime: string }> {
  const row = db.prepare(`SELECT p.file,p.entry,r.path FROM image_pages p JOIN resource r ON r.id=p.resource_id JOIN image_meta m ON m.resource_id=r.id
    WHERE p.id=? AND ${includeMissing ? '1=1' : 'p.missing=0'} AND (m.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND g.hidden=1))`).get(id) as { file: string; entry: string; path: string } | undefined
  if (!row) throw new Error('页面不可用')
  const file = await fs.realpath(row.file), root = await fs.realpath(row.path)
  const relative = path.relative(root, file)
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('图片已移到导入目录外，请重新定位')
  const ext = path.extname(row.entry || file).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error('不支持的图片格式')
  if (!row.entry && (await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('图片超过 64 MB')
  const data = row.entry ? await readArchiveEntry(file, row.entry) : await fs.readFile(file)
  const mime = imageMime(data)
  if (mime !== MIME[ext]) throw new Error('图片格式与扩展名不符')
  return { data, mime }
}
