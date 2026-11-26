import fs from 'node:fs/promises'
import { constants, createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../services/storage/schema.ts'
import { DocumentLibrary } from './documents.ts'
import { WorkspaceLinks } from './links.ts'
import { samePath } from '../kinds/project/paths.ts'
import { transaction } from './validation.ts'
import type {
  DocumentSubmodule,
  DocumentOrganizePreview,
  DocumentOrganizePreviewItem,
  DocumentOrganizeResult
} from '../../src/types/workspace.ts'

export interface FileStamp {
  identity: string
  digest: string
  size: number
}

export interface DocumentFilePlan {
  id: string
  projectId?: string
  source: string
  destination: string
  mode: 'link' | 'copy' | 'move'
  stamp: FileStamp
  createdAt: number
}

export interface DocumentFileOperation extends DocumentFilePlan {
  documentId: string
  state: 'prepared' | 'copied' | 'committed' | 'done' | 'attention'
  destinationIdentity: string
  error: string
  undone?: boolean
  undoPending?: boolean
  undoSourceIdentity?: string
  undoDestinationIdentity?: string
}

export const fileIdentity = (s: { dev: number; ino: number; birthtimeMs: number }) =>
  `${process.platform === 'win32' ? 0 : s.dev}:${s.ino}:${s.birthtimeMs}`

export async function inspectActualFile(file: string): Promise<FileStamp> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) {
    throw new Error('请选择完整文件路径')
  }
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || !samePath(await fs.realpath(file), file)) {
    throw new Error('请选择实际文件，不支持链接或特殊文件')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const after = await fs.lstat(file)
  if (
    fileIdentity(before) !== fileIdentity(after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('文件读取期间发生变化，请重试')
  }
  return { identity: fileIdentity(after), digest: hash.digest('hex'), size: after.size }
}

export async function actualDirectory(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error('请选择完整目录路径')
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) {
    throw new Error('目标必须是已存在的实际目录，不支持目录链接')
  }
}

export function sanitizePathComponent(name: string): string {
  let clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  clean = clean.replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) {
    clean = '_' + clean
  }
  return clean || '未命名'
}

const matches = (a: FileStamp, b: FileStamp) =>
  a.identity === b.identity && a.digest === b.digest && a.size === b.size

export class DocumentFiles {
  readonly db: SqlDb
  constructor(db: SqlDb) {
    this.db = db
  }

  locations(id: string): Array<{ path: string; primary: boolean; available: boolean }> {
    const row = this.db.prepare("SELECT path FROM resource WHERE id=? AND kind='document'").get(id) as
      | { path: string }
      | undefined
    if (!row) throw new Error('资料不存在')
    const files = this.db.prepare('SELECT path FROM document_files WHERE resource_id=?').all(id) as {
      path: string
    }[]
    return [row, ...files.filter((f) => !samePath(f.path, row.path))].map((f) => ({
      path: f.path,
      primary: samePath(f.path, row.path),
      available: existsSync(f.path)
    }))
  }

  private project(id: string) {
    if (!this.db.prepare("SELECT 1 FROM resource WHERE id=? AND kind='project'").get(id)) {
      throw new Error('项目不存在')
    }
  }

  async plan(
    projectId: string | undefined,
    source: string,
    mode: DocumentFilePlan['mode'],
    destination = ''
  ): Promise<DocumentFilePlan> {
    if (projectId) this.project(projectId)
    if (!['link', 'copy', 'move'].includes(mode)) throw new Error('文件操作方式无效')
    const stamp = await inspectActualFile(source)
    source = path.resolve(source)
    if (mode !== 'link') {
      if (!path.isAbsolute(destination) || destination.includes('\0')) {
        throw new Error('目标必须是完整文件路径')
      }
      destination = path.resolve(destination)
      if (samePath(source, destination)) throw new Error('目标不能是文件自身')
      await actualDirectory(path.dirname(destination))
      const name = path.basename(destination)
      if (
        /[<>:"|?*\x00-\x1f]/.test(name) ||
        /[. ]$/.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
      ) {
        throw new Error('目标文件名无效')
      }
      if (
        existsSync(destination) ||
        this.db.prepare('SELECT 1 FROM resource WHERE path=? COLLATE NOCASE').get(destination) ||
        this.db.prepare('SELECT 1 FROM document_files WHERE path=? COLLATE NOCASE').get(destination)
      ) {
        throw new Error('目标已存在或已登记，请选择其他文件名')
      }
    }
    return {
      id: randomUUID(),
      projectId,
      source,
      mode,
      destination: mode === 'link' ? source : destination,
      stamp,
      createdAt: Date.now()
    }
  }

  operations(): DocumentFileOperation[] {
    return (
      this.db
        .prepare('SELECT payload FROM document_file_operations ORDER BY created_at DESC,rowid DESC')
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload))
  }

  private save(op: DocumentFileOperation) {
    this.db
      .prepare(
        'INSERT INTO document_file_operations(id,resource_id,state,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload'
      )
      .run(op.id, op.documentId, op.state, op.createdAt, JSON.stringify(op))
    return op
  }

  async execute(
    plan: DocumentFilePlan,
    hooks: { afterCopy?: () => void } = {}
  ): Promise<DocumentFileOperation> {
    if (Date.now() - plan.createdAt > 30 * 60_000) throw new Error('文件预览已过期')
    const checked = await this.plan(plan.projectId, plan.source, plan.mode, plan.destination)
    if (!matches(checked.stamp, plan.stamp)) throw new Error('源文件在预览后发生变化，请重新选择')
    const doc = await new DocumentLibrary(this.db).register(plan.source, undefined, true)
    const op: DocumentFileOperation = {
      ...plan,
      documentId: doc.id,
      state: 'prepared',
      destinationIdentity: '',
      error: ''
    }
    this.save(op)
    try {
      if (plan.mode === 'link') return this.commit(op)
      await fs.copyFile(plan.source, plan.destination, constants.COPYFILE_EXCL)
      const copied = await inspectActualFile(plan.destination)
      op.destinationIdentity = copied.identity
      op.state = 'copied'
      this.save(op)
      if (copied.digest !== plan.stamp.digest || copied.size !== plan.stamp.size) {
        throw new Error('副本校验失败，源文件已保留')
      }
      hooks.afterCopy?.()
      return await this.finish(op)
    } catch (error) {
      op.state = 'attention'
      op.error = (error as Error).message
      this.save(op)
      throw error
    }
  }

  private commit(op: DocumentFileOperation) {
    transaction(this.db, () => {
      if (op.mode !== 'link') {
        this.db
          .prepare(
            'INSERT INTO document_files(id,resource_id,path,project_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO NOTHING'
          )
          .run(randomUUID(), op.documentId, op.destination, op.projectId || null, Date.now())
        if (op.mode === 'move') {
          this.db
            .prepare(
              'UPDATE resource SET path=?,file_name=?,source_dir=?,updated_at=? WHERE id=? AND path=? COLLATE NOCASE'
            )
            .run(
              op.destination,
              path.basename(op.destination),
              path.dirname(op.destination),
              Date.now(),
              op.documentId,
              op.source
            )
          this.db
            .prepare('DELETE FROM document_files WHERE resource_id=? AND path=? COLLATE NOCASE')
            .run(op.documentId, op.source)
        }
      }
      if (op.projectId) {
        new WorkspaceLinks(this.db).add('project', op.projectId, op.documentId)
      }
      op.state = op.mode === 'move' ? 'committed' : 'done'
      op.error = ''
      this.save(op)
    })
    return op
  }

  private async finish(op: DocumentFileOperation) {
    if (op.projectId) this.project(op.projectId)
    await actualDirectory(path.dirname(op.destination))
    const target = await inspectActualFile(op.destination)
    if (
      !op.destinationIdentity ||
      target.identity !== op.destinationIdentity ||
      target.digest !== op.stamp.digest ||
      target.size !== op.stamp.size
    ) {
      throw new Error('目标文件已变化，不能自动恢复')
    }
    const sourceExists = existsSync(op.source)
    if (sourceExists && !matches(await inspectActualFile(op.source), op.stamp)) {
      throw new Error('源文件已变化，保留两份文件，请人工检查')
    }
    this.commit(op)
    if (op.mode === 'move' && sourceExists) {
      if (!matches(await inspectActualFile(op.source), op.stamp)) {
        throw new Error('源文件已变化，未删除原文件')
      }
      await fs.unlink(op.source)
    }
    op.state = 'done'
    op.error = ''
    return this.save(op)
  }

  async recover(id: string) {
    const op = this.operations().find((r) => r.id === id)
    if (!op) throw new Error('文件操作记录不存在')
    if (op.state === 'done' && !op.undoPending) return op
    try {
      if (op.undoPending) return await this.finishUndo(op)
      // Older successful undos used state=prepared. Never replay them forwards.
      if (op.undone) { op.state = 'done'; return this.save(op) }
      if (op.mode !== 'link' && !op.destinationIdentity && !existsSync(op.destination)) {
        const checked = await this.plan(op.projectId, op.source, op.mode, op.destination)
        if (!matches(checked.stamp, op.stamp)) throw new Error('源文件已变化，不能重试复制')
        await fs.copyFile(op.source, op.destination, constants.COPYFILE_EXCL)
        const stamp = await inspectActualFile(op.destination)
        op.destinationIdentity = stamp.identity
        op.state = 'copied'
        this.save(op)
      }
      return op.mode === 'link' ? this.commit(op) : await this.finish(op)
    } catch (error) {
      op.state = 'attention'
      op.error = (error as Error).message
      this.save(op)
      throw error
    }
  }

  async undo(id: string): Promise<{ undone: boolean; reason?: string }> {
    const op = this.operations().find((r) => r.id === id)
    if (!op) throw new Error('文件操作记录不存在')
    if (op.undoPending) { await this.recover(id); return { undone: true } }
    if (op.state !== 'done' || op.undone) {
      return { undone: false, reason: '该操作未能成功或已经撤销' }
    }
    if (op.mode !== 'move') {
      return { undone: false, reason: '仅移动操作支持撤销回原路径' }
    }
    const current = new DocumentLibrary(this.db).require(op.documentId)
    if (!samePath(current.path, op.destination)) return { undone: false, reason: '资料位置已改变，请先处理后续移动记录' }
    if (!existsSync(op.destination)) {
      return { undone: false, reason: '目标文件已不存在，无法撤销' }
    }
    const targetStamp = await inspectActualFile(op.destination)
    if (targetStamp.digest !== op.stamp.digest) {
      return { undone: false, reason: '目标文件已被外部修改，停止自动撤销并保留现状' }
    }
    if (existsSync(op.source)) {
      return { undone: false, reason: '原文件位置已存在同名文件，无法撤销' }
    }
    await fs.mkdir(path.dirname(op.source), { recursive: true })
    await fs.copyFile(op.destination, op.source, constants.COPYFILE_EXCL)
    const sourceStamp = await inspectActualFile(op.source)
    if (sourceStamp.digest !== op.stamp.digest) {
      throw new Error('恢复原文件校验失败，原文件未恢复')
    }
    op.undoPending = true
    op.state = 'prepared'
    op.undoSourceIdentity = sourceStamp.identity
    op.undoDestinationIdentity = targetStamp.identity
    this.save(op)
    try { await this.finishUndo(op) }
    catch (error) { op.state = 'attention'; op.error = (error as Error).message; this.save(op); throw error }
    return { undone: true }
  }

  private async finishUndo(op: DocumentFileOperation) {
    const source = await inspectActualFile(op.source)
    if (!op.undoSourceIdentity || source.identity !== op.undoSourceIdentity || source.digest !== op.stamp.digest || source.size !== op.stamp.size) {
      throw new Error('撤销后的原文件已变化，保留两份文件，请人工检查')
    }
    const current = new DocumentLibrary(this.db).require(op.documentId)
    if (!samePath(current.path, op.source) && !samePath(current.path, op.destination)) throw new Error('资料位置已变化，停止恢复撤销')
    const targetExists = existsSync(op.destination)
    if (targetExists) {
      const target = await inspectActualFile(op.destination)
      if (target.identity !== (op.undoDestinationIdentity || op.destinationIdentity) || target.digest !== op.stamp.digest || target.size !== op.stamp.size) throw new Error('目标文件已变化，保留两份文件，请人工检查')
    }
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE resource SET path=?,file_name=?,source_dir=?,updated_at=? WHERE id=?')
        .run(op.source, path.basename(op.source), path.dirname(op.source), Date.now(), op.documentId)
      this.db
        .prepare('DELETE FROM document_files WHERE resource_id=? AND path=? COLLATE NOCASE')
        .run(op.documentId, op.destination)
      this.save(op)
    })
    if (targetExists) {
      const target = await inspectActualFile(op.destination)
      if (target.identity !== (op.undoDestinationIdentity || op.destinationIdentity) || target.digest !== op.stamp.digest) throw new Error('目标文件已变化，未删除副本')
      const restored = await inspectActualFile(op.source)
      if (restored.identity !== op.undoSourceIdentity || restored.digest !== op.stamp.digest || restored.size !== op.stamp.size) throw new Error('撤销后的原文件已变化，未删除副本')
      await fs.unlink(op.destination)
    }
    op.state = 'done'; op.undone = true; op.undoPending = false; op.error = ''
    return this.save(op)
  }

  async previewOrganize(options: {
    rootDir: string
    mode: 'copy' | 'move'
    submodule?: DocumentSubmodule
    useCustomGroups?: boolean
  }): Promise<DocumentOrganizePreview> {
    const rootDir = path.resolve(options.rootDir)
    await actualDirectory(rootDir)
    const docs = new DocumentLibrary(this.db)
    const categories = docs.categories()
    const customGroups = docs.customGroups()
    const allItems = docs.list({ submodule: options.submodule })

    const items: DocumentOrganizePreviewItem[] = []
    let readyCount = 0
    let skipCount = 0
    let conflictCount = 0
    let missingCount = 0

    for (const item of allItems) {
      const source = path.resolve(item.path)
      const subDir = item.submodule === 'archive' ? '资料' : '阅读'
      const cat = categories.find((c) => c.id === item.type)
      const catDir = sanitizePathComponent(cat ? cat.name : '未分类')

      let grpDir = ''
      let grpName = ''
      if (options.useCustomGroups && item.customGroupId) {
        const grp = customGroups.find((g) => g.id === item.customGroupId)
        if (grp) {
          grpDir = sanitizePathComponent(grp.name)
          grpName = grp.name
        }
      }

      const ext = path.extname(source)
      const base = path.basename(source, ext)
      const safeFileName = sanitizePathComponent(base) + ext

      const targetDir = grpDir
        ? path.join(rootDir, subDir, catDir, grpDir)
        : path.join(rootDir, subDir, catDir)
      const destination = path.join(targetDir, safeFileName)

      let status: 'ready' | 'skip' | 'conflict' | 'missing' = 'ready'
      let reason = ''

      if (!destination.startsWith(rootDir + path.sep)) {
        status = 'conflict'
        reason = '目标路径越界'
        conflictCount++
      } else if (samePath(source, destination)) {
        status = 'skip'
        reason = '已在目标位置'
        skipCount++
      } else if (!existsSync(source)) {
        status = 'missing'
        reason = '源文件不存在'
        missingCount++
      } else if (existsSync(destination)) {
        status = 'conflict'
        reason = '目标位置已存在同名文件'
        conflictCount++
      } else {
        readyCount++
      }

      items.push({
        id: item.id,
        name: item.name,
        submodule: item.submodule,
        categoryName: cat ? cat.name : '未分类',
        groupName: grpName,
        source,
        destination,
        size: item.size,
        status,
        reason
      })
    }

    return {
      total: items.length,
      ready: readyCount,
      skip: skipCount,
      conflict: conflictCount,
      missing: missingCount,
      items
    }
  }

  async executeOrganize(options: {
    rootDir: string
    mode: 'copy' | 'move'
    submodule?: DocumentSubmodule
    useCustomGroups?: boolean
    selectedIds?: string[]
  }): Promise<DocumentOrganizeResult> {
    const preview = await this.previewOrganize(options)
    const selectedSet = options.selectedIds ? new Set(options.selectedIds) : null
    const candidates = preview.items.filter((item) => {
      if (selectedSet && !selectedSet.has(item.id)) return false
      return item.status === 'ready'
    })

    const results: DocumentOrganizeResult['items'] = []
    let succeeded = 0
    let skipped = 0
    let failed = 0

    for (const item of preview.items) {
      if (selectedSet && !selectedSet.has(item.id)) continue
      if (item.status === 'skip') {
        skipped++
        results.push({
          id: item.id,
          name: item.name,
          source: item.source,
          destination: item.destination,
          status: 'skipped',
          error: item.reason
        })
      } else if (item.status === 'conflict' || item.status === 'missing') {
        failed++
        results.push({
          id: item.id,
          name: item.name,
          source: item.source,
          destination: item.destination,
          status: 'failed',
          error: item.reason
        })
      }
    }

    for (const item of candidates) {
      try {
        await fs.mkdir(path.dirname(item.destination), { recursive: true })
        const plan = await this.plan(undefined, item.source, options.mode, item.destination)
        const op = await this.execute(plan)
        succeeded++
        results.push({
          id: item.id,
          name: item.name,
          source: item.source,
          destination: item.destination,
          status: 'success',
          operationId: op.id
        })
      } catch (err: any) {
        failed++
        results.push({
          id: item.id,
          name: item.name,
          source: item.source,
          destination: item.destination,
          status: 'failed',
          error: err?.message || String(err)
        })
      }
    }

    return {
      total: results.length,
      succeeded,
      skipped,
      failed,
      items: results
    }
  }
}
