// Moving wall-clock times between time zones (FR-29). Events are read in the zone they were written
// in (the organization zone for floating times) and shown in the viewer's display zone; all-day
// dates never move. Pure, so it runs in plain Vitest (tests/time-zone.test.ts).
import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent } from '../../shared/types/calendar'

/**
 * `value` (`YYYY-MM-DDTHH:mm[:ss]`, a wall-clock time in `from`) as the wall-clock time in `to`,
 * `YYYY-MM-DDTHH:mm:ss`. A time that occurs twice (clocks go back) is the first occurrence and a
 * time that does not exist (clocks go forward) is read with the offset from before the gap, as
 * RFC 5545 §3.3.5 says: 02:30 on 25 Oct 2026 in Berlin is 00:30Z, 02:30 on 29 Mar 2026 is 01:30Z.
 */
export function convertWallClock(value: string, from: string, to: string): string {
  if (from === to) return value
  return Temporal.PlainDateTime.from(value.slice(0, 19))
    .toZonedDateTime(from, { disambiguation: 'compatible' })
    .withTimeZone(to)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
}

/**
 * The event with start and end moved from `from` to `to`. All-day events are dates, not instants,
 * and stay on their dates.
 */
export function convertEventTimes<T extends Pick<CalendarEvent, 'start' | 'end' | 'allDay'>>(
  event: T,
  from: string,
  to: string,
): T {
  if (event.allDay || from === to) return event
  return {
    ...event,
    start: convertWallClock(event.start, from, to),
    end: convertWallClock(event.end, from, to),
  }
}
