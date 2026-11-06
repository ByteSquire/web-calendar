// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import SubscriptionsSection from '~/components/settings/SubscriptionsSection.vue'
import { COLOR_PALETTE } from '~/utils/settings/palette'
import {
  FakeBackend,
  alerts,
  button,
  dialog,
  errorTexts,
  field,
  keydown,
  reply,
  requireButton,
  rows,
  statusText,
  subscription,
  type,
} from './settings-helpers'

const state = vi.hoisted(() => ({ backend: null as FakeBackend | null }))
vi.mock('~/composables/useAuthFetch', async () =>
  (await import('./settings-helpers')).authFetchModule(state)(),
)

// The subscription section inside a real Nuxt UI app: list, add form, edit and delete dialogs and
// the check button.
const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(SubscriptionsSection) }),
})

let backend: FakeBackend
let app: Awaited<ReturnType<typeof mountSuspended>>

async function mountSection(setup?: (backend: FakeBackend) => void) {
  setup?.(backend)
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(backend.callsTo('GET', '/api/ical-subscriptions')).toHaveLength(1))
  await vi.waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull())
}

const sourcesVersion = () => useState<number>('calendar-sources-version', () => 0).value
const nameInput = (root: ParentNode = document) => field('Name', root)
const urlInput = (root: ParentNode = document) => field('Address of the .ics file', root)
const addButton = () => requireButton(/^(Add subscription|Saving…)$/)
const colorRadios = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
]
const rowOf = (name: string) =>
  rows('Your calendar subscriptions').find((row) => row.textContent?.includes(name))!

beforeEach(() => {
  backend = new FakeBackend()
  state.backend = backend
})

afterEach(() => {
  app.unmount()
  state.backend = null
  clearNuxtState()
  vi.restoreAllMocks()
})

describe('the list', () => {
  it('shows name, the full address as title, and no editing for a shared subscription', async () => {
    await mountSection((api) => {
      api.subscriptions = [
        subscription(1, { name: 'Holidays', url: 'https://example.org/holidays.ics' }),
        subscription(2, {
          name: 'Company events',
          url: 'https://example.org/a/very/long/path/to/the/company/events/calendar.ics?token=abc',
          shared: true,
          color: null,
        }),
      ]
    })
    const [own, shared] = rows('Your calendar subscriptions')
    expect(own!.textContent).toContain('Holidays')
    expect(own!.querySelector('[title="https://example.org/holidays.ics"]')).not.toBeNull()
    expect(button('Edit Holidays', own!)).toBeDefined()
    expect(button('Delete Holidays', own!)).toBeDefined()
    expect(button('Check Holidays', own!)).toBeDefined()

    expect(shared!.textContent).toContain('Shared')
    expect(shared!.textContent).toContain('Only an administrator can change it')
    expect(button('Check Company events', shared!)).toBeDefined()
    expect(button('Edit Company events', shared!)).toBeUndefined()
    expect(button('Delete Company events', shared!)).toBeUndefined()
    // the whole address is in the title and in the text (visually cut by CSS only)
    const address = shared!.querySelector('p.truncate')!
    expect(address.getAttribute('title')).toContain('company/events/calendar.ics?token=abc')
    expect(address.textContent).toContain('company/events/calendar.ics?token=abc')
  })

  it('names the colour in text for assistive technology, with and without one', async () => {
    await mountSection((api) => {
      api.subscriptions = [
        subscription(1, { name: 'Blue one', color: '#1d4ed8' }),
        subscription(2, { name: 'Odd one', color: '#123456' }),
        subscription(3, { name: 'Bare one', color: null }),
      ]
    })
    expect(rowOf('Blue one').textContent).toContain('Colour: Blue')
    expect(rowOf('Odd one').textContent).toContain('Colour: Custom colour')
    expect(rowOf('Bare one').textContent).toContain('Colour: No colour')
    // the swatch itself is decoration
    for (const swatch of document.querySelectorAll('li .rounded-full')) {
      expect(swatch.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('says so when there are none, and shows an alert with Retry when loading fails', async () => {
    await mountSection()
    expect(document.body.textContent).toContain('You have no calendar subscriptions yet.')
    app.unmount()

    backend.override = (call) =>
      call.method === 'GET' && call.path === '/api/ical-subscriptions'
        ? reply.error(500, 'boom')
        : undefined
    app = await mountSuspended(Shell, { attachTo: document.body })
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('Could not load your calendar subscriptions.')
    // the add form is still there and no skeleton is left
    expect(addButton()).toBeDefined()
    expect(document.querySelector('.animate-pulse')).toBeNull()

    backend.override = null
    requireButton('Retry').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('no calendar subscriptions'))
    expect(alerts()).toHaveLength(0)
  })
})

describe('the colour picker', () => {
  beforeEach(() => mountSection())

  it('is a radio group named Colour with a named choice for each palette colour', () => {
    const group = document.querySelector('fieldset')!
    expect(group.querySelector('legend')!.textContent).toBe('Colour')
    const radios = colorRadios(group)
    // the palette, then "Custom" for any colour
    expect(radios).toHaveLength(COLOR_PALETTE.length + 1)
    // one group: native radios of one name arrow through each other
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1)
    const names = radios.map((radio) => radio.closest('label')!.textContent!.trim())
    expect(names).toEqual([...COLOR_PALETTE.map((color) => color.name), 'Custom'])
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
    expect(radios[0]!.checked).toBe(true)
    // the selected choice has a check mark, so it is not shown by colour alone
    expect(
      radios[0]!.closest('label')!.querySelector('svg, .iconify, [class*="i-lucide-check"]'),
    ).not.toBeNull()
    expect(radios[1]!.closest('label')!.querySelector('[class*="i-lucide-check"]')).toBeNull()
  })

  it('changes the choice when a colour is clicked', async () => {
    const radios = colorRadios()
    radios[3]!.click()
    await vi.waitFor(() => expect(colorRadios()[3]!.checked).toBe(true))
    expect(colorRadios()[0]!.checked).toBe(false)
  })
})

describe('adding a subscription', () => {
  beforeEach(() => mountSection())

  it('sends name, address and colour, adds the row, resets the form and tells the calendar', async () => {
    expect(sourcesVersion()).toBe(0)
    type(nameInput(), '  Holidays  ')
    type(urlInput(), ' webcal://example.org/holidays.ics ')
    colorRadios()[1]!.click()
    addButton().click()

    await vi.waitFor(() => expect(rows('Your calendar subscriptions')).toHaveLength(1))
    expect(backend.callsTo('POST', '/api/ical-subscriptions')[0]!.body).toEqual({
      name: 'Holidays',
      url: 'webcal://example.org/holidays.ics',
      color: COLOR_PALETTE[1]!.value,
    })
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Subscription “Holidays” added.')
    expect(nameInput().value).toBe('')
    expect(urlInput().value).toBe('')
    expect(colorRadios()[0]!.checked).toBe(true)
    expect(errorTexts()).toEqual([])
  })

  it('checks the input before asking the server', async () => {
    addButton().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual([
        'Enter a name for the calendar.',
        'Enter the address of the calendar.',
      ]),
    )
    expect(backend.callsTo('POST', '/api/ical-subscriptions')).toHaveLength(0)
    expect(sourcesVersion()).toBe(0)
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameInput())

    type(nameInput(), 'Holidays')
    type(urlInput(), 'ftp://example.org/a.ics')
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual(['The address must start with http://, https:// or webcal://.']),
    )
    expect(urlInput().getAttribute('aria-describedby')).toMatch(/-error\b/)
  })

  it.each([
    [
      'an address in a private network',
      reply.invalid({ field: 'url', message: 'must not point to a private or reserved network' }),
      'This address points to a private or reserved network, which is not allowed.',
    ],
    [
      'a host name that does not exist',
      reply.invalid({ field: 'url', message: 'has a host name that cannot be resolved' }),
      'The host name of this address cannot be found. Check it for typos.',
    ],
    [
      'an address that is already subscribed',
      reply.error(409, 'You already subscribed to this address', { code: 'duplicate' }),
      'You already subscribed to this address.',
    ],
  ])('shows %s under the address and focuses it', async (_name, answer, message) => {
    backend.override = (call) => (call.method === 'POST' ? answer : undefined)
    type(nameInput(), 'Holidays')
    type(urlInput(), 'https://example.org/holidays.ics')
    addButton().click()
    await vi.waitFor(() => expect(errorTexts()).toEqual([message]))
    expect(urlInput().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(urlInput())
    // nothing was added and the calendar was not told
    expect(rows('Your calendar subscriptions')).toHaveLength(0)
    expect(sourcesVersion()).toBe(0)
    expect(nameInput().value).toBe('Holidays')

    // the message is about the address that was sent: it goes when the address is edited
    type(urlInput(), 'https://example.org/holidays2.ics')
    await vi.waitFor(() => expect(errorTexts()).toEqual([]))
  })

  it('shows the field messages of several fields at once', async () => {
    backend.override = (call) =>
      call.method === 'POST'
        ? reply.invalid(
            { field: 'name', message: 'must have at most 80 characters' },
            { field: 'url', message: 'must be a valid address' },
          )
        : undefined
    type(nameInput(), 'Holidays')
    type(urlInput(), 'https://example.org/holidays.ics')
    addButton().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual([
        'The name must have at most 80 characters.',
        'The address must be a valid address.',
      ]),
    )
    expect(document.activeElement).toBe(nameInput())
  })

  it('shows the limit and failures without a field in an alert', async () => {
    backend.override = (call) =>
      call.method === 'POST'
        ? reply.error(409, 'At most 50 calendar subscriptions are allowed per user', {
            code: 'limit_reached',
          })
        : undefined
    type(nameInput(), 'Holidays')
    type(urlInput(), 'https://example.org/holidays.ics')
    addButton().click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('At most 50 calendar subscriptions')
    expect(errorTexts()).toEqual([])

    backend.override = (call) => (call.method === 'POST' ? reply.error(502, 'bad') : undefined)
    addButton().click()
    await vi.waitFor(() =>
      expect(alerts()[0]?.textContent).toContain(
        'Could not add the subscription. The server answered with an error (HTTP 502).',
      ),
    )
  })
})

describe('changing a subscription', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.subscriptions = [
        subscription(1, { name: 'Holidays', color: null }),
        subscription(2, { name: 'Sports', color: '#123456' }),
      ]
    }),
  )

  it('opens a dialog with the values, saves them and returns focus to Edit', async () => {
    const opener = requireButton('Edit Holidays')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Edit subscription')
    await vi.waitFor(() => expect(document.activeElement).toBe(nameInput(dialog()!)))
    expect(nameInput(dialog()!).value).toBe('Holidays')
    expect(urlInput(dialog()!).value).toBe('https://example.org/calendar-1.ics')
    // no colour stays "Default" and is offered as such
    const radios = colorRadios(dialog()!)
    expect(radios).toHaveLength(COLOR_PALETTE.length + 2)
    expect(radios.find((radio) => radio.checked)!.closest('label')!.textContent).toContain(
      'Default',
    )

    type(nameInput(dialog()!), 'Public holidays')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())

    expect(backend.callsTo('PUT', '/api/ical-subscriptions/1')[0]!.body).toEqual({
      name: 'Public holidays',
      url: 'https://example.org/calendar-1.ics',
      // untouched "Default" stays no colour
      color: null,
    })
    expect(rowOf('Public holidays')).toBeDefined()
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Subscription “Public holidays” saved.')
    expect(document.activeElement).toBe(requireButton('Edit Public holidays'))
  })

  it('takes any colour through "Custom", by the colour code', async () => {
    requireButton('Edit Sports').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const code = dialog()!.querySelector<HTMLInputElement>('input.font-mono')!
    code.value = 'zz'
    code.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() =>
      expect(dialog()!.textContent).toContain('Enter a colour code like #1d4ed8.'),
    )
    code.value = 'FFE066'
    code.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() =>
      expect(dialog()!.textContent).not.toContain('Enter a colour code like #1d4ed8.'),
    )
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('PUT', '/api/ical-subscriptions/2')[0]!.body).toMatchObject({
      color: '#ffe066',
    })
  })

  it('keeps a colour the palette does not have unless another one is chosen', async () => {
    requireButton('Edit Sports').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const radios = colorRadios(dialog()!)
    const current = radios.find((radio) => radio.checked)!
    expect(current.value).toBe('custom')
    expect(current.closest('label')!.textContent).toContain('Custom')
    const code = dialog()!.querySelector<HTMLInputElement>('input.font-mono')!
    expect(code.value).toBe('#123456')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('PUT', '/api/ical-subscriptions/2')[0]!.body).toMatchObject({
      color: '#123456',
    })
  })

  it('discards the changes on Cancel and on Escape', async () => {
    const opener = requireButton('Edit Holidays')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(nameInput(dialog()!), 'Changed')
    button('Cancel', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)

    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    // a fresh form, not the half-edited one
    expect(nameInput(dialog()!).value).toBe('Holidays')
    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(backend.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(sourcesVersion()).toBe(0)
  })

  it('shows the server message in the dialog and keeps it open', async () => {
    backend.override = (call) =>
      call.method === 'PUT'
        ? reply.error(409, 'You already subscribed to this address', { code: 'duplicate' })
        : undefined
    requireButton('Edit Holidays').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(urlInput(dialog()!), 'https://example.org/other.ics')
    requireButton('Save changes').click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual(['You already subscribed to this address.']),
    )
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(urlInput(dialog()!))
    expect(sourcesVersion()).toBe(0)
  })
})

describe('deleting a subscription', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.subscriptions = [
        subscription(1, { name: 'Holidays' }),
        subscription(2, { name: 'Sports' }),
      ]
    }),
  )

  it('asks first; Cancel leaves everything as it was', async () => {
    const opener = requireButton('Delete Holidays')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Delete “Holidays”?')
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Cancel'))
    button('Cancel', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(rows('Your calendar subscriptions')).toHaveLength(2)
    expect(sourcesVersion()).toBe(0)
  })

  it('deletes on confirm, tells the calendar and moves focus to the heading', async () => {
    const opener = requireButton('Delete Holidays')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Delete subscription', dialog()!)!.click()

    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('DELETE', '/api/ical-subscriptions/1')).toHaveLength(1)
    expect(rows('Your calendar subscriptions')).toHaveLength(1)
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Subscription “Holidays” deleted.')
    expect(document.activeElement?.textContent?.trim()).toBe('iCal subscriptions')
  })

  it('keeps the dialog open with the reason when deleting fails', async () => {
    backend.override = (call) => (call.method === 'DELETE' ? reply.error(500, 'boom') : undefined)
    requireButton('Delete Holidays').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Delete subscription', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull())
    expect(dialog()!.textContent).toContain('Could not delete the subscription.')
    expect(rows('Your calendar subscriptions')).toHaveLength(2)
    expect(sourcesVersion()).toBe(0)
  })
})

describe('the Check button', () => {
  const ICS = (events: number) =>
    [
      'BEGIN:VCALENDAR',
      ...Array.from({ length: events }, () => 'BEGIN:VEVENT\r\nEND:VEVENT'),
      'END:VCALENDAR',
      '',
    ].join('\r\n')

  beforeEach(() =>
    mountSection((api) => {
      api.subscriptions = [
        subscription(1, { name: 'Holidays' }),
        subscription(2, { name: 'Sports' }),
      ]
    }),
  )

  it('reports that it works, with the number of events and the size', async () => {
    backend.documents.set(1, ICS(12))
    requireButton('Check Holidays').click()
    await vi.waitFor(() => expect(rowOf('Holidays').textContent).toContain('Works: 12 events'))
    expect(rowOf('Holidays').textContent).toMatch(/Works: 12 events, \d+ bytes\./)
    // the other row says nothing
    expect(rowOf('Sports').textContent).not.toContain('Works')
    expect(backend.callsTo('GET', '/api/ical-subscriptions/1/data')).toHaveLength(1)
  })

  it('shows that it is working and keeps the focus on the button meanwhile', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    backend.override = async (call) => {
      if (!call.path.endsWith('/data')) return undefined
      await gate
      return { status: 200, text: ICS(1) }
    }
    const check = requireButton('Check Holidays')
    check.focus()
    check.click()
    await vi.waitFor(() => expect(rowOf('Holidays').textContent).toContain('Checking the address…'))
    expect(check.textContent).toContain('Checking…')
    expect(check.getAttribute('aria-busy')).toBe('true')
    expect(check.disabled).toBe(false)
    expect(document.activeElement).toBe(check)
    // a second click while the first is running does not start another request
    check.click()
    release()
    await vi.waitFor(() => expect(rowOf('Holidays').textContent).toContain('Works: 1 event'))
    expect(backend.callsTo('GET', '/api/ical-subscriptions/1/data')).toHaveLength(1)
    expect(check.getAttribute('aria-busy')).toBe('false')
  })

  it.each([
    ['blocked', 'The address points to a private or reserved network, which is not allowed.'],
    ['unreachable', 'The server could not reach the address.'],
    ['timeout', 'The address did not answer in time.'],
    ['too-large', 'The file is too large.'],
    ['not-ical', 'The address does not return an iCal calendar file.'],
    ['http-404', 'The address answered with HTTP 404 (not found).'],
    ['http-503', 'The address answered with HTTP 503.'],
  ])('says why when the server reports %s, and asks only once', async (reason, sentence) => {
    backend.documents.set(1, reply.error(502, 'Bad Gateway', { reason }))
    requireButton('Check Holidays').click()
    await vi.waitFor(() =>
      expect(rowOf('Holidays').textContent).toContain(`Check failed: ${sentence}`),
    )
    // ofetch would repeat a GET that failed with a 5xx; the check must not
    expect(backend.callsTo('GET', '/api/ical-subscriptions/1/data')).toHaveLength(1)
    // the message names the problem, never the address (it can hold a secret)
    expect(rowOf('Holidays').querySelector('[role="status"]')!.textContent).not.toContain(
      'https://',
    )
  })

  it('says so when the server cannot be reached or the subscription is gone', async () => {
    backend.documents.set(2, reply.error(404, 'Not found'))
    requireButton('Check Sports').click()
    await vi.waitFor(() => expect(rowOf('Sports').textContent).toContain('no longer exists'))
  })

  it('announces the result in a polite live region of the row and can be repeated', async () => {
    backend.documents.set(1, reply.error(502, 'Bad Gateway', { reason: 'timeout' }))
    requireButton('Check Holidays').click()
    await vi.waitFor(() => expect(rowOf('Holidays').textContent).toContain('Check failed'))
    const live = rowOf('Holidays').querySelector('[role="status"][aria-live="polite"]')!
    expect(live.textContent).toContain('did not answer in time')

    backend.documents.set(1, ICS(2))
    requireButton('Check Holidays').click()
    await vi.waitFor(() => expect(live.textContent).toContain('Works: 2 events'))
    expect(live.textContent).not.toContain('Check failed')
  })

  it('forgets the result when the address is changed', async () => {
    backend.documents.set(1, ICS(2))
    requireButton('Check Holidays').click()
    await vi.waitFor(() => expect(rowOf('Holidays').textContent).toContain('Works'))
    requireButton('Edit Holidays').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(urlInput(dialog()!), 'https://example.org/other.ics')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(rowOf('Holidays').textContent).not.toContain('Works')
  })
})
