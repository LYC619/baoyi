import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageChapterUpdate, ImageUpdateCheck } from '../../../src/types/image.ts'
import type { createImageDownloads } from './downloads.ts'
import { PicacomicSource } from './source.ts'
import { ImageLibrary } from './library.ts'
import { readImageManifest } from './manifest.ts'
import { auditImage } from './integrity.ts'

type Dependencies = { db: SqlDb; source: PicacomicSource; queue: Pick<ReturnType<typeof createImageDownloads>, 'enqueue'> }
export function createImageUpdates({ db, source, queue }: Dependencies) {
  const library = new ImageLibrary(db)
  function available(id: string) {
    const item = library.get(id)
    if (!item) throw new Error('资源不可用')
    if (item.type !== 'comic' || item.source !== 'pica' || !item.sourceId) throw new Error('这部作品没有可用的连载来源')
    return item
  }
  async function inspect(id: string) {
    const item = available(id), detail = await source.detail(item.sourceId)
    const manifest = await readImageManifest(item.path, item.sourceId), audit = await auditImage(db, id)
    const localBySource = new Map(item.chapters.filter(c => c.sourceId).map(c => [c.sourceId, c]))
    const savedBySource = new Map(manifest?.chapters.map(c => [c.id, c]) || [])
    const chapters: ImageChapterUpdate[] = detail.chapters.map(chapter => {
      const local = localBySource.get(chapter.id), saved = savedBySource.get(chapter.id)
      const entries = audit.entries.filter(e => e.chapterId === chapter.id || e.chapterId === local?.id)
      const expectedPages = saved?.pageIds?.length || null
      const goodPages = entries.filter(e => ['ok', 'unverified'].includes(e.status)).length
      let status: ImageChapterUpdate['status'] = 'new'
      if (local || saved) {
        if (!entries.length || entries.some(e => ['missing', 'damaged'].includes(e.status)) || (expectedPages !== null && goodPages < expectedPages)) status = 'incomplete'
        else if (expectedPages === null || entries.some(e => e.status === 'unverified')) status = 'unverified'
        else status = 'downloaded'
      }
      return { ...chapter, status, localTitle: local?.title || saved?.title || '', localPages: goodPages, expectedPages }
    })
    const remote = new Set(detail.chapters.map(c => c.id))
    for (const sourceId of new Set([...localBySource.keys(), ...savedBySource.keys()])) {
      if (remote.has(sourceId)) continue
      const local = localBySource.get(sourceId), saved = savedBySource.get(sourceId)
      chapters.push({ id: sourceId, title: local?.title || saved!.title, order: saved?.order ?? local!.ordinal, status: 'unavailable', localTitle: local?.title || saved!.title, localPages: local?.pageCount || 0, expectedPages: saved?.pageIds?.length || null })
    }
    const current = available(id)
    if (current.path !== item.path || current.sourceId !== item.sourceId) throw new Error('作品位置或来源已变化，请重新检查更新')
    const result: ImageUpdateCheck = { resourceId: id, checkedAt: Date.now(), sourceTitle: detail.work.title, sourcePublication: detail.work.finished ? 'completed' : 'ongoing', chapters }
    return { item: current, detail, result }
  }
  async function download(id: string, selected: string[]) {
    available(id)
    if (!Array.isArray(selected) || !selected.length || selected.length > 5000 || selected.some(value => typeof value !== 'string' || !value)) throw new Error('请选择有效的新增章节')
    const { item, detail, result } = await inspect(id), ids = new Set(selected)
    if ([...ids].some(value => !result.chapters.some(c => c.id === value && c.status === 'new'))) throw new Error('仅可选择当前新增章节；本地已有或来源已移除的章节请重新核对')
    return queue.enqueue(detail.work, detail.chapters.filter(c => ids.has(c.id)), path.dirname(item.path), item.groupId, { resourceId: item.id })
  }
  return { check: async (id: string) => (await inspect(id)).result, download }
}
