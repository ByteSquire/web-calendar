// @vitest-environment node
// PUT /api/me/time-zone (FR-32) over HTTP: the real route files behind an h3 router, with the real
// request guards in front (the body limit), an in-memory database and a stand-in for token
// verification (`Bearer test-<name>` is the user `sub-<name>`), as in api-routes.test.ts.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import meGet from '../../server/api/me.get'
import timeZonePut from '../../server/api/me/time-zone.put'
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
  router.add('/api/me/time-zone', timeZonePut, 'put')
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

const put = (user: string | null, body?: unknown) => call(user, 'PUT', '/api/me/time-zone', body)
const storedZone = (sub: string) => findUserBySub(db, sub)?.timeZone

describe('PUT /api/me/time-zone', () => {
  it('needs a user and stores nothing without one', async () => {
    expect((await put(null, { timeZone: 'Asia/Tokyo' })).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })

  it('stores the zone and answers with it, out of every cache', async () => {
    const reply = await put('alice', { timeZone: 'Australia/Sydney' })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ timeZone: 'Australia/Sydney' })
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(storedZone('sub-alice')).toBe('Australia/Sydney')
  })

  it('shows the zone in GET /api/me, until it is cleared with null', async () => {
    expect((await call('alice', 'GET', '/api/me')).body.timeZone).toBeNull()

    await put('alice', { timeZone: 'America/Argentina/Buenos_Aires' })
    expect((await call('alice', 'GET', '/api/me')).body.timeZone).toBe(
      'America/Argentina/Buenos_Aires',
    )

    expect((await put('alice', { timeZone: null })).body).toEqual({ timeZone: null })
    expect((await call('alice', 'GET', '/api/me')).body.timeZone).toBeNull()
    expect(storedZone('sub-alice')).toBeNull()
  })

  it('changes a zone that was set before', async () => {
    await put('alice', { timeZone: 'Australia/Sydney' })
    const reply = await put('alice', { timeZone: 'Asia/Tokyo' })
    expect(reply.body).toEqual({ timeZone: 'Asia/Tokyo' })
    expect(storedZone('sub-alice')).toBe('Asia/Tokyo')
  })

  it('keeps the users apart', async () => {
    await put('alice', { timeZone: 'Australia/Sydney' })
    expect((await call('bob', 'GET', '/api/me')).body.timeZone).toBeNull()

    await put('bob', { timeZone: 'Asia/Tokyo' })
    await put('bob', { timeZone: null })
    expect(storedZone('sub-alice')).toBe('Australia/Sydney')
    expect(storedZone('sub-bob')).toBeNull()
  })

  it.each([
    ['no body', undefined],
    ['a list', []],
    ['no field', {}],
    ['a number', { timeZone: 3 }],
    ['an empty string', { timeZone: '' }],
    ['a name that is no zone', { timeZone: 'Mars/Olympus' }],
    ['a UTC offset', { timeZone: '+01:00' }],
    ['a name that is too long', { timeZone: 'Europe/Berlin'.padEnd(500, 'x') }],
  ])('answers 400 for %s and keeps the stored zone', async (_label, body) => {
    await put('alice', { timeZone: 'Asia/Tokyo' })
    const reply = await put('alice', body)

    expect(reply.status).toBe(400)
    expect(reply.body.statusMessage).toBe('Bad Request')
    expect(reply.body.data.fields).toEqual(
      expect.arrayContaining([{ field: 'timeZone', message: expect.any(String) }]),
    )
    expect(storedZone('sub-alice')).toBe('Asia/Tokyo')
  })

  it('does not send the input back', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const reply = await put('alice', { timeZone: hostile })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body)).not.toContain(hostile)
    expect(JSON.stringify(reply.body)).not.toContain('onerror')
  })

  it('refuses a body over the limit before the route runs', async () => {
    await put('alice', { timeZone: 'Asia/Tokyo' })
    const reply = await call(
      'alice',
      'PUT',
      '/api/me/time-zone',
      { timeZone: null },
      { 'content-length': String(API_MAX_BODY_BYTES + 1) },
    )
    expect(reply.status).toBe(413)
    expect(storedZone('sub-alice')).toBe('Asia/Tokyo')
  })
})
