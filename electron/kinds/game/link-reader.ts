import fs from 'node:fs'
import path from 'node:path'
import type { LinkedFile } from '../../../src/types'
import type { GameLinkState, GameLinkText } from '../../../src/types/game-project'
import { hasLink } from './links.ts'

export function gameLinkStates(links: LinkedFile[]): GameLinkState[] {
  return links.map(link => {
    let exists = false, file = false
    try { const stat = fs.statSync(link.path); exists = true; file = stat.isFile() } catch { /* missing or offline */ }
    return { path:link.path, exists, readable:file && /\.(md|txt)$/i.test(link.path) }
  })
}

export async function readGameLink(links: LinkedFile[], target: string): Promise<GameLinkText> {
  if (!hasLink(links,target)) throw new Error('这份资料未关联到当前游戏')
  if (!/\.(md|txt)$/i.test(target)) throw new Error('内置阅读支持 Markdown 和 TXT；其他格式请用系统打开')
  const file = await fs.promises.open(target,'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024*1024) throw new Error('内置阅读支持不超过 1 MB 的文本文件')
    // Bounded read also handles a file growing after stat().
    const bytes = Buffer.alloc(1024*1024+1)
    const { bytesRead } = await file.read(bytes,0,bytes.length,0)
    if (bytesRead > 1024*1024) throw new Error('文本超过 1 MB，请用系统打开')
    const data = bytes.subarray(0,bytesRead)
    const text = data[0]===0xff&&data[1]===0xfe ? data.subarray(2).toString('utf16le') : data.toString('utf8').replace(/^\uFEFF/,'')
    return { path:target, text, format:path.extname(target).toLowerCase()==='.md'?'markdown':'text' }
  } finally { await file.close() }
}
