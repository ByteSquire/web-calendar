// @vitest-environment nuxt
// The live-mode parts of the UI inside a real Nuxt UI app: the problems list, the overflow menu,
// the progress indicator and the layout's guard. The data side is tested without Nuxt (live-loader).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { OverflowMenu, SidebarProblems, TopBar, UApp } from '#components'
import DefaultLayout from '~/layouts/default.vue'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { AuthStatus } from '~/utils/auth/types'

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const OTHER_ZONE = BROWSER_ZONE === 'Australia/Sydney' ? 'Pacific/Auckland' : 'Australia/Sydney'

function useConfig(config: { demo?: boolean; issuer?: string; timezone?: string }) {
  useServerConfigState().value = {
    oidc: {
      issuer: config.issuer ?? 'https://idm.example.org/oauth2',
      clientId: 'x',
      scope: 'openid',
    },
    timezone: config.timezone ?? BROWSER_ZONE,
    demo: config.demo ?? false,
  }
}

function shell(component: object) {
  return defineComponent({
    render: () => h(UApp, null, { default: () => [h(component)] }),
  })
}

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  // The colour mode lives in Nuxt state too, and the overflow menu needs it.
  clearNuxtState((key) => key !== 'color-mode')
  document.body.innerHTML = ''
})

beforeEach(() => {
  // The colour mode lives in Nuxt state too, and the overflow menu needs it.
  clearNuxtState((key) => key !== 'color-mode')
  useConfig({})
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()

describe('problems in the sidebar', () => {
  function problems(errors: Record<string, string>, skipped: Record<string, number> = {}) {
    useNuxtApp().payload.state['$slive-errors'] = errors
    useNuxtApp().payload.state['$slive-skipped'] = skipped
  }

  it('renders nothing while all is well', async () => {
    app = await mountSuspended(shell(SidebarProblems), { attachTo: document.body })
    expect(document.querySelector('[data-sidebar-problems]')).toBeNull()
  })

  it('lists each failing calendar and source with its message and a Retry button', async () => {
    problems({ 'dav:/caldav/u/b/': 'Not reachable', 'source:views': 'Server unavailable' })
    useState('cal-calendars').value = [
      {
        id: 'dav:/caldav/u/b/',
        name: 'Beta',
        type: 'caldav',
        color: '#112233',
        defaultVisible: true,
      },
    ]
    app = await mountSuspended(shell(SidebarProblems), { attachTo: document.body })
    const items = [...document.querySelectorAll('[data-sidebar-problems] li')]
    expect(items.map(text)).toEqual([
      expect.stringContaining('Beta: Not reachable'),
      expect.stringContaining('Views: Server unavailable'),
    ])
    const retry = [...document.querySelectorAll('[data-sidebar-problems] button')]
    expect(retry.map((b) => b.getAttribute('aria-label'))).toEqual(['Retry Beta', 'Retry Views'])
    expect(
      document.querySelector('[data-sidebar-problems]')!.getAttribute('aria-labelledby'),
    ).toBeTruthy()
  })

  it('announces a problem when it appears, not when the list is shown again', async () => {
    // The role is removed again after the render that announced the problem, so record the
    // moments a role="alert" is put on an element.
    const announced: string[] = []
    const setAttribute = Element.prototype.setAttribute
    const spy = vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (name === 'role' && value === 'alert') announced.push(text(this) ?? '')
      setAttribute.call(this, name, value)
    })

    app = await mountSuspended(shell(SidebarProblems), { attachTo: document.body })
    problems({ 'source:views': 'Server unavailable' })
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    expect(announced[0]).toContain('Views')
    await vi.waitFor(() => expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0))

    // The sidebar is closed and opened again: the same problem is not announced a second time.
    app.unmount()
    app = await mountSuspended(shell(SidebarProblems), { attachTo: document.body })
    await nextTick()
    expect(document.querySelector('[data-sidebar-problems] li')).not.toBeNull()
    expect(announced).toHaveLength(1)

    // A new problem is announced.
    problems({ 'source:views': 'Server unavailable', 'source:filters': 'Not reachable' })
    await vi.waitFor(() => expect(announced).toHaveLength(2))
    expect(announced[1]).toContain('Filters')
    spy.mockRestore()
  })

  it('says how many entries could not be read, without a Retry button', async () => {
    problems({}, { 'dav:/caldav/u/a/': 2 })
    app = await mountSuspended(shell(SidebarProblems), { attachTo: document.body })
    expect(text(document.querySelector('[data-sidebar-problems] li'))).toContain(
      '2 entries could not be read and are not shown',
    )
    expect(document.querySelector('[data-sidebar-problems] button')).toBeNull()
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
  })
})

describe('overflow menu', () => {
  const menuItems = () =>
    [...document.querySelectorAll('[role^="menuitem"]')].map((item) => text(item))

  async function open() {
    app = await mountSuspended(shell(OverflowMenu), { attachTo: document.body })
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More options"]')!
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
    return trigger
  }

  it('shows the user, the zone, Refresh, Settings, Help and Sign out when signed in', async () => {
    useState('cal-user').value = { id: '7', name: 'Alice', email: 'alice@example.org' }
    await open()
    expect(menuItems()).toEqual(['Refresh', 'Settings', 'Dark mode', 'Help', 'Sign out'])
    const menu = text(document.querySelector('[role="menu"]'))!
    expect(menu).toContain('Alice')
    expect(menu).toContain('alice@example.org')
    expect(menu).toContain(`Times in ${BROWSER_ZONE}`)
    expect(menu).not.toContain('Organization time')
    expect(document.querySelector('[role="menuitem"][href="/settings"]')).not.toBeNull()
  })

  it('names the organization zone only when it differs from the display zone', async () => {
    useConfig({ timezone: OTHER_ZONE })
    await open()
    const menu = text(document.querySelector('[role="menu"]'))!
    expect(menu).toContain(`Times in ${BROWSER_ZONE}`)
    expect(menu).toContain(`Organization time: ${OTHER_ZONE}`)
  })

  it('keeps the placeholder items of the mock-up in demo mode', async () => {
    useConfig({ demo: true, issuer: '' })
    await open()
    expect(menuItems()).toEqual(['Refresh', 'Settings', 'Dark mode', 'Help'])
    expect(text(document.querySelector('[role="menu"]'))).not.toContain('Times in')
  })

  describe('full screen', () => {
    const request = vi.fn(() => Promise.resolve())
    const exit = vi.fn(() => Promise.resolve())

    function browserWithFullscreen(enabled: boolean) {
      Object.defineProperty(document, 'fullscreenEnabled', { value: enabled, configurable: true })
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
      document.documentElement.requestFullscreen = request
      document.exitFullscreen = exit
    }

    afterEach(() => {
      Reflect.deleteProperty(document, 'fullscreenEnabled')
      Reflect.deleteProperty(document, 'fullscreenElement')
      request.mockClear()
      exit.mockClear()
    })

    it('is offered where the browser has it and asks for the whole page', async () => {
      browserWithFullscreen(true)
      await open()
      expect(menuItems()).toEqual([
        'Refresh',
        'Settings',
        'Full screen',
        'Dark mode',
        'Help',
        'Sign out',
      ])

      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => text(candidate) === 'Full screen',
      )!
      item.click()
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' }))
    })

    it('says so when full screen is on, and leaves it with the same entry', async () => {
      browserWithFullscreen(true)
      Object.defineProperty(document, 'fullscreenElement', {
        value: document.documentElement,
        configurable: true,
      })
      await open()
      expect(menuItems()).toContain('Exit full screen')

      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => text(candidate) === 'Exit full screen',
      )!
      item.click()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    })

    it('is not offered where the browser has no full screen for pages', async () => {
      browserWithFullscreen(false)
      await open()
      expect(menuItems()).not.toContain('Full screen')
    })
  })

  describe('dark mode switch', () => {
    afterEach(() => {
      useColorMode().preference = 'system'
    })

    const entry = () => document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!

    it('is a single menu item that shows the scheme in use', async () => {
      useColorMode().preference = 'light'
      await open()
      expect(document.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(1)
      expect(text(entry())).toBe('Dark mode')
      expect(entry().getAttribute('aria-checked')).toBe('false')
      // The switch is a picture of the state; the item itself is the control.
      expect(entry().querySelector('button, [role="switch"]')).toBeNull()
    })

    it('is on when the dark scheme is in use', async () => {
      useColorMode().preference = 'dark'
      await open()
      expect(entry().getAttribute('aria-checked')).toBe('true')
    })

    it('stores dark when turned on and light when turned off, and stays open', async () => {
      await open()
      entry().click()
      await vi.waitFor(() => expect(useColorMode().preference).toBe('dark'))
      await vi.waitFor(() => expect(entry().getAttribute('aria-checked')).toBe('true'))
      expect(document.querySelector('[role="menu"]')).not.toBeNull()

      entry().click()
      await vi.waitFor(() => expect(useColorMode().preference).toBe('light'))
      await vi.waitFor(() => expect(entry().getAttribute('aria-checked')).toBe('false'))
    })
  })

  it('marks the trigger busy while data loads', async () => {
    useState('live-loading').value = true
    app = await mountSuspended(shell(OverflowMenu), { attachTo: document.body })
    const trigger = document.querySelector('button[aria-label="More options"]')!
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    useState('live-loading').value = false
    await nextTick()
    expect(trigger.getAttribute('aria-busy')).toBe('false')
  })
})

describe('top bar progress', () => {
  it('shows an indeterminate progress line only while loading', async () => {
    app = await mountSuspended(shell(TopBar), { attachTo: document.body })
    const progress = () => document.querySelector('[role="progressbar"]')
    expect(progress()).toBeNull()
    useState('live-loading').value = true
    await vi.waitFor(() => expect(progress()).not.toBeNull())
    expect(progress()!.getAttribute('aria-label')).toBe('Loading calendars')
    expect(progress()!.hasAttribute('aria-valuenow')).toBe(false)
    useState('live-loading').value = false
    await vi.waitFor(() => expect(progress()).toBeNull())
  })
})

describe('layout', () => {
  const layout = () =>
    defineComponent({
      render: () =>
        h(UApp, null, {
          default: () => [h(DefaultLayout, null, { default: () => h('div', 'page content') })],
        }),
    })

  it('draws nothing of the app before the user is signed in (live mode)', async () => {
    useState<AuthStatus>('auth-status').value = 'unauthenticated'
    app = await mountSuspended(layout(), { attachTo: document.body })
    expect(document.querySelector('main')).toBeNull()
    expect(document.querySelector('header')).toBeNull()
    expect(document.body.textContent).not.toContain('page content')
  })

  it('draws the app once signed in, and marks the main area busy while loading', async () => {
    useState<AuthStatus>('auth-status').value = 'authenticated'
    app = await mountSuspended(layout(), { attachTo: document.body })
    const main = () => document.querySelector('main')!
    expect(main().textContent).toContain('page content')
    expect(main().getAttribute('aria-busy')).toBe('false')
    useState('live-loading').value = true
    await vi.waitFor(() => expect(main().getAttribute('aria-busy')).toBe('true'))
  })

  it('draws the mock-up at once in demo mode', async () => {
    useConfig({ demo: true, issuer: '' })
    useState<AuthStatus>('auth-status').value = 'loading'
    app = await mountSuspended(layout(), { attachTo: document.body })
    expect(document.querySelector('main')).not.toBeNull()
  })
})
