// @vitest-environment node
// The form of the live dialogs: defaults, the form of an existing event, validation of the repeat,
// the mapping to the iCalendar writer's input, and the diff that turns an edit into `EventChanges`.
import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { createEventResource } from '../app/utils/ical/write'
import { setQuickAddAllDay, setQuickAddStart } from '../app/utils/quick-add'
import {
  diffEventForm,
  eventFormFromEvent,
  initialEventForm,
  recurrenceFromForm,
  toWallClockRange,
  toWriterNewEvent,
  validateEventForm,
  type EventForm,
} from '../app/utils/writes/event-form'
import { contentLines, instants } from './ical-write-helpers'
import { NOW } from './writes-helpers'

const anchor = Temporal.PlainDate.from('2026-10-28') // a Wednesday
const calendars = [{ id: 'dav:/a/' }, { id: 'dav:/b/' }]
const calendarIds = calendars.map((calendar) => calendar.id)

function form(overrides: Partial<EventForm> = {}): EventForm {
  return {
    ...initialEventForm({ preset: null, anchor, calendars, visibleCalendarIds: ['dav:/b/'] }),
    title: 'Planning',
    ...overrides,
  }
}

const BERLIN = { displayTimeZone: 'Europe/Berlin', orgTimeZone: 'Europe/Berlin', now: NOW }

describe('initialEventForm', () => {
  it('starts from the quick-add defaults with empty extras and no repeat', () => {
    expect(form({ title: '' })).toEqual({
      title: '',
      calendarId: 'dav:/b/',
      allDay: false,
      start: '2026-10-28T09:00',
      end: '2026-10-28T10:00',
      description: '',
      location: '',
      status: 'confirmed',
      categoryNames: [],
      repeat: 'none',
      repeatEnds: 'never',
      repeatUntil: '',
      repeatCount: '10',
    })
  })

  it('gives every form its own list of categories', () => {
    const a = form()
    const b = form()
    a.categoryNames.push('Work')
    expect(b.categoryNames).toEqual([])
  })

  it('keeps its extras when the quick-add helpers change the times', () => {
    const base = form({ description: 'Agenda', repeat: 'weekly' })
    const allDay = setQuickAddAllDay(base, true)
    expect(allDay).toMatchObject({ allDay: true, description: 'Agenda', repeat: 'weekly' })
    expect(setQuickAddStart(allDay, '2026-10-30')).toMatchObject({
      start: '2026-10-30',
      end: '2026-10-30',
      description: 'Agenda',
    })
  })
})

describe('eventFormFromEvent', () => {
  const base = {
    title: 'Offsite',
    calendarId: 'dav:/a/',
    status: 'tentative' as const,
  }

  it('cuts a timed event to the minute', () => {
    expect(
      eventFormFromEvent({
        ...base,
        allDay: false,
        start: '2026-11-02T14:30:15',
        end: '2026-11-02T16:00:00',
        description: 'Bring slides',
        location: 'Room 4',
        categoryNames: ['Work', 'Meeting'],
      }),
    ).toMatchObject({
      title: 'Offsite',
      calendarId: 'dav:/a/',
      status: 'tentative',
      allDay: false,
      start: '2026-11-02T14:30',
      end: '2026-11-02T16:00',
      description: 'Bring slides',
      location: 'Room 4',
      categoryNames: ['Work', 'Meeting'],
      repeat: 'none',
    })
  })

  it('shows the last day of an all-day event, not the exclusive end', () => {
    expect(
      eventFormFromEvent({ ...base, allDay: true, start: '2026-11-02', end: '2026-11-05' }),
    ).toMatchObject({ allDay: true, start: '2026-11-02', end: '2026-11-04' })
    expect(
      eventFormFromEvent({ ...base, allDay: true, start: '2026-11-02', end: '2026-11-03' }),
    ).toMatchObject({ start: '2026-11-02', end: '2026-11-02' })
  })

  it('repairs an all-day end that is not after the start', () => {
    expect(
      eventFormFromEvent({ ...base, allDay: true, start: '2026-11-02', end: '2026-11-02' }),
    ).toMatchObject({ start: '2026-11-02', end: '2026-11-02' })
  })

  it('has empty text where the event has none, and copies the categories', () => {
    const names = ['Work']
    const result = eventFormFromEvent({
      ...base,
      allDay: false,
      start: '2026-11-02T14:30:00',
      end: '2026-11-02T15:30:00',
      categoryNames: names,
    })
    expect(result).toMatchObject({ description: '', location: '' })
    result.categoryNames.push('x')
    expect(names).toEqual(['Work'])
  })
})

describe('validateEventForm', () => {
  it('passes a valid form and reports the quick-add errors', () => {
    expect(validateEventForm(form(), calendarIds)).toEqual({})
    expect(
      validateEventForm(
        form({ title: ' ', calendarId: 'x', end: '2026-10-28T09:00' }),
        calendarIds,
      ),
    ).toEqual({
      title: 'Enter a title.',
      calendarId: 'Choose a calendar.',
      end: 'The end must be after the start.',
    })
  })

  it('ignores the repeat inputs while the event does not repeat', () => {
    expect(
      validateEventForm(
        form({ repeatEnds: 'after', repeatCount: 'many', repeatUntil: 'x' }),
        calendarIds,
      ),
    ).toEqual({})
  })

  it.each([
    ['', 'Enter the last date of the repeat.'],
    ['soon', 'Enter the last date of the repeat.'],
    ['2026-02-30', 'Enter the last date of the repeat.'],
    ['2026-10-27', 'The repeat must not end before the event starts.'],
  ])('refuses the last repeat date "%s"', (repeatUntil, message) => {
    expect(
      validateEventForm(form({ repeat: 'weekly', repeatEnds: 'on', repeatUntil }), calendarIds),
    ).toEqual({ repeatUntil: message })
  })

  it.each(['2026-10-28', '2026-12-31'])('accepts the last repeat date %s', (repeatUntil) => {
    expect(
      validateEventForm(form({ repeat: 'daily', repeatEnds: 'on', repeatUntil }), calendarIds),
    ).toEqual({})
  })

  it.each(['', ' ', '0', '-3', '1.5', '1e3', 'abc', '1000', '10000', '99999'])(
    'refuses the count "%s"',
    (repeatCount) => {
      expect(
        validateEventForm(form({ repeat: 'daily', repeatEnds: 'after', repeatCount }), calendarIds),
      ).toEqual({ repeatCount: 'Enter a number from 1 to 999.' })
    },
  )

  it.each(['1', '10', ' 7 ', '999'])('accepts the count "%s"', (repeatCount) => {
    expect(
      validateEventForm(form({ repeat: 'daily', repeatEnds: 'after', repeatCount }), calendarIds),
    ).toEqual({})
  })

  it('does not ask for a count or a date when the repeat never ends', () => {
    expect(
      validateEventForm(form({ repeat: 'yearly', repeatCount: '', repeatUntil: '' }), calendarIds),
    ).toEqual({})
  })

  it('compares an all-day repeat end with the start date', () => {
    const allDay = form({ allDay: true, start: '2026-10-28', end: '2026-10-28', repeat: 'weekly' })
    expect(
      validateEventForm({ ...allDay, repeatEnds: 'on', repeatUntil: '2026-10-27' }, calendarIds),
    ).toEqual({ repeatUntil: 'The repeat must not end before the event starts.' })
    expect(
      validateEventForm({ ...allDay, repeatEnds: 'on', repeatUntil: '2026-10-28' }, calendarIds),
    ).toEqual({})
  })

  describe('when editing', () => {
    // Events other clients made may have no length; an edit that leaves the time alone must pass.
    const zero = form({ start: '2026-11-02T10:00', end: '2026-11-02T10:00' })

    it('does not check times that were not touched', () => {
      expect(validateEventForm(zero, calendarIds)).toEqual({
        end: 'The end must be after the start.',
      })
      expect(
        validateEventForm({ ...zero, title: 'Renamed' }, calendarIds, { original: zero }),
      ).toEqual({})
    })

    it('checks them once they are changed', () => {
      expect(
        validateEventForm({ ...zero, end: '2026-11-02T09:00' }, calendarIds, { original: zero }),
      ).toEqual({ end: 'The end must be after the start.' })
    })

    it('still checks the title', () => {
      expect(validateEventForm({ ...zero, title: '' }, calendarIds, { original: zero })).toEqual({
        title: 'Enter a title.',
      })
    })
  })
})

describe('toWallClockRange', () => {
  it('passes a timed range on and makes the all-day end exclusive', () => {
    expect(toWallClockRange(form())).toEqual({
      start: '2026-10-28T09:00',
      end: '2026-10-28T10:00',
      allDay: false,
    })
    expect(
      toWallClockRange(form({ allDay: true, start: '2026-12-30', end: '2026-12-31' })),
    ).toEqual({ start: '2026-12-30', end: '2027-01-01', allDay: true })
  })
})

describe('recurrenceFromForm', () => {
  it('is undefined without a repeat', () => {
    expect(recurrenceFromForm(form())).toBeUndefined()
  })

  it('repeats daily and yearly without extra parts', () => {
    expect(recurrenceFromForm(form({ repeat: 'daily' }))).toEqual({ freq: 'DAILY' })
    expect(recurrenceFromForm(form({ repeat: 'yearly' }))).toEqual({ freq: 'YEARLY' })
  })

  it.each([
    ['2026-10-26', 'MO'],
    ['2026-10-28', 'WE'],
    ['2026-11-01', 'SU'],
  ])('repeats weekly on the weekday of the start (%s is %s)', (day, code) => {
    expect(
      recurrenceFromForm(form({ repeat: 'weekly', start: `${day}T09:00`, end: `${day}T10:00` })),
    ).toEqual({ freq: 'WEEKLY', byDay: [code] })
  })

  it('repeats monthly on the day of the month of the start', () => {
    expect(
      recurrenceFromForm(
        form({ repeat: 'monthly', start: '2026-10-31T09:00', end: '2026-10-31T10:00' }),
      ),
    ).toEqual({ freq: 'MONTHLY', byMonthDay: [31] })
  })

  it('maps the end: never, on a date, after a number of times', () => {
    expect(recurrenceFromForm(form({ repeat: 'daily', repeatEnds: 'never' }))).toEqual({
      freq: 'DAILY',
    })
    expect(
      recurrenceFromForm(form({ repeat: 'daily', repeatEnds: 'on', repeatUntil: '2026-11-30' })),
    ).toEqual({ freq: 'DAILY', until: '2026-11-30' })
    expect(
      recurrenceFromForm(form({ repeat: 'daily', repeatEnds: 'after', repeatCount: ' 12 ' })),
    ).toEqual({ freq: 'DAILY', count: 12 })
  })

  it('uses the start in the form, not the anchor, for the weekday of an all-day event', () => {
    expect(
      recurrenceFromForm(
        form({ repeat: 'weekly', allDay: true, start: '2026-11-03', end: '2026-11-03' }),
      ),
    ).toEqual({ freq: 'WEEKLY', byDay: ['TU'] })
  })
})

describe('toWriterNewEvent and the writer', () => {
  it('trims the text and leaves empty description and location out', () => {
    expect(
      toWriterNewEvent(form({ title: '  Planning ', description: '  ', location: ' Room 2 ' })),
    ).toEqual({
      title: 'Planning',
      when: { start: '2026-10-28T09:00', end: '2026-10-28T10:00', allDay: false },
      location: 'Room 2',
    })
  })

  it('creates a weekly event with three occurrences on the weekday of the start', () => {
    const input = toWriterNewEvent(
      form({
        repeat: 'weekly',
        repeatEnds: 'after',
        repeatCount: '3',
        description: 'Agenda',
        location: 'Room 1',
      }),
    )
    const { ics } = createEventResource(input, BERLIN)
    const lines = contentLines(ics)
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3')
    expect(lines).toContain('DESCRIPTION:Agenda')
    expect(lines).toContain('LOCATION:Room 1')
    expect(instants(ics)).toEqual([
      '2026-10-28T08:00:00.000Z',
      '2026-11-04T08:00:00.000Z',
      '2026-11-11T08:00:00.000Z',
    ])
  })

  it('creates a monthly event that ends on a date, inclusive', () => {
    const input = toWriterNewEvent(
      form({
        repeat: 'monthly',
        start: '2026-10-15T09:00',
        end: '2026-10-15T10:00',
        repeatEnds: 'on',
        repeatUntil: '2027-01-15',
      }),
    )
    const { ics } = createEventResource(input, BERLIN)
    expect(contentLines(ics).find((line) => line.startsWith('RRULE:'))).toMatch(
      /^RRULE:FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20270115T225959Z$/,
    )
    expect(instants(ics)).toHaveLength(4)
  })

  it('creates an all-day weekly event with dates', () => {
    const input = toWriterNewEvent(
      form({
        allDay: true,
        start: '2026-11-03',
        end: '2026-11-04',
        repeat: 'weekly',
        repeatEnds: 'on',
        repeatUntil: '2026-11-17',
      }),
    )
    const { ics } = createEventResource(input, BERLIN)
    const lines = contentLines(ics)
    expect(lines).toContain('DTSTART;VALUE=DATE:20261103')
    expect(lines).toContain('DTEND;VALUE=DATE:20261105')
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261117')
  })
})

describe('diffEventForm', () => {
  const original = eventFormFromEvent({
    title: 'Planning',
    calendarId: 'dav:/a/',
    allDay: false,
    // The state holds seconds; the form shows minutes.
    start: '2026-11-02T14:00:00',
    end: '2026-11-02T15:00:00',
    status: 'confirmed',
    description: 'Agenda',
    categoryNames: ['Work', 'Meeting'],
  })

  it('is empty for a form nobody touched', () => {
    expect(diffEventForm(original, { ...original })).toEqual({})
  })

  it('does not report the times when only a text changed', () => {
    expect(diffEventForm(original, { ...original, title: 'Planning 2' })).toEqual({
      title: 'Planning 2',
    })
  })

  it('compares trimmed text and treats a missing description as empty', () => {
    expect(
      diffEventForm(original, { ...original, title: ' Planning ', description: 'Agenda  ' }),
    ).toEqual({})
    const bare = { ...original, description: '', location: '' }
    expect(diffEventForm(bare, { ...bare, description: '  ', location: '' })).toEqual({})
  })

  it('removes a description or location that was cleared and adds one that is new', () => {
    expect(diffEventForm(original, { ...original, description: ' ' })).toEqual({
      description: null,
    })
    expect(diffEventForm(original, { ...original, location: ' Room 5 ' })).toEqual({
      location: 'Room 5',
    })
    const withLocation = { ...original, location: 'Room 5' }
    expect(diffEventForm(withLocation, { ...withLocation, location: '' })).toEqual({
      location: null,
    })
  })

  it('reports the status', () => {
    expect(diffEventForm(original, { ...original, status: 'cancelled' })).toEqual({
      status: 'cancelled',
    })
  })

  it('compares categories as a set and sends the list when it differs', () => {
    expect(diffEventForm(original, { ...original, categoryNames: ['Meeting', 'Work'] })).toEqual({})
    expect(
      diffEventForm(original, { ...original, categoryNames: ['Work', 'Meeting', 'Travel'] }),
    ).toEqual({ categoryNames: ['Work', 'Meeting', 'Travel'] })
    expect(diffEventForm(original, { ...original, categoryNames: [] })).toEqual({
      categoryNames: [],
    })
  })

  it('reports the whole range when the start or the end moved', () => {
    expect(diffEventForm(original, setQuickAddStart(original, '2026-11-03T14:00'))).toEqual({
      when: { start: '2026-11-03T14:00', end: '2026-11-03T15:00', allDay: false },
    })
    expect(diffEventForm(original, { ...original, end: '2026-11-02T15:30' })).toEqual({
      when: { start: '2026-11-02T14:00', end: '2026-11-02T15:30', allDay: false },
    })
  })

  it('reports an all-day switch with the exclusive end', () => {
    const toAllDay = setQuickAddAllDay(original, true)
    expect(diffEventForm(original, toAllDay)).toEqual({
      when: { start: '2026-11-02', end: '2026-11-03', allDay: true },
    })
  })

  it('does not see a change in an all-day event that was left alone', () => {
    const allDay = eventFormFromEvent({
      title: 'Offsite',
      calendarId: 'dav:/a/',
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-05',
      status: 'confirmed',
    })
    expect(diffEventForm(allDay, { ...allDay })).toEqual({})
    expect(diffEventForm(allDay, { ...allDay, end: '2026-11-05' })).toEqual({
      when: { start: '2026-11-02', end: '2026-11-06', allDay: true },
    })
  })
})
