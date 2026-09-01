/**
 * 验 rollback-v9 和 rollback-v8 在真文件上跑得通，且两条分支都按说的办。
 *
 *   node --experimental-strip-types --no-warnings scripts/verify-rollback-v9.ts
 *
 * 和 `verify-rollback-v7.ts` 同样的理由：自检里的迁移用例跑内存库，验的是
 * 「SQL 对不对」；这个脚本验的是回滚脚本作为**独立进程**在磁盘文件上跑，会不会
 * 中途炸掉、会不会把库改成半截状态。
 *
 * 这一版多验一样东西：**两个脚本对「还有数据挂着」的态度不同，而且是刻意的。**
 *
 * - `rollback-v8` 删的是**分类行**。有条目归在「里番」下时删掉它，那些条目的
 *   分类就悬空了 —— 那是用户的数据，所以**中止**。
 * - `rollback-v9` 删的是一列刮来的 id。丢了重刮一次就有，所以**只报数、照做**。
 *
 * 这个区别只能在真跑一遍里验：SQL 层面看不出「谁该中止」。
 *
 * 全程临时目录，不碰真库 —— 两个回滚脚本不给路径参数时**默认打真库**
 * （`%APPDATA%\抱一\baoyi.db`），所以这里每一次调用都显式传路径。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, objectType, schemaVersion } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { HENTAI_CATEGORY } from '../electron/kinds/video/taxonomy.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-rb9-'))
const dbPath = path.join(tmp, 'baoyi.db')

let failed = 0
function check(name: string, cond: boolean, note = ''): void {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${note ? ` —— ${note}` : ''}`)
  if (!cond) failed++
}

/**
 * 建一个 v9 的库。`withHentai` 决定要不要往「里番」下挂条目 ——
 * 那正是 v8 该中止、v9 该照做的那个条件。
 */
function makeDb(withHentai: boolean): void {
  fs.rmSync(dbPath, { force: true })
  const d = new DatabaseSync(dbPath)
  d.exec('PRAGMA foreign_keys = ON')
  initSchema(d as any, KINDS)
  // 一个别的分类的条目，回滚后必须完好
  d.prepare(
    `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, category)
     VALUES ('v1', 'video', 1, 2, 'D:\\V\\a.mkv', 'a.mkv', '某部电影', '欧美')`
  ).run()
  d.prepare(`INSERT INTO video_meta (resource_id, video_type) VALUES ('v1', 'movie')`).run()
  if (withHentai) {
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, category)
       VALUES ('v2', 'video', 1, 2, 'D:\\H\\b.mkv', 'b.mkv', '某部里番', ?)`
    ).run(HENTAI_CATEGORY)
    d.prepare(
      `INSERT INTO video_meta (resource_id, video_type, hanime_id) VALUES ('v2', 'movie', '86994')`
    ).run()
  }
  d.close()
}

function run(script: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', `scripts/${script}`, dbPath],
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    return { ok: true, out }
  } catch (err: any) {
    return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

function open(): DatabaseSync {
  const d = new DatabaseSync(dbPath)
  d.exec('PRAGMA foreign_keys = ON')
  return d
}
const count = (d: DatabaseSync, sql: string): number => (d.prepare(sql).get() as any).n
const hasCol = (d: DatabaseSync, table: string, col: string): boolean =>
  count(d, `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${col}'`) === 1

console.log('\n回滚验证 · v9 / v8（临时库，不碰真库）\n')
console.log(`  库：${dbPath}\n`)

/* ==================== 一、挂着数据时两者的态度 ==================== */

console.log('【一】还有里番条目挂着的时候')
makeDb(true)

const v8Blocked = run('rollback-v8.ts')
check('rollback-v8 中止了（分类行删了会让条目的分类悬空）', v8Blocked.ok === false, `退出码 ${v8Blocked.ok ? 0 : '非 0'}`)
check(
  '中止时说清楚了该先做什么',
  /挪到别的分类|已中止/.test(v8Blocked.out),
  v8Blocked.out.trim().split('\n').slice(-1)[0] ?? ''
)
{
  const d = open()
  check('中止之后库没被改：版本号还是 9', schemaVersion(d as any) === 9, `拿到 ${schemaVersion(d as any)}`)
  check(
    '中止之后「里番」那一行还在',
    count(d, `SELECT COUNT(*) AS n FROM categories WHERE id = 'video-hentai'`) === 1
  )
  d.close()
}

// v9 相反：有数据也照做，只是要把代价说出来
const v9WithData = run('rollback-v9.ts')
check('rollback-v9 有数据也照做（刮来的 id 丢了能重刮）', v9WithData.ok === true)
check('但它把「有几条要丢」报出来了', /1 条/.test(v9WithData.out), v9WithData.out.match(/.*条.*/)?.[0] ?? '')
{
  const d = open()
  check('hanime_id 列没了', hasCol(d, 'video_meta', 'hanime_id') === false)
  check('版本号退到 8', schemaVersion(d as any) === 8, `拿到 ${schemaVersion(d as any)}`)
  check('条目本身还在（丢的是一列 id，不是数据）', count(d, `SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`) === 2)
  d.close()
}

// v9 跑完之后 v8 才能跑 —— 这一次里番条目还挂着，所以仍旧该中止
const v8StillBlocked = run('rollback-v8.ts')
check('里番条目还挂着，v8 仍旧中止', v8StillBlocked.ok === false)

/* ==================== 二、干净的一条链：v9 → v8 ==================== */

console.log('\n【二】没有里番条目时，v9 → v8 连着跑')
makeDb(false)

const v9 = run('rollback-v9.ts')
check('rollback-v9 跑通', v9.ok === true, v9.out.trim().split('\n').slice(-1)[0] ?? '')
{
  const d = open()
  check('hanime_id 列没了', hasCol(d, 'video_meta', 'hanime_id') === false)
  check('版本号 8', schemaVersion(d as any) === 8, `拿到 ${schemaVersion(d as any)}`)
  // v9 故意 drop 掉视图（它引用着 hanime_id），靠下次启动 initSchema 重建
  check('video 视图被撤掉了（下次启动重建）', objectType(d as any, 'video') !== 'view')
  check('0.7 的两张表完好', count(d, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('video_meta','episode')`) === 2)
  d.close()
}

const v8 = run('rollback-v8.ts')
check('rollback-v8 跑通', v8.ok === true, v8.out.trim().split('\n').slice(-1)[0] ?? '')
// 这一条盯的是报警文案本身：v9 撤过视图之后 v8 不该报得像数据没了。
// 原先三个对象一起数、缺一个就喊「0.7 的表或视图不见了」，于是一次干净的回滚
// 后面跟着一句像出事的话 —— 那是在教用户忽略报警
check(
  'v8 没把「视图不在」报成「表不见了」',
  !/表或视图不见了|表不见了/.test(v8.out),
  v8.out.match(/.*视图.*/)?.[0] ?? ''
)
{
  const d = open()
  check('版本号 7', schemaVersion(d as any) === 7, `拿到 ${schemaVersion(d as any)}`)
  check(
    '「里番」那一行删掉了',
    count(d, `SELECT COUNT(*) AS n FROM categories WHERE id = 'video-hentai'`) === 0
  )
  check(
    '「其他」挪回 sort_order 7',
    count(d, `SELECT COUNT(*) AS n FROM categories WHERE id = 'video-other' AND sort_order = 7`) === 1
  )
  check('回到 7 个视频分类', count(d, `SELECT COUNT(*) AS n FROM categories WHERE kind = 'video'`) === 7)
  check('别的分类的条目完好', count(d, `SELECT COUNT(*) AS n FROM resource WHERE id = 'v1'`) === 1)
  d.close()
}

/* ==================== 三、重复跑不该炸 ==================== */

console.log('\n【三】再跑一次（用户不确定跑过没有，很可能会再跑一遍）')
const v9Again = run('rollback-v9.ts')
const v8Again = run('rollback-v8.ts')
// 判据是「说得清楚 + 不改坏库」，而不是退出码一定为 0：已经在 7 上了，
// 脚本报「不用回滚」然后退出非 0 也是合理的
check(
  '重跑 v9 有话说，不是抛原始异常',
  /版本号|不用|已经|无需/.test(v9Again.out),
  v9Again.out.trim().split('\n')[0] ?? ''
)
check(
  '重跑 v8 有话说',
  /版本号|不用|已经|无需/.test(v8Again.out),
  v8Again.out.trim().split('\n')[0] ?? ''
)
{
  const d = open()
  check('重跑之后版本号还是 7', schemaVersion(d as any) === 7, `拿到 ${schemaVersion(d as any)}`)
  check('重跑之后条目还在', count(d, `SELECT COUNT(*) AS n FROM resource WHERE id = 'v1'`) === 1)
  d.close()
}

/* ==================== 四、回滚之后再启动一次 ==================== */

console.log('\n【四】回滚完再启动应用 —— 两个脚本都跟用户说了「下次启动会重建」')
// 这一节验的是那句承诺本身。回滚脚本撤掉视图之后打印「下次启动会重建」，
// 而在这之前没有任何一条检查真的走过那一步 —— 一句没验过的承诺和一个 bug
// 在输出上长得一模一样。用户的真实路径是「回滚 → 重开应用」，所以补上这一段。
{
  const d = open()
  initSchema(d as any, KINDS) // 应用启动时干的就是这一件事
  check('重新启动后爬回版本 9', schemaVersion(d as any) === 9, `拿到 ${schemaVersion(d as any)}`)
  check('video 视图重建出来了', objectType(d as any, 'video') === 'view')
  check('hanime_id 列也回来了', hasCol(d, 'video_meta', 'hanime_id') === true)
  check(
    '「里番」分类又被迁移插回来了',
    count(d, `SELECT COUNT(*) AS n FROM categories WHERE id = 'video-hentai'`) === 1
  )
  check(
    '「其他」又挪到了 8',
    count(d, `SELECT COUNT(*) AS n FROM categories WHERE id = 'video-other' AND sort_order = 8`) === 1
  )
  // 回滚 → 重启这一圈下来，用户的条目一条都不能少
  check('转了一圈条目还在', count(d, `SELECT COUNT(*) AS n FROM resource WHERE id = 'v1'`) === 1)
  check(
    '视图查得动（重建出来的不是个空壳）',
    count(d, `SELECT COUNT(*) AS n FROM video`) === 1,
    `video 视图里 ${count(d, `SELECT COUNT(*) AS n FROM video`)} 行`
  )
  d.close()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`)
if (failed > 0) process.exit(1)
