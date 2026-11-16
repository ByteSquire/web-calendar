import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent, EventStatus } from '../../shared/types/calendar'
import type { MockData } from './mock'

// A year of entries for the demo, to look at long periods on screen and on paper (the year view,
// a month full of entries, many pages of a printout). The default mock data is untouched;
// `useMockData` adds this only when the demo is opened with `?demo-load=year`. It is mock data
// only: it never reaches a live calendar. Everything follows from the year of `today`, so a test
// that passes a fixed date gets the same entries every time.

export const YEAR_VALUE = 'year'

type Entry = Omit<CalendarEvent, 'id' | 'uid'>

const HOLIDAYS: readonly (readonly [month: number, day: number, title: string])[] = [
  [1, 1, "New Year's Day"],
  [5, 1, 'Labour Day'],
  [10, 3, 'Day of German Unity'],
  [12, 24, 'Christmas Eve'],
  [12, 25, 'Christmas Day'],
  [12, 26, 'Boxing Day'],
  [12, 31, "New Year's Eve"],
]

const BOOKS = [
  'The Left Hand of Darkness',
  'Middlemarch',
  'Piranesi',
  'The Remains of the Day',
  'Beloved',
  'Stoner',
  'The Overstory',
  'A Gentleman in Moscow',
  'Klara and the Sun',
  'Never Let Me Go',
  'The Dispossessed',
  'Hamnet',
]

/** `data` with entries all through the year of `today`, from 1 January to 31 December. */
export function addYearOfEvents(data: MockData, today: Temporal.PlainDate): MockData {
  const first = Temporal.PlainDate.from({ year: today.year, month: 1, day: 1 })
  const last = Temporal.PlainDate.from({ year: today.year, month: 12, day: 31 })
  const at = (day: Temporal.PlainDate, time: string) => `${day.toString()}T${time}:00`
  const entries: Entry[] = []

  const timed = (
    day: Temporal.PlainDate,
    from: string,
    to: string,
    fields: Pick<Entry, 'calendarId' | 'title' | 'categoryIds'> & Partial<Entry>,
  ) =>
    entries.push({
      allDay: false,
      status: 'confirmed',
      ...fields,
      start: at(day, from),
      end: at(day, to),
    })

  const allDay = (
    from: Temporal.PlainDate,
    days: number,
    fields: Pick<Entry, 'calendarId' | 'title' | 'categoryIds'> & Partial<Entry>,
  ) =>
    entries.push({
      allDay: true,
      status: 'confirmed',
      ...fields,
      start: from.toString(),
      end: from.add({ days }).toString(),
    })

  /** Every `weekday` (1 is Monday) of the year, in order. */
  const weekdays = (weekday: number) => {
    const days: Temporal.PlainDate[] = []
    let day = first.add({ days: (weekday - first.dayOfWeek + 7) % 7 })
    while (Temporal.PlainDate.compare(day, last) <= 0) {
      days.push(day)
      day = day.add({ weeks: 1 })
    }
    return days
  }
  /** The `nth` `weekday` of a month; a negative `nth` counts from the end. */
  const nthWeekday = (month: number, weekday: number, nth: number) => {
    const days = weekdays(weekday).filter((day) => day.month === month)
    return days.at(nth > 0 ? nth - 1 : nth)!
  }

  // Weekly: a team sync on Mondays (now and then tentative or cancelled) and the gym on Wednesdays.
  weekdays(1).forEach((day, week) => {
    const status: EventStatus =
      week % 9 === 4 ? 'cancelled' : week % 7 === 3 ? 'tentative' : 'confirmed'
    timed(day, '11:00', '11:30', {
      calendarId: 'cal-team',
      title: 'Weekly team sync',
      categoryIds: ['cat-meeting', 'cat-work'],
      location: 'Video call',
      status,
    })
  })
  weekdays(3).forEach((day) =>
    timed(day, '18:30', '19:30', {
      calendarId: 'cal-personal',
      title: 'Gym',
      categoryIds: ['cat-personal'],
      location: 'City fitness centre',
    }),
  )

  // Every other Friday: the sprint review.
  weekdays(5).forEach((day, week) => {
    if (week % 2 === 1) {
      timed(day, '14:00', '15:00', {
        calendarId: 'cal-engineering',
        title: `Sprint review ${Math.ceil(week / 2)}`,
        categoryIds: ['cat-meeting', 'cat-work'],
        location: 'Room A',
      })
    }
  })

  // Monthly: the budget check-in (first Tuesday) and the book club (last Thursday).
  for (let month = 1; month <= 12; month += 1) {
    timed(nthWeekday(month, 2, 1), '10:00', '11:00', {
      calendarId: 'cal-team',
      title: 'Budget check-in',
      categoryIds: ['cat-work'],
    })
    timed(nthWeekday(month, 4, -1), '19:00', '21:00', {
      calendarId: 'cal-personal',
      title: `Book club: ${BOOKS[month - 1]}`,
      categoryIds: ['cat-personal'],
      location: 'Café Central',
      status: month % 4 === 2 ? 'tentative' : 'confirmed',
    })
  }

  // Quarterly: a whole working day of planning, with a long title and a description.
  for (const month of [1, 4, 7, 10]) {
    timed(nthWeekday(month, 3, 2), '09:00', '17:00', {
      calendarId: 'cal-engineering',
      title: 'Quarterly business review and roadmap planning with product, design and sales',
      categoryIds: ['cat-work', 'cat-focus'],
      location: 'Lakeside Lodge, conference room 2',
      description: 'Review the last quarter, agree on goals and owners for the next one.',
    })
  }

  // Holidays, and a few longer stretches away.
  for (const [month, day, title] of HOLIDAYS) {
    allDay(Temporal.PlainDate.from({ year: today.year, month, day }), 1, {
      calendarId: 'cal-holidays',
      title,
      categoryIds: ['cat-holiday'],
    })
  }
  allDay(nthWeekday(2, 6, 1), 2, {
    calendarId: 'cal-engineering',
    title: 'Conference: FOSDEM',
    categoryIds: ['cat-work', 'cat-travel'],
    location: 'Brussels',
  })
  allDay(nthWeekday(3, 6, 1), 9, {
    calendarId: 'cal-personal',
    title: 'Ski trip',
    categoryIds: ['cat-personal', 'cat-travel'],
    location: 'Innsbruck',
  })
  allDay(nthWeekday(8, 6, 1), 15, {
    calendarId: 'cal-personal',
    title: 'Summer holiday in Portugal',
    categoryIds: ['cat-personal', 'cat-travel', 'cat-holiday'],
    location: 'Lisbon and the Algarve',
  })
  allDay(nthWeekday(6, 1, 2), 3, {
    calendarId: 'cal-team',
    title: 'Team offsite',
    categoryIds: ['cat-work', 'cat-travel'],
    location: 'Black Forest',
  })

  // One-off appointments.
  timed(nthWeekday(4, 2, 3), '08:15', '09:00', {
    calendarId: 'cal-personal',
    title: 'Dentist check-up',
    categoryIds: ['cat-personal'],
    location: 'Main Street 12',
  })
  timed(nthWeekday(9, 2, 3), '08:15', '09:00', {
    calendarId: 'cal-personal',
    title: 'Dentist check-up',
    categoryIds: ['cat-personal'],
    location: 'Main Street 12',
  })
  timed(nthWeekday(5, 4, 2), '16:00', '17:30', {
    calendarId: 'cal-room-a',
    title: 'Customer workshop',
    categoryIds: ['cat-meeting'],
    location: 'Room A',
    resourceId: 'res-room-a',
    bookedByCalendarId: 'cal-team',
  })
  timed(nthWeekday(11, 5, 3), '18:00', '23:00', {
    calendarId: 'cal-team',
    title: 'End-of-year party',
    categoryIds: ['cat-personal'],
    location: 'The Old Brewery',
  })
  timed(nthWeekday(12, 1, 2), '13:00', '17:00', {
    calendarId: 'cal-engineering',
    title: 'Annual performance reviews with the whole engineering department and HR',
    categoryIds: ['cat-work'],
  })

  const events: CalendarEvent[] = entries.map((entry, index) => ({
    id: `evt-year-${index}`,
    uid: `evt-year-${index}`,
    ...entry,
  }))
  return { ...data, events: [...data.events, ...events] }
}
