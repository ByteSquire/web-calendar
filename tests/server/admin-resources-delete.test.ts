// @vitest-environment node
// Deleting a resource and changing or deleting a shared category, as HTTP: admin only, the rows
// that go with them, the audit entries and the refusals (bookings, a person's own category).
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import resourceDelete from '../../server/api/admin/resources/[id].delete'
import categoryPut from '../../server/api/admin/categories/[id].put'
import categoryDelete from '../../server/api/admin/categories/[id].delete'
import { upsertUser } from '../../server/db/users'
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
  ['DELETE', '/api/admin/resources/:id', resourceDelete],
  ['PUT', '/api/admin/categories/:id', categoryPut],
  ['DELETE', '/api/admin/categories/:id', categoryDelete],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let radicale: Record<
  'makeCalendar' | 'updateCalendar' | 'deleteCollection' | 'listShares' | 'deleteShare',
  ReturnType<typeof vi.fn>
>
let ports: GroupsPorts & { onSharesChanged: ReturnType<typeof vi.fn> }
const ok = { ok: true, value: undefined } as const
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

function seedResource(name = 'Room 1'): number {
  const id = Number(
    db.prepare(`INSERT INTO resources (name, type) VALUES (?, 'room')`).run(name).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
     VALUES (?, 'group', 'staff', 'book'), (?, 'authenticated', NULL, 'read')`,
  ).run(id, id)
  return id
}

describe('DELETE /api/admin/resources/:id', () => {
  it('answers 401 anonymous and 403 for a non-admin, and keeps the resource', async () => {
    const id = seedResource()
    expect((await call('DELETE', `/api/admin/resources/${id}`, null)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/resources/${id}`, 'alice')).status).toBe(403)
    expect(count('resources')).toBe(1)
  })

  it('deletes the resource and its rules, and audits it', async () => {
    const id = seedResource('Room 1')
    const other = seedResource('Room 2')
    const res = await call('DELETE', `/api/admin/resources/${id}`, 'admin')
    expect(res.status).toBe(200)
    expect(db.prepare('SELECT id FROM resources').pluck().all()).toEqual([other])
    expect(db.prepare('SELECT DISTINCT resource_id FROM resource_acl').pluck().all()).toEqual([
      other,
    ])
    expect(audit()).toEqual([
      {
        action: 'resource.deleted',
        target: `resource:${id}`,
        details: { resourceId: id, name: 'Room 1' },
      },
    ])
  })

  it.each(['pending', 'approved', 'declined', 'cancelled'])(
    'answers 409 has_bookings when a %s booking names it',
    async (status) => {
      const id = seedResource()
      db.prepare(
        `INSERT INTO calendar_bookings
           (resource_id, requester_id, start_at, end_at, status, event_calendar_path, event_uid,
            block_ref)
         VALUES (?, ?, '2030-01-01T10:00:00.000Z', '2030-01-01T11:00:00.000Z', ?, ?, 'uid-1', ?)`,
      ).run(id, userIds.alice, status, `/${SUBS.alice}/Mine/`, 'b'.repeat(20))
      const res = await call('DELETE', `/api/admin/resources/${id}`, 'admin')
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ data: { code: 'has_bookings' } })
      expect(count('resources')).toBe(1)
      expect(count('resource_acl')).toBe(2)
      expect(audit()).toEqual([])
    },
  )

  it('answers 404 for an unknown resource', async () => {
    expect((await call('DELETE', '/api/admin/resources/999', 'admin')).status).toBe(404)
    expect((await call('DELETE', '/api/admin/resources/abc', 'admin')).status).toBe(404)
  })
})

function seedCategory(name: string, owner: Who | null): number {
  return Number(
    db
      .prepare(`INSERT INTO categories (name, color, owner_id) VALUES (?, '#112233', ?)`)
      .run(name, owner ? userIds[owner] : null).lastInsertRowid,
  )
}

describe('PUT /api/admin/categories/:id', () => {
  it('answers 401 anonymous and 403 for a non-admin, and changes nothing', async () => {
    const id = seedCategory('Work', null)
    expect((await call('PUT', `/api/admin/categories/${id}`, null, { name: 'X' })).status).toBe(401)
    expect((await call('PUT', `/api/admin/categories/${id}`, 'alice', { name: 'X' })).status).toBe(
      403,
    )
    expect(db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(id)).toBe('Work')
  })

  it('renames and recolours a shared category and audits it', async () => {
    const id = seedCategory('Work', null)
    const res = await call('PUT', `/api/admin/categories/${id}`, 'admin', {
      name: 'Office',
      color: '#ff0000',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, name: 'Office', color: '#ff0000', shared: true })
    expect(audit()).toEqual([
      { action: 'category.shared_changed', target: `category:${id}`, details: { name: 'Office' } },
    ])
  })

  it("answers 404 for a person's own category and changes nothing", async () => {
    const id = seedCategory('Mine', 'alice')
    const res = await call('PUT', `/api/admin/categories/${id}`, 'admin', { name: 'Stolen' })
    expect(res.status).toBe(404)
    expect(db.prepare('SELECT name FROM categories WHERE id = ?').pluck().get(id)).toBe('Mine')
    expect(audit()).toEqual([])
    expect((await call('PUT', '/api/admin/categories/999', 'admin', { name: 'X' })).status).toBe(
      404,
    )
  })

  it('answers 400 for a bad body and 409 for a name that is taken', async () => {
    const id = seedCategory('Work', null)
    seedCategory('Home', null)
    expect((await call('PUT', `/api/admin/categories/${id}`, 'admin', {})).status).toBe(400)
    expect(
      (await call('PUT', `/api/admin/categories/${id}`, 'admin', { name: 'X', color: 'red' }))
        .status,
    ).toBe(400)
    const taken = await call('PUT', `/api/admin/categories/${id}`, 'admin', { name: 'home' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ data: { code: 'duplicate' } })
    expect(audit()).toEqual([])
  })
})

describe('DELETE /api/admin/categories/:id', () => {
  it('answers 401 anonymous and 403 for a non-admin, and keeps the category', async () => {
    const id = seedCategory('Work', null)
    expect((await call('DELETE', `/api/admin/categories/${id}`, null)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/categories/${id}`, 'alice')).status).toBe(403)
    expect(count('categories')).toBe(1)
  })

  it('deletes a shared category with the audit entry', async () => {
    const id = seedCategory('Work', null)
    const mine = seedCategory('Mine', 'alice')
    const res = await call('DELETE', `/api/admin/categories/${id}`, 'admin')
    expect(res.status).toBe(204)
    expect(db.prepare('SELECT id FROM categories').pluck().all()).toEqual([mine])
    expect(audit()).toEqual([
      { action: 'category.shared_deleted', target: `category:${id}`, details: { name: 'Work' } },
    ])
  })

  it("answers 404 for a person's own category and keeps it", async () => {
    const id = seedCategory('Mine', 'alice')
    expect((await call('DELETE', `/api/admin/categories/${id}`, 'admin')).status).toBe(404)
    expect(count('categories')).toBe(1)
    expect(audit()).toEqual([])
    expect((await call('DELETE', '/api/admin/categories/999', 'admin')).status).toBe(404)
  })
})
