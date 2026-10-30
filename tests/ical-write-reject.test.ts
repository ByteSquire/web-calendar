// @vitest-environment node
// Events come from other clients and from the user's keyboard: what cannot be edited safely is
// refused with an EditError, and no text can add lines to the resource.
import { describe, expect, it } from 'vitest'
import {
  deleteFromEventResource,
  editEventResource,
  EditError,
  type EditErrorCode,
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
const BERLIN: WriteContext = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  now: NOW,
}
const SERIES: EditScope = { kind: 'series' }
const stamp = 'DTSTAMP:20260901T080000Z'

const vevent = (lines: string[]): string[] => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
const weekly = (extra: string[] = []): string =>
  wrapCalendar(
    vevent([
      'UID:w@example.com',
      stamp,
      'SUMMARY:Weekly',
      'DTSTART;TZID=Europe/Berlin:20261012T090000',
      'DTEND;TZID=Europe/Berlin:20261012T100000',
      'RRULE:FREQ=WEEKLY;COUNT=6',
      ...extra,
    ]),
    BERLIN_VTIMEZONE,
  )
const single = (extra: string[] = []): string =>
  wrapCalendar(
    vevent([
      'UID:s@example.com',
      stamp,
      'SUMMARY:Single',
      'DTSTART;TZID=Europe/Berlin:20261105T090000',
      'DTEND;TZID=Europe/Berlin:20261105T100000',
      ...extra,
    ]),
    BERLIN_VTIMEZONE,
  )

function codeOf(fn: () => unknown): EditErrorCode {
  try {
    fn()
  } catch (error) {
    if (error instanceof EditError) return error.code
    throw error
  }
  throw new Error('expected an EditError')
}

const edit = (ics: string, scope: EditScope, changes: EventChanges, ctx = BERLIN) =>
  editEventResource(ics, scope, changes, ctx)

describe('text that is not an editable calendar', () => {
  const dtstart = 'DTSTART;TZID=Europe/Berlin:20261012T090000'
  it.each([
    ['empty text', '', 'unparseable'],
    ['not iCalendar at all', 'hello world', 'unparseable'],
    ['no VCALENDAR', ['BEGIN:VEVENT', 'UID:x', dtstart, 'END:VEVENT'].join('\r\n'), 'unparseable'],
    [
      'no VEVENT',
      ['BEGIN:VCALENDAR', 'VERSION:2.0', ...BERLIN_VTIMEZONE, 'END:VCALENDAR'].join('\r\n'),
      'unparseable',
    ],
    [
      'a VEVENT that is never closed',
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', dtstart, 'END:VCALENDAR'].join('\r\n'),
      'unparseable',
    ],
    [
      'an END that does not match',
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', dtstart, 'END:VTODO', 'END:VCALENDAR'].join(
        '\r\n',
      ),
      'unparseable',
    ],
    [
      'an END without a BEGIN',
      ['BEGIN:VCALENDAR', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
      'unparseable',
    ],
    [
      'a VEVENT without DTSTART',
      wrapCalendar(vevent(['UID:x', stamp, 'SUMMARY:No start'])),
      'unparseable',
    ],
    [
      'a DTSTART that is not a date',
      wrapCalendar(vevent(['UID:x', stamp, 'SUMMARY:Bad', 'DTSTART:garbage'])),
      'unparseable',
    ],
  ] as Array<[string, string, EditErrorCode]>)('%s', (_name, text, code) => {
    expect(codeOf(() => edit(text, SERIES, { title: 'x' }))).toBe(code)
    // Deleting a single event needs no start; a broken structure is refused all the same.
    if (!_name.includes('DTSTART')) {
      expect(
        codeOf(() =>
          deleteFromEventResource(text, { kind: 'instance', recurrenceId: '2026-10-12' }, BERLIN),
        ),
      ).toBe(code)
    }
  })

  it.each([
    ['an unknown frequency', 'RRULE:FREQ=FOO'],
    ['a rule without FREQ', 'RRULE:BYDAY=MO'],
    ['a made-up weekday', 'RRULE:FREQ=WEEKLY;BYDAY=XX'],
    ['a non-numeric count', 'RRULE:FREQ=DAILY;COUNT=abc'],
    ['a week number out of range', 'RRULE:FREQ=YEARLY;BYWEEKNO=54'],
    ['an interval of 0', 'RRULE:FREQ=DAILY;INTERVAL=0'],
    ['a count of 0', 'RRULE:FREQ=DAILY;COUNT=0'],
    ['day of the month 0', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=0'],
    ['a day that no month has', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'],
    ['a day that no listed month has', 'RRULE:FREQ=YEARLY;BYMONTH=2,4;BYMONTHDAY=31'],
  ])('refuses %s in a series it has to walk', (_name, rule) => {
    const text = wrapCalendar(
      vevent([
        'UID:x',
        stamp,
        'SUMMARY:Bad rule',
        'DTSTART;TZID=Europe/Berlin:20261012T090000',
        rule,
      ]),
      BERLIN_VTIMEZONE,
    )
    expect(
      codeOf(() =>
        edit(text, { kind: 'instance', recurrenceId: '2026-10-12T07:00:00Z' }, { title: 'x' }),
      ),
    ).toBe('unparseable')
  })

  it('refuses to edit an unlimited fine-grained series far in the future instead of hanging', () => {
    const text = wrapCalendar(
      vevent([
        'UID:x',
        stamp,
        'SUMMARY:Often',
        'DTSTART;TZID=Europe/Berlin:20260101T000000',
        'RRULE:FREQ=MINUTELY',
      ]),
      BERLIN_VTIMEZONE,
    )
    expect(
      codeOf(() =>
        edit(text, { kind: 'instance', recurrenceId: '2036-01-01T00:00:00Z' }, { title: 'x' }),
      ),
    ).toBe('unknown-instance')
  })
})

describe('invalid input', () => {
  it.each(
    [
      [
        '',
        'tomorrow',
        '2026-11-16T08:00:00',
        '2026-11-16T08:00Z',
        '2026-11-16 08:00:00Z',
        '20261116',
        '2026-11-16T08:00:00+01:00',
      ],
    ].flat(),
  )('refuses the recurrence id %j', (recurrenceId) => {
    for (const kind of ['instance', 'thisAndFollowing'] as const) {
      expect(codeOf(() => edit(weekly(), { kind, recurrenceId }, { title: 'x' }))).toBe(
        'invalid-input',
      )
      expect(codeOf(() => deleteFromEventResource(weekly(), { kind, recurrenceId }, BERLIN))).toBe(
        'invalid-input',
      )
    }
    expect(
      codeOf(() =>
        edit(
          weekly(),
          { kind: 'series', recurrenceId },
          { when: { start: '2026-10-12T09:00', end: '2026-10-12T10:00', allDay: false } },
        ),
      ),
    ).toBe('invalid-input')
  })

  it('treats a well-formed id that names no day as an unknown occurrence', () => {
    expect(
      codeOf(() =>
        edit(weekly(), { kind: 'instance', recurrenceId: '2026-13-45' }, { title: 'x' }),
      ),
    ).toBe('unknown-instance')
  })

  const timed = (start: string, end: string) => ({ start, end, allDay: false })
  const allDay = (start: string, end: string) => ({ start, end, allDay: true })
  it.each([
    ['an empty title', { title: '' }],
    ['a blank title', { title: ' \t ' }],
    ['an unknown status', { status: 'maybe' as never }],
    ['an end before the start', { when: timed('2026-11-05T10:00', '2026-11-05T09:00') }],
    ['an all-day end on the start day', { when: allDay('2026-11-05', '2026-11-05') }],
    ['an all-day end before the start', { when: allDay('2026-11-05', '2026-11-04') }],
    ['times in an all-day range', { when: allDay('2026-11-05T09:00', '2026-11-06T09:00') }],
    ['dates in a timed range', { when: timed('2026-11-05', '2026-11-06') }],
    ['a start that is not a date', { when: timed('soon', '2026-11-05T10:00') }],
    ['an impossible date', { when: timed('2026-02-30T10:00', '2026-02-30T11:00') }],
    ['an impossible time', { when: timed('2026-11-05T24:30', '2026-11-05T25:30') }],
    ['an offset in the range', { when: timed('2026-11-05T10:00+01:00', '2026-11-05T11:00+01:00') }],
  ] as Array<[string, EventChanges]>)('refuses %s', (_name, changes) => {
    for (const scope of [
      SERIES,
      { kind: 'instance', recurrenceId: '2026-11-02T08:00:00Z' },
      { kind: 'thisAndFollowing', recurrenceId: '2026-11-02T08:00:00Z' },
    ] as EditScope[]) {
      expect(codeOf(() => edit(weekly(), scope, changes))).toBe('invalid-input')
    }
    expect(codeOf(() => edit(single(), SERIES, changes))).toBe('invalid-input')
  })

  it('refuses a display or organization zone that is not one', () => {
    for (const zone of ['', 'Nowhere/Land', 'Europe/Berlin\r\nX-EVIL:1', 'CET-1CEST']) {
      expect(
        codeOf(() => edit(single(), SERIES, { title: 'x' }, { ...BERLIN, displayTimeZone: zone })),
      ).toBe('invalid-input')
      expect(
        codeOf(() => edit(single(), SERIES, { title: 'x' }, { ...BERLIN, orgTimeZone: zone })),
      ).toBe('invalid-input')
      expect(
        codeOf(() =>
          deleteFromEventResource(single(), SERIES, { ...BERLIN, displayTimeZone: zone }),
        ),
      ).toBe('invalid-input')
    }
  })

  it('refuses a series that exists only as single occurrences', () => {
    const orphan = wrapCalendar(
      vevent([
        'UID:o',
        stamp,
        'SUMMARY:Only one',
        'RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000',
        'DTSTART;TZID=Europe/Berlin:20261026T140000',
        'DTEND;TZID=Europe/Berlin:20261026T150000',
      ]),
      BERLIN_VTIMEZONE,
    )
    expect(codeOf(() => edit(orphan, SERIES, { title: 'x' }))).toBe('unsupported')
    expect(
      codeOf(() =>
        edit(orphan, { kind: 'instance', recurrenceId: '2026-10-27T08:00:00Z' }, { title: 'x' }),
      ),
    ).toBe('unknown-instance')
    const { updated } = edit(
      orphan,
      { kind: 'instance', recurrenceId: '2026-10-26T08:00:00Z' },
      { title: 'Renamed' },
    )
    expect(contentLines(updated!)).toContain('SUMMARY:Renamed')
    expect(
      deleteFromEventResource(
        orphan,
        { kind: 'instance', recurrenceId: '2026-10-26T08:00:00Z' },
        BERLIN,
      ).updated,
    ).toBeNull()
  })

  it('refuses to move times in a zone it cannot resolve, whichever way the edit goes', () => {
    const unknown = weekly()
      .replace(/Europe\/Berlin/g, 'Nowhere Standard Time')
      .replace(/BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE\r\n/, '')
    const range = { start: '2026-10-12T10:00', end: '2026-10-12T11:00', allDay: false }
    expect(codeOf(() => edit(unknown, SERIES, { when: range }))).toBe('unsupported')
    expect(
      codeOf(() =>
        edit(unknown, { kind: 'instance', recurrenceId: '2026-10-19T07:00:00Z' }, { title: 'x' }),
      ),
    ).toBe('unsupported')
  })
})

describe('text cannot add lines', () => {
  const attack =
    'x\r\nATTENDEE;CN=Eve:mailto:eve@example.com\nBEGIN:VALARM\rACTION:EMAIL\r\nEND:VALARM'
  const noExtraLines = (ics: string): void => {
    const lines = contentLines(ics)
    expect(lines.some((l) => l.startsWith('ATTENDEE'))).toBe(false)
    expect(lines.some((l) => l.startsWith('ACTION'))).toBe(false)
    expect(lines.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(0)
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(
      contentLines(ics).filter((l) => l === 'END:VEVENT').length,
    )
  }

  it('in every text field of a series edit', () => {
    const { updated } = edit(weekly(), SERIES, {
      title: attack,
      description: attack,
      location: attack,
      categoryNames: [attack, 'b'],
    })
    noExtraLines(updated!)
    const event = expand(updated!)[0]!
    expect(event.summary).toBe(attack.replace(/\r\n|\r/g, '\n'))
  })

  it('in an instance override and in a split', () => {
    const instance = edit(
      weekly(),
      { kind: 'instance', recurrenceId: '2026-10-19T07:00:00Z' },
      { title: attack, description: attack },
    )
    noExtraLines(instance.updated!)
    const split = edit(
      weekly(),
      { kind: 'thisAndFollowing', recurrenceId: '2026-10-19T07:00:00Z' },
      { title: attack, location: attack },
    )
    noExtraLines(split.updated!)
    noExtraLines(split.created!.ics)
  })

  it('and a RECURRENCE-ID taken from the caller cannot reach the text', () => {
    const error = codeOf(() =>
      edit(
        weekly(),
        {
          kind: 'instance',
          recurrenceId: '2026-10-19T07:00:00Z\r\nATTENDEE:mailto:eve@example.com',
        },
        { title: 'x' },
      ),
    )
    expect(error).toBe('invalid-input')
  })
})

describe('single events with a time to move', () => {
  const range = (start: string, end: string) => ({ start, end, allDay: false })

  it('moves a zoned event in its own zone and leaves the VTIMEZONE alone', () => {
    const source = single()
    const { updated } = edit(source, SERIES, {
      when: range('2026-11-05T10:00', '2026-11-05T11:00'),
    })
    const lines = contentLines(updated!)
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20261105T100000')
    expect(lines).toContain('DTEND;TZID=Europe/Berlin:20261105T110000')
    for (const line of BERLIN_VTIMEZONE) expect(lines).toContain(line)
    expect(instants(updated!)).toEqual(['2026-11-05T09:00:00.000Z'])
  })

  it('writes DTEND when the event had a DURATION', () => {
    const withDuration = wrapCalendar(
      vevent([
        'UID:d',
        stamp,
        'SUMMARY:D',
        'DTSTART;TZID=Europe/Berlin:20261105T090000',
        'DURATION:PT1H30M',
      ]),
      BERLIN_VTIMEZONE,
    )
    const unchanged = edit(withDuration, SERIES, {
      when: range('2026-11-05T09:00', '2026-11-05T10:30'),
    })
    expect(unchanged.updated).toBe(withDuration)
    const { updated } = edit(withDuration, SERIES, {
      when: range('2026-11-05T10:00', '2026-11-05T11:00'),
    })
    const [event] = splitEvents(updated!)
    expect(event).toContain('DTSTART;TZID=Europe/Berlin:20261105T100000')
    expect(event).toContain('DTEND;TZID=Europe/Berlin:20261105T110000')
    expect(event!.some((l) => l.startsWith('DURATION'))).toBe(false)
  })

  it('keeps the parameters of a DTSTART it only moves', () => {
    const odd = wrapCalendar(
      vevent([
        'UID:p',
        stamp,
        'SUMMARY:P',
        'DTSTART;VALUE=DATE-TIME;TZID=Europe/Berlin;X-VOBJ-ORIGINAL-TZID=Foo:20261105T090000',
        'DTEND;TZID=Europe/Berlin:20261105T100000',
      ]),
      BERLIN_VTIMEZONE,
    )
    const { updated } = edit(odd, SERIES, { when: range('2026-11-05T10:00', '2026-11-05T11:00') })
    expect(contentLines(updated!)).toContain(
      'DTSTART;VALUE=DATE-TIME;TZID=Europe/Berlin;X-VOBJ-ORIGINAL-TZID=Foo:20261105T100000',
    )
  })

  it('moves a floating event in the organization zone', () => {
    const floating = wrapCalendar(
      vevent(['UID:f', stamp, 'SUMMARY:F', 'DTSTART:20261105T090000', 'DTEND:20261105T100000']),
    )
    const { updated } = edit(
      floating,
      SERIES,
      { when: range('2026-11-05T19:00', '2026-11-05T20:00') },
      {
        ...BERLIN,
        displayTimeZone: 'Asia/Tokyo',
      },
    )
    // Tokyo is eight hours ahead of Berlin in November.
    expect(contentLines(updated!)).toContain('DTSTART:20261105T110000')
    expect(contentLines(updated!)).toContain('DTEND:20261105T120000')
  })

  it('moves a UTC event as an instant', () => {
    const utc = wrapCalendar(
      vevent(['UID:u', stamp, 'SUMMARY:U', 'DTSTART:20261105T080000Z', 'DTEND:20261105T090000Z']),
    )
    const { updated } = edit(utc, SERIES, { when: range('2026-11-05T10:00', '2026-11-05T11:00') })
    expect(contentLines(updated!)).toContain('DTSTART:20261105T090000Z')
    expect(contentLines(updated!)).toContain('DTEND:20261105T100000Z')
  })

  it('turns an all-day event into a timed one in the display zone', () => {
    const allDay = wrapCalendar(
      vevent([
        'UID:a',
        stamp,
        'SUMMARY:A',
        'DTSTART;VALUE=DATE:20261105',
        'DTEND;VALUE=DATE:20261106',
      ]),
    )
    const { updated } = edit(allDay, SERIES, {
      when: range('2026-11-05T10:00', '2026-11-05T11:00'),
    })
    const lines = contentLines(updated!)
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20261105T100000')
    expect(lines).toContain('TZID:Europe/Berlin')
    expect(instants(updated!)).toEqual(['2026-11-05T09:00:00.000Z'])
  })

  it('turns a timed event into an all-day one', () => {
    const { updated } = edit(single(), SERIES, {
      when: { start: '2026-11-05', end: '2026-11-06', allDay: true },
    })
    const [event] = splitEvents(updated!)
    expect(event).toContain('DTSTART;VALUE=DATE:20261105')
    expect(event).toContain('DTEND;VALUE=DATE:20261106')
    expect(event!.some((l) => l.includes('TZID'))).toBe(false)
  })

  it('moves a nonexistent local time as RFC 5545 says', () => {
    // 02:30 on 29 March 2026 does not exist in Berlin; the editor's wall clock is kept as typed.
    const { updated } = edit(single(), SERIES, {
      when: range('2026-03-29T02:30', '2026-03-29T03:30'),
    })
    expect(contentLines(updated!)).toContain('DTSTART;TZID=Europe/Berlin:20260329T023000')
  })
})
