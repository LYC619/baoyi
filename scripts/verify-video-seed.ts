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
import { SCHEMA_VERSION } from '../electron/services/schema.ts'
import { HENTAI_CATEGORY } from '../electron/kinds/video/taxonomy.ts'
import { SEED_VIDEOS, SEED_HENTAI } from './lib/video-seed-data.ts'

// 声明在 lib/video-seed-data.ts，CDP 那一路要从同一份声明算期望值。
// 这一条断言把「那个文件里的字面量」和「主进程真正用的常量」钉在一起 ——
// 分类名要是改了而那边没跟上，这里先炸，而不是等真机验证红一片
if (SEED_HENTAI !== HENTAI_CATEGORY) {
  console.error(`分类名对不上：seed 数据写的是 ${SEED_HENTAI}，taxonomy 里是 ${HENTAI_CATEGORY}`)
  process.exit(1)
}

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

/**
 * 版本闸门读的是 `SCHEMA_VERSION` 而不是写死的数字。
 *
 * 原先写死 `!== '7'`，于是库升到 9 之后这个脚本直接拒绝开工 —— 表现是
 * 「真机验证做不了」，而真正的原因只是闸门本身过期了。写死的那个数字每次
 * 迁移都要有人记得改，而忘了改的代价是**验证路径先坏掉**，最需要它的时候。
 */
const schema = (db.prepare(`SELECT value FROM settings WHERE key = '_schema'`).get() as any)?.value
if (String(schema ?? '') !== String(SCHEMA_VERSION)) {
  console.error(
    `库版本是 ${schema}，不是 ${SCHEMA_VERSION} —— 这个 profile 没跑完迁移，先空跑一次应用`
  )
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


/**
 * 那个真文件：profile 里的一个 .txt。
 *
 * 为什么是 txt 而不是 mkv：要验的是 `shell.openPath` 这一步真的走通了，
 * 而那取决于**系统有没有关联程序**。假 mkv 在这台机器上可能关联着某个
 * 播放器、也可能什么都没有，两种情况下这条检查的含义完全不同。txt 一定
 * 有关联（记事本），而且开出来的窗口一句 `Stop-Process` 就收拾干净。
 *
 * 代价是它会在验证过程中真的弹一个记事本出来。CDP 那一路把这条检查排在
 * 最后并且立刻杀掉进程 —— 记事本抢焦点会把 Electron 窗口的 rAF 掐掉，
 * 后面的 DOM 查询会看起来像是页面卡住了（v0.6 记过这个坑）。
 */
const PLAYABLE = path.join(profile, '能真打开的片.txt')
fs.writeFileSync(PLAYABLE, '这是验证用的假视频文件。\r\n', 'utf8')

/**
 * 外挂字幕：两个真文件 + 一个内嵌轨。
 *
 * 三条都要有，因为详情页把内嵌和外挂分成了两块显示，而那个区别的判据是
 * `path` 空不空。只铺一种的话，分不分开都能「看着对」。
 * 文件要真存在 —— `revealSubtitle` 会 `existsSync` 一道。
 */
const SUB_DIR = path.join(profile, 'subs')
fs.mkdirSync(SUB_DIR, { recursive: true })
const SUBS = ['沙丘.简体.srt', '沙丘.英文.ass'].map((name) => {
  const p = path.join(SUB_DIR, name)
  fs.writeFileSync(p, '1\r\n00:00:01,000 --> 00:00:02,000\r\n假字幕\r\n', 'utf8')
  return p
})

for (const v of SEED_VIDEOS) {
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
    v.playable ? PLAYABLE : isSeries ? dir : `${dir}\\${file}`,
    v.playable ? path.basename(PLAYABLE) : isSeries ? v.name : file,
    isSeries ? 0 : 4_000_000_000,
    'D:\\假影视',
    v.name,
    `${v.name}的简介。这一段是假的，用来验详情页那块简介排版。`,
    v.category,
    // JSON 数组字符串，和 `insertVideo` 写进去的形状一致（`JSON.stringify(p.tags)`）。
    // 铺成 `'科幻,史诗'` 的话读出来是空数组 —— 详见 SeedVideo.tags 的注释
    JSON.stringify(v.tags),
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

  // 字幕轨只给沙丘：一条内嵌 + 两个外挂。详情页把这两类分开显示，
  // 判据是 path 空不空，所以两类都得有实物
  const subtitleTracks =
    v.id === 'vid-0001'
      ? [
          { index: 2, language: 'zh', label: '简体中文', codec: 'SUBRIP', path: '' },
          { index: -1, language: 'zh', label: SUBS[0]!.split(/[\\/]/).pop(), codec: 'SRT', path: SUBS[0] },
          { index: -1, language: 'en', label: SUBS[1]!.split(/[\\/]/).pop(), codec: 'ASS', path: SUBS[1] }
        ]
      : []

  // 里番不给 tmdb_id / douban_id：那两个站上本来就没有这类条目，给了就等于
  // 铺了一份现实里不会出现的数据，验出来的按钮组合也是假的
  const isHentai = v.category === HENTAI_CATEGORY

  db.prepare(
    `INSERT INTO video_meta
       (resource_id, video_type, poster_path, year, rating, watch_status,
        duration_sec, resolution, video_codec, source, release_group,
        audio_tracks, subtitle_tracks, tmdb_id, douban_id, douban_rating, hanime_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    v.id, v.type, posterPath, v.year, v.rating, v.status, v.duration,
    isSeries ? '' : '1080p', isSeries ? '' : 'AVC', isSeries ? '' : 'BLURAY',
    isSeries ? '' : 'GROUP',
    JSON.stringify([{ index: 0, language: 'zh', label: '国语 5.1', codec: 'DTS', path: '' }]),
    JSON.stringify(subtitleTracks),
    isHentai ? '' : v.year ? '438631' : '',
    isHentai ? '' : v.doubanRating ? '3820120' : '',
    v.doubanRating,
    v.hanimeId ?? ''
  )
}

/**
 * 黑暗荣耀的季集表：两季，故意留缺口。
 *
 * 第一季 8 集全有文件、看完 5 集 —— 详情页该显示 5/8，剧一级是「在看」。
 * 第二季 8 集只有 3 个文件 —— 剩下 5 集 path 为空串，那是「知道有这一集、
 * 磁盘上没文件」，界面上必须露面，否则用户不知道自己缺什么。
 *
 * **S02E02 留一个断点**（Step 7 加的）：这样「点播放该开哪一集」在真数据上
 * 有得可验 —— 有断点的那一集要压过「第一集没看完的」（那会是 S01E06）。
 * 不留断点的话两条规则给出同一个答案，等于只验了一条。
 */
let epSeq = 0
for (const season of [1, 2]) {
  for (let ep = 1; ep <= 8; ep++) {
    const hasFile = season === 1 || ep <= 3
    const watched = season === 1 && ep <= 5
    const resuming = season === 2 && ep === 2
    db.prepare(
      `INSERT INTO episode
         (id, resource_id, season, episode, title, path, file_size,
          duration_sec, watch_status, position_sec, watched_at, air_date)
       VALUES (?, 'vid-0004', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `ep-${String(++epSeq).padStart(4, '0')}`, season, ep,
      `第 ${ep} 集的标题`,
      hasFile ? `D:\\假影视\\黑暗荣耀\\S0${season}\\S0${season}E0${ep}.mkv` : '',
      hasFile ? 2_000_000_000 : 0,
      hasFile ? 3300 : 0,
      watched ? 'watched' : resuming ? 'watching' : 'unwatched',
      resuming ? 812 : 0,
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
      hentai: n(`SELECT COUNT(*) AS n FROM video WHERE category = '${HENTAI_CATEGORY}'`),
      withHanimeId: n(`SELECT COUNT(*) AS n FROM video WHERE hanime_id != ''`),
      movies: n(`SELECT COUNT(*) AS n FROM video WHERE video_type = 'movie'`),
      series: n(`SELECT COUNT(*) AS n FROM video WHERE video_type = 'series'`),
      archived: n(`SELECT COUNT(*) AS n FROM video WHERE is_archived = 1`),
      episodes: n(`SELECT COUNT(*) AS n FROM episode`),
      episodesMissingFile: n(`SELECT COUNT(*) AS n FROM episode WHERE path = ''`),
      episodesResuming: n(`SELECT COUNT(*) AS n FROM episode WHERE position_sec > 0`),
      posterFiles: fs.readdirSync(postersDir).length,
      playableFile: PLAYABLE,
      subtitleFiles: SUBS.length
    },
    null,
    2
  )
)
db.close()
