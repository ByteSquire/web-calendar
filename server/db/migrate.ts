import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'

export interface Migration {
  /** File name such as `001_init.sql`; names decide the order. */
  name: string
  /** One or more statements. Must not start or end a transaction itself. */
  sql: string
}

const NAME_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    super(
      `Migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'MigrationError'
  }
}

/**
 * Applies the migrations that the database has not seen yet, in name order, and returns their
 * names. Each one runs in its own transaction together with its `schema_migrations` row, so a
 * failing file leaves the earlier ones applied and itself not applied. Safe to run on every
 * start, also from two processes at once.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): string[] {
  const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const seen = new Map<string, string>()
  for (const { name } of sorted) {
    const match = NAME_PATTERN.exec(name)
    if (!match) {
      throw new Error(`Invalid migration name "${name}": expected a file like 001_init.sql`)
    }
    const other = seen.get(match[1]!)
    if (other) throw new Error(`Migrations ${other} and ${name} share the number ${match[1]}`)
    seen.set(match[1]!, name)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)')

  const applied: string[] = []
  for (const migration of sorted) {
    // The check sits inside the write transaction so a second process cannot apply it twice.
    const apply = db.transaction(() => {
      if (isApplied.get(migration.name)) return false
      db.exec(migration.sql)
      record.run(migration.name)
      return true
    })
    try {
      if (apply.immediate()) applied.push(migration.name)
    } catch (error) {
      throw new MigrationError(migration.name, error)
    }
  }
  return applied
}

/** Reads every `*.sql` file of a directory. */
export function loadMigrationsFromDir(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}
