// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, MigrationError, runMigrations } from '../../server/db/migrate'
import type { UserRow } from '../../server/db/types'
import { findUserBySub, findUserByUsername, upsertUser } from '../../server/db/users'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function migrated(): Database {
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  return db
}

function tableNames(): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
}

describe('openDatabase', () => {
  it('turns foreign keys on', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('creates the parent directory and uses WAL for a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-calendar-db-'))
    try {
      const file = openDatabase(join(dir, 'nested', 'app.db'))
      expect(file.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(file.pragma('foreign_keys', { simple: true })).toBe(1)
      file.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty path', () => {
    expect(() => openDatabase('')).toThrow(/empty/)
  })
})

describe('runMigrations', () => {
  it('creates every table of the data model', () => {
    migrated()
    expect(tableNames()).toEqual([
      'app_tokens',
      'calendar_acl',
      'calendar_prefs',
      'calendars',
      'categories',
      'filters',
      'ical_subscriptions',
      'resources',
      'schema_migrations',
      'users',
      'views',
    ])
  })

  it('applies each file once and is idempotent', () => {
    const migrations = loadMigrationsFromDir(migrationsDir)
    expect(runMigrations(db, migrations)).toEqual(migrations.map((m) => m.name))
    expect(runMigrations(db, migrations)).toEqual([])
    const recorded = db.prepare('SELECT name, applied_at FROM schema_migrations').all()
    expect(recorded).toHaveLength(migrations.length)
    expect(recorded[0]).toMatchObject({
      name: '001_init.sql',
      applied_at: expect.stringMatching(ISO),
    })
  })

  it('applies new files on a later run and in name order', () => {
    runMigrations(db, [{ name: '001_a.sql', sql: 'CREATE TABLE a (x INTEGER)' }])
    const applied = runMigrations(db, [
      { name: '003_c.sql', sql: 'INSERT INTO b VALUES (3)' },
      { name: '001_a.sql', sql: 'CREATE TABLE a (x INTEGER)' },
      { name: '002_b.sql', sql: 'CREATE TABLE b (x INTEGER); INSERT INTO b VALUES (2)' },
    ])
    expect(applied).toEqual(['002_b.sql', '003_c.sql'])
    expect(db.prepare('SELECT x FROM b ORDER BY rowid').pluck().all()).toEqual([2, 3])
  })

  it('fails loudly on a bad file, rolls it back and keeps the earlier ones', () => {
    const good = { name: '001_a.sql', sql: 'CREATE TABLE a (x INTEGER)' }
    const bad = {
      name: '002_bad.sql',
      sql: 'CREATE TABLE half (x INTEGER); INSERT INTO missing VALUES (1)',
    }
    const never = { name: '003_c.sql', sql: 'CREATE TABLE c (x INTEGER)' }

    expect(() => runMigrations(db, [good, bad, never])).toThrow(MigrationError)
    expect(() => runMigrations(db, [good, bad, never])).toThrow(/002_bad\.sql.*no such table/)
    expect(tableNames()).toEqual(['a', 'schema_migrations'])
    expect(db.prepare('SELECT name FROM schema_migrations').pluck().all()).toEqual(['001_a.sql'])

    const fixed = { name: '002_bad.sql', sql: 'CREATE TABLE b (x INTEGER)' }
    expect(runMigrations(db, [good, fixed, never])).toEqual(['002_bad.sql', '003_c.sql'])
  })

  it('rejects names that are not numbered .sql files', () => {
    expect(() => runMigrations(db, [{ name: 'init.sql', sql: '' }])).toThrow(/Invalid migration/)
    expect(() => runMigrations(db, [{ name: '1_init.sql', sql: '' }])).toThrow(/Invalid migration/)
    expect(() => runMigrations(db, [{ name: '001_init.txt', sql: '' }])).toThrow(
      /Invalid migration/,
    )
  })

  it('rejects two files with the same number', () => {
    expect(() =>
      runMigrations(db, [
        { name: '002_a.sql', sql: '' },
        { name: '002_b.sql', sql: '' },
      ]),
    ).toThrow(/share the number 002/)
  })
})

describe('schema', () => {
  function addUser(sub = 'sub-1', username = 'alice'): number {
    return Number(
      db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(sub, username)
        .lastInsertRowid,
    )
  }

  function addCalendar(path = '/u/cal/', ownerId: number | null = null, kind = 'shared'): number {
    return Number(
      db
        .prepare(
          'INSERT INTO calendars (name, kind, owner_id, collection_path) VALUES (?, ?, ?, ?)',
        )
        .run('Team', kind, ownerId, path).lastInsertRowid,
    )
  }

  beforeEach(() => {
    migrated()
  })

  it('sets ISO timestamps by default and touches updated_at on update', () => {
    const id = addUser()
    const row = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(id)!
    expect(row.created_at).toMatch(ISO)
    expect(row.updated_at).toMatch(ISO)

    db.prepare("UPDATE users SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id)
    db.prepare("UPDATE users SET name = 'Alice' WHERE id = ?").run(id)
    const after = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(id)!
    expect(after.updated_at).toMatch(ISO)
    expect(after.updated_at > '2000-01-01T00:00:00.000Z').toBe(true)
    expect(after.created_at).toBe(row.created_at)
  })

  it('touches updated_at on a table with a composite key', () => {
    const userId = addUser()
    db.prepare(
      "INSERT INTO calendar_prefs (user_id, calendar_ref, updated_at) VALUES (?, '1', '2000-01-01T00:00:00.000Z')",
    ).run(userId)
    db.prepare(
      "UPDATE calendar_prefs SET visible = 0 WHERE user_id = ? AND calendar_ref = '1'",
    ).run(userId)
    const updatedAt = db.prepare('SELECT updated_at FROM calendar_prefs').pluck().get() as string
    expect(updatedAt > '2000-01-01T00:00:00.000Z').toBe(true)
  })

  it('rejects values outside the enums', () => {
    const userId = addUser()
    const calendarId = addCalendar()
    const cases: [string, unknown[]][] = [
      [
        'INSERT INTO calendars (name, kind, collection_path) VALUES (?, ?, ?)',
        ['x', 'private', '/x/'],
      ],
      [
        'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
        [calendarId, 'team', 'x', 'read'],
      ],
      [
        'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
        [calendarId, 'user', 'bob', 'owner'],
      ],
      [
        'INSERT INTO filters (owner_id, name, kind, value) VALUES (?, ?, ?, ?)',
        [userId, 'f', 'regex', 'x'],
      ],
      [
        'INSERT INTO resources (calendar_id, name, type) VALUES (?, ?, ?)',
        [calendarId, 'r', 'boat'],
      ],
      ['INSERT INTO users (oidc_sub, is_admin) VALUES (?, ?)', ['sub-2', 2]],
      ['INSERT INTO views (name, is_admin) VALUES (?, ?)', ['v', 2]],
      ['INSERT INTO views (name, definition) VALUES (?, ?)', ['v', 'not json']],
    ]
    for (const [sql, params] of cases) {
      expect(() => db.prepare(sql).run(...params), sql).toThrow(/CHECK constraint/)
    }
  })

  it('accepts every valid enum value', () => {
    const userId = addUser()
    const calendarId = addCalendar()
    for (const kind of ['personal', 'shared', 'resource']) {
      addCalendar(`/${kind}/`, userId, kind)
    }
    for (const permission of ['free_busy', 'read', 'write', 'admin']) {
      db.prepare(
        "INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, 'user', ?, ?)",
      ).run(calendarId, `u-${permission}`, permission)
    }
    for (const type of ['group']) {
      db.prepare(
        'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
      ).run(calendarId, type, 'staff', 'read')
    }
    for (const type of ['authenticated', 'public']) {
      db.prepare(
        'INSERT INTO calendar_acl (calendar_id, principal_type, permission) VALUES (?, ?, ?)',
      ).run(calendarId, type, 'free_busy')
    }
    for (const kind of ['text', 'category', 'status']) {
      db.prepare('INSERT INTO filters (owner_id, name, kind, value) VALUES (?, ?, ?, ?)').run(
        userId,
        kind,
        kind,
        'x',
      )
    }
    expect(db.prepare('SELECT COUNT(*) FROM calendar_acl').pluck().get()).toBe(7)
  })

  it('ties the ACL principal to its type', () => {
    const calendarId = addCalendar()
    const insert = db.prepare(
      'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
    )
    expect(() => insert.run(calendarId, 'user', null, 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(calendarId, 'group', '', 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(calendarId, 'public', 'someone', 'read')).toThrow(/CHECK constraint/)
  })

  it('rejects duplicate ACL entries, also for principals without a name', () => {
    const calendarId = addCalendar()
    const insert = db.prepare(
      'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
    )
    insert.run(calendarId, 'public', null, 'free_busy')
    expect(() => insert.run(calendarId, 'public', null, 'read')).toThrow(/UNIQUE constraint/)
    insert.run(calendarId, 'user', 'bob', 'read')
    expect(() => insert.run(calendarId, 'user', 'bob', 'write')).toThrow(/UNIQUE constraint/)
  })

  it('needs an owner for a personal calendar only', () => {
    expect(() => addCalendar('/p/', null, 'personal')).toThrow(/CHECK constraint/)
    expect(() => addCalendar('/s/', null, 'shared')).not.toThrow()
  })

  it('enforces foreign keys', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO app_tokens (user_id, label, token_hash, expires_at) VALUES (999, 'x', 'h', 'e')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint/)
  })

  it("removes a deleted user's own data but protects the calendars they own", () => {
    const userId = addUser()
    db.prepare(
      "INSERT INTO app_tokens (user_id, label, token_hash, expires_at) VALUES (?, 'x', 'h', 'e')",
    ).run(userId)
    db.prepare("INSERT INTO views (name, owner_id) VALUES ('v', ?)").run(userId)
    db.prepare("INSERT INTO calendar_prefs (user_id, calendar_ref) VALUES (?, '1')").run(userId)
    const calendarId = addCalendar('/own/', userId, 'personal')

    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(userId)).toThrow(
      /FOREIGN KEY constraint/,
    )
    db.prepare('DELETE FROM calendars WHERE id = ?').run(calendarId)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    for (const table of ['app_tokens', 'views', 'calendar_prefs']) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0)
    }
  })

  it('keeps a resource to one calendar and removes it with the calendar', () => {
    const calendarId = addCalendar('/room/', null, 'resource')
    const insert = db.prepare(
      "INSERT INTO resources (calendar_id, name, type, capacity) VALUES (?, 'Room 1', 'room', ?)",
    )
    insert.run(calendarId, 8)
    expect(() => insert.run(calendarId, 8)).toThrow(/UNIQUE constraint/)
    db.prepare('DELETE FROM calendars WHERE id = ?').run(calendarId)
    expect(db.prepare('SELECT COUNT(*) FROM resources').pluck().get()).toBe(0)
    const other = addCalendar('/room2/', null, 'resource')
    expect(() => insert.run(other, 0)).toThrow(/CHECK constraint/)
  })

  it('keeps usernames and collection paths unique', () => {
    addUser('sub-1', 'alice')
    expect(() => addUser('sub-2', 'ALICE')).toThrow(/UNIQUE constraint/)
    expect(() => addUser('sub-1', 'bob')).toThrow(/UNIQUE constraint/)
    db.prepare('INSERT INTO users (oidc_sub) VALUES (?)').run('sub-3')
    expect(() => db.prepare('INSERT INTO users (oidc_sub) VALUES (?)').run('sub-4')).not.toThrow()

    addCalendar('/same/')
    expect(() => addCalendar('/same/')).toThrow(/UNIQUE constraint/)
  })

  it('keeps category names unique per owner, ignoring case', () => {
    const userId = addUser()
    const insert = db.prepare('INSERT INTO categories (name, owner_id) VALUES (?, ?)')
    insert.run('Work', userId)
    insert.run('Work', null)
    expect(() => insert.run('work', userId)).toThrow(/UNIQUE constraint/)
    expect(() => insert.run('WORK', null)).toThrow(/UNIQUE constraint/)
  })
})

describe('users', () => {
  const now = new Date('2026-10-29T10:00:00.000Z')

  beforeEach(() => {
    migrated()
  })

  it('creates a user on first use', () => {
    const user = upsertUser(
      db,
      { sub: 'sub-1', username: 'alice', name: 'Alice A', email: 'alice@example.org' },
      now,
    )
    expect(user).toEqual({
      id: expect.any(Number),
      sub: 'sub-1',
      username: 'alice',
      name: 'Alice A',
      email: 'alice@example.org',
      isAdmin: false,
      lastSeenAt: now.toISOString(),
      timeZone: null,
    })
  })

  it('updates the profile and last_seen_at on later use without a second row', () => {
    const first = upsertUser(db, { sub: 'sub-1', username: 'alice', name: 'Alice' }, now)
    const later = new Date('2026-10-30T08:00:00.000Z')
    const second = upsertUser(
      db,
      { sub: 'sub-1', username: 'alicia', name: 'Alicia', email: 'a@example.org', isAdmin: true },
      later,
    )
    expect(second).toMatchObject({
      id: first.id,
      username: 'alicia',
      name: 'Alicia',
      email: 'a@example.org',
      isAdmin: true,
      lastSeenAt: later.toISOString(),
    })
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
  })

  it('keeps stored fields that the call leaves out', () => {
    upsertUser(
      db,
      { sub: 'sub-1', username: 'alice', name: 'Alice', email: 'a@example.org', isAdmin: true },
      now,
    )
    const later = new Date('2026-10-30T08:00:00.000Z')
    expect(upsertUser(db, { sub: 'sub-1' }, later)).toMatchObject({
      username: 'alice',
      name: 'Alice',
      email: 'a@example.org',
      isAdmin: true,
      lastSeenAt: later.toISOString(),
    })
    expect(upsertUser(db, { sub: 'sub-1', isAdmin: false }, later).isAdmin).toBe(false)
  })

  it('treats blank fields as missing', () => {
    expect(upsertUser(db, { sub: 'sub-1', username: '  ', name: '' }, now)).toMatchObject({
      username: null,
      name: null,
    })
  })

  it('moves a username to its new holder instead of failing', () => {
    upsertUser(db, { sub: 'sub-old', username: 'alice' }, now)
    upsertUser(db, { sub: 'sub-new', username: 'alice' }, now)
    expect(findUserBySub(db, 'sub-old')?.username).toBeNull()
    expect(findUserByUsername(db, 'alice')?.sub).toBe('sub-new')
  })

  it('finds users by sub and by username, ignoring case', () => {
    const created = upsertUser(db, { sub: 'sub-1', username: 'Alice' }, now)
    expect(findUserBySub(db, 'sub-1')).toEqual(created)
    expect(findUserByUsername(db, 'alice')).toEqual(created)
    expect(findUserBySub(db, 'nobody')).toBeNull()
    expect(findUserByUsername(db, 'nobody')).toBeNull()
  })

  it('needs a sub', () => {
    expect(() => upsertUser(db, { sub: '' })).toThrow(/sub/)
  })
})
