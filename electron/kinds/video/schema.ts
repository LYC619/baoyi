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
 * ## migrate 里两种闸门，各管各的
 *
 * 0.7 是视频模块的第一个版本，库里不存在需要搬动的视频数据 ——
 * `CREATE TABLE IF NOT EXISTS` 同时覆盖全新安装和从 0.6 升上来两条路。
 * SCHEMA_VERSION 推到 7 的作用是让 `initSchema` 那道 `from < SCHEMA_VERSION`
 * 闸门把视频的内置标签装进去，以及给 `scripts/rollback-v7.ts` 一个可判断的版本号。
 *
 * 那之后 0.7 自己的开发过程中又加了两列（`douban_id` / `douban_rating`），
 * 于是有了这个 migrate。补列这部分**只补列，并且靠「列在不在」判断，不看版本号** ——
 * 理由是这两列是在 0.7 开发途中加的：已经装了 0.7 开发版的库版本号也是 7，
 * 版本号闸门放不进去，而 `columnsOf().has()` 那道闸门下次启动就自己补上了。
 * 公共层的 `categories.description` / `categories.kind` 用的是同一个写法。
 *
 * **当时没有为这两列提 SCHEMA_VERSION 到 8**，因为 8 的含义应该留给「0.8 的库形状」：
 * 拿它标记 0.7 开发中途的两个可空列，会让 rollback-v7 那句「退回 0.6」和
 * rollback-v8 的界限说不清 —— 而这两列是纯增量，有默认值，回滚时整张 video_meta
 * 都被 drop 掉，没人需要知道它们存在过。
 *
 * 0.8 兑现了那个含义：版本号 7 -> 8，标记的是「视频分类多了『里番』一格」。
 * 它走的是版本号闸门而不是列闸门，理由见 `migrateHentaiCategory` 上的注释。
 */

import { VIDEO_SCAN_STATE_SQL } from './scan-state.ts'
import type { KindSchema } from '../types.ts'
import { columnsOf, objectType, type SqlDb } from '../../services/schema.ts'
import { HENTAI_CATEGORY_ID, VIDEO_CATEGORIES } from './taxonomy.ts'

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
    poster_source TEXT NOT NULL DEFAULT '',
    thumbnail_path TEXT NOT NULL DEFAULT '',
    thumbnail_source TEXT NOT NULL DEFAULT '',
    collection_name TEXT NOT NULL DEFAULT '',
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
    imdb_id TEXT NOT NULL DEFAULT '',

    -- 豆瓣 subject id。条目页地址能从它拼出来，所以不单独存 URL
    douban_id TEXT NOT NULL DEFAULT '',
    -- 豆瓣评分，十分制。0 = 没拿到，**不是零分**
    --
    -- 和上面的 rating 分开存，不是为了多存一个数：rating 来自 TMDB 或 nfo，
    -- 这一列来自搜索服务商的摘要（见 douban.ts）—— 两个数的来源、时效、
    -- 可信度都不一样。合并成一列之后界面上就只剩一个不知道打哪儿来的数字，
    -- 而中文用户看影视评分时,「这是豆瓣的分」本身就是信息。
    douban_rating REAL NOT NULL DEFAULT 0,

    -- hanime 的 videoCode，纯数字字符串。0.8 加的。
    --
    -- 地位和 tmdb_id 完全一样：有它，重新刮削就是一次精确查询（/watch?v=<它>）
    -- 而不是重新按名字搜一遍 —— 里番的名字里全角半角、＃N、站方繁体标题
    -- 混在一起，按名字重搜每次都可能落到不同的候选上。
    -- （这段注释里刻意不用反引号：整个 VIDEO_META_SQL 是模板字符串，
    --   反引号会把它提前截断，而报错位置指向的是几十行之外）
    --
    -- 存成 TEXT 而不是 INTEGER：它是站方 URL 里的一个标识符，不参与算术，
    -- 而 tmdb_id / douban_id 也都是 TEXT。前导零真出现时 INTEGER 会吃掉它。
    hanime_id TEXT NOT NULL DEFAULT '',

    -- Hanime 页面上的原始简介和全部站方标签。与 agent 生成的中文简介、普通标签
    -- 分开保存：前者是数据源事实，不应被模型截断或受普通标签数量上限影响。
    original_description TEXT NOT NULL DEFAULT '',
    hanime_tags TEXT NOT NULL DEFAULT '[]',

    -- 用户在界面上改过哪些字段，JSON 字符串数组，如 '["category","name_zh"]'。
    -- 重扫时这些字段跳过不写，见 db.ts 的 PROTECTED_* 两张名单。
    --
    -- 存字段名而不是存「改过没有」一个布尔：用户只把分类从「欧美」改成「科幻」
    -- 的时候，新刮到的简介照样该写进去。一个布尔会把整行都锁住，
    -- 于是「我纠正了一个字段」变成「这条从此不再更新」。
    user_edited TEXT NOT NULL DEFAULT '[]'
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
    display_label TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    poster_source TEXT NOT NULL DEFAULT '',
    thumbnail_path TEXT NOT NULL DEFAULT '',
    thumbnail_source TEXT NOT NULL DEFAULT '',
    original_title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    original_description TEXT NOT NULL DEFAULT '',
    poster_path TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    studio TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL DEFAULT 0,

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

/** Stable source, managed-directory and file-asset records for downloadable works. */
export const VIDEO_LIBRARY_SQL = `
  CREATE TABLE IF NOT EXISTS video_sources (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
    episode_id TEXT REFERENCES episode(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('work', 'episode')),
    page_url TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT 'legacy',
    confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(provider, external_id, scope, resource_id, episode_id)
  );
  CREATE TABLE IF NOT EXISTS video_directories (
    resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
    bundle_id TEXT NOT NULL UNIQUE,
    root TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    directory_path TEXT NOT NULL UNIQUE,
    metadata_state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_assets (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('video', 'subtitle', 'poster', 'attachment')),
    quality TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'unchecked' CHECK (state IN ('unchecked', 'present', 'missing', 'offline')),
    checked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(resource_id, path, role)
  );
  CREATE TABLE IF NOT EXISTS video_episode_assets (
    episode_id TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
    PRIMARY KEY (episode_id, asset_id)
  );
`

/** Recovery data intentionally has no cascading FK: removing a work must not erase its journal. */
export const VIDEO_ORGANIZE_SQL = `
  CREATE TABLE IF NOT EXISTS video_organize_journal (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('organize', 'relocate')),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_video_organize_resource ON video_organize_journal(resource_id, created_at);
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
    COALESCE(m.thumbnail_path, '') AS thumbnail_path,
    COALESCE(m.thumbnail_source, '') AS thumbnail_source,
    COALESCE(m.poster_path, '') AS poster_path,
    COALESCE(m.poster_source, '') AS poster_source,
    COALESCE(m.collection_name, '') AS collection_name,
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
    COALESCE(m.douban_id, '') AS douban_id,
    COALESCE(m.douban_rating, 0) AS douban_rating,
    COALESCE(m.hanime_id, '') AS hanime_id,
    COALESCE(m.original_description, '') AS original_description,
    COALESCE(m.hanime_tags, '[]') AS hanime_tags,
    COALESCE(m.user_edited, '[]') AS user_edited,
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
  CREATE INDEX IF NOT EXISTS idx_video_sources_external ON video_sources(provider, external_id);
  CREATE INDEX IF NOT EXISTS idx_video_assets_resource ON video_assets(resource_id, state);
  CREATE INDEX IF NOT EXISTS idx_video_episode_assets_asset ON video_episode_assets(asset_id);
`

/**
 * 补 0.7 开发途中加的三列，外加 0.8 那条分类迁移。见文件头「两种闸门」。
 *
 * `from` 只喂给 `migrateHentaiCategory`：补列那几步的闸门是「列在不在」
 * 而不是版本号，理由同上。补列部分幂等，每次启动都跑，列已经在就是空操作。
 *
 * 视图必须在这之后建 —— `initSchema` 已经是这个顺序（migrate → view），
 * 而 `VIDEO_VIEW_SQL` 里 SELECT 了这几列：老库上如果先建视图，
 * 会当场报 no such column，然后后面的语句连着 migrate 全都不跑。
 *
 * ## 补列之后还要把视图撤掉
 *
 * `VIDEO_VIEW_SQL` 是 `CREATE VIEW IF NOT EXISTS`，对已经有 video 视图的库
 * 是**空操作** —— 加列不会让视图多出这一列。0.7 开发版装过的库于是会停在
 * 「表里有 user_edited、视图里没有」，而 `getVideo` 是从视图读的：
 * 拿到的每条 user_edited 都是 undefined，界面上所有保护标记消失，
 * 重扫照旧把用户改过的字段覆盖掉 —— 这一步等于没做，且不报任何错。
 *
 * 所以列不齐时把视图撤掉，让 initSchema 紧接着的那步照新定义重建。
 * 视图里没有数据，drop 掉是无损的。用「视图缺列」而不是「刚补过列」作判断，
 * 是因为前者对 0.7 开发版的库也成立 —— 那些库的列早就补上了，
 * 缺的恰恰只有视图。
 */
/**
 * 0.8 的那一条分类：往老库里补「里番」，并把「其他」挪到它后面。
 *
 * ## 为什么需要这一段 —— `VIDEO_CATEGORIES` 喂不到老库
 *
 * `seedCategories` 是**兜底**不是同步：它判的是「这个 kind 一条分类都没有吗」，
 * 装过 0.7 的库里视频分类有七条，于是直接 return —— 第八条永远进不去。
 * 而失效链条一声不吭：分类不在表里 → `listCategories` 读不到 →
 * `register_video` 那个工具的 category enum 里没有「里番」→ 模型没有合法途径
 * 把片子归过去 → `GROUP BY category` 数不出这一格 → 侧栏永远不出现。
 * 开发机上永远看不见，因为开发时反复删库重来，走的全是全新安装那条路。
 *
 * 所以这一段挂在版本号上（`from < 8`），和上面那三列的「看列在不在」不同：
 * 分类是数据不是结构，没有 `columnsOf` 那种可以反复问的现成判据，
 * 而「表里有没有这一行」不能当闸门 —— 用户删掉「里番」之后不该每次启动都长回来。
 *
 * ## 两条路不重叠
 *
 * 全新安装 `from` 是 0，此时视频分类一条都没有，这里不动手，
 * 由 initSchema 末尾的 `seedCategories` 一次装齐八条。
 * 用户把视频分类全删光的库同理 —— 交给兜底，这里不重复插。
 *
 * ## 不用 INSERT OR REPLACE
 *
 * `insertCategories` 用的是 `INSERT OR REPLACE`，拿它顺手「更新一下其他」
 * 会把用户可能改过的 name / description / icon 一起覆盖回出厂值，
 * 那是替用户撤销一次决定。这里只插新行（冲突就不管），
 * 只按 id 和旧值条件改排序 —— 于是连跑两次也不会插出第二行或把排序推到 9。
 */
function migrateHentaiCategory(d: SqlDb, from: number): void {
  if (from >= 8) return

  const has = d
    .prepare(`SELECT COUNT(*) AS n FROM categories WHERE kind = 'video'`)
    .get() as { n: number }
  if (has.n === 0) return

  const c = VIDEO_CATEGORIES.find((x) => x.id === HENTAI_CATEGORY_ID)
  if (!c) return
  d.prepare(
    `INSERT INTO categories (id, kind, name, description, icon, sort_order)
     VALUES (?, 'video', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(c.id, c.name, c.description ?? '', c.icon ?? '', c.sort_order)

  // 只在它还停在 0.7 那个位置时挪。用户自己删掉「其他」的库这里是 0 行，不炸
  d.prepare(
    `UPDATE categories SET sort_order = 8
     WHERE id = 'video-other' AND kind = 'video' AND sort_order = 7`
  ).run()
}

export function migrateVideo(d: SqlDb, from: number): void {
  migrateHentaiCategory(d, from)

  if (objectType(d, 'video_meta') !== 'table') return
  const cols = columnsOf(d, 'video_meta')
  for (const column of ['thumbnail_path', 'thumbnail_source']) if (!cols.has(column)) d.exec(`ALTER TABLE video_meta ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
  if (!cols.has('collection_name')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN collection_name TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.has('poster_source')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN poster_source TEXT NOT NULL DEFAULT ''`)
    d.exec(`UPDATE video_meta SET poster_source = poster_path
      WHERE poster_path LIKE 'https://%' OR (poster_path LIKE '/%' AND instr(substr(poster_path, 2), '/') = 0)`)
  }
  if (!cols.has('douban_id')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN douban_id TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.has('douban_rating')) {
    d.exec('ALTER TABLE video_meta ADD COLUMN douban_rating REAL NOT NULL DEFAULT 0')
  }
  if (!cols.has('user_edited')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN user_edited TEXT NOT NULL DEFAULT '[]'`)
  }
  // 0.8 加的。走「列在不在」而不是版本号，理由同上面那三列 ——
  // 而且它得和下面那道视图闸门配套：列补上了视图也必须跟着重建
  if (!cols.has('hanime_id')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN hanime_id TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.has('original_description')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN original_description TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.has('hanime_tags')) {
    d.exec(`ALTER TABLE video_meta ADD COLUMN hanime_tags TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!columnsOf(d, 'episode').has('display_label')) {
    d.exec(`ALTER TABLE episode ADD COLUMN display_label TEXT NOT NULL DEFAULT ''`)
  }
  const episodeColumns = columnsOf(d, 'episode')
  if (!episodeColumns.has('published_at')) d.exec('ALTER TABLE episode ADD COLUMN published_at INTEGER NOT NULL DEFAULT 0')
  if (!episodeColumns.has('tags')) d.exec(`ALTER TABLE episode ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`)
  for (const column of ['studio', 'poster_source', 'thumbnail_path', 'thumbnail_source', 'original_title', 'description', 'original_description', 'poster_path', 'source_url', 'notes']) {
    if (!episodeColumns.has(column)) d.exec(`ALTER TABLE episode ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
  }

  // 视图缺任何一个新列就撤掉，让 initSchema 紧接着按新定义重建。
  //
  // 这里判的是**两列都在不在**，不是只判 user_edited：0.8 之前装过的库
  // 视图里有 user_edited 但没有 hanime_id，只判前者的话这种库不会重建视图，
  // 而 getVideo 是从视图读的 —— 每条的 hanime_id 都是 undefined，
  // 详情页上那个链接永远不出现，重刮也永远走不了精确查询那条路。
  // 且不报任何错，因为 SQL 层面视图本身是合法的
  if (objectType(d, 'video') === 'view') {
    const v = columnsOf(d, 'video')
    if (
      !v.has('user_edited') ||
      !v.has('hanime_id') ||
      !v.has('original_description') ||
      !v.has('hanime_tags') ||
      !v.has('collection_name') ||
      !v.has('poster_source') || !v.has('thumbnail_path')
    ) d.exec('DROP VIEW video')
  }
}

export const videoSchema: KindSchema = {
  tables: VIDEO_SCAN_STATE_SQL + VIDEO_META_SQL + EPISODE_SQL + VIDEO_LIBRARY_SQL + VIDEO_ORGANIZE_SQL,
  view: VIDEO_VIEW_SQL,
  indexes: VIDEO_INDEXES_SQL,
  migrate: migrateVideo
}
