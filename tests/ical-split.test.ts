// @vitest-environment node
// FR-7, importing a file: a calendar file becomes one CalDAV resource per UID. A recurring event
// stays in one resource with its overrides, every line comes out as it went in, and a damaged or
// unwanted component costs only itself (NFR-4). The file is untrusted.
import { describe, expect, it } from 'vitest'
import { splitCalendar, type SplitResource } from '../app/utils/ical/split'
import { fixture } from './ical-read-helpers'
import { contentLines, expand, splitEvents, wrapCalendar } from './ical-write-helpers'

const vevent = (lines: string[]): string[] => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
const stamp = 'DTSTAMP:20261001T080000Z'
const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'

const byUid = (resources: SplitResource[], uid: string): SplitResource => {
  const found = resources.find((resource) => resource.uid === uid)
  if (!found) throw new Error(`no resource for ${uid}: ${resources.map((r) => r.uid).join(', ')}`)
  return found
}

/** The TZIDs of the VTIMEZONEs a resource carries, in order. */
const zonesOf = (ics: string): string[] =>
  contentLines(ics)
    .filter(
      (line, index, lines) => line.startsWith('TZID:') && lines[index - 1] === 'BEGIN:VTIMEZONE',
    )
    .map((line) => line.slice(5))

describe('a recurring event and its overrides', () => {
  it('stay in one resource, in file order, even when other events sit between them', async () => {
    const { resources, problem } = await splitCalendar(fixture('import-recurring-overrides.ics'))
    expect(problem).toBeNull()
    expect(resources.map((r) => [r.uid, r.events])).toEqual([
      ['series-1@example.com', 3],
      ['single-1@example.com', 1],
    ])
    const series = byUid(resources, 'series-1@example.com')
    expect(series.summary).toBe('Weekly planning')
    expect(
      splitEvents(series.ics).map((event) => event.find((l) => l.startsWith('SUMMARY'))),
    ).toEqual([
      'SUMMARY:Weekly planning',
      'SUMMARY:Weekly planning (moved)',
      'SUMMARY:Weekly planning (shorter)',
    ])
  })

  it('is read by an independent client as the same series, overrides applied', async () => {
    const { resources } = await splitCalendar(fixture('import-recurring-overrides.ics'))
    const occurrences = expand(byUid(resources, 'series-1@example.com').ics)
    expect(occurrences).toHaveLength(6)
    expect(occurrences.map((o) => o.summary)).toEqual([
      'Weekly planning',
      'Weekly planning (moved)',
      'Weekly planning (shorter)',
      'Weekly planning',
      'Weekly planning',
      'Weekly planning',
    ])
    // The moved one starts at 14:00 Berlin, which is 12:00 UTC in summer time.
    expect(occurrences[1]?.utc).toBe('2026-10-19T12:00:00.000Z')
    expect(occurrences[2]?.endUtc).toBe('2026-10-26T08:30:00.000Z')
  })

  it('come out line by line as they went in, folds and odd parameters included (X- properties apart)', async () => {
    const { resources } = await splitCalendar(fixture('import-recurring-overrides.ics'))
    const { ics } = byUid(resources, 'series-1@example.com')
    expect(ics).toContain(
      'DESCRIPTION:Agenda: this line is long enough to be folded by a careful clien\r\n' +
        ' t, and the fold must come out exactly as it went in.\r\n',
    )
    // X- properties of an imported event are removed (see ical-x-properties.test.ts).
    expect(ics).not.toContain('X-CUSTOM')
    expect(ics).toContain(
      ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM']
        .map((line) => `${line}\r\n`)
        .join(''),
    )
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=6\r\n')
    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261019T090000\r\n')
  })
})

describe('the calendar around each resource', () => {
  it('is a VCALENDAR of its own with VERSION and the file’s PRODID, CRLF throughout', async () => {
    const { resources } = await splitCalendar(fixture('import-recurring-overrides.ics'))
    const { ics } = byUid(resources, 'single-1@example.com')
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Mozilla.org/NONSGML')).toBe(
      true,
    )
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true)
    expect(ics).not.toMatch(/[^\r]\n|\r[^\n]/)
  })

  it('leaves out what describes the file and not the event (METHOD, X-WR-CALNAME)', async () => {
    const { resources, calendarName } = await splitCalendar(
      fixture('import-recurring-overrides.ics'),
    )
    expect(calendarName).toBe('Team calendar')
    for (const { ics } of resources) {
      expect(ics).not.toContain('METHOD')
      expect(ics).not.toContain('X-WR-CALNAME')
    }
  })

  it('has the writer’s PRODID when the file has none or an empty one', async () => {
    for (const lines of [[], ['PRODID:']]) {
      const text = crlf([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        ...lines,
        ...vevent(['UID:a', 'DTSTART:20261110T100000Z']),
        'END:VCALENDAR',
      ])
      const { resources } = await splitCalendar(text)
      expect(resources[0]?.ics).toContain('PRODID:-//web-calendar//Web Calendar//EN\r\n')
    }
  })

  it('names the calendar after X-WR-CALNAME, else NAME, and unescapes it', async () => {
    const both = crlf([
      'BEGIN:VCALENDAR',
      'NAME:Second',
      'X-WR-CALNAME:First\\, escaped',
      'END:VCALENDAR',
    ])
    expect((await splitCalendar(both)).calendarName).toBe('First, escaped')
    expect((await splitCalendar(fixture('import-mixed.ics'))).calendarName).toBe('Projects')
    expect((await splitCalendar(fixture('feed.ics'))).calendarName).toBe('Holidays')
    expect((await splitCalendar(fixture('d-floating.ics'))).calendarName).toBeNull()
  })

  it('keeps the original PRODID line of a file that folds it', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      'PRODID:-//Some Very Long Vendor Name//Some Very Long Product Name V12.3.4567//EN',
      '  and a second part',
      'VERSION:2.0',
      ...vevent(['UID:a', 'DTSTART:20261110T100000Z']),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(resources[0]?.ics).toContain(
      'PRODID:-//Some Very Long Vendor Name//Some Very Long Product Name V12.3.4567//EN\r\n  and a second part\r\n',
    )
  })
})

describe('time zones', () => {
  it('puts every VTIMEZONE a resource refers to into it, and only those', async () => {
    const { resources } = await splitCalendar(fixture('import-two-timezones.ics'))
    expect(resources).toHaveLength(6)
    const zones = Object.fromEntries(resources.map((r) => [r.uid, zonesOf(r.ics)]))
    expect(zones).toEqual({
      'berlin-only': ['Europe/Berlin'],
      'new-york-only': ['America/New_York'],
      // DTSTART in New York, DTEND in Berlin: both definitions, in the order they are used.
      'both-zones': ['America/New_York', 'Europe/Berlin'],
      'quoted-zone': ['Europe/Berlin'],
      'utc-only': [],
      'undefined-zone': [],
    })
    // Tokyo is defined and never used.
    expect(resources.some((r) => r.ics.includes('Asia/Tokyo'))).toBe(false)
  })

  it('copies a VTIMEZONE as it was written, and an event with a zone the file lacks as it is', async () => {
    const { resources } = await splitCalendar(fixture('import-two-timezones.ics'))
    expect(byUid(resources, 'new-york-only').ics).toContain(
      ['BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:STANDARD', 'DTSTART:19701101T020000']
        .map((line) => `${line}\r\n`)
        .join(''),
    )
    expect(byUid(resources, 'undefined-zone').ics).toContain(
      'DTSTART;TZID=Europe/Paris:20261115T090000\r\n',
    )
  })

  it('finds a TZID in EXDATE, RDATE and a nested component too, and VTIMEZONEs after the events', async () => {
    const zone = (tzid: string) => [
      'BEGIN:VTIMEZONE',
      `TZID:${tzid}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]
    const text = crlf([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...vevent([
        'UID:a',
        'DTSTART;TZID=Zone/One:20261110T100000',
        'EXDATE;TZID=Zone/Two:20261117T100000',
        'RDATE;TZID=Zone/Three:20261201T100000',
        'BEGIN:VALARM',
        'TRIGGER;VALUE=DATE-TIME;TZID=Zone/Four:20261110T090000',
        'END:VALARM',
      ]),
      ...zone('Zone/Four'),
      ...zone('Zone/Three'),
      ...zone('Zone/Two'),
      ...zone('Zone/One'),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(zonesOf(resources[0]!.ics)).toEqual(['Zone/One', 'Zone/Two', 'Zone/Three', 'Zone/Four'])
  })

  it('takes the first definition when a file defines a zone twice', async () => {
    const zone = (offset: string) => [
      'BEGIN:VTIMEZONE',
      'TZID:Zone/One',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      'END:STANDARD',
      'END:VTIMEZONE',
    ]
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...zone('+0100'),
      ...zone('+0200'),
      ...vevent(['UID:a', 'DTSTART;TZID=Zone/One:20261110T100000']),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(resources[0]?.ics).toContain('TZOFFSETTO:+0100')
    expect(resources[0]?.ics).not.toContain('+0200')
  })
})

describe('what is not imported', () => {
  it('counts to-dos, journal entries and free/busy blocks with the reason, and imports the events', async () => {
    const { resources, skipped } = await splitCalendar(fixture('feed.ics'))
    expect(resources.map((r) => r.uid)).toEqual(['holiday-1', 'holiday-2', 'holiday-3'])
    expect(skipped).toEqual([
      { reason: 'not-an-event', component: 'VTODO', summary: 'Not an event' },
      { reason: 'not-an-event', component: 'VJOURNAL', summary: 'Not an event either' },
    ])
  })

  it('goes through a mixed file component by component', async () => {
    const { resources, skipped, problem } = await splitCalendar(fixture('import-mixed.ics'))
    expect(problem).toBeNull()
    expect(resources.map((r) => r.summary)).toEqual([
      'Kick-off',
      'No UID at all',
      'Twice in the file (first)',
      'Right after the cut-off one',
      'Review',
    ])
    expect(skipped.map((s) => [s.reason, s.component, s.summary])).toEqual([
      ['not-an-event', 'VTODO', 'Write the report'],
      ['not-an-event', 'VJOURNAL', 'Notes'],
      ['not-an-event', 'VFREEBUSY', ''],
      ['no-start', 'VEVENT', 'No DTSTART either'],
      ['duplicate', 'VEVENT', 'Twice in the file (second)'],
      ['damaged', 'VEVENT', 'Cut off, no END line'],
      ['damaged', 'VEVENT', 'Alarm never ends'],
    ])
  })

  it('keeps the first of two events with the same UID and no RECURRENCE-ID', async () => {
    const { resources } = await splitCalendar(fixture('import-mixed.ics'))
    const dup = byUid(resources, 'dup-1')
    expect(dup.events).toBe(1)
    expect(dup.ics).toContain('SUMMARY:Twice in the file (first)')
    expect(dup.ics).not.toContain('(second)')
  })

  it('skips an override that repeats an earlier one, and keeps overrides without a master', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...vevent([
        'UID:a',
        'RECURRENCE-ID:20261110T100000Z',
        'DTSTART:20261110T110000Z',
        'SUMMARY:one',
      ]),
      ...vevent([
        'UID:a',
        'RECURRENCE-ID:20261110T100000Z',
        'DTSTART:20261110T120000Z',
        'SUMMARY:again',
      ]),
      ...vevent([
        'UID:a',
        'RECURRENCE-ID:20261117T100000Z',
        'DTSTART:20261117T110000Z',
        'SUMMARY:other',
      ]),
      'END:VCALENDAR',
    ])
    const { resources, skipped } = await splitCalendar(text)
    expect(resources.map((r) => [r.uid, r.events, r.summary])).toEqual([['a', 2, 'one']])
    expect(skipped.map((s) => s.reason)).toEqual(['duplicate'])
  })

  it('does not take a component without END for an event, and reads on after it', async () => {
    const { resources, skipped } = await splitCalendar(fixture('import-mixed.ics'))
    expect(resources.map((r) => r.uid)).toContain('after-cut-off')
    expect(resources.map((r) => r.uid)).not.toContain('missing-end')
    expect(skipped.filter((s) => s.reason === 'damaged')).toHaveLength(2)
  })

  it('skips a stray END, a crossed END and an END of another component', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...vevent(['UID:stray', 'DTSTART:20261110T100000Z', 'END:VALARM']),
      ...vevent(['UID:crossed', 'DTSTART:20261110T100000Z', 'BEGIN:VALARM', 'END:VEVENT']),
      ...vevent(['UID:good', 'DTSTART:20261110T100000Z']),
      'END:VCALENDAR',
    ])
    const { resources, skipped } = await splitCalendar(text)
    expect(resources.map((r) => r.uid)).toEqual(['good'])
    expect(skipped).toHaveLength(2)
  })

  it('imports events outside any VCALENDAR and ends a calendar that is cut off', async () => {
    const text = crlf([
      ...vevent(['UID:bare', 'DTSTART:20261110T100000Z']),
      'BEGIN:VCALENDAR',
      ...vevent(['UID:cut', 'DTSTART:20261110T100000Z']),
    ])
    const { resources } = await splitCalendar(text)
    expect(resources.map((r) => r.uid)).toEqual(['bare', 'cut'])
  })

  it('reads several calendars in one file and takes the PRODID of the first', async () => {
    const calendar = (prodid: string, uid: string) => [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${prodid}`,
      ...vevent([`UID:${uid}`, 'DTSTART:20261110T100000Z']),
      'END:VCALENDAR',
    ]
    const { resources } = await splitCalendar(
      crlf([...calendar('-//One//EN', 'a'), ...calendar('-//Two//EN', 'b')]),
    )
    expect(resources.map((r) => r.uid)).toEqual(['a', 'b'])
    expect(resources.every((r) => r.ics.includes('PRODID:-//One//EN'))).toBe(true)
  })
})

describe('events without a UID', () => {
  const text = (summary: string) =>
    crlf([
      'BEGIN:VCALENDAR',
      ...vevent(['DTSTART:20261110T100000Z', stamp, `SUMMARY:${summary}`]),
      'END:VCALENDAR',
    ])

  it('get one made from their own lines, written into the resource', async () => {
    const { resources } = await splitCalendar(text('Nameless'))
    const [only] = resources
    expect(only?.uid).toMatch(/^[0-9a-f]{32}@web-calendar\.invalid$/)
    expect(only?.ics).toContain(`UID:${only?.uid}\r\n`)
    expect(only?.ics).toContain('SUMMARY:Nameless\r\n')
  })

  it('get the same UID every time, so importing the file again finds the event again', async () => {
    const first = await splitCalendar(text('Nameless'))
    const second = await splitCalendar(text('Nameless'))
    expect(second.resources[0]?.uid).toBe(first.resources[0]?.uid)
    expect((await splitCalendar(text('Another'))).resources[0]?.uid).not.toBe(
      first.resources[0]?.uid,
    )
  })

  it('are told apart by their lines, an empty UID counting as none, and a copy is a duplicate', async () => {
    const event = (uid: string) => vevent([uid, 'DTSTART:20261110T100000Z'])
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...event('UID:'),
      ...event('UID: '),
      ...event('UID:'),
      'END:VCALENDAR',
    ])
    const { resources, skipped } = await splitCalendar(text)
    expect(resources).toHaveLength(2)
    expect(resources[0]?.uid).toMatch(/@web-calendar\.invalid$/)
    expect(skipped.map((s) => s.reason)).toEqual(['duplicate'])
  })
})

describe('untrusted UIDs and text', () => {
  it('are kept as data in the resource and never used as a name', async () => {
    const { resources } = await splitCalendar(fixture('import-hostile-uids.ics'))
    expect(resources.map((r) => r.uid)).toEqual([
      '../../etc/passwd',
      'a/b/c',
      '%2e%2e%2fother-user%2fcalendar',
      'https://evil.example/..;x=1?y=2#z',
      'ünïcode-ñ-日本語',
      'con.ics',
    ])
    expect(resources[0]?.ics).toContain('UID:../../etc/passwd\r\n')
  })

  it('cannot add lines: an escaped line break in a value stays inside its line', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...vevent([
        'UID:a',
        'DTSTART:20261110T100000Z',
        'SUMMARY:Evil\\nEND:VEVENT\\nBEGIN:VEVENT\\nUID:other',
      ]),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(resources.map((r) => r.uid)).toEqual(['a'])
    expect(splitEvents(resources[0]!.ics)).toHaveLength(1)
    expect(contentLines(resources[0]!.ics).filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1)
  })

  it('does not expand a rule: an endless one and a huge COUNT are text like any other', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...vevent(['UID:a', 'DTSTART:20261110T100000Z', 'RRULE:FREQ=SECONDLY;COUNT=999999999999']),
      ...vevent(['UID:b', 'DTSTART:20261110T100000Z', 'RRULE:FREQ=DAILY']),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(resources).toHaveLength(2)
    expect(resources[0]?.ics).toContain('RRULE:FREQ=SECONDLY;COUNT=999999999999\r\n')
  })
})

describe('text that is not a calendar', () => {
  it.each([
    ['an HTML error page', fixture('garbage.ics')],
    ['empty', ''],
    ['blank lines', '  \r\n \r\n'],
    ['one word', 'BEGIN'],
    ['JSON', '{"events": []}'],
    ['binary', String.fromCharCode(0, 1, 2, 0xfffd, 0xfffd)],
  ])('is no iCalendar: %s', async (_name, text) => {
    expect(await splitCalendar(text)).toEqual({
      problem: 'not-icalendar',
      calendarName: null,
      resources: [],
      skipped: [],
    })
  })

  it('has no events when the calendar is empty or cut off', async () => {
    for (const text of [
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n',
    ]) {
      const result = await splitCalendar(text)
      expect(result.problem).toBeNull()
      expect(result.resources).toEqual([])
    }
  })

  it('refuses a vCalendar 1.0 file instead of calling it 2.0', async () => {
    const old = crlf([
      'BEGIN:VCALENDAR',
      'VERSION:1.0',
      ...vevent(['UID:a', 'DTSTART:20261110T100000Z']),
      'END:VCALENDAR',
    ])
    expect((await splitCalendar(old)).problem).toBe('unsupported-version')
  })

  it('reads a file whose events are damaged but not its calendar', async () => {
    const { resources, skipped } = await splitCalendar(fixture('mixed-good-bad.ics'))
    // Month thirteen is the service's to refuse (it is reported per event); nothing here reads dates.
    expect(resources.map((r) => r.uid)).toEqual([
      'good-1',
      'bad-date',
      expect.stringMatching(/@web-calendar\.invalid$/),
      'good-2',
    ])
    expect(skipped.map((s) => [s.reason, s.summary])).toEqual([['no-start', 'No DTSTART at all']])
  })
})

describe('form of the text', () => {
  it('reads a byte order mark, lower-case names, bare CR and LF line ends', async () => {
    const lines = [
      'begin:vcalendar',
      'version:2.0',
      'begin:vevent',
      'uid:lower',
      'dtstart:20261110T100000Z',
      'end:vevent',
      'end:vcalendar',
    ]
    for (const eol of ['\r\n', '\n', '\r']) {
      const { resources, problem } = await splitCalendar(
        String.fromCharCode(0xfeff) + lines.join(eol) + eol,
      )
      expect(problem).toBeNull()
      expect(resources.map((r) => r.uid)).toEqual(['lower'])
    }
    // The lines of the event are kept as written, in CRLF.
    const { resources } = await splitCalendar(lines.join('\n'))
    expect(resources[0]?.ics).toContain(
      'begin:vevent\r\nuid:lower\r\ndtstart:20261110T100000Z\r\nend:vevent\r\n',
    )
  })

  it('does not choke on nesting deeper than a calendar has, and reads on after it', async () => {
    const nested = 'BEGIN:X\r\n'.repeat(100_000) + 'END:X\r\n'.repeat(100_000)
    const text = crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:deep',
      'DTSTART:20261110T100000Z',
      '__NESTED__',
      'END:VEVENT',
      ...vevent(['UID:after', 'DTSTART:20261110T100000Z']),
      'END:VCALENDAR',
    ]).replace('__NESTED__\r\n', nested)
    const { resources, skipped } = await splitCalendar(text)
    expect(resources.map((r) => r.uid)).toEqual(['after'])
    expect(skipped.map((s) => s.reason)).toEqual(['damaged'])
  })

  it('handles a single line as long as the largest file', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...vevent([
        'UID:a',
        'DTSTART:20261110T100000Z',
        `DESCRIPTION:${'x'.repeat(5 * 1024 * 1024)}`,
      ]),
      'END:VCALENDAR',
    ])
    const { resources } = await splitCalendar(text)
    expect(resources).toHaveLength(1)
    expect(resources[0]?.ics.length).toBeGreaterThan(5 * 1024 * 1024)
  })

  it('splits a feed of thousands of events', async () => {
    const events = Array.from({ length: 3000 }, (_, i) =>
      vevent([`UID:event-${i}`, 'DTSTART:20261110T100000Z', `SUMMARY:Event ${i}`]),
    ).flat()
    const { resources } = await splitCalendar(wrapCalendar(events))
    expect(resources).toHaveLength(3000)
    expect(new Set(resources.map((r) => r.uid)).size).toBe(3000)
  })
})
