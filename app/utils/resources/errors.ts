// Words for a refused booking, from the answer of the booking routes (resources-core.md: the
// service code is in `data.code` of the error body; 404 hides a resource the caller cannot read).
import { N_, t, tv } from '../i18n'
import { parseApiError } from '../settings/api-errors'

const BY_CODE: Record<string, string> = {
  overlap: N_('it is already booked at that time'),
  daily_limit: N_('you have reached the limit of bookings for that day'),
  live_limit: N_('you have reached the limit of bookings open at once'),
  too_long: N_('the booking is longer than allowed'),
  too_far_ahead: N_('the booking is too far ahead'),
  in_past: N_('the time has already started or passed'),
  invalid_slot: N_('the time slot is not valid'),
  invalid_event: N_('the calendar of the event is not one of yours'),
  calendar_not_readable: N_('you cannot read the calendar of the event'),
  resource_unavailable: N_('it is not available'),
  invalid_transition: N_('its state has changed meanwhile'),
}

/** The reason as the tail of a sentence: "Room 1 could not be booked: <this>". */
export function describeBookingRefusal(cause: unknown): string {
  const info = parseApiError(cause)
  if (info.kind === 'signed-out') return t('you are signed out')
  if (info.kind === 'network') return t('the server could not be reached')
  if (info.code && BY_CODE[info.code]) return tv(BY_CODE[info.code]!)
  if (info.status === 403) return t('you may not book it')
  if (info.status === 404) return t('it no longer exists or you may not see it')
  if (info.status === 429) return t('too many requests, wait a moment')
  if (info.kind === 'validation') return t('the server did not accept the time')
  return t('the server did not accept the booking')
}

/** The sentence for the answer of accept, decline and cancel. */
export function describeDecisionFailure(cause: unknown, action: 'accept' | 'decline' | 'cancel') {
  const reason = describeBookingRefusal(cause)
  if (action === 'accept') return t('Could not accept the booking: {reason}.', { reason })
  if (action === 'decline') return t('Could not decline the booking: {reason}.', { reason })
  return t('Could not cancel the booking: {reason}.', { reason })
}
