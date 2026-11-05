// Busy times as the calendar view shows them: what a free/busy share (and a calendar link at that
// level) gets from Radicale is a VFREEBUSY of `FREEBUSY;FBTYPE=…:start/end` periods in UTC, with
// series already expanded and transparent events left out, and nothing else of the events. Each
// period becomes a "Busy" entry (`isBlocked`) in the viewer's zone; BUSY-TENTATIVE is tentative,
// FREE periods are left out. All-day events arrive as UTC midnight to midnight and are shown as
// such, converted like every other period.
import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent, EventStatus } from '../../../shared/types/calendar'

/** RFC 5545 lines: a line that starts with a space or tab continues the previous one. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

/** `20261105T170000Z` as an instant; null for anything else. */
function utcInstant(value: string): Temporal.Instant | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  try {
    return Temporal.Instant.from(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  } catch {
    return null
  }
}

/** The end of a period: an instant, or the start plus a duration (`PT30M`). */
function periodEnd(start: Temporal.Instant, value: string): Temporal.Instant | null {
  const instant = utcInstant(value)
  if (instant) return instant
  try {
    return start.toZonedDateTimeISO('UTC').add(Temporal.Duration.from(value.trim())).toInstant()
  } catch {
    return null
  }
}

const wallClock = (instant: Temporal.Instant, zone: string) =>
  instant.toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: 'second' })

export interface BusyPeriod {
  start: Temporal.Instant
  end: Temporal.Instant
  tentative: boolean
}

/** The busy periods of a VFREEBUSY text, in order; unreadable periods are left out. */
export function busyPeriods(text: string): BusyPeriod[] {
  const periods: BusyPeriod[] = []
  for (const line of unfold(text)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const [name, ...params] = line.slice(0, colon).split(';')
    if (name?.toUpperCase() !== 'FREEBUSY') continue
    const fbtype =
      params
        .find((param) => param.toUpperCase().startsWith('FBTYPE='))
        ?.slice(7)
        .toUpperCase() ?? 'BUSY'
    if (fbtype === 'FREE') continue
    for (const period of line.slice(colon + 1).split(',')) {
      const [from, to] = period.split('/')
      const start = from ? utcInstant(from) : null
      const end = start && to ? periodEnd(start, to) : null
      if (!start || !end || Temporal.Instant.compare(end, start) <= 0) continue
      periods.push({ start, end, tentative: fbtype === 'BUSY-TENTATIVE' })
    }
  }
  return periods.sort((a, b) => Temporal.Instant.compare(a.start, b.start))
}

/**
 * The busy periods as events of `calendarId`, wall-clock strings in `displayTimeZone`; with `range`,
 * only the periods that overlap it.
 */
export function freeBusyEvents(
  text: string,
  context: { calendarId: string; displayTimeZone: string; range?: { start: Date; end: Date } },
): CalendarEvent[] {
  const { range } = context
  const periods = busyPeriods(text).filter(
    (period) =>
      !range ||
      (period.end.epochMilliseconds > range.start.getTime() &&
        period.start.epochMilliseconds < range.end.getTime()),
  )
  // An id of its own times, so a block keeps it whatever else the range holds; the same period
  // twice is one block.
  const seen = new Set<string>()
  return periods.flatMap((period): CalendarEvent[] => {
    const key = `${period.start.epochMilliseconds}-${period.end.epochMilliseconds}`
    if (seen.has(key)) return []
    seen.add(key)
    const status: EventStatus = period.tentative ? 'tentative' : 'confirmed'
    const event: CalendarEvent = {
      id: `${context.calendarId}|busy|${key}`,
      calendarId: context.calendarId,
      uid: `busy-${key}`,
      title: '',
      start: wallClock(period.start, context.displayTimeZone),
      end: wallClock(period.end, context.displayTimeZone),
      allDay: false,
      status,
      categoryIds: [],
      isBlocked: true,
    }
    return [event]
  })
}
