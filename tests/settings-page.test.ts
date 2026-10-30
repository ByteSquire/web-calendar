// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import SettingsPage from '~/pages/settings.vue'
import { useServerConfigState } from '~/composables/useServerConfigState'
import {
  FakeBackend,
  alerts,
  field,
  reply,
  requireButton,
  subscription,
  token,
} from './settings-helpers'

const state = vi.hoisted(() => ({ backend: null as FakeBackend | null }))
vi.mock('~/composables/useAuthFetch', async () =>
  (await import('./settings-helpers')).authFetchModule(state)(),
)

// The whole page inside a real Nuxt UI app: structure, the account section and what happens when
// the API is not there.
const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(SettingsPage) }),
})

let backend: FakeBackend
let app: Awaited<ReturnType<typeof mountSuspended>>
let consoleError: ReturnType<typeof vi.spyOn>

function configure(config: { demo?: boolean; timezone?: string } = {}) {
  useServerConfigState().value = {
    oidc: { issuer: '', clientId: '', scope: '' },
    timezone: config.timezone ?? 'Europe/Berlin',
    demo: config.demo ?? false,
  }
}

async function mountPage() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull())
}

const headings = (level: string) =>
  [...document.querySelectorAll(level)].map((item) => item.textContent?.trim())

beforeEach(() => {
  backend = new FakeBackend()
  state.backend = backend
  consoleError = vi.spyOn(console, 'error')
})

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled()
  app.unmount()
  state.backend = null
  clearNuxtState()
  vi.restoreAllMocks()
})

describe('structure', () => {
  beforeEach(async () => {
    configure()
    await mountPage()
  })

  it('has one h1 and the three sections as h2, each named by its heading', () => {
    expect(headings('h1')).toEqual(['Settings'])
    expect(headings('h2')).toEqual(['Account', 'App tokens', 'iCal subscriptions'])
    for (const section of document.querySelectorAll('section')) {
      const heading = document.getElementById(section.getAttribute('aria-labelledby')!)
      expect(heading?.tagName).toBe('H2')
    }
  })

  it('does not add a main landmark: the layout provides it', () => {
    expect(document.querySelectorAll('main')).toHaveLength(0)
  })

  it('links back to the calendar', () => {
    const link = [...document.querySelectorAll('a')].find((item) =>
      item.textContent?.includes('Back to calendar'),
    )
    expect(link?.getAttribute('href')).toBe('/')
  })

  it('is not in demo mode', () => {
    expect(document.body.textContent).not.toContain('Demo mode')
  })
})

describe('account', () => {
  it('shows name, email and user name, and the time zones', async () => {
    configure({ timezone: 'Pacific/Auckland' })
    await mountPage()
    const text = document.querySelector('section')!.textContent!
    expect(text).toContain('Alice Example')
    expect(text).toContain('alice@example.test')
    expect(text).toContain('alice')
    expect(text).not.toContain('Administrator')
    // the organization zone comes from the server settings, the display zone from the browser
    const display = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(text.replace(/\s+/g, ' ')).toContain(
      `Times are shown in ${display} (your browser's zone). Organization time zone: Pacific/Auckland.`,
    )
  })

  it('shows an Administrator badge for an admin', async () => {
    configure()
    backend.me = { ...backend.me, isAdmin: true }
    await mountPage()
    expect(document.querySelector('section')!.textContent).toContain('Administrator')
  })

  it('says "Not set" for what the identity provider did not give', async () => {
    configure()
    backend.me = { ...backend.me, name: null, email: null }
    await mountPage()
    expect(document.querySelector('section')!.textContent!.match(/Not set/g)).toHaveLength(2)
  })

  it('gives the user name to the calendar-app instructions', async () => {
    configure()
    backend.me = { ...backend.me, username: 'bob' }
    await mountPage()
    const tokens = document.querySelector('[aria-labelledby="settings-tokens"]')!
    expect([...tokens.querySelectorAll('code')].map((item) => item.textContent)).toContain('bob')
  })

  it('reserves the room of the data while it loads, with a text for assistive technology', async () => {
    configure()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    backend.override = async (call) => {
      if (call.path === '/api/me') await gate
      return undefined
    }
    app = await mountSuspended(Shell, { attachTo: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Loading account details'))
    expect(document.querySelector('[aria-labelledby="settings-account"] dl')).toBeNull()
    release()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Alice Example'))
    expect(document.body.textContent).not.toContain('Loading account details')
  })
})

describe('demo mode', () => {
  it('says that nothing is saved', async () => {
    configure({ demo: true })
    await mountPage()
    expect(document.body.textContent).toContain('Demo mode')
    expect(document.body.textContent).toContain('Nothing is saved in demo mode')
  })
})

describe('when the API fails', () => {
  it('renders, shows an alert with Retry per section and keeps the forms usable', async () => {
    configure({ demo: true })
    backend.override = () => reply.error(401, 'Unauthorized')
    await mountPage()
    await vi.waitFor(() => expect(alerts()).toHaveLength(3))
    for (const alert of alerts()) {
      expect(alert.textContent).toContain('You are signed out')
      expect(alert.textContent).toContain('Retry')
    }
    expect(headings('h2')).toEqual(['Account', 'App tokens', 'iCal subscriptions'])
    // the tokens form works as far as the client can tell
    expect(requireButton('Create token').disabled).toBe(false)
    expect(field('Label')).toBeDefined()
    expect(requireButton('Add subscription').disabled).toBe(false)
    expect(document.body.textContent).toContain('Nothing is saved in demo mode')
  })

  it('lets one section recover without the others', async () => {
    configure()
    backend.tokens = [token(1, { label: 'Thunderbird' })]
    backend.subscriptions = [subscription(1, { name: 'Holidays' })]
    let meFails = true
    backend.override = (call) =>
      meFails && call.path === '/api/me' ? reply.error(500, 'boom') : undefined
    await mountPage()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('Could not load your account.')
    // the other sections are fine
    expect(document.body.textContent).toContain('Thunderbird')
    expect(document.body.textContent).toContain('Holidays')

    meFails = false
    requireButton('Retry').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Alice Example'))
    expect(alerts()).toHaveLength(0)
  })

  it('works when the network is down', async () => {
    configure()
    state.backend!.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    await mountPage()
    await vi.waitFor(() => expect(alerts()).toHaveLength(3))
    expect(alerts()[0]!.textContent).toContain('The server could not be reached')
  })
})
