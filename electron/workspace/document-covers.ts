import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import type { SqlDb } from '../services/schema.ts'
import type { CoverResult } from '../../src/types/workspace.ts'
import { DocumentLibrary } from './documents.ts'
import { TextStreamService } from './text-stream.ts'

const MAX_PNG = 2 * 1024 * 1024
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function crc(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
/** Validate PNG structure, checksums and actual decompressed image rows before caching. */
function validPng(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_PNG)
    throw new Error('封面图片超过大小限制')
  const png = Buffer.from(value)
  if (png.length < 45 || !png.subarray(0, 8).equals(signature))
    throw new Error('封面不是有效 PNG')
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0,
    ended = false
  const data: Buffer[] = []
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset),
      end = offset + 12 + length
    if (end > png.length) throw new Error('封面 PNG 已损坏')
    const type = png.toString('ascii', offset + 4, offset + 8),
      chunk = png.subarray(offset + 8, offset + 8 + length)
    if (
      crc(png.subarray(offset + 4, offset + 8 + length)) !==
      png.readUInt32BE(offset + 8 + length)
    )
      throw new Error('封面 PNG 校验失败')
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('封面 PNG 头无效')
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      channels =
        ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[chunk[9]] || 0
      if (
        width < 1 ||
        width > 300 ||
        height < 1 ||
        height > 900 ||
        chunk[8] !== 8 ||
        !channels ||
        chunk[10] ||
        chunk[11] ||
        chunk[12]
      )
        throw new Error('封面 PNG 尺寸或编码无效')
    } else if (type === 'IDAT') data.push(chunk)
    else if (type === 'IEND') {
      ended = true
      offset = end
      break
    }
    offset = end
  }
  if (!ended || offset !== png.length || !width || !data.length)
    throw new Error('封面 PNG 不完整')
  const row = 1 + width * channels,
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: row * height })
  if (raw.length !== row * height) throw new Error('封面 PNG 解码失败')
  for (let y = 0; y < height; y++)
    if (raw[y * row] > 4) throw new Error('封面 PNG 行无效')
  return png
}

interface Source {
  key: string
  file: string
  format: string
  size: number
}
interface Token extends Source {
  db: SqlDb
  documentId: string
  expires: number
}
export class DocumentCovers {
  private tokens = new Map<string, Token>()
  private activeDb?: SqlDb
  private getDb: () => SqlDb
  private directory: string
  private now: () => number
  constructor(getDb: () => SqlDb, directory: string, now = Date.now) {
    this.getDb = getDb
    this.directory = path.resolve(directory)
    this.now = now
  }
  private db() {
    const db = this.getDb()
    if (db !== this.activeDb) {
      this.tokens.clear()
      this.activeDb = db
    }
    return db
  }
  private async fingerprint(db: SqlDb, id: string): Promise<Source> {
    const item = new DocumentLibrary(db).require(id)
    if (!['pdf', 'png', 'jpg', 'jpeg'].includes(item.format))
      throw new Error('使用文字封面')
    const file = await fs.realpath(item.path),
      stat = await fs.lstat(file)
    if (!stat.isFile()) throw new Error('原文件暂不可用')
    if (item.format !== 'pdf' && stat.size > 8 * 1024 * 1024) throw new Error('图片过大，封面暂不可用')
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          file,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          'v1',
          300,
        ]),
      )
      .digest('hex')
    return { key, file, format: item.format, size: stat.size }
  }
  private pruneTokens(id?: string, key?: string) {
    for (const [token, entry] of this.tokens)
      if (
        entry.expires < this.now() ||
        (id === entry.documentId && entry.key !== key)
      )
        this.tokens.delete(token)
    while (this.tokens.size >= 512)
      this.tokens.delete(this.tokens.keys().next().value!)
  }
  async get(documentId: string): Promise<CoverResult> {
    const db = this.db()
    let source: Source
    try {
      source = await this.fingerprint(db, documentId)
    } catch (e) {
      this.pruneTokens(documentId)
      return { state: 'unavailable', reason: (e as Error).message }
    }
    this.pruneTokens(documentId, source.key)
    const cache = path.join(this.directory, source.key + '.png')
    try {
      const stat = await fs.stat(cache)
      if (stat.size > MAX_PNG) throw new Error('oversized cache')
      const png = validPng(await fs.readFile(cache))
      if (
        this.db() !== db ||
        (await this.fingerprint(db, documentId)).key !== source.key
      )
        return this.get(documentId)
      return { state: 'ready', key: source.key, png }
    } catch {
      /* A missing or damaged cache is safely regenerated. */
    }
    if (this.db() !== db)
      return { state: 'unavailable', reason: '资料库已切换' }
    if ((await this.fingerprint(db, documentId)).key !== source.key)
      return this.get(documentId)
    const token = randomUUID()
    this.tokens.set(token, {
      ...source,
      db,
      documentId,
      expires: this.now() + 600000,
    })
    return { state: 'render', key: source.key, token, format: source.format }
  }
  private async current(documentId: string, token: string) {
    const db = this.db(),
      entry = this.tokens.get(token)
    if (
      !entry ||
      entry.db !== db ||
      entry.documentId !== documentId ||
      entry.expires < this.now()
    )
      return null
    try {
      if ((await this.fingerprint(db, documentId)).key !== entry.key) {
        this.tokens.delete(token)
        return null
      }
    } catch {
      this.tokens.delete(token)
      return null
    }
    return entry
  }
  async source(documentId: string, token: string) {
    const entry = await this.current(documentId, token)
    if (!entry) throw new Error('封面来源已变化，请刷新资料')
    if (entry.format === 'pdf') return { format: entry.format, size: entry.size }
    const data = await fs.readFile(entry.file)
    if (data.length !== entry.size || !(await this.current(documentId, token)))
      throw new Error('封面来源已变化，请刷新资料')
    return { format: entry.format, data: new Uint8Array(data), size: entry.size }
  }
  async range(documentId: string, token: string, offset: number, length: number) {
    const entry = await this.current(documentId, token)
    if (!entry || entry.format !== 'pdf') throw new Error('封面来源已变化，请刷新资料')
    const data = await new TextStreamService(this.directory).readPdfRange(entry.file, offset, length)
    if (!(await this.current(documentId, token))) throw new Error('封面来源已变化，请刷新资料')
    return data
  }
  async put(documentId: string, token: string, png: Uint8Array) {
    const entry = await this.current(documentId, token)
    if (!entry) return { stored: false }
    const bytes = validPng(png)
    await fs.mkdir(this.directory, { recursive: true })
    const destination = path.join(this.directory, entry.key + '.png'),
      temporary = path.join(this.directory, randomUUID() + '.tmp')
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' })
      if (!(await this.current(documentId, token))) return { stored: false }
      await fs.rename(temporary, destination)
      if (!(await this.current(documentId, token))) {
        await fs.unlink(destination).catch(() => {})
        return { stored: false }
      }
      this.tokens.delete(token)
      await this.trim()
      return { stored: true }
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  }
  private async trim() {
    const entries = await fs.readdir(this.directory)
    const files = await Promise.all(
      entries
        .filter((n) => /^[a-f0-9]{64}\.png$/.test(n))
        .map(async (name) => {
          const file = path.join(this.directory, name),
            stat = await fs.stat(file)
          return { file, size: stat.size, time: stat.mtimeMs }
        }),
    )
    let size = files.reduce((n, f) => n + f.size, 0)
    for (const file of files.sort((a, b) => a.time - b.time)) {
      if (size <= 256 * 1024 * 1024) break
      await fs.unlink(file.file)
      size -= file.size
    }
  }
}
