// @vitest-environment node
// GET /api/shared-calendars over HTTP: the real route behind an h3 router, an in-memory database and
// a stand-in for token verification (`Bearer test-<name>` is the user `sub-<name>`).
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharedCalendarsGet from '../../server/api/shared-calendars.get'
import { addCalendarAcl } from '../../server/db/calendar-acl'
import { upsertUser } from '../../server/db/users'
import { setDb } from '../../server/utils/db'
import { openTestDb } from './api-fixtures'

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  return {
    requireUser: async (event: H3Event) => {
      const match = /^Bearer test-(\S+)$/.exec(event.headers.get('authorization') ?? '')
      if (!match) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
      return { sub: `sub-${match[1]}`, via: 'bearer' as const }
    },
  }
})

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
  }),
}))

let db: Database
let handle: (request: Request) => Promise<Response>
const ids: Record<string, number> = {}

function calendar(key: string, kind: string, ownerSub: string | null, path: string): void {
  const owner = ownerSub
    ? (db.prepare('SELECT id FROM users WHERE oidc_sub = ?').pluck().get(ownerSub) as number)
    : null
  ids[key] = Number(
    db
      .prepare('INSERT INTO calendars (name, kind, owner_id, collection_path) VALUES (?, ?, ?, ?)')
      .run(key === 'team' ? 'Team' : 'Personal Calendar', kind, owner, path).lastInsertRowid,
  )
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  upsertUser(db, { sub: 'sub-alice', username: 'alice', name: 'Alice Example' })
  upsertUser(db, { sub: 'sub-bob', username: 'bob' })
  upsertUser(db, { sub: 'sub-cara', username: 'cara' })
  calendar('alice', 'personal', 'sub-alice', '/sub-alice/def-calendar/')
  calendar('bob', 'personal', 'sub-bob', '/sub-bob/def-calendar/')
  calendar('cara', 'personal', 'sub-cara', '/sub-cara/def-calendar/')
  calendar('team', 'shared', null, '/shared/team/')
  calendar('secret', 'personal', 'sub-alice', '/sub-alice/secret/')
  const staff = Number(
    db.prepare("INSERT INTO groups (name, source) VALUES ('staff', 'app')").run().lastInsertRowid,
  )
  db.prepare("INSERT INTO group_members (group_id, sub) VALUES (?, 'sub-bob')").run(staff)
  // bob sees alice's as a person, cara's through his group, the team's as somebody signed in
  addCalendarAcl(db, ids.alice!, {
    principalType: 'user',
    principal: 'sub-bob',
    permission: 'read',
  })
  addCalendarAcl(db, ids.cara!, { principalType: 'group', principal: 'staff', permission: 'write' })
  addCalendarAcl(db, ids.team!, {
    principalType: 'authenticated',
    principal: null,
    permission: 'read',
  })
  // his own calendar shared with alice is his own, and alice's other one is cara's alone
  addCalendarAcl(db, ids.bob!, {
    principalType: 'user',
    principal: 'sub-alice',
    permission: 'read',
  })
  addCalendarAcl(db, ids.secret!, {
    principalType: 'user',
    principal: 'sub-cara',
    permission: 'read',
  })
  const router = createRouter()
  router.add('/api/shared-calendars', sharedCalendarsGet, 'get')
  handle = toWebHandler(createApp().use(router))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

const get = (who: string | null) =>
  handle(
    new Request('http://localhost/api/shared-calendars', {
      headers: who ? { authorization: `Bearer test-${who}` } : {},
    }),
  )

describe('the calendars shared with the caller', () => {
  it('names each with its owner when it is a person’s, by every kind of rule, and no other', async () => {
    const res = await get('bob')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { calendars: unknown[] }).calendars).toEqual([
      {
        id: ids.alice,
        name: 'Personal Calendar',
        kind: 'personal',
        owner: 'Alice Example',
        groupId: null,
        canManage: false,
      },
      {
        id: ids.cara,
        name: 'Personal Calendar',
        kind: 'personal',
        owner: 'cara',
        groupId: null,
        canManage: false,
      },
      { id: ids.team, name: 'Team', kind: 'shared', owner: null, groupId: null, canManage: false },
    ])
  })

  it('counts a rule for the group of everyone, and never the caller’s own calendar', async () => {
    addCalendarAcl(db, ids.secret!, {
      principalType: 'group',
      principal: 'web_calendar_users',
      permission: 'free_busy',
    })
    const calendars = ((await (await get('alice')).json()) as { calendars: { id: number }[] })
      .calendars
    expect(calendars.map((item) => item.id)).toEqual([ids.bob, ids.team])
    const bob = ((await (await get('bob')).json()) as { calendars: { id: number }[] }).calendars
    expect(bob.map((item) => item.id)).toContain(ids.secret)
  })

  it('says which group owns a calendar, and whether the caller manages it', async () => {
    const staff = db.prepare("SELECT id FROM groups WHERE name = 'staff'").pluck().get() as number
    const own = Number(
      db
        .prepare(
          `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id)
           VALUES ('Rota', 'shared', NULL, ?, ?)`,
        )
        .run(`/_group-${staff}/rota/`, staff).lastInsertRowid,
    )
    addCalendarAcl(db, own, { principalType: 'group', principal: 'staff', permission: 'write' })
    const rota = async () =>
      ((await (await get('bob')).json()) as { calendars: { id: number }[] }).calendars.find(
        (item) => item.id === own,
      )
    expect(await rota()).toMatchObject({ name: 'Rota', groupId: staff, canManage: false })
    db.prepare("UPDATE group_members SET manager = 1 WHERE sub = 'sub-bob'").run()
    expect(await rota()).toMatchObject({ groupId: staff, canManage: true })
  })

  it('needs a signed-in person', async () => {
    expect((await get(null)).status).toBe(401)
  })
})
