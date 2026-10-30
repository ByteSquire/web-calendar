// @vitest-environment node
// Creating events: the text a new event is written as, and the input that has to be refused.
import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import {
  createEventResource,
  editEventResource,
  EditError,
  type NewEventInput,
  type NewEventRecurrence,
  type WriteContext,
} from '../app/utils/ical/write'
import { contentLines, expand, instants, splitEvents } from './ical-write-helpers'

const NOW = new Date('2026-10-30T12:00:00Z')
const ctxIn = (displayTimeZone: string, orgTimeZone = 'Europe/Berlin'): WriteContext => ({
  displayTimeZone,
  orgTimeZone,
  now: NOW,
})
const BERLIN = ctxIn('Europe/Berlin')

const timed = (start: string, end: string) => ({ start, end, allDay: false })

function input(overrides: Partial<NewEventInput> = {}): NewEventInput {
  return {
    title: 'Standup',
    when: timed('2026-11-02T09:00', '2026-11-02T09:30'),
    ...overrides,
  }
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

describe('createEventResource', () => {
  it('writes a timed event with TZID, a VTIMEZONE and all the fields', () => {
    const { uid, ics } = createEventResource(
      input({
        description: 'Agenda: A, B; C\nSecond line',
        location: 'Room 1, Floor 2',
        status: 'tentative',
        categoryNames: ['Work', 'A,B'],
      }),
      BERLIN,
    )
    expect(uid).toMatch(/^[0-9a-f-]{36}$/)
    const lines = contentLines(ics)
    expect(lines.slice(0, 4)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//web-calendar//Web Calendar//EN',
      'CALSCALE:GREGORIAN',
    ])
    expect(lines).toContain('BEGIN:VTIMEZONE')
    expect(lines).toContain('TZID:Europe/Berlin')
    const [event] = splitEvents(ics)
    expect(event).toEqual([
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261030T120000Z',
      'CREATED:20261030T120000Z',
      'LAST-MODIFIED:20261030T120000Z',
      'SEQUENCE:0',
      'SUMMARY:Standup',
      'DTSTART;TZID=Europe/Berlin:20261102T090000',
      'DTEND;TZID=Europe/Berlin:20261102T093000',
      'STATUS:TENTATIVE',
      'CATEGORIES:Work,A\\,B',
      'DESCRIPTION:Agenda: A\\, B\\; C\\nSecond line',
      'LOCATION:Room 1\\, Floor 2',
      'END:VEVENT',
    ])
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).not.toMatch(/[^\r]\n/)
    // The VTIMEZONE comes before the event, as clients expect.
    expect(lines.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(lines.indexOf('BEGIN:VEVENT'))
    expect(instants(ics)).toEqual(['2026-11-02T08:00:00.000Z'])
    expect(() => ICAL.parse(ics)).not.toThrow()
  })

  it('gives every event its own UID', () => {
    const a = createEventResource(input(), BERLIN)
    const b = createEventResource(input(), BERLIN)
    expect(a.uid).not.toBe(b.uid)
  })

  it('writes the event in the display zone, wherever the organization is', () => {
    const { ics } = createEventResource(
      input({ when: timed('2026-11-02T19:00', '2026-11-02T20:00') }),
      ctxIn('Australia/Sydney'),
    )
    expect(contentLines(ics)).toContain('DTSTART;TZID=Australia/Sydney:20261102T190000')
    expect(contentLines(ics)).toContain('TZID:Australia/Sydney')
    expect(instants(ics)).toEqual(['2026-11-02T08:00:00.000Z'])
  })

  it('writes an all-day event as dates without a VTIMEZONE', () => {
    const { ics } = createEventResource(
      input({ when: { start: '2026-11-05', end: '2026-11-07', allDay: true } }),
      BERLIN,
    )
    const lines = contentLines(ics)
    expect(lines).toContain('DTSTART;VALUE=DATE:20261105')
    expect(lines).toContain('DTEND;VALUE=DATE:20261107')
    expect(lines).not.toContain('BEGIN:VTIMEZONE')
    expect(expand(ics)[0]?.isDate).toBe(true)
  })

  it('writes UTC times for a display zone of UTC', () => {
    const { ics } = createEventResource(
      input({ when: timed('2026-11-02T08:00', '2026-11-02T08:30') }),
      ctxIn('UTC'),
    )
    const lines = contentLines(ics)
    expect(lines).toContain('DTSTART:20261102T080000Z')
    expect(lines).toContain('DTEND:20261102T083000Z')
    expect(lines).not.toContain('BEGIN:VTIMEZONE')
  })

  it('never writes a floating time', () => {
    for (const when of [
      timed('2026-11-02T09:00', '2026-11-02T09:30'),
      { start: '2026-11-02', end: '2026-11-03', allDay: true },
    ]) {
      for (const zone of ['Europe/Berlin', 'UTC', 'Asia/Tokyo']) {
        const [event] = splitEvents(createEventResource(input({ when }), ctxIn(zone)).ics)
        for (const line of event!.filter((l) => /^(DTSTART|DTEND)/.test(l))) {
          expect(line).toMatch(/TZID=|VALUE=DATE:|Z$/)
        }
      }
    }
  })

  it('keeps an empty optional field out of the event', () => {
    const { ics } = createEventResource(
      input({ description: '', location: '', categoryNames: [' '] }),
      BERLIN,
    )
    const [event] = splitEvents(ics)
    expect(event!.some((l) => /^(DESCRIPTION|LOCATION|CATEGORIES|STATUS)/.test(l))).toBe(false)
  })

  it('folds long lines at 75 octets without splitting a character', () => {
    const title = 'Ärger über Öl und Ärzte '.repeat(8)
    const { ics } = createEventResource(input({ title }), BERLIN)
    for (const physical of ics.split('\r\n')) {
      expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75)
    }
    expect(contentLines(ics)).toContain(`SUMMARY:${title}`)
    expect(expand(ics)[0]?.summary).toBe(title)
  })

  it('the new resource can be edited straight away', () => {
    const { ics } = createEventResource(input({ recurrence: { freq: 'WEEKLY', count: 4 } }), BERLIN)
    const { updated } = editEventResource(
      ics,
      { kind: 'instance', recurrenceId: '2026-11-09T08:00:00Z' },
      { title: 'Different' },
      BERLIN,
    )
    expect(expand(updated!).map((o) => o.summary)).toEqual([
      'Standup',
      'Different',
      'Standup',
      'Standup',
    ])
  })
})

describe('createEventResource: recurrence', () => {
  const start = timed('2026-11-02T09:00', '2026-11-02T09:30') // a Monday

  it.each([
    [
      'every other week on two days',
      { freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], count: 5 },
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5',
      ['2026-11-02', '2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30'],
    ],
    [
      'the last Friday of the month',
      { freq: 'MONTHLY', byDay: ['-1FR'], count: 3 },
      'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3',
      ['2026-11-27', '2026-12-25', '2027-01-29'],
    ],
    [
      'the first and fifteenth',
      { freq: 'MONTHLY', byMonthDay: [1, 15], count: 4 },
      'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=4',
      ['2026-11-01', '2026-11-15', '2026-12-01', '2026-12-15'],
      '2026-11-01',
    ],
    [
      'the last day of the month',
      { freq: 'MONTHLY', byMonthDay: [-1], count: 3 },
      'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3',
      ['2026-11-30', '2026-12-31', '2027-01-31'],
    ],
    [
      'every March 1st',
      { freq: 'YEARLY', byMonth: [3], byMonthDay: [1], count: 2 },
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;COUNT=2',
      ['2027-03-01', '2028-03-01'],
    ],
    [
      'the last weekday of the month',
      {
        freq: 'MONTHLY',
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
        bySetPos: [-1],
        count: 3,
      },
      'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3',
      ['2026-11-30', '2026-12-31', '2027-01-29'],
      '2026-11-30',
    ],
    [
      'every third day',
      { freq: 'DAILY', interval: 3, count: 3 },
      'FREQ=DAILY;INTERVAL=3;COUNT=3',
      ['2026-11-02', '2026-11-05', '2026-11-08'],
    ],
    [
      'an end date as a date (the whole day counts)',
      { freq: 'WEEKLY', until: '2026-11-16' },
      'FREQ=WEEKLY;UNTIL=20261116T225959Z',
      ['2026-11-02', '2026-11-09', '2026-11-16'],
    ],
    [
      'an end date with a time',
      { freq: 'WEEKLY', until: '2026-11-16T09:00' },
      'FREQ=WEEKLY;UNTIL=20261116T080000Z',
      ['2026-11-02', '2026-11-09', '2026-11-16'],
    ],
  ] as unknown as Array<[string, NewEventRecurrence, string, string[], string?]>)(
    '%s',
    (_name, recurrence, rule, days, first) => {
      const when = first ? timed(`${first}T09:00`, `${first}T09:30`) : start
      const { ics } = createEventResource(input({ when, recurrence }), BERLIN)
      expect(contentLines(ics)).toContain(`RRULE:${rule}`)
      // The days are in Berlin; the times are 09:00 there (CET after the clocks went back).
      const occurrences = expand(ics, 10)
      expect(occurrences.map((o) => o.wall.slice(0, 10))).toEqual(days)
      for (const o of occurrences) expect(o.wall.slice(11)).toBe('09:00:00')
    },
  )

  it('ends an all-day series on a date', () => {
    const { ics } = createEventResource(
      input({
        when: { start: '2026-11-05', end: '2026-11-06', allDay: true },
        recurrence: { freq: 'DAILY', until: '2026-11-07T18:00' },
      }),
      BERLIN,
    )
    expect(contentLines(ics)).toContain('RRULE:FREQ=DAILY;UNTIL=20261107')
    expect(expand(ics).map((o) => o.wall)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07'])
  })

  it('ends the series in the display zone, so a recurrence follows its daylight saving', () => {
    // 09:00 in Sydney through the change of 4 October 2026: the instant moves, the wall clock not.
    const { ics } = createEventResource(
      input({
        when: timed('2026-09-28T09:00', '2026-09-28T10:00'),
        recurrence: { freq: 'WEEKLY', count: 3 },
      }),
      ctxIn('Australia/Sydney'),
    )
    expect(instants(ics)).toEqual([
      '2026-09-27T23:00:00.000Z', // +10
      '2026-10-04T22:00:00.000Z', // +11
      '2026-10-11T22:00:00.000Z',
    ])
  })
})

describe('createEventResource: refused input', () => {
  const day = { start: '2026-11-05', end: '2026-11-06', allDay: true }
  const code = (title: string, fn: () => unknown, expected = 'invalid-input') => {
    const error = catchError(fn)
    expect(error.code, title).toBe(expected)
  }

  it.each([
    ['an empty title', { title: '' }],
    ['a blank title', { title: '   ' }],
    ['an end before the start', { when: timed('2026-11-02T10:00', '2026-11-02T09:00') }],
    [
      'an all-day end on the start day',
      { when: { start: '2026-11-05', end: '2026-11-05', allDay: true } },
    ],
    [
      'an all-day end before the start',
      { when: { start: '2026-11-05', end: '2026-11-04', allDay: true } },
    ],
    [
      'times for an all-day event',
      { when: { start: '2026-11-05T09:00', end: '2026-11-06T09:00', allDay: true } },
    ],
    ['dates for a timed event', { when: timed('2026-11-05', '2026-11-06') }],
    ['a start that is not a date', { when: timed('tomorrow', '2026-11-06T10:00') }],
    ['an impossible date', { when: timed('2026-02-30T10:00', '2026-02-30T11:00') }],
    ['an impossible time', { when: timed('2026-11-05T25:00', '2026-11-05T26:00') }],
    ['an empty end', { when: timed('2026-11-05T10:00', '') }],
    ['a time zone suffix', { when: timed('2026-11-05T10:00Z', '2026-11-05T11:00Z') }],
    ['an unknown status', { status: 'maybe' as never }],
    ['an unknown frequency', { recurrence: { freq: 'HOURLY' as never } }],
    ['a zero interval', { recurrence: { freq: 'DAILY', interval: 0 } }],
    ['a fractional interval', { recurrence: { freq: 'DAILY', interval: 1.5 } }],
    ['a zero count', { recurrence: { freq: 'DAILY', count: 0 } }],
    ['a count and an end date', { recurrence: { freq: 'DAILY', count: 2, until: '2026-12-01' } }],
    ['an end before the start', { recurrence: { freq: 'DAILY', until: '2026-10-01' } }],
    ['a made-up weekday', { recurrence: { freq: 'WEEKLY', byDay: ['XX'] } }],
    ['a weekday that injects a part', { recurrence: { freq: 'WEEKLY', byDay: ['MO;COUNT=1'] } }],
    ['a numbered weekday in a weekly rule', { recurrence: { freq: 'WEEKLY', byDay: ['1MO'] } }],
    ['month 13', { recurrence: { freq: 'YEARLY', byMonth: [13] } }],
    ['day of month 0', { recurrence: { freq: 'MONTHLY', byMonthDay: [0] } }],
    ['day of month 32', { recurrence: { freq: 'MONTHLY', byMonthDay: [32] } }],
    ['a set position without a BY part', { recurrence: { freq: 'MONTHLY', bySetPos: [1] } }],
    ['a set position of 0', { recurrence: { freq: 'MONTHLY', byDay: ['MO'], bySetPos: [0] } }],
  ] as Array<[string, Partial<NewEventInput>]>)('refuses %s', (name, bad) => {
    code(name, () => createEventResource({ ...input(), ...bad }, BERLIN))
    void day
  })

  it('refuses a display or organization zone that is not one', () => {
    for (const zone of [
      '',
      'Mars/Olympus',
      'Europe/Berlin\r\nX-EVIL:1',
      'W. Europe Standard Time',
    ]) {
      code(`display ${zone}`, () => createEventResource(input(), ctxIn(zone)))
      code(`org ${zone}`, () => createEventResource(input(), ctxIn('Europe/Berlin', zone)))
    }
  })

  it('cannot be made to write extra lines through any text field', () => {
    const attack = 'x\r\nATTENDEE;CN=Eve:mailto:eve@example.com\r\nBEGIN:VALARM\nACTION:EMAIL'
    const { ics } = createEventResource(
      input({
        title: attack,
        description: attack,
        location: attack,
        categoryNames: [attack, 'ok'],
      }),
      BERLIN,
    )
    const lines = contentLines(ics)
    expect(lines.some((l) => l.startsWith('ATTENDEE'))).toBe(false)
    expect(lines.some((l) => l.startsWith('BEGIN:VALARM'))).toBe(false)
    expect(lines.some((l) => l.startsWith('ACTION'))).toBe(false)
    const [event] = splitEvents(ics)
    expect(event!.filter((l) => l.startsWith('SUMMARY'))).toEqual([
      'SUMMARY:x\\nATTENDEE\\;CN=Eve:mailto:eve@example.com\\nBEGIN:VALARM\\nACTION:EMAIL',
    ])
    expect(expand(ics)[0]?.summary).toBe(attack.replace(/\r\n|\r/g, '\n'))
  })

  it('drops control characters from text', () => {
    const { ics } = createEventResource(input({ title: 'a\u0000b\u0007c\td' }), BERLIN)
    expect(contentLines(ics)).toContain('SUMMARY:abc\td')
  })
})
