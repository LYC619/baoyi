import { randomUUID } from 'node:crypto'
import type { SqlDb } from './schema.ts'
import type { WebBrowserSource, WebBrowserSourceInput } from '../../src/types/web-browser.ts'
import { normalizeWebUrl } from './web-browser-url.ts'

const key = 'web_browser_sources'
/** Website shortcuts are browsing settings, not local resources or film metadata. */
export function createWebBrowserSources(db: SqlDb) {
  function list(): WebBrowserSource[] {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
    if (!row) return []
    try {
      const values = JSON.parse(row.value)
      if (!Array.isArray(values) || values.length > 64) throw new Error()
      const ids = new Set<string>()
      return values.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) throw new Error()
        ids.add(item.id)
        return { id: item.id, name: item.name, url: normalizeWebUrl(item.url) }
      })
    } catch { throw new Error('保存的网页来源无法读取，原数据已保留') }
  }
  function write(values: WebBrowserSource[]) {
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(values))
  }
  function save(input: WebBrowserSourceInput): WebBrowserSource {
    if (!input || typeof input !== 'object' || input.id !== undefined && typeof input.id !== 'string') throw new Error('网页来源无效')
    const url = normalizeWebUrl(input.url)
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 100)) throw new Error('来源名称不能超过 100 字')
    const name = input.name?.trim() || new URL(url).hostname.slice(0, 100), values = list()
    const old = input.id ? values.find(item => item.id === input.id) : values.find(item => item.url === url)
    if (input.id && !old) throw new Error('网页来源已不存在，请重新添加')
    if (values.some(item => item.url === url && item.id !== old?.id)) throw new Error('这个网址已保存为其他来源')
    if (!old && values.length >= 64) throw new Error('最多保存 64 个网页来源')
    const next = { id: old?.id || randomUUID(), name, url }
    if (old) values[values.findIndex(item => item.id === old.id)] = next
    else values.push(next)
    write(values); return next
  }
  function remove(id: string) {
    if (typeof id !== 'string') throw new Error('网页来源无效')
    write(list().filter(item => item.id !== id))
  }
  return { list, save, remove }
}
