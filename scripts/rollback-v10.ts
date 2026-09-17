/**
 * 把 0.9 收尾时的库退回版本 9 的形状。
 *
 * 版本 10 加了两样东西：
 * 1. settings 表：scan_dirs -> software_scan_dirs / game_scan_dirs / video_scan_dirs
 * 2. identify_logs 表：resource_kind 列（DEFAULT 'software'）
 *    （注：这一列实际在 0.8 迁移里就会补，不严格属于版本 10；脚本仍按现有库形状处理）
 *
 * 退回去就是：
 * 1. 三个新键合并回 scan_dirs（取 software_scan_dirs 的值，另外两个丢掉）
 * 2. DROP COLUMN identify_logs.resource_kind
 * 3. 版本号回 9
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v10.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
 *
 * ## 为什么敢直接 DROP COLUMN
 *
 * SQLite 3.35+ 支持 `ALTER TABLE ... DROP COLUMN`，node:sqlite 和
 * better-sqlite3 带的都够新。resource_kind 这一列没有索引、不在任何 CHECK 或
 * 外键里，掉它不会牵动别的东西。
 *
 * 老 SQLite 上 DROP COLUMN 会报错，这时脚本会中止且**库没有被改动**
 * （整段包在事务里），不会留下半迁移状态。
 *
 * ## 数据代价
 *
 * - game_scan_dirs / video_scan_dirs 的值会丢失，退回后只剩 software_scan_dirs
 * - identify_logs 里 resource_kind='game' 和 'video' 的日志会变成无差别（列没了），
 *   但日志本身不丢
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { columnsOf, schemaVersion } from '../electron/services/schema.ts'

const target = process.argv[2] ?? path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

const one = (sql: string): number => (d.prepare(sql).get() as { n: number }).n

if (!columnsOf(d as any, 'identify_logs').has('resource_kind')) {
  console.error('identify_logs 里没有 resource_kind 列，这个库没迁到版本 10，无需回滚。')
  process.exit(1)
}

const ver = schemaVersion(d as any)
console.log(`当前：版本号 ${ver}`)
if (ver !== 10) {
  console.error(`版本号是 ${ver} 而不是 10，这个脚本只回滚 10 -> 9`)
  process.exit(1)
}

const gameDirs = d.prepare('SELECT value FROM settings WHERE key = ?').get('game_scan_dirs') as
  | { value: string }
  | undefined
const videoDirs = d.prepare('SELECT value FROM settings WHERE key = ?').get('video_scan_dirs') as
  | { value: string }
  | undefined

const gameCount = gameDirs ? JSON.parse(gameDirs.value).length : 0
const videoCount = videoDirs ? JSON.parse(videoDirs.value).length : 0

if (gameCount > 0 || videoCount > 0) {
  console.log(
    `注意：game_scan_dirs (${gameCount} 个目录) 和 video_scan_dirs (${videoCount} 个目录) 会丢失。` +
      `退回后这两个模块的持久扫描目录会清空。`
  )
}

const gameLogCount = one(`SELECT COUNT(*) AS n FROM identify_logs WHERE resource_kind = 'game'`)
const videoLogCount = one(`SELECT COUNT(*) AS n FROM identify_logs WHERE resource_kind = 'video'`)
if (gameLogCount > 0 || videoLogCount > 0) {
  console.log(
    `注意：${gameLogCount} 条游戏日志和 ${videoLogCount} 条影视日志会失去模块标记（列没了），` +
      `但日志本身不丢，它们会和软件日志混在一起。`
  )
}

d.exec('BEGIN')
try {
  // 1. 三个新键合并回 scan_dirs
  const softwareDirs =
    (
      d.prepare('SELECT value FROM settings WHERE key = ?').get('software_scan_dirs') as
        | { value: string }
        | undefined
    )?.value ?? '[]'

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('scan_dirs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(softwareDirs)

  d.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run(
    'software_scan_dirs',
    'game_scan_dirs',
    'video_scan_dirs'
  )

  // 2. DROP COLUMN identify_logs.resource_kind
  d.exec('ALTER TABLE identify_logs DROP COLUMN resource_kind')

  // 3. 版本号回 9
  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '9')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()

  d.exec('COMMIT')
} catch (err) {
  d.exec('ROLLBACK')
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`\n回滚失败，库没有被改动：${msg}`)
  if (/near "DROP"|syntax error/i.test(msg)) {
    console.error(
      '看起来是 SQLite 版本太老，不支持 ALTER TABLE ... DROP COLUMN（需要 3.35+）。'
    )
  }
  d.close()
  process.exit(1)
}

console.log(`\n已退回版本 9：resource_kind 列已删除，三个扫描目录键已合并，版本号 ${schemaVersion(d as any)}`)

// 验证
const cols = columnsOf(d as any, 'identify_logs')
console.log(cols.has('resource_kind') ? '警告：列没删掉。' : 'resource_kind 已不在 identify_logs 上。')

const hasScanDirs = d.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').get('scan_dirs') as {
  n: number
}
console.log(hasScanDirs.n > 0 ? 'scan_dirs 已恢复。' : '警告：scan_dirs 不见了。')

const hasSplit = d.prepare('SELECT COUNT(*) AS n FROM settings WHERE key IN (?, ?, ?)').get(
  'software_scan_dirs',
  'game_scan_dirs',
  'video_scan_dirs'
) as { n: number }
console.log(hasSplit.n === 0 ? '三个分离的键已删除。' : '警告：还有分离的键残留。')

d.close()
