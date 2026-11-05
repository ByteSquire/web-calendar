// @vitest-environment nuxt
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useNuxtApp } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import { useServerConfigState } from '~/composables/useServerConfigState'

// On a small screen the plus of a section opens a pop-up with the field instead of showing it under
// the heading: the on-screen keyboard would cover a field low on the page.

vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => async () => ({ isAdmin: false }),
}))

const made: string[] = []
const caldav = {
  client: {
    createCalendar: async (args: { displayName: string }) => {
      made.push(args.displayName)
      return { url: '/caldav/alice/new/', displayName: args.displayName }
    },
  },
  reader: { invalidate: () => undefined },
}

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(SidebarContent) }) })
const realMatchMedia = window.matchMedia
let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

beforeAll(() => {
  useNuxtApp().provide('caldav', caldav)
})
beforeEach(() => {
  made.length = 0
  clearNuxtState((key) => key !== 'color-mode')
  window.localStorage.clear()
  // A phone: the desktop query (min-width: 768px) does not match.
  window.matchMedia = ((query: string) => ({
    matches: !query.includes('min-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  window.matchMedia = realMatchMedia
})
afterAll(() => {
  window.matchMedia = realMatchMedia
})

async function mountSidebar() {
  useServerConfigState().value = {
    oidc: { issuer: 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: 'Europe/Berlin',
    demo: false,
    signinWindowDays: 30,
  }
  app = await mountSuspended(Shell, { attachTo: document.body })
  useCalendarState().calendars.value = []
}

const plus = () =>
  document.querySelector<HTMLButtonElement>('section button[aria-label="Add calendar"]')!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const field = () => dialog()?.querySelector<HTMLInputElement>('input') ?? null
const named = (name: string) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent?.trim() === name,
  )

describe('the plus of a section on a small screen', () => {
  it('opens a pop-up with a titled, labelled field instead of a field under the heading', async () => {
    await mountSidebar()
    expect(plus().getAttribute('aria-haspopup')).toBe('dialog')
    expect(plus().hasAttribute('aria-expanded')).toBe(false)
    plus().click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Add calendar')
    expect(dialog()!.textContent).toContain('New calendar name')
    // Nothing is shown under the heading as well.
    expect(
      [...document.querySelectorAll('section')].some(
        (section) => !dialog()!.contains(section) && section.querySelector('input'),
      ),
    ).toBe(false)
    await vi.waitFor(() => expect(document.activeElement).toBe(field()))
  })

  it('adds the calendar and closes, and Cancel closes without adding', async () => {
    await mountSidebar()
    plus().click()
    await vi.waitFor(() => expect(field()).not.toBeNull())
    named('Cancel')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(made).toEqual([])

    plus().click()
    await vi.waitFor(() => expect(field()).not.toBeNull())
    field()!.value = ' Holidays '
    field()!.dispatchEvent(new Event('input', { bubbles: true }))
    named('Add')!.click()
    await vi.waitFor(() => expect(made).toEqual(['Holidays']))
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('stays open with the message when the name is refused', async () => {
    await mountSidebar()
    useCalendarState().calendars.value = [
      {
        id: 'dav:/caldav/alice/work/',
        name: 'Work',
        color: '#1d4ed8',
        type: 'caldav',
        href: '/caldav/alice/work/',
        writable: true,
      } as never,
    ]
    plus().click()
    await vi.waitFor(() => expect(field()).not.toBeNull())
    field()!.value = 'work'
    field()!.dispatchEvent(new Event('input', { bubbles: true }))
    named('Add')!.click()
    await vi.waitFor(() =>
      expect(dialog()!.textContent).toContain('A calendar with this name already exists.'),
    )
    expect(made).toEqual([])
  })
})
