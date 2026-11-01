// Writes (or removes) the X-WEB-CALENDAR-* properties of a booking on a resource's text, changing
// no other line. Part 2 (the booking UI) calls it after the server accepted a booking and again
// when the status changes.
import {
  insertProp,
  makeProp,
  parseDocument,
  removeProps,
  serializeDocument,
  subcomponents,
  type Comp,
} from './write-lines'
import { X_BOOKING, X_BOOKING_STATUS, X_RESOURCE, type BookingMarks } from './x-properties'

function eventsOf(root: Comp): Comp[] {
  return subcomponents(root, 'VCALENDAR').flatMap((calendar) => subcomponents(calendar, 'VEVENT'))
}

/**
 * Every VEVENT of the resource (master and overrides: one booking covers the series) gets the
 * properties; `null` removes them. Returns the text unchanged when it holds no VEVENT.
 */
export function setBookingMarks(
  ics: string,
  marks: (BookingMarks & { bookingId: number }) | null,
): string {
  const root = parseDocument(ics)
  const events = eventsOf(root)
  if (events.length === 0) return ics
  for (const event of events) {
    for (const name of [X_RESOURCE, X_BOOKING, X_BOOKING_STATUS]) removeProps(event, name)
    if (!marks) continue
    insertProp(event, makeProp(X_RESOURCE, [], `res:${marks.resourceId}`))
    insertProp(event, makeProp(X_BOOKING, [], String(marks.bookingId)))
    if (marks.status) insertProp(event, makeProp(X_BOOKING_STATUS, [], marks.status))
  }
  return serializeDocument(root)
}
