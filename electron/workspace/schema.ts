/** Persistent work and personal records. No file contents or external credentials. */
export const WORKSPACE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS document_recycle (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('indexed','recycled','attention','restored','purged')),
  created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_files (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  path TEXT NOT NULL COLLATE NOCASE UNIQUE,project_id TEXT REFERENCES resource(id) ON DELETE SET NULL,created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS document_file_operations (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('prepared','copied','committed','done','attention')),created_at INTEGER NOT NULL,payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_summaries (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('day','week','version')),group_key TEXT NOT NULL,
  title TEXT NOT NULL,body TEXT NOT NULL,sources TEXT NOT NULL,source_stamp TEXT NOT NULL,session_id TEXT NOT NULL,
  revised INTEGER NOT NULL DEFAULT 0 CHECK(revised IN (0,1)),undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1)),
  original TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(resource_id,kind,group_key)
);
CREATE TABLE IF NOT EXISTS workspace_sessions (
  id TEXT PRIMARY KEY, module TEXT NOT NULL CHECK(module IN ('document','personal')), title TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_changes (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK(entity IN ('personal','document','link')), target_id TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('proposed','applied','undone')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_context (
  resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
  current_text TEXT NOT NULL DEFAULT '', next_text TEXT NOT NULL DEFAULT '', baseline TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_events (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, occurred_at INTEGER NOT NULL,
  milestone INTEGER NOT NULL DEFAULT 0 CHECK(milestone IN (0,1)), version TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('manual','git','directory')), source_key TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('draft','published','dismissed')),
  revised INTEGER NOT NULL DEFAULT 0 CHECK(revised IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(resource_id,source_key)
);
CREATE INDEX IF NOT EXISTS idx_project_events ON project_events(resource_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS personal_records (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('profile','asset','skill','experience','metric','measurement','todo')),
  name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_records ON personal_records(kind,updated_at DESC);
CREATE TABLE IF NOT EXISTS resource_links (
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK(owner_type IN ('project','event','skill','experience','asset')),
  owner_id TEXT NOT NULL, target_key TEXT NOT NULL,
  owner_resource_id TEXT REFERENCES resource(id) ON DELETE CASCADE,
  owner_event_id TEXT REFERENCES project_events(id) ON DELETE CASCADE,
  owner_personal_id TEXT REFERENCES personal_records(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resource(id) ON DELETE SET NULL,
  annotation_id TEXT REFERENCES document_annotations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, UNIQUE(owner_type,owner_id,target_key)
);
CREATE INDEX IF NOT EXISTS idx_resource_links_target ON resource_links(resource_id);
CREATE TABLE IF NOT EXISTS project_event_generation (
  event_id TEXT PRIMARY KEY REFERENCES project_events(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, original TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_automation (
  resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), last_head TEXT NOT NULL DEFAULT '',
  observed_head TEXT NOT NULL DEFAULT '', pending_since INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT ''
);
`

/** This migration also runs in minimal fixtures and after metadata reset. */
export function migrateProjectContext(db:import('../services/storage/schema.ts').SqlDb):void {
  const columns=new Set((db.prepare('PRAGMA table_info(project_context)').all() as Array<{name:string}>).map(r=>r.name))
  const additions:Record<string,string>={prompt_text:"TEXT NOT NULL DEFAULT ''",rules:"TEXT NOT NULL DEFAULT '[]'",version:'INTEGER NOT NULL DEFAULT 1',revision:'INTEGER NOT NULL DEFAULT 0',updated_at:'INTEGER NOT NULL DEFAULT 0'}
  db.exec('SAVEPOINT project_context_migration')
  try {
    for(const [name,definition] of Object.entries(additions))if(!columns.has(name))db.exec(`ALTER TABLE project_context ADD COLUMN ${name} ${definition}`)
    db.exec('RELEASE project_context_migration')
  }catch(error){db.exec('ROLLBACK TO project_context_migration; RELEASE project_context_migration');throw error}
}
