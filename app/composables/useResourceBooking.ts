// Booking the resources of an event that was just saved (FR-17), bound to the app: the API, the
// calendar client for the marks, and the reload that follows. The logic and its tests are in
// app/utils/resources/booking-flow.ts. Live mode only; the demo books into local state through
// useResourceBookings().
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useCalDav } from '~/composables/useCalDav'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import {
  bookResources,
  describeBooked,
  describeFailures,
  type BookingFlowArgs,
  type BookingFlowResult,
} from '~/utils/resources/booking-flow'
import type { BookingStatus, NewBookingBody } from '~/utils/resources/types'

export interface BookingReport {
  result: BookingFlowResult
  /** What was booked, ready for a toast; null when nothing was. */
  booked: string | null
  /** One sentence per refused resource. */
  failures: string[]
}

export function useResourceBooking() {
  const api = useAuthFetch()
  const caldav = useCalDav()
  const { refresh } = useLiveStatus()

  /** `calendarHref` is dropped from the reader's cache so the marks show after the reload. */
  async function book(args: BookingFlowArgs): Promise<BookingReport> {
    const client = caldav?.client
    const result = await bookResources(
      {
        post: (path: string, body: NewBookingBody) =>
          api<{ id: number; status: BookingStatus }>(path, { method: 'POST', body }),
        client: client ?? {
          getObject: () => Promise.reject(new Error('The calendar service is not available.')),
          putObject: () => Promise.reject(new Error('The calendar service is not available.')),
        },
      },
      args,
    )
    if (result.booked.length > 0) {
      caldav?.reader.invalidate(args.calendarHref)
      try {
        await refresh({ external: false })
      } catch {
        // The loader reports its own failure.
      }
    }
    return { result, booked: describeBooked(result), failures: describeFailures(result) }
  }

  return { book }
}
