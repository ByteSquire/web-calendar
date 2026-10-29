// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { authenticateRequest, type AuthDeps } from '../../server/utils/auth/authenticate'
import { AuthError } from '../../server/utils/auth/errors'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'

function setup(overrides: Partial<AuthDeps> = {}) {
  const verify = vi.fn(async (token: string) => {
    if (token !== 'good.jwt.token') throw new AuthError('expired')
    return { sub: SUB, clientId: 'web-calendar', scopes: ['caldav'], exp: 1 }
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

describe('authenticateRequest', () => {
  it('sends a bearer token to the verifier', async () => {
    const { call, verify, verifyAppToken } = setup()
    await expect(call('Bearer good.jwt.token')).resolves.toEqual({ sub: SUB, via: 'bearer' })
    expect(verify).toHaveBeenCalledWith('good.jwt.token')
    expect(verifyAppToken).not.toHaveBeenCalled()
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

  it.each(['a/b', 'a\\b', 'line\nbreak', 'two words', '', 'ü', 'x'.repeat(256)])(
    'refuses a user id that cannot be Radicale’s user name (%j)',
    async (sub) => {
      const bearer = setup({
        verifier: { verify: async () => ({ sub, clientId: 'c', scopes: [], exp: 1 }) },
      })
      expect((await failure(bearer.call('Bearer a.b.c'))).reason).toBe('invalid-sub')
      const token = setup({ verifyAppToken: () => ({ sub }) })
      expect((await failure(token.call(basic('alice:x')))).reason).toBe('invalid-sub')
    },
  )
})
