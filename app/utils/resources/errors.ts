// Words for a refused booking, from the answer of the booking routes (resources-core.md: the
// service code is in `data.code` of the error body; 404 hides a resource the caller cannot read).
import { parseApiError } from '../settings/api-errors'

const BY_CODE: Record<string, string> = {
  overlap: 'it is already booked at that time',
  daily_limit: 'you have reached the limit of bookings for that day',
  live_limit: 'you have reached the limit of bookings open at once',
  too_long: 'the booking is longer than allowed',
  too_far_ahead: 'the booking is too far ahead',
  in_past: 'the time has already started or passed',
  invalid_slot: 'the time slot is not valid',
  invalid_event: 'the calendar of the event is not one of yours',
  calendar_not_readable: 'you cannot read the calendar of the event',
  resource_unavailable: 'it is not available',
  invalid_transition: 'its state has changed meanwhile',
}

/** The reason as the tail of a sentence: "Room 1 could not be booked: <this>". */
export function describeBookingRefusal(cause: unknown): string {
  const info = parseApiError(cause)
  if (info.kind === 'signed-out') return 'you are signed out'
  if (info.kind === 'network') return 'the server could not be reached'
  if (info.code && BY_CODE[info.code]) return BY_CODE[info.code]!
  if (info.status === 403) return 'you may not book it'
  if (info.status === 404) return 'it no longer exists or you may not see it'
  if (info.status === 429) return 'too many requests, wait a moment'
  if (info.kind === 'validation') return 'the server did not accept the time'
  return 'the server did not accept the booking'
}

/** The sentence for the answer of accept, decline and cancel. */
export function describeDecisionFailure(cause: unknown, action: 'accept' | 'decline' | 'cancel') {
  const reason = describeBookingRefusal(cause)
  return `Could not ${action} the booking: ${reason}.`
}
