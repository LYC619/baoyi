/**
 * 验 rollback-v7 在真文件上跑得通。
 *
 *   node --experimental-strip-types --no-warnings scripts/verify-rollback-v7.ts
 *
 * 自检里的迁移用例跑的是内存库，验的是「SQL 对不对」。这个脚本验的是另一件事：
 * 回滚脚本作为一个**独立进程**在磁盘文件上跑，会不会中途炸掉、会不会把库改成
 * 半截状态。两者都需要 —— 0.6 那次 tags 重建就是在真文件上才暴露出
 * 「DROP TABLE 之后索引还指着旧表」。
 *
 * 建临时库、跑回滚、检查结果，全程不碰真库。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, objectType, schemaVersion } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertVideo } from '../electron/kinds/video/db.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-rb7-'))
const dbPath = path.join(tmp, 'baoyi.db')

function makeDb(): void {
  const d = new DatabaseSync(dbPath)
  d.exec('PRAGMA foreign_keys = ON')
  initSchema(d as any, KINDS)
  // 一个软件和一个游戏，回滚后必须完好
  d.prepare(
    `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, category)
     VALUES ('s1', 'software', 1, 2, 'C:\\T\\a.exe', 'a.exe', '甲软件', '开发工具')`
  ).run()
  d.prepare('INSERT INTO software_meta (resource_id) VALUES (?)').run('s1')
  d.prepare(
    `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, category)
     VALUES ('g1', 'game', 1, 2, 'D:\\G\\g.exe', 'g.exe', '乙游戏', 'RPG')`
  ).run()
  d.prepare(
    `INSERT INTO game_meta (resource_id, play_status, total_playtime_sec) VALUES ('g1','playing',7200)`
  ).run()
  d.close()
}

function runRollback(): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'scripts/rollback-v7.ts', dbPath],
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    return { ok: true, out }
  } catch (err: any) {
    return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

let failed = 0
const check = (name: string, cond: boolean, note = ''): void => {
  console.log(cond ? `  ok   ${name}` : `  FAIL ${name}${note ? `\n       ${note}` : ''}`)
  if (!cond) failed++
}

console.log('\n回滚 v7 · 真文件')

/* --- 1. 空视频库：能干净退回 6 --- */
makeDb()
{
  const r = runRollback()
  check('库里没有视频条目时回滚成功', r.ok, r.out)
  const d = new DatabaseSync(dbPath)
  check('版本号退回 6', schemaVersion(d as any) === 6, `实际 ${schemaVersion(d as any)}`)
  check('video 视图删掉了', objectType(d as any, 'video') === null)
  check('video_meta 表删掉了', objectType(d as any, 'video_meta') === null)
  check('episode 表删掉了', objectType(d as any, 'episode') === null)
  check('游戏视图完好', objectType(d as any, 'game') === 'view')
  const soft = (d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind='software'`).get() as any).n
  const game = (d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind='game'`).get() as any).n
  check('软件条目还在', soft === 1, `实际 ${soft}`)
  check('游戏条目还在', game === 1, `实际 ${game}`)
  const playtime = (d.prepare(`SELECT total_playtime_sec AS t FROM game_meta`).get() as any).t
  check('游玩时长没被碰', playtime === 7200, `实际 ${playtime}`)
  const vcats = (d.prepare(`SELECT COUNT(*) AS n FROM categories WHERE kind='video'`).get() as any).n
  check('视频分类清掉了', vcats === 0, `实际 ${vcats}`)
  d.close()
}

/* --- 2. 有视频条目：必须拒绝，且库一点没动 --- */
fs.rmSync(dbPath, { force: true })
makeDb()
{
  const d = new DatabaseSync(dbPath)
  insertVideo(d as any, {
    path: 'D:\\Movies\\x.mkv',
    video_type: 'movie',
    name_zh: '某片', name_en: '', summary: '', description: '',
    category: '欧美', tags: [], official_url: '', source_dir: 'D:\\Movies',
    file_size: 100, year: 2024, end_year: 0, rating: 8, duration_sec: 100,
    resolution: '1080p', video_codec: 'H264', source: 'WEB-DL', release_group: '',
    audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [],
    tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0,
    poster_path: '', fanart_path: '', episodes: []
  })
  d.close()

  const r = runRollback()
  check('库里有视频条目时拒绝回滚', !r.ok, '不该成功 —— 那等于替用户扔掉整个片库')
  check('拒绝时说清了原因', r.out.includes('装不下'), r.out.slice(0, 200))

  const d2 = new DatabaseSync(dbPath)
  check('被拒绝后库一点没动：版本号还是 7', schemaVersion(d2 as any) === 7)
  check('被拒绝后 video 视图还在', objectType(d2 as any, 'video') === 'view')
  const v = (d2.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind='video'`).get() as any).n
  check('被拒绝后视频条目还在', v === 1, `实际 ${v}`)
  d2.close()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\n回滚 v7 验证通过\n' : `\n回滚 v7 验证失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
