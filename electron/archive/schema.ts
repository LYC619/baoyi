export const ARCHIVE_TABLES_SQL=`
CREATE TABLE IF NOT EXISTS archive_actions (
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL,target_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,
 reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('applied','undone')),created_at INTEGER NOT NULL,
 scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('public','all'))
);
CREATE INDEX IF NOT EXISTS idx_archive_actions_session ON archive_actions(session_id,created_at);
CREATE TABLE IF NOT EXISTS archive_runs (
 session_id TEXT PRIMARY KEY,status TEXT NOT NULL,text TEXT NOT NULL,error TEXT NOT NULL,
 started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('public','all'))
);
`
import type {SqlDb} from '../services/schema.ts'


export function ensureArchiveSchema(db:SqlDb){
  db.exec(ARCHIVE_TABLES_SQL)
  // Preserve early development histories whose privacy scope was not recorded.
  for(const table of ['archive_actions','archive_runs']){
    const columns=db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
    if(!columns.some(x=>x.name==='scope'))db.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('public','all'))`)
  }
}
