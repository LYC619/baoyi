/**
 * 无外部依赖的文件读取helpers。
 *
 * 单独成文件的理由和 paths.ts 一样：不依赖 electron / 数据库，
 * 才能被 scripts/agent-selfcheck.ts 直接验证。
 * 这里最容易出错的是编码判断 —— 它出错不会抛异常，只会把一屏乱码喂给模型。
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 允许读的扩展名。目标是说明文档，不是让 agent 翻遍整个目录 */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.nfo', '.me', '.1st',
  '.ini', '.cfg', '.conf', '.yml', '.yaml', '.json', '.xml', '.url'
])

/** 没有扩展名、但一看就是说明文件的常见命名 */
const DOC_STEMS =
  /^(readme|read.?me|license|licence|copying|changelog|changes|history|install|notice|authors|version|about|使用说明|说明|注意事项|更新日志|版本说明)/i

export function isReadableName(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  if (ext) return TEXT_EXTS.has(ext)
  return DOC_STEMS.test(name)
}

/** 单次最多从文件里读多少字节 */
const READ_MAX_BYTES = 256 * 1024
/** 回灌给模型的字符上限，给 loop 的 6000 字符留出余量 */
const READ_MAX_CHARS = 4000

/**
 * 严格 UTF-8 解码。缓冲区末尾可能截断在多字节字符中间，所以最多退 3 个字节重试，
 * 否则会把一个好端端的 UTF-8 文件误判成 GBK。
 */
function decodeUtf8Strict(buf: Buffer): string | null {
  for (let drop = 0; drop <= 3 && drop < buf.length; drop++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - drop))
    } catch {
      /* 继续退一格 */
    }
  }
  return null
}

/**
 * 国内绿色软件的 readme 大量是 GBK，按 UTF-8 读会得到一屏乱码 ——
 * 那比读不到更糟，agent 会拿着乱码去猜。所以按 BOM → 严格 UTF-8 → GBK 的顺序试。
 */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16LE' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16BE' }
  }

  const utf8 = decodeUtf8Strict(buf)
  if (utf8 !== null) return { text: utf8, encoding: 'UTF-8' }

  try {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'GBK' }
  } catch {
    // 运行时没带 GBK 码表，宽松 UTF-8 兜底：有乱码好过直接失败
    return { text: buf.toString('utf8'), encoding: '未知' }
  }
}

/** 无 BOM 的文本不该含 NUL；含了基本可以断定是二进制 */
export function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 1024))
  return probe.includes(0)
}

function hasBom(buf: Buffer): boolean {
  return (
    (buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf[0] === 0xfe && buf[1] === 0xff) ||
    (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
  )
}

/**
 * 读一个说明文档并整理成回灌给模型的文本。
 * 传进来的路径必须已经过 paths.ts 的白名单校验。
 */
export async function readTextFile(file: string): Promise<string> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(file)
  } catch {
    throw new Error(`文件不存在或无法访问：${file}`)
  }
  if (!stat.isFile()) throw new Error(`${file} 不是文件`)
  if (!isReadableName(path.basename(file))) {
    throw new Error(
      `${path.basename(file)} 不是可读的文本文件。这个工具只用来读说明文档（README、changelog、使用说明等），exe 请用 get_file_info。`
    )
  }
  if (stat.size === 0) return `${file} 是空文件。`

  const cap = Math.min(stat.size, READ_MAX_BYTES)
  const buf = Buffer.alloc(cap)
  const handle = await fsp.open(file, 'r')
  try {
    await handle.read(buf, 0, cap, 0)
  } finally {
    await handle.close()
  }

  if (!hasBom(buf) && looksBinary(buf)) {
    throw new Error(`${path.basename(file)} 看起来是二进制文件，读不出有意义的文本。`)
  }

  const { text, encoding } = decodeText(buf)
  // 连续空行压掉，省 token
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!cleaned) return `${file} 里没有可读内容。`

  const body =
    cleaned.length > READ_MAX_CHARS
      ? `${cleaned.slice(0, READ_MAX_CHARS)}\n…（后续内容已省略）`
      : cleaned

  return [
    `文件：${file}（${formatSize(stat.size)}，${encoding}${cap < stat.size ? '，只读取了开头部分' : ''}）`,
    '---',
    body
  ].join('\n')
}
