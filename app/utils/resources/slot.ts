// The time slot of a booking from an event's wall-clock range in the viewer's display zone.
import { Temporal } from 'temporal-polyfill'

export interface BookingSlot {
  startAt: string
  endAt: string
}

/** UTC ISO text with milliseconds, like the booking rows. */
function instantOf(wallClock: string, allDay: boolean, zone: string): string {
  const dateTime = allDay
    ? Temporal.PlainDate.from(wallClock.slice(0, 10)).toPlainDateTime()
    : Temporal.PlainDateTime.from(wallClock.slice(0, 19))
  return new Date(dateTime.toZonedDateTime(zone).epochMilliseconds).toISOString()
}

/** `end` of an all-day range is exclusive (the writer's `WallClockRange`). */
export function slotOf(
  range: { start: string; end: string; allDay: boolean },
  displayTimeZone: string,
): BookingSlot {
  return {
    startAt: instantOf(range.start, range.allDay, displayTimeZone),
    endAt: instantOf(range.end, range.allDay, displayTimeZone),
  }
}

/** An ISO instant as display-zone wall clock `YYYY-MM-DDTHH:mm:ss`. */
export function wallClockOf(iso: string, displayTimeZone: string): string {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(displayTimeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
}
