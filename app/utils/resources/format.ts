// The time of a booking, or of an event being edited, as text, in the viewer's display zone.
const LOCALE = 'en-GB'

function parts(iso: string, zone: string) {
  const date = new Date(iso)
  return {
    day: new Intl.DateTimeFormat(LOCALE, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: zone,
    }).format(date),
    time: new Intl.DateTimeFormat(LOCALE, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).format(date),
  }
}

/** `Fri 6 Nov`: the day of an instant in `zone`. */
export function formatDay(iso: string, zone: string): string {
  return parts(iso, zone).day
}

/** `Fri 6 Nov, 14:00–15:00`, or both days when the booking spans midnight. */
export function formatSlot(startIso: string, endIso: string, zone: string): string {
  const start = parts(startIso, zone)
  const end = parts(endIso, zone)
  return start.day === end.day
    ? `${start.day}, ${start.time}–${end.time}`
    : `${start.day}, ${start.time} – ${end.day}, ${end.time}`
}
