// @vitest-environment nuxt
// "Your sign-in has expired" inside a real Nuxt UI app, with the login state of `useAuth` as plain
// Nuxt state: it opens when the sign-in expires while the app is open, signs in again to the page
// the person is on, shows why that failed, closes with "Not now" and opens again at the next
// request that finds the session gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { clearNuxtState, useState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import SignInExpiredDialog from '~/components/SignInExpiredDialog.vue'
import type { AuthStatus } from '~/utils/auth/types'

const login = vi.hoisted(() => vi.fn<(returnTo?: string) => Promise<void>>())
vi.mock('~/composables/useAuth', async () => {
  const { useState } = await import('#app')
  return {
    useAuth: () => ({
      status: useState<AuthStatus>('auth-status', () => 'authenticated'),
      expiredSignal: useState<number>('auth-expired-signal', () => 0),
      login,
    }),
  }
})

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(SignInExpiredDialog) }),
})

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

beforeEach(() => {
  login.mockReset()
  // The page leaves for the provider: the promise does not settle.
  login.mockImplementation(() => new Promise<void>(() => undefined))
  clearNuxtState()
  useState<AuthStatus>('auth-status').value = 'authenticated'
  useState<number>('auth-expired-signal').value = 0
})

afterEach(() => {
  app?.unmount()
  app = undefined
  clearNuxtState()
  document.body.innerHTML = ''
})

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const dialog = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((item) =>
    text(item)?.includes('Your sign-in has expired'),
  )
const button = (name: RegExp) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) =>
    name.test(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? ''),
  )

/** The session runs out while the app is on screen: what the controller does. */
function expire() {
  useState<AuthStatus>('auth-status').value = 'expired'
  useState<number>('auth-expired-signal').value += 1
}

async function mount() {
  app = await mountSuspended(Shell, { attachTo: document.body })
}

describe('the expired sign-in dialog', () => {
  it('opens only when the sign-in expires, and says what signing in again costs', async () => {
    await mount()
    await nextTick()
    expect(dialog()).toBeUndefined()
    expire()
    await vi.waitFor(() => expect(dialog()).toBeDefined())
    expect(text(dialog())).toContain('Anything you have not saved yet is lost when you do')
    expect(button(/^Sign in again$/)).toBeDefined()
    expect(button(/^Not now$/)).toBeDefined()
  })

  it('signs in again to the page the person is on', async () => {
    await mount()
    expire()
    await vi.waitFor(() => expect(button(/^Sign in again$/)).toBeDefined())
    button(/^Sign in again$/)!.click()
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
    expect(login).toHaveBeenCalledWith('/')
  })

  it('shows why signing in again failed, and stays open to try again', async () => {
    login.mockImplementation(async () => Promise.reject(new TypeError('Failed to fetch')))
    await mount()
    expire()
    await vi.waitFor(() => expect(button(/^Sign in again$/)).toBeDefined())
    button(/^Sign in again$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Check your connection'))
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('connection')
    expect(button(/^Sign in again$/)?.disabled).toBe(false)
  })

  it('closes with "Not now" and asks again at the next request that needs the session', async () => {
    await mount()
    expire()
    await vi.waitFor(() => expect(button(/^Not now$/)).toBeDefined())
    button(/^Not now$/)!.click()
    await vi.waitFor(() => expect(dialog()).toBeUndefined())
    expect(login).not.toHaveBeenCalled()
    // another request finds the session gone
    useState<number>('auth-expired-signal').value += 1
    await vi.waitFor(() => expect(dialog()).toBeDefined())
  })

  it('closes when the status leaves "expired" (a sign-out)', async () => {
    await mount()
    expire()
    await vi.waitFor(() => expect(dialog()).toBeDefined())
    useState<AuthStatus>('auth-status').value = 'unauthenticated'
    await vi.waitFor(() => expect(dialog()).toBeUndefined())
  })
})
