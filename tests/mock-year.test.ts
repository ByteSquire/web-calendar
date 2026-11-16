import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { createMockData } from '../app/data/mock'
import { addYearOfEvents } from '../app/data/mock-year'

// The demo's year of entries (`?demo-load=year`), for long periods on screen and on paper.

const anchor = Temporal.PlainDate.from('2026-10-29')
const plain = createMockData(anchor)
const year = addYearOfEvents(plain, anchor)
const added = year.events.slice(plain.events.length)

describe('the demo year of entries', () => {
  it('keeps the default data as it was and does not change what it was given', () => {
    expect(year.events.slice(0, plain.events.length)).toEqual(plain.events)
    expect(year.calendars).toEqual(plain.calendars)
    expect(plain).toEqual(createMockData(anchor))
  })

  it('fills every month of the year, and only that year', () => {
    const months = new Set(added.map((event) => event.start.slice(0, 7)))
    expect([...months].sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
    )
    for (const event of added) expect(event.start.startsWith('2026-')).toBe(true)
    expect(added.length).toBeGreaterThan(150)
  })

  it('gives every entry its own id, a calendar and categories that exist, and an end after its start', () => {
    const calendars = new Set(year.calendars.map((calendar) => calendar.id))
    const categories = new Set(year.categories.map((category) => category.id))
    expect(new Set(year.events.map((event) => event.id)).size).toBe(year.events.length)
    for (const event of added) {
      expect(calendars.has(event.calendarId)).toBe(true)
      for (const id of event.categoryIds) expect(categories.has(id)).toBe(true)
      expect(event.end > event.start).toBe(true)
    }
  })

  it('has all-day, tentative and cancelled entries as well as timed confirmed ones', () => {
    expect(added.some((event) => event.allDay)).toBe(true)
    expect(added.some((event) => event.status === 'tentative')).toBe(true)
    expect(added.some((event) => event.status === 'cancelled')).toBe(true)
  })
})
