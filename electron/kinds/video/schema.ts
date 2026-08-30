/**
 * 视频品类的库结构：私有表、视图、索引。
 *
 * 和 game_meta / software_meta 平级 —— 公共层的 resource 表放「拥有什么」，
 * 这里放「作为一部影视作品它还有什么」。
 *
 * ## 压着这个文件的那个决定：一条 resource 是什么
 *
 * `resource` 一条 = **一部电影 / 一整部剧**，单集进 `episode` 表。
 *
 * 用户心里的一个单位是「我有这部剧」，不是「我有这部剧的第 7 集」。按集入
 * resource 会让海报墙变成一面重复海报，侧栏计数也失去意义（「未看 342」里
 * 有 300 个是同一部剧的不同集）。代价是多一张表，以及查询时要算集数。
 *
 * ## 没有 migrate 函数
 *
 * 0.7 是视频模块的第一个版本，库里不存在需要搬动的视频数据。
 * `CREATE TABLE IF NOT EXISTS` 同时覆盖全新安装和从 0.6 升上来两条路 ——
 * 和 game 在 0.6 时的处境一样。SCHEMA_VERSION 推到 7 的作用是让
 * `initSchema` 那道 `from < SCHEMA_VERSION` 闸门把视频的内置标签装进去，
 * 以及给 `scripts/rollback-v7.ts` 一个可判断的版本号。
 *
 * 写一个空的 migrate 只是为了「显得有迁移」，那会让下一个读代码的人
 * 以为这里有需要小心的东西。
 */

import type { KindSchema } from '../types.ts'

/**
 * 视频私有字段。
 *
 * ## 哪些用真列，哪些用 JSON
 *
 * `audio_tracks` / `subtitle_tracks` / `parts` / `linked_files` 用 JSON 数组：
 * 都是列表，都不按它们查询，也不需要索引。和 game_meta 里 save_paths 同一个判断。
 *
 * `video_type` / `watch_status` / `year` / `rating` 用真列：侧栏要按它们筛选和
 * 计数，海报墙要按它们排序。json_extract 上建不了有用的索引，而这四列每一列
 * 都出现在「点一下侧栏」这条路径上。
 *
 * `position_sec` 在这里只对电影有意义。剧集的进度记在 episode 行上 ——
 * 一部剧没有「整部剧播到第几秒」这种东西，硬塞一个进来，下次打开就不知道
 * 该跳回哪一集的哪一秒。
 *
 * ## 两个 CHECK
 *
 * `video_type` 和 `watch_status` 都是闭集。写进去一个 'movei' 或 'wathcing'
 * 不该被静默收下 —— 侧边栏按它们筛选时会多出一个谁也点不到的幽灵分组，
 * 而那条记录从此在界面上消失（它不属于任何一个可见的格子）。
 */
export const VIDEO_META_SQL = `
  CREATE TABLE IF NOT EXISTS video_meta (
    resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,

    video_type TEXT NOT NULL DEFAULT 'movie'
      CHECK (video_type IN ('movie', 'series')),

    -- 竖版 2:3 海报 / 横版背景图的本地路径。空串 = 还没有，界面退回首字占位
    poster_path TEXT NOT NULL DEFAULT '',
    fanart_path TEXT NOT NULL DEFAULT '',

    -- 电影是一个点，剧集是区间起点。0 = 不知道，不是公元 0 年
    year INTEGER NOT NULL DEFAULT 0,
    end_year INTEGER NOT NULL DEFAULT 0,
    -- 十分制。0 = 还没刮到，不是「评分为零」
    rating REAL NOT NULL DEFAULT 0,

    watch_status TEXT NOT NULL DEFAULT 'unwatched'
      CHECK (watch_status IN ('unwatched', 'watching', 'watched', 'dropped')),
    -- 只对电影有意义，见文件头注释
    position_sec INTEGER NOT NULL DEFAULT 0,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    last_watched_at INTEGER NOT NULL DEFAULT 0,

    -- 以下四项来自文件名解析和容器元数据，是本地事实，不是模型猜的
    resolution TEXT NOT NULL DEFAULT '',
    video_codec TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    release_group TEXT NOT NULL DEFAULT '',

    audio_tracks TEXT NOT NULL DEFAULT '[]',
    subtitle_tracks TEXT NOT NULL DEFAULT '[]',
    parts TEXT NOT NULL DEFAULT '[]',
    linked_files TEXT NOT NULL DEFAULT '[]',

    -- 刮削来源的 id。留着是为了重新刮削时不用再猜一次是哪部片
    tmdb_id TEXT NOT NULL DEFAULT '',
    imdb_id TEXT NOT NULL DEFAULT ''
  );
`

/**
 * 剧集的一集。
 *
 * ## 为什么是独立表而不是 video_meta 里的一个 JSON 列
 *
 * 一部剧可以有几百集，而「这一集看到第几秒」「这一集文件在不在」都是要
 * 按集查询和更新的。JSON 列每改一集都得读出整个数组、改一个元素、写回去；
 * 自动连播时上一集刚写完进度、下一集又写一次，中间任何一次读旧值都会
 * 把另一集的进度覆盖掉。这不是性能问题，是正确性问题。
 *
 * ## path 允许为空串
 *
 * 空串表示**库里知道有这一集，磁盘上没有文件**。这不是脏数据 ——
 * TMDB 说这季 16 集、用户手上只有 8 个文件，缺的那 8 集必须露面，
 * 否则用户不知道自己缺什么。详情页那一列「在 / 缺」就是读它。
 *
 * ## 唯一键是 (resource_id, season, episode)
 *
 * 同一部剧的同一季同一集只该有一行。重扫一遍是 UPSERT 而不是再插一行 ——
 * 没有这个约束，扫描器每跑一次集列表就长一倍，而用户看到的是重复的集。
 * 不给 path 建唯一约束：缺文件的行 path 都是空串，那会让第二个缺的集插不进去。
 */
export const EPISODE_SQL = `
  CREATE TABLE IF NOT EXISTS episode (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,

    season INTEGER NOT NULL DEFAULT 1,
    episode INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',

    -- 空串 = 缺文件，见文件头注释
    path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    duration_sec INTEGER NOT NULL DEFAULT 0,

    watch_status TEXT NOT NULL DEFAULT 'unwatched'
      CHECK (watch_status IN ('unwatched', 'watching', 'watched', 'dropped')),
    position_sec INTEGER NOT NULL DEFAULT 0,
    watched_at INTEGER NOT NULL DEFAULT 0,
    -- 首播日期。0 = 不知道
    air_date INTEGER NOT NULL DEFAULT 0,

    UNIQUE(resource_id, season, episode)
  );
`

/**
 * resource + video_meta 拼成视频模块的读形状，外加三个集数统计。
 *
 * LEFT JOIN 而不是 JOIN，和另两个品类同一个理由：万一哪条 resource 缺了
 * 配套的 video_meta，条目该带着默认值露面，而不是从库里凭空消失。
 *
 * ## 三个 episode_* 为什么现算
 *
 * 它们要出现在海报墙每张卡片上（「3/12 集」）。存成列的话，每次改一集的
 * 观看状态都要同步更新两张表 —— 而自动连播会在一小时里改十几次。
 * 两处计数不一致的代价是具体的：卡片说「8/16」，点进去数出来 9 集看完了。
 * 视频库是百级规模，三个 COUNT 子查询的代价可以忽略。
 */
export const VIDEO_VIEW_SQL = `
  CREATE VIEW IF NOT EXISTS video AS
  SELECT
    r.id, r.created_at, r.updated_at,
    r.path, r.file_name, r.file_size, r.source_dir,
    r.name_zh, r.name_en, r.summary, r.description, r.category, r.tags,
    r.official_url, r.ai_status, r.notes, r.is_archived,
    COALESCE(m.video_type, 'movie') AS video_type,
    COALESCE(m.poster_path, '') AS poster_path,
    COALESCE(m.fanart_path, '') AS fanart_path,
    COALESCE(m.year, 0) AS year,
    COALESCE(m.end_year, 0) AS end_year,
    COALESCE(m.rating, 0) AS rating,
    COALESCE(m.watch_status, 'unwatched') AS watch_status,
    COALESCE(m.position_sec, 0) AS position_sec,
    COALESCE(m.duration_sec, 0) AS duration_sec,
    COALESCE(m.last_watched_at, 0) AS last_watched_at,
    COALESCE(m.resolution, '') AS resolution,
    COALESCE(m.video_codec, '') AS video_codec,
    COALESCE(m.source, '') AS source,
    COALESCE(m.release_group, '') AS release_group,
    COALESCE(m.audio_tracks, '[]') AS audio_tracks,
    COALESCE(m.subtitle_tracks, '[]') AS subtitle_tracks,
    COALESCE(m.parts, '[]') AS parts,
    COALESCE(m.linked_files, '[]') AS linked_files,
    COALESCE(m.tmdb_id, '') AS tmdb_id,
    COALESCE(m.imdb_id, '') AS imdb_id,
    (SELECT COUNT(*) FROM episode e WHERE e.resource_id = r.id) AS episode_total,
    (SELECT COUNT(*) FROM episode e WHERE e.resource_id = r.id AND e.watch_status = 'watched')
      AS episode_watched,
    (SELECT COUNT(*) FROM episode e WHERE e.resource_id = r.id AND e.path != '')
      AS episode_present
  FROM resource r
  LEFT JOIN video_meta m ON m.resource_id = r.id
  WHERE r.kind = 'video'
`

/**
 * 索引。
 *
 * `idx_episode_resource` 带 season/episode 排序：季集列表每次打开详情页都要按
 * 这个顺序取一整部剧，而它同时也是 UNIQUE 约束的顺序，SQLite 能直接用上。
 */
export const VIDEO_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_video_type ON video_meta(video_type);
  CREATE INDEX IF NOT EXISTS idx_video_watch_status ON video_meta(watch_status);
  CREATE INDEX IF NOT EXISTS idx_video_year ON video_meta(year);
  CREATE INDEX IF NOT EXISTS idx_video_last_watched ON video_meta(last_watched_at);
  CREATE INDEX IF NOT EXISTS idx_episode_resource ON episode(resource_id, season, episode);
`

export const videoSchema: KindSchema = {
  tables: VIDEO_META_SQL + EPISODE_SQL,
  view: VIDEO_VIEW_SQL,
  indexes: VIDEO_INDEXES_SQL
}
