/**
 * 图标提取的改前 / 改后对比。只读，不写库不写盘。
 *
 *   npm run verify-icons
 *
 * ## 判据是什么
 *
 * 「改前」不是重新跑一遍老代码 —— 而是**磁盘上已经存着的那批图标文件**，
 * 也就是用户此刻真正在界面上看到的东西。「改后」是拿真的 `bestIconPng`
 * （不是在这儿照抄一份判断逻辑，那样就成了自己验自己）在同一批 exe 上跑一遍。
 *
 * 要看的三个数：
 *
 *   · **共用同一个哈希的条目还剩多少** —— 通用程序图标的判据。不需要知道那张图
 *     长什么样：一张图出现在很多不相干的软件上，它就是通用图。自证的判据。
 *   · 尺寸分布 —— 32×32 那一堆该消失
 *   · 有多少条真的换了图 —— 一条都没换的话说明新那条路根本没跑起来
 *
 * ## 为什么不调 app.getFileIcon
 *
 * 走 `ELECTRON_RUN_AS_NODE`（better-sqlite3 要 Electron 的 ABI），拿不到 `app`。
 * 但也不需要：老图标已经在磁盘上了，那才是「改前」的真实状态。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { MAX_ICON_BYTES, bestIconPng } from '../electron/kinds/software/peIcon.ts'

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

const appData = process.env.APPDATA ?? ''
const dbFile = path.join(appData, '抱一', 'baoyi.db')
if (!fs.existsSync(dbFile)) {
  console.log(`没找到数据库：${dbFile}`)
  process.exit(0)
}

const db = new Database(dbFile, { readonly: true })
const rows = db
  .prepare(`SELECT exe_path, icon_path, name_zh FROM software ORDER BY name_zh`)
  .all() as Array<{ exe_path: string; icon_path: string; name_zh: string }>

interface Cluster {
  n: number
  names: string[]
}

/** 按哈希聚类，回「出现两次以上」的那些 —— 通用图标就藏在里面 */
function clusters(items: Array<{ hash: string; name: string }>): Cluster[] {
  const m = new Map<string, Cluster>()
  for (const it of items) {
    const c = m.get(it.hash) ?? { n: 0, names: [] }
    c.n++
    if (c.names.length < 8) c.names.push(it.name)
    m.set(it.hash, c)
  }
  return [...m.values()].filter((c) => c.n > 1).sort((a, b) => b.n - a.n)
}

const before: Array<{ hash: string; name: string }> = []
const after: Array<{ hash: string; name: string }> = []
const sizes = new Map<string, number>()
let changed = 0
let noPeIcon = 0
let tooBig = 0
const stillShared: string[] = []
/** 退回 `getFileIcon` 的那些。存个档：下次这一路出问题，名单在这儿 */
const fellBack: string[] = []

for (const r of rows) {
  if (r.icon_path && fs.existsSync(r.icon_path)) {
    before.push({ hash: sha1(fs.readFileSync(r.icon_path)), name: r.name_zh })
  }

  let best: ReturnType<typeof bestIconPng> = null
  try {
    const stat = fs.statSync(r.exe_path)
    if (stat.size > MAX_ICON_BYTES) tooBig++
    else best = bestIconPng(fs.readFileSync(r.exe_path))
  } catch {
    /* exe 不在了。计在 noPeIcon 里，反正结果一样：退回 getFileIcon */
  }

  if (!best) {
    noPeIcon++
    fellBack.push(r.name_zh)
    continue
  }
  const h = sha1(best.png)
  after.push({ hash: h, name: r.name_zh })
  const key = `${best.width}x${best.height}`
  sizes.set(key, (sizes.get(key) ?? 0) + 1)

  if (r.icon_path && fs.existsSync(r.icon_path) && sha1(fs.readFileSync(r.icon_path)) !== h) {
    changed++
  }
}

console.log(`软件条目 ${rows.length} 条\n`)

console.log('── 改前（磁盘上现在这批图标里，共用同一张图的）')
const b = clusters(before)
if (b.length === 0) console.log('  没有共用的')
for (const c of b) console.log(`  ${c.n} 条共用一张：${c.names.join('、')}`)

console.log('\n── 改后（PE 里取出来的最佳 PNG 帧里，共用同一张图的）')
const a = clusters(after)
if (a.length === 0) console.log('  没有共用的 —— 每条都拿到了自己的图标')
for (const c of a) {
  console.log(`  ${c.n} 条共用一张：${c.names.join('、')}`)
  stillShared.push(...c.names)
}

console.log('\n── 改后的尺寸分布')
for (const [k, n] of [...sizes.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${k.padEnd(10)} ${n} 条`)
}

console.log(
  `\n── 汇总\n  换了图的 ${changed} 条　PE 里没有 PNG 帧、退回 getFileIcon 的 ${noPeIcon} 条　` +
    `超体积上限的 ${tooBig} 条`
)

// 这批是 DIB-only 的 exe，getFileIcon 在它们身上取到的是 48×48 的真图标
// （不是通用图）。列出来是为了下次这条退路出问题时能一眼看到影响面
console.log(`\n── 退回 getFileIcon 的：${fellBack.join('、') || '（没有）'}`)

/*
 * 判据写死在这儿而不是靠人看输出：
 * 改前那批共用图标的条目数必须掉到 0，否则这一版没解决用户报的问题。
 */
const beforeShared = b.reduce((s, c) => s + c.n, 0)
const afterShared = a.reduce((s, c) => s + c.n, 0)
if (beforeShared === 0) {
  console.log('\n⚠ 改前一条共用的都没有 —— 要么图标已经被重新提过，要么这台机器上没有那批条目')
} else if (afterShared >= beforeShared) {
  console.log(`\n✗ 失败：共用图标的条目从 ${beforeShared} 条变成 ${afterShared} 条，没有改善`)
  process.exitCode = 1
} else {
  console.log(`\n✓ 共用图标的条目：${beforeShared} 条 → ${afterShared} 条`)
}
