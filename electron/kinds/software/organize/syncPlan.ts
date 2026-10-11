/**
 * 整理目录的「读回来」那一层：把整理根下的文件夹结构读成一份布局，再和库里的
 * 记录对账，算出这次同步该做哪些事。
 *
 * 和 scanPlan.ts 同一个理由单独成文件 —— 它只读文件系统、不碰数据库、不碰
 * Electron，所以验证脚本能拿真实的临时目录树把它整个跑一遍。sync.ts 负责把
 * 这里算出来的结果落到库上。
 *
 * 这一层要回答三个问题：
 *   · 整理根下面现在有哪些分类文件夹、每个里面有哪些软件目录
 *   · 哪个软件目录是 junction（链接版），它指向哪儿
 *   · 一个还没入库的软件目录，主程序是哪个 exe
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { nestedInside, samePath, sanitizeFolder } from './plan.ts'
import { linkTargetOf } from './fsops.ts'

/** 和 scanPlan 的跳过名单保持一致 —— 两个遍历口径不同的话，同一棵树会读出两种结果 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information',
  'windows', 'winsxs', 'temp', 'tmp', 'cache', '__pycache__', '.cache'
])

/** 找主程序时最多下钻几层。再深就多半是 bin\、locales\ 这种了 */
const EXE_MAX_DEPTH = 3
/** 一个软件目录里最多看多少个 exe。防御性上限，正常软件几十个封顶 */
const EXE_MAX_COUNT = 200
/** 一个软件目录里最多访问多少个目录项 */
const WALK_MAX_ENTRIES = 20_000

/**
 * 一看就不是主程序的 exe。
 *
 * 选错了比选不到更糟 —— 卡片指向一个卸载器，用户点「启动」弹出来的是卸载向导。
 * 所以宁可一个都不选（那条目录进 skipped，用户手工添加）。
 */
const NOT_MAIN_EXE =
  /^(unins\d*|uninstall|setup|install|update|updater|crashpad_handler|vcredist.*|dxsetup|dotnetfx.*)\.exe$/i

export function skippableName(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')
}

export interface LayoutSoftware {
  /** 软件目录的绝对路径。是 junction 时这就是链接那一侧 */
  dir: string
  /** 所在分类文件夹名（整理根的直接子目录名） */
  category: string
  /** 目录名 */
  name: string
  is_link: boolean
  /** junction 指向的真实路径；读不到（链接失效）时为空串 */
  link_target: string
}

export interface OrganizeLayout {
  root: string
  /** 分类文件夹名，按 readdir 给的顺序 */
  categories: string[]
  software: LayoutSoftware[]
}

interface ChildDir {
  name: string
  full: string
  isLink: boolean
}

/**
 * 读一层的子目录。
 *
 * 链接的判断一律走 lstat，不信 Dirent：Windows 上 junction 在 readdir 里报成
 * 目录还是链接，Node 各版本和文件系统并不一致。这里判错的后果是「把链接当实体
 * 目录，进去找 exe」——那会一路走进真实安装目录。
 */
async function readChildDirs(dir: string): Promise<ChildDir[]> {
  // 不把权限错误当作空目录，否则会把整批记录误报为丢失。
  const entries = await fsp.readdir(dir, { withFileTypes: true })

  const out: ChildDir[] = []
  for (const e of entries) {
    if (skippableName(e.name)) continue
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const full = path.join(dir, e.name)

    let isLink: boolean
    let isDir: boolean
    try {
      const st = await fsp.lstat(full)
      isLink = st.isSymbolicLink()
      isDir = st.isDirectory()
    } catch {
      continue
    }
    if (!isLink && !isDir) continue
    if (isLink) {
      // 只收指向目录的链接。指向文件的符号链接不是软件目录
      try {
        if (!(await fsp.stat(full)).isDirectory()) continue
      } catch {
        // 目标没了：照样收，标成失效链接交给上层报告，而不是当它不存在
      }
    }
    out.push({ name: e.name, full, isLink })
  }
  return out
}

export async function scanOrganizeLayout(root: string): Promise<OrganizeLayout> {
  const layout: OrganizeLayout = { root, categories: [], software: [] }
  if (!root) return layout

  for (const cat of await readChildDirs(root)) {
    // 整理根那一层的链接不算分类目录：那是用户自己放的链接，
    // 当成分类会把它的目标整棵子树当成「分类里的软件」读进来
    if (cat.isLink) continue
    layout.categories.push(cat.name)
    for (const child of await readChildDirs(cat.full)) {
      layout.software.push({
        dir: child.full,
        category: cat.name,
        name: child.name,
        is_link: child.isLink,
        link_target: child.isLink ? await linkTargetOf(child.full) : ''
      })
    }
  }
  return layout
}

export interface ExeCandidate {
  path: string
  name: string
  /** 相对软件目录的层数，0 = 就在这一层 */
  depth: number
  size: number
}

/**
 * 挑主程序。判据按重要性排：
 *   1. 越浅越像主程序（主程序躺在 bin\ 里的有，但那是少数）
 *   2. 名字和目录名对得上（HBuilderX\HBuilderX.exe）
 *   3. 体积大的（主程序总比随附的小工具大）
 * 排序完全确定：同分按路径字典序，同一棵树跑两次结果必须一样。
 */
export function pickMainExe(dir: string, candidates: ExeCandidate[]): string {
  const usable = candidates.filter((c) => !NOT_MAIN_EXE.test(c.name))
  if (usable.length === 0) return ''

  const folder = sanitizeFolder(path.basename(dir)).toLowerCase()
  const matchesName = (c: ExeCandidate): boolean => {
    const base = path.basename(c.name, path.extname(c.name)).toLowerCase()
    if (!base) return false
    return base === folder || base.startsWith(folder) || folder.startsWith(base)
  }

  const sorted = [...usable].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    const an = matchesName(a) ? 0 : 1
    const bn = matchesName(b) ? 0 : 1
    if (an !== bn) return an - bn
    if (a.size !== b.size) return b.size - a.size
    return a.path.localeCompare(b.path)
  })
  return sorted[0].path
}

/** 广度优先收 exe：先浅后深，撞上数量上限时留下的也是浅的那批 */
async function collectExes(dir: string): Promise<ExeCandidate[]> {
  const out: ExeCandidate[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && out.length < EXE_MAX_COUNT && visited < WALK_MAX_ENTRIES) {
    const cur = queue.shift()!
    let entries
    try {
      entries = await fsp.readdir(cur.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (++visited > WALK_MAX_ENTRIES) break
      if (e.isSymbolicLink()) continue // 不跟进链接，免得绕回自己
      const full = path.join(cur.dir, e.name)
      if (e.isDirectory()) {
        if (!skippableName(e.name) && cur.depth + 1 <= EXE_MAX_DEPTH) {
          queue.push({ dir: full, depth: cur.depth + 1 })
        }
        continue
      }
      if (!e.isFile()) continue
      if (path.extname(e.name).toLowerCase() !== '.exe') continue
      let size = 0
      try {
        size = (await fsp.stat(full)).size
      } catch {
        /* 读不到就当 0，排序时自然排在后面 */
      }
      out.push({ path: full, name: e.name, depth: cur.depth, size })
      if (out.length >= EXE_MAX_COUNT) break
    }
  }
  return out
}

export async function findMainExe(dir: string): Promise<string> {
  return pickMainExe(dir, await collectExes(dir))
}

/** 对账时用到的记录字段。只取这几个，匹配逻辑不必知道 SoftwareItem 的全貌 */
export interface RecordRef {
  id: string
  /** 记录当前所在目录（source_dir，退回 exe 所在目录） */
  dir: string
  link_target: string
  exe_path: string
  category: string
  name: string
}

export type SkipReason = 'no-exe' | 'ambiguous'

export interface MatchPlan {
  /** 位置没动过的 */
  claimed: Array<{ id: string; name: string; dir: string; category: string }>
  /** 在资源管理器里挪过位置、被认回来的 */
  healed: Array<{ id: string; name: string; from: string; to: string; link_target: string; why: string; preserve_paths?: boolean }>
  /** 分类跟着文件夹改了 */
  recategorized: Array<{ id: string; name: string; from: string; to: string }>
  /** 新装进整理目录、库里还没有的 */
  added: Array<{ dir: string; category: string; name: string; exe: string }>
  /** 有目录但没能入库 */
  skipped: Array<{ dir: string; reason: SkipReason }>
  /** 没有任何记录指向的链接 */
  orphans: Array<{ dir: string; name: string; target: string; broken: boolean }>
  /** 记录还在、整理目录里的文件夹没了 */
  missing: Array<{ id: string; name: string; dir: string }>
}

const key = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/**
 * 把布局和记录对账。
 *
 * 顺序是有讲究的：**先把位置没动过的钉死，再谈启发式**。位置匹配是唯一不会
 * 认错的判据，先做完它，后面的「按名字」「按 exe」就没有机会把一条其实没动过的
 * 记录「修」到别处去 —— 那种错会把用户的路径指向一个不相干的目录。
 *
 * dirExists / findExe 从外面注入，这个函数本身不碰真实文件系统，验证脚本能
 * 拿假实现把每条分支都走一遍。
 */
export async function matchLayout(
  layout: OrganizeLayout,
  records: RecordRef[],
  dirExists: (p: string) => Promise<boolean>,
  findExe: (dir: string) => Promise<string> = findMainExe
): Promise<MatchPlan> {
  const plan: MatchPlan = {
    claimed: [], healed: [], recategorized: [], added: [], skipped: [], orphans: [], missing: []
  }
  const taken = new Set<string>() // 已被某个布局条目认领的目录
  const used = new Set<string>() // 已经匹配掉的记录

  const byDir = new Map<string, RecordRef[]>()
  for (const r of records) {
    const k = key(r.dir)
    const list = byDir.get(k)
    if (list) list.push(r)
    else byDir.set(k, [r])
  }

  // 第一步：位置没动过的
  for (const s of layout.software) {
    for (const hit of byDir.get(key(s.dir)) ?? []) {
      if (used.has(hit.id)) continue
      used.add(hit.id)
      taken.add(key(s.dir))
      if (!s.is_link && hit.link_target) {
        plan.healed.push({ id: hit.id, name: hit.name, from: hit.dir, to: s.dir,
          link_target: '', why: '原链接位置现为实体目录，清除旧链接状态' })
      } else {
        plan.claimed.push({ id: hit.id, name: hit.name, dir: s.dir, category: s.category })
      }
    }
  }

  // 第二步：链接被挪到别的分类下了 —— 靠 link_target 认。
  // junction 的目标没变，这是「还是同一条记录」的强证据
  for (const s of layout.software) {
    if (taken.has(key(s.dir)) || !s.is_link || !s.link_target) continue
    const candidates = records.filter(
      (r) => !used.has(r.id) && nestedInside(layout.root, r.dir) && r.link_target !== '' && samePath(r.link_target, s.link_target)
    )
    const destinations = layout.software.filter(d => d.is_link && samePath(d.link_target, s.link_target))
    if (candidates.length !== 1 || destinations.length !== 1) continue
    const hit = candidates[0]
    if (await dirExists(hit.dir)) continue
    used.add(hit.id)
    taken.add(key(s.dir))
    plan.healed.push({
      id: hit.id, name: hit.name, from: hit.dir, to: s.dir,
      link_target: s.link_target, why: '链接被挪到了别的分类下'
    })
  }

  // 按名字认领前先数一遍重名：同名两条时宁可不认，也不要把路径指错。
  // 指错的代价是把一条记录的 exe_path 改到一个不相干的目录上
  const dirNameCount = new Map<string, number>()
  for (const s of layout.software) {
    if (taken.has(key(s.dir)) || s.is_link) continue
    const k = s.name.toLowerCase()
    dirNameCount.set(k, (dirNameCount.get(k) ?? 0) + 1)
  }
  const recNameCount = new Map<string, number>()
  for (const r of records) {
    if (used.has(r.id) || !nestedInside(layout.root, r.dir)) continue
    const k = path.basename(r.dir).toLowerCase()
    recNameCount.set(k, (recNameCount.get(k) ?? 0) + 1)
  }

  // 第三步：剩下的目录逐个处理
  for (const s of layout.software) {
    if (taken.has(key(s.dir))) continue

    if (s.is_link) {
      // 走到这里说明没有任何记录指向它
      plan.orphans.push({ dir: s.dir, name: s.name, target: s.link_target, broken: s.link_target === '' })
      continue
    }

    const nameKey = s.name.toLowerCase()
    const dirsWithName = dirNameCount.get(nameKey) ?? 0
    const recsWithName = recNameCount.get(nameKey) ?? 0
    if (recsWithName > 0 && dirsWithName > 1) {
      taken.add(key(s.dir))
      plan.skipped.push({ dir: s.dir, reason: 'ambiguous' })
      continue
    }
    if (dirsWithName === 1 && recsWithName >= 1) {
      // 目录名对得上、原位置又已经不在了：用户在资源管理器里挪了文件夹。
      // 「原位置不在」这一条不能省 —— 少了它，一条还在扫描目录里好好待着的记录
      // 会被同名文件夹凭空「搬」进整理目录，而磁盘上什么都没发生
      const byName = records.find(
        (r) =>
          !used.has(r.id) &&
          nestedInside(layout.root, r.dir) &&
          path.basename(r.dir).toLowerCase() === nameKey &&
          !samePath(r.dir, s.dir)
      )
      if (byName) {
        if (recsWithName > 1) {
          taken.add(key(s.dir))
          plan.skipped.push({ dir: s.dir, reason: 'ambiguous' })
          continue
        }
        if (!(await dirExists(byName.dir))) {
          used.add(byName.id)
          taken.add(key(s.dir))
          plan.healed.push({
            id: byName.id, name: byName.name, from: byName.dir, to: s.dir,
            link_target: '', why: '文件夹被挪到了别的分类下'
          })
          continue
        }
      }
    }

    const exe = await findExe(s.dir)
    if (!exe) {
      taken.add(key(s.dir))
      plan.skipped.push({ dir: s.dir, reason: 'no-exe' })
      continue
    }

    // 同一个 exe 已经在库里了（比如它本来就在扫描目录里被收过）→ 认领，不新插
    const byExe = records.find((r) => !used.has(r.id) && samePath(r.exe_path, exe))
    if (byExe) {
      used.add(byExe.id)
      taken.add(key(s.dir))
      plan.healed.push({
        id: byExe.id, name: byExe.name, from: byExe.dir, to: s.dir,
        link_target: '', why: '确认主程序所属的软件根目录', preserve_paths: true
      })
      continue
    }

    taken.add(key(s.dir))
    plan.added.push({ dir: s.dir, category: s.category, name: s.name, exe })
  }

  // 第四步：记录还在、整理目录里的文件夹没了
  for (const r of records) {
    if (used.has(r.id)) continue
    if (!nestedInside(layout.root, r.dir)) continue
    if (await dirExists(r.dir)) continue
    plan.missing.push({ id: r.id, name: r.name, dir: r.dir })
  }

  // 第五步：认领了的那些，分类跟着文件夹走（文件夹即真相）
  const matched = [...plan.claimed, ...plan.healed.map(h => ({
    id: h.id, name: h.name, category: layout.software.find(s => samePath(s.dir, h.to))!.category
  }))]
  for (const c of matched) {
    const rec = records.find((r) => r.id === c.id)
    if (rec && rec.category !== c.category) {
      plan.recategorized.push({ id: c.id, name: c.name, from: rec.category, to: c.category })
    }
  }

  return plan
}
