import { describe, expect, it } from 'vitest'
import { ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import { toViews } from '../app/utils/live/views'
import { emptySeed } from '../app/utils/live/seed'
import type { Calendar, CalendarEvent } from '../shared/types/calendar'

// FR-15: somebody without access sees nothing of a calendar. Radicale answers 403 (or does not
// list the collection at all), so the loader never creates a calendar for it. What this test pins
// is the app side: with only the accessible calendar in the state, a view that names the other
// one, the sidebar's list, the visible events and the split view's bands show nothing of it.

const ALLOWED = 'dav:/caldav/u/allowed/'
const HIDDEN = 'dav:/caldav/u/hidden/'

function memoryState(): StateFactory {
  const store = new Map<string, Ref<unknown>>()
  return <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key) as Ref<T>
  }
}

const calendar = (id: string, name: string): Calendar => ({
  id,
  name,
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
})

const event = (id: string, calendarId: string, title: string): CalendarEvent => ({
  id,
  calendarId,
  uid: id,
  title,
  start: '2026-10-28T09:00:00',
  end: '2026-10-28T10:00:00',
  allDay: false,
  status: 'confirmed',
  categoryIds: [],
})

function setup() {
  const store = createCalendarState(memoryState(), {
    seed: emptySeed,
    today: () => Temporal.PlainDate.from('2026-10-28'),
    sidebarOpen: () => true,
  })
  // The loader's result for a viewer who may read ALLOWED only; HIDDEN was never listed.
  store.calendars.value = [calendar(ALLOWED, 'Allowed')]
  store.visibleCalendarIds.value = [ALLOWED]
  store.views.value = toViews([
    {
      id: 1,
      name: 'Both',
      icon: 'users',
      calendars: [
        { ref: ALLOWED, color: null },
        { ref: HIDDEN, color: null },
      ],
      isAdmin: true,
      ownerId: null,
    },
  ])
  store.events.value = [event('e1', ALLOWED, 'Visible meeting')]
  return store
}

describe('a calendar the viewer has no access to', () => {
  it('is not in the sidebar lists', () => {
    const store = setup()
    expect(store.calendars.value.map((c) => c.id)).toEqual([ALLOWED])
    expect(store.regularCalendars.value.map((c) => c.id)).toEqual([ALLOWED])
    expect(store.calendarById.value.has(HIDDEN)).toBe(false)
  })

  it('is dropped from a shared view that names it', () => {
    const store = setup()
    expect(store.views.value[0]?.calendarIds).toEqual([ALLOWED, HIDDEN])
    store.selectView('1')
    expect(store.visibleCalendarIds.value).toEqual([ALLOWED])
  })

  it('shows no events in the views even if some were in the state', () => {
    const store = setup()
    store.events.value = [...store.events.value, event('e2', HIDDEN, 'Secret meeting')]
    store.selectView('1')
    expect(store.visibleEvents.value.map((e) => e.title)).toEqual(['Visible meeting'])
    expect(store.visibleEventsInRange.value.map((e) => e.title)).toEqual(['Visible meeting'])
  })

  it('has no band in the split view', () => {
    const store = setup()
    store.events.value = [...store.events.value, event('e2', HIDDEN, 'Secret meeting')]
    store.viewType.value = 'split'
    store.selectView('1')
    expect(store.splitBands.value.map((band) => band.calendar.id)).toEqual([ALLOWED])
    expect(JSON.stringify(store.splitBands.value)).not.toContain('Secret')
  })
})
