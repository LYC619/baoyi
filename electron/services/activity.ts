/**
 * 「外部活跃时间」—— 一个软件最近一次被用过的近似值。
 *
 * last_used_at 只记「用户通过抱一启动过」，所以刚导入完整个库都是「从未使用」。
 * 那不是事实，只是抱一还没开始记账。绿色软件的 exe 本身几乎不动，但它同目录下的
 * 配置文件（.ini / .cfg / .json…）会随每次使用被改写 —— 取这些文件里最新的 mtime，
 * 就能把「装了没碰过」和「上周还在用」区分开。读不到配置就退回 exe 自己的 mtime。
 *
 * 没有 electron 和数据库依赖，selfcheck 可以直接 import。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 会随使用被改写的配置 / 状态文件。刻意不含 .dll .exe —— 那些只随版本更新变 */
const CONFIG_EXTS = new Set([
  '.ini', '.cfg', '.conf', '.config', '.settings',
  '.json', '.xml', '.yml', '.yaml', '.toml',
  '.dat', '.db', '.sqlite', '.log', '.history', '.bak'
])

/** 一层目录最多看多少个文件。撞上塞了几万个文件的目录时不至于把注册拖死 */
const MAX_ENTRIES = 400

function mtimeOf(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/**
 * 读 exe 所在目录（不递归）里配置文件的最新修改时间，退化到 exe 自己的 mtime。
 * 返回 0 表示读不出任何有意义的时间。
 *
 * ponytail: 只看 exe 那一层。把配置写在 data\ 或 profile\ 子目录里的软件会被低估成
 * exe 的 mtime。要更准就得递归一层再按目录名挑，代价是每次注册多几十次 stat；
 * 当前精度已经足够把「从未使用」和「一年没碰」分开，那才是这个字段要回答的问题。
 */
export function readExternalActiveAt(exePath: string): number {
  let latest = mtimeOf(exePath)

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.dirname(exePath), { withFileTypes: true })
  } catch {
    return sane(latest)
  }

  let seen = 0
  for (const entry of entries) {
    if (++seen > MAX_ENTRIES) break
    if (!entry.isFile()) continue
    if (!CONFIG_EXTS.has(path.extname(entry.name).toLowerCase())) continue
    const t = mtimeOf(path.join(path.dirname(exePath), entry.name))
    if (t > latest) latest = t
  }
  return sane(latest)
}

/**
 * 落在未来的 mtime 一律不信 —— 跨时区解压、系统时间被改过都会造出这种值，
 * 而一个「明年才被用过」的时间会让「长期未用」永远筛不到它。
 */
function sane(ts: number): number {
  return ts > 0 && ts <= Date.now() ? ts : 0
}
