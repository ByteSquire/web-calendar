// The rows of the page "Resource bookings": pending requests for managers and the viewer's own
// bookings, in one shape for the live data (API answers) and the demo data (local state). Pure.
import { Temporal } from 'temporal-polyfill'
import type { BookingRequest } from '../../../shared/types/resources-api'
import type { ApiBooking, ApiManagedBooking, BookingStatus } from './types'

export interface BookingRow {
  id: number
  /** The id of the resource as the calendar state has it. */
  resourceId: string
  resourceName: string
  requesterName: string
  /** UTC ISO instants. */
  start: string
  end: string
  status: BookingStatus
  mine: boolean
  createdAt: string
  /** The booker's event cannot be found (resources part 3). */
  orphaned: boolean
  /** Other pending bookings of the same resource that overlap this one. */
  overlapIds: number[]
}

export function fromRequest(request: BookingRequest): BookingRow {
  return {
    id: request.bookingId,
    resourceId: String(request.resourceId),
    resourceName: request.resourceName,
    requesterName: request.requesterName,
    start: request.start,
    end: request.end,
    status: 'pending',
    mine: false,
    createdAt: request.createdAt,
    orphaned: request.orphanedAt !== null,
    overlapIds: request.overlappingPendingIds,
  }
}

function isManaged(booking: ApiBooking): booking is ApiManagedBooking {
  return 'requester' in booking
}

/** A booking from `GET /api/resources/:id/bookings`; null when it is somebody else's. */
export function fromListedBooking(
  booking: ApiBooking,
  resource: { id: string; name: string },
  myUserId: number,
): BookingRow | null {
  if (isManaged(booking) && booking.requester.id !== myUserId) return null
  return {
    id: booking.id,
    resourceId: resource.id,
    resourceName: resource.name,
    requesterName: 'You',
    start: booking.startAt,
    end: booking.endAt,
    status: booking.status,
    mine: true,
    createdAt: '',
    orphaned: isManaged(booking) && booking.orphaned,
    overlapIds: [],
  }
}

/** Own bookings that still matter: waiting or approved, and not over. */
export function ownBookings(rows: readonly BookingRow[], now: Date): BookingRow[] {
  return rows
    .filter(
      (row) =>
        row.mine &&
        (row.status === 'pending' || row.status === 'approved') &&
        Date.parse(row.end) > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id - b.id)
}

export function pendingRequests(rows: readonly BookingRow[]): BookingRow[] {
  return rows
    .filter((row) => row.status === 'pending' && !row.mine)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)
}

function overlaps(a: BookingRow, b: BookingRow): boolean {
  return (
    a.resourceId === b.resourceId &&
    Date.parse(a.start) < Date.parse(b.end) &&
    Date.parse(b.start) < Date.parse(a.end)
  )
}

/** Recomputes the overlap hints among the pending rows (demo data; the API sends its own). */
export function withOverlaps(rows: readonly BookingRow[]): BookingRow[] {
  return rows.map((row) => ({
    ...row,
    overlapIds:
      row.status === 'pending'
        ? rows
            .filter((o) => o.id !== row.id && o.status === 'pending' && overlaps(row, o))
            .map((o) => o.id)
        : [],
  }))
}

/** Local counterpart of accept: approves, declines the overlapping pending ones. */
export function acceptLocal(
  rows: readonly BookingRow[],
  id: number,
): { rows: BookingRow[]; declined: BookingRow[] } {
  const target = rows.find((row) => row.id === id && row.status === 'pending')
  if (!target) return { rows: [...rows], declined: [] }
  const declined = rows.filter(
    (row) => row.status === 'pending' && row.id !== id && overlaps(row, target),
  )
  const ids = new Set(declined.map((row) => row.id))
  const next = rows.map((row): BookingRow => {
    if (row.id === id) return { ...row, status: 'approved' }
    return ids.has(row.id) ? { ...row, status: 'declined' } : row
  })
  return {
    rows: withOverlaps(next),
    declined: declined.map((row) => ({ ...row, status: 'declined' })),
  }
}

export function setStatusLocal(
  rows: readonly BookingRow[],
  id: number,
  status: 'declined' | 'cancelled',
): BookingRow[] {
  return withOverlaps(rows.map((row) => (row.id === id ? { ...row, status } : row)))
}

/** Rows for the demo page: two overlapping requests for Room A, one of the viewer's for the Van. */
export function seedDemoRows(today: Temporal.PlainDate, zone: string): BookingRow[] {
  const at = (days: number, time: string) =>
    new Date(
      today.add({ days }).toPlainDateTime(Temporal.PlainTime.from(time)).toZonedDateTime(zone)
        .epochMilliseconds,
    ).toISOString()
  const created = (days: number) => at(days, '08:00')
  return withOverlaps([
    {
      id: 9001,
      resourceId: 'res-room-a',
      resourceName: 'Room A',
      requesterName: 'Priya Nair',
      start: at(1, '14:00'),
      end: at(1, '15:00'),
      status: 'pending',
      mine: false,
      createdAt: created(-2),
      orphaned: false,
      overlapIds: [],
    },
    {
      id: 9002,
      resourceId: 'res-room-a',
      resourceName: 'Room A',
      requesterName: 'Tom Becker',
      start: at(1, '14:30'),
      end: at(1, '16:00'),
      status: 'pending',
      mine: false,
      createdAt: created(-1),
      orphaned: false,
      overlapIds: [],
    },
    {
      id: 9003,
      resourceId: 'res-van',
      resourceName: 'Van',
      requesterName: 'You',
      start: at(3, '09:00'),
      end: at(3, '17:00'),
      status: 'pending',
      mine: true,
      createdAt: created(-1),
      orphaned: false,
      overlapIds: [],
    },
  ])
}
