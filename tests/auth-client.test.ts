// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  MIN_TOKEN_VALIDITY_SEC,
  buildOidcSettings,
  createAuthClient,
  type OidcManagerLike,
  type OidcSettings,
  type OidcUserLike,
} from '../app/utils/auth/client'
import { AuthRequiredError } from '../app/utils/auth/errors'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'
const ORIGIN = 'https://calendar.example.org'
const NOW_MS = Date.parse('2026-10-30T12:00:00Z')
const NOW_SEC = NOW_MS / 1000

function oidcUser(overrides: Partial<OidcUserLike> = {}): OidcUserLike {
  return {
    access_token: 'access-1',
    refresh_token: 'rt-1',
    expires_at: NOW_SEC + 900,
    profile: {
      sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
      name: 'Alice Example',
      email: 'alice@example.test',
      preferred_username: 'alice',
    },
    ...overrides,
  }
}

interface FakeOptions {
  user?: OidcUserLike | null
  endSession?: string | undefined | Error
  /** The revocation endpoint the provider advertises. */
  revocation?: string | undefined | Error
  /** Replaces what a revocation does; the default succeeds. May reject or never settle. */
  revoke?: (types: string[], current: OidcUserLike | null) => Promise<void>
  /** What the renewal produces; an Error rejects. */
  renewal?: (current: OidcUserLike | null) => OidcUserLike | Error | Promise<OidcUserLike | Error>
}

/** A stand-in for oidc-client-ts' UserManager that keeps its user like the real one's store does. */
function fakeManager(options: FakeOptions = {}) {
  let stored: OidcUserLike | null = options.user ?? null
  let lastRedirectState: unknown
  let settings: OidcSettings | undefined
  /** The token values the provider was asked to revoke. */
  const revoked: string[] = []
  const manager = {
    getUser: vi.fn(async () => stored),
    removeUser: vi.fn(async () => {
      stored = null
    }),
    signinRedirect: vi.fn(async (args?: { state?: unknown }) => {
      lastRedirectState = args?.state
    }),
    // Like the library: the state given to signinRedirect comes back with the user.
    signinRedirectCallback: vi.fn(async () => {
      stored = oidcUser({ state: lastRedirectState })
      return stored
    }),
    signinSilent: vi.fn(async () => {
      const result = await (options.renewal?.(stored) ??
        oidcUser({ access_token: 'access-renewed' }))
      if (result instanceof Error) throw result
      stored = result
      return result
    }),
    signoutRedirect: vi.fn(async () => {
      stored = null
    }),
    // Like the library: revokes, then stores the user without the revoked refresh token.
    revokeTokens: vi.fn(async (types: Array<'access_token' | 'refresh_token'>) => {
      const current = stored
      await options.revoke?.(types, current)
      for (const type of types) if (current?.[type]) revoked.push(current[type])
      if (current && types.includes('refresh_token'))
        stored = { ...current, refresh_token: undefined }
    }),
    metadataService: {
      getEndSessionEndpoint: vi.fn(async () => {
        if (options.endSession instanceof Error) throw options.endSession
        return options.endSession
      }),
      getRevocationEndpoint: vi.fn(async () => {
        if (options.revocation instanceof Error) throw options.revocation
        return options.revocation
      }),
    },
  } satisfies OidcManagerLike
  return {
    manager,
    revoked,
    stored: () => stored,
    settings: () => settings,
    setStored: (value: OidcUserLike | null) => {
      stored = value
    },
    factory: (given: OidcSettings): OidcManagerLike => {
      settings = given
      return manager
    },
  }
}

function setup(
  fake = fakeManager(),
  extra: { now?: () => number; providerTimeoutMs?: number } = {},
) {
  const navigate = vi.fn()
  const client = createAuthClient({
    issuer: ISSUER,
    clientId: 'web-calendar',
    scope: 'openid profile email groups_name caldav',
    origin: ORIGIN,
    createUserManager: fake.factory,
    navigate,
    now: extra.now ?? (() => NOW_MS),
    providerTimeoutMs: extra.providerTimeoutMs ?? 50,
  })
  return { client, fake, navigate, manager: fake.manager }
}

describe('settings', () => {
  it('points the library at the issuer with the code flow and no timers', () => {
    const { fake } = setup()
    expect(fake.settings()).toEqual({
      authority: ISSUER,
      client_id: 'web-calendar',
      redirect_uri: `${ORIGIN}/auth/callback`,
      post_logout_redirect_uri: `${ORIGIN}/`,
      response_type: 'code',
      scope: 'openid profile email groups_name caldav',
      automaticSilentRenew: false,
      loadUserInfo: false,
      revokeTokenAdditionalContentTypes: ['text/plain'],
    })
  })

  it('does not double a slash at the end of the origin', () => {
    expect(
      buildOidcSettings({ issuer: ISSUER, clientId: 'c', scope: 's', origin: `${ORIGIN}/` })
        .redirect_uri,
    ).toBe(`${ORIGIN}/auth/callback`)
  })
})

describe('init and the user', () => {
  it('is signed out without a stored user', async () => {
    const { client } = setup()
    expect(client.user).toBeNull()
    expect(await client.init()).toBeNull()
    expect(client.user).toBeNull()
  })

  it('reads the user from the ID token claims', async () => {
    const { client } = setup(fakeManager({ user: oidcUser() }))
    expect(await client.init()).toEqual({
      sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
      name: 'Alice Example',
      email: 'alice@example.test',
      username: 'alice',
    })
    expect(client.user?.username).toBe('alice')
  })

  it.each([
    [{ sub: 's1', preferred_username: 'bob', email: 'b@x.test' }, 'bob'],
    [{ sub: 's1', email: 'b@x.test' }, 'b@x.test'],
    [{ sub: 's1' }, 's1'],
    [{ sub: 's1', name: '', preferred_username: 'bob' }, 'bob'],
  ])('names the user when the claims are incomplete: %j -> %s', async (profile, name) => {
    const { client } = setup(fakeManager({ user: oidcUser({ profile }) }))
    const user = await client.init()
    expect(user?.name).toBe(name)
    expect(user?.sub).toBe('s1')
  })

  it('uses null for claims that are not there', async () => {
    const { client } = setup(fakeManager({ user: oidcUser({ profile: { sub: 's1' } }) }))
    expect(await client.init()).toMatchObject({ email: null, username: null })
  })
})

describe('login', () => {
  it('redirects with the place to come back to as state', async () => {
    const { client, manager } = setup()
    await client.login('/calendar?view=week#now')
    expect(manager.signinRedirect).toHaveBeenCalledOnce()
    expect(manager.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: '/calendar?view=week#now' },
    })
  })

  it('comes back to / by default', async () => {
    const { client, manager } = setup()
    await client.login()
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/' } })
  })

  it.each([
    ['https://evil.com'],
    ['//evil.com'],
    ['javascript:alert(1)'],
    ['/\\evil.com'],
    ['\\\\evil.com'],
    ['/\t/evil.com'],
    ['/auth/callback?code=1'],
  ])('does not store %j as the place to come back to', async (returnTo) => {
    const { client, manager } = setup()
    await client.login(returnTo)
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/' } })
  })

  it('starts one redirect for simultaneous calls', async () => {
    const { client, manager } = setup()
    await Promise.all([client.login('/a'), client.login('/b'), client.login('/c')])
    expect(manager.signinRedirect).toHaveBeenCalledOnce()
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/a' } })
  })

  it('can be tried again after a failure', async () => {
    const { client, manager } = setup()
    manager.signinRedirect.mockRejectedValueOnce(new Error('Network Error'))
    await expect(client.login('/a')).rejects.toThrow('Network Error')
    await client.login('/a')
    expect(manager.signinRedirect).toHaveBeenCalledTimes(2)
  })
})

describe('completeLogin', () => {
  it('returns where the login started and knows the user', async () => {
    const { client, manager } = setup()
    await client.login('/calendar?view=week')
    const returnTo = await client.completeLogin(`${ORIGIN}/auth/callback?code=c&state=s`)
    expect(returnTo).toBe('/calendar?view=week')
    expect(manager.signinRedirectCallback).toHaveBeenCalledWith(
      `${ORIGIN}/auth/callback?code=c&state=s`,
    )
    expect(client.user?.username).toBe('alice')
  })

  it('goes to / when nothing was stored', async () => {
    const { client } = setup()
    expect(await client.completeLogin(`${ORIGIN}/auth/callback?code=c&state=s`)).toBe('/')
  })

  it.each([
    ['https://evil.com'],
    ['//evil.com'],
    ['javascript:alert(1)'],
    ['/\\evil.com'],
    [42],
    [null],
    [{ nested: '/ok' }],
  ])('checks the stored place again: %j -> /', async (returnTo) => {
    const fake = fakeManager()
    const { client, manager } = setup(fake)
    // Something else wrote to the session storage between the redirect and the callback.
    manager.signinRedirectCallback.mockImplementationOnce(async () =>
      oidcUser({ state: { returnTo } }),
    )
    expect(await client.completeLogin(`${ORIGIN}/auth/callback?code=c&state=s`)).toBe('/')
  })

  it('runs once for the same URL (a remount or hot reload must not fail on the used state)', async () => {
    const { client, manager } = setup()
    await client.login('/a')
    const url = `${ORIGIN}/auth/callback?code=c&state=s`
    const [first, second] = await Promise.all([
      client.completeLogin(url),
      client.completeLogin(url),
    ])
    const third = await client.completeLogin(url)
    expect([first, second, third]).toEqual(['/a', '/a', '/a'])
    expect(manager.signinRedirectCallback).toHaveBeenCalledOnce()
  })

  it('passes the provider error on, without a user', async () => {
    const { client, manager } = setup()
    const denied = Object.assign(new Error('access_denied'), { name: 'ErrorResponse' })
    manager.signinRedirectCallback.mockRejectedValueOnce(denied)
    await expect(client.completeLogin(`${ORIGIN}/auth/callback?error=access_denied`)).rejects.toBe(
      denied,
    )
    expect(client.user).toBeNull()
  })
})

describe('getAccessToken', () => {
  it('is not signed in without a user', async () => {
    const { client, manager } = setup()
    const error = await client.getAccessToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthRequiredError)
    expect((error as AuthRequiredError).reason).toBe('signed-out')
    expect(manager.signinSilent).not.toHaveBeenCalled()
  })

  it('returns a token that stays valid long enough, without renewing', async () => {
    const { client, manager } = setup(fakeManager({ user: oidcUser() }))
    expect(await client.getAccessToken()).toBe('access-1')
    expect(manager.signinSilent).not.toHaveBeenCalled()
  })

  it.each([
    // seconds left, renewed?
    [900, false],
    [MIN_TOKEN_VALIDITY_SEC + 1, false],
    [MIN_TOKEN_VALIDITY_SEC, false],
    [MIN_TOKEN_VALIDITY_SEC - 1, true],
    [1, true],
    [0, true],
    [-30, true],
  ])('with %d s left: renewed=%s', async (left, renewed) => {
    const { client, manager } = setup(
      fakeManager({ user: oidcUser({ expires_at: NOW_SEC + left }) }),
    )
    const token = await client.getAccessToken()
    expect(manager.signinSilent).toHaveBeenCalledTimes(renewed ? 1 : 0)
    expect(token).toBe(renewed ? 'access-renewed' : 'access-1')
  })

  it('does not renew a token without an expiry (the server decides with a 401)', async () => {
    const { client, manager } = setup(fakeManager({ user: oidcUser({ expires_at: undefined }) }))
    expect(await client.getAccessToken()).toBe('access-1')
    expect(manager.signinSilent).not.toHaveBeenCalled()
  })

  it('uses the renewed token afterwards', async () => {
    const { client, manager } = setup(fakeManager({ user: oidcUser({ expires_at: NOW_SEC + 10 }) }))
    expect(await client.getAccessToken()).toBe('access-renewed')
    expect(await client.getAccessToken()).toBe('access-renewed')
    expect(manager.signinSilent).toHaveBeenCalledOnce()
  })

  it('renews ONCE for any number of simultaneous callers (the old refresh token is spent)', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakeManager({
      user: oidcUser({ expires_at: NOW_SEC + 5 }),
      renewal: async () => {
        await gate
        return oidcUser({ access_token: 'access-renewed' })
      },
    })
    const { client, manager } = setup(fake)
    const callers = Array.from({ length: 8 }, () => client.getAccessToken())
    // let every caller reach the shared renewal before it finishes
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    expect(await Promise.all(callers)).toEqual(Array(8).fill('access-renewed'))
    expect(manager.signinSilent).toHaveBeenCalledOnce()
  })

  it('renews again when the new token also runs out', async () => {
    let now = NOW_MS
    const fake = fakeManager({
      user: oidcUser({ expires_at: NOW_SEC + 5 }),
      renewal: () =>
        oidcUser({
          access_token: `at-${manager.signinSilent.mock.calls.length}`,
          expires_at: now / 1000 + 900,
        }),
    })
    const { client, manager } = setup(fake, { now: () => now })
    expect(await client.getAccessToken()).toBe('at-1')
    now += 850_000
    expect(await client.getAccessToken()).toBe('at-2')
    expect(manager.signinSilent).toHaveBeenCalledTimes(2)
  })

  describe('after a 401', () => {
    it('renews a token the server refused although it has not expired', async () => {
      const { client, manager } = setup(fakeManager({ user: oidcUser() }))
      expect(await client.getAccessToken({ rejectedToken: 'access-1' })).toBe('access-renewed')
      expect(manager.signinSilent).toHaveBeenCalledOnce()
    })

    it('does not renew again when another request already did', async () => {
      const { client, manager } = setup(
        fakeManager({ user: oidcUser({ access_token: 'access-2' }) }),
      )
      expect(await client.getAccessToken({ rejectedToken: 'access-1' })).toBe('access-2')
      expect(manager.signinSilent).not.toHaveBeenCalled()
    })

    it('still renews a different token that is about to expire', async () => {
      const { client, manager } = setup(
        fakeManager({ user: oidcUser({ access_token: 'access-2', expires_at: NOW_SEC + 5 }) }),
      )
      expect(await client.getAccessToken({ rejectedToken: 'access-1' })).toBe('access-renewed')
      expect(manager.signinSilent).toHaveBeenCalledOnce()
    })

    it('shares the renewal with callers that only noticed the expiry', async () => {
      const fake = fakeManager({
        user: oidcUser({ expires_at: NOW_SEC + 5 }),
        renewal: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return oidcUser({ access_token: 'access-renewed' })
        },
      })
      const { client, manager } = setup(fake)
      const tokens = await Promise.all([
        client.getAccessToken(),
        client.getAccessToken({ rejectedToken: 'access-1' }),
        client.getAccessToken({ rejectedToken: 'access-1' }),
      ])
      expect(tokens).toEqual(Array(3).fill('access-renewed'))
      expect(manager.signinSilent).toHaveBeenCalledOnce()
    })
  })

  describe('when the renewal fails', () => {
    const failing = () =>
      fakeManager({
        user: oidcUser({ expires_at: NOW_SEC + 5 }),
        renewal: () => new Error('invalid_grant'),
      })

    it('throws AuthRequiredError with the cause and clears the user', async () => {
      const { client, manager } = setup(failing())
      await client.init()
      expect(client.user).not.toBeNull()
      const error = await client.getAccessToken().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AuthRequiredError)
      expect((error as AuthRequiredError).reason).toBe('renewal-failed')
      expect(((error as AuthRequiredError).cause as Error).message).toBe('invalid_grant')
      expect(manager.removeUser).toHaveBeenCalledOnce()
      expect(client.user).toBeNull()
    })

    it('does not try the spent token again', async () => {
      const { client, manager } = setup(failing())
      await client.getAccessToken().catch(() => undefined)
      const second = await client.getAccessToken().catch((e: unknown) => e)
      expect((second as AuthRequiredError).reason).toBe('signed-out')
      expect(manager.signinSilent).toHaveBeenCalledOnce()
    })

    it('fails all simultaneous callers with one renewal', async () => {
      const { client, manager } = setup(failing())
      const results = await Promise.allSettled([
        client.getAccessToken(),
        client.getAccessToken(),
        client.getAccessToken({ rejectedToken: 'access-1' }),
      ])
      for (const result of results) {
        expect(result.status).toBe('rejected')
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(AuthRequiredError)
      }
      expect(manager.signinSilent).toHaveBeenCalledOnce()
    })

    it('treats a provider that returns no user as a failure', async () => {
      const fake = fakeManager({ user: oidcUser({ expires_at: NOW_SEC + 5 }) })
      fake.manager.signinSilent.mockResolvedValueOnce(null as never)
      const { client } = setup(fake)
      await expect(client.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('still fails with AuthRequiredError when clearing the user fails too', async () => {
      const fake = failing()
      fake.manager.removeUser.mockRejectedValueOnce(new Error('storage'))
      const { client } = setup(fake)
      await expect(client.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('can renew again after the user signed in anew', async () => {
      const fake = fakeManager({
        user: oidcUser({ expires_at: NOW_SEC + 5 }),
        renewal: (current) =>
          current?.access_token === 'access-1'
            ? new Error('x')
            : oidcUser({ access_token: 'access-renewed' }),
      })
      const { client, manager } = setup(fake)
      await client.getAccessToken().catch(() => undefined)
      fake.setStored(oidcUser({ access_token: 'access-9', expires_at: NOW_SEC + 5 }))
      expect(await client.getAccessToken()).toBe('access-renewed')
      expect(manager.signinSilent).toHaveBeenCalledTimes(2)
    })
  })
})

describe('logout', () => {
  it('leaves through the provider when it has an end-session endpoint', async () => {
    const fake = fakeManager({
      user: oidcUser(),
      endSession: 'https://idm.example.org/oauth2/openid/web-calendar/logout',
    })
    const { client, manager, navigate } = setup(fake)
    await client.init()
    await client.logout()
    expect(manager.signoutRedirect).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    expect(client.user).toBeNull()
    expect(await manager.getUser()).toBeNull()
  })

  it('clears the local state and goes to the signed-out page without an end-session endpoint', async () => {
    const { client, manager, navigate } = setup(
      fakeManager({ user: oidcUser(), endSession: undefined }),
    )
    await client.init()
    await client.logout()
    expect(manager.signoutRedirect).not.toHaveBeenCalled()
    expect(manager.removeUser).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/auth/signed-out')
    expect(client.user).toBeNull()
    expect(await manager.getUser()).toBeNull()
  })

  it('signs out here when the provider metadata cannot be fetched', async () => {
    const { client, manager, navigate } = setup(
      fakeManager({ user: oidcUser(), endSession: new Error('Network Error') }),
    )
    await client.logout()
    expect(manager.signoutRedirect).not.toHaveBeenCalled()
    expect(manager.removeUser).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
  })

  it('signs out here when the provider redirect fails', async () => {
    const fake = fakeManager({ user: oidcUser(), endSession: 'https://idm.example.org/logout' })
    fake.manager.signoutRedirect.mockRejectedValueOnce(new Error('boom'))
    const { client, manager, navigate } = setup(fake)
    await client.logout()
    expect(manager.removeUser).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
    expect(await manager.getUser()).toBeNull()
  })

  it('does not hand out a token afterwards', async () => {
    const { client } = setup(fakeManager({ user: oidcUser() }))
    await client.logout()
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
  })
})

describe('logout: revoking the tokens at the provider', () => {
  const REVOKE_URL = 'https://idm.example.org/oauth2/token/revoke'
  const advertised = (extra: Partial<FakeOptions> = {}) =>
    fakeManager({ user: oidcUser(), revocation: REVOKE_URL, ...extra })

  it('revokes the refresh token before the local user is dropped', async () => {
    const fake = advertised()
    const { client, manager, navigate } = setup(fake)
    await client.init()
    await client.logout()
    expect(manager.revokeTokens).toHaveBeenCalledExactlyOnceWith(['refresh_token'])
    expect(fake.revoked).toEqual(['rt-1'])
    // order: revoke, then remove the user, then leave
    const revokeOrder = manager.revokeTokens.mock.invocationCallOrder[0]!
    expect(revokeOrder).toBeLessThan(manager.removeUser.mock.invocationCallOrder[0]!)
    expect(manager.removeUser.mock.invocationCallOrder[0]!).toBeLessThan(
      navigate.mock.invocationCallOrder[0]!,
    )
    expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
    expect(client.user).toBeNull()
    expect(fake.stored()).toBeNull()
  })

  it('revokes the access token when there is no refresh token', async () => {
    const fake = advertised({ user: oidcUser({ refresh_token: undefined }) })
    const { client, manager } = setup(fake)
    await client.logout()
    expect(manager.revokeTokens).toHaveBeenCalledExactlyOnceWith(['access_token'])
    expect(fake.revoked).toEqual(['access-1'])
  })

  it('does not ask the provider when it advertises no revocation endpoint', async () => {
    const { client, manager, navigate } = setup(fakeManager({ user: oidcUser() }))
    await client.logout()
    expect(manager.revokeTokens).not.toHaveBeenCalled()
    expect(manager.removeUser).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
  })

  it('does not ask the provider when there is no user', async () => {
    const { client, manager, navigate } = setup(fakeManager({ revocation: REVOKE_URL }))
    await client.logout()
    expect(manager.revokeTokens).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
  })

  it('revokes before leaving through an end-session endpoint', async () => {
    const fake = advertised({ endSession: 'https://idm.example.org/logout' })
    const { client, manager, navigate } = setup(fake)
    await client.logout()
    expect(manager.revokeTokens).toHaveBeenCalledOnce()
    expect(manager.signoutRedirect).toHaveBeenCalledOnce()
    expect(manager.revokeTokens.mock.invocationCallOrder[0]!).toBeLessThan(
      manager.signoutRedirect.mock.invocationCallOrder[0]!,
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  describe('never blocks the sign-out', () => {
    const REVOKING_FAILS: Array<[string, Partial<FakeOptions>]> = [
      ['the revocation is refused', { revoke: () => Promise.reject(new Error('invalid_client')) }],
      ['the network is down', { revoke: () => Promise.reject(new TypeError('Failed to fetch')) }],
      ['the revocation endpoint cannot be looked up', { revocation: new Error('Network Error') }],
    ]

    it.each(REVOKING_FAILS)('when %s', async (_label, extra) => {
      const { client, manager, navigate } = setup(advertised(extra))
      await expect(client.logout()).resolves.toBeUndefined()
      expect(manager.removeUser).toHaveBeenCalled()
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/auth/signed-out')
      expect(client.user).toBeNull()
    })

    it('when the provider does not answer within the cap', async () => {
      // never settles; the cap is 50 ms in these tests (3 s by default)
      const fake = advertised({ revoke: () => new Promise<void>(() => undefined) })
      const { client, manager, navigate } = setup(fake)
      const started = Date.now()
      await client.logout()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(manager.removeUser).toHaveBeenCalled()
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/auth/signed-out')
      expect(fake.stored()).toBeNull()
    })

    it('and removes the user again if the library stores it after the cap', async () => {
      let finish: () => void = () => undefined
      const fake = advertised({
        revoke: () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      })
      const { client, navigate } = setup(fake)
      await client.logout()
      expect(navigate).toHaveBeenCalledOnce()
      // the late revocation ends and, like the library, stores the user again
      finish()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.stored()).toBeNull()
      expect(client.user).toBeNull()
      await expect(client.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('when the signoutRedirect of the provider fails too', async () => {
      const fake = advertised({ endSession: 'https://idm.example.org/logout' })
      fake.manager.signoutRedirect.mockRejectedValueOnce(new Error('boom'))
      const { client, navigate } = setup(fake)
      await client.logout()
      expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
      expect(fake.stored()).toBeNull()
    })
  })

  describe('no token reaches the logs or the errors', () => {
    it('stays silent even when the revocation fails with the token in the error', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      )
      try {
        // the library's errors carry the request body, which holds the token
        const leaky = Object.assign(new Error('invalid_request: token=rt-1'), {
          form: new URLSearchParams({ token: 'rt-1' }),
        })
        const { client } = setup(advertised({ revoke: () => Promise.reject(leaky) }))
        await expect(client.logout()).resolves.toBeUndefined()
        const output = spies.flatMap((spy) => spy.mock.calls).map((args) => JSON.stringify(args))
        expect(output.filter((line) => line.includes('rt-1') || line.includes('access-1'))).toEqual(
          [],
        )
        expect(output).toEqual([])
      } finally {
        spies.forEach((spy) => spy.mockRestore())
      }
    })
  })

  describe('a renewal that is under way', () => {
    function renewingWorld(options: Partial<FakeOptions> = {}) {
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const fake = advertised({
        user: oidcUser({ expires_at: NOW_SEC + 5 }),
        renewal: async () => {
          await gate
          return oidcUser({ access_token: 'access-renewed', refresh_token: 'rt-renewed' })
        },
        ...options,
      })
      return { ...setup(fake), fake, release }
    }

    it('cannot bring the session back: its result is ignored', async () => {
      const { client, fake, release, navigate } = renewingWorld()
      await client.init()
      const pending = client.getAccessToken().catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const leaving = client.logout()
      // the provider takes a moment; logout has to be waiting for the renewal by now
      await new Promise((resolve) => setTimeout(resolve, 5))
      release()
      await leaving
      const outcome = await pending
      expect(outcome).toBeInstanceOf(AuthRequiredError)
      expect((outcome as AuthRequiredError).reason).toBe('signed-out')
      expect(client.user).toBeNull()
      expect(fake.stored()).toBeNull()
      expect(navigate).toHaveBeenCalledWith('/auth/signed-out')
    })

    it('has its NEW refresh token revoked, not the spent one', async () => {
      const { client, fake, release } = renewingWorld()
      await client.init()
      const pending = client.getAccessToken().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const leaving = client.logout()
      // the provider takes a moment; logout has to be waiting for the renewal by now
      await new Promise((resolve) => setTimeout(resolve, 5))
      release()
      await Promise.all([leaving, pending])
      expect(fake.revoked).toEqual(['rt-renewed'])
    })

    it('that outlasts the cap is still revoked and removed when it ends', async () => {
      const { client, fake, release, navigate } = renewingWorld()
      await client.init()
      const pending = client.getAccessToken().catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await client.logout() // returns after the cap, the renewal is still running
      expect(navigate).toHaveBeenCalledOnce()
      release()
      expect(await pending).toBeInstanceOf(AuthRequiredError)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake.revoked).toEqual(['rt-renewed'])
      expect(fake.stored()).toBeNull()
      expect(client.user).toBeNull()
    })

    it('that fails is no problem either', async () => {
      const { client, navigate } = renewingWorld({
        renewal: () => new Error('invalid_grant'),
      })
      await client.init()
      const pending = client.getAccessToken().catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await client.logout()
      expect(await pending).toBeInstanceOf(AuthRequiredError)
      expect(navigate).toHaveBeenCalledOnce()
    })
  })

  describe('after logout', () => {
    it('hands out no token, even if a user is still stored', async () => {
      const fake = advertised()
      const { client } = setup(fake)
      await client.logout()
      fake.setStored(oidcUser())
      const error = await client.getAccessToken().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AuthRequiredError)
      expect((error as AuthRequiredError).reason).toBe('signed-out')
    })

    it('does not renew', async () => {
      const fake = advertised({ user: oidcUser({ expires_at: NOW_SEC + 5 }) })
      const { client, manager } = setup(fake)
      await client.logout()
      fake.setStored(oidcUser({ expires_at: NOW_SEC + 5 }))
      await client.getAccessToken({ rejectedToken: 'access-1' }).catch(() => undefined)
      expect(manager.signinSilent).not.toHaveBeenCalled()
    })

    it('works again after the next login', async () => {
      const { client } = setup(advertised())
      await client.logout()
      await client.login('/a')
      await client.completeLogin(`${ORIGIN}/auth/callback?code=c&state=s`)
      expect(await client.getAccessToken()).toBe('access-1')
    })

    it('signs out twice without revoking twice', async () => {
      const fake = advertised()
      const { client, manager } = setup(fake)
      await client.logout()
      await client.logout()
      expect(manager.revokeTokens).toHaveBeenCalledOnce()
      expect(fake.revoked).toEqual(['rt-1'])
    })
  })
})
