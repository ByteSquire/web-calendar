// @vitest-environment nuxt
// The entry for the access administration in the overflow menu: admins only, never in demo mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { OverflowMenu, UApp } from '#components'
import { useServerConfigState } from '~/composables/useServerConfigState'

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => [h(OverflowMenu)] }),
})

let app: Awaited<ReturnType<typeof mountSuspended>>

function configure(demo: boolean) {
  useServerConfigState().value = {
    oidc: { issuer: demo ? '' : 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: 'Europe/Berlin',
    demo,
  }
}

async function open() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More options"]')!
  trigger.focus()
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
}

const items = () =>
  [...document.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim())

beforeEach(() => {
  clearNuxtState((key) => key !== 'color-mode')
  useColorMode().preference = 'system'
})

afterEach(() => {
  app.unmount()
  clearNuxtState((key) => key !== 'color-mode')
  document.body.innerHTML = ''
})

describe('the Calendars and People entries', () => {
  it('are in the menu for an admin and lead to the pages', async () => {
    configure(false)
    useState('admin-flag').value = true
    await open()
    expect(items()).toEqual(expect.arrayContaining(['Calendars', 'People']))
    expect(
      document.querySelector('[role="menuitem"][href="/admin/calendars"]')?.textContent,
    ).toContain('Calendars')
    expect(
      document.querySelector('[role="menuitem"][href="/admin/people"]')?.textContent,
    ).toContain('People')
  })

  it.each([
    ['somebody who is not an admin', false],
    ['somebody whose status is not known yet', null],
  ])('are not in the menu for %s', async (_label, flag) => {
    configure(false)
    useState('admin-flag').value = flag
    await open()
    expect(items()).not.toContain('Calendars')
    expect(items()).not.toContain('People')
    expect(document.querySelector('[href="/admin/calendars"]')).toBeNull()
    expect(document.querySelector('[href="/admin/people"]')).toBeNull()
  })

  it('are not in the menu in demo mode', async () => {
    configure(true)
    useState('admin-flag').value = true
    await open()
    expect(items()).not.toContain('Calendars')
    expect(items()).not.toContain('People')
  })
})

describe('the Resources entry', () => {
  it('is in the menu for an admin and leads to the page', async () => {
    configure(false)
    useState('admin-flag').value = true
    await open()
    expect(items()).toContain('Resources')
    expect(
      document.querySelector('[role="menuitem"][href="/admin/resources"]')?.textContent,
    ).toContain('Resources')
  })

  it.each([
    ['somebody who is not an admin', false],
    ['somebody whose status is not known yet', null],
  ])('is not in the menu for %s', async (_label, flag) => {
    configure(false)
    useState('admin-flag').value = flag
    await open()
    expect(items()).not.toContain('Resources')
    expect(document.querySelector('[href="/admin/resources"]')).toBeNull()
  })

  it('is not in the menu in demo mode', async () => {
    configure(true)
    useState('admin-flag').value = true
    await open()
    expect(items()).not.toContain('Resources')
  })
})
