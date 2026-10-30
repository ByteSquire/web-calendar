// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, USelectMenu } from '#components'
import TimeZoneSection from '~/components/settings/TimeZoneSection.vue'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { MeResponse } from '~/utils/settings/types'
import { FakeBackend, ME, alerts, reply, statusText } from './settings-helpers'

const state = vi.hoisted(() => ({ backend: null as FakeBackend | null }))
vi.mock('~/composables/useAuthFetch', async () =>
  (await import('./settings-helpers')).authFetchModule(state)(),
)

// The time zone section inside a real Nuxt UI app, with the shared state the rest of the app reads.
// The choice is made the way the control reports it: the section listens to the `update:modelValue`
// of the select menu.
const Shell = defineComponent({
  props: {
    me: { type: Object as () => MeResponse | null, default: null },
    error: { type: String, default: null },
  },
  setup: (props) => () =>
    h(UApp, null, { default: () => h(TimeZoneSection, { me: props.me, error: props.error }) }),
})

const BROWSER = Intl.DateTimeFormat().resolvedOptions().timeZone
const SYDNEY_NOTICE = 'Times are now shown in Australia/Sydney.'

let backend: FakeBackend
let app: Awaited<ReturnType<typeof mountSuspended>>
let consoleError: ReturnType<typeof vi.spyOn>

function configure(config: { demo?: boolean; timezone?: string } = {}) {
  useServerConfigState().value = {
    oidc: { issuer: '', clientId: '', scope: '' },
    timezone: config.timezone ?? 'Pacific/Auckland',
    demo: config.demo ?? false,
  }
}

async function mountSection(props: { me?: MeResponse | null; error?: string | null } = {}) {
  app = await mountSuspended(Shell, {
    props: { me: props.me === undefined ? backend.me : props.me, error: props.error ?? null },
    attachTo: document.body,
  })
}

/** Picks a choice in the select menu: a zone name, or `browser`. */
function choose(value: string) {
  app.findComponent(USelectMenu).vm.$emit('update:modelValue', value)
}

const control = () => document.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')
const section = () => document.querySelector('section')!
const puts = () => backend.callsTo('PUT', '/api/me/time-zone')

beforeEach(() => {
  backend = new FakeBackend()
  state.backend = backend
  configure()
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
  it('is a section named by its heading, which can take focus from a script', async () => {
    await mountSection()
    const heading = document.getElementById(section().getAttribute('aria-labelledby')!)
    expect(heading?.tagName).toBe('H2')
    expect(heading?.textContent).toBe('Time zone')
    expect(heading?.getAttribute('tabindex')).toBe('-1')
  })

  it('has a labelled control that shows the browser zone as the default', async () => {
    await mountSection()
    const label = [...document.querySelectorAll('label')].find((item) =>
      item.textContent?.startsWith('Show times in'),
    )
    expect(label).toBeDefined()
    expect(control()).not.toBeNull()
    expect(control()!.id).toBe(label!.htmlFor)
    expect(control()!.textContent).toContain(`Browser's zone (${BROWSER})`)
  })

  it('names the organization zone and keeps a live region for the result', async () => {
    await mountSection()
    expect(section().textContent).toContain('Organization time zone: Pacific/Auckland')
    const live = section().querySelector('[role="status"][aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live!.textContent).toBe('')
  })

  it('shows the zone saved with the account, and the screens read it', async () => {
    backend.me = { ...ME, timeZone: 'Asia/Tokyo' }
    await mountSection()
    expect(control()!.textContent).toContain('Asia/Tokyo')
    expect(useUserTimeZone().value).toBe('Asia/Tokyo')
    expect(useDisplayTimeZone().value).toBe('Asia/Tokyo')
  })

  it('shows a saved zone that the browser does not list', async () => {
    backend.me = { ...ME, timeZone: 'Etc/GMT+5' }
    await mountSection()
    expect(control()!.textContent).toContain('Etc/GMT+5')
  })
})

describe('while the account loads', () => {
  it('reserves the room of the control, with a text for assistive technology', async () => {
    await mountSection({ me: null })
    expect(control()).toBeNull()
    expect(section().textContent).toContain('Loading your time zone')
  })

  it('shows no control and no second alert when the account does not load', async () => {
    await mountSection({ me: null, error: 'Could not load your account.' })
    expect(control()).toBeNull()
    expect(section().textContent).toContain('Your time zone setting is not available')
    expect(alerts()).toHaveLength(0)
  })

  it('takes the account when it arrives', async () => {
    await mountSection({ me: null })
    expect(control()).toBeNull()
    await app.setProps({ me: { ...ME, timeZone: 'Asia/Tokyo' } })
    await vi.waitFor(() => expect(control()?.textContent).toContain('Asia/Tokyo'))
    expect(useUserTimeZone().value).toBe('Asia/Tokyo')
  })
})

describe('choosing a zone', () => {
  it('saves it, switches the display zone at once and says so', async () => {
    await mountSection()
    expect(useDisplayTimeZone().value).toBe(BROWSER)

    choose('Australia/Sydney')
    await vi.waitFor(() => expect(statusText()).toContain(SYDNEY_NOTICE))

    expect(puts().map((call) => call.body)).toEqual([{ timeZone: 'Australia/Sydney' }])
    expect(backend.me.timeZone).toBe('Australia/Sydney')
    expect(useUserTimeZone().value).toBe('Australia/Sydney')
    expect(useDisplayTimeZone().value).toBe('Australia/Sydney')
    expect(control()!.textContent).toContain('Australia/Sydney')
    expect(alerts()).toHaveLength(0)
  })

  it('goes back to the browser zone with the first choice, which saves null', async () => {
    backend.me = { ...ME, timeZone: 'Asia/Tokyo' }
    await mountSection()

    choose('browser')
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    await vi.waitFor(() => expect(statusText()).toContain("your browser's zone"))

    expect(puts()[0]!.body).toEqual({ timeZone: null })
    expect(backend.me.timeZone).toBeNull()
    expect(useUserTimeZone().value).toBeNull()
    expect(useDisplayTimeZone().value).toBe(BROWSER)
    expect(control()!.textContent).toContain(`Browser's zone (${BROWSER})`)
  })

  it('sends nothing when the choice is the one that is saved already', async () => {
    backend.me = { ...ME, timeZone: 'Asia/Tokyo' }
    await mountSection()
    choose('Asia/Tokyo')
    choose('browser')
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    choose('browser')
    expect(puts()).toHaveLength(1)
  })

  it('keeps the old zone and shows an alert when the server refuses', async () => {
    backend.me = { ...ME, timeZone: 'Asia/Tokyo' }
    backend.override = (call) =>
      call.method === 'PUT' ? reply.invalid({ field: 'timeZone', message: 'nope' }) : undefined
    await mountSection()

    choose('Australia/Sydney')
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))

    expect(alerts()[0]!.textContent).toContain('Could not save your time zone.')
    expect(statusText()).not.toContain('Times are now shown')
    expect(useUserTimeZone().value).toBe('Asia/Tokyo')
    expect(useDisplayTimeZone().value).toBe('Asia/Tokyo')
    expect(control()!.textContent).toContain('Asia/Tokyo')
  })

  it('clears the alert with the next attempt, which can succeed', async () => {
    let fail = true
    backend.override = (call) =>
      fail && call.method === 'PUT' ? reply.error(500, 'boom') : undefined
    await mountSection()

    choose('Australia/Sydney')
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('The server answered with an error (HTTP 500)')

    fail = false
    choose('Australia/Sydney')
    await vi.waitFor(() => expect(alerts()).toHaveLength(0))
    expect(useUserTimeZone().value).toBe('Australia/Sydney')
  })

  it('says so when the network is down', async () => {
    await mountSection()
    state.backend!.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    choose('Asia/Tokyo')
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('The server could not be reached')
    expect(useUserTimeZone().value).toBeNull()
  })

  it('takes one choice at a time, and the control shows that it is busy', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    backend.override = async (call) => {
      if (call.method === 'PUT') await gate
      return undefined
    }
    await mountSection()

    choose('Australia/Sydney')
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(section().querySelector('[aria-busy="true"]')).not.toBeNull()
    choose('Asia/Tokyo')
    expect(puts()).toHaveLength(1)

    release()
    await vi.waitFor(() => expect(useUserTimeZone().value).toBe('Australia/Sydney'))
    expect(section().querySelector('[aria-busy="true"]')).toBeNull()
    expect(puts()).toHaveLength(1)
  })

  it('does not run markup in a zone name', async () => {
    backend.me = { ...ME, timeZone: '<img src=x onerror=alert(1)>' }
    await mountSection()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    // not a zone the browser knows: the calendar keeps the browser zone
    expect(useDisplayTimeZone().value).toBe(BROWSER)
  })
})

describe('the list', () => {
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  const names = () => options().map((item) => item.textContent?.trim())

  async function openList() {
    control()!.click()
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0))
  }

  async function search(text: string) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search time zones"]')
    if (!input) throw new Error('The list is not open')
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  it('starts with the default, then lists the zones and marks the organization zone', async () => {
    await mountSection()
    await openList()
    expect(names()[0]).toBe(`Browser's zone (${BROWSER})`)
    expect(names()).toContain('Europe/Berlin')
    expect(names()).toContain('Pacific/Auckland (organization zone)')
    expect(names().length).toBeGreaterThan(300)
  })

  it("lists the browser's zone and the saved choice even when the runtime does not", async () => {
    backend.me = { ...ME, timeZone: 'Etc/GMT+5' }
    await mountSection()
    await openList()
    expect(names()).toContain(BROWSER)
    expect(names()).toContain('Etc/GMT+5')
  })

  it('finds a zone by the words of its name', async () => {
    await mountSection()
    await openList()
    await search('new york')
    await vi.waitFor(() => expect(names()).toEqual(['America/New_York']))
    await search('europe/ber')
    await vi.waitFor(() => expect(names()).toEqual(['Europe/Berlin']))
    await search('browser')
    await vi.waitFor(() => expect(names()).toEqual([`Browser's zone (${BROWSER})`]))
  })

  it('says so when nothing matches', async () => {
    await mountSection()
    await openList()
    await search('atlantis')
    await vi.waitFor(() => expect(options()).toHaveLength(0))
    expect(document.body.textContent).toContain('No time zone matches your search.')
  })

  it('saves the zone that is clicked', async () => {
    await mountSection()
    await openList()
    await search('tokyo')
    await vi.waitFor(() => expect(names()).toEqual(['Asia/Tokyo']))
    options()[0]!.click()

    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ timeZone: 'Asia/Tokyo' })
    await vi.waitFor(() => expect(useDisplayTimeZone().value).toBe('Asia/Tokyo'))
    await vi.waitFor(() => expect(control()!.textContent).toContain('Asia/Tokyo'))
  })
})

describe('demo mode', () => {
  beforeEach(() => configure({ demo: true }))

  it('keeps the choice in the page, sends nothing, and works without an account', async () => {
    await mountSection({ me: null, error: 'Could not load your account.' })
    expect(control()).not.toBeNull()

    choose('Australia/Sydney')
    await vi.waitFor(() => expect(statusText()).toContain(SYDNEY_NOTICE))

    expect(backend.calls).toEqual([])
    expect(useDisplayTimeZone().value).toBe('Australia/Sydney')
    expect(alerts()).toHaveLength(0)

    choose('browser')
    await vi.waitFor(() => expect(useUserTimeZone().value).toBeNull())
    expect(backend.calls).toEqual([])
  })

  it('does not replace the choice with what the account says', async () => {
    useUserTimeZone().value = 'Australia/Sydney'
    await mountSection({ me: { ...ME, timeZone: 'Asia/Tokyo' } })
    expect(useUserTimeZone().value).toBe('Australia/Sydney')
  })
})
