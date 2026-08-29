/**
 * 游戏条目的落库出口。
 *
 * 刻意收 `SqlDb` 而不是自己去调 `getDb()`：`services/database.ts` 依赖
 * electron 和 better-sqlite3（后者按 Electron ABI 编译，纯 node 载不进来），
 * 一旦在这里 import 它，整条识别链路就只能在应用跑起来之后才能验证。
 * 收一个 db 句柄，自检和 scripts/try-game-identify.ts 就能拿 node:sqlite
 * 驱动同一份 SQL 走完整个流程 —— 和 services/schema.ts 是同一个理由。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { LinkedFile, PlayStatus, SavePath } from '../../../src/types'
import type { SqlDb } from '../../services/schema.ts'

export interface GamePayload {
  /** 主程序绝对路径，同时是 resource.path 这个全局唯一键 */
  exe_path: string
  name_zh: string
  name_en: string
  summary: string
  description: string
  category: string
  tags: string[]
  official_url: string
  /** 这个游戏所在的目录 */
  source_dir: string
  file_size: number
  save_paths: SavePath[]
  linked_files: LinkedFile[]
}

export interface GameWriteOutcome {
  id: string
  created: boolean
}

/**
 * 以主程序路径作唯一键：同一个游戏反复识别是更新，不是再开一条。
 *
 * 更新时只覆盖 AI 认出来的那些字段。游玩时长、上次游玩、游玩状态、封面
 * 一律不动 —— 它们是用户玩出来的账，重新识别一次不该把它清零。
 * save_paths 同理：用户手工改过的路径比模型这一次的猜测可信，只在
 * 原先为空时才写入。
 */
export function insertGame(d: SqlDb, p: GamePayload): GameWriteOutcome {
  const now = Date.now()
  const common = [
    p.name_zh,
    p.name_en,
    p.summary,
    p.description,
    p.category,
    JSON.stringify(p.tags),
    p.official_url,
    p.source_dir,
    path.basename(p.exe_path),
    p.file_size
  ]

  const existing = d.prepare('SELECT id FROM resource WHERE path = ?').get(p.exe_path) as
    | { id: string }
    | undefined

  if (existing) {
    d.prepare(
      `UPDATE resource SET
         name_zh = ?, name_en = ?, summary = ?, description = ?, category = ?, tags = ?,
         official_url = ?, source_dir = ?, file_name = ?, file_size = ?,
         ai_status = 'done', updated_at = ?
       WHERE id = ?`
    ).run(...common, now, existing.id)

    // meta 行可能不存在（手工改库、或早于 game_meta 建表的条目），补一行再写
    d.prepare(`INSERT OR IGNORE INTO game_meta (resource_id) VALUES (?)`).run(existing.id)
    d.prepare(
      `UPDATE game_meta SET
         save_paths = CASE WHEN save_paths IN ('[]', '') THEN ? ELSE save_paths END,
         linked_files = CASE WHEN linked_files IN ('[]', '') THEN ? ELSE linked_files END
       WHERE resource_id = ?`
    ).run(JSON.stringify(p.save_paths), JSON.stringify(p.linked_files), existing.id)

    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  d.prepare(
    `INSERT INTO resource
       (id, kind, created_at, updated_at, path, icon_path,
        name_zh, name_en, summary, description, category, tags,
        official_url, source_dir, file_name, file_size, ai_status)
     VALUES (?, 'game', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`
  ).run(id, now, now, p.exe_path, ...common)
  d.prepare(
    `INSERT INTO game_meta (resource_id, save_paths, linked_files) VALUES (?, ?, ?)`
  ).run(id, JSON.stringify(p.save_paths), JSON.stringify(p.linked_files))

  return { id, created: true }
}

/** 某个目录下已注册的游戏，用来告诉 agent 别重复注册 */
export function gamesUnder(d: SqlDb, dir: string): Array<{ name: string; path: string }> {
  const rows = d
    .prepare(
      `SELECT name_zh, name_en, file_name, path FROM resource
       WHERE kind = 'game' AND source_dir = ? ORDER BY created_at`
    )
    .all(dir) as Array<Record<string, string>>
  return rows.map((r) => ({ name: r.name_zh || r.name_en || r.file_name, path: r.path }))
}

/** 更新游玩状态。Step 6 的时长统计会走同一张表，这里先只开状态这一个口子 */
export function setPlayStatus(d: SqlDb, id: string, status: PlayStatus): void {
  d.prepare('UPDATE game_meta SET play_status = ? WHERE resource_id = ?').run(status, id)
}
