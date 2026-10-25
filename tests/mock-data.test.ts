import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { createMockData, mockData } from '../app/data/mock'

const calendarIds = new Set(mockData.calendars.map((calendar) => calendar.id))
const categoryIds = new Set(mockData.categories.map((category) => category.id))
const resourceIds = new Set(mockData.resources.map((resource) => resource.id))

function expectUniqueIds(items: { id: string }[]) {
  const ids = items.map((item) => item.id)
  expect(new Set(ids).size).toBe(ids.length)
}

describe('mock data', () => {
  it('uses unique ids within each collection', () => {
    expectUniqueIds(mockData.views)
    expectUniqueIds(mockData.calendars)
    expectUniqueIds(mockData.resources)
    expectUniqueIds(mockData.categories)
    expectUniqueIds(mockData.filters)
    expectUniqueIds(mockData.events)
  })

  it('references existing calendars, categories and resources', () => {
    for (const event of mockData.events) {
      expect(calendarIds.has(event.calendarId)).toBe(true)
      for (const id of event.categoryIds) {
        expect(categoryIds.has(id)).toBe(true)
      }
      if (event.resourceId) {
        expect(resourceIds.has(event.resourceId)).toBe(true)
      }
      if (event.bookedByCalendarId) {
        expect(calendarIds.has(event.bookedByCalendarId)).toBe(true)
      }
    }
  })

  it('scopes every view to existing calendars', () => {
    for (const view of mockData.views) {
      expect(view.calendarIds.length).toBeGreaterThan(0)
      for (const id of view.calendarIds) {
        expect(calendarIds.has(id)).toBe(true)
      }
    }
    expect(mockData.views.some((view) => view.isAdmin)).toBe(true)
  })

  it('maps every resource to its own resource calendar', () => {
    const resourceCalendars = mockData.calendars.filter((calendar) => calendar.type === 'resource')

    expect(resourceCalendars.map((calendar) => calendar.id).sort()).toEqual(
      mockData.resources.map((resource) => resource.calendarId).sort(),
    )

    for (const resource of mockData.resources) {
      const calendar = mockData.calendars.find((item) => item.id === resource.calendarId)
      expect(calendar?.resourceType).toBe(resource.type)
    }
  })

  it('includes empty calendars for split-view band hiding', () => {
    const used = new Set(mockData.events.map((event) => event.calendarId))
    const empty = mockData.calendars.filter((calendar) => !used.has(calendar.id))

    expect(empty.map((calendar) => calendar.id)).toEqual(
      expect.arrayContaining(['cal-office', 'cal-marketing']),
    )
  })

  it('marks blocked bookings with hidden details', () => {
    const blocked = mockData.events.filter((event) => event.isBlocked)

    expect(blocked.length).toBeGreaterThan(0)
    for (const event of blocked) {
      expect(event.bookedByCalendarId).toBeTruthy()
      expect(event.resourceId).toBeTruthy()
      expect(event.description).toBeUndefined()
    }
  })

  it('has valid all-day and timed ranges', () => {
    for (const event of mockData.events) {
      if (event.allDay) {
        const start = Temporal.PlainDate.from(event.start)
        const end = Temporal.PlainDate.from(event.end)
        expect(Temporal.PlainDate.compare(end, start)).toBe(1)
      } else {
        const start = Temporal.PlainDateTime.from(event.start)
        const end = Temporal.PlainDateTime.from(event.end)
        expect(Temporal.PlainDateTime.compare(end, start)).toBe(1)
      }
    }
  })

  it('covers all-day, timed, multi-day and every status', () => {
    expect(mockData.events.some((event) => event.allDay)).toBe(true)
    expect(mockData.events.some((event) => !event.allDay)).toBe(true)
    expect(
      mockData.events.some((event) => {
        if (!event.allDay) return false
        const start = Temporal.PlainDate.from(event.start)
        return Temporal.PlainDate.from(event.end).since(start).days > 1
      }),
    ).toBe(true)
    expect(new Set(mockData.events.map((event) => event.status))).toEqual(
      new Set(['confirmed', 'tentative', 'cancelled']),
    )
  })

  it('has resolvable filters and hex colors', () => {
    for (const filter of mockData.filters) {
      if (filter.kind === 'category') {
        expect(categoryIds.has(filter.value)).toBe(true)
      } else if (filter.kind === 'status') {
        expect(['confirmed', 'tentative', 'cancelled']).toContain(filter.value)
      } else {
        expect(filter.value.length).toBeGreaterThan(0)
      }
    }

    for (const item of [...mockData.calendars, ...mockData.categories]) {
      expect(item.color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('is deterministic for a fixed anchor date', () => {
    const anchor = Temporal.PlainDate.from('2026-10-26')
    const first = createMockData(anchor)
    const second = createMockData(anchor)

    expect(first).toEqual(second)
    expect(first.events.some((event) => event.start.startsWith(anchor.toString()))).toBe(true)
  })
})
