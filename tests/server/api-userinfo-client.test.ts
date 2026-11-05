// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUserinfoClient,
  tokenExpiresAtMs,
  USERINFO_FAILURE_TTL_MS,
  USERINFO_TTL_MS,
  type UserinfoClient,
} from '../../server/utils/api/userinfo-client'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'
const TOKEN = 'header.payload.signature-secret'

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

let now: number
let respond: FetchFn
let fetchCalls: ReturnType<typeof vi.fn<FetchFn>>

function claims(sub: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ sub, name: `name of ${sub}`, groups: ['g'], ...extra }))
}

/** The `sub` is told by the token the fake receives: `Bearer <sub>`. */
function subOf(init?: RequestInit): string {
  return new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
}

function setup(options: { maxEntries?: number } = {}): UserinfoClient {
  fetchCalls = vi.fn<FetchFn>((url, init) => respond(url, init))
  return createUserinfoClient({
    fetch: fetchCalls as typeof fetch,
    // The discovery document of ISSUER names this endpoint; any other issuer is not known.
    endpointOf: (issuer) => (issuer === ISSUER ? `${ISSUER}/userinfo` : null),
    now: () => now,
    timeoutMs: 100,
    ...options,
  })
}

function lookup(
  sub: string,
  extra: { tokenExpiresAtMs?: number | null; accessToken?: string } = {},
) {
  return { issuer: ISSUER, sub, accessToken: extra.accessToken ?? sub, ...extra }
}

beforeEach(() => {
  now = 1_000_000
  respond = async (_url, init) => claims(subOf(init))
})

describe('createUserinfoClient', () => {
  it('asks the endpoint of the issuer’s discovery document, and nothing when there is none', async () => {
    const client = setup()
    await client.get(lookup('alice'))
    expect(fetchCalls.mock.calls[0]![0]).toBe(`${ISSUER}/userinfo`)

    // An issuer without a known endpoint (no document yet, or a provider without userinfo): no call,
    // nothing kept, so the answer follows the document as soon as there is one.
    fetchCalls.mockClear()
    const unknown = { ...lookup('bob'), issuer: 'https://other.example.org/realms/team' }
    expect(await client.get(unknown)).toEqual({ ok: false, reason: 'no-endpoint' })
    expect(fetchCalls).not.toHaveBeenCalled()
    expect(client.size()).toBe(1)
  })

  it('keeps an answer for a minute per user and then asks again', async () => {
    const client = setup()
    const first = await client.get(lookup('alice'))
    expect(first).toMatchObject({ ok: true, profile: { sub: 'alice' } })

    now += USERINFO_TTL_MS - 1
    expect(await client.get(lookup('alice'))).toBe(first)
    expect(fetchCalls).toHaveBeenCalledTimes(1)

    now += 1
    await client.get(lookup('alice'))
    expect(fetchCalls).toHaveBeenCalledTimes(2)
  })

  it('does not mix up users', async () => {
    const client = setup()
    const alice = await client.get(lookup('alice'))
    const bob = await client.get(lookup('bob'))
    expect(alice).toMatchObject({ profile: { sub: 'alice' } })
    expect(bob).toMatchObject({ profile: { sub: 'bob' } })
    expect(fetchCalls).toHaveBeenCalledTimes(2)
    // each call carried its own user's token
    expect(fetchCalls.mock.calls.map(([, init]) => subOf(init))).toEqual(['alice', 'bob'])
  })

  it('never keeps an answer longer than the token lives', async () => {
    const client = setup()
    await client.get(lookup('alice', { tokenExpiresAtMs: now + 10_000 }))
    now += 9_999
    await client.get(lookup('alice', { tokenExpiresAtMs: now + 1 }))
    expect(fetchCalls).toHaveBeenCalledTimes(1)
    now += 1
    await client.get(lookup('alice', { tokenExpiresAtMs: now + 10_000 }))
    expect(fetchCalls).toHaveBeenCalledTimes(2)
  })

  it('does not keep anything for a token that has expired already', async () => {
    const client = setup()
    await client.get(lookup('alice', { tokenExpiresAtMs: now - 1 }))
    await client.get(lookup('alice', { tokenExpiresAtMs: now - 1 }))
    expect(fetchCalls).toHaveBeenCalledTimes(2)
    expect(client.size()).toBe(0)
  })

  it('shares one call between concurrent requests of a user', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    respond = async (_url, init) => {
      await gate
      return claims(subOf(init))
    }
    const client = setup()

    const pending = Array.from({ length: 25 }, () => client.get(lookup('alice')))
    const other = client.get(lookup('bob'))
    release()
    const results = await Promise.all(pending)

    expect(fetchCalls).toHaveBeenCalledTimes(2) // one for alice, one for bob
    expect(new Set(results).size).toBe(1)
    expect(await other).toMatchObject({ profile: { sub: 'bob' } })
  })

  it('starts a new call once the shared one is over', async () => {
    const client = setup()
    await Promise.all([client.get(lookup('alice')), client.get(lookup('alice'))])
    await client.get(lookup('alice'), { maxAgeMs: 0 })
    expect(fetchCalls).toHaveBeenCalledTimes(2)
  })

  describe('maxAgeMs: 0 (the admin check)', () => {
    it('never uses an answer from the past, and stores the fresh one', async () => {
      const client = setup()
      respond = async (_url, init) => claims(subOf(init), { groups: ['calendar_admins'] })
      await client.get(lookup('alice'))

      respond = async (_url, init) => claims(subOf(init), { groups: [] })
      const fresh = await client.get(lookup('alice'), { maxAgeMs: 0 })
      expect(fresh).toMatchObject({ profile: { groups: [] } })
      expect(fetchCalls).toHaveBeenCalledTimes(2)

      // the next ordinary read sees what the fresh call found
      expect(await client.get(lookup('alice'))).toBe(fresh)
      expect(fetchCalls).toHaveBeenCalledTimes(2)
    })

    it('joins a call that is already running', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      respond = async (_url, init) => {
        await gate
        return claims(subOf(init))
      }
      const client = setup()

      const ordinary = client.get(lookup('alice'))
      const admin = client.get(lookup('alice'), { maxAgeMs: 0 })
      release()
      expect(await admin).toBe(await ordinary)
      expect(fetchCalls).toHaveBeenCalledTimes(1)
    })

    it('is satisfied by an answer younger than maxAgeMs', async () => {
      const client = setup()
      await client.get(lookup('alice'))
      now += 500
      await client.get(lookup('alice'), { maxAgeMs: 1000 })
      expect(fetchCalls).toHaveBeenCalledTimes(1)
      await client.get(lookup('alice'), { maxAgeMs: 500 })
      expect(fetchCalls).toHaveBeenCalledTimes(2)
    })
  })

  describe('failures', () => {
    it('are remembered only for a few seconds', async () => {
      respond = async () => new Response('down', { status: 503 })
      const client = setup()
      expect(await client.get(lookup('alice'))).toEqual({
        ok: false,
        reason: 'status',
        status: 503,
      })
      await client.get(lookup('alice'))
      expect(fetchCalls).toHaveBeenCalledTimes(1)

      now += USERINFO_FAILURE_TTL_MS
      respond = async (_url, init) => claims(subOf(init))
      expect(await client.get(lookup('alice'))).toMatchObject({ ok: true })
      expect(fetchCalls).toHaveBeenCalledTimes(2)
    })

    it('do not stop the admin check from trying again', async () => {
      respond = async () => new Response('down', { status: 503 })
      const client = setup()
      await client.get(lookup('alice'))
      respond = async (_url, init) => claims(subOf(init), { groups: ['calendar_admins'] })
      expect(await client.get(lookup('alice'), { maxAgeMs: 0 })).toMatchObject({ ok: true })
    })

    it('include an answer about somebody else', async () => {
      respond = async () => claims('someone-else')
      const client = setup()
      expect(await client.get(lookup('alice'))).toEqual({ ok: false, reason: 'sub-mismatch' })
    })
  })

  it('does not ask, keep or share anything without an issuer or a token', async () => {
    const client = setup()
    expect(await client.get({ ...lookup('alice'), issuer: '' })).toEqual({
      ok: false,
      reason: 'no-endpoint',
    })
    expect(await client.get({ ...lookup('alice'), accessToken: null })).toEqual({
      ok: false,
      reason: 'no-token',
    })
    expect(fetchCalls).not.toHaveBeenCalled()
    expect(client.size()).toBe(0)
  })

  describe('a refusal from an endpoint on another origin (Entra: Microsoft Graph)', () => {
    const GRAPH = 'https://graph.example.net/oidc/userinfo'
    const other = (): UserinfoClient => {
      fetchCalls = vi.fn<FetchFn>((url, init) => respond(url, init))
      return createUserinfoClient({
        fetch: fetchCalls as typeof fetch,
        endpointOf: (issuer) => (issuer === ISSUER ? GRAPH : null),
        now: () => now,
        timeoutMs: 100,
      })
    }

    it('is marked, also when it comes from the memory', async () => {
      respond = async () => new Response('no', { status: 401 })
      const client = other()
      const expected = { ok: false, reason: 'status', status: 401, otherOrigin: true }
      expect(await client.get(lookup('alice'))).toEqual(expected)
      expect(await client.get(lookup('alice'))).toEqual(expected)
      expect(fetchCalls).toHaveBeenCalledTimes(1)
    })

    it('is not marked when the endpoint is on the issuer’s origin, or the failure is another one', async () => {
      respond = async () => new Response('no', { status: 401 })
      expect(await setup().get(lookup('alice'))).toEqual({
        ok: false,
        reason: 'status',
        status: 401,
      })
      respond = async () => new Response('down', { status: 503 })
      // The mark says where a status came from; it does not decide what to do with it.
      expect(await other().get(lookup('bob'))).toMatchObject({ status: 503, otherOrigin: true })
    })

    it('keeps the answers for two claims of one person apart, kept or in flight', async () => {
      respond = async (_url, init) =>
        claims(subOf(init), { groups: ['from-groups'], roles: ['from-roles'] })
      const client = setup()
      const [plain, roles] = await Promise.all([
        client.get({ ...lookup('alice') }),
        client.get({ ...lookup('alice'), groupsClaim: 'roles' }),
      ])
      expect(plain).toMatchObject({ profile: { groups: ['from-groups'] } })
      expect(roles).toMatchObject({ profile: { groups: ['from-roles'] } })
      expect(fetchCalls).toHaveBeenCalledTimes(2)
      // Kept answers too: each claim gets its own.
      expect(await client.get({ ...lookup('alice'), groupsClaim: 'roles' })).toMatchObject({
        profile: { groups: ['from-roles'] },
      })
      expect(fetchCalls).toHaveBeenCalledTimes(2)
    })

    it('reads the groups from the claim that is configured', async () => {
      respond = async (_url, init) =>
        claims(subOf(init), { 'cognito:groups': ['a'], groups: ['b'] })
      const client = setup()
      expect(await client.get({ ...lookup('alice'), groupsClaim: 'cognito:groups' })).toMatchObject(
        { ok: true, profile: { groups: ['a'] } },
      )
      expect(await client.get({ ...lookup('bob') })).toMatchObject({ profile: { groups: ['b'] } })
    })
  })

  describe('memory bound', () => {
    it('keeps at most maxEntries answers and drops the oldest first', async () => {
      const client = setup({ maxEntries: 3 })
      for (const sub of ['u1', 'u2', 'u3', 'u4', 'u5']) await client.get(lookup(sub))
      expect(client.size()).toBe(3)

      fetchCalls.mockClear()
      await client.get(lookup('u5'))
      await client.get(lookup('u4'))
      await client.get(lookup('u3'))
      expect(fetchCalls).not.toHaveBeenCalled()
      await client.get(lookup('u1'))
      expect(fetchCalls).toHaveBeenCalledTimes(1)
    })

    it('drops answers that have run out before it drops a live one', async () => {
      const client = setup({ maxEntries: 3 })
      await client.get(lookup('short', { tokenExpiresAtMs: now + 1000 }))
      await client.get(lookup('live1'))
      await client.get(lookup('live2'))
      now += 1000
      await client.get(lookup('live3'))
      expect(client.size()).toBe(3)

      fetchCalls.mockClear()
      await client.get(lookup('live1'))
      await client.get(lookup('live2'))
      await client.get(lookup('live3'))
      expect(fetchCalls).not.toHaveBeenCalled()
    })

    it('stays bounded under a flood of different users', async () => {
      const client = setup({ maxEntries: 50 })
      for (let i = 0; i < 400; i += 1) await client.get(lookup(`user-${i}`))
      expect(client.size()).toBe(50)
    })
  })

  it('forgets everything on clear()', async () => {
    const client = setup()
    await client.get(lookup('alice'))
    client.clear()
    expect(client.size()).toBe(0)
    await client.get(lookup('alice'))
    expect(fetchCalls).toHaveBeenCalledTimes(2)
  })

  it('does not hold on to the token', async () => {
    const client = setup()
    const result = await client.get(lookup('alice', { accessToken: TOKEN }))
    expect(JSON.stringify(result)).not.toContain('signature-secret')
  })
})

describe('tokenExpiresAtMs', () => {
  function jwt(payload: unknown): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'ES256' })}.${encode(payload)}.sig`
  }

  it('reads exp in milliseconds', () => {
    expect(tokenExpiresAtMs(jwt({ exp: 1793338544 }))).toBe(1793338544000)
  })

  it.each([
    ['no token', null],
    ['an empty token', ''],
    ['a token without a payload', 'abc'],
    ['a payload that is no base64 JSON', 'a.!!!.c'],
    ['a payload that is no object', jwt('text')],
    ['a null payload', jwt(null)],
    ['no exp', jwt({ sub: 'x' })],
    ['a text exp', jwt({ exp: '1793338544' })],
    ['an infinite exp', `a.${Buffer.from('{"exp":1e999}').toString('base64url')}.c`],
  ])('is null for %s', (_label, token) => {
    expect(tokenExpiresAtMs(token)).toBeNull()
  })
})
