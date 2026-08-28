/**
 * 拿一份真实的 0.4 库副本跑一遍 0.5 迁移，逐项核对前后是否一致。
 *
 * 自检里的用例造的是合成数据，这个脚本核的是**你自己那份攒了几个月的库**：
 * 条目数、分类名、is_portable 三态分布、写过的备注、junction 指向。
 * 迁移的代价不是「报个错」而是「数据没了」，所以动真库之前先在副本上跑这一遍。
 *
 *   node --experimental-strip-types --no-warnings scripts/verify-migration.ts <库文件>
 *
 * 不传路径就找 %APPDATA%\抱一\baoyi.db.v0.4.0.bak。
 * 脚本只读参数指定的那个文件并就地迁移它 —— 请传副本，别传正在用的库。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, initSchema, objectType, schemaVersion } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'

type Row = Record<string, any>

const target =
  process.argv[2] ??
  path.join(process.env.APPDATA ?? '', '抱一', 'baoyi.db.v0.4.0.bak')

if (!fs.existsSync(target)) {
  console.error(`找不到库文件：${target}`)
  process.exit(1)
}

const d = new DatabaseSync(target)
d.exec('PRAGMA foreign_keys = ON')

const one = (sql: string): number => (d.prepare(sql).get() as { n: number }).n
const names = (sql: string): string[] => (d.prepare(sql).all() as Row[]).map((r) => String(r.name))

if (objectType(d as any, 'software') !== 'table') {
  console.error('这个库里的 software 不是表 —— 它可能已经迁过了。请换一份 0.4 的副本。')
  process.exit(1)
}

const before = {
  版本: schemaVersion(d as any),
  条目数: one('SELECT COUNT(*) AS n FROM software'),
  分类: names('SELECT name FROM categories ORDER BY name'),
  判定为绿色: one('SELECT COUNT(*) AS n FROM software WHERE is_portable = 1'),
  判定为非绿色: one('SELECT COUNT(*) AS n FROM software WHERE is_portable = 0'),
  还没判断过: one('SELECT COUNT(*) AS n FROM software WHERE is_portable IS NULL'),
  写过备注的: one(`SELECT COUNT(*) AS n FROM software WHERE notes != ''`),
  已归档: one('SELECT COUNT(*) AS n FROM software WHERE is_archived = 1'),
  有链接指向的: one(`SELECT COUNT(*) AS n FROM software WHERE link_target != ''`),
  启动过的: one('SELECT COUNT(*) AS n FROM software WHERE use_count > 0'),
  暂存区: one('SELECT COUNT(*) AS n FROM pending_software')
}

console.log('迁移前：')
console.log(JSON.stringify(before, null, 2))

initSchema(d as any, KINDS)

const after = {
  版本: schemaVersion(d as any),
  条目数: one('SELECT COUNT(*) AS n FROM software'),
  分类: names('SELECT name FROM categories ORDER BY name'),
  判定为绿色: one('SELECT COUNT(*) AS n FROM software WHERE is_portable = 1'),
  判定为非绿色: one('SELECT COUNT(*) AS n FROM software WHERE is_portable = 0'),
  还没判断过: one('SELECT COUNT(*) AS n FROM software WHERE is_portable IS NULL'),
  写过备注的: one(`SELECT COUNT(*) AS n FROM software WHERE notes != ''`),
  已归档: one('SELECT COUNT(*) AS n FROM software WHERE is_archived = 1'),
  有链接指向的: one(`SELECT COUNT(*) AS n FROM software WHERE link_target != ''`),
  启动过的: one('SELECT COUNT(*) AS n FROM software WHERE use_count > 0'),
  暂存区: one('SELECT COUNT(*) AS n FROM pending_software')
}

console.log('\n迁移后：')
console.log(JSON.stringify(after, null, 2))

let failed = 0
function same(label: string, a: unknown, b: unknown): void {
  try {
    assert.deepEqual(b, a)
    console.log(`  ok   ${label}`)
  } catch {
    failed++
    console.log(`  FAIL ${label}：迁移前 ${JSON.stringify(a)}，迁移后 ${JSON.stringify(b)}`)
  }
}

console.log('\n逐项核对：')
same('条目一条不少', before.条目数, after.条目数)
same('分类一个不少（含你自建的）', before.分类, after.分类)
same('判定为绿色的条数', before.判定为绿色, after.判定为绿色)
same('判定为非绿色的条数', before.判定为非绿色, after.判定为非绿色)
same('还没判断过的仍是 NULL', before.还没判断过, after.还没判断过)
same('写过备注的条数', before.写过备注的, after.写过备注的)
same('已归档的条数', before.已归档, after.已归档)
same('junction 指向没丢', before.有链接指向的, after.有链接指向的)
same('使用统计没丢', before.启动过的, after.启动过的)
same('暂存区没动', before.暂存区, after.暂存区)
same('版本号提到 5', SCHEMA_VERSION, after.版本)

// 结构也核一遍：视图占了 software 这个名字，老表改名留着
same('software 变成视图', 'view', objectType(d as any, 'software'))
same('老表改名留存', 'table', objectType(d as any, 'software_legacy_v4'))
same(
  'resource 与 software_meta 一一对应',
  0,
  one('SELECT COUNT(*) AS n FROM resource r LEFT JOIN software_meta m ON m.resource_id = r.id WHERE m.resource_id IS NULL')
)

d.close()

console.log(failed === 0 ? '\n✅ 全部一致\n' : `\n❌ ${failed} 项对不上\n`)
process.exit(failed === 0 ? 0 : 1)
