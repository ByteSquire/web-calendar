import { describe, expect, it } from 'vitest'
import { readCalendarObject } from '../app/utils/ical/read'
import { calendar, fixture, lines, options, range, read, vevent } from './ical-read-helpers'

// NFR-4: calendar data is untrusted (subscriptions) and sometimes broken (clients, truncated
// transfers). Reading never throws, a bad component costs only itself, and no rule can keep the
// browser busy.

describe('text that is not a calendar', () => {
  it('returns no events and an error for an HTML error page', () => {
    const result = read(fixture('garbage.ics'))
    expect(result.events).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toMatch(/not iCalendar/i)
  })

  it.each([
    ['empty', ''],
    ['blank', '  \r\n \r\n'],
    ['one word', 'BEGIN'],
    ['binary', '\u0000\u0001\u0002��'],
    ['an unterminated calendar', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'],
    ['JSON', '{"events": []}'],
    ['a very long line', `BEGIN:VCALENDAR\r\nX-JUNK:${'x'.repeat(200_000)}\r\nEND:VCALENDAR\r\n`],
  ])('does not throw for %s', (_name, text) => {
    const result = read(text)
    expect(result.events).toEqual([])
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('reports data that is not text', () => {
    for (const value of [undefined, null, 42, {}] as unknown as string[]) {
      const result = readCalendarObject(value, options())
      expect(result.events).toEqual([])
      expect(result.errors).toHaveLength(1)
    }
  })

  it('says so for a calendar without any event', () => {
    const result = read(calendar())
    expect(result).toEqual({ events: [], errors: [] })
  })
})

describe('text that is read despite its form', () => {
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...vevent(['DTSTART:20261110T090000Z', 'SUMMARY:Form']),
    'END:VCALENDAR',
  ]

  it('reads LF line endings, folding with a tab, and a byte order mark', () => {
    const lf = body.join('\n').replace('SUMMARY:Form', 'SUMMARY:Fo\n\trm')
    for (const text of [lf, `\ufeff${lf}`, lf.replace(/\n/g, '\r\n')]) {
      const result = read(text)
      expect(result.errors).toEqual([])
      expect(result.events.map((event) => event.title)).toEqual(['Form'])
    }
  })

  it('reads parameters it does not use, quoted values and lower-case names', () => {
    const ics = calendar(
      vevent([
        'dtstart;TZID="Europe/Berlin";X-FOO=bar:20261110T100000',
        'summary;LANGUAGE=de:Besprechung',
        'DESCRIPTION;ALTREP="cid:part1.0001@example.com":Plain text',
        'CATEGORIES;LANGUAGE=en:A,B',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE;TZID="Europe/Berlin":20261111T100000',
      ]),
    )
    const result = read(ics, { displayTimeZone: 'UTC' })
    expect(result.errors).toEqual([])
    expect(result.events.map((e) => e.start)).toEqual([
      '2026-11-10T09:00:00',
      '2026-11-12T09:00:00',
    ])
    expect(result.events[0]).toMatchObject({
      title: 'Besprechung',
      description: 'Plain text',
      categoryNames: ['A', 'B'],
    })
  })

  it('unescapes every escape of RFC 5545 text', () => {
    const ics = calendar(vevent(['DTSTART:20261110T090000Z', 'SUMMARY:A\\;B\\\\C\\,D\\nE\\NF']))
    expect(read(ics).events[0]?.title).toBe('A;B\\C,D\nE\nF')
  })
})

describe('one bad component among good ones', () => {
  it('reads the good events and reports each bad one with its UID', () => {
    const result = read(fixture('mixed-good-bad.ics'), { displayTimeZone: 'UTC' })
    expect(result.events.map((event) => event.uid)).toEqual(['good-1', 'good-2'])
    expect(lines(result.events)).toEqual([
      '2026-11-10T10:00:00 - 2026-11-10T11:00:00 Good one',
      '2026-11-12 - 2026-11-13 Good two',
    ])
    expect(result.errors).toHaveLength(3)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { uid: 'bad-date', message: expect.stringContaining('Invalid date') },
        { uid: 'no-start', message: 'Missing DTSTART' },
        { message: expect.stringContaining('without UID') },
      ]),
    )
  })

  it('survives a line ical.js cannot parse: the component is read without it', () => {
    const result = read(fixture('broken-line.ics'), { displayTimeZone: 'UTC' })
    expect(result.events.map((event) => event.uid)).toEqual(['before', 'damaged', 'after'])
    expect(result.events[1]?.title).toBe('Has a stray line')
    expect(result.errors.some((issue) => issue.uid === 'damaged')).toBe(true)
    expect(result.errors.every((issue) => issue.severity === 'warning')).toBe(true)
  })

  it('reads the complete events of a truncated transfer and reports the cut one', () => {
    // A feed cut in the middle of its fourth event: no END:VEVENT, no END:VCALENDAR.
    const text = fixture('feed.ics')
    const cut = `${text.slice(0, text.indexOf('BEGIN:VTODO'))}BEGIN:VEVENT\nUID:cut-off\nSUMMARY:Cut`
    const result = read(cut, { range: range('2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z') })
    expect(result.events.map((event) => event.title)).toEqual([
      'Reformation Day',
      'All Saints',
      'Yearly feast',
    ])
    expect(result.errors.some((issue) => issue.uid === 'cut-off')).toBe(true)
  })

  it('does not let an unknown time zone, a bad DURATION or a bad RDATE hurt the other events', () => {
    const ics = calendar(
      vevent(['DTSTART:20261110T090000Z', 'DURATION:PT1X'], 'bad-duration'),
      vevent(
        ['DTSTART:20261110T090000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'RDATE:garbage'],
        'bad-rdate',
      ),
      vevent(['DTSTART:20261110T100000Z', 'SUMMARY:Fine'], 'fine'),
    )
    const result = read(ics)
    expect(result.events.map((event) => event.uid)).toEqual(['bad-rdate', 'fine', 'bad-rdate'])
    expect(result.errors.map((issue) => issue.uid).sort()).toEqual(['bad-duration', 'bad-rdate'])
  })

  it('skips a duplicate of an event it already has', () => {
    const one = vevent(['DTSTART:20261110T090000Z', 'SUMMARY:Twice'], 'dup')
    const result = read(calendar(one, one))
    expect(result.events).toHaveLength(1)
    expect(result.errors).toEqual([expect.objectContaining({ uid: 'dup', severity: 'warning' })])
  })
})

describe('recurrence rules that cannot be used', () => {
  const window = range('2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z')
  const fileWith = (rule: string): string =>
    calendar(
      // 1 Nov 2026 is a Sunday.
      vevent(
        ['DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', `RRULE:${rule}`, 'SUMMARY:Bad'],
        'bad',
      ),
      vevent(['DTSTART:20261102T120000Z', 'DTEND:20261102T130000Z', 'SUMMARY:Good'], 'good'),
    )

  // [rule, what the message says]. Each one makes ical.js loop forever or throw.
  const rejected: [string, RegExp][] = [
    ['FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', /never match/],
    ['FREQ=DAILY;BYMONTH=4,6,9,11;BYMONTHDAY=31', /never match/],
    ['FREQ=DAILY;BYMONTH=2;BYMONTHDAY=-30', /never match/],
    ['FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30', /never match/],
    ['FREQ=DAILY;BYMONTHDAY=0', /BYMONTHDAY/],
    ['FREQ=MONTHLY;BYMONTHDAY=32', /RRULE|BYMONTHDAY/],
    ['FREQ=MONTHLY;BYYEARDAY=3', /BYYEARDAY/],
    ['FREQ=DAILY;BYWEEKNO=1', /BYWEEKNO/],
    ['FREQ=WEEKLY;BYDAY=2MO', /BYDAY/],
    ['FREQ=WEEKLY;BYMONTHDAY=3', /BYMONTHDAY/],
    ['FREQ=DAILY;BYDAY=XX', /RRULE|BYDAY/],
    ['FREQ=YEARLY;BYWEEKNO=54', /RRULE|BYWEEKNO/],
    ['FREQ=FOO', /RRULE|FREQ/],
    ['FREQ=DAILY;BYHOUR=25', /RRULE|BYHOUR/],
    ['FREQ=', /RRULE|FREQ/],
    // Passes every check, and ical.js never finds a Tuesday: a week of days from a Sunday.
    ['FREQ=DAILY;INTERVAL=7;BYDAY=TU', /too much work/],
  ]

  it.each(rejected)('rejects %s without hurting the other events', (rule, message) => {
    const started = performance.now()
    const result = read(fileWith(rule), { range: window, displayTimeZone: 'UTC' })
    const elapsed = performance.now() - started
    // The series is shown once, as its first event; nothing else is made of the rule.
    expect(result.events.filter((event) => event.uid === 'bad')).toHaveLength(1)
    expect(result.events.filter((event) => event.uid === 'good')).toHaveLength(1)
    const issues = result.errors.filter((issue) => issue.uid === 'bad')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(message)
    expect(elapsed).toBeLessThan(1500)
  })

  // Rules ical.js accepts but reads in its own way. They must end, whatever they give.
  it.each([
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;BYSETPOS=5',
    'FREQ=HOURLY;INTERVAL=24;BYHOUR=5',
    'FREQ=MINUTELY;INTERVAL=60;BYMINUTE=5',
    'FREQ=SECONDLY;INTERVAL=60;BYSECOND=5',
    'FREQ=MONTHLY;BYDAY=5FR;BYMONTH=2',
    'FREQ=YEARLY;BYYEARDAY=366',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=TU,WE',
    'FREQ=MONTHLY;INTERVAL=12;BYMONTH=5',
    'FREQ=SECONDLY',
  ])('ends %s', (rule) => {
    const started = performance.now()
    const result = read(fileWith(rule), { range: window })
    expect(result.events.filter((event) => event.uid === 'good')).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('stops a rule that needs too much work and says so', () => {
    const result = read(fileWith('FREQ=DAILY;INTERVAL=7;BYDAY=TU'), { range: window })
    expect(result.errors).toEqual([
      expect.objectContaining({ uid: 'bad', message: expect.stringContaining('too much work') }),
    ])
  })

  it('reads two rules of one event, one of them unusable', () => {
    const ics = calendar(
      vevent(
        [
          'DTSTART:20261101T090000Z',
          'DTEND:20261101T100000Z',
          'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
          'RRULE:FREQ=DAILY;COUNT=3',
        ],
        'two',
      ),
    )
    const result = read(ics, { range: window })
    expect(result.events).toHaveLength(3)
    expect(result.errors).toEqual([expect.objectContaining({ uid: 'two' })])
  })

  it('does not use a rule in an override', () => {
    const ics = calendar(
      vevent(
        ['DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'],
        's',
      ),
      vevent(
        [
          'UID:s',
          'RECURRENCE-ID:20261102T090000Z',
          'DTSTART:20261102T090000Z',
          'DTEND:20261102T100000Z',
          'RRULE:FREQ=HOURLY',
        ],
        's',
      ),
    )
    const result = read(ics, { range: window })
    expect(result.events).toHaveLength(3)
  })
})

describe('size', () => {
  it('reads a feed of 3000 events for a one-week range quickly', () => {
    const events: string[] = []
    for (let index = 0; index < 3000; index++) {
      const day = String(1 + (index % 28)).padStart(2, '0')
      const month = String(1 + (index % 12)).padStart(2, '0')
      events.push(
        ...vevent(
          [
            `DTSTART:2026${month}${day}T090000Z`,
            `DTEND:2026${month}${day}T100000Z`,
            `SUMMARY:Event ${index}`,
          ],
          `bulk-${index}`,
        ),
      )
    }
    const text = calendar(events)
    const started = performance.now()
    const result = read(text, { range: range('2026-11-02T00:00:00Z', '2026-11-09T00:00:00Z') })
    const elapsed = performance.now() - started
    expect(result.errors).toEqual([])
    expect(result.events.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(2000)
  })

  it('reads a series with many EXDATEs', () => {
    const exdates = Array.from(
      { length: 500 },
      (_, index) =>
        `EXDATE:${new Date(Date.UTC(2026, 0, 1 + index * 2, 9)).toISOString().replace(/[-:]|\.000/g, '')}`,
    )
    const ics = calendar(
      vevent([
        'DTSTART:20260101T090000Z',
        'DTEND:20260101T100000Z',
        'RRULE:FREQ=DAILY',
        ...exdates,
      ]),
    )
    const result = read(ics, {
      displayTimeZone: 'UTC',
      range: range('2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z'),
    })
    // The 1st, 3rd, 5th ... are taken out.
    expect(result.events.map((event) => event.start.slice(8, 10))).toEqual([
      '02',
      '04',
      '06',
      '08',
      '10',
    ])
  })
})
