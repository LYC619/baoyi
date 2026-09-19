/**
 * 统一移动（实测第三轮）：把已入库的作品挪成「整理根目录 / 收藏分组 / 作品文件夹」，没分组的直接放根目录下。
 *
 * 两条路，按作品有没有绑定目录分：
 * - 绑定了目录的：整个目录 rename 过去（同一块盘上是瞬时的），再用 rebaseMovedVideoDirectory 把库里所有路径改过来。
 *   跨盘不做（rename 会变成整盘复制，那是「目录管理 / 重新绑定」里复制整目录的活）。
 * - 只有散文件、没绑定目录的：走现成的物理整理（previewVideoOrganize + applyVideoOrganize，transfer=move），
 *   复制→校验→切引用→删原件，带整理日志，能在「整理记录」里重试和回退。
 *
 * ponytail: 目录 rename 这条路没有走整理日志，只在 userData/library-layout/ 留一份 from→to 的记录；
 * 要回退就按记录反着 rename 再「重新绑定」。真要日志化得给 video_organize_journal 的 kind 加值，这轮不做。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SqlDb } from '../../services/schema.ts'
import type { VideoLayoutEntry, VideoLayoutPreview, VideoLayoutResult } from '../../../src/types/video-organize.ts'
import { getVideo } from './db.ts'
import { getVideoWorkLibrary } from './library.ts'
import { safeWorkFolderName } from './bundle.ts'
import { rebaseMovedVideoDirectory, videoPathKey } from './local-files.ts'
import { applyVideoOrganize, previewVideoOrganize } from './organize.ts'
import { resolveVideoOrganizeOwner } from './organize-owner.ts'
import { persistVideoWorkBundle } from './local-sync.ts'

const same = (a: string, b: string) => videoPathKey(a) === videoPathKey(b)
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
const groupFolder = (group: string) => group.trim() ? safeWorkFolderName(group) : ''

export function previewVideoLayout(d: SqlDb, ids: string[], root: string): VideoLayoutPreview {
  root = path.resolve(root)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('整理根目录不存在或不可用：' + root)
  const entries: VideoLayoutEntry[] = [], targets = new Set<string>()
  const others = d.prepare("SELECT id, path FROM resource WHERE kind = 'video' AND is_archived = 0").all() as Array<{ id: string; path: string }>
  const bindings = d.prepare('SELECT resource_id, directory_path FROM video_directories').all() as Array<{ resource_id: string; directory_path: string }>
  for (const id of [...new Set(ids)]) {
    const item = getVideo(d, id)
    if (!item || item.is_archived || resolveVideoOrganizeOwner(d, id) !== id) continue
    const title = item.name_zh || item.name_en || item.file_name, group = item.collection_name || ''
    const to = path.join(root, groupFolder(group), safeWorkFolderName(title))
    const library = getVideoWorkLibrary(d, id)
    const videos = library.assets.filter(asset => asset.role === 'video')
    const push = (from: string, action: VideoLayoutEntry['action'], reason = '') => entries.push({ resourceId: id, title, group, from, to, action, reason, files: videos.length })
    if (library.directory) {
      const from = library.directory.path
      if (same(from, to)) { push(from, 'in-place', '已在目标位置'); continue }
      if (!fs.existsSync(from)) { push(from, 'skip', '作品目录当前不可用（磁盘离线或已移走），可先「检查文件」'); continue }
      if (same(from, root) || inside(from, root)) { push(from, 'skip', '作品目录包含整理根目录，不能移动'); continue }
      if (fs.existsSync(to)) { push(from, 'skip', '目标目录已存在，未覆盖'); continue }
      if (targets.has(videoPathKey(to))) { push(from, 'skip', '另一部作品也要搬到同名目录，请先改名'); continue }
      const occupied = others.some(row => row.id !== id && row.path && (same(row.path, from) || inside(from, row.path)) && resolveVideoOrganizeOwner(d, row.id) !== id)
        || bindings.some(row => row.resource_id !== id && (same(row.directory_path, from) || inside(from, row.directory_path)))
      if (occupied) { push(from, 'skip', '目录里还有其他作品，请先整理归属'); continue }
      if (path.parse(from).root.toLowerCase() !== path.parse(to).root.toLowerCase()) { push(from, 'skip', '跨磁盘不移动；请用「目录管理 / 重新绑定」复制整目录'); continue }
      targets.add(videoPathKey(to)); push(from, 'move-directory')
      continue
    }
    if (!videos.length) { push('', 'skip', '没有本地文件'); continue }
    const from = path.dirname(videos[0].path)
    if (videos.every(asset => inside(to, asset.path))) { push(from, 'in-place', '文件已在目标目录'); continue }
    if (targets.has(videoPathKey(to))) { push(from, 'skip', '另一部作品也要搬到同名目录，请先改名'); continue }
    try {
      const preview = previewVideoOrganize(d, { resourceIds: [id], survivorId: id, targetDirectory: to, root, transfer: 'move' })
      if (!preview.canOrganize) { push(from, 'skip', preview.collisions.find(c => c.scope !== 'file')?.message || preview.collisions[0]?.message || '整理预览未通过'); continue }
      const trouble = preview.collisions.filter(c => c.scope === 'file').length
      targets.add(videoPathKey(to)); push(from, 'move-files', trouble ? `${trouble} 个文件有问题，会跳过` : '')
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
        done(entry, true, '已移动整个作品目录' + (note ? '；' + note : ''))
      } else {
        const plan = previewVideoOrganize(d, { resourceIds: [entry.resourceId], survivorId: entry.resourceId, targetDirectory: entry.to, root: preview.root, transfer: 'move' })
        if (!plan.canOrganize) throw new Error(plan.collisions.find(c => c.scope !== 'file')?.message || '整理预览未通过')
        const journal = await applyVideoOrganize(d, { preview: plan, mode: 'physical' })
        const moved = journal.files.filter(file => file.status === 'switched').length
        if (journal.status === 'applied') {
          // ponytail: 只删「搬空了」的原目录；里面还剩别的东西就留着
          try { if (entry.from && !same(entry.from, preview.root) && fs.existsSync(entry.from) && !fs.readdirSync(entry.from).length) fs.rmdirSync(entry.from) } catch { /* 留着也无妨 */ }
          done(entry, true, `已把 ${moved} 个文件搬进新目录`)
        } else done(entry, false, `部分文件未处理（已搬 ${moved} 个）：` + [...journal.conflicts, ...journal.files.filter(f => f.status === 'failed').map(f => f.error)].filter(Boolean).slice(0, 3).join('；') + '；可在「整理记录」里重试或回退')
      }
    } catch (error) { done(entry, false, error instanceof Error ? error.message : String(error)) }
  }
  log.finishedAt = Date.now(); save()
  return { root: preview.root, record, outcomes }
}
