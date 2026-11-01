// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CalendarMain, EventSheet, UApp } from '#components'
import FullCalendar from '@fullcalendar/vue3'
import { useCalendarState } from '~/composables/useCalendarState'
import { VIEW_TYPES } from '~/utils/calendar-state'
import { fullCalendarViewName } from '~/utils/fullcalendar'

// The standard views and the event sheet inside a real Nuxt UI app.
const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => [h(CalendarMain), h(EventSheet)] }),
})

const STANDARD_VIEWS = VIEW_TYPES.filter((type) => type !== 'split')

const entries = () => [...document.querySelectorAll<HTMLElement>('.app-evt')]
const entryNamed = (title: string) =>
  entries().find((item) => item.textContent?.includes(title) ?? false)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const dialogButton = (name: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent?.trim() === name,
  )

function calendarApi(app: Awaited<ReturnType<typeof mountSuspended>>) {
  return (app.findComponent(FullCalendar).vm as unknown as { getApi(): CalendarApi }).getApi()
}

interface CalendarApi {
  view: { type: string }
  getOption(name: string): unknown
  getDate(): Date
  formatIso(date: Date, omitTime: boolean): string
}

let app: Awaited<ReturnType<typeof mountSuspended>>
let consoleError: ReturnType<typeof vi.spyOn>
let consoleWarn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  consoleError = vi.spyOn(console, 'error')
  consoleWarn = vi.spyOn(console, 'warn')
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(entries().length).toBeGreaterThan(0))
})

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled()
  expect(consoleWarn).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  app.unmount()
  // Only the calendar state: the colour mode lives in Nuxt state too, and the calendar needs it.
  clearNuxtState((key) => key.startsWith('cal-'))
})

describe('display zone', () => {
  it('passes a change of the zone on to FullCalendar while it is shown (FR-32)', async () => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(calendarApi(app).getOption('timeZone')).toBe(browser)

    useUserTimeZone().value = 'Pacific/Kiritimati'
    await vi.waitFor(() =>
      expect(calendarApi(app).getOption('timeZone')).toBe('Pacific/Kiritimati'),
    )
    expect(entries().length).toBeGreaterThan(0)

    useUserTimeZone().value = null
    await vi.waitFor(() => expect(calendarApi(app).getOption('timeZone')).toBe(browser))
  })
})

/**
 * The mock events cover the current week only, so what a view shows would depend on the weekday the
 * suite runs on. One all-day stub event on every day of the last, the current and the next week
 * (Monday to Sunday) makes the days around today the same on every run.
 */
function addStubEventsAroundToday() {
  const { anchorDate, calendars, addEvent } = useCalendarState()
  const calendarId = calendars.value[0]!.id
  const monday = anchorDate.value.subtract({ days: anchorDate.value.dayOfWeek - 1 })
  for (let offset = -7; offset < 14; offset += 1) {
    const day = monday.add({ days: offset })
    addEvent({
      title: 'Stub event',
      calendarId,
      start: day.toString(),
      end: day.add({ days: 1 }).toString(),
      allDay: true,
    })
  }
}

describe('standard views', () => {
  it('renders events in every view and keeps the selected date', async () => {
    addStubEventsAroundToday()
    const { viewType, anchorDate } = useCalendarState()
    const date = anchorDate.value.add({ days: 2 })
    anchorDate.value = date

    for (const type of STANDARD_VIEWS) {
      viewType.value = type
      await vi.waitFor(() => {
        expect(calendarApi(app).view.type).toBe(fullCalendarViewName(type))
        expect(entries().length).toBeGreaterThan(0)
      })
      const api = calendarApi(app)
      expect(api.formatIso(api.getDate(), true)).toBe(date.toString())
      expect(document.querySelector(`.calendar-view-${type}`)).not.toBeNull()
    }
  })

  it('follows the date navigation of the shared state', async () => {
    const { anchorDate, next, prev } = useCalendarState()
    const start = anchorDate.value

    next()
    await vi.waitFor(() => {
      const api = calendarApi(app)
      expect(api.formatIso(api.getDate(), true)).toBe(start.add({ days: 7 }).toString())
    })

    prev()
    prev()
    await vi.waitFor(() => {
      const api = calendarApi(app)
      expect(api.formatIso(api.getDate(), true)).toBe(start.subtract({ days: 7 }).toString())
    })
  })

  it('opens a day from the day number in the month view', async () => {
    const { viewType, anchorDate } = useCalendarState()
    anchorDate.value = Temporal.PlainDate.from('2026-10-15')
    viewType.value = 'month'
    await vi.waitFor(() => expect(calendarApi(app).view.type).toBe('dayGridMonth'))

    // The month grid starts on Monday 28 September.
    const firstDay = document.querySelector<HTMLElement>('[role="link"]')!
    firstDay.click()
    await vi.waitFor(() => expect(viewType.value).toBe('day'))
    expect(anchorDate.value.toString()).toBe('2026-09-28')
    await vi.waitFor(() => {
      const api = calendarApi(app)
      expect(api.view.type).toBe('timeGridDay')
      expect(api.formatIso(api.getDate(), true)).toBe('2026-09-28')
    })
  })

  it('draws blocked events as Busy and gives every entry an accessible name', () => {
    const blocked = document.querySelector('.app-evt-blocked')
    expect(blocked?.textContent).toContain('Busy')
    expect(blocked?.textContent).not.toMatch(/Van|Sales/)
    for (const entry of entries()) {
      expect(entry.getAttribute('role')).toBe('button')
      expect(entry.querySelector('.sr-only')?.textContent?.length).toBeGreaterThan(0)
    }
  })

  it('opens the event sheet on a click and nothing is draggable', async () => {
    const { selectedEventId } = useCalendarState()
    expect(document.querySelector('.fc-draggable, [draggable="true"]')).toBeNull()

    entryNamed('Standup')!.click()
    await vi.waitFor(() => expect(selectedEventId.value).toBe('evt-standup'))
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Standup')
    expect(dialog()!.textContent).toContain('Video call')
    expect(dialog()!.textContent).toContain('Personal')
    expect(dialog()!.textContent).toContain('09:00 – 09:15')
    expect(dialogButton('Edit')).toBeDefined()
    expect(dialogButton('Delete')).toBeDefined()
  })
})

describe('event sheet', () => {
  it('closes on Escape and returns the focus to the clicked entry', async () => {
    const { selectedEventId } = useCalendarState()
    const entry = entryNamed('Standup')!
    entry.focus()
    entry.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.contains(document.activeElement)).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(selectedEventId.value).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(entry))
  })

  it('shows only Busy and the time for a blocked event, without Edit and Delete', async () => {
    const { selectEvent } = useCalendarState()
    selectEvent('evt-van-blocked')
    await vi.waitFor(() => expect(dialog()).not.toBeNull())

    const text = dialog()!.textContent ?? ''
    expect(text).toContain('Busy')
    expect(text).toContain('All day')
    expect(text).not.toMatch(/Van|Sales|Calendar|Status/)
    expect(dialogButton('Edit')).toBeUndefined()
    expect(dialogButton('Delete')).toBeUndefined()
  })

  it('names the resource of a booking', async () => {
    const { selectEvent } = useCalendarState()
    selectEvent('evt-room-a-booking')
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Room A')
    expect(dialog()!.textContent).toContain('Design workshop')
  })

  it('says that editing arrives with the real calendar service', async () => {
    const { selectEvent, selectedEventId } = useCalendarState()
    selectEvent('evt-standup')
    await vi.waitFor(() => expect(dialogButton('Edit')).toBeDefined())

    dialogButton('Edit')!.click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Editing arrives with the real calendar service'),
    )
    expect(selectedEventId.value).toBe('evt-standup')

    dialogButton('Delete')!.click()
    expect(selectedEventId.value).toBe('evt-standup')
  })
})
