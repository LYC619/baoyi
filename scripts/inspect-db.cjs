/**
 * 直接读实际的 baoyi.db，看 agent 到底识别出了什么。
 *
 *   npm run inspect
 *
 * 调 prompt 的时候用它验合并对不对（32/64 位有没有并成一条、附属程序有没有被单列），
 * 比在界面上一个个点详情页快。只读打开，不会改动任何数据。
 *
 * 用 Electron 跑（ELECTRON_RUN_AS_NODE=1）而不是 node：
 * better-sqlite3 是按 Electron 的 ABI 编译的，纯 node 加载会报 ABI 不匹配。
 */
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const file = path.join(process.env.APPDATA || '', '抱一', 'baoyi.db')
if (!fs.existsSync(file)) {
  console.log(`没找到数据库：${file}\n抱一还没运行过，或者刚被恢复出厂。`)
  process.exit(0)
}

const db = new Database(file, { readonly: true })
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('sv') : '—')
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c

console.log(`数据库：${file}\n`)

/* ------------------------------ 表结构自检 ------------------------------ */

// 0.3 的三列是 migrate() 补出来的，而 migrate() 曾被 initSchema 里的建索引语句挡在
// 门外（见 database.ts initSchema 的注释）。缺列的后果不是报错一次，而是每一条
// register_software 都写不进去 —— agent 认得再对也白认。所以先把这件事说清楚。
const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name))
const missing = []
for (const [t, need] of Object.entries({
  software: ['is_portable', 'move_risk', 'link_target'],
  pending_software: ['is_portable', 'move_risk']
})) {
  const have = colsOf(t)
  for (const c of need) if (!have.has(c)) missing.push(`${t}.${c}`)
}
if (missing.length) {
  console.log(`⚠ 表结构缺列：${missing.join('、')}`)
  console.log('   迁移没跑完，识别会在注册那一步整批失败。启动一次修好版的抱一即可补上。\n')
  process.exitCode = 1
} else {
  console.log('表结构：0.3 的列齐全\n')
}

console.log(
  `软件条目 ${count('software')} · 扫描目录 ${count('scan_units')} · 分类 ${count('categories')}\n`
)

/* ------------------------------ 扫描目录 ------------------------------ */

const units = db.prepare('SELECT * FROM scan_units ORDER BY status, dir').all()
if (units.length) {
  const by = units.reduce((m, u) => ((m[u.status] = (m[u.status] || 0) + 1), m), {})
  console.log(
    `── 扫描目录（待识别 ${by.pending || 0} · 已识别 ${by.done || 0} · 已跳过 ${by.skipped || 0} · 失败 ${by.failed || 0}）`
  )
  for (const u of units) {
    console.log(`   [${u.status}] ${u.dir}  ${u.exe_count} 个 exe`)
    if (u.note) console.log(`       ${u.note}`)
  }
  console.log()
}

/* ------------------------------ 软件条目 ------------------------------ */

const items = db.prepare('SELECT * FROM software ORDER BY source_dir, name_zh').all()
if (!items.length) {
  console.log('── 还没有任何软件条目')
} else {
  console.log(`── 软件条目 ${items.length}`)
  for (const it of items) {
    let launchers = []
    try {
      launchers = JSON.parse(it.launchers || '[]')
    } catch {
      /* 坏数据照原样呈现 */
    }
    const tags = (() => {
      try {
        return JSON.parse(it.tags || '[]').join('/')
      } catch {
        return ''
      }
    })()

    console.log(`\n   ${it.name_zh}${it.name_en ? `  (${it.name_en})` : ''}   [${it.category}]${tags ? `  #${tags}` : ''}`)
    console.log(`     ${it.summary || '（无说明）'}`)
    console.log(`     状态 ${it.ai_status} · 收录 ${fmt(it.created_at)} · 用过 ${it.use_count} 次`)
    if (it.official_url) console.log(`     ${it.official_url}`)
    console.log(`     来源目录 ${it.source_dir || '（无）'}`)

    if (launchers.length <= 1) {
      console.log(`     启动端 1 个：${it.exe_path}`)
    } else {
      console.log(`     启动端 ${launchers.length} 个：`)
      for (const l of launchers) {
        const marks = [l.is_default ? '默认' : '', l.kind === 'extra' ? '附属' : '']
          .filter(Boolean)
          .join(' ')
        console.log(`       ${l.label || '—'}${marks ? ` [${marks}]` : ''}  ${l.path}`)
      }
    }
  }
  console.log()
}

db.close()
