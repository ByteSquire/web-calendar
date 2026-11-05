// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { authenticateRequest, type AuthDeps } from '../../server/utils/auth/authenticate'
import { AuthError } from '../../server/utils/auth/errors'
import { createBasicThrottle } from '../../server/utils/auth/throttle'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
/** What a bearer identity carries when the token has no groups claim. */
const NO_GROUPS = { entries: undefined, overage: false }

function setup(overrides: Partial<AuthDeps> = {}) {
  const verify = vi.fn(async (token: string) => {
    if (token !== 'good.jwt.token') throw new AuthError('expired')
    return {
      sub: SUB,
      clientId: 'web-calendar',
      scopes: ['caldav'],
      exp: 1,
      groups: undefined,
      groupsOverage: false,
    }
  })
  const verifyAppToken = vi.fn((username: string, token: string) =>
    username === 'alice' && token === 'wcal_secret:with:colons' ? { sub: SUB } : null,
  )
  const deps: AuthDeps = { verifier: { verify }, verifyAppToken, ...overrides }
  const call = (authorization?: string) =>
    authenticateRequest(new Headers(authorization === undefined ? {} : { authorization }), deps)
  return { call, verify, verifyAppToken }
}

const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AuthError)
  return error as AuthError
}

/** A caller whose bearer token and app token both belong to `sub`. */
function asSub(sub: string, overrides: Partial<AuthDeps> = {}) {
  return setup({
    verifier: {
      verify: async () => ({
        sub,
        clientId: 'c',
        scopes: [],
        exp: 1,
        groups: undefined,
        groupsOverage: false,
      }),
    },
    verifyAppToken: () => ({ sub }),
    ...overrides,
  })
}

describe('authenticateRequest', () => {
  it('sends a bearer token to the verifier', async () => {
    const { call, verify, verifyAppToken } = setup()
    await expect(call('Bearer good.jwt.token')).resolves.toEqual({
      sub: SUB,
      via: 'bearer',
      tokenGroups: NO_GROUPS,
    })
    expect(verify).toHaveBeenCalledWith('good.jwt.token')
    expect(verifyAppToken).not.toHaveBeenCalled()
  })

  it('carries the groups claim of the verified token on a bearer identity, and none on an app token', async () => {
    const withGroups = asSub(SUB, {
      verifier: {
        verify: async () => ({
          sub: SUB,
          clientId: 'c',
          scopes: [],
          exp: 1,
          groups: ['staff', '/team/ops'],
          groupsOverage: false,
        }),
      },
    })
    await expect(withGroups.call('Bearer a.b.c')).resolves.toEqual({
      sub: SUB,
      via: 'bearer',
      tokenGroups: { entries: ['staff', '/team/ops'], overage: false },
    })
    // An app token has no claims: its identity carries no groups.
    const identity = await withGroups.call(basic('alice:x'))
    expect(identity).toEqual({ sub: SUB, via: 'app-token' })
  })

  it('sends Basic credentials to the app token check, splitting at the first colon', async () => {
    const { call, verify, verifyAppToken } = setup()
    await expect(call(basic('alice:wcal_secret:with:colons'))).resolves.toEqual({
      sub: SUB,
      via: 'app-token',
    })
    expect(verifyAppToken).toHaveBeenCalledWith('alice', 'wcal_secret:with:colons')
    expect(verify).not.toHaveBeenCalled()
  })

  it('reads the scheme case-insensitively', async () => {
    const { call } = setup()
    await expect(call('bearer good.jwt.token')).resolves.toMatchObject({ via: 'bearer' })
    await expect(
      call(basic('alice:wcal_secret:with:colons').replace('Basic', 'BASIC')),
    ).resolves.toMatchObject({ via: 'app-token' })
  })

  it('awaits an asynchronous app token check', async () => {
    const { call } = setup({ verifyAppToken: async () => ({ sub: SUB }) })
    await expect(call(basic('alice:x'))).resolves.toMatchObject({ via: 'app-token' })
  })

  describe('401 with both challenges', () => {
    const expectChallenges = (error: AuthError) => {
      expect(error.status).toBe(401)
      expect(error.challenges).toEqual([
        expect.stringMatching(/^Basic realm="Web Calendar"/),
        expect.stringMatching(/^Bearer realm="Web Calendar"/),
      ])
    }

    it('without credentials', async () => {
      const { call, verify, verifyAppToken } = setup()
      const error = await failure(call())
      expect(error.reason).toBe('no-credentials')
      expectChallenges(error)
      expect((await failure(call('   '))).reason).toBe('no-credentials')
      expect(verify).not.toHaveBeenCalled()
      expect(verifyAppToken).not.toHaveBeenCalled()
    })

    it.each(['Digest abc', 'Negotiate abc', 'Token good.jwt.token', 'good.jwt.token'])(
      'for the scheme in %j',
      async (header) => {
        const { call, verify, verifyAppToken } = setup()
        const error = await failure(call(header))
        expectChallenges(error)
        expect(['unsupported-scheme', 'malformed']).toContain(error.reason)
        expect(verify).not.toHaveBeenCalled()
        expect(verifyAppToken).not.toHaveBeenCalled()
      },
    )

    it('for a bearer token the verifier rejects, with the reason kept and invalid_token', async () => {
      const { call } = setup()
      const error = await failure(call('Bearer expired.jwt.token'))
      expect(error.reason).toBe('expired')
      expect(error.challenges[1]).toBe('Bearer realm="Web Calendar", error="invalid_token"')
      expect(error.challenges[0]).toMatch(/^Basic/)
    })

    it('for an unknown app token or user', async () => {
      const { call } = setup()
      expect((await failure(call(basic('alice:wrong')))).reason).toBe('invalid-app-token')
      expect((await failure(call(basic('mallory:wcal_secret:with:colons')))).reason).toBe(
        'invalid-app-token',
      )
      expectChallenges(await failure(call(basic('alice:wrong'))))
    })

    it.each([
      ['not base64', 'Basic %%%'],
      ['no colon', basic('alice')],
      ['empty user name', basic(':token')],
      ['empty token', basic('alice:')],
      ['invalid UTF-8', `Basic ${Buffer.from([0x61, 0x3a, 0xff, 0xfe]).toString('base64')}`],
      ['no credentials after the scheme', 'Basic'],
    ])('for malformed Basic credentials (%s)', async (_name, header) => {
      const { call, verifyAppToken } = setup()
      const error = await failure(call(header))
      expectChallenges(error)
      expect(verifyAppToken).not.toHaveBeenCalled()
    })

    it('for an oversized header', async () => {
      const { call, verify } = setup()
      expect((await failure(call(`Bearer ${'a'.repeat(9000)}`))).reason).toBe('malformed')
      expect(verify).not.toHaveBeenCalled()
    })
  })

  it('offers only Bearer where app tokens are not accepted', async () => {
    const { call, verifyAppToken } = setup({ verifyAppToken: undefined })
    const error = await failure(call(basic('alice:wcal_secret:with:colons')))
    expect(error.reason).toBe('unsupported-scheme')
    expect(error.challenges).toEqual(['Bearer realm="Web Calendar"'])
    expect((await failure(call())).challenges).toEqual(['Bearer realm="Web Calendar"'])
    expect(verifyAppToken).not.toHaveBeenCalled()
    await expect(call('Bearer good.jwt.token')).resolves.toMatchObject({ via: 'bearer' })
  })

  it('passes a 503 (signing keys unavailable) on without a challenge', async () => {
    const { call } = setup({
      verifier: {
        verify: async () => {
          throw new AuthError('keys-unavailable')
        },
      },
    })
    const error = await failure(call('Bearer good.jwt.token'))
    expect(error.status).toBe(503)
    expect(error.challenges).toEqual([])
  })

  it('does not turn a failure of the verifier or the app token store into a 401', async () => {
    const boom = new Error('database is locked')
    const dbDown = setup({
      verifyAppToken: () => {
        throw boom
      },
    })
    await expect(dbDown.call(basic('alice:x'))).rejects.toBe(boom)
    const verifierBug = setup({
      verifier: {
        verify: async () => {
          throw boom
        },
      },
    })
    await expect(verifierBug.call('Bearer a.b.c')).rejects.toBe(boom)
  })

  it.each([
    'a/b',
    'a\\b',
    'line\nbreak',
    'two words',
    '',
    'ü',
    'x'.repeat(256),
    '.hidden',
    '..',
    'tilde~',
    'a:b',
    "a'b",
    'a"b',
    'a*b',
    'a?b',
    'a,b',
    'a@b@c',
    '@x',
    'x@',
  ])('refuses a user id that cannot be Radicale’s user name (%j)', async (sub) => {
    const caller = asSub(sub)
    expect((await failure(caller.call('Bearer a.b.c'))).reason).toBe('invalid-sub')
    expect((await failure(caller.call(basic('alice:x')))).reason).toBe('invalid-sub')
  })

  it.each([
    'ABC123',
    'abc123',
    'Alice@Example.ORG',
    'auth0|5f7c8ec7c33c6c004bbafe82',
    'a+b=c.d',
    'Zx9_-Zx9_-Zx9_-Zx9_-Zx9_-Zx9_-Zx9_-Zx9_-Zx9_-',
    '_Zx9',
    '-1',
    'x'.repeat(255),
  ])('takes the id the provider sends as it is, case and symbols kept (%j)', async (sub) => {
    const caller = asSub(sub)
    await expect(caller.call('Bearer a.b.c')).resolves.toEqual({
      sub,
      via: 'bearer',
      tokenGroups: NO_GROUPS,
    })
    await expect(caller.call(basic('alice:x'))).resolves.toEqual({ sub, via: 'app-token' })
  })

  it.each(['_resources', '_group-1', '_group-77', '_group-anything'])(
    'refuses an id that is one of the app’s own principals (%j)',
    async (sub) => {
      const caller = asSub(sub)
      expect((await failure(caller.call('Bearer a.b.c'))).reason).toBe('invalid-sub')
      expect((await failure(caller.call(basic('alice:x')))).reason).toBe('invalid-sub')
    },
  )

  it('refuses a configured shared owner, and only when it is configured', async () => {
    await expect(asSub('_team').call('Bearer a.b.c')).resolves.toMatchObject({ sub: '_team' })
    const guarded = asSub('_team', { sharedOwners: ['_team'] })
    expect((await failure(guarded.call('Bearer a.b.c'))).reason).toBe('invalid-sub')
    expect((await failure(guarded.call(basic('alice:x')))).reason).toBe('invalid-sub')
    // Another underscore id is a person's.
    await expect(
      asSub('_other', { sharedOwners: ['_team'] }).call('Bearer a.b.c'),
    ).resolves.toMatchObject({ sub: '_other' })
  })
})

describe('authenticateRequest: throttle of failed Basic logins', () => {
  const ADDRESS = '203.0.113.9'
  const NOW = 1_800_000_000_000

  function throttled(options: { address?: string | null } = {}) {
    const address = 'address' in options ? options.address : ADDRESS
    const clock = { ms: NOW }
    const basicThrottle = createBasicThrottle({ now: () => clock.ms })
    const base = setup({ basicThrottle, clientAddress: address })
    const as = (clientAddress: string | null) =>
      setup({ basicThrottle, clientAddress, verifyAppToken: base.verifyAppToken })
    let names = 0
    const wrong = (user = 'alice') => base.call(basic(`${user}:wrong`))
    const right = () => base.call(basic('alice:wcal_secret:with:colons'))
    /** A failed login of a user name nobody used before. */
    const sprayed = () => wrong(`sprayed-${names++}`)
    return { ...base, clock, basicThrottle, wrong, right, sprayed, as }
  }

  it('checks the credentials first, every time', async () => {
    const { wrong, verifyAppToken } = throttled()
    for (let i = 0; i < 8; i++) await failure(wrong())
    expect(verifyAppToken).toHaveBeenCalledTimes(8)
  })

  it('answers 401 for the first failures of a user name and 429 with Retry-After from the fifth', async () => {
    const { wrong } = throttled()
    for (let i = 0; i < 4; i++) {
      const error = await failure(wrong())
      expect([error.status, error.reason]).toEqual([401, 'invalid-app-token'])
    }
    for (let i = 0; i < 3; i++) {
      const error = await failure(wrong())
      expect(error.reason).toBe('throttled')
      expect(error.status).toBe(429)
      expect(error.retryAfterSec).toBe(600)
      // No challenge and no verdict: the client is asked to wait, not to log in again.
      expect(error.challenges).toEqual([])
      expect(error.message).not.toContain('wrong')
    }
  })

  it('counts down Retry-After for a client that keeps failing', async () => {
    const { wrong, clock } = throttled()
    for (let i = 0; i < 5; i++) await failure(wrong())
    clock.ms += 100_000
    expect((await failure(wrong())).retryAfterSec).toBe(500)
  })

  it('accepts a correct login while the (address, user name) key is blocked, and ends the block', async () => {
    const { wrong, right, verifyAppToken } = throttled()
    for (let i = 0; i < 6; i++) expect((await failure(wrong())).status).toBe(i < 4 ? 401 : 429)
    await expect(right()).resolves.toEqual({ sub: SUB, via: 'app-token' })
    expect(verifyAppToken).toHaveBeenCalledTimes(7)
    // The counter started over: four more failures are plain 401s again.
    for (let i = 0; i < 4; i++) expect((await failure(wrong())).status).toBe(401)
    expect((await failure(wrong())).status).toBe(429)
  })

  it('accepts a correct login while the address is rate limited', async () => {
    const { sprayed, right, basicThrottle } = throttled()
    for (let i = 0; i < 30; i++) expect((await failure(sprayed())).status).toBe(401)
    for (let i = 0; i < 20; i++) expect((await failure(sprayed())).status).toBe(429)
    await expect(right()).resolves.toEqual({ sub: SUB, via: 'app-token' })
    await expect(right()).resolves.toEqual({ sub: SUB, via: 'app-token' })
    expect(basicThrottle.size().addresses).toBe(1)
  })

  it('accepts a correct login while the address AND the user name are blocked', async () => {
    const { sprayed, wrong, right } = throttled()
    for (let i = 0; i < 40; i++) await failure(sprayed())
    for (let i = 0; i < 10; i++) await failure(wrong())
    expect((await failure(wrong())).status).toBe(429)
    await expect(right()).resolves.toMatchObject({ via: 'app-token' })
  })

  it('behind a proxy (every request from one address) 100 failed logins do not stop the correct ones', async () => {
    const { sprayed, wrong, right } = throttled({ address: '127.0.0.1' })
    for (let i = 0; i < 100; i++) {
      await failure(sprayed())
      if (i % 10 === 0) await expect(right()).resolves.toMatchObject({ via: 'app-token' })
    }
    // Including the failures that name the very user the stranger attacks.
    for (let i = 0; i < 100; i++) await failure(wrong())
    for (let i = 0; i < 3; i++) await expect(right()).resolves.toMatchObject({ via: 'app-token' })
  })

  it('rate limits the failures of one address and lets it recover with the clock', async () => {
    const { sprayed, clock } = throttled()
    for (let i = 0; i < 30; i++) expect((await failure(sprayed())).status).toBe(401)
    const slowed = await failure(sprayed())
    expect([slowed.status, slowed.retryAfterSec]).toEqual([429, 1])
    clock.ms += 100
    expect((await failure(sprayed())).status).toBe(401)
    expect((await failure(sprayed())).status).toBe(429)
    clock.ms += 3000
    for (let i = 0; i < 30; i++) expect((await failure(sprayed())).status).toBe(401)
  })

  it('does not count what is not a failed check of an app token', async () => {
    const { call, right, verifyAppToken, basicThrottle } = throttled()
    for (let i = 0; i < 50; i++) {
      expect((await failure(call())).reason).toBe('no-credentials')
      expect((await failure(call('Bearer expired.jwt.token'))).reason).toBe('expired')
      expect((await failure(call('Digest abc'))).reason).toBe('unsupported-scheme')
      expect((await failure(call('Basic %%%'))).reason).toBe('malformed')
      expect((await failure(call(basic('alice:')))).reason).toBe('malformed')
      expect((await failure(call(basic('no-colon')))).reason).toBe('malformed')
    }
    expect(verifyAppToken).not.toHaveBeenCalled()
    expect(basicThrottle.size()).toEqual({ users: 0, addresses: 0 })
    await expect(right()).resolves.toMatchObject({ via: 'app-token' })
  })

  it('does not count a check that broke (the database is down)', async () => {
    const boom = new Error('database is locked')
    const clock = { ms: NOW }
    const basicThrottle = createBasicThrottle({ now: () => clock.ms })
    const dbDown = setup({
      basicThrottle,
      clientAddress: ADDRESS,
      verifyAppToken: () => {
        throw boom
      },
    })
    for (let i = 0; i < 50; i++) await expect(dbDown.call(basic('alice:x'))).rejects.toBe(boom)
    expect(basicThrottle.size()).toEqual({ users: 0, addresses: 0 })
  })

  it('never touches bearer tokens, however the address is doing', async () => {
    const { call, sprayed, verify } = throttled()
    for (let i = 0; i < 50; i++) await failure(sprayed())
    await expect(call('Bearer good.jwt.token')).resolves.toEqual({
      sub: SUB,
      via: 'bearer',
      tokenGroups: NO_GROUPS,
    })
    // A bad bearer token is a 401 like before, not a 429.
    expect((await failure(call('Bearer expired.jwt.token'))).status).toBe(401)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('keeps clients apart: another address, and another user name, are counted on their own', async () => {
    const { wrong, as } = throttled()
    for (let i = 0; i < 5; i++) await failure(wrong())
    expect((await failure(wrong())).status).toBe(429)
    expect((await failure(wrong('bob'))).status).toBe(401)
    const other = as('198.51.100.7')
    expect((await failure(other.call(basic('alice:wrong')))).status).toBe(401)
  })

  it.each([null, undefined])(
    'counts clients with an unknown address (%s) together',
    async (address) => {
      const { sprayed } = throttled({ address })
      for (let i = 0; i < 30; i++) expect((await failure(sprayed())).status).toBe(401)
      expect((await failure(sprayed())).status).toBe(429)
    },
  )

  it('answers the same way for a user name that exists and one that does not', async () => {
    const { wrong } = throttled()
    for (let i = 0; i < 5; i++) await failure(wrong('alice'))
    for (let i = 0; i < 5; i++) await failure(wrong('no-such-user'))
    const real = await failure(wrong('alice'))
    const absent = await failure(wrong('no-such-user'))
    expect([real.status, real.retryAfterSec]).toEqual([absent.status, absent.retryAfterSec])
  })

  it('leaves the 401 of a client without a throttle as it was', async () => {
    const { call } = setup()
    for (let i = 0; i < 50; i++)
      expect((await failure(call(basic('alice:wrong')))).status).toBe(401)
  })
})

describe('authenticateRequest: challenges', () => {
  it('offers Basic first, without a charset parameter, and Bearer second', async () => {
    const { call } = setup()
    const error = await failure(call())
    expect(error.challenges).toEqual(['Basic realm="Web Calendar"', 'Bearer realm="Web Calendar"'])
    const expired = await failure(call('Bearer expired.jwt.token'))
    expect(expired.challenges).toEqual([
      'Basic realm="Web Calendar"',
      'Bearer realm="Web Calendar", error="invalid_token"',
    ])
  })
})

describe('AuthError', () => {
  it.each([
    ['throttled', 429],
    ['keys-unavailable', 503],
    ['expired', 401],
    ['invalid-app-token', 401],
    ['no-credentials', 401],
  ] as const)('maps %s to HTTP %i', (reason, status) => {
    expect(new AuthError(reason).status).toBe(status)
  })

  it.each([
    [undefined, 1],
    [0, 1],
    [0.2, 1],
    [1, 1],
    [59.01, 60],
    [600, 600],
  ])('rounds a Retry-After of %s up to %s whole seconds, at least 1', (given, expected) => {
    expect(new AuthError('throttled', { retryAfterSec: given }).retryAfterSec).toBe(expected)
  })

  it('has a Retry-After only when it is a 429', () => {
    expect(new AuthError('expired', { retryAfterSec: 30 }).retryAfterSec).toBeNull()
    expect(new AuthError('keys-unavailable').retryAfterSec).toBeNull()
  })
})
