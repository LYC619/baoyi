/**
 * 给临时 profile 铺假数据，专门验「恢复出厂 / 数据统计」这一路。
 *
 * 用法：node --experimental-strip-types scripts/verify-reset-seed.ts <profile 目录>
 *
 * 为什么要单独一个脚本：resetData / dataStats 住在 services/database.ts 里，
 * 那个文件绑死了 electron + better-sqlite3，selfcheck 结构上就驱动不了它。
 * 所以只能真开一次应用让它自己建表，再用 node:sqlite 从旁边把假数据塞进去。
 * 绝不碰真库。
 *
 * software / game 都是**视图**，写不进去 —— 要写的是 resource + software_meta / game_meta。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const profile = process.argv[2]
if (!profile) {
  console.error('用法: node --experimental-strip-types scripts/verify-reset-seed.ts <profile 目录>')
  process.exit(1)
}

const dbFile = path.join(profile, 'baoyi.db')
if (!fs.existsSync(dbFile)) {
  console.error(`找不到 ${dbFile} —— 先空跑一次应用让它建表，再来铺数据`)
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON')

const iconsDir = path.join(profile, 'icons')
const coversDir = path.join(profile, 'covers')
fs.mkdirSync(iconsDir, { recursive: true })
fs.mkdirSync(coversDir, { recursive: true })

const now = Date.now()

/** resource 主表一条。时间戳是 INTEGER 毫秒，不是 ISO 串 */
function addResource(id: string, kind: 'software' | 'game', name: string): void {
  db.prepare(
    `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, ai_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'done')`
  ).run(id, kind, now, now, `D:\\假的\\${name}\\${name}.exe`, `${name}.exe`, name)
}

const softwareIds = ['sw-0001', 'sw-0002', 'sw-0003']
const gameIds = ['gm-0001', 'gm-0002']

for (const [i, id] of softwareIds.entries()) {
  addResource(id, 'software', `假软件${i + 1}`)
  db.prepare(`INSERT INTO software_meta (resource_id) VALUES (?)`).run(id)
  // 图标按 <id>.png 命名，和真实识别流程一致
  fs.writeFileSync(path.join(iconsDir, `${id}.png`), Buffer.alloc(1024, 7))
}

for (const [i, id] of gameIds.entries()) {
  addResource(id, 'game', `假游戏${i + 1}`)
  const cover = path.join(coversDir, `${id}.jpg`)
  db.prepare(`INSERT INTO game_meta (resource_id, cover_path) VALUES (?, ?)`).run(id, cover)
  fs.writeFileSync(path.join(iconsDir, `${id}.png`), Buffer.alloc(1024, 7))
  // 封面按 <id>.<后缀> 命名 —— 行没了就再没人能找到它，这正是它该被删的理由
  fs.writeFileSync(cover, Buffer.alloc(4096, 9))
}

// 扫描单元：主键是 dir，不是 id
for (let i = 0; i < 4; i++) {
  db.prepare(
    `INSERT INTO scan_units (dir, root, exe_count, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).run(`D:\\假的\\子目录${i}`, 'D:\\假的', 1, now, now)
}

for (let i = 0; i < 3; i++) {
  db.prepare(
    `INSERT INTO identify_logs (id, dir, label, status, created_at)
     VALUES (?, ?, ?, 'ok', ?)`
  ).run(`log-${i}`, `D:\\假的\\子目录${i}`, `子目录${i}`, now)
}

// 存档备份：故意留着。save_backups 刻意没给 resource_id 建外键，DELETE FROM resource
// 碰不到它；backup_dir 指向磁盘上真实存在的一份拷贝，是资产不是缓存。
const backupRoot = path.join(profile, '假备份')
for (let i = 0; i < 2; i++) {
  const dir = path.join(backupRoot, `backup-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'save1.dat'), Buffer.alloc(2048, 3))
  db.prepare(
    `INSERT INTO save_backups (id, resource_id, save_path, backup_dir, size_bytes, file_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`bk-${i}`, gameIds[i], `D:\\假的\\假游戏${i + 1}\\save`, dir, 2048, 1, now)
}

const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
console.log(
  JSON.stringify(
    {
      software: n(`SELECT COUNT(*) AS n FROM software`),
      games: n(`SELECT COUNT(*) AS n FROM game`),
      units: n(`SELECT COUNT(*) AS n FROM scan_units`),
      logs: n(`SELECT COUNT(*) AS n FROM identify_logs`),
      saveBackups: n(`SELECT COUNT(*) AS n FROM save_backups`),
      iconFiles: fs.readdirSync(iconsDir).length,
      coverFiles: fs.readdirSync(coversDir).length
    },
    null,
    2
  )
)
db.close()
