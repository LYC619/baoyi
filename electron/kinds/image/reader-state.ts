import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageBookmark, ImagePreferences, ImageReaderPreferences } from '../../../src/types/image.ts'
import { DEFAULT_IMAGE_PREFERENCES, normalizeImagePreferences } from '../../../src/utils/image-preferences.ts'
import { ImageLibrary } from './library.ts'

export class ImageReaderState {
  private db: SqlDb
  constructor(db: SqlDb) { this.db = db }
  private available(id: string) {
    if (!new ImageLibrary(this.db).get(id)) throw new Error('资源不可用')
  }
  preferences(value?: ImagePreferences): Required<ImagePreferences> {
    if (value !== undefined) {
      const prefs = normalizeImagePreferences(value)
      this.db.prepare("INSERT INTO settings(key,value) VALUES('_image_reader',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(prefs))
    }
    const row = this.db.prepare("SELECT value FROM settings WHERE key='_image_reader'").get() as { value: string } | undefined
    try { return row ? normalizeImagePreferences(JSON.parse(row.value)) : { ...DEFAULT_IMAGE_PREFERENCES } }
    catch { return { ...DEFAULT_IMAGE_PREFERENCES } }
  }
  forWork(id: string, value?: ImagePreferences | null): ImageReaderPreferences {
    this.available(id)
    if (value !== undefined) {
      const preferences = value === null ? '' : JSON.stringify(normalizeImagePreferences(value))
      this.db.prepare('INSERT INTO image_reader_state(resource_id,preferences) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET preferences=excluded.preferences').run(id, preferences)
    }
    const row = this.db.prepare('SELECT preferences FROM image_reader_state WHERE resource_id=?').get(id) as { preferences: string } | undefined
    if (row?.preferences) {
      try { return { preferences: normalizeImagePreferences(JSON.parse(row.preferences)), customized: true } }
      catch { /* Malformed old preferences fall back to the global defaults. */ }
    }
    return { preferences: this.preferences(), customized: false }
  }
  bookmarks(id: string): ImageBookmark[] {
    this.available(id)
    const rows = this.db.prepare('SELECT b.*,p.ordinal,p.missing FROM image_bookmarks b JOIN image_pages p ON p.id=b.page_id WHERE b.resource_id=? ORDER BY p.ordinal,b.created_at').all(id) as Array<{ id: string; page_id: string; ordinal: number; missing: number; scroll_offset: number; label: string; created_at: number }>
    return rows.map(row => ({ id: row.id, resourceId: id, pageId: row.page_id, ordinal: row.ordinal, offset: row.scroll_offset, label: row.label, missing: !!row.missing, createdAt: row.created_at }))
  }
  saveBookmark(id: string, pageId: string, offset: number, label?: string): ImageBookmark {
    this.available(id)
    if (!this.db.prepare('SELECT 1 FROM image_pages WHERE id=? AND resource_id=? AND missing=0').get(pageId, id)) throw new Error('书签页面不可用')
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset > 1) throw new Error('书签位置无效')
    if (label !== undefined && typeof label !== 'string') throw new Error('书签名称无效')
    const old = this.db.prepare('SELECT id,label FROM image_bookmarks WHERE resource_id=? AND page_id=?').get(id, pageId) as { id: string; label: string } | undefined
    const bookmarkId = old?.id || randomUUID(), name = label === undefined ? old?.label || '' : label.trim().slice(0, 200)
    this.db.prepare('INSERT INTO image_bookmarks(id,resource_id,page_id,scroll_offset,label,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(resource_id,page_id) DO UPDATE SET scroll_offset=excluded.scroll_offset,label=excluded.label').run(bookmarkId, id, pageId, offset, name, Date.now())
    return this.bookmarks(id).find(b => b.id === bookmarkId)!
  }
  removeBookmark(id: string, bookmarkId: string): void {
    this.available(id)
    if (!this.db.prepare('SELECT 1 FROM image_bookmarks WHERE id=? AND resource_id=?').get(bookmarkId, id)) throw new Error('书签不可用')
    this.db.prepare('DELETE FROM image_bookmarks WHERE id=? AND resource_id=?').run(bookmarkId, id)
  }
}
