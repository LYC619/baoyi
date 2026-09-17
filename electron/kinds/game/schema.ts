/**
 * 游戏品类的库结构：私有表、视图、索引。
 *
 * 和 software_meta 平级 —— 公共层的 resource 表放「拥有什么」，这里放
 * 「作为一个游戏它还有什么」。没有 migrate：0.6 是游戏模块的第一个版本，
 * CREATE TABLE IF NOT EXISTS 同时覆盖全新安装和从 0.5 升上来两条路。
 */

import type { KindSchema } from '../types.ts'

/**
 * 游戏私有字段。
 *
 * save_paths / linked_files 用 JSON 数组而不是独立表：一个游戏的存档路径
 * 通常 1-3 条，关联文件也就几条，既不需要按它们查询也不需要索引。独立表
 * 换来的只是两次 JOIN 和两套增删改。
 *
 * 这和 software_meta 里 is_portable 坚持用真列不矛盾 —— 那一列是三态的，
 * json_extract 分不出「键不存在」和「值是 null」，而它决定敢不敢搬一个目录。
 * 这里两个字段都是列表，空列表和没有列表是同一件事。
 *
 *   save_paths:   [{ "path": "C:\\...\\Saves", "verified_at": 1730000000000 }]
 *   linked_files: [{ "path": "D:\\...\\修改器.exe", "label": "修改器", "type": "trainer" }]
 *
 * play_status 带 CHECK：四个状态是闭集，写进去一个 'playng' 不该被静默收下 ——
 * 侧边栏按状态筛选时它会变成一个谁也点不到的幽灵分组。
 */
export const GAME_META_SQL = `
  CREATE TABLE IF NOT EXISTS game_meta (
    resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,

    -- 竖版 2:3 封面 / 横版背景图的本地路径。空串 = 还没有，界面上退回首字占位
    cover_path TEXT DEFAULT '',
    background_path TEXT DEFAULT '',
    cover_source TEXT NOT NULL DEFAULT '',
    cover_source_url TEXT NOT NULL DEFAULT '',
    cover_status TEXT NOT NULL DEFAULT 'missing',
    cover_detail TEXT NOT NULL DEFAULT '',
    identity_name TEXT NOT NULL DEFAULT '',
    identity_query TEXT NOT NULL DEFAULT '',
    identity_confirmed INTEGER NOT NULL DEFAULT 0,

    play_status TEXT NOT NULL DEFAULT 'unplayed'
      CHECK (play_status IN ('unplayed', 'playing', 'completed', 'shelved')),
    total_playtime_sec INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER NOT NULL DEFAULT 0,

    save_paths TEXT NOT NULL DEFAULT '[]',
    linked_files TEXT NOT NULL DEFAULT '[]'
  );
`

/**
 * 每次存档备份留一条。
 *
 * ponytail: 刻意不给 resource_id 建外键，理由同 organize_plans —— 这张表不是
 * 日志而是**索引**：backup_dir 指向磁盘上真实存在的一份存档拷贝。级联删掉记录
 * 不会删掉那些文件，只会让用户再也找不到它们。用户从抱一里移除一个游戏，
 * 不等于他愿意扔掉那个游戏的存档备份。
 * 代价是可能留下孤儿行；等有了「孤儿备份清理」那一屏再回收。
 */
export const SAVE_BACKUPS_SQL = `
  CREATE TABLE IF NOT EXISTS save_backups (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    save_path TEXT NOT NULL,
    backup_dir TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`

/**
 * resource + game_meta 拼成游戏模块的读形状，和 software 视图同一个套路。
 *
 * LEFT JOIN 而不是 JOIN：万一哪条 resource 缺了配套的 game_meta，条目应该
 * 带着默认值露面，而不是从库里凭空消失。
 */
export const GAME_VIEW_SQL = `
  CREATE VIEW IF NOT EXISTS game AS
  SELECT
    r.id, r.created_at, r.updated_at,
    r.path, r.icon_path, r.file_name, r.file_size, r.source_dir,
    r.name_zh, r.name_en, r.summary, r.description, r.category, r.tags,
    r.official_url, r.ai_status,
    r.why_choose, r.use_cases, r.notes, r.alternatives, r.mastery_level,
    r.last_used_at, r.use_count, r.is_archived, r.external_active_at,
    COALESCE(m.cover_path, '') AS cover_path,
    COALESCE(m.background_path, '') AS background_path,
    COALESCE(m.cover_source, '') AS cover_source,
    COALESCE(m.cover_source_url, '') AS cover_source_url,
    COALESCE(m.cover_status, 'missing') AS cover_status,
    COALESCE(m.cover_detail, '') AS cover_detail,
    COALESCE(m.identity_name, '') AS identity_name,
    COALESCE(m.identity_query, '') AS identity_query,
    COALESCE(m.identity_confirmed, 0) AS identity_confirmed,
    COALESCE(m.play_status, 'unplayed') AS play_status,
    COALESCE(m.total_playtime_sec, 0) AS total_playtime_sec,
    COALESCE(m.last_played_at, 0) AS last_played_at,
    COALESCE(m.save_paths, '[]') AS save_paths,
    COALESCE(m.linked_files, '[]') AS linked_files
  FROM resource r
  LEFT JOIN game_meta m ON m.resource_id = r.id
  WHERE r.kind = 'game'
`

export const GAME_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_game_play_status ON game_meta(play_status);
  CREATE INDEX IF NOT EXISTS idx_game_last_played ON game_meta(last_played_at);
  CREATE INDEX IF NOT EXISTS idx_save_backups_resource ON save_backups(resource_id, created_at DESC);
`

export const gameSchema: KindSchema = {
  tables: GAME_META_SQL + SAVE_BACKUPS_SQL,
  view: GAME_VIEW_SQL,
  indexes: GAME_INDEXES_SQL,
  migrate(d) {
    const columns = new Set<string>(
      (d.prepare('PRAGMA table_info(game_meta)').all() as Array<{ name: string }>).map((r) => r.name)
    )
    const additions: Array<[string, string]> = [
      ['cover_source', "TEXT NOT NULL DEFAULT ''"],
      ['cover_source_url', "TEXT NOT NULL DEFAULT ''"],
      ['cover_status', "TEXT NOT NULL DEFAULT 'missing'"],
      ['cover_detail', "TEXT NOT NULL DEFAULT ''"],
      ['identity_name', "TEXT NOT NULL DEFAULT ''"],
      ['identity_query', "TEXT NOT NULL DEFAULT ''"],
      ['identity_confirmed', 'INTEGER NOT NULL DEFAULT 0']
    ]
    for (const [name, type] of additions) if (!columns.has(name)) d.exec(`ALTER TABLE game_meta ADD COLUMN ${name} ${type}`)
    // 旧版本的 game 视图没有新增字段，重建后让查询立即看到完整形状。
    d.exec('DROP VIEW IF EXISTS game')
  }
}
