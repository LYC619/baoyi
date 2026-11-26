export const DOCUMENT_INSIGHT_SQL=`
CREATE TABLE IF NOT EXISTS document_insights (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),active INTEGER NOT NULL CHECK(active IN (0,1)),
  core_value TEXT NOT NULL,conclusions TEXT NOT NULL,suggested_category TEXT REFERENCES document_categories(id) ON DELETE SET NULL,
  suggested_tags TEXT NOT NULL,evidence TEXT NOT NULL,limitations TEXT NOT NULL,
  model TEXT NOT NULL,prompt_version TEXT NOT NULL,source_fingerprint TEXT NOT NULL,source_file_id TEXT NOT NULL,
  coverage TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT NOT NULL,
  generated_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,user_edited INTEGER NOT NULL CHECK(user_edited IN (0,1)),
  UNIQUE(resource_id,revision),UNIQUE(resource_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_insight_active ON document_insights(resource_id) WHERE active=1;
CREATE TABLE IF NOT EXISTS document_insight_runs (
  id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled','interrupted')),
  attempt INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL
);
`
