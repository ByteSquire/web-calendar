// The manager queue: pending bookings, and bookings whose event cannot be found (orphaned), of the
// resources the caller manages. Nobody else gets anything.
import type { Database } from 'better-sqlite3'
import type { BookingRequest, BookingRequestsResponse } from '../../../shared/types/resources-api'
import { listResourcesFor, type Actor } from './service'

interface Row {
  id: number
  resource_id: number
  start_at: string
  end_at: string
  created_at: string
  orphaned_at: string | null
  requester_name: string
}

export function listBookingRequests(db: Database, actor: Actor): BookingRequestsResponse {
  const managed = listResourcesFor(db, actor).filter((view) => view.right === 'manage')
  const requests: BookingRequest[] = []
  const select = db.prepare<[number], Row>(
    `SELECT b.id, b.resource_id, b.start_at, b.end_at, b.created_at, b.orphaned_at,
            COALESCE(NULLIF(u.name, ''), u.username) AS requester_name
     FROM calendar_bookings b JOIN users u ON u.id = b.requester_id
     WHERE b.resource_id = ?
       AND (b.status = 'pending' OR (b.orphaned_at IS NOT NULL AND b.status = 'approved'))`,
  )
  const pending = db.prepare<[number], { id: number; start_at: string; end_at: string }>(
    `SELECT id, start_at, end_at FROM calendar_bookings
     WHERE resource_id = ? AND status = 'pending'`,
  )
  for (const { resource } of managed) {
    const open = pending.all(resource.id)
    for (const row of select.all(resource.id)) {
      requests.push({
        bookingId: row.id,
        resourceId: resource.id,
        resourceName: resource.name,
        start: row.start_at,
        end: row.end_at,
        requesterName: row.requester_name,
        createdAt: row.created_at,
        orphanedAt: row.orphaned_at,
        overlappingPendingIds: open
          .filter((o) => o.id !== row.id && o.start_at < row.end_at && o.end_at > row.start_at)
          .map((o) => o.id)
          .sort((a, b) => a - b),
      })
    }
  }
  requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.bookingId - b.bookingId)
  return { requests }
}
