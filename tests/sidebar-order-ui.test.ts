// @vitest-environment nuxt
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useNuxtApp } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, UApp } from '#components'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { useSidebarOrderState } from '~/composables/useSidebarOrder'
import { SIDEBAR_SECTION_IDS, type SidebarSectionId } from '../shared/utils/sidebar-sections'

// The order of the sidebar's sections (FR-21): drawn in the saved order, moved with the arrow
// buttons or by dragging the headings, and saved for the account with PUT /api/me/sidebar-order.

const puts: { path: string; body: unknown }[] = []
const server = { failPut: false }

vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => async (path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method === 'PUT') {
      puts.push({ path, body: options.body })
      if (server.failPut) throw new Error('offline')
      return {}
    }
    return { isAdmin: false }
  },
}))

const caldav = { client: {}, reader: { invalidate: () => undefined } }

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
  puts.length = 0
  server.failPut = false
  clearNuxtState((key) => key !== 'color-mode')
  window.localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
afterAll(() => {
  server.failPut = false
})

async function mountSidebar(demo = false) {
  config(demo)
  app = await mountSuspended(Shell, { attachTo: document.body })
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const sections = () => [...document.querySelectorAll<HTMLElement>('section[data-section-id]')]
const shown = () => sections().map((section) => section.dataset.sectionId)
const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === name || text(button) === name,
  )

describe('the order of the sections', () => {
  it('is the default order for someone who never arranged them', async () => {
    await mountSidebar(true)
    expect(shown()).toEqual([...SIDEBAR_SECTION_IDS])
  })

  it('follows the saved order, which is also the Tab and reading order of the page', async () => {
    await mountSidebar(true)
    useSidebarOrderState().value = ['filters', 'resources', 'views', 'categories', 'calendars']
    await vi.waitFor(() =>
      expect(shown()).toEqual(['filters', 'resources', 'views', 'categories', 'calendars']),
    )
    expect(sections().map((section) => text(section.querySelector('h2')))).toEqual([
      'Filters',
      'Resources',
      'Views',
      'Categories',
      'Calendars',
    ])
  })
})

describe('arranging with the arrow buttons', () => {
  async function arrange() {
    await mountSidebar()
    buttonNamed('Arrange sections')!.click()
    await vi.waitFor(() => expect(buttonNamed('Move Views down')).toBeDefined())
  }

  it('replaces the sections with a list of them, the first one unable to go up and the last down', async () => {
    await arrange()
    expect(sections()).toHaveLength(0)
    expect(buttonNamed('Move Views up')!.disabled).toBe(true)
    expect(buttonNamed('Move Filters down')!.disabled).toBe(true)
    expect(buttonNamed('Move Calendars up')!.disabled).toBe(false)
  })

  it('moves a section, saves the order for the account and says where it went', async () => {
    await arrange()
    buttonNamed('Move Calendars up')!.click()
    await vi.waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({
      path: '/api/me/sidebar-order',
      body: { order: ['calendars', 'views', 'resources', 'categories', 'filters'] },
    })
    expect(useSidebarOrderState().value[0]).toBe('calendars')
    expect(document.querySelector('[role="status"]')!.textContent).toContain(
      'Calendars: number 1 of 5',
    )
    // The focus stays on the button; the one that was pressed is disabled now, so it is its twin.
    await vi.waitFor(() => expect(document.activeElement).toBe(buttonNamed('Move Calendars down')))
  })

  it('keeps the focus on the button that was pressed while it can be pressed again', async () => {
    await arrange()
    buttonNamed('Move Resources down')!.click()
    await vi.waitFor(() => expect(puts).toHaveLength(1))
    await vi.waitFor(() => expect(document.activeElement).toBe(buttonNamed('Move Resources down')))
  })

  it('says so when the order could not be saved, and keeps the new order on the screen', async () => {
    await arrange()
    server.failPut = true
    buttonNamed('Move Calendars up')!.click()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Could not save the order of the sections.'),
    )
    expect(useSidebarOrderState().value[0]).toBe('calendars')
  })

  it('sends one request per move, one after the other', async () => {
    await arrange()
    buttonNamed('Move Calendars up')!.click()
    buttonNamed('Move Filters up')!.click()
    await vi.waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((put) => (put.body as { order: string[] }).order[0])).toEqual([
      'calendars',
      'calendars',
    ])
    expect((puts[1]!.body as { order: string[] }).order).toEqual([
      'calendars',
      'views',
      'resources',
      'filters',
      'categories',
    ])
  })

  it('closes with Done and puts the focus on the button that opened it', async () => {
    await arrange()
    buttonNamed('Done')!.click()
    await vi.waitFor(() => expect(sections()).toHaveLength(5))
    expect(document.activeElement).toBe(buttonNamed('Arrange sections'))
  })

  it('saves nothing in the demo, where there is no account', async () => {
    await mountSidebar(true)
    buttonNamed('Arrange sections')!.click()
    await vi.waitFor(() => expect(buttonNamed('Move Calendars up')).toBeDefined())
    buttonNamed('Move Calendars up')!.click()
    await vi.waitFor(() => expect(useSidebarOrderState().value[0]).toBe('calendars'))
    expect(puts).toEqual([])
  })
})

describe('dragging the headings', () => {
  // happy-dom has no layout: five headings of 44 px, 12 px apart, in the order they are in.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = sections().indexOf(this)
      const top = index === -1 ? 0 : index * 56
      const height = index === -1 ? 0 : 44
      return { top, bottom: top + height, left: 0, right: 200, width: 200, height } as DOMRect
    })
  })

  const heading = (id: SidebarSectionId) =>
    document.querySelector<HTMLElement>(`section[data-section-id="${id}"] h2 button`)!
  const pointer = (type: string, target: EventTarget, y: number, pointerType = 'mouse') =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        pointerType,
        button: 0,
        clientX: 20,
        clientY: y,
      }),
    )

  it('does nothing for a click, or for a press that hardly moves', async () => {
    await mountSidebar(true)
    pointer('pointerdown', heading('views'), 20)
    pointer('pointermove', window, 23)
    pointer('pointerup', window, 23)
    expect(document.querySelector('[data-dragging]')).toBeNull()
    expect(shown()).toEqual([...SIDEBAR_SECTION_IDS])
  })

  it('takes a section to the place where the pointer is let go, saves it and does not fold it', async () => {
    await mountSidebar()
    const folded = heading('views').getAttribute('aria-expanded')
    pointer('pointerdown', heading('views'), 20)
    pointer('pointermove', window, 60)
    await vi.waitFor(() => expect(document.querySelector('[data-dragging="true"]')).not.toBeNull())
    // Every section shows only its heading while one is in the hand.
    const body = document.getElementById(heading('calendars').getAttribute('aria-controls')!)!
    expect(body.style.display).toBe('none')
    pointer('pointermove', window, 56 * 3 + 20)
    await vi.waitFor(() =>
      expect(shown()).toEqual(['calendars', 'resources', 'categories', 'views', 'filters']),
    )
    pointer('pointerup', window, 56 * 3 + 20)
    await vi.waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.body).toEqual({
      order: ['calendars', 'resources', 'categories', 'views', 'filters'],
    })
    expect(document.querySelector('[data-dragging]')).toBeNull()
    expect(body.style.display).not.toBe('none')
    // The click that follows the release does not fold the section.
    heading('views').click()
    expect(heading('views').getAttribute('aria-expanded')).toBe(folded)
  })

  it('puts everything back on Escape', async () => {
    await mountSidebar()
    pointer('pointerdown', heading('views'), 20)
    pointer('pointermove', window, 56 * 2 + 20)
    await vi.waitFor(() => expect(shown()[2]).toBe('views'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(shown()).toEqual([...SIDEBAR_SECTION_IDS]))
    pointer('pointerup', window, 56 * 2 + 20)
    expect(puts).toEqual([])
    expect(document.querySelector('[data-dragging]')).toBeNull()
  })

  it('needs a long press on a touch screen, and leaves a finger that moves first to the scrolling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await mountSidebar(true)
      // A finger that moves before the press is long enough is scrolling.
      pointer('pointerdown', heading('views'), 20, 'touch')
      pointer('pointermove', window, 60, 'touch')
      vi.advanceTimersByTime(600)
      expect(document.querySelector('[data-dragging]')).toBeNull()
      pointer('pointerup', window, 60, 'touch')

      // A finger that rests picks the section up.
      pointer('pointerdown', heading('views'), 20, 'touch')
      vi.advanceTimersByTime(300)
      expect(document.querySelector('[data-dragging]')).toBeNull()
      vi.advanceTimersByTime(300)
      expect(document.querySelector('[data-dragging="true"]')).not.toBeNull()
      pointer('pointerup', window, 20, 'touch')
      expect(document.querySelector('[data-dragging]')).toBeNull()
      expect(shown()).toEqual([...SIDEBAR_SECTION_IDS])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start from the plus beside a heading', async () => {
    await mountSidebar(true)
    const plus = document.querySelector<HTMLButtonElement>('section button[aria-label="Add view"]')!
    pointer('pointerdown', plus, 20)
    pointer('pointermove', window, 100)
    expect(document.querySelector('[data-dragging]')).toBeNull()
    pointer('pointerup', window, 100)
  })
})
