/**
 * 把 0.5 的库退回 0.4 的形状。
 *
 * 备份是底线，回滚是**不动备份**也能退回去 —— 两者的差别在于：备份文件停在
 * 迁移那一刻，而你迁完之后可能已经用了几天，识别了新软件、改过备注。直接拿
 * 备份盖回去，那几天的东西就没了。
 *
 * 所以这个脚本不碰 software_legacy_v4 那份快照，而是**按当前的 resource +
 * software_meta 重建 software 宽表** —— 迁移之后写进去的东西一并保留。
 *
 *   node --experimental-strip-types --no-warnings scripts/rollback-v5.ts <库文件>
 *
 * 会就地改写传入的那个文件。跑之前先关掉抱一，并且自己另存一份。
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

// 先确认它真是一个迁过的库，别在一个 0.4 的库上瞎折腾
if (objectType(d as any, 'software') !== 'view' || objectType(d as any, 'resource') !== 'table') {
  console.error('这个库看起来没迁到 0.5（software 不是视图 / 没有 resource 表），无需回滚。')
  process.exit(1)
}

const before = (d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }).n
console.log(`当前：0.5 结构，${before} 条软件，版本号 ${schemaVersion(d as any)}`)

d.exec('BEGIN')
try {
  // 老快照留着也没用了，先让开名字
  if (objectType(d as any, 'software_legacy_v4') === 'table') {
    d.exec('DROP TABLE software_legacy_v4')
  }
  d.exec('DROP VIEW software')

  // 0.4 那张宽表，原样重建
  d.exec(`
    CREATE TABLE software (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      exe_path TEXT NOT NULL UNIQUE,
      icon_path TEXT,
      file_name TEXT NOT NULL,
      file_description TEXT DEFAULT '',
      company TEXT DEFAULT '',
      version TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      source_dir TEXT DEFAULT '',

      name_zh TEXT DEFAULT '',
      name_en TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      description TEXT DEFAULT '',
      category TEXT DEFAULT '其他',
      tags TEXT DEFAULT '[]',
      official_url TEXT DEFAULT '',
      ai_status TEXT DEFAULT 'pending',
      launchers TEXT DEFAULT '[]',

      why_choose TEXT DEFAULT '',
      use_cases TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      alternatives TEXT DEFAULT '[]',
      mastery_level TEXT DEFAULT 'new',

      last_used_at INTEGER DEFAULT 0,
      use_count INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      external_active_at INTEGER DEFAULT 0,

      is_portable INTEGER DEFAULT NULL,
      move_risk TEXT DEFAULT 'unknown',
      link_target TEXT DEFAULT ''
    );

    INSERT INTO software
      (id, created_at, updated_at, exe_path, icon_path, file_name, file_description,
       company, version, file_size, source_dir, name_zh, name_en, summary, description,
       category, tags, official_url, ai_status, launchers,
       why_choose, use_cases, notes, alternatives, mastery_level,
       last_used_at, use_count, is_archived, external_active_at,
       is_portable, move_risk, link_target)
    SELECT
      r.id, r.created_at, r.updated_at, r.path, r.icon_path, r.file_name,
      COALESCE(m.file_description, ''), COALESCE(m.company, ''), COALESCE(m.version, ''),
      r.file_size, r.source_dir, r.name_zh, r.name_en, r.summary, r.description,
      r.category, r.tags, r.official_url, r.ai_status, COALESCE(m.launchers, '[]'),
      r.why_choose, r.use_cases, r.notes, r.alternatives, r.mastery_level,
      r.last_used_at, r.use_count, r.is_archived, r.external_active_at,
      m.is_portable, COALESCE(m.move_risk, 'unknown'), COALESCE(m.link_target, '')
    FROM resource r
    LEFT JOIN software_meta m ON m.resource_id = r.id
    WHERE r.kind = 'software';
  `)

  const after = (d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }).n
  if (after !== before) {
    throw new Error(`回滚条数对不上：视图里 ${before} 条，重建出来 ${after} 条`)
  }

  // 非 software 的资源在 0.4 里没有容身之处。真有的话就此打住 ——
  // 与其把用户的游戏 / 视频记录悄悄扔掉，不如让他知道这个库回不去
  const others = (
    d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind != 'software'`).get() as { n: number }
  ).n
  if (others > 0) {
    throw new Error(
      `库里有 ${others} 条非软件资源，0.4 的结构装不下它们。回滚会丢掉这部分数据，已中止。`
    )
  }

  d.exec('DROP TABLE software_meta')
  d.exec('DROP TABLE resource')

  // 0.4 的索引名，一并复原
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_software_category ON software(category);
    CREATE INDEX IF NOT EXISTS idx_software_mastery ON software(mastery_level);
    CREATE INDEX IF NOT EXISTS idx_software_archived ON software(is_archived);
    CREATE INDEX IF NOT EXISTS idx_software_last_used ON software(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_software_ai_status ON software(ai_status);
    CREATE INDEX IF NOT EXISTS idx_software_portable ON software(is_portable);
  `)

  d.prepare(
    `INSERT INTO settings (key, value) VALUES ('_schema', '4')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()

  d.exec('COMMIT')
} catch (err) {
  d.exec('ROLLBACK')
  console.error(`\n回滚失败，库没有被改动：${err instanceof Error ? err.message : String(err)}`)
  d.close()
  process.exit(1)
}

const rows = d.prepare('SELECT COUNT(*) AS n FROM software').get() as { n: number }
const nulls = (
  d.prepare('SELECT COUNT(*) AS n FROM software WHERE is_portable IS NULL').get() as { n: number }
).n
console.log(`\n已退回 0.4 结构：${rows.n} 条软件（其中 ${nulls} 条 is_portable 仍是 NULL），版本号 ${schemaVersion(d as any)}`)

const stale = (d.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (?, ?)').get('resource', 'software_meta') as Row).n
console.log(stale === 0 ? '0.5 的表已清理干净。' : '警告：0.5 的表没删干净。')

d.close()
