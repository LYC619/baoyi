import { getDb } from '../../services/storage/database'
/**
 * 软件模块与 Electron / 真实库之间的接缝。
 *
 * 和游戏模块的 service.ts 同一个分工：纯逻辑在 icons.ts 那种文件里（自检跑得动），
 * 这里只做「真拷文件、真落库」，不放任何判断规则。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SoftwareItem } from '../../../src/types'
import { getSoftware, listSoftware, updateSoftware } from './db.ts'
import { iconsDir } from '../../services/storage/database'
import { extractIcon } from '../../services/media/iconExtractor'
import { ICON_EXTS, iconFileName, iconSiblings, isIconExt, isManualIcon } from './icons.ts'

/** 清掉这个条目的所有手动图标文件（含换过扩展名留下的孤儿） */
function dropManualIcons(id: string): void {
  const dir = iconsDir()
  for (const name of iconSiblings(id)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch { // best-effort
      /* 正被渲染进程占用之类，删不掉就留着，下次换图标会覆盖 */
    }
  }
}

/**
 * 换图标：把用户选的图**拷进** userData 下的 icons/，再把路径写进库。
 *
 * 拷而不是记一个指向原图的路径 —— 和游戏封面同一个理由，第二条是决定性的：
 *   · 原图被挪走、被删、在没插的移动硬盘上时，卡片墙会整片破图；
 *   · 打包后页面跑在 `file://` 下，`<img src="C:\...">` 加载不出来，
 *     必须走 `baoyi://icon/` 协议，而那个协议只在白名单目录里找文件。
 */
export function setSoftwareIcon(
  id: string,
  source: string
): { ok: boolean; message: string } {
  if (!getSoftware(getDb(), id)) return { ok: false, message: '找不到这个条目' }

  const from = path.resolve(source)
  if (!isIconExt(from)) {
    return { ok: false, message: `只认这些格式：${ICON_EXTS.join('、')}` }
  }
  if (!fs.existsSync(from)) return { ok: false, message: '这个文件不在了' }

  // 换扩展名时旧文件不会被覆盖，先整个清一遍再拷 —— 不清就会留下一个谁也不引用的
  // 孤儿，而它和新图标同名不同扩展名，看着像是没换成功
  dropManualIcons(id)

  const name = iconFileName(id, from)
  try {
    fs.copyFileSync(from, path.join(iconsDir(), name))
  } catch (err: any) {
    return { ok: false, message: `拷贝失败：${err?.message ?? '未知错误'}` }
  }

  updateSoftware(getDb(), id, { icon_path: path.join(iconsDir(), name) })
  return { ok: true, message: '图标已更换' }
}

/**
 * 撤掉手动图标，退回自动提取的那张。
 *
 * 这里**不清空 icon_path 了事** —— 那样界面会退到首字占位，而这个条目的 exe
 * 可能本来是能提出图标的，用户看到的就是「撤销之后比原来更差」。所以撤销时
 * 重新提一次：提到了就用它，提不到才落到占位。
 *
 * 磁盘上那份拷贝一起删，留着只是占地方。
 */
export async function clearSoftwareIcon(id: string): Promise<SoftwareItem | null> {
  const item = getSoftware(getDb(), id)
  if (!item) return null

  dropManualIcons(id)

  const auto = await extractIcon(item.exe_path)
  return updateSoftware(getDb(), id, { icon_path: auto })
}

/**
 * 把全库的自动图标重提一遍。
 *
 * ## 为什么非要有这个入口
 *
 * 修好提取逻辑**对已经入库的条目没有任何效果** —— `extractIcon` 只在识别时被调，
 * 而老条目不会重新识别。用户装上修好的版本，看到的还是原来那批通用图标，
 * 现象和「这个 bug 没修」一模一样。
 *
 * 光靠「重新识别」也不行：那要烧 token 重跑一遍 AI，而图标和 AI 一点关系都没有。
 *
 * ## 手改过的图标一律不动
 *
 * 判据是 `isManualIcon`（文件名是 `<条目 id>.<扩展名>` 还是 `<sha1>-N.png`）。
 * 判错的方向不对称：把手动当自动 = 用户亲手挑的图被这个按钮悄悄换掉，
 * 而他按下去时想的是「把读不到的那些补上」，不是「重置我的设置」。
 */
export async function refreshSoftwareIcons(): Promise<{
  total: number
  changed: number
  manual: number
  failed: number
}> {
  // 归档的也要一起提：`listSoftware({})` 默认只回 `is_archived = 0`，
  // 只查一次的话归档条目永远刷不到，而界面照样报「换了 N 张」——
  // 那一条静静地留着空白图，用户没有任何线索知道为什么
  const items = [...listSoftware(getDb(), {}), ...listSoftware(getDb(), { group: 'archived' })]
  const out = { total: items.length, changed: 0, manual: 0, failed: 0 }

  for (const item of items) {
    if (isManualIcon(item.id, item.icon_path)) {
      out.manual++
      continue
    }
    const icon = await extractIcon(item.exe_path)
    if (!icon) {
      out.failed++
      continue
    }
    if (icon !== item.icon_path) {
      updateSoftware(getDb(), item.id, { icon_path: icon })
      out.changed++
    }
  }
  return out
}


function withinDir(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

export function relocateSoftware(
  id: string,
  entry: string,
  directory?: string
): SoftwareItem {
  const db = getDb()
  const item = getSoftware(db, id)
  if (!item) throw new Error('软件条目已不存在')
  const file = path.resolve(entry)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('请选择有效的程序或安装包文件')
  const conflict = db
    .prepare('SELECT id FROM resource WHERE path = ? COLLATE NOCASE AND id <> ?')
    .get(file, id)
  if (conflict) throw new Error('所选文件已登记在另一条记录下，请先处理重复条目')

  const oldRoot = path.resolve(item.source_dir || path.dirname(item.exe_path))
  let newRoot = directory ? path.resolve(directory) : path.dirname(file)
  const oldRel = path.relative(oldRoot, item.exe_path)
  if (
    !directory &&
    withinDir(oldRoot, item.exe_path) &&
    file.toLowerCase().endsWith((path.sep + oldRel).toLowerCase())
  ) {
    newRoot = file.slice(0, -(oldRel.length + 1))
  }
  if (!fs.statSync(newRoot).isDirectory() || !withinDir(newRoot, file)) {
    throw new Error('主程序必须位于所选软件目录内')
  }
  const rebasePath = (p: string): string =>
    p && withinDir(oldRoot, path.resolve(p)) ? path.join(newRoot, path.relative(oldRoot, p)) : p

  const launchers = item.launchers.map((l) => {
    if (l.path.toLowerCase() === item.exe_path.toLowerCase()) {
      return { ...l, path: file }
    }
    return { ...l, path: rebasePath(l.path) }
  })

  const updated = updateSoftware(db, id, {
    exe_path: file,
    source_dir: newRoot,
    file_name: path.basename(file),
    file_size: stat.size,
    launchers
  })
  if (!updated) throw new Error('更新软件路径失败')
  return updated
}

export function appendSoftwareLauncher(id: string, targetPath: string): SoftwareItem {
  const db = getDb()
  const item = getSoftware(db, id)
  if (!item) throw new Error('软件条目已不存在')
  const file = path.resolve(targetPath)
  const stat = fs.statSync(file)
  if (!stat.isFile() || !/\.(?:exe|bat|cmd|lnk)$/i.test(file)) {
    throw new Error('请选择 .exe、.bat、.cmd 或 .lnk 启动文件')
  }
  if (item.launchers.some((l) => l.path.toLowerCase() === file.toLowerCase())) {
    throw new Error('这个启动文件已在当前条目的启动列表中')
  }
  const label = path.basename(file, path.extname(file))
  const launchers = [
    ...item.launchers,
    { path: file, label, kind: 'extra' as const, is_default: false }
  ]
  const updated = updateSoftware(db, id, { launchers })
  if (!updated) throw new Error('添加启动项失败')
  return updated
}
