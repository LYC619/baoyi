import fs from 'node:fs/promises'
import { assertImageFilesIdle } from './management.ts'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageDownloadJob, ImageDownloadOptions, ImageDownloadProgress, ImageSourceChapter, ImageSourcePage, ImageSourceWork, ImageTransferEvent } from '../../../src/types/image.ts'
import { ImageLibrary } from './library.ts'
import { PicacomicSource } from './source.ts'
import { scanImageImport } from './scanner.ts'
import { inspectImage } from './metadata.ts'
import { readImageManifest, readManifestPage, type ImageManifest } from './manifest.ts'
import { auditImage } from './integrity.ts'
import { createTransferMeter, normalizeDownloadProgress } from './download-progress.ts'
import { createImageRequestGate, type ImageRequestGate } from './request-gate.ts'

const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '漫画'
type Dependencies = { db: SqlDb; source: PicacomicSource; changed: () => void; jobsChanged?: () => void }

async function writeJson(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp'
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temporary, file) }
  catch (cause) { await fs.unlink(temporary).catch(() => {}); throw cause }
}
async function realDirectory(directory: string, root: string) {
  await fs.mkdir(directory, { recursive: true })
  const actual = await fs.realpath(directory), relative = path.relative(root, actual)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('下载目录指向目标根目录之外')
  return actual
}
export function createImageDownloads(deps: Dependencies) {
  const { db, source } = deps, library = new ImageLibrary(db)
  const jobs = new Map<string, ImageDownloadJob>(), controllers = new Map<string, AbortController>()
  const settling = new Map<string, Promise<void>>(), gates = new Map<string, ImageRequestGate>()
  const jobsChanged = deps.jobsChanged || deps.changed
  let pumping = false, nextOrder = 0, configuredConcurrency = 2, configuredJobConcurrency = 3
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='image_download_job_concurrency'").get() as {value:string} | undefined
    const saved = row && JSON.parse(row.value)
    if (Number.isInteger(saved) && saved >= 1 && saved <= 4) configuredJobConcurrency = saved
  } catch { /* bounded default */ }
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='image_download_concurrency'").get() as { value: string } | undefined
    const saved = row ? JSON.parse(row.value) : 2
    if (Number.isInteger(saved) && saved >= 1 && saved <= 3) configuredConcurrency = saved
  } catch { /* Invalid historical settings use the bounded default. */ }
  const persist = (job: ImageDownloadJob) => {
    job.updatedAt = Date.now()
    db.prepare('INSERT INTO image_download_jobs(id,status,updated_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload').run(job.id, job.status, job.updatedAt, JSON.stringify(job))
  }
  const save = (job: ImageDownloadJob) => { persist(job); jobsChanged() }
  for (const row of db.prepare('SELECT * FROM image_download_jobs ORDER BY updated_at').all() as Array<{ id: string; status: string; payload: string }>) {
    try {
      const job = JSON.parse(row.payload) as ImageDownloadJob
      if (job.id !== row.id || !job.work?.id || !Array.isArray(job.chapters) || !path.isAbsolute(job.root)) continue
      job.status = row.status as ImageDownloadJob['status']
      job.queueOrder = Number.isSafeInteger(job.queueOrder) && job.queueOrder! >= 0 ? job.queueOrder : nextOrder++
      nextOrder = Math.max(nextOrder, job.queueOrder! + 1)
      job.progress = normalizeDownloadProgress(job.progress)
      job.retryNotBefore = Number.isFinite(job.retryNotBefore) && job.retryNotBefore! > Date.now() ? job.retryNotBefore : 0
      job.progress.bytesPerSecond = 0; job.progress.retryAt = 0; job.progress.phase = 'idle'
      if (['running', 'queued'].includes(row.status)) { job.status = 'interrupted'; job.error = '应用中断，请重试剩余页'; persist(job) }
      jobs.set(job.id, job)
    } catch { /* Keep malformed rows on disk without starting filesystem work. */ }
  }
  const visible = (job: ImageDownloadJob) => !library.groups().some(g => g.id === job.groupId && g.hidden) && (!job.resourceId || !!library.get(job.resourceId))
  const queued = () => [...jobs.values()].filter(j => j.status === 'queued').sort((a, b) => a.queueOrder! - b.queueOrder!)
  const available = (id: string) => { const job = jobs.get(id); if (!job || !visible(job)) throw new Error('任务不可用'); return job }
  const duplicate = (workId: string, except?: string) => [...jobs.values()].some(j => j.id !== except && j.work.id === workId && ['queued', 'running', 'paused'].includes(j.status))
  function options(value?: ImageDownloadOptions): ImageDownloadOptions {
    if (value !== undefined) {
      if (!value || !Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 3) throw new Error('下载并发必须是 1 到 3 的整数')
      const jobConcurrency = value.jobConcurrency ?? configuredJobConcurrency
      if (!Number.isInteger(jobConcurrency) || jobConcurrency < 1 || jobConcurrency > 4) throw new Error('同时下载作品数必须是 1 到 4 的整数')
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('image_download_concurrency',?)").run(JSON.stringify(value.concurrency))
      configuredConcurrency = value.concurrency
      configuredJobConcurrency = jobConcurrency
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('image_download_job_concurrency',?)").run(JSON.stringify(jobConcurrency))
      for (const gate of gates.values()) gate.refresh()
      jobsChanged()
      pump()
    }
    return { concurrency: configuredConcurrency, jobConcurrency: configuredJobConcurrency }
  }
  async function run(job: ImageDownloadJob) {
    const controller = new AbortController()
    controllers.set(job.id, controller)
    job.status = 'running'; job.error = ''; job.processed = 0; job.total = 0; job.completedChapters = 0
    const progress = job.progress = normalizeDownloadProgress(), meter = createTransferMeter()
    const states = new Map<number, { phase: ImageDownloadProgress['phase']; retryAt: number }>()
    let workflow: ImageDownloadProgress['phase'] = 'catalog', lastNotice = 0, dirty = false
    const notify = (force = false) => { dirty = true; if (force || Date.now() - lastNotice >= 250) { lastNotice = Date.now(); dirty = false; jobsChanged() } }
    function aggregate(force = false) {
      const all = [...states.values()], old = progress.phase
      progress.effectiveConcurrency = gate.concurrency()
      if (all.some(s => s.phase === 'receiving')) progress.phase = 'receiving'
      else if (all.length && gate.retryAt()) progress.phase = 'rate-limited'
      else progress.phase = (['rate-limited', 'retrying', 'connecting', 'saving', 'checking'] as const).find(p => all.some(s => s.phase === p)) || workflow
      progress.retryAt = ['retrying', 'rate-limited'].includes(progress.phase) ? Math.max(gate.retryAt(), ...all.map(s => s.retryAt), 0) : 0
      progress.bytesPerSecond = progress.phase === 'receiving' ? meter.speed() : 0
      notify(force || old !== progress.phase)
    }
    const gate = createImageRequestGate(() => configuredConcurrency, () => {
      const retryAt = gate.retryAt(), extended = retryAt > (job.retryNotBefore || 0)
      if (extended) job.retryNotBefore = retryAt
      aggregate(true)
      if (extended) persist(job)
    })
    gates.set(job.id, gate)
    if ((job.retryNotBefore || 0) > Date.now()) gate.defer(job.retryNotBefore! - Date.now())
    const phase = (next: ImageDownloadProgress['phase']) => { workflow = next; aggregate(true) }
    const observe = (event: ImageTransferEvent, ordinal?: number) => {
      if (event.bytes) { progress.receivedBytes += event.bytes; meter.add(event.bytes) }
      if (ordinal === undefined) {
        workflow = ['connecting', 'receiving'].includes(event.phase) ? 'catalog' : event.phase
        progress.retryAt = event.waitMs ? Date.now() + event.waitMs : 0
        progress.phase = workflow; progress.bytesPerSecond = 0; notify(true)
      } else { states.set(ordinal, { phase: event.phase, retryAt: event.waitMs ? Date.now() + event.waitMs : 0 }); aggregate() }
    }
    const pagePhase = (ordinal: number, value: ImageDownloadProgress['phase']) => { states.set(ordinal, { phase: value, retryAt: 0 }); aggregate() }
    const timer = setInterval(() => { const speed = progress.phase === 'receiving' ? meter.speed() : 0; if (speed !== progress.bytesPerSecond || dirty) { progress.bytesPerSecond = speed; notify() } }, 250)
    let commits = Promise.resolve()
    const commit = (action: () => Promise<void>) => {
      const pending = commits.then(() => { controller.signal.throwIfAborted(); return action() })
      commits = pending.catch(() => {})
      return pending
    }
    try {
      save(job)
      const root = await fs.realpath(job.root)
      const existing = library.list().find(i => i.source === 'pica' && i.sourceId === job.work.id)
      if(existing)assertImageFilesIdle(existing.id)
      if (job.resourceId && existing?.id !== job.resourceId) throw new Error('目标作品已移除或隐藏，未写入下载文件')
      if (existing && path.dirname(existing.path).toLowerCase() !== root.toLowerCase()) throw new Error('作品已在另一目录中，请使用原下载根目录补齐章节')
      const directory = await realDirectory(existing?.path || path.join(root, safeName(job.work.title) + ' [' + hash(job.work.id).slice(0, 8) + ']'), root)
      const manifestFile = path.join(directory, '.baoyi-image.json')
      const manifest: ImageManifest = await readImageManifest(directory, job.work.id) || { version: 1, source: 'pica', sourceId: job.work.id, name: job.work.title, description: job.work.description, tags: job.work.tags, publication: job.work.finished ? 'completed' : 'ongoing', chapters: [], pages: {} }
      const catalog: Array<{ chapter: ImageSourceChapter; pages: ImageSourcePage[]; ordinals: number[] }> = []
      phase('catalog')
      for (const chapter of job.chapters) {
        controller.signal.throwIfAborted(); job.current = chapter.title
        const pages = await source.pages(job.work.id, chapter, controller.signal, event => observe(event))
        if (!pages.length) throw new Error('来源章节没有可下载的页面')
        const selected = job.repairPages?.[chapter.id]
        if (job.repairPages && (!selected?.length || selected.some(id => !pages.some(p => p.id === id)))) throw new Error('来源已无法提供待修复页面，请稍后重试或手动核对来源')
        const ordinals = pages.map((_, index) => index).filter(index => !selected || selected.includes(pages[index].id))
        catalog.push({ chapter, pages, ordinals }); job.total += ordinals.length; progress.catalogChapters = catalog.length; save(job)
        if (!job.repairPages) {
          let saved = manifest.chapters.find(c => c.id === chapter.id)
          if (!saved) { saved = { directory: String(chapter.order).padStart(5, '0') + '-' + hash(chapter.id).slice(0, 12), id: chapter.id, title: chapter.title, order: chapter.order }; manifest.chapters.push(saved) }
          saved.pageIds = pages.map(p => p.id)
        }
      }
      await writeJson(manifestFile, manifest)
      progress.totalKnown = true; save(job)
      for (const [chapterIndex, { chapter, pages, ordinals }] of catalog.entries()) {
        controller.signal.throwIfAborted()
        const relative = manifest.chapters.find(c => c.id === chapter.id)!.directory, chapterDir = await realDirectory(path.join(directory, relative), directory)
        job.current = chapter.title; progress.chapterIndex = chapterIndex + 1; progress.chapterProcessed = 0; progress.chapterTotal = ordinals.length
        phase('checking'); save(job)
        async function page(ordinal: number) {
          controller.signal.throwIfAborted()
          const entryKey = chapter.id + ':' + pages[ordinal].id, entry = manifest.pages[entryKey]
          let valid = false, size = 0
          pagePhase(ordinal, 'checking')
          if (entry) {
            const file = path.resolve(directory, entry.file), inside = path.relative(chapterDir, file)
            if (inside.includes(path.sep) || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('下载清单中的页面路径无效')
            try {
              const bytes = await readManifestPage(directory, entry.file)
              inspectImage(bytes); valid = hash(bytes) === entry.sha256; size = bytes.length
            } catch { valid = false }
          }
          if (!valid) {
            pagePhase(ordinal, 'connecting')
            const { data, extension } = await source.image(pages[ordinal].url, controller.signal, event => observe(event, ordinal), gate)
            inspectImage(data)
            if (entry && path.extname(entry.file).toLowerCase().replace('.jpeg', '.jpg') !== extension.replace('.jpeg', '.jpg')) throw new Error('来源图片格式已变化，已保留现有文件。请核对来源后重新导入，避免重复页和阅读位置丢失')
            controller.signal.throwIfAborted()
            pagePhase(ordinal, 'saving'); size = data.length
            await commit(async () => {
              const savedOrdinal = job.repairPages ? manifest.chapters.find(c => c.id === chapter.id)?.pageIds?.indexOf(pages[ordinal].id) : undefined
              const filename = entry ? path.basename(entry.file) : String((savedOrdinal !== undefined && savedOrdinal >= 0 ? savedOrdinal : ordinal) + 1).padStart(5, '0') + '-' + hash(pages[ordinal].id).slice(0, 12) + extension
              const file = path.join(chapterDir, filename), temporary = file + '.' + randomUUID() + '.part'
              try {
                await fs.writeFile(temporary, data, { flag: 'wx' })
                try { const present = await fs.lstat(file); if (present.isSymbolicLink()) throw new Error('目标页面是链接'); await fs.rename(file, file + '.damaged-' + Date.now()) }
                catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
                await fs.rename(temporary, file)
              } catch (cause) { await fs.unlink(temporary).catch(() => {}); throw cause }
              manifest.pages[entryKey] = { file: path.relative(directory, file).replaceAll('\\', '/'), sha256: hash(data) }
              await writeJson(manifestFile, manifest)
              job.processed++; progress.chapterProcessed++; progress.storedBytes += size; save(job)
            })
          } else {
            await commit(async () => { progress.reusedPages++; job.processed++; progress.chapterProcessed++; progress.storedBytes += size; save(job) })
          }
          states.delete(ordinal); aggregate()
        }
        let cursor = 0, failure: unknown
        // Workers may receive out of order; all durable mutations go through commit().
        await Promise.all(Array.from({ length: Math.min(3, ordinals.length) }, async () => {
          try { while (cursor < ordinals.length) { controller.signal.throwIfAborted(); const ordinal = ordinals[cursor++]; await page(ordinal) } }
          catch (cause) { if (failure === undefined) failure = cause; if (!controller.signal.aborted) controller.abort(cause) }
        }))
        await commits
        if (failure !== undefined) throw failure
        controller.signal.throwIfAborted()
        job.completedChapters++; await writeJson(manifestFile, manifest)
        states.clear(); phase('importing')
        const scanned = (await scanImageImport(directory, 'comic', false))[0], item = library.register(scanned)
        job.resourceId = item.id
        if (job.groupId && !existing && chapterIndex === 0) library.update(item.id, { groupId: job.groupId })
        deps.changed(); save(job)
      }
      job.status = 'success'; job.current = '下载并入库完成'; job.retryNotBefore = 0
    } catch (cause) {
      const reason = controller.signal.reason
      job.status = reason === 'paused' ? 'paused' : reason === 'cancelled' ? 'cancelled' : 'failed'
      job.error = job.status === 'paused' ? '' : job.status === 'cancelled' ? '已停止，可重试剩余页' : String((cause as Error)?.message || cause)
      if (job.status === 'paused') job.current = '已暂停'
    } finally {
      clearInterval(timer); await commits; states.clear(); phase('idle')
      gate.dispose(); gates.delete(job.id); controllers.delete(job.id); save(job)
    }
  }
  function pump() {
    if (pumping) return
    pumping = true
    try {
      let next: ImageDownloadJob | undefined
      while (settling.size < configuredJobConcurrency && (next = queued().find(job=>!settling.has(job.id)))) {
        const job = next, pending = Promise.resolve().then(() => job.status === 'queued' ? run(job) : undefined)
        settling.set(job.id, pending)
        void pending.catch(error => { job.status = 'failed'; job.error = String(error); save(job) }).finally(() => { settling.delete(job.id); pump() })
      }
    } finally { pumping = false }
  }
  async function enqueue(work: ImageSourceWork, chapters: ImageSourceChapter[], root: string, groupId: string | null, request?: { repairPages?: Record<string, string[]>; resourceId?: string }) {
    if (!chapters.length) throw new Error('请先选择章节')
    const actualRoot = await fs.realpath(root)
    const existing=library.list().find(item=>item.source==='pica'&&item.sourceId===work.id)
    if(existing)assertImageFilesIdle(existing.id)
    if (duplicate(work.id)) throw new Error('这部作品已有下载任务')
    if (groupId && !library.groups().some(g => g.id === groupId && !g.hidden)) throw new Error('下载类型不可用')
    if (request?.resourceId) {
      const target = library.get(request.resourceId)
      if (!target || target.source !== 'pica' || target.sourceId !== work.id) throw new Error('目标作品不可用')
    }
    const job: ImageDownloadJob = { id: randomUUID(), work, chapters: chapters.slice().sort((a, b) => a.order - b.order), root: actualRoot, groupId, status: 'queued', processed: 0, total: 0, completedChapters: 0, current: '等待下载', error: '', updatedAt: Date.now(), resourceId: '', progress: normalizeDownloadProgress(), queueOrder: nextOrder++ }
    if (request?.repairPages) job.repairPages = structuredClone(request.repairPages)
    if (request?.resourceId) job.resourceId = request.resourceId
    jobs.set(job.id, job); save(job); pump(); return structuredClone(job)
  }
  async function repair(id: string): Promise<ImageDownloadJob | null> {
    const item = library.get(id)
    if (!item) throw new Error('资源不可用')
    if (item.source !== 'pica' || !item.sourceId) throw new Error('本地导入没有可用的修复来源')
    if (duplicate(item.sourceId)) throw new Error('这部作品已有下载任务，请先完成或停止任务')
    const audit = await auditImage(db, id), targets = audit.entries.filter(e => e.repairable)
    if (!targets.length) return null
    const manifest = await readImageManifest(item.path, item.sourceId)
    if (!manifest) throw new Error('缺少来源下载清单，无法定位修复页面')
    const repairPages: Record<string, string[]> = Object.create(null)
    for (const entry of targets) (repairPages[entry.chapterId] ||= []).push(entry.sourcePageId)
    const chapters = manifest.chapters.filter(c => repairPages[c.id]).map(c => ({ id: c.id, title: c.title, order: c.order }))
    if (!library.get(id)) throw new Error('资源不可用')
    return enqueue({ id: item.sourceId, title: item.name, author: '', description: item.description, tags: item.tags, pages: targets.length, chapters: chapters.length, finished: item.publication === 'completed' }, chapters, path.dirname(item.path), item.groupId, { repairPages, resourceId: id })
  }
  async function retry(id: string) {
    if (['queued', 'running'].includes(available(id).status)) return
    await settling.get(id)
    const job = available(id)
    if (['queued', 'running'].includes(job.status)) return
    if (duplicate(job.work.id, id)) throw new Error('这部作品已有下载任务')
    job.status = 'queued'; job.error = ''; job.queueOrder = nextOrder++
    job.progress = normalizeDownloadProgress({ ...job.progress, phase: 'queued', bytesPerSecond: 0, retryAt: 0 })
    save(job); pump()
  }
  async function pause(id: string) {
    const job = available(id)
    if (job.status === 'queued') { job.status = 'paused'; job.current = '已暂停'; save(job) }
    else if (job.status === 'running') { controllers.get(id)?.abort('paused'); await settling.get(id) }
  }
  async function resume(id: string) {
    if (available(id).status !== 'paused') return
    await settling.get(id)
    if (available(id).status !== 'paused') return
    await retry(id)
  }
  async function cancel(id: string) {
    const job = available(id)
    if (job.status === 'queued' || job.status === 'paused') { job.status = 'cancelled'; job.error = '已停止，可重试剩余页'; save(job) }
    else if (job.status === 'running') { controllers.get(id)?.abort('cancelled'); await settling.get(id) }
  }
  function move(id: string, direction: 'up' | 'down') {
    const job = available(id)
    if (job.status !== 'queued') throw new Error('只能调整排队任务')
    if (!['up', 'down'].includes(direction)) throw new Error('无效的队列方向')
    const queue = queued(), index = queue.indexOf(job), other = queue[index + (direction === 'up' ? -1 : 1)]
    if (!other) return
    const order = job.queueOrder!, otherOrder = other.queueOrder!
    db.exec('BEGIN IMMEDIATE')
    try { job.queueOrder = otherOrder; other.queueOrder = order; persist(job); persist(other); db.exec('COMMIT') }
    catch (cause) { db.exec('ROLLBACK'); job.queueOrder = order; other.queueOrder = otherOrder; throw cause }
    jobsChanged()
  }
  function dismiss(id: string) {
    const job = available(id)
    if (['queued', 'running'].includes(job.status) || settling.has(id)) return
    jobs.delete(id); db.prepare('DELETE FROM image_download_jobs WHERE id=?').run(id); jobsChanged()
  }
  function list() {
    const queue = queued(), priority = (job: ImageDownloadJob) => job.status === 'running' ? 0 : job.status === 'queued' ? 1 : job.status === 'paused' ? 2 : 3
    return [...jobs.values()].filter(visible).sort((a, b) => priority(a) - priority(b) || (a.status === 'queued' && b.status === 'queued' ? a.queueOrder! - b.queueOrder! : b.updatedAt - a.updatedAt))
      .map(job => ({ ...structuredClone(job), queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : undefined }))
  }
  async function enqueueBatch(ids: string[], root: string, groupId: string | null) {
    if (!Array.isArray(ids) || ids.length > 200 || !ids.length || ids.some(id=>typeof id!=='string'||!id.trim())) throw new Error('一次请选择 1 到 200 部漫画')
    const result = {enqueued:0,skipped:0,errors:[] as string[]}
    for (const id of new Set(ids)) {
      if (duplicate(id) || db.prepare("SELECT 1 FROM image_meta WHERE source='pica' AND source_id=?").get(id)) {result.skipped++;continue}
      try { const {work,chapters} = await source.detail(id); await enqueue(work,chapters,root,groupId); result.enqueued++ }
      catch(error) {result.errors.push(`${id}：${(error as Error).message}`)}
    }
    return result
  }
  return { enqueue, enqueueBatch, repair, retry, pause, resume, cancel, move, options, dismiss, list, idle: async () => { while (settling.size) {await Promise.allSettled([...settling.values()]); await Promise.resolve()} } }
}
