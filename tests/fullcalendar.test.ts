import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { createMockData } from '../app/data/mock'
import {
  VIEW_TYPES,
  rangeKindOf,
  visibleRangeFor,
  type SplitSpan,
  type ViewType,
} from '../app/utils/calendar-state'
import {
  BUSY_TITLE,
  buildEventDetails,
  describeEventWhen,
  eventAssistiveLabel,
} from '../app/utils/event-display'
import { pickFocusTarget } from '../app/utils/focus'
import {
  BASE_CALENDAR_OPTIONS,
  COMPACT_MAX_WIDTH,
  FULLCALENDAR_VIEW_NAMES,
  calendarLayoutOptions,
  eventDisplayFor,
  contrastRatio,
  eventColors,
  eventKind,
  fullCalendarViewName,
  isCompactWidth,
  mixColors,
  parseHexColor,
  plainDateInCalendarZone,
  quickAddPresetForClick,
  readableTextColor,
  relativeLuminance,
  toFullCalendarEvent,
  toFullCalendarEvents,
  type ColorScheme,
  type EventExtendedProps,
  type EventKind,
  type EventMappingContext,
} from '../app/utils/fullcalendar'
import type { Calendar, CalendarEvent } from '../shared/types/calendar'

const SCHEMES: ColorScheme[] = ['light', 'dark']
const KINDS: EventKind[] = ['confirmed', 'tentative', 'cancelled', 'blocked']
const SURFACES: Record<ColorScheme, string> = { light: '#ffffff', dark: '#0f172a' }

const calendar = (overrides: Partial<Calendar> = {}): Calendar => ({
  id: 'cal-a',
  name: 'Team',
  type: 'caldav',
  color: '#047857',
  defaultVisible: true,
  ...overrides,
})

const makeEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1',
  uid: 'evt-1',
  calendarId: 'cal-a',
  title: 'Planning',
  start: '2026-10-28T09:00:00',
  end: '2026-10-28T10:00:00',
  allDay: false,
  status: 'confirmed',
  categoryIds: [],
  ...overrides,
})

const context = (scheme: ColorScheme = 'light', calendars = [calendar()]): EventMappingContext => ({
  calendarById: new Map(calendars.map((item) => [item.id, item])),
  scheme,
})

const extendedProps = (input: ReturnType<typeof toFullCalendarEvent>) =>
  input.extendedProps as EventExtendedProps

describe('view mapping', () => {
  it('maps every standard view type to its FullCalendar view', () => {
    expect(fullCalendarViewName('day')).toBe('timeGridDay')
    expect(fullCalendarViewName('5day')).toBe('timeGrid5Day')
    expect(fullCalendarViewName('week')).toBe('timeGridWeek')
    expect(fullCalendarViewName('month')).toBe('dayGridMonth')
    expect(fullCalendarViewName('year')).toBe('multiMonthYear')
    expect(fullCalendarViewName('list')).toBe('listWeek')
  })

  it('maps the split view like its span', () => {
    const spans: [SplitSpan, string][] = [
      ['day', 'timeGridDay'],
      ['5day', 'timeGrid5Day'],
      ['week', 'timeGridWeek'],
      ['month', 'dayGridMonth'],
    ]
    for (const [span, view] of spans) expect(fullCalendarViewName('split', span)).toBe(view)
    expect(fullCalendarViewName('split')).toBe('timeGridWeek')
  })

  it('covers every view type of the switcher', () => {
    for (const type of VIEW_TYPES.filter((item) => item !== 'split')) {
      expect(FULLCALENDAR_VIEW_NAMES[type as Exclude<ViewType, 'split'>]).toBeTruthy()
    }
  })

  it('defines the five-day view as five calendar days', () => {
    const { views } = calendarLayoutOptions(false)
    expect(views?.timeGrid5Day).toMatchObject({ type: 'timeGrid', duration: { days: 5 } })
    // Same span as the shared state computes for the anchor date.
    const range = visibleRangeFor(
      rangeKindOf('5day', 'week'),
      Temporal.PlainDate.from('2026-10-28'),
    )
    expect(range.end.since(range.start).days).toBe(5)
  })

  it('keeps editing off and leaves the time zone to the setting', () => {
    expect(BASE_CALENDAR_OPTIONS).toMatchObject({
      editable: false,
      selectable: false,
      eventStartEditable: false,
      eventDurationEditable: false,
      firstDay: 1,
      headerToolbar: false,
    })
    // The organization time zone is a setting (FR-29): the component adds it from useTimeZone().
    expect(BASE_CALENDAR_OPTIONS).not.toHaveProperty('timeZone')
  })

  it('switches to panning day columns and fewer month columns on narrow containers', () => {
    expect(isCompactWidth(COMPACT_MAX_WIDTH - 1)).toBe(true)
    expect(isCompactWidth(COMPACT_MAX_WIDTH)).toBe(false)
    expect(isCompactWidth(360)).toBe(true)

    const narrow = calendarLayoutOptions(true).views!
    const wide = calendarLayoutOptions(false).views!
    expect(narrow.timeGridWeek).toHaveProperty('dayMinWidth')
    expect(narrow.timeGrid5Day).toHaveProperty('dayMinWidth')
    expect(wide.timeGridWeek).not.toHaveProperty('dayMinWidth')
    expect(narrow.multiMonthYear?.multiMonthMaxColumns).toBe(1)
    expect(wide.multiMonthYear?.multiMonthMaxColumns).toBe(3)
    expect(narrow.dayGridMonth?.displayEventTime).toBe(false)
    expect(wide.dayGridMonth?.displayEventTime).toBe(true)
    // timed entries of the month are filled strips, like all-day ones; the year keeps its dots
    expect(eventDisplayFor('month')).toBe('block')
    expect(eventDisplayFor('year')).toBe('auto')
    expect(eventDisplayFor('week')).toBe('auto')
    expect(narrow.timeGrid?.eventMaxStack).toBeLessThan(wide.timeGrid!.eventMaxStack!)
  })
})

describe('plainDateInCalendarZone', () => {
  it('reads FullCalendar dates in the organization time zone', () => {
    // Midnight in Berlin is 22:00 UTC the day before in summer (CEST) ...
    const berlin = (iso: string) => plainDateInCalendarZone(new Date(iso), 'Europe/Berlin')
    expect(berlin('2026-07-13T22:00:00Z').toString()).toBe('2026-07-14')
    // ... and 23:00 UTC in winter (CET); daylight saving time ended on 25 October 2026.
    expect(berlin('2026-10-27T23:00:00Z').toString()).toBe('2026-10-28')
    expect(berlin('2026-10-24T22:00:00Z').toString()).toBe('2026-10-25')
    expect(berlin('2026-10-28T12:00:00Z').toString()).toBe('2026-10-28')
  })

  it('follows the zone it is given, not a built-in one', () => {
    const instant = new Date('2026-10-29T22:30:00Z')
    expect(plainDateInCalendarZone(instant, 'Europe/Berlin').toString()).toBe('2026-10-29')
    expect(plainDateInCalendarZone(instant, 'Asia/Tokyo').toString()).toBe('2026-10-30')
    expect(plainDateInCalendarZone(instant, 'America/Los_Angeles').toString()).toBe('2026-10-29')
    expect(plainDateInCalendarZone(instant, 'UTC').toString()).toBe('2026-10-29')
  })
})

describe('colours', () => {
  it('parses short, long and alpha hex colours', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255])
    expect(parseHexColor('#1D4ED8')).toEqual([29, 78, 216])
    expect(parseHexColor('#1d4ed8cc')).toEqual([29, 78, 216])
    expect(parseHexColor('blue')).toBeNull()
    expect(parseHexColor('#12345')).toBeNull()
    expect(parseHexColor(undefined)).toBeNull()
  })

  it('computes WCAG contrast', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  it('mixes colours', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColors('#ff0000', '#0000ff', 1)).toBe('#ff0000')
    expect(mixColors('#ff0000', '#0000ff', 0)).toBe('#0000ff')
  })

  it('picks readable text for any background (4.5:1)', () => {
    expect(readableTextColor('#1d4ed8')).toBe('#ffffff')
    expect(readableTextColor('#facc15')).toBe('#000000')
    const steps = [0, 51, 102, 128, 153, 204, 255]
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const background = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
          expect(contrastRatio(background, readableTextColor(background))).toBeGreaterThanOrEqual(
            4.5,
          )
        }
      }
    }
  })

  it('keeps text readable on every calendar colour, kind and scheme', () => {
    const mock = createMockData()
    const palette = [...mock.calendars.map((item) => item.color), '#ffff00', '#00ffff', '#808080']
    for (const scheme of SCHEMES) {
      for (const kind of KINDS) {
        for (const color of palette) {
          const { color: fill, contrastColor } = eventColors(color, kind, scheme)
          expect(contrastRatio(fill, contrastColor)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('uses the calendar colour for confirmed events and falls back for invalid ones', () => {
    for (const scheme of SCHEMES) {
      expect(eventColors('#1d4ed8', 'confirmed', scheme).color).toBe('#1d4ed8')
      expect(eventColors(undefined, 'confirmed', scheme).color).toBe('#475569')
      expect(eventColors('not-a-colour', 'tentative', scheme).contrastColor).toMatch(/^#/)
    }
  })

  it('moves tentative and cancelled fills towards the page background of each scheme', () => {
    for (const scheme of SCHEMES) {
      const surface = SURFACES[scheme]
      const confirmed = eventColors('#1d4ed8', 'confirmed', scheme).color
      const tentative = eventColors('#1d4ed8', 'tentative', scheme).color
      const cancelled = eventColors('#1d4ed8', 'cancelled', scheme).color
      expect(contrastRatio(tentative, surface)).toBeLessThan(contrastRatio(confirmed, surface))
      expect(contrastRatio(cancelled, surface)).toBeLessThan(contrastRatio(tentative, surface))
    }
    // Lighter in the light scheme.
    expect(relativeLuminance(eventColors('#1d4ed8', 'tentative', 'light').color)).toBeGreaterThan(
      relativeLuminance('#1d4ed8'),
    )
  })

  it('draws blocked events in a neutral colour that differs per scheme', () => {
    const light = eventColors('#b91c1c', 'blocked', 'light')
    const dark = eventColors('#b91c1c', 'blocked', 'dark')
    expect(light.color).not.toBe('#b91c1c')
    expect(light.color).not.toBe(dark.color)
    expect(light.contrastColor).toBe('#ffffff')
    expect(dark.contrastColor).toBe('#000000')
  })
})

describe('event mapping', () => {
  it('maps a timed event', () => {
    const input = toFullCalendarEvent(makeEvent(), context())
    expect(input).toMatchObject({
      id: 'evt-1',
      title: 'Planning',
      start: '2026-10-28T09:00:00',
      end: '2026-10-28T10:00:00',
      allDay: false,
      color: '#047857',
      contrastColor: '#ffffff',
      className: 'app-evt app-evt-confirmed',
    })
    expect(extendedProps(input)).toMatchObject({
      eventId: 'evt-1',
      calendarId: 'cal-a',
      kind: 'confirmed',
    })
  })

  it('keeps the start and end of minute-precision strings in order', () => {
    const input = toFullCalendarEvent(
      makeEvent({ start: '2026-10-28T09:00', end: '2026-10-28T09:30' }),
      context(),
    )
    expect(input).toMatchObject({ start: '2026-10-28T09:00:00', end: '2026-10-28T09:30:00' })
  })

  it('leaves out an end that is not after the start', () => {
    const same = toFullCalendarEvent(makeEvent({ end: '2026-10-28T09:00:00' }), context())
    expect(same).not.toHaveProperty('end')
    const before = toFullCalendarEvent(makeEvent({ end: '2026-10-28T08:00:00' }), context())
    expect(before).not.toHaveProperty('end')
    // The same instant written with and without seconds is still "not after".
    const mixed = toFullCalendarEvent(
      makeEvent({ start: '2026-10-28T09:00:00', end: '2026-10-28T09:00' }),
      context(),
    )
    expect(mixed).not.toHaveProperty('end')
  })

  it('passes all-day events as dates with an exclusive end', () => {
    const multi = toFullCalendarEvent(
      makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-31' }),
      context(),
    )
    expect(multi).toMatchObject({ allDay: true, start: '2026-10-28', end: '2026-10-31' })

    const single = toFullCalendarEvent(
      makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-29' }),
      context(),
    )
    expect(single).toMatchObject({ start: '2026-10-28', end: '2026-10-29' })
  })

  it('drops the time part of all-day events and an empty or same-day end', () => {
    const withTime = toFullCalendarEvent(
      makeEvent({ allDay: true, start: '2026-10-28T00:00:00', end: '2026-10-29T00:00:00' }),
      context(),
    )
    expect(withTime).toMatchObject({ start: '2026-10-28', end: '2026-10-29' })

    const sameDay = toFullCalendarEvent(
      makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-28' }),
      context(),
    )
    expect(sameDay).not.toHaveProperty('end')
  })

  it('shows blocked events as Busy without details', () => {
    const input = toFullCalendarEvent(
      makeEvent({
        title: 'Salary talk',
        description: 'secret',
        location: 'Room 7',
        isBlocked: true,
      }),
      context(),
    )
    expect(input.title).toBe(BUSY_TITLE)
    expect(input.className).toBe('app-evt app-evt-blocked')
    const text = JSON.stringify(input)
    for (const secret of ['Salary talk', 'secret', 'Room 7', 'Team']) {
      expect(text).not.toContain(secret)
    }
    expect(extendedProps(input).kind).toBe('blocked')
  })

  it('names the calendar of busy times the viewer sees as "Busy times only", and keeps tentative ones dashed', () => {
    const busyOnly = calendar({ id: 'cal-b', name: 'Bob', freeBusyOnly: true, readOnly: true })
    const input = toFullCalendarEvent(
      makeEvent({ calendarId: 'cal-b', title: '', isBlocked: true, status: 'tentative' }),
      context('light', [calendar(), busyOnly]),
    )
    expect(input.className).toBe('app-evt app-evt-blocked app-evt-tentative')
    expect(extendedProps(input).label).toBe(
      'Busy, Wed, 28 Oct 2026, 09:00 to 10:00, Calendar Bob, tentative',
    )
    // a blocked entry of another calendar still names nothing
    const other = toFullCalendarEvent(makeEvent({ isBlocked: true }), context())
    expect(extendedProps(other).label).toBe('Busy, Wed, 28 Oct 2026, 09:00 to 10:00')
  })

  it('marks tentative and cancelled events', () => {
    const tentative = toFullCalendarEvent(makeEvent({ status: 'tentative' }), context())
    const cancelled = toFullCalendarEvent(makeEvent({ status: 'cancelled' }), context())
    expect(tentative.className).toBe('app-evt app-evt-tentative')
    expect(cancelled.className).toBe('app-evt app-evt-cancelled')
    expect(tentative.color).not.toBe('#047857')
    expect(cancelled.color).not.toBe(tentative.color)
    expect(eventKind(makeEvent({ status: 'cancelled', isBlocked: true }))).toBe('blocked')
  })

  it('follows the colour scheme', () => {
    const light = toFullCalendarEvent(makeEvent({ status: 'tentative' }), context('light'))
    const dark = toFullCalendarEvent(makeEvent({ status: 'tentative' }), context('dark'))
    expect(light.color).not.toBe(dark.color)
    expect(light.contrastColor).not.toBe(dark.contrastColor)
  })

  it('uses a neutral colour for an unknown calendar', () => {
    const input = toFullCalendarEvent(makeEvent({ calendarId: 'gone' }), context())
    expect(input.color).toBe('#475569')
  })

  it('builds the assistive label from title, time, calendar and status', () => {
    const input = toFullCalendarEvent(makeEvent({ status: 'tentative' }), context())
    expect(extendedProps(input).label).toBe(
      'Planning, Wed, 28 Oct 2026, 09:00 to 10:00, Calendar Team, tentative',
    )
  })

  it('maps every mock event without changing the count or ids', () => {
    const mock = createMockData()
    for (const scheme of SCHEMES) {
      const mapped = toFullCalendarEvents(mock.events, {
        calendarById: new Map(mock.calendars.map((item) => [item.id, item])),
        scheme,
      })
      expect(mapped.map((item) => item.id)).toEqual(mock.events.map((item) => item.id))
      for (const item of mapped) {
        expect(item.start).toMatch(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/)
        expect(extendedProps(item).label.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('quickAddPresetForClick', () => {
  it('gives a one-day all-day event for a date cell', () => {
    expect(quickAddPresetForClick('2026-10-28', true)).toEqual({
      start: '2026-10-28',
      end: '2026-10-29',
      allDay: true,
    })
    expect(quickAddPresetForClick('2026-12-31', true).end).toBe('2027-01-01')
  })

  it('gives a one-hour event at the clicked time slot, ignoring the offset', () => {
    expect(quickAddPresetForClick('2026-10-28T10:30:00+01:00', false)).toEqual({
      start: '2026-10-28T10:30',
      end: '2026-10-28T11:30',
      allDay: false,
    })
    expect(quickAddPresetForClick('2026-10-28T23:30:00', false).end).toBe('2026-10-29T00:30')
  })
})

describe('event text', () => {
  it('describes timed events on one day and across midnight', () => {
    expect(describeEventWhen(makeEvent())).toEqual({
      date: 'Wed, 28 Oct 2026',
      time: '09:00 – 10:00',
    })
    expect(
      describeEventWhen(makeEvent({ start: '2026-10-28T22:00:00', end: '2026-10-29T02:00:00' })),
    ).toEqual({ date: 'Wed, 28 Oct 2026', time: '22:00 – Thu, 29 Oct 2026, 02:00' })
    expect(
      describeEventWhen(makeEvent({ start: '2026-10-28T23:00:00', end: '2026-10-29T00:00:00' }))
        .time,
    ).toBe('23:00 – 24:00')
    expect(describeEventWhen(makeEvent({ end: '2026-10-28T09:00:00' })).time).toBe('09:00')
  })

  it('describes all-day events with an exclusive end', () => {
    expect(
      describeEventWhen(makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-29' })),
    ).toEqual({ date: 'Wed, 28 Oct 2026', time: 'All day' })
    expect(
      describeEventWhen(makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-31' })).date,
    ).toBe('Wed, 28 Oct 2026 – Fri, 30 Oct 2026')
    expect(
      describeEventWhen(makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-28' })).date,
    ).toBe('Wed, 28 Oct 2026')
  })

  it('words the range for assistive technology', () => {
    expect(
      eventAssistiveLabel(
        makeEvent({ allDay: true, start: '2026-10-28', end: '2026-10-30' }),
        'Team',
      ),
    ).toBe('Planning, Wed, 28 Oct 2026 to Thu, 29 Oct 2026, All day, Calendar Team')
    expect(eventAssistiveLabel(makeEvent({ isBlocked: true, title: 'Secret' }), 'Team')).toBe(
      'Busy, Wed, 28 Oct 2026, 09:00 to 10:00',
    )
    expect(eventAssistiveLabel(makeEvent({ status: 'cancelled' }), undefined)).toBe(
      'Planning, Wed, 28 Oct 2026, 09:00 to 10:00, cancelled',
    )
  })
})

describe('buildEventDetails', () => {
  const lookups = () => {
    const mock = createMockData()
    return {
      mock,
      lookups: {
        calendarById: new Map(mock.calendars.map((item) => [item.id, item])),
        categoryById: new Map(mock.categories.map((item) => [item.id, item])),
        resourceById: new Map(mock.resources.map((item) => [item.id, item])),
      },
    }
  }

  it('collects calendar, location, categories and status', () => {
    const { mock, lookups: maps } = lookups()
    const standup = mock.events.find((item) => item.id === 'evt-standup')!
    const details = buildEventDetails(standup, maps)
    expect(details).toMatchObject({
      title: 'Standup',
      blocked: false,
      location: 'Video call',
      status: 'confirmed',
      statusLabel: 'Confirmed',
      calendar: { name: 'Personal' },
    })
    expect(details.categories.map((item) => item.name)).toEqual(['Meeting'])
    expect(details.resource).toBeNull()
  })

  it('adds the organization time when the viewer is in another zone', () => {
    const { mock, lookups: maps } = lookups()
    // The mock times are read here as Sydney time: 03:00-04:00 on Thu 29 Oct is 17:00-18:00 on
    // Wed 28 Oct in Berlin.
    const event = { ...mock.events.find((item) => item.id === 'evt-standup')!, allDay: false }
    const sydney = { ...event, start: '2026-10-29T03:00:00', end: '2026-10-29T04:00:00' }
    const zones = { display: 'Australia/Sydney', org: 'Europe/Berlin' }
    expect(buildEventDetails(sydney, maps, zones).orgWhen).toEqual({
      date: 'Wed, 28 Oct 2026',
      time: '17:00 – 18:00',
    })
    expect(buildEventDetails(sydney, maps, zones).when.time).toBe('03:00 – 04:00')
  })

  it('has no organization time in the same zone, without zones or for all-day events', () => {
    const { mock, lookups: maps } = lookups()
    const timed = mock.events.find((item) => item.id === 'evt-standup')!
    const allDay = mock.events.find((item) => item.id === 'evt-coast')!
    const same = { display: 'Europe/Berlin', org: 'Europe/Berlin' }
    const other = { display: 'Australia/Sydney', org: 'Europe/Berlin' }
    expect(buildEventDetails(timed, maps, same).orgWhen).toBeNull()
    expect(buildEventDetails(timed, maps).orgWhen).toBeNull()
    expect(buildEventDetails(allDay, maps, other).orgWhen).toBeNull()
  })

  it('names the resource of a booking and the booking calendar', () => {
    const { mock, lookups: maps } = lookups()
    const booking = mock.events.find((item) => item.id === 'evt-room-a-booking')!
    const details = buildEventDetails(booking, maps)
    expect(details.resource).toMatchObject({ name: expect.any(String), type: 'room' })
    expect(details.bookedBy).toBe('Team')
  })

  it('reveals nothing but Busy and the time for blocked events', () => {
    const { mock, lookups: maps } = lookups()
    const blocked = mock.events.find((item) => item.id === 'evt-van-blocked')!
    const details = buildEventDetails(
      { ...blocked, title: 'Real title', description: 'Real text', location: 'Real place' },
      maps,
    )
    expect(details).toMatchObject({
      title: 'Busy',
      blocked: true,
      calendar: null,
      location: null,
      resource: null,
      bookedBy: null,
      description: null,
      categories: [],
      allDay: true,
      when: { time: 'All day' },
    })
    expect(JSON.stringify(details)).not.toMatch(/Real|Van|Sales/)
  })

  it('names the calendar of busy times the viewer sees as "Busy times only"', () => {
    const { lookups: maps } = lookups()
    const bob: Calendar = {
      id: 'dav:/caldav/u/shared-7/',
      name: 'Bob',
      type: 'caldav',
      color: '#16a34a',
      defaultVisible: true,
      readOnly: true,
      freeBusyOnly: true,
    }
    maps.calendarById.set(bob.id, bob)
    const details = buildEventDetails(
      makeEvent({ calendarId: bob.id, title: '', isBlocked: true }),
      maps,
    )
    expect(details).toMatchObject({
      title: 'Busy',
      blocked: true,
      calendar: { name: 'Bob', color: '#16a34a' },
      location: null,
      description: null,
    })
  })
})

describe('pickFocusTarget', () => {
  const element = (isConnected: boolean) => ({ isConnected })

  it('prefers the opener while it is in the document', () => {
    const opener = element(true)
    const fallback = element(true)
    expect(pickFocusTarget(opener, fallback)).toBe(opener)
  })

  it('falls back when the opener was re-rendered away', () => {
    const fallback = element(true)
    expect(pickFocusTarget(element(false), fallback)).toBe(fallback)
    expect(pickFocusTarget(null, fallback)).toBe(fallback)
  })

  it('returns null when nothing can take the focus', () => {
    expect(pickFocusTarget(element(false), element(false))).toBeNull()
    expect(pickFocusTarget(null, null)).toBeNull()
  })
})
