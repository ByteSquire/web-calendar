// @vitest-environment nuxt
// The page "Resource bookings" in live mode inside a real Nuxt UI app, with a fake API behind
// `useAuthFetch`: everybody who opens it stays on it, also with nothing to decide and no booking
// (the sidebar links it for everybody, so sending that person back felt like a crash).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import RequestsPage from '~/pages/resources/requests.vue'
import { useServerConfigState } from '~/composables/useServerConfigState'

const api = vi.hoisted(() => ({ handler: null as null | ((path: string) => Promise<unknown>) }))
vi.mock('~/composables/useAuthFetch', () => ({
  useAuthFetch: () => (path: string) => api.handler!(path),
}))

const Shell = defineComponent({ render: () => h(UApp, null, { default: () => h(RequestsPage) }) })

let app: Awaited<ReturnType<typeof mountSuspended>>
let replace: ReturnType<typeof vi.fn>
let rights: 'none' | 'read' | 'manage' = 'none'

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()

beforeEach(() => {
  rights = 'none'
  replace = vi.fn(async () => undefined)
  vi.spyOn(useRouter(), 'replace').mockImplementation(replace as never)
  useServerConfigState().value = {
    oidc: { issuer: 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: 'Europe/Berlin',
    demo: false,
  }
  api.handler = async (path) => {
    if (path === '/api/me') return { id: 7 }
    if (path === '/api/resources/requests') return { requests: [] }
    if (path === '/api/resources') {
      return {
        resources: rights === 'none' ? [] : [{ id: 1, name: 'Room 1', right: rights }],
      }
    }
    if (path === '/api/resources/1/bookings') return { bookings: [] }
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
  // mountSuspended itself navigates to '/' while it sets the route up.
  replace.mockClear()
}

describe('the page Resource bookings (live)', () => {
  it('stays for a person who manages nothing and has no booking, and says so', async () => {
    await mountPage()
    await vi.waitFor(() => expect(document.querySelector('[data-mine-none]')).not.toBeNull())
    expect(text(document.querySelector('[data-mine-none]'))).toBe('You have no upcoming bookings.')
    expect(document.querySelector('#requests-heading')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })

  it('stays for a person who may only read the resources', async () => {
    rights = 'read'
    await mountPage()
    await vi.waitFor(() => expect(document.querySelector('[data-mine-none]')).not.toBeNull())
    expect(replace).not.toHaveBeenCalled()
  })

  it('shows the requests section to a manager with nothing pending', async () => {
    rights = 'manage'
    await mountPage()
    await vi.waitFor(() => expect(document.querySelector('[data-requests-none]')).not.toBeNull())
    expect(text(document.querySelector('[data-requests-none]'))).toBe(
      'There are no pending requests.',
    )
    expect(replace).not.toHaveBeenCalled()
  })
})
