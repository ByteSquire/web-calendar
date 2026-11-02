// The start and end of an event form as one line, for the region that folds those fields away.
// The form holds wall-clock text (`2026-11-06T14:00`, or `2026-11-06` for an all-day event); it is
// read as UTC and shown in UTC so that nothing is shifted, and the format is the one of bookings.
import { t } from '~/utils/i18n'
import { formatDay, formatSlot } from '~/utils/resources/format'

function asInstant(wallClock: string): string {
  if (wallClock.length === 10) return `${wallClock}T00:00:00Z`
  return `${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`
}

/** `Fri 6 Nov, 14:00–15:00` or `Fri 6 Nov, all day`; the raw text while the dates do not parse. */
export function whenSummary(form: { allDay: boolean; start: string; end: string }): string {
  try {
    if (form.allDay) {
      const first = formatDay(asInstant(form.start), 'UTC')
      const last = formatDay(asInstant(form.end), 'UTC')
      return first === last
        ? t('{day}, all day', { day: first })
        : t('{first} – {last}, all day', { first, last })
    }
    return formatSlot(asInstant(form.start), asInstant(form.end), 'UTC')
  } catch {
    return [form.start, form.end].filter((part) => part !== '').join(' – ')
  }
}
