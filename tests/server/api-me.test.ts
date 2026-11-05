// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findUserBySub, setUserTimeZone, upsertUser } from '../../server/db/users'
import { bearerToken, resolveMe, type ResolveMeOptions } from '../../server/utils/api/me'
import { createUserinfoClient } from '../../server/utils/api/userinfo-client'
import { openTestDb } from './api-fixtures'

const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'
/** As the discovery document of ISSUER names it; an empty issuer has none. */
const endpointOfIssuer = (issuer: string) => (issuer === ISSUER ? `${ISSUER}/userinfo` : null)
const ALICE_SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const BOB_SUB = '6f9f0e2d-0000-4000-8000-000000000002'
const ALICE_TOKEN = 'alice.token.value'
const BOB_TOKEN = 'bob.token.value'

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

let db: Database
let warn: ReturnType<typeof vi.fn<(message: string) => void>>

beforeEach(() => {
  db = openTestDb()
  warn = vi.fn()
})

afterEach(() => {
  db.close()
})

function userinfo(claims: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(claims), { status })
}

function options(fetchImpl: FetchFn, overrides: Partial<ResolveMeOptions> = {}): ResolveMeOptions {
  // A client of its own per call, so nothing is remembered between two calls of a test.
  const client = createUserinfoClient({
    fetch: fetchImpl as typeof fetch,
    endpointOf: endpointOfIssuer,
    timeoutMs: 50,
  })
  return {
    db,
    adminGroup: 'calendar_admins',
    groupsIgnore: [],
    userinfo: (sub, accessToken) => client.get({ issuer: ISSUER, sub, accessToken }),
    warn,
    ...overrides,
  }
}

/** What requireAppUser does before: creates the row on first use. */
function signedIn(sub: string) {
  return upsertUser(db, { sub })
}

const ALICE_CLAIMS = {
  sub: ALICE_SUB,
  name: 'Alice Example',
  preferred_username: 'alice',
  email: 'alice@example.test',
  groups: ['00000000-0000-0000-0000-000000000035', 'calendar_admins@idm.example.org'],
}

describe('resolveMe', () => {
  it('stores the profile and the admin flag from userinfo and returns the stored user', async () => {
    const user = signedIn(ALICE_SUB)
    const me = await resolveMe(
      options(async () => userinfo(ALICE_CLAIMS)),
      user,
      ALICE_TOKEN,
    )

    expect(me).toEqual({
      id: user.id,
      sub: ALICE_SUB,
      username: 'alice',
      name: 'Alice Example',
      email: 'alice@example.test',
      isAdmin: true,
      timeZone: null,
    })
    expect(findUserBySub(db, ALICE_SUB)).toMatchObject({
      username: 'alice',
      name: 'Alice Example',
      email: 'alice@example.test',
      isAdmin: true,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the time zone the user chose (FR-32), also after a profile refresh', async () => {
    setUserTimeZone(db, signedIn(ALICE_SUB).id, 'Australia/Sydney')
    const me = await resolveMe(
      options(async () => userinfo(ALICE_CLAIMS)),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me.timeZone).toBe('Australia/Sydney')
    expect(findUserBySub(db, ALICE_SUB)!.timeZone).toBe('Australia/Sydney')
  })

  it('returns the chosen time zone when userinfo fails', async () => {
    setUserTimeZone(db, signedIn(ALICE_SUB).id, 'Asia/Tokyo')
    const me = await resolveMe(
      options(async () => userinfo({}, 500)),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me.timeZone).toBe('Asia/Tokyo')
  })

  it('does not expose last_seen_at or anything else of the row', async () => {
    const me = await resolveMe(
      options(async () => userinfo(ALICE_CLAIMS)),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(Object.keys(me).sort()).toEqual(
      ['email', 'id', 'isAdmin', 'name', 'sub', 'timeZone', 'username'].sort(),
    )
  })

  it.each([
    ['a short group name', ['calendar_admins'], true],
    ['an SPN', ['calendar_admins@idm.example.org'], true],
    ['a near miss', ['calendar_admins_old', 'calendar_admins_old@idm.example.org'], false],
    ['no groups at all', [], false],
  ])('sets isAdmin from %s', async (_label, groups, expected) => {
    const me = await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me.isAdmin).toBe(expected)
  })

  it('uses the configured admin group', async () => {
    const me = await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: ['staff'] }), {
        adminGroup: 'staff',
      }),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me.isAdmin).toBe(true)
  })

  it('takes admin rights away when the groups no longer include the admin group', async () => {
    const user = upsertUser(db, { sub: ALICE_SUB, isAdmin: true })
    const me = await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: ['idm_all_persons'] })),
      user,
      ALICE_TOKEN,
    )
    expect(me.isAdmin).toBe(false)
    expect(findUserBySub(db, ALICE_SUB)!.isAdmin).toBe(false)
  })

  it('says "not an admin" when userinfo has no groups claim at all, and leaves the stored note alone', async () => {
    const user = upsertUser(db, { sub: ALICE_SUB, isAdmin: true })
    const { groups: _groups, ...withoutGroups } = ALICE_CLAIMS
    const me = await resolveMe(
      options(async () => userinfo(withoutGroups)),
      user,
      ALICE_TOKEN,
    )
    expect(me.isAdmin).toBe(false)
    expect(me.name).toBe('Alice Example')
    // informational copy: neither used nor changed without a claim to judge by
    expect(findUserBySub(db, ALICE_SUB)!.isAdmin).toBe(true)
  })

  it('keeps a stored field that userinfo does not give', async () => {
    upsertUser(db, { sub: ALICE_SUB, name: 'Old Name', email: 'old@example.test' })
    const me = await resolveMe(
      options(async () => userinfo({ sub: ALICE_SUB, preferred_username: 'alice' })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me).toMatchObject({ username: 'alice', name: 'Old Name', email: 'old@example.test' })
  })

  describe.each([
    ['a server error', async () => userinfo({}, 500)],
    ['a rejected token', async () => userinfo({ error: 'invalid_token' }, 401)],
    ['malformed JSON', async () => new Response('{"sub"', { status: 200 })],
    [
      'a network error',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed')
      },
    ],
    ['an answer about another user', async () => userinfo({ ...ALICE_CLAIMS, sub: BOB_SUB })],
    [
      'a timeout',
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ],
  ])('when userinfo fails with %s', (_label, respond) => {
    it('returns the stored profile, no admin rights, logs a warning and changes nothing', async () => {
      upsertUser(db, {
        sub: ALICE_SUB,
        username: 'alice',
        name: 'Stored Name',
        email: 'stored@example.test',
        isAdmin: true,
      })
      const user = signedIn(ALICE_SUB)
      const before = JSON.stringify(findUserBySub(db, ALICE_SUB))

      const me = await resolveMe(options(respond as FetchFn), user, ALICE_TOKEN)

      expect(me).toEqual({
        id: user.id,
        sub: ALICE_SUB,
        username: 'alice',
        name: 'Stored Name',
        email: 'stored@example.test',
        // the stored note says admin, but nothing vouches for it right now
        isAdmin: false,
        timeZone: null,
      })
      expect(JSON.stringify(findUserBySub(db, ALICE_SUB))).toBe(before)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toMatch(/^\[me\] userinfo not used: /)
      expect(warn.mock.calls[0]![0]).not.toContain(ALICE_TOKEN)
    })
  })

  it('does not call out without an issuer or a bearer token', async () => {
    const fake = vi.fn<FetchFn>(async () => userinfo(ALICE_CLAIMS))
    const client = createUserinfoClient({
      fetch: fake as typeof fetch,
      endpointOf: endpointOfIssuer,
    })
    const user = signedIn(ALICE_SUB)
    const noIssuer = options(fake, {
      userinfo: (sub, accessToken) => client.get({ issuer: '', sub, accessToken }),
    })
    expect((await resolveMe(noIssuer, user, ALICE_TOKEN)).name).toBeNull()
    expect((await resolveMe(options(fake), user, null)).name).toBeNull()
    expect(fake).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('asks with the token of each caller and keeps the users apart', async () => {
    const seen: { token: string | null; sub: string }[] = []
    const fake: FetchFn = async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null
      const sub = token === ALICE_TOKEN ? ALICE_SUB : BOB_SUB
      seen.push({ token, sub })
      return userinfo({
        sub,
        name: sub === ALICE_SUB ? 'Alice' : 'Bob',
        preferred_username: sub === ALICE_SUB ? 'alice' : 'bob',
        groups: sub === ALICE_SUB ? ['calendar_admins'] : [],
      })
    }

    const alice = await resolveMe(options(fake), signedIn(ALICE_SUB), ALICE_TOKEN)
    const bob = await resolveMe(options(fake), signedIn(BOB_SUB), BOB_TOKEN)
    const aliceAgain = await resolveMe(options(fake), signedIn(ALICE_SUB), ALICE_TOKEN)

    expect(seen.map((s) => s.token)).toEqual([ALICE_TOKEN, BOB_TOKEN, ALICE_TOKEN])
    expect([alice.name, alice.isAdmin]).toEqual(['Alice', true])
    expect([bob.name, bob.isAdmin]).toEqual(['Bob', false])
    expect(aliceAgain).toEqual(alice)
  })

  it('refuses to give Bob the profile of Alice when the identity provider mixes them up', async () => {
    const bob = signedIn(BOB_SUB)
    const me = await resolveMe(
      options(async () => userinfo(ALICE_CLAIMS)),
      bob,
      BOB_TOKEN,
    )
    expect(me).toMatchObject({ sub: BOB_SUB, name: null, isAdmin: false })
    expect(findUserBySub(db, ALICE_SUB)).toBeNull()
  })
})

describe('resolveMe: the groups of the person', () => {
  const importedGroup = (name: string, externalId = name): number =>
    db
      .prepare(`INSERT INTO groups (name, source, external_id) VALUES (?, 'oidc', ?) RETURNING id`)
      .pluck()
      .get(name, externalId) as number
  const members = (id: number): string[] =>
    db.prepare<[number], string>('SELECT sub FROM group_members WHERE group_id = ?').pluck().all(id)

  it('puts the person into the imported groups of the userinfo claim, and tells who is interested', async () => {
    const staff = importedGroup('staff')
    const onGroupsImported = vi.fn()
    const claims = { ...ALICE_CLAIMS, groups: ['staff', 'calendar_admins@idm.example.org'] }
    const me = await resolveMe(
      options(async () => userinfo(claims), { onGroupsImported }),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me.isAdmin).toBe(true)
    expect(members(staff)).toEqual([ALICE_SUB])
    expect(onGroupsImported).toHaveBeenCalledTimes(1)
    expect(onGroupsImported).toHaveBeenCalledWith(
      expect.objectContaining({ membershipsChanged: true, joined: 1 }),
    )
    // The admin group is a candidate like any other group of the claim.
    expect(
      db.prepare('SELECT external_id FROM oidc_group_candidates ORDER BY 1').pluck().all(),
    ).toEqual(['calendar_admins@idm.example.org', 'staff'])
  })

  it('says nothing when nothing changed', async () => {
    importedGroup('staff')
    const onGroupsImported = vi.fn()
    const claims = { ...ALICE_CLAIMS, groups: ['staff'] }
    const again = () =>
      resolveMe(
        options(async () => userinfo(claims), { onGroupsImported }),
        signedIn(ALICE_SUB),
        ALICE_TOKEN,
      )
    await again()
    await again()
    expect(onGroupsImported).toHaveBeenCalledTimes(1)
  })

  it('leaves the stored groups alone when the claim is missing, and when userinfo fails', async () => {
    const staff = importedGroup('staff')
    await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: ['staff'] })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: undefined })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    await resolveMe(
      options(async () => userinfo({}, 500)),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(members(staff)).toEqual([ALICE_SUB])
    // An empty claim, however, is a claim: the person left the group.
    await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: [] })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(members(staff)).toEqual([])
  })

  it('answers even when the import fails, and logs it', async () => {
    db.exec(
      `CREATE TRIGGER no_candidates BEFORE INSERT ON oidc_group_candidates BEGIN SELECT RAISE(ABORT, 'broken'); END`,
    )
    const me = await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: ['calendar_admins', 'x'] })),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(me).toMatchObject({ name: 'Alice Example', isAdmin: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the groups could not be stored'))
  })

  it('does not import the groups of the ignore list', async () => {
    await resolveMe(
      options(async () => userinfo({ ...ALICE_CLAIMS, groups: ['idm_admins', 'staff'] }), {
        groupsIgnore: ['idm_*'],
      }),
      signedIn(ALICE_SUB),
      ALICE_TOKEN,
    )
    expect(db.prepare('SELECT external_id FROM oidc_group_candidates').pluck().all()).toEqual([
      'staff',
    ])
  })

  describe('where userinfo cannot give groups', () => {
    it('uses the verified token’s claim: no endpoint, and an endpoint of another origin that refuses', async () => {
      const staff = importedGroup('staff')
      const fromToken = { entries: ['staff', 'calendar_admins'], overage: false }
      const noEndpoint = options(async () => userinfo({}), {
        userinfo: async () => ({ ok: false, reason: 'no-endpoint' }),
      })
      const me = await resolveMe(noEndpoint, signedIn(ALICE_SUB), ALICE_TOKEN, fromToken)
      expect(me.isAdmin).toBe(true)
      expect(members(staff)).toEqual([ALICE_SUB])
      expect(warn).not.toHaveBeenCalled()

      await resolveMe(
        options(async () => userinfo({}), {
          userinfo: async () => ({ ok: false, reason: 'status', status: 401, otherOrigin: true }),
        }),
        signedIn(BOB_SUB),
        BOB_TOKEN,
        { entries: ['staff'], overage: false },
      )
      expect(members(staff)).toEqual([ALICE_SUB, BOB_SUB])
    })

    it('does not, when the issuer’s own userinfo refuses the token', async () => {
      const staff = importedGroup('staff')
      const me = await resolveMe(
        options(async () => userinfo({}, 401)),
        signedIn(ALICE_SUB),
        ALICE_TOKEN,
        { entries: ['staff', 'calendar_admins'], overage: false },
      )
      expect(me.isAdmin).toBe(false)
      expect(members(staff)).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'))
    })

    it('does nothing with a token that says its groups were left out', async () => {
      const staff = importedGroup('staff')
      await resolveMe(
        options(async () => userinfo({}), {
          userinfo: async () => ({ ok: false, reason: 'no-endpoint' }),
        }),
        signedIn(ALICE_SUB),
        ALICE_TOKEN,
        { entries: ['staff'], overage: true },
      )
      expect(members(staff)).toEqual([])
    })
  })
})

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['BEARER   abc  ', 'abc'],
    ['Basic YWxpY2U6c2VjcmV0', null],
    ['Bearer', null],
    ['Bearer ', null],
    ['Bearer a b', null],
    ['abc', null],
    ['', null],
  ])('%j -> %j', (header, expected) => {
    expect(bearerToken(new Headers(header ? { authorization: header } : {}))).toBe(expected)
  })

  it('is null without the header', () => {
    expect(bearerToken(new Headers())).toBeNull()
  })
})
