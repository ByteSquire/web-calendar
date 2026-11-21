// @vitest-environment node
// PUT /api/me/sidebar-hidden (FR-21) over HTTP: the real route files behind an h3 router, with the real
// request guards in front (the body limit), an in-memory database and a stand-in for token
// verification (`Bearer test-<name>` is the user `sub-<name>`), as in api-routes.test.ts.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import meGet from '../../server/api/me.get'
import sidebarHiddenPut from '../../server/api/me/sidebar-hidden.put'
import { findUserBySub } from '../../server/db/users'
import apiGuards from '../../server/middleware/api-guards'
import { API_MAX_BODY_BYTES } from '../../server/utils/api/body-limit'
import { SIDEBAR_HIDDEN_KEY_MAX, SIDEBAR_HIDDEN_MAX } from '../../shared/utils/sidebar-hidden'
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
  router.add('/api/me/sidebar-hidden', sidebarHiddenPut, 'put')
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
  call(user, 'PUT', '/api/me/sidebar-hidden', body)
const storedHidden = (sub: string) => findUserBySub(db, sub)?.sidebarHidden

const HIDDEN = [
  'calendar:dav:/caldav/sub-alice/work/',
  'resource:12',
  'view:3',
  'category:auto:Travel',
]

describe('PUT /api/me/sidebar-hidden', () => {
  it('needs a user and stores nothing without one', async () => {
    expect((await put(null, { hidden: HIDDEN })).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })

  it('stores the list and answers with it, out of every cache', async () => {
    const reply = await put('alice', { hidden: HIDDEN })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ hidden: HIDDEN })
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(storedHidden('sub-alice')).toEqual(HIDDEN)
  })

  it('shows the list in GET /api/me, so that it follows the user to another browser', async () => {
    expect((await call('alice', 'GET', '/api/me')).body.sidebarHidden).toEqual([])
    await put('alice', { hidden: HIDDEN })
    expect((await call('alice', 'GET', '/api/me')).body.sidebarHidden).toEqual(HIDDEN)
  })

  it('shows everything again with an empty list', async () => {
    await put('alice', { hidden: HIDDEN })
    expect((await put('alice', { hidden: [] })).body).toEqual({ hidden: [] })
    expect(storedHidden('sub-alice')).toEqual([])
  })

  it('keeps the users apart', async () => {
    await put('alice', { hidden: HIDDEN })
    expect((await call('bob', 'GET', '/api/me')).body.sidebarHidden).toEqual([])
    await put('bob', { hidden: ['filter:1'] })
    expect(storedHidden('sub-alice')).toEqual(HIDDEN)
  })

  it('takes the most items it allows, and keys of the longest length', async () => {
    const many = Array.from({ length: SIDEBAR_HIDDEN_MAX }, (_, index) => `view:${index}`)
    expect((await put('alice', { hidden: many })).status).toBe(200)
    const long = `calendar:${'x'.repeat(SIDEBAR_HIDDEN_KEY_MAX - 'calendar:'.length)}`
    expect((await put('alice', { hidden: [long] })).body).toEqual({ hidden: [long] })
  })

  it.each([
    ['no body', undefined],
    ['a list', []],
    ['no field', {}],
    ['null', { hidden: null }],
    ['a string', { hidden: 'view:3' }],
    ['a kind that does not exist', { hidden: ['inbox:3'] }],
    ['a key without a kind', { hidden: ['3'] }],
    ['a kind without an id', { hidden: ['view:'] }],
    ['a number', { hidden: [3] }],
    ['a control character', { hidden: ['view:3\n'] }],
    ['a key that is too long', { hidden: [`view:${'x'.repeat(SIDEBAR_HIDDEN_KEY_MAX)}`] }],
    ['an item twice', { hidden: ['view:3', 'view:3'] }],
    [
      'too many items',
      { hidden: Array.from({ length: SIDEBAR_HIDDEN_MAX + 1 }, (_, index) => `view:${index}`) },
    ],
  ])('answers 400 for %s and keeps the stored list', async (_label, body) => {
    await put('alice', { hidden: HIDDEN })
    const reply = await put('alice', body)

    expect(reply.status).toBe(400)
    expect(reply.body.statusMessage).toBe('Bad Request')
    expect(reply.body.data.fields).toEqual(
      expect.arrayContaining([
        { field: expect.stringMatching(/^(hidden|body)$/), message: expect.any(String) },
      ]),
    )
    expect(storedHidden('sub-alice')).toEqual(HIDDEN)
  })

  it('does not send the input back', async () => {
    const hostile = 'view:<img src=x onerror=alert(1)>'
    const reply = await put('alice', { hidden: [hostile, hostile] })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body)).not.toContain('onerror')
  })

  it('refuses a body over the limit before the route runs', async () => {
    await put('alice', { hidden: HIDDEN })
    const reply = await call(
      'alice',
      'PUT',
      '/api/me/sidebar-hidden',
      { hidden: [] },
      { 'content-length': String(API_MAX_BODY_BYTES + 1) },
    )
    expect(reply.status).toBe(413)
    expect(storedHidden('sub-alice')).toEqual(HIDDEN)
  })

  it('reads a stored value with keys it does not know as the keys it knows', () => {
    // Written by hand into the column: the CHECK keeps non-lists out, unknown keys are dropped.
    db.prepare('INSERT INTO users (oidc_sub, sidebar_hidden) VALUES (?, ?)').run(
      'sub-old',
      '["view:3","inbox:1","view:3",7]',
    )
    expect(storedHidden('sub-old')).toEqual(['view:3'])
    expect(() =>
      db.prepare('INSERT INTO users (oidc_sub, sidebar_hidden) VALUES (?, ?)').run('sub-x', '{}'),
    ).toThrow(/CHECK/)
  })
})
