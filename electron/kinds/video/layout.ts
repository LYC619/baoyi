/**
 * 统一移动（实测第三轮，第四轮补洞）：把已入库的作品挪成「整理根目录 / 收藏分组 / 作品文件夹」，没分组的直接放根目录下。
 *
 * 两条路，按作品有没有绑定目录分：
 * - 绑定了目录的：整个目录 rename 过去（同一块盘上是瞬时的），再用 rebaseMovedVideoDirectory 把库里所有路径改过来。
 *   跨盘不做（rename 会变成整盘复制，那是「目录管理 / 重新绑定」里复制整目录的活）。
 * - 只有散文件、没绑定目录的：走现成的物理整理（previewVideoOrganize + applyVideoOrganize，transfer=move），
 *   复制→校验→切引用→删原件，带整理日志，能在「整理记录」里重试和回退。
 *
 * 第四轮补的三个洞（用户实测：文件夹和配置搬走了、视频留在原地）：
 * - 搬文件那条路先看视频本体搬不搬得过去；搬不过去整部作品标「不动」，不再搬两个配置文件就把目录绑过去。
 * - 绑定了目录、但有视频在目录外面的：改名之后（或已就位时）用整理流程把外面的视频收进来；
 *   整目录 rename 只改目录里面的路径，目录外的文件它一个都不碰。
 * - 有没收尾的整理日志的作品：目标就是当前目录的，顺着那条日志重试；不然标「不动」让用户先去整理记录处理。
 *   以前是绕过日志直接改名，日志就永远指着一个不存在的目录。
 *
 * ponytail: 目录 rename 这条路没有走整理日志，只在 userData/library-layout/ 留一份 from→to 的记录；
 * 要回退就按记录反着 rename 再「重新绑定」。真要日志化得给 video_organize_journal 的 kind 加值，这轮不做。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoLayoutEntry, VideoLayoutPreview, VideoLayoutResult, VideoOrganizeJournal, VideoOrganizePreview } from '../../../src/types/video-organize.ts'
import type { VideoWorkLibrary } from '../../../src/types/video-workflow.ts'
import { getVideo } from './db.ts'
import { getVideoWorkLibrary } from './library.ts'
import { safeWorkFolderName } from './bundle.ts'
import { rebaseMovedVideoDirectory, videoPathKey } from './local-files.ts'
import { applyVideoOrganize, pendingVideoOrganizeMap, previewVideoOrganize, retryVideoOrganize } from './organize.ts'
import { resolveVideoOrganizeOwner } from './organize-owner.ts'
import { persistVideoWorkBundle } from './local-sync.ts'

const same = (a: string, b: string) => videoPathKey(a) === videoPathKey(b)
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
const groupFolder = (group: string) => group.trim() ? safeWorkFolderName(group) : ''
const PENDING_HINT = '有未完成的整理记录，请先在「日志 / 整理记录」里重试或回退'

/** 视频文件在作品目录外面（上一轮只搬了配置、视频留在原地的那种状态）。 */
function strayVideos(library: VideoWorkLibrary, directory: string) {
  return library.assets.filter(asset => asset.role === 'video' && !inside(directory, asset.path))
}

/** 用整理流程把文件收进目录之前先预览一遍：视频本体搬不过去就整部作品不动，附件有问题只是跳过。 */
function gatherPlan(d: SqlDb, id: string, library: VideoWorkLibrary, target: string, root: string): { preview: VideoOrganizePreview; blocked: string; trouble: number } {
  const preview = previewVideoOrganize(d, { resourceIds: [id], survivorId: id, targetDirectory: target, root, transfer: 'move' })
  if (!preview.canOrganize) return { preview, blocked: preview.collisions.find(c => c.scope !== 'file')?.message || preview.collisions[0]?.message || '整理预览未通过', trouble: 0 }
  const videoKeys = new Set([...library.assets.filter(asset => asset.role === 'video').map(asset => asset.path), ...library.contents.map(ep => ep.path)].filter(Boolean).map(videoPathKey))
  const videoFiles = new Set(preview.files.filter(file => videoKeys.has(videoPathKey(file.source))).map(file => file.id))
  const issues = preview.collisions.filter(c => c.scope === 'file')
  const video = issues.find(c => c.fileId && videoFiles.has(c.fileId))
  if (video) return { preview, blocked: '视频文件搬不过去：' + video.message, trouble: 0 }
  return { preview, blocked: '', trouble: issues.length }
}

export function previewVideoLayout(d: SqlDb, ids: string[], root: string): VideoLayoutPreview {
  root = path.resolve(root)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('整理根目录不存在或不可用：' + root)
  const entries: VideoLayoutEntry[] = [], targets = new Set<string>()
  const others = d.prepare("SELECT id, path FROM resource WHERE kind = 'video' AND is_archived = 0").all() as Array<{ id: string; path: string }>
  const bindings = d.prepare('SELECT resource_id, directory_path FROM video_directories').all() as Array<{ resource_id: string; directory_path: string }>
  const pendingByWork = pendingVideoOrganizeMap(d)
  for (const id of [...new Set(ids)]) {
    const item = getVideo(d, id)
    if (!item || item.is_archived || resolveVideoOrganizeOwner(d, id) !== id) continue
    const title = item.name_zh || item.name_en || item.file_name, group = item.collection_name || ''
    const to = path.join(root, groupFolder(group), safeWorkFolderName(title))
    const library = getVideoWorkLibrary(d, id)
    const videos = library.assets.filter(asset => asset.role === 'video')
    const push = (from: string, action: VideoLayoutEntry['action'], reason = '', journal = '') => entries.push({ resourceId: id, title, group, from, to, action, reason, files: videos.length, ...(journal ? { journal } : {}) })
    const pending = pendingByWork.get(id)
    if (library.directory) {
      const from = library.directory.path, placed = same(from, to)
      const stray = strayVideos(library, from)
      if (placed && !stray.length) { push(from, 'in-place', pending ? '已在目标位置；有一条未收尾的整理记录（缺附件之类），可在「日志 / 整理记录」里处理' : '已在目标位置'); continue }
      if (!fs.existsSync(from)) { push(from, 'skip', '作品目录当前不可用（磁盘离线或已移走），可先「检查文件」'); continue }
      if (pending) {
        // 上次整理没收尾（比如视频因为路径过长没搬成）：目标就是现在这个目录的，顺着它重试；别的先去整理记录处理
        if (placed && pending.canRetry && same(pending.targetDirectory, to)) {
          const left = pending.files.filter(file => file.status === 'failed' || file.status === 'pending').length
          push(path.dirname((stray[0] || videos[0])?.path || from), 'move-files', `继续上次未完成的整理（${left} 个文件未搬）`, pending.id); continue
        }
        push(from, 'skip', PENDING_HINT); continue
      }
      if (!placed) {
        if (same(from, root) || inside(from, root)) { push(from, 'skip', '作品目录包含整理根目录，不能移动'); continue }
        if (fs.existsSync(to)) { push(from, 'skip', '目标目录已存在，未覆盖'); continue }
        if (targets.has(videoPathKey(to))) { push(from, 'skip', '另一部作品也要搬到同名目录，请先改名'); continue }
        const occupied = others.some(row => row.id !== id && row.path && (same(row.path, from) || inside(from, row.path)) && resolveVideoOrganizeOwner(d, row.id) !== id)
          || bindings.some(row => row.resource_id !== id && (same(row.directory_path, from) || inside(from, row.directory_path)))
        if (occupied) { push(from, 'skip', '目录里还有其他作品，请先整理归属'); continue }
        if (path.parse(from).root.toLowerCase() !== path.parse(to).root.toLowerCase()) { push(from, 'skip', '跨磁盘不移动；请用「目录管理 / 重新绑定」复制整目录'); continue }
      }
      if (stray.length) {
        // 改名前先按现在的目录验一遍收得进来不：视频缺失 / 离线 / 目标重名这些和改不改名无关
        const validationRoot = inside(root, from) ? root : library.directory.root && inside(library.directory.root, from) ? library.directory.root : path.dirname(from)
        try {
          const plan = gatherPlan(d, id, library, from, validationRoot)
          if (plan.blocked) { push(from, 'skip', plan.blocked); continue }
          const note = `${stray.length} 个视频在作品目录外，会一并收进来` + (plan.trouble ? `；${plan.trouble} 个附件有问题，会跳过` : '')
          targets.add(videoPathKey(to)); push(placed ? path.dirname(stray[0].path) : from, placed ? 'move-files' : 'move-directory', note)
        } catch (error) { push(from, 'skip', error instanceof Error ? error.message : String(error)) }
        continue
      }
      targets.add(videoPathKey(to)); push(from, 'move-directory')
      continue
    }
    if (!videos.length) { push('', 'skip', '没有本地文件'); continue }
    const from = path.dirname(videos[0].path)
    if (videos.every(asset => inside(to, asset.path))) { push(from, 'in-place', '文件已在目标目录'); continue }
    if (pending) { push(from, 'skip', PENDING_HINT); continue }
    if (targets.has(videoPathKey(to))) { push(from, 'skip', '另一部作品也要搬到同名目录，请先改名'); continue }
    try {
      const plan = gatherPlan(d, id, library, to, root)
      if (plan.blocked) { push(from, 'skip', plan.blocked); continue }
      targets.add(videoPathKey(to)); push(from, 'move-files', plan.trouble ? `${plan.trouble} 个附件有问题，会跳过` : '')
    } catch (error) { push(from, 'skip', error instanceof Error ? error.message : String(error)) }
  }
  return { root, entries, movable: entries.filter(entry => entry.action === 'move-directory' || entry.action === 'move-files').length }
}

export async function applyVideoLayout(d: SqlDb, ids: string[], root: string, recoveryRoot: string): Promise<VideoLayoutResult> {
  const preview = previewVideoLayout(d, ids, root)
  fs.mkdirSync(recoveryRoot, { recursive: true })
  const record = path.join(recoveryRoot, new Date().toISOString().replace(/[:.]/g, '-') + '.json')
  const log = { root: preview.root, startedAt: Date.now(), finishedAt: 0, moves: [] as Array<{ resourceId: string; title: string; from: string; to: string; kind: string; ok: boolean; message: string }> }
  const save = () => fs.writeFileSync(record, JSON.stringify(log, null, 2))
  const outcomes: VideoLayoutResult['outcomes'] = []
  const done = (entry: VideoLayoutEntry, ok: boolean, message: string) => {
    outcomes.push({ resourceId: entry.resourceId, title: entry.title, ok, message })
    if (entry.action === 'move-directory' || entry.action === 'move-files') { log.moves.push({ resourceId: entry.resourceId, title: entry.title, from: entry.from, to: entry.to, kind: entry.action, ok, message }); save() }
  }
  // ponytail: 只删「搬空了」的原目录；里面还剩别的东西就留着。根目录和盘符根一律不碰
  const tidy = (dir: string) => { try { if (dir && !same(dir, preview.root) && !same(dir, path.parse(dir).root) && fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir) } catch { /* 留着也无妨 */ } }
  const finish = (journal: VideoOrganizeJournal): { ok: boolean; message: string } => {
    const moved = journal.files.filter(file => file.status === 'switched').length
    if (journal.status === 'applied') {
      for (const dir of new Set(journal.files.filter(file => file.sourceRemoved).map(file => path.dirname(file.source)))) tidy(dir)
      return { ok: true, message: `已把 ${moved} 个文件搬进新目录` }
    }
    return { ok: false, message: `部分文件未处理（已搬 ${moved} 个）：` + [...journal.conflicts, ...journal.files.filter(f => f.status === 'failed').map(f => f.error)].filter(Boolean).slice(0, 3).join('；') + '；可在「日志 / 整理记录」里重试或回退' }
  }
  const gather = async (entry: VideoLayoutEntry, target: string) => {
    const plan = previewVideoOrganize(d, { resourceIds: [entry.resourceId], survivorId: entry.resourceId, targetDirectory: target, root: preview.root, transfer: 'move' })
    if (!plan.canOrganize) throw new Error(plan.collisions.find(c => c.scope !== 'file')?.message || '整理预览未通过')
    return finish(await applyVideoOrganize(d, { preview: plan, mode: 'physical' }))
  }
  save()
  for (const entry of preview.entries) {
    if (entry.action === 'in-place') { done(entry, true, entry.reason); continue }
    if (entry.action === 'skip') { done(entry, false, entry.reason); continue }
    try {
      if (entry.action === 'move-directory') {
        if (fs.existsSync(entry.to)) throw new Error('目标目录已存在，未覆盖')
        if (!fs.existsSync(entry.from)) throw new Error('作品目录在移动前已不可用')
        fs.mkdirSync(path.dirname(entry.to), { recursive: true })
        fs.renameSync(entry.from, entry.to)
        d.exec('SAVEPOINT video_layout')
        try { rebaseMovedVideoDirectory(d, entry.resourceId, entry.from, entry.to, preview.root); d.exec('RELEASE SAVEPOINT video_layout') }
        catch (error) {
          d.exec('ROLLBACK TO SAVEPOINT video_layout'); d.exec('RELEASE SAVEPOINT video_layout')
          try { fs.renameSync(entry.to, entry.from) } catch { /* 目录已搬到新位置、库里还是旧路径：记录里有 from→to，用「重新绑定」能接回来 */ }
          throw error
        }
        let note = ''
        try { note = persistVideoWorkBundle(d, entry.resourceId, entry.to).warnings[0] || '' } catch (error) { note = '清单待保存：' + (error instanceof Error ? error.message : String(error)) }
        const moved = '已移动整个作品目录' + (note ? '；' + note : '')
        // 目录外还有视频的，改完名接着收进来；收不进来目录改名也已经成立，下次统一移动会当「已就位 + 收文件」再试
        if (strayVideos(getVideoWorkLibrary(d, entry.resourceId), entry.to).length) {
          const result = await gather(entry, entry.to)
          done(entry, result.ok, moved + '；' + result.message); continue
        }
        done(entry, true, moved)
      } else if (entry.journal) {
        const result = finish(await retryVideoOrganize(d, entry.journal))
        done(entry, result.ok, result.message)
      } else {
        const result = await gather(entry, entry.to)
        done(entry, result.ok, result.message)
      }
    } catch (error) { done(entry, false, error instanceof Error ? error.message : String(error)) }
  }
  log.finishedAt = Date.now(); save()
  return { root: preview.root, record, outcomes }
}
