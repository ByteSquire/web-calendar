// What happened to the caller's own bookings. The time of a change is `decided_at`, or
// `updated_at` when no decision time was recorded (a cancellation by the booker).
import type { Database } from 'better-sqlite3'
import type {
  BookingUpdate,
  BookingUpdateReason,
  BookingUpdatesResponse,
} from '../../../shared/types/resources-api'
import type { Actor } from './service'

const REASONS: readonly string[] = ['decision', 'overlap', 'event_removed', 'event_moved']
const MAX_UPDATES = 200

interface Row {
  id: number
  resource_id: number
  resource_name: string
  status: BookingUpdate['status']
  changed_at: string
}

function reasonOf(db: Database, bookingId: number): BookingUpdateReason {
  const rows = db
    .prepare<[string], { reason: unknown }>(
      `SELECT json_extract(details, '$.reason') AS reason FROM audit_log
       WHERE target = ? AND json_extract(details, '$.reason') IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .all(`booking:${bookingId}`)
  const reason = rows[0]?.reason
  return typeof reason === 'string' && REASONS.includes(reason)
    ? (reason as BookingUpdateReason)
    : 'decision'
}

export function listBookingUpdates(
  db: Database,
  actor: Actor,
  since: string,
): BookingUpdatesResponse {
  const rows = db
    .prepare<[number, string, number], Row>(
      `SELECT b.id, b.resource_id, r.name AS resource_name, b.status,
              COALESCE(b.decided_at, b.updated_at) AS changed_at
       FROM calendar_bookings b JOIN resources r ON r.id = b.resource_id
       WHERE b.requester_id = ? AND b.status IN ('approved', 'declined', 'cancelled')
         AND COALESCE(b.decided_at, b.updated_at) > ?
       ORDER BY changed_at, b.id LIMIT ?`,
    )
    .all(actor.id, since, MAX_UPDATES)
  return {
    since,
    updates: rows.map((row) => ({
      bookingId: row.id,
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      status: row.status,
      decidedAt: row.changed_at,
      reason: reasonOf(db, row.id),
    })),
  }
}
