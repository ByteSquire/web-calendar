// @vitest-environment node
// Bookings of resources (security review 7.4): rights, limits, approval, audit and the blocks.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { getBooking } from '../../server/db/bookings'
import { addResourceAcl } from '../../server/db/resource-acl'
import { createResource, deactivateResource } from '../../server/db/resources'
import type { BookingRow, ResourceRow } from '../../server/db/types'
import {
  AVAILABILITY_COLLECTION,
  blockPath,
  type BlockStore,
} from '../../server/utils/resources/block'
import {
  acceptBooking,
  cancelBooking,
  declineBooking,
  listBookingsFor,
  listResourcesFor,
  repairBlocks,
  requestBooking,
  syncBlock,
  type Actor,
  type NewBookingRequest,
  type ServiceDeps,
} from '../../server/utils/resources/service'
import { createUsers, openTestDb } from './api-fixtures'

const NOW = new Date('2026-11-01T08:00:00.000Z')

let db: Database
let resource: ResourceRow
let alice: Actor
let bob: Actor
let manager: Actor
let puts: Map<string, string>
let deletes: string[]
let failing: boolean
let logs: string[]
let deps: ServiceDeps

function actor(id: number, sub: string, groups: string[] = []): Actor {
  return { id, sub, groups }
}

function slot(day: number, from = 9, to = 10, who: Actor = alice): NewBookingRequest {
  const at = (hour: number) =>
    `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
  return {
    resourceId: resource.id,
    startAt: at(from),
    endAt: at(to),
    eventCalendarPath: `/${who.sub}/work/`,
    eventUid: `uid-${day}-${from}`,
  }
}

async function book(who: Actor, input: NewBookingRequest): Promise<BookingRow> {
  const result = await requestBooking(deps, who, input)
  if (!result.ok) throw new Error(`booking refused: ${result.code}`)
  return result.booking
}

beforeEach(() => {
  db = openTestDb()
  const { alice: a, bob: b } = createUsers(db)
  const m = (
    db.prepare("INSERT INTO users (oidc_sub) VALUES ('sub-manager') RETURNING id").get() as {
      id: number
    }
  ).id
  alice = actor(a, 'sub-alice')
  bob = actor(b, 'sub-bob')
  manager = actor(m, 'sub-manager', ['facility'])
  resource = createResource(db, {
    name: 'Room 1',
    type: 'room',
    location: null,
    capacity: 8,
    description: null,
  })
  addResourceAcl(db, resource.id, {
    principalType: 'group',
    principal: 'facility',
    right: 'manage',
  })
  puts = new Map()
  deletes = []
  failing = false
  logs = []
  const store: BlockStore = {
    async put(path, ics) {
      if (failing) throw new Error('store down https://secret.example/token')
      puts.set(path, ics)
    },
    async delete(path) {
      if (failing) throw new Error('store down')
      puts.delete(path)
      deletes.push(path)
    },
  }
  deps = { db, store, now: () => NOW, log: (message) => logs.push(message), requestId: 'req-1' }
})

afterEach(() => {
  db.close()
})

const actions = () =>
  listAuditEntries(db, {})
    .map((entry) => entry.action)
    .reverse()

describe('requestBooking', () => {
  it('creates a pending booking, audits it and writes a tentative block', async () => {
    const booking = await book(alice, slot(5))
    expect(booking).toMatchObject({ status: 'pending', requester_id: alice.id })
    const [entry] = listAuditEntries(db, {})
    expect(entry).toMatchObject({
      actor_sub: 'sub-alice',
      action: 'resource_booking.created',
      target: `booking:${booking.id}`,
      request_id: 'req-1',
    })
    expect(JSON.parse(entry!.details!)).toEqual({ bookingId: booking.id, resourceId: resource.id })
    const ics = puts.get(blockPath(booking.block_ref))
    expect(ics).toContain('STATUS:TENTATIVE')
  })

  it('refuses a user who can only read', async () => {
    addResourceAcl(db, resource.id, {
      principalType: 'user',
      principal: 'sub-alice',
      right: 'read',
    })
    db.prepare("DELETE FROM resource_acl WHERE principal_type = 'authenticated'").run()
    const result = await requestBooking(deps, alice, slot(5))
    expect(result).toEqual({ ok: false, code: 'forbidden' })
    expect(puts.size).toBe(0)
    expect(actions()).toEqual([])
  })

  it('hides a resource the caller cannot read', async () => {
    db.prepare("DELETE FROM resource_acl WHERE principal_type = 'authenticated'").run()
    expect(await requestBooking(deps, bob, slot(5, 9, 10, bob))).toEqual({
      ok: false,
      code: 'not_found',
    })
    expect(listResourcesFor(db, bob)).toEqual([])
    expect(listResourcesFor(db, manager).map((view) => view.right)).toEqual(['manage'])
  })

  it('refuses a deactivated resource', async () => {
    deactivateResource(db, resource.id)
    expect(await requestBooking(deps, alice, slot(5))).toEqual({
      ok: false,
      code: 'resource_unavailable',
    })
  })

  it('applies the limits', async () => {
    const limited = { ...deps, limits: { maxDurationMs: 2 * 3600_000, maxPerRequesterPerDay: 2 } }
    const code = async (input: NewBookingRequest) => {
      const result = await requestBooking(limited, alice, input)
      return result.ok ? 'ok' : result.code
    }
    expect(await code(slot(5, 9, 12))).toBe('too_long')
    expect(
      await code({ ...slot(5), startAt: '2026-10-31T09:00:00Z', endAt: '2026-10-31T10:00:00Z' }),
    ).toBe('in_past')
    expect(
      await code({ ...slot(5), startAt: '2028-01-01T09:00:00Z', endAt: '2028-01-01T10:00:00Z' }),
    ).toBe('too_far_ahead')
    expect(await code({ ...slot(5), endAt: '2026-11-05T08:00:00Z' })).toBe('invalid_slot')
    expect(await code(slot(5, 9, 10))).toBe('ok')
    expect(await code(slot(5, 10, 11))).toBe('ok')
    expect(await code(slot(5, 11, 12))).toBe('daily_limit')
  })

  it('refuses a slot that an approved booking holds', async () => {
    const first = await book(alice, slot(5))
    await acceptBooking(deps, manager, first.id)
    expect(await requestBooking(deps, bob, slot(5, 9, 11, bob))).toEqual({
      ok: false,
      code: 'overlap',
    })
  })

  describe('the calendar of the event', () => {
    function sharedCalendar(permission: string, principalType = 'user', principal = 'sub-alice') {
      const id = db
        .prepare(
          "INSERT INTO calendars (name, kind, owner_id, collection_path) VALUES ('c', 'personal', ?, '/sub-bob/c/') RETURNING id",
        )
        .pluck()
        .get(bob.id) as number
      db.prepare(
        'INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, ?, ?, ?)',
      ).run(id, principalType, principal, permission)
      return id
    }
    const from = (eventCalendarPath: string, day = 5) => ({ ...slot(day), eventCalendarPath })

    it('stores the path of an own calendar discovery has not seen yet, as given', async () => {
      const booking = await book(alice, from('/sub-alice/Büro new/'))
      expect(booking.event_calendar_path).toBe('/sub-alice/Büro new/')
    })

    it.each(['read', 'write'])(
      'accepts a share with %s access under its share name',
      async (permission) => {
        const id = sharedCalendar(permission)
        const booking = await book(alice, from(`/sub-alice/shared-${id}/`))
        expect(booking.event_calendar_path).toBe(`/sub-alice/shared-${id}/`)
      },
    )

    it('accepts a group share through the groups of the booker', async () => {
      const id = sharedCalendar('read', 'group', 'staff')
      const path = `/sub-alice/shared-${id}-staff/`
      expect(await requestBooking(deps, alice, from(path))).toEqual({
        ok: false,
        code: 'calendar_not_readable',
      })
      const member = { ...alice, groups: ['staff'] }
      expect((await book(member, from(path))).event_calendar_path).toBe(path)
    })

    it('refuses a share that only shows free/busy', async () => {
      const id = sharedCalendar('free_busy')
      expect(await requestBooking(deps, alice, from(`/sub-alice/shared-${id}/`))).toEqual({
        ok: false,
        code: 'calendar_not_readable',
      })
    })

    it('refuses a share nobody gave to the booker and one that does not exist', async () => {
      const id = sharedCalendar('read', 'user', 'sub-carol')
      for (const path of [`/sub-alice/shared-${id}/`, '/sub-alice/shared-999/']) {
        expect(await requestBooking(deps, alice, from(path))).toEqual({
          ok: false,
          code: 'calendar_not_readable',
        })
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_bookings').get()).toEqual({ n: 0 })
    })

    it('refuses a path in the home of somebody else', async () => {
      expect(await requestBooking(deps, alice, from('/sub-bob/c/'))).toEqual({
        ok: false,
        code: 'invalid_event',
      })
      expect(await requestBooking(deps, alice, from('/sub-alice-2/c/'))).toEqual({
        ok: false,
        code: 'invalid_event',
      })
    })

    it('answers not_found for a hidden resource before it looks at the calendar', async () => {
      db.prepare("DELETE FROM resource_acl WHERE principal_type = 'authenticated'").run()
      expect(await requestBooking(deps, bob, from('/sub-alice/c/'))).toEqual({
        ok: false,
        code: 'not_found',
      })
    })
  })
})

describe('the block', () => {
  it('holds nothing but the slot, the opaque marks and the fixed text', async () => {
    const booking = await book(alice, slot(5))
    await acceptBooking(deps, manager, booking.id)
    const ics = puts.get(`${AVAILABILITY_COLLECTION}${booking.block_ref}.ics`)!
    const lines = ics.split('\r\n').filter(Boolean)
    const event = lines.slice(lines.indexOf('BEGIN:VEVENT') + 1, lines.indexOf('END:VEVENT'))
    expect(event.map((line) => line.split(':')[0]).sort()).toEqual(
      [
        'CLASS',
        'DTEND',
        'DTSTAMP',
        'DTSTART',
        'SUMMARY',
        'TRANSP',
        'UID',
        'X-WEB-CALENDAR-BLOCK',
      ].sort(),
    )
    expect(event).toContain('SUMMARY:Reserved')
    expect(event).toContain('DTSTART:20261105T090000Z')
    for (const secret of [booking.event_uid, 'Room 1', 'alice', 'sub-alice']) {
      expect(ics).not.toContain(secret)
    }
    expect(ics).not.toContain('STATUS')
  })

  it('is removed when the booking is declined or cancelled', async () => {
    const one = await book(alice, slot(5))
    const two = await book(alice, slot(6))
    await declineBooking(deps, manager, one.id)
    await cancelBooking(deps, alice, two.id)
    expect(puts.size).toBe(0)
    expect(deletes.sort()).toEqual([blockPath(one.block_ref), blockPath(two.block_ref)].sort())
  })

  it('is rewritten as busy on approval', async () => {
    const booking = await book(alice, slot(5))
    await acceptBooking(deps, manager, booking.id)
    expect(puts.get(blockPath(booking.block_ref))).not.toContain('TENTATIVE')
  })
})

describe('who may change a booking', () => {
  it('lets another booker neither cancel, decline nor accept it, and the block stays', async () => {
    const booking = await book(alice, slot(5))
    for (const run of [cancelBooking, declineBooking, acceptBooking]) {
      expect(await run(deps, bob, booking.id)).toEqual({ ok: false, code: 'not_found' })
    }
    expect(deletes).toEqual([])
    expect(puts.has(blockPath(booking.block_ref))).toBe(true)
    expect(getBooking(db, booking.id)?.status).toBe('pending')
  })

  it('lets the requester cancel but not accept or decline', async () => {
    const booking = await book(alice, slot(5))
    expect(await acceptBooking(deps, alice, booking.id)).toEqual({ ok: false, code: 'forbidden' })
    expect(await declineBooking(deps, alice, booking.id)).toEqual({ ok: false, code: 'forbidden' })
    const result = await cancelBooking(deps, alice, booking.id)
    expect(result.ok && result.booking.status).toBe('cancelled')
  })

  it('lets a manager cancel and decline', async () => {
    const one = await book(alice, slot(5))
    const two = await book(alice, slot(6))
    expect((await cancelBooking(deps, manager, one.id)).ok).toBe(true)
    expect((await declineBooking(deps, manager, two.id)).ok).toBe(true)
    expect(actions()).toEqual([
      'resource_booking.created',
      'resource_booking.created',
      'resource_booking.cancelled',
      'resource_booking.declined',
    ])
  })

  it('stops a manager cancelling the booking of someone else when the setting is off', async () => {
    const strict: ServiceDeps = { ...deps, managerCancel: false }
    const one = await book(alice, slot(5))
    const two = await book(manager, slot(6, 9, 10, manager))
    expect(await cancelBooking(strict, manager, one.id)).toEqual({ ok: false, code: 'forbidden' })
    expect(getBooking(db, one.id)?.status).toBe('pending')
    // Declining is still the manager's decision, and nobody loses the right to cancel their own.
    expect((await declineBooking(strict, manager, one.id)).ok).toBe(true)
    expect((await cancelBooking(strict, alice, (await book(alice, slot(7))).id)).ok).toBe(true)
    expect((await cancelBooking(strict, manager, two.id)).ok).toBe(true)
  })

  it('does not change a final booking', async () => {
    const booking = await book(alice, slot(5))
    await cancelBooking(deps, alice, booking.id)
    expect(await cancelBooking(deps, alice, booking.id)).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
  })
})

describe('accepting', () => {
  it('declines the overlapping pending bookings, reports and audits them', async () => {
    const winner = await book(alice, slot(5, 9, 11))
    const loser = await book(bob, slot(5, 10, 12, bob))
    const apart = await book(bob, slot(5, 13, 14, bob))
    const result = await acceptBooking(deps, manager, winner.id)
    expect(result.ok && result.declined.map((b) => b.id)).toEqual([loser.id])
    expect(getBooking(db, loser.id)?.status).toBe('declined')
    expect(getBooking(db, apart.id)?.status).toBe('pending')
    expect(puts.has(blockPath(loser.block_ref))).toBe(false)
    const declined = listAuditEntries(db, {}).find(
      (entry) => entry.action === 'resource_booking.declined',
    )
    expect(declined).toMatchObject({ actor_sub: 'sub-manager', target: `booking:${loser.id}` })
    expect(actions()).toContain('resource_booking.approved')
  })

  it('gives two concurrent accepts of overlapping bookings one winner', async () => {
    const one = await book(alice, slot(5, 9, 11))
    const two = await book(bob, slot(5, 10, 12, bob))
    const results = await Promise.all([
      acceptBooking(deps, manager, one.id),
      acceptBooking(deps, manager, two.id),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const approved = [one.id, two.id].filter((id) => getBooking(db, id)?.status === 'approved')
    expect(approved).toHaveLength(1)
  })

  it('leaves the database to refuse a second approval of the same slot', async () => {
    const one = await book(alice, slot(5, 9, 11))
    const two = await book(bob, slot(5, 10, 12, bob))
    await acceptBooking(deps, manager, one.id)
    expect(await acceptBooking(deps, manager, two.id)).toMatchObject({ ok: false })
  })
})

describe('a failing block store', () => {
  it('keeps the booking, logs without the error text and audits the failure', async () => {
    failing = true
    const booking = await book(alice, slot(5))
    expect(getBooking(db, booking.id)?.status).toBe('pending')
    expect(logs.join('\n')).not.toContain('secret.example')
    expect(logs).toHaveLength(1)
    expect(actions()).toEqual(['resource_booking.created', 'resource_booking.block_failed'])
    const [failure] = listAuditEntries(db, {})
    expect(JSON.parse(failure!.details!)).toEqual({
      bookingId: booking.id,
      resourceId: resource.id,
      status: 'pending',
    })
  })

  it('is repaired by syncBlock and repairBlocks, which can run again', async () => {
    failing = true
    const booking = await book(alice, slot(5))
    const gone = await book(bob, slot(6, 9, 10, bob))
    await cancelBooking(deps, bob, gone.id)
    expect(puts.size).toBe(0)

    expect(await repairBlocks(deps)).toEqual({ synced: 0, failed: 2 })
    failing = false
    expect(await repairBlocks(deps)).toEqual({ synced: 2, failed: 0 })
    expect(await repairBlocks(deps)).toEqual({ synced: 2, failed: 0 })
    expect([...puts.keys()]).toEqual([blockPath(booking.block_ref)])
    expect(await syncBlock(deps, getBooking(db, booking.id)!)).toBe(true)
    expect(puts.size).toBe(1)
  })

  it('does not audit again for every repair run', async () => {
    failing = true
    await book(alice, slot(5))
    const before = listAuditEntries(db, {}).length
    await repairBlocks(deps)
    expect(listAuditEntries(db, {})).toHaveLength(before)
  })
})

describe('listBookingsFor', () => {
  it('gives a booker their own bookings and a manager all of them', async () => {
    const mine = await book(alice, slot(5))
    const theirs = await book(bob, slot(6, 9, 10, bob))
    expect(listBookingsFor(db, alice, resource.id)?.bookings.map((b) => b.id)).toEqual([mine.id])
    const all = listBookingsFor(db, manager, resource.id)
    expect(all?.manager).toBe(true)
    expect(all?.bookings.map((b) => b.id)).toEqual([mine.id, theirs.id])
  })

  it('is null for a resource the caller cannot read', () => {
    db.prepare("DELETE FROM resource_acl WHERE principal_type = 'authenticated'").run()
    expect(listBookingsFor(db, alice, resource.id)).toBeNull()
  })
})

describe('the default store', () => {
  it('logs and does not throw', async () => {
    const { createLoggingBlockStore } = await import('../../server/utils/resources/block')
    const log = vi.fn()
    const store = createLoggingBlockStore(log)
    await store.put('/_resources/availability/x.ics', 'x')
    await store.delete('/_resources/availability/x.ics')
    expect(log).toHaveBeenCalledTimes(2)
  })
})
