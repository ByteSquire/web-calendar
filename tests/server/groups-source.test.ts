// @vitest-environment node
// Where a person's groups come from (decisions A3 and O3 of the plan): userinfo first; the verified
// token's own claim only where userinfo cannot give groups; a refusal from the issuer's own origin
// is never turned into a fallback.
import { describe, expect, it } from 'vitest'
import type { UserinfoResult } from '../../server/utils/api/userinfo'
import { chooseGroups, type TokenGroups } from '../../server/utils/groups/source'

const profile = (groups?: string[]): UserinfoResult => ({
  ok: true,
  profile: { sub: 's', groups },
})
const failed = (
  reason: Extract<UserinfoResult, { ok: false }>['reason'],
  extra: { status?: number; otherOrigin?: boolean } = {},
): UserinfoResult => ({ ok: false, reason, ...extra })
const token = (entries: string[] | undefined, overage = false): TokenGroups => ({
  entries,
  overage,
})

describe('chooseGroups', () => {
  it('takes userinfo when it has the claim, even if the token says something else', () => {
    expect(chooseGroups(profile(['a']), token(['b']))).toEqual({
      ok: true,
      entries: ['a'],
      from: 'userinfo',
    })
    // An empty list from userinfo is an answer: the person is in no group.
    expect(chooseGroups(profile([]), token(['b']))).toEqual({
      ok: true,
      entries: [],
      from: 'userinfo',
    })
  })

  it('takes the token when userinfo answered without the claim', () => {
    expect(chooseGroups(profile(undefined), token(['b']))).toEqual({
      ok: true,
      entries: ['b'],
      from: 'token',
    })
    expect(chooseGroups(profile(undefined), undefined)).toEqual({
      ok: true,
      entries: undefined,
      from: 'token',
    })
  })

  it('does not take the groups of a token that says they were left out (overage)', () => {
    expect(chooseGroups(profile(undefined), token(['b'], true))).toEqual({
      ok: true,
      entries: undefined,
      from: 'token',
    })
  })

  it('takes the token when the provider has no userinfo endpoint', () => {
    expect(chooseGroups(failed('no-endpoint'), token(['b']))).toMatchObject({
      ok: true,
      entries: ['b'],
      from: 'token',
    })
  })

  it.each([401, 403])(
    'takes the token when an endpoint on another origin refuses it with %i (Entra)',
    (status) => {
      expect(
        chooseGroups(failed('status', { status, otherOrigin: true }), token(['b'])),
      ).toMatchObject({ ok: true, entries: ['b'], from: 'token' })
    },
  )

  it.each([401, 403])(
    'does not, when the endpoint is on the issuer’s own origin: %i may be a revoked token',
    (status) => {
      expect(chooseGroups(failed('status', { status }), token(['b']))).toEqual({ ok: false })
    },
  )

  it.each([
    ['a server error', failed('status', { status: 500, otherOrigin: true })],
    ['a missing endpoint page', failed('status', { status: 404, otherOrigin: true })],
    ['no token', failed('no-token')],
    ['a timeout', failed('timeout')],
    ['a network error', failed('network')],
    ['bad JSON', failed('bad-json')],
    ['a wrong shape', failed('bad-shape')],
    ['too large an answer', failed('too-large')],
    ['an answer about somebody else', failed('sub-mismatch')],
  ])('stays closed on %s, token claim or not', (_label, result) => {
    expect(chooseGroups(result, token(['b']))).toEqual({ ok: false })
  })
})
