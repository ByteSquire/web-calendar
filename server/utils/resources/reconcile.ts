// Keeps bookings and their events in step when someone moves or deletes the event (design §5
// "Reconcile on move/delete", security review 7.4). The database is the truth: a changed or
// unreadable event never cancels a booking by itself. Only an event that is definitively gone
// (calendar read, UID absent everywhere in the booker's home, or the calendar is gone), seen on
// repeated runs, cancels it. Everything else becomes an orphaned booking for the manager queue.
import type { Database } from 'better-sqlite3'
import { readCalendarObject } from '../../../app/utils/ical/read'
import { recordAudit } from '../../db/audit-log'
import { getSyncStamp, setSyncStamp } from '../../db/booking-sync'
import {
  clearBookingOrphaned,
  listBookingsInRange,
  markBookingOrphaned,
  setBookingEvent,
  transitionBooking,
} from '../../db/bookings'
import type { BookingRow } from '../../db/types'
import type { BlockStore } from './block'
import type { BookingEventReader } from './reconcile-reader'
import { syncBlock } from './service'

export const RECONCILE_ACTOR = 'system:resources'
/** Looks (failed or "gone") before a booking is cancelled or left to the manager queue. */
export const DEFAULT_MAX_ATTEMPTS = 3
/** A booking this young may not have its X-WEB-CALENDAR-* marks written yet. */
const MARK_GRACE_MS = 10 * 60_000
const MAX_CALENDARS_SEARCHED = 20
const DAY_MS = 24 * 60 * 60 * 1000

export interface BookingReconcilerOptions {
  db: Database
  reader: BookingEventReader
  store: BlockStore
  now?: () => Date
  log?: (message: string) => void
  maxAttempts?: number
}

export interface BookingReconcileSummary {
  skipped: boolean
  looked: number
  unchanged: number
  orphaned: number
  moved: number
  cancelled: number
  /** Calendars whose stamp matched the stored one, so no event was read. */
  gated: number
}

type Outcome = 'unchanged' | 'moved' | 'gone' | 'unreadable' | 'wait'

interface CalendarInfo {
  id: number
  collection_path: string
  owner_id: number | null
  owner_sub: string | null
}

export interface BookingReconciler {
  run(): Promise<BookingReconcileSummary>
}

const emptySummary = (skipped: boolean): BookingReconcileSummary => ({
  skipped,
  looked: 0,
  unchanged: 0,
  orphaned: 0,
  moved: 0,
  cancelled: 0,
  gated: 0,
})

/** Does the event of this object still hold the booking's slot and marks? */
function matchEvent(booking: BookingRow, objects: string[], created: Date, now: Date): Outcome {
  const from = new Date(Date.parse(booking.start_at) - DAY_MS)
  const to = new Date(Date.parse(booking.end_at) + DAY_MS)
  const uidLine = `UID:${booking.event_uid}`
  const present = objects.some((ics) =>
    ics
      .replace(/\r?\n[ \t]/g, '')
      .split(/\r?\n/)
      .some((line) => line.replace(/^UID;[^:]*:/, 'UID:') === uidLine),
  )
  // The query matches substrings; without the exact UID the event is not there.
  if (!present) return 'gone'
  for (const ics of objects) {
    const read = readCalendarObject(ics, {
      calendarId: String(booking.event_calendar_id),
      href: '/',
      displayTimeZone: 'UTC',
      orgTimeZone: 'UTC',
      range: { start: from, end: to },
      trustBookingProperties: true,
    })
    for (const event of read.events) {
      if (event.uid !== booking.event_uid) continue
      if (
        event.allDay ||
        Date.parse(`${event.start}Z`) !== Date.parse(booking.start_at) ||
        Date.parse(`${event.end}Z`) !== Date.parse(booking.end_at)
      ) {
        continue
      }
      const marks = event.bookingMarks
      const marksOk =
        marks !== undefined &&
        marks.resourceId === booking.resource_id &&
        (marks.bookingId === undefined || marks.bookingId === booking.id)
      if (marksOk) return 'unchanged'
      // Part 2 writes the marks after the server accepted the booking.
      if (now.getTime() - created.getTime() < MARK_GRACE_MS) return 'wait'
      return 'moved'
    }
  }
  // The event exists but no occurrence has the booked slot (or it cannot be read).
  return 'moved'
}

export function createBookingReconciler(options: BookingReconcilerOptions): BookingReconciler {
  const { db, reader, store } = options
  const clock = options.now ?? (() => new Date())
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const log = options.log ?? ((message: string) => console.warn(message))
  let running = false

  const calendarOf = (id: number): CalendarInfo | undefined =>
    db
      .prepare<[number], CalendarInfo>(
        `SELECT c.id, c.collection_path, c.owner_id, u.oidc_sub AS owner_sub
         FROM calendars c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`,
      )
      .get(id)

  function audit(booking: BookingRow, action: string, details: Record<string, unknown>): void {
    recordAudit(db, {
      actorSub: RECONCILE_ACTOR,
      action,
      target: `booking:${booking.id}`,
      details: { bookingId: booking.id, resourceId: booking.resource_id, ...details },
    })
  }

  /** Marks the booking orphaned; audits only the first time. Returns the attempts so far. */
  function orphan(booking: BookingRow, reason: string, now: Date): number {
    const row = markBookingOrphaned(db, booking.id, now)
    if (booking.orphaned_at === null) audit(booking, 'resource_booking.orphaned', { reason })
    return row?.reconcile_attempts ?? booking.reconcile_attempts + 1
  }

  async function cancel(booking: BookingRow, now: Date): Promise<void> {
    const cancelled = db.transaction(() => {
      const result = transitionBooking(db, booking.id, 'cancelled', null, now)
      if (!result.ok) return null
      audit(result.booking, 'resource_booking.cancelled', { reason: 'event_removed' })
      return result.booking
    })()
    if (cancelled) {
      await syncBlock({ db, store, now: clock, log }, cancelled, { actorSub: RECONCILE_ACTOR })
    }
  }

  /** The UID is absent from its calendar: look for it elsewhere in the booker's home. */
  async function searchElsewhere(
    booking: BookingRow,
    principal: string,
    ownPath: string,
    now: Date,
  ): Promise<Outcome> {
    const listed = await reader.listCalendars(principal)
    if (listed.kind !== 'ok') return 'unreadable'
    const others = listed.paths.filter((path) => path !== ownPath)
    if (others.length > MAX_CALENDARS_SEARCHED) return 'unreadable'
    for (const path of others) {
      const found = await reader.findEvent(principal, path, booking.event_uid)
      if (found.kind === 'error') return 'unreadable'
      if (found.kind !== 'found') continue
      const outcome = matchEvent(booking, found.objects, new Date(booking.created_at), now)
      if (outcome === 'gone') continue
      const target = db
        .prepare<[string, number], { id: number }>(
          'SELECT id FROM calendars WHERE collection_path = ? AND owner_id = ?',
        )
        .get(path, booking.requester_id)
      if (outcome === 'unchanged' && target) {
        setBookingEvent(db, booking.id, target.id, booking.event_uid)
        return 'unchanged'
      }
      // Moved to a calendar the app cannot point at, or changed on the way: ambiguous.
      return outcome === 'unchanged' ? 'moved' : outcome
    }
    return 'gone'
  }

  async function lookAt(
    booking: BookingRow,
    calendar: CalendarInfo,
    principal: string,
    now: Date,
  ): Promise<Outcome> {
    const found = await reader.findEvent(principal, calendar.collection_path, booking.event_uid)
    if (found.kind === 'error') return 'unreadable'
    if (found.kind === 'gone') return 'gone'
    if (found.kind === 'absent') {
      return searchElsewhere(booking, principal, calendar.collection_path, now)
    }
    const outcome = matchEvent(booking, found.objects, new Date(booking.created_at), now)
    return outcome === 'gone'
      ? searchElsewhere(booking, principal, calendar.collection_path, now)
      : outcome
  }

  /** Applies the outcome; true when the booking needs no further look. */
  async function apply(
    booking: BookingRow,
    outcome: Outcome,
    summary: BookingReconcileSummary,
    now: Date,
  ): Promise<boolean> {
    if (outcome === 'wait') return false
    if (outcome === 'unchanged') {
      if (booking.orphaned_at !== null || booking.reconcile_attempts > 0) {
        clearBookingOrphaned(db, booking.id)
      }
      summary.unchanged++
      return true
    }
    if (outcome === 'moved') {
      // Ambiguous: straight to the manager queue, never an automatic cancel.
      if (booking.reconcile_attempts >= maxAttempts) return true
      let attempts = booking.reconcile_attempts
      while (attempts < maxAttempts) {
        attempts = markBookingOrphaned(db, booking.id, now)?.reconcile_attempts ?? maxAttempts
      }
      audit(booking, 'resource_booking.orphaned', { reason: 'event_moved' })
      summary.moved++
      summary.orphaned++
      return true
    }
    if (outcome === 'unreadable') {
      if (booking.reconcile_attempts < maxAttempts) {
        orphan(booking, 'event_unreadable', now)
        summary.orphaned++
      }
      return false
    }
    // gone
    const attempts = orphan(booking, 'event_missing', now)
    if (attempts >= maxAttempts) {
      await cancel(booking, now)
      summary.cancelled++
      return true
    }
    summary.orphaned++
    return false
  }

  async function runOnce(): Promise<BookingReconcileSummary> {
    const now = clock()
    const summary = emptySummary(false)
    const active = listBookingsInRange(db, { from: now.toISOString() }, ['pending', 'approved'])
    const byCalendar = new Map<number, BookingRow[]>()
    for (const booking of active) {
      // No calendar: the event is not saved yet, or its calendar was deleted; not decidable here.
      if (booking.event_calendar_id === null) continue
      const list = byCalendar.get(booking.event_calendar_id) ?? []
      list.push(booking)
      byCalendar.set(booking.event_calendar_id, list)
    }
    for (const [calendarId, bookings] of [...byCalendar].sort((a, b) => a[0] - b[0])) {
      const calendar = calendarOf(calendarId)
      if (!calendar || calendar.owner_sub === null) continue
      const principal = calendar.owner_sub
      const mine = bookings.filter((booking) => booking.requester_id === calendar.owner_id)
      if (mine.length === 0) continue
      const stamp = await reader.stamp(principal, calendar.collection_path)
      if (stamp.kind === 'error') {
        for (const booking of mine) await apply(booking, 'unreadable', summary, now)
        continue
      }
      if (stamp.kind === 'gone') {
        for (const booking of mine) await apply(booking, 'gone', summary, now)
        continue
      }
      const retrying = mine.some(
        (booking) => booking.orphaned_at !== null && booking.reconcile_attempts < maxAttempts,
      )
      if (!retrying && stamp.stamp !== '' && getSyncStamp(db, calendarId) === stamp.stamp) {
        summary.gated++
        continue
      }
      let resolved = true
      for (const booking of mine) {
        summary.looked++
        const outcome = await lookAt(booking, calendar, principal, now)
        if (!(await apply(booking, outcome, summary, now))) resolved = false
      }
      if (resolved && stamp.stamp !== '') setSyncStamp(db, calendarId, stamp.stamp, now)
    }
    return summary
  }

  return {
    async run() {
      if (running) return emptySummary(true)
      running = true
      try {
        return await runOnce()
      } finally {
        running = false
      }
    },
  }
}
