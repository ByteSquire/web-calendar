// The X- properties the app writes on an event that books a resource (design §5). The database is
// the truth about a booking; these properties are a copy for other clients and for recovery. They
// are read only from calendars the app trusts, and removed from files and feeds of strangers.
import type { CalendarEvent } from '../../../shared/types/calendar'

export const X_RESOURCE = 'X-WEB-CALENDAR-RESOURCE'
export const X_BOOKING = 'X-WEB-CALENDAR-BOOKING'
export const X_BOOKING_STATUS = 'X-WEB-CALENDAR-BOOKING-STATUS'

export type BookingMarkStatus = 'pending' | 'approved' | 'declined' | 'cancelled'

/** What the X-WEB-CALENDAR-* properties of an event say. Part of the parsed event, never trusted alone. */
export interface BookingMarks {
  resourceId: number
  bookingId?: number
  status?: BookingMarkStatus
}

/** The parsed event with the booking marks of its calendar, when it has any. */
export type ReadEvent = CalendarEvent & { bookingMarks?: BookingMarks }

/**
 * X- properties kept when a file is imported. None for now: a stranger's file must not claim a
 * booking, and nothing else the app does depends on a foreign X- property.
 */
export const IMPORT_ALLOWED_X_PROPERTIES: ReadonlySet<string> = new Set()

const POSITIVE_INT = /^[1-9][0-9]{0,14}$/
const STATUSES: readonly string[] = ['pending', 'approved', 'declined', 'cancelled']

/** The marks, or undefined when there is no valid `res:<id>`. Bad booking or status are left out. */
export function parseBookingMarks(
  resource: string | undefined,
  booking: string | undefined,
  status: string | undefined,
): BookingMarks | undefined {
  const resourceMatch = /^res:([1-9][0-9]{0,14})$/.exec((resource ?? '').trim())
  if (!resourceMatch) return undefined
  const marks: BookingMarks = { resourceId: Number(resourceMatch[1]) }
  const bookingText = (booking ?? '').trim()
  if (POSITIVE_INT.test(bookingText)) marks.bookingId = Number(bookingText)
  const statusText = (status ?? '').trim().toLowerCase()
  if (STATUSES.includes(statusText)) marks.status = statusText as BookingMarkStatus
  return marks
}

/** The three property lines for an event that books a resource. */
export function bookingMarkLines(marks: BookingMarks & { bookingId: number }): string[] {
  const lines = [`${X_RESOURCE}:res:${marks.resourceId}`, `${X_BOOKING}:${marks.bookingId}`]
  if (marks.status) lines.push(`${X_BOOKING_STATUS}:${marks.status}`)
  return lines
}
