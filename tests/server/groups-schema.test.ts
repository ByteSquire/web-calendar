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
  countGroups,
  findGroupByName,
  isGroupMember,
  listGroupSummaries,
  listGroupsForFile,
  listGroupMembers,
  replaceGroupMembers,
} from '../../server/db/groups'
import { upsertUser } from '../../server/db/users'
import {
  createCustomGroup,
  deleteCustomGroup,
  mayActForGroup,
  replaceMembers,
} from '../../server/utils/groups/service'
import { signinCutoff } from '../../server/utils/auth/window'
import { reservedGroupNames } from '../../server/utils/groups/claim'
import { importCandidate, listCandidates } from '../../server/utils/groups/oidc'
import { MAX_GROUPS } from '../../server/utils/groups/rules'
import { apiError, openTestDb } from './api-fixtures'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const BOB = '6f9f0e2d-0000-4000-8000-000000000002'
const ADMIN_GROUP = 'calendar_admins'
// Any time before the rows a test makes: `isGroupMember` of a stored member ignores it.
const LONG_AGO = '2000-01-01T00:00:00.000Z'

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
    expect(tableColumns(db, 'groups')).toEqual([
      'id',
      'name',
      'source',
      'external_id',
      'created_at',
      'updated_at',
    ])
    expect(tableColumns(db, 'oidc_group_candidates')).toEqual([
      'external_id',
      'name',
      'conflict',
      'first_seen_at',
      'last_seen_at',
    ])
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
    expect(isGroupMember(db, group.id, 'ABC123', LONG_AGO)).toBe(true)
    expect(isGroupMember(db, group.id, 'abc123', LONG_AGO)).toBe(false)
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

  it('refuses every name the admin group can have here, whatever form the setting has', () => {
    // an SPN: an import names the group by the part before the @
    expect(() =>
      createCustomGroup(db, 'calendar_admins', 'calendar_admins@idm.example.org'),
    ).toThrow(/reserved/)
    // a path: an import joins the segments with dots
    expect(() => createCustomGroup(db, 'org.admins', '/org/admins')).toThrow(/reserved/)
    expect(reservedGroupNames('calendar_admins@idm.example.org')).toEqual([
      'calendar_admins@idm.example.org',
      'calendar_admins_idm.example.org',
      'calendar_admins',
      'web_calendar_users',
    ])
    // other names stay free
    expect(createCustomGroup(db, 'admins_of_rooms', 'calendar_admins@idm.example.org').name).toBe(
      'admins_of_rooms',
    )
  })

  it('never offers or imports the admin group, by its short name or by its id', () => {
    const add = db.prepare('INSERT INTO oidc_group_candidates (external_id, name) VALUES (?, ?)')
    add.run('11111111-aaaa-4aaa-8aaa-111111111111', 'calendar_admins')
    add.run('22222222-bbbb-4bbb-8bbb-222222222222', 'staff')
    const bySpn = { ignore: [], adminGroup: 'calendar_admins@idm.example.org' }
    expect(listCandidates(db, bySpn).candidates.map((item) => item.name)).toEqual(['staff'])
    expect(() => importCandidate(db, '11111111-aaaa-4aaa-8aaa-111111111111', bySpn)).toThrow(
      apiError(404),
    )
    const byId = { ignore: [], adminGroup: '22222222-bbbb-4bbb-8bbb-222222222222' }
    expect(listCandidates(db, byId).candidates.map((item) => item.name)).toEqual([
      'calendar_admins',
    ])
    expect(() => importCandidate(db, '22222222-bbbb-4bbb-8bbb-222222222222', byId)).toThrow(
      apiError(404),
    )
  })

  it('refuses a name taken by a group of either source, ignoring case', () => {
    createCustomGroup(db, 'Team', ADMIN_GROUP)
    expect(() => createCustomGroup(db, 'team', ADMIN_GROUP)).toThrow(/already exists/)
    db.prepare(
      `INSERT INTO groups (name, source, external_id) VALUES ('staff', 'oidc', 'staff-id')`,
    ).run()
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

  it('lists every group for the file: app and imported groups with their stored members', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    upsertUser(db, { sub: ALICE, username: 'alice' })
    replaceGroupMembers(db, group.id, [ALICE])
    const imported = db
      .prepare(
        `INSERT INTO groups (name, source, external_id) VALUES ('from_idp', 'oidc', 'idp-1') RETURNING id`,
      )
      .pluck()
      .get() as number
    replaceGroupMembers(db, imported, [BOB])
    expect(findGroupByName(db, 'Team')?.source).toBe('app')
    const { groups, skipped } = listGroupsForFile(db, LONG_AGO)
    expect(skipped).toBe(0)
    expect(groups).toEqual([
      { name: 'Team', members: [ALICE] },
      { name: 'from_idp', members: [BOB] },
      // Seen since the cutoff: alice only (bob never signed in).
      { name: 'web_calendar_users', members: [ALICE] },
    ])
  })

  it('leaves a member that is not a valid user id out of the file and counts it', () => {
    const group = createCustomGroup(db, 'Team', ADMIN_GROUP)
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group.id, ALICE)
    // The table allows any 1..255 characters; the file does not.
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group.id, 'a b')
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group.id, 'x/y')
    const { groups, skipped } = listGroupsForFile(db, LONG_AGO)
    expect(groups.find((g) => g.name === 'Team')!.members).toEqual([ALICE])
    expect(skipped).toBe(2)
  })

  it('puts the people seen since the cutoff into the line of everyone, and nobody older', () => {
    upsertUser(db, { sub: ALICE, username: 'a' }, new Date('2026-06-14T12:00:00.000Z'))
    upsertUser(db, { sub: BOB, username: 'b' }, new Date('2026-06-01T12:00:00.000Z'))
    const line = (since: string) =>
      listGroupsForFile(db, since).groups.find((g) => g.name === 'web_calendar_users')!.members
    expect(line('2026-06-10T00:00:00.000Z')).toEqual([ALICE])
    expect(line('2026-05-01T00:00:00.000Z')).toEqual([BOB, ALICE].sort())
    expect(line('2026-07-01T00:00:00.000Z')).toEqual([])
  })
})

describe('the sources of a group and the group of everyone (migration 009)', () => {
  const insertGroup = (name: string, source: string, externalId: string | null) =>
    db
      .prepare(`INSERT INTO groups (name, source, external_id) VALUES (?, ?, ?)`)
      .run(name, source, externalId)

  beforeEach(() => {
    db = openTestDb()
  })

  it('has exactly one group of everyone from the start, named web_calendar_users, with no members', () => {
    const rows = db
      .prepare(`SELECT name, source, external_id FROM groups WHERE source = 'everyone'`)
      .all()
    expect(rows).toEqual([{ name: 'web_calendar_users', source: 'everyone', external_id: null }])
    expect(db.prepare('SELECT COUNT(*) FROM group_members').pluck().get()).toBe(0)
  })

  it('accepts the three sources and refuses any other, e.g. the old name kanidm', () => {
    insertGroup('made_here', 'app', null)
    insertGroup('from_idp', 'oidc', 'idp-1')
    expect(() => insertGroup('old_name', 'kanidm', 'k-1')).toThrow(/CHECK/)
  })

  it('keeps the name web_calendar_users for the group of everyone alone', () => {
    // The name is the built-in group's, so no other source can take it and it cannot be renamed;
    // `name` is unique, so there is no second group of everyone either.
    expect(() => insertGroup('web_calendar_users', 'app', null)).toThrow(/CHECK|UNIQUE/)
    expect(() => insertGroup('web_calendar_users', 'oidc', 'idp-9')).toThrow(/CHECK|UNIQUE/)
    expect(() => insertGroup('everybody', 'everyone', null)).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`UPDATE groups SET name = 'renamed' WHERE source = 'everyone'`).run(),
    ).toThrow(/CHECK/)
    expect(db.prepare(`SELECT COUNT(*) FROM groups WHERE source = 'everyone'`).pluck().get()).toBe(
      1,
    )
  })

  it('needs an external id for an imported group and for no other', () => {
    expect(() => insertGroup('no_id', 'oidc', null)).toThrow(/CHECK/)
    expect(() => insertGroup('app_id', 'app', 'idp-1')).toThrow(/CHECK/)
    expect(() =>
      db.prepare(`UPDATE groups SET external_id = 'x' WHERE source = 'everyone'`).run(),
    ).toThrow(/CHECK/)
  })

  it('keeps the external id 1 to 255 characters long and unique, and lets other groups have none', () => {
    expect(() => insertGroup('empty_id', 'oidc', '')).toThrow(/CHECK/)
    expect(() => insertGroup('long_id', 'oidc', 'x'.repeat(256))).toThrow(/CHECK/)
    insertGroup('widest', 'oidc', 'x'.repeat(255))
    insertGroup('first', 'oidc', 'Idp-1')
    expect(() => insertGroup('twin', 'oidc', 'Idp-1')).toThrow(/UNIQUE/)
    // The index is on the exact text (the id is the provider's, case-sensitive).
    insertGroup('other_case', 'oidc', 'idp-1')
    // Several groups without an id are fine: the index covers imported groups only.
    insertGroup('app_one', 'app', null)
    insertGroup('app_two', 'app', null)
  })

  it('checks a candidate like a group: id length, a file-safe name, a 0/1 conflict flag', () => {
    const insert = (id: string, name: string, conflict = 0) =>
      db
        .prepare(`INSERT INTO oidc_group_candidates (external_id, name, conflict) VALUES (?, ?, ?)`)
        .run(id, name, conflict)
    insert('a', 'team')
    expect(() => insert('a', 'other')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insert('', 'team2')).toThrow(/CHECK/)
    expect(() => insert('x'.repeat(256), 'team3')).toThrow(/CHECK/)
    expect(() => insert('b', 'bad name')).toThrow(/CHECK/)
    expect(() => insert('c', '-lead')).toThrow(/CHECK/)
    expect(() => insert('d', 'x'.repeat(65))).toThrow(/CHECK/)
    expect(() => insert('e', 'team', 2)).toThrow(/CHECK/)
    const seen = db
      .prepare<[], { first_seen_at: string; last_seen_at: string }>(
        'SELECT first_seen_at, last_seen_at FROM oidc_group_candidates',
      )
      .get()!
    expect(seen.first_seen_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(seen.last_seen_at).toBe(seen.first_seen_at)
  })

  it('does not count the group of everyone against the group limit', () => {
    expect(countGroups(db)).toBe(0)
    createCustomGroup(db, 'one', ADMIN_GROUP)
    expect(countGroups(db)).toBe(1)
  })
})

describe('the members of the group of everyone', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  const since = signinCutoff(30 * DAY, NOW)

  beforeEach(() => {
    db = openTestDb()
  })

  const everyone = () =>
    db.prepare<[], { id: number }>(`SELECT id FROM groups WHERE source = 'everyone'`).get()!.id

  it('counts, and holds, the people seen since the cutoff and nobody else', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' }, new Date(NOW.getTime() - 29 * DAY))
    upsertUser(db, { sub: BOB, username: 'bob' }, new Date(NOW.getTime() - 31 * DAY))
    const row = listGroupSummaries(db, ALICE, since).find((g) => g.source === 'everyone')!
    expect(row).toMatchObject({ name: 'web_calendar_users', memberCount: 1, member: true })
    expect(listGroupSummaries(db, BOB, since).find((g) => g.source === 'everyone')).toMatchObject({
      memberCount: 1,
      member: false,
    })
    expect(isGroupMember(db, everyone(), ALICE, since)).toBe(true)
    expect(isGroupMember(db, everyone(), BOB, since)).toBe(false)
    expect(isGroupMember(db, everyone(), 'unknown', since)).toBe(false)
  })

  it('includes a person seen exactly at the cutoff and excludes one a millisecond earlier', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' }, new Date(NOW.getTime() - 30 * DAY))
    upsertUser(db, { sub: BOB, username: 'bob' }, new Date(NOW.getTime() - 30 * DAY - 1))
    expect(isGroupMember(db, everyone(), ALICE, since)).toBe(true)
    expect(isGroupMember(db, everyone(), BOB, since)).toBe(false)
  })

  it('never lists members, even if a row is stored for it, and ignores such a row', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' }, new Date(NOW.getTime() - 40 * DAY))
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(everyone(), ALICE)
    expect(listGroupMembers(db, everyone())).toEqual([])
    expect(isGroupMember(db, everyone(), ALICE, since)).toBe(false)
  })

  it('refuses to change or delete it, as for an imported group', () => {
    const group = findGroupByName(db, 'web_calendar_users')!
    upsertUser(db, { sub: ALICE, username: 'alice' })
    expect(() => replaceMembers(db, group, [ALICE])).toThrow(/cannot be changed/)
    expect(() => deleteCustomGroup(db, group)).toThrow(/cannot be changed/)
    expect(findGroupByName(db, 'web_calendar_users')).toBeDefined()
  })

  it('lets a person seen recently act in it, and an admin always (mayActForGroup)', async () => {
    const group = findGroupByName(db, 'web_calendar_users')!
    upsertUser(db, { sub: ALICE, username: 'alice' }, NOW)
    upsertUser(db, { sub: BOB, username: 'bob' }, new Date(NOW.getTime() - 31 * DAY))
    const admin = async () => true
    const nobody = async () => false
    expect(await mayActForGroup(db, group, ALICE, nobody, since)).toBe(true)
    expect(await mayActForGroup(db, group, BOB, nobody, since)).toBe(false)
    expect(await mayActForGroup(db, group, BOB, admin, since)).toBe(true)
  })
})
