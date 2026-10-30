import { describe, expect, it } from 'vitest'
import { calendar, fixture, lines, range, read, vevent, ZONE_SOURCES } from './ical-read-helpers'

// Recurrence (FR-28): RRULE with all its parts, RDATE, EXDATE, RECURRENCE-ID overrides, series that
// began long before the range, series the server already expanded.

const WEEK_OF_12_OCT = range('2026-10-12T00:00:00Z', '2026-10-19T00:00:00Z')

describe('a weekly series with an EXDATE and a moved occurrence (a-weekly)', () => {
  const ics = fixture('a-weekly.ics')

  it('runs the rule in the zone of DTSTART across the change of 25 Oct 2026', () => {
    const result = read(ics)
    expect(result.errors).toEqual([])
    // 09:00 Berlin every Monday, before and after the change; 2 Nov is excluded, 26 Oct moved to 14:00.
    expect(lines(result.events)).toEqual([
      '2026-10-12T09:00:00 - 2026-10-12T10:00:00 A weekly',
      '2026-10-19T09:00:00 - 2026-10-19T10:00:00 A weekly',
      '2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)',
      '2026-11-09T09:00:00 - 2026-11-09T10:00:00 A weekly',
      '2026-11-16T09:00:00 - 2026-11-16T10:00:00 A weekly',
      '2026-11-23T09:00:00 - 2026-11-23T10:00:00 A weekly',
      '2026-11-30T09:00:00 - 2026-11-30T10:00:00 A weekly',
    ])
  })

  it('shows the same instants in UTC', () => {
    const result = read(ics, { displayTimeZone: 'UTC' })
    expect(result.events.map((event) => event.start)).toEqual([
      '2026-10-12T07:00:00',
      '2026-10-19T07:00:00',
      '2026-10-26T13:00:00',
      '2026-11-09T08:00:00',
      '2026-11-16T08:00:00',
      '2026-11-23T08:00:00',
      '2026-11-30T08:00:00',
    ])
  })

  it('shows them in Sydney, where the moved occurrence is on the next day', () => {
    const result = read(ics, { displayTimeZone: 'Australia/Sydney' })
    expect(result.events.map((event) => event.start)).toEqual([
      '2026-10-12T18:00:00',
      '2026-10-19T18:00:00',
      '2026-10-27T00:00:00',
      '2026-11-09T19:00:00',
      '2026-11-16T19:00:00',
      '2026-11-23T19:00:00',
      '2026-11-30T19:00:00',
    ])
  })

  it('shows them in Los Angeles, where the change of 1 Nov moves them by an hour', () => {
    const result = read(ics, { displayTimeZone: 'America/Los_Angeles' })
    expect(result.events.map((event) => event.start)).toEqual([
      '2026-10-12T00:00:00',
      '2026-10-19T00:00:00',
      '2026-10-26T06:00:00',
      '2026-11-09T00:00:00',
      '2026-11-16T00:00:00',
      '2026-11-23T00:00:00',
      '2026-11-30T00:00:00',
    ])
  })

  it('marks every occurrence and the override as recurring, with the original slot as id', () => {
    const { events } = read(ics)
    expect(events.every((event) => event.recurring)).toBe(true)
    expect(events.map((event) => event.recurrenceId)).toEqual([
      '2026-10-12T07:00:00Z',
      '2026-10-19T07:00:00Z',
      // The override keeps the slot it replaced (09:00 CET = 08:00Z), not its new time.
      '2026-10-26T08:00:00Z',
      '2026-11-09T08:00:00Z',
      '2026-11-16T08:00:00Z',
      '2026-11-23T08:00:00Z',
      '2026-11-30T08:00:00Z',
    ])
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(events[2]?.id).toBe('dav:/caldav/u/c/|/caldav/u/c/test.ics|2026-10-26T08:00:00Z')
  })

  it('returns only the occurrences in the range', () => {
    const result = read(ics, {
      displayTimeZone: 'UTC',
      range: range('2026-10-19T00:00:00Z', '2026-11-30T23:59:59Z'),
    })
    expect(result.events.map((event) => event.title)).toEqual([
      'A weekly',
      'A weekly (moved)',
      'A weekly',
      'A weekly',
      'A weekly',
      'A weekly',
    ])
  })
})

describe('BYSETPOS, WKST, BYDAY and the other rule parts', () => {
  it('finds the last weekday of each month (b-lastweekday)', () => {
    const { events, errors } = read(fixture('b-lastweekday.ics'), { displayTimeZone: 'UTC' })
    expect(errors).toEqual([])
    expect(events.map((event) => event.start)).toEqual([
      '2026-08-31T15:00:00',
      '2026-09-30T15:00:00',
      '2026-10-30T16:00:00',
      '2026-11-30T16:00:00',
      '2026-12-31T16:00:00',
      '2027-01-29T16:00:00',
    ])
    expect(read(fixture('b-lastweekday.ics')).events.map((event) => event.start.slice(11))).toEqual(
      Array(6).fill('17:00:00'),
    )
  })

  // RFC 5545 §3.8.5.3: the week start decides which Sundays belong to which week.
  it.each([
    ['MO', ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']],
    ['SU', ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']],
  ])('honours WKST=%s', (wkst, days) => {
    const ics = calendar(
      vevent([
        'DTSTART:19970805T090000Z',
        'DTEND:19970805T100000Z',
        `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`,
      ]),
    )
    const { events } = read(ics, {
      displayTimeZone: 'UTC',
      range: range('1997-01-01T00:00:00Z', '1998-01-01T00:00:00Z'),
    })
    expect(events.map((event) => event.start.slice(0, 10))).toEqual(days)
  })

  it('expands the second Tuesday of every month', () => {
    const ics = calendar(
      vevent([
        'DTSTART:20260113T090000Z',
        'DTEND:20260113T100000Z',
        'RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=4',
      ]),
    )
    expect(read(ics, { displayTimeZone: 'UTC' }).events.map((e) => e.start.slice(0, 10))).toEqual([
      '2026-01-13',
      '2026-02-10',
      '2026-03-10',
      '2026-04-14',
    ])
  })

  it('expands BYMONTHDAY with a negative day (the last day of the month)', () => {
    const ics = calendar(
      vevent([
        'DTSTART:20260131T090000Z',
        'DTEND:20260131T100000Z',
        'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4',
      ]),
    )
    expect(read(ics, { displayTimeZone: 'UTC' }).events.map((e) => e.start.slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('expands the fourth Thursday of November every year', () => {
    const ics = calendar(
      vevent(['DTSTART;VALUE=DATE:20201126', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=4']),
    )
    expect(read(ics).events.map((event) => event.start)).toEqual([
      '2020-11-26',
      '2021-11-25',
      '2022-11-24',
      '2023-11-23',
    ])
  })

  it('expands an INTERVAL on a daily rule', () => {
    const ics = calendar(
      vevent([
        'DTSTART:20261101T090000Z',
        'DTEND:20261101T100000Z',
        'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4',
      ]),
    )
    expect(read(ics, { displayTimeZone: 'UTC' }).events.map((e) => e.start.slice(0, 10))).toEqual([
      '2026-11-01',
      '2026-11-04',
      '2026-11-07',
      '2026-11-10',
    ])
  })
})

describe('all-day series (f-yearly-allday)', () => {
  const ics = fixture('f-yearly-allday.ics')

  it('finds the instance in the range', () => {
    const result = read(ics, { range: range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z') })
    expect(result.errors).toEqual([])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      start: '2026-11-05',
      end: '2026-11-06',
      allDay: true,
      recurring: true,
      recurrenceId: '2026-11-05',
      id: 'dav:/caldav/u/c/|/caldav/u/c/test.ics|2026-11-05',
    })
  })

  it('never moves the date between zones', () => {
    for (const displayTimeZone of [
      'Europe/Berlin',
      'Australia/Sydney',
      'America/Los_Angeles',
      'Pacific/Kiritimati',
    ]) {
      const { events } = read(ics, {
        displayTimeZone,
        range: range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      })
      expect(events.map((event) => [event.start, event.end])).toEqual([
        ['2026-11-05', '2026-11-06'],
      ])
    }
  })

  it('finds every year in a long range', () => {
    const { events } = read(ics, { range: range('2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z') })
    expect(events.map((event) => event.start)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${2020 + index}-11-05`),
    )
  })

  it('keeps a multi-day all-day series as long as its first instance', () => {
    const multi = calendar(
      vevent([
        'DTSTART;VALUE=DATE:20261103',
        'DTEND;VALUE=DATE:20261106',
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ]),
    )
    expect(read(multi).events.map((event) => [event.start, event.end])).toEqual([
      ['2026-11-03', '2026-11-06'],
      ['2026-11-10', '2026-11-13'],
      ['2026-11-17', '2026-11-20'],
    ])
  })
})

describe('COUNT, UNTIL, RDATE, EXDATE', () => {
  const daily = (extra: string[], dtstart = 'DTSTART:20261101T090000Z'): string =>
    calendar(
      vevent([dtstart, dtstart.replace('DTSTART', 'DTEND').replace('090000', '100000'), ...extra]),
    )
  const days = (ics: string, extra = {}): string[] =>
    read(ics, { displayTimeZone: 'UTC', ...extra }).events.map((e) => e.start.slice(5, 10))

  it('stops after COUNT', () => {
    expect(days(daily(['RRULE:FREQ=DAILY;COUNT=3']))).toEqual(['11-01', '11-02', '11-03'])
  })

  it('stops at UNTIL, which is inclusive', () => {
    expect(days(daily(['RRULE:FREQ=DAILY;UNTIL=20261103T090000Z']))).toEqual([
      '11-01',
      '11-02',
      '11-03',
    ])
    expect(days(daily(['RRULE:FREQ=DAILY;UNTIL=20261103T085959Z']))).toEqual(['11-01', '11-02'])
  })

  it('reads a UTC UNTIL in the zone of DTSTART', () => {
    // 09:00 Berlin in winter is 08:00Z, so UNTIL 08:00Z includes the 4th and 07:59:59Z does not.
    const berlin = (until: string): string =>
      daily([`RRULE:FREQ=DAILY;UNTIL=${until}`], 'DTSTART;TZID=Europe/Berlin:20261102T090000')
    expect(days(berlin('20261104T080000Z'))).toEqual(['11-02', '11-03', '11-04'])
    expect(days(berlin('20261104T075959Z'))).toEqual(['11-02', '11-03'])
  })

  it('allows the whole last day when UNTIL is a date', () => {
    expect(days(daily(['RRULE:FREQ=DAILY;UNTIL=20261103']))).toEqual(['11-01', '11-02', '11-03'])
    const allDay = calendar(
      vevent(['DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=DAILY;UNTIL=20261103']),
    )
    expect(read(allDay).events.map((e) => e.start)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ])
  })

  it('adds RDATE instances with the length of the series and drops EXDATE instances', () => {
    const ics = daily([
      'RRULE:FREQ=DAILY;COUNT=4',
      'RDATE:20261110T090000Z,20261112T090000Z',
      'EXDATE:20261102T090000Z',
      'EXDATE:20261103T090000Z,20261110T090000Z',
    ])
    const result = read(ics, { displayTimeZone: 'UTC' })
    expect(lines(result.events)).toEqual([
      '2026-11-01T09:00:00 - 2026-11-01T10:00:00 ',
      '2026-11-04T09:00:00 - 2026-11-04T10:00:00 ',
      '2026-11-12T09:00:00 - 2026-11-12T10:00:00 ',
    ])
  })

  it('counts an RDATE that repeats an instance once', () => {
    const ics = daily(['RRULE:FREQ=DAILY;COUNT=2', 'RDATE:20261102T090000Z'])
    expect(days(ics)).toEqual(['11-01', '11-02'])
  })

  it('supports a series made of RDATE only', () => {
    const ics = daily(['RDATE:20261105T090000Z'])
    expect(days(ics)).toEqual(['11-01', '11-05'])
    expect(read(ics).events.every((event) => event.recurring)).toBe(true)
  })

  it('reads an RDATE period', () => {
    const ics = daily([
      'RDATE;VALUE=PERIOD:20261105T090000Z/PT3H,20261106T090000Z/20261106T130000Z',
    ])
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-11-01T09:00:00 - 2026-11-01T10:00:00 ',
      '2026-11-05T09:00:00 - 2026-11-05T12:00:00 ',
      '2026-11-06T09:00:00 - 2026-11-06T13:00:00 ',
    ])
  })

  it('matches an EXDATE in another zone by instant', () => {
    const ics = daily(
      ['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/New_York:20261102T040000'],
      'DTSTART:20261101T090000Z',
    )
    // 04:00 EST is 09:00Z.
    expect(days(ics)).toEqual(['11-01', '11-03'])
  })

  it('lets a DATE EXDATE take out a timed instance of that day', () => {
    const ics = daily(['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261102'])
    expect(days(ics)).toEqual(['11-01', '11-03'])
  })

  it('lets an EXDATE take out an all-day instance', () => {
    const ics = calendar(
      vevent([
        'DTSTART;VALUE=DATE:20261101',
        'RRULE:FREQ=DAILY;COUNT=3',
        'EXDATE;VALUE=DATE:20261102',
      ]),
    )
    expect(read(ics).events.map((e) => e.start)).toEqual(['2026-11-01', '2026-11-03'])
  })

  it('reports an EXDATE it cannot read and keeps the series', () => {
    const ics = calendar(
      vevent(
        ['DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'EXDATE:20261301T090000Z'],
        'series',
      ),
    )
    const result = read(ics)
    expect(result.events).toHaveLength(2)
    expect(result.errors).toEqual([expect.objectContaining({ uid: 'series' })])
  })
})

describe('daylight saving edges inside a series', () => {
  for (const [label, vtimezone] of ZONE_SOURCES) {
    describe(label, () => {
      it('keeps 02:30 every day across the repeated hour of 25 Oct 2026', () => {
        const ics = calendar(
          vtimezone,
          vevent([
            'DTSTART;TZID=Europe/Berlin:20261023T023000',
            'DTEND;TZID=Europe/Berlin:20261023T024500',
            'RRULE:FREQ=DAILY;COUNT=5',
          ]),
        )
        // The rule is on the Berlin wall clock; 25 Oct 02:30 is the first one (CEST).
        expect(read(ics, { displayTimeZone: 'Europe/Berlin' }).events.map((e) => e.start)).toEqual([
          '2026-10-23T02:30:00',
          '2026-10-24T02:30:00',
          '2026-10-25T02:30:00',
          '2026-10-26T02:30:00',
          '2026-10-27T02:30:00',
        ])
        const utc = read(ics, { displayTimeZone: 'UTC' })
        expect(utc.events.map((e) => e.start)).toEqual([
          '2026-10-23T00:30:00',
          '2026-10-24T00:30:00',
          '2026-10-25T00:30:00',
          '2026-10-26T01:30:00',
          '2026-10-27T01:30:00',
        ])
        expect(utc.events[2]?.recurrenceId).toBe('2026-10-25T00:30:00Z')
        expect(utc.events.map((e) => e.end.slice(11))).toEqual([
          '00:45:00',
          '00:45:00',
          '00:45:00',
          '01:45:00',
          '01:45:00',
        ])
      })

      it('reads 02:30 on 29 Mar 2026, which does not exist, with the offset before the gap', () => {
        const ics = calendar(
          vtimezone,
          vevent([
            'DTSTART;TZID=Europe/Berlin:20260327T023000',
            'DTEND;TZID=Europe/Berlin:20260327T024500',
            'RRULE:FREQ=DAILY;COUNT=5',
          ]),
        )
        expect(read(ics, { displayTimeZone: 'UTC' }).events.map((e) => e.start)).toEqual([
          '2026-03-27T01:30:00',
          '2026-03-28T01:30:00',
          '2026-03-29T01:30:00',
          '2026-03-30T00:30:00',
          '2026-03-31T00:30:00',
        ])
        // In Berlin the instant of the gap day is shown as 03:30.
        expect(read(ics, { displayTimeZone: 'Europe/Berlin' }).events.map((e) => e.start)).toEqual([
          '2026-03-27T02:30:00',
          '2026-03-28T02:30:00',
          '2026-03-29T03:30:00',
          '2026-03-30T02:30:00',
          '2026-03-31T02:30:00',
        ])
      })

      it('follows the zone of DTSTART, not the viewer: a weekly 09:00 in Berlin shifts in Sydney', () => {
        const ics = calendar(
          vtimezone,
          vevent([
            'DTSTART;TZID=Europe/Berlin:20260320T090000',
            'DTEND;TZID=Europe/Berlin:20260320T100000',
            'RRULE:FREQ=WEEKLY;COUNT=4',
          ]),
        )
        // Berlin changes on 29 Mar and Sydney on 5 Apr, so the gap between them is 10 h, then 11 h
        // (3 Apr), then 10 h.
        expect(
          read(ics, { displayTimeZone: 'Australia/Sydney' }).events.map((e) => e.start),
        ).toEqual([
          '2026-03-20T19:00:00',
          '2026-03-27T19:00:00',
          '2026-04-03T18:00:00',
          '2026-04-10T17:00:00',
        ])
      })
    })
  }
})

describe('overrides (RECURRENCE-ID)', () => {
  // Mondays 09:00Z: 12, 19, 26 Oct, 2, 9, 16 Nov.
  const master = [
    'UID:series',
    'DTSTART:20261012T090000Z',
    'DTEND:20261012T100000Z',
    'SUMMARY:Series',
    'RRULE:FREQ=WEEKLY;COUNT=6',
  ]
  const calendarWith = (...overrides: string[][]): string =>
    calendar(vevent(master), ...overrides.map((lines) => vevent(['UID:series', ...lines])))
  const options = (start: string, end: string) => ({
    displayTimeZone: 'UTC',
    range: range(start, end),
  })

  it('replaces an occurrence by the override', () => {
    const ics = calendarWith([
      'RECURRENCE-ID:20261026T090000Z',
      'DTSTART:20261026T090000Z',
      'DTEND:20261026T100000Z',
      'SUMMARY:Renamed',
    ])
    const { events } = read(ics, options('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(events.map((e) => e.title)).toEqual([
      'Series',
      'Series',
      'Renamed',
      'Series',
      'Series',
      'Series',
    ])
    expect(events[2]).toMatchObject({ recurring: true, recurrenceId: '2026-10-26T09:00:00Z' })
  })

  it('shows an override that was moved into the range, though its original slot is outside', () => {
    const ics = calendarWith([
      'RECURRENCE-ID:20261026T090000Z',
      'DTSTART:20261104T090000Z',
      'DTEND:20261104T100000Z',
      'SUMMARY:Moved in',
    ])
    const { events } = read(ics, options('2026-11-03T00:00:00Z', '2026-11-06T00:00:00Z'))
    expect(lines(events)).toEqual(['2026-11-04T09:00:00 - 2026-11-04T10:00:00 Moved in'])
    expect(events[0]?.recurrenceId).toBe('2026-10-26T09:00:00Z')
  })

  it('drops the original slot when the override was moved out of the range', () => {
    const ics = calendarWith([
      'RECURRENCE-ID:20261026T090000Z',
      'DTSTART:20261104T090000Z',
      'DTEND:20261104T100000Z',
      'SUMMARY:Moved away',
    ])
    expect(read(ics, options('2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z')).events).toEqual([])
  })

  it('keeps all other occurrences when an override moves one', () => {
    const ics = calendarWith([
      'RECURRENCE-ID:20261026T090000Z',
      'DTSTART:20261104T090000Z',
      'DTEND:20261104T100000Z',
      'SUMMARY:Moved',
    ])
    const { events } = read(ics, options('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(events.map((e) => e.start.slice(5, 10))).toEqual([
      '10-12',
      '10-19',
      '11-02',
      '11-04',
      '11-09',
      '11-16',
    ])
  })

  it('returns a cancelled override as cancelled', () => {
    const ics = calendarWith([
      'RECURRENCE-ID:20261019T090000Z',
      'DTSTART:20261019T090000Z',
      'DTEND:20261019T100000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Series',
    ])
    const { events } = read(ics, options('2026-10-18T00:00:00Z', '2026-10-21T00:00:00Z'))
    expect(events.map((e) => e.status)).toEqual(['cancelled'])
  })

  it('matches an override given in another zone by instant', () => {
    const ics = calendarWith([
      'RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000',
      'DTSTART:20261026T150000Z',
      'DTEND:20261026T160000Z',
      'SUMMARY:Afternoon',
    ])
    // 10:00 CET is 09:00Z, the slot of 26 Oct.
    const { events } = read(ics, options('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(events.filter((e) => e.start.startsWith('2026-10-26'))).toHaveLength(1)
    expect(events.find((e) => e.title === 'Afternoon')?.recurrenceId).toBe('2026-10-26T09:00:00Z')
  })

  it('matches a date RECURRENCE-ID of an all-day series', () => {
    const ics = calendar(
      vevent(['UID:s', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Day']),
      vevent([
        'UID:s',
        'RECURRENCE-ID;VALUE=DATE:20261102',
        'DTSTART;VALUE=DATE:20261102',
        'SUMMARY:Special day',
      ]),
    )
    const { events } = read(ics)
    expect(events.map((e) => [e.start, e.title, e.recurrenceId])).toEqual([
      ['2026-11-01', 'Day', '2026-11-01'],
      ['2026-11-02', 'Special day', '2026-11-02'],
      ['2026-11-03', 'Day', '2026-11-03'],
    ])
  })

  it('reads an override without a master as a plain event', () => {
    const ics = calendar(
      vevent([
        'UID:orphan',
        'RECURRENCE-ID:20261026T090000Z',
        'DTSTART:20261026T100000Z',
        'DTEND:20261026T110000Z',
        'SUMMARY:Copy of one occurrence',
      ]),
    )
    const { events, errors } = read(ics, { displayTimeZone: 'UTC' })
    expect(errors).toEqual([])
    expect(lines(events)).toEqual([
      '2026-10-26T10:00:00 - 2026-10-26T11:00:00 Copy of one occurrence',
    ])
    expect(events[0]).toMatchObject({ recurring: true, recurrenceId: '2026-10-26T09:00:00Z' })
  })
})

describe('data the server already expanded (expandRecurrence: false)', () => {
  const asServer = { expandRecurrence: false }

  it('reads every VEVENT as one occurrence, as Radicale sends it', () => {
    const result = read(fixture('server-expanded-a-weekly.ics'), {
      ...asServer,
      displayTimeZone: 'UTC',
      range: range('2026-10-19T00:00:00Z', '2026-11-30T23:59:59Z'),
    })
    expect(result.errors).toEqual([])
    expect(lines(result.events)).toEqual([
      '2026-10-19T07:00:00 - 2026-10-19T08:00:00 A weekly',
      '2026-10-26T13:00:00 - 2026-10-26T14:00:00 A weekly (moved)',
      '2026-11-09T08:00:00 - 2026-11-09T09:00:00 A weekly',
      '2026-11-16T08:00:00 - 2026-11-16T09:00:00 A weekly',
      '2026-11-23T08:00:00 - 2026-11-23T09:00:00 A weekly',
      '2026-11-30T08:00:00 - 2026-11-30T09:00:00 A weekly',
    ])
    expect(result.events.every((event) => event.recurring)).toBe(true)
    expect(new Set(result.events.map((event) => event.id)).size).toBe(6)
  })

  it('gives the same events as expanding the series here', () => {
    const options = {
      displayTimeZone: 'Australia/Sydney',
      range: range('2026-10-19T00:00:00Z', '2026-11-30T23:59:59Z'),
    }
    const fromServer = read(fixture('server-expanded-a-weekly.ics'), { ...options, ...asServer })
    const local = read(fixture('a-weekly.ics'), options)
    expect(fromServer.events).toEqual(local.events)
  })

  it('reads the all-day instance with a date RECURRENCE-ID written without VALUE=DATE', () => {
    // Radicale writes `RECURRENCE-ID:20261105` for an all-day series.
    const { events, errors } = read(fixture('server-expanded-f-yearly.ics'), asServer)
    expect(errors).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      start: '2026-11-05',
      end: '2026-11-06',
      allDay: true,
      recurring: true,
      recurrenceId: '2026-11-05',
    })
  })

  it('reads the same data the same way when expansion is on (overrides without a master)', () => {
    const fromServer = read(fixture('server-expanded-a-weekly.ics'), {
      ...asServer,
      range: range('2026-10-19T00:00:00Z', '2026-11-30T23:59:59Z'),
    })
    const expanding = read(fixture('server-expanded-a-weekly.ics'), {
      range: range('2026-10-19T00:00:00Z', '2026-11-30T23:59:59Z'),
    })
    expect(expanding).toEqual(fromServer)
  })

  it('does not expand a master it is given, and still marks it as part of a series', () => {
    const { events } = read(fixture('f-yearly-allday.ics'), {
      ...asServer,
      range: range('2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      start: '2020-11-05',
      recurring: true,
      recurrenceId: '2020-11-05',
    })
  })

  it('still applies the range', () => {
    const { events } = read(fixture('server-expanded-a-weekly.ics'), {
      ...asServer,
      displayTimeZone: 'UTC',
      range: range('2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'),
    })
    expect(events.map((event) => event.start)).toEqual(['2026-11-09T08:00:00'])
  })
})

describe('series that began long before the range', () => {
  const series = (rule: string, dtstart = 'DTSTART;TZID=Europe/Berlin:20100104T090000'): string =>
    calendar(
      vevent([
        dtstart,
        ...(dtstart.includes('VALUE=DATE') ? [] : ['DURATION:PT1H']),
        `RRULE:${rule}`,
        'SUMMARY:Old',
      ]),
    )

  it('finds a daily series from 2010 for one week quickly', () => {
    const started = performance.now()
    const result = read(series('FREQ=DAILY'), {
      displayTimeZone: 'Australia/Sydney',
      range: WEEK_OF_12_OCT,
    })
    const elapsed = performance.now() - started
    expect(result.errors).toEqual([])
    expect(result.events).toHaveLength(7)
    expect(elapsed).toBeLessThan(200)
  })

  it.each([
    ['FREQ=DAILY;INTERVAL=3'],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    ['FREQ=YEARLY;BYMONTH=10;BYDAY=2MO'],
    ['FREQ=HOURLY;INTERVAL=7'],
  ])('finds %s from 2010 quickly', (rule) => {
    const started = performance.now()
    const result = read(series(rule), {
      range: range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    })
    const elapsed = performance.now() - started
    expect(result.errors).toEqual([])
    expect(result.events.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })

  // Starting near the range must give what walking from the start gives. A COUNT large enough never
  // to end turns the shortcut off, so the same rule with and without it is the oracle.
  // `wide` rules are rare enough to need a longer window to produce anything.
  const oracleCases: [string, string, string, boolean][] = [
    [
      'every third day',
      'FREQ=DAILY;INTERVAL=3',
      'DTSTART;TZID=Europe/Berlin:20100104T090000',
      false,
    ],
    [
      'weekdays from a Saturday start',
      'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR',
      'DTSTART;TZID=Europe/Berlin:20100102T090000',
      false,
    ],
    [
      'every other week on Tuesday and Thursday',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
      'DTSTART;TZID=Europe/Berlin:20100105T090000',
      false,
    ],
    [
      'every other week with Sunday as week start',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU',
      'DTSTART;TZID=Europe/Berlin:20100103T090000',
      false,
    ],
    [
      'every fifth month on the 31st',
      'FREQ=MONTHLY;INTERVAL=5',
      'DTSTART;TZID=Europe/Berlin:20100131T090000',
      true,
    ],
    [
      'last weekday of the month',
      'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
      'DTSTART;TZID=Europe/Berlin:19900131T090000',
      false,
    ],
    [
      'fourth Thursday of November',
      'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH',
      'DTSTART;TZID=Europe/Berlin:19951123T090000',
      true,
    ],
    [
      'every other year',
      'FREQ=YEARLY;INTERVAL=2',
      'DTSTART;TZID=Europe/Berlin:20001027T090000',
      true,
    ],
    ['every fifth hour', 'FREQ=HOURLY;INTERVAL=5', 'DTSTART:20260601T000000Z', false],
    ['every 90 minutes', 'FREQ=MINUTELY;INTERVAL=90', 'DTSTART:20261001T000000Z', false],
    [
      'Mondays of week 43',
      'FREQ=YEARLY;BYWEEKNO=43;BYDAY=MO',
      'DTSTART;TZID=Europe/Berlin:20000103T090000',
      false,
    ],
    ['all-day every ten days', 'FREQ=DAILY;INTERVAL=10', 'DTSTART;VALUE=DATE:20150101', false],
    [
      'all-day last Friday',
      'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
      'DTSTART;VALUE=DATE:20150130',
      true,
    ],
  ]

  it.each(oracleCases)(
    'starting near the range gives the same as walking: %s',
    (_name, rule, dtstart, wide) => {
      const windows = wide
        ? [range('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z')]
        : [
            range('2026-10-12T00:00:00Z', '2026-10-26T00:00:00Z'),
            // Across the change of 25 Oct and across the start of the year.
            range('2026-10-24T00:00:00Z', '2026-10-29T00:00:00Z'),
            range('2026-12-28T00:00:00Z', '2027-01-04T00:00:00Z'),
          ]
      let found = 0
      for (const window of windows) {
        const fast = read(series(rule, dtstart), { range: window, displayTimeZone: 'UTC' })
        const walked = read(series(`${rule};COUNT=99999`, dtstart), {
          range: window,
          displayTimeZone: 'UTC',
          maxOccurrencesPerSeries: 100_000,
        })
        expect(walked.errors).toEqual([])
        expect(fast.errors).toEqual([])
        expect(fast.events.map((e) => [e.start, e.end, e.recurrenceId])).toEqual(
          walked.events.map((e) => [e.start, e.end, e.recurrenceId]),
        )
        found += fast.events.length
      }
      expect(found).toBeGreaterThan(0)
    },
  )

  it('finds a yearly 29 Feb only in leap years', () => {
    const window = range('2028-02-20T00:00:00Z', '2028-03-10T00:00:00Z')
    const odd = range('2026-02-20T00:00:00Z', '2026-03-10T00:00:00Z')
    for (const rule of ['FREQ=YEARLY', 'FREQ=YEARLY;BYMONTH=2', 'FREQ=YEARLY;COUNT=99999']) {
      const ics = series(rule, 'DTSTART;VALUE=DATE:20080229')
      expect(read(ics, { range: window }).events.map((e) => e.start)).toEqual(['2028-02-29'])
      expect(read(ics, { range: odd }).events).toEqual([])
    }
  })

  it('skips the months that have no 31st', () => {
    const ics = calendar(
      vevent(['DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;COUNT=5', 'SUMMARY:Month end']),
    )
    expect(read(ics).events.map((e) => e.start)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
    ])
  })

  it('walks a COUNT series from its start without counting the occurrences before the range', () => {
    const ics = series('FREQ=DAILY;COUNT=3000', 'DTSTART;TZID=Europe/Berlin:20260101T090000')
    const result = read(ics, { range: range('2026-12-01T00:00:00Z', '2026-12-08T00:00:00Z') })
    expect(result.errors).toEqual([])
    expect(result.events).toHaveLength(7)
  })

  it('stops a COUNT series at its count', () => {
    const ics = series('FREQ=DAILY;COUNT=10', 'DTSTART;TZID=Europe/Berlin:20100104T090000')
    expect(
      read(ics, { range: range('2010-01-01T00:00:00Z', '2030-01-01T00:00:00Z') }).events,
    ).toHaveLength(10)
  })
})

describe('the occurrence limit', () => {
  const endless = calendar(
    vevent(['DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', 'RRULE:FREQ=DAILY'], 'endless'),
  )

  it('cuts an endless rule at maxOccurrencesPerSeries and says so', () => {
    const result = read(endless, {
      maxOccurrencesPerSeries: 5,
      range: range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
    })
    expect(result.events).toHaveLength(5)
    expect(result.errors).toEqual([
      expect.objectContaining({ uid: 'endless', message: expect.stringContaining('limit') }),
    ])
  })

  it('does not reach the limit when the range holds fewer occurrences', () => {
    const result = read(endless, {
      maxOccurrencesPerSeries: 8,
      range: range('2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z'),
    })
    expect(result.events).toHaveLength(3)
    expect(result.errors).toEqual([])
  })

  it('applies a default limit of 2000 to a rule that produces more', () => {
    const everySecond = calendar(
      vevent(
        ['DTSTART:20261101T090000Z', 'DTEND:20261101T090000Z', 'RRULE:FREQ=SECONDLY'],
        'noisy',
      ),
    )
    const result = read(everySecond, {
      range: range('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
    })
    expect(result.events).toHaveLength(2000)
    expect(result.errors).toEqual([expect.objectContaining({ uid: 'noisy' })])
  })

  it('does not let one capped series cost the others', () => {
    const ics = calendar(
      vevent(['DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY'], 'endless'),
      vevent(['DTSTART:20261102T120000Z', 'DTEND:20261102T130000Z', 'SUMMARY:Single'], 'single'),
    )
    const result = read(ics, {
      maxOccurrencesPerSeries: 3,
      range: range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
    })
    expect(result.events.filter((event) => event.uid === 'single')).toHaveLength(1)
  })
})
