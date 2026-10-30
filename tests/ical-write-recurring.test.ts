// @vitest-environment node
// Editing and deleting recurring events: this instance, this and following, the whole series.
// Every result is also expanded with ical.js (VTIMEZONEs of the file registered, nothing from the
// code under test) so the occurrences, not only the text, are checked.
import { describe, expect, it } from 'vitest'
import {
  deleteFromEventResource,
  editEventResource,
  EditError,
  type EditScope,
  type EventChanges,
  type WriteContext,
} from '../app/utils/ical/write'
import {
  BERLIN_VTIMEZONE,
  contentLines,
  expand,
  instants,
  splitEvents,
  wrapCalendar,
} from './ical-write-helpers'

const NOW = new Date('2026-10-30T12:00:00Z')
const ctxIn = (displayTimeZone: string, orgTimeZone = 'Europe/Berlin'): WriteContext => ({
  displayTimeZone,
  orgTimeZone,
  now: NOW,
})
const BERLIN = ctxIn('Europe/Berlin')
const SYDNEY = ctxIn('Australia/Sydney')

const vevent = (lines: string[]): string[] => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
const stamp = 'DTSTAMP:20260901T080000Z'

/** A Monday 09:00 Berlin series across the daylight-saving change of 25 October 2026. */
function weeklyBerlin(
  options: { rule?: string; extra?: string[]; overrides?: string[][]; exdate?: boolean } = {},
): string {
  const master = vevent([
    'UID:weekly@example.com',
    stamp,
    'SUMMARY:Weekly',
    'SEQUENCE:3',
    'ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com',
    'DTSTART;TZID=Europe/Berlin:20261012T090000',
    'DTEND;TZID=Europe/Berlin:20261012T100000',
    `RRULE:${options.rule ?? 'FREQ=WEEKLY;BYDAY=MO;COUNT=8'}`,
    ...(options.exdate === false ? [] : ['EXDATE;TZID=Europe/Berlin:20261102T090000']),
    ...(options.extra ?? []),
  ])
  const overrides = options.overrides ?? [
    vevent([
      'UID:weekly@example.com',
      stamp,
      'SUMMARY:Weekly (moved)',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000',
      'DTSTART;TZID=Europe/Berlin:20261026T140000',
      'DTEND;TZID=Europe/Berlin:20261026T150000',
    ]),
  ]
  return wrapCalendar([...master, ...overrides.flat()], BERLIN_VTIMEZONE)
}

const when = (start: string, end: string): EventChanges['when'] => ({ start, end, allDay: false })
const day = (start: string, end: string): EventChanges['when'] => ({ start, end, allDay: true })

function edit(ics: string, scope: EditScope, changes: EventChanges, ctx = BERLIN) {
  return editEventResource(ics, scope, changes, ctx)
}

function lines(ics: string | null | undefined): string[] {
  return contentLines(ics ?? '')
}

function catchError(fn: () => unknown): EditError {
  try {
    fn()
  } catch (error) {
    if (error instanceof EditError) return error
    throw error
  }
  throw new Error('expected an EditError')
}

/** The original occurrences of weekly Berlin (EXDATE 2 Nov, 26 Oct moved to 14:00). */
const WEEKLY_UTC = [
  '2026-10-12T07:00:00.000Z',
  '2026-10-19T07:00:00.000Z',
  '2026-10-26T13:00:00.000Z',
  '2026-11-09T08:00:00.000Z',
  '2026-11-16T08:00:00.000Z',
  '2026-11-23T08:00:00.000Z',
  '2026-11-30T08:00:00.000Z',
]

describe('the fixture', () => {
  it('expands as designed (daylight saving inside the series, EXDATE, a moved occurrence)', () => {
    expect(instants(weeklyBerlin())).toEqual(WEEKLY_UTC)
  })
})

describe('whole series', () => {
  it('moves the slots of EXDATE and the overrides with the start (viewed from Berlin)', () => {
    const { updated, created } = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T11:00') },
    )
    expect(created).toBeNull()
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('DTSTART;TZID=Europe/Berlin:20261012T100000')
    expect(master).toContain('DTEND;TZID=Europe/Berlin:20261012T110000')
    expect(master).toContain('EXDATE;TZID=Europe/Berlin:20261102T100000')
    expect(master).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8')
    expect(master).toContain('SEQUENCE:4')
    // The override had a custom time, so it keeps it, but it still names the right slot.
    expect(override).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000')
    expect(override).toContain('DTSTART;TZID=Europe/Berlin:20261026T140000')
    expect(override).toContain('SEQUENCE:1')
    expect(instants(updated!)).toEqual([
      '2026-10-12T08:00:00.000Z',
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T13:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
      '2026-11-30T09:00:00.000Z',
    ])
  })

  it('gives the same result viewed from Sydney, by master range and by occurrence', () => {
    // Sydney is on UTC+11 in October and November: 09:00 Berlin (UTC+2) is 18:00, later 19:00.
    const byMaster = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: when('2026-10-12T19:00', '2026-10-12T20:00') },
      SYDNEY,
    )
    const byOccurrence = edit(
      weeklyBerlin(),
      { kind: 'series', recurrenceId: '2026-11-09T08:00:00Z' },
      { when: when('2026-11-09T20:00', '2026-11-09T21:00') },
      SYDNEY,
    )
    const reference = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T11:00') },
    )
    expect(byMaster.updated).toBe(reference.updated)
    expect(byOccurrence.updated).toBe(reference.updated)
  })

  it('moves a series to another weekday: BYDAY, EXDATE and the overrides follow', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: when('2026-10-13T09:00', '2026-10-13T10:00') },
    )
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8')
    expect(master).toContain('DTSTART;TZID=Europe/Berlin:20261013T090000')
    expect(master).toContain('EXDATE;TZID=Europe/Berlin:20261103T090000')
    expect(override).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261027T090000')
    expect(instants(updated!)).toEqual([
      '2026-10-13T07:00:00.000Z',
      '2026-10-20T07:00:00.000Z',
      '2026-10-26T13:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
      '2026-11-24T08:00:00.000Z',
      '2026-12-01T08:00:00.000Z',
    ])
    // The override still replaces its occurrence (Oct 27 09:00), so the 27th has no plain slot.
    expect(expand(updated!).filter((o) => o.summary === 'Weekly (moved)')).toHaveLength(1)
  })

  it('moves an override with its slot when it was never moved, keeps a custom time otherwise', () => {
    const source = weeklyBerlin({
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Follows',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000',
          'DTSTART;TZID=Europe/Berlin:20261116T090000',
          'DTEND;TZID=Europe/Berlin:20261116T100000',
        ]),
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Custom',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261123T090000',
          'DTSTART;TZID=Europe/Berlin:20261123T150000',
          'DTEND;TZID=Europe/Berlin:20261123T160000',
        ]),
      ],
    })
    const { updated } = edit(
      source,
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T12:00') },
    )
    const [, follows, custom] = splitEvents(updated!)
    expect(follows).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261116T100000')
    expect(follows).toContain('DTSTART;TZID=Europe/Berlin:20261116T100000')
    expect(follows).toContain('DTEND;TZID=Europe/Berlin:20261116T120000')
    expect(custom).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261123T100000')
    expect(custom).toContain('DTSTART;TZID=Europe/Berlin:20261123T150000')
    expect(custom).toContain('DTEND;TZID=Europe/Berlin:20261123T160000')
    const byTitle = Object.fromEntries(expand(updated!).map((o) => [o.summary, o.utc]))
    expect(byTitle['Follows']).toBe('2026-11-16T09:00:00.000Z')
    expect(byTitle['Custom']).toBe('2026-11-23T14:00:00.000Z')
  })

  it('shifts UNTIL with the series so the last occurrence survives', () => {
    const source = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T080000Z',
      overrides: [],
    })
    const { updated } = edit(
      source,
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T11:00') },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T090000Z')
    expect(instants(updated!).at(-1)).toBe('2026-11-30T09:00:00.000Z')
    expect(instants(updated!)).toHaveLength(7)
  })

  it('changes only the length when only the end moves', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: when('2026-10-12T09:00', '2026-10-12T11:30') },
    )
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('DTSTART;TZID=Europe/Berlin:20261012T090000')
    expect(master).toContain('DTEND;TZID=Europe/Berlin:20261012T113000')
    expect(master).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(override).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000')
  })

  it('edits only the text when the range is the one already there', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { title: 'Renamed', when: when('2026-10-12T09:00', '2026-10-12T10:00') },
    )
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('SUMMARY:Renamed')
    expect(master).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(override).toContain('SUMMARY:Weekly (moved)')
    expect(override).not.toContain('SEQUENCE:1')
  })

  it('treats a single event as its own series whatever the scope says', () => {
    const single = wrapCalendar(
      vevent([
        'UID:single@example.com',
        stamp,
        'SUMMARY:One',
        'DTSTART;TZID=Europe/Berlin:20261105T090000',
        'DTEND;TZID=Europe/Berlin:20261105T100000',
      ]),
      BERLIN_VTIMEZONE,
    )
    for (const scope of [
      { kind: 'series' },
      { kind: 'instance', recurrenceId: '2026-11-05T08:00:00Z' },
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-05T08:00:00Z' },
    ] as EditScope[]) {
      const { updated, created } = edit(single, scope, { title: 'Two' })
      expect(created).toBeNull()
      expect(lines(updated)).toContain('SUMMARY:Two')
      expect(updated).not.toContain('RECURRENCE-ID')
    }
  })
})

describe('this instance', () => {
  it('creates an override that copies the master and leaves the master untouched', () => {
    const source = weeklyBerlin()
    const { updated, created } = edit(
      source,
      { kind: 'instance', recurrenceId: '2026-11-16T08:00:00Z' },
      { title: 'Only this one' },
    )
    expect(created).toBeNull()
    const [masterBefore] = splitEvents(source)
    const [master = [], moved = [], added = []] = splitEvents(updated!)
    expect(master).toEqual(masterBefore)
    expect(moved).toEqual(splitEvents(source)[1])
    expect(added).toContain('UID:weekly@example.com')
    expect(added).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000')
    expect(added).toContain('DTSTART;TZID=Europe/Berlin:20261116T090000')
    expect(added).toContain('DTEND;TZID=Europe/Berlin:20261116T100000')
    expect(added).toContain('SUMMARY:Only this one')
    expect(added).toContain('ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com')
    expect(added).toContain('SEQUENCE:4')
    expect(added.some((l) => /^(RRULE|EXDATE|RDATE)/.test(l))).toBe(false)
    const titles = Object.fromEntries(expand(updated!).map((o) => [o.utc, o.summary]))
    expect(titles['2026-11-16T08:00:00.000Z']).toBe('Only this one')
    expect(titles['2026-11-23T08:00:00.000Z']).toBe('Weekly')
    expect(instants(updated!)).toEqual(WEEKLY_UTC)
  })

  it('moves one occurrence, seen from Sydney, in the event zone', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'instance', recurrenceId: '2026-11-16T08:00:00Z' },
      { when: when('2026-11-16T21:00', '2026-11-16T22:00') },
      SYDNEY,
    )
    const added = splitEvents(updated!)[2]!
    expect(added).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000')
    expect(added).toContain('DTSTART;TZID=Europe/Berlin:20261116T110000')
    expect(added).toContain('DTEND;TZID=Europe/Berlin:20261116T120000')
    expect(instants(updated!)).toContain('2026-11-16T10:00:00.000Z')
    expect(instants(updated!)).not.toContain('2026-11-16T08:00:00.000Z')
  })

  it('edits an existing override in place', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'instance', recurrenceId: '2026-10-26T08:00:00Z' },
      { title: 'Moved and renamed' },
    )
    const events = splitEvents(updated!)
    expect(events).toHaveLength(2)
    expect(events[1]).toContain('SUMMARY:Moved and renamed')
    expect(events[1]).toContain('DTSTART;TZID=Europe/Berlin:20261026T140000')
    expect(events[1]).toContain('SEQUENCE:1')
    expect(events[0]).toEqual(splitEvents(weeklyBerlin())[0])
  })

  it('does not create an override when nothing differs', () => {
    const source = weeklyBerlin()
    const { updated } = edit(
      source,
      { kind: 'instance', recurrenceId: '2026-11-16T08:00:00Z' },
      { title: 'Weekly', when: when('2026-11-16T09:00', '2026-11-16T10:00') },
    )
    expect(updated).toBe(source)
  })

  it('switches one occurrence between timed and all-day', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'instance', recurrenceId: '2026-11-16T08:00:00Z' },
      { when: { start: '2026-11-16', end: '2026-11-17', allDay: true } },
    )
    const added = splitEvents(updated!)[2]!
    // The RECURRENCE-ID keeps the type of the master's DTSTART; the occurrence itself is a day.
    expect(added).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000')
    expect(added).toContain('DTSTART;VALUE=DATE:20261116')
    expect(added).toContain('DTEND;VALUE=DATE:20261117')
    const occurrence = expand(updated!).find((o) => o.recurrenceId.startsWith('2026-11-16'))
    expect(occurrence?.isDate).toBe(true)
    expect(expand(updated!).filter((o) => !o.isDate)).toHaveLength(6)
  })

  it('refuses a recurrence id that is not an occurrence', () => {
    for (const recurrenceId of [
      '2026-10-14T07:00:00Z', // a Wednesday
      '2026-11-02T08:00:00Z', // excluded by EXDATE
      '2026-12-07T08:00:00Z', // after COUNT ran out
      '2026-10-12T09:00:00Z', // the right day, the wrong instant
    ]) {
      const error = catchError(() =>
        edit(weeklyBerlin(), { kind: 'instance', recurrenceId }, { title: 'x' }),
      )
      expect(error.code, recurrenceId).toBe('unknown-instance')
    }
  })

  it('finds slots in the hour that does not exist and the hour that happens twice', () => {
    const source = wrapCalendar(
      vevent([
        'UID:dst@example.com',
        stamp,
        'SUMMARY:Night',
        'DTSTART;TZID=Europe/Berlin:20260322T023000',
        'DTEND;TZID=Europe/Berlin:20260322T030000',
        'RRULE:FREQ=WEEKLY;COUNT=40',
      ]),
      BERLIN_VTIMEZONE,
    )
    // 29 March: 02:30 does not exist and is read with the offset before the gap (01:30Z);
    // 25 October: 02:30 happens twice and means the first one (00:30Z).
    for (const [recurrenceId, wall] of [
      ['2026-03-29T01:30:00Z', '20260329T023000'],
      ['2026-10-25T00:30:00Z', '20261025T023000'],
    ] as const) {
      const { updated } = edit(source, { kind: 'instance', recurrenceId }, { title: 'Shifted' })
      expect(splitEvents(updated!)[1]).toContain(`RECURRENCE-ID;TZID=Europe/Berlin:${wall}`)
    }
  })
})

describe('this and following', () => {
  it('splits a COUNT series: UNTIL on the original, the remaining COUNT on the new series', () => {
    const source = weeklyBerlin()
    const { updated, created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-09T08:00:00Z' },
      { title: 'From November' },
    )
    expect(created).not.toBeNull()
    expect(created!.uid).not.toBe('weekly@example.com')
    const [original, moved] = splitEvents(updated!)
    expect(original).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T075959Z')
    expect(original).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(original).toContain('SUMMARY:Weekly')
    expect(original).toContain('SEQUENCE:4')
    expect(moved).toContain('SUMMARY:Weekly (moved)')

    const [successor = []] = splitEvents(created!.ics)
    expect(successor).toContain(`UID:${created!.uid}`)
    expect(successor).toContain('SUMMARY:From November')
    expect(successor).toContain('DTSTART;TZID=Europe/Berlin:20261109T090000')
    expect(successor).toContain('DTEND;TZID=Europe/Berlin:20261109T100000')
    expect(successor).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4')
    expect(successor).toContain('SEQUENCE:0')
    expect(successor).toContain('ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com')
    expect(successor.some((l) => l.startsWith('EXDATE'))).toBe(false)
    expect(created!.ics).toContain('TZID:Europe/Berlin')

    // Together the two resources are the original series, the new part renamed.
    const all = [...expand(updated!), ...expand(created!.ics)]
    expect(all.map((o) => o.utc).sort()).toEqual(instants(source))
    expect(all.filter((o) => o.summary === 'From November').map((o) => o.utc)).toEqual(
      WEEKLY_UTC.slice(3).sort(),
    )
  })

  it('splits an UNTIL series and keeps the UNTIL on the new series', () => {
    const source = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T080000Z',
      overrides: [],
    })
    const { updated, created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-16T08:00:00Z' },
      { title: 'Late' },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T075959Z')
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T080000Z')
    const all = [...instants(updated!), ...instants(created!.ics)].sort()
    expect(all).toEqual(instants(source))
  })

  it('splits an unbounded series', () => {
    const source = weeklyBerlin({ rule: 'FREQ=WEEKLY;BYDAY=MO', overrides: [], exdate: false })
    const { updated, created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-09T08:00:00Z' },
      { location: 'Annex' },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T075959Z')
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO')
    expect(lines(created!.ics)).toContain('LOCATION:Annex')
    expect(instants(updated!, 50)).toEqual([
      '2026-10-12T07:00:00.000Z',
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T07:00:00.000Z'.replace('07:00', '08:00'),
      '2026-11-02T08:00:00.000Z',
    ])
    expect(instants(created!.ics, 3)).toEqual([
      '2026-11-09T08:00:00.000Z',
      '2026-11-16T08:00:00.000Z',
      '2026-11-23T08:00:00.000Z',
    ])
  })

  it('divides overrides and exclusions around the split', () => {
    const source = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
      extra: ['EXDATE;TZID=Europe/Berlin:20261123T090000'],
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Early',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261019T090000',
          'DTSTART;TZID=Europe/Berlin:20261019T090000',
          'DTEND;TZID=Europe/Berlin:20261019T100000',
        ]),
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Late',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000',
          'DTSTART;TZID=Europe/Berlin:20261130T150000',
          'DTEND;TZID=Europe/Berlin:20261130T160000',
        ]),
      ],
    })
    const { updated, created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-16T08:00:00Z' },
      {},
    )
    // Nothing differs, so nothing is split.
    expect(updated).toBe(source)
    expect(created).toBeNull()

    const result = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-16T08:00:00Z' },
      { title: 'Second half' },
    )
    const original = splitEvents(result.updated!)
    expect(original).toHaveLength(2)
    expect(original[1]).toContain('SUMMARY:Early')
    expect(original[0]).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(original[0]!.some((l) => l.includes('20261123'))).toBe(false)
    const [successor, late] = splitEvents(result.created!.ics)
    expect(successor).toContain('EXDATE;TZID=Europe/Berlin:20261123T090000')
    expect(successor).not.toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(successor).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5')
    expect(late).toContain(`UID:${result.created!.uid}`)
    expect(late).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000')
    expect(late).toContain('DTSTART;TZID=Europe/Berlin:20261130T150000')
    expect(late).toContain('SUMMARY:Late')

    const all = [...expand(result.updated!), ...expand(result.created!.ics)]
    expect(all.map((o) => o.utc).sort()).toEqual(instants(source))
    expect(new Set(all.map((o) => o.uid)).size).toBe(2)
  })

  it('moves the new series with changes.when and shifts its overrides', () => {
    const source = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=8',
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Late',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261123T090000',
          'DTSTART;TZID=Europe/Berlin:20261123T090000',
          'DTEND;TZID=Europe/Berlin:20261123T100000',
        ]),
      ],
    })
    // Seen from Sydney the occurrence of 9 November is at 19:00; the editor moves it to 20:00.
    const { updated, created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-09T08:00:00Z' },
      { when: when('2026-11-09T20:00', '2026-11-09T21:00') },
      SYDNEY,
    )
    const [successor, late] = splitEvents(created!.ics)
    expect(successor).toContain('DTSTART;TZID=Europe/Berlin:20261109T100000')
    expect(successor).toContain('DTEND;TZID=Europe/Berlin:20261109T110000')
    expect(successor).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4')
    expect(late).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261123T100000')
    expect(late).toContain('DTSTART;TZID=Europe/Berlin:20261123T100000')
    expect(instants(created!.ics)).toEqual([
      '2026-11-09T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
      '2026-11-30T09:00:00.000Z',
    ])
    expect(instants(updated!)).toEqual([
      '2026-10-12T07:00:00.000Z',
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ])
  })

  it('moves the new series to another weekday and counts the remaining occurrences', () => {
    const { created } = edit(
      weeklyBerlin(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-09T08:00:00Z' },
      { when: when('2026-11-10T09:00', '2026-11-10T10:00') },
    )
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4')
    expect(instants(created!.ics)).toEqual([
      '2026-11-10T08:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
      '2026-11-24T08:00:00.000Z',
      '2026-12-01T08:00:00.000Z',
    ])
  })

  it('the override on the clicked occurrence takes the edit too', () => {
    const source = weeklyBerlin({
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Special',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000',
          'DTSTART;TZID=Europe/Berlin:20261116T090000',
          'DTEND;TZID=Europe/Berlin:20261116T100000',
          'X-KEEP:me',
        ]),
      ],
    })
    const { created } = edit(
      source,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-16T08:00:00Z' },
      { title: 'Everything from here' },
    )
    const [successor, special] = splitEvents(created!.ics)
    expect(successor).toContain('SUMMARY:Everything from here')
    expect(special).toContain('SUMMARY:Everything from here')
    expect(special).toContain('X-KEEP:me')
  })

  it('is the whole series at the first occurrence, and when the earlier ones are excluded', () => {
    const first = edit(
      weeklyBerlin(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-10-12T07:00:00Z' },
      { title: 'All of it' },
    )
    expect(first.created).toBeNull()
    expect(lines(first.updated)).toContain('SUMMARY:All of it')
    expect(lines(first.updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8')

    const excluded = weeklyBerlin({
      exdate: false,
      extra: ['EXDATE;TZID=Europe/Berlin:20261012T090000'],
      overrides: [],
    })
    const second = edit(
      excluded,
      { kind: 'thisAndFollowing', recurrenceId: '2026-10-19T07:00:00Z' },
      { title: 'All remaining' },
    )
    expect(second.created).toBeNull()
    expect(lines(second.updated)).toContain('SUMMARY:All remaining')
  })

  it('refuses an occurrence that does not exist', () => {
    const error = catchError(() =>
      edit(
        weeklyBerlin(),
        { kind: 'thisAndFollowing', recurrenceId: '2026-11-03T08:00:00Z' },
        { title: 'x' },
      ),
    )
    expect(error.code).toBe('unknown-instance')
  })
})

describe('all-day series', () => {
  const allDay = (rule = 'FREQ=WEEKLY;COUNT=5'): string =>
    wrapCalendar(
      vevent([
        'UID:holiday@example.com',
        stamp,
        'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20261105',
        'DTEND;VALUE=DATE:20261106',
        `RRULE:${rule}`,
        'EXDATE;VALUE=DATE:20261126',
      ]),
    )

  it('writes a date override for one day', () => {
    const { updated } = edit(
      allDay(),
      { kind: 'instance', recurrenceId: '2026-11-12' },
      { title: 'Different', when: day('2026-11-13', '2026-11-15') },
    )
    const added = splitEvents(updated!)[1]!
    expect(added).toContain('RECURRENCE-ID;VALUE=DATE:20261112')
    expect(added).toContain('DTSTART;VALUE=DATE:20261113')
    expect(added).toContain('DTEND;VALUE=DATE:20261115')
    const days = expand(updated!).map((o) => o.wall)
    expect(days).toEqual(['2026-11-05', '2026-11-13', '2026-11-19', '2026-12-03'])
  })

  it('splits with a date UNTIL on the previous day and counts the rest', () => {
    const { updated, created } = edit(
      allDay(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-19' },
      { title: 'Later holiday' },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261118')
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;COUNT=3')
    expect(lines(created!.ics)).toContain('DTSTART;VALUE=DATE:20261119')
    expect(lines(created!.ics)).toContain('EXDATE;VALUE=DATE:20261126')
    const all = [...expand(updated!), ...expand(created!.ics)].map((o) => o.wall).sort()
    expect(all).toEqual(expand(allDay()).map((o) => o.wall))
  })

  it('moves a series by whole days', () => {
    const { updated } = edit(
      allDay(),
      { kind: 'series' },
      { when: day('2026-11-06', '2026-11-07') },
    )
    expect(lines(updated)).toContain('DTSTART;VALUE=DATE:20261106')
    expect(lines(updated)).toContain('EXDATE;VALUE=DATE:20261127')
    expect(expand(updated!).map((o) => o.wall)).toEqual([
      '2026-11-06',
      '2026-11-13',
      '2026-11-20',
      '2026-12-04',
    ])
  })

  it('becomes a timed series in the display zone, with a VTIMEZONE', () => {
    const { updated } = edit(
      allDay(),
      { kind: 'series' },
      { when: when('2026-11-05T10:00', '2026-11-05T11:00') },
    )
    const out = lines(updated)
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20261105T100000')
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20261105T110000')
    expect(out).toContain('EXDATE;TZID=Europe/Berlin:20261126T100000')
    expect(out).toContain('TZID:Europe/Berlin')
    expect(instants(updated!)).toEqual([
      '2026-11-05T09:00:00.000Z',
      '2026-11-12T09:00:00.000Z',
      '2026-11-19T09:00:00.000Z',
      '2026-12-03T09:00:00.000Z',
    ])
  })

  it('a timed series becomes an all-day series', () => {
    const { updated } = edit(
      weeklyBerlin(),
      { kind: 'series' },
      { when: day('2026-10-12', '2026-10-13') },
    )
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('DTSTART;VALUE=DATE:20261012')
    expect(master).toContain('DTEND;VALUE=DATE:20261013')
    expect(master).toContain('EXDATE;VALUE=DATE:20261102')
    expect(master).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8')
    expect(override).toContain('RECURRENCE-ID;VALUE=DATE:20261026')
    expect(expand(updated!).map((o) => o.wall)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ])
  })
})

describe('UTC and floating series', () => {
  const utcSeries = (rule = 'FREQ=WEEKLY;COUNT=4'): string =>
    wrapCalendar(
      vevent([
        'UID:utc@example.com',
        stamp,
        'SUMMARY:Utc',
        'DTSTART:20261105T083000Z',
        'DTEND:20261105T093000Z',
        `RRULE:${rule}`,
      ]),
    )

  it('keeps UTC: an instance override in Z form, edited from Sydney', () => {
    const { updated } = edit(
      utcSeries(),
      { kind: 'instance', recurrenceId: '2026-11-12T08:30:00Z' },
      { when: when('2026-11-12T20:30', '2026-11-12T21:30') },
      SYDNEY,
    )
    const added = splitEvents(updated!)[1]!
    expect(added).toContain('RECURRENCE-ID:20261112T083000Z')
    expect(added).toContain('DTSTART:20261112T093000Z')
    expect(added).toContain('DTEND:20261112T103000Z')
    expect(instants(updated!)).toContain('2026-11-12T09:30:00.000Z')
  })

  it('cuts a UTC series with a UTC UNTIL', () => {
    const { updated, created } = edit(
      utcSeries(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-19T08:30:00Z' },
      { title: 'Tail' },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261119T082959Z')
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;COUNT=2')
    expect(lines(created!.ics)).toContain('DTSTART:20261119T083000Z')
    expect([...instants(updated!), ...instants(created!.ics)].sort()).toEqual(instants(utcSeries()))
  })

  it('moves a UTC series by the delta of the display zone', () => {
    // 08:30Z is 19:30 in Sydney (UTC+11); one hour later there is 09:30Z.
    const { updated } = edit(
      utcSeries('FREQ=WEEKLY;UNTIL=20261126T083000Z'),
      { kind: 'series' },
      { when: when('2026-11-05T20:30', '2026-11-05T21:30') },
      SYDNEY,
    )
    expect(lines(updated)).toContain('DTSTART:20261105T093000Z')
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261126T093000Z')
    expect(instants(updated!)).toHaveLength(4)
  })

  const floatingSeries = wrapCalendar(
    vevent([
      'UID:floating@example.com',
      stamp,
      'SUMMARY:Floating',
      'DTSTART:20261104T100000',
      'DTEND:20261104T110000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
    ]),
  )

  it('keeps floating times and reads the recurrence id in the organization zone', () => {
    // 11 November 10:00 floating is 10:00 in Berlin, 09:00Z.
    const { updated } = edit(
      floatingSeries,
      { kind: 'instance', recurrenceId: '2026-11-11T09:00:00Z' },
      { title: 'Once' },
    )
    const added = splitEvents(updated!)[1]!
    expect(added).toContain('RECURRENCE-ID:20261111T100000')
    expect(added).toContain('DTSTART:20261111T100000')
    expect(added).toContain('DTEND:20261111T110000')
    expect(expand(updated!).find((o) => o.summary === 'Once')?.wall).toBe('2026-11-11T10:00:00')
  })

  it('converts the display zone to the organization zone for floating times', () => {
    // Sydney is eleven hours ahead of UTC and ten ahead of Berlin in early November.
    const { updated } = edit(
      floatingSeries,
      { kind: 'series' },
      { when: when('2026-11-04T21:00', '2026-11-04T22:00') },
      SYDNEY,
    )
    expect(lines(updated)).toContain('DTSTART:20261104T110000')
    expect(lines(updated)).toContain('DTEND:20261104T120000')
  })

  it('cuts a floating series with a floating UNTIL', () => {
    const { updated, created } = edit(
      floatingSeries,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-18T09:00:00Z' },
      { title: 'Tail' },
    )
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261118T095959')
    expect(lines(created!.ics)).toContain('RRULE:FREQ=WEEKLY;COUNT=2')
    expect(lines(created!.ics)).toContain('DTSTART:20261118T100000')
    const all = [...expand(updated!), ...expand(created!.ics)].map((o) => o.wall).sort()
    expect(all).toEqual(expand(floatingSeries).map((o) => o.wall))
  })
})

describe('rules that do not follow DTSTART', () => {
  const lastWeekday = (periods = false): string =>
    wrapCalendar(
      [
        ...vevent([
          'UID:lastday@example.com',
          stamp,
          'SUMMARY:Last weekday',
          'DTSTART;TZID=W. Europe Standard Time:20260831T170000',
          'DTEND;TZID=W. Europe Standard Time:20260831T180000',
          'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=6',
          // ical.js cannot expand a PERIOD RDATE, so the expanding tests use plain date-times.
          periods
            ? 'RDATE;VALUE=PERIOD;TZID=W. Europe Standard Time:20261215T100000/PT2H'
            : 'RDATE;TZID=W. Europe Standard Time:20261215T100000',
          periods ? 'RDATE;VALUE=PERIOD:20261201T090000Z/PT1H' : 'RDATE:20261201T090000Z',
          'EXDATE;TZID=W. Europe Standard Time:20261130T170000',
        ]),
        ...vevent([
          'UID:lastday@example.com',
          stamp,
          'SUMMARY:Last weekday (early)',
          'RECURRENCE-ID;TZID=W. Europe Standard Time:20260930T170000',
          'DTSTART;TZID=W. Europe Standard Time:20260930T130000',
          'DTEND;TZID=W. Europe Standard Time:20260930T140000',
        ]),
      ],
      [
        [
          'BEGIN:VTIMEZONE',
          'TZID:W. Europe Standard Time',
          'BEGIN:STANDARD',
          'DTSTART:16010101T030000',
          'TZOFFSETFROM:+0200',
          'TZOFFSETTO:+0100',
          'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
          'END:STANDARD',
          'BEGIN:DAYLIGHT',
          'DTSTART:16010101T020000',
          'TZOFFSETFROM:+0100',
          'TZOFFSETTO:+0200',
          'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
          'END:DAYLIGHT',
          'END:VTIMEZONE',
        ],
      ].flat(),
    )

  it('expands as designed', () => {
    expect(instants(lastWeekday())).toEqual([
      '2026-08-31T15:00:00.000Z',
      '2026-09-30T11:00:00.000Z',
      '2026-10-30T16:00:00.000Z',
      '2026-12-01T09:00:00.000Z',
      '2026-12-15T09:00:00.000Z',
      '2026-12-31T16:00:00.000Z',
      '2027-01-29T16:00:00.000Z',
    ])
  })

  it('moves the time of day in a zone only the file knows, keeping the rule byte for byte', () => {
    const { updated } = edit(
      lastWeekday(),
      { kind: 'series' },
      { when: when('2026-08-31T18:00', '2026-08-31T19:00') },
    )
    const [master, override] = splitEvents(updated!)
    expect(master).toContain('DTSTART;TZID=W. Europe Standard Time:20260831T180000')
    expect(master).toContain('DTEND;TZID=W. Europe Standard Time:20260831T190000')
    expect(master).toContain('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=6')
    expect(master).toContain('EXDATE;TZID=W. Europe Standard Time:20261130T180000')
    // An RDATE in the series' zone and one in UTC move by the same hour.
    expect(master).toContain('RDATE;TZID=W. Europe Standard Time:20261215T110000')
    expect(master).toContain('RDATE:20261201T100000Z')
    expect(override).toContain('RECURRENCE-ID;TZID=W. Europe Standard Time:20260930T180000')
    expect(override).toContain('DTSTART;TZID=W. Europe Standard Time:20260930T130000')
    expect(updated).toContain('TZID:W. Europe Standard Time')
    expect(updated!.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1)
    expect(instants(updated!)).toEqual([
      '2026-08-31T16:00:00.000Z',
      '2026-09-30T11:00:00.000Z',
      '2026-10-30T17:00:00.000Z',
      '2026-12-01T10:00:00.000Z',
      '2026-12-15T10:00:00.000Z',
      '2026-12-31T17:00:00.000Z',
      '2027-01-29T17:00:00.000Z',
    ])
  })

  it('moves PERIOD RDATEs with their duration (read by their start, not as floating)', () => {
    const { updated } = edit(
      lastWeekday(true),
      { kind: 'series' },
      { when: when('2026-08-31T18:00', '2026-08-31T19:00') },
    )
    const master = splitEvents(updated!)[0]!
    expect(master).toContain('RDATE;VALUE=PERIOD;TZID=W. Europe Standard Time:20261215T110000/PT2H')
    expect(master).toContain('RDATE;VALUE=PERIOD:20261201T100000Z/PT1H')
  })

  it('converts from a display zone to a zone defined only in the file', () => {
    // 17:00 on 31 August in Berlin (UTC+2) is 01:00 on 1 September in Sydney (UTC+10).
    const { updated } = edit(
      lastWeekday(),
      { kind: 'series' },
      { when: when('2026-09-01T02:00', '2026-09-01T03:00') },
      SYDNEY,
    )
    expect(lines(updated)).toContain('DTSTART;TZID=W. Europe Standard Time:20260831T180000')
  })

  it('refuses a move to another day that the rule would not follow', () => {
    const error = catchError(() =>
      edit(
        lastWeekday(),
        { kind: 'series' },
        { when: when('2026-09-01T17:00', '2026-09-01T18:00') },
      ),
    )
    expect(error.code).toBe('unsupported')
  })

  it('splits at the last weekday of a month', () => {
    const { updated, created } = edit(
      lastWeekday(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-10-30T16:00:00Z' },
      { title: 'From October' },
    )
    expect(lines(created!.ics)).toContain(
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4',
    )
    expect(lines(updated)).toContain(
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;UNTIL=20261030T155959Z',
    )
    // RDATEs from the slot on follow the new series, earlier ones stay.
    expect(lines(created!.ics).filter((l) => l.startsWith('RDATE'))).toHaveLength(2)
    expect(lines(updated).some((l) => l.startsWith('RDATE'))).toBe(false)
    const all = [...instants(updated!), ...instants(created!.ics)].sort()
    expect(all).toEqual(instants(lastWeekday()))
  })
})

describe('time zones missing from the file', () => {
  const noVtimezone = wrapCalendar(
    vevent([
      'UID:ny@example.com',
      stamp,
      'SUMMARY:New York',
      'DTSTART;TZID=America/New_York:20261105T090000',
      'DTEND;TZID=America/New_York:20261105T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
    ]),
  )

  it('leaves the file alone for a text edit', () => {
    const { updated } = edit(noVtimezone, { kind: 'series' }, { title: 'Renamed' })
    expect(updated).not.toContain('VTIMEZONE')
  })

  it('adds a generated VTIMEZONE when it writes a time in that zone', () => {
    // 09:00 in New York (UTC-5 after 1 November) is 15:00 in Berlin.
    const { updated } = edit(
      noVtimezone,
      { kind: 'series' },
      { when: when('2026-11-05T16:00', '2026-11-05T17:00') },
    )
    expect(lines(updated)).toContain('DTSTART;TZID=America/New_York:20261105T100000')
    expect(lines(updated)).toContain('TZID:America/New_York')
    expect(instants(updated!)).toEqual([
      '2026-11-05T15:00:00.000Z',
      '2026-11-06T15:00:00.000Z',
      '2026-11-07T15:00:00.000Z',
    ])
  })

  it('reads a path-style TZID as its IANA zone and writes it back as it was', () => {
    const tzid = '/mozilla.org/20050126_1/Europe/Berlin'
    const mozilla = wrapCalendar(
      vevent([
        'UID:moz@example.com',
        stamp,
        'SUMMARY:Mozilla',
        `DTSTART;TZID=${tzid}:20261109T090000`,
        `DTEND;TZID=${tzid}:20261109T100000`,
        'RRULE:FREQ=WEEKLY;COUNT=3',
      ]),
      BERLIN_VTIMEZONE.map((line) => (line === 'TZID:Europe/Berlin' ? `TZID:${tzid}` : line)),
    )
    const instance = edit(
      mozilla,
      { kind: 'instance', recurrenceId: '2026-11-16T08:00:00Z' },
      { when: when('2026-11-16T11:00', '2026-11-16T12:00') },
    )
    const added = splitEvents(instance.updated!)[1]!
    expect(added).toContain(`RECURRENCE-ID;TZID=${tzid}:20261116T090000`)
    expect(added).toContain(`DTSTART;TZID=${tzid}:20261116T110000`)
    const series = edit(
      mozilla,
      { kind: 'series' },
      { when: when('2026-11-09T10:00', '2026-11-09T11:00') },
    )
    expect(lines(series.updated)).toContain(`DTSTART;TZID=${tzid}:20261109T100000`)
    expect(instants(series.updated!)).toEqual([
      '2026-11-09T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
    ])
  })

  it('refuses to move times in a zone nobody can resolve, but still edits the text', () => {
    const unknown = noVtimezone.replace(/America\/New_York/g, 'Mars Standard Time')
    expect(lines(edit(unknown, { kind: 'series' }, { title: 'Renamed' }).updated)).toContain(
      'SUMMARY:Renamed',
    )
    const error = catchError(() =>
      edit(unknown, { kind: 'series' }, { when: when('2026-11-05T16:00', '2026-11-05T17:00') }),
    )
    expect(error.code).toBe('unsupported')
  })
})

describe('which slots a series has (the calendar view and the writer must agree)', () => {
  it('counts a DTSTART the rule would not produce as the first slot', () => {
    // A Monday start with a Tuesday/Thursday rule: the view shows the Monday too (RFC 5545 §3.8.5.3).
    const offRule = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4',
      overrides: [],
      exdate: false,
    })
    const first = edit(
      offRule,
      { kind: 'instance', recurrenceId: '2026-10-12T07:00:00Z' },
      { title: 'Monday' },
    )
    expect(splitEvents(first.updated!)[1]).toContain(
      'RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000',
    )
    const second = edit(
      offRule,
      { kind: 'thisAndFollowing', recurrenceId: '2026-10-13T07:00:00Z' },
      { title: 'From Tuesday' },
    )
    // The Monday is before the split, so the original keeps it and ends before the Tuesday.
    expect(lines(second.updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261013T065959Z')
    expect(lines(second.created!.ics)).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4')
  })

  it('leaves out 29 February in the years without one', () => {
    const leap = wrapCalendar(
      vevent([
        'UID:leap',
        stamp,
        'SUMMARY:Leap day',
        'DTSTART;VALUE=DATE:20240229',
        'DTEND;VALUE=DATE:20240301',
        'RRULE:FREQ=YEARLY',
      ]),
    )
    expect(
      lines(edit(leap, { kind: 'instance', recurrenceId: '2028-02-29' }, { title: 'x' }).updated),
    ).toContain('RECURRENCE-ID;VALUE=DATE:20280229')
    expect(
      catchError(() => edit(leap, { kind: 'instance', recurrenceId: '2025-03-01' }, { title: 'x' }))
        .code,
    ).toBe('unknown-instance')
  })
})

describe('series made of RDATEs only, and unusual overrides', () => {
  const rdates = wrapCalendar(
    vevent([
      'UID:rdates@example.com',
      stamp,
      'SUMMARY:Pick days',
      'DTSTART;TZID=Europe/Berlin:20261103T090000',
      'DTEND;TZID=Europe/Berlin:20261103T100000',
      'RDATE;TZID=Europe/Berlin:20261110T090000,20261124T090000',
    ]),
    BERLIN_VTIMEZONE,
  )

  it('edits one chosen day without touching the others', () => {
    const { updated } = edit(
      rdates,
      { kind: 'instance', recurrenceId: '2026-11-10T08:00:00Z' },
      { title: 'Special' },
    )
    expect(splitEvents(updated!)).toHaveLength(2)
    // (ical.js leaves DTSTART out of an RDATE-only set; RFC 5545 and this module count it.)
    expect(expand(updated!).map((o) => [o.wall.slice(0, 10), o.summary])).toEqual([
      ['2026-11-10', 'Special'],
      ['2026-11-24', 'Pick days'],
    ])
    expect(splitEvents(updated!)[1]).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000')
  })

  it('splits and deletes by moving RDATEs between resources', () => {
    const { updated, created } = edit(
      rdates,
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-10T08:00:00Z' },
      { title: 'Later days' },
    )
    expect(lines(updated).some((l) => l.startsWith('RDATE'))).toBe(false)
    expect(lines(created!.ics)).toContain(
      'RDATE;TZID=Europe/Berlin:20261110T090000,20261124T090000',
    )
    const gone = deleteFromEventResource(
      rdates,
      { kind: 'instance', recurrenceId: '2026-11-03T08:00:00Z' },
      BERLIN,
    ).updated
    expect(lines(gone)).toContain('EXDATE;TZID=Europe/Berlin:20261103T090000')
    expect(expand(gone!).map((o) => o.wall.slice(0, 10))).toEqual(['2026-11-10', '2026-11-24'])
  })

  it('keeps RANGE and other parameters of a RECURRENCE-ID when the series moves', () => {
    const source = weeklyBerlin({
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Future',
          'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261116T090000',
          'DTSTART;TZID=Europe/Berlin:20261116T090000',
          'DTEND;TZID=Europe/Berlin:20261116T100000',
        ]),
      ],
    })
    const { updated } = edit(
      source,
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T11:00') },
    )
    expect(splitEvents(updated!)[1]).toContain(
      'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261116T100000',
    )
  })

  it('leaves an override with a date while the series is timed as it is', () => {
    const odd = weeklyBerlin({
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Whole day',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000',
          'DTSTART;VALUE=DATE:20261116',
          'DTEND;VALUE=DATE:20261117',
        ]),
      ],
    })
    const { updated } = edit(
      odd,
      { kind: 'series' },
      { when: when('2026-10-12T10:00', '2026-10-12T11:00') },
    )
    const override = splitEvents(updated!)[1]!
    expect(override).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261116T100000')
    expect(override).toContain('DTSTART;VALUE=DATE:20261116')
  })
})

describe('deleting', () => {
  const del = (ics: string, scope: EditScope, ctx = BERLIN) =>
    deleteFromEventResource(ics, scope, ctx).updated

  it('removes a single event and a whole series', () => {
    const single = wrapCalendar(
      vevent(['UID:s', stamp, 'SUMMARY:S', 'DTSTART:20261105T100000', 'DTEND:20261105T110000']),
    )
    expect(del(single, { kind: 'series' })).toBeNull()
    expect(del(single, { kind: 'instance', recurrenceId: '2026-11-05T09:00:00Z' })).toBeNull()
    expect(del(weeklyBerlin(), { kind: 'series' })).toBeNull()
  })

  it.each([
    [
      'the first',
      '2026-10-12T07:00:00Z',
      '2026-10-12T07:00:00.000Z',
      'EXDATE;TZID=Europe/Berlin:20261012T090000',
    ],
    [
      'a middle',
      '2026-11-16T08:00:00Z',
      '2026-11-16T08:00:00.000Z',
      'EXDATE;TZID=Europe/Berlin:20261116T090000',
    ],
    [
      'the last',
      '2026-11-30T08:00:00Z',
      '2026-11-30T08:00:00.000Z',
      'EXDATE;TZID=Europe/Berlin:20261130T090000',
    ],
  ])('deletes %s occurrence with an EXDATE', (_name, recurrenceId, gone, exdate) => {
    const updated = del(weeklyBerlin(), { kind: 'instance', recurrenceId })!
    const [master] = splitEvents(updated)
    expect(master).toContain(exdate)
    expect(master).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(master).toContain('SEQUENCE:4')
    expect(master).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8')
    expect(instants(updated)).toEqual(WEEKLY_UTC.filter((i) => i !== gone))
  })

  it('deleting an occurrence that has an override removes the override', () => {
    const updated = del(weeklyBerlin(), { kind: 'instance', recurrenceId: '2026-10-26T08:00:00Z' })!
    expect(splitEvents(updated)).toHaveLength(1)
    expect(lines(updated)).toContain('EXDATE;TZID=Europe/Berlin:20261026T090000')
    expect(instants(updated)).toEqual(WEEKLY_UTC.filter((i) => i !== '2026-10-26T13:00:00.000Z'))
  })

  it('deleting this and following ends the series before the slot', () => {
    const updated = del(weeklyBerlin(), {
      kind: 'thisAndFollowing',
      recurrenceId: '2026-11-16T08:00:00Z',
    })!
    expect(lines(updated)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T075959Z')
    expect(instants(updated)).toEqual(WEEKLY_UTC.slice(0, 4))
  })

  it('deleting this and following drops the later overrides and exclusions', () => {
    const source = weeklyBerlin({
      extra: ['EXDATE;TZID=Europe/Berlin:20261123T090000'],
      overrides: [
        vevent([
          'UID:weekly@example.com',
          stamp,
          'SUMMARY:Late',
          'RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000',
          'DTSTART;TZID=Europe/Berlin:20261130T150000',
          'DTEND;TZID=Europe/Berlin:20261130T160000',
        ]),
      ],
    })
    const updated = del(source, { kind: 'thisAndFollowing', recurrenceId: '2026-11-16T08:00:00Z' })!
    expect(splitEvents(updated)).toHaveLength(1)
    expect(lines(updated).some((l) => l.includes('20261123'))).toBe(false)
    expect(lines(updated).some((l) => l.includes('Late'))).toBe(false)
    expect(lines(updated)).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
  })

  it('deleting this and following at the first occurrence deletes the resource', () => {
    expect(
      del(weeklyBerlin(), { kind: 'thisAndFollowing', recurrenceId: '2026-10-12T07:00:00Z' }),
    ).toBeNull()
  })

  it('deleting the last remaining occurrence deletes the resource', () => {
    const two = weeklyBerlin({ rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2', exdate: false, overrides: [] })
    const once = del(two, { kind: 'instance', recurrenceId: '2026-10-12T07:00:00Z' })!
    expect(instants(once)).toEqual(['2026-10-19T07:00:00.000Z'])
    expect(del(once, { kind: 'instance', recurrenceId: '2026-10-19T07:00:00Z' })).toBeNull()
  })

  it('this and following with every earlier occurrence already gone deletes the resource', () => {
    const source = weeklyBerlin({
      rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      exdate: false,
      extra: ['EXDATE;TZID=Europe/Berlin:20261012T090000'],
      overrides: [],
    })
    expect(
      del(source, { kind: 'thisAndFollowing', recurrenceId: '2026-10-19T07:00:00Z' }),
    ).toBeNull()
  })

  it('deletes all-day, UTC and floating occurrences in their own form', () => {
    const allDay = wrapCalendar(
      vevent([
        'UID:d',
        stamp,
        'DTSTART;VALUE=DATE:20261105',
        'DTEND;VALUE=DATE:20261106',
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ]),
    )
    expect(lines(del(allDay, { kind: 'instance', recurrenceId: '2026-11-12' }))).toContain(
      'EXDATE;VALUE=DATE:20261112',
    )
    expect(lines(del(allDay, { kind: 'thisAndFollowing', recurrenceId: '2026-11-19' }))).toContain(
      'RRULE:FREQ=WEEKLY;UNTIL=20261118',
    )
    const utc = wrapCalendar(
      vevent([
        'UID:u',
        stamp,
        'DTSTART:20261105T083000Z',
        'DTEND:20261105T093000Z',
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ]),
    )
    expect(lines(del(utc, { kind: 'instance', recurrenceId: '2026-11-12T08:30:00Z' }))).toContain(
      'EXDATE:20261112T083000Z',
    )
    const floating = wrapCalendar(
      vevent([
        'UID:f',
        stamp,
        'DTSTART:20261104T100000',
        'DTEND:20261104T110000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ]),
    )
    expect(
      lines(del(floating, { kind: 'instance', recurrenceId: '2026-11-11T09:00:00Z' })),
    ).toContain('EXDATE:20261111T100000')
  })

  it('refuses an occurrence that does not exist', () => {
    for (const scope of [
      { kind: 'instance', recurrenceId: '2026-11-03T08:00:00Z' },
      { kind: 'instance', recurrenceId: '2026-11-02T08:00:00Z' },
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-03T08:00:00Z' },
    ] as EditScope[]) {
      expect(catchError(() => del(weeklyBerlin(), scope)).code).toBe('unknown-instance')
    }
  })
})
