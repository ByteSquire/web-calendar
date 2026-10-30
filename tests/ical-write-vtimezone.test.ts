// @vitest-environment node
// The generated VTIMEZONE must be valid iCalendar and must agree with the runtime's own zone data
// (Intl) on the UTC offset: checked across daylight-saving changes in several hemispheres, a zone
// with a half-hour offset and one without daylight saving.
import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import {
  formatOffset,
  generateVTimezone,
  VTIMEZONE_YEARS_AFTER,
  VTIMEZONE_YEARS_BEFORE,
} from '../app/utils/ical/vtimezone'
import { EditError } from '../app/utils/ical/write'

/** The UTC offset of a zone at an instant, in seconds, read from Intl (not from Temporal). */
function intlOffset(zone: string, at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')!.value
  const match = /GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(part)!
  if (!match[1]) return 0
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)
  return match[1] === '-' ? -seconds : seconds
}

function parsed(zone: string, anchorYear: number): { lines: string[]; tz: ICAL.Timezone } {
  const lines = generateVTimezone(zone, anchorYear)
  const component = ICAL.Component.fromString(lines.join('\r\n'))
  return { lines, tz: new ICAL.Timezone(component) }
}

const HOUR = 3_600_000

/** The offset ical.js reads from the generated block for a local wall clock. */
function offsetAtWall(tz: ICAL.Timezone, wall: string): number {
  const time = ICAL.Time.fromDateTimeString(wall)
  time.zone = tz
  return time.utcOffset()
}

/**
 * The offset ical.js reads from the generated block at an instant, asked through the local time
 * (ical.js converts UTC to local approximately near a change). Null within a few hours of a change,
 * where the local time can be missing or happen twice and clients read it in their own way.
 */
function blockOffset(tz: ICAL.Timezone, zone: string, at: Date): number | null {
  const offset = intlOffset(zone, at)
  for (const hours of [-3.5, 3.5]) {
    if (intlOffset(zone, new Date(at.getTime() + hours * HOUR)) !== offset) return null
  }
  return offsetAtWall(tz, new Date(at.getTime() + offset * 1000).toISOString().slice(0, 19))
}

const ZONES = [
  'Europe/Berlin',
  'America/New_York',
  'Australia/Sydney',
  'Asia/Kolkata',
  'Asia/Tokyo',
]

describe('generated VTIMEZONE', () => {
  it.each(ZONES)(
    '%s agrees with Intl on the second of every month for the whole window',
    (zone) => {
      const { tz } = parsed(zone, 2026)
      for (let year = 2026 - VTIMEZONE_YEARS_BEFORE; year <= 2026 + VTIMEZONE_YEARS_AFTER; year++) {
        for (let month = 0; month < 12; month++) {
          for (const hour of [0, 12]) {
            const at = new Date(Date.UTC(year, month, 2, hour))
            expect(blockOffset(tz, zone, at), `${zone} ${at.toISOString()}`).toSatisfy(
              (offset: number | null) => offset === null || offset === intlOffset(zone, at),
            )
          }
        }
      }
    },
  )

  it.each([
    // [zone, a local time well before the change, its offset, a local time after, its offset]
    ['Europe/Berlin', '2026-03-29T01:00:00', 3600, '2026-03-29T04:00:00', 7200],
    ['Europe/Berlin', '2026-10-25T01:00:00', 7200, '2026-10-25T04:00:00', 3600],
    ['America/New_York', '2026-03-08T01:00:00', -18000, '2026-03-08T04:00:00', -14400],
    ['America/New_York', '2026-11-01T00:00:00', -14400, '2026-11-01T03:00:00', -18000],
    ['Australia/Sydney', '2026-04-05T01:00:00', 39600, '2026-04-05T04:00:00', 36000],
    ['Australia/Sydney', '2026-10-04T01:00:00', 36000, '2026-10-04T04:00:00', 39600],
  ] as const)(
    '%s switches on the right day (%s)',
    (zone, before, offsetBefore, after, offsetAfter) => {
      const { tz } = parsed(zone, 2026)
      expect(offsetAtWall(tz, before)).toBe(offsetBefore)
      expect(offsetAtWall(tz, after)).toBe(offsetAfter)
      // The same facts according to Intl.
      expect(intlOffset(zone, new Date(Date.parse(`${before}Z`) - offsetBefore * 1000))).toBe(
        offsetBefore,
      )
      expect(intlOffset(zone, new Date(Date.parse(`${after}Z`) - offsetAfter * 1000))).toBe(
        offsetAfter,
      )
    },
  )

  it('reads local times through the block the way an RFC 5545 client does', () => {
    const { tz } = parsed('Europe/Berlin', 2026)
    const local = (wall: string) => {
      const time = ICAL.Time.fromDateTimeString(wall)
      time.zone = tz
      return time.utcOffset()
    }
    expect(local('2026-07-01T12:00:00')).toBe(7200)
    expect(local('2026-12-01T12:00:00')).toBe(3600)
  })

  it('has one observance for a zone without daylight saving', () => {
    for (const [zone, offset] of [
      ['Asia/Tokyo', '+0900'],
      ['Asia/Kolkata', '+0530'],
    ] as const) {
      const { lines } = parsed(zone, 2026)
      expect(lines.filter((l) => l.startsWith('BEGIN:STANDARD'))).toHaveLength(1)
      expect(lines.filter((l) => l.startsWith('BEGIN:DAYLIGHT'))).toHaveLength(0)
      expect(lines).toContain(`TZOFFSETFROM:${offset}`)
      expect(lines).toContain(`TZOFFSETTO:${offset}`)
    }
  })

  it('is structured as RFC 5545 §3.6.5 asks', () => {
    const { lines } = parsed('Europe/Berlin', 2026)
    expect(lines[0]).toBe('BEGIN:VTIMEZONE')
    expect(lines[1]).toBe('TZID:Europe/Berlin')
    expect(lines.at(-1)).toBe('END:VTIMEZONE')
    // Explicit observances only, no RRULE; each has DTSTART, TZOFFSETFROM and TZOFFSETTO.
    expect(lines.some((l) => l.startsWith('RRULE'))).toBe(false)
    const starts = lines.filter((l) => l.startsWith('DTSTART:')).map((l) => l.slice(8))
    expect(starts).toEqual([...starts].sort())
    expect(starts[0]).toBe('20250101T000000')
    // The first observance plus a pair per year over the window.
    expect(starts).toHaveLength(1 + 2 * (VTIMEZONE_YEARS_BEFORE + 1 + VTIMEZONE_YEARS_AFTER))
    expect(lines.filter((l) => l.startsWith('TZOFFSETFROM'))).toHaveLength(starts.length)
    expect(lines.filter((l) => l.startsWith('TZOFFSETTO'))).toHaveLength(starts.length)
    // Each observance starts from the offset the previous one ended with.
    const from = lines.filter((l) => l.startsWith('TZOFFSETFROM:')).map((l) => l.slice(13))
    const to = lines.filter((l) => l.startsWith('TZOFFSETTO:')).map((l) => l.slice(11))
    from.slice(1).forEach((value, i) => expect(value).toBe(to[i]))
    // Spring forward is DAYLIGHT, fall back is STANDARD, with the local time before the change.
    const at = lines.indexOf('DTSTART:20260329T020000')
    expect(lines[at - 1]).toBe('BEGIN:DAYLIGHT')
    expect(lines.slice(at, at + 3)).toEqual([
      'DTSTART:20260329T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
    ])
    const back = lines.indexOf('DTSTART:20261025T030000')
    expect(lines[back - 1]).toBe('BEGIN:STANDARD')
    expect(lines.slice(back, back + 3)).toEqual([
      'DTSTART:20261025T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
    ])
  })

  it('starts a southern-hemisphere zone in daylight time when the year starts there', () => {
    const { lines } = parsed('Australia/Sydney', 2026)
    expect(lines[3]).toBe('BEGIN:DAYLIGHT')
    expect(lines.slice(4, 7)).toEqual([
      'DTSTART:20250101T000000',
      'TZOFFSETFROM:+1100',
      'TZOFFSETTO:+1100',
    ])
  })

  it('is anchored on the year given', () => {
    const { lines, tz } = parsed('Europe/Berlin', 2040)
    expect(lines).toContain('DTSTART:20390101T000000')
    expect(lines).toContain('DTSTART:20400325T020000')
    expect(offsetAtWall(tz, '2040-07-01T12:00:00')).toBe(7200)
    expect(offsetAtWall(tz, '2040-01-15T12:00:00')).toBe(3600)
  })

  it.each([
    ['America/Sao_Paulo', 2018], // abolished daylight saving in 2019
    ['Europe/Dublin', 2026], // winter time is the "daylight" side
    ['Pacific/Chatham', 2026], // +1245 / +1345
    ['Australia/Lord_Howe', 2026], // a 30-minute daylight saving
    ['Africa/Casablanca', 2026], // changes for Ramadan
    ['UTC', 2026],
  ])('%s agrees with Intl at every offset change in the window', (zone, anchor) => {
    const { tz } = parsed(zone, anchor)
    const start = Date.UTC(anchor - 1, 0, 3)
    const end = Date.UTC(anchor + 25, 0, 1)
    // Samples every 61 hours over the window: every change is crossed, and the sampled hour of the
    // day keeps moving.
    let checked = 0
    for (let t = start; t < end; t += 61 * HOUR) {
      const at = new Date(t)
      const offset = blockOffset(tz, zone, at)
      if (offset === null) continue
      checked++
      expect(offset, `${zone} ${at.toISOString()}`).toBe(intlOffset(zone, at))
    }
    expect(checked).toBeGreaterThan(3000)
  })

  it('formats offsets with seconds only when a historic offset needs them', () => {
    expect(formatOffset(3600)).toBe('+0100')
    expect(formatOffset(-16200)).toBe('-0430')
    expect(formatOffset(0)).toBe('+0000')
    expect(formatOffset(19800)).toBe('+0530')
    expect(formatOffset(3 * 3600 + 53 * 60 + 28)).toBe('+035328')
  })

  it('refuses a name that is not a time zone', () => {
    for (const zone of [
      '',
      'Mars/Olympus',
      'Europe/Berlin\r\nX-EVIL:1',
      'W. Europe Standard Time',
    ]) {
      try {
        generateVTimezone(zone, 2026)
        throw new Error(`accepted ${JSON.stringify(zone)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(EditError)
        expect((error as EditError).code).toBe('invalid-input')
      }
    }
  })
})
