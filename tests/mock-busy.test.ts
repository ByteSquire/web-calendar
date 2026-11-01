import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { createMockData } from '../app/data/mock'
import { addBusyCalendars } from '../app/data/mock-busy'

// The bigger demo of NFR-1 (10-20 calendars, a busy day of about 10 entries).

const anchor = Temporal.PlainDate.from('2026-10-29')
const plain = createMockData(anchor)
const busy = addBusyCalendars(plain, anchor)

describe('the busy demo data', () => {
  it('has 10 to 20 calendars, each with its own id, name and colour', () => {
    expect(busy.calendars.length).toBeGreaterThanOrEqual(10)
    expect(busy.calendars.length).toBeLessThanOrEqual(20)
    for (const key of ['id', 'name', 'color'] as const) {
      expect(new Set(busy.calendars.map((calendar) => calendar[key])).size).toBe(
        busy.calendars.length,
      )
    }
    for (const calendar of busy.calendars) expect(calendar.color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('keeps the default calendars and events as they were', () => {
    expect(busy.calendars.slice(0, plain.calendars.length)).toEqual(plain.calendars)
    expect(busy.events.slice(0, plain.events.length)).toEqual(plain.events)
  })

  it('puts at least 10 entries on the busy day, in visible calendars, each in a calendar that exists', () => {
    const ids = new Set(busy.calendars.map((calendar) => calendar.id))
    const visible = new Set(
      busy.calendars.filter((calendar) => calendar.defaultVisible).map((calendar) => calendar.id),
    )
    const onTheDay = busy.events.filter((event) => event.start.startsWith('2026-10-29'))
    expect(onTheDay.filter((event) => visible.has(event.calendarId)).length).toBeGreaterThanOrEqual(
      10,
    )
    for (const event of busy.events) expect(ids.has(event.calendarId)).toBe(true)
    expect(new Set(busy.events.map((event) => event.id)).size).toBe(busy.events.length)
  })

  it('lets the views that list every calendar list the new ones, and no other view', () => {
    const all = busy.calendars.map((calendar) => calendar.id).sort()
    for (const view of busy.views) {
      const before = plain.views.find((item) => item.id === view.id)!
      const wasAll = before.calendarIds.length === plain.calendars.length
      expect(wasAll ? [...view.calendarIds].sort() : view.calendarIds).toEqual(
        wasAll ? all : before.calendarIds,
      )
    }
  })

  it('does not change the data it was given', () => {
    expect(plain).toEqual(createMockData(anchor))
  })
})
