// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AuthConfigError, AuthRequiredError } from '../app/utils/auth/errors'
import {
  createAuthController,
  type AuthControllerOptions,
  type AuthStatePatch,
} from '../app/utils/auth/controller'
import { DEMO_USER } from '../app/utils/auth/state'
import type { AuthClient, AuthStatus, AuthUserInfo } from '../app/utils/auth/types'

const ORIGIN = 'https://calendar.example.org'
const ALICE: AuthUserInfo = {
  sub: 's1',
  name: 'Alice Example',
  email: 'a@x.test',
  username: 'alice',
}

/** The state the composable keeps, as plain values. */
function stateStore() {
  const state: { status: AuthStatus; user: AuthUserInfo | null; error: string | null } = {
    status: 'loading',
    user: null,
    error: null,
  }
  const patches: AuthStatePatch[] = []
  return {
    state,
    patches,
    setState(patch: AuthStatePatch) {
      patches.push(patch)
      Object.assign(state, patch)
    },
  }
}

function fakeClient(overrides: Partial<AuthClient> = {}) {
  let user: AuthUserInfo | null = null
  const client = {
    get user() {
      return user
    },
    init: vi.fn(async () => user),
    login: vi.fn(async () => undefined),
    completeLogin: vi.fn(async () => {
      user = ALICE
      return '/calendar'
    }),
    getAccessToken: vi.fn(async () => 'token-1'),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } satisfies AuthClient
  return Object.assign(client, {
    signIn: () => {
      user = ALICE
    },
  })
}

function setup(options: Partial<AuthControllerOptions> = {}) {
  const store = stateStore()
  const baseFetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>
  const onExpired = vi.fn()
  const controller = createAuthController({
    client: null,
    demo: false,
    setState: store.setState,
    getStatus: () => store.state.status,
    onExpired,
    baseFetch,
    origin: ORIGIN,
    ...options,
  })
  return { controller, store, baseFetch, onExpired }
}

describe('demo mode', () => {
  function demo() {
    const client = fakeClient()
    // Even with a client at hand, nothing may touch it.
    return { ...setup({ demo: true, client }), client }
  }

  it('is signed in as the mock user at once', async () => {
    const { controller, store } = demo()
    await controller.initialize()
    expect(store.state).toEqual({ status: 'authenticated', user: DEMO_USER, error: null })
    expect(store.state.user?.name).toBe('Alex Doe')
  })

  it('works without any sign-in settings', async () => {
    const { controller, store } = setup({ demo: true, client: null })
    await controller.initialize()
    expect(store.state.status).toBe('authenticated')
    await expect(controller.login('/x')).resolves.toBeUndefined()
    await expect(controller.getAccessToken()).resolves.toBe('')
  })

  it('does not redirect, renew or sign out', async () => {
    const { controller, client, store } = demo()
    await controller.initialize()
    await controller.login('/calendar')
    await controller.logout()
    expect(await controller.completeLogin('https://x/auth/callback?code=1')).toBe('/')
    expect(client.init).not.toHaveBeenCalled()
    expect(client.login).not.toHaveBeenCalled()
    expect(client.logout).not.toHaveBeenCalled()
    expect(client.completeLogin).not.toHaveBeenCalled()
    expect(store.state.status).toBe('authenticated')
    expect(store.state.user).toEqual(DEMO_USER)
  })

  it('has no token, so the request goes out as it is', async () => {
    const { controller, client, baseFetch } = demo()
    expect(await controller.getAccessToken()).toBe('')
    expect(client.getAccessToken).not.toHaveBeenCalled()
    await controller.authFetch('/api/me', { headers: { 'X-A': '1' } })
    expect(baseFetch).toHaveBeenCalledExactlyOnceWith('/api/me', { headers: { 'X-A': '1' } })
  })
})

describe('without sign-in settings', () => {
  it('is in the error state and never redirects', async () => {
    const { controller, store } = setup({ client: null })
    await controller.initialize()
    expect(store.state.status).toBe('error')
    expect(store.state.error).toMatch(/no sign-in provider/i)
    expect(store.state.user).toBeNull()
  })

  it('fails login, completeLogin and token requests with a config error', async () => {
    const { controller, store } = setup({ client: null })
    await expect(controller.login('/x')).rejects.toBeInstanceOf(AuthConfigError)
    expect(store.state.status).toBe('error')
    await expect(controller.completeLogin('https://x/auth/callback?code=1')).rejects.toBeInstanceOf(
      AuthConfigError,
    )
    await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthConfigError)
    await expect(controller.logout()).rejects.toBeInstanceOf(AuthConfigError)
  })
})

describe('initialize', () => {
  it('is authenticated when the client has a user', async () => {
    const client = fakeClient()
    client.signIn()
    const { controller, store } = setup({ client })
    await controller.initialize()
    expect(store.state).toEqual({ status: 'authenticated', user: ALICE, error: null })
  })

  it('is unauthenticated without one (after a reload: tokens are only in memory)', async () => {
    const { controller, store } = setup({ client: fakeClient() })
    await controller.initialize()
    expect(store.state).toEqual({ status: 'unauthenticated', user: null, error: null })
  })

  it('does not throw when the client fails', async () => {
    const client = fakeClient({
      init: vi.fn(async () => Promise.reject(new Error('storage blocked'))),
    })
    const { controller, store } = setup({ client })
    await expect(controller.initialize()).resolves.toBeUndefined()
    expect(store.state.status).toBe('error')
    expect(store.state.error).not.toBeNull()
  })

  it('does not redirect', async () => {
    const client = fakeClient()
    const { controller } = setup({ client })
    await controller.initialize()
    expect(client.login).not.toHaveBeenCalled()
  })
})

describe('login', () => {
  it('hands the place to come back to to the client', async () => {
    const client = fakeClient()
    const { controller } = setup({ client })
    await controller.login('/calendar?x=1')
    expect(client.login).toHaveBeenCalledExactlyOnceWith('/calendar?x=1')
  })

  it('reports a failure in the state and passes it on', async () => {
    const client = fakeClient({
      login: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    })
    const { controller, store } = setup({ client })
    await expect(controller.login('/')).rejects.toThrow('Failed to fetch')
    expect(store.state.status).toBe('error')
    expect(store.state.error).toMatch(/connection/i)
  })

  it('keeps the app on screen when signing in again from an expired sign-in fails', async () => {
    const client = fakeClient({
      login: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    })
    const { controller, store } = setup({ client })
    store.setState({ status: 'expired', user: ALICE })
    await expect(controller.login('/calendar')).rejects.toThrow('Failed to fetch')
    expect(store.state.status).toBe('expired')
    expect(store.state.user).toEqual(ALICE)
    expect(store.state.error).toMatch(/connection/i)
  })
})

describe('completeLogin', () => {
  it('sets the state BEFORE the caller can navigate (the route guard of the next page reads it)', async () => {
    const client = fakeClient()
    const { controller, store } = setup({ client })
    const returnTo = await controller.completeLogin('https://x/auth/callback?code=1&state=2')
    expect(returnTo).toBe('/calendar')
    // already true when the promise resolves
    expect(store.state).toEqual({ status: 'authenticated', user: ALICE, error: null })
  })

  it('goes to the error state when the exchange fails, and passes the error on', async () => {
    const failure = new Error('No matching state found in storage')
    const client = fakeClient({ completeLogin: vi.fn(async () => Promise.reject(failure)) })
    const { controller, store } = setup({ client })
    await expect(controller.completeLogin('https://x/auth/callback?code=1')).rejects.toBe(failure)
    expect(store.state.status).toBe('error')
    expect(store.state.user).toBeNull()
    expect(store.state.error).toMatch(/tab|expired|reloaded/i)
  })
})

describe('getAccessToken', () => {
  it('passes the options (the refused token) on', async () => {
    const client = fakeClient()
    const { controller } = setup({ client })
    expect(await controller.getAccessToken({ rejectedToken: 'old' })).toBe('token-1')
    expect(client.getAccessToken).toHaveBeenCalledWith({ rejectedToken: 'old' })
  })

  it('marks the session as expired and fails the caller, without redirecting by itself', async () => {
    const client = fakeClient({
      getAccessToken: vi.fn(async () => Promise.reject(new AuthRequiredError('renewal-failed'))),
    })
    const { controller, store, onExpired } = setup({ client })
    store.setState({ status: 'authenticated', user: ALICE })
    await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    // the app stays on screen, still showing who it was for, and the UI asks
    expect(store.state.status).toBe('expired')
    expect(store.state.user).toEqual(ALICE)
    expect(onExpired).toHaveBeenCalledOnce()
    // the UI or the route guard at the next navigation does that
    expect(client.login).not.toHaveBeenCalled()
  })

  it('tells the UI again at each later request, so it can ask again', async () => {
    const client = fakeClient({
      getAccessToken: vi.fn(async () => Promise.reject(new AuthRequiredError('signed-out'))),
    })
    const { controller, store, onExpired } = setup({ client })
    store.setState({ status: 'expired', user: ALICE })
    await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(store.state.status).toBe('expired')
    expect(onExpired).toHaveBeenCalledTimes(2)
  })

  it.each(['unauthenticated', 'loading', 'error'] as const)(
    'stays without an app on screen when the status was %s (a sign-out, the start)',
    async (status) => {
      const client = fakeClient({
        getAccessToken: vi.fn(async () => Promise.reject(new AuthRequiredError('signed-out'))),
      })
      const { controller, store, onExpired } = setup({ client })
      store.setState({ status, user: null })
      await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
      expect(store.state.status).toBe('unauthenticated')
      expect(store.state.user).toBeNull()
      expect(onExpired).not.toHaveBeenCalled()
    },
  )

  it('keeps the signed-out state when a request fails during the sign-out', async () => {
    let finishLogout: () => void = () => undefined
    const client = fakeClient({
      getAccessToken: vi.fn(async () => Promise.reject(new AuthRequiredError('signed-out'))),
      logout: vi.fn(() => new Promise<void>((resolve) => (finishLogout = resolve))),
    })
    const { controller, store, onExpired } = setup({ client })
    store.setState({ status: 'authenticated', user: ALICE })
    const leaving = controller.logout()
    await expect(controller.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(store.state.status).toBe('unauthenticated')
    expect(onExpired).not.toHaveBeenCalled()
    finishLogout()
    await leaving
  })

  it('does not treat other errors as a lost session', async () => {
    const client = fakeClient({
      getAccessToken: vi.fn(async () => Promise.reject(new Error('boom'))),
    })
    const { controller, store } = setup({ client })
    store.setState({ status: 'authenticated', user: ALICE })
    await expect(controller.getAccessToken()).rejects.toThrow('boom')
    expect(store.state.status).toBe('authenticated')
    expect(client.login).not.toHaveBeenCalled()
  })
})

describe('authFetch', () => {
  it('adds the token of the client to calls to the app', async () => {
    const client = fakeClient()
    const { controller, baseFetch } = setup({ client })
    await controller.authFetch('/api/me')
    const [, init] = baseFetch.mock.calls[0] as [unknown, RequestInit]
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-1')
  })

  it('renews and retries on a 401', async () => {
    const client = fakeClient({
      getAccessToken: vi.fn(async (options?: { rejectedToken?: string }) =>
        options?.rejectedToken ? 'token-2' : 'token-1',
      ),
    })
    const { controller, baseFetch } = setup({ client })
    baseFetch.mockImplementationOnce(async () => new Response('no', { status: 401 }))
    const response = await controller.authFetch('/api/me')
    expect(response.status).toBe(200)
    const sent = baseFetch.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get('authorization'),
    )
    expect(sent).toEqual(['Bearer token-1', 'Bearer token-2'])
  })
})

describe('logout', () => {
  it('shows the signed-out state first, then lets the client leave', async () => {
    let stateWhenLeaving: AuthStatus | null = null
    const logout = vi.fn(async () => {
      stateWhenLeaving = store.state.status
    })
    const client = fakeClient({ logout })
    client.signIn()
    const { controller, store } = setup({ client })
    store.setState({ status: 'authenticated', user: ALICE })
    await controller.logout()
    expect(stateWhenLeaving).toBe('unauthenticated')
    expect(store.state.user).toBeNull()
    expect(logout).toHaveBeenCalledOnce()
  })
})
