// @vitest-environment node
// Migration 009 (groups) on a fresh database and on one that already has rows, and the group rules
// that sit on the tables: reserved and taken names, limits, and a delete that is refused while the
// group owns calendars.
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { addCalendarAcl, listCalendarAcl } from '../../server/db/calendar-acl'
import {
  findGroupByName,
  isGroupMember,
  listCustomGroupsForFile,
  listGroupMembers,
  replaceImportedGroups,
  replaceGroupMembers,
} from '../../server/db/groups'
import { upsertUser } from '../../server/db/users'
import {
  createCustomGroup,
  deleteCustomGroup,
  replaceMembers,
} from '../../server/utils/groups/service'
import { MAX_GROUPS } from '../../server/utils/groups/rules'
import { apiError, openTestDb } from './api-fixtures'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const BOB = '6f9f0e2d-0000-4000-8000-000000000002'
const ADMIN_GROUP = 'calendar_admins'

let db: Database

afterEach(() => db?.close())

function tableColumns(database: Database, table: string): string[] {
  return database
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
}

function calendarRow(database: Database, name: string, groupId: number | null) {
  return database
    .prepare(
      `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id)
       VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(name, 'shared', `/_group-${groupId ?? 0}/${name}/`, groupId).lastInsertRowid
}

describe('migration 009 (groups)', () => {
  it('creates the tables and the group column on a fresh database', () => {
    db = openTestDb()
    expect(tableColumns(db, 'groups')).toEqual(['id', 'name', 'source', 'created_at', 'updated_at'])
    expect(tableColumns(db, 'group_members')).toEqual(['group_id', 'sub', 'created_at'])
    expect(tableColumns(db, 'calendars')).toContain('group_id')
  })

  it('keeps existing calendars and their rules when it runs on a database with rows', () => {
    db = openDatabase(':memory:')
    const migrations = loadMigrationsFromDir(migrationsDir)
    const before = migrations.filter((migration) => !migration.name.startsWith('009_'))
    runMigrations(db, before)
    upsertUser(db, { sub: ALICE, username: 'alice' })
    const owner = db.prepare<[], { id: number }>('SELECT id FROM users').get()!.id
    const personal = Number(
      db
        .prepare(
          `INSERT INTO calendars (name, kind, owner_id, collection_path) VALUES (?, ?, ?, ?)`,
        )
        .run('Mine', 'personal', owner, `/${ALICE}/mine/`).lastInsertRowid,
    )
    addCalendarAcl(db, personal, {
      principalType: 'authenticated',
      principal: null,
      permission: 'read',
    })

    runMigrations(db, migrations)

    const row = db
      .prepare<[number], { name: string; group_id: number | null; owner_id: number }>(
        'SELECT name, group_id, owner_id FROM calendars WHERE id = ?',
      )
      .get(personal)!
    expect(row).toEqual({ name: 'Mine', group_id: null, owner_id: owner })
    expect(listCalendarAcl(db, personal)).toHaveLength(1)
  })

  it('refuses a group column on a personal calendar and a group name that is not an htgroup name', () => {
    db = openTestDb()
    const group = createCustomGroup(db, 'team_a', ADMIN_GROUP)
    expect(() =>
      db
        .prepare(
          `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id) VALUES ('x', 'personal', 1, '/x/', ?)`,
        )
        .run(group.id),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`INSERT INTO groups (name, source) VALUES ('bad name', 'app')`).run(),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`INSERT INTO groups (name, source) VALUES ('-x', 'app')`).run(),
    ).toThrow(/CHECK/)
  })

  it('cascades group members with their group and refuses to delete a group that owns a calendar', () => {
    db = openTestDb()
    const group = createCustomGroup(db, 'team_a', ADMIN_GROUP)
    replaceGroupMembers(db, group.id, [ALICE])
    calendarRow(db, 'Team', group.id)
    expect(() => db.prepare('DELETE FROM groups WHERE id = ?').run(group.id)).toThrow(/FOREIGN KEY/)
    db.prepare('DELETE FROM calendars WHERE group_id = ?').run(group.id)
    db.prepare('DELETE FROM groups WHERE id = ?').run(group.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_members').pluck().get()).toBe(0)
  })

  it('stores a member id exactly as sent: any case, any provider shape, 1 to 255 characters', () => {
    db = openTestDb()
    const group = createCustomGroup(db, 'team_a', ADMIN_GROUP)
    const insert = db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)')
    insert.run(group.id, 'ABC123')
    expect(isGroupMember(db, group.id, 'ABC123')).toBe(true)
    expect(isGroupMember(db, group.id, 'abc123')).toBe(false)
    const more = ['abc123', 'auth0|5f7c', 'Alice@Example.org', 'x'.repeat(255)]
    for (const sub of more) insert.run(group.id, sub)
    expect(db.prepare('SELECT sub FROM group_members ORDER BY sub').pluck().all()).toEqual(
      ['ABC123', ...more].sort(),
    )
    expect(() => insert.run(group.id, '')).toThrow(/CHECK/)
    expect(() => insert.run(group.id, 'x'.repeat(256))).toThrow(/CHECK/)
    expect(() => insert.run(group.id, 'ABC123')).toThrow(/UNIQUE|PRIMARY/)
  })
})

describe('group rules', () => {
  beforeEach(() => {
    db = openTestDb()
  })

  it('refuses the admin group and the users group as a custom name, in any case', () => {
    expect(() => createCustomGroup(db, ADMIN_GROUP, ADMIN_GROUP)).toThrow(/already exists|reserved/)
    expect(() => createCustomGroup(db, 'Calendar_Admins', ADMIN_GROUP)).toThrow(/reserved/)
    expect(() => createCustomGroup(db, 'web_calendar_users', ADMIN_GROUP)).toThrow(/reserved/)
  })

  it('refuses a name taken by a group of either source, ignoring case', () => {
    createCustomGroup(db, 'Team', ADMIN_GROUP)
    expect(() => createCustomGroup(db, 'team', ADMIN_GROUP)).toThrow(/already exists/)
    db.prepare(`INSERT INTO groups (name, source) VALUES ('staff', 'kanidm')`).run()
    expect(() => createCustomGroup(db, 'staff', ADMIN_GROUP)).toThrow(/already exists/)
  })

  it('stops at the group limit', () => {
    const insert = db.prepare(`INSERT INTO groups (name, source) VALUES (?, 'app')`)
    for (let i = 0; i < MAX_GROUPS; i += 1) insert.run(`g${i}`)
    expect(() => createCustomGroup(db, 'one_more', ADMIN_GROUP)).toThrow(/at most 200/)
  })

  it('refuses to delete a group that still owns calendars, and says so', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    calendarRow(db, 'Team cal', group.id)
    expect(() => deleteCustomGroup(db, group)).toThrow(/still owns calendars/)
    expect(findGroupByName(db, 'Team')).toBeDefined()
  })

  it('deletes an empty group with the rules that name it, in both rule tables', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    const calendar = calendarRow(db, 'Other', null)
    addCalendarAcl(db, Number(calendar), {
      principalType: 'group',
      principal: 'Team',
      permission: 'read',
    })
    db.prepare(`INSERT INTO resources (name, type) VALUES ('Room', 'room')`).run()
    db.prepare(
      `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
       VALUES ((SELECT id FROM resources LIMIT 1), 'group', 'Team', 'read')`,
    ).run()
    const removed = deleteCustomGroup(db, group)
    expect(removed).toEqual({ calendarRules: 1, resourceRules: 1 })
    expect(findGroupByName(db, 'Team')).toBeUndefined()
    expect(listCalendarAcl(db, Number(calendar))).toEqual([])
  })

  it('makes the members exactly the list, and refuses a person who has never signed in', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    upsertUser(db, { sub: ALICE, username: 'alice' })
    upsertUser(db, { sub: BOB, username: 'bob' })
    const first = replaceMembers(db, group, [ALICE, BOB])
    expect(first).toEqual({ added: 2, removed: 0, total: 2 })
    expect(replaceMembers(db, group, [BOB])).toEqual({ added: 0, removed: 1, total: 1 })
    expect(listGroupMembers(db, group.id).map((m) => m.sub)).toEqual([BOB])
    expect(() => replaceMembers(db, group, ['9f9f9f9f-9999-4999-8999-999999999999'])).toThrow(
      apiError(400),
    )
  })

  it('leaves custom groups out of the Kanidm import and lists them for the file', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    upsertUser(db, { sub: ALICE, username: 'alice' })
    replaceGroupMembers(db, group.id, [ALICE])
    replaceImportedGroups(db, [{ name: 'Team', members: [BOB] }])
    expect(findGroupByName(db, 'Team')?.source).toBe('app')
    expect(listCustomGroupsForFile(db)).toEqual([{ name: 'Team', members: [ALICE] }])
  })
})

describe('an imported group whose members could not be read', () => {
  beforeEach(() => {
    db = openTestDb()
  })

  it('keeps the stored members when the import says so, and replaces them otherwise', () => {
    db.prepare(`INSERT INTO groups (name, source) VALUES ('team_k', 'kanidm')`).run()
    const group = findGroupByName(db, 'team_k')!
    replaceGroupMembers(db, group.id, [ALICE])

    replaceImportedGroups(db, [{ name: 'team_k', members: [], keepMembers: true }])
    expect(listGroupMembers(db, group.id).map((m) => m.sub)).toEqual([ALICE])
    expect(findGroupByName(db, 'team_k')).toBeDefined()

    replaceImportedGroups(db, [{ name: 'team_k', members: [BOB] }])
    expect(listGroupMembers(db, group.id).map((m) => m.sub)).toEqual([BOB])
  })
})

describe('a Kanidm group that vanished', () => {
  beforeEach(() => {
    db = openTestDb()
  })

  it('clears its members and removes the row, unless a calendar still points at it', () => {
    db.prepare(`INSERT INTO groups (name, source) VALUES ('gone', 'kanidm')`).run()
    db.prepare(`INSERT INTO groups (name, source) VALUES ('kept', 'kanidm')`).run()
    const gone = findGroupByName(db, 'gone')!
    const kept = findGroupByName(db, 'kept')!
    replaceGroupMembers(db, gone.id, [ALICE])
    replaceGroupMembers(db, kept.id, [BOB])
    calendarRow(db, 'Kept cal', kept.id)

    const counts = replaceImportedGroups(db, [])

    expect(counts).toEqual({ created: 0, updated: 0, cleared: 2, removed: 1 })
    expect(findGroupByName(db, 'gone')).toBeUndefined()
    expect(findGroupByName(db, 'kept')).toBeDefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM group_members').pluck().get()).toBe(0)
  })

  it('imports a new Kanidm group and keeps an app group with the same name untouched', () => {
    const app = createCustomGroup(db, 'team_a', ADMIN_GROUP)
    replaceGroupMembers(db, app.id, [ALICE])
    const counts = replaceImportedGroups(db, [
      { name: 'team_a', members: [BOB] },
      { name: 'team_b', members: [BOB] },
    ])
    expect(counts).toEqual({ created: 1, updated: 0, cleared: 0, removed: 0 })
    expect(listGroupMembers(db, app.id).map((m) => m.sub)).toEqual([ALICE])
    expect(findGroupByName(db, 'team_b')?.source).toBe('kanidm')
  })
})
