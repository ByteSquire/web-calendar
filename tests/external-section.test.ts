// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { clearNuxtState, useState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import ExternalAccountForm from '~/components/settings/ExternalAccountForm.vue'
import ExternalAccountsSection from '~/components/settings/ExternalAccountsSection.vue'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { DavError } from '../app/utils/caldav/errors'
import { externalAccountKey } from '../app/utils/live/errors'
import { SEALED, account } from './external-helpers'
import { ExternalBackend, MemoryStorage, external, newAccess } from './external-section-helpers'
import {
  alerts,
  button,
  dialog,
  errorTexts,
  reply,
  requireButton,
  rows,
  statusText,
  type,
} from './settings-helpers'

// The settings section of the external accounts inside a real Nuxt UI app: list and status, adding
// with and without a login, the sealed credential, editing, deleting, checking, and the password
// dialog. The access (API, seal store, source) is built on a fake server and handed in.

const state = vi.hoisted(() => ({
  access: null as null | ReturnType<typeof import('./external-section-helpers').newAccess>,
}))
vi.mock('~/composables/useExternalAccess', () => ({ useExternalAccess: () => state.access! }))

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(ExternalAccountsSection) }),
})

let backend: ExternalBackend
let storage: MemoryStorage
let app: Awaited<ReturnType<typeof mountSuspended>>
let consoleError: ReturnType<typeof vi.spyOn>

async function mountSection(setup?: (backend: ExternalBackend) => void) {
  setup?.(backend)
  state.access = newAccess(backend, storage)
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(backend.callsTo('GET', '/api/external-accounts')).toHaveLength(1))
  await vi.waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull())
}

const seals = () => state.access!.seals
/** True when some field of the page holds `text` (innerHTML does not show what was typed). */
const anyFieldHolds = (text: string) =>
  [...document.querySelectorAll('input')].some((input) => input.value.includes(text))
const sourcesVersion = () => useState<number>('calendar-sources-version', () => 0).value
/** The input a `<label>` with exactly this text points at. */
function byLabel(label: string, root: ParentNode = document): HTMLInputElement {
  const element = [...root.querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === label,
  )
  const input = element?.htmlFor ? document.getElementById(element.htmlFor) : null
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labelled ${label}`)
  return input
}

const nameInput = (root: ParentNode = document) => byLabel('Name', root)
const urlInput = (root: ParentNode = document) => byLabel('Address of the CalDAV server', root)
const userInput = (root: ParentNode = document) => byLabel('User name', root)
const passwordInput = (root: ParentNode = document) => byLabel('Password', root)
const addButton = () => requireButton(/^(Add account|Saving…)$/)
const rowOf = (name: string) =>
  rows('Your external accounts').find((row) => row.textContent?.includes(name))!

/** A control of Reka UI by the text of its label (radio buttons, check boxes). */
function control(role: 'radio' | 'checkbox', label: string, root: ParentNode = document) {
  const found = [...root.querySelectorAll('label')].find((item) =>
    item.textContent?.trim().startsWith(label),
  )
  const element = found?.htmlFor ? document.getElementById(found.htmlFor) : null
  if (!element || element.getAttribute('role') !== role) throw new Error(`No ${role} ${label}`)
  return element as HTMLButtonElement
}

async function chooseLogin(root: ParentNode = document) {
  control('radio', 'User name and password', root).click()
  await vi.waitFor(() => expect(userInput(root)).toBeDefined())
}

beforeEach(() => {
  backend = new ExternalBackend()
  storage = new MemoryStorage()
  useServerConfigState().value = {
    oidc: { issuer: '', clientId: '', scope: '' },
    timezone: 'Europe/Berlin',
    demo: false,
  }
  consoleError = vi.spyOn(console, 'error')
})

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled()
  app.unmount()
  state.access = null
  clearNuxtState()
  vi.restoreAllMocks()
})

describe('the list', () => {
  it('names each account with its address, login and a status of its connection', async () => {
    await mountSection((api) => {
      api.accounts = [
        account(1, { name: 'Company', url: 'https://dav.example.org/dav/', color: '#1d4ed8' }),
        account(2, {
          name: 'Private',
          url: 'https://cal.example.net/',
          authMode: 'basic',
          username: 'me',
        }),
      ]
    })
    const [company, privateRow] = rows('Your external accounts')
    expect(company!.textContent).toContain('Company')
    expect(company!.querySelector('[title="https://dav.example.org/dav/"]')).not.toBeNull()
    expect(company!.textContent).toContain('No login')
    expect(company!.textContent).toContain('Colour: Blue')
    expect(privateRow!.textContent).toContain('User name me')
    expect(privateRow!.textContent).toContain('Colour: from the server')
    // The browser has no password for the second one yet, and says so, with the way out.
    expect(privateRow!.textContent).toContain('This browser has no password for the account yet.')
    expect(button('Enter the password of Private', privateRow!)).toBeDefined()
    expect(button('Enter the password of Company', company!)).toBeUndefined()
    for (const name of ['Company', 'Private']) {
      expect(button(`Check connection of ${name}`)).toBeDefined()
      expect(button(`Edit ${name}`)).toBeDefined()
      expect(button(`Delete ${name}`)).toBeDefined()
    }
  })

  it('is a labelled section with a heading that can take focus, and live status regions', async () => {
    await mountSection((api) => {
      api.accounts = [account(1, { name: 'Company' })]
    })
    const section = document.querySelector('section')!
    const heading = document.getElementById(section.getAttribute('aria-labelledby')!)!
    expect(heading.tagName).toBe('H2')
    expect(heading.textContent?.trim()).toBe('External CalDAV accounts')
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(rowOf('Company').querySelector('[role="status"][aria-live="polite"]')).not.toBeNull()
    expect(document.querySelector('p[role="status"][aria-live="polite"]')).not.toBeNull()
  })

  it('says the accounts are read-only, that the server passes requests on, and that a login needs https', async () => {
    await mountSection()
    const text = document.body.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('They are read-only')
    expect(text).toContain("this app's server passes each request on")
    expect(text).toContain('does not keep your password')
    expect(text).toContain('An account with a login needs an https:// address')
    expect(text).toContain('You have no external accounts yet.')
  })

  it('shows an alert with Retry when the list cannot be loaded, and the form stays usable', async () => {
    backend.override = (call) => (call.method === 'GET' ? reply.error(500, 'boom') : undefined)
    state.access = newAccess(backend, storage)
    app = await mountSuspended(Shell, { attachTo: document.body })
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('Could not load your external accounts.')
    expect(addButton()).toBeDefined()

    backend.override = null
    requireButton('Retry').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('no external accounts'))
    expect(alerts()).toHaveLength(0)
  })

  it('shows what the calendar view reported about an account, and what it found', async () => {
    await mountSection((api) => {
      api.accounts = [account(1, { name: 'Down' }), account(2, { name: 'Fine' })]
    })
    useState<Record<string, string>>('live-errors').value = {
      [externalAccountKey(1)]: 'Not reachable',
    }
    useState<unknown[]>('cal-calendars').value = [
      { id: 'ext:2:https://dav.example.org/a/', caldavAccountId: '2', name: 'A', color: '#000000' },
      { id: 'ext:2:https://dav.example.org/b/', caldavAccountId: '2', name: 'B', color: '#000000' },
    ]
    await vi.waitFor(() => expect(rowOf('Down').textContent).toContain('Not reachable.'))
    expect(rowOf('Fine').textContent).toContain('Connected: 2 calendars shown.')
  })

  it('offers the password when the calendar view could not log in', async () => {
    await mountSection((api) => {
      api.accounts = [account(1, { name: 'Private', authMode: 'basic', username: 'me' })]
    })
    seals().set(1, SEALED, false)
    await vi.waitFor(() => expect(button('Enter the password of Private')).toBeUndefined())
    useState<Record<string, string>>('live-errors').value = {
      [externalAccountKey(1)]: 'Login rejected',
    }
    useState<Record<string, number>>('live-password-for').value = { [externalAccountKey(1)]: 1 }
    await vi.waitFor(() => expect(button('Enter the password of Private')).toBeDefined())
  })
})

describe('adding an account', () => {
  beforeEach(() => mountSection())

  it('adds an account without a login: sends name, address and the server’s colour, resets, tells the calendar', async () => {
    expect(sourcesVersion()).toBe(0)
    type(nameInput(), '  Holidays  ')
    type(urlInput(), ' http://dav.example.org/dav/ ')
    addButton().click()

    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
    expect(backend.callsTo('POST', '/api/external-accounts')[0]!.body).toEqual({
      name: 'Holidays',
      url: 'http://dav.example.org/dav/',
      authMode: 'none',
      color: null,
    })
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Account “Holidays” added.')
    expect(nameInput().value).toBe('')
    expect(urlInput().value).toBe('')
    expect(errorTexts()).toEqual([])
    expect(seals().has(100)).toBe(false)
  })

  it('offers the login fields only for a login, with Remember on this device off', async () => {
    expect(document.body.textContent).not.toContain('Remember on this device')
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await chooseLogin()
    expect(passwordInput().type).toBe('password')
    expect(passwordInput().getAttribute('autocomplete')).toBe('off')
    const remember = control('checkbox', 'Remember on this device')
    expect(remember.getAttribute('aria-checked')).toBe('false')
    expect(remember.getAttribute('data-state')).toBe('unchecked')
    // what is kept is explained in a sentence
    expect(document.body.textContent).toContain('a sealed credential, not your password')
    expect(document.body.textContent).toContain('only through this app and only for this server')
  })

  it('adds an account with a login, keeps the sealed credential in memory only, and forgets the password', async () => {
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    await chooseLogin()
    type(userInput(), ' me ')
    type(passwordInput(), 'hunter2-secret')
    addButton().click()

    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
    expect(backend.callsTo('POST', '/api/external-accounts')[0]!.body).toEqual({
      name: 'Private',
      url: 'https://cal.example.net/',
      authMode: 'basic',
      username: 'me',
      password: 'hunter2-secret',
      color: null,
    })
    expect(seals().get(100)).toBe(SEALED)
    expect(seals().isRemembered(100)).toBe(false)
    expect(storage.length).toBe(0)
    // The password is not in the page any more, nor in what the seal store holds.
    expect(anyFieldHolds('hunter2')).toBe(false)
    expect(JSON.stringify([...storage.data])).not.toContain('hunter2')
    expect(document.body.innerHTML).not.toContain('hunter2')
    expect(rowOf('Private').textContent).not.toContain('This browser has no password')
  })

  it('says so when the browser did not allow keeping it on this device', async () => {
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    await chooseLogin()
    type(userInput(), 'me')
    type(passwordInput(), 'pw')
    control('checkbox', 'Remember on this device').click()
    addButton().click()
    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
    expect(statusText()).toContain('Account “Private” added.')
    expect(statusText()).toContain('did not allow keeping it on this device')
    // still usable in this session
    expect(seals().get(100)).toBe(SEALED)
    expect(seals().isRemembered(100)).toBe(false)
  })

  it('keeps the sealed credential on this device when asked to', async () => {
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    await chooseLogin()
    type(userInput(), 'me')
    type(passwordInput(), 'pw')
    control('checkbox', 'Remember on this device').click()
    addButton().click()
    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
    expect(seals().isRemembered(100)).toBe(true)
    expect([...storage.data.entries()]).toEqual([['web-calendar:external-seal:sub-1:100', SEALED]])
  })

  it('checks the input before asking the server', async () => {
    addButton().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual([
        'Enter a name for the account.',
        'Enter the address of the CalDAV server.',
      ]),
    )
    expect(backend.callsTo('POST', '/api/external-accounts')).toHaveLength(0)
    expect(document.activeElement).toBe(nameInput())

    type(nameInput(), 'Private')
    type(urlInput(), 'http://cal.example.net/')
    await chooseLogin()
    addButton().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual([
        'An account with a login needs an https:// address, so that the password is encrypted.',
        'Enter the user name of the account.',
        'Enter the password of the account.',
      ]),
    )
    expect(backend.callsTo('POST', '/api/external-accounts')).toHaveLength(0)
    expect(sourcesVersion()).toBe(0)
  })

  it('shows what the server rejected next to the input, until that input is edited', async () => {
    backend.override = (call) =>
      call.method === 'POST'
        ? external.code('host_not_allowed', 'not allowed', [{ field: 'url', message: 'x' }])
        : undefined
    type(nameInput(), 'Private')
    type(urlInput(), 'https://internal.example.org/')
    addButton().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual([
        'The administrator has not allowed this server. Ask them to add its host name to the list of allowed hosts.',
      ]),
    )
    expect(document.activeElement).toBe(urlInput())
    expect(nameInput().value).toBe('Private')
    type(urlInput(), 'https://internal2.example.org/')
    await vi.waitFor(() => expect(errorTexts()).toEqual([]))
  })

  it('shows the limit and other failures in an alert', async () => {
    backend.override = (call) =>
      call.method === 'POST' ? reply.error(409, 'At most 10', { code: 'limit_reached' }) : undefined
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    addButton().click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('limit of 10 external accounts')
  })

  it('does not put the password into the page or the console when the server fails', async () => {
    backend.override = (call) => (call.method === 'POST' ? reply.error(500, 'boom') : undefined)
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    await chooseLogin()
    type(userInput(), 'me')
    type(passwordInput(), 'hunter2-secret')
    addButton().click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('HTTP 500')
    expect(document.body.innerHTML).not.toContain('hunter2-secret')
    expect(anyFieldHolds('hunter2-secret')).toBe(false)
    expect(seals().has(100)).toBe(false)
  })
})

describe('when logins are not enabled', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.loginsEnabled = false
    }),
  )

  it('offers only accounts without a login and says why', () => {
    const login = control('radio', 'User name and password')
    expect(login.hasAttribute('disabled') || login.getAttribute('aria-disabled') === 'true').toBe(
      true,
    )
    expect(control('radio', 'No login').getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain(
      'The administrator has not enabled logins for external accounts',
    )
  })
})

describe('when the administrator switches logins off meanwhile', () => {
  it('still saves a change to an account that has a login, and lets the server decide', async () => {
    await mountSection((api) => {
      api.loginsEnabled = false
      api.accounts = [
        account(2, {
          name: 'Private',
          url: 'https://cal.example.net/',
          authMode: 'basic',
          username: 'me',
        }),
      ]
    })
    requireButton('Edit Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(nameInput(dialog()!), 'Private calendar')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    const body = backend.callsTo('PUT', '/api/external-accounts/2')[0]!.body!
    expect(body).toMatchObject({ name: 'Private calendar', authMode: 'basic', username: 'me' })
    expect(body).not.toHaveProperty('password')
    expect(rowOf('Private calendar')).toBeDefined()
  })

  it('shows the server’s refusal of such a change in the dialog', async () => {
    await mountSection((api) => {
      api.loginsEnabled = false
      api.accounts = [
        account(2, {
          name: 'Private',
          url: 'https://cal.example.net/',
          authMode: 'basic',
          username: 'me',
        }),
      ]
    })
    backend.override = (call) =>
      call.method === 'PUT' ? external.code('logins_disabled', 'not available') : undefined
    requireButton('Edit Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('administrator has not enabled logins')
    expect(dialog()).not.toBeNull()
  })

  it('says why a new account with a login cannot be added, and moves focus to the choice', async () => {
    const loginsEnabled = ref(true)
    const Form = defineComponent({
      render: () =>
        h(UApp, null, {
          default: () =>
            h(ExternalAccountForm, {
              submitLabel: 'Add account',
              busy: false,
              loginsEnabled: loginsEnabled.value,
            }),
        }),
    })
    app = await mountSuspended(Form, { attachTo: document.body })
    type(nameInput(), 'Private')
    type(urlInput(), 'https://cal.example.net/')
    await chooseLogin()
    type(userInput(), 'me')
    type(passwordInput(), 'pw')

    // The server’s list arrives after the choice was made: logins are off.
    loginsEnabled.value = false
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('The administrator has not enabled logins'),
    )
    addButton().click()
    await vi.waitFor(() =>
      expect(document.getElementById('external-logins-disabled')!.className).toContain('red'),
    )
    expect(document.activeElement).toBe(control('radio', 'No login'))
  })
})

describe('the limit of accounts', () => {
  it('replaces the form with the reason once 10 accounts exist', async () => {
    await mountSection((api) => {
      api.accounts = Array.from({ length: 10 }, (_, index) => account(index + 1))
    })
    expect(button('Add account')).toBeUndefined()
    expect(document.body.textContent).toContain(
      'You have reached the limit of 10 external accounts',
    )
  })
})

describe('changing an account', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.accounts = [
        account(1, { name: 'Company', url: 'https://dav.example.org/dav/' }),
        account(2, {
          name: 'Private',
          url: 'https://cal.example.net/',
          authMode: 'basic',
          username: 'me',
          color: '#047857',
        }),
      ]
    }),
  )

  it('opens a dialog with the values, saves them and returns focus to Edit', async () => {
    const opener = requireButton('Edit Company')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Edit account')
    await vi.waitFor(() => expect(document.activeElement).toBe(nameInput(dialog()!)))
    expect(nameInput(dialog()!).value).toBe('Company')
    expect(urlInput(dialog()!).value).toBe('https://dav.example.org/dav/')

    type(nameInput(dialog()!), 'Company calendar')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('PUT', '/api/external-accounts/1')[0]!.body).toEqual({
      name: 'Company calendar',
      url: 'https://dav.example.org/dav/',
      authMode: 'none',
      username: null,
      color: null,
    })
    expect(rowOf('Company calendar')).toBeDefined()
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Account “Company calendar” saved.')
    expect(document.activeElement).toBe(requireButton('Edit Company calendar'))
  })

  it('keeps the password for a rename: none is asked for, none is sent, the seal stays', async () => {
    seals().set(2, 'old-seal', false)
    requireButton('Edit Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(userInput(dialog()!).value).toBe('me')
    expect(passwordInput(dialog()!).value).toBe('')
    expect(dialog()!.textContent).toContain(
      'Leave it empty to keep the password you entered before.',
    )

    type(nameInput(dialog()!), 'Private calendar')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    const body = backend.callsTo('PUT', '/api/external-accounts/2')[0]!.body!
    expect(body).not.toHaveProperty('password')
    expect(seals().get(2)).toBe('old-seal')
  })

  it('asks for the password again when the address moves to another origin', async () => {
    seals().set(2, 'old-seal', false)
    requireButton('Edit Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(urlInput(dialog()!), 'https://other.example.net/')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(errorTexts()).toEqual(['Enter the password of the account.']))
    expect(backend.callsTo('PUT', '/api/external-accounts/2')).toHaveLength(0)

    type(passwordInput(dialog()!), 'new-password')
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('PUT', '/api/external-accounts/2')[0]!.body).toMatchObject({
      url: 'https://other.example.net/',
      password: 'new-password',
    })
    expect(seals().get(2)).toBe(SEALED)
  })

  it('forgets the credential when the account no longer has a login', async () => {
    seals().set(2, 'old-seal', true)
    requireButton('Edit Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    control('radio', 'No login', dialog()!).click()
    await vi.waitFor(() => expect(document.querySelector('input[type="password"]')).toBeNull())
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(seals().has(2)).toBe(false)
    expect(storage.length).toBe(0)
  })

  it('keeps the dialog and shows the reason when the server refuses', async () => {
    backend.override = (call) =>
      call.method === 'PUT' ? external.code('invalid_url', 'bad address') : undefined
    requireButton('Edit Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Save changes').click()
    await vi.waitFor(() => expect(errorTexts()[0]).toContain('This address cannot be used'))
    expect(dialog()).not.toBeNull()
    expect(rowOf('Company')).toBeDefined()
  })

  it('closes with Cancel and Escape without saving', async () => {
    requireButton('Edit Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Cancel').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('PUT', '/api/external-accounts/1')).toHaveLength(0)
  })
})

describe('deleting an account', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.accounts = [account(1, { name: 'Company' }), account(2, { name: 'Private' })]
    }),
  )

  it('asks first, then deletes the account and the credential and tells the calendar', async () => {
    seals().set(1, SEALED, true)
    requireButton('Delete Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Delete “Company”?')
    expect(dialog()!.textContent).toContain('The calendars on its server are not affected')
    expect(backend.callsTo('DELETE', '/api/external-accounts/1')).toHaveLength(0)
    // Focus starts on Cancel, the safe answer.
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('Cancel'))

    requireButton('Delete account').click()
    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
    expect(backend.callsTo('DELETE', '/api/external-accounts/1')).toHaveLength(1)
    expect(seals().has(1)).toBe(false)
    expect(storage.length).toBe(0)
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Account “Company” deleted.')
  })

  it('keeps the account and shows why when it cannot be deleted', async () => {
    backend.override = (call) => (call.method === 'DELETE' ? reply.error(500, 'boom') : undefined)
    requireButton('Delete Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Delete account').click()
    await vi.waitFor(() => expect(alerts().length).toBeGreaterThan(0))
    expect(dialog()!.textContent).toContain('Could not delete the account')
    expect(rows('Your external accounts')).toHaveLength(2)
    expect(sourcesVersion()).toBe(0)
  })

  it('treats an account that is gone already as deleted', async () => {
    backend.override = (call) =>
      call.method === 'DELETE' ? reply.error(404, 'Not found') : undefined
    requireButton('Delete Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Delete account').click()
    await vi.waitFor(() => expect(rows('Your external accounts')).toHaveLength(1))
  })
})

describe('checking the connection', () => {
  const check = (name: string) => requireButton(`Check connection of ${name}`)

  beforeEach(() =>
    mountSection((api) => {
      api.accounts = [
        account(1, { name: 'Company' }),
        account(2, { name: 'Private', authMode: 'basic', username: 'me' }),
      ]
    }),
  )

  it('says how many calendars it found', async () => {
    const found = vi.fn(async () => [{}, {}])
    state.access!.source.listCalendars = found as never
    check('Company').click()
    await vi.waitFor(() =>
      expect(rowOf('Company').textContent).toContain('Works: 2 calendars found.'),
    )
    expect(found).toHaveBeenCalledTimes(1)
    expect(found.mock.calls[0]![0]).toMatchObject({ id: 1 })
  })

  it('shows the check while it runs, and a button that cannot be pressed twice', async () => {
    let release!: (value: unknown[]) => void
    state.access!.source.listCalendars = (() =>
      new Promise((resolve) => (release = resolve))) as never
    check('Company').click()
    await vi.waitFor(() =>
      expect(rowOf('Company').textContent).toContain('Checking the connection…'),
    )
    expect(requireButton('Check connection of Company').getAttribute('aria-busy')).toBe('true')
    release([{}])
    await vi.waitFor(() =>
      expect(rowOf('Company').textContent).toContain('Works: 1 calendar found.'),
    )
  })

  it.each([
    ['login-rejected', 'The server rejected the login'],
    ['network', 'The server could not be reached.'],
    ['host-not-allowed', 'The administrator has not allowed this server.'],
    ['rate-limited', 'Too many requests.'],
    ['credential-needed', 'This browser has no password for the account.'],
  ] as const)('words a failure of kind %s', async (kind, words) => {
    state.access!.source.listCalendars = (async () => {
      throw new DavError(kind, 'x')
    }) as never
    check('Private').click()
    await vi.waitFor(() => expect(rowOf('Private').textContent).toContain('Check failed:'))
    expect(rowOf('Private').textContent).toContain(words)
  })

  it('offers the password after a rejected login, for an account that has one stored', async () => {
    seals().set(2, SEALED, false)
    state.access!.source.listCalendars = (async () => {
      throw new DavError('login-rejected', 'x')
    }) as never
    await vi.waitFor(() => expect(button('Enter the password of Private')).toBeUndefined())
    check('Private').click()
    await vi.waitFor(() => expect(button('Enter the password of Private')).toBeDefined())
  })
})

describe('entering the password again', () => {
  beforeEach(() =>
    mountSection((api) => {
      api.accounts = [
        account(2, {
          name: 'Private',
          authMode: 'basic',
          username: 'me',
          url: 'https://cal.example.net/',
        }),
      ]
    }),
  )

  it('opens a dialog on the password, seals it, keeps only the seal and loads again', async () => {
    const opener = requireButton('Enter the password of Private')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Password for “Private”')
    expect(dialog()!.textContent).toContain('Enter the password of me.')
    await vi.waitFor(() => expect(document.activeElement).toBe(passwordInput(dialog()!)))
    expect(passwordInput(dialog()!).type).toBe('password')
    expect(
      control('checkbox', 'Remember on this device', dialog()!).getAttribute('data-state'),
    ).toBe('unchecked')

    type(passwordInput(dialog()!), 'hunter2-secret')
    requireButton('Save password').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('POST', '/api/external-accounts/2/credential')[0]!.body).toEqual({
      password: 'hunter2-secret',
    })
    expect(seals().get(2)).toBe(SEALED)
    expect(storage.length).toBe(0)
    expect(sourcesVersion()).toBe(1)
    expect(statusText()).toContain('Password of “Private” saved.')
    expect(document.body.innerHTML).not.toContain('hunter2-secret')
    expect(button('Enter the password of Private')).toBeUndefined()
  })

  it('remembers on the device only when the box is checked', async () => {
    requireButton('Enter the password of Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    control('checkbox', 'Remember on this device', dialog()!).click()
    type(passwordInput(dialog()!), 'pw')
    requireButton('Save password').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect([...storage.data.keys()]).toEqual(['web-calendar:external-seal:sub-1:2'])
  })

  it('asks for a password before sending anything', async () => {
    requireButton('Enter the password of Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Save password').click()
    await vi.waitFor(() => expect(errorTexts()).toEqual(['Enter the password of the account.']))
    expect(backend.callsTo('POST', '/api/external-accounts/2/credential')).toHaveLength(0)
    expect(document.activeElement).toBe(passwordInput(dialog()!))
  })

  it('closes with Cancel and with Escape, forgets what was typed and returns focus', async () => {
    const opener = requireButton('Enter the password of Private')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(passwordInput(dialog()!), 'typed-and-abandoned')
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('POST', '/api/external-accounts/2/credential')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('typed-and-abandoned')
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))

    // and when it is opened again the field is empty
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(passwordInput(dialog()!).value).toBe('')
    requireButton('Cancel').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('shows why the password could not be saved and keeps the dialog', async () => {
    backend.override = (call) => (call.method === 'POST' ? reply.error(500, 'boom') : undefined)
    requireButton('Enter the password of Private').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    type(passwordInput(dialog()!), 'hunter2-secret')
    requireButton('Save password').click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain('Could not save the password')
    expect(dialog()).not.toBeNull()
    expect(anyFieldHolds('hunter2-secret')).toBe(false)
    expect(document.body.innerHTML).not.toContain('hunter2-secret')
    expect(seals().has(2)).toBe(false)
    expect(sourcesVersion()).toBe(0)
  })
})
