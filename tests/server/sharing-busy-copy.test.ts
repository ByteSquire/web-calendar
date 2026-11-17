// @vitest-environment node
// The "Busy" copy of an event for a calendar shared at "Busy times only" (design §8): only what an
// allow-list keeps gets out, and what free/busy leaves out is left out.
import { describe, expect, it } from 'vitest'
import { busyCopy, busyEntries, busyToken } from '../../server/utils/sharing/busy-copy'

const cal = (...lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Secret Corp//Mailer 7//EN',
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n')

/** Every property name of the copy's content lines (folded lines joined first). */
function names(ics: string): string[] {
  return ics
    .replace(/\r\n /g, '')
    .split('\r\n')
    .filter(Boolean)
    .map((line) => line.split(/[;:]/)[0]!)
}

const ALLOWED = new Set([
  'BEGIN',
  'END',
  'VERSION',
  'PRODID',
  'UID',
  'DTSTAMP',
  'DTSTART',
  'DTEND',
  'DURATION',
  'RECURRENCE-ID',
  'RRULE',
  'RDATE',
  'EXDATE',
  'STATUS',
  'SUMMARY',
  'TZID',
  'TZOFFSETFROM',
  'TZOFFSETTO',
  'TZNAME',
])

const PACKED = cal(
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'X-LIC-LOCATION:Europe/Berlin-secret-tz',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'X-SECRET-TZ:secret-tz-x',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VTIMEZONE',
  'TZID:America/Unused',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:secret-uid-alice@mail.example.org',
  'DTSTAMP:20261101T081234Z',
  'CREATED:20261101T081234Z',
  'LAST-MODIFIED:20261102T091234Z',
  'SEQUENCE:7',
  'DTSTART;TZID=Europe/Berlin;X-SECRET-PARAM=secret-param:20261105T090000',
  'DTEND;TZID=Europe/Berlin:20261105T100000',
  'SUMMARY;LANGUAGE=en;ALTREP="http://secret.example.org/altrep":Secret title',
  'DESCRIPTION:Secret description',
  'LOCATION;ALTREP="http://secret.example.org/room":Secret place',
  'GEO:52.5;13.4',
  'ORGANIZER;CN=Secret Organizer:mailto:organizer@secret.example.org',
  'ATTENDEE;CN=Secret Attendee;ROLE=REQ-PARTICIPANT:mailto:attendee@secret.example.org',
  'CATEGORIES:Secret category',
  'COMMENT:Secret comment',
  'CONTACT:Secret contact',
  'RESOURCES:Secret resource',
  'URL:http://secret.example.org/event',
  'ATTACH;ENCODING=BASE64;VALUE=BINARY:c2VjcmV0LWF0dGFjaA==',
  'ATTACH:http://secret.example.org/file',
  'CLASS:CONFIDENTIAL',
  'PRIORITY:1',
  'COLOR:secret-colour',
  'CONFERENCE:http://secret.example.org/meet',
  'IMAGE:http://secret.example.org/img',
  'X-MOZ-GENERATION:secret-moz',
  'X-SECRET:secret-x',
  'STATUS:CONFIRMED',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Secret alarm',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
)

describe('the busy copy', () => {
  it('lets out nothing but the allowed properties and parameters', () => {
    const entry = busyCopy(12, PACKED)!
    expect(entry).not.toBeNull()
    for (const name of names(entry.ics)) expect(ALLOWED.has(name), name).toBe(true)
    const flat = entry.ics.replace(/\r\n /g, '')
    expect(flat.toLowerCase()).not.toContain('secret')
    expect(flat).not.toContain('20261101T081234Z')
    expect(flat).not.toContain('America/Unused')
    expect(flat).toContain('DTSTART;TZID=Europe/Berlin:20261105T090000')
    expect(flat).toContain('DTEND;TZID=Europe/Berlin:20261105T100000')
    expect(flat).toContain('SUMMARY:Busy')
    expect(flat).toContain('TZNAME:CET')
    expect(flat).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU')
    // a confirmed event is plain busy
    expect(flat).not.toContain('STATUS')
    expect(entry.name).toMatch(/^[0-9a-f]{32}\.ics$/)
    expect(entry.etag).toMatch(/^"[0-9a-f]{32}"$/)
  })

  it('keeps the repeats, turns a cancelled or free occurrence into an excluded date, and marks tentative ones', () => {
    const entry = busyCopy(
      3,
      cal(
        'BEGIN:VEVENT',
        'UID:series',
        'DTSTART:20261102T080000Z',
        'DURATION:PT1H',
        'RRULE:FREQ=WEEKLY;COUNT=10;X-NAME=secret',
        'EXDATE:20261109T080000Z',
        'SUMMARY:Standup',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series',
        'RECURRENCE-ID:20261116T080000Z',
        'DTSTART:20261116T080000Z',
        'DTEND:20261116T090000Z',
        'STATUS:CANCELLED',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series',
        'RECURRENCE-ID:20261123T080000Z',
        'DTSTART:20261123T080000Z',
        'DTEND:20261123T090000Z',
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:series',
        'RECURRENCE-ID:20261130T080000Z',
        'DTSTART:20261130T100000Z',
        'DTEND:20261130T110000Z',
        'STATUS:TENTATIVE',
        'SUMMARY:Moved standup',
        'END:VEVENT',
      ),
    )!
    const flat = entry.ics.replace(/\r\n /g, '')
    expect(flat).toContain('DURATION:PT1H')
    // an RRULE with a part that is not allowed is left out as a whole
    expect(flat).not.toContain('RRULE')
    expect(flat).toContain('EXDATE:20261109T080000Z')
    expect(flat).toContain('EXDATE:20261116T080000Z')
    expect(flat).toContain('EXDATE:20261123T080000Z')
    expect(flat.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    expect(flat).toContain('RECURRENCE-ID:20261130T080000Z')
    expect(flat).toContain('STATUS:TENTATIVE')
    expect(flat).not.toContain('standup')
  })

  it('leaves out a cancelled or free series, tasks, and what it cannot read', () => {
    const event = (...extra: string[]) =>
      cal('BEGIN:VEVENT', 'UID:x', 'DTSTART:20261105T090000Z', ...extra, 'END:VEVENT')
    expect(busyCopy(1, event('STATUS:CANCELLED'))).toBeNull()
    expect(busyCopy(1, event('TRANSP:TRANSPARENT'))).toBeNull()
    expect(busyCopy(1, cal('BEGIN:VTODO', 'UID:t', 'SUMMARY:Secret task', 'END:VTODO'))).toBeNull()
    expect(busyCopy(1, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n')).toBeNull()
    // a start it cannot vouch for, or a time zone name with odd characters
    expect(busyCopy(1, cal('BEGIN:VEVENT', 'UID:x', 'DTSTART:tomorrow', 'END:VEVENT'))).toBeNull()
    expect(
      busyCopy(
        1,
        cal('BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID="a:b";X=1:20261105T090000', 'END:VEVENT'),
      ),
    ).toBeNull()
    expect(busyCopy(1, cal('BEGIN:VEVENT', 'DTSTART:20261105T090000Z', 'END:VEVENT'))).toBeNull()
  })

  it('keeps an occurrence that has no series, and all-day dates', () => {
    const orphan = busyCopy(
      1,
      cal(
        'BEGIN:VEVENT',
        'UID:o',
        'RECURRENCE-ID;VALUE=DATE:20261105',
        'DTSTART;VALUE=DATE:20261105',
        'DTEND;VALUE=DATE:20261106',
        'END:VEVENT',
      ),
    )!
    const flat = orphan.ics.replace(/\r\n /g, '')
    expect(flat).toContain('RECURRENCE-ID;VALUE=DATE:20261105')
    expect(flat).toContain('DTSTART;VALUE=DATE:20261105')
  })

  it('hides the UID by calendar, and changes its ETag only when the busy time changes', () => {
    const at = (title: string, start: string) =>
      cal('BEGIN:VEVENT', 'UID:same', `DTSTART:${start}`, `SUMMARY:${title}`, 'END:VEVENT')
    const one = busyCopy(1, at('A', '20261105T090000Z'))!
    expect(busyCopy(2, at('A', '20261105T090000Z'))!.name).not.toBe(one.name)
    expect(busyCopy(1, at('Renamed', '20261105T090000Z'))!.etag).toBe(one.etag)
    expect(busyCopy(1, at('A', '20261105T100000Z'))!.etag).not.toBe(one.etag)

    const before = busyEntries(1, [at('A', '20261105T090000Z')])
    expect(busyToken(busyEntries(1, [at('Renamed', '20261105T090000Z')]))).toBe(busyToken(before))
    expect(busyToken(busyEntries(1, [at('A', '20261105T100000Z')]))).not.toBe(busyToken(before))
    expect(busyToken([])).not.toBe(busyToken(before))
  })
})
