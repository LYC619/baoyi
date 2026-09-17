/**
 * `baoyi://poster/` 协议放行规则。纯函数，主进程的协议处理器和 selfcheck 共用一份。
 *
 * 0.8 以前这条协议只在缓存目录里按文件名找图，于是视频库里的图（`.baoyi/artwork`、
 * 片子旁边的 poster.jpg）每次列表都要复制一份进缓存才显示得出来 —— "到处都有海报"
 * 就是这么来的。现在 URL 里带完整路径（`?p=<encodeURIComponent(绝对路径)>`），
 * 这里只负责判断"这个路径能不能给渲染进程看"。
 *
 * 三类放行，其余一律 404：
 *   1. 缓存目录直属文件（`postersDir()` 下一层，不认子目录）；
 *   2. 路径里有 `\.baoyi\artwork\` 这一段，且扩展名在海报名单里 —— 这是抱一自己写的目录，
 *      形状固定；
 *   3. 和数据库里任意一条 `poster_path / thumbnail_path` 完全相等 —— 片子旁边的
 *      `poster.jpg`、单集截图这类用户文件，路径是库里记的，不是渲染进程编的。
 * 全部先 `path.resolve` 再比对，`..` 走不出去；不在名单里的扩展名（.exe、.html）不放行。
 */
import path from 'node:path'
import { POSTER_EXTS } from '../kinds/video/posters.ts'

export interface PosterProtocolContext {
  postersDir: string
  /** 库里是不是记着这个绝对路径（poster_path / thumbnail_path 任一列）。由调用方查库 */
  isReferenced: (absolutePath: string) => boolean
}

const ARTWORK_SEGMENT = /[\\/]\.baoyi[\\/]artwork[\\/][^\\/]+$/i

/** 从协议 URL 里取出要读的文件；不放行返回空串 */
export function resolvePosterRequest(rawUrl: string, ctx: PosterProtocolContext): string {
  let url: URL
  try { url = new URL(rawUrl) } catch { return '' }
  if (url.hostname !== 'poster') return ''
  const encoded = url.searchParams.get('p')
  if (!encoded) return ''
  let file: string
  try { file = path.resolve(decodeURIComponent(encoded)) } catch { return '' }
  if (!path.isAbsolute(file) || file.includes('\0')) return ''
  if (!POSTER_EXTS.includes(path.extname(file).toLowerCase())) return ''
  if (path.dirname(file).toLowerCase() === path.resolve(ctx.postersDir).toLowerCase()) return file
  if (ARTWORK_SEGMENT.test(file)) return file
  return ctx.isReferenced(file) ? file : ''
}
