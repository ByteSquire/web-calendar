import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { zoneFromVtimezone } from '../app/utils/ical/read-vtimezone'
import {
  formatUtcInstant,
  formatWall,
  ianaZone,
  instantToWall,
  instantToWallClock,
  parseUtcInstant,
  parseWall,
  wallClockToInstant,
  wallFromFields,
  wallToInstant,
} from '../app/utils/ical/zone'
import { convertWallClock } from '../app/utils/time-zone'
import {
  BERLIN_VTIMEZONE,
  calendar,
  fixture,
  lines,
  range,
  read,
  vevent,
} from './ical-read-helpers'

// zone.ts (instant <-> wall clock), the VTIMEZONE reader, and how the reader picks a zone for a
// value: file VTIMEZONE, IANA name, libical-style TZID, floating time, unknown name.

const utcOf = (wall: string, zone: string): string =>
  formatUtcInstant(wallClockToInstant(wall, zone)).slice(0, 19)

describe('wallClockToInstant', () => {
  // [zone, wall time, instant (UTC)] at the edges of daylight saving; the rule of RFC 5545
  // §3.3.5 in both directions.
  const edges: [string, string, string][] = [
    ['Europe/Berlin', '2026-10-25T01:59:59', '2026-10-24T23:59:59'],
    ['Europe/Berlin', '2026-10-25T02:00:00', '2026-10-25T00:00:00'],
    ['Europe/Berlin', '2026-10-25T02:30:00', '2026-10-25T00:30:00'], // repeated: the first
    ['Europe/Berlin', '2026-10-25T02:59:59', '2026-10-25T00:59:59'],
    ['Europe/Berlin', '2026-10-25T03:00:00', '2026-10-25T02:00:00'],
    ['Europe/Berlin', '2026-03-29T01:59:59', '2026-03-29T00:59:59'],
    ['Europe/Berlin', '2026-03-29T02:00:00', '2026-03-29T01:00:00'], // missing: offset before the gap
    ['Europe/Berlin', '2026-03-29T02:30:00', '2026-03-29T01:30:00'],
    ['Europe/Berlin', '2026-03-29T03:00:00', '2026-03-29T01:00:00'],
    ['America/New_York', '2026-11-01T01:30:00', '2026-11-01T05:30:00'],
    ['America/New_York', '2026-03-08T02:30:00', '2026-03-08T07:30:00'],
    ['Australia/Sydney', '2026-04-05T02:30:00', '2026-04-04T15:30:00'],
    ['Australia/Sydney', '2026-10-04T02:30:00', '2026-10-03T16:30:00'],
    ['Australia/Lord_Howe', '2026-04-05T01:45:00', '2026-04-04T14:45:00'], // a 30 minute change
    ['Asia/Kolkata', '2026-10-25T02:30:00', '2026-10-24T21:00:00'],
    ['Pacific/Kiritimati', '2026-06-01T12:00:00', '2026-05-31T22:00:00'], // +14:00
    ['Pacific/Pago_Pago', '2026-06-01T12:00:00', '2026-06-01T23:00:00'], // -11:00
    ['UTC', '2026-06-01T12:00:00', '2026-06-01T12:00:00'],
  ]

  it.each(edges)('%s %s is %s', (zone, wall, utc) => {
    expect(utcOf(wall, zone)).toBe(utc)
  })

  it('agrees with convertWallClock everywhere around the changes', () => {
    const sweeps: [string, string[]][] = [
      ['Europe/Berlin', ['2026-03-29', '2026-10-25']],
      ['America/New_York', ['2026-03-08', '2026-11-01']],
      ['Australia/Sydney', ['2026-04-05', '2026-10-04']],
      ['Australia/Lord_Howe', ['2026-04-05', '2026-10-04']],
      ['America/Sao_Paulo', ['2018-11-04', '2019-02-17']], // midnight changes
      ['Africa/Casablanca', ['2026-03-15', '2026-02-15']],
    ]
    for (const [zone, days] of sweeps) {
      for (const day of days) {
        const first = Date.parse(`${day}T00:00:00Z`) - 2 * 86_400_000
        for (let step = 0; step < 4 * 24 * 4; step++) {
          const wall = formatWall(first + step * 15 * 60_000)
          const expected = `${convertWallClock(wall, zone, 'UTC')}`
          expect(utcOf(wall, zone), `${zone} ${wall}`).toBe(expected)
        }
      }
    }
  })

  it('rejects what is not a wall-clock time or a zone', () => {
    expect(() => wallClockToInstant('2026-10-25T02:30:00Z', 'Europe/Berlin')).toThrow(RangeError)
    expect(() => wallClockToInstant('nonsense', 'Europe/Berlin')).toThrow(RangeError)
    expect(() => wallClockToInstant('2026-10-25T02:30:00', 'Mars/Olympus')).toThrow(RangeError)
  })
})

describe('instantToWall', () => {
  it('is the wall clock of the zone at that instant', () => {
    const instant = Date.parse('2026-10-25T00:30:00Z')
    expect(instantToWallClock(instant, 'Europe/Berlin')).toBe('2026-10-25T02:30:00')
    expect(instantToWallClock(instant + 3_600_000, 'Europe/Berlin')).toBe('2026-10-25T02:30:00')
    expect(instantToWallClock(instant, 'Australia/Sydney')).toBe('2026-10-25T11:30:00')
    expect(instantToWallClock(instant, 'America/Los_Angeles')).toBe('2026-10-24T17:30:00')
    expect(formatWall(instantToWall(instant, ianaZone('Asia/Kolkata')))).toBe('2026-10-25T06:00:00')
  })
})

describe('wall time helpers', () => {
  it('builds wall times only from real dates and times', () => {
    expect(wallFromFields(2026, 2, 28)).toBe(Date.UTC(2026, 1, 28))
    expect(wallFromFields(2028, 2, 29)).toBe(Date.UTC(2028, 1, 29))
    expect(wallFromFields(0, 1, 1, 0, 0, 0)).not.toBeNull()
    for (const bad of [
      [2026, 2, 29],
      [2026, 13, 1],
      [2026, 0, 1],
      [2026, 4, 31],
      [2026, 1, 1, 24, 0, 0],
      [2026, 1, 1, 0, 60, 0],
      [2026, 1, 1, 0, 0, 61],
      [2026.5, 1, 1],
      [10_000, 1, 1],
      [Number.NaN, 1, 1],
    ] as [number, number, number, number?, number?, number?][]) {
      expect(wallFromFields(...bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('parses and formats the forms the reader uses', () => {
    expect(parseWall('2026-10-25')).toMatchObject({ hasTime: false, utc: false })
    expect(parseWall('2026-10-25T02:30')).toMatchObject({ hasTime: true, utc: false })
    expect(parseWall('2026-10-25T02:30:15Z')).toMatchObject({ hasTime: true, utc: true })
    for (const bad of [
      '',
      'x',
      '2026-10-25Z',
      '2026-02-30',
      '2026-10-25T25:00:00',
      '20261025T023000',
    ]) {
      expect(parseWall(bad), bad).toBeNull()
    }
    expect(formatWall(Date.UTC(2026, 9, 5, 7, 4, 3))).toBe('2026-10-05T07:04:03')
    expect(formatUtcInstant(Date.UTC(2026, 9, 5, 7, 4, 3))).toBe('2026-10-05T07:04:03Z')
    expect(parseUtcInstant('2026-10-05T07:04:03Z')).toBe(Date.UTC(2026, 9, 5, 7, 4, 3))
    expect(parseUtcInstant('2026-10-05T07:04:03')).toBeNaN()
  })
})

describe('zones from a VTIMEZONE', () => {
  const vtimezone = (lines: string[]): ReturnType<typeof zoneFromVtimezone> => {
    const root = new ICAL.Component(
      ICAL.parse(['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n')),
    )
    return zoneFromVtimezone(root.getFirstSubcomponent('vtimezone') as ICAL.Component)
  }
  const outlook = fixture('outlook-tz.ics')
    .split(/\r?\n/)
    .slice(
      fixture('outlook-tz.ics').split(/\r?\n/).indexOf('BEGIN:VTIMEZONE'),
      fixture('outlook-tz.ics').split(/\r?\n/).indexOf('END:VTIMEZONE') + 1,
    )

  it.each([
    ['the spike VTIMEZONE (starts in 1970)', BERLIN_VTIMEZONE],
    ['an Outlook VTIMEZONE (starts in 1601)', outlook],
  ])('has the offsets of Europe/Berlin: %s', (_name, source) => {
    const zone = vtimezone(source)
    const berlin = ianaZone('Europe/Berlin')
    expect(zone).not.toBeNull()
    // At and around the changes of 2026 ...
    for (const [instant, offset] of [
      ['2026-03-29T00:59:59Z', 3600],
      ['2026-03-29T01:00:00Z', 7200],
      ['2026-10-25T00:59:59Z', 7200],
      ['2026-10-25T01:00:00Z', 3600],
    ] as const) {
      expect(zone?.offsetAt(Date.parse(instant)), instant).toBe(offset)
    }
    // ... and every 11 hours over several years.
    for (let at = Date.UTC(2015, 0, 1); at < Date.UTC(2036, 0, 1); at += 11 * 3_600_000) {
      if (zone?.offsetAt(at) !== berlin.offsetAt(at)) {
        throw new Error(`offsets differ at ${new Date(at).toISOString()}`)
      }
    }
  })

  it('has the same wall time to instant answer as the IANA zone in the repeated hour and the gap', () => {
    const zone = vtimezone(BERLIN_VTIMEZONE)
    const berlin = ianaZone('Europe/Berlin')
    for (const wall of ['2026-10-25T02:30:00', '2026-03-29T02:30:00', '2026-10-25T03:00:00']) {
      const parsed = parseWall(wall)?.wall as number
      expect(wallToInstant(parsed, zone as NonNullable<typeof zone>)).toBe(
        wallToInstant(parsed, berlin),
      )
    }
  })

  it('handles a zone with a fixed unusual offset', () => {
    const zone = vtimezone([
      'BEGIN:VTIMEZONE',
      'TZID:Nowhere',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0345',
      'TZOFFSETTO:+0345',
      'END:STANDARD',
      'END:VTIMEZONE',
    ])
    expect(zone?.offsetAt(Date.UTC(2026, 5, 1))).toBe(3 * 3600 + 45 * 60)
    expect(zone?.offsetAt(Date.UTC(1950, 5, 1))).toBe(3 * 3600 + 45 * 60)
  })

  it('handles RDATE onsets and an observance that ends with UNTIL', () => {
    const zone = vtimezone([
      'BEGIN:VTIMEZONE',
      'TZID:Retired',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700301T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=1SU;UNTIL=20091231T000000Z',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:19701001T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU;UNTIL=20091231T000000Z',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20110101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RDATE:20110601T000000',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ])
    expect(zone?.offsetAt(Date.UTC(2005, 6, 1))).toBe(7200) // in the rule's time
    expect(zone?.offsetAt(Date.UTC(2005, 11, 1))).toBe(3600)
    expect(zone?.offsetAt(Date.UTC(2020, 6, 1))).toBe(7200) // after the rule ended, the RDATE stays
  })

  it('returns null for a VTIMEZONE without a usable part', () => {
    expect(vtimezone(['BEGIN:VTIMEZONE', 'TZID:Empty', 'END:VTIMEZONE'])).toBeNull()
    expect(
      vtimezone([
        'BEGIN:VTIMEZONE',
        'TZID:Broken',
        'BEGIN:STANDARD',
        'DTSTART:nonsense',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0100',
        'END:STANDARD',
        'END:VTIMEZONE',
      ]),
    ).toBeNull()
  })

  it('survives a rule inside the VTIMEZONE that loops or is invalid', () => {
    const zone = vtimezone([
      'BEGIN:VTIMEZONE',
      'TZID:Hostile',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=SECONDLY',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700301T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ])
    const started = performance.now()
    expect(typeof zone?.offsetAt(Date.UTC(2026, 5, 1))).toBe('number')
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('files with a VTIMEZONE', () => {
  it('reads an Outlook file: its zone name is not an IANA name, the VTIMEZONE defines it', () => {
    const result = read(fixture('outlook-tz.ics'), {
      displayTimeZone: 'UTC',
      range: range('2026-10-01T00:00:00Z', '2026-11-10T00:00:00Z'),
    })
    expect(result.errors).toEqual([])
    expect(lines(result.events)).toEqual([
      '2026-10-13T07:00:00 - 2026-10-13T08:00:00 Outlook weekly',
      '2026-10-20T07:00:00 - 2026-10-20T08:00:00 Outlook weekly',
      // 02:30 on 25 Oct is the first 02:30 (CEST); 03:30 is CET.
      '2026-10-25T00:30:00 - 2026-10-25T02:30:00 Outlook single in the repeated hour',
      '2026-10-27T08:00:00 - 2026-10-27T09:00:00 Outlook weekly',
      '2026-11-03T08:00:00 - 2026-11-03T09:00:00 Outlook weekly',
    ])
  })

  it('reads a zone that exists only in the file', () => {
    const result = read(fixture('custom-vtimezone.ics'), { displayTimeZone: 'UTC' })
    expect(result.errors).toEqual([])
    expect(lines(result.events)).toEqual([
      // Acme branch: -03:00 in winter and -02:00 from the second Sunday of March.
      '2026-07-15T14:00:00 - 2026-07-15T15:00:00 Acme branch in summer time',
      // Acme Headquarters: +03:45.
      '2026-11-04T06:15:00 - 2026-11-04T07:45:00 Acme HQ meeting',
      '2026-12-15T15:00:00 - 2026-12-15T16:00:00 Acme branch in winter time',
    ])
  })

  it('prefers the VTIMEZONE of the file over the runtime zone of the same name', () => {
    const ics = calendar(
      [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0500',
        'TZOFFSETTO:+0500',
        'END:STANDARD',
        'END:VTIMEZONE',
      ],
      vevent([
        'DTSTART;TZID=Europe/Berlin:20261110T100000',
        'DTEND;TZID=Europe/Berlin:20261110T110000',
      ]),
    )
    expect(lines(read(ics, { displayTimeZone: 'UTC' }).events)).toEqual([
      '2026-11-10T05:00:00 - 2026-11-10T06:00:00 ',
    ])
  })

  it('falls back to the IANA zone when the VTIMEZONE of that name is unusable', () => {
    const ics = calendar(
      ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'END:VTIMEZONE'],
      vevent([
        'DTSTART;TZID=Europe/Berlin:20261110T100000',
        'DTEND;TZID=Europe/Berlin:20261110T110000',
      ]),
    )
    const result = read(ics, { displayTimeZone: 'UTC' })
    expect(result.errors).toEqual([])
    expect(lines(result.events)).toEqual(['2026-11-10T09:00:00 - 2026-11-10T10:00:00 '])
  })

  it('gives the same events with the VTIMEZONE as without (the IANA data)', () => {
    const body = [
      'UID:same',
      'DTSTART;TZID=Europe/Berlin:20260315T023000',
      'DTEND;TZID=Europe/Berlin:20260315T033000',
      'RRULE:FREQ=WEEKLY;COUNT=60',
    ]
    for (const displayTimeZone of [
      'UTC',
      'Europe/Berlin',
      'Australia/Sydney',
      'America/Los_Angeles',
    ]) {
      const window = {
        displayTimeZone,
        range: range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
      }
      const withFile = read(calendar(BERLIN_VTIMEZONE, vevent(body)), window)
      const without = read(calendar(vevent(body)), window)
      expect(withFile.errors).toEqual([])
      // Every Sunday from 15 Mar to 27 Dec, among them the gap and the repeated hour.
      expect(withFile.events).toHaveLength(42)
      expect(withFile.events).toEqual(without.events)
    }
  })
})

describe('zone names without a VTIMEZONE', () => {
  const event = (tzid: string): string =>
    calendar(
      vevent(
        [`DTSTART;TZID=${tzid}:20261110T100000`, `DTEND;TZID=${tzid}:20261110T110000`],
        'zoned',
      ),
    )
  const utc = { displayTimeZone: 'UTC' }

  it('reads an IANA name with the runtime database', () => {
    expect(lines(read(event('America/New_York'), utc).events)).toEqual([
      '2026-11-10T15:00:00 - 2026-11-10T16:00:00 ',
    ])
  })

  it.each([
    '/freeassociation.sourceforge.net/Tzfile/Europe/Berlin',
    '/mozilla.org/20070129_1/Europe/Berlin',
    '/softwarestudio.org/Olson_20011030_5/Europe/Berlin',
  ])('reads the libical name %s', (tzid) => {
    const result = read(event(tzid), utc)
    expect(result.errors).toEqual([])
    expect(result.events[0]?.start).toBe('2026-11-10T09:00:00')
  })

  it('reads a libical name with a region in the path', () => {
    const result = read(
      event('/softwarestudio.org/Olson_20011030_5/America/Argentina/Buenos_Aires'),
      utc,
    )
    expect(result.errors).toEqual([])
    expect(result.events[0]?.start).toBe('2026-11-10T13:00:00')
  })

  it('reads an unknown zone as organization time and says so, with the uid', () => {
    const result = read(event('Mars/Olympus'), utc)
    expect(result.events[0]?.start).toBe('2026-11-10T09:00:00') // 10:00 Berlin
    expect(result.errors).toEqual([
      { uid: 'zoned', severity: 'warning', message: expect.stringContaining('Mars/Olympus') },
    ])
  })

  it('reads an unknown zone in the organization zone, whichever that is', () => {
    const result = read(event('W. Europe Standard Time'), { ...utc, orgTimeZone: 'Asia/Tokyo' })
    expect(result.events[0]?.start).toBe('2026-11-10T01:00:00')
  })

  it('warns once per event for a zone used in several of its values', () => {
    const ics = calendar(
      vevent(
        ['DTSTART;TZID=Mars/Olympus:20261110T100000', 'DTEND;TZID=Mars/Olympus:20261110T110000'],
        'one',
      ),
      vevent(['DTSTART;TZID=Mars/Olympus:20261111T100000'], 'two'),
    )
    const warnings = read(ics, utc).errors
    expect(warnings.map((issue) => issue.uid)).toEqual(['one', 'two'])
  })

  it('does not take an unknown zone for a reason to drop the other events', () => {
    const ics = calendar(
      vevent(['DTSTART;TZID=Mars/Olympus:20261110T100000'], 'odd'),
      vevent(['DTSTART:20261110T100000Z'], 'fine'),
    )
    expect(read(ics, utc).events.map((e) => e.uid)).toEqual(['odd', 'fine'])
  })
})

describe('floating times', () => {
  it('runs a floating series in the organization zone, daylight saving included', () => {
    const ics = calendar(
      vevent(['DTSTART:20261023T023000', 'DTEND:20261023T024500', 'RRULE:FREQ=DAILY;COUNT=5']),
    )
    expect(read(ics, { displayTimeZone: 'UTC' }).events.map((e) => e.start)).toEqual([
      '2026-10-23T00:30:00',
      '2026-10-24T00:30:00',
      '2026-10-25T00:30:00',
      '2026-10-26T01:30:00',
      '2026-10-27T01:30:00',
    ])
    expect(
      read(ics, { displayTimeZone: 'UTC', orgTimeZone: 'America/New_York' }).events.map(
        (e) => e.start,
      ),
    ).toEqual([
      '2026-10-23T06:30:00',
      '2026-10-24T06:30:00',
      '2026-10-25T06:30:00',
      '2026-10-26T06:30:00',
      '2026-10-27T06:30:00',
    ])
  })
})

describe('options', () => {
  const ics = calendar(vevent(['DTSTART:20261110T090000Z', 'DTEND:20261110T100000Z']))

  it('falls back to the organization zone for an unusable display zone, with a warning', () => {
    const result = read(ics, { displayTimeZone: 'Nowhere/Land', orgTimeZone: 'Asia/Tokyo' })
    expect(result.events[0]?.start).toBe('2026-11-10T18:00:00')
    expect(result.errors).toEqual([expect.objectContaining({ severity: 'warning' })])
  })

  it('falls back to Europe/Berlin for an unusable organization zone, with a warning', () => {
    const result = read(ics, { displayTimeZone: 'UTC', orgTimeZone: 'Nowhere/Land' })
    expect(result.events).toHaveLength(1)
    expect(result.errors).toEqual([expect.objectContaining({ severity: 'warning' })])
  })

  it('returns an error instead of throwing for an unusable range', () => {
    const result = read(ics, { range: { start: new Date('nope'), end: new Date() } })
    expect(result.events).toEqual([])
    expect(result.errors).toHaveLength(1)
  })

  it('uses the default occurrence limit for a limit that makes no sense', () => {
    const endless = calendar(vevent(['DTSTART:20261110T090000Z', 'RRULE:FREQ=DAILY']))
    for (const maxOccurrencesPerSeries of [0, -3, Number.NaN, 2.5]) {
      const result = read(endless, {
        maxOccurrencesPerSeries,
        range: range('2026-11-10T00:00:00Z', '2026-11-20T00:00:00Z'),
      })
      expect(result.events).toHaveLength(10)
    }
  })
})
