// @vitest-environment node
// What a due CalDAV sighting does on the server: creates the person, renews their window, and imports
// their groups with their own token. An app token does none of it.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findUserBySub } from '../../server/db/users'
import { createUserinfoClient } from '../../server/utils/api/userinfo-client'
import { setGroupsPorts } from '../../server/utils/groups/ports'
import { noteBearerSighting } from '../../server/utils/groups/sighting-service'
import { openTestDb } from './api-fixtures'

let db: Database
let seenTokens: string[]
const ports = {
  radicale: vi.fn(),
  onGroupsChanged: vi.fn(),
  onSharesChanged: vi.fn(),
}

vi.mock('../../server/utils/db', () => ({ getDb: () => db }))
vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    oidcIssuer: 'https://idm.example.org/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
    groupsClaim: 'groups',
    groupsIgnore: [],
  }),
}))
vi.mock('../../server/utils/api/userinfo-service', () => ({
  getUserinfoClient: () =>
    createUserinfoClient({
      endpointOf: () => 'https://idm.example.org/oauth2/openid/web-calendar/userinfo',
      fetch: (async (_url: string, init?: RequestInit) => {
        const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
        seenTokens.push(token)
        return new Response(
          JSON.stringify({
            sub: token.split('.')[0],
            name: 'Dav Person',
            preferred_username: 'dav',
            groups: ['staff'],
          }),
        )
      }) as typeof fetch,
    }),
}))

beforeEach(() => {
  db = openTestDb()
  seenTokens = []
  vi.clearAllMocks()
  setGroupsPorts(ports)
  db.prepare(
    `INSERT INTO groups (name, source, external_id) VALUES ('staff', 'oidc', 'staff')`,
  ).run()
})
afterEach(() => {
  setGroupsPorts(undefined)
  db.close()
})

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` })
/** Lets the background work of a sighting finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('noteBearerSighting', () => {
  it('creates a person who never opened the web app, renews them, and imports their groups', async () => {
    const sub = 'dav-first.sig.nature'.split('.')[0]!
    expect(findUserBySub(db, sub)).toBeNull()
    noteBearerSighting({ sub, via: 'bearer' }, bearer(`${sub}.payload.signature`))
    await settle()
    expect(findUserBySub(db, sub)).toMatchObject({ username: 'dav', name: 'Dav Person' })
    expect(db.prepare('SELECT sub FROM group_members').pluck().all()).toEqual([sub])
    expect(ports.onGroupsChanged).toHaveBeenCalledTimes(1)
    // The call used the person's own token, once.
    expect(seenTokens).toEqual([`${sub}.payload.signature`])
  })

  it('does nothing for an app token, so a token cannot keep its owner active', async () => {
    noteBearerSighting({ sub: 'dav-token', via: 'app-token' }, bearer('dav-token.x.y'))
    await settle()
    expect(findUserBySub(db, 'dav-token')).toBeNull()
    expect(seenTokens).toEqual([])
  })

  it('asks only every five minutes per person, however often the client calls', async () => {
    const sub = 'dav-busy'
    for (let i = 0; i < 5; i += 1) {
      noteBearerSighting({ sub, via: 'bearer' }, bearer(`${sub}.p.s`))
    }
    await settle()
    expect(seenTokens).toHaveLength(1)
  })

  it('does nothing without a usable bearer header, and never throws into the request', () => {
    expect(() =>
      noteBearerSighting({ sub: 'dav-none', via: 'bearer' }, new Headers()),
    ).not.toThrow()
    db.close()
    expect(() =>
      noteBearerSighting({ sub: 'dav-closed', via: 'bearer' }, bearer('dav-closed.p.s')),
    ).not.toThrow()
    db = openTestDb()
  })
})
