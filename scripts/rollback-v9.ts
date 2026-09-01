/**
 * 把 0.8 收尾时的库退回版本 8 的形状。
 *
 * 版本 9 只加了一样东西：`video_meta.hanime_id` 那一列（以及 `video` 视图里
 * 跟着多出来的同名列）。退回去就是把这两样撤掉，版本号回 8。
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v9.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
 *
 * ## 和 rollback-v8 的分工
 *
 * v8 撤的是「里番」那个**分类**，v9 撤的是 `hanime_id` 那一**列**。
 * 两件事分开两个版本号、两个脚本，是因为它们能各自单独回滚 ——
 * 用户可能想退掉刮削通道但留着分类（他手动归类的那些条目还在里面）。
 * 合成一个脚本就没有这个选择了。
 *
 * 要完整退回 0.7，先跑 v9 再跑 v8。
 *
 * ## 为什么敢直接 DROP COLUMN
 *
 * SQLite 3.35+ 支持 `ALTER TABLE ... DROP COLUMN`，node:sqlite 和
 * better-sqlite3 带的都够新。这一列没有索引、不在任何 CHECK 或外键里，
 * 掉它不会牵动别的东西 —— 唯一引用它的是 `video` 视图，而视图在下面先撤掉了。
 *
 * 老 SQLite 上 DROP COLUMN 会报错，这时脚本会中止且**库没有被改动**
 * （整段包在事务里），不会留下半迁移状态。
 *
 * ## 挂着数据就先说清楚，但不中止
 *
 * 和 v8 不同：v8 删分类会让条目落进一个不存在的分类（用户看得见、改不掉），
 * 所以有条目就中止。v9 掉的是一列刮削 id —— 撤掉它只是「下次重刮要按名字
 * 重搜一遍」，条目本身完好无损。所以这里只报个数，不拦。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { columnsOf, objectType, schemaVersion } from '../electron/services/schema.ts'

const target = process.argv[2] ?? path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

const one = (sql: string): number => (d.prepare(sql).get() as { n: number }).n

if (objectType(d as any, 'video_meta') !== 'table') {
  console.error('这个库里没有 video_meta 表 —— 它还没迁到 0.7，谈不上退回 8。')
  process.exit(1)
}
if (!columnsOf(d as any, 'video_meta').has('hanime_id')) {
  console.error('video_meta 里没有 hanime_id 列，这个库没迁到版本 9，无需回滚。')
  process.exit(1)
}

const scraped = one(`SELECT COUNT(*) AS n FROM video_meta WHERE hanime_id != ''`)
console.log(
  `当前：版本号 ${schemaVersion(d as any)}，${scraped} 条视频存着 hanime_id`
)
if (scraped > 0) {
  // 不中止，但要说清楚代价：这些 id 没了之后重刮得按名字重搜，
  // 而里番的名字里全角半角和站方繁体标题混在一起，重搜未必落回同一条
  console.log(
    `注意：这 ${scraped} 条的 hanime_id 会丢掉。条目本身不受影响，` +
      `但之后重新刮削要按名字重搜，可能匹配到别的候选。`
  )
}

d.exec('BEGIN')
try {
  // 视图引用着这一列，必须先撤。视图里没有数据，drop 是无损的 ——
  // 下次启动 initSchema 会按当时的定义重建它
  if (objectType(d as any, 'video') === 'view') d.exec('DROP VIEW video')

  d.exec('ALTER TABLE video_meta DROP COLUMN hanime_id')

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '8')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()

  d.exec('COMMIT')
} catch (err) {
  d.exec('ROLLBACK')
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`\n回滚失败，库没有被改动：${msg}`)
  if (/near "DROP"|syntax error/i.test(msg)) {
    console.error('看起来是 SQLite 版本太老，不支持 ALTER TABLE ... DROP COLUMN（需要 3.35+）。')
  }
  d.close()
  process.exit(1)
}

console.log(`\n已退回版本 8：hanime_id 列已删除，版本号 ${schemaVersion(d as any)}`)

// 0.7 那些表和数据必须完好 —— 这一版只加了一列，回滚也只该动那一列
const cols = columnsOf(d as any, 'video_meta')
console.log(cols.has('hanime_id') ? '警告：列没删掉。' : 'hanime_id 已不在 video_meta 上。')
console.log(
  cols.has('douban_id') && cols.has('user_edited')
    ? '0.7 的那几列完好。'
    : '警告：0.7 的列不见了 —— 这不该发生。'
)
const videos = one(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`)
console.log(`${videos} 条视频条目还在。`)

// 「里番」那个分类不该被这个脚本碰到 —— 撤它是 rollback-v8 的活
const hentai = one(`SELECT COUNT(*) AS n FROM categories WHERE id = 'video-hentai'`)
console.log(
  hentai > 0
    ? '「里番」分类还在（撤它请跑 rollback-v8）。'
    : '「里番」分类不在库里 —— 大概已经跑过 rollback-v8 了。'
)

d.close()
