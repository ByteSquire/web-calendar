// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decideAdmin } from '../../server/utils/api/admin'
import { createUserinfoClient } from '../../server/utils/api/userinfo-client'
import type { TokenGroups } from '../../server/utils/groups/source'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function decide(
  respond: FetchFn,
  accessToken: string | null = 'alice-token',
  extra: { endpoint?: string | null; tokenGroups?: TokenGroups } = {},
) {
  const client = createUserinfoClient({
    fetch: respond as typeof fetch,
    // As the discovery document of ISSUER names it.
    endpointOf: (issuer) =>
      issuer === ISSUER
        ? extra.endpoint === undefined
          ? `${ISSUER}/userinfo`
          : extra.endpoint
        : null,
    timeoutMs: 50,
  })
  return decideAdmin({
    userinfo: client,
    issuer: ISSUER,
    adminGroup: 'calendar_admins',
    sub: 'sub-alice',
    accessToken,
    tokenGroups: extra.tokenGroups,
  })
}

const answer =
  (body: Record<string, unknown>, status = 200): FetchFn =>
  async () =>
    new Response(JSON.stringify({ sub: 'sub-alice', ...body }), { status })

describe('decideAdmin', () => {
  it.each([
    ['a short group name', ['calendar_admins']],
    ['an SPN', ['calendar_admins@idm.example.org']],
    ['among UUIDs and other groups', ['0000-1', 'staff@idm.example.org', 'calendar_admins@idm']],
  ])('lets an admin through, by %s', async (_label, groups) => {
    expect(await decide(answer({ groups }))).toEqual({ admin: true })
  })

  it.each([
    ['another group', ['staff'], 'not-in-group'],
    ['no group at all', [], 'not-in-group'],
    ['a near miss', ['calendar_admins_old', 'calendar_admins_old@idm.example.org'], 'not-in-group'],
    ['a different case', ['Calendar_Admins'], 'not-in-group'],
  ])('refuses somebody with %s', async (_label, groups, reason) => {
    expect(await decide(answer({ groups }))).toEqual({ admin: false, reason })
  })

  it.each([
    ['a missing claim', {}],
    ['a null claim', { groups: null }],
    ['a number claim', { groups: 1 }],
    ['a true claim', { groups: true }],
  ])('fails closed on %s, whatever else the answer says', async (_label, claims) => {
    expect(await decide(answer({ name: 'Alice', ...claims }))).toEqual({
      admin: false,
      reason: 'no-groups-claim',
    })
  })

  it('reads a text claim as one group and an object claim as its names that stand for something', async () => {
    // A provider with one group may send it as text (a single-valued mapper); Zitadel sends roles
    // as an object. A name that stands for false, null, 0 or '' is not one the person has.
    expect(await decide(answer({ groups: 'calendar_admins' }))).toEqual({ admin: true })
    expect(await decide(answer({ groups: { calendar_admins: { org1: 'x.example' } } }))).toEqual({
      admin: true,
    })
    for (const flag of [false, null, 0, '']) {
      expect(await decide(answer({ groups: { calendar_admins: flag } }))).toEqual({
        admin: false,
        reason: 'not-in-group',
      })
    }
    expect(await decide(answer({ groups: 'staff' }))).toEqual({
      admin: false,
      reason: 'not-in-group',
    })
  })

  it.each([
    ['a server error', answer({}, 500)],
    ['a rejected token', answer({}, 401)],
    ['malformed JSON', async () => new Response('{"sub":')],
    ['an answer about someone else', answer({ sub: 'sub-bob', groups: ['calendar_admins'] })],
    [
      'a network error',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      'a timeout',
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ],
  ])('fails closed on %s', async (_label, respond) => {
    expect(await decide(respond as FetchFn)).toEqual({
      admin: false,
      reason: 'userinfo-unavailable',
    })
  })

  it('fails closed without a token', async () => {
    expect(await decide(answer({ groups: ['calendar_admins'] }), null)).toEqual({
      admin: false,
      reason: 'userinfo-unavailable',
    })
  })
})

describe('decideAdmin with the groups claim of the token', () => {
  const admin: TokenGroups = { entries: ['calendar_admins'], overage: false }
  const GRAPH = 'https://graph.example.net/oidc/userinfo'

  it('uses the token where the provider has no userinfo endpoint', async () => {
    const never: FetchFn = async () => {
      throw new Error('no call expected')
    }
    expect(await decide(never, 'alice-token', { endpoint: null, tokenGroups: admin })).toEqual({
      admin: true,
    })
    expect(
      await decide(never, 'alice-token', {
        endpoint: null,
        tokenGroups: { entries: ['staff'], overage: false },
      }),
    ).toEqual({ admin: false, reason: 'not-in-group' })
    expect(await decide(never, 'alice-token', { endpoint: null })).toEqual({
      admin: false,
      reason: 'no-groups-claim',
    })
  })

  it('uses the token where userinfo answers without the claim', async () => {
    expect(await decide(answer({ name: 'Alice' }), 'alice-token', { tokenGroups: admin })).toEqual({
      admin: true,
    })
  })

  it('prefers userinfo: a person removed from the group is not an admin because the token is old', async () => {
    expect(
      await decide(answer({ groups: ['staff'] }), 'alice-token', { tokenGroups: admin }),
    ).toEqual({ admin: false, reason: 'not-in-group' })
  })

  it.each([401, 403])(
    'uses the token when an endpoint on another origin refuses it with %i (Entra)',
    async (status) => {
      expect(
        await decide(answer({}, status), 'alice-token', { endpoint: GRAPH, tokenGroups: admin }),
      ).toEqual({ admin: true })
    },
  )

  it.each([401, 403])(
    'does not when the issuer’s own userinfo refuses with %i: a revoked token is no admin',
    async (status) => {
      expect(await decide(answer({}, status), 'alice-token', { tokenGroups: admin })).toEqual({
        admin: false,
        reason: 'userinfo-unavailable',
      })
    },
  )

  it('stays closed on another origin when the endpoint itself fails, or the token has too many groups', async () => {
    expect(
      await decide(answer({}, 500), 'alice-token', { endpoint: GRAPH, tokenGroups: admin }),
    ).toEqual({ admin: false, reason: 'userinfo-unavailable' })
    expect(
      await decide(answer({}, 401), 'alice-token', {
        endpoint: GRAPH,
        tokenGroups: { entries: ['calendar_admins'], overage: true },
      }),
    ).toEqual({ admin: false, reason: 'no-groups-claim' })
  })
})
