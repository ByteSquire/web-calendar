// The shapes of the resource routes that exist since resources part 1 (docs/phase3-notes/
// resources-core.md), declared here so no server code reaches the browser. The answers of the
// availability, requests and updates routes are in shared/types/resources-api.ts.
export type ResourceRight = 'read' | 'book' | 'manage'
export type BookingStatus = 'pending' | 'approved' | 'declined' | 'cancelled'

/** `GET /api/resources`: the active resources the caller may at least read. */
export interface ApiResource {
  id: number
  name: string
  type: 'room' | 'car' | 'equipment'
  location: string | null
  capacity: number | null
  description: string | null
  active: boolean
  right: ResourceRight
}

interface ApiBookingBase {
  id: number
  resourceId: number
  startAt: string
  endAt: string
  status: BookingStatus
  decidedAt: string | null
}

/** A booking as its requester sees it. */
export interface ApiOwnBooking extends ApiBookingBase {
  /** The event's calendar as its requester sees it: `/<sub>/<name>/`. */
  eventCalendarPath: string
  eventUid: string
}

/** A booking as a manager of the resource sees it (also in the list of a manager). */
export interface ApiManagedBooking extends ApiBookingBase {
  requester: { id: number; username: string | null; name: string | null }
  orphaned: boolean
}

export type ApiBooking = ApiOwnBooking | ApiManagedBooking

/** The body of `POST /api/resources/:id/bookings`. */
export interface NewBookingBody {
  startAt: string
  endAt: string
  /** The event's calendar by its public CalDAV path (`/caldav/<owner>/<name>/`), a share included. */
  eventCalendarPath: string
  eventUid: string
}

export interface AcceptAnswer {
  booking: ApiBooking
  declined: ApiManagedBooking[]
}

/** What a booking of the form needs to know about a resource. */
export interface BookableResource {
  /** The state's id: the API id as text, in demo mode the mock id. */
  id: string
  name: string
}
