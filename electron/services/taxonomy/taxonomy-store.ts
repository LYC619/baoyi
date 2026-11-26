import { parseJsonArray } from '../system/json.ts'
import { randomUUID } from 'node:crypto'
import { reconcileResourceCategories } from './resource-taxonomy.ts'
import { insertTag } from '../storage/schema.ts'
import { FALLBACK_CATEGORY } from './taxonomy.ts'
import type { Category, Tag, TagSource } from '../../../src/types/index.ts'
import type { SqlDb, SqlStatement } from '../storage/schema.ts'
import { transaction } from '../../workspace/validation.ts'

type Row = Record<string, any>

/* ------------------------------- 分类 ------------------------------- */

/**
 * 分类 / 标签一律按 kind 收口。
 *
 * 0.6 之前 categories 和 tags 是全局单表，加游戏模块时才发现这条缝：
 * listCategories() 和 tagPool() 直接喂给软件的识别 prompt（见 aiService.ts），
 * 游戏的「RPG」「魂系」一旦进表，agent 就会拿它们去归类一个调试器。
 *
 * 默认值定成 'software' 是有意的：软件模块那几十处调用和整条 IPC / 渲染进程
 * 链路因此一个字都不用改，加 kind 的改动全压在游戏这一侧。
 */
const DEFAULT_KIND = 'software'

export function listCategories(d: SqlDb, kind: string = DEFAULT_KIND): Category[] {
  reconcileResourceCategories(d,kind)
  return d
    .prepare(
      `SELECT id, name, description, icon, sort_order FROM categories
       WHERE kind = ? ORDER BY sort_order, name`
    )
    .all(kind) as Category[]
}

/** 一条分类属于哪个品类。改名 / 删除时要按它把影响范围圈住 */
function categoryKind(d: SqlDb, id: string): string {
  const row = d.prepare('SELECT kind FROM categories WHERE id = ?').get(id) as Row | undefined
  return (row?.kind as string) ?? DEFAULT_KIND
}

export function upsertCategory(d: SqlDb, c: Category, kind: string = DEFAULT_KIND): Category[] {

  const id = c.id || randomUUID()
  const name = c.name.trim()
  if (!name) throw new Error('分类名称不能为空')

  const targetKind = transaction(d, () => {
    const previous = d.prepare('SELECT name, kind FROM categories WHERE id = ?').get(id) as Row | undefined
    const target = (previous?.kind as string) ?? kind
    if (previous?.name !== name && d.prepare('SELECT 1 FROM categories WHERE kind = ? AND name = ? AND id != ?').get(target,name,id)) {
      throw new Error('已经有同名分类了')
    }
    d.prepare(
      `INSERT INTO categories (id, kind, name, description, icon, sort_order)
       VALUES (@id, @kind, @name, @description, @icon, @sort_order)
       ON CONFLICT(id) DO UPDATE SET
         name = @name, description = @description, icon = @icon, sort_order = @sort_order`
    ).run({ ...c, id, name, kind: target, description: c.description ?? '', icon: c.icon ?? '' })

    // 分类是靠名字挂在条目上的，改名必须把引用一起改，否则一改名条目全掉进「其他」。
    // 限定 kind：软件和游戏可以各有一个叫「其他」的格子，改一边不该动到另一边
    if (previous && previous.name !== name) {
      d.prepare('UPDATE resource SET category = ? WHERE kind = ? AND category = ?').run(
        name,
        target,
        previous.name
      )
      if (target === DEFAULT_KIND) {
        d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(name, previous.name)
      }
    }
    return target
  })

  return listCategories(d, targetKind)
}

export function removeCategory(d: SqlDb, id: string): Category[] {

  const row = d.prepare('SELECT name, kind FROM categories WHERE id = ?').get(id) as Row | undefined
  const kind = (row?.kind as string) ?? DEFAULT_KIND
  if (row) {
    // 分类是虚拟的，删除时把归属条目退回「其他」，不动实际文件。
    // 同样限定 kind —— 两个品类各有一个「其他」，别把对方的条目也扫进来
    transaction(d, () => {
      d.prepare('UPDATE resource SET category = ? WHERE kind = ? AND category = ?').run(
        FALLBACK_CATEGORY,
        kind,
        row.name
      )
      if (kind === DEFAULT_KIND) {
        d.prepare('UPDATE pending_software SET category = ? WHERE category = ?').run(FALLBACK_CATEGORY, row.name)
      }
      d.prepare('DELETE FROM categories WHERE id = ?').run(id)
    })

  }
  return listCategories(d, kind)
}

/**
 * 上下挪一格。和相邻那条交换 sort_order 即可 —— 拖拽排序留给以后，
 * 这个按钮能到达完全一样的顺序，还能用键盘操作。
 */
export function moveCategory(d: SqlDb, id: string, delta: number): Category[] {
  const kind = categoryKind(d, id)
  const list = listCategories(d, kind)
  const from = list.findIndex((c) => c.id === id)
  const to = from + (delta < 0 ? -1 : 1)
  if (from < 0 || to < 0 || to >= list.length) return list

  const reordered = [...list]
  ;[reordered[from], reordered[to]] = [reordered[to], reordered[from]]


  const stmt = d.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
  // 整体重排一遍，顺便把历史上重复 / 空缺的 sort_order 抹平
  transaction(d, () => reordered.forEach((c, i) => stmt.run(i + 1, c.id)))

  return listCategories(d, kind)
}

/* ------------------------------- 标签 ------------------------------- */

/**
 * 每个标签实际被多少条目用着。
 *
 * ponytail: 规划里 tags 表带一个 usage_count 列，这里改成读的时候现算。
 * 标签存在 software.tags 的 JSON 数组里，详情页随手一改就会让计数列失真，
 * 而这个数字的唯一用途恰恰是「找出只挂着一个条目的碎片标签」—— 失真就没意义了。
 * 数据量在千级，一次全表扫描的代价可以忽略。
 */
function tagUsage(d: SqlDb, kind: string): Map<string, number> {
  const map = new Map<string, number>()
  const rows = d
    .prepare('SELECT tags FROM resource WHERE kind = ? AND is_archived = 0')
    .all(kind) as Row[]
  for (const r of rows) {
    for (const t of parseJsonArray(r.tags).filter((value): value is string => typeof value === 'string')) map.set(t, (map.get(t) ?? 0) + 1)
  }
  return map
}

export function listTags(d: SqlDb, kind: string = DEFAULT_KIND): Tag[] {

  const usage = tagUsage(d, kind)
  const rows = d.prepare('SELECT * FROM tags WHERE kind = ? ORDER BY name').all(kind) as Row[]
  return rows
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      source: (r.source ?? 'ai') as TagSource,
      usage_count: usage.get(r.name) ?? 0,
      created_at: r.created_at as number
    }))
    .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 注入 prompt 的标签池：只给用户认可过的。
 * agent 自己造的（source='ai'）不进池 —— 否则它造一个新词，下一轮就当成既成事实
 * 继续沿用，标签只会越长越碎，而这正是标签池要防的事。
 */
export function tagPool(d: SqlDb, kind: string = DEFAULT_KIND): string[] {
  return (
    d
      .prepare(
        `SELECT name FROM tags WHERE kind = ? AND source IN ('user','confirmed') ORDER BY name`
      )
      .all(kind) as Row[]
  ).map((r) => r.name as string)
}

/** 一条标签属于哪个品类。改名 / 合并 / 删除都要按它把影响范围圈住 */
function tagKind(d: SqlDb, id: number): string {
  const row = d.prepare('SELECT kind FROM tags WHERE id = ?').get(id) as Row | undefined
  return (row?.kind as string) ?? DEFAULT_KIND
}

export function createTag(d: SqlDb, name: string, kind: string = DEFAULT_KIND): Tag[] {
  const clean = name.trim().slice(0, 12)
  if (clean) insertTag(d, clean, 'user', kind)
  return listTags(d, kind)
}

export function renameTag(d: SqlDb, id: number, name: string): Tag[] {

  const kind = tagKind(d, id)
  const clean = name.trim().slice(0, 12)
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!clean || !row || row.name === clean) return listTags(d, kind)

  // 改成一个已存在的名字，等同于合并。只在同品类里找同名 ——
  // 游戏的「开源」和软件的「开源」是两个词，跨品类合并会把两边的条目搅在一起
  const collide = d.prepare('SELECT id FROM tags WHERE kind = ? AND name = ?').get(kind, clean) as
    | Row
    | undefined
  if (collide) return mergeTags(d, [id], collide.id as number)

  transaction(d, () => {
    d.prepare('UPDATE tags SET name = ? WHERE id = ?').run(clean, id)
    replaceTagInEntries(d, [row.name as string], clean, kind)
  })

  return listTags(d, kind)
}

/** 把 fromIds 这些标签并进 intoId，条目上的引用一并替换并去重 */
export function mergeTags(d: SqlDb, fromIds: number[], intoId: number): Tag[] {

  const kind = tagKind(d, intoId)
  const target = d.prepare('SELECT name FROM tags WHERE id = ?').get(intoId) as Row | undefined
  if (!target) return listTags(d, kind)

  const sources = fromIds
    .filter((id) => id !== intoId)
    .map((id) => d.prepare('SELECT id, name, kind FROM tags WHERE id = ?').get(id) as Row | undefined)
    .filter((r): r is Row => !!r)
    // 跨品类合并没有意义，静默跳过比把游戏标签并进软件池好
    .filter((r) => (r.kind as string) === kind)
  if (sources.length === 0) return listTags(d, kind)

  transaction(d, () => {
    replaceTagInEntries(d, sources.map((s) => s.name as string), target.name as string, kind)
    const del = d.prepare('DELETE FROM tags WHERE id = ?')
    for (const s of sources) del.run(s.id)
    // 并过之后目标标签就是用户的意思了，顺手转正
    d.prepare(`UPDATE tags SET source = 'confirmed' WHERE id = ? AND source = 'ai'`).run(intoId)
  })

  return listTags(d, kind)
}

export function removeTag(d: SqlDb, id: number): Tag[] {

  const kind = tagKind(d, id)
  const row = d.prepare('SELECT name FROM tags WHERE id = ?').get(id) as Row | undefined
  if (!row) return listTags(d, kind)
  transaction(d, () => {
    replaceTagInEntries(d, [row.name as string], '', kind)
    d.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })

  return listTags(d, kind)
}

/**
 * 把条目（含暂存）标签数组里的 from 换成 to，to 为空串表示删除。
 * 标签存的是 JSON 数组，只能读出来改完写回去 —— SQL 里没法原地改。
 *
 * 限定 kind：两个品类可以各有一个同名标签，删掉游戏的「单机」
 * 不该把软件条目上的「单机」一起抹掉。
 */
function replaceTagInEntries(
  d: SqlDb,
  from: string[],
  to: string,
  kind: string
): void {
  const drop = new Set(from)
  const rows = d.prepare('SELECT id, tags FROM resource WHERE kind = ?').all(kind) as Row[]
  const stmt = d.prepare('UPDATE resource SET tags = ? WHERE id = ?')
  const rewrite = (list: Row[], update: SqlStatement): void => {
    for (const r of list) {
      const tags = parseJsonArray(r.tags).filter((value): value is string => typeof value === 'string')
      if (!tags.some((t) => drop.has(t))) continue
      const next = tags.map((t) => (drop.has(t) ? to : t)).filter(Boolean)
      update.run(JSON.stringify([...new Set(next)]), r.id)
    }
  }
  rewrite(rows, stmt)

  // 暂存区是软件模块自己的表，只有软件标签能落在里面
  if (kind === DEFAULT_KIND) {
    rewrite(
      d.prepare('SELECT id, tags FROM pending_software').all() as Row[],
      d.prepare('UPDATE pending_software SET tags = ? WHERE id = ?')
    )
  }
}

/**
 * 清掉没有任何条目（含暂存区）在用的 AI 待确认标签，别让否决过的词一直留在管理页。
 * 只清软件那一侧 —— 这是确认面板走完之后调的，游戏的 AI 标签不在它的视野里，
 * 不限定 kind 的话会把游戏刚识别出来、还没确认的标签一起删掉。
 */
export function pruneOrphanAiTags(d: SqlDb): void {
  const used = new Set<string>()
  for (const table of ['software', 'pending_software']) {
    for (const r of d.prepare(`SELECT tags FROM ${table}`).all() as Row[]) {
      for (const t of parseJsonArray(r.tags).filter((value): value is string => typeof value === 'string')) used.add(t)
    }
  }
  const stale = (
    d.prepare(`SELECT id, name FROM tags WHERE source = 'ai' AND kind = ?`).all(DEFAULT_KIND) as Row[]
  ).filter((t) => !used.has(t.name as string))
  const del = d.prepare('DELETE FROM tags WHERE id = ?')
  for (const t of stale) del.run(t.id)
}
