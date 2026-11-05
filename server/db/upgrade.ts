// Brings the database of an earlier version up to the version that starts (design §5): checks that
// the file is not from a newer version, makes a copy of it before anything is changed, and applies
// the migrations that are new. A person updates the container and starts it; this is what makes
// the old database work with the new code, and what they can go back to when it does not.
import { chmodSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database, { type Database as Db } from 'better-sqlite3'
import { runMigrations, type Migration } from './migrate'

/** How many of the copies made before an upgrade are kept (the newest upgrade points). */
export const KEPT_BACKUPS = 5

/** The database has migrations that this version does not have: it was upgraded by a newer one. */
export class NewerDatabaseError extends Error {
  constructor(
    readonly unknown: readonly string[],
    readonly backup: string,
  ) {
    super(
      `The database was upgraded by a newer version of the app: it has ${unknown.join(', ')}, which ` +
        `this version does not know. Start the newer version again. To go back to this version, stop ` +
        `the app, put the copy ${backup} in place of the database file (delete its -wal and -shm ` +
        `files) and start this version: the newer version made that copy just before it upgraded ` +
        `the database. If the copy is gone, restore the backup you made before the update.`,
    )
    this.name = 'NewerDatabaseError'
  }
}

/** The copy could not be made or did not pass its check, so nothing was changed. */
export class UpgradeBackupError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `The database was not upgraded: the copy to ${path} that is made first failed (${
        cause instanceof Error ? cause.message : String(cause)
      }). Check that the data volume has room and can be written to.`,
      { cause },
    )
    this.name = 'UpgradeBackupError'
  }
}

/** The names of the migrations the database has applied; none for a file that has none yet. */
export function appliedMigrations(db: Db): string[] {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (!table) return []
  return db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]
}

const numberOf = (name: string): string => /^(\d{3})_/.exec(name)?.[1] ?? name

/** Where the copy made before the migration `name` is applied goes: next to the database file. */
export function backupPathFor(dbPath: string, name: string): string {
  return `${resolve(dbPath)}.pre-${numberOf(name)}.bak`
}

/**
 * Copies the database to `target` with `VACUUM INTO`, which writes a consistent copy of everything
 * committed, the -wal file included, checks the copy and only then gives it its name. An earlier
 * copy of the same upgrade point (a start that failed and was tried again) is replaced.
 */
function copyDatabase(db: Db, target: string): void {
  const temp = `${target}.tmp`
  try {
    rmSync(temp, { force: true })
    db.prepare('VACUUM INTO ?').run(temp)
    chmodSync(temp, 0o600)
    const copy = new Database(temp, { readonly: true, fileMustExist: true })
    try {
      const result = copy.pragma('integrity_check', { simple: true })
      if (result !== 'ok')
        throw new Error(`the copy failed its integrity check (${String(result)})`)
    } finally {
      copy.close()
    }
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Whatever is in the way is reported with the error below.
    }
    throw new UpgradeBackupError(target, error)
  }
}

/** Removes the copies of the oldest upgrade points, so that the data volume does not fill up. */
function pruneBackups(dbPath: string, keep: number): void {
  const file = resolve(dbPath)
  const pattern = new RegExp(
    `^${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.pre-(\\d{3})\\.bak$`,
  )
  const found = readdirSync(dirname(file))
    .map((name) => ({ name, number: pattern.exec(name)?.[1] }))
    .filter((item): item is { name: string; number: string } => item.number !== undefined)
    .sort((a, b) => Number(b.number) - Number(a.number))
  for (const old of found.slice(keep)) rmSync(join(dirname(file), old.name), { force: true })
}

export interface UpgradeResult {
  /** The migrations that were applied, in order. */
  applied: string[]
  /** The copy made first; null when nothing was to be applied or the database was new. */
  backup: string | null
}

/**
 * Upgrades the database to the migrations given:
 *  1. A database that has migrations this version does not know is refused (`NewerDatabaseError`).
 *     Running old code on a newer schema is how data gets damaged; the error says how to go back.
 *  2. When migrations are new and the database has a history, it is copied first, to
 *     `<file>.pre-<number of the first new migration>.bak` (mode 0600, checked). If that fails
 *     nothing is changed. A new database is not copied, and neither is `:memory:`.
 *  3. The migrations are applied, each in a transaction of its own (`runMigrations`): one that
 *     fails leaves the database as it was before it, and the copy stays.
 */
export function upgradeDatabase(
  db: Db,
  dbPath: string,
  migrations: readonly Migration[],
  options: { keep?: number } = {},
): UpgradeResult {
  const known = new Set(migrations.map((migration) => migration.name))
  const applied = appliedMigrations(db)
  const done = new Set(applied)

  const unknown = applied.filter((name) => !known.has(name)).sort()
  if (unknown.length > 0) throw new NewerDatabaseError(unknown, backupPathFor(dbPath, unknown[0]!))

  const pending = [...migrations]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .filter((m) => !done.has(m.name))
  if (pending.length === 0) return { applied: [], backup: null }

  let backup: string | null = null
  if (applied.length > 0 && dbPath !== ':memory:') {
    backup = backupPathFor(dbPath, pending[0]!.name)
    copyDatabase(db, backup)
    pruneBackups(dbPath, options.keep ?? KEPT_BACKUPS)
  }
  return { applied: runMigrations(db, migrations), backup }
}
