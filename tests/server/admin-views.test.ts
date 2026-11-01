// @vitest-environment node
// Shared (admin) views: the admin routes, the 403 for everybody else, an audit row per mutation,
// no `ext:` refs, and the user routes never touching an admin view.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { listViews } from '../../server/db/views'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { parseViewInput } from '../../server/utils/api/views'
import { setDb } from '../../server/utils/db'
import adminDelete from '../../server/api/admin/views/[id].delete'
import adminPut from '../../server/api/admin/views/[id].put'
import adminPost from '../../server/api/admin/views/index.post'
import userDelete from '../../server/api/views/[id].delete'
import userPut from '../../server/api/views/[id].put'
import userPost from '../../server/api/views/index.post'
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

const WORK = 'dav:/caldav/sub-alice/work/'
const EXTERNAL = 'ext:acc:https://x.example/c/'

let db: Database
let handle: (request: Request) => Promise<Response>
let admins: string[]

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  admins = ['alice']
  const router = createRouter()
  router.add('/api/admin/views', adminPost, 'post')
  router.add('/api/admin/views/:id', adminPut, 'put')
  router.add('/api/admin/views/:id', adminDelete, 'delete')
  router.add('/api/views', userPost, 'post')
  router.add('/api/views/:id', userPut, 'put')
  router.add('/api/views/:id', userDelete, 'delete')
  handle = toWebHandler(createApp().use(router))
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      const name = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer test-/,
        '',
      )
      const groups = admins.includes(name) ? ['calendar_admins'] : ['staff']
      return new Response(JSON.stringify({ sub: `sub-${name}`, groups }), { status: 200 })
    }),
  )
  getUserinfoClient().clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  db.close()
})

function call(method: string, path: string, body?: unknown, as = 'alice') {
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer test-${as}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const valid = (name = 'All staff') => ({
  name,
  icon: 'shield',
  calendars: [{ ref: WORK }, { ref: 'ics:3', color: '#ABCDEF' }],
})

async function createShared(name = 'All staff'): Promise<number> {
  const response = await call('POST', '/api/admin/views', valid(name))
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: number }).id
}

const audit = () => listAuditEntries(db).reverse()
const rows = () => db.prepare('SELECT * FROM views ORDER BY id').all()

describe('admin view routes', () => {
  it('creates a shared view without owner and audits it with the name only', async () => {
    const response = await call('POST', '/api/admin/views', valid())
    expect(response.status).toBe(201)
    const view = (await response.json()) as Record<string, unknown>
    expect(view).toMatchObject({
      name: 'All staff',
      icon: 'shield',
      isAdmin: true,
      ownerId: null,
      calendars: [
        { ref: WORK, color: null },
        { ref: 'ics:3', color: '#abcdef' },
      ],
    })
    const [entry, ...rest] = audit()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      actor_sub: 'sub-alice',
      action: 'admin_view.created',
      target: String(view.id),
    })
    expect(JSON.parse(entry!.details!)).toEqual({ name: 'All staff' })
  })

  it('shows the shared view to everybody', async () => {
    const id = await createShared()
    expect(listViews(db, 999).map((view) => view.id)).toEqual([id])
  })

  it('updates and deletes a shared view, one audit row each', async () => {
    const id = await createShared()
    const put = await call('PUT', `/api/admin/views/${id}`, {
      name: 'Everyone',
      calendars: [{ ref: 'ics:9' }],
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      id,
      name: 'Everyone',
      icon: 'calendar',
      calendars: [{ ref: 'ics:9', color: null }],
    })
    expect((await call('DELETE', `/api/admin/views/${id}`)).status).toBe(204)
    expect(rows()).toEqual([])
    expect(audit().map((entry) => [entry.action, entry.target])).toEqual([
      ['admin_view.created', String(id)],
      ['admin_view.updated', String(id)],
      ['admin_view.deleted', String(id)],
    ])
    expect(audit().map((entry) => JSON.parse(entry.details!))).toEqual([
      { name: 'All staff' },
      { name: 'Everyone' },
      { name: 'Everyone' },
    ])
  })

  it('answers 403 to a non-admin on every route and changes nothing', async () => {
    const id = await createShared()
    const before = rows()
    for (const [method, path, body] of [
      ['POST', '/api/admin/views', valid('Mine')],
      ['PUT', `/api/admin/views/${id}`, valid('Mine')],
      ['DELETE', `/api/admin/views/${id}`, undefined],
    ] as const) {
      expect((await call(method, path, body, 'bob')).status).toBe(403)
    }
    expect(rows()).toEqual(before)
    expect(audit()).toHaveLength(1)
  })

  it('ignores a forged isAdmin in the body', async () => {
    const forged = { ...valid('Forged'), isAdmin: true, is_admin: 1, admin: true }
    expect((await call('POST', '/api/admin/views', forged, 'bob')).status).toBe(403)
    expect(rows()).toEqual([])
  })

  it('rejects ext: refs on create and update, with the field named', async () => {
    const body = { name: 'X', calendars: [{ ref: WORK }, { ref: EXTERNAL }] }
    const created = await call('POST', '/api/admin/views', body)
    expect(created.status).toBe(400)
    expect(JSON.stringify(await created.json())).toContain('calendars[1].ref')
    const id = await createShared()
    expect((await call('PUT', `/api/admin/views/${id}`, body)).status).toBe(400)
    expect(listViews(db, 1)[0]!.calendars.map((c) => c.ref)).toEqual([WORK, 'ics:3'])
    expect(audit()).toHaveLength(1)
  })

  it('validates like a user view', async () => {
    expect((await call('POST', '/api/admin/views', { name: '', calendars: [] })).status).toBe(400)
    expect((await call('POST', '/api/admin/views', { name: 'a', calendars: 'x' })).status).toBe(400)
    expect(rows()).toEqual([])
  })

  it('does not change or delete a user view, and writes no audit row for the miss', async () => {
    const created = await call('POST', '/api/views', valid('Mine'), 'alice')
    const mine = ((await created.json()) as { id: number }).id
    expect((await call('PUT', `/api/admin/views/${mine}`, valid('Taken'))).status).toBe(404)
    expect((await call('DELETE', `/api/admin/views/${mine}`)).status).toBe(404)
    expect(listViews(db, 1).map((view) => view.name)).toEqual(['Mine'])
    expect(audit()).toEqual([])
  })

  it('answers 404 for an id that is no number', async () => {
    expect((await call('PUT', '/api/admin/views/abc', valid())).status).toBe(404)
  })
})

describe('user routes and shared views', () => {
  it('cannot update or delete a shared view, even for an admin', async () => {
    const id = await createShared()
    const before = rows()
    expect((await call('PUT', `/api/views/${id}`, valid('Hijack'))).status).toBe(404)
    expect((await call('DELETE', `/api/views/${id}`)).status).toBe(404)
    expect((await call('PUT', `/api/views/${id}`, valid('Hijack'), 'bob')).status).toBe(404)
    expect((await call('DELETE', `/api/views/${id}`, undefined, 'bob')).status).toBe(404)
    expect(rows()).toEqual(before)
  })

  it('cannot create a shared view through the body of a user view', async () => {
    const response = await call('POST', '/api/views', { ...valid('Sneaky'), isAdmin: true })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ isAdmin: false })
  })

  it('still allows ext: refs in a user view', async () => {
    const response = await call('POST', '/api/views', {
      name: 'Mine',
      calendars: [{ ref: EXTERNAL }],
    })
    expect(response.status).toBe(201)
  })
})

describe('parseViewInput', () => {
  const body = { name: 'X', calendars: [{ ref: EXTERNAL }] }

  it('accepts ext: refs by default and refuses them for shared views', () => {
    expect(parseViewInput(body).ok).toBe(true)
    const shared = parseViewInput(body, { allowExternal: false })
    expect(shared.ok).toBe(false)
    if (!shared.ok) expect(shared.fields.map((f) => f.field)).toEqual(['calendars[0].ref'])
  })
})
