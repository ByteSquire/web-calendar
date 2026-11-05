// @vitest-environment node
// The group routes as HTTP: every route file is imported and called through an h3 router, with an
// in-memory database, a stand-in for token verification (`Bearer test-<name>`, each name a fixed
// UUID sub) and a fake Radicale client. Checks who may call what (anonymous, non-member, member,
// admin), validation answers and the Radicale rollback.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import peopleGet from '../../server/api/people.get'
import groupsGet from '../../server/api/groups/index.get'
import groupsPost from '../../server/api/groups/index.post'
import groupGet from '../../server/api/groups/[id]/index.get'
import groupDelete from '../../server/api/groups/[id]/index.delete'
import membersPut from '../../server/api/groups/[id]/members.put'
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
  ['GET', '/api/groups/:id', groupGet],
  ['DELETE', '/api/groups/:id', groupDelete],
  ['PUT', '/api/groups/:id/members', membersPut],
  ['POST', '/api/groups/:id/calendars', calendarPost],
  ['PATCH', '/api/groups/:id/calendars/:calendarId', calendarPatch],
  ['DELETE', '/api/groups/:id/calendars/:calendarId', calendarDelete],
  ['PUT', '/api/groups/:id/calendars/:calendarId/shares', sharesPut],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let radicale: {
  makeCalendar: ReturnType<typeof vi.fn>
  setDisplayName: ReturnType<typeof vi.fn>
  setColor: ReturnType<typeof vi.fn>
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

/** A group with an app origin, its member alice and one calendar; returns the ids. */
function seedGroup(name = 'team_a') {
  const group = Number(
    db.prepare(`INSERT INTO groups (name, source) VALUES (?, 'app')`).run(name).lastInsertRowid,
  )
  db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group, SUBS.alice)
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
    setDisplayName: vi.fn(async () => ok),
    setColor: vi.fn(async () => ok),
    clearColor: vi.fn(async () => ok),
    deleteCollection: vi.fn(async () => ok),
    // The group's home lists one share of the seeded calendar and one of another calendar.
    listShares: vi.fn(async () => ({
      ok: true,
      value: [
        { pathMapped: '/_group-1/cal-1/', pathOrToken: '/alice/shared-1-team_a/', user: ':team_a' },
        { pathMapped: '/_group-1/other/', pathOrToken: '/bob/shared-2-x/', user: ':team_b' },
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
  })

  it("lists every group for any signed-in user, with the caller's membership", async () => {
    seedGroup()
    const res = await call('GET', '/api/groups', 'bob')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [{ id: 1, name: 'team_a', source: 'app', memberCount: 1, member: false }],
    })
    const alice = (await (await call('GET', '/api/groups', 'alice')).json()) as {
      groups: { member: boolean }[]
    }
    expect(alice.groups[0]!.member).toBe(true)
  })
})

describe('group detail (member or admin)', () => {
  it('shows a member the group, without the admin-only flag', async () => {
    const { group } = seedGroup()
    const body = (await (await call('GET', `/api/groups/${group}`, 'alice')).json()) as {
      canManageMembers: boolean
      members: { sub: string }[]
    }
    expect(body.canManageMembers).toBe(false)
    expect(body.members.map((m) => m.sub)).toEqual([SUBS.alice])
  })

  it('lets an admin see it, with members editable', async () => {
    const { group } = seedGroup()
    const body = (await (await call('GET', `/api/groups/${group}`, 'admin')).json()) as {
      canManageMembers: boolean
    }
    expect(body.canManageMembers).toBe(true)
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM groups').pluck().get()).toBe(0)
  })

  it('refuses to delete a group that still owns calendars (409)', async () => {
    const { group } = seedGroup()
    const res = await call('DELETE', `/api/groups/${group}`, 'admin')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { data: { code: string } }).data.code).toBe('has_calendars')
  })

  it('replaces the members for an admin, and validates the list', async () => {
    const { group } = seedGroup()
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

describe('group calendars (member or admin)', () => {
  it('lets a member create a calendar in the group principal, with its colour', async () => {
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
    const group = Number(
      db.prepare(`INSERT INTO groups (name, source) VALUES ('web_calendar_users', 'kanidm')`).run()
        .lastInsertRowid,
    )
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(group, SUBS.alice)
    for (const who of ['alice', 'admin'] as const) {
      const res = await call('POST', `/api/groups/${group}/calendars`, who, { name: 'Everyone' })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('cannot own calendars')
    }
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
    expect(radicale.setDisplayName).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      'Renamed',
    )
    expect(radicale.setColor).toHaveBeenCalledWith(
      `_group-${group}`,
      `/_group-${group}/cal-1/`,
      '#010203',
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
    expect(radicale.clearColor).toHaveBeenCalledWith(`_group-${group}`, `/_group-${group}/cal-1/`)
    expect(radicale.setDisplayName).not.toHaveBeenCalled()
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
    expect(radicale.clearColor).not.toHaveBeenCalled()
    expect(radicale.setColor).not.toHaveBeenCalled()
    expect(radicale.setDisplayName).toHaveBeenCalledTimes(1)
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
    expect(radicale.setDisplayName).toHaveBeenCalledTimes(1)
    expect(radicale.setColor).not.toHaveBeenCalled()
    expect(radicale.clearColor).not.toHaveBeenCalled()
    expect(db.prepare('SELECT color FROM calendars WHERE id = ?').pluck().get(calendar)).toBe(
      '#112233',
    )
  })

  it('answers 502 and keeps the colour when Radicale fails to clear it', async () => {
    const { group, calendar } = seedGroup()
    radicale.clearColor.mockResolvedValueOnce(down)
    const res = await call('PATCH', `/api/groups/${group}/calendars/${calendar}`, 'alice', {
      color: null,
    })
    expect(res.status).toBe(502)
    expect(db.prepare('SELECT color FROM calendars WHERE id = ?').pluck().get(calendar)).toBe(
      '#112233',
    )
  })

  it('refuses a colour that is not #rrggbb, and a null name', async () => {
    const { group, calendar } = seedGroup()
    const path = `/api/groups/${group}/calendars/${calendar}`
    expect((await call('PATCH', path, 'alice', { color: 'red' })).status).toBe(400)
    expect((await call('PATCH', path, 'alice', { name: null })).status).toBe(400)
    expect(radicale.clearColor).not.toHaveBeenCalled()
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
    expect(radicale.deleteShare).toHaveBeenCalledWith('_group-1', 'map', '/alice/shared-1-team_a/')
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
    db.prepare(`INSERT INTO groups (name, source) VALUES ('other_team', 'kanidm')`).run()
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
