// Shared helpers of the ical-read*.test.ts files: fixtures, inline calendars, default options.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CalendarEvent } from '../shared/types/calendar'
import { readCalendarObject } from '../app/utils/ical/read'
import type { ReadOptions, ReadResult } from '../app/utils/ical/read-types'

export function fixture(name: string): string {
  // Vitest runs from the repository root (`import.meta.url` is not a file URL in happy-dom).
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/ics', name), 'utf8')
}

/** The Europe/Berlin VTIMEZONE of the spike fixtures. */
export const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]

/** The two ways a test file can give Berlin: defined in the file, or left to the runtime's data. */
export const ZONE_SOURCES: [string, string[]][] = [
  ['VTIMEZONE in the file', BERLIN_VTIMEZONE],
  ['IANA zone', []],
]

export const STAMP = 'DTSTAMP:20261001T000000Z'

/** One VEVENT; a UID and DTSTAMP are added unless the lines bring their own. */
export function vevent(lines: string[], uid = 'test'): string[] {
  const all = [...lines]
  if (!all.some((line) => line.startsWith('UID'))) all.unshift(`UID:${uid}`)
  if (!all.some((line) => line.startsWith('DTSTAMP'))) all.push(STAMP)
  return ['BEGIN:VEVENT', ...all, 'END:VEVENT']
}

/** A VCALENDAR from lines (CRLF, as servers send it). */
export function calendar(...parts: (string[] | string)[]): string {
  return (
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...parts.flat(), 'END:VCALENDAR'].join(
      '\r\n',
    ) + '\r\n'
  )
}

export const WIDE_RANGE = {
  start: new Date('2020-01-01T00:00:00Z'),
  end: new Date('2030-01-01T00:00:00Z'),
}

export function options(extra: Partial<ReadOptions> = {}): ReadOptions {
  return {
    calendarId: 'dav:/caldav/u/c/',
    href: '/caldav/u/c/test.ics',
    displayTimeZone: 'Europe/Berlin',
    orgTimeZone: 'Europe/Berlin',
    range: WIDE_RANGE,
    ...extra,
  }
}

export function read(ics: string, extra: Partial<ReadOptions> = {}): ReadResult {
  return readCalendarObject(ics, options(extra))
}

export function range(start: string, end: string): { start: Date; end: Date } {
  return { start: new Date(start), end: new Date(end) }
}

/** `start - end title` per event: short enough to compare as a list. */
export function lines(events: CalendarEvent[]): string[] {
  return events.map((event) => `${event.start} - ${event.end} ${event.title}`)
}
