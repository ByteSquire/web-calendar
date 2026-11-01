// @vitest-environment node
// Availability, the manager queue and the booking updates, on a real in-memory database.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_AVAILABILITY_RANGE_DAYS } from '../../shared/types/resources-api'
import { recordAudit } from '../../server/db/audit-log'
import { addResourceAcl } from '../../server/db/resource-acl'
import { createResource } from '../../server/db/resources'
import { upsertUser } from '../../server/db/users'
import { listAvailability, parseAvailabilityQuery } from '../../server/utils/resources/availability'
import { listBookingRequests } from '../../server/utils/resources/requests'
import type { Actor } from '../../server/utils/resources/service'
import { listBookingUpdates } from '../../server/utils/resources/updates'
import { openTestDb } from './api-fixtures'

let db: Database
let owner: Actor
let alice: Actor
let bob: Actor
let manager: Actor
let roomId: number
let hiddenId: number
let calendarId: number

const workPath = () => `/${owner.sub}/work/`

const DAY = '2026-12-01'
const at = (hour: number) => `${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`
const RANGE = { from: `${DAY}T00:00:00.000Z`, to: `${DAY}T23:59:59.000Z`, resourceIds: [] }

function actorOf(sub: string, name: string, groups: string[] = []): Actor {
  return { id: upsertUser(db, { sub, username: name, name: `${name} Name` }).id, sub, groups }
}

function book(
  resourceId: number,
  requester: Actor,
  start: number,
  end: number,
  options: {
    status?: string
    path?: string
    uid?: string
    orphanedAt?: string | null
    createdAt?: string
    decidedAt?: string | null
  } = {},
): number {
  return db
    .prepare(
      `INSERT INTO calendar_bookings
         (resource_id, requester_id, start_at, end_at, status, event_calendar_path, event_uid,
          block_ref, orphaned_at, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      resourceId,
      requester.id,
      at(start),
      at(end),
      options.status ?? 'pending',
      options.path ?? `/${requester.sub}/default/`,
      options.uid ?? `uid-${start}-${end}-${requester.id}`,
      `ref-${Math.random().toString(16).slice(2)}-0000000000000000`,
      options.orphanedAt ?? null,
      options.createdAt ?? '2026-11-20T10:00:00.000Z',
      options.decidedAt ?? null,
    ).lastInsertRowid as number
}

beforeEach(() => {
  db = openTestDb()
  owner = actorOf('00000000-0000-4000-8000-000000000001', 'owner')
  alice = actorOf('00000000-0000-4000-8000-000000000002', 'alice')
  bob = actorOf('00000000-0000-4000-8000-000000000003', 'bob')
  manager = actorOf('00000000-0000-4000-8000-000000000004', 'manager', ['facility'])
  const fields = { type: 'room', location: null, description: null, capacity: null } as const
  roomId = createResource(db, { ...fields, name: 'Room' }).id
  hiddenId = createResource(db, { ...fields, name: 'Hidden' }).id
  addResourceAcl(db, roomId, { principalType: 'authenticated', principal: null, right: 'book' })
  addResourceAcl(db, roomId, { principalType: 'group', principal: 'facility', right: 'manage' })
  db.prepare(
    "DELETE FROM resource_acl WHERE resource_id = ? AND principal_type = 'authenticated'",
  ).run(hiddenId)
  addResourceAcl(db, hiddenId, { principalType: 'group', principal: 'facility', right: 'manage' })
  calendarId = db
    .prepare(
      `INSERT INTO calendars (name, kind, owner_id, collection_path)
       VALUES ('Work', 'personal', ?, ?) RETURNING id`,
    )
    .pluck()
    .get(owner.id, `/${owner.sub}/work/`) as number
})

afterEach(() => db.close())

function share(permission: string, principalType = 'user', principal: string | null = bob.sub) {
  db.prepare(
    `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
     VALUES (?, ?, ?, ?)`,
  ).run(calendarId, principalType, principal, permission)
}

describe('listAvailability', () => {
  it('blocks a booking whose event calendar is not readable, with exactly the allowed keys', async () => {
    book(roomId, owner, 9, 10, { status: 'approved', path: workPath() })
    const { resources } = await listAvailability(db, bob, RANGE)
    const [entry] = resources[0]?.entries ?? []
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['blocked', 'bookingId', 'end', 'mine', 'start', 'status'].sort(),
    )
    expect(entry).toMatchObject({ blocked: true, mine: false, status: 'approved' })
  })

  it('blocks a booking from an own calendar nobody else can read', async () => {
    book(roomId, owner, 9, 10, { status: 'approved', path: `/${owner.sub}/not-discovered/` })
    const [entry] = (await listAvailability(db, bob, RANGE)).resources[0]?.entries ?? []
    expect(entry?.blocked).toBe(true)
    expect(entry).not.toHaveProperty('eventUid')
  })

  it('gives details to a reader of the event calendar', async () => {
    share('read')
    book(roomId, owner, 9, 10, { status: 'approved', path: workPath(), uid: 'meeting' })
    const [entry] = (await listAvailability(db, bob, RANGE)).resources[0]?.entries ?? []
    expect(entry).toMatchObject({
      blocked: false,
      mine: false,
      requesterName: 'owner Name',
      eventUid: 'meeting',
    })
  })

  it('gives details to a reader through a group', async () => {
    share('read', 'group', 'readers')
    book(roomId, owner, 9, 10, { status: 'approved', path: workPath() })
    const reader = { ...bob, groups: ['readers'] }
    expect((await listAvailability(db, reader, RANGE)).resources[0]?.entries[0]?.blocked).toBe(
      false,
    )
    expect((await listAvailability(db, bob, RANGE)).resources[0]?.entries[0]?.blocked).toBe(true)
  })

  it('gives details to a reader of the calendar a booking was made from as a share', async () => {
    share('read')
    book(roomId, alice, 9, 10, {
      status: 'approved',
      path: `/${alice.sub}/shared-${calendarId}/`,
      uid: 'meeting',
    })
    const [entry] = (await listAvailability(db, bob, RANGE)).resources[0]?.entries ?? []
    expect(entry).toMatchObject({ blocked: false, mine: false, eventUid: 'meeting' })
  })

  it('blocks a share booking for someone who cannot read that calendar', async () => {
    book(roomId, alice, 9, 10, { status: 'approved', path: `/${alice.sub}/shared-${calendarId}/` })
    expect((await listAvailability(db, bob, RANGE)).resources[0]?.entries[0]?.blocked).toBe(true)
  })

  it('blocks a booking from a share that names no calendar', async () => {
    share('read')
    book(roomId, alice, 9, 10, { status: 'approved', path: `/${alice.sub}/shared-9999/` })
    expect((await listAvailability(db, bob, RANGE)).resources[0]?.entries[0]?.blocked).toBe(true)
  })

  it('keeps a free/busy grant blocked', async () => {
    share('free_busy')
    book(roomId, owner, 9, 10, { status: 'approved', path: workPath() })
    expect((await listAvailability(db, bob, RANGE)).resources[0]?.entries[0]?.blocked).toBe(true)
  })

  it('keeps a free/busy grant blocked for a booking made from the share too', async () => {
    share('free_busy')
    book(roomId, alice, 9, 10, { status: 'approved', path: `/${alice.sub}/shared-${calendarId}/` })
    expect((await listAvailability(db, bob, RANGE)).resources[0]?.entries[0]?.blocked).toBe(true)
  })

  it('shows the caller their own booking in detail, whatever the calendar', async () => {
    book(roomId, bob, 9, 10, {
      status: 'pending',
      path: `/${bob.sub}/not-discovered/`,
      uid: 'mine',
    })
    const [entry] = (await listAvailability(db, bob, RANGE)).resources[0]?.entries ?? []
    expect(entry).toMatchObject({
      blocked: false,
      mine: true,
      status: 'pending',
      eventUid: 'mine',
      requesterName: 'bob Name',
    })
  })

  it('lists only readable resources', async () => {
    book(hiddenId, owner, 9, 10, { status: 'approved' })
    const bobs = await listAvailability(db, bob, RANGE)
    expect(bobs.resources.map((r) => r.resourceId)).toEqual([roomId])
    const asked = await listAvailability(db, bob, { ...RANGE, resourceIds: [hiddenId] })
    expect(asked.resources).toEqual([])
    const managers = await listAvailability(db, manager, RANGE)
    expect(managers.resources.map((r) => r.resourceId).sort()).toEqual([roomId, hiddenId].sort())
  })

  it('leaves out declined and cancelled bookings and bookings outside the range', async () => {
    book(roomId, alice, 9, 10, { status: 'declined' })
    book(roomId, alice, 10, 11, { status: 'cancelled' })
    book(roomId, alice, 11, 12, { status: 'approved' })
    book(roomId, alice, 12, 13, { status: 'pending' })
    const range = { ...RANGE, from: at(11), to: at(13) }
    const entries = (await listAvailability(db, bob, range)).resources[0]?.entries ?? []
    expect(entries.map((e) => e.status)).toEqual(['approved', 'pending'])
    const narrow = { ...RANGE, from: at(12), to: at(13) }
    expect((await listAvailability(db, bob, narrow)).resources[0]?.entries).toHaveLength(1)
  })
})

describe('parseAvailabilityQuery', () => {
  const ok = { from: '2026-12-01T00:00:00Z', to: '2026-12-02T00:00:00+01:00' }

  it('normalizes the times and reads the ids', () => {
    expect(parseAvailabilityQuery({ ...ok, resource: '3,1,3' })).toEqual({
      ok: true,
      value: {
        from: '2026-12-01T00:00:00.000Z',
        to: '2026-12-01T23:00:00.000Z',
        resourceIds: [1, 3],
      },
    })
  })

  it('refuses a range over the cap, an empty range and bad times', () => {
    const over = new Date(Date.parse(ok.from) + (MAX_AVAILABILITY_RANGE_DAYS * 86_400_000 + 1))
    expect(parseAvailabilityQuery({ from: ok.from, to: over.toISOString() }).ok).toBe(false)
    const edge = new Date(Date.parse(ok.from) + MAX_AVAILABILITY_RANGE_DAYS * 86_400_000)
    expect(parseAvailabilityQuery({ from: ok.from, to: edge.toISOString() }).ok).toBe(true)
    expect(parseAvailabilityQuery({ from: ok.to, to: ok.from }).ok).toBe(false)
    expect(parseAvailabilityQuery({ from: 'yesterday', to: ok.to }).ok).toBe(false)
    expect(parseAvailabilityQuery({ from: ok.from }).ok).toBe(false)
    expect(parseAvailabilityQuery({ from: '2026-12-01', to: ok.to }).ok).toBe(false)
  })

  it('refuses bad or too many resource ids', () => {
    expect(parseAvailabilityQuery({ ...ok, resource: '1,x' }).ok).toBe(false)
    expect(parseAvailabilityQuery({ ...ok, resource: '0' }).ok).toBe(false)
    expect(parseAvailabilityQuery({ ...ok, resource: ['1', '2'] }).ok).toBe(false)
    const many = Array.from({ length: 51 }, (_, i) => i + 1).join(',')
    expect(parseAvailabilityQuery({ ...ok, resource: many }).ok).toBe(false)
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1).join(',')
    expect(parseAvailabilityQuery({ ...ok, resource: fifty }).ok).toBe(true)
  })
})

describe('listBookingRequests', () => {
  it('is empty for everybody but managers', () => {
    book(roomId, alice, 9, 10)
    expect(listBookingRequests(db, bob)).toEqual({ requests: [] })
    expect(listBookingRequests(db, alice)).toEqual({ requests: [] })
  })

  it('lists pending bookings oldest first with the overlapping pending ids', () => {
    const late = book(roomId, bob, 9, 11, { createdAt: '2026-11-21T10:00:00.000Z' })
    const early = book(roomId, alice, 10, 12, { createdAt: '2026-11-20T10:00:00.000Z' })
    const apart = book(roomId, alice, 14, 15, { createdAt: '2026-11-22T10:00:00.000Z' })
    book(roomId, alice, 9, 10, { status: 'approved' })
    book(roomId, alice, 16, 17, { status: 'declined' })
    const { requests } = listBookingRequests(db, manager)
    expect(requests.map((r) => r.bookingId)).toEqual([early, late, apart])
    expect(requests[0]).toMatchObject({
      resourceId: roomId,
      resourceName: 'Room',
      requesterName: 'alice Name',
      orphanedAt: null,
      overlappingPendingIds: [late],
    })
    expect(requests[1]?.overlappingPendingIds).toEqual([early])
    expect(requests[2]?.overlappingPendingIds).toEqual([])
  })

  it('includes orphaned pending and approved bookings, not orphaned declined ones', () => {
    const orphanedAt = '2026-11-25T10:00:00.000Z'
    const approved = book(roomId, alice, 9, 10, { status: 'approved', orphanedAt })
    const pending = book(roomId, alice, 11, 12, { orphanedAt })
    book(roomId, alice, 13, 14, { status: 'cancelled', orphanedAt })
    const ids = listBookingRequests(db, manager).requests.map((r) => r.bookingId)
    expect(ids.sort()).toEqual([approved, pending].sort())
  })
})

describe('listBookingUpdates', () => {
  const since = '2026-11-25T00:00:00.000Z'

  it('lists own decided or cancelled bookings changed after since', () => {
    const declined = book(roomId, alice, 9, 10, {
      status: 'declined',
      decidedAt: '2026-11-26T10:00:00.000Z',
    })
    const approved = book(roomId, alice, 10, 11, {
      status: 'approved',
      decidedAt: '2026-11-27T10:00:00.000Z',
    })
    book(roomId, alice, 11, 12, { status: 'approved', decidedAt: '2026-11-24T10:00:00.000Z' })
    book(roomId, alice, 12, 13, { status: 'pending' })
    book(roomId, bob, 13, 14, { status: 'approved', decidedAt: '2026-11-26T10:00:00.000Z' })
    const { updates } = listBookingUpdates(db, alice, since)
    expect(updates.map((u) => [u.bookingId, u.status, u.reason])).toEqual([
      [declined, 'declined', 'decision'],
      [approved, 'approved', 'decision'],
    ])
    expect(updates[0]).toMatchObject({
      resourceName: 'Room',
      decidedAt: '2026-11-26T10:00:00.000Z',
    })
  })

  it('falls back to updated_at when there is no decision time', () => {
    const id = book(roomId, alice, 9, 10, { status: 'cancelled' })
    const row = db.prepare('SELECT updated_at FROM calendar_bookings WHERE id = ?').get(id) as {
      updated_at: string
    }
    expect(listBookingUpdates(db, alice, row.updated_at).updates).toEqual([])
    const before = '2020-01-01T00:00:00.000Z'
    const [update] = listBookingUpdates(db, alice, before).updates
    expect(update).toMatchObject({ bookingId: id, status: 'cancelled', decidedAt: row.updated_at })
  })

  it('takes the reason from the audit log when one was recorded', () => {
    const id = book(roomId, alice, 9, 10, {
      status: 'declined',
      decidedAt: '2026-11-26T10:00:00.000Z',
    })
    recordAudit(db, {
      actorSub: manager.sub,
      action: 'resource_booking.declined',
      target: `booking:${id}`,
      details: { reason: 'overlap', automatic: true },
    })
    expect(listBookingUpdates(db, alice, since).updates[0]?.reason).toBe('overlap')
  })
})
