// @vitest-environment nuxt
// Admin › People inside a real Nuxt UI app, with a fake API behind `useAuthFetch`: who is sent
// away, who is listed and searched, what the details of a person show, and the truncation note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import PeoplePage from '~/pages/admin/people.vue'
import type { AdminPerson, AdminPersonDetail } from '~/utils/admin/people'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(PeoplePage) }) })

const ME = { id: 1, sub: 's', username: 'alice', name: 'Alice', email: null, timeZone: null }
const person = (id: number, extra: Partial<AdminPerson> = {}): AdminPerson => ({
  id,
  sub: `sub-${id}`,
  name: null,
  username: null,
  adminAtLastSignIn: false,
  lastSeenAt: null,
  ...extra,
})

const calls: { path: string; method: string }[] = []
let admin = true
let truncated = false
let people: AdminPerson[]
let detail: AdminPersonDetail
let app: Awaited<ReturnType<typeof mountSuspended>>
let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  calls.length = 0
  admin = true
  truncated = false
  people = [
    person(2, { name: 'Alice Admin', username: 'alice', adminAtLastSignIn: true }),
    person(3, { name: 'Bob Builder', username: 'bob' }),
    person(4, { username: 'carol' }),
  ]
  detail = {
    ...person(3, { name: 'Bob Builder', username: 'bob' }),
    groups: [
      { id: 1, name: 'Staff', source: 'local', manager: true },
      { id: 2, name: 'Everyone', source: 'everyone', manager: false },
    ],
    calendars: [{ id: 10, name: 'Bob private' }],
    shared: [
      { id: 11, name: 'Team', kind: 'shared', owner: null },
      { id: 12, name: 'Personal Calendar', kind: 'personal', owner: 'Alice Admin' },
    ],
    links: [
      {
        id: 1,
        label: 'Website',
        calendarName: 'Team',
        level: 'free_busy',
        createdAt: '2026-11-01T10:00:00.000Z',
        lastUsedAt: null,
      },
    ],
  }
  replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  api.handler = async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET' })
    if (path === '/api/me') {
      // mountSuspended navigates to '/' itself; only a call after this answer comes from the page.
      replace.mockClear()
      return { ...ME, isAdmin: admin }
    }
    if (path === '/api/admin/people') return { people, truncated }
    if (path === '/api/admin/people/3') return detail
    throw new Error(`unexpected ${path}`)
  }
})

afterEach(() => {
  app.unmount()
  api.handler = null
  clearNuxtState()
  vi.restoreAllMocks()
})

async function mountPage() {
  app = await mountSuspended(Shell, { attachTo: document.body })
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rows = () => [...document.querySelectorAll('[data-admin-person]')].map((li) => text(li))
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
const dialogText = () => text(document.querySelector('[role="dialog"]'))

function search(value: string) {
  const label = [...document.querySelectorAll('label')].find((item) =>
    text(item)?.startsWith('Search people'),
  )
  const input = document.getElementById(label!.getAttribute('for')!) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('who sees the page', () => {
  it('sends a user who is not an admin back to the calendar without asking for people', async () => {
    admin = false
    await mountPage()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(calls.map((call) => call.path)).toEqual(['/api/me'])
    expect(rows()).toHaveLength(0)
  })
})

describe('as an admin', () => {
  it('lists the people, with an Admin badge for those who were admins at their last sign-in', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    expect(document.querySelector('h1')?.textContent).toBe('People')
    expect(rows()[0]).toContain('Alice Admin (alice)')
    expect(rows()[0]).toContain('Admin')
    expect(rows()[0]).toContain('No sign-in recorded')
    expect(rows()[1]).toContain('Bob Builder (bob)')
    expect(rows()[1]).not.toMatch(/\bAdmin\b/)
    expect(rows()[2]).toContain('carol')
    expect(text(document.body)).not.toContain('Only the first')
  })

  it('searches by name and by user name, ignoring case', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    search('BUILD')
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toContain('Bob Builder')
    search('carol')
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toContain('carol')
    search('nobody-like-this')
    await vi.waitFor(() => expect(rows()).toHaveLength(0))
    expect(text(document.querySelector('[data-people-none]'))).toBe('Nobody matches.')
  })

  it('says so when nobody has signed in yet', async () => {
    people = []
    await mountPage()
    await vi.waitFor(() => expect(document.querySelector('[data-people-none]')).not.toBeNull())
    expect(text(document.querySelector('[data-people-none]'))).toBe('Nobody has signed in yet.')
  })

  it('says how many people are listed when the list was cut', async () => {
    truncated = true
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    expect(text(document.body)).toContain('Only the first 3 people are listed, sorted by name.')
  })

  it('opens a person: groups with the Manager badge, calendars, shares and links', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    button(/^Open Bob Builder \(bob\)$/)!.click()
    await vi.waitFor(() => expect(dialogText()).toContain('Bob private'))
    expect(calls.filter((call) => call.path === '/api/admin/people/3')).toHaveLength(1)
    const dialog = dialogText()!
    expect(dialog).toContain('Staff')
    expect(dialog).toMatch(/Staff.*Manager/)
    expect(dialog).toContain('Everyone')
    expect(dialog.match(/Manager/g)).toHaveLength(1)
    expect(dialog).toContain('Team')
    expect(dialog).toContain('Personal Calendar (Alice Admin)')
    expect(dialog).toContain('Website: Team, Busy times only')
    expect(dialog).not.toContain('In no group.')
  })

  it('links a calendar to the Calendars page, searching for its name', async () => {
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    button(/^Open Bob Builder/)!.click()
    await vi.waitFor(() => expect(dialogText()).toContain('Bob private'))
    const link = [...document.querySelectorAll('[role="dialog"] a')].find(
      (item) => text(item) === 'Bob private',
    )
    expect(link?.getAttribute('href')).toBe('/admin/calendars?q=Bob+private')
  })

  it('says what is empty for a person with nothing', async () => {
    detail = { ...detail, groups: [], calendars: [], shared: [], links: [] }
    await mountPage()
    await vi.waitFor(() => expect(rows()).toHaveLength(3))
    button(/^Open Bob Builder/)!.click()
    await vi.waitFor(() => expect(dialogText()).toContain('In no group.'))
    expect(dialogText()).toContain('No calendar of their own yet.')
    expect(dialogText()).toContain('No calendar is shared with them.')
    expect(dialogText()).toContain('No links.')
  })
})
