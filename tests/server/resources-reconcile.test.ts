// @vitest-environment node
// Reconcile of bookings whose event moved or was deleted (design §5, security review 7.4).
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { getSyncStamp, setSyncStamp } from '../../server/db/booking-sync'
import { approveBooking, createBooking, getBooking } from '../../server/db/bookings'
import { createResource } from '../../server/db/resources'
import type { BookingRow } from '../../server/db/types'
import { blockPath, type BlockStore } from '../../server/utils/resources/block'
import { createBookingReconciler } from '../../server/utils/resources/reconcile'
import type {
  BookingEventReader,
  CalendarList,
  CalendarStamp,
  EventLookup,
} from '../../server/utils/resources/reconcile-reader'
import { createUsers, openTestDb } from './api-fixtures'

const NOW = new Date('2026-11-01T08:00:00.000Z')
const START = '2026-11-05T09:00:00.000Z'
const END = '2026-11-05T10:00:00.000Z'
const WORK = '/sub-alice/work/'
const OTHER = '/sub-alice/other/'

interface FakeCalendar {
  stamp: string
  /** uid -> ics */
  events: Map<string, string>
  unreadable: boolean
  /** The requester may not read it (403). */
  forbidden: boolean
}

function ics(options: {
  uid: string
  start?: string
  end?: string
  marks?: { resource: number; booking: number } | null
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    `UID:${options.uid}`,
    'DTSTAMP:20261101T080000Z',
    `DTSTART:${options.start ?? '20261105T090000Z'}`,
    `DTEND:${options.end ?? '20261105T100000Z'}`,
    'SUMMARY:Meeting',
    ...(options.marks
      ? [
          `X-WEB-CALENDAR-RESOURCE:res:${options.marks.resource}`,
          `X-WEB-CALENDAR-BOOKING:${options.marks.booking}`,
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

class FakeReader implements BookingEventReader {
  calendars = new Map<string, FakeCalendar>()
  /** Fails the home listing. */
  listFails = false
  stampCalls = 0
  findCalls: string[] = []
  concurrent = 0
  maxConcurrent = 0
  delayMs = 0

  add(path: string, stamp = 'c1'): FakeCalendar {
    const calendar: FakeCalendar = { stamp, events: new Map(), unreadable: false, forbidden: false }
    this.calendars.set(path, calendar)
    return calendar
  }

  async stamp(_principal: string, path: string): Promise<CalendarStamp> {
    this.stampCalls++
    const calendar = this.calendars.get(path)
    if (!calendar) return { kind: 'no_collection' }
    if (calendar.forbidden) return { kind: 'forbidden' }
    if (calendar.unreadable) return { kind: 'error' }
    return { kind: 'ok', stamp: calendar.stamp }
  }

  async findEvent(_principal: string, path: string, uid: string): Promise<EventLookup> {
    this.findCalls.push(path)
    this.concurrent++
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    this.concurrent--
    const calendar = this.calendars.get(path)
    if (!calendar) return { kind: 'no_collection' }
    if (calendar.forbidden) return { kind: 'forbidden' }
    if (calendar.unreadable) return { kind: 'error' }
    const objects = [...calendar.events.entries()]
      .filter(([key]) => key.includes(uid))
      .map(([, text]) => text)
    return objects.length === 0 ? { kind: 'absent' } : { kind: 'found', objects }
  }

  async listCalendars(): Promise<CalendarList> {
    if (this.listFails) return { kind: 'error' }
    return { kind: 'ok', paths: [...this.calendars.keys()].sort() }
  }
}

let db: Database
let reader: FakeReader
let puts: Map<string, string>
let deletes: string[]
let aliceId: number
let resourceId: number
let now: Date

const store: BlockStore = {
  async put(path, text) {
    puts.set(path, text)
  },
  async delete(path) {
    puts.delete(path)
    deletes.push(path)
  },
}

const reconciler = (maxAttempts?: number) =>
  createBookingReconciler({ db, reader, store, now: () => now, log: () => undefined, maxAttempts })

function book(
  uid = 'ev-1',
  options: { approve?: boolean; path?: string; requesterId?: number } = {},
): BookingRow {
  const result = createBooking(
    db,
    {
      resourceId,
      requesterId: options.requesterId ?? aliceId,
      startAt: START,
      endAt: END,
      eventCalendarPath: options.path ?? WORK,
      eventUid: uid,
    },
    { now: NOW },
  )
  if (!result.ok) throw new Error(result.code)
  // Old enough that the marks of part 2 are expected.
  db.prepare(
    "UPDATE calendar_bookings SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?",
  ).run(result.booking.id)
  if (options.approve) approveBooking(db, result.booking.id, aliceId, NOW)
  return getBooking(db, result.booking.id)!
}

const marked = (booking: BookingRow, uid = 'ev-1') =>
  ics({ uid, marks: { resource: resourceId, booking: booking.id } })

const auditRows = () =>
  listAuditEntries(db, { limit: 200 })
    .reverse()
    .filter((row) => row.action.startsWith('resource_booking.'))
    .map((row) => ({
      action: row.action,
      actor: row.actor_sub,
      details: JSON.parse(row.details ?? '{}'),
    }))

beforeEach(() => {
  db = openTestDb()
  aliceId = createUsers(db).alice
  resourceId = createResource(db, {
    name: 'Room 1',
    type: 'room',
    location: null,
    capacity: 8,
    description: null,
  }).id
  reader = new FakeReader()
  reader.add(WORK)
  puts = new Map()
  deletes = []
  now = NOW
})

afterEach(() => {
  db.close()
})

describe('booking reconcile: unchanged', () => {
  it('clears the orphaned state when the event is back as booked', async () => {
    const booking = book()
    db.prepare(
      "UPDATE calendar_bookings SET orphaned_at = '2026-11-01T07:00:00.000Z', reconcile_attempts = 2 WHERE id = ?",
    ).run(booking.id)
    reader.calendars.get(WORK)!.events.set('ev-1', marked(booking))
    const summary = await reconciler().run()
    const row = getBooking(db, booking.id)!
    expect(row.orphaned_at).toBeNull()
    expect(row.reconcile_attempts).toBe(0)
    expect(row.status).toBe('pending')
    expect(summary.unchanged).toBe(1)
    expect(getSyncStamp(db, WORK)).toBe('c1')
  })

  it('does not judge a young booking whose marks may not be written yet', async () => {
    const booking = book()
    db.prepare('UPDATE calendar_bookings SET created_at = ? WHERE id = ?').run(
      new Date(NOW.getTime() - 60_000).toISOString(),
      booking.id,
    )
    reader.calendars.get(WORK)!.events.set('ev-1', ics({ uid: 'ev-1' }))
    await reconciler().run()
    expect(getBooking(db, booking.id)!.orphaned_at).toBeNull()
    expect(getSyncStamp(db, WORK)).toBeNull()
    expect(auditRows()).toEqual([])
  })
})

describe('booking reconcile: deleted event', () => {
  it('cancels only after the retries, removes the block and audits the reason', async () => {
    const booking = book('ev-1', { approve: true })
    const run = reconciler(3)
    await run.run()
    expect(getBooking(db, booking.id)).toMatchObject({ status: 'approved', reconcile_attempts: 1 })
    await run.run()
    expect(getBooking(db, booking.id)).toMatchObject({ status: 'approved', reconcile_attempts: 2 })
    expect(deletes).toEqual([])
    const summary = await run.run()
    expect(summary.cancelled).toBe(1)
    expect(getBooking(db, booking.id)!.status).toBe('cancelled')
    expect(deletes).toEqual([blockPath(booking.block_ref)])
    const rows = auditRows()
    expect(rows.map((row) => row.action)).toEqual([
      'resource_booking.orphaned',
      'resource_booking.cancelled',
    ])
    expect(rows[0]!.details).toMatchObject({ reason: 'event_missing', bookingId: booking.id })
    expect(rows[1]).toMatchObject({
      actor: 'system:resources',
      details: { reason: 'event_removed', bookingId: booking.id, resourceId },
    })
  })

  it('does not cancel when the calendar itself is gone, it goes to the manager queue', async () => {
    const booking = book()
    reader.calendars.delete(WORK)
    const run = reconciler(2)
    for (let i = 0; i < 4; i++) await run.run()
    expect(getBooking(db, booking.id)).toMatchObject({ status: 'pending', reconcile_attempts: 2 })
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
  })

  it('finds an event that moved to another calendar of the booker and follows it', async () => {
    const booking = book()
    reader.add(OTHER).events.set('ev-1', marked(booking))
    await reconciler().run()
    const row = getBooking(db, booking.id)!
    expect(row).toMatchObject({ status: 'pending', orphaned_at: null, event_calendar_path: OTHER })
  })

  it('follows an event that moved into a share and stores the share path', async () => {
    const booking = book()
    const share = '/sub-alice/shared-12/'
    reader.add(share).events.set('ev-1', marked(booking))
    await reconciler().run()
    expect(getBooking(db, booking.id)).toMatchObject({
      status: 'pending',
      orphaned_at: null,
      event_calendar_path: share,
    })
  })

  it('does not cancel when another calendar of the home may not be read', async () => {
    const booking = book('ev-1', { approve: true })
    reader.add(OTHER).forbidden = true
    const run = reconciler(2)
    for (let i = 0; i < 5; i++) await run.run()
    expect(getBooking(db, booking.id)!.status).toBe('approved')
    expect(deletes).toEqual([])
  })

  it('does not cancel when the rest of the home cannot be searched', async () => {
    const booking = book()
    reader.listFails = true
    const run = reconciler(2)
    for (let i = 0; i < 5; i++) await run.run()
    expect(getBooking(db, booking.id)!.status).toBe('pending')
  })
})

describe('booking reconcile: unreadable calendar', () => {
  it('never cancels, keeps the soft orphaned state and stops counting at the limit', async () => {
    const booking = book('ev-1', { approve: true })
    reader.calendars.get(WORK)!.unreadable = true
    const run = reconciler(3)
    for (let i = 0; i < 6; i++) await run.run()
    const row = getBooking(db, booking.id)!
    expect(row.status).toBe('approved')
    expect(row.orphaned_at).not.toBeNull()
    expect(row.reconcile_attempts).toBe(3)
    expect(deletes).toEqual([])
    expect(auditRows().map((r) => r.action)).toEqual(['resource_booking.orphaned'])
    expect(auditRows()[0]!.details).toMatchObject({ reason: 'event_unreadable' })
  })

  it('recovers when the calendar can be read again', async () => {
    const booking = book()
    const calendar = reader.calendars.get(WORK)!
    calendar.unreadable = true
    await reconciler().run()
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
    calendar.unreadable = false
    calendar.events.set('ev-1', marked(booking))
    await reconciler().run()
    expect(getBooking(db, booking.id)).toMatchObject({ orphaned_at: null, reconcile_attempts: 0 })
  })
})

describe('booking reconcile: calendar the requester cannot read', () => {
  it.each([
    ['forbidden', 'forbidden'],
    ['no_collection', 'missing'],
  ])(
    'sends a %s calendar to the manager queue in one run and never cancels',
    async (kind, cause) => {
      const booking = book('ev-1', { approve: true })
      setSyncStamp(db, WORK, 'c1', NOW)
      if (kind === 'forbidden') reader.calendars.get(WORK)!.forbidden = true
      else reader.calendars.delete(WORK)
      const run = reconciler(3)
      const summary = await run.run()
      expect(summary.lost).toBe(1)
      for (let i = 0; i < 4; i++) await run.run()
      const row = getBooking(db, booking.id)!
      expect(row.status).toBe('approved')
      expect(row.orphaned_at).not.toBeNull()
      expect(row.reconcile_attempts).toBe(3)
      expect(deletes).toEqual([])
      expect(getSyncStamp(db, WORK)).toBeNull()
      expect(auditRows()).toEqual([
        {
          action: 'resource_booking.orphaned',
          actor: 'system:resources',
          details: expect.objectContaining({
            reason: 'calendar_unavailable',
            cause,
            bookingId: booking.id,
          }),
        },
      ])
    },
  )

  it('does not read a path outside the home of the requester', async () => {
    const booking = book('ev-1', { path: '/sub-bob/work/' })
    reader.add('/sub-bob/work/').events.set('ev-1', marked(booking))
    const summary = await reconciler().run()
    expect(summary.lost).toBe(1)
    expect(reader.stampCalls).toBe(0)
    expect(reader.findCalls).toEqual([])
    expect(getBooking(db, booking.id)!.status).toBe('pending')
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
  })

  it('clears the orphaned state when the access comes back', async () => {
    const booking = book()
    const calendar = reader.calendars.get(WORK)!
    calendar.events.set('ev-1', marked(booking))
    calendar.forbidden = true
    await reconciler().run()
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
    calendar.forbidden = false
    await reconciler().run()
    expect(getBooking(db, booking.id)).toMatchObject({ orphaned_at: null, reconcile_attempts: 0 })
    expect(getSyncStamp(db, WORK)).toBe('c1')
  })
})

describe('booking reconcile: moved or stripped event', () => {
  it('flags a moved event for the manager queue and does not cancel', async () => {
    const booking = book('ev-1', { approve: true })
    reader.calendars.get(WORK)!.events.set(
      'ev-1',
      ics({
        uid: 'ev-1',
        start: '20261106T090000Z',
        end: '20261106T100000Z',
        marks: { resource: resourceId, booking: booking.id },
      }),
    )
    const run = reconciler(3)
    const summary = await run.run()
    expect(summary.moved).toBe(1)
    const row = getBooking(db, booking.id)!
    expect(row.status).toBe('approved')
    expect(row.orphaned_at).not.toBeNull()
    expect(row.reconcile_attempts).toBe(3)
    for (let i = 0; i < 3; i++) await run.run()
    expect(getBooking(db, booking.id)!.status).toBe('approved')
    expect(deletes).toEqual([])
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'resource_booking.orphaned',
      details: { reason: 'event_moved', bookingId: booking.id },
    })
  })

  it('flags a changed resource mark and does not cancel', async () => {
    const booking = book()
    reader.calendars
      .get(WORK)!
      .events.set(
        'ev-1',
        ics({ uid: 'ev-1', marks: { resource: resourceId + 1, booking: booking.id } }),
      )
    await reconciler().run()
    expect(getBooking(db, booking.id)).toMatchObject({ status: 'pending' })
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
  })

  it('does not cancel when a third party strips the X-WEB-CALENDAR properties', async () => {
    const booking = book('ev-1', { approve: true })
    reader.calendars.get(WORK)!.events.set('ev-1', ics({ uid: 'ev-1' }))
    const run = reconciler(2)
    for (let i = 0; i < 4; i++) await run.run()
    const row = getBooking(db, booking.id)!
    expect(row.status).toBe('approved')
    expect(row.orphaned_at).not.toBeNull()
    expect(deletes).toEqual([])
    expect(auditRows().map((r) => r.action)).toEqual(['resource_booking.orphaned'])
    expect(auditRows()[0]!.details).toMatchObject({ reason: 'event_moved' })
  })
})

describe('booking reconcile: ctag gate', () => {
  it('reads no event while the stamp is unchanged, and reads again when it changes', async () => {
    const booking = book()
    const calendar = reader.calendars.get(WORK)!
    calendar.events.set('ev-1', marked(booking))
    const run = reconciler()
    await run.run()
    expect(reader.findCalls).toHaveLength(1)
    const second = await run.run()
    expect(second.gated).toBe(1)
    expect(reader.findCalls).toHaveLength(1)
    expect(reader.stampCalls).toBe(2)
    calendar.stamp = 'c2'
    calendar.events.clear()
    await run.run()
    expect(reader.findCalls.length).toBeGreaterThan(1)
    expect(getBooking(db, booking.id)!.orphaned_at).not.toBeNull()
  })

  it('looks at no calendar for ended or settled bookings', async () => {
    const booking = book()
    db.prepare('UPDATE calendar_bookings SET status = ? WHERE id = ?').run('declined', booking.id)
    await reconciler().run()
    expect(reader.stampCalls).toBe(0)
    now = new Date('2026-12-01T00:00:00.000Z')
    const second = book('ev-2')
    db.prepare("UPDATE calendar_bookings SET status = 'cancelled' WHERE id = ?").run(second.id)
    await reconciler().run()
    expect(reader.stampCalls).toBe(0)
  })
})

describe('booking reconcile: stored stamps', () => {
  it('forgets the stamp of a path that has no active booking any more', async () => {
    book()
    setSyncStamp(db, '/sub-alice/old/', 'x', NOW)
    setSyncStamp(db, WORK, 'y', NOW)
    await reconciler().run()
    expect(getSyncStamp(db, '/sub-alice/old/')).toBeNull()
    expect(getSyncStamp(db, WORK)).not.toBeNull()
  })

  it('keeps the stamps of two calendars apart', async () => {
    const first = book('ev-1')
    const second = book('ev-2', { path: OTHER })
    reader.calendars.get(WORK)!.events.set('ev-1', marked(first))
    reader.add(OTHER, 'o1').events.set('ev-2', marked(second, 'ev-2'))
    await reconciler().run()
    expect(getSyncStamp(db, WORK)).toBe('c1')
    expect(getSyncStamp(db, OTHER)).toBe('o1')
  })
})

describe('booking reconcile: runs', () => {
  it('does not overlap two runs', async () => {
    const booking = book()
    reader.calendars.get(WORK)!.events.set('ev-1', marked(booking))
    reader.delayMs = 20
    const run = reconciler()
    const [first, second] = await Promise.all([run.run(), run.run()])
    expect([first.skipped, second.skipped].sort()).toEqual([false, true])
    expect(reader.maxConcurrent).toBe(1)
    expect(reader.findCalls).toHaveLength(1)
    // And it can run again afterwards.
    expect((await run.run()).skipped).toBe(false)
  })
})
