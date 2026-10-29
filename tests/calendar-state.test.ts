import { describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { createMockData } from '../app/data/mock'
import {
  buildSplitBands,
  createCalendarEvent,
  createCalendarState,
  createCategory,
  createTextFilter,
  eventOverlapsRange,
  filterCalendarEvents,
  formatRangeLabel,
  rangeKindOf,
  stepAnchorDate,
  VIEW_TYPES,
  VIEW_TYPE_LABELS,
  visibleRangeFor,
  withIdPresent,
  type StateFactory,
} from '../app/utils/calendar-state'
import type { CalendarEvent } from '../shared/types/calendar'

const date = (value: string) => Temporal.PlainDate.from(value)
const range = (start: string, end: string) => ({ start: date(start), end: date(end) })
const text = (value: Temporal.PlainDate) => value.toString()

// 2026-10-28 is a Wednesday; its week runs from Monday 2026-10-26.
const anchor = date('2026-10-28')

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

function makeStore(state: StateFactory = memoryState(), sidebarOpen = true) {
  return createCalendarState(state, {
    seed: () => createMockData(anchor),
    today: () => anchor,
    sidebarOpen: () => sidebarOpen,
  })
}

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e',
    uid: 'e',
    calendarId: 'cal-a',
    title: 'Event',
    start: '2026-10-28T10:00:00',
    end: '2026-10-28T11:00:00',
    allDay: false,
    status: 'confirmed',
    categoryIds: [],
    ...overrides,
  }
}

describe('view types', () => {
  it('labels every view type', () => {
    expect(VIEW_TYPES.map((type) => VIEW_TYPE_LABELS[type])).toEqual([
      'Day',
      '5 days',
      'Week',
      'Month',
      'Year',
      'Split',
      'List',
    ])
  })
})

describe('visible range', () => {
  it('covers the day, five days, the Monday-based week, month and year', () => {
    expect(visibleRangeFor('day', anchor)).toEqual(range('2026-10-28', '2026-10-29'))
    expect(visibleRangeFor('5day', anchor)).toEqual(range('2026-10-28', '2026-11-02'))
    expect(visibleRangeFor('week', anchor)).toEqual(range('2026-10-26', '2026-11-02'))
    expect(visibleRangeFor('month', anchor)).toEqual(range('2026-10-01', '2026-11-01'))
    expect(visibleRangeFor('year', anchor)).toEqual(range('2026-01-01', '2027-01-01'))
  })

  it('starts the week on Monday for a Monday and a Sunday', () => {
    expect(visibleRangeFor('week', date('2026-10-26')).start).toEqual(date('2026-10-26'))
    expect(visibleRangeFor('week', date('2026-11-01')).start).toEqual(date('2026-10-26'))
  })

  it('maps list to a week and split to its span', () => {
    expect(rangeKindOf('list', 'month')).toBe('week')
    expect(rangeKindOf('split', 'day')).toBe('day')
    expect(rangeKindOf('split', 'week')).toBe('week')
    expect(rangeKindOf('year', 'week')).toBe('year')
    expect(rangeKindOf('5day', 'week')).toBe('5day')
  })
})

describe('stepping', () => {
  it('moves by one period of the kind', () => {
    expect(text(stepAnchorDate('day', anchor, 1))).toBe('2026-10-29')
    expect(text(stepAnchorDate('day', anchor, -1))).toBe('2026-10-27')
    expect(text(stepAnchorDate('5day', anchor, 1))).toBe('2026-11-02')
    expect(text(stepAnchorDate('5day', anchor, -1))).toBe('2026-10-23')
    expect(text(stepAnchorDate('week', anchor, 1))).toBe('2026-11-04')
    expect(text(stepAnchorDate('week', anchor, -1))).toBe('2026-10-21')
    expect(text(stepAnchorDate('month', anchor, 1))).toBe('2026-11-28')
    expect(text(stepAnchorDate('month', anchor, -1))).toBe('2026-09-28')
    expect(text(stepAnchorDate('year', anchor, 1))).toBe('2027-10-28')
    expect(text(stepAnchorDate('year', anchor, -1))).toBe('2025-10-28')
  })

  it('clamps the day when the target month is shorter', () => {
    expect(text(stepAnchorDate('month', date('2026-01-31'), 1))).toBe('2026-02-28')
    expect(text(stepAnchorDate('year', date('2028-02-29'), 1))).toBe('2029-02-28')
  })

  it('crosses year boundaries', () => {
    expect(text(stepAnchorDate('month', date('2026-12-15'), 1))).toBe('2027-01-15')
    expect(text(stepAnchorDate('week', date('2026-12-30'), 1))).toBe('2027-01-06')
  })
})

describe('range label', () => {
  const label = (kind: Parameters<typeof formatRangeLabel>[0], value: string) =>
    formatRangeLabel(kind, visibleRangeFor(kind, date(value)))

  it('names the day, week, month and year', () => {
    expect(label('day', '2026-10-28')).toBe('Wed, 28 Oct 2026')
    expect(label('week', '2026-10-28')).toBe('26 Oct – 1 Nov 2026')
    expect(label('month', '2026-10-28')).toBe('October 2026')
    expect(label('year', '2026-10-28')).toBe('2026')
  })

  it('shortens a range inside one month and spells out a range across years', () => {
    expect(label('5day', '2026-10-12')).toBe('12 – 16 Oct 2026')
    expect(label('week', '2026-12-30')).toBe('28 Dec 2026 – 3 Jan 2027')
  })
})

describe('event overlap', () => {
  const week = range('2026-10-26', '2026-11-02')

  it('includes timed events inside the range and excludes the ones that only touch it', () => {
    expect(eventOverlapsRange(event({}), week)).toBe(true)
    expect(
      eventOverlapsRange(event({ start: '2026-10-25T22:00:00', end: '2026-10-26T00:00:00' }), week),
    ).toBe(false)
    expect(
      eventOverlapsRange(event({ start: '2026-11-02T00:00:00', end: '2026-11-02T01:00:00' }), week),
    ).toBe(false)
    expect(
      eventOverlapsRange(event({ start: '2026-10-25T23:00:00', end: '2026-10-26T00:30:00' }), week),
    ).toBe(true)
  })

  it('treats all-day ends as exclusive', () => {
    const allDay = { allDay: true }
    expect(
      eventOverlapsRange(event({ ...allDay, start: '2026-10-24', end: '2026-10-26' }), week),
    ).toBe(false)
    expect(
      eventOverlapsRange(event({ ...allDay, start: '2026-10-24', end: '2026-10-27' }), week),
    ).toBe(true)
    expect(
      eventOverlapsRange(event({ ...allDay, start: '2026-11-02', end: '2026-11-03' }), week),
    ).toBe(false)
    expect(
      eventOverlapsRange(event({ ...allDay, start: '2026-11-01', end: '2026-11-02' }), week),
    ).toBe(true)
  })

  it('counts a zero-length event as a point', () => {
    expect(
      eventOverlapsRange(event({ start: '2026-10-28T10:00:00', end: '2026-10-28T10:00:00' }), week),
    ).toBe(true)
    expect(
      eventOverlapsRange(event({ start: '2026-11-02T00:00:00', end: '2026-11-02T00:00:00' }), week),
    ).toBe(false)
  })

  it('accepts times without seconds', () => {
    expect(
      eventOverlapsRange(event({ start: '2026-10-28T10:00', end: '2026-10-28T11:00' }), week),
    ).toBe(true)
  })
})

describe('event filtering', () => {
  const events = createMockData(anchor).events
  const all = new Set(createMockData(anchor).calendars.map((calendar) => calendar.id))
  const ids = (list: CalendarEvent[]) => list.map((item) => item.id)
  const criteria = { visibleCalendarIds: all, filters: [], categoryIds: [] }

  it('keeps everything without restrictions', () => {
    expect(filterCalendarEvents(events, criteria)).toHaveLength(events.length)
  })

  it('drops events of calendars that are not visible', () => {
    const result = filterCalendarEvents(events, {
      ...criteria,
      visibleCalendarIds: new Set(['cal-team']),
    })
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((item) => item.calendarId === 'cal-team')).toBe(true)
  })

  it('keeps events with any selected category', () => {
    const result = filterCalendarEvents(events, {
      ...criteria,
      categoryIds: ['cat-focus', 'cat-travel'],
    })
    expect(ids(result).sort()).toEqual(['evt-coast', 'evt-focus', 'evt-offsite'])
  })

  it('applies category, text and status filters', () => {
    const filters = createMockData(anchor).filters
    const only = (id: string) => filters.filter((filter) => filter.id === id)

    expect(
      filterCalendarEvents(events, { ...criteria, filters: only('filter-work') }).every((item) =>
        item.categoryIds.includes('cat-work'),
      ),
    ).toBe(true)
    expect(
      ids(filterCalendarEvents(events, { ...criteria, filters: only('filter-offsite') })),
    ).toEqual(['evt-offsite'])
    const visible = filterCalendarEvents(events, {
      ...criteria,
      filters: only('filter-hide-cancelled'),
    })
    expect(ids(visible)).not.toContain('evt-vendor-demo')
    expect(visible).toHaveLength(events.length - 1)
  })

  it('matches text in location and description, ignoring case', () => {
    const filter = (value: string) => [{ id: 'f', name: value, kind: 'text' as const, value }]
    expect(ids(filterCalendarEvents(events, { ...criteria, filters: filter('LAKESIDE') }))).toEqual(
      ['evt-offsite'],
    )
    expect(ids(filterCalendarEvents(events, { ...criteria, filters: filter('two-week') }))).toEqual(
      ['evt-sprint-planning'],
    )
  })

  it('combines filters of one kind with OR and different kinds with AND', () => {
    const filters = [
      { id: 'a', name: 'Focus', kind: 'category' as const, value: 'cat-focus' },
      { id: 'b', name: 'Personal', kind: 'category' as const, value: 'cat-personal' },
    ]
    expect(ids(filterCalendarEvents(events, { ...criteria, filters })).sort()).toEqual([
      'evt-coast',
      'evt-dentist',
      'evt-focus',
    ])

    const withText = [...filters, { id: 'c', name: 'Trip', kind: 'text' as const, value: 'trip' }]
    expect(ids(filterCalendarEvents(events, { ...criteria, filters: withText }))).toEqual([
      'evt-coast',
    ])
  })
})

describe('split bands', () => {
  const data = createMockData(anchor)
  const week = range('2026-10-26', '2026-11-02')
  const bandIds = (calendarIds: string[], span = week) =>
    buildSplitBands(
      data.calendars,
      data.events.filter((item) => calendarIds.includes(item.calendarId)),
      span,
    ).map((band) => band.calendar.id)

  it('creates a band for every calendar with an event in the range, in calendar order', () => {
    expect(bandIds(data.calendars.map((calendar) => calendar.id))).toEqual([
      'cal-personal',
      'cal-team',
      'cal-engineering',
      'cal-holidays',
      'cal-room-a',
      'cal-van',
    ])
  })

  it('omits calendars whose events are all outside the range', () => {
    expect(bandIds(['cal-sales', 'cal-office'])).toEqual([])
    expect(bandIds(['cal-sales'], range('2026-11-16', '2026-11-23'))).toEqual(['cal-sales'])
  })

  it('sorts the events of a band by start', () => {
    const [team] = buildSplitBands(
      data.calendars,
      data.events.filter((item) => item.calendarId === 'cal-team'),
      week,
    )
    const starts = team!.events.map((item) => item.start)
    expect(starts).toEqual([...starts].sort())
  })
})

describe('creation helpers', () => {
  it('creates events with unique ids and defaults', () => {
    const first = createCalendarEvent(
      {
        title: '  Lunch ',
        calendarId: 'cal-team',
        start: '2026-10-28T12:00',
        end: '2026-10-28T13:00',
      },
      [],
    )
    expect(first).toMatchObject({
      id: 'evt-new',
      uid: 'evt-new',
      title: 'Lunch',
      allDay: false,
      status: 'confirmed',
      categoryIds: [],
    })
    expect(first).not.toHaveProperty('description')

    const second = createCalendarEvent(
      { title: '', calendarId: 'cal-team', start: '2026-10-28', end: '2026-10-29', allDay: true },
      [first],
    )
    expect(second.id).toBe('evt-new-2')
    expect(second.title).toBe('Untitled event')
    expect(second.allDay).toBe(true)
  })

  it('creates categories and rejects empty or duplicate names', () => {
    const existing = createMockData(anchor).categories
    const created = createCategory(' Product launch ', existing)

    expect(created).toMatchObject({ id: 'cat-product-launch', name: 'Product launch' })
    expect(created?.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(createCategory('   ', existing)).toBeNull()
    expect(createCategory('work', existing)).toBeNull()
  })

  it('creates text filters and rejects empty or duplicate names', () => {
    const existing = createMockData(anchor).filters

    expect(createTextFilter('Lunch', existing)).toMatchObject({
      id: 'filter-lunch',
      name: 'Lunch',
      kind: 'text',
      value: 'Lunch',
    })
    expect(createTextFilter('', existing)).toBeNull()
    expect(createTextFilter('offsite', existing)).toBeNull()
  })

  it('adds and removes ids without duplicates', () => {
    expect(withIdPresent(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(withIdPresent(['a', 'b'], 'b', true)).toEqual(['a', 'b'])
    expect(withIdPresent(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(withIdPresent(['a'], 'x', false)).toEqual(['a'])
  })
})

describe('calendar state', () => {
  it('starts on the current week with the default calendars', () => {
    const state = makeStore()

    expect(state.viewType.value).toBe('week')
    expect(text(state.anchorDate.value)).toBe('2026-10-28')
    expect(state.rangeLabel.value).toBe('26 Oct – 1 Nov 2026')
    expect(state.selectedViewId.value).toBeNull()
    expect([...state.visibleCalendarIds.value].sort()).toEqual(
      state.calendars.value
        .filter((calendar) => calendar.defaultVisible)
        .map((calendar) => calendar.id)
        .sort(),
    )
    expect(state.sidebarOpen.value).toBe(true)
    expect(makeStore(memoryState(), false).sidebarOpen.value).toBe(false)
  })

  it('steps by the view type and keeps the date when the type changes', () => {
    const state = makeStore()
    const steps: [typeof state.viewType.value, string, string][] = [
      ['day', '2026-10-29', '2026-10-28'],
      ['5day', '2026-11-02', '2026-10-28'],
      ['week', '2026-11-04', '2026-10-28'],
      ['list', '2026-11-04', '2026-10-28'],
      ['month', '2026-11-28', '2026-10-28'],
      ['year', '2027-10-28', '2026-10-28'],
      ['split', '2026-11-04', '2026-10-28'],
    ]

    for (const [viewType, forward, back] of steps) {
      state.today()
      state.viewType.value = viewType
      expect(text(state.anchorDate.value)).toBe('2026-10-28')
      state.next()
      expect(text(state.anchorDate.value), `${viewType} next`).toBe(forward)
      state.prev()
      expect(text(state.anchorDate.value), `${viewType} prev`).toBe(back)
    }
  })

  it('steps the split view by its span', () => {
    const state = makeStore()
    state.viewType.value = 'split'
    state.splitSpan.value = 'day'
    state.next()
    expect(text(state.anchorDate.value)).toBe('2026-10-29')
    expect(state.rangeLabel.value).toBe('Thu, 29 Oct 2026')
    state.splitSpan.value = 'month'
    state.next()
    expect(text(state.anchorDate.value)).toBe('2026-11-29')
    expect(state.rangeLabel.value).toBe('November 2026')
  })

  it('returns to today', () => {
    const state = makeStore()
    state.next()
    state.next()
    state.today()
    expect(text(state.anchorDate.value)).toBe('2026-10-28')
  })

  it('exposes the visible range of the view', () => {
    const state = makeStore()
    state.viewType.value = 'month'
    expect(text(state.visibleRange.value.start)).toBe('2026-10-01')
    expect(text(state.visibleRange.value.end)).toBe('2026-11-01')
    expect(state.rangeKind.value).toBe('month')
  })

  it('selects a view and shows exactly its calendars', () => {
    const state = makeStore()
    state.selectView('view-my-week')

    expect(state.selectedViewId.value).toBe('view-my-week')
    expect(state.selectedView.value?.name).toBe('My week')
    expect(state.visibleCalendarIds.value).toEqual(['cal-personal', 'cal-team', 'cal-holidays'])
    expect(new Set(state.visibleEvents.value.map((item) => item.calendarId))).toEqual(
      new Set(['cal-personal', 'cal-team', 'cal-holidays']),
    )
  })

  it('keeps the view selected while single calendars are toggled', () => {
    const state = makeStore()
    state.selectView('view-my-week')
    state.setCalendarVisible('cal-team', false)
    state.setCalendarVisible('cal-sales', true)

    expect(state.selectedViewId.value).toBe('view-my-week')
    expect(state.visibleCalendarIds.value).toEqual(['cal-personal', 'cal-holidays', 'cal-sales'])
  })

  it('clears the view and restores the default calendars', () => {
    const state = makeStore()
    const defaults = [...state.visibleCalendarIds.value]
    state.selectView('view-everything')
    expect(state.visibleCalendarIds.value).toHaveLength(state.calendars.value.length)

    state.selectView(null)
    expect(state.selectedViewId.value).toBeNull()
    expect(state.visibleCalendarIds.value).toEqual(defaults)
  })

  it('ignores an unknown view', () => {
    const state = makeStore()
    const before = [...state.visibleCalendarIds.value]
    state.selectView('view-missing')
    expect(state.selectedViewId.value).toBeNull()
    expect(state.visibleCalendarIds.value).toEqual(before)
  })

  it('shows resources through their calendars', () => {
    const state = makeStore()
    expect([...state.visibleResourceIds.value].sort()).toEqual(['res-room-a', 'res-van'])

    state.setResourceVisible('res-van', false)
    expect(state.visibleCalendarIds.value).not.toContain('cal-van')
    expect(state.visibleResourceIds.value).toEqual(['res-room-a'])
    expect(state.visibleEvents.value.some((item) => item.calendarId === 'cal-van')).toBe(false)

    state.setResourceVisible('res-van', true)
    expect(state.visibleResourceIds.value).toContain('res-van')

    const before = [...state.visibleCalendarIds.value]
    state.setResourceVisible('res-unknown', true)
    expect(state.visibleCalendarIds.value).toEqual(before)
  })

  it('lists resource calendars apart from the regular ones', () => {
    const state = makeStore()
    expect(state.regularCalendars.value.some((calendar) => calendar.type === 'resource')).toBe(
      false,
    )
    expect(state.regularCalendars.value).toHaveLength(
      state.calendars.value.length - state.resources.value.length,
    )
  })

  it('filters events by active filters and categories', () => {
    const state = makeStore()
    const total = state.visibleEvents.value.length

    state.setFilterActive('filter-hide-cancelled', true)
    expect(state.visibleEvents.value).toHaveLength(total - 1)
    expect(state.activeFilters.value.map((filter) => filter.id)).toEqual(['filter-hide-cancelled'])
    state.setFilterActive('filter-hide-cancelled', false)
    expect(state.visibleEvents.value).toHaveLength(total)

    state.setCategorySelected('cat-focus', true)
    expect(state.visibleEvents.value.map((item) => item.id)).toEqual(['evt-focus'])
    state.setCategorySelected('cat-focus', false)
    expect(state.visibleEvents.value).toHaveLength(total)
  })

  it('adds and activates a text filter', () => {
    const state = makeStore()
    const filter = state.addFilter('design')

    expect(filter?.kind).toBe('text')
    expect(state.filters.value.map((item) => item.name)).toContain('design')
    expect(state.activeFilterIds.value).toContain(filter?.id)
    expect(state.visibleEvents.value.map((item) => item.id).sort()).toEqual([
      'evt-design-review',
      'evt-room-a-booking',
    ])
    expect(state.addFilter('DESIGN')).toBeNull()
    expect(state.addFilter(' ')).toBeNull()
  })

  it('adds a category', () => {
    const state = makeStore()
    const category = state.addCategory('Training')

    expect(category?.id).toBe('cat-training')
    expect(state.categories.value.map((item) => item.name)).toContain('Training')
    expect(state.categoryById.value.get('cat-training')?.name).toBe('Training')
    expect(state.addCategory('training')).toBeNull()
  })

  it('adds an event that shows up in the visible events and the range', () => {
    const state = makeStore()
    const before = state.visibleEvents.value.length
    const created = state.addEvent({
      title: 'Planning',
      calendarId: 'cal-personal',
      start: '2026-10-30T09:00',
      end: '2026-10-30T10:00',
    })

    expect(created.id).toBe('evt-new')
    expect(state.visibleEvents.value).toHaveLength(before + 1)
    expect(state.visibleEventsInRange.value.map((item) => item.id)).toContain('evt-new')

    state.next()
    expect(state.visibleEventsInRange.value.map((item) => item.id)).not.toContain('evt-new')
    const another = state.addEvent({
      title: 'Another',
      calendarId: 'cal-personal',
      start: '2026-10-30T11:00',
      end: '2026-10-30T12:00',
    })
    expect(another.id).toBe('evt-new-2')
  })

  it('does not show events of hidden calendars', () => {
    const state = makeStore()
    state.addEvent({
      title: 'Pitch',
      calendarId: 'cal-sales',
      start: '2026-10-30T09:00',
      end: '2026-10-30T10:00',
    })
    expect(state.visibleEvents.value.some((item) => item.title === 'Pitch')).toBe(false)

    state.setCalendarVisible('cal-sales', true)
    expect(state.visibleEvents.value.some((item) => item.title === 'Pitch')).toBe(true)
  })

  it('builds split bands from the visible calendars with events in the range', () => {
    const state = makeStore()
    state.viewType.value = 'split'
    const names = () => state.splitBands.value.map((band) => band.calendar.id)

    expect(names()).toEqual([
      'cal-personal',
      'cal-team',
      'cal-engineering',
      'cal-holidays',
      'cal-room-a',
      'cal-van',
    ])

    state.setCalendarVisible('cal-van', false)
    expect(names()).not.toContain('cal-van')

    state.selectView('view-everything')
    expect(names()).toContain('cal-van')
    expect(names()).not.toContain('cal-sales')
    expect(names()).not.toContain('cal-office')
    expect(names()).not.toContain('cal-marketing')
  })

  it('shows a band when the range reaches its events and hides it when a filter empties it', () => {
    const state = makeStore()
    state.viewType.value = 'split'
    state.splitSpan.value = 'month'
    state.selectView('view-everything')
    expect(state.splitBands.value.map((band) => band.calendar.id)).not.toContain('cal-sales')

    state.next()
    expect(state.splitBands.value.map((band) => band.calendar.id)).toContain('cal-sales')

    state.today()
    state.setFilterActive('filter-offsite', true)
    expect(state.splitBands.value.map((band) => band.calendar.id)).toEqual(['cal-team'])
  })

  it('selects and clears an event', () => {
    const state = makeStore()
    expect(state.selectedEvent.value).toBeNull()

    state.selectEvent('evt-standup')
    expect(state.selectedEvent.value?.title).toBe('Standup')
    state.selectEvent(null)
    expect(state.selectedEvent.value).toBeNull()
  })

  it('opens quick-add with a preset and clears it on close', () => {
    const state = makeStore()
    state.openQuickAdd({ start: '2026-10-30', allDay: true })
    expect(state.quickAddOpen.value).toBe(true)
    expect(state.quickAddPreset.value).toEqual({ start: '2026-10-30', allDay: true })

    state.closeQuickAdd()
    expect(state.quickAddOpen.value).toBe(false)
    expect(state.quickAddPreset.value).toBeNull()

    state.openQuickAdd()
    expect(state.quickAddPreset.value).toBeNull()
  })

  it('toggles the sidebar', () => {
    const state = makeStore()
    state.toggleSidebar()
    expect(state.sidebarOpen.value).toBe(false)
    state.toggleSidebar()
    expect(state.sidebarOpen.value).toBe(true)
  })

  it('shares state between instances and seeds only once', () => {
    const factory = memoryState()
    const seed = vi.fn(() => createMockData(anchor))
    const options = { seed, today: () => anchor, sidebarOpen: () => true }
    const first = createCalendarState(factory, options)
    const second = createCalendarState(factory, options)

    first.viewType.value = 'month'
    first.setCalendarVisible('cal-sales', true)
    first.addEvent({ title: 'X', calendarId: 'cal-sales', start: '2026-10-28', end: '2026-10-29' })

    expect(second.viewType.value).toBe('month')
    expect(second.visibleCalendarIds.value).toContain('cal-sales')
    expect(second.events.value.some((item) => item.title === 'X')).toBe(true)
    expect(seed).toHaveBeenCalledTimes(1)
  })
})
