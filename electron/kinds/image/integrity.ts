import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageAudit, ImageAuditEntry, ImagePageInfo } from '../../../src/types/image.ts'
import { ImageLibrary } from './library.ts'
import { readImagePage } from './files.ts'
import { inspectImage } from './metadata.ts'
import { manifestPath, readImageManifest, readManifestPage } from './manifest.ts'

export async function imagePageInfo(db: SqlDb, pageId: string): Promise<ImagePageInfo> {
  return inspectImage((await readImagePage(db, pageId)).data)
}
export async function auditImage(db: SqlDb, id: string): Promise<ImageAudit> {
  const library = new ImageLibrary(db), item = library.get(id)
  if (!item) throw new Error('资源不可用')
  const manifest = item.source === 'pica' ? await readImageManifest(item.path, item.sourceId) : null
  const report: ImageAudit = { resourceId: id, checkedAt: Date.now(), total: 0, ok: 0, missing: 0, damaged: 0, unverified: 0, catalogComplete: !!manifest && manifest.chapters.every(c => !!c.pageIds?.length), entries: [] }
  const indexed = db.prepare('SELECT id,file,entry,chapter_id,ordinal,missing FROM image_pages WHERE resource_id=? ORDER BY ordinal').all(id) as Array<{ id: string; file: string; entry: string; chapter_id: string; ordinal: number; missing: number }>
  const seen = new Set<string>(), normalize = (file: string) => path.resolve(file).toLowerCase()
  const indexedFiles = new Map(indexed.filter(p => !p.entry).map(p => [normalize(p.file), p]))
  async function check(entry: ImageAuditEntry, read: () => Promise<Buffer>, checksum?: string) {
    try {
      const data = await read(); entry.info = inspectImage(data)
      if (checksum && createHash('sha256').update(data).digest('hex') !== checksum) { entry.status = 'damaged'; entry.reason = 'SHA-256 与下载清单不符' }
      else { entry.status = checksum ? 'ok' : 'unverified'; entry.reason = checksum ? '' : '格式与尺寸可读，无来源校验值' }
    } catch (cause) {
      entry.status = (cause as NodeJS.ErrnoException).code === 'ENOENT' || (cause as Error).message === '页面不可用' ? 'missing' : 'damaged'
      entry.reason = entry.status === 'missing' ? '文件缺失' : String((cause as Error).message)
    }
    entry.repairable = !!entry.sourcePageId && ['missing', 'damaged'].includes(entry.status)
    report.entries.push(entry); report[entry.status]++; report.total++
  }
  for (const chapter of manifest?.chapters || []) {
    const prefix = chapter.id + ':', savedIds = Object.keys(manifest!.pages).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    const pageIds = [...new Set([...(chapter.pageIds || []), ...savedIds])]
    for (const [ordinal, sourcePageId] of pageIds.entries()) {
      const key = prefix + sourcePageId, saved = manifest!.pages[key]
      const page = saved && indexedFiles.get(normalize(manifestPath(item.path, saved.file)))
      if (page) seen.add(page.id)
      const entry: ImageAuditEntry = { key, chapterId: chapter.id, sourcePageId, pageId: page?.id || '', title: chapter.title, ordinal, status: 'missing', reason: '', repairable: false }
      await check(entry, () => saved ? readManifestPage(item.path, saved.file) : Promise.reject(Object.assign(new Error('文件缺失'), { code: 'ENOENT' })), saved?.sha256)
    }
  }
  for (const page of indexed) {
    if (seen.has(page.id)) continue
    await check({ key: page.id, chapterId: page.chapter_id || '', sourcePageId: '', pageId: page.id, title: item.chapters.find(c => c.id === page.chapter_id)?.title || item.name, ordinal: page.ordinal, status: 'unverified', reason: '', repairable: false }, async () => (await readImagePage(db, page.id, true)).data)
  }
  if (!library.get(id)) throw new Error('资源不可用')
  return report
}
