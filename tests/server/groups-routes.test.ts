// @vitest-environment node
// The group routes as HTTP: every route file is imported and called through an h3 router, with an
// in-memory database, a stand-in for token verification (`Bearer test-<name>`, each name a fixed
// UUID sub) and a fake Radicale client. Checks who may call what (anonymous, non-member, member,
// admin), validation answers and the Radicale rollback.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import peopleGet from '../../server/api/people.get'
import { MAX_PEOPLE } from '../../server/utils/groups/rules'
import groupsGet from '../../server/api/groups/index.get'
import groupsPost from '../../server/api/groups/index.post'
import groupGet from '../../server/api/groups/[id]/index.get'
import groupDelete from '../../server/api/groups/[id]/index.delete'
import oidcGet from '../../server/api/groups/oidc/index.get'
import oidcPost from '../../server/api/groups/oidc/index.post'
import oidcDelete from '../../server/api/groups/oidc/[id].delete'
import membersPut from '../../server/api/groups/[id]/members.put'
import managersPut from '../../server/api/groups/[id]/managers.put'
import calendarPost from '../../server/api/groups/[id]/calendars/index.post'
import calendarPatch from '../../server/api/groups/[id]/calendars/[calendarId]/index.patch'
import calendarDelete from '../../server/api/groups/[id]/calendars/[calendarId]/index.delete'
import sharesPut from '../../server/api/groups/[id]/calendars/[calendarId]/shares.put'
import { upsertUser } from '../../server/db/users'
import { setDb } from '../../server/utils/db'
import { setGroupsPorts, type GroupsPorts } from '../../server/utils/groups/ports'
import type { RadicaleClient } from '../../server/utils/sharing/radicale-client'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

// Who is who: the bearer name maps to a fixed sub (a UUID, as group members must be).
const SUBS = {
  alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e', // member of the group under test
  bob: '6f9f0e2d-0000-4000-8000-000000000002', // signed in, not a member
  admin: '11111111-1111-4111-8111-111111111111', // in the admin group
} as const
type Who = keyof typeof SUBS
const ADMIN_GROUP = 'calendar_admins'

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  const subs: Record<string, string> = {
    alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    bob: '6f9f0e2d-0000-4000-8000-000000000002',
    admin: '11111111-1111-4111-8111-111111111111',
  }
  return {
    requireUser: async (event: H3Event) => {
      const match = /^Bearer test-(\w+)$/.exec(event.headers.get('authorization') ?? '')
      const sub = match ? subs[match[1]!] : undefined
      if (!sub) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
      return { sub, via: 'bearer' as const }
    },
  }
})

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
    groupsIgnore: ['idm_*', 'system_*'],
    signinWindowMs: 30 * 24 * 60 * 60 * 1000,
  }),
}))

// The per-actor limit has its own tests (admin-guard.test.ts).
vi.mock('../../server/utils/api/admin-limit', () => ({
  createAdminLimiter: () => ({ take: () => null }),
}))

const ROUTES: [method: string, path: string, handler: EventHandler][] = [
  ['GET', '/api/people', peopleGet],
  ['GET', '/api/groups', groupsGet],
  ['POST', '/api/groups', groupsPost],
  ['GET', '/api/groups/oidc', oidcGet],
  ['POST', '/api/groups/oidc', oidcPost],
  ['DELETE', '/api/groups/oidc/:id', oidcDelete],
  ['GET', '/api/groups/:id', groupGet],
  ['DELETE', '/api/groups/:id', groupDelete],
  ['PUT', '/api/groups/:id/members', membersPut],
  ['PUT', '/api/groups/:id/managers', managersPut],
  ['POST', '/api/groups/:id/calendars', calendarPost],
  ['PATCH', '/api/groups/:id/calendars/:calendarId', calendarPatch],
  ['DELETE', '/api/groups/:id/calendars/:calendarId', calendarDelete],
  ['PUT', '/api/groups/:id/calendars/:calendarId/shares', sharesPut],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let radicale: {
  makeCalendar: ReturnType<typeof vi.fn>
  updateCalendar: ReturnType<typeof vi.fn>
  deleteCollection: ReturnType<typeof vi.fn>
}
let ports: GroupsPorts & {
  onGroupsChanged: ReturnType<typeof vi.fn>
  onSharesChanged: ReturnType<typeof vi.fn>
}
const ok = { ok: true, value: undefined } as const
const down = { ok: false, failure: { kind: 'unreachable', message: 'down' } } as const

function call(method: string, path: string, who: Who | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (who) headers.authorization = `Bearer test-${who}`
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

/**
 * A group with an app origin, its member alice (its manager unless `manager` is false) and one
 * calendar; returns the ids.
 */
function seedGroup(name = 'team_a', { manager = true } = {}) {
  const group = Number(
    db.prepare(`INSERT INTO groups (name, source) VALUES (?, 'app')`).run(name).lastInsertRowid,
  )
  db.prepare('INSERT INTO group_members (group_id, sub, manager) VALUES (?, ?, ?)').run(
    group,
    SUBS.alice,
    manager ? 1 : 0,
  )
  const calendar = Number(
    db
      .prepare(
        `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id, color)
         VALUES ('Team cal', 'shared', NULL, ?, ?, '#112233')`,
      )
      .run(`/_group-${group}/cal-1/`, group).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
     VALUES (?, 'group', ?, 'write')`,
  ).run(calendar, name)
  return { group, calendar }
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  upsertUser(db, {
    sub: SUBS.alice,
    username: 'alice',
    name: 'Alice Ann',
    email: 'alice@example.org',
  })
  upsertUser(db, { sub: SUBS.bob, username: 'bob', name: 'Bob' })
  upsertUser(db, { sub: SUBS.admin, username: 'admin' })
  radicale = {
    makeCalendar: vi.fn(async () => ok),
    updateCalendar: vi.fn(async () => ok),
    deleteCollection: vi.fn(async () => ok),
    // The group's home lists one share of the seeded calendar and one of another calendar.
    listShares: vi.fn(async () => ({
      ok: true,
      value: [
        { pathMapped: '/_group-2/cal-1/', pathOrToken: '/alice/shared-1-team_a/', user: ':team_a' },
        { pathMapped: '/_group-2/other/', pathOrToken: '/bob/shared-2-x/', user: ':team_b' },
      ],
    })),
    deleteShare: vi.fn(async () => ok),
  }
  ports = {
    radicale: () => radicale as unknown as RadicaleClient,
    onGroupsChanged: vi.fn(),
    onSharesChanged: vi.fn(),
  }
  setGroupsPorts(ports)
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
  // The admin check asks the identity provider for the caller's groups.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      const who = new Headers(init?.headers).get('authorization')?.replace(/^Bearer test-/, '')
      const sub = who === 'admin' ? SUBS.admin : who === 'alice' ? SUBS.alice : SUBS.bob
      return new Response(JSON.stringify({ sub, groups: who === 'admin' ? [ADMIN_GROUP] : [] }))
    }),
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const router = createRouter()
  for (const [method, path, handler] of ROUTES) {
    router.add(path, handler, method.toLowerCase() as 'get')
  }
  handle = toWebHandler(createApp().use(router))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setGroupsPorts(undefined)
  db.close()
})

describe('anonymous callers', () => {
  it.each(ROUTES)('%s %s answers 401', async (method, path) => {
    const url = path.replace(':id', '1').replace(':calendarId', '1')
    const res = await call(method, url, null, method === 'GET' ? undefined : {})
    expect(res.status).toBe(401)
  })
})

describe('signed-in reads', () => {
  it('lists people without e-mail addresses, for any signed-in user', async () => {
    const res = await call('GET', '/api/people', 'bob')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { people: Record<string, unknown>[] }
    expect(body.people.map((p) => p.sub)).toEqual(expect.arrayContaining([SUBS.alice, SUBS.bob]))
    expect(JSON.stringify(body)).not.toContain('@')
    expect(Object.keys(body.people[0]!).sort()).toEqual(['name', 'sub', 'username'])
    expect((body as { truncated?: boolean }).truncated).toBe(false)
  })

  it('says when there are more people than it lists', async () => {
    const insert = db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)')
    db.transaction(() => {
      for (let index = 0; index < MAX_PEOPLE; index += 1) {
        insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `p${index}`)
      }
    })()
    const body = (await (await call('GET', '/api/people', 'bob')).json()) as {
      people: unknown[]
      truncated: boolean
    }
    expect(body.people).toHaveLength(MAX_PEOPLE)
    expect(body.truncated).toBe(true)
  })

  it("lists every group for any signed-in user, with the caller's membership", async () => {
    seedGroup()
    const res = await call('GET', '/api/groups', 'bob')
    expect(res.status).toBe(200)
    // The migration's own group of everyone comes with the one made here: it holds the people who
    // signed in within the window, bob (the caller) among them.
    const people = db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number
    expect(await res.json()).toEqual({
      groups: [
        { id: 2, name: 'team_a', source: 'app', memberCount: 1, member: false, manager: false },
        {
          id: 1,
          name: 'web_calendar_users',
          source: 'everyone',
          memberCount: people,
          member: true,
          manager: false,
        },
      ],
    })
    const alice = (await (await call('GET', '/api/groups', 'alice')).json()) as {
      groups: { name: string; member: boolean }[]
    }
    expect(alice.groups.map((g) => [g.name, g.member])).toEqual([
      ['team_a', true],
      ['web_calendar_users', true],
    ])
  })
})

interface DetailBody {
  canManageMembers: boolean
  canManageCalendars: boolean
  canNameManagers: boolean
  members: { sub: string; manager: boolean }[]
}

describe('group detail (member or admin)', () => {
  it('shows a member the group, with nothing to change', async () => {
    const { group } = seedGroup('team_a', { manager: false })
    const body = (await (await call('GET', `/api/groups/${group}`, 'alice')).json()) as DetailBody
    expect(body).toMatchObject({
      canManageMembers: false,
      canManageCalendars: false,
      canNameManagers: false,
    })
    expect(body.members).toEqual([
      { sub: SUBS.alice, name: 'Alice Ann', username: 'alice', manager: false },
    ])
  })

  it('shows a manager the members and calendars to change, but not the managers', async () => {
    const { group } = seedGroup()
    const body = (await (await call('GET', `/api/groups/${group}`, 'alice')).json()) as DetailBody
    expect(body).toMatchObject({
      canManageMembers: true,
      canManageCalendars: true,
      canNameManagers: false,
    })
    expect(body.members.map((m) => m.manager)).toEqual([true])
  })

  it('lets an admin see it, with everything to change', async () => {
    const { group } = seedGroup()
    const body = (await (await call('GET', `/api/groups/${group}`, 'admin')).json()) as DetailBody
    expect(body).toMatchObject({
      canManageMembers: true,
      canManageCalendars: true,
      canNameManagers: true,
    })
  })

  it('lists whether the caller manages each group', async () => {
    seedGroup('team_a')
    seedGroup('team_b', { manager: false })
    const body = (await (await call('GET', '/api/groups', 'alice')).json()) as {
      groups: { name: string; member: boolean; manager: boolean }[]
    }
    expect(
      body.groups
        .filter((g) => g.name.startsWith('team_'))
        .map(({ name, member, manager }) => ({ name, member, manager })),
    ).toEqual([
      { name: 'team_a', member: true, manager: true },
      { name: 'team_b', member: true, manager: false },
    ])
  })

  it('refuses a non-member with 403 and an unknown group with 404', async () => {
    const { group } = seedGroup()
    expect((await call('GET', `/api/groups/${group}`, 'bob')).status).toBe(403)
    expect((await call('GET', '/api/groups/999', 'alice')).status).toBe(404)
  })
})

describe('admin-only group routes', () => {
  it('creates a group for an admin, with the audit entry, and refuses everybody else', async () => {
    expect((await call('POST', '/api/groups', 'alice', { name: 'new_team' })).status).toBe(403)
    expect((await call('POST', '/api/groups', 'bob', { name: 'new_team' })).status).toBe(403)
    const res = await call('POST', '/api/groups', 'admin', { name: 'new_team' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { group: { name: string } }).group.name).toBe('new_team')
    expect(ports.onGroupsChanged).toHaveBeenCalledTimes(1)
    const audit = db.prepare<[], { action: string }>('SELECT action FROM audit_log').all()
    expect(audit.map((row) => row.action)).toEqual(['group.created'])
  })

  it('answers 400 for a bad name and 409 for a reserved one', async () => {
    const bad = await call('POST', '/api/groups', 'admin', { name: 'bad name!' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { data: { fields: unknown[] } }).data.fields).toHaveLength(1)
    const reserved = await call('POST', '/api/groups', 'admin', { name: ADMIN_GROUP })
    expect(reserved.status).toBe(409)
  })

  it('deletes an empty app group for an admin only', async () => {
    const { group, calendar } = seedGroup('gone')
    db.prepare('DELETE FROM calendars WHERE id = ?').run(calendar)
    expect((await call('DELETE', `/api/groups/${group}`, 'alice')).status).toBe(403)
    expect((await call('DELETE', `/api/groups/${group}`, 'admin')).status).toBe(200)
    // Only the group of everyone, which the migration made, is left.
    expect(db.prepare('SELECT source FROM groups').pluck().all()).toEqual(['everyone'])
  })

  it('refuses to delete a group that still owns calendars (409)', async () => {
    const { group } = seedGroup()
    const res = await call('DELETE', `/api/groups/${group}`, 'admin')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { data: { code: string } }).data.code).toBe('has_calendars')
  })

  it('replaces the members for an admin, and validates the list', async () => {
    const { group } = seedGroup('team_a', { manager: false })
    expect(
      (await call('PUT', `/api/groups/${group}/members`, 'alice', { members: [SUBS.bob] })).status,
    ).toBe(403)
    const ok = await call('PUT', `/api/groups/${group}/members`, 'admin', { members: [SUBS.bob] })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { members: { sub: string }[] }).members.map((m) => m.sub)).toEqual(
      [SUBS.bob],
    )
    for (const members of [['a/b'], ['two words'], ['.hidden'], ['a:b'], ['x'.repeat(256)]]) {
      const bad = await call('PUT', `/api/groups/${group}/members`, 'admin', { members })
      expect(bad.status).toBe(400)
    }
    // A well-formed id of somebody who never signed in is refused as well.
    for (const members of [['not-a-uuid'], ['9f9f9f9f-9999-4999-8999-999999999999']]) {
      const unknown = await call('PUT', `/api/groups/${group}/members`, 'admin', { members })
      expect(unknown.status).toBe(400)
    }
  })

  it('keeps member ids exactly as the provider sent them, case included', async () => {
    const { group } = seedGroup()
    const ids = ['Carol-ABC', 'carol-abc', 'auth0|5f7c8ec7']
    ids.forEach((sub, index) => upsertUser(db, { sub, username: `person${index}` }))
    const put = (members: string[]) =>
      call('PUT', `/api/groups/${group}/members`, 'admin', { members })
    const res = await put(ids)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: { sub: string }[] }
    expect(body.members.map((m) => m.sub).sort()).toEqual([...ids].sort())
    // `CAROL-ABC` is a third, unknown id: no case folding finds one of the others.
    expect((await put(['CAROL-ABC'])).status).toBe(400)
  })
})

describe('group managers', () => {
  it('lets a manager add and remove members, but not remove a manager', async () => {
    const { group } = seedGroup()
    const added = await call('PUT', `/api/groups/${group}/members`, 'alice', {
      members: [SUBS.alice, SUBS.bob],
    })
    expect(added.status).toBe(200)
    expect(((await added.json()) as DetailBody).members).toEqual([
      { sub: SUBS.alice, name: 'Alice Ann', username: 'alice', manager: true },
      { sub: SUBS.bob, name: 'Bob', username: 'bob', manager: false },
    ])
    const removed = await call('PUT', `/api/groups/${group}/members`, 'alice', {
      members: [SUBS.alice],
    })
    expect(removed.status).toBe(200)
    // Removing a manager (here herself) takes the role away, which only an admin may do.
    const refused = await call('PUT', `/api/groups/${group}/members`, 'alice', { members: [] })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { data: { code: string } }).data.code).toBe('manager')
    expect(db.prepare('SELECT COUNT(*) FROM group_members').pluck().get()).toBe(1)
    // An admin may.
    expect(
      (await call('PUT', `/api/groups/${group}/members`, 'admin', { members: [] })).status,
    ).toBe(200)
  })

  it('are named by admins only, from the members, with the audit entry', async () => {
    const { group } = seedGroup('team_a', { manager: false })
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group, SUBS.bob)
    const body = { managers: [SUBS.bob] }
    expect((await call('PUT', `/api/groups/${group}/managers`, 'alice', body)).status).toBe(403)
    expect((await call('PUT', `/api/groups/${group}/managers`, 'bob', body)).status).toBe(403)
    const res = await call('PUT', `/api/groups/${group}/managers`, 'admin', body)
    expect(res.status).toBe(200)
    expect(((await res.json()) as DetailBody).members.map((m) => [m.sub, m.manager])).toEqual([
      [SUBS.alice, false],
      [SUBS.bob, true],
    ])
    const audit = db
      .prepare<[], { action: string; details: string }>('SELECT action, details FROM audit_log')
      .all()
    expect(audit.map((row) => row.action)).toEqual(['group.managers_replaced'])
    expect(JSON.parse(audit[0]!.details)).toMatchObject({ added: 1, removed: 0, total: 1 })
    // The same list again changes nothing and writes nothing.
    expect((await call('PUT', `/api/groups/${group}/managers`, 'admin', body)).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(1)
    // Back to none.
    await call('PUT', `/api/groups/${group}/managers`, 'admin', { managers: [] })
    expect(db.prepare('SELECT COUNT(*) FROM group_members WHERE manager = 1').pluck().get()).toBe(0)
  })

  it('refuses a manager who is not a member, a bad list, and the group of everyone', async () => {
    const { group } = seedGroup()
    const notMember = await call('PUT', `/api/groups/${group}/managers`, 'admin', {
      managers: [SUBS.bob],
    })
    expect(notMember.status).toBe(400)
    for (const body of [
      {},
      { managers: 'x' },
      { managers: ['a/b'] },
      { managers: [SUBS.alice, SUBS.alice] },
    ]) {
      expect((await call('PUT', `/api/groups/${group}/managers`, 'admin', body)).status).toBe(400)
    }
    const everyone = db
      .prepare(`SELECT id FROM groups WHERE source = 'everyone'`)
      .pluck()
      .get() as number
    expect(
      (await call('PUT', `/api/groups/${everyone}/managers`, 'admin', { managers: [] })).status,
    ).toBe(403)
    expect((await call('PUT', '/api/groups/999/managers', 'admin', { managers: [] })).status).toBe(
      404,
    )
  })

  it('keeps a plain member away from the calendars of the group', async () => {
    const { group, calendar } = seedGroup('team_a', { manager: false })
    const base = `/api/groups/${group}/calendars`
    expect((await call('POST', base, 'alice', { name: 'Mine' })).status).toBe(403)
    expect((await call('PATCH', `${base}/${calendar}`, 'alice', { name: 'Renamed' })).status).toBe(
      403,
    )
    expect((await call('PUT', `${base}/${calendar}/shares`, 'alice', { shares: [] })).status).toBe(
      403,
    )
    expect((await call('DELETE', `${base}/${calendar}`, 'alice')).status).toBe(403)
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    // An admin may, member or not.
    expect((await call('PATCH', `${base}/${calendar}`, 'admin', { name: 'Renamed' })).status).toBe(
      200,
    )
  })
})

describe('group calendars (manager or admin)', () => {
  it('lets a manager create a calendar in the group principal, with its colour', async () => {
    const { group } = seedGroup()
    const res = await call('POST', `/api/groups/${group}/calendars`, 'alice', {
      name: 'Team plan',
      color: '#AABBCC',
    })
    expect(res.status).toBe(201)
    expect(radicale.makeCalendar).toHaveBeenCalledWith(
      `_group-${group}`,
      expect.stringMatching(new RegExp(`^/_group-${group}/[0-9a-f-]{36}/$`)),
      'Team plan',
      '#aabbcc',
    )
    const rule = db
      .prepare<[], { principal: string; permission: string }>(
        `SELECT principal, permission FROM calendar_acl WHERE principal_type = 'group' AND permission = 'write' ORDER BY id DESC LIMIT 1`,
      )
      .get()
    expect(rule).toEqual({ principal: 'team_a', permission: 'write' })
    expect(ports.onSharesChanged).toHaveBeenCalled()
  })

  it('refuses to create a calendar in the group of all users, for a member and an admin', async () => {
    // The group of everyone is a row of the migration; nobody is stored in it, so nobody manages
    // it: a person who signed in recently counts as in it, and an admin may act in every group.
    const group = db
      .prepare(`SELECT id FROM groups WHERE source = 'everyone'`)
      .pluck()
      .get() as number
    expect(
      (await call('POST', `/api/groups/${group}/calendars`, 'alice', { name: 'Everyone' })).status,
    ).toBe(403)
    const res = await call('POST', `/api/groups/${group}/calendars`, 'admin', { name: 'Everyone' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('cannot own calendars')
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendars').pluck().get()).toBe(0)
  })

  it('refuses a non-member, and a create with no name, before Radicale is called', async () => {
    const { group } = seedGroup()
    expect(
      (await call('POST', `/api/groups/${group}/calendars`, 'bob', { name: 'x' })).status,
    ).toBe(403)
    expect(
      (await call('POST', `/api/groups/${group}/calendars`, 'alice', { name: '  ' })).status,
    ).toBe(400)
    expect(
      (await call('POST', `/api/groups/${group}/calendars`, 'alice', { name: 'a\u0007b' })).status,
    ).toBe(400)
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
  })

  it('creates nothing and answers 502 when Radicale fails', async () => {
    const { group } = seedGroup()
    radicale.makeCalendar.mockResolvedValueOnce(down)
    const res = await call('POST', `/api/groups/${group}/calendars`, 'alice', { name: 'Plan' })
    expect(res.status).toBe(502)
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE name = 'Plan'").pluck().get(),
    ).toBe(0)
  })

  it('removes the new collection again when the rows cannot be written', async () => {
    const { group } = seedGroup()
    db.exec(`CREATE TRIGGER calendars_down BEFORE INSERT ON calendars
             BEGIN SELECT RAISE(ABORT, 'database is down'); END`)
    const res = await call('POST', `/api/groups/${group}/calendars`, 'alice', { name: 'Plan' })
    expect(res.status).toBe(500)
    expect(radicale.deleteCollection).toHaveBeenCalledWith(
      `_group-${group}`,
      expect.stringMatching(/^\/_group-\d+\/[0-9a-f-]{36}\/$/),
    )
  })

  it('renames and recolours a calendar of the group, and 404s a calendar of another group', async () => {
    const { group, calendar } = seedGroup()
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      name: 'Renamed',
      color: '#010203',
    })
    expect(res.status).toBe(200)
    // one request with both, so Radicale takes both or neither
    expect(radicale.updateCalendar).toHaveBeenCalledTimes(1)
    expect(radicale.updateCalendar).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      { displayName: 'Renamed', color: '#010203' },
    )
    const other = seedGroup('other_team')
    expect(
      (
        await call('PATCH', `/api/groups/${other.group}/calendars/${calendar}`, 'admin', {
          name: 'x',
        })
      ).status,
    ).toBe(404)
  })

  it('clears the colour with null on a coloured calendar, and keeps the name', async () => {
    const { group, calendar } = seedGroup()
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      name: 'Team cal',
      color: null,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { calendar: { color: string | null } }).calendar.color).toBeNull()
    // the name is the same, so only the colour is in the request
    expect(radicale.updateCalendar).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      { color: null },
    )
    expect(db.prepare('SELECT color FROM calendars WHERE id = ?').pluck().get(calendar)).toBeNull()
    const audit = db
      .prepare<[], { action: string; details: string }>(
        "SELECT action, details FROM audit_log WHERE action = 'group_calendar.renamed'",
      )
      .all()
    expect(JSON.parse(audit[0]!.details)).toMatchObject({ colorCleared: true })
  })

  it('sends a null colour for an uncoloured calendar nothing to Radicale, with or without a name', async () => {
    const { group, calendar } = seedGroup()
    db.prepare('UPDATE calendars SET color = NULL WHERE id = ?').run(calendar)
    const onlyColour = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      color: null,
    })
    expect(onlyColour.status).toBe(200)
    const renamed = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      name: 'Renamed',
      color: null,
    })
    expect(renamed.status).toBe(200)
    // the first patch changed nothing, the second only the name
    expect(radicale.updateCalendar).toHaveBeenCalledTimes(1)
    expect(radicale.updateCalendar).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      { displayName: 'Renamed' },
    )
    expect(db.prepare('SELECT name FROM calendars WHERE id = ?').pluck().get(calendar)).toBe(
      'Renamed',
    )
  })

  it('a rename alone does not touch the colour of a coloured calendar', async () => {
    const { group, calendar } = seedGroup()
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      name: 'Only name',
    })
    expect(res.status).toBe(200)
    expect(radicale.updateCalendar).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      { displayName: 'Only name' },
    )
    expect(db.prepare('SELECT color FROM calendars WHERE id = ?').pluck().get(calendar)).toBe(
      '#112233',
    )
  })

  it('answers 502 and keeps the colour when Radicale fails to clear it', async () => {
    const { group, calendar } = seedGroup()
    radicale.updateCalendar.mockResolvedValueOnce(down)
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      color: null,
    })
    expect(res.status).toBe(502)
    expect(db.prepare('SELECT color FROM calendars WHERE id = ?').pluck().get(calendar)).toBe(
      '#112233',
    )
  })

  it('keeps the name and the colour when Radicale refuses a change of both', async () => {
    const { group, calendar } = seedGroup()
    radicale.updateCalendar.mockResolvedValueOnce(down)
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      name: 'Renamed',
      color: '#010203',
    })
    expect(res.status).toBe(502)
    expect(db.prepare('SELECT name, color FROM calendars WHERE id = ?').get(calendar)).toEqual({
      name: 'Team cal',
      color: '#112233',
    })
  })

  it('refuses a colour that is not #rrggbb, and a null name', async () => {
    const { group, calendar } = seedGroup()
    const path = `/api/groups/${group}/calendars/${calendar}`
    expect((await call('PATCH', path, 'alice', { color: 'red' })).status).toBe(400)
    expect((await call('PATCH', path, 'alice', { name: null })).status).toBe(400)
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
  })

  it('answers 400 for a patch that changes nothing', async () => {
    const { group, calendar } = seedGroup()
    expect(
      (await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {})).status,
    ).toBe(400)
  })

  it('removes the calendar share, then the collection, then the rows', async () => {
    const { group, calendar } = seedGroup()
    const res = await call('DELETE', `/api/groups/${group}/calendars/${calendar}`, 'alice')
    expect(res.status).toBe(200)
    // Radicale refuses to delete a mapped collection: only this calendar's share goes.
    expect(radicale.deleteShare).toHaveBeenCalledTimes(1)
    expect(radicale.deleteShare).toHaveBeenCalledWith('_group-2', 'map', '/alice/shared-1-team_a/')
    expect(radicale.deleteShare.mock.invocationCallOrder[0]!).toBeLessThan(
      radicale.deleteCollection.mock.invocationCallOrder[0]!,
    )
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE id = ?').pluck().get(calendar),
    ).toBe(0)
  })

  it('keeps the rows when Radicale fails to delete, and a retry then succeeds', async () => {
    const { group, calendar } = seedGroup()
    radicale.deleteCollection.mockResolvedValueOnce(down)
    expect(
      (await call('DELETE', `/api/groups/${group}/calendars/${calendar}`, 'alice')).status,
    ).toBe(502)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE id = ?').pluck().get(calendar),
    ).toBe(1)
    // The shares were taken away first: the writer is asked to put them back.
    expect(ports.onSharesChanged).toHaveBeenCalled()
    expect(
      (await call('DELETE', `/api/groups/${group}/calendars/${calendar}`, 'alice')).status,
    ).toBe(200)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE id = ?').pluck().get(calendar),
    ).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_acl').pluck().get()).toBe(0)
  })

  it('replaces the extra shares and keeps the owning group write rule', async () => {
    const { group, calendar } = seedGroup()
    db.prepare(
      `INSERT INTO groups (name, source, external_id) VALUES ('other_team', 'oidc', 'other-team-id')`,
    ).run()
    const res = await call('PUT', `/api/groups/${group}/calendars/${calendar}/shares`, 'alice', {
      shares: [
        { principalType: 'user', principal: SUBS.bob, permission: 'read' },
        { principalType: 'group', principal: 'other_team', permission: 'write' },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      calendar: { shares: { principal: string; permission: string }[] }
    }
    // The owning group's own rule is not a share: the view lists the extra shares only.
    expect(body.calendar.shares.map((s) => `${s.principal}:${s.permission}`).sort()).toEqual([
      `${SUBS.bob}:read`,
      'other_team:write',
    ])
  })

  it('labels each person shared with by name, else username, else as unknown', async () => {
    const { group, calendar } = seedGroup()
    const res = await call('PUT', `/api/groups/${group}/calendars/${calendar}/shares`, 'alice', {
      shares: [
        { principalType: 'user', principal: SUBS.bob, permission: 'read' },
        { principalType: 'user', principal: SUBS.admin, permission: 'write' },
      ],
    })
    expect(res.status).toBe(200)
    // a rule for somebody whose row is gone (it can be left behind by a deleted user)
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission) VALUES (?, 'user', ?, 'read')`,
    ).run(calendar, '22222222-2222-4222-8222-222222222222')
    const detail = (await (await call('GET', `/api/groups/${group}`, 'alice')).json()) as {
      calendars: { id: number; shares: { principal: string; label: string }[] }[]
    }
    const shares = detail.calendars.find((item) => item.id === calendar)!.shares
    expect(Object.fromEntries(shares.map((share) => [share.principal, share.label]))).toEqual({
      [SUBS.bob]: 'Bob',
      [SUBS.admin]: 'admin',
      '22222222-2222-4222-8222-222222222222': 'Unknown person',
    })
  })

  it('refuses shares that name the owning group, an unknown person or group, or free_busy', async () => {
    const { group, calendar } = seedGroup()
    const path = `/api/groups/${group}/calendars/${calendar}/shares`
    expect(
      (
        await call('PUT', path, 'alice', {
          shares: [{ principalType: 'group', principal: 'team_a', permission: 'read' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('PUT', path, 'alice', {
          shares: [{ principalType: 'group', principal: 'nobody', permission: 'read' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('PUT', path, 'alice', {
          shares: [
            {
              principalType: 'user',
              principal: '9f9f9f9f-9999-4999-8999-999999999999',
              permission: 'read',
            },
          ],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('PUT', path, 'alice', {
          shares: [{ principalType: 'group', principal: 'team_a', permission: 'free_busy' }],
        })
      ).status,
    ).toBe(400)
    expect((await call('PUT', path, 'bob', { shares: [] })).status).toBe(403)
  })
})

describe('groups of the identity provider (admins only)', () => {
  const seenGroup = (key: string, name: string, extra: { conflict?: number } = {}) =>
    db
      .prepare(`INSERT INTO oidc_group_candidates (external_id, name, conflict) VALUES (?, ?, ?)`)
      .run(key, name, extra.conflict ?? 0)
  const importBody = (externalId: unknown) => ({ externalId })
  const groupRow = (key: string) =>
    db.prepare(`SELECT id, name, source FROM groups WHERE external_id = ?`).get(key) as
      { id: number; name: string; source: string } | undefined

  describe('who may call', () => {
    it.each([
      ['GET', '/api/groups/oidc', undefined],
      ['POST', '/api/groups/oidc', importBody('x')],
      ['DELETE', '/api/groups/oidc/1', undefined],
    ])('%s %s answers 403 for a member and for somebody else', async (method, path, body) => {
      seenGroup('x', 'x')
      for (const who of ['alice', 'bob'] as const) {
        expect((await call(method, path, who, body)).status).toBe(403)
      }
      expect(groupRow('x')).toBeUndefined()
      expect(ports.onGroupsChanged).not.toHaveBeenCalled()
    })
  })

  describe('the list', () => {
    it('shows what the claims have shown, by name, with the state of each', async () => {
      seenGroup('b-key', 'beta')
      seenGroup('a-key', 'Alpha')
      seenGroup('imported-key', 'gamma')
      const { group } = seedGroup('mine')
      void group
      seenGroup('taken-key', 'MINE')
      seenGroup('c1', 'twin', { conflict: 1 })
      seenGroup('c2', 'twin', { conflict: 1 })
      const id = Number(
        db
          .prepare(
            `INSERT INTO groups (name, source, external_id) VALUES ('gamma', 'oidc', 'imported-key')`,
          )
          .run().lastInsertRowid,
      )
      db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(id, SUBS.bob)
      const res = await call('GET', '/api/groups/oidc', 'admin')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        candidates: Record<string, unknown>[]
        truncated: boolean
      }
      expect(body.truncated).toBe(false)
      expect(body.candidates.map((c) => [c.name, c.imported, c.blocked, c.memberCount])).toEqual([
        ['Alpha', false, null, 0],
        ['beta', false, null, 0],
        ['gamma', true, null, 1],
        ['MINE', false, 'name_taken', 0],
        ['twin', false, 'conflict', 0],
        ['twin', false, 'conflict', 0],
      ])
      expect(body.candidates.find((c) => c.name === 'gamma')).toMatchObject({
        id: 'imported-key',
        groupId: id,
      })
    })

    it('never offers built-in groups, the admin group or the group of everyone', async () => {
      for (const [key, name] of [
        ['k1', 'idm_admins'],
        ['k2', 'SYSTEM_x'],
        ['k3', ADMIN_GROUP],
        ['k4', 'Calendar_Admins'],
        ['k5', 'web_calendar_users'],
        ['k6', 'fine'],
      ] as const) {
        seenGroup(key, name)
      }
      const body = (await (await call('GET', '/api/groups/oidc', 'admin')).json()) as {
        candidates: { name: string }[]
      }
      expect(body.candidates.map((c) => c.name)).toEqual(['fine'])
    })

    it('says so when there are more than it shows', async () => {
      const insert = db.prepare(
        `INSERT INTO oidc_group_candidates (external_id, name) VALUES (?, ?)`,
      )
      for (let i = 0; i < 1001; i += 1) insert.run(`k${i}`, `g${String(i).padStart(4, '0')}`)
      const body = (await (await call('GET', '/api/groups/oidc', 'admin')).json()) as {
        candidates: unknown[]
        truncated: boolean
      }
      expect(body.candidates).toHaveLength(1000)
      expect(body.truncated).toBe(true)
    })
  })

  describe('importing', () => {
    it('makes an imported group of the candidate, without members, and asks for the file', async () => {
      seenGroup('idp-1', 'ops')
      const res = await call('POST', '/api/groups/oidc', 'admin', importBody('idp-1'))
      expect(res.status).toBe(201)
      const body = (await res.json()) as { group: Record<string, unknown> }
      expect(body.group).toMatchObject({
        name: 'ops',
        source: 'oidc',
        memberCount: 0,
        member: false,
      })
      expect(groupRow('idp-1')).toMatchObject({ name: 'ops', source: 'oidc' })
      expect(db.prepare('SELECT COUNT(*) FROM group_members').pluck().get()).toBe(0)
      expect(ports.onGroupsChanged).toHaveBeenCalledTimes(1)
      const entry = db
        .prepare(`SELECT actor_sub, action, target, details FROM audit_log`)
        .get() as { actor_sub: string; action: string; target: string; details: string }
      expect(entry).toMatchObject({ actor_sub: SUBS.admin, action: 'group.oidc_imported' })
      expect(JSON.parse(entry.details)).toMatchObject({ name: 'ops' })
    })

    it('refuses a second import of the same group, a name that is taken and a shared name', async () => {
      seenGroup('idp-1', 'ops')
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('idp-1'))).status).toBe(
        201,
      )
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('idp-1'))).status).toBe(
        409,
      )

      seedGroup('team')
      seenGroup('idp-2', 'Team')
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('idp-2'))).status).toBe(
        409,
      )

      seenGroup('idp-3', 'twin', { conflict: 1 })
      seenGroup('idp-4', 'twin', { conflict: 1 })
      for (const key of ['idp-3', 'idp-4']) {
        expect((await call('POST', '/api/groups/oidc', 'admin', importBody(key))).status).toBe(409)
      }
      expect(groupRow('idp-2')).toBeUndefined()
      expect(groupRow('idp-3')).toBeUndefined()
      expect(ports.onGroupsChanged).toHaveBeenCalledTimes(1)
    })

    it('answers 404 for a key the claims never showed, and for names that are never offered', async () => {
      for (const [key, name] of [
        ['k1', 'idm_admins'],
        ['k2', ADMIN_GROUP],
        ['k3', 'web_calendar_users'],
      ] as const) {
        seenGroup(key, name)
        expect((await call('POST', '/api/groups/oidc', 'admin', importBody(key))).status).toBe(404)
      }
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('unknown'))).status).toBe(
        404,
      )
      expect(db.prepare(`SELECT COUNT(*) FROM groups WHERE source = 'oidc'`).pluck().get()).toBe(0)
    })

    it('stops at the group limit', async () => {
      const insert = db.prepare(`INSERT INTO groups (name, source) VALUES (?, 'app')`)
      for (let i = 0; i < 200; i += 1) insert.run(`g${i}`)
      seenGroup('idp-1', 'one_more')
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('idp-1'))).status).toBe(
        409,
      )
    })

    it.each([[undefined], [null], [5], [''], ['x'.repeat(256)], [['a']]])(
      'answers 400 for the key %j',
      async (key) => {
        const res = await call('POST', '/api/groups/oidc', 'admin', importBody(key))
        expect(res.status).toBe(400)
      },
    )

    it('matches the key as sent: not trimmed, not case-folded', async () => {
      seenGroup('Key With Blank ', 'blanky')
      expect(
        (await call('POST', '/api/groups/oidc', 'admin', importBody('Key With Blank'))).status,
      ).toBe(404)
      expect(
        (await call('POST', '/api/groups/oidc', 'admin', importBody('key with blank '))).status,
      ).toBe(404)
      expect(
        (await call('POST', '/api/groups/oidc', 'admin', importBody('Key With Blank '))).status,
      ).toBe(201)
    })
  })

  describe('stopping', () => {
    function importedGroup(key: string, name: string) {
      seenGroup(key, name)
      return Number(
        db
          .prepare(`INSERT INTO groups (name, source, external_id) VALUES (?, 'oidc', ?)`)
          .run(name, key).lastInsertRowid,
      )
    }

    it('removes the group, its members and the rules that name it, and keeps the candidate', async () => {
      const id = importedGroup('idp-1', 'ops')
      db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(id, SUBS.alice)
      const calendar = Number(
        db
          .prepare(
            `INSERT INTO calendars (name, kind, collection_path) VALUES ('c', 'shared', '/x/')`,
          )
          .run().lastInsertRowid,
      )
      db.prepare(
        `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
         VALUES (?, 'group', 'ops', 'read')`,
      ).run(calendar)
      const res = await call('DELETE', `/api/groups/oidc/${id}`, 'admin')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ removed: { calendarRules: 1, resourceRules: 0 } })
      expect(groupRow('idp-1')).toBeUndefined()
      expect(db.prepare('SELECT COUNT(*) FROM group_members').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM calendar_acl').pluck().get()).toBe(0)
      expect(
        db
          .prepare(`SELECT COUNT(*) FROM oidc_group_candidates WHERE external_id = 'idp-1'`)
          .pluck()
          .get(),
      ).toBe(1)
      expect(ports.onGroupsChanged).toHaveBeenCalledTimes(1)
      expect(ports.onSharesChanged).toHaveBeenCalledTimes(1)
      expect(db.prepare(`SELECT action FROM audit_log`).pluck().all()).toEqual([
        'group.oidc_import_stopped',
      ])
      // It can be imported again.
      expect((await call('POST', '/api/groups/oidc', 'admin', importBody('idp-1'))).status).toBe(
        201,
      )
    })

    it('refuses while the group owns calendars', async () => {
      const id = importedGroup('idp-1', 'ops')
      db.prepare(
        `INSERT INTO calendars (name, kind, collection_path, group_id)
         VALUES ('c', 'shared', '/_group-${id}/c/', ?)`,
      ).run(id)
      const res = await call('DELETE', `/api/groups/oidc/${id}`, 'admin')
      expect(res.status).toBe(409)
      expect(JSON.stringify(await res.json())).toContain('has_calendars')
      expect(groupRow('idp-1')).toBeDefined()
    })

    it('answers 404 for a group that is not an imported one, or does not exist', async () => {
      const { group } = seedGroup('mine')
      const everyone = db
        .prepare(`SELECT id FROM groups WHERE source = 'everyone'`)
        .pluck()
        .get() as number
      for (const id of [group, everyone, 9999]) {
        expect((await call('DELETE', `/api/groups/oidc/${id}`, 'admin')).status).toBe(404)
      }
      expect(db.prepare(`SELECT COUNT(*) FROM groups`).pluck().get()).toBe(2)
      expect((await call('DELETE', '/api/groups/oidc/abc', 'admin')).status).toBe(404)
    })

    it('is the only way to delete one: the route for app groups refuses it', async () => {
      const id = importedGroup('idp-1', 'ops')
      const res = await call('DELETE', `/api/groups/${id}`, 'admin')
      expect(res.status).toBe(403)
      expect(groupRow('idp-1')).toBeDefined()
    })
  })
})
