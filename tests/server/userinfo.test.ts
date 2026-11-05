// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  fetchUserinfo,
  type UserinfoRequest,
  type UserinfoResult,
} from '../../server/utils/api/userinfo'
import { matchesAdminGroup } from '../../server/utils/groups/claim'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'
const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.secret-payload.secret-signature'

const ALICE = {
  sub: SUB,
  name: 'Alice Example',
  preferred_username: 'alice',
  email: 'alice@example.test',
  groups: ['calendar_admins'],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function run(respond: FetchFn, overrides: Partial<UserinfoRequest> = {}): Promise<UserinfoResult> {
  return fetchUserinfo({
    // As the discovery document of the issuer gives it; Keycloak or Entra would differ.
    endpoint: `${ISSUER}/userinfo`,
    accessToken: TOKEN,
    expectedSub: SUB,
    fetch: respond as typeof fetch,
    timeoutMs: 50,
    ...overrides,
  })
}

/** A fetch that never answers, but honors the abort signal like the real one. */
const hangs: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

describe('fetchUserinfo', () => {
  it('asks the given endpoint with the caller token and returns the profile', async () => {
    const fake = vi.fn<FetchFn>(async () => json(ALICE))
    const result = await run(fake)

    expect(result).toEqual({
      ok: true,
      profile: {
        sub: SUB,
        username: 'alice',
        name: 'Alice Example',
        email: 'alice@example.test',
        groups: ['calendar_admins'],
      },
    })
    expect(fake).toHaveBeenCalledTimes(1)
    const [url, init] = fake.mock.calls[0]!
    expect(url).toBe(`${ISSUER}/userinfo`)
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    // The token is never sent to a place the operator did not configure.
    expect(init?.redirect).toBe('error')
  })

  it('asks exactly the endpoint it is given, wherever the provider keeps it', async () => {
    const fake = vi.fn<FetchFn>(async () => json(ALICE))
    const keycloak = 'https://keycloak.example.org/realms/team/protocol/openid-connect/userinfo'
    await run(fake, { endpoint: keycloak })
    expect(fake.mock.calls[0]![0]).toBe(keycloak)
  })

  it('ignores a userinfo answer about somebody else', async () => {
    const result = await run(async () => json({ ...ALICE, sub: 'someone-else' }))
    expect(result).toEqual({ ok: false, reason: 'sub-mismatch' })
  })

  it.each([
    ['groups as short names', ['idm_all_persons', 'calendar_admins']],
    ['groups as SPNs', ['idm_all_persons@idm.example.org', 'calendar_admins@idm.example.org']],
    [
      'groups mixed with UUIDs',
      ['00000000-0000-0000-0000-000000000035', 'calendar_admins@idm.localhost'],
    ],
  ])('passes %s through', async (_label, groups) => {
    const result = await run(async () => json({ ...ALICE, groups }))
    expect(result).toMatchObject({ ok: true, profile: { groups } })
  })

  it('drops group entries that are not strings and treats a number or boolean as "no claim"', async () => {
    const mixed = await run(async () => json({ ...ALICE, groups: ['a', 3, null, { x: 1 }, 'b'] }))
    expect(mixed).toMatchObject({ ok: true, profile: { groups: ['a', 'b'] } })

    for (const groups of [undefined, null, 7, true]) {
      const result = await run(async () => json({ ...ALICE, groups }))
      expect(result).toMatchObject({ ok: true })
      expect((result as { profile: { groups?: string[] } }).profile.groups).toBeUndefined()
    }
    // One text is one group; an object gives the names that stand for something (Zitadel roles).
    expect(await run(async () => json({ ...ALICE, groups: 'staff' }))).toMatchObject({
      profile: { groups: ['staff'] },
    })
    expect(
      await run(async () => json({ ...ALICE, groups: { admin: { o: 'x' }, off: false } })),
    ).toMatchObject({ profile: { groups: ['admin'] } })
  })

  it('leaves out profile fields that are missing, empty or not strings', async () => {
    const result = await run(async () =>
      json({ sub: SUB, name: '  ', preferred_username: 42, email: null }),
    )
    expect(result).toEqual({
      ok: true,
      profile: {
        sub: SUB,
        username: undefined,
        name: undefined,
        email: undefined,
        groups: undefined,
      },
    })
  })

  it.each([
    ['500', () => json({ error: 'boom' }, 500), { reason: 'status', status: 500 }],
    ['401', () => json({ error: 'invalid_token' }, 401), { reason: 'status', status: 401 }],
    [
      '204 without a body',
      () => new Response(null, { status: 204 }),
      { reason: 'status', status: 204 },
    ],
    ['malformed JSON', () => new Response('{"sub": ', { status: 200 }), { reason: 'bad-json' }],
    [
      'an HTML page',
      () => new Response('<html>nope</html>', { status: 200 }),
      { reason: 'bad-json' },
    ],
    ['an empty body', () => new Response('', { status: 200 }), { reason: 'bad-json' }],
    ['a JSON list', () => json([ALICE]), { reason: 'bad-shape' }],
    ['JSON null', () => new Response('null', { status: 200 }), { reason: 'bad-shape' }],
    ['no sub', () => json({ name: 'Alice' }), { reason: 'bad-shape' }],
    ['a numeric sub', () => json({ sub: 5 }), { reason: 'bad-shape' }],
    [
      'an oversized body',
      () => new Response(`{"sub":"${'x'.repeat(70_000)}"}`),
      { reason: 'too-large' },
    ],
  ])('fails softly on %s', async (_label, respond, expected) => {
    expect(await run(async () => respond())).toEqual({ ok: false, ...expected })
  })

  it('reports a network error', async () => {
    const result = await run(async () => {
      throw new TypeError('fetch failed')
    })
    expect(result).toEqual({ ok: false, reason: 'network' })
  })

  it('gives up after the timeout when the server never answers', async () => {
    const started = Date.now()
    expect(await run(hangs, { timeoutMs: 30 })).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('gives up even when fetch ignores the abort signal', async () => {
    const stuck: FetchFn = () => new Promise<Response>(() => {})
    expect(await run(stuck, { timeoutMs: 30 })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('counts the time to read the body, not only the headers', async () => {
    const slowBody: FetchFn = async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return new Response(stream, { status: 200 })
    }
    expect(await run(slowBody, { timeoutMs: 30 })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('does not call out without an endpoint or a token', async () => {
    const fake = vi.fn<FetchFn>(async () => json(ALICE))
    expect(await run(fake, { endpoint: null })).toEqual({ ok: false, reason: 'no-endpoint' })
    expect(await run(fake, { endpoint: '' })).toEqual({ ok: false, reason: 'no-endpoint' })
    expect(await run(fake, { accessToken: null })).toEqual({ ok: false, reason: 'no-token' })
    expect(await run(fake, { accessToken: '' })).toEqual({ ok: false, reason: 'no-token' })
    expect(fake).not.toHaveBeenCalled()
  })

  it('never puts the token into a result', async () => {
    const outcomes = await Promise.all([
      run(async () => json(ALICE)),
      run(async () => json({}, 500)),
      run(async () => new Response('not json')),
      run(async () => {
        throw new Error(`failed with ${TOKEN}`)
      }),
      run(hangs, { timeoutMs: 10 }),
    ])
    expect(JSON.stringify(outcomes)).not.toContain('secret-payload')
  })
})

describe('the admin group against a groups claim (matchesAdminGroup)', () => {
  it.each([
    [['calendar_admins'], true],
    [['idm_all_persons', 'calendar_admins'], true],
    [['calendar_admins@idm.example.org'], true],
    [['00000000-0000-0000-0000-000000000035', 'x@y', 'calendar_admins@idm.localhost'], true],
    // near misses
    [['calendar_admins_old'], false],
    [['calendar_admins_old@idm.example.org'], false],
    [['calendar_adminsx'], false],
    [['xcalendar_admins'], false],
    [['calendar_admins '], false],
    [['other@calendar_admins'], false],
    [['calendar'], false],
    [['Calendar_Admins'], false],
    [['calendar_admins@'], true],
    [[''], false],
    [[], false],
  ])('%j -> %s', (groups, expected) => {
    expect(matchesAdminGroup(groups, 'calendar_admins')).toBe(expected)
  })

  it('treats an empty admin group as "nobody is admin"', () => {
    expect(matchesAdminGroup(['', '@idm.example.org', 'calendar_admins'], '')).toBe(false)
  })

  it('follows the configured group name', () => {
    expect(matchesAdminGroup(['staff@idm.example.org'], 'staff')).toBe(true)
    expect(matchesAdminGroup(['calendar_admins'], 'staff')).toBe(false)
  })

  it('compares a path or an id exactly, as Keycloak and Entra write them', () => {
    // Keycloak's "Full group path": the admin group is then configured as the path.
    expect(matchesAdminGroup(['/team/ops', '/calendar_admins'], '/calendar_admins')).toBe(true)
    expect(matchesAdminGroup(['/team/ops'], '/team/ops')).toBe(true)
    // Not by its last segment, by a parent, or by a longer path.
    expect(matchesAdminGroup(['/team/ops'], 'ops')).toBe(false)
    expect(matchesAdminGroup(['/team/ops'], '/team')).toBe(false)
    expect(matchesAdminGroup(['/team/ops/extra'], '/team/ops')).toBe(false)
    // An Entra group is its object id.
    const id = '6f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77'
    expect(matchesAdminGroup([id], id)).toBe(true)
    expect(matchesAdminGroup([id.toUpperCase()], id)).toBe(false)
  })

  it('takes an SPN, a path joined by dots and the exact name, and nothing that is merely alike', () => {
    expect(matchesAdminGroup(['/team/ops'], 'team.ops')).toBe(true)
    expect(matchesAdminGroup(['staff@idm.example.org'], 'staff')).toBe(true)
    expect(matchesAdminGroup(['authentik Admins'], 'authentik Admins')).toBe(true)
    // Cleaning a name for the group file is not a way to the admin group: only an administrator of
    // the provider should be able to make somebody an admin here, not whoever can name a group.
    expect(matchesAdminGroup(['authentik Admins'], 'authentik_Admins')).toBe(false)
    for (const alike of [
      'calendar admins',
      'calendar+admins',
      'calendar|admins',
      'calendar/admins',
      'calendar   admins',
      'calendaréadmins',
      ' calendar_admins',
      'calendar_admins ',
    ]) {
      expect(matchesAdminGroup([alike], 'calendar_admins')).toBe(false)
    }
    // An SPN has one @ (a name with two is something else), and a longer name is another group.
    expect(matchesAdminGroup(['calendar_admins@a@b'], 'calendar_admins')).toBe(false)
    expect(matchesAdminGroup(['x'.repeat(70)], 'x'.repeat(64))).toBe(false)
    // Cleaning does not trim, and a parent, a child or a neighbour is no match either.
    expect(matchesAdminGroup(['/team'], 'team.ops')).toBe(false)
    expect(matchesAdminGroup(['/team/ops/extra'], 'team.ops')).toBe(false)
    expect(matchesAdminGroup(['team.ops.extra'], 'team.ops')).toBe(false)
  })
})
