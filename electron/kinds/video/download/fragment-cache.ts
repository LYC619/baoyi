import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resourceUrlKey, strongResourceEtag, type ResourceOptions } from './resource.ts'

interface Entry { size: number; hash: string; identity: string; etag?: string; source?: string; resolved?: string }
interface Journal { identity: string; shape: string; files: Record<string, Entry> }
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
/** Query parameters alone are not proof of content identity. Shape only permits an HTTP validator check. */
export function fragmentShape(value: unknown): string {
  return hash(JSON.stringify(value, (key, item) => key === 'url' && typeof item === 'string' ? resourceUrlKey(item) : item))
}
export function createFragmentCache(directory: string, identity: string, shape: string, allowRenewal = true) {
  const file = path.join(directory, 'manifest.json')
  const journal: Journal = { identity, shape, files: {} }
  let message = ''
  try {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (previous.files && (previous.identity === identity || allowRenewal && previous.shape === shape)) {
      for (const [key, entry] of Object.entries(previous.files) as Array<[string, Entry]>) {
        // Keep each fragment's old identity until its own revalidation succeeds, even across another interruption.
        journal.files[key] = { ...entry, identity: entry.identity || previous.identity }
      }
      if (previous.identity !== identity) message = '来源链接已更新，正在验证缓存内容；无法确认的分片将重新下载'
    } else message = '播放清单已变化或旧缓存缺少验证信息，正在重新下载分片'
  } catch { /* No usable journal. */ }
  fs.mkdirSync(directory, { recursive: true })
  function read(key: string, target: string) {
    const entry = journal.files[key]
    try {
      if (!entry || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) return null
      const data = fs.readFileSync(target)
      return data.length === entry.size && hash(data) === entry.hash ? { entry, data } : null
    } catch { return null }
  }
  return {
    message,
    exact(key: string, target: string): Buffer | null {
      const cached = read(key, target)
      return cached?.entry.identity === identity ? cached.data : null
    },
    conditional(key: string, target: string, url: string): ResourceOptions['conditional'] {
      const cached = read(key, target), entry = cached?.entry
      if (!allowRenewal || !cached || !entry?.etag || !entry.resolved || entry.source !== resourceUrlKey(url)) return undefined
      return { data: cached.data, etag: entry.etag, resolved: entry.resolved }
    },
    save(key: string, target: string, data: Buffer, response?: { headers: Headers; url: string }, source?: string) {
      fs.writeFileSync(target + '.tmp', data); fs.renameSync(target + '.tmp', target)
      journal.files[key] = { identity, size: data.length, hash: hash(data),
        ...(response && source ? { etag: strongResourceEtag(response.headers.get('etag')), source: resourceUrlKey(source), resolved: resourceUrlKey(response.url) } : {}) }
      fs.writeFileSync(file + '.tmp', JSON.stringify(journal)); fs.renameSync(file + '.tmp', file)
    }
  }
}
