// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import CalendarLinks from '~/components/links/CalendarLinks.vue'
import type { CalendarLinkItem } from '~/utils/settings/links'
import {
  FakeBackend,
  alerts,
  dialog,
  errorTexts,
  field,
  keydown,
  reply,
  requireButton,
  stubClipboard,
  toasts,
  type,
} from './settings-helpers'

const state = vi.hoisted(() => ({ backend: null as FakeBackend | null }))
vi.mock('~/composables/useAuthFetch', async () =>
  (await import('./settings-helpers')).authFetchModule(state)(),
)

// The links of a calendar as the access page shows them (LinksCalendarLinks with a calendar id):
// the list, the dialog that makes a link and then shows its details, the password that is asked
// of the server only when it is to be shown, and removing a link. The API is answered by
// `override`; FakeBackend knows nothing of links.

const LIST = '/api/admin/access/calendars/7/links'
const SLUG = 'S'.repeat(43)

const link = (id: number, extra: Partial<CalendarLinkItem> = {}): CalendarLinkItem => ({
  id,
  label: `Link ${id}`,
  calendarName: 'Team',
  calendarColor: '#1d4ed8',
  calendarId: 7,
  level: 'read',
  readsAs: 'owner',
  maker: 'alice',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: null,
  slug: SLUG,
  ...extra,
})

const Shell = defineComponent({
  render: () =>
    h(UApp, null, {
      default: () => h(CalendarLinks, { title: 'Links', calendarId: 7, calendarName: 'Team' }),
    }),
})

let backend: FakeBackend
let app: Awaited<ReturnType<typeof mountSuspended>>
let links: CalendarLinkItem[]

async function mountLinks() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(backend.callsTo('GET', LIST)).toHaveLength(1))
  await vi.waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull())
}

const rows = () => [...document.querySelectorAll('[data-calendar-link]')]
const reveals = () => backend.calls.filter((call) => call.path.endsWith('/reveal'))

beforeEach(() => {
  backend = new FakeBackend()
  state.backend = backend
  links = [link(3, { label: 'Front desk', level: 'free_busy' })]
  backend.override = (call) => {
    if (call.method === 'GET' && call.path === LIST) return reply.json({ links })
    if (call.method === 'POST' && call.path === LIST) {
      const body = call.body as { label?: string; level: 'read' | 'free_busy' }
      const made = link(20, {
        label: body.label ?? 'Team',
        level: body.level,
        slug: 'N'.repeat(43),
      })
      links = [made, ...links]
      return reply.json({ link: made }, 201)
    }
    if (call.method === 'POST' && call.path === '/api/admin/access/links/3/reveal') {
      return reply.json({ password: 'front desk secret' })
    }
    if (call.method === 'DELETE' && call.path === '/api/admin/access/links/3') {
      links = links.filter((item) => item.id !== 3)
      return reply.empty()
    }
    return undefined
  }
})

afterEach(() => {
  app.unmount()
  state.backend = null
  clearNuxtState()
  vi.restoreAllMocks()
})

describe('the list', () => {
  it('shows the label, the summary and "Details", and nothing of the address or the password', async () => {
    await mountLinks()
    const [row] = rows()
    expect(row!.textContent).toContain('Front desk')
    expect(row!.textContent).toContain('Busy times only')
    expect(row!.querySelectorAll('button')).toHaveLength(1)
    const details = requireButton('Details of Front desk')
    expect(details.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row!.textContent).not.toContain('Hidden')
    expect(row!.textContent).not.toContain('••')
    expect(row!.querySelector('input')).toBeNull()
  })
})

describe('the details of a link', () => {
  it('open in a dialog with the address; the password is asked of the server only when shown', async () => {
    await mountLinks()
    const opener = requireButton('Details of Front desk')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Front desk')
    const address = dialog()!.querySelector<HTMLInputElement>(
      'input[aria-label="Address of Front desk"]',
    )!
    expect(address.value).toMatch(new RegExp(`/link/${SLUG}$`))
    await vi.waitFor(() => expect(document.activeElement).toBe(address))
    expect(dialog()!.textContent).toContain('Hidden')
    expect(reveals()).toEqual([])

    const show = requireButton('Show the password of Front desk', dialog()!)
    expect(show.getAttribute('aria-pressed')).toBe('false')
    show.click()
    await vi.waitFor(() =>
      expect(
        dialog()!.querySelector<HTMLInputElement>('input[aria-label="Password of Front desk"]')
          ?.value,
      ).toBe('front desk secret'),
    )
    expect(show.getAttribute('aria-pressed')).toBe('true')
    expect(reveals()).toHaveLength(1)

    // closed and opened again, the password is forgotten
    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(document.body.innerHTML).not.toContain('front desk secret')
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.querySelector('input[aria-label="Password of Front desk"]')).toBeNull()
  })

  it('copies the address and says so in the dialog', async () => {
    const written: string[] = []
    const restore = stubClipboard(async (text) => void written.push(text))
    try {
      await mountLinks()
      requireButton('Details of Front desk').click()
      await vi.waitFor(() => expect(dialog()).not.toBeNull())
      requireButton('Copy the address of Front desk', dialog()!).click()
      await vi.waitFor(() =>
        expect(dialog()!.querySelector('[role="status"]')!.textContent).toContain(
          'Copied to the clipboard.',
        ),
      )
      expect(written[0]).toMatch(new RegExp(`/link/${SLUG}$`))
    } finally {
      restore()
    }
  })

  it('tells in the dialog and in a toast when the password cannot be had', async () => {
    await mountLinks()
    const answer = backend.override!
    backend.override = (call) =>
      call.path.endsWith('/reveal') ? reply.error(500, 'boom') : answer(call)
    requireButton('Details of Front desk').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Show the password of Front desk', dialog()!).click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toContain(
      'Could not show the password.',
    )
    await vi.waitFor(() => expect(toasts()[0]).toContain('Could not show the password.'))
  })
})

describe('making a link', () => {
  it('opens a dialog; after creating, the dialog shows the new link with the typed password', async () => {
    await mountLinks()
    const opener = requireButton('Create link')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()?.querySelector('form')).toBeTruthy())
    expect(dialog()!.textContent).toContain('New link')
    // the form is in the dialog only
    expect(document.querySelector('[data-calendar-link] form')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(field('Label', dialog()!)))

    const submit = () => requireButton(/^(Create link|Creating…)$/, dialog()!)
    type(field('Label', dialog()!), 'For the parents')
    type(field('Password', dialog()!), 'short')
    submit().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toContain('Choose a password of at least 8 characters.'),
    )
    expect(backend.callsTo('POST', LIST)).toHaveLength(0)
    expect(toasts()).toEqual([])

    type(field('Password', dialog()!), 'correct horse')
    submit().click()
    await vi.waitFor(() => expect(dialog()!.querySelector('form')).toBeNull())
    expect(backend.callsTo('POST', LIST)[0]!.body).toEqual({
      label: 'For the parents',
      level: 'read',
      password: 'correct horse',
    })
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('For the parents'),
      expect.stringContaining('Front desk'),
    ])
    await vi.waitFor(() => expect(toasts()[0]).toContain('Link “For the parents” created.'))
    expect(dialog()!.textContent).toContain('For the parents')
    expect(
      dialog()!.querySelector<HTMLInputElement>('input[aria-label="Address of For the parents"]')!
        .value,
    ).toMatch(/\/link\/N{43}$/)
    expect(dialog()!.textContent).toContain('Hidden')

    // the password just typed is shown without asking the server
    requireButton('Show the password of For the parents', dialog()!).click()
    await vi.waitFor(() =>
      expect(
        dialog()!.querySelector<HTMLInputElement>('input[aria-label="Password of For the parents"]')
          ?.value,
      ).toBe('correct horse'),
    )
    expect(reveals()).toEqual([])

    requireButton('Done', dialog()!).click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(document.body.innerHTML).not.toContain('correct horse')
  })

  it('keeps the dialog open with the reason, in a toast too, when the server refuses', async () => {
    await mountLinks()
    const answer = backend.override!
    backend.override = (call) =>
      call.method === 'POST' && call.path === LIST ? reply.error(500, 'boom') : answer(call)
    requireButton('Create link').click()
    await vi.waitFor(() => expect(dialog()?.querySelector('form')).toBeTruthy())
    type(field('Password', dialog()!), 'correct horse')
    requireButton('Create link', dialog()!).click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(dialog()!.querySelector('form')).not.toBeNull()
    await vi.waitFor(() => expect(toasts()).toHaveLength(1))
    expect(rows()).toHaveLength(1)
  })
})

describe('removing a link', () => {
  it('is in the details, asks first, removes the row, closes and says so in a toast', async () => {
    await mountLinks()
    requireButton('Details of Front desk').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Remove link Front desk').click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(2))
    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((item) =>
      item.textContent?.includes('Remove the link “Front desk”?'),
    )!
    requireButton('Remove link', confirm).click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(rows()).toHaveLength(0)
    expect(document.body.textContent).toContain('There are no links to Team yet.')
    expect(toasts()).toContain('Link “Front desk” removed.')
    expect(backend.callsTo('DELETE', '/api/admin/access/links/3')).toHaveLength(1)
    // the button that opened the details is gone: the focus goes to the heading
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Links'))
  })
})
