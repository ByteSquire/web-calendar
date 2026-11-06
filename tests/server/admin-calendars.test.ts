// @vitest-environment node
// The admin calendar routes as HTTP (create an organization calendar, rename, delete, list) and a
// person deleting their own calendar: every route file is called through an h3 router, with an
// in-memory database, a stand-in for token verification and a fake Radicale client.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import calendarsGet from '../../server/api/admin/access/calendars.get'
import calendarsPost from '../../server/api/admin/access/calendars.post'
import calendarPatch from '../../server/api/admin/access/calendars/[id].patch'
import calendarDelete from '../../server/api/admin/access/calendars/[id].delete'
import meCalendarDelete from '../../server/api/me/calendars.delete'
import { upsertUser } from '../../server/db/users'
import { MAX_ORGANIZATION_CALENDARS } from '../../server/utils/calendars/organization'
import { setDb } from '../../server/utils/db'
import { setGroupsPorts, type GroupsPorts } from '../../server/utils/groups/ports'
import type { RadicaleClient } from '../../server/utils/sharing/radicale-client'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

// Who is who: the bearer name maps to a fixed sub (a UUID).
const SUBS = {
  alice: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e', // signed in, owns a calendar
  bob: '6f9f0e2d-0000-4000-8000-000000000002', // signed in, nothing special
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
  ['GET', '/api/admin/access/calendars', calendarsGet],
  ['POST', '/api/admin/access/calendars', calendarsPost],
  ['PATCH', '/api/admin/access/calendars/:id', calendarPatch],
  ['DELETE', '/api/admin/access/calendars/:id', calendarDelete],
  ['DELETE', '/api/me/calendars', meCalendarDelete],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let radicale: Record<
  'makeCalendar' | 'updateCalendar' | 'deleteCollection' | 'listShares' | 'deleteShare',
  ReturnType<typeof vi.fn>
>
let ports: GroupsPorts & { onSharesChanged: ReturnType<typeof vi.fn> }
const ok = { ok: true, value: undefined } as const
const down = { ok: false, failure: { kind: 'unreachable', message: 'down' } } as const
let userIds: Record<Who, number>

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

function audit() {
  return db
    .prepare<[], { action: string; target: string | null; details: string | null }>(
      'SELECT action, target, details FROM audit_log ORDER BY id',
    )
    .all()
    .map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : null }))
}

function count(table: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number
}

/** A calendar row; `owner` makes it a person's own, `group` a group's. */
function seedCalendar(
  path: string,
  {
    name = 'Cal',
    kind = 'shared',
    owner = null,
    group = null,
    color = null,
  }: {
    name?: string
    kind?: string
    owner?: Who | null
    group?: number | null
    color?: string | null
  } = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id, color)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, kind, owner ? userIds[owner] : null, path, group, color).lastInsertRowid,
  )
}

let linkCounter = 0
function seedLink(userId: number, collectionPath: string, calendarId: number | null = null) {
  linkCounter += 1
  db.prepare(
    `INSERT INTO calendar_links
       (user_id, collection_path, calendar_name, label, slug_hash, password_hash, calendar_id)
     VALUES (?, ?, 'Cal', 'A link', ?, 'scrypt$x', ?)`,
  ).run(userId, collectionPath, String(linkCounter).padStart(64, '0'), calendarId)
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  userIds = {
    alice: upsertUser(db, {
      sub: SUBS.alice,
      username: 'alice',
      name: 'Alice Ann',
      email: 'alice@example.org',
    }).id,
    bob: upsertUser(db, { sub: SUBS.bob, username: 'bob', name: 'Bob' }).id,
    admin: upsertUser(db, { sub: SUBS.admin, username: 'admin' }).id,
  }
  radicale = {
    makeCalendar: vi.fn(async () => ok),
    updateCalendar: vi.fn(async () => ok),
    deleteCollection: vi.fn(async () => ok),
    listShares: vi.fn(async () => ({ ok: true, value: [] })),
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

describe('who may call the admin calendar routes', () => {
  const adminRoutes = ROUTES.filter(([, path]) => path.startsWith('/api/admin/'))

  it.each(adminRoutes)('%s %s answers 401 to an anonymous caller', async (method, path) => {
    const res = await call(
      method,
      path.replace(':id', '1'),
      null,
      method === 'GET' ? undefined : {},
    )
    expect(res.status).toBe(401)
  })

  it.each(adminRoutes)('%s %s answers 403 to a signed-in non-admin', async (method, path) => {
    const id = seedCalendar('/_organization/one/')
    const res = await call(
      method,
      path.replace(':id', String(id)),
      'alice',
      method === 'GET' ? undefined : { name: 'x' },
    )
    expect(res.status).toBe(403)
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
  })
})

describe('POST /api/admin/access/calendars', () => {
  it('makes a calendar of the organization in its own home and answers its view', async () => {
    const res = await call('POST', '/api/admin/access/calendars', 'admin', {
      name: 'Holidays',
      color: '#aa5500',
    })
    expect(res.status).toBe(201)
    const { calendar } = (await res.json()) as { calendar: Record<string, unknown> }
    const row = db
      .prepare<[], Record<string, unknown>>(`SELECT * FROM calendars WHERE kind = 'shared'`)
      .get()!
    expect(row).toMatchObject({
      name: 'Holidays',
      color: '#aa5500',
      owner_id: null,
      group_id: null,
    })
    expect(row.collection_path).toMatch(
      /^\/_organization\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/,
    )
    expect(calendar).toEqual({
      id: row.id,
      name: 'Holidays',
      kind: 'shared',
      color: '#aa5500',
      owner: null,
      group: null,
      isDefault: false,
      collectionPath: row.collection_path,
      rules: [],
    })
    expect(radicale.makeCalendar).toHaveBeenCalledExactlyOnceWith(
      '_organization',
      row.collection_path,
      'Holidays',
      '#aa5500',
    )
    expect(audit()).toEqual([
      {
        action: 'calendar.created',
        target: `calendar:${row.id}`,
        details: { name: 'Holidays', kind: 'organization' },
      },
    ])
  })

  it('makes a calendar without a colour', async () => {
    const res = await call('POST', '/api/admin/access/calendars', 'admin', { name: 'Plain' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { calendar: { color: unknown } }).calendar.color).toBeNull()
  })

  it.each([
    ['a missing name', {}],
    ['an empty name', { name: '  ' }],
    ['a bad colour', { name: 'Holidays', color: 'red' }],
    ['a short colour', { name: 'Holidays', color: '#fff' }],
  ])('answers 400 for %s before Radicale is called', async (_label, body) => {
    const res = await call('POST', '/api/admin/access/calendars', 'admin', body)
    expect(res.status).toBe(400)
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(0)
    expect(audit()).toEqual([])
  })

  it('answers 502 and keeps no row when Radicale cannot make the collection', async () => {
    radicale.makeCalendar.mockResolvedValueOnce(down)
    const res = await call('POST', '/api/admin/access/calendars', 'admin', { name: 'Holidays' })
    expect(res.status).toBe(502)
    expect(count('calendars')).toBe(0)
    expect(audit()).toEqual([])
  })

  it('answers 409 limit_reached at the limit without calling Radicale', async () => {
    const insert = db.prepare(
      `INSERT INTO calendars (name, kind, owner_id, collection_path, group_id)
       VALUES ('Cal', 'shared', NULL, ?, NULL)`,
    )
    db.transaction(() => {
      for (let index = 0; index < MAX_ORGANIZATION_CALENDARS; index += 1) {
        insert.run(`/_organization/seed-${index}/`)
      }
    })()
    const res = await call('POST', '/api/admin/access/calendars', 'admin', { name: 'One more' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ data: { code: 'limit_reached' } })
    expect(radicale.makeCalendar).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(MAX_ORGANIZATION_CALENDARS)
  })

  it('deletes the new collection again when the row cannot be saved', async () => {
    // The first limit check passes; the row insert is refused, as if the last slot was taken
    // meanwhile.
    db.exec(
      `CREATE TRIGGER refuse_calendar BEFORE INSERT ON calendars
       BEGIN SELECT RAISE(ABORT, 'no room'); END`,
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('POST', '/api/admin/access/calendars', 'admin', { name: 'Holidays' })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(count('calendars')).toBe(0)
    expect(radicale.makeCalendar).toHaveBeenCalledTimes(1)
    const [principal, path] = radicale.makeCalendar.mock.calls[0]!
    expect(radicale.deleteCollection).toHaveBeenCalledExactlyOnceWith(principal, path)
    expect(audit()).toEqual([])
  })
})

describe('PATCH /api/admin/access/calendars/:id', () => {
  const personal = () =>
    seedCalendar(`/${SUBS.alice}/Team plan/`, {
      name: 'Team plan',
      kind: 'personal',
      owner: 'alice',
      color: '#112233',
    })

  it("renames a person's calendar as that person, at the encoded path", async () => {
    const id = personal()
    const res = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', {
      name: 'Team plan 2',
    })
    expect(res.status).toBe(200)
    expect(radicale.updateCalendar).toHaveBeenCalledExactlyOnceWith(
      SUBS.alice,
      `/${SUBS.alice}/Team%20plan/`,
      { displayName: 'Team plan 2' },
    )
    const body = (await res.json()) as { calendar: Record<string, unknown> }
    expect(body.calendar).toMatchObject({
      id,
      name: 'Team plan 2',
      color: '#112233',
      owner: 'Alice Ann',
    })
    // The path in the row stays as discovery wrote it (decoded).
    expect(db.prepare('SELECT collection_path FROM calendars WHERE id = ?').pluck().get(id)).toBe(
      `/${SUBS.alice}/Team plan/`,
    )
    expect(audit()).toEqual([
      {
        action: 'calendar.changed',
        target: `calendar:${id}`,
        details: { name: 'Team plan 2', colorCleared: false },
      },
    ])
  })

  it('sets a colour, and clears it with null', async () => {
    const id = personal()
    const set = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', {
      color: '#ff0000',
    })
    expect(set.status).toBe(200)
    expect(radicale.updateCalendar).toHaveBeenLastCalledWith(
      SUBS.alice,
      `/${SUBS.alice}/Team%20plan/`,
      { color: '#ff0000' },
    )
    const cleared = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', {
      color: null,
    })
    expect(cleared.status).toBe(200)
    expect(radicale.updateCalendar).toHaveBeenLastCalledWith(
      SUBS.alice,
      `/${SUBS.alice}/Team%20plan/`,
      { color: null },
    )
    expect(((await cleared.json()) as { calendar: { color: unknown } }).calendar.color).toBeNull()
    expect(audit().at(-1)?.details).toMatchObject({ colorCleared: true })
  })

  it('calls nothing when the patch changes nothing', async () => {
    const id = personal()
    const res = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', {
      name: 'Team plan',
      color: '#112233',
    })
    expect(res.status).toBe(200)
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
    expect(audit()).toEqual([])
  })

  it('answers 400 for an empty patch or a bad value, without calling Radicale', async () => {
    const id = personal()
    for (const body of [{}, { name: '' }, { color: 'blue' }]) {
      const res = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', body)
      expect(res.status).toBe(400)
    }
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown calendar and for an id that is no number', async () => {
    expect(
      (await call('PATCH', '/api/admin/access/calendars/999', 'admin', { name: 'x' })).status,
    ).toBe(404)
    expect(
      (await call('PATCH', '/api/admin/access/calendars/abc', 'admin', { name: 'x' })).status,
    ).toBe(404)
    expect(radicale.updateCalendar).not.toHaveBeenCalled()
  })

  it('answers 502 and keeps the row as it was when Radicale fails', async () => {
    const id = personal()
    radicale.updateCalendar.mockResolvedValueOnce(down)
    const res = await call('PATCH', `/api/admin/access/calendars/${id}`, 'admin', {
      name: 'Other',
      color: null,
    })
    expect(res.status).toBe(502)
    expect(db.prepare('SELECT name, color FROM calendars WHERE id = ?').get(id)).toEqual({
      name: 'Team plan',
      color: '#112233',
    })
    expect(audit()).toEqual([])
  })
})

describe('DELETE /api/admin/access/calendars/:id', () => {
  const PATH = '/_organization/cal-1/'

  /** A shared calendar with a rule, a link tied to it and a link to its path. */
  function seedFull() {
    const id = seedCalendar(PATH, { name: 'Holidays' })
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
       VALUES (?, 'authenticated', NULL, 'read')`,
    ).run(id)
    seedLink(userIds.admin, PATH, id)
    seedLink(userIds.alice, PATH)
    return id
  }

  it('removes shares, collection, row, rules and links, in that order, and audits it', async () => {
    const id = seedFull()
    seedCalendar('/_organization/cal-2/', { name: 'Other' })
    seedLink(userIds.alice, `/${SUBS.alice}/Mine/`)
    radicale.listShares.mockResolvedValue({
      ok: true,
      value: [
        { pathMapped: PATH, pathOrToken: `/${SUBS.alice}/shared-${id}/`, user: SUBS.alice },
        { pathMapped: '/_organization/cal-2/', pathOrToken: '/x/shared-2/', user: 'x' },
      ],
    })
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(200)
    expect(radicale.listShares).toHaveBeenCalledWith('_organization', 'map')
    expect(radicale.deleteShare).toHaveBeenCalledExactlyOnceWith(
      '_organization',
      'map',
      `/${SUBS.alice}/shared-${id}/`,
    )
    expect(radicale.deleteCollection).toHaveBeenCalledExactlyOnceWith(
      '_organization',
      '/_organization/cal-1/',
    )
    expect(radicale.deleteShare.mock.invocationCallOrder[0]).toBeLessThan(
      radicale.deleteCollection.mock.invocationCallOrder[0]!,
    )
    expect(db.prepare('SELECT id FROM calendars WHERE id = ?').get(id)).toBeUndefined()
    expect(count('calendars')).toBe(1)
    expect(count('calendar_acl')).toBe(0)
    // Only the unrelated link of alice stays.
    expect(db.prepare('SELECT collection_path FROM calendar_links').pluck().all()).toEqual([
      `/${SUBS.alice}/Mine/`,
    ])
    expect(audit()).toEqual([
      {
        action: 'calendar.deleted',
        target: `calendar:${id}`,
        details: { name: 'Holidays', kind: 'shared', groupId: null, links: 2 },
      },
    ])
    expect(ports.onSharesChanged).toHaveBeenCalled()
  })

  it("deletes a person's calendar at the encoded path as that person", async () => {
    const id = seedCalendar(`/${SUBS.alice}/Team plan/`, { kind: 'personal', owner: 'alice' })
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(200)
    expect(radicale.deleteCollection).toHaveBeenCalledExactlyOnceWith(
      SUBS.alice,
      `/${SUBS.alice}/Team%20plan/`,
    )
  })

  it("answers 409 resource for a resource's calendar and changes nothing", async () => {
    const id = seedCalendar('/_resources/room-1/', { kind: 'resource' })
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ data: { code: 'resource' } })
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
  })

  it("answers 409 default_calendar for a person's default calendar and changes nothing", async () => {
    const id = seedCalendar(`/${SUBS.alice}/def-calendar/`, { kind: 'personal', owner: 'alice' })
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ data: { code: 'default_calendar' } })
    expect(radicale.listShares).not.toHaveBeenCalled()
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
    expect(audit()).toEqual([])
  })

  it('answers 404 for an unknown calendar', async () => {
    const res = await call('DELETE', '/api/admin/access/calendars/999', 'admin')
    expect(res.status).toBe(404)
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
  })

  it('answers 502 and keeps every row when the collection cannot be deleted', async () => {
    const id = seedFull()
    radicale.deleteCollection.mockResolvedValueOnce(down)
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(502)
    expect(count('calendars')).toBe(1)
    expect(count('calendar_acl')).toBe(1)
    expect(count('calendar_links')).toBe(2)
    expect(audit()).toEqual([])
    // The removed shares come back with the next reconcile.
    expect(ports.onSharesChanged).toHaveBeenCalled()
  })

  it('answers 502 and deletes nothing when the shares cannot be listed', async () => {
    const id = seedFull()
    radicale.listShares.mockResolvedValueOnce(down)
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(502)
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
    expect(count('calendar_links')).toBe(2)
  })

  it('answers 502 and deletes nothing when a share cannot be removed', async () => {
    const id = seedFull()
    radicale.listShares.mockResolvedValue({
      ok: true,
      value: [{ pathMapped: PATH, pathOrToken: '/a/shared-1/', user: 'a' }],
    })
    radicale.deleteShare.mockResolvedValueOnce(down)
    const res = await call('DELETE', `/api/admin/access/calendars/${id}`, 'admin')
    expect(res.status).toBe(502)
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
  })
})

describe('GET /api/admin/access/calendars', () => {
  it('names the group of a group calendar and gives null for any other', async () => {
    const group = Number(
      db.prepare(`INSERT INTO groups (name, source) VALUES ('team_a', 'app')`).run()
        .lastInsertRowid,
    )
    const own = seedCalendar(`/_group-${group}/c1/`, { name: 'Team cal', group })
    const org = seedCalendar('/_organization/c2/', { name: 'Org cal' })
    const mine = seedCalendar(`/${SUBS.alice}/Mine/`, {
      name: 'Mine',
      kind: 'personal',
      owner: 'alice',
    })
    const res = await call('GET', '/api/admin/access/calendars', 'admin')
    expect(res.status).toBe(200)
    const { calendars } = (await res.json()) as {
      calendars: { id: number; group: unknown; owner: unknown }[]
    }
    const byId = new Map(calendars.map((c) => [c.id, c]))
    expect(byId.get(own)?.group).toEqual({ id: group, name: 'team_a' })
    expect(byId.get(org)?.group).toBeNull()
    expect(byId.get(mine)?.group).toBeNull()
    expect(byId.get(mine)?.owner).toBe('Alice Ann')
  })

  it("marks a person's default calendar, and no other", async () => {
    const own = seedCalendar(`/${SUBS.alice}/def-calendar/`, { kind: 'personal', owner: 'alice' })
    const other = seedCalendar(`/${SUBS.alice}/Mine/`, { kind: 'personal', owner: 'alice' })
    // a calendar of a service principal of that name is nobody's default
    const shared = seedCalendar('/_team/def-calendar/')
    const res = await call('GET', '/api/admin/access/calendars', 'admin')
    const { calendars } = (await res.json()) as { calendars: { id: number; isDefault: boolean }[] }
    const byId = new Map(calendars.map((c) => [c.id, c.isDefault]))
    expect([byId.get(own), byId.get(other), byId.get(shared)]).toEqual([true, false, false])
  })
})

describe('DELETE /api/me/calendars', () => {
  const del = (who: Who | null, href: string | undefined) =>
    call(
      'DELETE',
      `/api/me/calendars${href === undefined ? '' : `?href=${encodeURIComponent(href)}`}`,
      who,
    )

  it('answers 401 to an anonymous caller', async () => {
    expect((await del(null, `/caldav/${SUBS.alice}/Mine/`)).status).toBe(401)
  })

  it('deletes an own calendar that has no row yet, and the links to its path', async () => {
    seedLink(userIds.alice, `/${SUBS.alice}/Team plan/`)
    seedLink(userIds.alice, `/${SUBS.alice}/Other/`)
    const res = await del('alice', `/caldav/${SUBS.alice}/Team%20plan/`)
    expect(res.status).toBe(200)
    expect(radicale.deleteCollection).toHaveBeenCalledExactlyOnceWith(
      SUBS.alice,
      `/${SUBS.alice}/Team%20plan/`,
    )
    expect(db.prepare('SELECT collection_path FROM calendar_links').pluck().all()).toEqual([
      `/${SUBS.alice}/Other/`,
    ])
    expect(audit()).toEqual([
      {
        action: 'calendar.deleted',
        target: 'calendar',
        details: { name: null, kind: 'personal', byOwner: true, links: 1 },
      },
    ])
  })

  it('deletes the row and its rules when there is one', async () => {
    const id = seedCalendar(`/${SUBS.alice}/Mine/`, {
      name: 'Mine',
      kind: 'personal',
      owner: 'alice',
    })
    db.prepare(
      `INSERT INTO calendar_acl (calendar_id, principal_type, principal, permission)
       VALUES (?, 'user', ?, 'read')`,
    ).run(id, SUBS.bob)
    const res = await del('alice', `/caldav/${SUBS.alice}/Mine/`)
    expect(res.status).toBe(200)
    expect(count('calendars')).toBe(0)
    expect(count('calendar_acl')).toBe(0)
    expect(audit()[0]).toMatchObject({
      action: 'calendar.deleted',
      target: `calendar:${id}`,
      details: { name: 'Mine', kind: 'personal', byOwner: true, links: 0 },
    })
  })

  it.each([
    ['another person home', `/caldav/${SUBS.bob}/Mine/`],
    ['a share by a user', `/caldav/${SUBS.alice}/shared-5/`],
    ['a share by a group', `/caldav/${SUBS.alice}/shared-5-team/`],
    ['the availability share', `/caldav/${SUBS.alice}/resource-availability/`],
    ['an event path', `/caldav/${SUBS.alice}/Mine/event.ics`],
    ['a path with a traversal', `/caldav/${SUBS.alice}/../${SUBS.bob}/Mine/`],
    ['an encoded traversal', `/caldav/${SUBS.alice}/%2e%2e/${SUBS.bob}/`],
    ['the home itself', `/caldav/${SUBS.alice}/`],
    ['no path', ''],
    ['an overlong href', `/caldav/${SUBS.alice}/${'a'.repeat(600)}/`],
  ])('refuses %s with 400', async (_label, href) => {
    const res = await del('alice', href)
    expect(res.status).toBe(400)
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(radicale.listShares).not.toHaveBeenCalled()
  })

  it('refuses the default calendar with 409 default_calendar, with or without a row', async () => {
    const href = `/caldav/${SUBS.alice}/def-calendar/`
    const before = await del('alice', href)
    expect(before.status).toBe(409)
    expect(await before.json()).toMatchObject({ data: { code: 'default_calendar' } })
    seedCalendar(`/${SUBS.alice}/def-calendar/`, { kind: 'personal', owner: 'alice' })
    // encoded or not, it is the same calendar
    expect((await del('alice', `/caldav/${SUBS.alice}/def%2Dcalendar/`)).status).toBe(409)
    expect((await del('alice', href)).status).toBe(409)
    expect(radicale.listShares).not.toHaveBeenCalled()
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
    expect(count('calendars')).toBe(1)
    expect(audit()).toEqual([])
  })

  it('refuses a missing href with 400', async () => {
    expect((await del('alice', undefined)).status).toBe(400)
    expect(radicale.deleteCollection).not.toHaveBeenCalled()
  })

  it('answers 502 and keeps the row and links when Radicale fails', async () => {
    const id = seedCalendar(`/${SUBS.alice}/Mine/`, { kind: 'personal', owner: 'alice' })
    seedLink(userIds.alice, `/${SUBS.alice}/Mine/`, id)
    radicale.deleteCollection.mockResolvedValueOnce(down)
    const res = await del('alice', `/caldav/${SUBS.alice}/Mine/`)
    expect(res.status).toBe(502)
    expect(count('calendars')).toBe(1)
    expect(count('calendar_links')).toBe(1)
    expect(audit()).toEqual([])
  })
})
