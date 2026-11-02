// A VTIMEZONE for an IANA zone, built from the runtime's own time zone data (Temporal over Intl);
// ical.js ships no zone data and no dependency is added for it. New events are written with
// `TZID=<IANA name>` and this block, so a client that does not know the name still places the time.
//
// Limits (documented, not hidden):
// - The block lists every offset change as its own STANDARD or DAYLIGHT observance (no RRULE) for the
//   years `anchorYear - 1` to `anchorYear + 25`. Before the first listed year the first offset is
//   assumed; after the last one, the last offset stays in force. A client that knows the IANA name
//   ignores the block, so this only matters to clients that read the block and look beyond it.
// - STANDARD/DAYLIGHT is a classification: an offset that rises and later returns to the previous
//   one is DAYLIGHT, everything else STANDARD. TZNAME is omitted (it is optional).
import { Temporal } from 'temporal-polyfill'
import { isValidTimeZone } from '../../../shared/utils/time-zone'
import { t } from '../i18n'
import { EditError } from './write-types'

/** Years before and after the anchor year that the generated block covers. */
export const VTIMEZONE_YEARS_BEFORE = 1
export const VTIMEZONE_YEARS_AFTER = 25

interface Transition {
  /** The instant of the change (epoch milliseconds). */
  at: number
  from: number
  to: number
}

function offsetSeconds(zdt: Temporal.ZonedDateTime): number {
  return zdt.offsetNanoseconds / 1e9
}

/** `+0100`, `-0430`, or with seconds `+005328` for historic offsets. */
export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+'
  const abs = Math.abs(seconds)
  const hours = Math.floor(abs / 3600)
  const minutes = Math.floor((abs % 3600) / 60)
  const rest = abs % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${sign}${two(hours)}${two(minutes)}${rest ? two(rest) : ''}`
}

/** The local time, in the offset before the change, at which an observance starts. */
function localStart(transition: Transition): string {
  return new Date(transition.at + transition.from * 1000)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')
}

/** The offset changes of a zone from 1 January of `fromYear` to the end of `toYear`. */
function transitionsBetween(zone: string, fromYear: number, toYear: number) {
  const start = Temporal.PlainDateTime.from({ year: fromYear, month: 1, day: 1 }).toZonedDateTime(
    zone,
  )
  const initial = offsetSeconds(start)
  const transitions: Transition[] = []
  let current = start
  let offset = initial
  // A zone has a handful of changes a year; the cap only guards against a broken runtime.
  for (let i = 0; i < 1000; i++) {
    const next = current.getTimeZoneTransition('next')
    if (!next || next.year > toYear) break
    const to = offsetSeconds(next)
    transitions.push({ at: next.epochMilliseconds, from: offset, to })
    offset = to
    current = next
  }
  return { initial, transitions }
}

/**
 * The content lines (no line breaks, not folded) of a VTIMEZONE for `zone`, valid per RFC 5545 §3.6.5.
 * Throws `invalid-input` when `zone` is not a time zone the runtime knows.
 */
export function generateVTimezone(zone: string, anchorYear: number): string[] {
  if (!isValidTimeZone(zone)) {
    throw new EditError('invalid-input', t('Unknown time zone: {zone}', { zone }))
  }
  const fromYear = anchorYear - VTIMEZONE_YEARS_BEFORE
  const toYear = anchorYear + VTIMEZONE_YEARS_AFTER
  const { initial, transitions } = transitionsBetween(zone, fromYear, toYear)

  const observances: Array<{
    daylight: boolean
    start: string
    from: number
    to: number
  }> = []

  // The offset in force when the block starts. It is DAYLIGHT only when the first change lowers it
  // and the next one raises it back (a southern-hemisphere zone that begins the year in summer time).
  const first = transitions[0]
  const second = transitions[1]
  const startsInDaylight = !!first && first.to < first.from && !!second && second.to === first.from
  observances.push({
    daylight: startsInDaylight,
    start: `${fromYear}0101T000000`,
    from: initial,
    to: initial,
  })
  transitions.forEach((transition, index) => {
    const next = transitions[index + 1]
    const daylight = transition.to > transition.from && !!next && next.to === transition.from
    observances.push({
      daylight,
      start: localStart(transition),
      from: transition.from,
      to: transition.to,
    })
  })

  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, `X-LIC-LOCATION:${zone}`]
  for (const observance of observances) {
    const name = observance.daylight ? 'DAYLIGHT' : 'STANDARD'
    lines.push(
      `BEGIN:${name}`,
      `DTSTART:${observance.start}`,
      `TZOFFSETFROM:${formatOffset(observance.from)}`,
      `TZOFFSETTO:${formatOffset(observance.to)}`,
      `END:${name}`,
    )
  }
  lines.push('END:VTIMEZONE')
  return lines
}
