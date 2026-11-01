import type { Temporal } from 'temporal-polyfill'
import type { Calendar, CalendarEvent } from '../../shared/types/calendar'
import type { MockData } from './mock'

// A bigger demo for NFR-1: 10-20 calendars and a busy day of 10 entries. The default mock data is
// untouched; `useMockData` adds this only when the demo is opened with `?demo-load=busy`. It exists
// so that a browser test can look at the Split view with that many calendars, which the app cannot
// otherwise be given without a login. It is mock data only: it never reaches a live calendar.

export const BUSY_QUERY = 'demo-load'
export const BUSY_VALUE = 'busy'

/** Eight more calendars (17 in all, 14 of them on by default), each with its own colour. */
const EXTRA = [
  ['Finance', '#a21caf'],
  ['Support', '#c2410c'],
  ['Design', '#be123c'],
  ['Legal', '#4338ca'],
  ['Operations', '#15803d'],
  ['Recruiting', '#0369a1'],
  ['Training', '#a16207'],
  ['Board', '#334155'],
] as const

/** The busy day's entries, by extra calendar: title, start, end. Eleven in total, all overlapping. */
const BUSY_DAY: readonly (readonly [calendar: number, title: string, from: string, to: string])[] =
  [
    [0, 'Month-end close', '09:00', '11:00'],
    [0, 'Audit call', '10:00', '11:30'],
    [1, 'Escalation review', '09:30', '10:30'],
    [2, 'Design critique', '10:00', '12:00'],
    [3, 'Contract review', '09:00', '10:00'],
    [4, 'Warehouse check', '10:30', '12:00'],
    [5, 'Interview: backend', '09:30', '10:30'],
    [5, 'Interview: design', '10:00', '11:00'],
    [6, 'Security training', '09:00', '12:00'],
    [7, 'Board prep', '10:00', '11:00'],
    [1, 'Customer call', '11:00', '12:00'],
  ]

/** `data` with the extra calendars and their entries; `busyDay` is the day with 10 or more entries. */
export function addBusyCalendars(data: MockData, busyDay: Temporal.PlainDate): MockData {
  const calendars: Calendar[] = EXTRA.map(([name, color], index) => ({
    id: `cal-extra-${index}`,
    name,
    type: 'caldav',
    color,
    defaultVisible: true,
    ownerId: data.currentUser.id,
  }))
  const events: CalendarEvent[] = BUSY_DAY.map(([calendar, title, from, to], index) => ({
    id: `evt-busy-${index}`,
    uid: `evt-busy-${index}`,
    calendarId: calendars[calendar]!.id,
    title,
    start: `${busyDay.toString()}T${from}:00`,
    end: `${busyDay.toString()}T${to}:00`,
    allDay: false,
    status: 'confirmed',
    categoryIds: [],
  }))
  // Varying entries per month: every extra calendar also has one entry a week or two later.
  calendars.forEach((calendar, index) => {
    const day = busyDay.add({ days: 7 + index })
    events.push({
      id: `evt-later-${index}`,
      uid: `evt-later-${index}`,
      calendarId: calendar.id,
      title: `${calendar.name} follow-up`,
      start: `${day.toString()}T14:00:00`,
      end: `${day.toString()}T15:00:00`,
      allDay: false,
      status: 'confirmed',
      categoryIds: [],
    })
  })
  const extraIds = calendars.map((calendar) => calendar.id)
  const everything = new Set(data.calendars.map((calendar) => calendar.id))
  return {
    ...data,
    // The views that list every calendar list the new ones too.
    views: data.views.map((view) =>
      view.calendarIds.length === everything.size &&
      view.calendarIds.every((id) => everything.has(id))
        ? { ...view, calendarIds: [...view.calendarIds, ...extraIds] }
        : view,
    ),
    calendars: [...data.calendars, ...calendars],
    events: [...data.events, ...events],
  }
}
