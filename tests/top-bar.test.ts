// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { QuickAddModal, TopBar, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import { VIEW_TYPES, VIEW_TYPE_LABELS } from '~/utils/calendar-state'

// The top bar and the quick-add dialog inside a real Nuxt UI app: ARIA, keyboard, focus.
const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => [h(TopBar), h(QuickAddModal)] }),
})

const buttons = () => [...document.querySelectorAll('button')]
const button = (name: string) =>
  buttons().find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
const dialog = () => document.querySelector('[role="dialog"]')
const formInputs = () => [...document.querySelectorAll<HTMLInputElement>('#quick-add-form input')]
const errorTexts = () =>
  [...document.querySelectorAll('#quick-add-form [id$="-error"]')].map((item) =>
    item.textContent?.trim(),
  )

function keydown(target: Element | null, key: string) {
  target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let app: Awaited<ReturnType<typeof mountSuspended>>

beforeEach(async () => {
  // The test environment starts on 'light'; the app starts on the system's scheme.
  useColorMode().preference = 'system'
  app = await mountSuspended(Shell, { attachTo: document.body })
})

afterEach(() => {
  app.unmount()
  // The colour mode lives in Nuxt state too, and the overflow menu needs it.
  clearNuxtState((key) => key !== 'color-mode')
})

describe('the name of the app', () => {
  it('is a link to the base address, the calendar view', () => {
    const link = [...document.querySelectorAll('a')].find(
      (item) => item.textContent?.trim() === 'Web Calendar',
    )
    expect(link).toBeDefined()
    expect(link!.getAttribute('href')).toBe('/')
  })
})

describe('view-type switcher', () => {
  it('changes the view type and marks only the current one as pressed', async () => {
    const { viewType } = useCalendarState()
    for (const type of VIEW_TYPES) {
      button(VIEW_TYPE_LABELS[type])!.click()
      await vi.waitFor(() => expect(viewType.value).toBe(type))
      const pressed = [...document.querySelectorAll('[aria-pressed="true"]')]
      expect(pressed.map((item) => item.textContent?.trim())).toEqual([VIEW_TYPE_LABELS[type]])
    }
  })
})

describe('date navigation', () => {
  it('steps by the period of the view and announces the new title', async () => {
    const { anchorDate, rangeLabel, viewType } = useCalendarState()
    const start = anchorDate.value
    const title = () => document.querySelector('[aria-live="polite"]')?.textContent?.trim()
    expect(title()).toBe(rangeLabel.value)

    button('Next week')!.click()
    await vi.waitFor(() =>
      expect(anchorDate.value.toString()).toBe(start.add({ days: 7 }).toString()),
    )
    await vi.waitFor(() => expect(title()).toBe(rangeLabel.value))

    button('Previous week')!.click()
    button('Previous week')!.click()
    await vi.waitFor(() =>
      expect(anchorDate.value.toString()).toBe(start.subtract({ days: 7 }).toString()),
    )

    button('Today')!.click()
    await vi.waitFor(() => expect(anchorDate.value.toString()).toBe(start.toString()))

    viewType.value = 'month'
    await vi.waitFor(() => expect(button('Next month')).toBeDefined())
  })
})

describe('overflow menu', () => {
  it('opens with the keyboard, closes with Escape and returns focus to its trigger', async () => {
    const trigger = button('More options')!
    trigger.focus()
    keydown(trigger, 'Enter')
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
    expect(
      [...document.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim()),
    ).toEqual(['Refresh', 'Settings', 'Dark mode', 'Category colours on events', 'Help'])
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')

    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})

describe('quick-add', () => {
  it('validates, adds an event that shows in the current range and returns focus', async () => {
    const { events, visibleEventsInRange } = useCalendarState()
    const opener = button('Quick add')!
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const [title] = formInputs()
    expect(document.activeElement).toBe(title)

    button('Add event')!.click()
    await vi.waitFor(() => expect(errorTexts()).toEqual(['Enter a title.']))
    expect(document.activeElement).toBe(title)
    expect(title!.getAttribute('aria-invalid')).toBe('true')
    expect(title!.getAttribute('aria-describedby')).toMatch(/-error$/)

    type(title!, 'Dialog test')
    await vi.waitFor(() => expect(errorTexts()).toEqual([]))
    const before = events.value.length
    button('Add event')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())

    expect(events.value).toHaveLength(before + 1)
    const added = events.value.find((event) => event.title === 'Dialog test')!
    expect(visibleEventsInRange.value.map((event) => event.id)).toContain(added.id)
    expect(document.activeElement).toBe(opener)
  })

  it('closes with Escape and returns focus', async () => {
    const { quickAddOpen } = useCalendarState()
    const opener = button('Quick add')!
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())

    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(quickAddOpen.value).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('starts from the preset and stores an all-day end as exclusive', async () => {
    const { events, openQuickAdd } = useCalendarState()
    openQuickAdd({ allDay: true, start: '2026-11-02', end: '2026-11-05' })
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const [title, start, end] = formInputs()
    expect([start!.type, start!.value, end!.value]).toEqual(['date', '2026-11-02', '2026-11-04'])

    type(title!, 'Offsite')
    button('Add event')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(events.value.find((event) => event.title === 'Offsite')).toMatchObject({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-05',
    })
  })

  it('shows an error for an end before the start', async () => {
    const { events, openQuickAdd } = useCalendarState()
    openQuickAdd({ start: '2026-11-02T14:00', end: '2026-11-02T15:00' })
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const [title, , end] = formInputs()
    type(title!, 'Backwards')
    type(end!, '2026-11-02T13:00')

    const before = events.value.length
    button('Add event')!.click()
    await vi.waitFor(() => expect(errorTexts()).toEqual(['The end must be after the start.']))
    expect(document.activeElement).toBe(end)
    expect(events.value).toHaveLength(before)
    expect(dialog()).not.toBeNull()
  })
})
