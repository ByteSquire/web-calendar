// Keeps bookings and their events in step when someone moves or deletes the event (design §5
// "Reconcile on move/delete", security review 7.4). The database is the truth: a changed or
// unreadable event never cancels a booking by itself. The calendar is read as the requester at the
// stored path (a share included). Only an event that is definitively gone (calendar readable, UID
// absent everywhere in the booker's home), seen on repeated runs, cancels it. A calendar the
// requester can no longer read (403, or 404 on the collection) is ambiguous, so it goes to the
// manager queue and is never cancelled. Everything else becomes an orphaned booking too.
import type { Database } from 'better-sqlite3'
import { readCalendarObject } from '../../../app/utils/ical/read'
import { recordAudit } from '../../db/audit-log'
import { clearSyncStamp, getSyncStamp, pruneSyncStamps, setSyncStamp } from '../../db/booking-sync'
import {
  clearBookingOrphaned,
  listBookingsInRange,
  markBookingOrphaned,
  setBookingEvent,
  transitionBooking,
} from '../../db/bookings'
import type { BookingRow } from '../../db/types'
import { splitCollectionPath } from '../sharing/names'
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
  /** Bookings whose calendar the requester can no longer read (sent to the manager queue). */
  lost: number
  cancelled: number
  /** Calendars whose stamp matched the stored one, so no event was read. */
  gated: number
}

type Verdict = 'unchanged' | 'moved' | 'gone' | 'unreadable' | 'wait'
interface Lost {
  lost: 'forbidden' | 'missing'
}
type Outcome = Verdict | Lost

const LOST_FORBIDDEN: Lost = { lost: 'forbidden' }
const LOST_MISSING: Lost = { lost: 'missing' }
/** The longest collection path the table accepts. */
const MAX_PATH_LENGTH = 500

export interface BookingReconciler {
  run(): Promise<BookingReconcileSummary>
}

const emptySummary = (skipped: boolean): BookingReconcileSummary => ({
  skipped,
  looked: 0,
  unchanged: 0,
  orphaned: 0,
  moved: 0,
  lost: 0,
  cancelled: 0,
  gated: 0,
})

/** Does the event of this object still hold the booking's slot and marks? */
function matchEvent(
  booking: BookingRow,
  objects: string[],
  created: Date,
  now: Date,
): Exclude<Verdict, 'unreadable'> {
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
      calendarId: booking.event_calendar_path,
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

  function subsOf(requesterIds: number[]): Map<number, string> {
    if (requesterIds.length === 0) return new Map()
    const marks = requesterIds.map(() => '?').join(', ')
    const rows = db
      .prepare<number[], { id: number; oidc_sub: string }>(
        `SELECT id, oidc_sub FROM users WHERE id IN (${marks})`,
      )
      .all(...requesterIds)
    return new Map(rows.map((row) => [row.id, row.oidc_sub]))
  }

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

  /** Straight to the manager queue: the attempts jump to the limit, so no further look counts. */
  function sendToManagers(booking: BookingRow, reason: string, extra: object, now: Date): void {
    let attempts = booking.reconcile_attempts
    while (attempts < maxAttempts) {
      attempts = markBookingOrphaned(db, booking.id, now)?.reconcile_attempts ?? maxAttempts
    }
    audit(booking, 'resource_booking.orphaned', { reason, ...extra })
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
      // Not being allowed to look is not the event being absent.
      if (found.kind === 'error' || found.kind === 'forbidden') return 'unreadable'
      if (found.kind !== 'found') continue
      const outcome = matchEvent(booking, found.objects, new Date(booking.created_at), now)
      if (outcome === 'gone') continue
      if (outcome === 'unchanged') {
        if (path.length > MAX_PATH_LENGTH) return 'moved'
        setBookingEvent(db, booking.id, path, booking.event_uid)
      }
      return outcome
    }
    return 'gone'
  }

  async function lookAt(booking: BookingRow, principal: string, now: Date): Promise<Outcome> {
    const path = booking.event_calendar_path
    const found = await reader.findEvent(principal, path, booking.event_uid)
    if (found.kind === 'error') return 'unreadable'
    if (found.kind === 'forbidden') return LOST_FORBIDDEN
    if (found.kind === 'no_collection') return LOST_MISSING
    if (found.kind === 'absent') return searchElsewhere(booking, principal, path, now)
    const outcome = matchEvent(booking, found.objects, new Date(booking.created_at), now)
    return outcome === 'gone' ? searchElsewhere(booking, principal, path, now) : outcome
  }

  /** Applies the outcome; true when the booking needs no further look. */
  async function apply(
    booking: BookingRow,
    outcome: Outcome,
    summary: BookingReconcileSummary,
    now: Date,
  ): Promise<boolean> {
    if (typeof outcome === 'object') {
      // The stored stamp goes, so a share that comes back is read again; never "resolved".
      clearSyncStamp(db, booking.event_calendar_path)
      if (booking.reconcile_attempts >= maxAttempts) return false
      sendToManagers(booking, 'calendar_unavailable', { cause: outcome.lost }, now)
      summary.lost++
      summary.orphaned++
      return false
    }
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
      sendToManagers(booking, 'event_moved', {}, now)
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
    const subs = subsOf(
      [...new Set(active.map((booking) => booking.requester_id))].sort((a, b) => a - b),
    )
    const byPath = new Map<string, BookingRow[]>()
    for (const booking of active) {
      const list = byPath.get(booking.event_calendar_path) ?? []
      list.push(booking)
      byPath.set(booking.event_calendar_path, list)
    }
    for (const [path, bookings] of [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const home = splitCollectionPath(path)?.owner
      // Read as the requester, and only in the requester's own home.
      const mine: BookingRow[] = []
      for (const booking of bookings) {
        if (home !== undefined && subs.get(booking.requester_id) === home) mine.push(booking)
        else await apply(booking, LOST_FORBIDDEN, summary, now)
      }
      if (mine.length === 0 || home === undefined) continue
      const stamp = await reader.stamp(home, path)
      if (stamp.kind === 'error') {
        for (const booking of mine) await apply(booking, 'unreadable', summary, now)
        continue
      }
      if (stamp.kind !== 'ok') {
        const lost = stamp.kind === 'forbidden' ? LOST_FORBIDDEN : LOST_MISSING
        for (const booking of mine) await apply(booking, lost, summary, now)
        continue
      }
      const retrying = mine.some(
        (booking) => booking.orphaned_at !== null && booking.reconcile_attempts < maxAttempts,
      )
      if (!retrying && stamp.stamp !== '' && getSyncStamp(db, path) === stamp.stamp) {
        summary.gated++
        continue
      }
      let resolved = true
      for (const booking of mine) {
        summary.looked++
        const outcome = await lookAt(booking, home, now)
        if (!(await apply(booking, outcome, summary, now))) resolved = false
      }
      if (resolved && stamp.stamp !== '') setSyncStamp(db, path, stamp.stamp, now)
    }
    pruneSyncStamps(db)
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
