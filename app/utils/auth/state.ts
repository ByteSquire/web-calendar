// Decisions of the login that need no Nuxt: the demo user, which routes need a login and what the
// route guard does in each state. Pure, so tests/auth-state.test.ts runs them in plain Vitest.
import type { AuthStatus, AuthUserInfo } from './types'

export const AUTH_CALLBACK_PATH = '/auth/callback'
export const SIGNED_OUT_PATH = '/auth/signed-out'

/** Demo mode (no login, mock data): the user the mock data is about. */
export const DEMO_USER: AuthUserInfo = {
  sub: 'demo-user',
  name: 'Alex Doe',
  email: 'alex@example.com',
  username: 'alex',
}

/** Demo mode comes from `/api/config`; without the settings it is off. */
export function isDemoConfig(config: { demo?: boolean } | null | undefined): boolean {
  return config?.demo === true
}

/** The prefix of the page of a calendar link, which a visitor opens with its password. */
export const CALENDAR_LINK_PREFIX = '/link/'

/**
 * The pages that must open without a login: the one that finishes it, the signed-out page and the
 * page of a calendar link.
 */
export function isPublicAuthPath(path: string): boolean {
  return (
    path === AUTH_CALLBACK_PATH || path === SIGNED_OUT_PATH || path.startsWith(CALENDAR_LINK_PREFIX)
  )
}

export type GuardAction =
  /** Let the navigation go on. */
  | 'pass'
  /** Start the login; the page that was asked for is shown after it. */
  | 'login'
  /** The login state is not known yet. */
  | 'wait'

/**
 * What the global route guard does. A state of `error` also starts the login: the next attempt may
 * work (the provider was down), and if sign-in is not configured at all, `login` fails again and
 * the guard shows that.
 */
export function routeGuardAction(input: {
  demo: boolean
  status: AuthStatus
  path: string
}): GuardAction {
  if (input.demo || isPublicAuthPath(input.path)) return 'pass'
  if (input.status === 'loading') return 'wait'
  return input.status === 'authenticated' ? 'pass' : 'login'
}

/**
 * Whether `url` carries an authorization response (`code` or `error`, in the query or, for the
 * fragment response mode, after the `#`).
 */
export function looksLikeAuthResponse(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, 'http://app.invalid')
  } catch {
    return false
  }
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''))
  return [parsed.searchParams, fragment].some((params) => params.has('code') || params.has('error'))
}
