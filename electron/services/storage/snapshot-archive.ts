import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createGzip, createGunzip } from 'node:zlib'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readSnapshotInventory } from './library-snapshots.ts'
import type { LibrarySnapshot, SnapshotArchiveResult } from '../../../src/types/library-snapshot.ts'

const locks = new Map<string, Promise<unknown>>()
async function exclusive<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory)
  const previous = locks.get(key) || Promise.resolve()
  const pending = previous.catch(() => { /* 原始 Promise 的错误已交给调用方；这里只释放队列或监听。 */ }).then(run)
  locks.set(key, pending)
  try { return await pending } finally { if (locks.get(key) === pending) locks.delete(key) }
}
const rootFor = (directory: string) => path.join(path.resolve(directory), 'library-snapshots')
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
async function stat(file: string) {
  try { return await fs.promises.lstat(file) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
}
async function regular(file: string) {
  const info = await stat(file)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('快照不是普通文件：' + path.basename(file))
  return info
}
async function checkRoot(directory: string) {
  const info = await stat(directory)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('快照目录不能是链接或文件')
}
function sameFile(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs }
async function syncFile(file: string) {
  const handle = await fs.promises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
async function verify(file: string, gzip: boolean, expected: Pick<LibrarySnapshot, 'size' | 'sha256'>) {
  const before = await regular(file), hash = createHash('sha256')
  let bytes = 0
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
    bytes += chunk.length
    if (bytes > expected.size) { done(new Error('快照解压长度超出记录')); return }
    hash.update(chunk); done()
  } })
  const input = fs.createReadStream(file)
  if (gzip) await pipeline(input, createGunzip(), sink)
  else await pipeline(input, sink)
  if (bytes !== expected.size || hash.digest('hex') !== expected.sha256 || !sameFile(before, await regular(file))) throw new Error('快照内容与原始摘要不一致')
}
async function publishManifest(file: string, snapshot: LibrarySnapshot) {
  const temporary = file + '.' + randomUUID() + '.tmp'
  const handle = await fs.promises.open(temporary, 'wx')
  try { await handle.writeFile(JSON.stringify(snapshot, null, 2)); await handle.sync() }
  finally { await handle.close() }
  try { await fs.promises.rename(temporary, file) }
  finally { await fs.promises.rm(temporary, { force: true }).catch(() => { /* best-effort */ }) }
}

/** Keeps every recovery point. Only verified duplicate raw bytes are removed after publication. */
export function archiveLibrarySnapshots(directory: string, keepRecent = 3): Promise<SnapshotArchiveResult> {
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 1) return Promise.reject(new Error('至少保留一份原始升级快照'))
  return exclusive(directory, async () => {
    const root = rootFor(directory)
    await checkRoot(root)
    const inventory = readSnapshotInventory(directory, 1000)
    const result: SnapshotArchiveResult = { archived: 0, reclaimedBytes: 0, retained: 0, warnings: [...inventory.warnings] }
    const keep = new Set(inventory.snapshots.filter(item => item.reason === 'upgrade').slice(0, keepRecent).map(item => item.id))
    for (const entry of inventory.snapshots) {
      if (entry.reason !== 'upgrade' || keep.has(entry.id) || entry.state !== 'available') { result.retained++; continue }
      const { state: _state, ...snapshot } = entry
      const original = path.join(root, snapshot.id + '.db'), archived = path.join(root, snapshot.id + '.db.gz'), manifest = path.join(root, snapshot.id + '.json')
      let temporary = ''
      try {
        if (snapshot.compression === 'gzip') {
          // Recover a previous interruption between manifest publication and removal of the raw duplicate.
          if (await stat(original)) {
            await verify(archived, true, snapshot); await verify(original, false, snapshot)
            await fs.promises.unlink(original); result.reclaimedBytes += snapshot.size
          }
          continue
        }
        const before = await regular(original), manifestBefore = await fs.promises.readFile(manifest, 'utf8')
        if (before.size !== snapshot.size || JSON.parse(manifestBefore).file !== snapshot.file) throw new Error('快照在整理前已变化')
        if (!await stat(archived)) {
          temporary = archived + '.' + randomUUID() + '.tmp'
          const hash = createHash('sha256'); let bytes = 0
          const measure = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk) } })
          await pipeline(fs.createReadStream(original), measure, createGzip({ level: 6 }), fs.createWriteStream(temporary, { flags: 'wx' }))
          if (bytes !== snapshot.size || hash.digest('hex') !== snapshot.sha256 || !sameFile(before, await regular(original))) throw new Error('原始快照内容已变化，保留原件')
          if ((await regular(temporary)).size >= snapshot.size) { result.retained++; continue }
          await verify(temporary, true, snapshot); await syncFile(temporary)
          // Exclusive publication: an existing file can never be silently replaced.
          await fs.promises.link(temporary, archived)
          await fs.promises.unlink(temporary); temporary = ''
        } else {
          // A verified archive left before manifest publication can be resumed.
          await verify(archived, true, snapshot); await verify(original, false, snapshot)
        }
        if (!sameFile(before, await regular(original)) || await fs.promises.readFile(manifest, 'utf8') !== manifestBefore) throw new Error('快照或说明在整理期间变化，保留原件')
        const storedSize = (await regular(archived)).size
        await publishManifest(manifest, { ...snapshot, file: snapshot.id + '.db.gz', compression: 'gzip', storedSize })
        await fs.promises.unlink(original)
        result.archived++; result.reclaimedBytes += snapshot.size - storedSize
      } catch (cause) { result.warnings.push(`${snapshot.id}：${message(cause)}`) }
      finally { if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => { /* best-effort */ }) }
    }
    return result
  })
}

/** Export to a new file. Existing databases or user files are never overwritten. */
export function exportLibrarySnapshot(directory: string, id: string, destination: string): Promise<{ file: string; size: number; sha256: string }> {
  return exclusive(directory, async () => {
    const root = rootFor(directory)
    await checkRoot(root)
    const snapshot = readSnapshotInventory(directory, 1000).snapshots.find(item => item.id === id)
    if (!snapshot || snapshot.state !== 'available') throw new Error('快照不可用，请刷新后重试')
    if (!path.isAbsolute(destination)) throw new Error('请选择完整导出路径')
    const relative = path.relative(root, path.resolve(destination))
    if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('请导出到快照目录之外')
    if (await stat(destination)) throw new Error('目标文件已存在，请选择新的文件名')
    const source = path.join(root, snapshot.file), before = await regular(source)
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      if (snapshot.compression === 'gzip') {
        let bytes = 0
        const limit = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; done(bytes > snapshot.size ? new Error('快照解压长度超出记录') : null, chunk) } })
        await pipeline(fs.createReadStream(source), createGunzip(), limit, fs.createWriteStream(temporary, { flags: 'wx' }))
      } else await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
      await verify(temporary, false, snapshot)
      if (!sameFile(before, await regular(source))) throw new Error('快照在导出期间变化')
      await syncFile(temporary)
      await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL)
      await syncFile(destination)
      return { file: destination, size: snapshot.size, sha256: snapshot.sha256 }
    } finally { await fs.promises.rm(temporary, { force: true }).catch(() => { /* best-effort */ }) }
  })
}
