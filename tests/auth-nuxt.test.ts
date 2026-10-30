// @vitest-environment nuxt
// The wiring in Nuxt: the composable reads the settings from the shared state, the route guard
// follows the status. The decisions themselves are tested without Nuxt (auth-controller, auth-state).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { useNuxtApp } from '#app'
import { useAuth } from '~/composables/useAuth'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useServerConfigState } from '~/composables/useServerConfigState'
import authGuard from '~/middleware/auth.global'
import CallbackPage from '~/pages/auth/callback.vue'
import SignedOutPage from '~/pages/auth/signed-out.vue'
import type { ServerConfig } from '~/plugins/server-config'
import { DEMO_USER } from '~/utils/auth/state'

const OIDC = {
  issuer: 'https://idm.example.org/oauth2/openid/web-calendar',
  clientId: 'web-calendar',
  scope: 'openid profile',
}

function useConfig(config: Partial<ServerConfig>) {
  useServerConfigState().value = { oidc: OIDC, timezone: 'Europe/Berlin', demo: false, ...config }
}

function route(path: string) {
  return { path, fullPath: path } as RouteLocationNormalized
}

/** Runs the global guard like the router does. */
function guard(path: string) {
  const to = route(path)
  return useNuxtApp().runWithContext(() => authGuard(to, to))
}

describe('demo mode', () => {
  it('is signed in as the mock user and the guard lets everything pass', async () => {
    useConfig({ demo: true, oidc: { issuer: '', clientId: '', scope: '' } })
    const auth = useAuth()
    await auth.initialize()
    expect(auth.status.value).toBe('authenticated')
    expect(auth.user.value).toEqual(DEMO_USER)
    expect(auth.isDemo.value).toBe(true)
    expect(await auth.getAccessToken()).toBe('')
    expect(await guard('/')).toBeUndefined()
    expect(await guard('/auth/callback')).toBeUndefined()
  })
})

describe('with sign-in settings and no session', () => {
  it('is unauthenticated after the start; the callback and signed-out pages stay open', async () => {
    useConfig({})
    const auth = useAuth()
    await auth.initialize()
    expect(auth.status.value).toBe('unauthenticated')
    expect(auth.user.value).toBeNull()
    expect(await guard('/auth/callback')).toBeUndefined()
    expect(await guard('/auth/signed-out')).toBeUndefined()
  })

  it('has no token to give', async () => {
    useConfig({})
    const auth = useAuth()
    await auth.initialize()
    await expect(auth.getAccessToken()).rejects.toMatchObject({ name: 'AuthRequiredError' })
  })
})

describe('without sign-in settings (the server gave none)', () => {
  it('is in the error state, and the guard shows that instead of redirecting', async () => {
    useConfig({ oidc: { issuer: '', clientId: '', scope: '' } })
    const auth = useAuth()
    await auth.initialize()
    expect(auth.status.value).toBe('error')
    expect(auth.error.value).toMatch(/no sign-in provider/i)
    const result = await guard('/')
    expect(result).toBeInstanceOf(Error)
    expect(result).toMatchObject({ fatal: true, statusCode: 503 })
    // the pages of the login itself still open
    expect(await guard('/auth/callback')).toBeUndefined()
  })
})

// The real oidc-client-ts behind the client, with only the network replaced.
describe('the login with the real library', () => {
  const METADATA = {
    issuer: OIDC.issuer,
    authorization_endpoint: 'https://idm.example.org/ui/oauth2',
    token_endpoint: 'https://idm.example.org/oauth2/token',
    jwks_uri: `${OIDC.issuer}/public_key.jwk`,
    code_challenge_methods_supported: ['S256'],
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('redirects with PKCE (S256), a state and the scope; tokens never reach web storage', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${OIDC.issuer}/.well-known/openid-configuration`)
      return new Response(JSON.stringify(METADATA), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    useConfig({})
    const auth = useAuth()
    await auth.initialize()

    const redirect = auth.login('/calendar?view=week')
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce())
    const url = new URL(String(assign.mock.calls[0]![0]))
    expect(`${url.origin}${url.pathname}`).toBe(METADATA.authorization_endpoint)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'web-calendar',
      response_type: 'code',
      scope: 'openid profile',
      redirect_uri: `${window.location.origin}/auth/callback`,
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('state')).toBeTruthy()
    // the login state waits in the session storage (only this tab) ...
    expect(window.sessionStorage.length).toBe(1)
    expect(window.sessionStorage.key(0)).toContain(url.searchParams.get('state'))
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toContain(
      '"returnTo":"/calendar?view=week"',
    )
    // ... and nothing of the login is in the local storage (the color mode is Nuxt UI's)
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith('oidc.'))).toEqual([])

    window.dispatchEvent(new Event('pageshow'))
    await redirect
  })

  it('shows a provider that cannot be reached as a fatal error, not a blank page', async () => {
    // happy-dom has no window.stop(), which the library calls to clean up after a failed redirect
    Object.assign(window, { stop: () => undefined })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    useConfig({})
    const auth = useAuth()
    await auth.initialize()
    const result = await guard('/calendar')
    expect(result).toMatchObject({ fatal: true, statusCode: 503 })
    expect(auth.status.value).toBe('error')
    expect(auth.error.value).toMatch(/connection/i)
  })
})

describe('the pages of the login', () => {
  const inApp = (page: object) =>
    defineComponent({ render: () => h(UApp, null, { default: () => h(page) }) })

  it('the callback page tells a login that cannot be finished, accessibly', async () => {
    // no authorization response in the address: the library finds no state to finish
    useConfig({})
    await useAuth().initialize()
    const wrapper = await mountSuspended(inApp(CallbackPage))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true))
    const heading = wrapper.find('h1')
    expect(heading.text()).toBe('This sign-in has expired')
    expect(heading.attributes('tabindex')).toBe('-1')
    expect(wrapper.find('[role="alert"]').text()).toMatch(/Try again/)
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again')
    expect(retry).toBeDefined()
    wrapper.unmount()
  })

  it('the signed-out page offers to sign in again', async () => {
    useConfig({})
    await useAuth().initialize()
    const wrapper = await mountSuspended(inApp(SignedOutPage))
    expect(wrapper.find('h1').text()).toBe('You are signed out')
    expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['Sign in again'])
    wrapper.unmount()
  })
})

// $fetch with the auth fetch underneath: proves that ofetch really calls the replacement.
describe('useAuthFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('goes through authFetch: no session means no request, and the caller sees why', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    useConfig({})
    await useAuth().initialize()
    const api = useAuthFetch()
    const error = await api('/api/me', { retry: 0 }).catch((e: unknown) => e)
    expect(fetchMock).not.toHaveBeenCalled()
    // ofetch wraps what `fetch` throws; the reason is the cause
    expect(error).toMatchObject({ name: 'FetchError', cause: { name: 'AuthRequiredError' } })
  })

  it('sends the bearer token, parses JSON and renews on a 401', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return calls.length === 1
          ? new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
          : new Response('{"sub":"s1"}', { headers: { 'content-type': 'application/json' } })
      }),
    )
    // a session whose token the server refuses once
    const { createAuthController } = await import('~/utils/auth/controller')
    const tokens = ['t1', 't2']
    const controller = createAuthController({
      client: {
        user: null,
        init: async () => null,
        login: async () => undefined,
        completeLogin: async () => '/',
        getAccessToken: async (options) => (options?.rejectedToken ? tokens[1]! : tokens[0]!),
        logout: async () => undefined,
      },
      demo: false,
      setState: () => undefined,
      origin: window.location.origin,
    })
    const create = $fetch.create as unknown as (
      defaults: object,
      global: { fetch: typeof fetch },
    ) => typeof $fetch
    const result = await create({}, { fetch: controller.authFetch })('/api/me')
    expect(result).toEqual({ sub: 's1' })
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer t1', 'Bearer t2'])
  })
})
