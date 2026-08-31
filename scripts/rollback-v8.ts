/**
 * 把 0.8 的库退回 0.7 的形状。
 *
 * 0.8 Step 2 只动了三样东西：`categories` 里多一行 `video-hentai`、
 * 「其他」的 `sort_order` 7 -> 8、版本号 7 -> 8。退回去就是把这三样撤掉。
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v8.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
 *
 * ## 为什么是 .ts 不是 .sql
 *
 * v0.8-计划.md 里写的是 `rollback-v8.sql`。改成 .ts 有两个理由：
 * 一是 v5/v6/v7 三个回滚脚本都是 .ts，npm scripts 里也是这个跑法，
 * 仓库里没有任何 .sql 的执行入口（要多装一个 sqlite3 CLI）；
 * 二是下面那条「还有条目挂在里番上就中止」的判断，纯 SQL 表达不了 ——
 * 而它恰恰是这个脚本里唯一重要的那句。
 *
 * ## 挂着条目就中止
 *
 * 和 rollback-v6 / v7 对游戏、视频条目的态度一致：删掉分类行不会删掉条目，
 * 但那些条目的 `resource.category` 会变成一个分类表里不存在的字符串 ——
 * 侧栏 `GROUP BY category` 还是会给它数出一格来（那一列是自由文本），
 * 而用户点进去看到的是一个删不掉也改不了名的幽灵分类。
 * 与其替用户制造这个，不如让他先把那些片子挪走。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { schemaVersion } from '../electron/services/schema.ts'
import { HENTAI_CATEGORY, HENTAI_CATEGORY_ID } from '../electron/kinds/video/taxonomy.ts'

const target = process.argv[2] ?? path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

const one = (sql: string, ...p: any[]): number =>
  (d.prepare(sql).get(...p) as { n: number }).n

const hasRow = one('SELECT COUNT(*) AS n FROM categories WHERE id = ?', HENTAI_CATEGORY_ID) > 0
if (schemaVersion(d as any) < 8 && !hasRow) {
  console.error('这个库看起来没迁到 0.8（没有 video-hentai 这一行），无需回滚。')
  process.exit(1)
}

const tagged = one(
  `SELECT COUNT(*) AS n FROM resource WHERE kind = 'video' AND category = ?`,
  HENTAI_CATEGORY
)
console.log(`当前：版本号 ${schemaVersion(d as any)}，${tagged} 条视频归在「${HENTAI_CATEGORY}」下`)

d.exec('BEGIN')
try {
  if (tagged > 0) {
    throw new Error(
      `有 ${tagged} 条视频归在「${HENTAI_CATEGORY}」下。删掉这个分类会把它们留在一个` +
        `不存在的分类里（侧栏还是会数出这一格，但改不了也删不掉）。` +
        `请先在界面上把这些条目挪到别的分类，再跑一次。已中止。`
    )
  }

  const dropped = d.prepare('DELETE FROM categories WHERE id = ?').run(HENTAI_CATEGORY_ID).changes

  // 只把 0.8 挪过的那一格挪回去。带 sort_order = 8 的条件是为了不碰
  // 用户自己重排过的库 —— 那种库里这一格的位置是他的决定，不是我们的
  const moved = d
    .prepare(
      `UPDATE categories SET sort_order = 7
       WHERE id = 'video-other' AND kind = 'video' AND sort_order = 8`
    )
    .run().changes

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '7')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()

  d.exec('COMMIT')
  console.log(`删掉 ${dropped} 行分类，「其他」挪回原位 ${moved} 行。`)
} catch (err) {
  d.exec('ROLLBACK')
  console.error(`\n回滚失败，库没有被改动：${err instanceof Error ? err.message : String(err)}`)
  d.close()
  process.exit(1)
}

const cats = one(`SELECT COUNT(*) AS n FROM categories WHERE kind = 'video'`)
console.log(`\n已退回 0.7 结构：${cats} 个视频分类，版本号 ${schemaVersion(d as any)}`)

// 0.7 的表和视图必须完好 —— 这一版没碰它们，回滚也不该碰
const intact = one(
  `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('video_meta', 'episode', 'video')`
)
console.log(intact === 3 ? '0.7 的表和视图完好。' : '警告：0.7 的表或视图不见了。')

d.close()
