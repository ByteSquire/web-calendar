// @vitest-environment nuxt
// Deleting a resource on Admin › Resources: it asks first, a confirmed delete removes the row,
// and a resource with bookings stays and the dialog says to deactivate it instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import ResourcesPage from '~/pages/admin/resources.vue'
import type { AdminResource } from '~/utils/admin/resources'

type Handler = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
const api = vi.hoisted(() => ({ handler: null as null | Handler, refresh: vi.fn() }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string, options?: { method?: string; body?: unknown }) =>
    api.handler!(path, options),
}))
vi.mock('~/composables/useLiveCalendar', () => ({
  useLiveStatus: () => ({ refresh: api.refresh }),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(ResourcesPage) }) })

const ME = { id: 1, sub: 's', username: 'alice', name: 'Alice', email: null, timeZone: null }
const start = (): AdminResource[] => [
  {
    id: 1,
    name: 'Board room',
    type: 'room',
    location: null,
    capacity: null,
    description: null,
    active: true,
  },
  {
    id: 2,
    name: 'Old van',
    type: 'car',
    location: null,
    capacity: null,
    description: null,
    active: false,
  },
]

const calls: { path: string; method: string }[] = []
let failure: unknown = null
let resources: AdminResource[]
let app: Awaited<ReturnType<typeof mountSuspended>>

beforeEach(() => {
  calls.length = 0
  failure = null
  resources = start()
  api.refresh.mockReset()
  const replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  api.handler = async (path, options) => {
    const method = options?.method ?? 'GET'
    calls.push({ path, method })
    if (path === '/api/me') return { ...ME, isAdmin: true }
    if (path === '/api/groups') return { groups: [] }
    if (path === '/api/admin/access/users') return { users: [] }
    if (path === '/api/admin/resources' && method === 'GET') return { resources }
    if (/^\/api\/admin\/resources\/\d+$/.test(path) && method === 'DELETE') {
      if (failure) throw failure
      const id = Number(path.split('/').pop())
      resources = resources.filter((item) => item.id !== id)
      return {}
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
})

afterEach(() => {
  app.unmount()
  api.handler = null
  clearNuxtState()
  vi.restoreAllMocks()
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const rows = () => [...document.querySelectorAll('[data-resource]')].map((li) => text(li))
const button = (name: RegExp, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent ?? ''),
  )
const dialog = () => document.querySelector('[role="dialog"]')
const deletes = () => calls.filter((call) => call.method === 'DELETE')

async function mountPage() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(rows()).toHaveLength(2))
}

describe('deleting a resource', () => {
  it('asks first and sends nothing until it is confirmed', async () => {
    await mountPage()
    button(/^Delete Board room$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Delete "Board room"?'))
    expect(deletes()).toHaveLength(0)
    button(/^Cancel$/, dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(deletes()).toHaveLength(0)
    expect(rows()).toHaveLength(2)
  })

  it('removes the row when confirmed', async () => {
    await mountPage()
    button(/^Delete Old van$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Delete "Old van"?'))
    button(/^Delete$/, dialog()!)!.click()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(deletes()).toEqual([{ path: '/api/admin/resources/2', method: 'DELETE' }])
    expect(rows()[0]).toContain('Board room')
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('keeps a resource with bookings and says to deactivate it instead', async () => {
    failure = {
      statusCode: 409,
      data: {
        statusCode: 409,
        message: 'The resource has bookings; deactivate it instead',
        data: { code: 'has_bookings' },
      },
    }
    await mountPage()
    button(/^Delete Board room$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Delete "Board room"?'))
    button(/^Delete$/, dialog()!)!.click()
    await vi.waitFor(() =>
      expect(text(dialog())).toContain(
        'The resource has bookings, so it cannot be deleted. Deactivate it instead.',
      ),
    )
    expect(rows()).toHaveLength(2)
    expect(deletes()).toHaveLength(1)
  })
})
