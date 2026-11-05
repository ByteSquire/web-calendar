// @vitest-environment nuxt
// The Groups entry in the overflow menu: for every signed-in user, not an admin-only entry, and not
// in demo mode (where there is no API behind the page).
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

describe('the Groups entry', () => {
  it.each([
    ['an administrator', true],
    ['somebody who is not an administrator', false],
  ])('is in the menu for %s and leads to the page', async (_label, admin) => {
    configure(false)
    useState('admin-flag').value = admin
    await open()
    expect(items()).toContain('Groups')
    expect(document.querySelector('[role="menuitem"][href="/groups"]')?.textContent).toContain(
      'Groups',
    )
  })

  it('is not in the menu in demo mode', async () => {
    configure(true)
    useState('admin-flag').value = true
    await open()
    expect(items()).not.toContain('Groups')
    expect(document.querySelector('[href="/groups"]')).toBeNull()
  })
})
