// What happens after an event with resources was saved (FR-17): ask the booking route for each
// resource, then copy the booking onto the event as X-WEB-CALENDAR-* marks. The event is already
// saved when this runs and stays saved whatever happens here; a refusal is reported by resource
// and never throws. Injected services, no Vue.
import { ensureTrailingSlash, toDavPath } from '../caldav/urls'
import { setBookingMarks } from '../ical/booking-marks'
import { t } from '../i18n'
import { describeBookingRefusal } from './errors'
import type { BookableResource, BookingStatus, NewBookingBody } from './types'
import type { BookingSlot } from './slot'

export interface BookingFlowDeps {
  /** POST to the app's API; throws what `$fetch` throws. */
  post: (path: string, body: NewBookingBody) => Promise<{ id: number; status: BookingStatus }>
  /** The saved event's `.ics` resource, for the marks. */
  client: {
    getObject: (url: string) => Promise<{ data: string; etag: string }>
    putObject: (args: { url: string; data: string; etag: string }) => Promise<unknown>
  }
}

export interface BookingFlowArgs {
  resources: readonly BookableResource[]
  slot: BookingSlot
  eventUid: string
  /** URL of the collection that holds the event (`Calendar.href`). */
  calendarHref: string
  /**
   * URL of the event's `.ics` for the marks, or null to write none (a single occurrence of a
   * series: the marks of a resource cover the whole series).
   */
  markUrl: string | null
}

export interface BookedResource {
  resource: BookableResource
  bookingId: number
  status: BookingStatus
}

export interface BookingFlowResult {
  booked: BookedResource[]
  failed: { resource: BookableResource; reason: string }[]
  /** The booking exists but the event could not be marked. */
  marksFailed: boolean
}

/** The path the server links the booking to the calendar by; null for a calendar of another service. */
export function calendarPathOf(href: string): string | null {
  const path = toDavPath(href.trim()).replace(/[?#].*$/, '')
  return path.startsWith('/caldav/') ? ensureTrailingSlash(path) : null
}

/**
 * Requests the resources one after the other (the route is rate limited and the first refusal
 * says nothing about the next). The marks carry ONE resource, so with several only the first
 * booked one is marked; the database stays the truth about all of them.
 */
export async function bookResources(
  deps: BookingFlowDeps,
  args: BookingFlowArgs,
): Promise<BookingFlowResult> {
  const result: BookingFlowResult = { booked: [], failed: [], marksFailed: false }
  const eventCalendarPath = calendarPathOf(args.calendarHref)
  if (eventCalendarPath === null) {
    // No path, no booking: the event would never be followed. The saved event stays.
    for (const resource of args.resources) {
      result.failed.push({ resource, reason: t('the calendar of the event cannot be booked from') })
    }
    return result
  }
  for (const resource of args.resources) {
    try {
      const booking = await deps.post(`/api/resources/${resource.id}/bookings`, {
        startAt: args.slot.startAt,
        endAt: args.slot.endAt,
        eventCalendarPath,
        eventUid: args.eventUid,
      })
      result.booked.push({ resource, bookingId: booking.id, status: booking.status })
    } catch (cause) {
      result.failed.push({ resource, reason: describeBookingRefusal(cause) })
    }
  }
  const first = result.booked[0]
  if (first && args.markUrl) {
    try {
      const object = await deps.client.getObject(args.markUrl)
      const data = setBookingMarks(object.data, {
        resourceId: Number(first.resource.id),
        bookingId: first.bookingId,
        status: first.status,
      })
      if (data !== object.data) {
        await deps.client.putObject({ url: args.markUrl, data, etag: object.etag })
      }
    } catch {
      result.marksFailed = true
    }
  }
  return result
}

function names(items: readonly { name: string }[]): string {
  if (items.length === 2) return t('{a} and {b}', { a: items[0]!.name, b: items[1]!.name })
  if (items.length < 2) return items.map((item) => item.name).join(', ')
  return t('{list} and {last}', {
    list: items
      .slice(0, -1)
      .map((item) => item.name)
      .join(', '),
    last: items[items.length - 1]!.name,
  })
}

/** The failures, one sentence each: "Room 1 could not be booked: it is already booked ...". */
export function describeFailures(result: BookingFlowResult): string[] {
  return result.failed.map(({ resource, reason }) =>
    t('{name} could not be booked: {reason}.', { name: resource.name, reason }),
  )
}

/** The toast after a flow: what was booked, what is waiting. Null when nothing was booked. */
export function describeBooked(result: BookingFlowResult): string | null {
  if (result.booked.length === 0) return null
  const waiting = result.booked.filter((item) => item.status === 'pending').map((i) => i.resource)
  const done = result.booked.filter((item) => item.status !== 'pending').map((i) => i.resource)
  const parts: string[] = []
  if (done.length > 0) parts.push(t('{names} booked', { names: names(done) }))
  if (waiting.length > 0)
    parts.push(t('{names} requested, waiting for approval', { names: names(waiting) }))
  return `${parts.join('; ')}.`
}
