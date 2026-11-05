// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { MigrationError, runMigrations, type Migration } from '../../server/db/migrate'
import {
  KEPT_BACKUPS,
  NewerDatabaseError,
  UpgradeBackupError,
  appliedMigrations,
  backupPathFor,
  upgradeDatabase,
} from '../../server/db/upgrade'

// What happens at start when the database file is from an earlier version (the update of a
// container): a copy first, the new migrations after, and a refusal for a file from a later version.

const m = (name: string, sql: string): Migration => ({ name, sql })
const ONE = m(
  '001_notes.sql',
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes (text) VALUES ('kept');",
)
const TWO = m('002_pinned.sql', 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;')
const THREE = m(
  '003_tags.sql',
  'CREATE TABLE tags (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes (id));',
)

let dir: string
let path: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-calendar-upgrade-'))
  path = join(dir, 'web-calendar.db')
})
afterEach(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

const files = () => readdirSync(dir).sort()
const columns = (database: Database.Database, table: string) =>
  database.pragma(`table_info(${table})`).map((column) => (column as { name: string }).name)

/** A database file as an earlier version left it: these migrations applied and closed. */
function existing(...migrations: Migration[]): void {
  const old = openDatabase(path)
  runMigrations(old, migrations)
  old.close()
}

describe('upgradeDatabase', () => {
  it('applies every migration to a new database, without a copy', () => {
    db = openDatabase(path)
    const result = upgradeDatabase(db, path, [ONE, TWO, THREE])
    expect(result).toEqual({
      applied: ['001_notes.sql', '002_pinned.sql', '003_tags.sql'],
      backup: null,
    })
    expect(files().filter((name) => name.endsWith('.bak'))).toEqual([])
  })

  it('does nothing, and writes nothing, when the database is up to date', () => {
    existing(ONE, TWO)
    const before = files()
    db = openDatabase(path)
    expect(upgradeDatabase(db, path, [ONE, TWO])).toEqual({ applied: [], backup: null })
    expect(files().filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))).toEqual(
      before.filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm')),
    )
  })

  it('copies the database before it applies the new migrations, and keeps its data', () => {
    existing(ONE)
    db = openDatabase(path)
    const result = upgradeDatabase(db, path, [ONE, TWO, THREE])

    expect(result.applied).toEqual(['002_pinned.sql', '003_tags.sql'])
    expect(result.backup).toBe(`${path}.pre-002.bak`)
    expect(backupPathFor(path, '002_pinned.sql')).toBe(result.backup)
    // the database moved on
    expect(columns(db, 'notes')).toEqual(['id', 'text', 'pinned'])
    expect(db.prepare('SELECT text FROM notes').pluck().all()).toEqual(['kept'])

    // the copy is the state before: the old data, none of the new schema, and only the owner can read it
    expect((statSync(result.backup!).mode & 0o777).toString(8)).toBe('600')
    const copy = new Database(result.backup!, { readonly: true })
    try {
      expect(columns(copy, 'notes')).toEqual(['id', 'text'])
      expect(copy.prepare('SELECT text FROM notes').pluck().all()).toEqual(['kept'])
      expect(appliedMigrations(copy)).toEqual(['001_notes.sql'])
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      copy.close()
    }
    expect(files().some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('copies what is in the write-ahead log too', () => {
    existing(ONE)
    db = openDatabase(path)
    db.prepare("INSERT INTO notes (text) VALUES ('in the wal')").run()
    const { backup } = upgradeDatabase(db, path, [ONE, TWO])
    const copy = new Database(backup!, { readonly: true })
    try {
      expect(copy.prepare('SELECT text FROM notes ORDER BY id').pluck().all()).toEqual([
        'kept',
        'in the wal',
      ])
    } finally {
      copy.close()
    }
  })

  it('makes no copy of an in-memory database', () => {
    db = openDatabase(':memory:')
    runMigrations(db, [ONE])
    expect(upgradeDatabase(db, ':memory:', [ONE, TWO])).toEqual({
      applied: ['002_pinned.sql'],
      backup: null,
    })
  })

  describe('a migration that fails', () => {
    const BROKEN = m(
      '003_broken.sql',
      'CREATE TABLE half (id INTEGER); INSERT INTO missing_table VALUES (1);',
    )

    it('leaves the database as it was before that migration, and the copy where it is', () => {
      existing(ONE)
      db = openDatabase(path)
      expect(() => upgradeDatabase(db, path, [ONE, TWO, BROKEN])).toThrow(MigrationError)
      // 002 was applied and stays, 003 left nothing behind
      expect(appliedMigrations(db)).toEqual(['001_notes.sql', '002_pinned.sql'])
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined()
      expect(existsSync(`${path}.pre-002.bak`)).toBe(true)
    })

    it('is tried again at the next start from the same point, with one copy of it', () => {
      existing(ONE, TWO)
      db = openDatabase(path)
      expect(() => upgradeDatabase(db, path, [ONE, TWO, BROKEN])).toThrow(MigrationError)
      expect(() => upgradeDatabase(db, path, [ONE, TWO, BROKEN])).toThrow(MigrationError)
      expect(files().filter((name) => name.endsWith('.bak'))).toEqual([
        'web-calendar.db.pre-003.bak',
      ])
      // once the migration is fixed the same start goes through
      const fixed = m('003_broken.sql', 'CREATE TABLE half (id INTEGER);')
      expect(upgradeDatabase(db, path, [ONE, TWO, fixed]).applied).toEqual(['003_broken.sql'])
    })
  })

  describe('a copy that cannot be made', () => {
    it('stops before anything is changed', () => {
      existing(ONE)
      // Something that is not a file where the copy is made first
      mkdirSync(`${path}.pre-002.bak.tmp`)
      db = openDatabase(path)
      expect(() => upgradeDatabase(db, path, [ONE, TWO])).toThrow(UpgradeBackupError)
      expect(appliedMigrations(db)).toEqual(['001_notes.sql'])
      expect(columns(db, 'notes')).toEqual(['id', 'text'])
    })
  })

  describe('a database of a newer version', () => {
    it('is refused, names what is unknown and the copy to go back to, and is not changed', () => {
      existing(
        ONE,
        TWO,
        m('003_tags.sql', 'SELECT 1;'),
        m('004_future.sql', 'CREATE TABLE future (id INTEGER);'),
      )
      db = openDatabase(path)
      let error: unknown
      try {
        upgradeDatabase(db, path, [ONE, TWO]) // an older version of the app
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(NewerDatabaseError)
      const message = (error as NewerDatabaseError).message
      expect(message).toContain('003_tags.sql, 004_future.sql')
      expect(message).toContain(`${path}.pre-003.bak`)
      expect(appliedMigrations(db)).toHaveLength(4)
      expect(files().some((name) => name.endsWith('.bak'))).toBe(false)
    })

    it('is refused even when this version has migrations of its own that are not applied', () => {
      existing(ONE, m('004_future.sql', 'SELECT 1;'))
      db = openDatabase(path)
      expect(() => upgradeDatabase(db, path, [ONE, TWO])).toThrow(NewerDatabaseError)
      expect(appliedMigrations(db)).toEqual(['001_notes.sql', '004_future.sql'])
    })
  })

  describe('the copies that are kept', () => {
    it(`are the ${KEPT_BACKUPS} newest upgrade points`, () => {
      const names = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(3, '0'))
      const steps = names.map((number) =>
        m(`${number}_step.sql`, `CREATE TABLE t${number} (id INTEGER);`),
      )
      existing(steps[0]!)
      db = openDatabase(path)
      for (let count = 2; count <= 8; count += 1) upgradeDatabase(db, path, steps.slice(0, count))
      const left = files().filter((name) => name.endsWith('.bak'))
      expect(left).toEqual(
        ['004', '005', '006', '007', '008'].map((number) => `web-calendar.db.pre-${number}.bak`),
      )
    })

    it('do not touch other files in the folder', () => {
      writeFileSync(join(dir, 'other.db.pre-001.bak'), 'not ours')
      existing(ONE)
      db = openDatabase(path)
      upgradeDatabase(db, path, [ONE, TWO])
      expect(existsSync(join(dir, 'other.db.pre-001.bak'))).toBe(true)
    })
  })
})
