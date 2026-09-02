/**
 * 量「空图标」到底是怎么空的。只读，不写库、不写盘。
 *
 *   npx electron scripts/probe-icons.cjs
 *
 * ## 为什么先量再改
 *
 * 「部分软件图标读不到」有好几种完全不同的成因，而它们的修法互相不通：
 *
 *   a. exe 已经不在那个路径上了      —— 候选链救不了，得提示用户
 *   b. getFileIcon 回了空图           —— 换 RT_GROUP_ICON 自己解可能有救
 *   c. getFileIcon 回了 Windows 通用图 —— 界面上看着「像空的」，但 icon_path 非空
 *   d. 主 exe 本来就没有图标资源      —— 同单元换一个 launcher 就有
 *
 * 猜错方向的代价不是白改一版，而是**改完看起来好了**（闸门全绿、少数条目碰巧
 * 变好），真正的成因一条没动。这个项目在「点开始识别界面卡死」那次已经踩过
 * 一模一样的坑：修了一个真问题，但不是那个问题，且从没做过改前改后的对比。
 *
 * ## 通用图标怎么认出来
 *
 * 不需要知道 Windows 的通用图标长什么样：把每条提到的 PNG 算个 sha1，
 * **同一个哈希出现在很多条不相干的软件上**，它就是通用图标。这是个自证的判据，
 * 不依赖任何硬编码的样本。
 */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app } = require('electron')
const Database = require('better-sqlite3')
const ResEdit = require('resedit')

const RT_ICON = 3
const RT_GROUP_ICON = 14
/** 和 peReader 的上限一致：太大的文件读进内存不值得 */
const MAX_PARSE_BYTES = 96 * 1024 * 1024

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')

/** PE 里有没有图标资源。回 null 表示连资源都定位不了（加壳、节区限制、不是 PE） */
function peIconCount(exePath) {
  try {
    const stat = fs.statSync(exePath)
    if (stat.size <= 0 || stat.size > MAX_PARSE_BYTES) return null
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
    const res = ResEdit.NtExecutableResource.from(exe)
    let groups = 0
    let icons = 0
    for (const e of res.entries) {
      if (e.type === RT_GROUP_ICON) groups++
      else if (e.type === RT_ICON) icons++
    }
    return { groups, icons }
  } catch {
    return null
  }
}

/** 目录里有没有现成的图标文件可用 */
function sidecarIcon(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(ico|png)$/i.test(name)) return path.join(dir, name)
    }
  } catch {}
  return ''
}

async function iconOf(exePath) {
  try {
    const img = await app.getFileIcon(exePath, { size: 'large' })
    if (img.isEmpty()) return { empty: true }
    const png = img.toPNG()
    if (png.length === 0) return { empty: true }
    const s = img.getSize()
    return { empty: false, hash: sha1(png), w: s.width, h: s.height, bytes: png.length, png }
  } catch (err) {
    return { empty: true, err: err && err.message ? err.message : String(err) }
  }
}

app.whenReady().then(async () => {
  const file = path.join(process.env.APPDATA || '', '抱一', 'baoyi.db')
  if (!fs.existsSync(file)) {
    console.log(`没找到数据库：${file}`)
    app.exit(1)
    return
  }

  const db = new Database(file, { readonly: true })
  // 走 software 视图而不是自己拼 JOIN：视图是应用真正读的那一份，
  // 自己拼一遍就多一处会和 schema 走散的地方
  const rows = db
    .prepare(
      `SELECT id, exe_path, icon_path, name_zh, source_dir, launchers
         FROM software ORDER BY name_zh`
    )
    .all()

  console.log(`软件条目 ${rows.length} 条\n`)

  const stat = {
    total: rows.length,
    iconEmpty: 0,
    iconFileMissing: 0,
    exeMissing: 0,
    getIconEmpty: 0,
    primaryNoPeIcon: 0,
    primaryPeUnreadable: 0,
    altHasPeIcon: 0,
    sidecarAvailable: 0
  }
  const hashes = new Map()
  const notes = []

  for (const r of rows) {
    const exe = r.exe_path || ''
    const exeThere = exe && fs.existsSync(exe)
    const iconEmpty = !r.icon_path
    const iconThere = r.icon_path && fs.existsSync(r.icon_path)

    if (iconEmpty) stat.iconEmpty++
    else if (!iconThere) stat.iconFileMissing++
    if (!exeThere) {
      stat.exeMissing++
      notes.push(`  [exe 不在] ${r.name_zh} :: ${exe}`)
      continue
    }

    const got = await iconOf(exe)
    if (got.empty) {
      stat.getIconEmpty++
      notes.push(`  [getFileIcon 空] ${r.name_zh} :: ${exe}${got.err ? ` (${got.err})` : ''}`)
    } else {
      const e = hashes.get(got.hash) || { n: 0, size: `${got.w}x${got.h}`, names: [], all: [], png: got.png }
      e.n++
      e.all.push(r.name_zh)
      if (e.names.length < 6) e.names.push(r.name_zh)
      hashes.set(got.hash, e)
    }

    const pe = peIconCount(exe)
    if (pe === null) stat.primaryPeUnreadable++
    else if (pe.groups === 0) stat.primaryNoPeIcon++

    // 同单元的其它 launcher 里有没有带图标资源的。候选链值不值得做，看这个数
    let alts = []
    try {
      alts = JSON.parse(r.launchers)
    } catch {}
    if (pe === null || pe.groups === 0) {
      const better = alts
        .map((l) => l && l.path)
        .filter((p) => p && p !== exe && fs.existsSync(p))
        .find((p) => {
          const q = peIconCount(p)
          return q && q.groups > 0
        })
      if (better) {
        stat.altHasPeIcon++
        notes.push(`  [同单元有更好的] ${r.name_zh}\n      主 ${exe}\n      备 ${better}`)
      }
      const side = sidecarIcon(r.source_dir || path.dirname(exe))
      if (side) stat.sidecarAvailable++
    }
  }

  console.log('── 计数')
  for (const [k, v] of Object.entries(stat)) console.log(`  ${k.padEnd(20)} ${v}`)

  console.log('\n── 重复的图标哈希（出现 2 次以上就是通用图标的嫌疑）')
  const dup = [...hashes.entries()].filter(([, v]) => v.n > 1).sort((a, b) => b[1].n - a[1].n)
  if (dup.length === 0) console.log('  没有重复的，说明提到的图标都是各自的')
  for (const [h, v] of dup.slice(0, 10)) {
    console.log(`  ${v.n} 条共用 ${h.slice(0, 12)} (${v.size})：${v.names.join('、')}`)
  }

  // 把重复的那张图倒出来看一眼。「12 条共用一个哈希」只说明它们一样，
  // 不说明它是 Windows 的通用图标 —— 那得肉眼看。落在 temp 里，不进仓库
  const outDir = path.join(app.getPath('temp'), 'baoyi-icon-probe')
  fs.mkdirSync(outDir, { recursive: true })
  for (const [h, v] of dup.slice(0, 4)) {
    const f = path.join(outDir, `dup-${v.n}x-${h.slice(0, 8)}.png`)
    fs.writeFileSync(f, v.png)
    console.log(`  倒出：${f}`)
  }
  // 一张确定正常的做对照，免得「看着像通用图标」其实是整条链路都在回同一张图
  const solo = [...hashes.entries()].find(([, v]) => v.n === 1)
  if (solo) {
    const f = path.join(outDir, `solo-${solo[1].names[0].replace(/[^\w-]/g, '_')}.png`)
    fs.writeFileSync(f, solo[1].png)
    console.log(`  对照：${f}（${solo[1].names[0]}，${solo[1].size}）`)
  }

  console.log('\n── 尺寸分布（getFileIcon size:large 实际回了多大）')
  const bySize = new Map()
  for (const [, v] of hashes) bySize.set(v.size, (bySize.get(v.size) || 0) + v.n)
  for (const [s, n] of bySize) console.log(`  ${s}  ${n} 条`)

  console.log('\n── 共用那张图的条目，PE 资源读不读得出来')
  for (const [, v] of dup.slice(0, 1)) {
    for (const name of v.all) {
      const r = rows.find((x) => x.name_zh === name)
      const pe = r ? peIconCount(r.exe_path) : null
      console.log(
        `  ${name.padEnd(22)} ${pe === null ? 'PE 读不出' : `图标组 ${pe.groups} / RT_ICON ${pe.icons}`}`
      )
    }
  }

  console.log(`\n── 明细（${notes.length} 条）`)
  for (const n of notes.slice(0, 60)) console.log(n)
  if (notes.length > 60) console.log(`  （还有 ${notes.length - 60} 条，形状一样）`)

  app.exit(0)
})
