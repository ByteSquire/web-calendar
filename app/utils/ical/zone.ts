// Instant <-> wall-clock arithmetic for the iCalendar reader (FR-28, FR-29). Pure and free of
// ical.js, so the write side and the tests can use it too.
//
// Vocabulary: an *instant* is epoch milliseconds. A *wall time* is a calendar date and clock time
// without a zone, stored as the epoch milliseconds the same fields would have in UTC (so
// `2026-10-25T02:30:00` is `Date.UTC(2026, 9, 25, 2, 30)`). Wall times add and compare like
// numbers, which is what recurrence arithmetic needs; the zone only matters at the edges.
import { Temporal } from 'temporal-polyfill'
import { isValidTimeZone } from '../../../shared/utils/time-zone'

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** A time zone as far as converting goes: the UTC offset in force at an instant. */
export interface ZoneRules {
  /** The TZID or IANA name; informational. */
  readonly id: string
  /** Seconds east of UTC at `epochMs`. */
  offsetAt(epochMs: number): number
}

export const UTC_ZONE: ZoneRules = { id: 'UTC', offsetAt: () => 0 }

const ianaZones = new Map<string, ZoneRules>()

/** The rules of an IANA zone from the runtime's own database. Throws RangeError for other names. */
export function ianaZone(id: string): ZoneRules {
  let zone = ianaZones.get(id)
  if (!zone) {
    if (!isValidTimeZone(id)) throw new RangeError(`Unknown time zone "${id}"`)
    zone = {
      id,
      offsetAt: (epochMs) =>
        Number(
          Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(id).offsetNanoseconds,
        ) / 1e9,
    }
    ianaZones.set(id, zone)
  }
  return zone
}

/** The wall time in `zone` at an instant. */
export function instantToWall(epochMs: number, zone: ZoneRules): number {
  return epochMs + zone.offsetAt(epochMs) * 1000
}

/**
 * The instant a wall time in `zone` happens, read as RFC 5545 §3.3.5 says: a time that occurs
 * twice (clocks go back) is the first occurrence, and a time that does not exist (clocks go
 * forward) is read with the offset from before the gap. This is the same answer as
 * `convertWallClock` in app/utils/time-zone.ts gives; it works for any rules, including the ones
 * of a VTIMEZONE.
 */
export function wallToInstant(wall: number, zone: ZoneRules): number {
  // The instant is `wall - offset`, and an offset is between -12 h and +14 h, so the instant lies
  // in [wall - 14 h, wall + 12 h]. Only the offsets at both ends of that window can apply.
  const early = zone.offsetAt(wall - 14 * HOUR_MS)
  const late = zone.offsetAt(wall + 12 * HOUR_MS)
  const withEarly = wall - early * 1000
  if (early === late) return withEarly
  const withLate = wall - late * 1000
  const earlyHolds = zone.offsetAt(withEarly) === early
  const lateHolds = zone.offsetAt(withLate) === late
  if (earlyHolds && lateHolds) return Math.min(withEarly, withLate)
  if (lateHolds) return withLate
  return withEarly
}

/** Wall time from calendar fields; null for fields that are not a real date and time. */
export function wallFromFields(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number | null {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null
  if (year < 0 || year > 9999) return null
  const date = new Date(0)
  // `Date.UTC` maps the years 0-99 to 1900-1999; `setUTCFullYear` does not.
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  const exact =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  return exact ? date.getTime() : null
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** `YYYY-MM-DD` of a wall time. */
export function formatWallDate(wall: number): string {
  const date = new Date(wall)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** `YYYY-MM-DDTHH:mm:ss` of a wall time. */
export function formatWall(wall: number): string {
  const date = new Date(wall)
  return (
    `${formatWallDate(wall)}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

/** `YYYY-MM-DDTHH:mm:ssZ` of an instant, the form of `CalendarEvent.recurrenceId`. */
export function formatUtcInstant(epochMs: number): string {
  return `${formatWall(epochMs)}Z`
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?(Z)?$/

/** Fields of `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss]` or the same with a trailing `Z`; null otherwise. */
export function parseWall(value: string): { wall: number; hasTime: boolean; utc: boolean } | null {
  const match = WALL.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, zulu] = match
  const hasTime = hour !== undefined
  if (zulu && !hasTime) return null
  const wall = wallFromFields(
    Number(year),
    Number(month),
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  )
  return wall === null ? null : { wall, hasTime, utc: Boolean(zulu) }
}

/** The instant of `2026-10-26T08:00:00Z`; NaN when the text is not that form. */
export function parseUtcInstant(value: string): number {
  const parsed = parseWall(value)
  return parsed?.utc ? parsed.wall : Number.NaN
}

/** Instant of a wall-clock string (`YYYY-MM-DDTHH:mm[:ss]`) in an IANA zone. */
export function wallClockToInstant(value: string, zone: string): number {
  const parsed = parseWall(value)
  if (!parsed || parsed.utc) throw new RangeError(`Not a wall-clock time: "${value}"`)
  return wallToInstant(parsed.wall, ianaZone(zone))
}

/** Wall-clock string `YYYY-MM-DDTHH:mm:ss` of an instant in an IANA zone. */
export function instantToWallClock(epochMs: number, zone: string): string {
  return formatWall(instantToWall(epochMs, ianaZone(zone)))
}
