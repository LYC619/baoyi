import type { KindSchema } from '../types.ts'

export const imageSchema: KindSchema = {
  tables: `
    CREATE TABLE IF NOT EXISTS image_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS image_meta (
      resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('photo','comic')),
      group_id TEXT REFERENCES image_groups(id) ON DELETE SET NULL,
      favorite INTEGER NOT NULL DEFAULT 0, publication TEXT NOT NULL DEFAULT 'unknown',
      cover_page_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS image_source_identity ON image_meta(source, source_id) WHERE source_id != '';
    CREATE TABLE IF NOT EXISTS image_chapters (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
      chapter_key TEXT NOT NULL, title TEXT NOT NULL, ordinal INTEGER NOT NULL, source_id TEXT NOT NULL DEFAULT '', customized INTEGER NOT NULL DEFAULT 0,
      UNIQUE(resource_id, chapter_key)
    );
    CREATE TABLE IF NOT EXISTS image_pages (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
      chapter_id TEXT REFERENCES image_chapters(id) ON DELETE CASCADE,
      file TEXT NOT NULL, entry TEXT NOT NULL DEFAULT '', ordinal INTEGER NOT NULL, size INTEGER NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0, UNIQUE(resource_id, file, entry)
    );
    CREATE INDEX IF NOT EXISTS image_pages_order ON image_pages(resource_id, chapter_id, missing, ordinal);
    CREATE TABLE IF NOT EXISTS image_progress (
      resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL REFERENCES image_pages(id) ON DELETE CASCADE,
      scroll_offset REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_download_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
  `,
  migrate(db) {
    const seeded = db.prepare("SELECT 1 FROM settings WHERE key = '_image_groups_seeded'").get()
    if (!seeded) {
      for (const [i, name] of ['日漫', '韩漫', '欧美漫画', '其他'].entries()) {
        db.prepare('INSERT OR IGNORE INTO image_groups(id,name,sort_order) VALUES(?,?,?)').run(`image-group-${i}`, name, i)
      }
      db.prepare("INSERT INTO settings(key,value) VALUES('_image_groups_seeded','true')").run()
    }
  }
}
