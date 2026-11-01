import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FullCalendar from '@fullcalendar/vue3'
import { Temporal } from 'temporal-polyfill'
import { createMockData } from '../app/data/mock'
import SplitTimeline from '../app/components/SplitTimeline.vue'
import {
  buildSplitBands,
  createCalendarState,
  SPLIT_SPANS,
  visibleRangeFor,
  type SplitSpan,
  type SplitBand,
  type StateFactory,
} from '../app/utils/calendar-state'
import {
  splitColorScheme,
  splitDayWindow,
  splitEventColors,
  splitLayoutFor,
  splitLayoutTier,
  splitTextColor,
  splitViewName,
  splitViews,
  timelineEventSrText,
  toTimelineData,
  toTimelineEvent,
  toTimelineResource,
  type SplitColorScheme,
} from '../app/utils/split-view'
import type { Calendar, CalendarEvent, EventStatus } from '../shared/types/calendar'

// A second, independent WCAG 2.x implementation: the tests must not reuse the code they check.
function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function luminanceOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(first: string, second: string): number {
  const [a, b] = [luminanceOf(first), luminanceOf(second)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
const hexOf = (red: number, green: number, blue: number) =>
  `#${[red, green, blue].map((part) => part.toString(16).padStart(2, '0')).join('')}`

const SCHEMES: SplitColorScheme[] = ['light', 'dark']
const STATUSES: EventStatus[] = ['confirmed', 'tentative', 'cancelled']
// The mock calendar colours plus the awkward ones: extremes, mid greys, yellow, pure hues.
const COLORS = [
  '#1d4ed8',
  '#047857',
  '#6d28d9',
  '#b45309',
  '#b91c1c',
  '#0f766e',
  '#9d174d',
  '#4d7c0f',
  '#0e7490',
  '#000000',
  '#ffffff',
  '#777777',
  '#767676',
  '#808080',
  '#fde047',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#3788d8',
  '#0891b2',
  '#f59e0b',
  '#fff',
]

const calendar: Calendar = {
  id: 'cal-a',
  name: 'Team A',
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    uid: 'e1',
    calendarId: 'cal-a',
    title: 'Planning',
    start: '2026-10-28T10:00:00',
    end: '2026-10-28T11:00:00',
    allDay: false,
    status: 'confirmed',
    categoryIds: [],
    ...overrides,
  }
}

const day = (value: string) => Temporal.PlainDate.from(value)

describe('colour scheme', () => {
  it('follows Nuxt colour mode and treats anything but dark as light', () => {
    expect(splitColorScheme('dark')).toBe('dark')
    expect(splitColorScheme('light')).toBe('light')
    expect(splitColorScheme('system')).toBe('light')
    expect(splitColorScheme(undefined)).toBe('light')
  })
})

describe('text colour', () => {
  it('picks white on dark and a dark colour on light backgrounds', () => {
    expect(splitTextColor('#1d4ed8')).toBe('#ffffff')
    expect(splitTextColor('#000000')).toBe('#ffffff')
    expect(splitTextColor('#fde047')).not.toBe('#ffffff')
    expect(splitTextColor('#ffffff')).not.toBe('#ffffff')
  })

  it('reaches the WCAG AA ratio of 4.5 on every grey level', () => {
    for (let level = 0; level <= 255; level++) {
      const background = hexOf(level, level, level)
      expect(contrast(background, splitTextColor(background)), background).toBeGreaterThanOrEqual(
        4.5,
      )
    }
  })

  it('reaches 4.5 on a sweep of the colour cube', () => {
    for (let red = 0; red <= 255; red += 51) {
      for (let green = 0; green <= 255; green += 51) {
        for (let blue = 0; blue <= 255; blue += 51) {
          const background = hexOf(red, green, blue)
          expect(
            contrast(background, splitTextColor(background)),
            background,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('falls back to white for a colour it cannot parse', () => {
    expect(splitTextColor('var(--fc-classic-event)')).toBe('#ffffff')
  })
})

describe('event colours', () => {
  it.each(SCHEMES)('keeps text readable for every status and colour (%s scheme)', (scheme) => {
    for (const color of COLORS) {
      const expanded =
        color.length === 4 ? `#${[...color.slice(1)].map((d) => d + d).join('')}` : color
      for (const status of STATUSES) {
        const colors = splitEventColors(expanded, status, scheme)
        expect(
          contrast(colors.color, colors.contrastColor),
          `${color} ${status}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('uses the calendar colour for confirmed and cancelled events in both schemes', () => {
    for (const scheme of SCHEMES) {
      expect(splitEventColors('#1d4ed8', 'confirmed', scheme).color).toBe('#1d4ed8')
      expect(splitEventColors('#1d4ed8', 'cancelled', scheme).color).toBe('#1d4ed8')
    }
  })

  it('tints tentative events towards the page background of the scheme', () => {
    const light = splitEventColors('#1d4ed8', 'tentative', 'light')
    const dark = splitEventColors('#1d4ed8', 'tentative', 'dark')
    expect(luminanceOf(light.color)).toBeGreaterThan(luminanceOf('#1d4ed8'))
    expect(luminanceOf(dark.color)).toBeLessThan(luminanceOf('#1d4ed8'))
    expect(light.color).toBe('#c0cdf4')
    expect(dark.color).toBe('#0f276b')
    expect(light.contrastColor).not.toBe(dark.contrastColor)
  })

  it('leaves a colour it cannot parse unchanged', () => {
    expect(splitEventColors('tomato', 'tentative', 'light').color).toBe('tomato')
  })
})

describe('timeline resources and events', () => {
  it('uses the calendar as the resource and carries its colour and position', () => {
    expect(toTimelineResource(calendar, 2)).toEqual({
      id: 'cal-a',
      title: 'Team A',
      extendedProps: { color: '#1d4ed8', sortIndex: 3 },
    })
  })

  it('maps a timed event to the calendar row', () => {
    expect(toTimelineEvent(event(), calendar, 'light')).toEqual({
      id: 'e1',
      resourceId: 'cal-a',
      title: 'Planning',
      start: '2026-10-28T10:00:00',
      end: '2026-10-28T11:00:00',
      allDay: false,
      color: '#1d4ed8',
      contrastColor: '#ffffff',
      class: 'split-event',
      extendedProps: { status: 'confirmed', blocked: false, calendarName: 'Team A' },
    })
  })

  it('keeps all-day events all-day with their exclusive end date', () => {
    const mapped = toTimelineEvent(
      event({ allDay: true, start: '2026-10-28', end: '2026-10-30' }),
      calendar,
      'light',
    )
    expect(mapped).toMatchObject({ allDay: true, start: '2026-10-28', end: '2026-10-30' })
  })

  it('shows blocked events as Busy without any details', () => {
    const mapped = toTimelineEvent(
      event({
        title: 'Salary talk with Sam',
        description: 'Confidential',
        location: 'Room 4',
        isBlocked: true,
      }),
      calendar,
      'light',
    )
    expect(mapped.title).toBe('Busy')
    expect(mapped.class).toContain('split-event--busy')
    expect(mapped.extendedProps.blocked).toBe(true)
    expect(JSON.stringify(mapped)).not.toMatch(/Salary|Confidential|Room 4/)
  })

  it('marks cancelled events for strike-through and tentative ones with a lighter fill', () => {
    const cancelled = toTimelineEvent(event({ status: 'cancelled' }), calendar, 'light')
    expect(cancelled.class).toBe('split-event split-event--cancelled')
    expect(cancelled.color).toBe('#1d4ed8')

    const tentative = toTimelineEvent(event({ status: 'tentative' }), calendar, 'light')
    expect(tentative.class).toBe('split-event split-event--tentative')
    expect(luminanceOf(tentative.color)).toBeGreaterThan(luminanceOf(calendar.color))
  })

  it('re-colours events for the scheme', () => {
    const light = toTimelineEvent(event({ status: 'tentative' }), calendar, 'light')
    const dark = toTimelineEvent(event({ status: 'tentative' }), calendar, 'dark')
    expect(light.color).not.toBe(dark.color)
  })

  it('describes calendar and status for screen readers', () => {
    expect(
      timelineEventSrText({ status: 'confirmed', blocked: false, calendarName: 'Team A' }),
    ).toBe('Team A')
    expect(
      timelineEventSrText({ status: 'cancelled', blocked: false, calendarName: 'Team A' }),
    ).toBe('Team A, cancelled')
    expect(
      timelineEventSrText({ status: 'tentative', blocked: true, calendarName: 'Team A' }),
    ).toBe('Team A, tentative, details hidden')
  })

  it('builds rows and events from bands in band order', () => {
    const second: Calendar = { ...calendar, id: 'cal-b', name: 'Team B', color: '#b91c1c' }
    const bands: SplitBand[] = [
      { calendar, events: [event({ id: 'a1' }), event({ id: 'a2' })] },
      { calendar: second, events: [event({ id: 'b1', calendarId: 'cal-b' })] },
    ]
    const data = toTimelineData(bands, 'light')
    expect(
      data.resources.map((resource) => [resource.id, resource.extendedProps.sortIndex]),
    ).toEqual([
      ['cal-a', 1],
      ['cal-b', 2],
    ])
    expect(data.events.map((item) => [item.id, item.resourceId])).toEqual([
      ['a1', 'cal-a'],
      ['a2', 'cal-a'],
      ['b1', 'cal-b'],
    ])
  })

  it('has no rows and no events without bands', () => {
    expect(toTimelineData([], 'light')).toEqual({ resources: [], events: [] })
  })
})

describe('views', () => {
  it('maps every split span to its timeline view', () => {
    expect(splitViewName('day')).toBe('resourceTimelineDay')
    expect(splitViewName('5day')).toBe('resourceTimeline5Day')
    expect(splitViewName('week')).toBe('resourceTimelineWeek')
    expect(splitViewName('month')).toBe('resourceTimelineMonth')
    expect(new Set(SPLIT_SPANS.map(splitViewName)).size).toBe(SPLIT_SPANS.length)
  })

  it('defines the five-day view and sizes each view', () => {
    const views = splitViews('desktop', { slotMinTime: '07:00:00', slotMaxTime: '19:00:00' })
    expect(Object.keys(views).sort()).toEqual(SPLIT_SPANS.map(splitViewName).sort())
    expect(views.resourceTimeline5Day).toMatchObject({
      type: 'resourceTimeline',
      duration: { days: 5 },
      slotDuration: { days: 1 },
    })
    expect(views.resourceTimelineDay).toMatchObject({
      slotDuration: { hours: 1 },
      slotMinTime: '07:00:00',
      slotMaxTime: '19:00:00',
      // Hours read 07:00, as in the standard views.
      slotHeaderFormat: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    })
    for (const name of ['resourceTimeline5Day', 'resourceTimelineWeek', 'resourceTimelineMonth']) {
      expect(views[name]).not.toHaveProperty('slotMinTime')
      // The headers of whole days keep FullCalendar's day labels: an hour format would print 00:00.
      expect(views[name]).not.toHaveProperty('slotHeaderFormat')
    }
    for (const name of ['resourceTimelineWeek', 'resourceTimelineMonth']) {
      expect(views[name]).toMatchObject({ slotDuration: { days: 1 } })
    }
    expect(views.resourceTimelineWeek).not.toHaveProperty('type')
  })
})

describe('responsive layout', () => {
  it('splits the viewport width into phone, compact and desktop', () => {
    expect([320, 360, 479].map(splitLayoutTier)).toEqual(['phone', 'phone', 'phone'])
    expect([480, 640, 767].map(splitLayoutTier)).toEqual(['compact', 'compact', 'compact'])
    expect([768, 1024, 1280, 1920].map(splitLayoutTier)).toEqual([
      'desktop',
      'desktop',
      'desktop',
      'desktop',
    ])
  })

  it('uses 90 to 120 px day slots and a 90 to 100 px label column on a 360 px phone', () => {
    for (const span of ['5day', 'week'] as const) {
      const layout = splitLayoutFor(360, span)
      expect(layout.slotMinWidth).toBeGreaterThanOrEqual(90)
      expect(layout.slotMinWidth).toBeLessThanOrEqual(120)
      expect(layout.resourceColumnsWidth).toBeGreaterThanOrEqual(90)
      expect(layout.resourceColumnsWidth).toBeLessThanOrEqual(100)
    }
  })

  it('uses narrower slots and a 100 px label column in landscape (640 px)', () => {
    const layout = splitLayoutFor(640, 'week')
    expect(layout).toMatchObject({ tier: 'compact', slotMinWidth: 64, resourceColumnsWidth: 100 })
  })

  it('gives the desktop a wider label column than a phone', () => {
    expect(splitLayoutFor(1280, 'week').resourceColumnsWidth).toBeGreaterThan(
      splitLayoutFor(360, 'week').resourceColumnsWidth,
    )
  })

  it('uses hourly slots for the day span and daily slots for the others', () => {
    for (const width of [360, 640, 1280]) {
      expect(splitLayoutFor(width, 'day').slotDuration).toEqual({ hours: 1 })
      for (const span of ['5day', 'week', 'month'] as const) {
        expect(splitLayoutFor(width, span).slotDuration).toEqual({ days: 1 })
      }
    }
  })

  it('keeps the month narrower per slot than the week', () => {
    for (const width of [360, 640, 1280]) {
      expect(splitLayoutFor(width, 'month').slotMinWidth).toBeLessThan(
        splitLayoutFor(width, 'week').slotMinWidth,
      )
    }
  })

  it('returns the same object inside a width tier, so resizing does not churn options', () => {
    expect(splitLayoutFor(361, 'week')).toBe(splitLayoutFor(479, 'week'))
    expect(splitLayoutFor(768, 'week')).toBe(splitLayoutFor(1920, 'week'))
    expect(splitLayoutFor(479, 'week')).not.toBe(splitLayoutFor(480, 'week'))
  })
})

describe('day window', () => {
  const window = (events: CalendarEvent[]) => splitDayWindow(events, day('2026-10-28'))

  it('shows 07:00 to 19:00 for no events and for all-day events', () => {
    const expected = { slotMinTime: '07:00:00', slotMaxTime: '19:00:00' }
    expect(window([])).toEqual(expected)
    expect(window([event({ allDay: true, start: '2026-10-28', end: '2026-10-29' })])).toEqual(
      expected,
    )
    expect(window([event({ start: '2026-10-28T09:00:00', end: '2026-10-28T10:00:00' })])).toEqual(
      expected,
    )
  })

  it('widens to whole hours that cover early and late events', () => {
    expect(window([event({ start: '2026-10-28T06:30:00', end: '2026-10-28T07:30:00' })])).toEqual({
      slotMinTime: '06:00:00',
      slotMaxTime: '19:00:00',
    })
    expect(window([event({ start: '2026-10-28T20:00:00', end: '2026-10-28T22:15:00' })])).toEqual({
      slotMinTime: '07:00:00',
      slotMaxTime: '23:00:00',
    })
  })

  it('clips events that cross midnight to the day', () => {
    expect(window([event({ start: '2026-10-27T22:00:00', end: '2026-10-28T08:00:00' })])).toEqual({
      slotMinTime: '00:00:00',
      slotMaxTime: '19:00:00',
    })
    expect(window([event({ start: '2026-10-28T21:00:00', end: '2026-10-29T02:00:00' })])).toEqual({
      slotMinTime: '07:00:00',
      slotMaxTime: '24:00:00',
    })
  })

  it('ignores events that do not reach into the day', () => {
    expect(window([event({ start: '2026-10-27T01:00:00', end: '2026-10-28T00:00:00' })])).toEqual({
      slotMinTime: '07:00:00',
      slotMaxTime: '19:00:00',
    })
    expect(window([event({ start: '2026-10-29T01:00:00', end: '2026-10-29T02:00:00' })])).toEqual({
      slotMinTime: '07:00:00',
      slotMaxTime: '19:00:00',
    })
  })

  it('covers the mock data: the late deploy window shows on its day', () => {
    const data = createMockData(day('2026-10-28'))
    const deploy = data.events.find((item) => item.id === 'evt-deploy')!
    const deployDay = day(deploy.start.slice(0, 10))
    expect(splitDayWindow([deploy], deployDay).slotMaxTime).toBe('22:00:00')
  })
})

describe('split state wiring', () => {
  function memoryState(): StateFactory {
    const store = new Map<string, Ref<unknown>>()
    return <T>(key: string, init: () => T) => {
      if (!store.has(key)) store.set(key, ref(init()))
      return store.get(key) as Ref<T>
    }
  }

  // 2026-10-28 is a Wednesday.
  const anchor = day('2026-10-28')
  const makeStore = () => {
    const state = createCalendarState(memoryState(), {
      seed: () => createMockData(anchor),
      today: () => anchor,
      sidebarOpen: () => true,
    })
    state.viewType.value = 'split'
    return state
  }

  it('gives every non-empty calendar a row and hides the empty ones', () => {
    const state = makeStore()
    state.selectView('view-everything')
    const bands = state.splitBands.value
    const { resources, events } = toTimelineData(bands, 'light')

    expect(resources.map((resource) => resource.id)).toEqual(bands.map((band) => band.calendar.id))
    expect(resources.map((resource) => resource.id)).not.toContain('cal-office')
    expect(resources.map((resource) => resource.id)).not.toContain('cal-marketing')
    const rowIds = new Set(resources.map((resource) => resource.id))
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((item) => rowIds.has(item.resourceId))).toBe(true)
  })

  it('follows the period: a narrower span drops the rows it empties', () => {
    const state = makeStore()
    state.selectView('view-everything')
    state.splitSpan.value = 'week'
    const weekRows = toTimelineData(state.splitBands.value, 'light').resources.length

    state.splitSpan.value = 'day'
    const dayRows = toTimelineData(state.splitBands.value, 'light').resources.length
    expect(dayRows).toBeLessThan(weekRows)
    expect(dayRows).toBeGreaterThan(0)
  })

  it('has no rows when nothing is visible, which the view shows as its empty state', () => {
    const state = makeStore()
    for (const id of [...state.visibleCalendarIds.value]) state.setCalendarVisible(id, false)
    expect(toTimelineData(state.splitBands.value, 'light')).toEqual({ resources: [], events: [] })
  })
})

// The real FullCalendar resource timeline, mounted in happy-dom (no layout, but all option
// handling, rendering and the slots run).
describe('SplitTimeline', () => {
  const monday = day('2026-10-26')
  const data = createMockData(day('2026-10-28'))
  const calendars = data.calendars.filter((item) => item.defaultVisible)
  const bandsFor = (anchor: string, span: SplitSpan) =>
    buildSplitBands(calendars, data.events, visibleRangeFor(span, day(anchor)))

  const mounted: VueWrapper[] = []
  function mountTimeline(anchor: string, span: SplitSpan, scheme: SplitColorScheme = 'light') {
    const wrapper = mount(SplitTimeline, {
      props: {
        bands: bandsFor(anchor, span),
        date: anchor,
        span,
        scheme,
        timeZone: 'Europe/Berlin',
      },
      attachTo: document.body,
    })
    mounted.push(wrapper)
    return wrapper
  }
  afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

  const view = (wrapper: VueWrapper) => wrapper.findComponent(FullCalendar).vm.getApi().view
  // The calendar runs in the organization time zone, whatever the zone of the machine.
  const ymd = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date)

  it('renders one labelled row per band in band order, with the events in their rows', async () => {
    const wrapper = mountTimeline(monday.toString(), 'week')
    await flushPromises()

    const bands = bandsFor(monday.toString(), 'week')
    const rows = wrapper.findAll('[role="rowheader"]')
    expect(rows.map((row) => row.attributes('data-resource-id'))).toEqual(
      bands.map((band) => band.calendar.id),
    )
    expect(rows.map((row) => row.text())).toEqual(bands.map((band) => band.calendar.name))
    expect(wrapper.findAll('.split-event')).toHaveLength(
      bands.reduce((count, band) => count + band.events.length, 0),
    )
  })

  it('shows blocked, cancelled and tentative events as such, with a screen reader note', async () => {
    const wrapper = mountTimeline('2026-10-29', 'day')
    await flushPromises()

    const text = wrapper.findAll('.split-event').map((item) => item.text())
    expect(text).toContain('Vendor demo, Team, cancelled')
    expect(text).toContain('1:1 with Sam, Team, tentative')
    expect(text).toContain('Busy, Van, details hidden')
    expect(wrapper.find('.split-event--cancelled .split-event__title').text()).toBe('Vendor demo')
  })

  it('opens an event by click and by keyboard', async () => {
    const wrapper = mountTimeline('2026-10-29', 'day')
    await flushPromises()

    const first = wrapper.find('.split-event')
    await first.trigger('click')
    await first.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')).toEqual([['evt-offsite'], ['evt-offsite']])
  })

  it('applies the colour scheme to the calendar and follows a change', async () => {
    const wrapper = mountTimeline(monday.toString(), 'week', 'dark')
    await flushPromises()
    expect(wrapper.find('[data-color-scheme]').attributes('data-color-scheme')).toBe('dark')

    await wrapper.setProps({ scheme: 'light' })
    await vi.waitFor(() =>
      expect(wrapper.find('[data-color-scheme]').attributes('data-color-scheme')).toBe('light'),
    )
  })

  it('stays on the range of the state for every span, date and switch', async () => {
    const wrapper = mountTimeline('2026-10-28', 'week')
    await flushPromises()

    // Includes the turn of the year and a Sunday, where week and month start on other days.
    for (const anchor of ['2026-10-28', '2026-11-04', '2026-12-31', '2027-01-03']) {
      for (const span of ['day', '5day', 'week', 'month', 'week', '5day'] as const) {
        const range = visibleRangeFor(span, day(anchor))
        await wrapper.setProps({ bands: bandsFor(anchor, span), date: anchor, span })
        await vi.waitFor(() => {
          expect(view(wrapper).type).toBe(splitViewName(span))
          expect([ymd(view(wrapper).activeStart), ymd(view(wrapper).activeEnd)]).toEqual([
            range.start.toString(),
            range.end.toString(),
          ])
        })
      }
    }
  })

  it('shows the hours of a late event in the day view', async () => {
    const wrapper = mountTimeline('2026-10-29', 'day')
    await flushPromises()
    // The Thursday has a deploy window from 20:00 to 22:00; the default would end at 19:00.
    // The hour labels read 19:00 20:00 21:00 and end at 21:00, the last slot before 22:00.
    expect(wrapper.text()).toMatch(/20:0021:00(?!\d)/)
    expect(wrapper.text()).not.toContain('20:0021:0022:00')
  })
})
