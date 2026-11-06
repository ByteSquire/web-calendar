// @vitest-environment nuxt
// The dialog of a group calendar (from "Edit calendar" in the sidebar) inside a real Nuxt UI app,
// with a fake API behind `useAuthFetch`: what it loads and shows, what a change of the name and
// colour sends, the share dialog over it, the delete after asking, and what a person who may not
// change the calendar sees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import GroupsCalendarDialog from '~/components/groups/CalendarDialog.vue'
import type { GroupDetail } from '~/utils/groups/model'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))

const target = ref<{ groupId: number; calendarId: number; name: string } | null>(null)
const closed = vi.fn()
const deleted = vi.fn()
const Shell = defineComponent({
  render: () =>
    h(UApp, null, {
      default: () =>
        h(GroupsCalendarDialog, {
          target: target.value,
          onClose: () => {
            closed()
            target.value = null
          },
          onDeleted: deleted,
        }),
    }),
})

let detail: GroupDetail
let failSave: unknown = null
const calls: { path: string; method: string; body: unknown }[] = []
let app: Awaited<ReturnType<typeof mountSuspended>>

beforeEach(() => {
  calls.length = 0
  failSave = null
  closed.mockClear()
  deleted.mockClear()
  detail = {
    id: 3,
    name: 'staff',
    source: 'app',
    canManageMembers: true,
    canManageCalendars: true,
    canNameManagers: false,
    members: [{ sub: 'sub-me', name: 'Me', username: 'me', manager: true }],
    calendars: [
      {
        id: 7,
        name: 'Rota',
        color: '#047857',
        shares: [
          { principalType: 'group', principal: 'staff', label: 'staff', permission: 'write' },
          { principalType: 'user', principal: 'sub-anna', label: 'Anna', permission: 'read' },
        ],
      },
    ],
  }
  api.handler = async (path, options) => {
    const method = options?.method ?? 'GET'
    calls.push({ path, method, body: options?.body })
    if (path === '/api/groups/3' && method === 'GET') return detail
    if (path === '/api/groups') return { groups: [{ id: 3, name: 'staff', source: 'app' }] }
    if (path === '/api/people')
      return { people: [{ sub: 'sub-anna', name: 'Anna', username: 'anna' }] }
    if (path === '/api/groups/3/calendars/7' && method === 'PATCH') {
      if (failSave) throw failSave
      const body = options!.body as { name: string; color: string | null }
      return { calendar: { ...detail.calendars[0]!, ...body } }
    }
    if (path === '/api/groups/3/calendars/7' && method === 'DELETE') return {}
    throw new Error(`unexpected ${method} ${path}`)
  }
})

afterEach(() => {
  app?.unmount()
  target.value = null
  api.handler = null
  clearNuxtState()
  vi.restoreAllMocks()
})

async function open() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  target.value = { groupId: 3, calendarId: 7, name: 'Rota' }
  await vi.waitFor(() => expect(dialog()?.textContent).toContain('A calendar of the group staff.'))
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const dialog = (name = 'Rota') =>
  [...document.querySelectorAll('[role="dialog"]')].find((item) =>
    text(item.querySelector('h2'))?.startsWith(name),
  )
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? ''),
  )
const sent = (method: string) => calls.filter((call) => call.method === method)

describe('the dialog of a group calendar', () => {
  it('loads the group and shows the calendar with whom it is shared', async () => {
    await open()
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining(['/api/groups/3', '/api/groups', '/api/people']),
    )
    expect(text(dialog())).toContain('Anna')
    expect(button(/^Save changes$/)).toBeDefined()
    expect(button(/^Change sharing$/)).toBeDefined()
    expect(button(/^Delete calendar$/)).toBeDefined()
  })

  it('saves the name and colour, and says so in the dialog', async () => {
    await open()
    const name = dialog()!.querySelector<HTMLInputElement>('input[autocomplete="off"]')!
    name.value = 'Rota 2'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    button(/^Save changes$/)!.click()
    await vi.waitFor(() => expect(sent('PATCH')).toHaveLength(1))
    expect(sent('PATCH')[0]).toMatchObject({
      path: '/api/groups/3/calendars/7',
      body: { name: 'Rota 2', color: '#047857' },
    })
    await vi.waitFor(() => expect(text(document.body)).toContain('Rota 2 was saved.'))
    expect(closed).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when the save is refused', async () => {
    failSave = { statusCode: 403, data: { statusCode: 403, message: 'Forbidden' } }
    await open()
    button(/^Save changes$/)!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Could not save the calendar.'))
    expect(closed).not.toHaveBeenCalled()
  })

  it('opens the share dialog over it', async () => {
    await open()
    button(/^Change sharing$/)!.click()
    await vi.waitFor(() => expect(dialog('Share Rota')).toBeDefined())
    expect(text(dialog('Share Rota'))).toContain('Anna')
  })

  it('deletes the calendar only after asking, then closes and says so', async () => {
    await open()
    button(/^Delete calendar$/)!.click()
    await vi.waitFor(() => expect(text(document.body)).toContain('Delete "Rota"?'))
    expect(sent('DELETE')).toHaveLength(0)
    button(/^Delete$/)!.click()
    await vi.waitFor(() => expect(sent('DELETE')).toHaveLength(1))
    expect(sent('DELETE')[0]!.path).toBe('/api/groups/3/calendars/7')
    await vi.waitFor(() => expect(closed).toHaveBeenCalled())
    expect(deleted).toHaveBeenCalledWith('Rota was deleted.')
  })

  it('offers nothing to change to somebody who no longer manages the group', async () => {
    detail = { ...detail, canManageCalendars: false }
    await open()
    expect(document.querySelector('[data-group-calendar-read-only]')).not.toBeNull()
    expect(button(/^Save changes$/)).toBeUndefined()
    expect(button(/^Delete calendar$/)).toBeUndefined()
  })

  it('says so when the calendar is gone from the group', async () => {
    detail = { ...detail, calendars: [] }
    app = await mountSuspended(Shell, { attachTo: document.body })
    target.value = { groupId: 3, calendarId: 7, name: 'Rota' }
    await vi.waitFor(() =>
      expect(text(document.body)).toContain('This calendar no longer exists. Reload the page.'),
    )
  })
})
