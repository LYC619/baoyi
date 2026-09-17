import Database from 'better-sqlite3'

/** A self-contained in-memory snapshot, including the live database's committed WAL pages. */
export function cloneVideoDatabase(live: Database.Database): Database.Database {
  const image = live.serialize()
  // SQLite deserialize cannot open a WAL journal for an anonymous in-memory DB.
  // serialize() already includes those pages; change only the snapshot header
  // to rollback-journal format. The source database stays in WAL mode.
  image[18] = 1
  image[19] = 1
  const scratch = new Database(image)
  scratch.pragma('foreign_keys = ON')
  return scratch
}
