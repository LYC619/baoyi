import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { iconsDir } from './database'
import { timeAsync } from './timing.ts'

/**
 * 提取 exe 图标并落盘为 PNG，返回图标文件绝对路径；失败返回空字符串。
 * 渲染进程通过 baoyi://icon/<filename> 协议读取（见 main.ts）。
 *
 * ponytail: app.getFileIcon 在 Windows 上 'large' 只有 32x32，
 * 放大到卡片的 48px 会略糊。要更高清需改成用 resedit 解析 PE 的 RT_GROUP_ICON。
 */
export async function extractIcon(exePath: string): Promise<string> {
  return timeAsync(`extractIcon ${path.basename(exePath)}`, () => extractIconInner(exePath))
}

async function extractIconInner(exePath: string): Promise<string> {
  const name = createHash('sha1').update(exePath.toLowerCase()).digest('hex') + '.png'
  const target = path.join(iconsDir(), name)

  if (fs.existsSync(target)) return target

  try {
    const image = await app.getFileIcon(exePath, { size: 'large' })
    if (image.isEmpty()) return ''
    const png = image.toPNG()
    if (png.length === 0) return ''
    fs.writeFileSync(target, png)
    return target
  } catch {
    return ''
  }
}
