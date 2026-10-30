import { describe, expect, it } from 'vitest'
import {
  BERLIN_VTIMEZONE,
  calendar,
  fixture,
  lines,
  range,
  read,
  vevent,
  ZONE_SOURCES,
} from './ical-read-helpers'

// Single events: time sources, display zones, fields, range overlap. Series are in
// ical-read-recurrence.test.ts, zones in ical-read-zones.test.ts, damaged input in
// ical-read-robustness.test.ts.

describe('time sources', () => {
  it('reads a UTC time as an instant and shows it in the display zone', () => {
    const ics = fixture('e-utc.ics')
    expect(lines(read(ics).events)).toEqual(['2026-11-05T09:30:00 - 2026-11-05T10:30:00 E utc'])
    const sydney = read(ics, { displayTimeZone: 'Australia/Sydney' })
    expect(lines(sydney.events)).toEqual(['2026-11-05T19:30:00 - 2026-11-05T20:30:00 E utc'])
    const la = read(ics, { displayTimeZone: 'America/Los_Angeles' })
    expect(lines(la.events)).toEqual(['2026-11-05T00:30:00 - 2026-11-05T01:30:00 E utc'])
  })

  it('reads a TZID time in that zone: a Berlin 17:00 event is on the next day in Sydney', () => {
    const ics = calendar(
      vevent([
        'DTSTART;TZID=Europe/Berlin:20261104T170000',
        'DTEND;TZID=Europe/Berlin:20261104T180000',
      ]),
    )
    expect(lines(read(ics, { displayTimeZone: 'Europe/Berlin' }).events)).toEqual([
      '2026-11-04T17:00:00 - 2026-11-04T18:00:00 ',
    ])
    expect(lines(read(ics, { displayTimeZone: 'Australia/Sydney' }).events)).toEqual([
      '2026-11-05T03:00:00 - 2026-11-05T04:00:00 ',
    ])
    expect(lines(read(ics, { displayTimeZone: 'America/Los_Angeles' }).events)).toEqual([
      '2026-11-04T08:00:00 - 2026-11-04T09:00:00 ',
    ])
  })

  it('reads a floating time in the organization zone', () => {
    const ics = fixture('d-floating.ics')
    expect(lines(read(ics).events)).toEqual([
      '2026-11-04T10:00:00 - 2026-11-04T11:00:00 D floating',
    ])
    // 10:00 Berlin (CET) is 09:00Z.
    expect(lines(read(ics, { displayTimeZone: 'Australia/Sydney' }).events)).toEqual([
      '2026-11-04T20:00:00 - 2026-11-04T21:00:00 D floating',
    ])
    expect(lines(read(ics, { displayTimeZone: 'America/Los_Angeles' }).events)).toEqual([
      '2026-11-04T01:00:00 - 2026-11-04T02:00:00 D floating',
    ])
    // Another organization zone gives another instant.
    expect(
      lines(read(ics, { orgTimeZone: 'Asia/Tokyo', displayTimeZone: 'Europe/Berlin' }).events),
    ).toEqual(['2026-11-04T02:00:00 - 2026-11-04T03:00:00 D floating'])
  })

  it('reads DATE values as all-day events that never move between zones', () => {
    const ics = fixture('c-allday-cancelled.ics')
    for (const displayTimeZone of [
      'Europe/Berlin',
      'Australia/Sydney',
      'America/Los_Angeles',
      'UTC',
    ]) {
      const [event] = read(ics, { displayTimeZone }).events
      expect(event).toMatchObject({ start: '2026-11-03', end: '2026-11-06', allDay: true })
    }
  })

  it('keeps a midnight-to-midnight timed event timed', () => {
    const ics = calendar(vevent(['DTSTART:20261110T000000Z', 'DTEND:20261111T000000Z']))
    const [event] = read(ics, { displayTimeZone: 'UTC' }).events
    expect(event).toMatchObject({
      start: '2026-11-10T00:00:00',
      end: '2026-11-11T00:00:00',
      allDay: false,
    })
  })

  it('reads a time written with a TZID the same as the zone-aware instant', () => {
    // The same instant, three ways of writing it.
    const instants = [
      'DTSTART:20261110T090000Z',
      'DTSTART;TZID=Europe/Berlin:20261110T100000',
      'DTSTART;TZID=America/Los_Angeles:20261110T010000',
    ]
    for (const line of instants) {
      const [event] = read(calendar(vevent([line])), { displayTimeZone: 'UTC' }).events
      expect(event?.start).toBe('2026-11-10T09:00:00')
    }
  })
})

describe('end of an event', () => {
  it('gives an all-day event without DTEND one day', () => {
    const ics = calendar(vevent(['DTSTART;VALUE=DATE:20261110']))
    expect(read(ics).events[0]).toMatchObject({
      start: '2026-11-10',
      end: '2026-11-11',
      allDay: true,
    })
  })

  it('uses DURATION for a timed event without DTEND', () => {
    const ics = calendar(vevent(['DTSTART:20261110T090000Z', 'DURATION:PT1H30M']))
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-11-10T09:00:00 - 2026-11-10T10:30:00 ',
    ])
  })

  it('counts a DURATION of days on the wall clock of the start zone', () => {
    const ics = calendar(
      BERLIN_VTIMEZONE,
      vevent(['DTSTART;TZID=Europe/Berlin:20261024T120000', 'DURATION:P2D']),
    )
    // Two nominal days over the change of 25 Oct are 49 hours.
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-10-24T10:00:00 - 2026-10-26T11:00:00 ',
    ])
  })

  it('gives an all-day event with a DURATION in days', () => {
    const ics = calendar(vevent(['DTSTART;VALUE=DATE:20261110', 'DURATION:P3D']))
    expect(read(ics).events[0]).toMatchObject({ start: '2026-11-10', end: '2026-11-13' })
  })

  it('gives a timed event with neither DTEND nor DURATION no length', () => {
    const ics = calendar(vevent(['DTSTART:20261110T090000Z']))
    const [event] = read(ics, { displayTimeZone: 'UTC' }).events
    expect(event?.start).toBe('2026-11-10T09:00:00')
    expect(event?.end).toBe('2026-11-10T09:00:00')
  })

  it('prefers DTEND over DURATION', () => {
    const ics = calendar(
      vevent(['DTSTART:20261110T090000Z', 'DTEND:20261110T100000Z', 'DURATION:PT5H']),
    )
    expect(read(ics, { displayTimeZone: 'UTC' }).events[0]?.end).toBe('2026-11-10T10:00:00')
  })

  it('warns about a DTEND before DTSTART and reads the event without length', () => {
    const ics = calendar(
      vevent(['DTSTART:20261110T090000Z', 'DTEND:20261110T080000Z'], 'backwards'),
    )
    const result = read(ics, { displayTimeZone: 'UTC' })
    expect(result.events[0]).toMatchObject({
      start: '2026-11-10T09:00:00',
      end: '2026-11-10T09:00:00',
    })
    expect(result.errors).toEqual([
      expect.objectContaining({ uid: 'backwards', severity: 'warning' }),
    ])
  })

  it('reads DTSTART and DTEND in their own zones', () => {
    const ics = calendar(
      vevent([
        'DTSTART;TZID=Europe/Berlin:20261110T090000',
        'DTEND;TZID=America/New_York:20261110T110000',
      ]),
    )
    // 09:00 CET = 08:00Z; 11:00 EST = 16:00Z.
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-11-10T08:00:00 - 2026-11-10T16:00:00 ',
    ])
  })

  it('gives a multi-day all-day event its exclusive end', () => {
    expect(read(fixture('c-allday-cancelled.ics')).events[0]).toMatchObject({
      start: '2026-11-03',
      end: '2026-11-06',
    })
  })

  it('keeps a multi-day timed event as one event', () => {
    const ics = calendar(
      BERLIN_VTIMEZONE,
      vevent([
        'DTSTART;TZID=Europe/Berlin:20261030T220000',
        'DTEND;TZID=Europe/Berlin:20261102T060000',
        'SUMMARY:Conference',
      ]),
    )
    expect(lines(read(ics).events)).toEqual([
      '2026-10-30T22:00:00 - 2026-11-02T06:00:00 Conference',
    ])
  })
})

describe('daylight saving edges of single events', () => {
  // Twice: with the zone defined in the file (VTIMEZONE) and with the runtime's IANA data.
  for (const [label, vtimezone] of ZONE_SOURCES) {
    describe(label, () => {
      it('reads the repeated 02:30 of 25 Oct 2026 as the first one', () => {
        const ics = calendar(
          vtimezone,
          vevent([
            'DTSTART;TZID=Europe/Berlin:20261025T023000',
            'DTEND;TZID=Europe/Berlin:20261025T033000',
          ]),
        )
        // 02:30 CEST = 00:30Z; 03:30 is after the change (CET) = 02:30Z.
        expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
          '2026-10-25T00:30:00 - 2026-10-25T02:30:00 ',
        ])
        expect(lines(read(ics, { displayTimeZone: 'Europe/Berlin' }).events)).toEqual([
          '2026-10-25T02:30:00 - 2026-10-25T03:30:00 ',
        ])
        expect(lines(read(ics, { displayTimeZone: 'Australia/Sydney' }).events)).toEqual([
          '2026-10-25T11:30:00 - 2026-10-25T13:30:00 ',
        ])
      })

      it('reads the missing 02:30 of 29 Mar 2026 with the offset from before the gap', () => {
        const ics = calendar(
          vtimezone,
          vevent([
            'DTSTART;TZID=Europe/Berlin:20260329T023000',
            'DTEND;TZID=Europe/Berlin:20260329T043000',
          ]),
        )
        // 02:30 does not exist; with +01:00 it is 01:30Z. 04:30 CEST = 02:30Z.
        expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
          '2026-03-29T01:30:00 - 2026-03-29T02:30:00 ',
        ])
        expect(lines(read(ics, { displayTimeZone: 'Europe/Berlin' }).events)).toEqual([
          '2026-03-29T03:30:00 - 2026-03-29T04:30:00 ',
        ])
      })
    })
  }

  it('reads a floating time in the repeated hour in the organization zone', () => {
    const ics = calendar(vevent(['DTSTART:20261025T023000', 'DTEND:20261025T033000']))
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-10-25T00:30:00 - 2026-10-25T02:30:00 ',
    ])
  })
})

describe('event fields', () => {
  it('fills the CalendarEvent of a single event', () => {
    const result = read(fixture('e-utc.ics'), { etag: '"abc"' })
    expect(result.errors).toEqual([])
    expect(result.events).toEqual([
      {
        id: 'dav:/caldav/u/c/|/caldav/u/c/test.ics|',
        calendarId: 'dav:/caldav/u/c/',
        uid: 'e-utc',
        title: 'E utc',
        start: '2026-11-05T09:30:00',
        end: '2026-11-05T10:30:00',
        allDay: false,
        status: 'confirmed',
        categoryIds: [],
        categoryNames: [],
        etag: '"abc"',
        href: '/caldav/u/c/test.ics',
        lastModified: '2026-10-01T12:00:00.000Z',
        recurring: false,
      },
    ])
  })

  it('leaves out what the event does not have', () => {
    const [event] = read(fixture('d-floating.ics')).events
    expect(event).not.toHaveProperty('etag')
    expect(event).not.toHaveProperty('lastModified')
    expect(event).not.toHaveProperty('description')
    expect(event).not.toHaveProperty('location')
    expect(event).not.toHaveProperty('recurrenceId')
  })

  it('keeps an empty SUMMARY and a missing one as an empty title', () => {
    expect(read(calendar(vevent(['DTSTART:20261110T090000Z', 'SUMMARY:']))).events[0]?.title).toBe(
      '',
    )
    expect(read(calendar(vevent(['DTSTART:20261110T090000Z']))).events[0]?.title).toBe('')
  })

  it('maps STATUS: confirmed by default, tentative, cancelled', () => {
    const status = (value: string | null): string | undefined =>
      read(calendar(vevent(['DTSTART:20261110T090000Z', ...(value ? [`STATUS:${value}`] : [])])))
        .events[0]?.status
    expect(status(null)).toBe('confirmed')
    expect(status('CONFIRMED')).toBe('confirmed')
    expect(status('TENTATIVE')).toBe('tentative')
    expect(status('CANCELLED')).toBe('cancelled')
    expect(status('cancelled')).toBe('cancelled')
    expect(status('NEEDS-ACTION')).toBe('confirmed')
  })

  it('returns a cancelled event with status cancelled', () => {
    expect(read(fixture('c-allday-cancelled.ics')).events[0]?.status).toBe('cancelled')
  })

  it('unescapes text and keeps the commas of CATEGORIES values apart', () => {
    const [event] = read(fixture('b-lastweekday.ics'), {
      range: range('2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z'),
    }).events
    expect(event).toMatchObject({
      title: 'B last weekday',
      location: 'Room 1, Floor 2',
      description: 'Line one\nLine two, with comma',
      categoryNames: ['Work', 'Meeting'],
      categoryIds: [],
    })
  })

  it('collects the values of all CATEGORIES properties', () => {
    const ics = calendar(
      vevent([
        'DTSTART:20261110T090000Z',
        'CATEGORIES:Work,Meeting',
        'CATEGORIES:Team A',
        'CATEGORIES:Big\\, loud,Quiet',
        'CATEGORIES:Work',
      ]),
    )
    expect(read(ics).events[0]?.categoryNames).toEqual([
      'Work',
      'Meeting',
      'Team A',
      'Big, loud',
      'Quiet',
    ])
  })

  it('joins folded lines and unescapes \\, \\; \\\\ and \\n', () => {
    const [event] = read(fixture('folded-escaped.ics')).events
    expect(event?.title).toBe(
      'A very long title that the producing client folded in the middle of a word and again after a space so the join must be exact',
    )
    expect(event?.location).toBe('Room 1, Floor 2; Building \\ North')
    expect(event?.description).toBe(
      'Line one\nLine two, with comma\nUmlauts: äöü ß and an emoji 📅 that splits mid-sequence',
    )
  })

  it('reads LAST-MODIFIED as an ISO instant', () => {
    const ics = calendar(
      vevent(['DTSTART:20261110T090000Z', 'LAST-MODIFIED;TZID=Europe/Berlin:20261001T140000']),
    )
    expect(read(ics).events[0]?.lastModified).toBe('2026-10-01T12:00:00.000Z')
  })

  it('ignores a LAST-MODIFIED it cannot read', () => {
    const ics = calendar(vevent(['DTSTART:20261110T090000Z', 'LAST-MODIFIED:not a date']))
    const result = read(ics)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).not.toHaveProperty('lastModified')
  })

  it('reads VEVENTs only', () => {
    const result = read(fixture('feed.ics'), {
      range: range('2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z'),
    })
    expect(result.errors).toEqual([])
    expect(lines(result.events)).toEqual([
      '2026-10-31 - 2026-11-01 Reformation Day',
      '2026-11-01 - 2026-11-02 All Saints',
      '2026-11-01 - 2026-11-02 Yearly feast',
    ])
  })

  it('keeps ids unique in a resource with several UIDs (a subscription feed)', () => {
    const { events } = read(fixture('feed.ics'), {
      range: range('2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z'),
    })
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(events[0]?.id).toBe('dav:/caldav/u/c/|/caldav/u/c/test.ics||holiday-1')
  })
})

describe('range', () => {
  const event = calendar(vevent(['DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z']))
  const count = (start: string, end: string): number =>
    read(event, { range: range(start, end) }).events.length

  it('includes events that overlap [start, end) and excludes the ones that only touch it', () => {
    expect(count('2026-11-10T09:00:00Z', '2026-11-10T12:00:00Z')).toBe(1)
    expect(count('2026-11-10T10:30:00Z', '2026-11-10T10:40:00Z')).toBe(1)
    expect(count('2026-11-10T10:59:59Z', '2026-11-10T12:00:00Z')).toBe(1)
    expect(count('2026-11-10T11:00:00Z', '2026-11-10T12:00:00Z')).toBe(0)
    expect(count('2026-11-10T09:00:00Z', '2026-11-10T10:00:01Z')).toBe(1)
    expect(count('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z')).toBe(0)
  })

  it('includes a zero-length event at the start of the range and not at its end', () => {
    const point = calendar(vevent(['DTSTART:20261110T100000Z']))
    const hits = (start: string, end: string): number =>
      read(point, { range: range(start, end) }).events.length
    expect(hits('2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z')).toBe(1)
    expect(hits('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z')).toBe(0)
    expect(hits('2026-11-10T10:00:01Z', '2026-11-10T11:00:00Z')).toBe(0)
    expect(hits('2026-11-10T09:00:00Z', '2026-11-10T11:00:00Z')).toBe(1)
  })

  it('compares instants, not strings in different zones', () => {
    // 23:30 in Los Angeles on 9 Nov is 07:30Z on 10 Nov.
    const ics = calendar(vevent(['DTSTART:20261110T073000Z', 'DTEND:20261110T083000Z']))
    const hit = (displayTimeZone: string): number =>
      read(ics, { displayTimeZone, range: range('2026-11-10T07:00:00Z', '2026-11-10T08:00:00Z') })
        .events.length
    expect(hit('America/Los_Angeles')).toBe(1)
    expect(hit('Australia/Sydney')).toBe(1)
    expect(hit('Europe/Berlin')).toBe(1)
  })

  it('includes a multi-day timed event that began before the range', () => {
    const ics = calendar(
      vevent(['DTSTART:20261030T210000Z', 'DTEND:20261102T050000Z', 'SUMMARY:Conference']),
    )
    const result = read(ics, {
      displayTimeZone: 'UTC',
      range: range('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
    })
    expect(lines(result.events)).toEqual(['2026-10-30T21:00:00 - 2026-11-02T05:00:00 Conference'])
  })

  it('checks all-day events against the days of the display zone', () => {
    const ics = calendar(vevent(['DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261106']))
    const hit = (displayTimeZone: string, start: string): number =>
      read(ics, { displayTimeZone, range: range(start, '2026-11-20T00:00:00Z') }).events.length
    // The event ends at 00:00 on 6 Nov, which is 23:00Z on 5 Nov in Berlin.
    expect(hit('Europe/Berlin', '2026-11-05T22:59:59Z')).toBe(1)
    expect(hit('Europe/Berlin', '2026-11-05T23:00:00Z')).toBe(0)
    // ... and 13:00Z in Sydney (+11).
    expect(hit('Australia/Sydney', '2026-11-05T12:59:59Z')).toBe(1)
    expect(hit('Australia/Sydney', '2026-11-05T13:00:00Z')).toBe(0)
  })

  it('returns events sorted by start', () => {
    const ics = calendar(
      vevent(['DTSTART:20261112T090000Z'], 'c'),
      vevent(['DTSTART:20261110T090000Z'], 'a'),
      vevent(['DTSTART:20261111T090000Z'], 'b'),
    )
    expect(read(ics).events.map((e) => e.uid)).toEqual(['a', 'b', 'c'])
  })
})
