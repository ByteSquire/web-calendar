// The instants to load for the visible dates. The month grid also shows days of the neighbouring
// weeks, and a quick step to the previous or next period should find its data already loaded, so
// the visible range is widened by a week on both sides.
import type { Temporal } from 'temporal-polyfill'
import type { DateRange } from '../calendar-state'

export const LOAD_PADDING_DAYS = 7

/**
 * `[start, end)` as instants. `visible` is a range of dates in `timeZone` (the viewer's display
 * zone), the end exclusive; each date starts at that zone's local midnight (or at the first
 * instant of the day when a daylight-saving change skips midnight), so a day that is 23 or 25
 * hours long is measured correctly.
 */
export function loadRange(
  visible: DateRange,
  timeZone: string,
  paddingDays: number = LOAD_PADDING_DAYS,
): { start: Date; end: Date } {
  const startOf = (date: Temporal.PlainDate) =>
    new Date(date.toZonedDateTime(timeZone).epochMilliseconds)
  return {
    start: startOf(visible.start.subtract({ days: paddingDays })),
    end: startOf(visible.end.add({ days: paddingDays })),
  }
}

/** A string that changes exactly when the loaded range does (a `watch` source). */
export function rangeKey(visible: DateRange, timeZone: string): string {
  return `${visible.start.toString()}/${visible.end.toString()}@${timeZone}`
}
