/**
 * 存档备份与还原。
 *
 * 这是游戏模块唯一会**改写用户磁盘**的一段，规矩照抄整理模块那一层
 * （organize/fsops.ts），并且共用同一份复制校验（services/fstree.ts）：
 *
 *   · 备份：复制 → 逐文件校验 → 才记账。校验不过就把半成品删掉，不留记录 ——
 *     一条指向残缺拷贝的记录比没有记录更坏，用户会以为自己有备份。
 *   · 还原：先把**当前存档**自动备份一份，再动手。用户点「还原」时想的是
 *     「回到那天」，不是「把今天玩的进度扔掉」；万一还原的是错的那一份，
 *     没有这一步就再也回不来了。
 *   · 还原走「复制到临时目录 → 校验 → 换名就位」，不做原地覆盖。
 *     原地覆盖崩在中途，用户的存档目录会是半新半旧的一锅粥。
 *
 * 和 db.ts / scanner.ts / tools.ts 一样只收 SqlDb 和一个 backupRoot，不 import
 * services/database.ts —— 那条链路依赖 electron 和 better-sqlite3，一旦引进来，
 * 整套备份就只能在应用跑起来之后才验证得了。而这是最不该靠手点来验证的一段。
 */

import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
import type { SaveBackup, SaveBackupResult, SaveRestoreResult } from '../../../src/types'
import type { SqlDb } from '../../services/schema.ts'
import {
  exists,
  isDriveRoot,
  nestedInside,
  sanitizeFolder,
  tallyTree,
  verifyCopy,
  walkTree
} from '../../services/fstree.ts'

/** 备份目录里存放存档拷贝的子目录名 */
export const PAYLOAD = 'save'
/** 备份目录里那份说明文件 */
export const MANIFEST = 'backup.json'
/** 还原时的临时目录后缀。留在存档目录旁边，同盘才能靠改名就位 */
const RESTORE_TMP = '.baoyi_restore_tmp'
/** 被换下来的旧存档的临时名。换名成功后才删，删之前它是唯一的退路 */
const REPLACED_TMP = '.baoyi_replaced_tmp'

/* ============================== 命名 ============================== */

/** `20260829-143012`。本地时间 —— 用户在资源管理器里看到它，UTC 会差 8 小时 */
export function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * 一个游戏在备份根下的文件夹名：`游戏名_id 前 6 位`。
 *
 * 带 id 尾巴是因为游戏名不唯一也不稳定 —— 两个「重制版」可以叫同一个名字，
 * 而用户随时会在详情页改名。名字给人看，尾巴保证同一条记录始终落在同一个
 * 文件夹里，改名之后旧备份不会变成一个找不到主人的孤儿目录。
 */
export function gameFolder(g: GameLike): string {
  const name = sanitizeFolder(g.name_zh || g.name_en || g.file_name.replace(/\.exe$/i, ''), 'Game')
  return `${name}_${g.id.slice(0, 6)}`
}

/**
 * 一次备份的目录名：`时间戳_存档目录名`。
 *
 * 带上存档目录名是因为一个游戏可以有好几条存档路径（本体存档 + 配置 + 云同步
 * 缓存），列表上只看时间戳分不出哪次备的是哪一条。
 */
export function backupFolder(savePath: string, at: number): string {
  const leaf = sanitizeFolder(path.basename(savePath.replace(/[\\/]+$/, '')), 'save')
  return `${stamp(at)}_${leaf}`
}

/** 备份记录和游戏名之间只需要这几个字段，写成结构类型好让自检传字面量 */
export interface GameLike {
  id: string
  name_zh: string
  name_en: string
  file_name: string
}

/* ============================== 护栏 ============================== */

/**
 * 系统目录，一律不许作为还原目标。
 *
 * 存档路径的来源有两条：模型验过的（已经过 scanner.ts 的白名单）和用户在对话框里
 * 亲自指的（对话框不设限）。后者可以是任何地方，包括手滑点到 `C:\Windows`。
 * 备份是只读的，指错了只是白备一份；**还原是写**，指错了是把系统目录清空重建。
 */
function systemish(target: string): string {
  const t = path.resolve(target).toLowerCase()
  const win = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
  const guards = [
    win,
    (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase(),
    (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase(),
    (process.env.ProgramData || 'C:\\ProgramData').toLowerCase()
  ]
  for (const g of guards) if (nestedInside(g, t)) return g
  return ''
}

/**
 * 这个路径能不能作为还原目标。返回一句拒绝的理由，能还原时返回空串。
 *
 * 抽成独立的纯函数是刻意的：它是「会不会把用户的东西删掉」这个问题的全部答案，
 * 而它不碰磁盘，所以自检能把每一种拒绝都验一遍，不必真造一个 C:\Windows 出来。
 */
export function restoreBlocked(target: string, backupRoot: string): string {
  if (!target.trim()) return '这条备份没有记下存档路径，无法还原'
  if (!path.isAbsolute(target)) return `存档路径不是绝对路径，无法还原：${target}`
  if (isDriveRoot(target)) return `存档路径是盘根（${target}），还原会覆盖整个磁盘，已拒绝`

  const sys = systemish(target)
  if (sys) return `存档路径落在系统目录 ${sys} 之下，已拒绝还原：${target}`

  // 备份根在还原目标里面：还原第一步就会把备份自己删掉，包括正要还原的这一份
  if (backupRoot && nestedInside(target, backupRoot)) {
    return `备份根 ${backupRoot} 在存档路径里面，还原会把备份本身删掉，已拒绝`
  }
  return ''
}

/** 备份前的检查。和还原共用一部分，但备份只读，门槛低一档 */
function backupBlocked(savePath: string, backupRoot: string): string {
  if (!backupRoot) return '还没设置存档备份目录，先去设置 › 数据管理里指一个'
  if (!savePath.trim()) return '存档路径是空的，没有可备份的内容'
  // 存档目录在备份根里面 → 复制会一边读一边往自己里面写，走到磁盘满为止
  if (nestedInside(backupRoot, savePath)) {
    return `存档路径在备份根 ${backupRoot} 里面，备份会自我嵌套，已拒绝`
  }
  if (nestedInside(savePath, backupRoot)) {
    return `备份根 ${backupRoot} 在存档路径里面，备份会自我嵌套，已拒绝`
  }
  return ''
}

/* ============================== 备份 ============================== */

/**
 * 存档是一个目录还是单个文件。
 *
 * 两者都真实存在：新一些的游戏存一整个目录，老游戏、RPG Maker、模拟器
 * 常常就是一个 `.sav`。detect_save_path 两种都收（probeSave 认 isFile），
 * 所以备份和还原也必须两种都会处理 —— 少处理一种等于「有一类游戏备份不了」。
 */
export type SaveShape = 'dir' | 'file'

interface Manifest {
  game: string
  game_id: string
  save_path: string
  /** 载荷里那份东西原本的形状。还原时靠它决定是铺开一个目录还是写回一个文件 */
  shape: SaveShape
  created_at: string
  note: string
  by: string
}

/**
 * 读回说明文件。读不到就返回 null —— 手工删过、或者是将来某个版本写的新格式，
 * 都不该让还原直接失败，调用方会退回从载荷形状去推断。
 */
async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, MANIFEST), 'utf-8')
    const parsed = JSON.parse(raw) as Manifest
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 这份载荷该按目录还原还是按文件还原。
 *
 * 优先信说明文件；它不在时看载荷长什么样 —— 里面只有一个文件、且文件名和
 * 存档路径的最后一段相同，那就是当初备的单文件存档。两条都不成立时按目录办，
 * 因为目录是绝大多数情况，而按目录还原一个单文件存档只会失败，不会写坏东西。
 */
async function shapeOf(backupDir: string, savePath: string): Promise<SaveShape> {
  const manifest = await readManifest(backupDir)
  if (manifest?.shape === 'file' || manifest?.shape === 'dir') return manifest.shape

  const leaf = path.basename(savePath.replace(/[\\/]+$/, '')).toLowerCase()
  try {
    const entries = await fsp.readdir(path.join(backupDir, PAYLOAD), { withFileTypes: true })
    if (entries.length === 1 && entries[0].isFile() && entries[0].name.toLowerCase() === leaf) {
      return 'file'
    }
  } catch {
    /* 读不到就按目录办 */
  }
  return 'dir'
}

/**
 * 说明文件写在**载荷目录之外**（备份目录根上），不能写进 save/ 里面。
 *
 * 写进去的话，还原时它会跟着被复制回用户的存档目录 —— 一个游戏的存档目录里
 * 凭空多出一个 backup.json，轻则用户困惑，重则某些游戏会把它当成损坏的存档。
 */
async function writeManifest(dir: string, m: Manifest): Promise<void> {
  await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(m, null, 2), 'utf-8').catch(() => {
    /* 说明文件写不进去不该让备份算失败 —— 拷贝本身已经校验过了 */
  })
}

/** 单文件的复制校验：比大小。和目录那边同一个标准（见 fstree.ts 的 diffTrees） */
async function verifyFile(from: string, to: string, expected: number): Promise<string> {
  try {
    const size = (await fsp.stat(to)).size
    return size === expected ? '' : `复制校验失败：${path.basename(from)} 大小不一致`
  } catch {
    return `复制校验失败：目标缺少 ${path.basename(from)}`
  }
}

/** 同一秒里备第二次时给目录名让个位，绝不合并进已有的备份目录 */
async function freeDir(base: string): Promise<string> {
  if (!(await exists(base))) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!(await exists(candidate))) return candidate
  }
  return ''
}

export interface BackupOptions {
  /** 备份根目录，由调用方（service.ts）从设置里取并保证存在 */
  backupRoot: string
  /** 记在说明文件里，用来区分手动备份和还原前的自动备份 */
  note?: string
  /** 覆盖时间戳，只有自检需要 */
  now?: number
}

/**
 * 失败结果。`over` 恒为空数组：没备份成功，自然也没有新的超额。
 *
 * 保留上限是设置项，只有 service 层拿得到，所以 `over` 由调用方在成功之后填。
 */
function noBackup(message: string): SaveBackupResult {
  return { ok: false, message, backup: null, over: [] }
}

/**
 * 把一条存档路径备份一份。
 *
 * 先复制、再校验、最后才写库。反过来的话（先记账后复制），中途失败会留下一条
 * 指向不存在或残缺目录的记录，而用户看到列表里有一行就以为自己有备份了。
 */
export async function createBackup(
  d: SqlDb,
  game: GameLike,
  savePath: string,
  opts: BackupOptions
): Promise<SaveBackupResult> {
  const blocked = backupBlocked(savePath, opts.backupRoot)
  if (blocked) return noBackup(blocked)

  const source = path.resolve(savePath)
  let stat: Stats
  try {
    stat = await fsp.stat(source)
  } catch {
    return noBackup(`存档已经不在了：${source}`)
  }

  const shape: SaveShape = stat.isDirectory() ? 'dir' : 'file'
  if (shape === 'dir') {
    const src = await walkTree(source).catch(() => null)
    if (!src) return noBackup(`读不到存档目录：${source}`)
    if (src.size === 0) {
      // 空目录备下来是一份「看起来有、其实没有」的备份，正是这个模块最该避免的东西
      return noBackup(`存档目录里一个文件都没有，没有备份的必要：${source}`)
    }
  } else if (stat.size === 0) {
    return noBackup(`这个存档文件是空的，没有备份的必要：${source}`)
  }

  const at = opts.now ?? Date.now()
  const holder = path.join(opts.backupRoot, gameFolder(game))
  const dir = await freeDir(path.join(holder, backupFolder(source, at)))
  if (!dir) return noBackup('同一秒里备份了太多次，稍等一下再试')

  const payload = path.join(dir, PAYLOAD)
  // 单文件存档也放进 save/ 里，保持「载荷永远是一个目录」——
  // 于是还原、删除、算体量那几条路只有一种形状要处理
  const landing = shape === 'dir' ? payload : path.join(payload, path.basename(source))
  try {
    await fsp.mkdir(shape === 'dir' ? dir : payload, { recursive: true })
    await fsp.cp(source, landing, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true
    })
  } catch (err: any) {
    // 半成品必须清掉：留着它，下一次同名备份会被 freeDir 让位，用户则多一个空壳目录
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    return noBackup(`复制失败：${err?.code ?? err?.message ?? '未知错误'}`)
  }

  const bad =
    shape === 'dir'
      ? await verifyCopy(source, landing)
      : await verifyFile(source, landing, stat.size)
  if (bad) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    return noBackup(bad)
  }

  // 体量按**拷贝**算而不是按源算：记录描述的是这份备份，源在这之后还会变
  const { files, bytes } = tallyTree(await walkTree(payload))
  const name = game.name_zh || game.name_en || game.file_name
  await writeManifest(dir, {
    game: name,
    game_id: game.id,
    save_path: source,
    shape,
    created_at: new Date(at).toISOString(),
    note: opts.note ?? '',
    by: '抱一'
  })

  const backup: SaveBackup = {
    id: randomUUID(),
    resource_id: game.id,
    save_path: source,
    backup_dir: dir,
    size_bytes: bytes,
    file_count: files,
    created_at: at
  }
  d.prepare(
    `INSERT INTO save_backups
       (id, resource_id, save_path, backup_dir, size_bytes, file_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    backup.id,
    backup.resource_id,
    backup.save_path,
    backup.backup_dir,
    backup.size_bytes,
    backup.file_count,
    backup.created_at
  )

  // over 留空由 service 填：这里不知道保留上限
  return { ok: true, message: `已备份 ${files} 个文件`, backup, over: [] }
}

/* ============================== 读 ============================== */

function rowToBackup(row: Record<string, any>): SaveBackup {
  return {
    id: String(row.id),
    resource_id: String(row.resource_id),
    save_path: String(row.save_path ?? ''),
    backup_dir: String(row.backup_dir ?? ''),
    size_bytes: Number(row.size_bytes) || 0,
    file_count: Number(row.file_count) || 0,
    created_at: Number(row.created_at) || 0
  }
}

/** 一个游戏的备份，新的在前 */
export function listBackups(d: SqlDb, resourceId: string): SaveBackup[] {
  const rows = d
    .prepare('SELECT * FROM save_backups WHERE resource_id = ? ORDER BY created_at DESC')
    .all(resourceId) as Array<Record<string, any>>
  return rows.map(rowToBackup)
}

export function getBackup(d: SqlDb, id: string): SaveBackup | null {
  const row = d.prepare('SELECT * FROM save_backups WHERE id = ?').get(id) as
    | Record<string, any>
    | undefined
  return row ? rowToBackup(row) : null
}

/** 保留上限的默认值。0 = 不限，界面上写「不限」 */
export const DEFAULT_KEEP = 10

/**
 * 超出保留上限的那几份，**最旧的在前**。没超出就是空数组。
 *
 * 按 (游戏, 存档路径) 一组算，不按游戏整体算：一个游戏可以有本体存档、配置、
 * 云同步缓存好几条路径，按游戏算会让备份得勤的那条把另一条挤掉。
 *
 * 这个函数只**回答问题**，一个字节都不删。删除交给调用方 —— 界面拿到这份名单
 * 之后要先问用户。自动删是用户明确否掉的做法（「定时替他决定留哪几份、删哪几份，
 * 等于替他扔东西」），所以这里连一个「顺手删掉」的重载都不留。
 */
export function overRetention(
  d: SqlDb,
  resourceId: string,
  savePath: string,
  keep: number
): SaveBackup[] {
  if (!Number.isFinite(keep) || keep <= 0) return [] // 0 或非法值 = 不限
  const rows = d
    .prepare(
      `SELECT * FROM save_backups
       WHERE resource_id = ? AND save_path = ?
       ORDER BY created_at ASC`
    )
    .all(resourceId, savePath) as Array<Record<string, any>>
  const all = rows.map(rowToBackup)
  return all.length > keep ? all.slice(0, all.length - keep) : []
}

/* ============================== 删 ============================== */

/**
 * 删一条备份：先删磁盘上的目录，再删记录。
 *
 * 顺序和备份时相反，理由同样是「不留下对不上的账」：目录删不掉时记录必须留着，
 * 否则那几个 GB 会永远躺在备份根里，而用户再也没有入口能看到它。
 */
export async function deleteBackup(d: SqlDb, id: string): Promise<{ ok: boolean; message: string }> {
  const backup = getBackup(d, id)
  if (!backup) return { ok: false, message: '找不到这条备份记录' }

  if (backup.backup_dir && (await exists(backup.backup_dir))) {
    try {
      await fsp.rm(backup.backup_dir, { recursive: true, force: true })
    } catch (err: any) {
      return {
        ok: false,
        message: `备份目录删不掉（${err?.code ?? '被占用'}），记录先留着：${backup.backup_dir}`
      }
    }
  }
  d.prepare('DELETE FROM save_backups WHERE id = ?').run(id)
  return { ok: true, message: '已删除这份备份' }
}

/* ============================== 还原 ============================== */

/**
 * 把一份备份还原回存档目录。
 *
 * 五步，顺序是这个函数存在的全部意义：
 *   1. 确认备份本体还在（用户可能手工删过备份根里的目录）
 *   2. 过还原护栏 —— 目标不能是盘根、系统目录、或包着备份根
 *   3. 当前存档不为空时，先自动备份一份。失败就整个中止，不动任何东西
 *   4. 复制到存档目录旁边的临时目录并校验
 *   5. 旧的改名让位 → 临时目录改名就位 → 才删旧的
 *
 * 第 5 步的三次改名换来一个性质：任何一步失败，磁盘上都还有一份完整的存档 ——
 * 要么是旧的，要么是新的，不会是半新半旧。
 */
export async function restoreBackup(
  d: SqlDb,
  id: string,
  game: GameLike | null,
  opts: BackupOptions
): Promise<SaveRestoreResult> {
  const fail = (message: string): SaveRestoreResult => ({ ok: false, message, safety: null })

  const backup = getBackup(d, id)
  if (!backup) return fail('找不到这条备份记录')

  const payload = path.join(backup.backup_dir, PAYLOAD)
  if (!(await exists(payload))) {
    return fail(
      `备份内容已经不在磁盘上了（${payload}）。` +
        `记录先留着，确认那个目录真的没了就在列表里删掉它。`
    )
  }

  const target = path.resolve(backup.save_path)
  const blocked = restoreBlocked(target, opts.backupRoot)
  if (blocked) return fail(blocked)
  // 备份载荷在目标里面：改名换位会把备份自己一起搬走
  if (nestedInside(target, backup.backup_dir)) {
    return fail(`备份目录在存档路径里面，还原会把它自己覆盖掉，已拒绝：${backup.backup_dir}`)
  }

  /* -------- 第 3 步：当前存档先留一份 -------- */
  //
  // 「当前存档有东西吗」必须分目录和单文件两种问法。原先只用 walkTree 问，
  // 而 walkTree 对着一个文件会抛（readdir 一个文件），异常被 catch 吞掉之后
  // 结论是「没东西，不用备份」—— 单文件存档会被直接覆盖掉，而这一步的存在
  // 就是为了让还原有退路。这是整个函数里最不能错的一句判断。
  let safety: SaveBackup | null = null
  if (await hasContent(target)) {
    const made = await createBackup(d, game ?? orphan(target), target, {
      ...opts,
      note: '还原前自动备份'
    })
    if (!made.ok) {
      return fail(`还原中止：当前存档没能先备份下来（${made.message}）。原存档一个字没动。`)
    }
    safety = made.backup
  }

  /* -------- 第 4 步：复制到旁边并校验 -------- */
  const shape = await shapeOf(backup.backup_dir, backup.save_path)
  // 单文件存档的载荷是 save/<文件名>，目录存档的载荷就是 save/ 本身
  let origin = payload
  if (shape === 'file') {
    const inner = path.join(payload, path.basename(target))
    if (!(await exists(inner))) {
      // 存档路径的最后一段改过（用户改了文件名）时退回「载荷里唯一那个文件」
      const only = await soleFile(payload)
      if (!only) {
        return {
          ok: false,
          message: `这份备份记的是单个存档文件，但载荷里找不到它：${inner}`,
          safety: null
        }
      }
      origin = only
    } else {
      origin = inner
    }
  }

  const staging = `${target}${RESTORE_TMP}`
  const replaced = `${target}${REPLACED_TMP}`
  for (const [p, label] of [[staging, '临时'], [replaced, '暂存']] as const) {
    if (await exists(p)) {
      return {
        ok: false,
        message: `${label}目录 ${p} 已存在，可能是上一次还原中断留下的。请先手工清理。`,
        safety
      }
    }
  }

  try {
    await fsp.mkdir(path.dirname(staging), { recursive: true })
    await fsp.cp(origin, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true
    })
  } catch (err: any) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, message: `复制备份失败：${err?.code ?? err?.message ?? '未知错误'}`, safety }
  }

  const bad =
    shape === 'dir'
      ? await verifyCopy(origin, staging)
      : await verifyFile(origin, staging, (await fsp.stat(origin)).size)
  if (bad) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, message: `${bad}（原存档一个字没动）`, safety }
  }

  /* -------- 第 5 步：三次改名 -------- */
  const hadOld = await exists(target)
  if (hadOld) {
    try {
      await fsp.rename(target, replaced)
    } catch (err: any) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        message:
          `原存档目录腾不开位置（${err?.code ?? '被占用'}）—— 游戏可能正在运行，先关掉再试。` +
          `原存档一个字没动。`,
        safety
      }
    }
  }

  try {
    await fsp.rename(staging, target)
  } catch (err: any) {
    // 换位失败：把旧的搬回来，回到操作前的状态
    if (hadOld) await fsp.rename(replaced, target).catch(() => {})
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, message: `就位失败：${err?.code ?? err?.message ?? '未知错误'}`, safety }
  }

  const files =
    shape === 'dir' ? tallyTree(await walkTree(target).catch(() => new Map())).files : 1
  // 到这里新存档已经就位，旧的那份只是垃圾了。删不掉也算成功，但要说清楚在哪
  let note = ''
  if (hadOld) {
    try {
      await fsp.rm(replaced, { recursive: true, force: true })
    } catch {
      note = `　旧存档没能清掉，留在 ${replaced}，可手工删除`
    }
  }

  return {
    ok: true,
    message:
      `已还原 ${files} 个文件到 ${target}` +
      (safety ? `　还原前的存档已备份为「${stamp(safety.created_at)}」` : '') +
      note,
    safety
  }
}

/**
 * 这个路径下现在有没有东西值得备份。目录看有没有文件，单文件看它是不是空的。
 *
 * 判据和 createBackup 的拒绝条件刻意一致：那边拒绝空目录和空文件，这边也就
 * 不为它们去备份。两处说的是同一句话 —— 「空的等于没有」。
 */
async function hasContent(target: string): Promise<boolean> {
  let stat: Stats
  try {
    stat = await fsp.stat(target)
  } catch {
    return false
  }
  if (!stat.isDirectory()) return stat.size > 0
  const listing = await walkTree(target).catch(() => null)
  return listing !== null && listing.size > 0
}

/** 载荷里唯一的那个文件，不止一个就返回空串 */
async function soleFile(payload: string): Promise<string> {
  try {
    const entries = await fsp.readdir(payload, { withFileTypes: true })
    const files = entries.filter((e) => e.isFile())
    return entries.length === 1 && files.length === 1 ? path.join(payload, files[0].name) : ''
  } catch {
    return ''
  }
}

/**
 * 记录还在、游戏条目已被移除时的替身。
 *
 * 这不是防御性编程：save_backups 刻意不给 resource_id 建外键（见 schema.ts），
 * 所以「游戏已移除、备份还在」是设计出来的正常状态，而不是坏数据。
 */
function orphan(savePath: string): GameLike {
  const leaf = path.basename(savePath.replace(/[\\/]+$/, '')) || 'save'
  return { id: 'orphan', name_zh: leaf, name_en: '', file_name: leaf }
}
