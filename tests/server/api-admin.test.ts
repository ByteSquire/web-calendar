// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decideAdmin } from '../../server/utils/api/admin'
import { createUserinfoClient } from '../../server/utils/api/userinfo-client'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function decide(respond: FetchFn, accessToken: string | null = 'alice-token') {
  const client = createUserinfoClient({ fetch: respond as typeof fetch, timeoutMs: 50 })
  return decideAdmin({
    userinfo: client,
    issuer: ISSUER,
    adminGroup: 'calendar_admins',
    sub: 'sub-alice',
    accessToken,
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
    ['a text claim', { groups: 'calendar_admins' }],
    ['an object claim', { groups: { calendar_admins: true } }],
  ])('fails closed on %s, whatever else the answer says', async (_label, claims) => {
    expect(await decide(answer({ name: 'Alice', ...claims }))).toEqual({
      admin: false,
      reason: 'no-groups-claim',
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
