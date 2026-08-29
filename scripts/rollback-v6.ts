/**
 * 把 0.6 的库退回 0.5 的形状。
 *
 * 0.6 动了三处：categories 加 kind 列、tags 的唯一键从 name 换成 (kind, name)、
 * 新增 game_meta / save_backups / game 视图。退回去就是把这三处按原样撤销。
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v6.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
 *
 * 两种情况会直接中止，不做半截活：库里已经有游戏条目（0.5 的结构装不下），
 * 或者两个品类各有一个同名标签（唯一键换回 name 之后它们会撞车）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { columnsOf, objectType, schemaVersion } from '../electron/services/schema.ts'

type Row = Record<string, any>

const target = process.argv[2] ?? path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

if (schemaVersion(d as any) < 6 || !columnsOf(d as any, 'tags').has('kind')) {
  console.error('这个库看起来没迁到 0.6（tags 没有 kind 列），无需回滚。')
  process.exit(1)
}

const games = (
  d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'game'`).get() as { n: number }
).n
const tagsBefore = (d.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n
console.log(`当前：0.6 结构，${games} 条游戏，${tagsBefore} 个标签，版本号 ${schemaVersion(d as any)}`)

d.exec('BEGIN')
try {
  // 与其把用户的游戏记录悄悄扔掉，不如让他知道这个库回不去 —— 同 rollback-v5
  if (games > 0) {
    throw new Error(`库里有 ${games} 条游戏，0.5 的结构装不下它们。回滚会丢掉这部分数据，已中止。`)
  }

  if (objectType(d as any, 'game') === 'view') d.exec('DROP VIEW game')
  d.exec('DROP TABLE IF EXISTS game_meta')
  d.exec('DROP TABLE IF EXISTS save_backups')

  // 游戏的分类和标签一并清掉。
  //
  // 只把 kind 列删掉是不够的 —— 那样「RPG」「魂系」会留在表里，而 0.5 的
  // listCategories / tagPool 不带 kind 过滤，它们会当场出现在软件的侧边栏和
  // 识别 prompt 里。回到 0.5 的意思是「没有游戏模块这回事」，它的词表也该跟着走。
  const droppedCats = d.prepare(`DELETE FROM categories WHERE kind != 'software'`).run().changes
  const droppedTags = d.prepare(`DELETE FROM tags WHERE kind != 'software'`).run().changes
  if (droppedCats || droppedTags) {
    console.log(`清掉游戏侧的 ${droppedCats} 个分类、${droppedTags} 个标签（0.5 装不下它们）`)
  }

  // 唯一键换回 name 之前先看有没有重名。有的话 INSERT 会静默少几行，
  // 而少掉的那个标签正挂在某些条目上 —— 标签管理页从此再也删不掉它
  const dupes = (
    d.prepare('SELECT name, COUNT(*) AS n FROM tags GROUP BY name HAVING n > 1').all() as Row[]
  ).map((r) => r.name as string)
  if (dupes.length > 0) {
    throw new Error(
      `这些标签重名，唯一键换回 name 会撞车：${dupes.join('、')}。` +
        `请先在标签管理里改名或删掉其中一边，已中止。`
    )
  }

  const tagsKept = (d.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n

  // tags 退回 name UNIQUE，id 原样保留
  d.exec(`
    CREATE TABLE tags_v5 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      source TEXT DEFAULT 'ai',
      created_at INTEGER NOT NULL
    );
    INSERT INTO tags_v5 (id, name, source, created_at)
      SELECT id, name, source, created_at FROM tags;
  `)
  const tagsAfter = (d.prepare('SELECT COUNT(*) AS n FROM tags_v5').get() as { n: number }).n
  if (tagsAfter !== tagsKept) {
    throw new Error(`标签回滚条数对不上：${tagsKept} -> ${tagsAfter}`)
  }
  d.exec('DROP TABLE tags')
  d.exec('ALTER TABLE tags_v5 RENAME TO tags')

  // categories.kind 直接删列。这一列上有索引，先让开
  d.exec('DROP INDEX IF EXISTS idx_categories_kind')
  d.exec('ALTER TABLE categories DROP COLUMN kind')

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '5')
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
console.log(`\n已退回 0.5 结构：${cats} 个分类，${tags} 个标签，版本号 ${schemaVersion(d as any)}`)

const stale = (
  d
    .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (?, ?, ?)')
    .get('game_meta', 'save_backups', 'game') as Row
).n
console.log(stale === 0 ? '0.6 的表和视图已清理干净。' : '警告：0.6 的表没删干净。')

d.close()
