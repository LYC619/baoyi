import fs from 'node:fs/promises'
import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const inflate = promisify(inflateRaw)
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3
export interface ArchiveEntry { name: string; size: number; compressed: number; offset: number; method: number; crc: number }
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function validName(name: string): boolean {
  return !!name && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && !name.includes(':') && !name.split('/').some(v => v === '..' || v === '.')
}
/** Read only the bounded central directory; never extract archive paths to disk. ZIP64/multivolume/encrypted files are explicitly unsupported. */
export async function listArchive(file: string): Promise<ArchiveEntry[]> {
  const handle = await fs.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (size < 22 || size > MAX_ARCHIVE_BYTES) throw new Error('归档为空或超过 4 GB')
    const tail = Buffer.alloc(Math.min(size, 65557))
    await handle.read(tail, 0, tail.length, size - tail.length)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
    if (eocd < 0) throw new Error('无法读取 ZIP／CBZ 目录')
    const count = tail.readUInt16LE(eocd + 10), bytes = tail.readUInt32LE(eocd + 12), start = tail.readUInt32LE(eocd + 16)
    if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || count !== tail.readUInt16LE(eocd + 8) || count > 20000 || bytes > 8 * 1024 ** 2 || start + bytes > size - tail.length + eocd) throw new Error('不支持分卷、ZIP64 或超大归档目录')
    const dir = Buffer.alloc(bytes)
    if ((await handle.read(dir, 0, bytes, start)).bytesRead !== bytes) throw new Error('归档目录不完整')
    const result: ArchiveEntry[] = [], names = new Set<string>()
    let pos = 0, total = 0
    for (let i = 0; i < count; i++) {
      if (pos + 46 > bytes || dir.readUInt32LE(pos) !== 0x02014b50) throw new Error('归档目录损坏')
      const flags = dir.readUInt16LE(pos + 8), method = dir.readUInt16LE(pos + 10), n = dir.readUInt16LE(pos + 28)
      const end = pos + 46 + n + dir.readUInt16LE(pos + 30) + dir.readUInt16LE(pos + 32)
      if (end > bytes) throw new Error('归档目录越界')
      const nameBytes = dir.subarray(pos + 46, pos + 46 + n)
      const name = (flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }) : new TextDecoder('gb18030', { fatal: true })).decode(nameBytes)
      const entry = { name, size: dir.readUInt32LE(pos + 24), compressed: dir.readUInt32LE(pos + 20), offset: dir.readUInt32LE(pos + 42), method, crc: dir.readUInt32LE(pos + 16) }
      if (!validName(name) || names.has(name.toLowerCase()) || (dir.readUInt32LE(pos + 38) >>> 16 & 0xf000) === 0xa000) throw new Error('归档包含不安全、重复或链接路径')
      if (flags & 1 || ![0, 8].includes(method)) throw new Error('归档加密或使用不支持的压缩方式')
      total += entry.size
      if (entry.size > MAX_IMAGE_BYTES || entry.compressed > MAX_IMAGE_BYTES || total > 2 * 1024 ** 3 || entry.offset + 30 + entry.compressed > start) throw new Error('归档条目超过安全读取限制')
      names.add(name.toLowerCase())
      if (!name.endsWith('/')) result.push(entry)
      pos = end
    }
    return result
  } finally { await handle.close() }
}
export async function readArchiveEntry(file: string, name: string): Promise<Buffer> {
  const entry = (await listArchive(file)).find(e => e.name === name)
  if (!entry) throw new Error('归档内页面已丢失，请重新扫描')
  const handle = await fs.open(file, 'r')
  try {
    const header = Buffer.alloc(30)
    await handle.read(header, 0, 30, entry.offset)
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) & 1 || header.readUInt16LE(8) !== entry.method) throw new Error('归档页面头损坏')
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const data = Buffer.alloc(entry.compressed)
    if ((await handle.read(data, 0, data.length, start)).bytesRead !== data.length) throw new Error('归档页面不完整')
    const output = entry.method === 0 ? data : await inflate(data, { maxOutputLength: MAX_IMAGE_BYTES })
    if (output.length !== entry.size || crc32(output) !== entry.crc) throw new Error('归档页面校验失败')
    return output
  } finally { await handle.close() }
}
