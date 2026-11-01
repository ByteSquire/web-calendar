// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addCalendarAcl,
  AclError,
  listAllCalendarAcl,
  listCalendarAcl,
  listUnappliedCalendarAcl,
  markCalendarAclApplied,
  removeCalendarAcl,
  replaceCalendarAcl,
} from '../../server/db/calendar-acl'
import {
  approveBooking,
  clearBookingOrphaned,
  createBooking,
  getBooking,
  listBookingsByRequester,
  listBookingsByResource,
  listBookingsInRange,
  markBookingOrphaned,
  transitionBooking,
} from '../../server/db/bookings'
import { openDatabase } from '../../server/db/connection'
import {
  loadMigrationsFromDir,
  MigrationError,
  runMigrations,
  type Migration,
} from '../../server/db/migrate'
import {
  addResourceAcl,
  effectiveResourceRight,
  listResourceAcl,
  removeResourceAcl,
  replaceResourceAcl,
} from '../../server/db/resource-acl'
import {
  createResource,
  deactivateResource,
  getResource,
  listResources,
  updateResource,
} from '../../server/db/resources'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const SUB_A = '8f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
const SUB_B = '3d9a7e51-0c2b-4f86-b1aa-6e4d8c0f9a12'
const GROUP = 'c0a8e2d4-77f1-4b0a-8d3e-5b1f9a6c4e10'
const NOW = new Date('2030-01-01T08:00:00.000Z')

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function allMigrations(): Migration[] {
  return loadMigrationsFromDir(migrationsDir)
}

function migrated(): Database {
  runMigrations(db, allMigrations())
  return db
}

function addUser(sub: string, username: string): number {
  return Number(
    db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(sub, username)
      .lastInsertRowid,
  )
}

function addCalendar(path = '/shared/'): number {
  return Number(
    db
      .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('T', 'shared', ?)")
      .run(path).lastInsertRowid,
  )
}

function slot(hourFrom: number, hourTo: number, day = '2030-01-02'): [string, string] {
  const hh = (hour: number) => String(hour).padStart(2, '0')
  return [`${day}T${hh(hourFrom)}:00:00.000Z`, `${day}T${hh(hourTo)}:00:00.000Z`]
}

describe('migration 006 guard', () => {
  const before006 = (): Migration[] => allMigrations().filter((m) => m.name < '006')
  const m006 = (): Migration => allMigrations().find((m) => m.name.startsWith('006'))!

  it('aborts and keeps the data when calendar_acl has rows', () => {
    runMigrations(db, before006())
    const calendar = addCalendar()
    db.prepare(
      "INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, 'user', 'bob', 'read')",
    ).run(calendar)
    expect(() => runMigrations(db, [m006()])).toThrow(MigrationError)
    expect(() => runMigrations(db, [m006()])).toThrow(/calendar_acl still has rows/)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_acl').pluck().get()).toBe(1)
    expect(
      db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE name LIKE '006%'").pluck().get(),
    ).toBe(0)
  })

  it('aborts and keeps the data when resources has rows', () => {
    runMigrations(db, before006())
    const calendar = addCalendar()
    db.prepare("INSERT INTO resources (calendar_id, name, type) VALUES (?, 'R', 'room')").run(
      calendar,
    )
    expect(() => runMigrations(db, [m006()])).toThrow(/resources still has rows/)
    expect(db.prepare('SELECT COUNT(*) FROM resources').pluck().get()).toBe(1)
    expect(db.pragma('table_info(resources)') as unknown[]).toHaveLength(8)
  })

  it('applies to empty old tables and leaves no temp table behind', () => {
    runMigrations(db, before006())
    expect(runMigrations(db, [m006()])).toEqual([m006().name])
    expect(
      db
        .prepare("SELECT COUNT(*) FROM sqlite_temp_master WHERE name LIKE 'migration_006%'")
        .pluck()
        .get(),
    ).toBe(0)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

describe('schema', () => {
  beforeEach(() => {
    migrated()
  })

  it('validates calendar_acl principals and applied_at', () => {
    const calendar = addCalendar()
    const insert = db.prepare(
      'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
    )
    insert.run(calendar, 'user', SUB_A, 'read')
    insert.run(calendar, 'group', 'staff@idm.example.org', 'write')
    insert.run(calendar, 'authenticated', null, 'free_busy')
    expect(() => insert.run(calendar, 'user', 'has space', 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(calendar, 'user', 'a/b', 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(calendar, 'authenticated', SUB_A, 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(calendar, 'public', null, 'read')).not.toThrow()
    expect(() => insert.run(calendar, 'public', null, 'write')).toThrow(/UNIQUE constraint/)
    expect(listUnappliedCalendarAcl(db)).toHaveLength(4)
  })

  it('cascades calendar_acl and resource_acl and protects resources with bookings', () => {
    const calendar = addCalendar()
    db.prepare(
      "INSERT INTO calendar_acl (calendar_id, principal_type, permission) VALUES (?, 'public', 'read')",
    ).run(calendar)
    db.prepare('DELETE FROM calendars WHERE id = ?').run(calendar)
    expect(db.prepare('SELECT COUNT(*) FROM calendar_acl').pluck().get()).toBe(0)

    const user = addUser(SUB_A, 'alice')
    const resource = createResource(db, room())
    const [start, end] = slot(9, 10)
    const result = createBooking(db, booking(resource.id, user, start, end), { now: NOW })
    expect(result.ok).toBe(true)
    expect(() => db.prepare('DELETE FROM resources WHERE id = ?').run(resource.id)).toThrow(
      /FOREIGN KEY constraint/,
    )
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(user)).toThrow(
      /FOREIGN KEY constraint/,
    )
    db.prepare('DELETE FROM calendar_bookings').run()
    db.prepare('DELETE FROM resources WHERE id = ?').run(resource.id)
    expect(db.prepare('SELECT COUNT(*) FROM resource_acl').pluck().get()).toBe(0)
  })

  it('checks resource_acl columns', () => {
    const resource = createResource(db, room())
    const insert = db.prepare(
      'INSERT INTO resource_acl (resource_id, principal_type, principal, "right") VALUES (?, ?, ?, ?)',
    )
    expect(() => insert.run(resource.id, 'public', null, 'read')).toThrow(/CHECK constraint/)
    expect(() => insert.run(resource.id, 'user', SUB_A, 'own')).toThrow(/CHECK constraint/)
    expect(() => insert.run(resource.id, 'authenticated', null, 'read')).toThrow(
      /UNIQUE constraint/,
    )
    expect(() => insert.run(resource.id, 'user', SUB_A, 'manage')).not.toThrow()
  })

  it('checks booking columns', () => {
    const user = addUser(SUB_A, 'alice')
    const resource = createResource(db, room())
    const insert = db.prepare(
      `INSERT INTO calendar_bookings (resource_id, requester_id, start_at, end_at, status, event_uid, block_ref)
       VALUES (?, ?, ?, ?, ?, 'uid', ?)`,
    )
    const ref = (n: number) => `ref-${String(n).padStart(20, '0')}`
    const [start, end] = slot(9, 10)
    insert.run(resource.id, user, start, end, 'pending', ref(1))
    expect(() => insert.run(resource.id, user, end, start, 'pending', ref(2))).toThrow(
      /CHECK constraint/,
    )
    expect(() => insert.run(resource.id, user, start, start, 'pending', ref(3))).toThrow(
      /CHECK constraint/,
    )
    expect(() => insert.run(resource.id, user, '2030-01-02', end, 'pending', ref(4))).toThrow(
      /CHECK constraint/,
    )
    expect(() => insert.run(resource.id, user, start, end, 'orphaned', ref(5))).toThrow(
      /CHECK constraint/,
    )
    expect(() => insert.run(resource.id, user, start, end, 'pending', 'short')).toThrow(
      /CHECK constraint/,
    )
    expect(() => insert.run(resource.id, user, start, end, 'pending', ref(1))).toThrow(
      /UNIQUE constraint/,
    )
  })

  it('lets pending bookings overlap but not approved ones (insert and update)', () => {
    const user = addUser(SUB_A, 'alice')
    const resource = createResource(db, room())
    const other = createResource(db, room('Room 2'))
    const insert = db.prepare(
      `INSERT INTO calendar_bookings (resource_id, requester_id, start_at, end_at, status, event_uid, block_ref)
       VALUES (?, ?, ?, ?, ?, 'uid', ?)`,
    )
    const ref = (n: number) => `ref-${String(n).padStart(20, '0')}`
    const [s1, e1] = slot(9, 11)
    const [s2, e2] = slot(10, 12)
    const [s3, e3] = slot(11, 12)
    insert.run(resource.id, user, s1, e1, 'approved', ref(1))
    insert.run(resource.id, user, s2, e2, 'pending', ref(2))
    insert.run(resource.id, user, s2, e2, 'pending', ref(3))
    insert.run(other.id, user, s2, e2, 'approved', ref(4))
    insert.run(resource.id, user, s3, e3, 'approved', ref(5))
    expect(() => insert.run(resource.id, user, s2, e2, 'approved', ref(6))).toThrow(
      /overlaps another approved/,
    )
    expect(() =>
      db
        .prepare("UPDATE calendar_bookings SET status = 'approved' WHERE block_ref = ?")
        .run(ref(2)),
    ).toThrow(/overlaps another approved/)
    expect(() =>
      db.prepare('UPDATE calendar_bookings SET start_at = ? WHERE block_ref = ?').run(s2, ref(5)),
    ).toThrow(/overlaps another approved/)
  })

  it('keeps declined and cancelled final', () => {
    const user = addUser(SUB_A, 'alice')
    const resource = createResource(db, room())
    const [start, end] = slot(9, 10)
    const made = createBooking(db, booking(resource.id, user, start, end), { now: NOW })
    if (!made.ok) throw new Error('setup')
    db.prepare("UPDATE calendar_bookings SET status = 'cancelled' WHERE id = ?").run(
      made.booking.id,
    )
    expect(() =>
      db
        .prepare("UPDATE calendar_bookings SET status = 'pending' WHERE id = ?")
        .run(made.booking.id),
    ).toThrow(/cannot change status/)
  })
})

function room(name = 'Room 1') {
  return { name, type: 'room' as const, location: null, capacity: 8, description: null }
}

function booking(resourceId: number, requesterId: number, startAt: string, endAt: string) {
  return { resourceId, requesterId, startAt, endAt, eventCalendarId: null, eventUid: 'uid-1' }
}

describe('calendar-acl module', () => {
  beforeEach(() => {
    migrated()
  })

  it('replaces the rule set, keeping applied_at of unchanged rules', () => {
    const calendar = addCalendar()
    const first = replaceCalendarAcl(db, calendar, [
      { principalType: 'user', principal: SUB_A, permission: 'read' },
      { principalType: 'group', principal: GROUP, permission: 'write' },
      { principalType: 'public', principal: null, permission: 'free_busy' },
    ])
    expect(first).toHaveLength(3)
    expect(
      markCalendarAclApplied(
        db,
        first.map((r) => r.id),
        NOW,
      ),
    ).toBe(3)
    expect(listUnappliedCalendarAcl(db)).toEqual([])

    const second = replaceCalendarAcl(db, calendar, [
      { principalType: 'user', principal: SUB_A, permission: 'read' },
      { principalType: 'group', principal: GROUP, permission: 'admin' },
      { principalType: 'user', principal: SUB_B, permission: 'read' },
    ])
    expect(second.map((r) => [r.principal_type, r.principal, r.permission])).toEqual([
      ['user', SUB_A, 'read'],
      ['group', GROUP, 'admin'],
      ['user', SUB_B, 'read'],
    ])
    expect(second[0]?.applied_at).toBe(NOW.toISOString())
    expect(second[1]?.applied_at).toBeNull()
    expect(listUnappliedCalendarAcl(db).map((r) => r.principal)).toEqual([GROUP, SUB_B])
  })

  it('rolls back a replace that fails and rejects bad input before touching anything', () => {
    const calendar = addCalendar()
    addCalendarAcl(db, calendar, { principalType: 'user', principal: SUB_A, permission: 'read' })
    expect(() =>
      replaceCalendarAcl(db, calendar, [
        { principalType: 'user', principal: 'not valid', permission: 'read' },
      ]),
    ).toThrow(AclError)
    expect(() =>
      replaceCalendarAcl(db, calendar, [
        { principalType: 'public', principal: null, permission: 'read' },
        { principalType: 'public', principal: null, permission: 'write' },
      ]),
    ).toThrow(/same principal/)
    expect(() =>
      replaceCalendarAcl(db, 9999, [
        { principalType: 'public', principal: null, permission: 'read' },
      ]),
    ).toThrow(/FOREIGN KEY/)
    expect(listCalendarAcl(db, calendar)).toHaveLength(1)
  })

  it('adds, upserts, removes and lists', () => {
    const one = addCalendar('/one/')
    const two = addCalendar('/two/')
    const row = addCalendarAcl(db, one, {
      principalType: 'authenticated',
      principal: null,
      permission: 'free_busy',
    })
    markCalendarAclApplied(db, [row.id], NOW)
    const same = addCalendarAcl(db, one, {
      principalType: 'authenticated',
      principal: null,
      permission: 'free_busy',
    })
    expect(same.id).toBe(row.id)
    expect(same.applied_at).toBe(NOW.toISOString())
    const changed = addCalendarAcl(db, one, {
      principalType: 'authenticated',
      principal: null,
      permission: 'read',
    })
    expect(changed).toMatchObject({ id: row.id, permission: 'read', applied_at: null })
    addCalendarAcl(db, two, { principalType: 'user', principal: SUB_A, permission: 'write' })
    expect(listAllCalendarAcl(db).map((r) => r.calendar_id)).toEqual([one, two])
    expect(removeCalendarAcl(db, one, 'authenticated', null)).toBe(true)
    expect(removeCalendarAcl(db, one, 'authenticated', null)).toBe(false)
    expect(removeCalendarAcl(db, two, 'user', SUB_A)).toBe(true)
    expect(listAllCalendarAcl(db)).toEqual([])
  })
})

describe('resources and resource-acl modules', () => {
  beforeEach(() => {
    migrated()
  })

  it('creates a resource with the default "authenticated may book" rule', () => {
    const resource = createResource(db, room())
    expect(resource).toMatchObject({ name: 'Room 1', type: 'room', capacity: 8, active: 1 })
    expect(listResourceAcl(db, resource.id)).toMatchObject([
      { principal_type: 'authenticated', principal: null, right: 'book' },
    ])
    expect(getResource(db, resource.id)).toEqual(resource)
    expect(getResource(db, 999)).toBeNull()
  })

  it('updates, deactivates and lists', () => {
    const a = createResource(db, room('beta'))
    const b = createResource(db, room('Alpha'))
    expect(listResources(db).map((r) => r.name)).toEqual(['Alpha', 'beta'])
    const updated = updateResource(db, a.id, { location: 'Floor 2', capacity: null })
    expect(updated).toMatchObject({ name: 'beta', location: 'Floor 2', capacity: null })
    expect(deactivateResource(db, b.id)?.active).toBe(0)
    expect(listResources(db).map((r) => r.name)).toEqual(['beta'])
    expect(listResources(db, { includeInactive: true })).toHaveLength(2)
    expect(updateResource(db, 999, { name: 'x' })).toBeNull()
    expect(deactivateResource(db, 999)).toBeNull()
  })

  it('manages the rule set and computes the effective right', () => {
    const resource = createResource(db, room())
    const user = { sub: SUB_A, groups: [GROUP] }
    expect(effectiveResourceRight(db, resource.id, user)).toBe('book')
    addResourceAcl(db, resource.id, { principalType: 'group', principal: GROUP, right: 'manage' })
    expect(effectiveResourceRight(db, resource.id, user)).toBe('manage')
    expect(effectiveResourceRight(db, resource.id, { sub: SUB_B, groups: [] })).toBe('book')
    replaceResourceAcl(db, resource.id, [
      { principalType: 'user', principal: SUB_A, right: 'read' },
    ])
    expect(effectiveResourceRight(db, resource.id, user)).toBe('read')
    expect(effectiveResourceRight(db, resource.id, { sub: SUB_B, groups: [] })).toBeNull()
    expect(removeResourceAcl(db, resource.id, 'user', SUB_A)).toBe(true)
    expect(removeResourceAcl(db, resource.id, 'user', SUB_A)).toBe(false)
    expect(() =>
      addResourceAcl(db, resource.id, { principalType: 'user', principal: 'a/b', right: 'read' }),
    ).toThrow(AclError)
  })
})

describe('bookings module', () => {
  let user: number
  let manager: number
  let resourceId: number

  beforeEach(() => {
    migrated()
    user = addUser(SUB_A, 'alice')
    manager = addUser(SUB_B, 'bob')
    resourceId = createResource(db, room()).id
  })

  function book(from: number, to: number, who = user, day = '2030-01-02') {
    const [start, end] = slot(from, to, day)
    return createBooking(db, booking(resourceId, who, start, end), { now: NOW })
  }

  it('creates a pending booking with normalised UTC times and an opaque block_ref', () => {
    const result = createBooking(
      db,
      booking(resourceId, user, '2030-01-02T10:00:00+01:00', '2030-01-02T11:00:00+01:00'),
      { now: NOW },
    )
    if (!result.ok) throw new Error(result.code)
    expect(result.booking).toMatchObject({
      status: 'pending',
      start_at: '2030-01-02T09:00:00.000Z',
      end_at: '2030-01-02T10:00:00.000Z',
      approver_id: null,
      orphaned_at: null,
    })
    expect(result.booking.block_ref).toMatch(/^[0-9a-f]{32}$/)
    const second = book(12, 13)
    expect(second.ok && second.booking.block_ref).not.toBe(result.booking.block_ref)
  })

  it('refuses bad slots, unavailable resources and over-limit requests', () => {
    const code = (r: { ok: boolean; code?: string }) => (r.ok ? 'ok' : r.code)
    const [s, e] = slot(9, 10)
    expect(code(createBooking(db, booking(resourceId, user, e, s), { now: NOW }))).toBe(
      'invalid_slot',
    )
    expect(code(createBooking(db, booking(resourceId, user, 'nope', e), { now: NOW }))).toBe(
      'invalid_slot',
    )
    expect(code(createBooking(db, booking(999, user, s, e), { now: NOW }))).toBe(
      'resource_unavailable',
    )
    expect(code(book(6, 7, user, '2029-12-31'))).toBe('in_past')
    expect(
      code(createBooking(db, booking(resourceId, user, s, '2030-01-04T09:00:00Z'), { now: NOW })),
    ).toBe('too_long')
    expect(code(book(9, 10, user, '2032-01-02'))).toBe('too_far_ahead')
    const limited = { now: NOW, limits: { maxPerRequesterPerDay: 2 } }
    createBooking(db, booking(resourceId, user, ...slot(1, 2)), limited)
    createBooking(db, booking(resourceId, user, ...slot(3, 4)), limited)
    expect(code(createBooking(db, booking(resourceId, user, ...slot(5, 6)), limited))).toBe(
      'daily_limit',
    )
    expect(code(createBooking(db, booking(resourceId, manager, ...slot(5, 6)), limited))).toBe('ok')
    deactivateResource(db, resourceId)
    expect(code(book(15, 16))).toBe('resource_unavailable')
  })

  it('lets pending bookings overlap and refuses a booking over an approved one', () => {
    const first = book(9, 11)
    const second = book(10, 12, manager)
    if (!first.ok || !second.ok) throw new Error('setup')
    expect(approveBooking(db, first.booking.id, manager, NOW).ok).toBe(true)
    const clash = book(10, 11)
    expect(clash).toEqual({ ok: false, code: 'overlap' })
    expect(book(11, 12).ok).toBe(true)
  })

  it('approves one booking and auto-declines the overlapping pending ones', () => {
    const a = book(9, 11)
    const b = book(10, 12, manager)
    const c = book(11, 12)
    const d = book(8, 9)
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('setup')
    const approved = approveBooking(db, a.booking.id, manager, NOW)
    if (!approved.ok) throw new Error(approved.code)
    expect(approved.booking).toMatchObject({
      status: 'approved',
      approver_id: manager,
      decided_at: NOW.toISOString(),
    })
    expect(approved.declinedIds).toEqual([b.booking.id])
    expect(getBooking(db, b.booking.id)?.status).toBe('declined')
    expect(getBooking(db, c.booking.id)?.status).toBe('pending')
    expect(getBooking(db, d.booking.id)?.status).toBe('pending')
    expect(approveBooking(db, a.booking.id, manager, NOW)).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
    expect(approveBooking(db, b.booking.id, manager, NOW)).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
    expect(approveBooking(db, 999, manager, NOW)).toEqual({ ok: false, code: 'not_found' })
  })

  it('enforces the allowed status moves', () => {
    const a = book(9, 10)
    const b = book(11, 12)
    const c = book(13, 14)
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup')
    const declined = transitionBooking(db, a.booking.id, 'declined', manager, NOW)
    expect(declined.ok && declined.booking).toMatchObject({
      status: 'declined',
      approver_id: manager,
    })
    expect(transitionBooking(db, a.booking.id, 'cancelled', user, NOW)).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
    approveBooking(db, b.booking.id, manager, NOW)
    expect(transitionBooking(db, b.booking.id, 'declined', manager, NOW)).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
    const cancelled = transitionBooking(db, b.booking.id, 'cancelled', user, NOW)
    expect(cancelled.ok && cancelled.booking).toMatchObject({
      status: 'cancelled',
      approver_id: manager,
    })
    expect(transitionBooking(db, c.booking.id, 'cancelled', user, NOW).ok).toBe(true)
    expect(transitionBooking(db, 999, 'cancelled', user, NOW)).toEqual({
      ok: false,
      code: 'not_found',
    })
    // The slot of a cancelled approved booking is free again.
    expect(book(11, 12, manager).ok).toBe(true)
  })

  it('lists by resource, requester and range', () => {
    const other = createResource(db, room('Room 2')).id
    const a = book(9, 10)
    const b = book(12, 13, manager)
    const [s, e] = slot(9, 10)
    const c = createBooking(db, booking(other, user, s, e), { now: NOW })
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup')
    approveBooking(db, b.booking.id, manager, NOW)
    expect(listBookingsByResource(db, resourceId).map((r) => r.id)).toEqual([
      a.booking.id,
      b.booking.id,
    ])
    expect(listBookingsByResource(db, resourceId, {}, ['approved']).map((r) => r.id)).toEqual([
      b.booking.id,
    ])
    expect(listBookingsByRequester(db, user).map((r) => r.id)).toEqual([a.booking.id, c.booking.id])
    const [from, to] = slot(10, 12)
    expect(listBookingsInRange(db, { from, to })).toEqual([])
    expect(listBookingsInRange(db, { from: slot(9, 10)[0], to: slot(9, 10)[1] })).toHaveLength(2)
    expect(listBookingsByResource(db, resourceId, { from: slot(12, 13)[0] })).toHaveLength(1)
  })

  it('tracks orphaned state without changing the status', () => {
    const a = book(9, 10)
    if (!a.ok) throw new Error('setup')
    approveBooking(db, a.booking.id, manager, NOW)
    const first = markBookingOrphaned(db, a.booking.id, NOW)
    const later = markBookingOrphaned(db, a.booking.id, new Date(NOW.getTime() + 60_000))
    expect(first).toMatchObject({ status: 'approved', reconcile_attempts: 1 })
    expect(later).toMatchObject({ orphaned_at: NOW.toISOString(), reconcile_attempts: 2 })
    expect(clearBookingOrphaned(db, a.booking.id)).toMatchObject({
      orphaned_at: null,
      reconcile_attempts: 0,
    })
    expect(markBookingOrphaned(db, 999)).toBeNull()
  })
})
