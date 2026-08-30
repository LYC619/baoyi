/**
 * 给临时 profile 铺影视假数据，专门验 Step 6 的海报墙 / 详情页 / 观看状态。
 *
 * 用法：node --experimental-strip-types scripts/verify-video-seed.ts <profile 目录>
 *
 * 为什么要真机而不是自检：五道闸门验的全是纯逻辑，验不到**接缝和渲染** ——
 * `baoyi://poster/` 那条协议通不通、海报到底显不显示、季集列表在真数据上
 * 什么样，都要开窗口看。而 v0.6 的记录里写着：窗口不可见时页面会静默不渲染，
 * 所以得靠 CDP 驱动（见 verify-video-cdp.ts）。
 *
 * **绝不碰真库。** 只往 --user-data-dir 指定的临时 profile 里写。
 *
 * video 是**视图**，写不进去 —— 要写的是 resource + video_meta + episode。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const profile = process.argv[2]
if (!profile) {
  console.error('用法: node --experimental-strip-types scripts/verify-video-seed.ts <profile 目录>')
  process.exit(1)
}

const dbFile = path.join(profile, 'baoyi.db')
if (!fs.existsSync(dbFile)) {
  console.error(`找不到 ${dbFile} —— 先空跑一次应用让它建表，再来铺数据`)
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA foreign_keys = ON')

const schema = (db.prepare(`SELECT value FROM settings WHERE key = '_schema'`).get() as any)?.value
if (String(schema ?? '') !== '7') {
  console.error(`库版本是 ${schema}，不是 7 —— 这个 profile 没跑过 v0.7 迁移`)
  process.exit(1)
}

const postersDir = path.join(profile, 'posters')
fs.mkdirSync(postersDir, { recursive: true })

const now = Date.now()

/**
 * 一张能真的被 Chromium 渲染出来的 PNG。
 *
 * 不能拿 `Buffer.alloc(1024)` 糊弄过去：那种文件磁盘上在、`existsSync` 为真、
 * 协议处理器也会 200 —— 但 `<img>` 解不出来，`onerror` 一响就退回首字占位。
 * 而这一路要验的正是「海报显示出来了」，用假字节验等于什么都没验。
 *
 * 1x1 的纯色 PNG，base64 是查表来的最短合法 PNG。
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

interface SeedVideo {
  id: string
  name: string
  type: 'movie' | 'series'
  /** '' = 没海报（验首字占位）；'local' = 真图；'tmdb' = 相对路径（验它被挡掉） */
  poster: '' | 'local' | 'tmdb'
  status: 'unwatched' | 'watching' | 'watched' | 'dropped'
  category: string
  tags: string
  year: number
  rating: number
  doubanRating: number
  duration: number
  archived?: boolean
}

const VIDEOS: SeedVideo[] = [
  // 有本地海报 + 在看 —— 墙上和侧栏都要能看见
  {
    id: 'vid-0001', name: '沙丘', type: 'movie', poster: 'local', status: 'watching',
    category: '欧美', tags: '科幻,史诗', year: 2021, rating: 7.9, doubanRating: 7.7, duration: 9300
  },
  // 只有 TMDB 相对路径 —— 界面必须退回首字占位，不能是一张破图
  {
    id: 'vid-0002', name: '奥本海默', type: 'movie', poster: 'tmdb', status: 'unwatched',
    category: '欧美', tags: '传记', year: 2023, rating: 8.1, doubanRating: 8.9, duration: 10800
  },
  // 一张海报都没有 + 只有豆瓣分（验排序回落）
  {
    id: 'vid-0003', name: '钢的琴', type: 'movie', poster: '', status: 'watched',
    category: '华语', tags: '文艺', year: 2010, rating: 0, doubanRating: 8.4, duration: 6300
  },
  // 剧集，有季集表，看了一部分 —— 详情页的重心在这条上
  {
    id: 'vid-0004', name: '黑暗荣耀', type: 'series', poster: 'local', status: 'watching',
    category: '日韩', tags: '悬疑,复仇', year: 2022, rating: 8.1, doubanRating: 8.9, duration: 0
  },
  // 剧集但没有季集表 —— 验那块「没刮到季集表」的解释面板
  {
    id: 'vid-0005', name: '某部没刮到的剧', type: 'series', poster: '', status: 'unwatched',
    category: '日韩', tags: '', year: 0, rating: 0, doubanRating: 0, duration: 0
  },
  // 弃 —— 侧栏那一格的空心点
  {
    id: 'vid-0006', name: '半途而废的片', type: 'movie', poster: '', status: 'dropped',
    category: '欧美', tags: '', year: 2015, rating: 5.2, doubanRating: 0, duration: 5400
  },
  // 归档 —— 侧栏的归档区只在有归档时出现
  {
    id: 'vid-0007', name: '收进箱底的片', type: 'movie', poster: '', status: 'watched',
    category: '华语', tags: '', year: 2008, rating: 7.0, doubanRating: 7.1, duration: 7200,
    archived: true
  }
]

for (const v of VIDEOS) {
  const isSeries = v.type === 'series'
  // 剧集的 path 是目录、file_name 是目录名；电影的 path 是文件
  const dir = `D:\\假影视\\${v.name}`
  const file = `${v.name}.2021.1080p.BluRay.x264-GROUP.mkv`

  db.prepare(
    `INSERT INTO resource
       (id, kind, created_at, updated_at, path, file_name, file_size, source_dir,
        name_zh, summary, category, tags, ai_status, is_archived)
     VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`
  ).run(
    v.id, now, now,
    isSeries ? dir : `${dir}\\${file}`,
    isSeries ? v.name : file,
    isSeries ? 0 : 4_000_000_000,
    'D:\\假影视',
    v.name,
    `${v.name}的简介。这一段是假的，用来验详情页那块简介排版。`,
    v.category, v.tags,
    v.archived ? 1 : 0
  )

  let posterPath = ''
  if (v.poster === 'local') {
    posterPath = path.join(postersDir, `${v.id}.png`)
    fs.writeFileSync(posterPath, PNG_1X1)
  } else if (v.poster === 'tmdb') {
    // 刮削阶段落下的相对路径，还没下载。界面该把它当「没有海报」
    posterPath = '/wPRcNZ4Q1RkzhtsFRSMJfLmMx1v.jpg'
  }

  db.prepare(
    `INSERT INTO video_meta
       (resource_id, video_type, poster_path, year, rating, watch_status,
        duration_sec, resolution, video_codec, source, release_group,
        audio_tracks, tmdb_id, douban_id, douban_rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    v.id, v.type, posterPath, v.year, v.rating, v.status, v.duration,
    isSeries ? '' : '1080p', isSeries ? '' : 'AVC', isSeries ? '' : 'BLURAY',
    isSeries ? '' : 'GROUP',
    JSON.stringify([{ index: 0, language: 'zh', label: '国语 5.1', codec: 'DTS', path: '' }]),
    v.year ? '438631' : '', v.doubanRating ? '3820120' : '', v.doubanRating
  )
}

/**
 * 黑暗荣耀的季集表：两季，故意留缺口。
 *
 * 第一季 8 集全有文件、看完 5 集 —— 详情页该显示 5/8，剧一级是「在看」。
 * 第二季 8 集只有 3 个文件 —— 剩下 5 集 path 为空串，那是「知道有这一集、
 * 磁盘上没文件」，界面上必须露面，否则用户不知道自己缺什么。
 */
let epSeq = 0
for (const season of [1, 2]) {
  for (let ep = 1; ep <= 8; ep++) {
    const hasFile = season === 1 || ep <= 3
    const watched = season === 1 && ep <= 5
    db.prepare(
      `INSERT INTO episode
         (id, resource_id, season, episode, title, path, file_size,
          duration_sec, watch_status, watched_at, air_date)
       VALUES (?, 'vid-0004', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `ep-${String(++epSeq).padStart(4, '0')}`, season, ep,
      `第 ${ep} 集的标题`,
      hasFile ? `D:\\假影视\\黑暗荣耀\\S0${season}\\S0${season}E0${ep}.mkv` : '',
      hasFile ? 2_000_000_000 : 0,
      hasFile ? 3300 : 0,
      watched ? 'watched' : 'unwatched',
      watched ? now : 0,
      0
    )
  }
}

const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
console.log(
  JSON.stringify(
    {
      videos: n(`SELECT COUNT(*) AS n FROM video`),
      movies: n(`SELECT COUNT(*) AS n FROM video WHERE video_type = 'movie'`),
      series: n(`SELECT COUNT(*) AS n FROM video WHERE video_type = 'series'`),
      archived: n(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 1`),
      episodes: n(`SELECT COUNT(*) AS n FROM episode`),
      episodesMissingFile: n(`SELECT COUNT(*) AS n FROM episode WHERE path = ''`),
      posterFiles: fs.readdirSync(postersDir).length
    },
    null,
    2
  )
)
db.close()
