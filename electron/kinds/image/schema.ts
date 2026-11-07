import type { KindSchema } from '../types.ts'
import path from 'node:path'

export const imageSchema: KindSchema = {
  tables: `
    CREATE TABLE IF NOT EXISTS image_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS image_collection_members (
      collection_id TEXT NOT NULL REFERENCES image_collections(id) ON DELETE CASCADE,
      resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS image_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
      item_type TEXT NOT NULL DEFAULT 'comic' CHECK(item_type IN ('photo','comic','misc')),
      directory TEXT NOT NULL DEFAULT '', UNIQUE(item_type,name)
    );
    CREATE TABLE IF NOT EXISTS image_meta (
      resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('photo','comic','misc')),
      group_id TEXT REFERENCES image_groups(id) ON DELETE SET NULL,
      favorite INTEGER NOT NULL DEFAULT 0, publication TEXT NOT NULL DEFAULT 'unknown',
      cover_page_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '[]'
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
    CREATE TABLE IF NOT EXISTS image_reader_state (
      resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
      is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)), preferences TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS image_bookmarks (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
      page_id TEXT NOT NULL REFERENCES image_pages(id) ON DELETE CASCADE,
      scroll_offset REAL NOT NULL DEFAULT 0 CHECK(scroll_offset >= 0 AND scroll_offset <= 1),
      label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(resource_id,page_id)
    );
  `,
  migrate(db) {
    const columns = db.prepare('PRAGMA table_info(image_groups)').all() as {name:string}[]
    if (!columns.some(column => column.name === 'item_type')) {
      // No table points at image_meta. Preserve its group IDs while rebuilding the
      // old globally-unique groups table with foreign keys still enabled.
      db.exec('SAVEPOINT image_types')
      try {
        db.exec(`CREATE TEMP TABLE image_meta_saved AS SELECT * FROM image_meta;
          DROP TABLE image_meta;
          CREATE TABLE image_groups_next (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
            hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
            item_type TEXT NOT NULL DEFAULT 'comic' CHECK(item_type IN ('photo','comic','misc')),
            directory TEXT NOT NULL DEFAULT '', UNIQUE(item_type,name));
          INSERT INTO image_groups_next(id,name,sort_order,hidden) SELECT id,name,sort_order,hidden FROM image_groups;
          DROP TABLE image_groups;
          ALTER TABLE image_groups_next RENAME TO image_groups;
          CREATE TABLE image_meta (
            resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
            item_type TEXT NOT NULL CHECK(item_type IN ('photo','comic','misc')),
            group_id TEXT REFERENCES image_groups(id) ON DELETE SET NULL,
            favorite INTEGER NOT NULL DEFAULT 0, publication TEXT NOT NULL DEFAULT 'unknown',
            cover_page_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '');
          INSERT INTO image_meta SELECT * FROM image_meta_saved;
          DROP TABLE image_meta_saved;
          CREATE UNIQUE INDEX image_source_identity ON image_meta(source,source_id) WHERE source_id != '';
          `)
        const groups=db.prepare('SELECT id,name FROM image_groups').all() as {id:string;name:string}[]
        for(const group of groups){
          const safe=group.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,80)||'未分类'
          const rows=db.prepare('SELECT r.path FROM resource r JOIN image_meta m ON m.resource_id=r.id WHERE m.group_id=?').all(group.id) as {path:string}[]
          const parents=[...new Set(rows.map(row=>path.dirname(row.path)).filter(parent=>path.basename(parent)===safe))]
          if(parents.length===1)db.prepare('UPDATE image_groups SET directory=? WHERE id=?').run(parents[0],group.id)
        }
        db.exec('RELEASE image_types')
      } catch (error) { db.exec('ROLLBACK TO image_types; RELEASE image_types'); throw error }
    }
    db.exec('UPDATE image_meta SET group_id=NULL WHERE EXISTS(SELECT 1 FROM image_groups g WHERE g.id=image_meta.group_id AND g.item_type<>image_meta.item_type)')
    if(!(db.prepare('PRAGMA table_info(image_meta)').all() as {name:string}[]).some(column=>column.name==='authors'))db.exec("ALTER TABLE image_meta ADD COLUMN authors TEXT NOT NULL DEFAULT '[]'")
    const seeded = db.prepare("SELECT 1 FROM settings WHERE key = '_image_groups_seeded'").get()
    if (!seeded) {
      for (const [i, name] of ['待整理', '喜欢的作品'].entries()) {
        db.prepare('INSERT OR IGNORE INTO image_groups(id,name,sort_order) VALUES(?,?,?)').run(`image-group-${i}`, name, i)
      }
      db.prepare("INSERT INTO settings(key,value) VALUES('_image_groups_seeded','true')").run()
    }
  }
}
