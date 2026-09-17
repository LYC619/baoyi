/**
 * 一部作品的图片该放在哪个目录。
 *
 * 用户 9-18 拍板：所有海报最终都进视频库，本地明文可读。所以新图一律写进作品目录下的
 * `.baoyi/artwork/`（和清单、单集 sidecar 同一套约定，`bundle.ts` 写的也是这里），
 * 缓存目录只给算不出目录的作品暂放（库里只有链接、没有任何本地文件）。
 *
 * 三种情形，按顺序：
 *   1. 作品绑定了目录（`video_directories`）且目录还在 → `<目录>/.baoyi/artwork`；
 *   2. 没绑定，但 `resource.path`、任一单集或任一视频资产的文件还在 → 该文件所在目录下的
 *      `.baoyi/artwork`（`resource.path` 本身是目录时就是它自己）；
 *   3. 都没有 → 调用方给的兜底（主进程传 `postersDir`）。
 * 不在这里 mkdir：算目录是纯读，建目录留给真要写文件的那一步。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'

const ARTWORK = ['.baoyi', 'artwork']

function isDirectory(file: string): boolean { try { return fs.statSync(file).isDirectory() } catch { return false } }
function exists(file: string): boolean { try { fs.statSync(file); return true } catch { return false } }

export function artworkDirFor(d: SqlDb, resourceId: string, fallback: () => string): string {
  const binding = d.prepare('SELECT directory_path FROM video_directories WHERE resource_id = ?').get(resourceId) as { directory_path: string } | undefined
  if (binding && isDirectory(binding.directory_path)) return path.join(binding.directory_path, ...ARTWORK)
  const resource = d.prepare('SELECT path FROM resource WHERE id = ?').get(resourceId) as { path: string } | undefined
  const files = [
    resource?.path,
    ...(d.prepare('SELECT path FROM episode WHERE resource_id = ? ORDER BY season, episode').all(resourceId) as Array<{ path: string }>).map(row => row.path),
    ...(d.prepare("SELECT path FROM video_assets WHERE resource_id = ? AND role = 'video' ORDER BY created_at").all(resourceId) as Array<{ path: string }>).map(row => row.path)
  ]
  for (const file of files) {
    if (!file || !path.isAbsolute(file) || !exists(file)) continue
    return path.join(isDirectory(file) ? file : path.dirname(file), ...ARTWORK)
  }
  return fallback()
}

/** 这条路径是不是抱一自己的图片目录里的文件（协议放行、迁移判定共用） */
export function insideArtworkDir(file: string): boolean {
  return /[\\/]\.baoyi[\\/]artwork[\\/][^\\/]+$/i.test(file)
}
