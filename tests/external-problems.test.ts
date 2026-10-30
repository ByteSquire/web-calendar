// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarProblems, UApp } from '#components'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { externalAccountKey } from '../app/utils/live/errors'
import { SEALED, account } from './external-helpers'
import { ExternalBackend, newAccess } from './external-section-helpers'
import { alerts, button, dialog, field, reply, requireButton, type } from './settings-helpers'

// The external accounts in the problems list of the sidebar (FR-8, NFR-4): one entry per failing
// account with a Retry, and "Enter password again" where a new password cures it.

const state = vi.hoisted(() => ({
  access: null as null | ReturnType<typeof import('./external-section-helpers').newAccess>,
}))
vi.mock('~/composables/useExternalAccess', () => ({ useExternalAccess: () => state.access! }))

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(SidebarProblems) }),
})

let backend: ExternalBackend
let app: Awaited<ReturnType<typeof mountSuspended>>
let consoleError: ReturnType<typeof vi.spyOn>

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const items = () => [...document.querySelectorAll('[data-sidebar-problems] li')]
const sourcesVersion = () => useState<number>('calendar-sources-version', () => 0).value

function problems(errors: Record<string, string>, passwordFor: Record<string, number> = {}) {
  useState<Record<string, string>>('live-errors').value = errors
  useState<Record<string, number>>('live-password-for').value = passwordFor
  useState('live-external-accounts').value = [
    account(1, { name: 'Company', authMode: 'basic', username: 'me' }),
    account(2, { name: 'Team' }),
  ]
}

async function mountProblems() {
  state.access = newAccess(backend)
  app = await mountSuspended(Shell, { attachTo: document.body })
}

beforeEach(() => {
  backend = new ExternalBackend()
  backend.accounts = [
    account(1, { name: 'Company', authMode: 'basic', username: 'me' }),
    account(2, { name: 'Team' }),
  ]
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

describe('an external account in the problems list', () => {
  it('is named by the account, with its message and a Retry', async () => {
    problems({ [externalAccountKey(2)]: 'Not reachable' })
    await mountProblems()
    expect(items().map(text)).toEqual([expect.stringContaining('Team: Not reachable')])
    expect(button('Retry Team')).toBeDefined()
    expect(button('Enter password again for Team')).toBeUndefined()
  })

  it('offers "Enter password again" where a new password cures it, next to Retry', async () => {
    problems({ [externalAccountKey(1)]: 'Login rejected' }, { [externalAccountKey(1)]: 1 })
    await mountProblems()
    expect(text(items()[0])).toContain('Company: Login rejected')
    const row = items()[0]!
    expect(button('Enter password again for Company', row)).toBeDefined()
    expect(button('Retry Company', row)).toBeDefined()
    // both are 44 px targets (the app's button size) and the row wraps at narrow widths
    expect(row.className).toContain('flex-wrap')
    expect(button('Enter password again for Company', row)!.className).toContain('min-h-11')
  })

  it('names a calendar of an account by its own name', async () => {
    problems({ 'ext:2:https://cal.example.net/team/': 'Server unavailable' })
    useState('cal-calendars').value = [
      {
        id: 'ext:2:https://cal.example.net/team/',
        name: 'Team plan',
        type: 'caldav',
        color: '#112233',
        defaultVisible: true,
      },
    ]
    await mountProblems()
    expect(text(items()[0])).toContain('Team plan: Server unavailable')
  })

  it('has no dialog open until it is asked for', async () => {
    problems({ [externalAccountKey(1)]: 'Password needed' }, { [externalAccountKey(1)]: 1 })
    await mountProblems()
    expect(dialog()).toBeNull()
  })
})

describe('entering the password again', () => {
  beforeEach(async () => {
    problems({ [externalAccountKey(1)]: 'Password needed' }, { [externalAccountKey(1)]: 1 })
    await mountProblems()
  })

  const open = async () => {
    requireButton('Enter password again for Company').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
  }

  it('opens the password dialog for the account, focused on the field', async () => {
    await open()
    expect(dialog()!.textContent).toContain('Password for “Company”')
    expect(dialog()!.textContent).toContain('Enter the password of me.')
    const input = field('Password', dialog()!)
    expect(input.type).toBe('password')
    await vi.waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('seals the password, keeps the sealed text, closes and loads everything again', async () => {
    await open()
    type(field('Password', dialog()!), 'hunter2-secret')
    requireButton('Save password').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('POST', '/api/external-accounts/1/credential')[0]!.body).toEqual({
      password: 'hunter2-secret',
    })
    expect(state.access!.seals.get(1)).toBe(SEALED)
    expect(state.access!.seals.isRemembered(1)).toBe(false)
    expect(sourcesVersion()).toBe(1)
    expect([...document.querySelectorAll('input')].some((i) => i.value.includes('hunter2'))).toBe(
      false,
    )
  })

  it('tells when the browser did not allow keeping the password on this device', async () => {
    await open()
    type(field('Password', dialog()!), 'pw')
    dialog()!.querySelector<HTMLElement>('[role="checkbox"]')!.click()
    requireButton('Save password').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    // There is no device storage in this test, so "remember" cannot work; the password is in memory.
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('did not allow keeping it on this device'),
    )
    expect(state.access!.seals.get(1)).toBe(SEALED)
    expect(state.access!.seals.isRemembered(1)).toBe(false)
  })

  it('stays open with the reason when the password cannot be saved', async () => {
    backend.override = (call) => (call.method === 'POST' ? reply.error(500, 'boom') : undefined)
    await open()
    type(field('Password', dialog()!), 'hunter2-secret')
    requireButton('Save password').click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(dialog()).not.toBeNull()
    expect(sourcesVersion()).toBe(0)
    expect(state.access!.seals.has(1)).toBe(false)
  })

  it('closes with Cancel and changes nothing', async () => {
    await open()
    requireButton('Cancel').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('POST', '/api/external-accounts/1/credential')).toHaveLength(0)
    expect(sourcesVersion()).toBe(0)
  })
})
