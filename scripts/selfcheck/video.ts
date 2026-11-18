import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatDuration, isLocalPosterPath, posterUrl, PROTECTED_FIELD_LABEL, videoTitle } from '../../src/utils/index.ts'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, columnsOf, initSchema, objectType, schemaVersion } from '../../electron/services/schema.ts'
import { KINDS } from '../../electron/kinds/index.ts'
import { COVER_EXTS } from '../../electron/kinds/game/links.ts'
import { extFromContentType } from '../../electron/kinds/game/covers.ts'
import { clearSearchCache } from '../../electron/services/searchService.ts'
import { deleteVideo, deriveSeriesStatus, getVideo, insertVideo, listEpisodes, listVideos, nextEpisode, parseUserEdited, resumeEpisode, PROTECTED_FIELDS, PROTECTED_META_FIELDS, PROTECTED_RESOURCE_FIELDS, restoreScrapedFields, USER_EDITED_FIELDS, syncSeriesStatus, updateEpisode, updateVideo, videoCounts, VIDEO_META_COLUMNS, VIDEO_RESOURCE_COLUMNS, type VideoPayload } from '../../electron/kinds/video/db.ts'
import { cnNumber, detectExtra, parseAnimeEpisode, parseCnSeasonEpisode, parseLatinSeasonEpisode, parsePart, parseVideoName, parseYear, splitTitle, titleRegion } from '../../electron/kinds/video/filename.ts'
import { isExtraDir, parseSeasonFolder, scanVideoRoot, stackParts } from '../../electron/kinds/video/scanner.ts'
import { dateToEpochSec, parseNfo, parseNfoEpisodes, type NfoData } from '../../electron/kinds/video/nfo.ts'
import { mapMediaInfo, mediaInfoWasmPath, normLanguage, readContainerInfo, resolutionLabel } from '../../electron/kinds/video/mediainfo.ts'
import { imageUrl, mapCandidate, mapDetail, mapSeasonEpisodes, normDomain, normTitle, scoreCandidate, tmdbAvailable, yearOf } from '../../electron/kinds/video/tmdb.ts'
import { buildFacts, emptyFacts, guessSubtitleLanguage, mergeFacts, nfoWatchState, pickMainNfo } from '../../electron/kinds/video/facts.ts'
import { cleanDoubanTitle, doubanAvailable, doubanQuery, doubanSubjectId, doubanUrl, mapDoubanHit, parseDoubanRating, parseDoubanYear, rankDoubanHits, scoreDoubanCandidate } from '../../electron/kinds/video/douban.ts'
import { fillVideoSystem, videoCandidatePrompt } from '../../electron/kinds/video/prompts.ts'
import { buildVideoTools, limitVideoTags } from '../../electron/kinds/video/tools.ts'
import { normalizeTag, parseHentaiName } from '../../electron/kinds/video/hentai/filename.ts'
import { cleanTag, durationSec, parseDetail, parseSearch, searchUrl, toVideoCode, watchUrl } from '../../electron/kinds/video/hentai/selectors.ts'
import { hanimeChannel } from '../../electron/kinds/video/hentai/channel.ts'
import { resolvePosterRequest } from '../../electron/services/poster-protocol.ts'
import { artworkDirFor } from '../../electron/kinds/video/artwork-dir.ts'
import { MAX_HANIME_FETCHES, hanimeDetail, hanimeSearch, looksLikeChallenge, newBudget, setHanimeChallengeHandler } from '../../electron/kinds/video/hentai/hanime.ts'
import { HENTAI_CATEGORY, HENTAI_CATEGORY_ID, VIDEO_CATEGORIES, VIDEO_TAGS } from '../../electron/kinds/video/taxonomy.ts'
import { acceptExternalPosterUrl, acceptPosterUrl, extFromContentType as posterExtFromContentType, extFromPath, isLocalPoster, isPosterExt, isRemotePoster, MAX_POSTER_BYTES, pickSidecarPoster, posterFileName, posterSiblings, POSTER_EXTS } from '../../electron/kinds/video/posters.ts'
import { check, stubJson, stubFetch } from './shared.ts'


/* ==================== 视频数据层 · v0.7 Step 1 ==================== */

/**
 * 迁移 6 -> 7 和视频读写层。
 *
 * 这一段的重量全在「0.6 的真实库升上来之后，原有数据一条不少」——
 * 0.7 是本项目第一次在库里已经有两个品类的情况下加第三个，而
 * initSchema 里那几道闸门（rebuildCategories、seedTags）历史上都出过
 * 「下一次提版本时误伤」的事。
 */
export async function videoDataSection(): Promise<void> {
  console.log('\n视频数据层 · 迁移与读写')

  const { DatabaseSync } = await import('node:sqlite')

  /**
   * 造一张 0.6 形状的库：软件和游戏都有真实数据，版本号停在 6。
   *
   * 直接用 initSchema 建 0.6 的结构是做不到的 —— 它现在会建 7 的结构。
   * 所以这里手搭 0.6 那几张表，和 makeV4Db 一个路子。
   */
  function makeV6Db(): InstanceType<typeof DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(`
      CREATE TABLE resource (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'software',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE, icon_path TEXT, file_name TEXT NOT NULL,
        file_size INTEGER DEFAULT 0, source_dir TEXT DEFAULT '',
        name_zh TEXT DEFAULT '', name_en TEXT DEFAULT '', summary TEXT DEFAULT '',
        description TEXT DEFAULT '', category TEXT DEFAULT '其他', tags TEXT DEFAULT '[]',
        official_url TEXT DEFAULT '', ai_status TEXT DEFAULT 'pending',
        why_choose TEXT DEFAULT '', use_cases TEXT DEFAULT '', notes TEXT DEFAULT '',
        alternatives TEXT DEFAULT '[]', mastery_level TEXT DEFAULT 'new',
        last_used_at INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0,
        external_active_at INTEGER DEFAULT 0
      );
      CREATE TABLE software_meta (
        resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
        file_description TEXT DEFAULT '', company TEXT DEFAULT '', version TEXT DEFAULT '',
        launchers TEXT DEFAULT '[]', is_portable INTEGER DEFAULT NULL,
        move_risk TEXT DEFAULT 'unknown', link_target TEXT DEFAULT ''
      );
      CREATE TABLE game_meta (
        resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
        cover_path TEXT DEFAULT '', background_path TEXT DEFAULT '',
        play_status TEXT NOT NULL DEFAULT 'unplayed',
        total_playtime_sec INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER NOT NULL DEFAULT 0,
        save_paths TEXT NOT NULL DEFAULT '[]', linked_files TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE save_backups (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, save_path TEXT NOT NULL,
        backup_dir TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE categories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'software', name TEXT NOT NULL,
        description TEXT DEFAULT '', icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'software',
        name TEXT NOT NULL, source TEXT DEFAULT 'ai', created_at INTEGER NOT NULL,
        UNIQUE(kind, name)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE identify_logs (
        id TEXT PRIMARY KEY, dir TEXT NOT NULL, label TEXT DEFAULT '', kind TEXT DEFAULT 'unit',
        status TEXT NOT NULL, summary TEXT DEFAULT '', registered INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0,
        stop_reason TEXT DEFAULT '', events TEXT DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE TABLE organize_plans (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, root TEXT NOT NULL,
        undone_at INTEGER DEFAULT 0, steps TEXT DEFAULT '[]'
      );
      CREATE TABLE identification_reports (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, processed INTEGER DEFAULT 0,
        registered INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0, searches INTEGER DEFAULT 0,
        entries TEXT DEFAULT '[]'
      );
    `)

    // 一个软件、一个游戏，都带用户攒出来的东西
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh,
         category, tags, notes, use_count, mastery_level)
       VALUES ('s1', 'software', 1, 2, 'C:\\T\\a.exe', 'a.exe', '甲软件', '开发工具', '["开源"]',
         '我的软件备注', 7, 'proficient')`
    ).run()
    d.prepare('INSERT INTO software_meta (resource_id, is_portable) VALUES (?, ?)').run('s1', null)
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh,
         category, tags, notes)
       VALUES ('g1', 'game', 1, 2, 'D:\\G\\game.exe', 'game.exe', '乙游戏', 'RPG', '["魂系"]',
         '我的游戏备注')`
    ).run()
    d.prepare(
      `INSERT INTO game_meta (resource_id, play_status, total_playtime_sec, cover_path, save_paths)
       VALUES ('g1', 'playing', 7200, 'C:\\covers\\g1.jpg', '[{"path":"D:\\\\S","verified_at":9}]')`
    ).run()

    // 用户自建的分类和标签，两个品类各一
    d.prepare(
      `INSERT INTO categories (id, kind, name, sort_order) VALUES ('u1', 'software', '我的软件分类', 9)`
    ).run()
    d.prepare(
      `INSERT INTO categories (id, kind, name, sort_order) VALUES ('u2', 'game', '我的游戏分类', 9)`
    ).run()
    d.prepare(
      `INSERT INTO tags (kind, name, source, created_at) VALUES ('software', '我的标签', 'user', 1)`
    ).run()
    d.prepare(`INSERT INTO settings (key, value) VALUES ('_schema', '6')`).run()
    return d
  }

  await check('6 -> 7 迁完，软件和游戏的数据一条不少', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 2)
    const s = d.prepare('SELECT * FROM software WHERE id = ?').get('s1') as any
    assert.equal(s.notes, '我的软件备注')
    assert.equal(s.use_count, 7)
    assert.equal(s.is_portable, null, '「还没判断过」必须仍是 NULL')
    const g = d.prepare('SELECT * FROM game WHERE id = ?').get('g1') as any
    assert.equal(g.play_status, 'playing', '游玩状态不该被这次迁移碰到')
    assert.equal(g.total_playtime_sec, 7200, '游玩时长不该被清零')
    assert.equal(g.cover_path, 'C:\\covers\\g1.jpg', '封面路径不能丢')
    assert.equal(JSON.parse(g.save_paths)[0].path, 'D:\\S')
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  await check('6 -> 7 迁完，用户自建的分类和标签必须还在', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const names = (d.prepare('SELECT name FROM categories').all() as any[]).map((r) => r.name)
    // rebuildCategories 那颗雷：闸门写成「版本号小于当前」的话，6 -> 7 会再跑
    // 一次 DELETE FROM categories，两个品类的自建分类当场没
    assert.ok(names.includes('我的软件分类'), `软件自建分类被清了：${names.join(',')}`)
    assert.ok(names.includes('我的游戏分类'), `游戏自建分类被清了：${names.join(',')}`)
    const tags = (d.prepare('SELECT name FROM tags').all() as any[]).map((r) => r.name)
    assert.ok(tags.includes('我的标签'), '用户手建的标签被清了')
    d.close()
  })

  await check('6 -> 8 装上视频的分类和内置标签，且带对 kind', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const cats = (
      d.prepare(`SELECT name FROM categories WHERE kind = 'video' ORDER BY sort_order`).all() as any[]
    ).map((r) => r.name)
    // 0.6 的库里视频分类一条都没有，走的是 seedCategories 那条路，一次装齐八条 ——
    // 「里番」是 0.8 加的，兜底装的就该是新版的完整一套
    assert.deepEqual(cats, ['华语', '欧美', '日韩', '动画', '纪录片', '综艺', '里番', '其他', '音频'])
    const tags = (
      d.prepare(`SELECT name, source FROM tags WHERE kind = 'video'`).all() as any[]
    )
    assert.ok(tags.length >= 12, `视频内置标签没装进去，只有 ${tags.length} 个`)
    // 内置标签必须以 user 落库才进 prompt 的标签池，落成 ai 就等于没装
    assert.ok(tags.every((t) => t.source === 'user'), '内置标签该以 source=user 落库')
    // 关键：视频的分类不该跑到软件或游戏的侧栏去
    const soft = (
      d.prepare(`SELECT name FROM categories WHERE kind = 'software'`).all() as any[]
    ).map((r) => r.name)
    assert.ok(!soft.includes('华语'), '视频分类漏进了软件侧')
    d.close()
  })

  await check('迁移是幂等的：连跑三遍不出错，也不重复装分类', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const after1 = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    const after3 = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    assert.equal(after3, after1, '重复跑把分类装了两遍')
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 2)
    d.close()
  })

  await check('全新安装：video 视图和 episode 表都建得出来', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.equal(objectType(d as any, 'video'), 'view')
    assert.equal(objectType(d as any, 'video_meta'), 'table')
    assert.equal(objectType(d as any, 'episode'), 'table')
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  /* --------------------------- 读写层 --------------------------- */

  /** 一个装好 0.7 结构的空库 */
  function freshDb(): InstanceType<typeof DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }

  await check('9 -> 10 迁完，旧的 scan_dirs 分配给 software_scan_dirs', () => {
    const d = makeV6Db()
    // 塞一条旧的 scan_dirs 行，值是两个目录
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'scan_dirs',
      '["C:\\\\Tools","D:\\\\Apps"]'
    )
    initSchema(d as any, KINDS)
    const soft = d.prepare('SELECT value FROM settings WHERE key = ?').get('software_scan_dirs') as
      | { value: string }
      | undefined
    assert.ok(soft, 'software_scan_dirs 没创建')
    assert.deepEqual(JSON.parse(soft.value), ['C:\\Tools', 'D:\\Apps'])
    const game = d.prepare('SELECT value FROM settings WHERE key = ?').get('game_scan_dirs') as
      | { value: string }
      | undefined
    assert.ok(game, 'game_scan_dirs 没创建')
    assert.deepEqual(JSON.parse(game.value), [])
    const video = d.prepare('SELECT value FROM settings WHERE key = ?').get('video_scan_dirs') as
      | { value: string }
      | undefined
    assert.ok(video, 'video_scan_dirs 没创建')
    assert.deepEqual(JSON.parse(video.value), [])
    d.close()
  })

  const moviePayload = (over: Partial<VideoPayload> = {}): VideoPayload => ({
    path: 'D:\\Movies\\Dune.2024.mkv',
    video_type: 'movie',
    name_zh: '沙丘：第二部分',
    name_en: 'Dune: Part Two',
    summary: '厄崔迪家族的复仇之路',
    description: '',
    category: '欧美',
    tags: ['科幻', '冒险'],
    official_url: '',
    source_dir: 'D:\\Movies',
    file_size: 78_400_000_000,
    year: 2024,
    end_year: 0,
    rating: 8.7,
    duration_sec: 9960,
    resolution: '2160p',
    video_codec: 'HEVC',
    source: 'WEB-DL',
    release_group: '',
    audio_tracks: [{ index: 0, language: 'en', label: '杜比全景声', codec: 'TrueHD', path: '' }],
    subtitle_tracks: [{ index: -1, language: 'zh', label: '简中', codec: 'SRT', path: 'D:\\Movies\\Dune.srt' }],
    parts: [],
    linked_files: [],
    tmdb_id: '693134',
    imdb_id: 'tt15239678',
    douban_id: '',
    douban_rating: 0,
    poster_path: '',
    fanart_path: '',
    episodes: [],
    ...over
  })

  const seriesPayload = (over: Partial<VideoPayload> = {}): VideoPayload => ({
    ...moviePayload(),
    path: 'E:\\TV\\The Glory',
    video_type: 'series',
    name_zh: '黑暗荣耀',
    name_en: 'The Glory',
    category: '日韩',
    tags: ['悬疑'],
    source_dir: 'E:\\TV',
    year: 2022,
    end_year: 2023,
    rating: 9.1,
    episodes: [
      { season: 1, episode: 1, title: '漆黑的开场', path: 'E:\\TV\\The Glory\\S01E01.mkv', duration_sec: 3480 },
      { season: 1, episode: 2, title: '欢迎来到我的地狱', path: 'E:\\TV\\The Glory\\S01E02.mkv', duration_sec: 3360 },
      // 第 3 集库里知道有，磁盘上没文件 —— path 空串是有意义的状态
      { season: 1, episode: 3, title: '她到底是谁', path: '' }
    ],
    ...over
  })

  await check('电影入库：一条 resource + 一行 video_meta，视图读得回来', () => {
    const d = freshDb()
    const out = insertVideo(d as any, moviePayload())
    assert.ok(out.created)
    assert.equal(out.episodesAdded, 0, '电影不该产生集')
    const v = getVideo(d as any, out.id)!
    assert.equal(v.name_zh, '沙丘：第二部分')
    assert.equal(v.video_type, 'movie')
    assert.equal(v.year, 2024)
    assert.equal(v.rating, 8.7)
    assert.equal(v.resolution, '2160p')
    assert.equal(v.audio_tracks[0].label, '杜比全景声')
    assert.equal(v.subtitle_tracks[0].path, 'D:\\Movies\\Dune.srt')
    assert.equal(v.tmdb_id, '693134')
    assert.equal(v.episode_total, 0)
    d.close()
  })

  await check('剧集入库：一条 resource + N 行 episode，缺文件的集也在', () => {
    const d = freshDb()
    const out = insertVideo(d as any, seriesPayload())
    assert.equal(out.episodesAdded, 3)
    const v = getVideo(d as any, out.id)!
    assert.equal(v.video_type, 'series')
    assert.equal(v.episode_total, 3, '缺文件的集也要计入总数')
    assert.equal(v.episode_present, 2, '磁盘上真有文件的是 2 集')
    assert.equal(v.episode_watched, 0)
    const eps = listEpisodes(d as any, out.id)
    assert.equal(eps.length, 3)
    assert.equal(eps[2].path, '', '第 3 集该是缺文件状态')
    assert.equal(eps[0].title, '漆黑的开场')
    d.close()
  })

  await check('重扫同一部片是更新而不是再开一条', () => {
    const d = freshDb()
    const a = insertVideo(d as any, moviePayload())
    const b = insertVideo(d as any, moviePayload({ name_zh: '沙丘 2', rating: 8.9 }))
    assert.equal(a.id, b.id)
    assert.equal(b.created, false)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 1)
    const v = getVideo(d as any, a.id)!
    assert.equal(v.name_zh, '沙丘 2', '识别出来的字段该被更新')
    assert.equal(v.rating, 8.9)
    d.close()
  })

  await check('重新刮削不动观看状态、播放位置和海报 —— 那是用户看出来的账', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    updateVideo(d as any, id, {
      watch_status: 'watched',
      position_sec: 5000,
      poster_path: 'C:\\covers\\v1.jpg',
      notes: '我的备注'
    })
    insertVideo(d as any, moviePayload({ name_zh: '沙丘 2' }))
    const v = getVideo(d as any, id)!
    assert.equal(v.watch_status, 'watched', '重新刮削把观看状态打回去了')
    assert.equal(v.position_sec, 5000, '播放位置被清了')
    assert.equal(v.poster_path, 'C:\\covers\\v1.jpg', '海报被清了')
    assert.equal(v.notes, '我的备注')
    d.close()
  })

  await check('补后半季：新集补进来，已看过的集进度一点不动', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    const eps = listEpisodes(d as any, id)
    updateEpisode(d as any, eps[0].id, { watch_status: 'watched', position_sec: 3480 })
    updateEpisode(d as any, eps[1].id, { watch_status: 'watching', position_sec: 900 })

    // 第 3 集下到了，另外多了两集
    const out = insertVideo(
      d as any,
      seriesPayload({
        episodes: [
          { season: 1, episode: 1, title: '漆黑的开场', path: 'E:\\TV\\The Glory\\S01E01.mkv', duration_sec: 3480 },
          { season: 1, episode: 2, title: '欢迎来到我的地狱', path: 'E:\\TV\\The Glory\\S01E02.mkv', duration_sec: 3360 },
          { season: 1, episode: 3, title: '她到底是谁', path: 'E:\\TV\\The Glory\\S01E03.mkv', duration_sec: 3480 },
          { season: 1, episode: 4, title: '慢慢渗透', path: 'E:\\TV\\The Glory\\S01E04.mkv' },
          { season: 2, episode: 1, title: '第二季开场', path: 'E:\\TV\\The Glory\\S02E01.mkv' }
        ]
      })
    )
    assert.equal(out.episodesAdded, 2, '该只新增 2 集（E04 和 S02E01）')
    const after = listEpisodes(d as any, id)
    assert.equal(after.length, 5)
    assert.equal(after[0].watch_status, 'watched', '看完的集被打回未看了')
    assert.equal(after[0].position_sec, 3480)
    assert.equal(after[1].position_sec, 900, '在看的集进度丢了')
    // 原先缺文件的第 3 集，路径该补上
    assert.equal(after[2].path, 'E:\\TV\\The Glory\\S01E03.mkv')
    d.close()
  })

  await check('季集唯一：同一季同一集反复入库不长出重复行', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    insertVideo(d as any, seriesPayload())
    insertVideo(d as any, seriesPayload())
    assert.equal(listEpisodes(d as any, id).length, 3, '集列表每扫一次长一倍')
    d.close()
  })

  await check('整部剧的状态从集列表推出来，不让用户再点一次', () => {
    // 一集都没碰 = 未看
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'unwatched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'unwatched'
    )
    // 有一集播过一点 = 在看
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'unwatched', position_sec: 120 } as any,
        { path: 'b', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'watching'
    )
    // 全看完 = 看完
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'watched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'watched', position_sec: 0 } as any
      ]),
      'watched'
    )
    // 缺文件的集不参与判断：手上这两集看完了就算看完，
    // 否则一部还没播完的剧永远到不了「看完」
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'watched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'watched', position_sec: 0 } as any,
        { path: '', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'watched'
    )
    // 一集文件都没有：推不出状态，返回 null 而不是硬说「未看」
    assert.equal(deriveSeriesStatus([{ path: '', watch_status: 'unwatched' } as any]), null)
  })

  await check('用户标了「弃」之后，推导不许把它改回「在看」', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    const eps = listEpisodes(d as any, id)
    updateEpisode(d as any, eps[0].id, { watch_status: 'watched' })
    updateVideo(d as any, id, { watch_status: 'dropped' })
    syncSeriesStatus(d as any, id)
    // 看了 8 集不看了和「在看」在数据上分不出来，只能由用户说 ——
    // 推导覆盖掉它，用户那个决定就永远保不住
    assert.equal(getVideo(d as any, id)!.watch_status, 'dropped')
    d.close()
  })

  await check('剧一级状态跟着集变：标完最后一集自动变「看完」', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    for (const e of listEpisodes(d as any, id)) {
      if (e.path) updateEpisode(d as any, e.id, { watch_status: 'watched' })
    }
    syncSeriesStatus(d as any, id)
    assert.equal(getVideo(d as any, id)!.watch_status, 'watched')
    assert.equal(getVideo(d as any, id)!.episode_watched, 2)
    d.close()
  })

  await check('自动连播跳过缺文件的集，且能跨季', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload({
        episodes: [
          { season: 1, episode: 1, path: 'a.mkv' },
          // 第 2 集缺文件，连播该跳过它 —— 不跳就停在黑屏上，用户以为播放器坏了
          { season: 1, episode: 2, path: '' },
          { season: 1, episode: 3, path: 'c.mkv' },
          { season: 2, episode: 1, path: 'd.mkv' }
        ]
      })
    )
    const n1 = nextEpisode(d as any, id, 1, 1)!
    assert.equal(n1.episode, 3, '缺文件的第 2 集该被跳过')
    const n2 = nextEpisode(d as any, id, 1, 3)!
    assert.equal(n2.season, 2, '该跨季接上 S02E01')
    assert.equal(n2.episode, 1)
    // 最后一集之后没有下一集，返回 null 而不是绕回第一集
    assert.equal(nextEpisode(d as any, id, 2, 1), null)
    d.close()
  })

  await check('筛选：类型 / 观看状态 / 分类 / 标签 / 关键词各自命中', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload())
    insertVideo(d as any, seriesPayload())
    assert.equal(listVideos(d as any, { type: 'movie' }).length, 1)
    assert.equal(listVideos(d as any, { type: 'series' }).length, 1)
    assert.equal(listVideos(d as any, { category: '日韩' }).length, 1)
    assert.equal(listVideos(d as any, { tag: '科幻' }).length, 1)
    assert.equal(listVideos(d as any, { status: 'unwatched' }).length, 2)
    // 中英文标题都要搜得到 —— 规格明确要求
    assert.equal(listVideos(d as any, { keyword: '沙丘' }).length, 1)
    assert.equal(listVideos(d as any, { keyword: 'Glory' }).length, 1)
    assert.equal(listVideos(d as any, { keyword: '不存在的片' }).length, 0)
    d.close()
  })

  await check('标签筛选带引号匹配，「剧情」不该命中「剧情向」', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\a.mkv', tags: ['剧情'] }))
    insertVideo(d as any, moviePayload({ path: 'D:\\b.mkv', tags: ['剧情向'] }))
    assert.equal(listVideos(d as any, { tag: '剧情' }).length, 1)
    d.close()
  })

  await check('排序：年份和评分为 0 的沉到底，不浮在最前面', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\a.mkv', year: 2024, rating: 8.7 }))
    insertVideo(d as any, moviePayload({ path: 'D:\\b.mkv', year: 0, rating: 0 }))
    insertVideo(d as any, moviePayload({ path: 'D:\\c.mkv', year: 1994, rating: 9.7 }))
    // 「不知道年份」不是「公元 0 年」，排序时它该在最后而不是最前
    const byYear = listVideos(d as any, { sort: 'year' }).map((v) => v.year)
    assert.deepEqual(byYear, [2024, 1994, 0])
    const byRating = listVideos(d as any, { sort: 'rating' }).map((v) => v.rating)
    assert.deepEqual(byRating, [9.7, 8.7, 0])
    d.close()
  })

  await check('只有豆瓣评分的片按分排序时不该被当成「没评分」', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\a.mkv', name_zh: 'A', rating: 9.7 }))
    // TMDB 没刮到分，但豆瓣有 —— 卡片上用户看得见那个 8.1
    insertVideo(
      d as any,
      moviePayload({ path: 'D:\\b.mkv', name_zh: 'B', rating: 0, douban_rating: 8.1 })
    )
    insertVideo(d as any, moviePayload({ path: 'D:\\c.mkv', name_zh: 'C', rating: 0 }))
    const order = listVideos(d as any, { sort: 'rating' }).map((v) => v.name_zh)
    // B 沉到底就是自相矛盾：界面显示 8.1，排序当它 0
    assert.deepEqual(order, ['A', 'B', 'C'])
    d.close()
  })

  await check('豆瓣两列存得住读得回，且和 rating 互不干扰', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      moviePayload({ rating: 8.7, douban_id: '1292052', douban_rating: 9.7 })
    )
    const v = getVideo(d as any, id)!
    assert.equal(v.rating, 8.7, 'TMDB 的分不该被豆瓣的覆盖')
    assert.equal(v.douban_id, '1292052')
    assert.equal(v.douban_rating, 9.7)
    // 没填时是 0 和空串，不是 null —— 界面拿 0 判断「没拿到」
    const bare = getVideo(d as any, insertVideo(d as any, moviePayload({ path: 'D:\\z.mkv' })).id)!
    assert.equal(bare.douban_id, '')
    assert.equal(bare.douban_rating, 0)
    d.close()
  })

  await check('重扫补进新集时，剧一级的「看完」要跟着退回「在看」', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    for (const e of listEpisodes(d as any, id)) {
      if (e.path) updateEpisode(d as any, e.id, { watch_status: 'watched' })
    }
    // updateEpisode 不自己刷剧一级，由调用方刷（见 db.ts 的 syncSeriesStatus）
    syncSeriesStatus(d as any, id)
    assert.equal(getVideo(d as any, id)!.watch_status, 'watched')

    // 用户下了后半季再扫一遍
    const out = insertVideo(
      d as any,
      seriesPayload({
        episodes: [
          { season: 1, episode: 1, path: 'E:\\TV\\The Glory\\S01E01.mkv' },
          { season: 1, episode: 2, path: 'E:\\TV\\The Glory\\S01E02.mkv' },
          { season: 1, episode: 3, path: 'E:\\TV\\The Glory\\S01E03.mkv' },
          { season: 1, episode: 4, path: 'E:\\TV\\The Glory\\S01E04.mkv' }
        ]
      })
    )
    assert.ok(out.episodesAdded > 0, '第 4 集是新的')
    const v = getVideo(d as any, id)!
    // 不退回的话：侧栏说「看完」，详情页的 2/4 说没看完，两个数字来自同一个库
    assert.equal(v.watch_status, 'watching')
    assert.equal(v.episode_watched, 2)
    assert.equal(v.episode_total, 4)
    d.close()
  })

  await check('集列表没变的重扫不动剧一级状态 —— 没有新事实就不该推翻用户的标记', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    // 用户没逐集标，直接在剧一级标了「看完」
    updateVideo(d as any, id, { watch_status: 'watched' })
    const out = insertVideo(d as any, seriesPayload())
    assert.equal(out.episodesAdded, 0)
    assert.equal(
      getVideo(d as any, id)!.watch_status,
      'watched',
      '集数没变就没有新事实，按集列表重算一次只会把用户的标记推翻'
    )
    d.close()
  })

  await check('重扫不覆盖已有的海报和背景图', () => {
    const d = freshDb()
    // 第一次刮削落的是 TMDB 相对路径
    const { id } = insertVideo(d as any, moviePayload({ poster_path: '/a.jpg', fanart_path: '/b.jpg' }))
    assert.equal(getVideo(d as any, id)!.poster_path, '/a.jpg')

    // Step 6 下载完把同一列改成本地路径（或者用户自己挑了一张）
    updateVideo(d as any, id, { poster_path: 'C:\\cache\\poster.jpg' })
    insertVideo(d as any, moviePayload({ poster_path: '/c.jpg', fanart_path: '/d.jpg' }))
    const v = getVideo(d as any, id)!
    // 覆盖回相对路径的话，界面拿它当本地文件读，结果是一面空白的海报墙
    assert.equal(v.poster_path, 'C:\\cache\\poster.jpg')
    assert.equal(v.fanart_path, '/b.jpg', '背景图同理')
    d.close()
  })

  await check('海报为空时重扫要补上 —— 只护住已有的，不是从此不写', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload({ poster_path: '', fanart_path: '' }))
    insertVideo(d as any, moviePayload({ poster_path: '/late.jpg', fanart_path: '/late2.jpg' }))
    const v = getVideo(d as any, id)!
    assert.equal(v.poster_path, '/late.jpg')
    assert.equal(v.fanart_path, '/late2.jpg')
    d.close()
  })

  await check('计数：类型和观看状态都是闭集，没有的那个是 0 不是不存在', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload())
    insertVideo(d as any, seriesPayload())
    const c = videoCounts(d as any)
    assert.equal(c.all, 2)
    assert.equal(c.type.movie, 1)
    assert.equal(c.type.series, 1)
    assert.equal(c.status.unwatched, 2)
    assert.equal(c.status.watched, 0, '一个都没有的状态该是 0 而不是缺键')
    assert.equal(c.status.dropped, 0)
    assert.ok(c.categories.some((x) => x.name === '日韩' && x.count === 1))
    assert.ok(c.tags.some((x) => x.name === '科幻'))
    d.close()
  })

  await check('删条目：集和 meta 跟着走，磁盘上的文件不碰', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM episode').get() as any).n, 3)
    deleteVideo(d as any, id)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 0)
    assert.equal(
      (d.prepare('SELECT COUNT(*) AS n FROM episode').get() as any).n,
      0,
      'episode 该靠 CASCADE 跟着删'
    )
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM video_meta').get() as any).n, 0)
    d.close()
  })

  await check('更新走白名单：渲染进程递来的野键进不了 SQL', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    // 这两个键一个是不存在的列、一个是主键，都不该被拼进 UPDATE
    const v = updateVideo(d as any, id, { id: 'hacked', bogus_col: 1 } as any)
    assert.equal(v!.id, id, 'id 被改掉了')
    // 视图现算的三个计数写不进去，也不该报错
    updateVideo(d as any, id, { episode_total: 99 } as any)
    assert.equal(getVideo(d as any, id)!.episode_total, 0)
    d.close()
  })

  await check('CHECK 约束拦得住闭集外的值', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    assert.throws(
      () =>
        d
          .prepare('UPDATE video_meta SET watch_status = ? WHERE resource_id = ?')
          .run('wathcing', id),
      /CHECK/i,
      '拼错的状态被静默收下了，那条记录会从界面上消失'
    )
    assert.throws(
      () => d.prepare('UPDATE video_meta SET video_type = ? WHERE resource_id = ?').run('movei', id),
      /CHECK/i
    )
    d.close()
  })

  await check('JSON 列坏掉时退回空数组，不让整个视频库打不开', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    d.prepare('UPDATE video_meta SET audio_tracks = ?, parts = ? WHERE resource_id = ?').run(
      '{坏掉的不是数组}',
      'null',
      id
    )
    const v = getVideo(d as any, id)!
    assert.deepEqual(v.audio_tracks, [])
    assert.deepEqual(v.parts, [])
    d.close()
  })

  await check('三个品类的 path 共用一个全局唯一键，同一个目录不会被认领两次', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\X\\same.mkv' }))
    // 磁盘只有一块。同一个路径被两个品类各自认领一次的话，整理模块搬动它时
    // 另一个模块的记录会当场失效 —— 这个约束在 resource 表上，不在品类层
    assert.throws(() => {
      d.prepare(
        `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name)
         VALUES ('dup', 'game', 1, 2, 'D:\\X\\same.mkv', 'same.mkv')`
      ).run()
    }, /UNIQUE/i)
    d.close()
  })
}


/* ==================== 文件名解析 · v0.7 Step 2 ==================== */

/**
 * 文件名解析器。
 *
 * 两部分：手写用例表（永远跑）+ guessit 语料（有参考副本时才跑）。
 *
 * 手写那部分是真正的回归网 —— 它进版本库，任何机器上都跑得到，
 * 每一条对应一个曾经踩过的坑。语料那部分在 `.recover/` 里，被 gitignore
 * 挡在版本库外，所以它只能是「有就多验一层」，缺了不能算失败。
 *
 * 语料用「命中数不低于某个下限」而不是「全对」来断言。guessit 认的东西
 * 比这里多（集名、语言、日期、法语西语的季集词），而这一层刻意不认
 * 一部分它认的（裸数字 scene 编号 —— 见 hasSeriesMarker 的注释）。
 * 下限卡住的是「不许退步」，不是「必须追平 guessit」。
 */
export async function videoFilenameSection(): Promise<void> {
  console.log('\n文件名解析')

  await check('中文标题不被季集模式吃掉 —— 上游的 \\W 分隔符会把它切成一个字', () => {
    const r = parseVideoName('漫长的季节.S01E05.2023.2160p.WEB-DL.H265.mp4')
    assert.equal(r.title_zh, '漫长的季节')
    assert.equal(r.season, 1)
    assert.deepEqual(r.episodes, [5])
    assert.equal(r.year, 2023)
  })

  await check('带年份的电影不会被 scene 编号规则拆成剧集', () => {
    // 上游有一条 four-digit-scene-numbering 模式会把 2024 读成 S20E24，
    // 每部带年份的电影都会变成剧集
    const r = parseVideoName('Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv')
    assert.equal(r.season, null)
    assert.deepEqual(r.episodes, [])
    assert.equal(r.absolute_episode, null)
    assert.equal(r.looks_like_series, false)
    assert.equal(r.year, 2024)
    assert.equal(r.title_en, 'Dune Part Two')
  })

  await check('片名里的四位数不会被当成年份', () => {
    // 取标题区之后的最后一个年份：2049 是片名的一部分
    assert.equal(parseYear('Blade.Runner.2049.2017.2160p.mkv'), 2017)
    assert.equal(parseYear('2012.2009.1080p.BluRay.mkv'), 2009)
    // 分辨率里的四位数也不是年份，大小写的 x 都要挡
    assert.equal(parseYear('Apotheosis_1920x1080.mp4'), 0)
    assert.equal(parseYear('Pirates.2008.FRENCH.1920X1080.h264.mkv'), 2008)
    // 紧跟在字母后面的四位数不是年份（BT2020 是色域标记）
    assert.equal(parseYear('Life of Pi 2012 2160p BluRay BT2020 DTSHD.mkv'), 2012)
    // 括号里的年份最明确，优先
    assert.equal(parseYear('某片(2019).1080p.mkv'), 2019)
  })

  await check('明写的 SxxExx 压得住其他模式', () => {
    // 上游在这条上会去匹配 `Part.1` 而给出 E1
    const r = parseVideoName('Adventure.Time.S08E16.Elements.Part.1.Skyhooks.720p.WEB-DL.mkv')
    assert.equal(r.season, 8)
    assert.deepEqual(r.episodes, [16])
    // S06xE01、S013E18、S01Extras 这几种上游直接给 null
    assert.equal(parseLatinSeasonEpisode('The Office - S06xE01.avi')?.season, 6)
    assert.deepEqual(parseLatinSeasonEpisode('The Office - S06xE01.avi')?.episodes, [1])
    assert.equal(parseLatinSeasonEpisode('CSI.S013E18.Sheltered.720p.mkv')?.season, 13)
    assert.equal(parseLatinSeasonEpisode('My.Name.Is.Earl.S01Extras.avi')?.season, 1)
    // 一个文件里多集：S01E02E03
    assert.deepEqual(parseLatinSeasonEpisode('Show.S01E02E03.mkv')?.episodes, [2, 3])
  })

  await check('中文季集标记不被降级成绝对集号', () => {
    // `第01集` 是明确的第 1 集，降成绝对集号会让它排不进任何一季
    const a = parseVideoName('狂飙.第01集.1080p.mkv')
    assert.deepEqual(a.episodes, [1])
    assert.equal(a.absolute_episode, null)
    assert.equal(a.title_zh, '狂飙')

    const b = parseVideoName('权力的游戏.第二季.第05集.1080p.mkv')
    assert.equal(b.season, 2)
    assert.deepEqual(b.episodes, [5])
    assert.equal(b.absolute_episode, null)

    assert.deepEqual(parseCnSeasonEpisode('某剧.第十二季.第二十集.mkv'), { season: 12, episode: 20 })
    assert.deepEqual(parseCnSeasonEpisode('某剧.第3话.mkv'), { season: null, episode: 3 })
  })

  await check('中文数字转阿拉伯数字，1-99', () => {
    assert.equal(cnNumber('一'), 1)
    assert.equal(cnNumber('十'), 10)
    assert.equal(cnNumber('十二'), 12)
    assert.equal(cnNumber('二十'), 20)
    assert.equal(cnNumber('二十三'), 23)
    assert.equal(cnNumber('05'), 5)
    // 认不出来给 0，调用方拿 `|| null` 兜住
    assert.equal(cnNumber('甲'), 0)
    assert.equal(cnNumber(''), 0)
  })

  await check('番剧的裸集号只在有字幕组前缀时才认', () => {
    // 集号在标题后面
    assert.equal(parseAnimeEpisode('[SubsPlease] Frieren - 12 (1080p) [F1A2B3C4].mkv'), 12)
    assert.equal(parseAnimeEpisode('[Figmentos] Monster 34 - At the End of Darkness [781219F1].mkv'), 34)
    // 集号后面紧跟下划线（`\w` 含下划线，所以边界不能用 \b）
    assert.equal(parseAnimeEpisode('[Evil-Saizen]_Laughing_Salesman_14_[DVD][1C98686A].mkv'), 14)
    // 集号在标题前面
    assert.equal(parseAnimeEpisode('[DeadFish] 01 - Tari Tari [BD][720p][AAC].mp4'), 1)
    // 中间夹着规格方括号块
    assert.equal(parseAnimeEpisode('[aprm] [BD][1080p] Nagi no Asukara 08 [4D102B7C].mkv'), 8)
    // 没有字幕组前缀就不认 —— 裸数字规则会毁掉 `Se7en`、`2012` 这类片名
    assert.equal(parseAnimeEpisode('Bleach - 313.mkv'), null)
    // 方括号里的数字不是集号
    assert.equal(parseAnimeEpisode('[XCT] Persepolis [H264+Aac-128(Fr-Eng)+ST(Fr-Eng)].mkv'), null)
    // 裸数字后面直接跟技术标记的，那个数字是片名的一部分
    assert.equal(parseAnimeEpisode('[h265 - hevc] transformers 2 1080p french ac3 6ch.mkv'), null)
  })

  await check('番剧集号排在上游那张表前面', () => {
    // 合集文件 `02-03` 的首集号是 2，上游给 3
    const r = parseVideoName('[ShinBunBu-Subs] Bleach - 02-03 (CX 1280x720 x264 AAC).mkv')
    assert.equal(r.absolute_episode, 2)
    assert.equal(r.season, null, '绝对集号不带季信息，硬填 1 会和真第一季撞车')
  })

  await check('NxNN 那个形状：季集、赛季年、像素尺寸得分开', () => {
    assert.equal(parseLatinSeasonEpisode('The Sopranos - [05x07] - In Camelot.mp4')?.season, 5)
    assert.equal(parseLatinSeasonEpisode('2x05 - Pure Laine.avi')?.season, 2)
    // 体育赛事拿年份当季号
    assert.equal(parseLatinSeasonEpisode('MotoGP.2016x03.USA.Race.1080p')?.season, 2016)
    // 像素尺寸不是季集
    assert.equal(parseLatinSeasonEpisode('Apotheosis_1920x1080.mp4'), null)
    assert.equal(parseLatinSeasonEpisode('[Doremi].Precure.[1280x720].mkv'), null)
    // 长宽比也不是
    assert.equal(parseLatinSeasonEpisode('Movie.16x9.aspect.mkv'), null)
    // 四位数开头再跟 1-2 位数的是日期
    assert.equal(parseLatinSeasonEpisode('Something.2008x12.13-FlexGet'), null)
    // 但一位数季号后面跟的 `.18` 是集名，不是日期
    assert.equal(parseLatinSeasonEpisode('The.Mentalist.2x21.18-5-4.HDTV.avi')?.season, 2)
  })

  await check('「Season」是片名里的词时不算季标记', () => {
    // 后面跟着括号年份的是电影
    assert.equal(parseLatinSeasonEpisode('Open Season 2 (2008) - Bluray-1080p.mkv'), null)
    // 拼出来的 Season 后面跟四位数，那是年份 —— guessit 自己的语料也标了 -season
    assert.equal(parseLatinSeasonEpisode('Show.Name.Season.2025.1080p.WEB-DL.mkv'), null)
    // 正常的整季包照认，复数形式也认
    assert.equal(parseLatinSeasonEpisode('Show.Season.2.1080p.mkv')?.season, 2)
    assert.equal(parseLatinSeasonEpisode('Something Seasons 4 Complete')?.season, 4)
    assert.equal(parseLatinSeasonEpisode('三体.Three-Body.2023.S01.2160p.mkv')?.full_season, true)
  })

  await check('分辨率、片源、发布组只报文件名字面写了的', () => {
    // 上游会从 `.mkv` 扩展名猜出 WEBDL + 720p —— Radarr 需要一个画质做下载
    // 决策，猜一个比没有强；这里恰好相反，第 4 步能从容器里读出真值
    const a = parseVideoName('某电影.2020.花絮.mkv')
    assert.equal(a.resolution, '')
    assert.equal(a.source, '')
    // `WEB-DL` 的 DL 不是发布组
    assert.equal(parseVideoName('流浪地球2.2023.2160p.WEB-DL.mkv').release_group, '')
    // `-sample` 也不是
    assert.equal(parseVideoName('Movie.2019.1080p-sample.mkv').release_group, '')
    // 真写了的照报
    const b = parseVideoName('The.Glory.S01E03.1080p.NF.WEB-DL.x264-GRP.mkv')
    assert.equal(b.resolution, '1080p')
    assert.equal(b.source, 'WEBDL')
    assert.equal(b.release_group, 'GRP')
  })

  await check('花絮预告样片认得出来，中英文都要认', () => {
    assert.deepEqual(detectExtra('某电影.2020.花絮.mkv'), { is_extra: true, kind: 'featurette' })
    assert.deepEqual(detectExtra('Movie.2019.1080p-sample.mkv'), { is_extra: true, kind: 'sample' })
    assert.equal(detectExtra('某片.预告片.mp4').is_extra, true)
    assert.equal(detectExtra('Movie.Behind.the.Scenes.mkv').kind, 'featurette')
    assert.equal(detectExtra('Movie.Deleted.Scenes.mkv').kind, 'deleted')
    assert.equal(detectExtra('[组] 某番 NCOP1 [CRC].mkv').kind, 'opening')
    // 正片不该被误判
    assert.equal(detectExtra('The.Glory.S01E03.1080p.WEB-DL.mkv').is_extra, false)
    assert.equal(detectExtra('漫长的季节.S01E05.2023.mkv').is_extra, false)
  })

  await check('分卷只认 CD/DISC/DVD + 数字，不认 Part N', () => {
    assert.equal(parsePart('Interstellar.2014.1080p.BluRay.x264.CD1.avi'), 1)
    assert.equal(parsePart('Movie.2014.DISC2.mkv'), 2)
    // `Dune: Part Two` 的 Part 是片名的一部分，认成分卷会把两部电影合成一条
    assert.equal(parsePart('Dune.Part.Two.2024.2160p.mkv'), null)
    assert.equal(parsePart('Harry.Potter.Part.1.2010.mkv'), null)
  })

  await check('中英双名拆得开，片名里的数字跟着中文走', () => {
    assert.deepEqual(splitTitle(titleRegion('三体.Three-Body.2023.S01.2160p.mkv')), {
      zh: '三体',
      en: 'Three-Body'
    })
    assert.deepEqual(splitTitle(titleRegion('灌篮高手.THE.FIRST.SLAM.DUNK.2022.BluRay.mkv')), {
      zh: '灌篮高手',
      en: 'THE FIRST SLAM DUNK'
    })
    // 按 token 分组而不是按第一个非 CJK 字符切：`流浪地球2` 的 2 是片名的一部分
    assert.deepEqual(splitTitle(titleRegion('流浪地球2.2023.2160p.WEB-DL.mkv')), {
      zh: '流浪地球2',
      en: ''
    })
  })

  await check('标题在第一个技术标记处结束，按位置不按优先级', () => {
    // 年份在前和分辨率在前都该切出同一个标题
    assert.equal(titleRegion('沙丘.2024.2160p.mkv').trim(), '沙丘')
    assert.equal(titleRegion('沙丘.2160p.2024.mkv').trim(), '沙丘')
    // `2012` 这种纯数字片名不能被年份规则切光
    assert.equal(titleRegion('2012.2009.1080p.BluRay.mkv').trim(), '2012')
    // 字幕组前缀和结尾 CRC 都剥掉
    assert.equal(titleRegion('[SubsPlease] Frieren - 12 (1080p) [F1A2B3C4].mkv').trim(), 'Frieren')
    // 中文字幕标记也是切点（`\b` 在 CJK 两侧不成立，所以那条不能带 \b）
    assert.equal(titleRegion('某剧.中英双字.1080p.mkv').trim(), '某剧')
  })

  await check('hintSeries 只放开季集解析，不凭空造季号', () => {
    // 扫描器知道「这个文件在一个有 12 个同名文件的目录里」时传 true
    const hinted = parseVideoName('new.girl.117.hdtv-lol.mp4', true)
    assert.equal(hinted.season, 1)
    assert.deepEqual(hinted.episodes, [17])
    // 不传就不认 —— 这个形状和电影的 `Movie.2019` 分不开
    const bare = parseVideoName('new.girl.117.hdtv-lol.mp4')
    assert.equal(bare.season, null)
    // hint 为 true 但文件名里真没有季集信息时，只标记「看起来是剧集」，
    // 不编一个季号出来
    const nothing = parseVideoName('某片.2020.1080p.mkv', true)
    assert.equal(nothing.season, null)
    assert.deepEqual(nothing.episodes, [])
    assert.equal(nothing.looks_like_series, true)
  })

  await guessitCorpusChecks()
}


/**
 * guessit 的 yml 测试语料。
 *
 * 语料在 `.recover/v07-refs/` 下，被 gitignore 挡在版本库外（GPL/LGPL 的
 * 参考物只读不抄，见 electron/kinds/video/parser/ORIGIN.md）。所以这一段
 * 缺了参考副本就跳过，不能算失败 —— 别的机器上没有那个目录。
 */
export async function guessitCorpusChecks(): Promise<void> {
  const dir = path.resolve('.recover/v07-refs/guessit-develop/guessit/test')
  if (!fs.existsSync(dir)) {
    console.log('  - guessit 语料不在本地（.recover/ 不进版本库），跳过')
    return
  }

  const yaml = await import('js-yaml')

  interface Corpus {
    file: string
    cases: Array<{ name: string; want: Record<string, unknown> }>
  }

  const load = (file: string): Corpus => {
    // json: true 允许重复键（语料里同一个文件名出现过两次），后者覆盖前者
    const doc = yaml.default.load(fs.readFileSync(path.join(dir, file), 'utf8'), {
      json: true
    }) as Record<string, unknown>
    const cases: Corpus['cases'] = []
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (key === '__default__' || !value || typeof value !== 'object') continue
      // guessit 喂的是整条路径，这一层只收文件名 —— 目录信息由扫描器另外给
      cases.push({ name: path.basename(key.replace(/\\/g, '/')), want: value as Record<string, unknown> })
    }
    return { file, cases }
  }

  /** 语料里 season/episode 可能是单值也可能是数组，取第一个 */
  const first = (v: unknown): number | null => {
    if (typeof v === 'number') return v
    if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
    return null
  }

  const corpora = ['episodes.yml', 'movies.yml', 'various.yml'].map(load)

  /**
   * 命中数下限。这些数字是 2026-08-30 实测值，留了几条余量。
   *
   * 卡的是「不许退步」。差距那部分是刻意不认的（裸数字 scene 编号）
   * 和不打算认的（法语 Saison、西语 Temporada 之类的季集词）。
   */
  const FLOOR: Record<string, { season: number; episode: number; year: number }> = {
    'episodes.yml': { season: 305, episode: 348, year: 36 },
    'movies.yml': { season: 0, episode: 0, year: 164 },
    'various.yml': { season: 72, episode: 75, year: 51 }
  }

  for (const { file, cases } of corpora) {
    await check(`${file}：季集年份命中数不低于下限（${cases.length} 条语料）`, () => {
      let season = 0
      let episode = 0
      let year = 0
      for (const c of cases) {
        const got = parseVideoName(c.name)
        const wantSeason = first(c.want.season)
        const wantEp = first(c.want.episode)
        if (wantSeason !== null && got.season === wantSeason) season++
        if (wantEp !== null && (got.episodes[0] === wantEp || got.absolute_episode === wantEp)) episode++
        if (typeof c.want.year === 'number' && got.year === c.want.year) year++
      }
      const floor = FLOOR[file]
      assert.ok(season >= floor.season, `季号命中 ${season}，低于下限 ${floor.season}`)
      assert.ok(episode >= floor.episode, `集号命中 ${episode}，低于下限 ${floor.episode}`)
      assert.ok(year >= floor.year, `年份命中 ${year}，低于下限 ${floor.year}`)
    })
  }

  await check('一条电影语料都不许被认成剧集', () => {
    // 这是这一段里唯一的零容忍断言。漏认一部剧，用户在确认面板里改一下就好；
    // 错认一部电影，它的年份变成季号，海报墙上多出「24/0 集」，
    // 而用户完全看不出为什么
    const wrong: string[] = []
    for (const { cases } of corpora) {
      for (const c of cases) {
        if (first(c.want.season) !== null || first(c.want.episode) !== null) continue
        if (c.want.type === 'episode') continue
        // guessit 有一批只断言单个属性的用例（`options: -T "..."`、只测字幕语言），
        // 它们没有 season 键不代表「这是电影」
        if ('options' in c.want || '-season' in c.want || '-episode' in c.want) continue
        if (!('title' in c.want)) continue
        const got = parseVideoName(c.name)
        if (got.season !== null || got.episodes.length > 0 || got.absolute_episode !== null) {
          wrong.push(`${c.name} -> S${got.season} E[${got.episodes}] abs=${got.absolute_episode}`)
        }
      }
    }
    assert.deepEqual(wrong, [], `被错认成剧集：\n  ${wrong.join('\n  ')}`)
  })

  await check('hintSeries 打开后命中率明显更高 —— 扫描器靠它补目录上下文', () => {
    // 各语料里「传了 hint 比不传多认出多少条」。这条守的是 hint 这个入口
    // 真的有用：如果哪天 hint 被接反或被无视，这里会掉到 0
    let gained = 0
    for (const { cases } of corpora) {
      for (const c of cases) {
        const wantEp = first(c.want.episode)
        if (wantEp === null) continue
        const bare = parseVideoName(c.name)
        const hinted = parseVideoName(c.name, true)
        const hitBare = bare.episodes[0] === wantEp || bare.absolute_episode === wantEp
        const hitHint = hinted.episodes[0] === wantEp || hinted.absolute_episode === wantEp
        if (!hitBare && hitHint) gained++
      }
    }
    assert.ok(gained >= 40, `hint 只多认出 ${gained} 条，太少了，怀疑没接上`)
  })
}



/* ==================== 视频扫描 · v0.7 Step 3 ==================== */

/**
 * 造一棵真实的临时片库来跑 scanner。理由和游戏识别那一段一样：
 * 这一整段全是「读磁盘之后怎么归堆」，用假的 fs mock 验它等于在验 mock 自己。
 *
 * 这棵树是照着真实片库里会出现的形状搭的，每一枝对着一条规则：
 * 季目录 / 平铺季集 / 番剧字幕组 / 独占目录的电影 / CD 分卷 / 一个目录多部片 /
 * 花絮目录 / 花絮后缀 / Specials 是第 0 季而不是花絮。
 */
export async function videoScanSection(): Promise<void> {
  console.log('\n视频扫描')

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-vscan-'))
  const mk = async (rel: string, bytes = 1024): Promise<string> => {
    const full = path.join(base, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, Buffer.alloc(bytes))
    return full
  }

  // 剧集：两季各两集，外加一个 Specials（第 0 季，不是花絮）
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S01E01.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S01E02.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Season 2/漫长的季节.S02E01.2023.1080p.WEB-DL.mkv')
  // 故意放错位置：S02E05 待在 Season 1 目录里。真实片库里这种常有
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S02E05.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Specials/漫长的季节.E01.mkv')
  await mk('剧集/漫长的季节/poster.jpg')
  await mk('剧集/漫长的季节/tvshow.nfo')

  // 剧集：没有季目录，季集号全写在文件名里
  await mk('剧集/The Glory/The.Glory.S01E01.1080p.NF.WEB-DL.x264-GRP.mkv')
  await mk('剧集/The Glory/The.Glory.S01E02.1080p.NF.WEB-DL.x264-GRP.mkv')

  // 番剧：字幕组前缀 + 绝对集号
  await mk('番剧/葬送的芙莉莲/[SubsPlease] Sousou no Frieren - 11 (1080p) [1A2B3C4D].mkv')
  await mk('番剧/葬送的芙莉莲/[SubsPlease] Sousou no Frieren - 12 (1080p) [5E6F7A8B].mkv')

  // 电影：独占目录，带侧车，还带两种花絮
  await mk('电影/沙丘 (2021)/沙丘.Dune.2021.2160p.BluRay.x265.mkv', 4096)
  await mk('电影/沙丘 (2021)/沙丘.Dune.2021.2160p.BluRay.x265.chs.srt')
  await mk('电影/沙丘 (2021)/poster.jpg')
  await mk('电影/沙丘 (2021)/movie.nfo')
  await mk('电影/沙丘 (2021)/沙丘-trailer.mkv')
  await mk('电影/沙丘 (2021)/Featurettes/making-of.mkv')

  // 电影：CD 分卷
  await mk('电影/无间道/无间道.CD1.avi')
  await mk('电影/无间道/无间道.CD2.avi')

  // 一个目录里并列两部电影，各带同名字幕
  await mk('散装/罗马.Roma.2018.1080p.WEB-DL.mkv')
  await mk('散装/罗马.Roma.2018.1080p.WEB-DL.chs.srt')
  await mk('散装/寄生虫.Parasite.2019.1080p.BluRay.mkv')
  await mk('散装/寄生虫.Parasite.2019.1080p.BluRay.chs.srt')

  const found = scanVideoRoot(base)
  const byPath = (rel: string): any => found.find((c) => c.path === path.join(base, rel))

  await check('季目录把两季收成一条，而不是两条剧', () => {
    const hits = found.filter((c) => c.video_type === 'series' && c.title_zh === '漫长的季节')
    assert.equal(hits.length, 1, `应该只有一条，实际 ${hits.length} 条`)
    assert.equal(hits[0].path, path.join(base, '剧集/漫长的季节'))
  })

  await check('Specials 是第 0 季，不是花絮 —— 剔掉它就是实打实的丢数据', () => {
    const s = byPath('剧集/漫长的季节')
    const seasons = s.episodes.map((e: any) => e.season)
    assert.ok(seasons.includes(0), `没收到第 0 季，实际季号 ${JSON.stringify(seasons)}`)
    assert.deepEqual(
      s.episodes.map((e: any) => `S${e.season}E${e.episode}`),
      ['S0E1', 'S1E1', 'S1E2', 'S2E1', 'S2E5']
    )
  })

  await check('文件名里的季号压过季目录 —— 放错位置的文件是真实存在的', () => {
    const s = byPath('剧集/漫长的季节')
    const misplaced = s.episodes.find((e: any) => e.episode === 5)
    // 它躺在 Season 1 目录里，但文件名写的是 S02
    assert.ok(misplaced.files[0].path.includes(`Season 1${path.sep}`))
    assert.equal(misplaced.season, 2, '目录位置压过了文件名里明写的季号')

    // 反过来那半边：Specials 里那个文件名没有季号，才用目录给的 0
    const sp = s.episodes.find((e: any) => e.season === 0)
    assert.equal(path.basename(sp.files[0].path), '漫长的季节.E01.mkv')
  })

  await check('没有季目录时，季集号从文件名来', () => {
    const s = byPath('剧集/The Glory')
    assert.equal(s.video_type, 'series')
    assert.deepEqual(s.episodes.map((e: any) => `S${e.season}E${e.episode}`), ['S1E1', 'S1E2'])
  })

  await check('番剧绝对集号归并，文件原名优先，目录保留作上下文', () => {
    const s = byPath('番剧/葬送的芙莉莲')
    assert.equal(s.video_type, 'series')
    assert.equal(s.title_en, 'Sousou no Frieren')
    assert.equal(path.basename(s.directory), '葬送的芙莉莲')
    assert.deepEqual(s.episodes.map((e: any) => e.episode), [11, 12])
  })

  await check('独占目录的电影：路径取目录，年份从目录名补上', () => {
    const m = byPath('电影/沙丘 (2021)')
    assert.equal(m.video_type, 'movie')
    assert.equal(m.title_zh, '沙丘')
    assert.equal(m.year, 2021)
    assert.equal(m.files.length, 1)
  })

  await check('花絮目录和花絮后缀都剔掉，但记下来不丢', () => {
    const m = byPath('电影/沙丘 (2021)')
    const names = m.extras.map((e: any) => path.basename(e.path)).sort()
    assert.deepEqual(names, ['making-of.mkv', '沙丘-trailer.mkv'])
    // 剔掉的东西不许混进正片
    assert.ok(!m.files.some((f: any) => /trailer|making/i.test(f.name)))
  })

  await check('侧车按目录收齐：nfo / 海报 / 字幕各归各的', () => {
    const m = byPath('电影/沙丘 (2021)')
    assert.equal(m.sidecars.nfo.length, 1)
    assert.equal(m.sidecars.images.length, 1)
    assert.equal(m.sidecars.subtitles.length, 1)
  })

  await check('CD1/CD2 合成一条，两个文件按卷号排好', () => {
    const m = byPath('电影/无间道')
    assert.equal(m.video_type, 'movie')
    assert.equal(m.files.length, 2)
    assert.deepEqual(m.files.map((f: any) => f.part), [1, 2])
  })

  await check('一个目录里两部电影：各自一条，路径用文件不用目录', () => {
    const loose = found.filter((c) => path.dirname(c.path) === path.join(base, '散装'))
    assert.equal(loose.length, 2, `应该 2 条，实际 ${loose.length} 条`)
    assert.ok(loose.every((c: any) => c.video_type === 'movie'))
    // 路径必须是文件本身 —— 都用目录的话两部片会抢同一个全局唯一键
    assert.ok(loose.every((c: any) => c.path.endsWith('.mkv')))
  })

  await check('目录里有多部片时，字幕只跟同名的那一部走', () => {
    const roma = found.find((c) => c.title_zh === '罗马')!
    const para = found.find((c) => c.title_zh === '寄生虫')!
    assert.equal(roma.sidecars.subtitles.length, 1)
    assert.equal(para.sidecars.subtitles.length, 1)
    assert.ok(path.basename(roma.sidecars.subtitles[0]).startsWith('罗马'))
    assert.ok(path.basename(para.sidecars.subtitles[0]).startsWith('寄生虫'))
  })

  await check('一部电影没有被认成剧 —— 这是最要命的那个错法', () => {
    const movies = ['电影/沙丘 (2021)', '电影/无间道']
    for (const rel of movies) {
      const m = byPath(rel)
      assert.equal(m.video_type, 'movie', `${rel} 被认成了 ${m.video_type}`)
      assert.equal(m.episodes.length, 0)
    }
    assert.ok(found.filter((c) => path.dirname(c.path) === path.join(base, '散装')).every((c) => c.video_type === 'movie'))
  })

  await check('季目录名：S01 / Season 2 / 第三季 / Specials 都认得出来', () => {
    assert.deepEqual(parseSeasonFolder('S01'), { season: 1, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('Season 2'), { season: 2, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('第三季'), { season: 3, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('第十二季'), { season: 12, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('Specials'), { season: 0, kind: 'marked' })
  })

  await check('四位数目录是年份不是季号，纯数字只当弱信号', () => {
    assert.equal(parseSeasonFolder('2019'), null)
    assert.deepEqual(parseSeasonFolder('3'), { season: 3, kind: 'numeric' })
    // S01E01 是单集文件名，不是季目录
    assert.equal(parseSeasonFolder('S01E01'), null)
  })

  await check('Specials 和 extras 不在花絮目录表里，trailers 在', () => {
    assert.equal(isExtraDir('Specials'), false)
    assert.equal(isExtraDir('Trailers'), true)
    assert.equal(isExtraDir('花絮'), true)
    assert.equal(isExtraDir('Season 1'), false)
  })

  await check('分卷只认 CD/DVD/DISC + 数字，Part N 不认', () => {
    assert.deepEqual(stackParts('无间道.CD1'), { stem: '无间道', part: 1 })
    assert.deepEqual(stackParts('Movie (DISC 2)'), { stem: 'Movie', part: 2 })
    assert.equal(stackParts('Dune.Part.Two'), null)
    assert.equal(stackParts('沙丘.2021.1080p'), null)
    // 整个名字就是个卷号标记时不算分卷，否则 stem 会是空串
    assert.equal(stackParts('CD1'), null)
  })

  await fsp.rm(base, { recursive: true, force: true })
}


/* ==================== NFO 解析 · v0.7 Step 4 ==================== */

/**
 * nfo 是视频版的 `app.info`，而且更好 —— 它常常直接带着 TMDB / IMDB id。
 * 所以这一段验的重点不是「字段读没读到」，而是**最值钱的那几个字段在各种
 * 畸形输入下还在不在**：id、标题、年份。
 *
 * 用例的形状全部照真实片库里会出现的样子写：CDATA 包着带 HTML 的简介、
 * 历年不同工具留下的三代 id 写法、一格里塞多个类型的 genre、
 * 只有一行 URL 的老 nfo、以及被手改坏的 XML。
 */
export async function videoNfoSection(): Promise<void> {
  console.log('\nNFO 解析')

  const fullMovie = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>沙丘</title>
  <originaltitle>Dune</originaltitle>
  <plot><![CDATA[一段带 <b>HTML</b> 的简介 & 特殊字符]]></plot>
  <year>2021</year>
  <premiered>2021-10-22</premiered>
  <runtime>155</runtime>
  <mpaa>PG-13</mpaa>
  <genre>科幻</genre>
  <genre>冒险 / 剧情</genre>
  <studio>Legendary</studio>
  <director>Denis Villeneuve</director>
  <credits>Jon Spaihts</credits>
  <credits>Eric Roth</credits>
  <set><name>沙丘系列</name></set>
  <ratings>
    <rating name="themoviedb" max="10" default="true"><value>7.8</value><votes>11234</votes></rating>
    <rating name="imdb" max="10"><value>8.0</value><votes>700000</votes></rating>
  </ratings>
  <userrating>9</userrating>
  <uniqueid type="tmdb" default="true">438631</uniqueid>
  <uniqueid type="imdb">tt1160419</uniqueid>
  <actor><name>提莫西·查拉梅</name><role>保罗</role><order>0</order><thumb>http://x/1.jpg</thumb></actor>
  <actor><name>赞达亚</name><role>契妮</role><order>1</order></actor>
  <playcount>2</playcount>
  <resume><position>1200.5</position><total>9300</total></resume>
  <thumb aspect="poster">http://x/poster.jpg</thumb>
  <fanart><thumb>http://x/fan1.jpg</thumb><thumb>http://x/fan2.jpg</thumb></fanart>
</movie>`

  await check('电影 nfo：标题 / 年份 / 日期 / 片长 / 分级都读得出来', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.kind, 'movie')
    assert.equal(n.title, '沙丘')
    assert.equal(n.original_title, 'Dune')
    assert.equal(n.year, 2021)
    assert.equal(n.premiered, '2021-10-22')
    assert.equal(n.runtime_min, 155)
    assert.equal(n.mpaa, 'PG-13')
    assert.equal(n.set, '沙丘系列')
  })

  await check('CDATA 里的 HTML 和实体字符原样保留，不被吃掉', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.plot, '一段带 <b>HTML</b> 的简介 & 特殊字符')
  })

  await check('一格里塞多个类型的 genre 拆得开，且去重保序', () => {
    const n = parseNfo(fullMovie)!
    assert.deepEqual(n.genres, ['科幻', '冒险', '剧情'])
    assert.deepEqual(n.writers, ['Jon Spaihts', 'Eric Roth'])
  })

  await check('演员表带角色和序号，没有 name 的条目丢掉', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.actors.length, 2)
    assert.equal(n.actors[0].name, '提莫西·查拉梅')
    assert.equal(n.actors[0].role, '保罗')
    assert.equal(n.actors[1].thumb, '')
    const empty = parseNfo('<movie><actor><role>无名氏</role></actor></movie>')!
    assert.equal(empty.actors.length, 0)
  })

  await check('uniqueid 的现代写法：按 type 分派，default 不影响归属', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.tmdb_id, '438631')
    assert.equal(n.imdb_id, 'tt1160419')
  })

  await check('老写法的 <id>：tt 开头归 IMDB，纯数字归 TMDB', () => {
    assert.equal(parseNfo('<movie><id>tt0111161</id></movie>')!.imdb_id, 'tt0111161')
    assert.equal(parseNfo('<movie><id>550</id></movie>')!.tmdb_id, '550')
    // 已经有 tvdb 时纯数字的 <id> 不认 —— 那多半是同一个 tvdb id，
    // 认成 tmdb 会去刮到另一部完全不相干的片
    const withTvdb = parseNfo('<tvshow><id>73739</id><uniqueid type="tvdb">73739</uniqueid></tvshow>')!
    assert.equal(withTvdb.tvdb_id, '73739')
    assert.equal(withTvdb.tmdb_id, '')
  })

  await check('评分一律折算成十分制，max 必须看', () => {
    assert.equal(parseNfo(fullMovie)!.rating, 7.8)
    // 现代写法带 max
    assert.equal(parseNfo('<movie><ratings><rating max="100" default="true"><value>75</value></rating></ratings></movie>')!.rating, 7.5)
    // 老写法没有 max，超过 10 的按百分制折
    const legacy = parseNfo('<movie><rating>85</rating><votes>1,234</votes></movie>')!
    assert.equal(legacy.rating, 8.5)
    assert.equal(legacy.votes, 1234, '带千分位逗号的票数要读得出来')
  })

  await check('default="true" 的那条评分优先，没有就取第一条', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.votes, 11234, '取的应该是 themoviedb 那条而不是 imdb 那条')
    const noDefault = parseNfo('<movie><ratings><rating><value>6.0</value></rating><rating><value>9.0</value></rating></ratings></movie>')!
    assert.equal(noDefault.rating, 6.0)
  })

  await check('观看状态只读出来，不在这一层折算成 watch_status', () => {
    const n = parseNfo(fullMovie)!
    assert.equal(n.playcount, 2)
    assert.equal(n.resume_position_sec, 1201)
    assert.equal(n.resume_total_sec, 9300)
    // 这一层不该有 watch_status 字段 —— 采信别家媒体中心的记录是入库策略要决定的事
    assert.equal((n as unknown as Record<string, unknown>).watch_status, undefined)
  })

  await check('季集号的零值是 -1 而不是 0 —— 0 是合法季号（特别篇）', () => {
    const movie = parseNfo(fullMovie)!
    assert.equal(movie.season, -1)
    assert.equal(movie.episode, -1)
    const sp = parseNfo('<episodedetails><season>0</season><episode>1</episode></episodedetails>')!
    assert.equal(sp.season, 0, '第 0 季被当成了「没写」')
    assert.equal(sp.episode, 1)
  })

  await check('只有一行 URL 的老 nfo 也要把 id 捞出来', () => {
    const imdb = parseNfo('https://www.imdb.com/title/tt0111161/\n')!
    assert.equal(imdb.imdb_id, 'tt0111161')
    assert.equal(imdb.kind, 'unknown')
    const tmdb = parseNfo('https://www.themoviedb.org/movie/438631-dune')!
    assert.equal(tmdb.tmdb_id, '438631')
  })

  await check('BOM 和 XML 前面的注释不影响根标签识别', () => {
    const n = parseNfo('﻿<!-- written by SomeTool -->\n<movie><title>带BOM</title></movie>')!
    assert.equal(n.title, '带BOM')
    assert.equal(n.kind, 'movie')
  })

  await check('XML 被改坏时仍要把 id 捞回来 —— 解析器是静默恢复不是抛异常', () => {
    // 实测行为：fast-xml-parser 遇到没闭合的标签不抛，而是丢掉那段内容。
    // 所以 try/catch 等不到，得靠 withIdBackfill 去原文里再扫一遍
    const n = parseNfo('<movie><title>没闭合 <uniqueid type="imdb">tt0111161</movie>')!
    assert.equal(n.title, '没闭合')
    assert.equal(n.imdb_id, 'tt0111161', 'id 在畸形 XML 里丢了')
  })

  await check('已经解出 id 时不被原文兜底覆盖', () => {
    // 原文里另有一个 tt 号，但正常解析出来的那个优先
    const n = parseNfo('<movie><uniqueid type="imdb">tt1160419</uniqueid><plot>参考 tt0111161</plot></movie>')!
    assert.equal(n.imdb_id, 'tt1160419')
  })

  await check('多集 nfo：两段 episodedetails 都取得到，parseNfo 只给第一段', () => {
    const multi = `<episodedetails><title>第一集</title><season>1</season><episode>1</episode></episodedetails>
<episodedetails><title>第二集</title><season>1</season><episode>2</episode></episodedetails>`
    const all = parseNfoEpisodes(multi)
    assert.deepEqual(all.map((e) => `S${e.season}E${e.episode} ${e.title}`), ['S1E1 第一集', 'S1E2 第二集'])
    assert.equal(parseNfo(multi)!.title, '第一集')
  })

  await check('没有 <year> 时从 premiered / aired 里补', () => {
    const ep = parseNfo('<episodedetails><aired>2023-05-01</aired></episodedetails>')!
    assert.equal(ep.year, 2023)
    assert.equal(ep.premiered_ts, dateToEpochSec('2023-05-01'))
  })

  await check('日期转 Unix 秒走 UTC，不受运行机器时区影响', () => {
    // new Date('2021-10-22') 在不同运行时对无时区日期的解释不一样，
    // 会让同一个 nfo 在不同机器上差出一天
    assert.equal(dateToEpochSec('2021-10-22'), 1634860800)
    assert.equal(dateToEpochSec('2021-10-22 20:00:00'), 1634860800)
    assert.equal(dateToEpochSec('不是日期'), 0)
    assert.equal(dateToEpochSec('2021-13-01'), 0, '月份越界应该给 0 而不是滚到下一年')
  })

  await check('空内容和认不出的内容返回 null，不返回空壳', () => {
    assert.equal(parseNfo(''), null)
    assert.equal(parseNfo('   '), null)
    assert.equal(parseNfo('随便什么东西'), null)
    assert.equal(parseNfo('<musicvideo><title>x</title></musicvideo>'), null)
  })

  await check('带属性的标签取得到文本', () => {
    assert.equal(parseNfo('<movie><title lang="zh">带属性</title></movie>')!.title, '带属性')
    assert.deepEqual(parseNfo(fullMovie)!.thumbs, ['http://x/poster.jpg'])
    assert.deepEqual(parseNfo(fullMovie)!.fanarts, ['http://x/fan1.jpg', 'http://x/fan2.jpg'])
  })
}


/* ==================== 容器元数据 · v0.7 Step 4 ==================== */

/**
 * 分两半验：`mapMediaInfo` 是纯函数，拿 fixture 把每条映射规则验一遍；
 * `readContainerInfo` 要真读文件，用一个**手写的 WAV** 端到端跑一次。
 *
 * 手写 WAV 是这里唯一能拿到的「真实媒体文件」—— 本机没有编码器，
 * 而 WAV 的头 44 字节是固定格式，写得出来。它验的是最要紧的那件事：
 * **WASM 在纯 node 下加载得起来**。这条如果坏了，Step 4 整个就是空的，
 * 而它坏起来的方式（打包后 wasm 找不到）恰恰是最容易漏的。
 */
export async function videoContainerSection(): Promise<void> {
  console.log('\n容器元数据')

  await check('分辨率分档宽度优先 —— 宽银幕的 1920x800 是 1080p 不是 720p', () => {
    assert.equal(resolutionLabel(1920, 1080), '1080p')
    assert.equal(resolutionLabel(1920, 800), '1080p', '按高度分档会把宽银幕判低一档')
    assert.equal(resolutionLabel(3840, 1608), '2160p')
    assert.equal(resolutionLabel(1280, 720), '720p')
    assert.equal(resolutionLabel(720, 480), '480p')
    // 只有高度时才走高度分档
    assert.equal(resolutionLabel(0, 1080), '1080p')
    assert.equal(resolutionLabel(0, 0), '')
  })

  await check('分辨率词汇和文件名解析那一套对得上，否则筛选器会当成两种东西', () => {
    // filename.ts 的 literalResolution 给的是小写 `1080p`
    const fromName = parseVideoName('某片.2021.1080p.WEB-DL.mkv').resolution
    assert.equal(fromName, '1080p')
    assert.equal(resolutionLabel(1920, 1080), fromName)
  })

  await check('语言代码归一：zho / chi / Chinese / zh-CN 都是 zh', () => {
    assert.equal(normLanguage('zho'), 'zh')
    assert.equal(normLanguage('chi'), 'zh')
    assert.equal(normLanguage('Chinese'), 'zh')
    assert.equal(normLanguage('zh-CN'), 'zh')
    assert.equal(normLanguage('eng'), 'en')
    assert.equal(normLanguage(''), '')
    assert.equal(normLanguage('klingon'), '', '认不出的语言给空串而不是原样返回')
  })

  const fixture = {
    media: {
      track: [
        { '@type': 'General', Duration: '9300.5', Format: 'Matroska' },
        { '@type': 'Video', Format: 'HEVC', Width: '3840', Height: '1608' },
        { '@type': 'Audio', Format: 'DTS', Language: 'zho', 'Channel(s)': '6', Title: '国语 5.1' },
        { '@type': 'Audio', Format: 'AAC', Language: 'en', Channels: '2' },
        { '@type': 'Text', Format: 'UTF-8', Language: 'chi' },
        { '@type': 'Text', Format: 'PGS', Language: 'eng', Forced: 'Yes' }
      ]
    }
  }

  await check('映射：时长 / 容器 / 尺寸 / 编码各就各位', () => {
    const c = mapMediaInfo(fixture)
    assert.equal(c.duration_sec, 9301)
    assert.equal(c.container, 'Matroska')
    assert.equal(c.width, 3840)
    assert.equal(c.resolution, '2160p')
    assert.equal(c.video_codec, 'HEVC')
  })

  await check('音轨按出现顺序编号，容器写了标题就用它', () => {
    const c = mapMediaInfo(fixture)
    assert.equal(c.audio_tracks.length, 2)
    assert.deepEqual(c.audio_tracks.map((t) => t.index), [0, 1])
    assert.equal(c.audio_tracks[0].label, '国语 5.1', '压制组写的标题比我们拼的准，应该优先')
    assert.equal(c.audio_tracks[0].language, 'zh')
    assert.equal(c.audio_tracks[1].label, '英语 立体声', '没有标题时才拼一个')
  })

  await check('`Channel(s)` 和 `Channels` 两种键名都认 —— 大小写和标点不稳', () => {
    const c = mapMediaInfo(fixture)
    assert.ok(c.audio_tracks[0].label.includes('5.1'))
    const alt = mapMediaInfo({ media: { track: [{ '@type': 'Audio', Format: 'AC3', 'channel(s)': '8' }] } })
    assert.equal(alt.audio_tracks[0].label, '7.1')
  })

  await check('内嵌字幕轨单列，强制轨标出来', () => {
    const c = mapMediaInfo(fixture)
    assert.equal(c.subtitle_tracks.length, 2)
    assert.equal(c.subtitle_tracks[0].label, '中文')
    assert.equal(c.subtitle_tracks[1].label, '英语 强制')
    // 内嵌轨没有路径，路径是外挂字幕才有的
    assert.ok(c.subtitle_tracks.every((t) => t.path === ''))
  })

  await check('垃圾输入不炸，返回全零值', () => {
    for (const junk of [null, undefined, {}, { media: {} }, { media: { track: '不是数组' } }, 42]) {
      const c = mapMediaInfo(junk)
      assert.equal(c.duration_sec, 0)
      assert.deepEqual(c.audio_tracks, [])
    }
  })

  await check('General 没有时长时退回视频轨的', () => {
    const c = mapMediaInfo({
      media: { track: [{ '@type': 'General', Format: 'Matroska' }, { '@type': 'Video', Duration: '120' }] }
    })
    assert.equal(c.duration_sec, 120)
  })

  await check('WASM 找得到 —— 找不到的话 Step 4 整个是空的', () => {
    const p = mediaInfoWasmPath()
    assert.ok(p, 'MediaInfoModule.wasm 没找到')
    assert.ok(fs.existsSync(p), `wasm 路径不存在：${p}`)
  })

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-mi-'))

  await check('端到端：手写一个 WAV，WASM 真能解出时长和音轨', async () => {
    // 本机没有编码器，但 WAV 的头 44 字节是固定格式，手写得出来。
    // 这一条验的是「WASM 在纯 node 下加载得起来并真的在解析」
    const rate = 8000
    const dataBytes = rate * 2 * 2 // 2 秒，16 位单声道
    const wav = Buffer.alloc(44 + dataBytes)
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8)
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24)
    wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40)
    const p = path.join(dir, 'tone.wav')
    await fsp.writeFile(p, wav)

    const info = await readContainerInfo(p)
    assert.ok(info, 'WASM 没能解析手写的 WAV')
    assert.equal(info!.container, 'Wave')
    assert.equal(info!.duration_sec, 2)
    assert.equal(info!.audio_tracks.length, 1)
    assert.equal(info!.audio_tracks[0].codec, 'PCM')
    assert.equal(info!.audio_tracks[0].label, '单声道')
  })

  await check('读不了的文件返回 null，不抛 —— 一个坏文件不该停下整次扫描', async () => {
    assert.equal(await readContainerInfo(path.join(dir, '不存在.mkv')), null)
    const empty = path.join(dir, 'empty.mkv')
    await fsp.writeFile(empty, '')
    assert.equal(await readContainerInfo(empty), null, '空文件应该给 null')
    assert.equal(await readContainerInfo(dir), null, '目录应该给 null')
  })

  await check('不是媒体的文件给全零值而不是假数据', async () => {
    const txt = path.join(dir, 'a.txt')
    await fsp.writeFile(txt, 'hello '.repeat(500))
    const info = await readContainerInfo(txt)
    assert.ok(info, '应该返回结构而不是 null')
    assert.equal(info!.duration_sec, 0)
    assert.equal(info!.video_codec, '')
    assert.deepEqual(info!.audio_tracks, [])
  })

  await fsp.rm(dir, { recursive: true, force: true })
}


/* ==================== TMDB 刮削 · v0.7 Step 5 ==================== */

/**
 * TMDB 客户端的纯逻辑部分。
 *
 * 这一段全部不碰网络 —— 验的是**匹配和映射规则**，那才是会静默出错的地方。
 * 「能不能发出 HTTP 请求」是运行环境的事，而「1920x800 该判成 1080p」
 * 「剧集的导演在 created_by 而不是 crew」错了不报错，只让界面显示错的值。
 */
export async function videoTmdbSection(): Promise<void> {
  console.log('\nTMDB 刮削 · 匹配与映射')

  await check('域名归一：用户粘什么进来都切成主机名', () => {
    assert.equal(normDomain('', 'api.themoviedb.org'), 'api.themoviedb.org')
    assert.equal(normDomain('https://tmdb.example.com/', 'x'), 'tmdb.example.com')
    // 带 /3 的很常见 —— 不切的话会拼出 /3/3/search/movie
    assert.equal(normDomain('https://tmdb.example.com/3', 'x'), 'tmdb.example.com')
    assert.equal(normDomain('tmdb.example.com/some/path', 'x'), 'tmdb.example.com')
    assert.equal(normDomain('   ', 'fallback'), 'fallback')
  })

  await check('标题归一：去标点折空白大写，CJK 不受影响', () => {
    // 同一部片在不同来源里的标点几乎从不一致，这是精确比对能命中的前提
    assert.equal(normTitle('蜘蛛侠：英雄无归'), normTitle('蜘蛛侠:英雄无归'))
    assert.equal(normTitle('Spider-Man: No Way Home'), normTitle('spider man no way home'))
    assert.equal(normTitle('教父'), '教父')
    // 归一不能把不同的片抹成同一个
    assert.notEqual(normTitle('教父'), normTitle('教父2'))
  })

  await check('打分：标题精确命中 + 年份吻合最高', () => {
    const base = { title: '沙丘', original_title: 'Dune', media_type: 'movie' as const, poster_path: '/a.jpg', votes: 5000 }
    const exact = scoreCandidate({ ...base, year: 2021 }, { title: '沙丘', year: 2021, type: 'movie' })
    const wrongYear = scoreCandidate({ ...base, year: 2015 }, { title: '沙丘', year: 2021, type: 'movie' })
    const wrongTitle = scoreCandidate({ ...base, title: '不相干', original_title: 'Other', year: 2021 }, { title: '沙丘', year: 2021, type: 'movie' })
    assert.ok(exact > wrongYear, '年份差 6 年该扣分')
    assert.ok(exact > wrongTitle, '标题不匹配该扣分')
    // 原名命中和译名命中同权 —— 用户库里两种写法都有
    const byOriginal = scoreCandidate({ ...base, year: 2021 }, { title: 'Dune', year: 2021, type: 'movie' })
    assert.equal(byOriginal, exact)
  })

  await check('打分：年份差 1 年只轻扣 —— 上映年 / 引进年 / 跨年首播都是常态', () => {
    const c = { title: '某剧', original_title: 'Show', media_type: 'tv' as const, poster_path: '', votes: 100 }
    const gap0 = scoreCandidate({ ...c, year: 2023 }, { title: '某剧', year: 2023, type: 'series' })
    const gap1 = scoreCandidate({ ...c, year: 2022 }, { title: '某剧', year: 2023, type: 'series' })
    const gap5 = scoreCandidate({ ...c, year: 2018 }, { title: '某剧', year: 2023, type: 'series' })
    assert.ok(gap0 > gap1 && gap1 > gap5)
    // 差 1 年仍该是正分（标题命中 100 打底），不能因为差一年就掉到负数被排到末尾
    assert.ok(gap1 > 0, '差 1 年不该被打成负分')
  })

  await check('打分：类型对不上要扣 —— 剧集不该匹到 movie 条目', () => {
    const want = { title: '三体', year: 2023, type: 'series' as const }
    const tv = scoreCandidate({ title: '三体', original_title: '', year: 2023, media_type: 'tv', poster_path: '', votes: 500 }, want)
    const movie = scoreCandidate({ title: '三体', original_title: '', year: 2023, media_type: 'movie', poster_path: '', votes: 500 }, want)
    assert.ok(tv > movie)
  })

  await check('打分只排序不取舍 —— 中文库里标题全不同也可能是同一部片', () => {
    // 这一条守的是设计意图：分数低不等于错。发布组写的简称和 TMDB 官方译名
    // 常常一个字都不一样，让分数替 agent 做决定会在这里静默刮错片
    const odd = scoreCandidate(
      { title: '疯狂的麦克斯4：狂暴之路', original_title: 'Mad Max: Fury Road', year: 2015, media_type: 'movie', poster_path: '/p.jpg', votes: 20000 },
      { title: '狂暴之路', year: 2015, type: 'movie' }
    )
    // 包含关系拿 40 分，加年份 50 加类型 25 —— 排得进候选，但不是满分
    assert.ok(odd > 0 && odd < 175, `包含关系应该拿中间分，实际 ${odd}`)
  })

  await check('搜索结果映射：电影和剧集的字段名不一样，两套都要认', () => {
    const movie = mapCandidate(
      { id: 693134, title: '沙丘2', original_title: 'Dune: Part Two', release_date: '2024-02-27', vote_average: 8.15, vote_count: 4000, poster_path: '/a.jpg', overview: '简介', original_language: 'en' },
      'movie'
    )
    assert.ok(movie)
    assert.equal(movie!.year, 2024)
    assert.equal(movie!.rating, 8.2, '十分制并保留一位小数')
    assert.equal(movie!.media_type, 'movie')

    const tv = mapCandidate(
      { id: 1, name: '漫长的季节', original_name: 'The Long Season', first_air_date: '2023-04-22', vote_average: 8.9, vote_count: 200 },
      'tv'
    )
    assert.ok(tv)
    assert.equal(tv!.title, '漫长的季节')
    assert.equal(tv!.year, 2023)
  })

  await check('multi 搜索里带 media_type 时以它为准，人物条目会被筛掉', () => {
    // /search/multi 会回 person，它没有 title/name 之外的可用字段
    const person = mapCandidate({ id: 5, media_type: 'person', name: '张艺谋' }, 'movie')
    // mapCandidate 本身不筛，它交给 tmdbSearch 按有没有标题筛 ——
    // 但 media_type 得原样透出来，不能被 fallback 顶掉
    assert.ok(person)
    assert.notEqual(person!.media_type, 'person', 'media_type 只允许 movie/tv 两个值')

    const asTv = mapCandidate({ id: 6, media_type: 'tv', name: '剧', first_air_date: '2020-01-01' }, 'movie')
    assert.equal(asTv!.media_type, 'tv', 'media_type 该压过 fallback')
  })

  await check('垃圾输入给 null 而不是一个半成品条目', () => {
    for (const junk of [null, undefined, {}, { id: 0 }, { id: -1 }, { id: 'abc' }, 42]) {
      assert.equal(mapCandidate(junk, 'movie'), null)
    }
  })

  const movieDetail = {
    id: 278,
    title: '肖申克的救赎',
    original_title: 'The Shawshank Redemption',
    release_date: '1994-09-23',
    vote_average: 8.7,
    vote_count: 26000,
    runtime: 142,
    overview: '一部关于希望的电影。',
    tagline: '恐惧让你沦为囚犯，希望让你重获自由。',
    imdb_id: 'tt0111161',
    original_language: 'en',
    homepage: 'https://example.com',
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    genres: [{ id: 18, name: '剧情' }, { id: 80, name: '犯罪' }],
    production_countries: [{ name: '美国' }],
    production_companies: [{ name: 'Castle Rock' }],
    credits: {
      crew: [
        { job: 'Director', name: '弗兰克·德拉邦特' },
        { job: 'Screenplay', name: '弗兰克·德拉邦特' },
        { job: 'Producer', name: '不该出现' }
      ],
      cast: [
        { name: '蒂姆·罗宾斯', character: '安迪' },
        { name: '摩根·弗里曼', character: '瑞德' }
      ]
    }
  }

  await check('电影详情映射：导演从 crew 取，Producer 不算', () => {
    const d = mapDetail(movieDetail, 'movie')
    assert.ok(d)
    assert.deepEqual(d!.directors, ['弗兰克·德拉邦特'])
    assert.deepEqual(d!.writers, ['弗兰克·德拉邦特'])
    assert.equal(d!.runtime_min, 142)
    assert.equal(d!.imdb_id, 'tt0111161')
    assert.equal(d!.year, 1994)
    assert.equal(d!.end_year, 0, '电影没有完结年份')
    assert.equal(d!.status, '', '电影没有状态')
    assert.deepEqual(d!.cast.map((c) => c.name), ['蒂姆·罗宾斯', '摩根·弗里曼'])
  })

  await check('剧集详情：导演取 created_by，因为每集导演都不同', () => {
    const d = mapDetail(
      {
        id: 1,
        name: '漫长的季节',
        first_air_date: '2023-04-22',
        last_air_date: '2023-05-01',
        status: 'Ended',
        episode_run_time: [45],
        created_by: [{ name: '辛爽' }],
        credits: { crew: [{ job: 'Director', name: '某集导演' }], cast: [] },
        seasons: [
          { season_number: 1, name: '第 1 季', episode_count: 12, air_date: '2023-04-22' },
          { season_number: 0, name: '特别篇', episode_count: 2, air_date: '' }
        ],
        external_ids: { imdb_id: 'tt21708796' }
      },
      'tv'
    )
    assert.ok(d)
    assert.deepEqual(d!.directors, ['辛爽'], '剧集的「导演」是主创')
    assert.equal(d!.end_year, 2023)
    assert.equal(d!.status, 'Ended')
    assert.equal(d!.runtime_min, 45, '剧集片长取 episode_run_time 第一个')
    assert.equal(d!.imdb_id, 'tt21708796', '剧集的 imdb id 在 external_ids 里')
    // 第 0 季（特别篇）是正片，不能被筛掉 —— 和 scanner 里 Specials/ 那条一致
    assert.equal(d!.seasons.length, 2)
    assert.equal(d!.seasons[0].season_number, 0, '季按季号排，0 在前')
  })

  await check('空季（episode_count 为 0）要剔掉 —— 详情页上摆一个点不开的空壳', () => {
    const d = mapDetail(
      {
        id: 2,
        name: 'x',
        seasons: [
          { season_number: 1, episode_count: 10 },
          { season_number: 2, episode_count: 0, name: '还没开播' }
        ]
      },
      'tv'
    )
    assert.equal(d!.seasons.length, 1)
    assert.equal(d!.seasons[0].season_number, 1)
  })

  await check('季集表映射：按集号排序，无效集号剔掉', () => {
    const eps = mapSeasonEpisodes(
      {
        episodes: [
          { season_number: 1, episode_number: 3, name: '第三集', air_date: '2023-04-24', runtime: 45 },
          { season_number: 1, episode_number: 1, name: '第一集', air_date: '2023-04-22', runtime: 46 },
          { season_number: 1, episode_number: 0, name: '无效' }
        ]
      },
      1
    )
    assert.equal(eps.length, 2)
    assert.deepEqual(eps.map((e) => e.episode_number), [1, 3])
    assert.ok(eps[0].air_date_ts > 0)
    // 日期走 Date.UTC，和 nfo.ts 的 dateToEpochSec 必须是同一个值，
    // 否则同一集的首播日期在两条路径上差一天
    assert.equal(eps[0].air_date_ts, dateToEpochSec('2023-04-22'))
  })

  await check('季号为 0 时不被 || 吞掉 —— 0 是合法季号（特别篇）', () => {
    const eps = mapSeasonEpisodes({ episodes: [{ season_number: 0, episode_number: 1, name: 'SP' }] }, 0)
    assert.equal(eps.length, 1)
    assert.equal(eps[0].season_number, 0)
  })

  await check('图片地址拼装，域名可覆盖（image.tmdb.org 单独被墙）', () => {
    const cfg = { api_key: 'k', api_domain: '', image_domain: '', enabled: true }
    assert.equal(imageUrl(cfg, '/abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg')
    // 相对路径没有前导斜杠时也要拼对
    assert.equal(imageUrl(cfg, 'abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg')
    assert.equal(imageUrl({ ...cfg, image_domain: 'img.mirror.com' }, '/a.jpg', 'original'), 'https://img.mirror.com/t/p/original/a.jpg')
    assert.equal(imageUrl(cfg, ''), '', '没有图片给空串而不是一个坏地址')
  })

  await check('可用性判断：关了或没 key 都算不可用', () => {
    assert.equal(tmdbAvailable({ api_key: 'k', api_domain: '', image_domain: '', enabled: true }), true)
    assert.equal(tmdbAvailable({ api_key: '', api_domain: '', image_domain: '', enabled: true }), false)
    assert.equal(tmdbAvailable({ api_key: 'k', api_domain: '', image_domain: '', enabled: false }), false)
    assert.equal(tmdbAvailable({ api_key: '   ', api_domain: '', image_domain: '', enabled: true }), false)
  })

  await check('年份抽取只认开头四位数字', () => {
    assert.equal(yearOf('2024-02-27'), 2024)
    assert.equal(yearOf('2024'), 2024)
    assert.equal(yearOf(''), 0)
    assert.equal(yearOf(null), 0)
    assert.equal(yearOf('不是日期'), 0)
  })
}


/* ==================== 本地事实汇总 · v0.7 Step 5 ==================== */

/**
 * `facts.ts`：把扫描结果 + nfo + 容器元数据合成一条事实。
 *
 * 这一段验的是**三个来源冲突时谁压过谁**。这些规则错了不报错，
 * 只让详情页上显示一个错的值 —— 而错的分辨率和错的年份，用户不会去核对。
 *
 * 优先级设计：nfo > 容器 > 文件名，唯一的例外是分辨率/编码/时长，容器压过文件名。
 */
export async function videoFactsSection(): Promise<void> {
  console.log('\n本地事实汇总')

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-facts-'))

  /* -------- 拿真实目录树跑一遍扫描，再合并事实 -------- */
  const root = path.join(dir, '影视')
  await fsp.mkdir(path.join(root, '沙丘 (2021)'), { recursive: true })
  await fsp.writeFile(path.join(root, '沙丘 (2021)', 'Dune.2021.1080p.BluRay.x264-GROUP.mkv'), 'x')
  await fsp.writeFile(path.join(root, '沙丘 (2021)', 'Dune.2021.1080p.BluRay.x264-GROUP.chs.srt'), 'x')
  await fsp.writeFile(
    path.join(root, '沙丘 (2021)', 'movie.nfo'),
    `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>沙丘</title>
  <originaltitle>Dune</originaltitle>
  <year>2021</year>
  <plot>厄崔迪家族的故事。</plot>
  <runtime>155</runtime>
  <genre>科幻</genre>
  <genre>冒险</genre>
  <director>丹尼斯·维伦纽瓦</director>
  <uniqueid type="tmdb" default="true">438631</uniqueid>
  <uniqueid type="imdb">tt1160419</uniqueid>
  <rating>7.8</rating>
  <actor><name>提莫西·查拉梅</name><role>保罗</role></actor>
</movie>`
  )

  await check('电影：nfo 的 id / 简介 / 类型都被读进来了', async () => {
    const cands = scanVideoRoot(root)
    assert.equal(cands.length, 1, `应该只有一条候选，实际 ${cands.length}`)
    const f = await buildFacts(cands[0]!)
    assert.equal(f.video_type, 'movie')
    assert.equal(f.tmdb_id, '438631', 'nfo 里的 tmdb id 是这一步最值钱的东西')
    assert.equal(f.imdb_id, 'tt1160419')
    assert.equal(f.title_zh, '沙丘')
    assert.equal(f.original_title, 'Dune')
    assert.equal(f.year, 2021)
    assert.ok(f.plot.includes('厄崔迪'))
    assert.deepEqual(f.genres, ['科幻', '冒险'])
    assert.deepEqual(f.directors, ['丹尼斯·维伦纽瓦'])
    assert.deepEqual(f.actors, ['提莫西·查拉梅'])
    assert.equal(f.nfo_rating, 7.8)
  })

  await check('电影：文件名的技术事实进来了，外挂字幕挂成 index=-1 的轨', async () => {
    const f = await buildFacts(scanVideoRoot(root)[0]!)
    assert.equal(f.resolution, '1080p')
    assert.equal(f.source, 'BLURAY')
    assert.equal(f.release_group, 'GROUP')
    assert.equal(f.external_subtitles.length, 1)
    const ext = f.subtitle_tracks.find((t) => t.index === -1)
    assert.ok(ext, '外挂字幕该并进字幕轨列表')
    assert.equal(ext!.language, 'zh', '.chs. 该认成中文')
    assert.ok(ext!.path.endsWith('.srt'), '外挂轨要带路径，内嵌轨才是空串')
  })

  await check('电影：nfo 路径记进 nfo_files，parts 带上文件', async () => {
    const f = await buildFacts(scanVideoRoot(root)[0]!)
    assert.equal(f.nfo_files.length, 1)
    assert.equal(f.parts.length, 1)
    assert.equal(f.parts[0].label, '', '不是分卷就不该有 CD 标签')
    // 时长读不出来（假文件不是真视频），nfo 的 runtime 顶上：155 分钟
    assert.equal(f.duration_sec, 155 * 60, 'nfo 的 runtime_min 该在容器读不出时兜底')
  })

  /* -------- 剧集：tvshow.nfo + 单集 nfo -------- */
  const showDir = path.join(dir, '剧集', '漫长的季节')
  await fsp.mkdir(path.join(showDir, 'Season 1'), { recursive: true })
  await fsp.writeFile(
    path.join(showDir, 'tvshow.nfo'),
    `<tvshow><title>漫长的季节</title><year>2023</year><status>Ended</status>
     <uniqueid type="tmdb">205050</uniqueid><plot>东北往事。</plot></tvshow>`
  )
  for (const n of [1, 2, 3]) {
    await fsp.writeFile(path.join(showDir, 'Season 1', `漫长的季节.S01E0${n}.1080p.WEB-DL.mkv`), 'x')
  }
  await fsp.writeFile(
    path.join(showDir, 'Season 1', '漫长的季节.S01E02.1080p.WEB-DL.nfo'),
    `<episodedetails><title>第二集标题</title><season>1</season><episode>2</episode>
     <aired>2023-04-23</aired><runtime>48</runtime></episodedetails>`
  )

  await check('剧集：tvshow.nfo 被挑成主 nfo，单集 nfo 不会顶替它', async () => {
    const cands = scanVideoRoot(path.join(dir, '剧集'))
    assert.equal(cands.length, 1)
    const f = await buildFacts(cands[0]!)
    assert.equal(f.video_type, 'series')
    assert.equal(f.title_zh, '漫长的季节')
    assert.equal(f.tmdb_id, '205050')
    assert.equal(f.status, 'Ended')
    assert.ok(f.plot.includes('东北'), '简介该来自 tvshow.nfo 而不是某一集')
    assert.equal(f.episode_files, 3)
    assert.deepEqual(f.seasons, [1])
  })

  await check('剧集：单集 nfo 按同名对齐到那一集，不会串到别集', async () => {
    const f = await buildFacts(scanVideoRoot(path.join(dir, '剧集'))[0]!)
    const e2 = f.episodes.find((e) => e.episode === 2)
    const e1 = f.episodes.find((e) => e.episode === 1)
    assert.ok(e2 && e1)
    assert.equal(e2!.title, '第二集标题')
    assert.ok(e2!.air_date > 0, '首播日期该从单集 nfo 来')
    assert.equal(e1!.title, '', '第 1 集没有 nfo，标题该是空串而不是借用第 2 集的')
    assert.equal(e1!.air_date, 0)
  })

  await check('剧集的 duration_sec 是单集时长而不是全剧总长', async () => {
    const f = await buildFacts(scanVideoRoot(path.join(dir, '剧集'))[0]!)
    // 容器读不出来，退回 nfo。这里 tvshow.nfo 没写 runtime，所以是 0 ——
    // 关键是它不该是「三集之和」
    assert.ok(f.duration_sec < 3 * 60 * 60, '不该把三集时长加起来当剧的时长')
  })

  /* -------- 纯函数：优先级规则 -------- */
  await check('分辨率：容器压过文件名 —— 改名转发的片子文件名会写错', () => {
    const candidate = {
      video_type: 'movie' as const,
      path: 'C:\\x\\a.mkv',
      title_zh: '某片', title_en: '', year: 2020,
      files: [{
        path: 'C:\\x\\a.mkv', name: 'a.mkv', size: 100, part: null,
        parsed: { ...parseVideoName('某片.2020.1080p.WEB-DL.mkv') }
      }],
      episodes: [], sidecars: { nfo: [], images: [], subtitles: [] }, extras: [], evidence: []
    }
    const containers = new Map([['C:\\x\\a.mkv', {
      duration_sec: 7200, container: 'Matroska', width: 1280, height: 720,
      resolution: '720p', video_codec: 'HEVC', audio_tracks: [], subtitle_tracks: []
    }]])
    const f = mergeFacts(candidate, null, new Map(), containers)
    assert.equal(f.resolution, '720p', '容器说 720p 就是 720p，文件名写的 1080p 不算')
    assert.equal(f.video_codec, 'HEVC')
    assert.equal(f.duration_sec, 7200)
    // 片源和发布组只有文件名知道，容器里没有这个概念
    assert.equal(f.source, 'WEBDL')
  })

  await check('年份：nfo 压过文件名', () => {
    const candidate = {
      video_type: 'movie' as const, path: 'C:\\x\\a.mkv',
      title_zh: '某片', title_en: '', year: 2019,
      files: [{ path: 'C:\\x\\a.mkv', name: 'a.mkv', size: 1, part: null, parsed: parseVideoName('某片.2019.mkv') }],
      episodes: [], sidecars: { nfo: [], images: [], subtitles: [] }, extras: [], evidence: []
    }
    const nfo = parseNfo('<movie><title>某片</title><year>2021</year></movie>')
    assert.ok(nfo)
    const f = mergeFacts(candidate, nfo, new Map(), new Map())
    assert.equal(f.year, 2021, 'nfo 是刮削结论，比文件名可信')
  })

  await check('分卷电影的时长是各卷之和 —— 被切成两半的片子，总长才是片长', () => {
    const mk = (p: string, part: number) => ({
      path: p, name: path.basename(p), size: 500, part,
      parsed: parseVideoName(path.basename(p))
    })
    const candidate = {
      video_type: 'movie' as const, path: 'C:\\x', title_zh: '老片', title_en: '', year: 1999,
      files: [mk('C:\\x\\m.CD1.avi', 1), mk('C:\\x\\m.CD2.avi', 2)],
      episodes: [], sidecars: { nfo: [], images: [], subtitles: [] }, extras: [], evidence: []
    }
    const blank = { container: '', width: 0, height: 0, resolution: '', video_codec: '', audio_tracks: [], subtitle_tracks: [] }
    const containers = new Map([
      ['C:\\x\\m.CD1.avi', { ...blank, duration_sec: 3000 }],
      ['C:\\x\\m.CD2.avi', { ...blank, duration_sec: 2800 }]
    ])
    const f = mergeFacts(candidate, null, new Map(), containers)
    assert.equal(f.duration_sec, 5800)
    assert.equal(f.parts.length, 2)
    assert.deepEqual(f.parts.map((p) => p.label), ['CD1', 'CD2'])
  })

  await check('nfo 标题是中文还是外文要分开落 —— 判不出来的交给 agent', () => {
    const candidate = {
      video_type: 'movie' as const, path: 'C:\\x\\a.mkv', title_zh: '', title_en: 'Some Film', year: 2020,
      files: [], episodes: [], sidecars: { nfo: [], images: [], subtitles: [] }, extras: [], evidence: []
    }
    const cn = mergeFacts(candidate, parseNfo('<movie><title>某中文片</title></movie>'), new Map(), new Map())
    assert.equal(cn.title_zh, '某中文片')
    assert.equal(cn.title_en, 'Some Film', '中文 nfo 标题不该盖掉文件名里的英文标题')

    const en = mergeFacts(candidate, parseNfo('<movie><title>Official Title</title></movie>'), new Map(), new Map())
    assert.equal(en.title_en, 'Official Title')
    assert.equal(en.title_zh, '')
  })

  await check('主 nfo 挑选：按根标签认，不只看文件名', () => {
    const ep = parseNfo('<episodedetails><title>第一集</title></episodedetails>')!
    const show = parseNfo('<tvshow><title>剧名</title></tvshow>')!
    const movie = parseNfo('<movie><title>片名</title></movie>')!

    // 剧集：单集 nfo 不能顶替 tvshow.nfo。拿一集的 nfo 当整部剧的，
    // 简介会变成「第 3 集：…」，而 tmdb_id 会是那一集的 id
    assert.equal(pickMainNfo([{ file: 'a.nfo', data: ep }], 'series'), null)
    const picked = pickMainNfo([{ file: 'a.nfo', data: ep }, { file: 'tvshow.nfo', data: show }], 'series')
    assert.equal(picked?.data.kind, 'tvshow')
    // 电影：认 movie 根标签，不管文件名叫什么
    assert.equal(pickMainNfo([{ file: '随便.nfo', data: movie }], 'movie')?.data.kind, 'movie')
    assert.equal(pickMainNfo([], 'movie'), null)
  })

  await check('没有 tvshow.nfo 时从单集 nfo 借 id，但不借文本', async () => {
    const borrowDir = path.join(dir, '借id', '某剧')
    await fsp.mkdir(borrowDir, { recursive: true })
    for (const n of [1, 2]) {
      await fsp.writeFile(path.join(borrowDir, `某剧.S01E0${n}.mkv`), 'x')
    }
    await fsp.writeFile(
      path.join(borrowDir, '某剧.S01E01.nfo'),
      `<episodedetails><title>只是第一集的标题</title><season>1</season><episode>1</episode>
       <plot>只是第一集的简介</plot><uniqueid type="tmdb">99999</uniqueid></episodedetails>`
    )
    const f = await buildFacts(scanVideoRoot(path.join(dir, '借id'))[0]!)
    assert.equal(f.tmdb_id, '99999', 'id 该借过来 —— 有它刮削就是精确查询')
    assert.equal(f.plot, '', '简介不能借：那是一集的简介，不是整部剧的')
    assert.equal(f.episodes.find(episode => episode.episode === 1)?.local_metadata?.description, '只是第一集的简介', '简介仍应保留在它所属的单集里')
    assert.ok(!f.title_zh.includes('只是第一集'), '标题也不能借')
  })

  await check('字幕语言只认明确写了的，认不出来给空串不猜', () => {
    assert.equal(guessSubtitleLanguage('片名.chs.srt'), 'zh')
    assert.equal(guessSubtitleLanguage('片名.简体.ass'), 'zh')
    assert.equal(guessSubtitleLanguage('片名.繁體中文.srt'), 'zh')
    assert.equal(guessSubtitleLanguage('片名.eng.srt'), 'en')
    assert.equal(guessSubtitleLanguage('片名.jpn.ass'), 'ja')
    // 猜错比不标更烦：用户点开「中文字幕」得到一轨英文
    assert.equal(guessSubtitleLanguage('片名.srt'), '')
    assert.equal(guessSubtitleLanguage('subtitle_track_2.srt'), '')
  })

  await check('空事实的零值齐全 —— 调用方不用到处 ?.', () => {
    const f = emptyFacts()
    assert.equal(f.year, 0)
    assert.equal(f.tmdb_id, '')
    assert.deepEqual(f.episodes, [])
    assert.deepEqual(f.audio_tracks, [])
    assert.equal(f.episode_files, 0)
  })

  await fsp.rm(dir, { recursive: true, force: true })
}


/* ==================== 豆瓣 · v0.7 Step 5 ==================== */

/**
 * 豆瓣这条路的纯逻辑。
 *
 * 这条路不碰豆瓣的私有接口，走的是用户自己配的搜索服务商 + `site:` 查询
 * （为什么这么选，见 douban.ts 的文件头）。代价是**返回的东西是外部输入**，
 * 里面会混进影评站、盗版站、豆瓣自己的非条目页。所以这一节的重点不是
 * 「能不能解出来」，而是**不该收的有没有被挡住**：
 *
 * 1. `doubanSubjectId` 是整道闸门，它判的是 host 而不是「串里有没有 douban」。
 * 2. 评分必须带锚点词才认 —— 摘要里的评价人数、时长、年份都长得像评分。
 */
export async function videoDoubanSection(): Promise<void> {
  console.log('\n豆瓣 · 搜索服务商这条路')

  const hit = (url: string, title = '肖申克的救赎 (豆瓣)', snippet = ''): any => ({
    url,
    title,
    snippet
  })

  await check('subject id 只从真的豆瓣 host 上取 —— 判的是主机名不是「串里有 douban」', () => {
    assert.equal(doubanSubjectId('https://movie.douban.com/subject/1292052/'), '1292052')
    assert.equal(doubanSubjectId('https://m.douban.com/movie/subject/1292052/'), '1292052')
    assert.equal(doubanSubjectId('https://movie.douban.com/subject/1292052/?from=search'), '1292052')
    assert.equal(doubanSubjectId('http://douban.com/subject/1292052'), '1292052')

    // 把别人的站伪装成豆瓣：正则一扫就过了，URL 解析过不去。
    // 放过它的后果是把一个陌生站点的数字当豆瓣 id 存进用户的库
    assert.equal(doubanSubjectId('https://evil.com/movie.douban.com/subject/1292052/'), '')
    assert.equal(doubanSubjectId('https://movie.douban.com.evil.com/subject/1292052/'), '')
    assert.equal(doubanSubjectId('https://fake-douban.com/subject/1292052/'), '')
    // 非 http 协议：javascript: 和 file: 一律不认
    assert.equal(doubanSubjectId('javascript:alert(1)//movie.douban.com/subject/1292052/'), '')
  })

  await check('豆瓣的非条目页不该被当成条目 —— 影人页、榜单、小组帖都会混进来', () => {
    assert.equal(doubanSubjectId('https://movie.douban.com/celebrity/1054521/'), '')
    assert.equal(doubanSubjectId('https://movie.douban.com/top250'), '')
    assert.equal(doubanSubjectId('https://www.douban.com/group/topic/12345678/'), '')
    // 条目自己的子页（影评、剧照）**照样认**：id 指的还是同一部片，
    // 而 rankDoubanHits 按 id 去重，它会和条目页那条合成一条
    assert.equal(doubanSubjectId('https://movie.douban.com/subject/1292052/reviews'), '1292052')
    // id 太短不像 subject（豆瓣的 subject id 是 7-8 位）
    assert.equal(doubanSubjectId('https://movie.douban.com/subject/12/'), '')
    // 非字符串、空值不该抛
    assert.equal(doubanSubjectId(null), '')
    assert.equal(doubanSubjectId(12345), '')
    assert.equal(doubanSubjectId(''), '')
  })

  await check('条目链接从 id 重拼，不带服务商的跟踪参数', () => {
    assert.equal(doubanUrl('1292052'), 'https://movie.douban.com/subject/1292052/')
    assert.equal(doubanUrl(''), '', '没有 id 时给空串，不是一个指向 /subject// 的坏链接')
    // 移动版地址进来，存下去的是桌面版规范形状
    const c = mapDoubanHit(hit('https://m.douban.com/movie/subject/1292052/?dt_dapp=1'))
    assert.equal(c!.url, 'https://movie.douban.com/subject/1292052/')
  })

  await check('评分必须带锚点词才认 —— 评价人数和时长长得跟评分一样', () => {
    assert.equal(parseDoubanRating('豆瓣评分 9.7'), 9.7)
    assert.equal(parseDoubanRating('豆瓣评分：9.7'), 9.7)
    assert.equal(parseDoubanRating('评分 8.1 / 10'), 8.1)
    assert.equal(parseDoubanRating('9.7/10'), 9.7)
    assert.equal(parseDoubanRating('8.5分'), 8.5)
    assert.equal(parseDoubanRating('评分 10'), 10)

    // 这一条是这个函数存在的理由：8.5 万人评价里的 8.5 恰好落在合法评分区间，
    // 认错了在界面上看不出任何异常
    assert.equal(parseDoubanRating('280.1万人评价'), 0)
    assert.equal(parseDoubanRating('8.5万人评价'), 0)
    assert.equal(parseDoubanRating('片长 120分钟'), 0)
    assert.equal(parseDoubanRating('1994年上映'), 0)
    assert.equal(parseDoubanRating('全 16 集'), 0)
    assert.equal(parseDoubanRating('一部关于希望的电影'), 0)
    assert.equal(parseDoubanRating(''), 0)
    assert.equal(parseDoubanRating(null), 0)
  })

  await check('解不出评分返回 0，且 0 的意思是「没拿到」不是「零分」', () => {
    // 越界的值不能当评分收下 —— 11.0 和 0.0 都不是豆瓣的十分制
    assert.equal(parseDoubanRating('评分 11'), 0)
    assert.equal(parseDoubanRating('评分 0'), 0)
    // 多一位小数说明这不是豆瓣评分（豆瓣只给一位）
    assert.equal(parseDoubanRating('评分 9.75'), 0)
    // 摘要里没有评分的条目页照样是有效候选，只是 rating = 0
    const c = mapDoubanHit(hit('https://movie.douban.com/subject/1292052/', '肖申克的救赎', '导演 弗兰克·德拉邦特'))
    assert.ok(c, '没解出评分不该让整条候选作废 —— id 和片名照样拿到了')
    assert.equal(c!.rating, 0)
  })

  await check('标题剥站点后缀，但留着英文原名 —— 同名译名靠它分开', () => {
    assert.equal(cleanDoubanTitle('肖申克的救赎 (豆瓣)'), '肖申克的救赎')
    assert.equal(cleanDoubanTitle('豆瓣电影: 肖申克的救赎'), '肖申克的救赎')
    assert.equal(cleanDoubanTitle('肖申克的救赎 - 豆瓣电影'), '肖申克的救赎')
    assert.equal(cleanDoubanTitle('沙丘 Dune (2021) - 豆瓣'), '沙丘 Dune (2021)')
    assert.equal(
      cleanDoubanTitle('无间道 Infernal Affairs'),
      '无间道 Infernal Affairs',
      '英文原名要留着'
    )
    assert.equal(cleanDoubanTitle('   '), '')
  })

  await check('年份只认有边界的四位数 —— 2160p 里的 2160 不是年份', () => {
    assert.equal(parseDoubanYear('沙丘 (2021)'), 2021)
    assert.equal(parseDoubanYear('2021年上映'), 2021)
    assert.equal(parseDoubanYear('剧情 / 1994 / 美国'), 1994)
    assert.equal(parseDoubanYear('2160p 蓝光原盘'), 0)
    assert.equal(parseDoubanYear('全 1080 天'), 0)
    assert.equal(parseDoubanYear('无年份'), 0)
  })

  await check('不是条目页的结果一律落成 null —— 服务商不认 site: 时靠这道闸门', () => {
    // 服务商把 site: 当普通词处理时，返回的就是这种东西
    assert.equal(mapDoubanHit(hit('https://www.zhihu.com/question/12345')), null)
    assert.equal(mapDoubanHit(hit('https://movie.douban.com/celebrity/1054521/')), null)
    assert.equal(mapDoubanHit(hit('https://evil.com/movie.douban.com/subject/1292052/')), null)
    // 是条目页但标题洗完是空的：留不下有意义的片名，不收
    assert.equal(mapDoubanHit(hit('https://movie.douban.com/subject/1292052/', '豆瓣电影')), null)
  })

  await check('候选按 subject id 去重，桌面版和移动版两条的摘要要合起来', () => {
    // 一条带评分不带年份，另一条反过来 —— 丢掉后来的那条就等于丢掉半份信息
    const list = rankDoubanHits(
      [
        hit('https://movie.douban.com/subject/1292052/', '肖申克的救赎', '豆瓣评分 9.7'),
        hit('https://m.douban.com/movie/subject/1292052/', '肖申克的救赎 The Shawshank Redemption', '剧情 / 1994 / 美国')
      ],
      { title: '肖申克的救赎', year: 1994 }
    )
    assert.equal(list.length, 1, '同一个 subject 只该留一条')
    assert.equal(list[0].rating, 9.7)
    assert.equal(list[0].year, 1994)
    // 标题取更长的那个：短的那条通常是被服务商截断的
    assert.equal(list[0].title, '肖申克的救赎 The Shawshank Redemption')
  })

  await check('打分只用来排序：年份对得上的排前面，差太远的往后掉', () => {
    const list = rankDoubanHits(
      [
        // 同名但年份差 40 年 —— 老版翻拍，不是用户手上这一部
        hit('https://movie.douban.com/subject/1111111/', '沙丘 Dune (1984)', '豆瓣评分 7.0 / 1984年'),
        hit('https://movie.douban.com/subject/2222222/', '沙丘 Dune (2021)', '豆瓣评分 7.9 / 2021年')
      ],
      { title: '沙丘', year: 2021 }
    )
    assert.equal(list[0].id, '2222222', '年份对得上的该排第一')
    assert.equal(list.length, 2, '排后面不等于丢掉 —— 取舍留给模型')
  })

  await check('查询词把 site: 放前面，不夹带「电影」这类形态词', () => {
    assert.equal(doubanQuery('肖申克的救赎', 1994), 'site:movie.douban.com 肖申克的救赎 1994')
    assert.equal(doubanQuery('肖申克的救赎'), 'site:movie.douban.com 肖申克的救赎')
    assert.equal(doubanQuery('肖申克的救赎', 0), 'site:movie.douban.com 肖申克的救赎')
    assert.ok(!doubanQuery('黑暗荣耀', 2022).includes('电视剧'))
    assert.equal(doubanQuery('   '), '', '没有片名就不该发出一个只有 site: 的查询')
  })

  await check('豆瓣的开关就是联网搜索的开关，没有第二个配置项', () => {
    const base = { api_key: 'k', endpoint: '', enabled: true }
    assert.equal(doubanAvailable({ ...base, provider: 'bing' } as any), true)
    // 「不额外联网」时这条路自动关掉
    assert.equal(doubanAvailable({ ...base, provider: 'model_builtin' } as any), false)
    assert.equal(doubanAvailable({ ...base, provider: 'bing', enabled: false } as any), false)
    assert.equal(doubanAvailable({ ...base, provider: 'bing', api_key: '' } as any), false)
  })

  await check('评分越界或标题不像时，打分函数不抛 —— 外部输入什么形状都有', () => {
    assert.equal(typeof scoreDoubanCandidate({ title: '', year: 0, rating: 0 }, { title: '', year: 0 }), 'number')
    const exact = scoreDoubanCandidate({ title: '沙丘', year: 2021, rating: 7.9 }, { title: '沙丘', year: 2021 })
    const off = scoreDoubanCandidate({ title: '沙丘', year: 1984, rating: 7.0 }, { title: '沙丘', year: 2021 })
    assert.ok(exact > off)
  })
}


/* ==================== 视频识别 · v0.7 Step 5 ==================== */

/**
 * 提示词与工具集。
 *
 * 两条重点：
 *
 * 1. **提示词和工具集必须对得上。** 说了有 web_search 却没注册，模型会去调
 *    一个不存在的工具，白烧一轮 —— 软件那边踩过这个坑，游戏那边的注释里记着。
 * 2. **编出来的 tmdb_id 必须被拦住。** 编 id 的后果是下次刷新刮到另一部片，
 *    海报简介季集表全换成别人的，用户得手工全删一遍。
 */
export async function videoIdentifySection(): Promise<void> {
  console.log('\n视频识别 · 提示词与工具')

  const facts = {
    ...emptyFacts(),
    video_type: 'movie' as const,
    path: 'C:\\影视\\沙丘 (2021)\\Dune.mkv',
    dir: 'C:\\影视\\沙丘 (2021)',
    title_zh: '沙丘',
    title_en: 'Dune',
    year: 2021,
    resolution: '1080p',
    video_codec: 'AVC',
    source: 'BLURAY',
    release_group: 'GROUP',
    duration_sec: 9300,
    audio_tracks: [{ index: 0, language: 'zh', label: '国语 5.1', codec: 'DTS', path: '' }],
    evidence: ['独占目录「沙丘 (2021)」，标题取目录名']
  }

  await check('任务描述把技术事实说成确定值，不留「你可以核实」的余地', () => {
    const p = videoCandidatePrompt(facts)
    assert.ok(p.includes('1080p'))
    assert.ok(p.includes('BLURAY'))
    assert.ok(p.includes('国语 5.1'))
    assert.ok(p.includes('不用再验证'), '措辞上必须堵住「去核实一下」这条路')
    // 留了余地模型就会真去核实，而它没有工具能核实，于是它会编
    assert.ok(!/供参考|仅供参考|可以核实/.test(p))
  })

  await check('有 id 时任务描述明确要求走精确查询，不要搜索', () => {
    const p = videoCandidatePrompt({ ...facts, tmdb_id: '438631', imdb_id: 'tt1160419' })
    assert.ok(p.includes('438631'))
    assert.ok(p.includes('tt1160419'))
    assert.ok(p.includes('不要再搜索'), 'id 在手还去搜就是白烧一轮')
  })

  await check('剧集的任务描述报季集情况，且说明集表由系统补', () => {
    const p = videoCandidatePrompt({
      ...facts,
      video_type: 'series',
      episodes: [
        { season: 1, episode: 1, title: '', path: 'a', file_size: 1, duration_sec: 0, air_date: 0, watch: null },
        { season: 1, episode: 2, title: '第二集', path: 'b', file_size: 1, duration_sec: 0, air_date: 0, watch: null }
      ],
      episode_files: 2,
      seasons: [1]
    })
    assert.ok(p.includes('磁盘上有 2 集'))
    assert.ok(p.includes('S01E02 第二集'))
    assert.ok(p.includes('你不用管集列表'), '否则模型会试图逐集填进 register_video')
  })

  await check('集列表长时截断，但要说清还有多少集没列', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      season: 1, episode: i + 1, title: '', path: `e${i}`, file_size: 1, duration_sec: 0, air_date: 0,
      watch: null
    }))
    const p = videoCandidatePrompt({ ...facts, video_type: 'series', episodes: many, episode_files: 40, seasons: [1] })
    assert.ok(p.includes('还有 34 集'), '截断了得说一声，否则模型以为只有 6 集')
    assert.ok(!p.includes('S01E40'), '第 40 集不该出现在 prompt 里')
  })

  await check('系统提示的占位符全被填掉，分类逐条带描述进去', () => {
    const s = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, true, true)
    // 占位符漏一个，模型看到的就是字面量 {{tags}}
    assert.ok(!s.includes('{{'), `还有没填的占位符：${s.match(/\{\{\w+\}\}/g)?.join(' ')}`)
    for (const c of VIDEO_CATEGORIES) {
      assert.ok(s.includes(`· ${c.name} —— ${c.description}`), `分类「${c.name}」没进 prompt`)
    }
    assert.ok(s.includes(VIDEO_TAGS.join('、')), '标签池该整条填进去')
  })

  await check('空分类表 / 空标签池要给兜底话术，不留空行', () => {
    const s = fillVideoSystem([], [], true, true)
    assert.ok(!s.includes('{{'))
    assert.ok(s.includes('分类表是空的'))
    assert.ok(s.includes('标签池还是空的'))
  })

  await check('视频 prompt 不夹带另两个品类的词', () => {
    const s = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, true, true)
    // v0.5 的学费：分类和标签曾是全局单表，「开发工具」进过游戏 prompt
    for (const alien of ['开发工具', '系统管理', '魂系', '绿色软件', '存档', 'exe']) {
      assert.ok(!s.includes(alien), `视频 prompt 里出现了别的品类的词：${alien}`)
    }
  })

  await check('提示词和工具集对得上：关搜索时明确说了没有 web_search 这个工具', () => {
    const off = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, false, true)
    assert.ok(off.includes('没有开启联网搜索'))
    assert.ok(off.includes('不要尝试调用'), '光不提不够 —— 得明确说这个工具不存在')
    // 开着的时候要真的教它怎么用，而不是只提一句名字
    const on = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, true, true)
    assert.ok(on.includes('web_search'))
    assert.ok(!on.includes('没有开启联网搜索'))
  })

  await check('没配 TMDB 时提示词说清三个工具都没有，并给降级指示', () => {
    const noTmdb = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, true, false)
    assert.ok(noTmdb.includes('本次运行没有配置 TMDB'))
    assert.ok(noTmdb.includes('tmdb_id 留空'))
    assert.ok(noTmdb.includes('不要编简介'), '没有数据源时最容易发生的失手就是编简介')
  })

  /* -------- 工具集的形状 -------- */
  const db = new DatabaseSync(':memory:')
  initSchema(db as any, KINDS)

  const mkCtx = (over: Record<string, unknown> = {}) => ({
    facts,
    db: db as any,
    tagPool: [...VIDEO_TAGS],
    searchConfig: { provider: 'model_builtin' as const, api_key: '', endpoint: '', enabled: false },
    // 默认关掉 TMDB：这一节只验工具形状和核对逻辑，一次网络请求都不该发出去
    tmdbConfig: { api_key: '', api_domain: '', image_domain: '', enabled: false },
    ...over
  })

  await check('工具集里没有 list_directory / read_text_file —— 视频用不上', () => {
    const names = buildVideoTools(mkCtx(), ['华语'], true, true).map((t) => t.name)
    // 目录结构 scanner 看过了，facts 读过了。给一个用不上的工具只会引诱模型
    // 浪费一轮，而每轮都要把整个上下文重发
    assert.ok(!names.includes('list_directory'))
    assert.ok(!names.includes('read_text_file'))
    assert.ok(names.includes('register_video'))
    assert.ok(names.includes('skip_entry'))
  })

  await check('开关决定工具在不在：TMDB 关了那三个工具就不该出现', () => {
    const withAll = buildVideoTools(mkCtx(), ['华语'], true, true).map((t) => t.name)
    assert.ok(withAll.includes('tmdb_search') && withAll.includes('tmdb_detail') && withAll.includes('tmdb_find'))
    assert.ok(withAll.includes('web_search'))

    const bare = buildVideoTools(mkCtx(), ['华语'], false, false).map((t) => t.name)
    assert.deepEqual(bare, ['register_video', 'skip_entry'])
  })

  await check('register_video 的参数表里没有技术字段 —— 那些不许模型经手', () => {
    const tool = buildVideoTools(mkCtx(), ['华语'], true, true).find((t) => t.name === 'register_video')
    assert.ok(tool)
    const props = Object.keys((tool!.parameters as any).properties)
    for (const tech of ['resolution', 'video_codec', 'duration_sec', 'audio_tracks', 'source', 'release_group']) {
      assert.ok(!props.includes(tech), `register_video 不该收 ${tech}，它是本地确定值`)
    }
    assert.ok(props.includes('name_zh') && props.includes('category') && props.includes('tmdb_id'))
  })

  await check('分类枚举来自实参，模型选不出表外的值', () => {
    const tool = buildVideoTools(mkCtx(), ['华语', '欧美'], true, true).find((t) => t.name === 'register_video')
    const cat = (tool!.parameters as any).properties.category
    assert.deepEqual(cat.enum, ['华语', '欧美'])
  })

  /* -------- 标签收敛 -------- */
  await check('标签收敛：池内照收，池外只留 2 个，总数封顶 3', () => {
    const pool = new Set(VIDEO_TAGS)
    assert.deepEqual(limitVideoTags(['科幻', '悬疑'], pool), ['科幻', '悬疑'])
    // 池外的只留前 2 个
    const mixed = limitVideoTags(['科幻', '新词甲', '新词乙', '新词丙'], pool)
    assert.equal(mixed.length, 3)
    assert.ok(mixed.includes('科幻'))
    assert.ok(!mixed.includes('新词丙'))
    assert.deepEqual(limitVideoTags(null, pool), [])
    assert.deepEqual(limitVideoTags('不是数组', pool), [])
  })

  await check('技术词不许当标签 —— 它们已经是 video_meta 上的真列了', () => {
    const pool = new Set(VIDEO_TAGS)
    const got = limitVideoTags(['4K', 'HEVC', '蓝光', 'HDR', '杜比', '科幻'], pool)
    assert.deepEqual(got, ['科幻'], `技术词该被剔掉，实际留下 ${got.join('、')}`)
    // 大小写不敏感，写法也不止一种
    assert.deepEqual(limitVideoTags(['hevc', '1080p', 'x265', 'web-dl'], pool), [])
  })

  await check('标签去重 —— 模型重复报同一个词不该占掉两个格子', () => {
    assert.deepEqual(limitVideoTags(['科幻', '科幻', '悬疑'], new Set(VIDEO_TAGS)), ['科幻', '悬疑'])
  })

  /* -------- 编 id 必须被拦住 -------- */
  await check('编出来的 tmdb_id 被丢掉，并把这件事回灌给模型', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)

    let registered: any = null
    const tools = buildVideoTools(
      mkCtx({ db: d as any, onRegister: (info: any) => { registered = info } }) as any,
      ['欧美'],
      false,
      false
    )
    const out = await tools.find((t) => t.name === 'register_video')!.execute({
      name_zh: '沙丘',
      summary: '沙漠星球上的权力更替',
      category: '欧美',
      // 这个 id 从来没在任何一次查询里出现过
      tmdb_id: 123456,
      tags: ['科幻']
    })

    assert.ok(registered, '注册本身该成功 —— 编了 id 不等于整条记录作废')
    assert.ok(out.includes('123456'), '要把编的那个 id 说出来，否则模型下一条继续编')
    assert.ok(out.includes('已被忽略'))

    const row = d.prepare('SELECT tmdb_id FROM video_meta').get() as any
    assert.equal(row.tmdb_id, '', '编的 id 绝不能落库 —— 下次刷新会刮到另一部片')
    d.close()
  })

  await check('注册回调带回条目 id，供注册后自动下载封面', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)
    let registered: any = null
    const ctx = mkCtx({ db: d as any, onRegister: (info: any) => { registered = info } }) as any
    const tools = buildVideoTools(ctx, ['欧美'], false, false)
    const reg = tools.find((t) => t.name === 'register_video')!
    await reg.execute({ name_zh: '沙丘', summary: 'x', category: '欧美' })
    assert.ok(registered?.id, '注册回调必须返回数据库条目 id')
    assert.equal(registered.hanime_id, '', '普通影视注册不应伪造 Hanime id')
    d.close()
  })

  await check('数字型 tmdb_id 也要认 —— 参数表声明的就是 number', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)
    const tools = buildVideoTools(mkCtx({ db: d as any }) as any, ['欧美'], false, false)
    const reg = tools.find((t) => t.name === 'register_video')!

    // 守规矩的模型交 JSON 数字。用 str() 读会读成空串，于是这个 id 既不落库
    // 也不报「被忽略」—— 刮削静默失效，日志里什么都看不出来。
    // 这里 ledger 是空的，所以正确行为是**明确拒绝**，而不是当没填过
    const out = await reg.execute({ name_zh: '沙丘', summary: 'x', category: '欧美', tmdb_id: 438631 })
    assert.ok(out.includes('438631'), '数字 id 被静默吞掉了，不是被拒绝')

    // 字符串写法、带前缀的写法都要落到同一个值上
    const out2 = await reg.execute({ name_zh: '沙丘', summary: 'x', category: '欧美', tmdb_id: 'tmdb:438631' })
    assert.ok(out2.includes('438631'))
    // 真的没填时不该报「你编了个 id」
    const out3 = await reg.execute({ name_zh: '沙丘', summary: 'x', category: '欧美' })
    assert.ok(!out3.includes('已被忽略'))
    assert.ok(out3.includes('未填'))
    d.close()
  })

  await check('技术字段按本地事实落库，不受模型影响', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)

    const tools = buildVideoTools(mkCtx({ db: d as any }) as any, ['欧美'], false, false)
    await tools.find((t) => t.name === 'register_video')!.execute({
      name_zh: '沙丘', summary: '一句话', category: '欧美',
      // 模型硬塞技术字段也没用 —— 它们不在参数表里，register 不读
      resolution: '480p', video_codec: '假编码', duration_sec: 1
    })

    const row = d
      .prepare('SELECT resolution, video_codec, duration_sec, source, release_group FROM video_meta')
      .get() as any
    assert.equal(row.resolution, '1080p', '该用容器/文件名读出来的值')
    assert.equal(row.video_codec, 'AVC')
    assert.equal(row.duration_sec, 9300)
    assert.equal(row.source, 'BLURAY')
    assert.equal(row.release_group, 'GROUP')
    d.close()
  })

  await check('落库路径用扫描器给的那个，模型改不动', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)
    const tools = buildVideoTools(mkCtx({ db: d as any }) as any, ['欧美'], false, false)
    await tools.find((t) => t.name === 'register_video')!.execute({
      name_zh: '沙丘', summary: 'x', category: '欧美', path: 'C:\\别的地方\\假的.mkv'
    })
    const row = d.prepare('SELECT path, source_dir FROM resource').get() as any
    assert.equal(row.path, facts.path)
    assert.equal(row.source_dir, facts.dir)
    d.close()
  })

  await check('skip_entry 用的是扫描器给的路径，不收模型的 path', async () => {
    // 用 any：赋值发生在回调里，控制流分析看不见，标成联合类型会被收窄成 never
    let skipped: any = null
    const tools = buildVideoTools(
      mkCtx({ onSkip: (p: string, reason: string) => { skipped = { path: p, reason } } }) as any,
      ['华语'],
      false,
      false
    )
    const skip = tools.find((t) => t.name === 'skip_entry')!
    // 参数表里根本没有 path —— 模型无从指定一个别的路径
    assert.ok(!Object.keys((skip.parameters as any).properties).includes('path'))
    await skip.execute({ reason: '是教学录屏' })
    assert.ok(skipped)
    assert.equal(skipped.path, facts.path)
    assert.equal(skipped.reason, '是教学录屏')
  })

  await check('name_zh 为空要报错而不是存一条无名条目', async () => {
    const tools = buildVideoTools(mkCtx(), ['华语'], false, false)
    const reg = tools.find((t) => t.name === 'register_video')!
    await assert.rejects(() => reg.execute({ summary: 'x', category: '华语' }))
    await assert.rejects(() => reg.execute({ name_zh: '   ', summary: 'x', category: '华语' }))
  })

  /* -------- 两套 id 空间不许互相顶替 -------- */
  await check('电影 id 不许当剧集 id 用 —— TMDB 的两套编号各自独立', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)

    // 这一条要 TMDB 开着才验得到：ledger 里得先有那个电影 id
    const restore = stubFetch({
      // 模型先按电影搜了一次，拿到 438631
      '/search/movie': { results: [{ id: 438631, title: 'Dune', release_date: '2021-10-22' }] },
      '/search/tv': { results: [] }
    })
    try {
      const tools = buildVideoTools(
        mkCtx({
          db: d as any,
          facts: { ...facts, video_type: 'series' as const },
          tmdbConfig: { api_key: 'k', api_domain: '', image_domain: '', enabled: true }
        }) as any,
        ['欧美'],
        false,
        true
      )
      await tools.find((t) => t.name === 'tmdb_search')!.execute({ query: 'Dune', type: 'movie' })

      // 然后把这个**电影** id 填进一个剧集条目
      const out = await tools.find((t) => t.name === 'register_video')!.execute({
        name_zh: '沙丘', summary: 'x', category: '欧美', tmdb_id: 438631
      })

      const row = d.prepare('SELECT tmdb_id FROM video_meta').get() as any
      // 退回另一个形态去找的话，年份、简介、imdb_id 全从那部电影抄过来，
      // 而那个电影 id 还被写进 tmdb_id —— 下次刷新按剧集去查它，查到的是别人
      assert.equal(row.tmdb_id, '', '电影 id 不该落到剧集条目上')
      assert.ok(out.includes('438631'), '要把这个 id 说出来')
      assert.ok(out.includes('两套') || out.includes('独立'), '要说清是两套 id 空间，否则模型只会再编一个')
    } finally {
      restore()
    }
    d.close()
  })

  /* -------- 豆瓣：工具形状 -------- */
  await check('豆瓣工具跟着联网搜索的开关走，没有第五个布尔', () => {
    const on = buildVideoTools(mkCtx(), ['华语'], true, true).map((t) => t.name)
    assert.ok(on.includes('douban_search'))
    assert.ok(on.includes('web_search'), '两个搜索工具同一个闸门')

    // 关搜索时两个一起消失 —— 只关一个会让提示词和工具集对不上
    const off = buildVideoTools(mkCtx(), ['华语'], false, true).map((t) => t.name)
    assert.ok(!off.includes('douban_search'))
    assert.ok(!off.includes('web_search'))
  })

  await check('register_video 收 douban_id 但不收豆瓣评分 —— 分不是模型填的', () => {
    const tool = buildVideoTools(mkCtx(), ['华语'], true, true).find((t) => t.name === 'register_video')!
    const props = Object.keys((tool.parameters as any).properties)
    assert.ok(props.includes('douban_id'))
    // 让模型填分就是请它编一个：它没有任何途径知道豆瓣给某部片打了几分
    for (const bad of ['douban_rating', 'rating', 'douban_url']) {
      assert.ok(!props.includes(bad), `register_video 不该收 ${bad}`)
    }

    // 关搜索时 douban_id 也该消失：查不到就没有合法来源，留着只会被编
    const offProps = Object.keys(
      (buildVideoTools(mkCtx(), ['华语'], false, true).find((t) => t.name === 'register_video')!
        .parameters as any).properties
    )
    assert.ok(!offProps.includes('douban_id'))
  })

  /* -------- 豆瓣：编出来的 id 必须被拦住 -------- */
  await check('编出来的 douban_id 被丢掉 —— 错的豆瓣链接比没有链接更糟', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)

    const tools = buildVideoTools(mkCtx({ db: d as any }) as any, ['欧美'], true, false)
    const out = await tools.find((t) => t.name === 'register_video')!.execute({
      name_zh: '沙丘',
      summary: 'x',
      category: '欧美',
      // 一次 douban_search 都没查过，这个 id 无从得来
      douban_id: '1292052'
    })

    const row = d.prepare('SELECT douban_id, douban_rating FROM video_meta').get() as any
    const res = d.prepare('SELECT official_url FROM resource').get() as any
    assert.equal(row.douban_id, '', '没查过的 douban_id 不能落库')
    assert.equal(row.douban_rating, 0)
    assert.ok(!res.official_url.includes('douban'), '连带的条目链接也不该出现')
    assert.ok(out.includes('1292052'), '要把编的那个 id 说出来')
    d.close()
  })

  await check('豆瓣评分从查询结果里取，不从模型的参数里取', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)
    clearSearchCache()

    // Tavily 形状的假响应，摘要里带评分
    const restore = stubJson({
      results: [
        {
          title: '肖申克的救赎 The Shawshank Redemption (豆瓣)',
          url: 'https://movie.douban.com/subject/1292052/',
          content: '豆瓣评分 9.7 / 1994年 / 美国 / 剧情'
        }
      ]
    })
    try {
      const tools = buildVideoTools(
        mkCtx({
          db: d as any,
          searchConfig: { provider: 'tavily' as const, api_key: 'k', endpoint: '', enabled: true }
        }) as any,
        ['欧美'],
        true,
        false
      )
      const found = await tools.find((t) => t.name === 'douban_search')!.execute({
        title: '肖申克的救赎', year: 1994
      })
      assert.ok(found.includes('1292052'))
      assert.ok(found.includes('9.7'), '查询结果里要把分报给模型看，但那不是让它填回来')

      await tools.find((t) => t.name === 'register_video')!.execute({
        name_zh: '肖申克的救赎',
        summary: 'x',
        category: '欧美',
        douban_id: '1292052',
        // 模型顺手编一个分 —— 参数表里没有这个键，register 不读
        douban_rating: 3.2
      })

      const row = d.prepare('SELECT douban_id, douban_rating FROM video_meta').get() as any
      const res = d.prepare('SELECT official_url FROM resource').get() as any
      assert.equal(row.douban_id, '1292052', '查过的 id 该收下')
      assert.equal(row.douban_rating, 9.7, '分该来自摘要，不是模型说的 3.2')
      // 没有 TMDB 主页时，豆瓣条目页就是这个条目唯一的官方链接
      assert.equal(res.official_url, 'https://movie.douban.com/subject/1292052/')
    } finally {
      restore()
      clearSearchCache()
    }
    d.close()
  })

  await check('豆瓣的分不覆盖 TMDB 的分 —— 一手数据和摘要快照分开存', async () => {
    const d = new DatabaseSync(':memory:')
    initSchema(d as any, KINDS)
    clearSearchCache()

    const restore = stubJson({
      results: [
        {
          title: '沙丘 Dune (豆瓣)',
          url: 'https://movie.douban.com/subject/3820120/',
          content: '豆瓣评分 7.9'
        }
      ]
    })
    try {
      const tools = buildVideoTools(
        mkCtx({
          db: d as any,
          searchConfig: { provider: 'tavily' as const, api_key: 'k', endpoint: '', enabled: true }
        }) as any,
        ['欧美'],
        true,
        false
      )
      await tools.find((t) => t.name === 'douban_search')!.execute({ title: '沙丘' })
      await tools.find((t) => t.name === 'register_video')!.execute({
        name_zh: '沙丘', summary: 'x', category: '欧美', douban_id: '3820120'
      })
      const row = d.prepare('SELECT rating, douban_rating FROM video_meta').get() as any
      // rating 是 TMDB 那一列，这次没配 TMDB 所以是 0；豆瓣的分不该顺手填进去
      assert.equal(row.rating, 0, '豆瓣的分不能占掉 TMDB 那一列')
      assert.equal(row.douban_rating, 7.9)
    } finally {
      restore()
      clearSearchCache()
    }
    d.close()
  })

  await check('搜索次数按真的发出去的请求算，缓存命中不计', async () => {
    clearSearchCache()
    let searches = 0
    const restore = stubJson({
      results: [
        { title: '黑暗荣耀 (豆瓣)', url: 'https://movie.douban.com/subject/35465232/', content: '豆瓣评分 7.8' }
      ]
    })
    try {
      const tools = buildVideoTools(
        mkCtx({
          searchConfig: { provider: 'tavily' as const, api_key: 'k', endpoint: '', enabled: true },
          onSearch: () => { searches++ }
        }) as any,
        ['日韩'],
        true,
        false
      )
      const douban = tools.find((t) => t.name === 'douban_search')!
      await douban.execute({ title: '黑暗荣耀', year: 2022 })
      assert.equal(searches, 1)

      // 同一部剧的第二季查的是同一个剧名 —— 服务商那边只扣了一次，
      // 报成两次会让用户拿着一个比账单大的数去质疑服务商
      await douban.execute({ title: '黑暗荣耀', year: 2022 })
      assert.equal(searches, 1, '缓存命中不该计入搜索次数')
    } finally {
      restore()
      clearSearchCache()
    }
  })

  await check('豆瓣查询有上限 —— 按次计费的东西不能由模型无限点', async () => {
    clearSearchCache()
    let searches = 0
    const restore = stubJson({ results: [] })
    try {
      const tools = buildVideoTools(
        mkCtx({
          searchConfig: { provider: 'tavily' as const, api_key: 'k', endpoint: '', enabled: true },
          onSearch: () => { searches++ }
        }) as any,
        ['华语'],
        true,
        false
      )
      const douban = tools.find((t) => t.name === 'douban_search')!
      // 每次换个片名，避开缓存
      const outs: string[] = []
      for (const t of ['甲', '乙', '丙', '丁']) outs.push(await douban.execute({ title: t }))

      assert.ok(searches <= 2, `豆瓣查询该封顶在 2 次，实际发出 ${searches} 次`)
      // 撞上限要说出来，不能静默返回空 —— 静默的话模型只会一直重试
      const last = outs[outs.length - 1]
      assert.ok(last.includes('不要再查'), `撞上限那次要明确叫停，实际回的是：${last.slice(0, 60)}`)
      // 而且要告诉它「留空是可以接受的答案」，否则它会转头去编一个 id
      assert.ok(last.includes('留空'))
    } finally {
      restore()
      clearSearchCache()
    }
  })

  await check('提示词里的豆瓣那段跟着开关走，且占位符不留残迹', () => {
    const on = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, true, true)
    assert.ok(!on.includes('{{'), '占位符全填掉')
    assert.ok(on.includes('douban_search'))
    assert.ok(on.includes('中文名'), '要说清按中文名查 —— 用英文名在豆瓣上搜不到')

    const off = fillVideoSystem(VIDEO_CATEGORIES, VIDEO_TAGS, false, true)
    assert.ok(!off.includes('{{'))
    // 关搜索时不能提到一个不存在的工具，但要说清它不存在
    assert.ok(off.includes('没有 `web_search` 和 `douban_search`'))
    // 步骤编号不能因为豆瓣那段被抽掉而断档
    for (const n of ['1.', '2.', '3.', '4.', '5.']) assert.ok(off.includes(n), `步骤 ${n} 不见了`)
    assert.ok(!/^\s*4\.\s*$/m.test(off), '空替换留下了一个光秃秃的「4.」')
  })

  db.close()
}


/* ==================== 视频海报 · v0.7 Step 6 ==================== */

/**
 * 挑图、命名、下载白名单。
 *
 * 这一节盯的是三件会实打实变成破图的事：
 *
 * 1. **`poster_path` 那一列存过两种值**（TMDB 相对路径 / 本机绝对路径）。分错
 *    一头是永远加载不出来的图，另一头是去拼一个 `.../w500/D:/...` 的地址。
 * 2. **图片域名是用户配的。** 白名单必须跟着当下这份配置走 —— 写死官方域名
 *    等于把配了反代的用户全挡在外面，而那批人正是最需要这个功能的。
 * 3. **挑图的优先级**决定用户看到的是竖版海报，还是被裁掉两边的横版剧照。
 */
export async function videoPosterSection(): Promise<void> {
  console.log('\n视频海报 · 挑图与下载')

  await check('海报和游戏封面认的格式是同一份名单', () => {
    // kinds/ 之间不该互相 import，所以这份一致性没有编译期保障，只能靠这一条盯着。
    // 两处都是最终塞进渲染进程 <img> 的图，能渲染的集合本就是同一个
    assert.deepEqual(POSTER_EXTS, COVER_EXTS)
    assert.ok(isPosterExt('a.JPG') && isPosterExt('海报.webp'))
    assert.ok(!isPosterExt('a.ico') && !isPosterExt('a.psd'), '塞进 2:3 的框里必然糊')
    assert.ok(!isPosterExt('poster'), '没扩展名的不收')
  })

  await check('海报文件按条目 id 命名，认不出的扩展名退回 .jpg', () => {
    // 用片名的话，详情页上改个名字就得同步挪文件；不挪就是一堆对不上的孤儿
    assert.equal(posterFileName('v1', 'D:\\x\\poster.PNG'), 'v1.png')
    assert.equal(posterFileName('v1', '/t/p/w500/abc.jpg'), 'v1.jpg')
    assert.equal(posterFileName('v1', 'noext'), 'v1.jpg')
    assert.equal(posterFileName('v1', 'a.svg'), 'v1.jpg', '不认的格式不能原样落到文件名上')
  })

  await check('换扩展名时清孤儿的名单覆盖所有认得的格式', () => {
    const siblings = posterSiblings('v1')
    assert.equal(siblings.length, POSTER_EXTS.length)
    for (const ext of POSTER_EXTS) assert.ok(siblings.includes(`v1${ext}`), `${ext} 不在清理名单里`)
    // 实际会写出来的那个名字必须在名单里，否则 dropPosterFiles 漏删的正是当前这张
    assert.ok(siblings.includes(posterFileName('v1', 'x.webp')))
  })

  await check('本地海报和 TMDB 相对路径分得开 —— 这一列两种值都存过', () => {
    // 刮削阶段先落 TMDB 的相对路径，下载完覆盖成本机绝对路径。两者都以分隔符
    // 开头，光看第一个字符分不出来
    assert.equal(isLocalPoster('D:\\baoyi\\posters\\v1.jpg'), true)
    assert.equal(isLocalPoster('d:/baoyi/posters/v1.jpg'), true)
    assert.equal(isLocalPoster('\\\\nas\\share\\v1.jpg'), true, 'UNC 也是本地路径')
    assert.equal(isLocalPoster('/home/u/.config/baoyi/posters/v1.jpg'), true)

    // TMDB 那种只有一层：`/abc123.jpg`
    assert.equal(isLocalPoster('/wPRcNZ4Q1Rk.jpg'), false)
    assert.equal(isLocalPoster(''), false)
    assert.equal(isLocalPoster('   '), false, '空白串不能算成一个本地文件')
    // 空值进来不能抛 —— 这一列是从库里读的，历史行什么形状都有
    assert.equal(isLocalPoster(undefined as any), false)
    assert.equal(isLocalPoster(null as any), false)
  })

  await check('图片白名单跟着用户配的域名走，不是写死官方那个', () => {
    // 官方图片域名在国内基本连不上，用户填反代是常态。写死就等于把配了反代的
    // 用户全挡在外面 —— image_domain 这个配置项存在的理由就是这个
    const proxy = { api_key: 'k', api_domain: '', image_domain: 'https://img.mycdn.cn/', enabled: true }
    assert.equal(acceptPosterUrl('https://img.mycdn.cn/t/p/w500/abc.jpg', proxy), true)
    // 配了反代之后官方域名就不在白名单里了：允许的是「用户填的那台机器」，
    // 不是「我们认识的所有机器」
    assert.equal(acceptPosterUrl('https://image.tmdb.org/t/p/w500/abc.jpg', proxy), false)

    // 没填时退回默认域名，这条路不能因为配置项空着就断掉
    const bare = { api_key: 'k', api_domain: '', image_domain: '', enabled: true }
    assert.equal(acceptPosterUrl('https://image.tmdb.org/t/p/w500/abc.jpg', bare), true)
  })

  await check('白名单卡的是主机名本身，前缀像也不放', () => {
    const cfg = { api_key: 'k', api_domain: '', image_domain: 'img.mycdn.cn', enabled: true }
    // 地址里那段相对路径来自 TMDB 的响应，等于外部输入。不卡主机就等于让远端
    // 决定这个进程去连哪台机器
    assert.equal(acceptPosterUrl('https://img.mycdn.cn.evil.test/t/p/w500/a.jpg', cfg), false)
    assert.equal(acceptPosterUrl('https://evil.test/img.mycdn.cn/a.jpg', cfg), false)
    assert.equal(acceptPosterUrl('https://u:p@evil.test/a.jpg?h=img.mycdn.cn', cfg), false)
    assert.equal(acceptPosterUrl('http://img.mycdn.cn/t/p/w500/a.jpg', cfg), false, 'http 不收')
    assert.equal(acceptPosterUrl('https://img.mycdn.cn/t/p/w500/a.svg', cfg), false)
    assert.equal(acceptPosterUrl('https://img.mycdn.cn/t/p/w500/abc', cfg), false, '看不出是图片的不收')
    assert.equal(acceptPosterUrl('not a url', cfg), false, '拼不出 URL 时不能抛')
    assert.equal(acceptPosterUrl('', cfg), false)
    assert.equal(acceptPosterUrl('https://img.mycdn.cn/a.jpg', undefined as any), false, '没配置时不该抛')
  })

  await check('拼地址的那头和验地址的那头对得上', () => {
    // 两处各写一份域名归一，改了一处就是「下载失败：这个图片地址不在允许的来源里」，
    // 而用户看不出是哪一头错了
    for (const domain of ['', 'img.mycdn.cn', 'https://img.mycdn.cn/', 'https://img.mycdn.cn/3']) {
      const cfg = { api_key: 'k', api_domain: '', image_domain: domain, enabled: true }
      const url = imageUrl(cfg, '/wPRcNZ4Q1Rk.jpg', 'w500')
      assert.ok(acceptPosterUrl(url, cfg), `imageUrl 拼出的 ${url} 被自己的白名单拒了`)
    }
  })

  /* ---------------------- 里番封面：外站地址那一支 ---------------------- */

  // v0.8 的 hanime 通道把封面地址解出来了却**从来没用过** —— register_video 里
  // `poster_path` 只取 TMDB 那份，于是里番条目永远是空白海报。用户报的
  // 「封面获取没体现」就是这个。
  //
  // 补上之后 poster_path 多了第三种值（完整的 https 地址），下面守的是
  // 「这一支不许被当成 TMDB 的相对路径」和「外站地址的护栏别开太大」。

  await check('完整的 https 地址要认出来，别当成 TMDB 的相对路径', () => {
    // 认错的表现很具体：拼出 https://image.tmdb.org/t/p/w500/https://… 然后 404
    assert.equal(isRemotePoster('https://cdn.example.com/thumb/86994.jpg'), true)
    assert.equal(isRemotePoster('http://cdn.example.com/a.jpg'), true, 'http 也算远端，收不收是下一道的事')
    assert.equal(isRemotePoster('/abc123.jpg'), false, 'TMDB 的相对路径')
    assert.equal(isRemotePoster('D:\\baoyi\\posters\\x.jpg'), false, '本地文件')
    assert.equal(isRemotePoster(''), false)
    // 三个判据合起来必须是互斥的，否则 fetchVideoPoster 里的分支顺序会说不清
    assert.equal(isLocalPoster('https://cdn.example.com/a.jpg'), false)
  })

  await check('外站封面走反向护栏：https + 不许指向内网', () => {
    // 正向白名单在这儿做不了 —— hanime 的封面在哪个 CDN 上至今没抓到真页面
    // （待确认 H），编一个域名白名单出来就是在假装知道，而猜错的表现是
    // 「封面永远刮不到」，和这个功能压根没接上长得一模一样
    assert.equal(acceptExternalPosterUrl('https://cdn.hanime1.me/thumb/86994.jpg'), true)
    assert.equal(acceptExternalPosterUrl('https://vdown.example.net/x/y'), true, 'CDN 常常不带扩展名')

    assert.equal(acceptExternalPosterUrl('http://cdn.example.com/a.jpg'), false, 'http 不收')
    // 页面是外部输入，它写什么主机名我们就会去连什么 —— 指向内网的话这个进程
    // 就变成了替远端探内网的工具
    for (const bad of [
      'https://127.0.0.1/a.jpg',
      'https://localhost/a.jpg',
      'https://192.168.1.1/a.jpg',
      'https://10.0.0.5/a.jpg',
      'https://172.16.3.4/a.jpg',
      'https://172.31.255.1/a.jpg',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.jpg'
    ]) {
      assert.equal(acceptExternalPosterUrl(bad), false, `${bad} 该被挡住`)
    }
    // 172.15 / 172.32 不在私有段里，别顺手多挡
    assert.equal(acceptExternalPosterUrl('https://172.15.0.1/a.jpg'), true)
    assert.equal(acceptExternalPosterUrl('https://172.32.0.1/a.jpg'), true)

    assert.equal(acceptExternalPosterUrl('https://nodot/a.jpg'), false, '没有点的主机名不像公网域名')
    assert.equal(acceptExternalPosterUrl('not a url'), false, '拼不出 URL 时不能抛')
    assert.equal(acceptExternalPosterUrl(''), false)
  })

  await check('两套判据不许互相顶替', () => {
    // 分错的方向不对称：把外站地址当 TMDB 会白挡掉（封面刮不到），
    // 把 TMDB 当外站会松掉那道「只许连用户配的那台机器」。
    // 所以 downloadPoster 的 source 由调用方说明，不在函数里嗅 URL
    const cfg = { api_key: 'k', api_domain: '', image_domain: 'img.mycdn.cn', enabled: true }
    const tmdbUrl = imageUrl(cfg, '/abc.jpg', 'w500')
    assert.ok(acceptPosterUrl(tmdbUrl, cfg), 'TMDB 的地址过 TMDB 那道')
    // 反过来：外站的地址过不了 TMDB 那道，这正是为什么需要第二套
    assert.equal(acceptPosterUrl('https://cdn.hanime1.me/thumb/1.jpg', cfg), false)
  })

  await check('扩展名以 content-type 为准，认不出就不落盘', () => {
    // 远端完全可以在 .jpg 地址上回一张 webp，而扩展名写错的文件在 <img> 里
    // 未必渲染得出来
    assert.equal(posterExtFromContentType('image/jpeg'), '.jpg')
    assert.equal(posterExtFromContentType('image/JPEG; charset=binary'), '.jpg')
    assert.equal(posterExtFromContentType('  Image/WebP  '), '.webp')
    assert.equal(posterExtFromContentType('image/x-ms-bmp'), '.bmp', '老 IIS 回的就是这个写法')
    // 反代挂了会回一个 HTML 错误页，那玩意儿存成 .jpg 就是一张永久的破图
    assert.equal(posterExtFromContentType('text/html'), '')
    assert.equal(posterExtFromContentType(''), '')
    assert.equal(posterExtFromContentType(undefined as any), '')
    for (const ct of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) {
      assert.ok(POSTER_EXTS.includes(posterExtFromContentType(ct)), `${ct} 推出的扩展名不在白名单里`)
    }
    // 两个品类的图走的是同一条「按 content-type 定扩展名」的路，结论必须一样
    assert.equal(posterExtFromContentType('image/avif'), extFromContentType('image/avif'))
  })

  await check('从路径取扩展名时不把查询串算进去', () => {
    assert.equal(extFromPath('/t/p/w500/abc.JPG'), '.jpg')
    assert.equal(extFromPath('/t/p/w500/abc'), '')
    assert.equal(extFromPath('/a.jpg/b'), '', '最后一段没扩展名就是没有')
    assert.equal(extFromPath(''), '')
    assert.equal(extFromPath(undefined as any), '')
  })

  await check('体积上限是个有限值，且大得下得了正常海报', () => {
    // w500 的竖版海报通常几十 KB。上限太小会把正常海报拒掉，而错误信息只会说「图太大了」
    assert.ok(Number.isFinite(MAX_POSTER_BYTES))
    assert.ok(MAX_POSTER_BYTES > 1024 * 1024)
  })

  await check('挑图优先级：竖版海报压过横版剧照', () => {
    // fanart / backdrop 是横版，塞进 2:3 的框里会被裁掉两边，只当兜底
    assert.equal(pickSidecarPoster(['/m/fanart.jpg', '/m/poster.jpg']), '/m/poster.jpg')
    assert.equal(pickSidecarPoster(['/m/poster.jpg', '/m/folder.jpg']), '/m/poster.jpg')
    assert.equal(pickSidecarPoster(['/m/folder.jpg', '/m/fanart.jpg']), '/m/folder.jpg')
    // 认不出名字的也压过横版：一个目录里孤零零一张 jpg，十次里九次就是海报，
    // 而 fanart 是确定的横版
    assert.equal(pickSidecarPoster(['/m/fanart.jpg', '/m/IMG_8821.jpg']), '/m/IMG_8821.jpg')
    // 只有横版时还是用它 —— 比首字占位像样
    assert.equal(pickSidecarPoster(['/m/backdrop.png']), '/m/backdrop.png')
  })

  await check('挑图和目录里文件的先后无关', () => {
    // readdirSync 的顺序跟文件系统有关，同一个片库在两台机器上可能不一样。
    // 优先级要是被顺序影响，就会出现「他那儿是海报，我这儿是剧照」
    const files = ['/m/fanart.jpg', '/m/season01-poster.jpg', '/m/poster.jpg', '/m/folder.jpg']
    for (let i = 0; i < files.length; i++) {
      const rotated = [...files.slice(i), ...files.slice(0, i)]
      assert.equal(pickSidecarPoster(rotated), '/m/poster.jpg', `顺序 ${rotated.join(',')} 挑错了`)
    }
  })

  await check('`<片名>-poster.jpg` 认得出来，且比 folder.jpg 优先', () => {
    // tinyMediaManager 默认就写这个名字，用户目录里躺着的往往正是它
    const files = ['/m/folder.jpg', '/m/Dune.2021.1080p-poster.jpg', '/m/fanart.jpg']
    assert.equal(pickSidecarPoster(files, 'Dune.2021.1080p.mkv'), '/m/Dune.2021.1080p-poster.jpg')
    // 传的是 file_name（带扩展名），归一时要把 .mkv 切掉
    assert.equal(pickSidecarPoster(['/m/Dune-poster.jpg'], 'Dune.mkv'), '/m/Dune-poster.jpg')
    // 片名对不上时也还能按通用后缀认出来，只是排在 folder 后面
    assert.equal(pickSidecarPoster(['/m/别的名字-poster.jpg'], 'Dune.mkv'), '/m/别的名字-poster.jpg')
  })

  await check('季海报只在整部剧的海报缺席时才顶上', () => {
    assert.equal(pickSidecarPoster(['/s/season01-poster.jpg', '/s/poster.jpg']), '/s/poster.jpg')
    assert.equal(pickSidecarPoster(['/s/season01-poster.jpg', '/s/fanart.jpg']), '/s/season01-poster.jpg')
  })

  await check('banner / clearlogo / 单集缩略图一概不当海报', () => {
    // 这几类塞进竖版框里的结果比首字占位更难看：logo 是透明底的横条，
    // thumb 是某一集的截图
    for (const bad of ['banner', 'clearlogo', 'clearart', 'logo', 'disc', 'discart', 'characterart', 'thumb', 'landscape']) {
      assert.equal(pickSidecarPoster([`/m/${bad}.jpg`]), '', `${bad}.jpg 不该被挑成海报`)
    }
    assert.equal(pickSidecarPoster(['/m/S01E02-thumb.jpg']), '', '单集截图不是整部剧的海报')
    assert.equal(pickSidecarPoster(['/m/Dune-banner.png']), '')
    // 排除的只是这些名字，同目录还有别的图时不能被连带拖下水
    assert.equal(pickSidecarPoster(['/m/banner.jpg', '/m/poster.jpg']), '/m/poster.jpg')
  })

  await check('挑不到就返回空串，让上层去走联网那条路', () => {
    assert.equal(pickSidecarPoster([]), '')
    assert.equal(pickSidecarPoster(['/m/Dune.mkv', '/m/Dune.nfo', '/m/Dune.srt']), '')
    assert.equal(pickSidecarPoster(['/m/banner.jpg']), '', '全被排除时等于没挑到')
    // 大小写不该影响认名字：Windows 上文件名大小写不敏感，用户手里就是各种写法
    assert.equal(pickSidecarPoster(['/m/POSTER.JPG']), '/m/POSTER.JPG')
    assert.equal(pickSidecarPoster(['D:\\影视\\沙丘\\Poster.jpg']), 'D:\\影视\\沙丘\\Poster.jpg')
  })

  /* -------- 渲染进程那一侧 -------- */

  await check('渲染进程和主进程对「是不是本地海报」的判断一字不差', () => {
    // 两份实现刻意各写一份（一边在 Node、一边在浏览器，隔着 contextBridge），
    // 漂了的后果是整墙破图或者整墙占位，而两处都不报错。用同一组用例锁住
    for (const v of [
      'D:\\baoyi\\posters\\v1.jpg',
      'd:/baoyi/posters/v1.jpg',
      '\\\\nas\\share\\v1.jpg',
      '/home/u/.config/baoyi/posters/v1.jpg',
      '/wPRcNZ4Q1Rk.jpg',
      '',
      '   '
    ]) {
      assert.equal(isLocalPosterPath(v), isLocalPoster(v), `两处对 ${JSON.stringify(v)} 的判断不一致`)
    }
  })

  await check('海报地址带完整路径，TMDB 相对路径退回占位', () => {
    // 图住在各自的作品目录里，URL 里编完整路径；能不能读由主进程按白名单判（下一条）
    assert.equal(posterUrl('D:\\baoyi\\posters\\v1.jpg', 7), 'baoyi://poster/?p=D%3A%5Cbaoyi%5Cposters%5Cv1.jpg&v=7')
    // 相对路径连本地文件都算不上，更早一步就退回占位了 —— 比封面那条路多挡一层
    assert.equal(posterUrl('..\\..\\Windows\\System32\\evil.png', 1), '')
    // 刮削阶段落的相对路径拼进协议地址是一张必然 404 的破图，占位比破图诚实
    assert.equal(posterUrl('/wPRcNZ4Q1Rk.jpg', 1), '', 'TMDB 相对路径不该拼成协议地址')
    assert.equal(posterUrl('', 1), '')
    // 路径不变，不带版本号换了图不刷新
    assert.notEqual(posterUrl('D:\\p\\v1.jpg', 1), posterUrl('D:\\p\\v1.jpg', 2))
  })

  await check('海报协议只放行三类路径：缓存目录直属、.baoyi/artwork 里的、库里记着的', () => {
    const cache = 'D:\\profile\\posters'
    const referenced = new Set(['d:\\视频\\沙丘\\poster.jpg'])
    const ctx = { postersDir: cache, isReferenced: (file: string) => referenced.has(file.toLowerCase()) }
    const url = (file: string) => posterUrl(file, 1)
    assert.equal(resolvePosterRequest(url('D:\\profile\\posters\\v1.jpg'), ctx), path.resolve('D:\\profile\\posters\\v1.jpg'), '缓存目录直属文件')
    assert.equal(resolvePosterRequest(url('E:\\视频\\沙丘\\.baoyi\\artwork\\abc.png'), ctx), path.resolve('E:\\视频\\沙丘\\.baoyi\\artwork\\abc.png'), '作品图片目录')
    assert.equal(resolvePosterRequest(url('D:\\视频\\沙丘\\poster.jpg'), ctx), path.resolve('D:\\视频\\沙丘\\poster.jpg'), '库里记着的用户文件')
    // 走不出去：.. 被 resolve 掉之后落在缓存目录外、库里也没记 → 拒
    assert.equal(resolvePosterRequest(url('D:\\profile\\posters\\..\\evil.png'), ctx), '', '.. 不能穿到缓存目录外')
    assert.equal(resolvePosterRequest(url('D:\\profile\\posters\\sub\\v1.jpg'), ctx), '', '缓存目录的子目录不算直属')
    assert.equal(resolvePosterRequest(url('C:\\Windows\\System32\\evil.png'), ctx), '', '任意路径不放行')
    assert.equal(resolvePosterRequest(url('E:\\视频\\沙丘\\.baoyi\\artwork\\evil.exe'), ctx), '', '扩展名不在海报名单里的不放行')
    assert.equal(resolvePosterRequest('baoyi://poster/v1.jpg?v=1', ctx), '', '老格式（只有文件名）不再认')
    assert.equal(resolvePosterRequest('baoyi://cover/?p=D%3A%5Cprofile%5Cposters%5Cv1.jpg', ctx), '', '别的主机名不归它管')
  })

  await check('artworkDirFor：绑定目录 → 文件所在目录 → 兜底缓存', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-artwork-dir-'))
    try {
      const d = new DatabaseSync(':memory:')
      initSchema(d as any, KINDS)
      const mk = (id: string, resourcePath: string) => {
        d.prepare(`INSERT INTO resource (id,kind,created_at,updated_at,path,file_name,name_zh,category,source_dir) VALUES (?,'video',1,1,?,?,?,'其他',?)`).run(id, resourcePath, path.basename(resourcePath), id, path.dirname(resourcePath))
        d.prepare('INSERT INTO video_meta (resource_id) VALUES (?)').run(id)
      }
      const bound = path.join(root, 'bound'); fs.mkdirSync(bound)
      mk('bound', bound)
      d.prepare(`INSERT INTO video_directories (resource_id,bundle_id,root,relative_path,directory_path,metadata_state,created_at,updated_at) VALUES ('bound','b1',?,'bound',?,'complete',1,1)`).run(root, bound)
      assert.equal(artworkDirFor(d as any, 'bound', () => 'CACHE'), path.join(bound, '.baoyi', 'artwork'), '绑定了目录就用它')

      const loose = path.join(root, 'loose', 'movie.mp4'); fs.mkdirSync(path.dirname(loose)); fs.writeFileSync(loose, 'x')
      mk('loose', loose)
      assert.equal(artworkDirFor(d as any, 'loose', () => 'CACHE'), path.join(root, 'loose', '.baoyi', 'artwork'), '没绑定但文件在：文件所在目录')

      mk('episodic', path.join(root, 'gone', 'x.mp4'))
      const epFile = path.join(root, 'eps', 'e1.mp4'); fs.mkdirSync(path.dirname(epFile)); fs.writeFileSync(epFile, 'x')
      d.prepare(`INSERT INTO episode (id,resource_id,season,episode,title,path,file_size,duration_sec,air_date,watch_status,position_sec,watched_at) VALUES ('e1','episodic',0,1,'e1',?,1,0,0,'unwatched',0,0)`).run(epFile)
      assert.equal(artworkDirFor(d as any, 'episodic', () => 'CACHE'), path.join(root, 'eps', '.baoyi', 'artwork'), 'resource.path 没了但单集文件在：单集所在目录')

      mk('linkonly', path.join(root, 'nowhere', 'y.mp4'))
      assert.equal(artworkDirFor(d as any, 'linkonly', () => 'CACHE'), 'CACHE', '什么本地位置都没有：兜底')
      d.close()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  await check('片名兜底到文件名时把扩展名剥掉，剧集的目录名原样留着', () => {
    const v = (over: Record<string, string>) => ({ name_zh: '', name_en: '', file_name: '', ...over })
    assert.equal(videoTitle(v({ name_zh: '沙丘', name_en: 'Dune', file_name: 'a.mkv' })), '沙丘')
    assert.equal(videoTitle(v({ name_en: 'Dune', file_name: 'a.mkv' })), 'Dune')
    assert.equal(videoTitle(v({ file_name: 'Dune.2021.1080p.mkv' })), 'Dune.2021.1080p')
    // 剧集那条记录的 file_name 是目录名，没有扩展名可剥
    assert.equal(videoTitle(v({ file_name: '黑暗荣耀 第一季' })), '黑暗荣耀 第一季')
    // 结尾那截不像扩展名就别动：剥掉「.2021」会让标题看着像少了一半
    assert.equal(videoTitle(v({ file_name: '沙丘.2021' })), '沙丘.2021')
    assert.equal(videoTitle(v({})), '')
  })

  await check('片长 0 显示成「—」，不是「0 分钟」', () => {
    // 0 的含义是「读不出来」（容器元数据缺失、文件已经不在了），不是零分钟
    assert.equal(formatDuration(0), '—')
    assert.equal(formatDuration(-1), '—')
    // 单集按分钟说 —— 42 分钟写成「0.7 小时」没人这么说话
    assert.equal(formatDuration(42 * 60), '42 分钟')
    assert.equal(formatDuration(9300), '2 小时 35 分')
    assert.equal(formatDuration(7200), '2 小时', '整点不该拖一个「0 分」')
  })
}


/* ============== 重扫保住用户改过的字段 · v0.7 Step 6b ============== */

/**
 * `user_edited` 那一层。
 *
 * 这一段要挡住的三类事，每一类都是静默的：
 *
 * 1. **保护没生效** —— 重扫照旧覆盖，用户改的东西无声退回 agent 说的那个值。
 *    他下次打开才发现，而那时已经无从知道是哪一步弄丢的。
 * 2. **保护过头** —— 把整行锁住，或者把本地事实（分辨率、时长）也锁住。
 *    前者让「我纠正了一个字段」变成「这条从此不再更新」；后者更隐蔽：
 *    用户换了 4K 片源，详情页还写着 720p，而那一栏正是他用来分辨版本的。
 * 3. **视图缺列** —— 表里补上了 `user_edited`，视图没跟着重建。
 *    `getVideo` 从视图读，于是每条都是空名单，界面上标记全消失，
 *    重扫照旧覆盖 —— 表现和第 1 类一模一样，但原因在迁移里。
 *
 * 所以这里的正反两面都要验：改过的字段留住，**没改过的字段照旧被刷新**。
 * 只验前一半的话，一个「重扫什么都不写」的实现也能全绿。
 */
export async function videoUserEditedSection(): Promise<void> {
  console.log('\n视频 · 重扫保住用户改过的字段')

  const { DatabaseSync } = await import('node:sqlite')

  const freshDb = (): InstanceType<typeof DatabaseSync> => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }

  const payload = (over: Partial<VideoPayload> = {}): VideoPayload => ({
    path: 'D:\\Movies\\Dune.2024.mkv',
    video_type: 'movie',
    name_zh: '沙丘：第二部分',
    name_en: 'Dune: Part Two',
    summary: '厄崔迪家族的复仇之路',
    description: '',
    category: '欧美',
    tags: ['科幻', '冒险'],
    official_url: '',
    source_dir: 'D:\\Movies',
    file_size: 78_400_000_000,
    year: 2024,
    end_year: 0,
    rating: 8.7,
    duration_sec: 9960,
    resolution: '2160p',
    video_codec: 'HEVC',
    source: 'WEB-DL',
    release_group: '',
    audio_tracks: [],
    subtitle_tracks: [],
    parts: [],
    linked_files: [],
    tmdb_id: '693134',
    imdb_id: 'tt15239678',
    douban_id: '',
    douban_rating: 0,
    poster_path: '',
    fanart_path: '',
    episodes: [],
    ...over
  })

  await check('新条目的名单是空的 —— 还没人改过任何东西', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    assert.deepEqual(getVideo(d as any, id)!.user_edited, [])
    d.close()
  })

  await check('改过的字段进名单，改没改过的不进', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻' })
    assert.deepEqual(getVideo(d as any, id)!.user_edited, ['category'])

    // 多改几个是并进去，不是替换掉
    updateVideo(d as any, id, { name_zh: '沙丘 2', tags: ['科幻'] })
    assert.deepEqual(
      [...getVideo(d as any, id)!.user_edited].sort(),
      ['category', 'name_zh', 'tags']
    )

    // 观看状态和笔记不在保护名单里 —— insertVideo 本来就不写它们
    updateVideo(d as any, id, { watch_status: 'watched', notes: '看过了' })
    assert.ok(
      !getVideo(d as any, id)!.user_edited.includes('watch_status'),
      'watch_status 不该进名单，它不受重扫威胁'
    )
    d.close()
  })

  await check('重扫：改过的字段留住，没改过的照旧被刷新', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻', name_zh: '沙丘 2' })

    // 第二次扫到同一条，刮削给出一整套新值
    insertVideo(
      d as any,
      payload({
        category: '欧美',
        name_zh: '沙丘：第二部分',
        summary: '换了个简介',
        rating: 9.4
      })
    )

    const v = getVideo(d as any, id)!
    assert.equal(v.category, '科幻', '用户改的分类被重扫覆盖了 —— 这一层没生效')
    assert.equal(v.name_zh, '沙丘 2', '用户改的片名被重扫覆盖了')
    // 反面：没改过的字段必须跟着刮削走。少了这两条，
    // 一个「重扫什么都不写」的实现也能通过上面那两条
    assert.equal(v.summary, '换了个简介', '没改过的简介该被刷新')
    assert.equal(v.rating, 9.4, '没改过的评分该被刷新')
    d.close()
  })

  await check('本地事实不受保护：换了片源，分辨率和时长要跟着变', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    // 用户把这几栏也改过一遍（界面允许改）
    updateVideo(d as any, id, { resolution: '720p', duration_sec: 100, video_codec: 'H264' })

    insertVideo(d as any, payload({ resolution: '2160p', duration_sec: 9960, video_codec: 'HEVC' }))

    const v = getVideo(d as any, id)!
    // 这几栏来自 mediainfo 和文件名。锁住的后果是用户换了 4K 片源，
    // 详情页还写着 720p —— 而那一栏正是他用来分辨手上是哪个版本的
    assert.equal(v.resolution, '2160p', '分辨率是从文件读出来的，不该被锁住')
    assert.equal(v.duration_sec, 9960)
    assert.equal(v.video_codec, 'HEVC')
    d.close()
  })

  await check('保护的是字段不是整行', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻' })
    insertVideo(d as any, payload({ category: '欧美', summary: '新简介', year: 2025 }))
    const v = getVideo(d as any, id)!
    assert.equal(v.category, '科幻')
    // 一个布尔标记会把这两条一起锁住，于是「我纠正了一个字段」
    // 变成「这条从此不再更新」
    assert.equal(v.summary, '新简介')
    assert.equal(v.year, 2025)
    d.close()
  })

  await check('撤保护之后重扫又能写了', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻', name_zh: '沙丘 2' })

    // 撤单个：另一个还留着
    restoreScrapedFields(d as any, id, ['category'])
    assert.deepEqual(getVideo(d as any, id)!.user_edited, ['name_zh'])
    // 撤保护本身不改值 —— 刮削原来那个值没存第二份，得等下一次重扫才变。
    // 界面文案因此说「以后听刮削的」，不说「恢复成刮削值」
    assert.equal(getVideo(d as any, id)!.category, '科幻', '撤保护不该当场改值')

    insertVideo(d as any, payload({ category: '欧美', name_zh: '沙丘：第二部分' }))
    const v = getVideo(d as any, id)!
    assert.equal(v.category, '欧美', '撤了保护的字段该重新跟着刮削走')
    assert.equal(v.name_zh, '沙丘 2', '没撤的那个还得留着')
    d.close()
  })

  await check('传空数组 = 全撤', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻', name_zh: '沙丘 2', year: 1984 })
    restoreScrapedFields(d as any, id, [])
    assert.deepEqual(getVideo(d as any, id)!.user_edited, [])
    d.close()
  })

  await check('脏数据不拦住重扫', () => {
    // 手工改库、旧版本残留、JSON 写坏了 —— 这一列坏掉时该退回「没改过」。
    // 反过来（坏数据当成「全改过」）会让整条记录从此不再更新，而没人看得出为什么
    assert.deepEqual(parseUserEdited('not json'), [])
    assert.deepEqual(parseUserEdited('{"a":1}'), [])
    assert.deepEqual(parseUserEdited(''), [])
    assert.deepEqual(parseUserEdited(null), [])
    assert.deepEqual(parseUserEdited(undefined), [])
    assert.deepEqual(parseUserEdited('[1,2,3]'), [])
    // 不认识的字段名要滤掉：留着它就会在界面上显示成一行裸列名，
    // 而且永远撤不掉（用户点「取消保留」传的是这个名字，DB 里删得掉，
    // 但下次又从同一份脏数据里长回来）
    assert.deepEqual(parseUserEdited('["category","bogus_field"]'), ['category'])
  })

  await check('保护名单和界面文案一一对应', () => {
    // 漏一个的表现是那一行显示成裸列名（`douban_rating`）。
    // 兜底逻辑让它不至于消失，但那不是能给用户看的东西
    for (const f of PROTECTED_FIELDS) {
      assert.ok(PROTECTED_FIELD_LABEL[f], `字段 ${f} 没有界面文案`)
    }
    // 反向：文案表里不该有 user_edited 里出不来的键 —— 那种键永远显示不出来，
    // 是维护时的误导（看着支持，其实那个字段根本不受保护）。
    // 名单是 USER_EDITED_FIELDS 而不是 PROTECTED_FIELDS：poster_path 不走 markUserEdited，
    // 但手选封面会直接写进 user_edited，界面同样要有文案（B1）
    for (const f of Object.keys(PROTECTED_FIELD_LABEL)) {
      assert.ok(USER_EDITED_FIELDS.includes(f), `文案表里的 ${f} 不在 user_edited 允许名单里`)
    }
    assert.ok(USER_EDITED_FIELDS.includes('poster_path') && PROTECTED_FIELD_LABEL.poster_path, '手选封面要能在界面上显示为受保护字段')
    assert.equal(new Set(PROTECTED_FIELDS).size, PROTECTED_FIELDS.length, '名单里有重复')
  })

  await check('两张名单不重叠，且都是界面真能改的字段', () => {
    const overlap = PROTECTED_RESOURCE_FIELDS.filter((f) =>
      (PROTECTED_META_FIELDS as readonly string[]).includes(f)
    )
    assert.deepEqual(overlap, [], `同一个字段落在两张表上：${overlap.join(',')}`)
    // 保护一个界面改不了的字段是死代码 —— 它永远进不了名单
    for (const f of PROTECTED_FIELDS) {
      assert.ok(
        VIDEO_RESOURCE_COLUMNS.has(f) || VIDEO_META_COLUMNS.has(f),
        `${f} 受保护，但界面改不了它`
      )
    }
  })

  await check('迁移：老库补上列之后，视图里也要有这一列', () => {
    // 这一条挡的是最隐蔽那类失败：表里有 user_edited、视图里没有。
    // getVideo 从视图读，于是每条都是空名单 —— 界面上标记全没了，
    // 重扫照旧覆盖，而库结构看着是对的
    const d = freshDb()
    // 造出「0.7 开发版装过的库」：列还在，但视图是旧定义
    d.exec('DROP VIEW video')
    d.exec(`
      CREATE VIEW video AS
      SELECT r.id, r.name_zh, r.name_en, r.summary, r.description, r.category, r.tags,
             r.official_url, r.notes, r.is_archived, r.created_at, r.updated_at,
             r.path, r.file_name, r.file_size, r.source_dir, r.ai_status,
             m.video_type, m.poster_path, m.fanart_path, m.year, m.end_year, m.rating,
             m.watch_status, m.position_sec, m.duration_sec, m.last_watched_at,
             m.resolution, m.video_codec, m.source, m.release_group,
             m.audio_tracks, m.subtitle_tracks, m.parts, m.linked_files,
             m.tmdb_id, m.imdb_id, m.douban_id, m.douban_rating,
             0 AS episode_total, 0 AS episode_watched, 0 AS episode_present
      FROM resource r LEFT JOIN video_meta m ON m.resource_id = r.id
      WHERE r.kind = 'video'
    `)
    assert.ok(!columnsOf(d as any, 'video').has('user_edited'), '前置条件：视图确实缺这一列')

    // 再跑一次 initSchema，migrate 该把旧视图撤掉、按新定义重建
    initSchema(d as any, KINDS)
    assert.ok(
      columnsOf(d as any, 'video').has('user_edited'),
      '视图没跟着重建 —— 界面上保护标记会全部消失，而库结构看着是对的'
    )

    // 重建完还得真的能用
    const { id } = insertVideo(d as any, payload())
    updateVideo(d as any, id, { category: '科幻' })
    assert.deepEqual(getVideo(d as any, id)!.user_edited, ['category'])
    d.close()
  })

  await check('回滚 v7 之后这一列跟着 video_meta 一起消失', () => {
    // 这一列刻意放在 video_meta 而不是 resource：rollback-v7 把 video_meta
    // 整张 drop 掉，列自然没了。放在 resource 上的话，退回 0.6 的库里会
    // 留一列谁也不认识的 user_edited
    const d = freshDb()
    assert.ok(columnsOf(d as any, 'video_meta').has('user_edited'))
    assert.ok(
      !columnsOf(d as any, 'resource').has('user_edited'),
      'user_edited 不该在 resource 上 —— 回滚 v7 会把它留成孤儿列'
    )
    d.close()
  })

  await check('user_edited 和 hanime_id 都不靠版本号，闸门是「列在不在」', () => {
    // 这两列的闸门是 columnsOf().has()，不是版本号（见 kinds/video/schema.ts 文件头）。
    // 版本号在 0.8 里推了两次，各自标记一件能回滚的事：
    //   8 = 视频分类多了「里番」一格（rollback-v8 撤这个）
    //   9 = video_meta 多了 hanime_id 列（rollback-v9 撤这个）
    // 一个数字标两件事的话，两个回滚脚本的界限就说不清了。
    // 0.9 抬到 10：拆扫描目录（scan_dirs -> software/game/video_scan_dirs）+ identify_logs.resource_kind 列
    assert.equal(SCHEMA_VERSION, 31, '游戏便签和封面构图加入后的库形状是 31')
  })
}


/* ================= 播放与进度 · v0.7 Step 7 ================= */

/**
 * 两件事：**别家 nfo 的观看状态怎么进来**，和**点播放开哪一集**。
 *
 * 这一段要挡住的：
 *
 * 1. **重扫覆盖用户的进度** —— Step 6b 刚从「刮削字段」那个入口修掉这个错，
 *    nfo 导入是它的第二个入口，而且更隐蔽：用户在抱一里标了看完，
 *    重扫一遍被 Kodi 那份旧 nfo 的 playcount=0 顶回未看。所以
 *    `upsertEpisodes` 的 UPDATE 分支必须一列都不碰这三样。
 * 2. **导入时把「没说」当成「说了没看」** —— nfo 里没有任何观看痕迹时，
 *    写一个显式的 unwatched 和不写在库里是同一个结果，但在代码里是两回事：
 *    前者宣称「那份 nfo 说他没看过」。折算函数必须给 null。
 * 3. **CHECK 约束炸在扫描中途** —— 那三列的值一路来自磁盘上别人写的 xml。
 *    watch_status 有闭集约束，写进去一个没见过的词是整条 INSERT 抛异常，
 *    而它发生在扫描循环里，表现是「扫到某个目录就整趟失败」。
 * 4. **播放挑错集** —— 一部 40 集的剧点播放开了第 1 集，或者开了一集
 *    用户明确标过「不看了」的花絮。
 */
export async function videoPlaybackSection(): Promise<void> {
  console.log('\n视频 · 播放与进度')

  const { DatabaseSync } = await import('node:sqlite')

  const freshDb = (): InstanceType<typeof DatabaseSync> => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }

  const seriesPayload = (episodes: any[]): VideoPayload =>
    ({
      path: 'D:\\TV\\孤独摇滚',
      video_type: 'series',
      name_zh: '孤独摇滚！',
      name_en: 'Bocchi the Rock!',
      summary: '社恐少女组乐队',
      description: '',
      category: '日本',
      tags: [],
      official_url: '',
      source_dir: 'D:\\TV',
      file_size: 0,
      year: 2022,
      end_year: 0,
      rating: 0,
      duration_sec: 1440,
      resolution: '1080p',
      video_codec: 'HEVC',
      source: '',
      release_group: '',
      audio_tracks: [],
      subtitle_tracks: [],
      parts: [],
      linked_files: [],
      tmdb_id: '119100',
      imdb_id: '',
      douban_id: '',
      douban_rating: 0,
      poster_path: '',
      fanart_path: '',
      episodes
    }) as VideoPayload

  const ep = (n: number, over: Record<string, unknown> = {}) => ({
    season: 1,
    episode: n,
    title: `第 ${n} 集`,
    path: `D:\\TV\\孤独摇滚\\S01E${String(n).padStart(2, '0')}.mkv`,
    file_size: 1_400_000_000,
    duration_sec: 1440,
    air_date: 0,
    ...over
  })

  /* -------------------- nfo 折算 -------------------- */

  // 走一趟真解析器拿完整形状，而不是手写一个对象字面量：NfoData 有三十来个
  // 字段，手写的那份将来加字段时不会报错，只会静默少一个键
  const base = parseNfo('<movie><title>底座</title></movie>')!
  const nfo = (over: Partial<NfoData> = {}): NfoData => ({ ...base, ...over })

  await check('nfo 里没有观看痕迹 = null，不是 unwatched', () => {
    // 这个区别决定入库那边「写不写这三列」。给 unwatched 的话，
    // 一份根本没提过观看的 nfo 会宣称「他没看过」
    assert.equal(nfoWatchState(nfo()), null)
    assert.equal(nfoWatchState(null), null, '没有 nfo 也是 null，不该抛')
  })

  await check('playcount > 0 折算成看完', () => {
    const w = nfoWatchState(nfo({ playcount: 2 }))
    assert.equal(w?.watch_status, 'watched')
  })

  await check('只有断点没有播放次数 = 在看', () => {
    const w = nfoWatchState(nfo({ resume_position_sec: 620 }))
    assert.equal(w?.watch_status, 'watching')
    assert.equal(w?.position_sec, 620)
  })

  await check('看完 + 有断点：状态取看完，位置照留', () => {
    // 重看到一半的人两个都有值。库里存不下「看过几遍」，
    // 那就保住信息量更大的那一半，位置不丢
    const w = nfoWatchState(nfo({ playcount: 1, resume_position_sec: 300 }))
    assert.equal(w?.watch_status, 'watched')
    assert.equal(w?.position_sec, 300)
  })

  await check('不做「快到头就算看完」那种换算', () => {
    // Kodi 自己有个 90% 阈值，但那是它的判断而不是它的记录。抄过来等于
    // 我们替用户认定他看完了一部卡在 91% 的片子 —— v0.6 那条教训说的
    // 「猜一个会过期的判断写进库」
    const w = nfoWatchState(nfo({ resume_position_sec: 5340, resume_total_sec: 5400 }))
    assert.equal(w?.watch_status, 'watching', '99% 也只是在看，没有 playcount 就不算看完')
  })

  await check('lastplayed 认得出 Kodi 那个形状，认不出时留 0', () => {
    const ok = nfoWatchState(nfo({ playcount: 1, last_played: '2024-03-05 21:30:00' }))
    assert.ok((ok?.watched_at ?? 0) > 0, 'Kodi 写的是「日期 空格 时间」，得认')
    const bad = nfoWatchState(nfo({ playcount: 1, last_played: '前天晚上' }))
    assert.equal(bad?.watched_at, 0, '认不出来要留 0，不能变成 1970 年跑到排序最前面')
  })

  /* -------------------- 入库：只认第一次 -------------------- */

  await check('新建的集接受 nfo 带来的观看状态', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([
        ep(1, { watch_status: 'watched', position_sec: 0, watched_at: 1_700_000_000_000 }),
        ep(2, { watch_status: 'watching', position_sec: 620 }),
        ep(3)
      ])
    )
    const list = listEpisodes(d as any, id)
    assert.equal(list[0]!.watch_status, 'watched')
    assert.equal(list[1]!.watch_status, 'watching')
    assert.equal(list[1]!.position_sec, 620)
    assert.equal(list[2]!.watch_status, 'unwatched', '没带状态的落到列默认值')
    d.close()
  })

  await check('重扫不覆盖已存在的集的进度 —— 哪怕 nfo 说的不一样', () => {
    // 这是这一段最要紧的一条。用户在抱一里标了看完，而 Kodi 那份 nfo
    // 还写着 playcount=0；重扫时采信 nfo 就是把用户的账清零
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload([ep(1), ep(2)]))
    const first = listEpisodes(d as any, id)
    updateEpisode(d as any, first[0]!.id, { watch_status: 'watched', position_sec: 1400 })

    // 第二趟：nfo 说这一集没看过（playcount 缺失 → 整组不带），
    // 以及说另一集看过了
    insertVideo(
      d as any,
      seriesPayload([
        ep(1, { watch_status: 'unwatched', position_sec: 0 }),
        ep(2, { watch_status: 'watched' })
      ])
    )
    const after = listEpisodes(d as any, id)
    assert.equal(after[0]!.watch_status, 'watched', '用户标的看完被 nfo 顶回去了')
    assert.equal(after[0]!.position_sec, 1400, '播放位置也被顶回去了')
    assert.equal(after[1]!.watch_status, 'unwatched', '已存在的集不接受 nfo 的新状态')
    d.close()
  })

  await check('重扫照旧刷新集的标题和文件事实', () => {
    // 上一条的反面。只验「进度没变」的话，一个「重扫什么都不写」的
    // 实现也能全绿，而那会让改名、换片源在详情页上永远不更新
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload([ep(1, { title: '第 1 集' })]))
    insertVideo(
      d as any,
      seriesPayload([ep(1, { title: '転がるロック', file_size: 2_000_000_000 })])
    )
    const list = listEpisodes(d as any, id)
    assert.equal(list[0]!.title, '転がるロック')
    assert.equal(list[0]!.file_size, 2_000_000_000)
    d.close()
  })

  await check('watch_status 是脏值时落回 unwatched，不让 CHECK 炸在扫描中途', () => {
    // 值一路来自磁盘上别人写的 xml。抛异常的话表现是「扫到某个目录就整趟失败」
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'wathcing' as any }), ep(2, { watch_status: '' as any })])
    )
    const list = listEpisodes(d as any, id)
    assert.equal(list[0]!.watch_status, 'unwatched')
    assert.equal(list[1]!.watch_status, 'unwatched')
    d.close()
  })

  await check('负数和小数的播放位置被夹回整数秒', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watching', position_sec: -5 }), ep(2, { watch_status: 'watching', position_sec: 12.7 })])
    )
    const list = listEpisodes(d as any, id)
    assert.equal(list[0]!.position_sec, 0)
    assert.equal(list[1]!.position_sec, 13)
    d.close()
  })

  await check('导入的集状态会推到剧一级 —— 全看完就是看完', () => {
    // 从别处导进来一整部看完的剧，侧栏那一格该是「看完」而不是「想看」
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watched' }), ep(2, { watch_status: 'watched' })])
    )
    assert.equal(getVideo(d as any, id)!.watch_status, 'watched')
    d.close()
  })

  await check('电影的观看状态落在 video_meta 上，也只认第一次', () => {
    const d = freshDb()
    const movie = (over: Record<string, unknown>): VideoPayload =>
      ({
        ...seriesPayload([]),
        path: 'D:\\Movies\\Dune.mkv',
        video_type: 'movie',
        ...over
      }) as VideoPayload

    const { id } = insertVideo(d as any, movie({ watch_status: 'watched', position_sec: 300, last_watched_at: 1_700_000_000_000 }))
    assert.equal(getVideo(d as any, id)!.watch_status, 'watched')
    assert.equal(getVideo(d as any, id)!.position_sec, 300)

    // 用户改成「弃」，重扫一遍不该被 nfo 顶回 watched
    updateVideo(d as any, id, { watch_status: 'dropped' })
    insertVideo(d as any, movie({ watch_status: 'watched', position_sec: 999 }))
    assert.equal(getVideo(d as any, id)!.watch_status, 'dropped', '重扫顶掉了用户的判断')
    assert.equal(getVideo(d as any, id)!.position_sec, 300, '播放位置也被顶掉了')
    d.close()
  })

  await check('剧集不接受 payload 上的 watch_status —— 那一级是推出来的', () => {
    // 硬写会被下一次 syncSeriesStatus 推翻，留着只会让人以为它有用
    const d = freshDb()
    const p = seriesPayload([ep(1)])
    ;(p as any).watch_status = 'watched'
    const { id } = insertVideo(d as any, p)
    assert.equal(getVideo(d as any, id)!.watch_status, 'unwatched')
    d.close()
  })

  /* -------------------- 点播放开哪一集 -------------------- */

  await check('有断点的那一集优先', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([
        ep(1, { watch_status: 'watched' }),
        ep(2, { watch_status: 'watching', position_sec: 620 }),
        ep(3)
      ])
    )
    assert.equal(resumeEpisode(d as any, id)!.episode, 2)
    d.close()
  })

  await check('没有断点时开第一集没看完的', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watched' }), ep(2, { watch_status: 'watched' }), ep(3), ep(4)])
    )
    assert.equal(resumeEpisode(d as any, id)!.episode, 3)
    d.close()
  })

  await check('标过「不看了」的集被跳过', () => {
    // 跳过的花絮特别篇常被这么标。跳到它上面是把用户刚做的判断当没看见
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watched' }), ep(2, { watch_status: 'dropped' }), ep(3)])
    )
    assert.equal(resumeEpisode(d as any, id)!.episode, 3)
    d.close()
  })

  await check('全看完了开第一集 —— 重看的人从头开始', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watched' }), ep(2, { watch_status: 'watched' })])
    )
    assert.equal(resumeEpisode(d as any, id)!.episode, 1, '「没得播」比开第一集难用')
    d.close()
  })

  await check('缺文件的集不会被挑中', () => {
    // 播放器打不开一个不存在的文件。挑中它的表现是「点了播放，弹一句文件不在」
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([ep(1, { watch_status: 'watched' }), ep(2, { path: '' }), ep(3)])
    )
    assert.equal(resumeEpisode(d as any, id)!.episode, 3)
    d.close()
  })

  await check('一集文件都没有时给 null，不是抛', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload([ep(1, { path: '' }), ep(2, { path: '' })]))
    assert.equal(resumeEpisode(d as any, id), null)
    d.close()
  })

  await check('跨季接着看', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload([
        ep(1, { watch_status: 'watched' }),
        { ...ep(1), season: 2, episode: 1, path: 'D:\\TV\\孤独摇滚\\S02E01.mkv' }
      ])
    )
    const target = resumeEpisode(d as any, id)!
    assert.equal(target.season, 2)
    assert.equal(target.episode, 1)
    d.close()
  })
}


/* ================= 里番分类迁移 · v0.8 Step 2 ================= */

/**
 * 守的是 v0.8-计划.md 第三节那个坑：`seedCategories` 是兜底不是同步，
 * 往 VIDEO_CATEGORIES 里加一条对**老库无效**，而失效链条一声不吭
 * （分类不在表里 → 工具的 enum 里没有 → 模型没法归类 → 侧栏那格永不出现）。
 *
 * 这一节全部用 node:sqlite 驱动 electron/services/schema.ts 本身，
 * 和应用启动时跑的是同一份代码。
 */
export async function hentaiCategorySection(): Promise<void> {
  console.log('\n里番分类迁移 · v0.8 Step 2')

  const { DatabaseSync } = await import('node:sqlite')

  /** 造一个「装过 0.7 的老库」：七条视频分类，其他排在 7，版本号 7 */
  const oldDb = (): InstanceType<typeof DatabaseSync> => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    // 从 0.8 的形状退回 0.7 的形状 —— 比手搭一份 0.7 的建表 SQL 可靠，
    // 那份 SQL 会和真实历史悄悄漂移
    d.exec(`DELETE FROM categories WHERE id = '${HENTAI_CATEGORY_ID}'`)
    d.exec(`UPDATE categories SET sort_order = 7 WHERE id = 'video-other'`)
    d.exec(`UPDATE settings SET value = '7' WHERE key = '_schema'`)
    return d
  }

  const cats = (d: InstanceType<typeof DatabaseSync>): Record<string, any>[] =>
    d
      .prepare(`SELECT id, name, description, icon, sort_order FROM categories WHERE kind = 'video'`)
      .all() as Record<string, any>[]
  const byId = (d: InstanceType<typeof DatabaseSync>, id: string): Record<string, any> | undefined =>
    cats(d).find((c) => c.id === id)

  await check('老库升上来之后里番在表里，且「其他」排在最后', () => {
    const d = oldDb()
    assert.equal(byId(d, HENTAI_CATEGORY_ID), undefined, '前置条件：老库里确实没有它')

    initSchema(d as any, KINDS)

    const h = byId(d, HENTAI_CATEGORY_ID)
    assert.ok(h, '里番没进老库 —— 侧栏那格永远不会出现，而且不报任何错')
    assert.equal(h!.name, HENTAI_CATEGORY)
    const other = byId(d, 'video-other')!
    assert.ok(
      other.sort_order > h!.sort_order,
      `兜底那格该排在里番后面，实际 其他=${other.sort_order} 里番=${h!.sort_order}`
    )
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION, '版本号该跟着推上去')
    d.close()
  })

  await check('全新安装和迁移长出同一个库', () => {
    // 两条路各装一遍分类（seedCategories / migrateHentaiCategory），
    // 结果不一致的话，用户升级上来看到的和干净装出来的是两个应用
    const fresh = new DatabaseSync(':memory:')
    fresh.exec('PRAGMA foreign_keys = ON')
    initSchema(fresh as any, KINDS)

    const migrated = oldDb()
    initSchema(migrated as any, KINDS)

    const key = (rows: Record<string, any>[]): string =>
      JSON.stringify(rows.slice().sort((a, b) => a.sort_order - b.sort_order))
    assert.equal(key(cats(migrated)), key(cats(fresh)), '两条路长出两种库')
    assert.equal(cats(fresh).length, VIDEO_CATEGORIES.length)
    fresh.close()
    migrated.close()
  })

  await check('迁移幂等：连跑两次不会插重、不会把排序推到 9', () => {
    const d = oldDb()
    initSchema(d as any, KINDS)
    const after1 = cats(d)
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    assert.deepEqual(cats(d), after1, '再启动两次，分类表就该纹丝不动')
    d.close()
  })

  await check('用户改过的分类行不被覆盖', () => {
    // 迁移只插新行、只按 id 和旧值条件改 sort_order。
    // 用 INSERT OR REPLACE 顺手「同步一下」的话，这里的「杂项」会变回「其他」——
    // 那是替用户撤销一次决定
    const d = oldDb()
    d.exec(`UPDATE categories SET name = '杂项', icon = 'box' WHERE id = 'video-other'`)

    initSchema(d as any, KINDS)

    const other = byId(d, 'video-other')!
    assert.equal(other.name, '杂项', '用户改的名字被出厂值覆盖了')
    assert.equal(other.icon, 'box')
    assert.equal(other.sort_order, 8, '名字保住的同时，排序还是要挪')
    d.close()
  })

  await check('用户删掉了「其他」时不炸，也不无中生有把它插回来', () => {
    const d = oldDb()
    d.exec(`DELETE FROM categories WHERE id = 'video-other'`)

    initSchema(d as any, KINDS)

    assert.equal(byId(d, 'video-other'), undefined, '删掉的分类不该自己长回来')
    assert.ok(byId(d, HENTAI_CATEGORY_ID), '里番照样要进去')
    d.close()
  })

  await check('视频分类被全删光的库交给 seedCategories 兜底，迁移不重复插', () => {
    const d = oldDb()
    d.exec(`DELETE FROM categories WHERE kind = 'video'`)

    initSchema(d as any, KINDS)

    assert.equal(cats(d).length, VIDEO_CATEGORIES.length, '兜底该把八条一次装齐')
    assert.equal(
      cats(d).filter((c) => c.id === HENTAI_CATEGORY_ID).length,
      1,
      '两条路都插了一遍 —— 里番出现了两次'
    )
    d.close()
  })

  await check('hanime_id：新库建表就有，视图里也读得到', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.ok(columnsOf(d as any, 'video_meta').has('hanime_id'))
    assert.ok(columnsOf(d as any, 'video').has('hanime_id'), '视图里没有它，getVideo 就读不到')
    d.close()
  })

  await check('hanime_id：老库补上列之后，视图必须跟着重建', () => {
    // 这一条挡的和 user_edited 那条同源，但它挡的是**第二次**踩：
    // 0.8 中途装过的库视图里有 user_edited、没有 hanime_id。
    // 那道闸门原先只判 user_edited，于是这种库不会重建视图 ——
    // 而 getVideo 从视图读，每条 hanime_id 都是 undefined，
    // 详情页那个链接永远不出现，重刮也永远走不了精确查询。且不报错
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)

    // 造出「0.8 中途那种库」：表里有列，视图是少一列的旧定义
    d.exec('DROP VIEW video')
    d.exec(`
      CREATE VIEW video AS
      SELECT r.id, r.created_at, r.updated_at, r.path, r.file_name, r.file_size,
             r.source_dir, r.name_zh, r.name_en, r.summary, r.description,
             r.category, r.tags, r.official_url, r.ai_status, r.notes, r.is_archived,
             m.video_type, m.poster_path, m.fanart_path, m.year, m.end_year, m.rating,
             m.watch_status, m.position_sec, m.duration_sec, m.last_watched_at,
             m.resolution, m.video_codec, m.source, m.release_group,
             m.audio_tracks, m.subtitle_tracks, m.parts, m.linked_files,
             m.tmdb_id, m.imdb_id, m.douban_id, m.douban_rating, m.user_edited,
             0 AS episode_total, 0 AS episode_watched, 0 AS episode_present
      FROM resource r LEFT JOIN video_meta m ON m.resource_id = r.id
      WHERE r.kind = 'video'
    `)
    assert.ok(columnsOf(d as any, 'video').has('user_edited'), '前置条件：旧视图有 user_edited')
    assert.ok(!columnsOf(d as any, 'video').has('hanime_id'), '前置条件：旧视图缺 hanime_id')

    initSchema(d as any, KINDS)
    assert.ok(
      columnsOf(d as any, 'video').has('hanime_id'),
      '视图没重建 —— hanime_id 读出来会是 undefined，而库结构看着是对的'
    )
    d.close()
  })

  await check('hanime_id：存得住读得回，且受重扫保护', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const { id } = insertVideo(d as any, {
      path: 'D:\\H\\巨乳女教師 第1話_1080P.mkv',
      video_type: 'movie',
      name_zh: '巨乳女教師',
      name_en: '',
      summary: 'x',
      description: '',
      category: HENTAI_CATEGORY,
      tags: [],
      official_url: '',
      source_dir: 'D:\\H',
      file_size: 1,
      year: 0,
      end_year: 0,
      rating: 0,
      duration_sec: 0,
      resolution: '1080p',
      video_codec: '',
      source: '',
      release_group: '',
      audio_tracks: [],
      subtitle_tracks: [],
      parts: [],
      linked_files: [],
      tmdb_id: '',
      imdb_id: '',
      douban_id: '',
      douban_rating: 0,
      hanime_id: '86994',
      poster_path: '',
      fanart_path: '',
      watch_status: 'unwatched',
      episodes: []
    } as any)
    assert.equal(getVideo(d as any, id)!.hanime_id, '86994')

    // 在保护名单里：用户改了它是在说「你匹配错作品了」，
    // 不保护的话下次重扫按错的 id 又把整条刮一遍
    assert.ok(PROTECTED_META_FIELDS.includes('hanime_id' as any))
    d.close()
  })

  await check('软件和游戏的分类没被碰到', () => {
    // 迁移的 WHERE 里带着 kind = 'video'。漏掉它的话，软件那边也有一条
    // 「其他」，它的 sort_order 会跟着被挪走
    const d = oldDb()
    const before = d
      .prepare(`SELECT id, name, sort_order FROM categories WHERE kind != 'video' ORDER BY id`)
      .all()

    initSchema(d as any, KINDS)

    const after = d
      .prepare(`SELECT id, name, sort_order FROM categories WHERE kind != 'video' ORDER BY id`)
      .all()
    assert.deepEqual(after, before, '迁移越界改到隔壁品类了')
    d.close()
  })
}


/* ================= 里番文件名解析 · v0.8 Step 3 ================= */

/**
 * 守的是 v0.8-计划.md 第四节那张实测表：共用解析器认得清晰度和 `第N話`/`EPN`，
 * 不认 `＃N` / `#N` / `ROUND N`，而且失败是连锁的 ——
 * 集号没认出来，标题的切割点就往后跑，`[中文字幕]` 被当成标题吃进去。
 */
export async function hentaiFilenameSection(): Promise<void> {
  console.log('\n里番文件名解析 · v0.8 Step 3')

  const p = parseHentaiName

  /* -------- 用户给的两个真样本，逐字段断言 -------- */

  await check('真样本一：＃2 + 方括号 + 清晰度，四项都要对', () => {
    const r = p('OVAピュアピュア ぺろぺろ プリンセス ＃2 [中文字幕]_720P')
    // OVA 贴在片名前面没有空格，站上的标题就叫这个，别拆走
    assert.equal(r.title_zh, 'OVAピュアピュア ぺろぺろ プリンセス')
    assert.equal(r.title_en, '', '集号不该漏进 title_en')
    assert.equal(r.absolute_episode, 2)
    assert.equal(r.resolution, '720p')
    assert.deepEqual(r.site_tags, ['中文字幕', '720p'])
  })

  await check('真样本二：ROUND1 认得出来，全角！留在片名里', () => {
    const r = p('寝取られファイター ヤリっちんぐ！ ROUND1 [中文字幕]_720P')
    assert.equal(r.title_zh, '寝取られファイター ヤリっちんぐ！')
    assert.equal(r.title_en, '')
    assert.equal(r.absolute_episode, 1)
    assert.equal(r.resolution, '720p')
    assert.deepEqual(r.site_tags, ['中文字幕', '720p'])
  })

  /* -------- 六个集号模式 -------- */

  await check('＃2（全角井号）', () => assert.equal(p('作品 ＃2 _720P').absolute_episode, 2))
  await check('#12（半角井号）', () => assert.equal(p('ものすごい #12 _480P').absolute_episode, 12))
  await check('＃１２（全角井号 + 全角数字）', () =>
    assert.equal(p('作品 ＃１２ _720P').absolute_episode, 12))
  await check('ROUND1（紧挨着）', () => assert.equal(p('作品 ROUND1 _720P').absolute_episode, 1))
  await check('ROUND 1（带空格）', () => assert.equal(p('作品 ROUND 1 _720P').absolute_episode, 1))
  await check('ROUND　3（全角空格）', () =>
    assert.equal(p('作品 ROUND　3 _720P').absolute_episode, 3))
  await check('第3話（日文話）', () => assert.equal(p('巨乳女教師 第3話 _1080P').absolute_episode, 3))
  await check('第3话（简体话）', () => assert.equal(p('巨乳女教師 第3话 _1080P').absolute_episode, 3))
  await check('EP5 / ep5 大小写都认', () => {
    assert.equal(p('なにわ EP5 _720P').absolute_episode, 5)
    assert.equal(p('なにわ ep5 _720P').absolute_episode, 5)
  })

  await check('集号一律落在 absolute_episode，不占季也不占 episodes', () => {
    // 站上「ROUND1」「＃2」是作品内的序号，不挂在任何一季下面。
    // 硬填 season=1 会和将来真有分季的作品撞车
    const r = p('作品 ROUND1 _720P')
    assert.equal(r.season, null)
    assert.deepEqual(r.episodes, [])
    assert.equal(r.full_season, false)
    assert.equal(r.looks_like_series, true)
  })

  await check('认不出集号时 looks_like_series 是 false', () => {
    const r = p('作品名だけ_1080P')
    assert.equal(r.absolute_episode, null)
    assert.equal(r.looks_like_series, false)
  })

  /* -------- 剥标记 -------- */

  await check('多个方括号连排，顺序按文件名上的先后', () => {
    const r = p('なにわ EP5 [中文字幕][无修正]_720P')
    assert.equal(r.title_zh, 'なにわ')
    assert.deepEqual(r.site_tags, ['中文字幕', '無碼', '720p'])
  })

  await check('只有清晰度没有集号', () => {
    const r = p('作品名だけ_1080P')
    assert.equal(r.title_zh, '作品名だけ')
    assert.equal(r.resolution, '1080p')
    assert.deepEqual(r.site_tags, ['1080p'])
  })

  await check('只有集号没有清晰度', () => {
    const r = p('マニアック ROUND 3')
    assert.equal(r.title_zh, 'マニアック')
    assert.equal(r.absolute_episode, 3)
    assert.equal(r.resolution, '')
    assert.deepEqual(r.site_tags, [])
  })

  await check('四档清晰度都认，240p 共用解析器不认也要补上', () => {
    for (const q of ['240', '480', '720', '1080']) {
      const r = p(`作品 ＃1 _${q}P`)
      assert.equal(r.resolution, `${q}p`, `${q}P 没认出来`)
      assert.ok(r.site_tags.includes(`${q}p`), `${q}p 没进标签`)
    }
  })

  await check('扩展名剥掉，不影响集号和标记', () => {
    const r = p('なにわ ep5 [AI解碼]_720P.mp4')
    assert.equal(r.title_zh, 'なにわ')
    assert.equal(r.absolute_episode, 5)
    assert.deepEqual(r.site_tags, ['AI解碼', '720p'])
  })

  /* -------- 别名表 -------- */

  await check('别名表：无修正 / 無修正 / 無碼 / uncensored 归到同一个 key', () => {
    // 文件名里常见简体「无修正」，站方 key 是繁体「無碼」—— 靠字面相等对不上
    for (const w of ['无修正', '無修正', '无码', '無碼', 'uncensored', 'UNCENSORED']) {
      assert.equal(normalizeTag(w), '無碼', `${w} 没归到「無碼」`)
    }
  })

  await check('别名表对不上的原样留着，不硬归到某个站方 key', () => {
    // 归错了之后，用户在界面上看到的是一个他没写过、也不知道打哪儿来的词
    assert.equal(normalizeTag('第二部'), '第二部')
    assert.deepEqual(p('作品 ＃1 [某个没见过的词]_720P').site_tags, ['某个没见过的词', '720p'])
  })

  /* -------- 不该被当成集号的东西 -------- */

  await check('标题里本来就带数字，不当集号', () => {
    // 光秃秃一个数字没有标记，`巨乳女教師2` 不该被拆成「巨乳女教師」第 2 集
    const r = p('巨乳女教師2 [中文字幕]_1080P')
    assert.equal(r.absolute_episode, null)
    assert.equal(r.title_zh, '巨乳女教師2')
  })

  await check('全角数字属于片名时原样留着，不被抹成半角', () => {
    // 全角只在匹配集号的时候抹平。抹进片名里，刮削搜索就和站上的标题对不上了
    const r = p('巨乳女教師２ [中文字幕]_1080P')
    assert.equal(r.title_zh, '巨乳女教師２')
    assert.equal(r.absolute_episode, null)
  })

  await check('标题里带 # 但后面不是数字，不当集号', () => {
    const r = p('C#入門 [中文字幕]')
    assert.equal(r.absolute_episode, null)
    assert.equal(r.title_zh, 'C#入門')
  })

  await check('多处命中时取最靠后的那个，不留半截在标题里', () => {
    // 片名里本来就有 `ROUND 1` 的时候，按模式表的顺序挑会切错地方，
    // 剩下的 `＃12` 会漏进 title_en —— 看着像解析器在乱码
    const r = p('ROUND 1 テスト ＃１２ _240P')
    assert.equal(r.absolute_episode, 12)
    assert.ok(!`${r.title_zh}${r.title_en}`.includes('12'), '切剩的集号漏进标题了')
  })

  /* -------- is_special -------- */

  await check('is_special 一律 false，含计划里推测会误判的那个写法', () => {
    // 注意：这是护栏不是在修一个观察到的错。v0.8-计划.md 原先推测
    // `ピュアピュア OVA ＃2` 会被共用规则判成特别篇，实测四种写法全是 false
    //（共用解析器只在真有季集标记时才跑上游的 parseSeason），计划里那句已更正。
    // 钉死它是因为这条路径不该依赖那个巧合 —— 上游哪天覆盖面变宽，
    // 一整批里番会悄悄挪到第 0 季去，在库里和正片分家
    for (const n of [
      'ピュアピュア OVA ＃2 [中文字幕]_720P',
      'OVAピュアピュア ぺろぺろ プリンセス ＃2 [中文字幕]_720P',
      'ピュアピュア OVA 第3話 _720P',
      'Pure Pure OVA EP5'
    ]) {
      assert.equal(p(n).is_special, false, `${n} 被判成特别篇了`)
    }
  })

  await check('共用解析器在这个写法上确实还没判特别篇 —— 变了要知道', () => {
    // 上面那条把 is_special 钉死了，于是它挡不住上游行为变化。
    // 这一条盯的是上游本身：哪天它开始认 OVA，这里会先红，
    // 而不是等到用户发现半个片库挪进了第 0 季
    assert.equal(parseVideoName('ピュアピュア OVA ＃2 [中文字幕]_720P').is_special, false)
    assert.equal(parseVideoName('ピュアピュア OVA S01E02').is_special, false)
  })

  await check('技术事实仍旧交给共用解析器，没有第二张正则表', () => {
    const r = p('作品 ＃1 [中文字幕] 1080p.WEB-DL.x265-ABC.mkv')
    assert.equal(r.resolution, '1080p')
    assert.equal(r.source, 'WEBDL')
    assert.equal(r.video_codec, 'x265')
  })

  await check('空串和纯扩展名不炸', () => {
    for (const n of ['', '.mkv', '   ']) {
      const r = p(n)
      assert.equal(r.absolute_episode, null)
      assert.deepEqual(r.site_tags, [])
    }
  })
}


/* ================= hanime 刮削通道 · v0.8 Step 4/5 ================= */

/**
 * URL 拼装、videoCode 提取、HTML 解析、标签清洗 —— 全是纯逻辑，不联网。
 *
 * ## fixture 的来源，以及它的**局限**
 *
 * 下面这些 HTML 是**按 doc/hanime-api-notes.md 第三、四节记的 DOM 结构搭的**，
 * 那一节的选择器抄自 Han1meViewer 的 `Parser.kt`。它们**不是从真实页面抓下来的**
 * —— 计划里 Step 1 那个「抓一份真实 HTML 验证选择器还有效」的验证项还没做。
 *
 * 所以这一节能证明的是「解析器按我们理解的结构工作，且畸形输入不炸」，
 * 证明不了「我们理解的结构和 2026 年的 hanime1.me 一致」。后者只能拿真页面验，
 * 而那要联网。这个区别写在这儿，免得后面有人把绿灯当成「通道已经通了」。
 */
export async function hanimeChannelSection(): Promise<void> {
  console.log('\nhanime 刮削通道 · v0.8 Step 4/5（纯逻辑，未联网验证）')

  /* -------------------- URL 拼装 -------------------- */

  await check('搜索 URL：query 转义、genre 锁繁体「裏番」', () => {
    const u = new URL(searchUrl('寝取られファイター ヤリっちんぐ！'))
    assert.equal(u.origin + u.pathname, 'https://hanime1.me/search')
    assert.equal(u.searchParams.get('query'), '寝取られファイター ヤリっちんぐ！')
    // 简体「里番」在站方 genre.json 里搜不到 —— 两个字不同形
    assert.equal(u.searchParams.get('genre'), '裏番')
    assert.ok(u.href.includes('%'), '非 ASCII 该被转义')
  })

  await check('搜索 URL：页码 1 不写进去，多个 tags[] 是重复参数', () => {
    assert.ok(!searchUrl('x').includes('page='), '第一页不该带 page 参数')
    assert.ok(searchUrl('x', { page: 3 }).includes('page=3'))
    const u = new URL(searchUrl('x', { tags: ['巨乳', '無碼'] }))
    assert.deepEqual(u.searchParams.getAll('tags[]'), ['巨乳', '無碼'])
  })

  await check('详情 URL：拼得出来，空 code 给空串', () => {
    assert.equal(watchUrl('12345'), 'https://hanime1.me/watch?v=12345')
    assert.equal(watchUrl(''), '')
    assert.equal(watchUrl('   '), '')
  })

  await check('镜像域名可以换 base', () => {
    assert.equal(watchUrl('7', 'https://javchu.com/'), 'https://javchu.com/watch?v=7')
  })

  /* -------------------- toVideoCode -------------------- */

  await check('toVideoCode：绝对 / 相对 / 四个镜像 / v= 前有别的参数', () => {
    assert.equal(toVideoCode('https://hanime1.me/watch?v=12345'), '12345')
    assert.equal(toVideoCode('/watch?v=678'), '678')
    assert.equal(toVideoCode('watch?v=678'), '678')
    for (const h of ['hanime1.me', 'hanime1.com', 'hanimeone.me', 'javchu.com']) {
      assert.equal(toVideoCode(`https://${h}/watch?v=99`), '99', `${h} 没认出来`)
    }
    // v= 前面允许夹别的查询参数（上游那条正则也管这个）
    assert.equal(toVideoCode('https://hanime1.me/watch?ref=home&v=42'), '42')
    assert.equal(toVideoCode('https://www.hanime1.me/watch?v=42'), '42', 'www. 前缀该被剥掉')
  })

  await check('toVideoCode：认不出来返回空串，不抛', () => {
    for (const bad of [
      '',
      null,
      undefined,
      '/search?query=x',
      'https://example.com/watch?v=1', // 不在镜像白名单里
      'https://hanime1.me/watch?v=abc', // 不是纯数字
      'https://hanime1.me/watch', // 没有 v=
      '一段没有链接的文本'
    ]) {
      assert.equal(toVideoCode(bad as any), '', `${String(bad)} 该解不出来`)
    }
  })

  await check('toVideoCode：从一段带引号和空白的 data-href 里也捞得出来', () => {
    assert.equal(toVideoCode('  "/watch?v=555"  '), '555')
  })

  /* -------------------- 标签清洗 -------------------- */

  await check('标签清洗：去掉 # 前缀和 (计数)', () => {
    // 页面上是 `#巨乳 (1234)`，而那个计数每天都在变 ——
    // 不洗的话同一个标签会因为数字不同反复入池
    assert.equal(cleanTag('#巨乳 (1234)'), '巨乳')
    assert.equal(cleanTag('巨乳'), '巨乳')
    assert.equal(cleanTag('#無碼'), '無碼')
    assert.equal(cleanTag('  #女教師 (12)  '), '女教師')
    assert.equal(cleanTag(''), '')
    assert.equal(cleanTag(null), '')
  })

  await check('时长：mm:ss 和 h:mm:ss 都认，认不出给 0', () => {
    assert.equal(durationSec('12:34'), 754)
    assert.equal(durationSec('1:02:03'), 3723)
    assert.equal(durationSec('00:59'), 59)
    for (const bad of ['', '—', 'abc', '1:2:3:4', null]) {
      assert.equal(durationSec(bad as any), 0, `${String(bad)} 该给 0`)
    }
  })

  /* -------------------- 搜索结果解析 -------------------- */

  // 正常版式，照 doc/hanime-api-notes.md 第四节的结构搭
  const searchHtml = `
<div class="content-padding-new">
  <div class="search-doujin-videos">
    <a class="overlay" href="/watch?v=12345"></a>
    <div class="card-mobile-panel">
      <img src="/uploads/cover-12345.jpg">
      <div class="card-mobile-title">巨乳女教師 ＃1</div>
      <div class="thumb-container"><div class="duration">17:28</div></div>
    </div>
  </div>
  <div class="search-doujin-videos">
    <a class="overlay" href="https://hanime1.me/watch?v=67890"></a>
    <div class="card-mobile-panel">
      <img src="https://cdn.hanime1.me/cover-67890.jpg">
      <div class="card-mobile-title">寝取られファイター ROUND1</div>
      <div class="thumb-container"><div class="duration">1:05:00</div></div>
    </div>
  </div>
  <div class="search-doujin-videos">
    <a class="overlay" href="/search?query=x"></a>
    <div class="card-mobile-title">这一项不是作品，没有 watch 链接</div>
  </div>
</div>`

  await check('搜索结果：逐条解出 code / 标题 / 封面 / 时长', () => {
    const hits = parseSearch(searchHtml)
    assert.equal(hits.length, 2, `解出 ${hits.length} 条，非作品那条该被丢掉`)
    assert.deepEqual(hits[0], {
      videoCode: '12345',
      title: '巨乳女教師 ＃1',
      coverUrl: 'https://hanime1.me/uploads/cover-12345.jpg',
      durationSec: 1048
    })
    assert.equal(hits[1].videoCode, '67890')
    assert.equal(hits[1].durationSec, 3900)
  })

  await check('搜索结果：相对封面拼绝对，已经绝对的原样留着', () => {
    const hits = parseSearch(searchHtml)
    assert.ok(hits[0].coverUrl.startsWith('https://hanime1.me/'), '相对路径没拼上 base')
    assert.equal(hits[1].coverUrl, 'https://cdn.hanime1.me/cover-67890.jpg', 'CDN 绝对地址被改写了')
  })

  await check('搜索结果：同一个 videoCode 只留一条', () => {
    const dup = `<div class="content-padding-new">
      <div class="search-doujin-videos"><a href="/watch?v=1"></a><div class="card-mobile-title">A</div></div>
      <div class="search-doujin-videos"><a href="/watch?v=1"></a><div class="card-mobile-title">A 重复</div></div>
    </div>`
    assert.equal(parseSearch(dup).length, 1)
  })

  await check('搜索结果：简化版式也认', () => {
    const simplified = `<div class="home-rows-videos-wrapper">
      <a class="home-rows-videos-div" href="/watch?v=321">
        <img src="/c.jpg"><div class="home-rows-videos-title">简化版式的标题</div>
      </a>
    </div>`
    const hits = parseSearch(simplified)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].videoCode, '321')
    assert.equal(hits[0].title, '简化版式的标题')
  })

  await check('搜索结果：当前 Hanime 外层 a + 内层 card 结构也认', () => {
    const current = `<div class="home-rows-videos-wrapper">
      <a href="https://hanime1.me/watch?v=87022">
        <div class="home-rows-videos-div search-videos">
          <div class="video-card-inner"><img src="https://vdownload.hembed.com/image/cover/x.jpg">
            <div class="home-rows-videos-title">妻NTR・凌辱輪迴 4</div>
          </div>
        </div>
      </a>
    </div>`
    const hits = parseSearch(current)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].videoCode, '87022')
    assert.equal(hits[0].title, '妻NTR・凌辱輪迴 4')
  })

  await check('搜索结果：改版 / 空页 / 垃圾输入一律空数组，不抛', () => {
    // 站方改版时正确的行为是「这次刮不到」，不是让整次识别炸掉
    for (const bad of ['', '<html><body>盾的挑战页</body></html>', '不是 HTML', '<div class="x"></div>']) {
      assert.deepEqual(parseSearch(bad), [], `${bad.slice(0, 20)} 该给空数组`)
    }
  })

  /* -------------------- 详情页解析 -------------------- */

  const detailHtml = `
<html><head>
  <meta property="og:image" content="/uploads/big-cover.jpg">
  <meta property="og:url" content="https://hanime1.me/watch?v=12345">
</head><body>
  <div id="shareBtn-title">巨乳女教師 ＃1</div>
  <div class="video-details-wrapper">
    <h4 class="video-details-title">巨乳女教师 第一集</h4>
    <div class="video-caption-text caption-ellipsis">这里是简介正文。<span>剧集列表</span></div>
  </div>
  <div class="meta-author"><a href="/search?brands[]=某厂牌">某厂牌</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=巨乳">#巨乳 (1234)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=女教師">#女教師 (567)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=無碼">#無碼</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=巨乳">#巨乳 (1234)</a></div>
  <div class="video-playlist-wrapper">
    <div id="playlist-top-block"><h4><a href="/search?query=巨乳女教師">巨乳女教師 系列</a></h4></div>
    <div id="playlist-scroll">
      <div class="playlist-hover-wrap" data-href="/watch?v=12345">
        <img class="main-thumb" src="/e1.jpg">
        <h4 class="video-title"><a href="/watch?v=12345">＃1</a></h4>
        <div class="duration">17:28</div>
      </div>
      <div class="playlist-hover-wrap" data-href="/watch?v=12346">
        <img class="main-thumb" src="/e2.jpg">
        <h4 class="video-title"><a href="/watch?v=12346">＃2</a></h4>
        <div class="duration">18:02</div>
      </div>
    </div>
  </div>
</body></html>`

  await check('详情页：标题 / 中文名 / 简介 / 封面 / 厂牌', () => {
    const d = parseDetail(detailHtml)
    assert.equal(d.videoCode, '12345')
    assert.equal(d.title, '巨乳女教師 ＃1')
    // 中文名在简介节点**前面**那个兄弟节点上
    assert.equal(d.chineseTitle, '巨乳女教师 第一集')
    assert.equal(d.coverUrl, 'https://hanime1.me/uploads/big-cover.jpg')
    assert.equal(d.artist, '某厂牌')
  })

  await check('详情页：简介用 ownText，不吃子节点的文本', () => {
    // 那个节点底下有个 <span>剧集列表</span>，用 .text 会把它一起吃进来 ——
    // 于是简介末尾多出三个字，而它看着像是简介的一部分
    const d = parseDetail(detailHtml)
    assert.equal(d.introduction, '这里是简介正文。')
    assert.ok(!d.introduction.includes('剧集列表'), '子节点文本漏进简介了')
  })

  await check('详情页：标签洗过且去重', () => {
    const d = parseDetail(detailHtml)
    assert.deepEqual(d.tags, ['巨乳', '女教師', '無碼'])
  })

  await check('详情页：playlist 就是集数来源，每集有自己的 code', () => {
    // 站上没有季集层级，一部作品的多集是一个 playlist 里的多个独立条目
    const d = parseDetail(detailHtml)
    assert.equal(d.seriesName, '巨乳女教師 系列')
    assert.equal(d.episodes.length, 2)
    assert.equal(d.episodes[0].videoCode, '12345')
    assert.equal(d.episodes[0].durationSec, 1048)
    assert.equal(d.episodes[1].videoCode, '12346')
    assert.equal(d.episodes[1].coverUrl, 'https://hanime1.me/e2.jpg')
  })

  await check('详情页：旧结构的 playlist 容器也认', () => {
    const old = detailHtml.replace('class="video-playlist-wrapper"', 'id="video-playlist-wrapper"')
    assert.equal(parseDetail(old).episodes.length, 2, '旧结构没走到 fallback 选择器')
  })

  await check('详情页：单集作品的 episodes 是空数组，不是一条自己', () => {
    const single = detailHtml.replace(/<div class="video-playlist-wrapper">[\s\S]*?<\/div>\s*<\/body>/, '</body>')
    const d = parseDetail(single)
    assert.deepEqual(d.episodes, [])
    assert.equal(d.seriesName, '')
    // playlist 没了，但别的字段该照旧
    assert.equal(d.title, '巨乳女教師 ＃1')
  })

  await check('详情页：每个字段独立降级，一个选择器失效不带走别的', () => {
    // 站方改版通常只动一部分 DOM。全靠一个 try 包起来会让能拿到的字段跟着一起丢
    const noTitle = detailHtml.replace('id="shareBtn-title"', 'id="something-else"')
    const d = parseDetail(noTitle)
    assert.equal(d.title, '巨乳女教师 第一集', '标题该退到正文标题上')
    assert.equal(d.tags.length, 3, '标题没了不该影响标签')
    assert.equal(d.episodes.length, 2, '标题没了不该影响集数')
  })

  await check('详情页：整页改版 / 空串一律给一个全空的结果，不抛', () => {
    for (const bad of ['', '<html></html>', '不是 HTML']) {
      const d = parseDetail(bad)
      assert.equal(d.title, '')
      assert.deepEqual(d.tags, [])
      assert.deepEqual(d.episodes, [])
    }
  })

  /* -------------------- 盾 -------------------- */

  await check('挑战页认得出来 —— 它是 200，不分辨就会被当成「站上没有」', () => {
    // 盾挡下来和真的没搜到，HTTP 状态都是 200，区别只在内容。
    // 混在一起的话用户看到「刮不到，重试也刮不到」，而真实原因是 IP 被盯上了
    for (const s of [
      '<title>Just a moment...</title>',
      '<div class="cf-browser-verification"></div>',
      '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>',
      'Checking your browser before accessing',
      '<title>Attention Required! | Cloudflare</title>',
      '<div id="cf-error-details">Sorry, you have been blocked</div>'
    ]) {
      assert.equal(looksLikeChallenge(s), true, `没认出挑战页：${s.slice(0, 40)}`)
    }
  })

  await check('正常页面不会被误判成挑战页', () => {
    assert.equal(looksLikeChallenge(detailHtml), false)
    assert.equal(looksLikeChallenge(searchHtml), false)
    assert.equal(looksLikeChallenge('<script src="/cloudflare-analytics/beacon.min.js"></script>'), false)
    assert.equal(looksLikeChallenge(''), false)
  })

  await check('Cloudflare 弹窗拿到正文后直接交给解析器，不再二次请求', async () => {
    const original = globalThis.fetch
    let calls = 0
    let verifiedUrl = ''
    setHanimeChallengeHandler(async (url) => {
      verifiedUrl = url
      return searchHtml
    })
    ;(globalThis as any).fetch = async () => {
      calls += 1
      return new Response('<title>Just a moment...</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    }
    try {
      const hits = await hanimeSearch(`challenge-${Date.now()}`, newBudget())
      assert.equal(calls, 1)
      assert.ok(hits.length > 0)
      assert.match(verifiedUrl, /hanime1\.me\/search/)
    } finally {
      ;(globalThis as any).fetch = original
      setHanimeChallengeHandler(null)
    }
  })

  await check('取页预算：用完就不再发请求', () => {
    // 配额按「别把用户 IP 打进挑战页」定，不按额度 —— hanime 不烧用户的 API 额度，
    // 但请求太密被盾盯上之后，代价落在用户 IP 上
    const b = newBudget()
    assert.equal(b.used, 0)
    assert.ok(MAX_HANIME_FETCHES > 0 && MAX_HANIME_FETCHES <= 4, '上限该比 TMDB 的 4 次更紧或相当')
  })

  await check('空 query 不发请求，直接空数组', async () => {
    const b = newBudget()
    assert.deepEqual(await hanimeSearch('   ', b), [])
    assert.equal(b.used, 0, '空 query 不该消耗预算')
  })

  await check('空 videoCode 不发请求，直接 null', async () => {
    const b = newBudget()
    assert.equal(await hanimeDetail('', b), null)
    assert.equal(b.used, 0)
  })

  /* -------------------- 通道判据 -------------------- */

  await check('判据一：分类已经是里番就走这条通道', () => {
    // 用户手改过的分类受永久保护，所以这个事实读一次就够 ——
    // 这也是「通道依赖分类、分类依赖识别」那个环的断点
    assert.equal(hanimeChannel('随便什么名字.mkv', HENTAI_CATEGORY), 'category')
    assert.equal(hanimeChannel('作品名だけ.mkv', '里番'), 'category')
  })

  await check('判据二：文件名形状像', () => {
    for (const n of [
      'OVAピュアピュア ぺろぺろ プリンセス ＃2 [中文字幕]_720P',
      '寝取られファイター ヤリっちんぐ！ ROUND1 [中文字幕]_720P',
      'ものすごい #12 _480P',
      '巨乳女教師 第3話 [无修正]_1080P.mkv'
    ]) {
      assert.equal(hanimeChannel(n), 'filename', `${n} 该命中文件名判据`)
    }
  })

  await check('判据二放宽的那几类：一个集号和方括号都没有也认得出来', () => {
    // 2026-09-03 放宽。放宽之前这几种全部漏掉，落到 TMDB 那条路上被定成
    // 普通电影 —— 用户报的就是这个。安全阀在 prompt 那头（模型自己再判一次，
    // 搜不到就退回 TMDB），所以这一层宁可宽
    for (const n of [
      // THE ANIMATION：里番改编作的招牌后缀
      '巨乳女教師 THE ANIMATION.mkv',
      '作品名 the animation 01.mp4',
      '作品名 THE　ANIMATION.mkv',
      // 厂牌名，常常是唯一的线索
      '[ピンクパイナップル] 作品名.mp4',
      '[Pink Pineapple] Some Title.mkv',
      '(Queen Bee) 作品名 01.mp4',
      '[Collaboration Works] 作品名.mkv',
      // 不带方括号的标记
      '巨乳女教師 無修正 1080p.mkv',
      '作品名 无修正.mp4',
      '某作品 中文字幕 720p.mkv',
      // OVA 紧贴假名，中间没有分隔符
      'OVAピュアピュア.mkv',
      'OVAたとえば.mp4'
    ]) {
      assert.equal(hanimeChannel(n), 'filename', `${n} 该命中放宽后的判据`)
    }
  })

  await check('放宽之后普通片库仍旧不许命中', () => {
    // 挂错的代价是模型多两个搜不到东西的工具（可恢复），
    // 漏挂的代价是这条片子永远刮不到（不可恢复）——
    // 所以判据偏松。但松也不能松到把整个动画库和普通片库都圈进来。
    // **这一条是放宽那一版的刹车**：每加一条判据都得回来跑它
    for (const n of [
      '漫长的季节.S01E05.2023.2160p.WEB-DL.mp4',
      'Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv',
      '[SubsPlease] Frieren - 12 (1080p).mkv',
      '孤独摇滚 第3話 [简繁内封]_1080P.mkv',
      '权力的游戏.第二季.第05集.mp4',
      '某部电影 1080p.mkv',
      // 正常番剧的 OVA：分隔符是有的，判据卡的是「粘着」不是「出现了 OVA」
      '钢之炼金术师 OVA 01.mkv',
      'Clannad - OVA.mkv',
      '某番剧 OVA 合集.mp4',
      // 厂牌名单里刻意不收的通用英文词，收了会命中这些
      'Edge.of.Tomorrow.2014.1080p.mkv',
      'Milky.Way.Documentary.2019.mkv',
      'Mary.Jane.2022.WEB-DL.mkv',
      // 「动画」两个字不是判据 —— 那会圈进整个动画库
      '某某动画电影.2021.1080p.mkv',
      'The.Animated.Series.S01E01.mkv'
    ]) {
      assert.equal(hanimeChannel(n), '', `${n} 不该命中 —— 它会给整个片库挂上 hanime 工具`)
    }
  })

  await check('第N話 / EPN 单独出现不算判据 —— 普通番剧也这么写', () => {
    // 这两种写法共用解析器本来就认，拿它们当判据会把整个动画库圈进来
    assert.equal(hanimeChannel('某番剧 第3話.mkv'), '')
    assert.equal(hanimeChannel('某番剧 EP5.mkv'), '')
    // 但和站方标记一起出现就算
    assert.equal(hanimeChannel('某作品 第3話 [无修正].mkv'), 'filename')
  })

  await check('清晰度单独出现不算判据', () => {
    // 普通片库的文件名上到处都是 _1080P，拿它当判据等于给整个库都挂上工具
    assert.equal(hanimeChannel('某部片_1080P.mkv'), '')
    assert.equal(hanimeChannel('某部片_720P.mkv'), '')
  })

  /* -------------------- 工具挂载 -------------------- */

  // 一份最小上下文。TMDB 和搜索都关着 —— 这一节只验工具形状和核对逻辑，
  // 一次网络请求都不该发出去
  const hCtx = (over: Record<string, unknown> = {}): any => ({
    facts: {
      ...emptyFacts(),
      video_type: 'movie' as const,
      path: 'D:\\H\\巨乳女教師 第1話 [无修正]_1080P.mkv',
      dir: 'D:\\H',
      title_zh: '巨乳女教師',
      resolution: '1080p'
    },
    db: null,
    tagPool: ['巨乳'],
    searchConfig: { provider: 'model_builtin' as const, api_key: '', endpoint: '', enabled: false },
    tmdbConfig: { api_key: '', api_domain: '', image_domain: '', enabled: false },
    ...over
  })

  await check('withHanime 关着时这两个工具不出现', () => {
    // 和 withTmdb / withSearch 同一个约定：prompt 里那段话和工具表必须一致，
    // 否则模型会去调一个没注册的工具，白烧一轮
    const names = buildVideoTools(hCtx(), ['里番'], true, true, false).map((t) => t.name)
    assert.ok(!names.includes('hanime_search'))
    assert.ok(!names.includes('hanime_detail'))
  })

  await check('withHanime 开着时两个工具都在，register_video 多一个 hanime_id', () => {
    const tools = buildVideoTools(hCtx(), ['里番'], true, true, true)
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('hanime_search'))
    assert.ok(names.includes('hanime_detail'))
    const props = Object.keys(
      (tools.find((t) => t.name === 'register_video')!.parameters as any).properties
    )
    assert.ok(props.includes('hanime_id'))

    // 关掉时这个字段也该消失：没有查询工具就没有合法来源，留着只会被编
    const offProps = Object.keys(
      (buildVideoTools(hCtx(), ['里番'], true, true, false).find(
        (t) => t.name === 'register_video'
      )!.parameters as any).properties
    )
    assert.ok(!offProps.includes('hanime_id'))
  })

  await check('prompt 里那段话跟着判据变，且不会两段同时出现', () => {
    const cats = [{ id: 'video-hentai', name: HENTAI_CATEGORY, description: '', icon: '', sort_order: 7 }]
    const off = fillVideoSystem(cats as any, ['巨乳'], true, true, '')
    const byCat = fillVideoSystem(cats as any, ['巨乳'], true, true, 'category')
    const byName = fillVideoSystem(cats as any, ['巨乳'], true, true, 'filename')

    assert.ok(!off.includes('hanime'), '判据没命中时不该提 hanime')
    assert.ok(byCat.includes('这一条是里番'), '分类判据该用确定的说法')
    assert.ok(!byCat.includes('看起来像里番'), '两段不该同时出现')
    assert.ok(byName.includes('看起来像里番'), '文件名判据该用推测的说法')
    assert.ok(
      byName.includes('那说明这个判断错了'),
      '靠猜的那条必须留一句退路，否则模型会硬塞并反复重搜'
    )
    // 两种说法都要带上共用那段（标签可用、不要编 id、不要合并集）
    for (const s of [byCat, byName]) {
      assert.ok(s.includes('不要编 hanime_id'))
      assert.ok(s.includes('不要把同系列的集合并成一条'))
    }
  })

  /* -------------------- 侧栏 / 海报墙 / 详情页 -------------------- */

  await check('里番类型单独计数，显式选择后筛选海报墙', () => {
    // v0.8-计划.md 第三节说「加一条分类，侧栏入口和筛选同时就有」。
    // 那句话对**界面**成立（这一条验它），对**老库**不成立（迁移那一节验它）。
    // 两件事分开验，因为它们当初是被混成一句话才出的错
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)

    const base = {
      video_type: 'movie' as const,
      name_en: '', description: '', official_url: '', source_dir: 'D:\\H',
      file_size: 1, year: 0, end_year: 0, rating: 0, duration_sec: 0,
      resolution: '', video_codec: '', source: '', release_group: '',
      audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [],
      tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0,
      poster_path: '', fanart_path: '', watch_status: 'unwatched', episodes: []
    }
    insertVideo(d as any, {
      ...base, path: 'D:\\H\\a.mkv', name_zh: '巨乳女教師', summary: 'x',
      category: HENTAI_CATEGORY, tags: [], hanime_tags: ['巨乳', '女教師'], hanime_id: '86994'
    } as any)
    insertVideo(d as any, {
      ...base, path: 'D:\\H\\b.mkv', name_zh: '寝取られファイター', summary: 'x',
      category: HENTAI_CATEGORY, tags: [], hanime_tags: ['巨乳'], hanime_id: '86995'
    } as any)
    insertVideo(d as any, {
      ...base, path: 'D:\\M\\c.mkv', name_zh: '沙丘', summary: 'x',
      category: '欧美', tags: ['科幻']
    } as any)

    const cats = videoCounts(d as any).categories
    assert.equal(cats.find((c) => c.name === HENTAI_CATEGORY), undefined)
    assert.equal(videoCounts(d as any).hentai, 2)

    // 点一下侧栏 = store.select({kind:'category'}) -> q.category -> 这个查询
    const only = listVideos(d as any, { type: 'hentai' }).map((v: any) => v.name_zh)
    assert.deepEqual(only.sort(), ['寝取られファイター', '巨乳女教師'].sort())
    const counts = videoCounts(d as any)
    assert.deepEqual(counts.tags, [{ name: '科幻', count: 1 }], '普通标签栏不该露出里番标签')
    assert.deepEqual(
      counts.hanime_tags,
      [{ name: '巨乳', count: 2 }, { name: '女教師', count: 1 }],
      '进入里番分类时要拿到站方标签计数'
    )
    assert.deepEqual(
      listVideos(d as any, { type: 'hentai', tag: '女教師' })
        .map((v: any) => v.name_zh),
      ['巨乳女教師'],
      '里番标签筛选必须和分类条件叠加'
    )
    assert.deepEqual(
      listVideos(d as any, { category: '欧美' } as any).map((v: any) => v.name_zh),
      ['沙丘'],
      '筛里番不该影响别的分类'
    )
    d.close()
  })

  await check('库里没有里番时那一格不出现 —— 「没有就不显示」是白拿的隐私', () => {
    // 分类是开集，侧栏那段是 v-if="categories.length > 0" + 后端只返回有条目的分类。
    // 所以不需要做「隐藏成人内容」的开关：库里没有就看不见
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.deepEqual(videoCounts(d as any).categories, [])
    d.close()
  })

  await check('详情页点标签 = 按标签筛选，站方标签和 TMDB 题材词走同一条路', () => {
    // 站方标签（巨乳、女教師）和 TMDB 题材词（科幻）在库里是同一张标签表，
    // 没有理由让它们的点击行为不一样
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const base = {
      video_type: 'movie' as const,
      name_en: '', description: '', official_url: '', source_dir: 'D:\\H',
      file_size: 1, year: 0, end_year: 0, rating: 0, duration_sec: 0,
      resolution: '', video_codec: '', source: '', release_group: '',
      audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [],
      tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0,
      poster_path: '', fanart_path: '', watch_status: 'unwatched', episodes: []
    }
    insertVideo(d as any, {
      ...base, path: 'D:\\H\\a.mkv', name_zh: '巨乳女教師', summary: 'x',
      category: HENTAI_CATEGORY, tags: ['巨乳', '女教師']
    } as any)
    insertVideo(d as any, {
      ...base, path: 'D:\\M\\c.mkv', name_zh: '沙丘', summary: 'x',
      category: '欧美', tags: ['科幻']
    } as any)

    assert.deepEqual(
      listVideos(d as any, { type: 'hentai', tag: '女教師' }).map((v: any) => v.name_zh),
      ['巨乳女教師']
    )
    assert.deepEqual(
      listVideos(d as any, { tag: '科幻' } as any).map((v: any) => v.name_zh),
      ['沙丘']
    )
    d.close()
  })

  await check('hanime_id 一路读到详情页读得到的那个形状', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    insertVideo(d as any, {
      video_type: 'movie' as const, path: 'D:\\H\\a.mkv', name_zh: 'x', name_en: '',
      summary: 'x', description: '', category: HENTAI_CATEGORY, tags: [], official_url: '',
      source_dir: 'D:\\H', file_size: 1, year: 0, end_year: 0, rating: 0, duration_sec: 0,
      resolution: '', video_codec: '', source: '', release_group: '',
      audio_tracks: [], subtitle_tracks: [], parts: [], linked_files: [],
      tmdb_id: '', imdb_id: '', douban_id: '', douban_rating: 0, hanime_id: '86994',
      poster_path: '', fanart_path: '', watch_status: 'unwatched', episodes: []
    } as any)
    // 详情页那个按钮的 v-if 判的就是这个值非空
    const row = listVideos(d as any, { type: 'hentai' })[0] as any
    assert.equal(row.hanime_id, '86994')
    assert.equal(watchUrl(row.hanime_id), 'https://hanime1.me/watch?v=86994')
    d.close()
  })

  await check('编出来的 hanime_id 被丢掉', async () => {
    // 编一个的后果是详情页上一个指向别的作品的链接，而用户没法判断它是错的：
    // 点进去看到另一部片，只会以为是站方改了内容
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const ctx = hCtx({ db: d as any })
    const tool = buildVideoTools(ctx, ['里番'], true, true, true).find(
      (t) => t.name === 'register_video'
    )!
    const out = await tool.execute({
      name_zh: '巨乳女教師',
      summary: 'x',
      category: HENTAI_CATEGORY,
      hanime_id: 99999
    })
    const row = d.prepare('SELECT hanime_id FROM video_meta').get() as any
    assert.equal(row.hanime_id, '', '没查过的 hanime_id 不能落库')
    assert.ok(String(out).includes('99999'), '要把编的那个回灌给模型，别静默丢掉')
    d.close()
  })
}


/* ==================== 隐藏里番 · v0.8 ==================== */

/**
 * 「隐藏里番」这个开关。
 *
 * 重点全在**覆盖面**：判据出现在七处（列表 + counts 的六个聚合），漏掉任何一处的
 * 表现都是「关了还能从别处看见」，而那比不做更糟 —— 用户以为藏住了。所以这一节
 * 挨个数字都验一遍，不只验「墙上没有了」。
 *
 * 另外验两件容易想歪的事：藏起来**不改数据**（关掉就全回来），以及归档那一格
 * 也得挡（漏出去等于告诉用户「藏了几条」）。
 */
export async function hideHentaiSection(): Promise<void> {
  console.log('\n隐藏里番 · v0.8（开关只管显示，不动数据）')

  /** 铺一个小库：2 条里番 + 2 条别的 + 1 条归档的里番 */
  const seed = (): any => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const add = (
      id: string,
      name: string,
      category: string,
      tags: string[],
      status: string,
      type: string,
      archived = 0
    ): void => {
      d.prepare(
        `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name,
           name_zh, category, tags, is_archived)
         VALUES (?, 'video', 1, 2, ?, ?, ?, ?, ?, ?)`
      ).run(id, `D:\\V\\${name}.mkv`, `${name}.mkv`, name, category, JSON.stringify(tags), archived)
      d.prepare(
        `INSERT INTO video_meta (resource_id, video_type, watch_status) VALUES (?, ?, ?)`
      ).run(id, type, status)
    }
    add('h1', '里番甲', HENTAI_CATEGORY, ['巨乳'], 'watched', 'movie')
    add('h2', '里番乙', HENTAI_CATEGORY, ['巨乳', '女教師'], 'unwatched', 'movie')
    add('n1', '普通电影', '欧美', ['科幻'], 'watching', 'movie')
    add('n2', '普通剧集', '日韩', ['悬疑'], 'unwatched', 'series')
    add('h3', '归档的里番', HENTAI_CATEGORY, ['巨乳'], 'watched', 'movie', 1)
    return d
  }

  await check('关闭全局隐藏时，仍须显式选择里番类型', () => {
    const d = seed()
    assert.equal(listVideos(d as any).length, 2)
    assert.equal(listVideos(d as any, { type: 'hentai' }).length, 2)
    const c = videoCounts(d as any)
    assert.equal(c.all, 2)
    assert.equal(c.archived, 0)
    assert.equal(c.hentai, 2)
    assert.ok(!c.categories.some((x) => x.name === HENTAI_CATEGORY))
    d.close()
  })

  await check('开了之后墙上不铺里番', () => {
    const d = seed()
    const names = listVideos(d as any, {}, true).map((v) => v.name_zh)
    assert.deepEqual(names.sort(), ['普通剧集', '普通电影'])
    d.close()
  })

  await check('开了之后侧栏那一格消失，别的分类不受影响', () => {
    const d = seed()
    const c = videoCounts(d as any, true)
    assert.ok(!c.categories.some((x) => x.name === HENTAI_CATEGORY), '里番那一格该没了')
    assert.deepEqual(
      c.categories.map((x) => x.name).sort(),
      ['日韩', '欧美'],
      '别的分类得原样留着'
    )
    d.close()
  })

  await check('六个聚合一个都不能漏 —— 漏一处就等于告诉用户藏了几条', () => {
    const d = seed()
    const c = videoCounts(d as any, true)
    assert.equal(c.all, 2, `all 没挡住：${c.all}`)
    // 归档那一格也要挡。h3 是归档的里番，漏出去就是「归档区里有 1 条看不见的东西」
    assert.equal(c.archived, 0, `archived 没挡住：${c.archived}`)
    // 观看状态：里番占了 watched 1 条 + unwatched 1 条，藏了之后
    // watched 该是 0，unwatched 只剩普通剧集那 1 条
    assert.equal(c.status.watched, 0, `status.watched 没挡住：${c.status.watched}`)
    assert.equal(c.status.unwatched, 1, `status.unwatched 没挡住：${c.status.unwatched}`)
    assert.equal(c.status.watching, 1, '普通电影那条该还在')
    // 类型：里番两条都是 movie，藏了之后 movie 只剩 1
    assert.equal(c.type.movie, 1, `type.movie 没挡住：${c.type.movie}`)
    assert.equal(c.type.series, 1)
    // 标签：巨乳 / 女教師 只挂在里番上，该整个消失
    const tags = c.tags.map((t) => t.name)
    assert.ok(!tags.includes('巨乳'), `标签池漏了「巨乳」：${JSON.stringify(tags)}`)
    assert.ok(!tags.includes('女教師'), `标签池漏了「女教師」：${JSON.stringify(tags)}`)
    assert.deepEqual(tags.sort(), ['悬疑', '科幻'])
    d.close()
  })

  await check('明确点里番分类也筛不出东西 —— 判据在数据层，不靠界面自觉', () => {
    const d = seed()
    // 开关刚打开的那一刻 selection 可能还停在里番上。挡在这一层才是真挡住
    assert.equal(listVideos(d as any, { type: 'hentai' }, true).length, 0)
    // 走标签进来也一样
    assert.equal(listVideos(d as any, { tag: '巨乳' }, true).length, 0)
    // 关键词搜索走的是同一条查询路径，所以顺带就挡住了 —— 验一下别真漏了
    assert.equal(listVideos(d as any, { keyword: '里番' }, true).length, 0)
    // 归档视图也不能漏
    assert.equal(listVideos(d as any, { group: 'archived' }, true).length, 0)
    d.close()
  })

  await check('藏起来不改数据 —— 关掉开关全回来', () => {
    const d = seed()
    // 先藏
    assert.equal(listVideos(d as any, {}, true).length, 2)
    // 表里的行数一条都没变：这个开关只是查询时多一个条件
    const rows = (
      d.prepare(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`).get() as any
    ).n
    assert.equal(rows, 5, '开关不该动任何一行数据')
    // 再放开
    assert.equal(listVideos(d as any).length, 2)
    assert.equal(listVideos(d as any, { type: 'hentai' }).length, 2)
    assert.equal(videoCounts(d as any).hentai, 2)
    d.close()
  })

  await check('库里没有里番时，开着开关也不出错', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.deepEqual(listVideos(d as any, {}, true), [])
    const c = videoCounts(d as any, true)
    assert.equal(c.all, 0)
    assert.deepEqual(c.categories, [])
    assert.deepEqual(c.tags, [])
    d.close()
  })
}
