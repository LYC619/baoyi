import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'
import type { LinkedFile } from '../../../src/types'
import type { GameExcelSheet, GamePreview } from '../../../src/types/game-workspace.ts'
import { hasLink } from './links.ts'

const TEXT_LIMIT = 200 * 1024
const ZIP_LIMIT = 8 * 1024 * 1024
const PDF_LIMIT = 32 * 1024 * 1024
const IMAGE_LIMIT = 6 * 1024 * 1024
const TOTAL_IMAGE_LIMIT = 16 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  processEntities: false
})
const list = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const value = (v: any): string => (typeof v === 'object' && v !== null ? String(v['#text'] ?? '') : String(v ?? ''))

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

// Read only named OOXML entries. No extraction, macros, formulas or external links.
function zipEntries(data: Buffer): Map<string, () => Buffer> {
  let e = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      e = i
      break
    }
  }
  if (e < 0) throw Error('工作簿 ZIP 结构不完整')
  const count = data.readUInt16LE(e + 10)
  if (count > 2000) throw Error('工作簿条目过多')
  let at = data.readUInt32LE(e + 16)
  let total = 0
  const entries = new Map<string, () => Buffer>()
  for (let i = 0; i < count; i++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw Error('工作簿目录损坏')
    const method = data.readUInt16LE(at + 10)
    const compressed = data.readUInt32LE(at + 20)
    const size = data.readUInt32LE(at + 24)
    const nameLen = data.readUInt16LE(at + 28)
    const extra = data.readUInt16LE(at + 30)
    const comment = data.readUInt16LE(at + 32)
    const local = data.readUInt32LE(at + 42)
    total += size
    if (total > 32 * 1024 * 1024 || size > ZIP_LIMIT) throw Error('工作簿解压大小超过预览上限')
    const name = data.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    at += 46 + nameLen + extra + comment
    entries.set(name, () => {
      if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw Error('工作簿数据损坏')
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
      if (start + compressed > data.length) throw Error('工作簿数据截断')
      const raw = data.subarray(start, start + compressed)
      const out = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: ZIP_LIMIT }) : null
      if (!out || out.length !== size) throw Error('不支持的工作簿压缩格式')
      return out
    })
  }
  return entries
}

function parseSheetRows(worksheetXml: any, shared: string[]): { rows: string[][]; truncated: boolean } {
  const source = list(worksheetXml.worksheet?.sheetData?.row)
  const rows = source.slice(0, 50).map((row) => {
    const cells: string[] = []
    for (const cell of list(row.c)) {
      const letters = String(cell['@r'] || '').match(/^[A-Z]+/)?.[0] || 'A'
      let col = 0
      for (const c of letters) col = col * 26 + c.charCodeAt(0) - 64
      if (col > 50) continue
      const raw =
        cell['@t'] === 's'
          ? shared[Number(value(cell.v))] || ''
          : cell['@t'] === 'inlineStr'
            ? value(cell.is?.t) || list(cell.is?.r).map((r) => value(r.t)).join('')
            : value(cell.v)
      cells[col - 1] = raw.slice(0, 2000)
    }
    return Array.from({ length: Math.max(1, cells.length) }, (_, i) => cells[i] || '')
  })
  return { rows, truncated: source.length > 50 }
}

function workbook(data: Buffer) {
  const entries = zipEntries(data)
  const read = (name: string) => {
    const get = entries.get(name)
    if (!get) throw Error('缺少工作表数据')
    const text = get().toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('工作簿不能包含外部实体')
    return xml.parse(text)
  }
  const sheets = list(read('xl/workbook.xml').workbook?.sheets?.sheet)
  if (!sheets.length) throw Error('没有可预览的工作表')
  const rels = list(read('xl/_rels/workbook.xml.rels').Relationships?.Relationship)
  const shared = entries.has('xl/sharedStrings.xml')
    ? list(read('xl/sharedStrings.xml').sst?.si).map((s) =>
        s.t !== undefined ? value(s.t) : list(s.r).map((r) => value(r.t)).join('')
      )
    : []

  const allSheets: GameExcelSheet[] = []
  for (const [idx, sheet] of sheets.slice(0, 20).entries()) {
    const rel = rels.find((r) => r['@Id'] === sheet['@r:id'])
    if (!rel || rel['@TargetMode'] === 'External') {
      if (idx === 0) throw Error('不支持外部工作表')
      continue
    }
    const sheetPath = path.posix.normalize(
      String(rel['@Target']).startsWith('/') ? String(rel['@Target']).slice(1) : 'xl/' + rel['@Target']
    )
    if (!sheetPath.startsWith('xl/')) {
      if (idx === 0) throw Error('工作表位置无效')
      continue
    }
    if (!entries.has(sheetPath)) {
      if (idx === 0) throw Error('缺少工作表数据')
      continue
    }
    const parsed = parseSheetRows(read(sheetPath), shared)
    allSheets.push({ name: String(sheet['@name'] || `工作表 ${idx + 1}`), ...parsed })
  }
  if (!allSheets.length) throw Error('没有可预览的工作表')
  return {
    sheets: sheets.map((s) => String(s['@name'] || '工作表')),
    rows: allSheets[0].rows,
    truncated: allSheets[0].truncated,
    allSheets
  }
}

async function collectLocalMarkdownImages(
  markdown: string,
  guideFile: string,
  gameRoots: string[]
): Promise<Record<string, string>> {
  const guideDir = path.resolve(path.dirname(guideFile))
  const allowedRoots = [...new Set([guideDir, ...gameRoots.filter(Boolean).map((r) => path.resolve(r))])]
  const refs = new Set<string>()
  const re = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const raw = (m[1] || m[2] || '').trim()
    if (raw) refs.add(raw)
    if (refs.size >= 40) break
  }

  const out: Record<string, string> = {}
  let totalBytes = 0
  for (const raw of refs) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue
    let decoded = raw.split('#')[0].split('?')[0]
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      /* keep raw */
    }
    if (!decoded || path.isAbsolute(decoded)) continue
    const resolved = path.resolve(guideDir, decoded)
    if (!allowedRoots.some((root) => within(root, resolved))) continue
    const ext = path.extname(resolved).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) continue
    try {
      const st = await fs.lstat(resolved)
      if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > IMAGE_LIMIT) continue
      if (totalBytes + st.size > TOTAL_IMAGE_LIMIT) break
      const real = await fs.realpath(resolved)
      if (!allowedRoots.some((root) => within(root, real))) continue
      const bytes = await fs.readFile(real)
      totalBytes += bytes.byteLength
      out[raw] = `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      /* missing local image */
    }
  }
  return out
}

export async function previewGameLink(
  links: LinkedFile[],
  target: string,
  gameRoots: string[] = []
): Promise<GamePreview> {
  if (!hasLink(links, target)) throw Error('这份资料未关联到当前游戏')
  const ext = path.extname(target).toLowerCase()
  const handle = await fs.open(target, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw Error('请选择文件预览')
    const base = { path: target, text: '', bytes: stat.size, truncated: false }
    if (ext === '.pdf') {
      if (stat.size < 5 || stat.size > PDF_LIMIT) return { ...base, kind: 'unsupported' }
      const header = Buffer.alloc(5)
      const { bytesRead } = await handle.read(header, 0, 5, 0)
      if (bytesRead < 5 || header.toString('latin1') !== '%PDF-') return { ...base, kind: 'unsupported' }
      const full = Buffer.alloc(stat.size)
      const readRes = await handle.read(full, 0, stat.size, 0)
      return { ...base, kind: 'pdf', data: new Uint8Array(full.subarray(0, readRes.bytesRead)) }
    }
    if (!['.md', '.txt', '.xlsx'].includes(ext)) return { ...base, kind: 'unsupported' }
    const limit = ext === '.xlsx' ? ZIP_LIMIT : TEXT_LIMIT
    if (ext === '.xlsx' && stat.size > limit) throw Error('表格超过 8 MB，请使用系统程序打开')
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, Math.min(bytesRead, limit))
    if (ext === '.xlsx') {
      if (bytesRead > limit) throw Error('表格超过预览上限')
      return { ...base, kind: 'xlsx', ...workbook(data) }
    }
    const partial = bytesRead > limit || stat.size > limit
    let text: string
    if (data[0] === 255 && data[1] === 254) text = new TextDecoder('utf-16le').decode(data, { stream: partial })
    else if (data[0] === 254 && data[1] === 255) text = new TextDecoder('utf-16be').decode(data, { stream: partial })
    else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: partial })
      } catch {
        text = new TextDecoder('gb18030').decode(data, { stream: partial })
      }
    }
    const images = ext === '.md' ? await collectLocalMarkdownImages(text, target, gameRoots) : undefined
    return {
      ...base,
      kind: ext === '.md' ? 'md' : 'txt',
      text,
      truncated: bytesRead > limit || stat.size > limit,
      ...(images && Object.keys(images).length ? { images } : {})
    }
  } finally {
    await handle.close()
  }
}
