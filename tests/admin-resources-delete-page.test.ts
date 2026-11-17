// @vitest-environment nuxt
// Deleting a resource on Admin › Resources, from the "Resource" tab of its dialog: it asks first, a
// confirmed delete removes the row and closes the dialog, and a resource with bookings stays and the
// question says to deactivate it instead (and a toast says it too).
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
const notes = vi.hoisted(() => ({ done: vi.fn(), failed: vi.fn() }))
vi.mock('~/composables/useNotify', () => ({ useNotify: () => notes }))

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
  notes.done.mockReset()
  notes.failed.mockReset()
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
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')]
// The question, over the dialog of the resource.
const dialog = () => dialogs().find((item) => text(item)?.includes('Delete "'))
const deletes = () => calls.filter((call) => call.method === 'DELETE')

async function mountPage() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(rows()).toHaveLength(2))
}

/** Opens the dialog of a resource and asks to delete it there. */
async function askDelete(name: string) {
  button(new RegExp(`^Edit ${name}$`))!.focus()
  button(new RegExp(`^Edit ${name}$`))!.click()
  await vi.waitFor(() => expect(button(/^Delete resource$/)).toBeDefined())
  expect(text(dialogs()[0])).toContain('A resource with bookings cannot be deleted')
  button(/^Delete resource$/)!.click()
  await vi.waitFor(() => expect(text(dialog())).toContain(`Delete "${name}"?`))
}

describe('deleting a resource', () => {
  it('asks first and sends nothing until it is confirmed', async () => {
    await mountPage()
    // a row has no Delete of its own
    expect(button(/^Delete Board room$/)).toBeUndefined()
    await askDelete('Board room')
    expect(deletes()).toHaveLength(0)
    button(/^Cancel$/, dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeUndefined())
    // back in the dialog of the resource
    expect(dialogs()).toHaveLength(1)
    expect(deletes()).toHaveLength(0)
    expect(rows()).toHaveLength(2)
  })

  it('removes the row and closes the dialog when confirmed', async () => {
    await mountPage()
    await askDelete('Old van')
    button(/^Delete$/, dialog()!)!.click()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(deletes()).toEqual([{ path: '/api/admin/resources/2', method: 'DELETE' }])
    expect(rows()[0]).toContain('Board room')
    await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
    expect(notes.done.mock.calls).toEqual([['Old van was deleted.']])
    expect(api.refresh).toHaveBeenCalledTimes(1)
    // the row that opened it is gone: focus goes to "New resource"
    await vi.waitFor(() => expect(document.activeElement).toBe(button(/^New resource$/)))
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
    await askDelete('Board room')
    button(/^Delete$/, dialog()!)!.click()
    const why = 'The resource has bookings, so it cannot be deleted. Deactivate it instead.'
    await vi.waitFor(() => expect(text(dialog())).toContain(why))
    expect(notes.failed.mock.calls).toEqual([[why]])
    // told in the question only, not again behind it
    expect(dialogs()[0]!.querySelector('[role="alert"]')).toBeNull()
    expect(rows()).toHaveLength(2)
    expect(deletes()).toHaveLength(1)
  })
})
