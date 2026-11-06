// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCalendarLinkById, listCalendarLinksOfCalendar } from '../../server/db/calendar-links'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations, type Migration } from '../../server/db/migrate'
import { findUserBySub, setUserSidebarOrder } from '../../server/db/users'
import { appliedMigrations, upgradeDatabase } from '../../server/db/upgrade'

// The update of a production container: the database that an earlier release left is opened by the
// current code and migrated. The migrations of each release are kept here as they were released
// (fixtures/released/<tag>/), with rows in every table, so that the test runs the real upgrade from
// that schema. When a release is made, add its folder and its data (new tables only) and a test.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const migrationsDir = here('../../server/db/migrations')
const released = (tag: string) => here(`./fixtures/released/${tag}`)
const current = () => loadMigrationsFromDir(migrationsDir)
// The folder of a release holds its migrations and `data.sql`, the rows that the tests put in.
const frozen = (...tags: string[]) =>
  tags
    .flatMap((tag) => loadMigrationsFromDir(released(tag)))
    .filter((file) => file.name !== 'data.sql')
const sqlOf = (tag: string) => readFileSync(join(released(tag), 'data.sql'), 'utf8')

let dir: string
let path: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-calendar-released-'))
  path = join(dir, 'web-calendar.db')
})
afterEach(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The database file that releases `tags` (oldest first) left, with each release's rows in it. */
function leftBy(...tags: string[]): void {
  const old = openDatabase(path)
  const migrations: Migration[] = []
  for (const tag of tags) {
    migrations.push(...frozen(tag))
    runMigrations(old, migrations)
    old.exec(sqlOf(tag))
  }
  old.close()
}

type Rows = Record<string, { columns: string[]; rows: unknown[] }>

/** Every table with its columns and rows (the migration history is not data). */
function snapshot(database: Database.Database): Rows {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    )
    .pluck()
    .all() as string[]
  return Object.fromEntries(
    tables.map((table) => {
      const columns = (database.pragma(`table_info("${table}")`) as { name: string }[]).map(
        (c) => c.name,
      )
      return [
        table,
        { columns, rows: database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() },
      ]
    }),
  )
}

/** The rows of `before`, still there: the same values in the columns that were there. */
function expectKept(before: Rows, database: Database.Database): void {
  for (const [table, { columns, rows }] of Object.entries(before)) {
    const list = columns.map((column) => `"${column}"`).join(', ')
    const now = database.prepare(`SELECT ${list} FROM "${table}" ORDER BY rowid`).all()
    expect(now, `the rows of ${table}`).toEqual(rows)
  }
}

function expectHealthy(database: Database.Database): void {
  expect(database.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(database.pragma('foreign_key_check')).toEqual([])
}

describe('the migrations that were released', () => {
  it.each(['v0.1.0', 'v0.2.0', 'v0.2.1'])('are unchanged: %s', (tag) => {
    // A migration that a database has applied is never edited (the runner goes by name and would not
    // run it again): a change is a new migration. Compare byte for byte with what was released.
    const files = readdirSync(released(tag)).filter((name) => name !== 'data.sql')
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      expect(readFileSync(join(migrationsDir, name), 'utf8'), name).toBe(
        readFileSync(join(released(tag), name), 'utf8'),
      )
    }
  })

  it('are all there, and no number is used twice', () => {
    const names = current().map((migration) => migration.name)
    for (const migration of frozen('v0.1.0', 'v0.2.0', 'v0.2.1')) {
      expect(names).toContain(migration.name)
    }
    const numbers = names.map((name) => name.slice(0, 3))
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})

describe('updating from v0.1.0 (001 to 008)', () => {
  it('migrates the database, keeps every row and makes the groups', () => {
    leftBy('v0.1.0')
    db = openDatabase(path)
    const before = snapshot(db)
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(['users', 'calendars', 'calendar_bookings', 'audit_log']),
    )
    expect(before.users!.rows).toHaveLength(2)
    expect(appliedMigrations(db)).toHaveLength(7)

    const result = upgradeDatabase(db, path, current())

    expect(result.applied).toEqual([
      '009_groups.sql',
      '010_sidebar_order.sql',
      '011_calendar_links.sql',
      '012_calendar_link_levels.sql',
      '013_group_managers.sql',
    ])
    expect(result.backup).toBe(`${path}.pre-009.bak`)
    expectKept(before, db)
    expectHealthy(db)

    // what the new versions add
    expect(db.prepare('SELECT id, name, source FROM groups').all()).toEqual([
      { id: 1, name: 'web_calendar_users', source: 'everyone' },
    ])
    expect(db.prepare('SELECT group_id FROM calendars').pluck().all()).toEqual([null, null, null])
    expect(db.prepare('SELECT sidebar_order FROM users').pluck().all()).toEqual([null, null])
    expect(db.prepare('SELECT COUNT(*) FROM calendar_links').pluck().get()).toBe(0)
  })

  it('leaves a copy of the old database, which still works with the old version', () => {
    leftBy('v0.1.0')
    db = openDatabase(path)
    const before = snapshot(db)
    const { backup } = upgradeDatabase(db, path, current())

    const copy = new Database(backup!, { readonly: true })
    try {
      expect(appliedMigrations(copy)).toHaveLength(7)
      expect(snapshot(copy)).toEqual(before)
    } finally {
      copy.close()
    }
  })

  it('works with the code afterwards', () => {
    leftBy('v0.1.0')
    db = openDatabase(path)
    upgradeDatabase(db, path, current())
    const alice = findUserBySub(db, 'sub-alice')!
    expect(alice).toMatchObject({
      username: 'alice',
      timeZone: 'Europe/Berlin',
      sidebarOrder: null,
    })
    expect(setUserSidebarOrder(db, alice.id, ['filters'])).toEqual([
      'filters',
      'views',
      'calendars',
      'resources',
      'categories',
    ])
    expect(db.prepare('SELECT COUNT(*) FROM app_tokens').pluck().get()).toBe(2)
  })

  it('does it once: the next start finds nothing to do', () => {
    leftBy('v0.1.0')
    db = openDatabase(path)
    upgradeDatabase(db, path, current())
    expect(upgradeDatabase(db, path, current())).toEqual({ applied: [], backup: null })
  })
})

describe('updating from v0.2.0 (001 to 009)', () => {
  it('migrates the database and keeps the groups, their members and calendars', () => {
    leftBy('v0.1.0', 'v0.2.0')
    db = openDatabase(path)
    const before = snapshot(db)
    expect(before.groups!.rows).toHaveLength(3)
    expect(before.group_members!.rows).toHaveLength(3)
    expect(appliedMigrations(db)).toHaveLength(8)

    const result = upgradeDatabase(db, path, current())

    expect(result.applied).toEqual([
      '010_sidebar_order.sql',
      '011_calendar_links.sql',
      '012_calendar_link_levels.sql',
      '013_group_managers.sql',
    ])
    expect(result.backup).toBe(`${path}.pre-010.bak`)
    expectKept(before, db)
    expectHealthy(db)
    expect(db.prepare('SELECT sidebar_order FROM users').pluck().all()).toEqual([null, null])
  })
})

describe('updating from v0.2.1 (001 to 012)', () => {
  it('adds the group managers, keeps every row, and the code reads the links and the sidebar order', () => {
    leftBy('v0.1.0', 'v0.2.0', 'v0.2.1')
    db = openDatabase(path)
    const before = snapshot(db)
    expect(before.calendar_links!.rows).toHaveLength(4)
    expect(appliedMigrations(db)).toHaveLength(11)

    const result = upgradeDatabase(db, path, current())
    expect(result.applied).toEqual(['013_group_managers.sql'])
    expect(result.backup).toBe(`${path}.pre-013.bak`)
    expectKept(before, db)
    expectHealthy(db)
    // nobody manages a group until an admin names them
    expect(db.prepare('SELECT DISTINCT manager FROM group_members').pluck().all()).toEqual([0])

    expect(findUserBySub(db, 'sub-alice')!.sidebarOrder).toEqual([
      'filters',
      'views',
      'calendars',
      'resources',
      'categories',
    ])
    // the links of the access page's calendar: one made in Settings, one an admin made there
    expect(
      listCalendarLinksOfCalendar(db, 4).map((link) => [link.label, link.reads_as, link.level]),
    ).toEqual([
      ['Reception', 'owner', 'free_busy'],
      ['Front desk', 'maker', 'free_busy'],
    ])
    // a link from before 012 has its defaults and no sealed copy
    expect(findCalendarLinkById(db, 4)).toMatchObject({
      level: 'read',
      reads_as: 'maker',
      calendar_id: null,
      secret_sealed: null,
      maker_username: 'alice',
    })
  })
})
