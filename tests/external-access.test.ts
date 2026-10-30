// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { clearNuxtState, useNuxtApp, useState } from '#app'
import { useEventWrites } from '~/composables/useEventWrites'
import { useExternalAccess } from '~/composables/useExternalAccess'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { AuthStatus, AuthUserInfo } from '~/utils/auth/types'
import { DavError } from '../app/utils/caldav/errors'

const refresh = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('~/composables/useLiveCalendar', () => ({
  useLiveStatus: () => ({ refresh }),
}))

// The per-app set of the external accounts' API, seal store and source: one of each, and the
// credentials in memory go when the user signs out (the copies on the device are the user's choice).

const USER: AuthUserInfo = { sub: 'sub-1', name: 'Alice', email: null, username: 'alice' }
const KEY = 'web-calendar:external-seal:sub-1:1'

function access() {
  return useNuxtApp().runWithContext(() => useExternalAccess())
}

beforeEach(() => {
  localStorage.clear()
  useServerConfigState().value = {
    oidc: { issuer: '', clientId: '', scope: '' },
    timezone: 'Europe/Berlin',
    demo: false,
  }
  useState<AuthStatus>('auth-status').value = 'authenticated'
  useState<AuthUserInfo | null>('auth-user').value = USER
})

afterEach(() => {
  localStorage.clear()
  clearNuxtState()
})

describe('useExternalAccess', () => {
  it('is one set per app', () => {
    expect(access()).toBe(access())
    expect(Object.keys(access()).sort()).toEqual(['api', 'seals', 'source'])
  })

  it('forgets the credentials in memory when the user signs out, and keeps the device copies', async () => {
    const { seals } = access()
    seals.set(1, 'sealed-one', true)
    seals.set(2, 'sealed-two', false)
    expect(localStorage.getItem(KEY)).toBe('sealed-one')

    useState<AuthStatus>('auth-status').value = 'unauthenticated'
    await nextTick()
    expect(seals.get(1)).toBeNull()
    expect(seals.get(2)).toBeNull()
    expect(localStorage.getItem(KEY)).toBe('sealed-one')
  })

  it('keeps them while the user stays signed in', async () => {
    const { seals } = access()
    seals.set(2, 'sealed-two', false)
    useState<AuthStatus>('auth-status').value = 'authenticated'
    await nextTick()
    expect(seals.get(2)).toBe('sealed-two')
  })

  it('keys the copy on the device by the signed-in user', () => {
    const { seals } = access()
    useState<AuthUserInfo | null>('auth-user').value = { ...USER, sub: 'sub-9' }
    seals.set(1, 'sealed-one', true)
    expect(localStorage.getItem('web-calendar:external-seal:sub-9:1')).toBe('sealed-one')
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('a write to the built-in service', () => {
  it('reloads without the external accounts: it must not wait for their servers', async () => {
    useServerConfigState().value = {
      oidc: {
        issuer: 'https://idm.example.org/oauth2/openid/web-calendar',
        clientId: 'x',
        scope: 'openid',
      },
      timezone: 'Europe/Berlin',
      demo: false,
    }
    // The event is gone already, which a delete counts as done and reloads for.
    const client = {
      getObject: async () => {
        throw new DavError('not-found', 'gone')
      },
    }
    ;(useNuxtApp() as unknown as { $caldav: unknown }).$caldav = {
      client,
      reader: { invalidate: vi.fn() },
    }
    const writes = useNuxtApp().runWithContext(() => useEventWrites())
    const outcome = await writes.remove({
      target: { href: '/caldav/u/a/e.ics', calendarHref: '/caldav/u/a/', recurring: false },
      scope: null,
    } as never)
    expect(outcome).toMatchObject({ ok: true, alreadyGone: true })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ external: false })
  })
})
