// The answers of the resource availability API (Phase 3, resources part 2). The server routes and
// the browser import these, so a change here is checked on both sides. Times are UTC ISO text with
// milliseconds, like the booking rows. The routes (all need a signed-in user, answer JSON, never
// cache):
//
//   GET /api/resources/availability?from=<iso>&to=<iso>[&resource=<id>,<id>]
//     -> AvailabilityResponse. Only resources the caller may at least read; a range of at most 62
//        days; without `resource` all of those. Declined and cancelled bookings are not listed.
//   GET /api/resources/requests
//     -> BookingRequestsResponse. The pending (and orphaned) bookings of the resources the caller
//        manages, oldest first. Empty for everybody else.
//   GET /api/resources/updates?since=<iso>
//     -> BookingUpdatesResponse. The caller's own bookings whose status changed after `since`.
//
// The routes that create, accept, decline and cancel bookings are described in docs/design.md §5.

export type AvailabilityStatus = 'approved' | 'pending'

export interface AvailabilityEntry {
  bookingId: number
  start: string
  end: string
  /** `approved` blocks the slot; `pending` is only a hint (design section 5). */
  status: AvailabilityStatus
  /**
   * True when the caller may not see who booked and why: `requesterName` and `eventUid` are then
   * absent. The caller sees the details of their own bookings and of events in calendars they can
   * read. The title of the event is not known to the server (it lives in Radicale); the browser
   * matches `eventUid` with the events it has already loaded.
   */
  blocked: boolean
  requesterName?: string
  eventUid?: string
  /** The caller made this booking. */
  mine: boolean
}

export interface ResourceAvailability {
  resourceId: number
  entries: AvailabilityEntry[]
}

export interface AvailabilityResponse {
  from: string
  to: string
  resources: ResourceAvailability[]
}

export interface BookingRequest {
  bookingId: number
  resourceId: number
  resourceName: string
  start: string
  end: string
  requesterName: string
  createdAt: string
  /** Set while the booker's event cannot be found (resources part 3); null otherwise. */
  orphanedAt: string | null
  /** Other pending bookings of the same resource that overlap this one. */
  overlappingPendingIds: number[]
}

export interface BookingRequestsResponse {
  requests: BookingRequest[]
}

export type BookingUpdateReason = 'decision' | 'overlap' | 'event_removed' | 'event_moved'

export interface BookingUpdate {
  bookingId: number
  resourceId: number
  resourceName: string
  status: 'approved' | 'declined' | 'cancelled'
  decidedAt: string
  /** Best effort: `decision` when the cause is not recorded. */
  reason: BookingUpdateReason
}

export interface BookingUpdatesResponse {
  since: string
  updates: BookingUpdate[]
}

/** Longest range the availability route answers, in days. */
export const MAX_AVAILABILITY_RANGE_DAYS = 62
