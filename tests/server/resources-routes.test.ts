// @vitest-environment node
// The resource routes through the real frame: authentication, the admin guard, validation, rights
// by group, and the block store behind the booking routes (all with fakes).
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import acceptRoute from '../../server/api/resources/[id]/bookings/[bookingId]/accept.post'
import cancelRoute from '../../server/api/resources/[id]/bookings/[bookingId]/cancel.post'
import bookingsGet from '../../server/api/resources/[id]/bookings.get'
import bookingsPost from '../../server/api/resources/[id]/bookings.post'
import resourceGet from '../../server/api/resources/[id].get'
import resourcesGet from '../../server/api/resources/index.get'
import adminAclPut from '../../server/api/admin/resources/[id]/acl.put'
import adminDeactivate from '../../server/api/admin/resources/[id]/deactivate.post'
import adminCreate from '../../server/api/admin/resources/index.post'
import { listAuditEntries } from '../../server/db/audit-log'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
import { setBlockStore } from '../../server/utils/resources/store'
import { openTestDb } from './api-fixtures'

vi.mock('../../server/utils/auth/nitro', async () => {
  const { createError } = await import('h3')
  return {
    requireUser: async (event: { headers: Headers }) => {
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

const GROUPS: Record<string, string[]> = {
  admin: ['calendar_admins'],
  alice: [],
  bob: [],
  manager: ['facility@idm.test'],
}

let db: Database
let handle: (request: Request) => Promise<Response>
let blocks: Map<string, string>

function mount() {
  const router = createRouter()
  const add = (path: string, handler: EventHandler, method: 'get' | 'post' | 'put') =>
    router.add(path, handler, method)
  add('/api/resources', resourcesGet, 'get')
  add('/api/resources/:id', resourceGet, 'get')
  add('/api/resources/:id/bookings', bookingsGet, 'get')
  add('/api/resources/:id/bookings', bookingsPost, 'post')
  add('/api/resources/:id/bookings/:bookingId/accept', acceptRoute, 'post')
  add('/api/resources/:id/bookings/:bookingId/cancel', cancelRoute, 'post')
  add('/api/admin/resources', adminCreate, 'post')
  add('/api/admin/resources/:id/acl', adminAclPut, 'put')
  add('/api/admin/resources/:id/deactivate', adminDeactivate, 'post')
  handle = toWebHandler(createApp().use(router))
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  blocks = new Map()
  setBlockStore({
    async put(path, ics) {
      blocks.set(path, ics)
    },
    async delete(path) {
      blocks.delete(path)
    },
  })
  mount()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      const name = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer test-/,
        '',
      )
      return new Response(JSON.stringify({ sub: `sub-${name}`, groups: GROUPS[name] ?? [] }), {
        status: 200,
      })
    }),
  )
  getUserinfoClient().clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setBlockStore(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  db.close()
})

function call(who: string, method: string, path: string, body?: unknown) {
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer test-${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

async function createRoom(): Promise<number> {
  const response = await call('admin', 'POST', '/api/admin/resources', {
    name: 'Room',
    type: 'room',
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: number }).id
}

function slotBody(offsetHours = 0) {
  const start = new Date(Date.now() + 2 * 86_400_000 + offsetHours * 3_600_000)
  start.setUTCMinutes(0, 0, 0)
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
    eventUid: `uid-${offsetHours}`,
  }
}

describe('admin routes', () => {
  it('refuse a user who is not an admin', async () => {
    expect(
      (await call('alice', 'POST', '/api/admin/resources', { name: 'x', type: 'room' })).status,
    ).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS n FROM resources').get()).toEqual({ n: 0 })
  })

  it('create a resource with the default rule and audit it', async () => {
    const id = await createRoom()
    expect(db.prepare('SELECT "right" FROM resource_acl WHERE resource_id = ?').all(id)).toEqual([
      { right: 'book' },
    ])
    expect(listAuditEntries(db, {})[0]).toMatchObject({
      actor_sub: 'sub-admin',
      action: 'resource.created',
    })
  })

  it('validate the body', async () => {
    expect(
      (await call('admin', 'POST', '/api/admin/resources', { name: '', type: 'boat' })).status,
    ).toBe(400)
  })

  it('refuse write-style and public rules, and accept manage for a group', async () => {
    const id = await createRoom()
    const put = (rules: unknown[]) =>
      call('admin', 'PUT', `/api/admin/resources/${id}/acl`, { rules })
    expect((await put([{ principalType: 'authenticated', right: 'write' }])).status).toBe(400)
    expect((await put([{ principalType: 'public', right: 'read' }])).status).toBe(400)
    const ok = await put([
      { principalType: 'authenticated', right: 'book' },
      { principalType: 'group', principal: 'facility', right: 'manage' },
    ])
    expect(ok.status).toBe(200)
  })

  it('deactivate stops new bookings', async () => {
    const id = await createRoom()
    expect((await call('admin', 'POST', `/api/admin/resources/${id}/deactivate`)).status).toBe(200)
    expect((await call('alice', 'POST', `/api/resources/${id}/bookings`, slotBody())).status).toBe(
      409,
    )
    expect((await call('alice', 'GET', `/api/resources/${id}`)).status).toBe(404)
  })
})

describe('user routes', () => {
  it('list the resources the caller may read, with their right', async () => {
    const id = await createRoom()
    const response = await call('alice', 'GET', '/api/resources')
    expect(await response.json()).toEqual({
      resources: [expect.objectContaining({ id, name: 'Room', right: 'book', active: true })],
    })
  })

  it('book, accept by a manager group, and cancel; the block follows', async () => {
    const id = await createRoom()
    await call('admin', 'PUT', `/api/admin/resources/${id}/acl`, {
      rules: [
        { principalType: 'authenticated', right: 'book' },
        { principalType: 'group', principal: 'facility', right: 'manage' },
      ],
    })
    const created = await call('alice', 'POST', `/api/resources/${id}/bookings`, slotBody())
    expect(created.status).toBe(201)
    const booking = (await created.json()) as { id: number; status: string }
    expect(booking.status).toBe('pending')
    expect(blocks.size).toBe(1)

    const base = `/api/resources/${id}/bookings/${booking.id}`
    expect((await call('bob', 'POST', `${base}/cancel`)).status).toBe(404)
    expect((await call('alice', 'POST', `${base}/accept`)).status).toBe(403)
    expect(blocks.size).toBe(1)

    expect((await call('manager', 'POST', `${base}/accept`)).status).toBe(200)
    const mine = (await (await call('alice', 'GET', `/api/resources/${id}/bookings`)).json()) as {
      bookings: { status: string }[]
    }
    expect(mine.bookings.map((b) => b.status)).toEqual(['approved'])
    expect(await call('bob', 'GET', `/api/resources/${id}/bookings`).then((r) => r.json())).toEqual(
      {
        bookings: [],
      },
    )
    const seen = (await (await call('manager', 'GET', `/api/resources/${id}/bookings`)).json()) as {
      bookings: { requester: unknown; eventUid?: string }[]
    }
    expect(seen.bookings[0]?.requester).toBeDefined()
    expect(seen.bookings[0]?.eventUid).toBeUndefined()

    expect((await call('alice', 'POST', `${base}/cancel`)).status).toBe(200)
    expect(blocks.size).toBe(0)
  })

  it('validate the booking body and answer 404 for an id that is not a number', async () => {
    const id = await createRoom()
    expect(
      (await call('alice', 'POST', `/api/resources/${id}/bookings`, { startAt: 'x' })).status,
    ).toBe(400)
    expect((await call('alice', 'GET', '/api/resources/abc')).status).toBe(404)
  })

  it('need a signed-in caller', async () => {
    const response = await handle(new Request('http://localhost/api/resources'))
    expect(response.status).toBe(401)
  })
})
