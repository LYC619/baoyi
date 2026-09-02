import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { iconsDir } from './database'
import { timeAsync } from './timing.ts'
import { MAX_ICON_BYTES, bestIconPng } from '../kinds/software/peIcon.ts'

/**
 * 提取 exe 图标并落盘为 PNG，返回图标文件绝对路径；失败返回空字符串。
 * 渲染进程通过 baoyi://icon/<filename> 协议读取（见 main.ts）。
 *
 * ## 两条路，PE 优先
 *
 * 1. 自己从 PE 的 RT_GROUP_ICON 里取最大的 PNG 帧（见 peIcon.ts）；
 * 2. 取不到才退回 `app.getFileIcon`。
 *
 * 顺序不能反。`app.getFileIcon` 在**有图标资源的 exe 上也会回 Windows 的通用
 * 程序图标** —— 2026-09-02 在真库 46 条上量到 13 条拿的是同一张 32×32 通用图，
 * 而其中 12 条的 PE 里有 256×256 的真图标。用户报的「空图标」就是这个，
 * 而它三道自动检查全绕过去了（路径非空、文件在、img 渲染成功）。
 */
export async function extractIcon(exePath: string): Promise<string> {
  return timeAsync(`extractIcon ${path.basename(exePath)}`, () => extractIconInner(exePath))
}

/**
 * 缓存文件名带一位版本号。
 *
 * **必需，不是保险**：老版本按 `<sha1>.png` 存过一批通用图标，文件名不变的话
 * 下面第一句 `existsSync` 就直接命中它们 —— 修好的代码对已经入库的条目
 * 一点效果都没有，而现象是「改完还是空图标」。换个名字等于让老缓存自然失效。
 */
const CACHE_VERSION = '2'

function cacheName(exePath: string): string {
  return `${createHash('sha1').update(exePath.toLowerCase()).digest('hex')}-${CACHE_VERSION}.png`
}

/** 上一版的名字。写新的时候顺手删掉，免得图标目录里留一堆再也不会被读的孤儿 */
function legacyName(exePath: string): string {
  return `${createHash('sha1').update(exePath.toLowerCase()).digest('hex')}.png`
}

async function extractIconInner(exePath: string): Promise<string> {
  const target = path.join(iconsDir(), cacheName(exePath))
  if (fs.existsSync(target)) return target

  const png = (await fromPe(exePath)) ?? (await fromShell(exePath))
  if (!png) return ''

  try {
    fs.writeFileSync(target, png)
  } catch {
    return ''
  }

  try {
    fs.rmSync(path.join(iconsDir(), legacyName(exePath)), { force: true })
  } catch {
    /* 删不掉只是留个孤儿，不影响新图标已经写好这件事 */
  }
  return target
}

/**
 * 从 PE 资源里取。**异步读文件，不用 `readFileSync`** —— 上限是 512MB
 * （见 peIcon.ts 的 MAX_ICON_BYTES），同步读那么大的文件就是主进程停摆，
 * 而这个项目已经为「主进程被同步 IO 堵死」付过一次代价了。
 */
async function fromPe(exePath: string): Promise<Buffer | null> {
  try {
    const stat = await fsp.stat(exePath)
    if (stat.size <= 0 || stat.size > MAX_ICON_BYTES) return null
    return bestIconPng(await fsp.readFile(exePath))?.png ?? null
  } catch {
    return null
  }
}

/**
 * 退路。DIB-only 的 exe（真库上 14 条）走这里，拿到的是 48×48 的**真**图标，
 * 不是通用图 —— 所以这条退路是有用的，不是聊胜于无。
 */
async function fromShell(exePath: string): Promise<Buffer | null> {
  try {
    const image = await app.getFileIcon(exePath, { size: 'large' })
    if (image.isEmpty()) return null
    const png = image.toPNG()
    return png.length > 0 ? png : null
  } catch {
    return null
  }
}
