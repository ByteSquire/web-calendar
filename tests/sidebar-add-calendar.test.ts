// @vitest-environment nuxt
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useNuxtApp } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { DavError } from '../app/utils/caldav/errors'
import type { Calendar } from '../shared/types/calendar'

// "Add calendar" in the sidebar: a text field and a plus, like the ones for views, categories and
// filters. It makes a calendar in the person's own home and lists it, and is not there where there
// is no calendar service (demo mode).

vi.mock('~/composables/useAuthFetch', () => ({
  // The sidebar asks /api/me whether the person is an admin; it is not.
  useAuthFetch: () => async () => ({ isAdmin: false }),
}))

const made: { displayName: string }[] = []
const service = { fail: null as DavError | null, hold: null as Promise<void> | null }
const caldav = {
  client: {
    createCalendar: async (args: { displayName: string }) => {
      await service.hold
      if (service.fail) throw service.fail
      made.push({ displayName: args.displayName })
      return { url: '/caldav/alice/new/', displayName: args.displayName }
    },
  },
  reader: { invalidate: () => undefined },
}

const calendars: Calendar[] = [
  {
    id: 'dav:/caldav/alice/work/',
    name: 'Work',
    color: '#1d4ed8',
    type: 'caldav',
    href: '/caldav/alice/work/',
    writable: true,
  } as unknown as Calendar,
]

function config(demo: boolean) {
  useServerConfigState().value = {
    oidc: { issuer: 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: 'Europe/Berlin',
    demo,
    signinWindowDays: 30,
  }
}

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(SidebarContent) }) })
let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

beforeAll(() => {
  useNuxtApp().provide('caldav', caldav)
})
beforeEach(() => {
  made.length = 0
  service.fail = null
  service.hold = null
  clearNuxtState((key) => key !== 'color-mode')
  window.localStorage.clear()
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
afterAll(() => {
  service.hold = null
})

async function mountSidebar(demo = false) {
  config(demo)
  app = await mountSuspended(Shell, { attachTo: document.body })
  const state = useCalendarState()
  state.calendars.value = calendars
  state.visibleCalendarIds.value = calendars.map((calendar) => calendar.id)
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const sourcesVersion = () => useState<number>('calendar-sources-version', () => 0).value
const calendarsSection = () =>
  [...document.querySelectorAll('section')].find((item) =>
    text(item.querySelector('h2')).startsWith('Calendars'),
  ) ?? null
const input = () =>
  calendarsSection()?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])') ??
  null
const addButton = () =>
  calendarsSection()?.querySelector<HTMLButtonElement>('button[aria-label="Add calendar"]') ?? null

async function submit(name: string) {
  const field = input()!
  field.value = name
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  addButton()!.click()
}

describe('the plus in the calendars section', () => {
  it('has a labelled text field and an "Add calendar" button, like views and categories', async () => {
    await mountSidebar()
    expect(input()).not.toBeNull()
    expect(addButton()).not.toBeNull()
    const label = [...(calendarsSection()?.querySelectorAll('label') ?? [])].find(
      (item) => text(item) === 'New calendar name',
    )
    expect(label).toBeDefined()
    expect(label!.getAttribute('for')).toBe(input()!.id)
  })

  it('is not there in demo mode, where there is no calendar service', async () => {
    await mountSidebar(true)
    expect(addButton()).toBeNull()
    expect(input()).toBeNull()
  })

  it('makes the calendar with the trimmed name, empties the field and loads the sources again', async () => {
    await mountSidebar()
    const before = sourcesVersion()
    await submit('  Holidays  ')
    await vi.waitFor(() => expect(made).toEqual([{ displayName: 'Holidays' }]))
    await vi.waitFor(() => expect(input()!.value).toBe(''))
    expect(sourcesVersion()).toBe(before + 1)
  })

  it('does nothing for an empty name', async () => {
    await mountSidebar()
    await submit('   ')
    await nextTick()
    expect(made).toEqual([])
  })

  it('refuses a name that a calendar has already, in any case, and keeps what was typed', async () => {
    await mountSidebar()
    const before = sourcesVersion()
    await submit('work')
    await vi.waitFor(() =>
      expect(text(calendarsSection())).toContain('A calendar with this name already exists.'),
    )
    expect(made).toEqual([])
    expect(input()!.value).toBe('work')
    expect(sourcesVersion()).toBe(before)
  })

  it('refuses a name that is too long, with the reason', async () => {
    await mountSidebar()
    await submit('x'.repeat(101))
    await vi.waitFor(() => expect(text(calendarsSection())).toContain('at most 100 characters'))
    expect(made).toEqual([])
  })

  it('says why the calendar could not be made, makes none and keeps the name', async () => {
    await mountSidebar()
    service.fail = new DavError('forbidden', 'no')
    const before = sourcesVersion()
    await submit('Holidays')
    await vi.waitFor(() =>
      expect(text(calendarsSection())).toContain('The calendar could not be created'),
    )
    expect(made).toEqual([])
    expect(input()!.value).toBe('Holidays')
    expect(sourcesVersion()).toBe(before)
    // Edited, it is tried again.
    service.fail = null
    await submit('Holidays 2')
    await vi.waitFor(() => expect(made).toEqual([{ displayName: 'Holidays 2' }]))
  })

  it('cannot be sent twice while the request runs: one calendar, the button busy', async () => {
    await mountSidebar()
    let release!: () => void
    service.hold = new Promise<void>((resolve) => (release = resolve))
    await submit('Holidays')
    await vi.waitFor(() => expect(input()!.readOnly).toBe(true))
    // Read-only, not disabled: the keyboard focus can stay in the field.
    expect(input()!.disabled).toBe(false)
    addButton()!.click()
    addButton()!.click()
    release()
    await vi.waitFor(() => expect(made).toHaveLength(1))
    await vi.waitFor(() => expect(input()!.readOnly).toBe(false))
    expect(made).toEqual([{ displayName: 'Holidays' }])
  })
})
