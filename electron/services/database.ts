import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { KINDS } from '../kinds/index.ts'
import { initSchema, seedDefaults, SCHEMA_VERSION } from './schema.ts'
import { openUpgradedDatabase } from './library-snapshots.ts'
import { buildLibraryBackup } from './library-backup.ts'
import { VIDEO_JOBS_SQL } from '../kinds/video/download/jobs.ts'
import { migrateDocumentSchema } from '../kinds/document/index.ts'
import { migratePosterStorage, resolvePosterDirectory } from './poster-storage.ts'
import { migrateArtworkIntoLibrary } from './artwork-migration.ts'
import { pruneStrayPlaceholders } from '../kinds/video/catalogue.ts'
import { isPortable } from './portable.ts'
import type { DataStats } from '../../src/types/index.ts'
import { getSettings } from './settings-store.ts'

let db: Database.Database | null = null

let posterDirectory = ''

export function iconsDir(): string {
  const dir = path.join(app.getPath('userData'), 'icons')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 游戏封面目录。和 icons 分开而不是共用一个目录：
 *
 * 图标是抱一自己从 exe 里抽出来的**缓存**，清掉不丢东西，下次识别会重新抽 ——
 * `clearIcons()` 就是照这个前提写的，重置时整个目录一扫而空。封面是用户亲手指的
 * 一张图，性质是**资产**。混在一起的话，「清空图标缓存」会顺手把他挑的封面全删了。
 */
export function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 影视海报目录。第三个图片目录，不是随手多开的一个 —— 它在上面那条
 * 「缓存 vs 资产」的线上落在**中间**，所以两边都不该收它。
 *
 * 海报绝大多数是刮削下来的，丢了重刮一次就有，这一点像 icons；但用户也能自己
 * 挑一张，那一张跟游戏封面一样是资产。塞进 covers/ 的话，将来做「清理刮削缓存」
 * 就没有一个能安全下手的目录；塞进 icons/ 的话，`clearIcons()` 会把用户手动
 * 挑的海报一起删掉。单独一个目录，两种清理都有明确边界。
 */
export function postersDir(): string {
  const dir = path.join(app.getPath('userData'), 'posters')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 0.8 开发期有一版把海报缓存放到了项目/程序目录下的 `data/posters`，仓库一挪缓存就断。
 * 现在缓存回到 userData；这里算出那个旧位置，启动时把里面的图搬回来。
 * 绿色版和显式 --user-data-dir 从来没用过那个位置，算出来就是 userData 本身，迁移会直接跳过。
 */
function legacyProjectPostersDir(): string {
  posterDirectory ||= resolvePosterDirectory({
    appPath: app.getAppPath(), exePath: process.execPath, userDataPath: app.getPath('userData'),
    explicitUserData: app.commandLine.hasSwitch('user-data-dir'), portable: isPortable()
  })
  return posterDirectory
}

/**
 * 存档备份根目录，并保证它存在。
 *
 * 设置为空时退回用户数据目录下的 save-backups —— 和 icons 同一个套路：
 * 「不设置也能用」比「先去设置里指一个」少一道门槛，而想换位置的人随时能换。
 * 目录创建失败时让 IPC 调用方显示真实错误。
 */
export function saveBackupRoot(): string {
  const configured = getSettings(getDb()).save_backup_root.trim()
  const dir = configured || path.join(app.getPath('userData'), 'save-backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database.Database {
  if (db) return db
  const file = path.join(app.getPath('userData'), 'baoyi.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = openUpgradedDatabase({
    file, version: app.getVersion(), targetSchema: SCHEMA_VERSION,
    open: (filename, readonly) => new Database(filename, { readonly, fileMustExist: readonly }),
    migrate: connection => {
      connection.pragma('journal_mode = WAL')
      connection.pragma('foreign_keys = ON')
      initSchema(connection, KINDS)
      connection.exec(VIDEO_JOBS_SQL)
    }
  })
  try {
    const pruned = pruneStrayPlaceholders(db)
    if (pruned) console.log(`[抱一] 已清理 ${pruned} 条不属于同系列的占位集（播放列表带来的、本地没有文件的集）`)
  } catch (cause) { console.error('[抱一] 占位集清理未完成：', cause) }
  try {
    const migration = migratePosterStorage(db, legacyProjectPostersDir(), postersDir())
    if (migration.removed || migration.updated) console.log(`[抱一] 影视图片已搬回 ${postersDir()}（${migration.removed} 张，${migration.updated} 处引用）`)
    for (const warning of migration.warnings) console.warn('[抱一] ' + warning)
  } catch (cause) { console.error('[抱一] 影视图片迁移未完成；尚未迁移的原文件与恢复记录已保留：', cause) }
  // 用户 9-18 拍板：所有海报进视频库。缓存目录里被库引用的图按作品搬进 <作品目录>/.baoyi/artwork，
  // 无引用的按内容在视频库里找同款，找到的删、找不到的留着报数（这里不读 getSettings，它会再进 getDb）
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('video_scan_dirs') as { value?: string } | undefined
    let scanRoots: string[] = []
    try { const parsed = JSON.parse(row?.value ?? '[]'); if (Array.isArray(parsed)) scanRoots = parsed.filter((v): v is string => typeof v === 'string') } catch { /* 坏值当没有 */ }
    const migration = migrateArtworkIntoLibrary(db, {
      cacheDirs: [postersDir(), legacyProjectPostersDir()], fallbackDir: postersDir(),
      recoveryRoot: app.getPath('userData'), scanRoots, orphanStrategy: 'count'
    })
    if (migration.moved || migration.relinked || migration.removed) console.log(`[抱一] 影视图片已归位到作品目录：搬入 ${migration.moved} 张，改指向 ${migration.relinked} 处，清理缓存 ${migration.removed} 张，留在缓存 ${migration.keptInCache} 处`)
    if (migration.orphans) console.log(`[抱一] 保留 ${migration.orphans} 张无引用海报，启动时不扫描影视库查重：${postersDir()}`)
    for (const warning of migration.warnings) console.warn('[抱一] ' + warning)
  } catch (cause) { console.error('[抱一] 影视图片归位未完成；缓存副本与恢复记录已保留：', cause) }
  return db
}

export function exportAll(): import('../../src/types/library-backup.ts').LibraryBackup {
  return buildLibraryBackup(getDb())
}

/* ------------------------------ 用量统计 ------------------------------ */

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 设置页「数据管理」上那几个数字。
 *
 * 库大小要把 -wal 算进去：journal_mode 是 WAL，刚写进去还没 checkpoint 的数据
 * 全在 wal 文件里，只报 baoyi.db 会明显偏小，看起来像是数据没存上。
 *
 * 封面单独一栏，和图标并列。它们在**存留策略**上是两回事（图标是缓存，随时可重建；
 * 封面是用户亲手指的资产），但在「占了多少磁盘」这个问题上是同一回事 ——
 * 0.6 只统计图标，于是封面攒了多少空间在界面上完全看不到。
 */
function dirUsage(dir: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      count++
      bytes += fileSize(path.join(dir, name))
    }
  } catch {
    /* 目录还没建起来，当作空 —— 第一次运行时图标和封面目录都还不存在 */
  }
  return { count, bytes }
}

export function dataStats(): DataStats {
  const d = getDb()
  const one = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  const dbFile = path.join(app.getPath('userData'), 'baoyi.db')

  const icons = dirUsage(iconsDir())
  const covers = dirUsage(coversDir())
  const posters = dirUsage(postersDir())

  return {
    software: one('SELECT COUNT(*) AS n FROM software'),
    games: one('SELECT COUNT(*) AS n FROM game'),
    videos: one('SELECT COUNT(*) AS n FROM video'),
    episodes: one('SELECT COUNT(*) AS n FROM episode'),
    units: one('SELECT COUNT(*) AS n FROM scan_units'),
    logs: one('SELECT COUNT(*) AS n FROM identify_logs'),
    dbBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`),
    icons: icons.count,
    iconBytes: icons.bytes,
    covers: covers.count,
    coverBytes: covers.bytes,
    posters: posters.count,
    posterBytes: posters.bytes
  }
}

/* ------------------------------- 重置 ------------------------------- */

export interface ResetSummary {
  projects: number
  software: number
  games: number
  videos: number
  /** 跟着影视条目一起清掉的集数。见 resetData 里数它的那一行 */
  episodes: number
  units: number
  icons: number
  covers: number
  posters: number
  /** 保留下来的存档备份记录数。磁盘上那些备份文件一个都没动，见下面的注释 */
  saveBackupsKept: number
  settingsCleared: boolean
}

/** 清空一个目录里的文件，返回删掉的个数。删不掉的跳过，不让一个占用中的文件挡住整次重置 */
function wipeDir(dir: string, whenBusy: string): number {
  let n = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name))
        n++
      } catch { // best-effort
        void whenBusy /* 正被渲染进程占用，删不掉就留着 */
      }
    }
  } catch { // best-effort
    /* 目录不存在，当作里面没东西 */
  }
  return n
}

/** 清空图标缓存目录，返回删掉的文件数 */
function clearIcons(): number {
  return wipeDir(iconsDir(), '下次识别会覆盖')
}

/**
 * 清空封面目录，返回删掉的文件数。
 *
 * **这不等于把封面当缓存看。** `clearIcons()` 可以随时调用，因为图标能重新提取；
 * 封面不能，它是用户亲手指的一张图。这个函数只在 `resetData()` 里调用，
 * 而且只因为同一次操作正在把每一条游戏记录一起删掉 ——
 * 封面文件名是 `<游戏 id>.<后缀>`，而 id 是重置时生成的 uuid，重扫一遍不会再生成同一个。
 * 也就是说这些文件在记录消失的那一刻就已经没有任何代码路径能读到它们了，
 * 留着不是「保住了用户的资产」，是在磁盘上攒一堆永远打不开的图。
 *
 * 反过来说，`clearIcons()` 至今没有、以后也不该碰 `coversDir()` ——
 * 「清空图标缓存」是个能单独发生的动作，那时候游戏记录还在，封面还读得到。
 */
function clearCovers(): number {
  return wipeDir(coversDir(), '下次换封面会覆盖')
}

/**
 * 清空海报目录，返回删掉的文件数。理由和 `clearCovers()` 一字不差：
 * 文件名是 `<条目 id>.<后缀>`，条目记录一删，这些图就再没有任何代码路径读得到。
 */
function clearPosters(): number {
  return wipeDir(postersDir(), '下次刮削会覆盖')
}

/**
 * 重置识别数据。
 *
 * mode = 'library'：清掉全部品类的条目、待识别目录、整理记录、图标缓存和封面，
 *   保留 API Key、搜索配置、扫描目录和自定义分类 —— 反复调 prompt 重测时用这个。
 * mode = 'all'：连设置和分类一起清掉，等于恢复出厂，会重新走引导流程。
 *
 * 两种模式都只动抱一自己的数据库，绝不碰你磁盘上的任何实际软件文件 ——
 * 已经整理过的文件夹留在整理后的位置，只是抱一不再记得它们原来在哪。
 *
 * **0.6 到 0.7 之间改掉的一件事**：原先这里限定 `kind = 'software'`，注释写的理由是
 * 「以后有了游戏、视频，『清空软件库』不该顺手把它们也清了」。那个理由针对的是一个
 * 并不存在的按钮 —— 这两个入口在全局设置页里，写的是「清空识别数据」和「恢复出厂」，
 * 没有一个是「清空软件库」。结果是用户点了「恢复出厂」、对话框说了会清空、
 * 走完引导之后游戏库里那些条目一条不少地站在原地。
 * 一个和界面说法不符的行为比少一个功能糟得多，所以改成清全部品类。
 * 真要做「只清当前模块」，那是给 resetData 加一个 kind 参数、并且按钮上得写清楚，
 * 不是靠这里悄悄限定一个品类。
 */
export function resetData(mode: 'library' | 'all'): ResetSummary {
  const d = getDb()

  const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n
  const projects = count("SELECT COUNT(*) AS n FROM resource WHERE kind='project'")
  const software = count('SELECT COUNT(*) AS n FROM software')
  const games = count('SELECT COUNT(*) AS n FROM game')
  // 影视条目和它下面的集数分开数：一部剧清掉的是一行，但用户感觉上没的是几十集。
  // 只报「1 个影视条目」会让人以为季集表还在
  const videos = count('SELECT COUNT(*) AS n FROM video')
  const episodes = count('SELECT COUNT(*) AS n FROM episode')
  const units = count('SELECT COUNT(*) AS n FROM scan_units')
  // 先数下来，因为下面刻意不删它 —— 报给用户的是「留了多少」，不是「清了多少」
  const saveBackupsKept = count('SELECT COUNT(*) AS n FROM save_backups')

  const tx = d.transaction(() => {
    // 打在 resource 上，各品类的私有表（software_meta / game_meta）靠 CASCADE 跟着走。
    // 不带 WHERE：所有品类一起清，理由见上面那段注释。
    //
    // save_backups 刻意**不在**这里 —— 它没有外键，所以这句 DELETE 碰不到它，
    // 而这正是当初不给它建外键的目的：那张表不是日志而是索引，每行的 backup_dir
    // 指向磁盘上一份真实存在的存档拷贝。删掉记录不会删掉那些文件，
    // 只会让用户再也找不到它们。「用户重置了抱一」不等于「用户愿意扔掉存档备份」。
    // 代价是留下一批孤儿行，等「孤儿备份清理」那一屏再回收；
    // 在那之前至少要让用户知道它们还在，所以 saveBackupsKept 进了 ResetSummary。
    d.prepare('DELETE FROM resource').run()
    d.prepare('DELETE FROM scan_units').run()
    d.prepare('DELETE FROM pending_software').run()
    d.prepare('DELETE FROM skip_list').run()
    // 没被认可过的 AI 标签跟着识别数据一起清；用户建的和确认过的是资产，留着。
    // 不再限定 kind：条目全清了，哪个品类的 AI 标签都一样没了主人
    d.prepare(`DELETE FROM tags WHERE source = 'ai'`).run()
    // 整理记录跟着软件条目一起清。0.3 时这里刻意留着它（「文件夹还在磁盘上，
    // 清掉记录等于让用户永远失去搬回去的办法」），但留下来的记录里 software_id
    // 全都指向已经不存在的条目 —— 撤销时找不到关联软件，整理页也只能显示一串空条目。
    // 一份读不懂的记录不比没有记录更有用，所以改成一起清。
    // 代价是清空后无法再自动撤销整理，这一点已经写进了重置对话框的提示里。
    d.prepare('DELETE FROM organize_plans').run()
    d.prepare('DELETE FROM video_organize_journal').run()
    d.prepare('DELETE FROM video_download_jobs').run()
    d.prepare('DELETE FROM image_download_jobs').run()
    d.prepare('DELETE FROM task_records').run()
    if (mode === 'all') {
      // Personal records are independent of library indexes. Only factory reset clears them.
      d.prepare('DELETE FROM personal_records').run()
      d.prepare('DELETE FROM skill_proposal').run()
      d.prepare('DELETE FROM workspace_sessions').run()
      d.prepare('DELETE FROM document_categories').run()
      d.prepare('DELETE FROM resource_links').run()
      // 识别日志只在恢复出厂时清。反复调 prompt 时要的正是「改之前那次是怎么判断的」，
      // 清空识别数据后还能拿旧日志对照，这是它最主要的用途
      d.prepare('DELETE FROM identify_logs').run()
      d.prepare('DELETE FROM identification_reports').run()
      d.prepare('DELETE FROM settings').run()
      d.prepare('DELETE FROM categories').run()
      d.prepare('DELETE FROM tags').run()
      d.prepare('DELETE FROM image_groups').run()
    }
  })
  tx()

  // 恢复出厂把内置分类、内置标签和版本号一并装回去。少了最后一项，下次启动
  // 会以为还没迁移过，白跑一遍重建。分类同样来自品类注册表，不是写死的
  if (mode === 'all') { seedDefaults(d, KINDS);migrateDocumentSchema(d,0); for (const kind of KINDS.filter(k => k.kind === 'image')) kind.schema.migrate?.(d, 0) }

  const icons = clearIcons()
  const covers = clearCovers()
  const posters = clearPosters()

  // 删完把 WAL 落盘并把文件收缩回去，不然 db 文件不会变小
  try {
    d.pragma('wal_checkpoint(TRUNCATE)')
    d.exec('VACUUM')
  } catch { // best-effort
    /* 收缩失败不影响数据已被清空这个事实 */
  }

  return {
    projects,
    software,
    games,
    videos,
    episodes,
    units,
    icons,
    covers,
    posters,
    saveBackupsKept,
    settingsCleared: mode === 'all'
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
