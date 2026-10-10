import type { KindSchema } from '../types.ts'
export const projectSchema: KindSchema = {
  tables: `CREATE TABLE IF NOT EXISTS project_meta (
    resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
    origin TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL DEFAULT 'active',
    group_name TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
    version TEXT NOT NULL DEFAULT '', entries TEXT NOT NULL DEFAULT '[]',
    default_entry TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS project_sessions (
    id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
    title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_sessions_resource ON project_sessions(resource_id,updated_at);`
}
