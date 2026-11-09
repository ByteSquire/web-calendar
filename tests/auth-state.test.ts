// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  AUTH_CALLBACK_PATH,
  DEMO_USER,
  SIGNED_OUT_PATH,
  isDemoConfig,
  isPublicAuthPath,
  looksLikeAuthResponse,
  routeGuardAction,
} from '../app/utils/auth/state'
import type { AuthStatus } from '../app/utils/auth/types'

describe('routeGuardAction', () => {
  const STATUSES: AuthStatus[] = ['loading', 'authenticated', 'expired', 'unauthenticated', 'error']

  it.each([
    // [demo, status, path, action]
    [false, 'authenticated', '/', 'pass'],
    [false, 'authenticated', '/anything?x=1', 'pass'],
    [false, 'unauthenticated', '/', 'login'],
    [false, 'unauthenticated', '/calendar', 'login'],
    [false, 'error', '/', 'login'],
    // an expired sign-in stays on screen, but moving on to another page signs in again
    [false, 'expired', '/settings', 'login'],
    [false, 'loading', '/', 'wait'],
    // the login's own pages never need a session
    [false, 'unauthenticated', AUTH_CALLBACK_PATH, 'pass'],
    [false, 'error', AUTH_CALLBACK_PATH, 'pass'],
    [false, 'loading', AUTH_CALLBACK_PATH, 'pass'],
    [false, 'unauthenticated', SIGNED_OUT_PATH, 'pass'],
    // lookalikes do
    [false, 'unauthenticated', '/auth/callback/x', 'login'],
    [false, 'unauthenticated', '/auth/callbackx', 'login'],
    [false, 'unauthenticated', '/x/auth/callback', 'login'],
  ] as const)('demo=%s status=%s path=%s -> %s', (demo, status, path, action) => {
    expect(routeGuardAction({ demo, status, path })).toBe(action)
  })

  it('an expired sign-in lets a navigation on the same page pass (Back closing a dialog)', () => {
    const guard = (path: string, from: string) =>
      routeGuardAction({ demo: false, status: 'expired', path, from })
    expect(guard('/', '/')).toBe('pass')
    expect(guard('/resources/requests', '/resources/requests')).toBe('pass')
    expect(guard('/settings', '/')).toBe('login')
    // the same page is no reason to pass for anyone else: they are not signed in at all
    expect(routeGuardAction({ demo: false, status: 'unauthenticated', path: '/', from: '/' })).toBe(
      'login',
    )
  })

  it('demo mode passes everything in every state', () => {
    for (const status of STATUSES) {
      for (const path of ['/', '/calendar', AUTH_CALLBACK_PATH, '/x?y=1']) {
        expect(routeGuardAction({ demo: true, status, path })).toBe('pass')
      }
    }
  })
})

describe('isPublicAuthPath', () => {
  it('is exactly the callback and the signed-out page', () => {
    expect(isPublicAuthPath('/auth/callback')).toBe(true)
    expect(isPublicAuthPath('/auth/signed-out')).toBe(true)
    expect(isPublicAuthPath('/')).toBe(false)
    expect(isPublicAuthPath('/auth')).toBe(false)
    expect(isPublicAuthPath('/auth/callback/')).toBe(false)
  })
})

describe('isDemoConfig', () => {
  it('is on only for demo === true', () => {
    expect(isDemoConfig({ demo: true })).toBe(true)
    expect(isDemoConfig({ demo: false })).toBe(false)
    expect(isDemoConfig({})).toBe(false)
    expect(isDemoConfig(null)).toBe(false)
    expect(isDemoConfig(undefined)).toBe(false)
  })
})

describe('looksLikeAuthResponse', () => {
  it.each([
    ['https://app.example.org/auth/callback?code=abc&state=xyz', true],
    ['https://app.example.org/auth/callback?error=access_denied&state=xyz', true],
    ['https://app.example.org/auth/callback#code=abc&state=xyz', true],
    ['https://app.example.org/auth/callback#error=access_denied', true],
    ['https://app.example.org/auth/callback', false],
    ['https://app.example.org/auth/callback?state=xyz', false],
    ['https://app.example.org/auth/callback?x=1#y', false],
    ['/auth/callback?code=1', true],
  ])('%s -> %s', (url, expected) => {
    expect(looksLikeAuthResponse(url)).toBe(expected)
  })
})

describe('DEMO_USER', () => {
  it('is the mock user of the demo data', () => {
    expect(DEMO_USER.name).toBe('Alex Doe')
    expect(DEMO_USER.email).toBe('alex@example.com')
  })
})
