/**
 * 把 0.7 的库退回 0.6 的形状。
 *
 * 0.7 只加东西，不改已有结构 —— 新增 video_meta / episode / video 视图，
 * 加视频的分类和内置标签，版本号 6 -> 7。退回去就是把这些撤掉。
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v7.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
 *
 * 库里已经有视频条目时直接中止，不做半截活 —— 0.6 的结构装不下它们，
 * 硬回滚等于把用户刮削好的一整个片库悄悄扔掉。这和 rollback-v6 对游戏条目
 * 的态度一致：与其替用户扔数据，不如让他知道这个库回不去。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { objectType, schemaVersion } from '../electron/services/schema.ts'

type Row = Record<string, any>

const target = process.argv[2] ?? path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

if (schemaVersion(d as any) < 7 && objectType(d as any, 'video_meta') !== 'table') {
  console.error('这个库看起来没迁到 0.7（没有 video_meta 表），无需回滚。')
  process.exit(1)
}

const videos = (
  d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`).get() as { n: number }
).n
const episodes =
  objectType(d as any, 'episode') === 'table'
    ? (d.prepare('SELECT COUNT(*) AS n FROM episode').get() as { n: number }).n
    : 0
console.log(
  `当前：0.7 结构，${videos} 条视频，${episodes} 集，版本号 ${schemaVersion(d as any)}`
)

d.exec('BEGIN')
try {
  if (videos > 0) {
    throw new Error(
      `库里有 ${videos} 条视频（${episodes} 集），0.6 的结构装不下它们。` +
        `回滚会丢掉这部分数据，已中止。`
    )
  }

  if (objectType(d as any, 'video') === 'view') d.exec('DROP VIEW video')
  d.exec('DROP TABLE IF EXISTS episode')
  d.exec('DROP TABLE IF EXISTS video_meta')

  // 视频的分类和标签一并清掉。
  //
  // 留着它们不只是碍眼：0.6 的 listCategories / tagPool 是带 kind 过滤的
  // （那是 0.6 加的），所以「华语」「悬疑」不会跑到软件侧栏去。但版本号退回 6
  // 之后，下次启动 initSchema 那道 `from < SCHEMA_VERSION` 闸门会重新放行，
  // 而 seedCategories 只在「这个 kind 一条都没有」时才装 —— 留着旧的
  // 反而会让用户升回 0.7 时装不上新版分类。回到 0.6 的意思是
  // 「没有视频模块这回事」，它的词表也该跟着走。
  const droppedCats = d.prepare(`DELETE FROM categories WHERE kind = 'video'`).run().changes
  const droppedTags = d.prepare(`DELETE FROM tags WHERE kind = 'video'`).run().changes
  if (droppedCats || droppedTags) {
    console.log(`清掉视频侧的 ${droppedCats} 个分类、${droppedTags} 个标签（0.6 装不下它们）`)
  }

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '6')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()

  d.exec('COMMIT')
} catch (err) {
  d.exec('ROLLBACK')
  console.error(`\n回滚失败，库没有被改动：${err instanceof Error ? err.message : String(err)}`)
  d.close()
  process.exit(1)
}

const tags = (d.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n
const cats = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n
console.log(`\n已退回 0.6 结构：${cats} 个分类，${tags} 个标签，版本号 ${schemaVersion(d as any)}`)

// 游戏那套必须完好无损 —— 回滚视频不该碰到隔壁品类
const gameOk =
  objectType(d as any, 'game') === 'view' && objectType(d as any, 'game_meta') === 'table'
console.log(gameOk ? '游戏模块的表和视图完好。' : '警告：游戏模块的表或视图不见了。')

const stale = (
  d
    .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (?, ?, ?)')
    .get('video_meta', 'episode', 'video') as Row
).n
console.log(stale === 0 ? '0.7 的表和视图已清理干净。' : '警告：0.7 的表没删干净。')

d.close()
