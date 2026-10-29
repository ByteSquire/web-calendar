import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

/** How long a statement waits for another connection's write lock before it fails. */
const BUSY_TIMEOUT_MS = 5000

/**
 * Opens the SQLite file, creating its directory when needed. `:memory:` gives a private
 * in-memory database (tests). WAL keeps readers and the single writer from blocking each other.
 */
export function openDatabase(path: string): Database.Database {
  if (!path) throw new Error('The database path is empty')
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })

  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}
