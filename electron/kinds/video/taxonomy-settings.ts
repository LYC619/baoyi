import { transaction } from '../../workspace/validation.ts'
import type { SqlDb } from '../../services/schema.ts'
import { updateEpisode, updateVideo } from './db.ts'
import type { VideoTaxonomy, VideoTaxonomyEdit } from '../../../src/types/video-taxonomy.ts'

interface Row { id: string; name: string; collection_name: string; tags: string; hanime_tags: string }
const parse = (value: string): string[] => JSON.parse(value || '[]')
function rows(db: SqlDb, hentai: boolean): Row[] {
  if (typeof hentai !== 'boolean') throw new Error('影视设置范围无效')
  return db.prepare(`SELECT id, COALESCE(NULLIF(name_zh,''), NULLIF(name_en,''), file_name) AS name, collection_name, tags, hanime_tags
    FROM video WHERE category ${hentai ? '=' : '!='} ? ORDER BY name`).all('里番') as Row[]
}
function episodes(db: SqlDb, id: string) { return db.prepare('SELECT id,tags FROM episode WHERE resource_id=?').all(id) as Array<{ id: string; tags: string }> }
export function videoTaxonomy(db: SqlDb, hentai: boolean): VideoTaxonomy {
  const works = rows(db, hentai), groups = new Map<string, number>(), tags = new Map<string, number>()
  for (const work of works) {
    groups.set(work.collection_name, (groups.get(work.collection_name) || 0) + 1)
    for (const tag of new Set([...parse(work.tags), ...parse(work.hanime_tags), ...episodes(db, work.id).flatMap(episode => parse(episode.tags))])) tags.set(tag, (tags.get(tag) || 0) + 1)
  }
  const list = (counts: Map<string, number>) => [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { works: works.map(({ id, name }) => ({ id, name })), groups: list(groups), tags: list(tags) }
}
export function editVideoTaxonomy(db: SqlDb, edit: VideoTaxonomyEdit): number {
  if (!edit || !['groups', 'tags'].includes(edit.field) || (edit.from !== null && typeof edit.from !== 'string') || (edit.to !== null && (typeof edit.to !== 'string' || !edit.to.trim() || edit.to.trim().length > 80))) throw new Error('分组或标签名称无效')
  if (edit.from === null && (edit.to === null || !Array.isArray(edit.ids) || !edit.ids.length)) throw new Error('请先选择作品')
  return transaction(db, () => {
    const all = rows(db, edit.hentai), target = edit.to?.trim() ?? null
    const ids = edit.from === null ? new Set(edit.ids) : null
    if (ids && [...ids].some(id => !all.some(work => work.id === id))) throw new Error('作品已变化或不属于当前设置范围，请刷新后重试')
    const replace = (value: string) => [...new Set(parse(value).flatMap(tag => tag === edit.from ? target === null ? [] : [target] : [tag]))]
    let changed = 0
    for (const work of all) {
      if (ids && !ids.has(work.id)) continue
      if (edit.field === 'groups') {
        if (!ids && work.collection_name !== edit.from) continue
        if (work.collection_name === (target || '')) continue
        updateVideo(db, work.id, { collection_name: target || '' }); changed++
      } else if (ids) {
        const tags = parse(work.tags)
        if (tags.includes(target!)) continue
        updateVideo(db, work.id, { tags: [...tags, target!] }); changed++
      } else {
        const parts = episodes(db, work.id), tags = replace(work.tags), hanimeTags = replace(work.hanime_tags)
        const matches = parse(work.tags).includes(edit.from!) || parse(work.hanime_tags).includes(edit.from!) || parts.some(part => parse(part.tags).includes(edit.from!))
        if (!matches || target === edit.from) continue
        updateVideo(db, work.id, { tags, hanime_tags: hanimeTags })
        for (const part of parts) if (parse(part.tags).includes(edit.from!)) updateEpisode(db, part.id, { tags: replace(part.tags) })
        changed++
      }
    }
    return changed
  })
}
