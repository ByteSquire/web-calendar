// @vitest-environment node
// PUT /api/me/sidebar-order (FR-21) over HTTP: the real route files behind an h3 router, with the real
// request guards in front (the body limit), an in-memory database and a stand-in for token
// verification (`Bearer test-<name>` is the user `sub-<name>`), as in api-routes.test.ts.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import meGet from '../../server/api/me.get'
import sidebarOrderPut from '../../server/api/me/sidebar-order.put'
import { findUserBySub } from '../../server/db/users'
import apiGuards from '../../server/middleware/api-guards'
import { API_MAX_BODY_BYTES } from '../../server/utils/api/body-limit'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
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

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  const router = createRouter()
  router.add('/api/me', meGet, 'get')
  router.add('/api/me/sidebar-order', sidebarOrderPut, 'put')
  handle = toWebHandler(createApp().use(apiGuards).use(router))
  // GET /api/me calls the identity provider: it is down, the stored profile is what comes back.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
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

interface Reply {
  status: number
  headers: Headers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: bodies are checked by shape
  body: any
}

async function call(
  user: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Reply> {
  const headers = new Headers(extraHeaders)
  if (user) headers.set('authorization', `Bearer test-${user}`)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const response = await handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  }
}

const put = (user: string | null, body?: unknown) =>
  call(user, 'PUT', '/api/me/sidebar-order', body)
const storedOrder = (sub: string) => findUserBySub(db, sub)?.sidebarOrder

const ARRANGED = ['filters', 'calendars', 'views', 'resources', 'categories']

describe('PUT /api/me/sidebar-order', () => {
  it('needs a user and stores nothing without one', async () => {
    expect((await put(null, { order: ARRANGED })).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })

  it('stores the order and answers with it, out of every cache', async () => {
    const reply = await put('alice', { order: ARRANGED })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ order: ARRANGED })
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(storedOrder('sub-alice')).toEqual(ARRANGED)
  })

  it('shows the order in GET /api/me, so that it follows the user to another browser', async () => {
    expect((await call('alice', 'GET', '/api/me')).body.sidebarOrder).toBeNull()
    await put('alice', { order: ARRANGED })
    expect((await call('alice', 'GET', '/api/me')).body.sidebarOrder).toEqual(ARRANGED)
  })

  it('completes an order that leaves sections out, in their default order', async () => {
    const reply = await put('alice', { order: ['filters', 'views'] })
    expect(reply.body).toEqual({
      order: ['filters', 'views', 'calendars', 'resources', 'categories'],
    })
  })

  it('changes an order that was set before', async () => {
    await put('alice', { order: ARRANGED })
    await put('alice', { order: ['resources'] })
    expect(storedOrder('sub-alice')).toEqual([
      'resources',
      'views',
      'calendars',
      'categories',
      'filters',
    ])
  })

  it('keeps the users apart', async () => {
    await put('alice', { order: ARRANGED })
    expect((await call('bob', 'GET', '/api/me')).body.sidebarOrder).toBeNull()
    await put('bob', { order: ['views'] })
    expect(storedOrder('sub-alice')).toEqual(ARRANGED)
  })

  it.each([
    ['no body', undefined],
    ['a list', []],
    ['no field', {}],
    ['null', { order: null }],
    ['a string', { order: 'views' }],
    ['an empty list', { order: [] }],
    ['a section that does not exist', { order: ['views', 'inbox'] }],
    ['a number', { order: [1] }],
    ['a section twice', { order: ['views', 'views'] }],
    ['too many entries', { order: [...ARRANGED, 'views'] }],
  ])('answers 400 for %s and keeps the stored order', async (_label, body) => {
    await put('alice', { order: ARRANGED })
    const reply = await put('alice', body)

    expect(reply.status).toBe(400)
    expect(reply.body.statusMessage).toBe('Bad Request')
    expect(reply.body.data.fields).toEqual(
      expect.arrayContaining([
        { field: expect.stringMatching(/^(order|body)$/), message: expect.any(String) },
      ]),
    )
    expect(storedOrder('sub-alice')).toEqual(ARRANGED)
  })

  it('does not send the input back', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const reply = await put('alice', { order: [hostile] })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body)).not.toContain(hostile)
    expect(JSON.stringify(reply.body)).not.toContain('onerror')
  })

  it('refuses a body over the limit before the route runs', async () => {
    await put('alice', { order: ARRANGED })
    const reply = await call(
      'alice',
      'PUT',
      '/api/me/sidebar-order',
      { order: ['views'] },
      { 'content-length': String(API_MAX_BODY_BYTES + 1) },
    )
    expect(reply.status).toBe(413)
    expect(storedOrder('sub-alice')).toEqual(ARRANGED)
  })

  it('reads a stored value that is not a list of sections as no order', () => {
    // Written by hand into the column: the CHECK keeps non-lists out, and unknown ids are dropped.
    db.prepare('INSERT INTO users (oidc_sub, sidebar_order) VALUES (?, ?)').run(
      'sub-old',
      '["filters","gone","filters"]',
    )
    expect(storedOrder('sub-old')).toEqual([
      'filters',
      'views',
      'calendars',
      'resources',
      'categories',
    ])
    expect(() =>
      db.prepare('INSERT INTO users (oidc_sub, sidebar_order) VALUES (?, ?)').run('sub-bad', '{}'),
    ).toThrow(/CHECK constraint/)
    expect(() =>
      db.prepare('INSERT INTO users (oidc_sub, sidebar_order) VALUES (?, ?)').run('sub-bad', 'x'),
    ).toThrow(/CHECK constraint/)
  })
})
