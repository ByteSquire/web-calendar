import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getResource } from './resources'
import type { BookingRow, BookingStatus } from './types'

// Bookings of resources (design §5, security review §7.4). The database is the source of truth;
// the overlap rule is also enforced by triggers (migration 006), so a race cannot get past it.

export interface BookingLimits {
  maxDurationMs: number
  /** Pending and approved bookings one user may have starting on the same UTC day,. */
  maxPerRequesterPerDay: number
  maxLookaheadMs: number
  /**
   * Pending and approved bookings one user may have in total, any day (security review
   * 2026-11-01, finding 6): the per-day limit alone does not bound a year of look-ahead, so a
   * requester could hold thousands of live bookings a day at a time.
   */
  maxLivePerRequester: number
}

export const DEFAULT_BOOKING_LIMITS: BookingLimits = {
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxPerRequesterPerDay: 10,
  maxLookaheadMs: 365 * 24 * 60 * 60 * 1000,
  maxLivePerRequester: 50,
}

export type BookingErrorCode =
  | 'invalid_slot'
  | 'resource_unavailable'
  | 'in_past'
  | 'too_long'
  | 'too_far_ahead'
  | 'daily_limit'
  | 'live_limit'
  | 'overlap'
  | 'not_found'
  | 'invalid_transition'

export type BookingResult<T> = ({ ok: true } & T) | { ok: false; code: BookingErrorCode }

export interface NewBooking {
  resourceId: number
  requesterId: number
  /** Any ISO 8601 instant; stored as UTC with milliseconds. */
  startAt: string
  endAt: string
  /** The collection holding the event, as the requester sees it: '/<sub>/<name>/'. */
  eventCalendarPath: string
  eventUid: string
}

export interface BookingRange {
  /** Bookings that overlap [from, to): they start before `to` and end after `from`. */
  from?: string
  to?: string
}

function fail(code: BookingErrorCode): { ok: false; code: BookingErrorCode } {
  return { ok: false, code }
}

function toUtc(value: string): string | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

export function newBlockRef(): string {
  return randomBytes(16).toString('hex')
}

export function getBooking(db: Database, id: number): BookingRow | null {
  return (
    db.prepare<[number], BookingRow>('SELECT * FROM calendar_bookings WHERE id = ?').get(id) ?? null
  )
}

/**
 * Creates a pending booking after checking the slot, the limits and the approved bookings of the
 * resource, all in one transaction. A pending booking may overlap other pending ones.
 */
export function createBooking(
  db: Database,
  input: NewBooking,
  options: { now?: Date; limits?: Partial<BookingLimits> } = {},
): BookingResult<{ booking: BookingRow }> {
  const now = options.now ?? new Date()
  const limits = { ...DEFAULT_BOOKING_LIMITS, ...options.limits }
  const startAt = toUtc(input.startAt)
  const endAt = toUtc(input.endAt)
  if (!startAt || !endAt || endAt <= startAt || input.eventUid === '') return fail('invalid_slot')

  const create = db.transaction((): BookingResult<{ booking: BookingRow }> => {
    const resource = getResource(db, input.resourceId)
    if (!resource || resource.active !== 1) return fail('resource_unavailable')
    if (startAt < now.toISOString()) return fail('in_past')
    if (Date.parse(endAt) - Date.parse(startAt) > limits.maxDurationMs) return fail('too_long')
    if (Date.parse(startAt) - now.getTime() > limits.maxLookaheadMs) return fail('too_far_ahead')
    const { count } = db
      .prepare<[number, string], { count: number }>(
        `SELECT COUNT(*) AS count FROM calendar_bookings
         WHERE requester_id = ? AND status IN ('pending', 'approved') AND substr(start_at, 1, 10) = ?`,
      )
      .get(input.requesterId, startAt.slice(0, 10))!
    if (count >= limits.maxPerRequesterPerDay) return fail('daily_limit')
    const { liveCount } = db
      .prepare<[number], { liveCount: number }>(
        `SELECT COUNT(*) AS liveCount FROM calendar_bookings
         WHERE requester_id = ? AND status IN ('pending', 'approved')`,
      )
      .get(input.requesterId)!
    if (liveCount >= limits.maxLivePerRequester) return fail('live_limit')
    if (hasApprovedOverlap(db, input.resourceId, startAt, endAt, 0)) return fail('overlap')
    const booking = db
      .prepare<[number, number, string, string, string, string, string], BookingRow>(
        `INSERT INTO calendar_bookings
           (resource_id, requester_id, start_at, end_at, event_calendar_path, event_uid, block_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.resourceId,
        input.requesterId,
        startAt,
        endAt,
        input.eventCalendarPath,
        input.eventUid,
        newBlockRef(),
      )!
    return { ok: true, booking }
  })
  return create.immediate()
}

function hasApprovedOverlap(
  db: Database,
  resourceId: number,
  startAt: string,
  endAt: string,
  exceptId: number,
): boolean {
  return (
    db
      .prepare<[number, string, string, number], { found: 1 }>(
        `SELECT 1 AS found FROM calendar_bookings
         WHERE resource_id = ? AND status = 'approved' AND start_at < ? AND end_at > ? AND id <> ?`,
      )
      .get(resourceId, endAt, startAt, exceptId) !== undefined
  )
}

function listWhere(
  db: Database,
  column: 'resource_id' | 'requester_id',
  id: number,
  range: BookingRange,
  statuses?: readonly BookingStatus[],
): BookingRow[] {
  const clauses = [`${column} = ?`]
  const params: (string | number)[] = [id]
  if (range.to !== undefined) {
    clauses.push('start_at < ?')
    params.push(range.to)
  }
  if (range.from !== undefined) {
    clauses.push('end_at > ?')
    params.push(range.from)
  }
  if (statuses) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  return db
    .prepare<(string | number)[], BookingRow>(
      `SELECT * FROM calendar_bookings WHERE ${clauses.join(' AND ')} ORDER BY start_at, id`,
    )
    .all(...params)
}

export function listBookingsByResource(
  db: Database,
  resourceId: number,
  range: BookingRange = {},
  statuses?: readonly BookingStatus[],
): BookingRow[] {
  return listWhere(db, 'resource_id', resourceId, range, statuses)
}

export function listBookingsByRequester(
  db: Database,
  requesterId: number,
  range: BookingRange = {},
  statuses?: readonly BookingStatus[],
): BookingRow[] {
  return listWhere(db, 'requester_id', requesterId, range, statuses)
}

/** Bookings of every resource in a range, optionally of some statuses. */
export function listBookingsInRange(
  db: Database,
  range: BookingRange,
  statuses?: readonly BookingStatus[],
): BookingRow[] {
  const clauses = ['1 = 1']
  const params: string[] = []
  if (range.to !== undefined) {
    clauses.push('start_at < ?')
    params.push(range.to)
  }
  if (range.from !== undefined) {
    clauses.push('end_at > ?')
    params.push(range.from)
  }
  if (statuses) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  return db
    .prepare<string[], BookingRow>(
      `SELECT * FROM calendar_bookings WHERE ${clauses.join(' AND ')} ORDER BY start_at, id`,
    )
    .all(...params)
}

/**
 * Approves a pending booking and declines the pending ones that overlap it, in one transaction.
 * Fails with `overlap` when another approved booking holds the slot.
 */
export function approveBooking(
  db: Database,
  id: number,
  approverId: number,
  now: Date = new Date(),
): BookingResult<{ booking: BookingRow; declinedIds: number[] }> {
  const approve = db.transaction(
    (): BookingResult<{ booking: BookingRow; declinedIds: number[] }> => {
      const current = getBooking(db, id)
      if (!current) return fail('not_found')
      if (current.status !== 'pending') return fail('invalid_transition')
      if (hasApprovedOverlap(db, current.resource_id, current.start_at, current.end_at, id)) {
        return fail('overlap')
      }
      const stamp = now.toISOString()
      const booking = db
        .prepare<[string, number, number], BookingRow>(
          `UPDATE calendar_bookings SET status = 'approved', decided_at = ?, approver_id = ?
           WHERE id = ? RETURNING *`,
        )
        .get(stamp, approverId, id)!
      const declinedIds = db
        .prepare<[string, number, number, number, string, string], { id: number }>(
          `UPDATE calendar_bookings SET status = 'declined', decided_at = ?, approver_id = ?
           WHERE resource_id = ? AND id <> ? AND status = 'pending'
             AND start_at < ? AND end_at > ?
           RETURNING id`,
        )
        .all(stamp, approverId, booking.resource_id, id, booking.end_at, booking.start_at)
        .map((row) => row.id)
        .sort((a, b) => a - b)
      return { ok: true, booking, declinedIds }
    },
  )
  return approve.immediate()
}

/**
 * Declines (pending only) or cancels (pending or approved) a booking. Approving goes through
 * approveBooking. `actorId` is stored as the approver when a manager declines.
 */
export function transitionBooking(
  db: Database,
  id: number,
  to: 'declined' | 'cancelled',
  actorId: number | null,
  now: Date = new Date(),
): BookingResult<{ booking: BookingRow }> {
  const move = db.transaction((): BookingResult<{ booking: BookingRow }> => {
    const current = getBooking(db, id)
    if (!current) return fail('not_found')
    const allowed: readonly BookingStatus[] =
      to === 'declined' ? ['pending'] : ['pending', 'approved']
    if (!allowed.includes(current.status)) return fail('invalid_transition')
    const booking = db
      .prepare<[string, string, number | null, number], BookingRow>(
        `UPDATE calendar_bookings
         SET status = ?, decided_at = ?, approver_id = COALESCE(?, approver_id)
         WHERE id = ? RETURNING *`,
      )
      .get(to, now.toISOString(), to === 'declined' ? actorId : null, id)!
    return { ok: true, booking }
  })
  return move.immediate()
}

/** Records one more failed look for the booking event; `orphaned_at` keeps its first time. */
export function markBookingOrphaned(
  db: Database,
  id: number,
  now: Date = new Date(),
): BookingRow | null {
  return (
    db
      .prepare<[string, number], BookingRow>(
        `UPDATE calendar_bookings
         SET orphaned_at = COALESCE(orphaned_at, ?), reconcile_attempts = reconcile_attempts + 1
         WHERE id = ? RETURNING *`,
      )
      .get(now.toISOString(), id) ?? null
  )
}

/** The booking event was found again. */
export function clearBookingOrphaned(db: Database, id: number): BookingRow | null {
  return (
    db
      .prepare<[number], BookingRow>(
        `UPDATE calendar_bookings SET orphaned_at = NULL, reconcile_attempts = 0
         WHERE id = ? RETURNING *`,
      )
      .get(id) ?? null
  )
}

/** Points the booking at its event after the event moved to another calendar. */
export function setBookingEvent(
  db: Database,
  id: number,
  eventCalendarPath: string,
  eventUid: string,
): BookingRow | null {
  return (
    db
      .prepare<[string, string, number], BookingRow>(
        'UPDATE calendar_bookings SET event_calendar_path = ?, event_uid = ? WHERE id = ? RETURNING *',
      )
      .get(eventCalendarPath, eventUid, id) ?? null
  )
}
