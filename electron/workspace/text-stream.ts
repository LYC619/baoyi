import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

export interface NovelChapter { index: number; title: string; byteOffset: number; byteLength: number; characterCount?: number }
export interface NovelIndexResult { version: string; encoding: string; fileSize: number; chapters: NovelChapter[]; isChunked: boolean }
const CHAPTER_REGEX = /^[ \t\u3000]*(?:第[0-9一二三四五六七八九十百千万零〇两]+[章回卷节篇部集话]|[0-9]{1,5}[.、\s]+|序章|序言|前言|楔子|尾声|后记|番外|终章|结语)[ \t\u3000]*[^\r\n，。！？；]{0,40}$/
const MAX_CHUNK_BYTES = 48 * 1024

export class TextStreamService {
  private cacheDir: string
  constructor(cacheDir: string) { this.cacheDir = cacheDir }
  async sniffEncoding(filePath: string): Promise<'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'> {
    const handle = await fs.open(filePath, 'r')
    try {
      const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.min(65536, size))
      await handle.read(buffer, 0, buffer.length, 0)
      if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8'
      if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le'
      if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be'
      for (const encoding of ['utf-8', 'gb18030'] as const) {
        try { new TextDecoder(encoding, { fatal: true }).decode(buffer, { stream: buffer.length < size }); return encoding } catch { /* sample may be another encoding */ }
      }
      throw new Error('无法识别文本编码，请选择编码后重试')
    } finally { await handle.close() }
  }
  async indexNovel(filePath: string, userEncoding?: string): Promise<NovelIndexResult> {
    const stat = await fs.stat(filePath), encoding = userEncoding || await this.sniffEncoding(filePath)
    if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(encoding)) throw new Error('不支持的文本编码')
    const version = createHash('sha256').update([filePath, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex')
    // v2 invalidates indexes with approximate newline/encoding byte counts.
    const cacheFile = path.join(this.cacheDir, createHash('sha256').update('v2:' + version + ':' + encoding).digest('hex') + '.json')
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as NovelIndexResult
      if (cached.version === version && cached.encoding === encoding) return cached
    } catch { /* cache miss */ }
    const heads: Array<{ title: string; byteOffset: number }> = [], cuts: number[] = []
    const decoder = new TextDecoder(encoding, { fatal: true }), line = Buffer.alloc(512)
    let lineLength = 0, lineStart = 0, blockStart = 0, absolute = 0, start = 0
    let carry = Buffer.alloc(0), sawCR = false
    const finishLine = () => {
      if (lineLength > 0 && lineLength <= line.length) {
        const title = new TextDecoder(encoding, { fatal: true }).decode(line.subarray(0, lineLength)).trim()
        if (title && title.length <= 64 && CHAPTER_REGEX.test(title)) heads.push({ title, byteOffset: lineStart })
      }
      lineLength = 0
    }
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      const buffer = Buffer.concat([carry, chunk as Buffer])
      try { decoder.decode(chunk as Buffer, { stream: true }) } catch { throw new Error('文本编码不匹配，请切换编码后重试') }
      let offset = 0
      if (absolute === 0) {
        start = encoding === 'utf-8' && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3
          : encoding.startsWith('utf-16') && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) ? 2 : 0
        offset = start; lineStart = start; blockStart = start
      }
      while (offset < buffer.length) {
        const b = buffer[offset]
        let length = 1, code = b
        if (encoding.startsWith('utf-16')) {
          if (offset + 2 > buffer.length) break
          code = encoding === 'utf-16le' ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
          length = code >= 0xd800 && code <= 0xdbff ? 4 : 2
        } else if (encoding === 'utf-8') {
          length = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
        } else if (b >= 0x81 && b <= 0xfe) {
          if (offset + 2 > buffer.length) break
          length = buffer[offset + 1] >= 0x30 && buffer[offset + 1] <= 0x39 ? 4 : 2
        }
        if (offset + length > buffer.length) break
        const position = absolute + offset
        if (position + length - blockStart > MAX_CHUNK_BYTES) { cuts.push(position); blockStart = position }
        if (code === 13 || code === 10) {
          if (!(code === 10 && sawCR)) finishLine()
          lineStart = position + length; sawCR = code === 13
        } else {
          sawCR = false
          if (lineLength + length <= line.length) buffer.copy(line, lineLength, offset, offset + length)
          lineLength += length
        }
        offset += length
      }
      carry = Buffer.from(buffer.subarray(offset)); absolute += offset
    }
    try { decoder.decode() } catch { throw new Error('文本编码不匹配或文件不完整，请切换编码后重试') }
    if (carry.length) throw new Error('文本结尾存在不完整字符')
    finishLine()
    const isChunked = heads.length === 0
    if (!heads.length || heads[0].byteOffset > start) heads.unshift({ title: isChunked ? '正文' : '开篇', byteOffset: start })
    const chapters: NovelChapter[] = []
    let cutIndex = 0
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i], end = heads[i + 1]?.byteOffset ?? stat.size
      let cursor = head.byteOffset, part = 1
      while (cutIndex < cuts.length && cuts[cutIndex] <= cursor) cutIndex++
      while (end - cursor > MAX_CHUNK_BYTES) {
        const next = cuts[cutIndex++]
        if (next === undefined || next >= end) break
        chapters.push({ index: chapters.length, title: head.title + ' · ' + part++, byteOffset: cursor, byteLength: next - cursor })
        cursor = next
      }
      if (end > cursor) chapters.push({ index: chapters.length, title: part === 1 ? head.title : head.title + ' · ' + part, byteOffset: cursor, byteLength: end - cursor })
    }
    const after = await fs.stat(filePath)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('索引期间原文件已变化，请重试')
    const result = { version, encoding, fileSize: stat.size, chapters, isChunked }
    await fs.mkdir(this.cacheDir, { recursive: true })
    await fs.writeFile(cacheFile, JSON.stringify(result), 'utf8')
    return result
  }
  async sliceText(filePath: string, byteOffset: number, byteLength: number, encoding = 'utf-8') {
    const data = await this.readRange(filePath, byteOffset, byteLength, 512 * 1024)
    return { text: new TextDecoder(encoding, { fatal: true }).decode(data), byteOffset, byteLength: data.length }
  }
  async readPdfRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
    return this.readRange(filePath, offset, length, 1024 * 1024)
  }
  private async readRange(filePath: string, offset: number, length: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > limit) throw new Error('文件读取区间无效')
    const handle = await fs.open(filePath, 'r')
    try {
      const size = (await handle.stat()).size
      if (offset > size) throw new Error('文件读取区间越界')
      const buffer = Buffer.alloc(Math.min(length, size - offset)), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return new Uint8Array(buffer.subarray(0, bytesRead))
    } finally { await handle.close() }
  }
}
