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
import { createHash } from 'node:crypto'
import { POSTER_EXTS } from '../../kinds/video/posters.ts'
import { HENTAI_CATEGORY } from '../../kinds/video/taxonomy.ts'
import type { SqlDb } from '../storage/schema.ts'

export interface PosterProtocolContext {
  postersDir: string
  hideHentai: boolean
  /** 库里是不是记着这个绝对路径（poster_path / thumbnail_path 任一列）。由调用方查库 */
  isReferenced: (absolutePath: string) => boolean
  discoveryFile?: (source: string, entry: string) => string
}

const ARTWORK_SEGMENT = /[\\/]\.baoyi[\\/]artwork[\\/][^\\/]+$/i

/** Either the work or an episode must belong to a visible video; a shared image is OK. */
export function posterReferenced(db:SqlDb,file:string,hideHentai:boolean):boolean {
  const select=(table:'video_meta'|'episode')=>`SELECT resource_id FROM ${table}
    WHERE poster_path COLLATE NOCASE IN (@file,@slash) OR thumbnail_path COLLATE NOCASE IN (@file,@slash)`
  const query=`SELECT 1 FROM resource r WHERE r.id IN (${select('video_meta')} UNION ALL ${select('episode')})
    AND r.kind='video' ${hideHentai?'AND r.category != @hidden':''} LIMIT 1`
  return !!db.prepare(query).get({file,slash:file.replaceAll('\\','/'),...(hideHentai?{hidden:HENTAI_CATEGORY}:{})})
}

/** Match the current catalogue entry to the file fetched for its remote cover URL. */
export function discoveryPoster(db: SqlDb, source: string, entry: string, hidden: boolean): string {
  const row = db.prepare(`SELECT json_extract(item.value, '$.coverUrl') AS cover
    FROM video_discovery_sources s, json_each(s.payload, '$.entries') item
    WHERE s.id = ? AND json_extract(item.value, '$.id') = ? AND NOT EXISTS (
      SELECT 1 FROM video_sources vs JOIN resource r ON r.id = vs.resource_id
      WHERE ? = 1 AND vs.provider = 'catalogue:' || s.id AND vs.external_id = ? AND r.category = ?
    ) LIMIT 1`).get(source, entry, Number(hidden), entry, HENTAI_CATEGORY) as { cover: string } | undefined
  if (!row?.cover) return ''
  const hash = createHash('sha256').update(row.cover).digest('hex')
  const cached = db.prepare('SELECT path FROM video_discovery_artwork WHERE url_hash = ?').get(hash) as { path: string } | undefined
  return cached?.path ?? ''
}

/** 从协议 URL 里取出要读的文件；不放行返回空串 */
export function resolvePosterRequest(rawUrl: string, ctx: PosterProtocolContext): string {
  let url: URL
  try { url = new URL(rawUrl) } catch { return '' }
  if (url.hostname !== 'poster') return ''
  if (url.searchParams.has('source') || url.searchParams.has('entry')) {
    const file = ctx.discoveryFile?.(url.searchParams.get('source') ?? '', url.searchParams.get('entry') ?? '')
    return file && path.dirname(file).toLowerCase() === path.resolve(ctx.postersDir).toLowerCase() && /^[a-f0-9]{24}\.png$/i.test(path.basename(file)) ? file : ''
  }
  const encoded = url.searchParams.get('p')
  if (!encoded) return ''
  // URLSearchParams already decoded the path, including literal percent signs.
  if (!path.isAbsolute(encoded) || encoded.includes('\0')) return ''
  const file = path.resolve(encoded)
  if (!POSTER_EXTS.includes(path.extname(file).toLowerCase())) return ''
  if (ctx.hideHentai) return ctx.isReferenced(file) ? file : ''
  if (path.dirname(file).toLowerCase() === path.resolve(ctx.postersDir).toLowerCase()) return file
  if (ARTWORK_SEGMENT.test(file)) return file
  return ctx.isReferenced(file) ? file : ''
}

export async function posterResponse(url:string,ctx:PosterProtocolContext,read:(file:string)=>Promise<Response>) {
  const file=resolvePosterRequest(url,ctx)
  const response=file?await read(file):new Response(null,{status:404})
  const headers=new Headers(response.headers);headers.set('Cache-Control','no-store')
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers})
}
