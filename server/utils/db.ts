import type { Database } from 'better-sqlite3'

let handle: Database | undefined

/** Called once by the `db` plugin when the database is open and migrated. */
export function setDb(db: Database): void {
  handle = db
}

/** The app database. Request handlers can rely on it; the plugin holds requests until it is ready. */
export function getDb(): Database {
  if (!handle) throw new Error('The database is not ready (see server/plugins/db.ts)')
  return handle
}
