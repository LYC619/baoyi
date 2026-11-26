import type { ResourceKindModule } from '../types.ts'
import type { SqlDb } from '../../services/storage/schema.ts'
import { DEFAULT_DOCUMENT_CATEGORIES } from '../../../src/types/workspace.ts'
export const DOCUMENT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS document_categories (
  id TEXT PRIMARY KEY, submodule TEXT NOT NULL DEFAULT 'reading' CHECK(submodule IN ('archive','reading')),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  behavior TEXT NOT NULL CHECK(behavior IN ('reading','contract','certificate','other')), sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(submodule, name)
);
CREATE TABLE IF NOT EXISTS document_custom_groups (
  id TEXT PRIMARY KEY, submodule TEXT NOT NULL CHECK(submodule IN ('archive','reading')),
  category_id TEXT REFERENCES document_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(submodule, category_id, name)
);
CREATE TABLE IF NOT EXISTS document_meta (
  resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL DEFAULT 'other',
  category_id TEXT REFERENCES document_categories(id),
  submodule TEXT CHECK(submodule IN ('archive','reading')),
  custom_group_id TEXT REFERENCES document_custom_groups(id) ON DELETE SET NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  type_locked INTEGER NOT NULL DEFAULT 0 CHECK(type_locked IN (0,1)),
  edited_fields TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', counterpart TEXT NOT NULL DEFAULT '',
  issued_on TEXT NOT NULL DEFAULT '', expires_on TEXT NOT NULL DEFAULT '',
  read_state TEXT NOT NULL DEFAULT 'unread' CHECK(read_state IN ('unread','reading','read')),
  page INTEGER NOT NULL DEFAULT 1 CHECK(page>=1), page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count>=0),
  scroll_offset REAL NOT NULL DEFAULT 0 CHECK(scroll_offset>=0 AND scroll_offset<=1)
);
CREATE TABLE IF NOT EXISTS document_annotations (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('bookmark','excerpt')), quote TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL CHECK(page>=1), scroll_offset REAL NOT NULL CHECK(scroll_offset>=0 AND scroll_offset<=1),
  anchor TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`

export const DOCUMENT_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_document_annotations ON document_annotations(resource_id,page,created_at);
CREATE INDEX IF NOT EXISTS idx_document_meta_submodule ON document_meta(submodule);
CREATE INDEX IF NOT EXISTS idx_document_categories_submodule ON document_categories(submodule, sort_order);
CREATE INDEX IF NOT EXISTS idx_document_custom_groups_cat ON document_custom_groups(category_id, sort_order);
`

export function migrateDocumentSchema(db:SqlDb,from:number) {
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('SAVEPOINT document_categories_migration')
  try {
    const metaCols=new Set((db.prepare('PRAGMA table_info(document_meta)').all() as {name:string}[]).map(r=>r.name))
    const catCols=new Set((db.prepare('PRAGMA table_info(document_categories)').all() as {name:string}[]).map(r=>r.name))
    if(!(db.prepare('PRAGMA table_info(document_annotations)').all() as {name:string}[]).some(c=>c.name==='anchor'))db.exec("ALTER TABLE document_annotations ADD COLUMN anchor TEXT NOT NULL DEFAULT ''")
    if(!metaCols.has('category_id'))db.exec('ALTER TABLE document_meta ADD COLUMN category_id TEXT REFERENCES document_categories(id)')
    if(!metaCols.has('type_locked'))db.exec('ALTER TABLE document_meta ADD COLUMN type_locked INTEGER NOT NULL DEFAULT 0 CHECK(type_locked IN (0,1))')
    if(!metaCols.has('edited_fields'))db.exec("ALTER TABLE document_meta ADD COLUMN edited_fields TEXT NOT NULL DEFAULT '[]'")
    if(!metaCols.has('submodule'))db.exec("ALTER TABLE document_meta ADD COLUMN submodule TEXT CHECK(submodule IN ('archive','reading'))")
    if(!metaCols.has('custom_group_id'))db.exec('ALTER TABLE document_meta ADD COLUMN custom_group_id TEXT')
    if(!metaCols.has('favorite'))db.exec('ALTER TABLE document_meta ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1))')

    db.exec(`
      CREATE TABLE IF NOT EXISTS document_custom_groups (
        id TEXT PRIMARY KEY, submodule TEXT NOT NULL CHECK(submodule IN ('archive','reading')),
        category_id TEXT REFERENCES document_categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(submodule, category_id, name)
      );
    `)

    const groupCols = new Set((db.prepare('PRAGMA table_info(document_custom_groups)').all() as {name:string}[]).map(r=>r.name))
    if (!groupCols.has('category_id')) {
      db.exec('ALTER TABLE document_custom_groups ADD COLUMN category_id TEXT REFERENCES document_categories(id) ON DELETE CASCADE')
      db.exec(`
        UPDATE document_custom_groups
        SET category_id = (
          SELECT category_id FROM document_meta WHERE custom_group_id = document_custom_groups.id LIMIT 1
        )
        WHERE category_id IS NULL;
      `)
      db.exec(`
        UPDATE document_custom_groups
        SET category_id = CASE WHEN submodule = 'archive' THEN 'archive_other' ELSE 'novel' END
        WHERE category_id IS NULL;
      `)
    }

    if(!catCols.has('submodule')){
      db.exec(`
        CREATE TABLE document_categories_v2 (
          id TEXT PRIMARY KEY, submodule TEXT NOT NULL DEFAULT 'reading' CHECK(submodule IN ('archive','reading')),
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          behavior TEXT NOT NULL CHECK(behavior IN ('reading','contract','certificate','other')), sort_order INTEGER NOT NULL DEFAULT 0,
          UNIQUE(submodule, name)
        );
        INSERT OR IGNORE INTO document_categories_v2(id, submodule, name, description, behavior, sort_order)
          SELECT id,
            CASE WHEN behavior IN ('certificate','contract') OR id IN ('certificate','contract') THEN 'archive' ELSE 'reading' END,
            name, description, behavior, sort_order
          FROM document_categories;
        DROP TABLE document_categories;
        ALTER TABLE document_categories_v2 RENAME TO document_categories;
      `)
    }

    if(from<19){
      const used=new Set((db.prepare('SELECT DISTINCT document_type FROM document_meta').all() as {document_type:string}[]).map(r=>r.document_type))
      for(const c of DEFAULT_DOCUMENT_CATEGORIES)if(from>0||used.has(c.id)||!['reference','contract'].includes(c.id)) {
        db.prepare('INSERT OR IGNORE INTO document_categories(id,submodule,name,description,behavior,sort_order) VALUES(?,?,?,?,?,?)').run(c.id,c.submodule,c.name,c.description,c.behavior,c.order)
      }
      db.exec('UPDATE document_meta SET category_id=document_type,type_locked=1 WHERE category_id IS NULL')
      // Pre-category databases only stored these built-in type IDs.
      db.exec("UPDATE document_meta SET category_id='archive_other',document_type='other',submodule='archive' WHERE category_id='contract' AND NOT EXISTS(SELECT 1 FROM document_categories WHERE id='contract')")
      db.exec("UPDATE document_meta SET category_id='book',document_type='book',submodule='reading' WHERE category_id='reference' AND NOT EXISTS(SELECT 1 FROM document_categories WHERE id='reference')")
      if(from>0)db.prepare('UPDATE document_meta SET edited_fields=?').run(JSON.stringify(['name','type','author','counterpart','issuedOn','expiresOn','notes','tags','readState']))
    }

    if(from<25){
      const pendingIds = (db.prepare("SELECT resource_id FROM document_meta WHERE submodule IS NULL AND (COALESCE(category_id,document_type)='other' OR COALESCE(category_id,document_type) IN (SELECT id FROM document_categories WHERE behavior='other' AND id NOT IN ('id_resume','archive_other','reading_other')))").all() as {resource_id:string}[]).map(r => r.resource_id)
      // Ensure seed categories
      for(const c of DEFAULT_DOCUMENT_CATEGORIES) {
        db.prepare('INSERT OR IGNORE INTO document_categories(id,submodule,name,description,behavior,sort_order) VALUES(?,?,?,?,?,?)').run(c.id,c.submodule,c.name,c.description,c.behavior,c.order)
      }

      // Check if reference is unchanged system category -> move items to reading/book
      const refCat = db.prepare("SELECT * FROM document_categories WHERE id='reference'").get() as {name:string;description:string;behavior:string}|undefined
      if(refCat && refCat.name==='教程与参考' && refCat.behavior==='reading' && ['保留的教程、手册与参考资料分类','技术文档、教程与参考资料'].includes(refCat.description)){
        db.exec("UPDATE document_meta SET category_id='book', document_type='book', submodule='reading' WHERE COALESCE(category_id,document_type)='reference'")
        db.exec("DELETE FROM document_categories WHERE id='reference'")
      }

      // Check if contract is unchanged system category -> move items to archive/archive_other
      const contractCat = db.prepare("SELECT * FROM document_categories WHERE id='contract'").get() as {name:string;description:string;behavior:string}|undefined
      if(contractCat && contractCat.name==='合同' && contractCat.behavior==='contract' && contractCat.description==='合同、协议与相关方凭据'){
        db.exec("UPDATE document_meta SET category_id='archive_other', document_type='other', submodule='archive' WHERE COALESCE(category_id,document_type)='contract'")
        db.exec("DELETE FROM document_categories WHERE id='contract'")
      }

      // Backfill submodules
      db.exec("UPDATE document_meta SET submodule='archive' WHERE submodule IS NULL AND COALESCE(category_id,document_type) IN ('certificate','id_resume','archive_other')")
      db.exec("UPDATE document_meta SET submodule='reading' WHERE submodule IS NULL AND COALESCE(category_id,document_type) IN ('book','novel','paper','reading_other')")
      db.exec("UPDATE document_meta SET submodule=(SELECT CASE WHEN behavior='reading' THEN 'reading' WHEN behavior IN ('certificate','contract') THEN 'archive' ELSE NULL END FROM document_categories WHERE document_categories.id=COALESCE(document_meta.category_id, document_meta.document_type)) WHERE submodule IS NULL")
      db.exec("UPDATE document_meta SET category_id='reading_other',document_type='book' WHERE category_id='other' AND NOT EXISTS(SELECT 1 FROM document_categories WHERE id='other')")
      for (const id of pendingIds) db.prepare('UPDATE document_meta SET submodule=NULL WHERE resource_id=?').run(id)
    }

    // Repair former pending records even when a library has already reached v25.
    db.exec("UPDATE document_meta SET submodule=COALESCE((SELECT submodule FROM document_categories WHERE id=COALESCE(document_meta.category_id,document_meta.document_type)), 'reading') WHERE submodule IS NULL")
    db.exec(DOCUMENT_INDEXES_SQL)
    db.exec('RELEASE document_categories_migration')
  }catch(error){
    db.exec('ROLLBACK TO document_categories_migration; RELEASE document_categories_migration')
    throw error
  }finally{
    db.exec('PRAGMA foreign_keys = ON')
  }
}
export const documentKind: ResourceKindModule = {
  kind: 'document',
  label: '资料',
  defaultCategories: [],
  defaultTags: [],
  schema: {
    tables: DOCUMENT_TABLES_SQL,
    indexes: DOCUMENT_INDEXES_SQL
  }
}
