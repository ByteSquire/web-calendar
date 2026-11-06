// @vitest-environment node
// The HTTP contract of the signed-in-user API: the real route files behind an h3 router, an
// in-memory database and a stand-in for token verification (`Bearer test-<name>` is the user
// `sub-<name>`). What the unit tests of the plain modules cannot show: routes, methods, status
// codes, error bodies and that every route needs a user.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler, type EventHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import icalData from '../../server/api/ical-subscriptions/[id]/data.get'
import appTokensDelete from '../../server/api/app-tokens/[id].delete'
import appTokensDeleteAll from '../../server/api/app-tokens/index.delete'
import appTokensGet from '../../server/api/app-tokens/index.get'
import appTokensPost from '../../server/api/app-tokens/index.post'
import calendarPrefsDelete from '../../server/api/calendar-prefs/index.delete'
import calendarPrefsGet from '../../server/api/calendar-prefs/index.get'
import calendarPrefsPut from '../../server/api/calendar-prefs/index.put'
import categoriesDelete from '../../server/api/categories/[id].delete'
import categoriesPut from '../../server/api/categories/[id].put'
import categoriesGet from '../../server/api/categories/index.get'
import categoriesPost from '../../server/api/categories/index.post'
import filtersDelete from '../../server/api/filters/[id].delete'
import filtersPut from '../../server/api/filters/[id].put'
import filtersGet from '../../server/api/filters/index.get'
import filtersPost from '../../server/api/filters/index.post'
import meGet from '../../server/api/me.get'
import viewsDelete from '../../server/api/views/[id].delete'
import viewsPut from '../../server/api/views/[id].put'
import viewsGet from '../../server/api/views/index.get'
import viewsPost from '../../server/api/views/index.post'
import { MAX_APP_TOKENS_PER_USER } from '../../server/db/app-tokens'
import { MAX_VIEWS_PER_USER } from '../../server/db/views'
import { setDb } from '../../server/utils/db'
import { defineApiHandler, requireAdmin } from '../../server/utils/api/handler'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { openTestDb, seedUserinfoEndpoint } from './api-fixtures'

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

const icalProxy = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../server/utils/ical-proxy/nitro', () => ({
  getIcalProxy: () => icalProxy,
  toGatewayError: (error: unknown) => error,
}))

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
  }),
}))

// A stand-in for a Phase 3 admin route: the frame, then the one admin check.
const adminProbe = defineApiHandler(async (event, { user }) => {
  await requireAdmin(event)
  return { admin: true, userKeys: Object.keys(user).sort() }
})

const ROUTES: [method: string, path: string, handler: EventHandler][] = [
  ['GET', '/api/me', meGet],
  ['GET', '/api/admin-probe', adminProbe],
  ['GET', '/api/ical-subscriptions/:id/data', icalData],
  ['GET', '/api/app-tokens', appTokensGet],
  ['POST', '/api/app-tokens', appTokensPost],
  ['DELETE', '/api/app-tokens/:id', appTokensDelete],
  ['DELETE', '/api/app-tokens', appTokensDeleteAll],
  ['GET', '/api/views', viewsGet],
  ['POST', '/api/views', viewsPost],
  ['PUT', '/api/views/:id', viewsPut],
  ['DELETE', '/api/views/:id', viewsDelete],
  ['GET', '/api/filters', filtersGet],
  ['POST', '/api/filters', filtersPost],
  ['PUT', '/api/filters/:id', filtersPut],
  ['DELETE', '/api/filters/:id', filtersDelete],
  ['GET', '/api/categories', categoriesGet],
  ['POST', '/api/categories', categoriesPost],
  ['PUT', '/api/categories/:id', categoriesPut],
  ['DELETE', '/api/categories/:id', categoriesDelete],
  ['GET', '/api/calendar-prefs', calendarPrefsGet],
  ['PUT', '/api/calendar-prefs', calendarPrefsPut],
  ['DELETE', '/api/calendar-prefs', calendarPrefsDelete],
]

let db: Database
let handle: (request: Request) => Promise<Response>
let userinfoFetch: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  const router = createRouter()
  for (const [method, path, handler] of ROUTES) {
    router.add(path, handler, method.toLowerCase() as 'get')
  }
  handle = toWebHandler(createApp().use(router))
  // GET /api/me calls the identity provider; every test starts with "it is down".
  userinfoFetch = vi.fn<typeof fetch>(async () => {
    throw new TypeError('fetch failed')
  })
  vi.stubGlobal('fetch', userinfoFetch)
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
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
  options: { raw?: string; contentType?: string } = {},
): Promise<Reply> {
  const headers = new Headers()
  if (user) headers.set('authorization', `Bearer test-${user}`)
  let payload: string | undefined
  if (options.raw !== undefined) {
    payload = options.raw
    headers.set('content-type', options.contentType ?? 'application/json')
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers.set('content-type', 'application/json')
  }
  const response = await handle(
    new Request(`http://localhost${path}`, { method, headers, body: payload }),
  )
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  }
}

const VIEW = {
  name: 'Team',
  icon: 'users',
  calendars: [{ ref: 'dav:/caldav/a/b/', color: '#1d4ed8' }],
}

describe('authentication', () => {
  it.each(ROUTES.map(([method, path]) => [method, path.replace(':id', '1')]))(
    '%s %s needs a user',
    async (method, path) => {
      expect((await call(null, method!, path!, method === 'GET' ? undefined : {})).status).toBe(401)
    },
  )

  it('does not touch the database for a request without a user', async () => {
    await call(null, 'POST', '/api/views', VIEW)
    expect(db.prepare('SELECT COUNT(*) FROM views').pluck().get()).toBe(0)
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
  })

  it('creates the users row on first use', async () => {
    await call('alice', 'GET', '/api/views')
    expect(db.prepare('SELECT oidc_sub FROM users').pluck().all()).toEqual(['sub-alice'])
  })

  it('keeps every answer out of caches', async () => {
    const replies = await Promise.all([
      call('alice', 'GET', '/api/views'),
      call('alice', 'POST', '/api/app-tokens', { label: 'x' }),
      call('alice', 'GET', '/api/me'),
    ])
    for (const reply of replies) expect(reply.headers.get('cache-control')).toBe('no-store')
  })
})

/** What userinfo answers; `groups` left out of the object means "no groups claim". */
function userinfoAnswers(claims: Record<string, unknown> | null) {
  userinfoFetch.mockImplementation(async (_url, init) => {
    if (claims === null) throw new TypeError('fetch failed')
    const sub = new Headers(init?.headers).get('authorization')!.replace('Bearer test-', 'sub-')
    return Response.json({ sub, ...claims })
  })
}

describe('GET /api/me', () => {
  it('returns the stored profile, but no admin rights, when the identity provider is not reachable', async () => {
    const reply = await call('alice', 'GET', '/api/me')
    expect(reply).toMatchObject({
      status: 200,
      body: {
        id: expect.any(Number),
        sub: 'sub-alice',
        username: null,
        name: null,
        email: null,
        isAdmin: false,
        timeZone: null,
        sidebarOrder: null,
      },
    })
  })

  it('refreshes the profile from userinfo with the caller’s own token', async () => {
    userinfoAnswers({
      name: 'Alice Example',
      preferred_username: 'alice',
      email: 'alice@example.test',
      groups: ['calendar_admins@idm.test'],
    })
    const reply = await call('alice', 'GET', '/api/me')

    expect(reply.body).toMatchObject({
      sub: 'sub-alice',
      username: 'alice',
      name: 'Alice Example',
      email: 'alice@example.test',
      isAdmin: true,
    })
    const [url, init] = userinfoFetch.mock.calls[0]!
    expect(url).toBe('https://idm.test/oauth2/openid/web-calendar/userinfo')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-alice')
  })

  it('asks the identity provider once for a user, however often and however many at a time', async () => {
    userinfoAnswers({ name: 'Alice Example', groups: ['calendar_admins'] })
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => call('alice', 'GET', '/api/me')),
    )
    for (let i = 0; i < 5; i += 1) replies.push(await call('alice', 'GET', '/api/me'))

    expect(replies.every((r) => r.status === 200 && r.body.isAdmin === true)).toBe(true)
    expect(userinfoFetch).toHaveBeenCalledTimes(1)

    await call('bob', 'GET', '/api/me')
    expect(userinfoFetch).toHaveBeenCalledTimes(2)
    expect(new Headers(userinfoFetch.mock.calls[1]![1]?.headers).get('authorization')).toBe(
      'Bearer test-bob',
    )
  })

  it('does not call out for a failed answer again at once', async () => {
    userinfoAnswers(null)
    await call('alice', 'GET', '/api/me')
    await call('alice', 'GET', '/api/me')
    expect(userinfoFetch).toHaveBeenCalledTimes(1)
  })
})

describe('the admin check (requireAdmin)', () => {
  const ADMIN = { groups: ['calendar_admins@idm.test'] }

  function markStoredAdmin(sub = 'sub-alice') {
    db.prepare('UPDATE users SET is_admin = 1 WHERE oidc_sub = ?').run(sub)
  }

  it('lets a member of the admin group through', async () => {
    userinfoAnswers(ADMIN)
    const reply = await call('alice', 'GET', '/api/admin-probe')
    expect(reply).toMatchObject({ status: 200, body: { admin: true } })
  })

  it('refuses a stale is_admin = 1 when userinfo does not name the group', async () => {
    await call('alice', 'GET', '/api/views') // creates the row
    markStoredAdmin()
    userinfoAnswers({ groups: ['idm_all_persons@idm.test', 'calendar_admins_old@idm.test'] })

    const reply = await call('alice', 'GET', '/api/admin-probe')
    expect(reply.status).toBe(403)
    expect(reply.body.statusMessage).toBe('Forbidden')
  })

  it('refuses when userinfo cannot be reached, even with is_admin = 1', async () => {
    await call('alice', 'GET', '/api/views')
    markStoredAdmin()
    userinfoAnswers(null)
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(403)
  })

  it('refuses when userinfo answers an error', async () => {
    await call('alice', 'GET', '/api/views')
    markStoredAdmin()
    userinfoFetch.mockImplementation(async () => new Response('oops', { status: 500 }))
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(403)
  })

  it('refuses when the answer has no groups claim, even with is_admin = 1', async () => {
    await call('alice', 'GET', '/api/views')
    markStoredAdmin()
    userinfoAnswers({ name: 'Alice' })
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(403)
  })

  it('does not trust a body or a header that claims admin rights', async () => {
    userinfoAnswers({ groups: [] })
    const reply = await handle(
      new Request('http://localhost/api/admin-probe?isAdmin=true', {
        headers: { authorization: 'Bearer test-alice', 'x-admin': '1', 'x-is-admin': 'true' },
      }),
    )
    expect(reply.status).toBe(403)
  })

  it('needs a signed-in user first, and asks nobody for an anonymous request', async () => {
    userinfoAnswers(ADMIN)
    expect((await call(null, 'GET', '/api/admin-probe')).status).toBe(401)
    expect(userinfoFetch).not.toHaveBeenCalled()
  })

  it('follows a change of groups at once, although /api/me remembers for a minute', async () => {
    userinfoAnswers(ADMIN)
    expect((await call('alice', 'GET', '/api/me')).body.isAdmin).toBe(true)
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(200)

    // alice is removed from the group
    userinfoAnswers({ groups: ['idm_all_persons@idm.test'] })
    expect((await call('alice', 'GET', '/api/me')).body.isAdmin).toBe(true) // still the old answer
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(403) // not a kept one
    // the fresh answer replaces the kept one
    expect((await call('alice', 'GET', '/api/me')).body.isAdmin).toBe(false)
  })

  it('asks again for every admin request, but only once for requests at the same time', async () => {
    userinfoAnswers(ADMIN)
    await call('alice', 'GET', '/api/admin-probe')
    await call('alice', 'GET', '/api/admin-probe')
    expect(userinfoFetch).toHaveBeenCalledTimes(2)

    userinfoFetch.mockClear()
    await Promise.all(Array.from({ length: 10 }, () => call('alice', 'GET', '/api/admin-probe')))
    expect(userinfoFetch.mock.calls.length).toBeLessThan(10)
  })

  it('keeps users apart: one admin does not make another one', async () => {
    userinfoFetch.mockImplementation(async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization')!
      const sub = token.replace('Bearer test-', 'sub-')
      return Response.json({ sub, groups: sub === 'sub-alice' ? ['calendar_admins'] : [] })
    })
    expect((await call('alice', 'GET', '/api/admin-probe')).status).toBe(200)
    expect((await call('bob', 'GET', '/api/admin-probe')).status).toBe(403)
  })

  it('shows handlers a user without the stored admin flag', async () => {
    await call('alice', 'GET', '/api/views')
    markStoredAdmin()
    userinfoAnswers(ADMIN)
    const reply = await call('alice', 'GET', '/api/admin-probe')
    expect(reply.body.userKeys).toEqual([
      'email',
      'id',
      'lastSeenAt',
      'name',
      'sidebarOrder',
      'sub',
      'timeZone',
      'username',
    ])
  })
})

describe('GET /api/ical-subscriptions/:id/data', () => {
  function subscribe(sub: string, ownerSub: string | null = sub): number {
    return Number(
      db
        .prepare(
          `INSERT INTO ical_subscriptions (owner_id, name, url)
           VALUES ((SELECT id FROM users WHERE oidc_sub = ?), 'Holidays', 'https://example.org/h.ics')`,
        )
        .run(ownerSub === null ? null : `sub-${ownerSub.replace('sub-', '')}`).lastInsertRowid,
    )
  }

  it('serves the file as text/calendar and tells the browser not to sniff it', async () => {
    await call('alice', 'GET', '/api/views') // creates the user
    const id = subscribe('alice')
    icalProxy.get.mockResolvedValue({ body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', etag: '"v1"' })

    const handled = await handle(
      new Request(`http://localhost/api/ical-subscriptions/${id}/data`, {
        headers: { authorization: 'Bearer test-alice' },
      }),
    )
    expect(handled.status).toBe(200)
    expect(handled.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(handled.headers.get('x-content-type-options')).toBe('nosniff')
    expect(handled.headers.get('etag')).toBe('"v1"')
    expect(handled.headers.get('cache-control')).toBe('no-store')
    expect(await handled.text()).toContain('BEGIN:VCALENDAR')
  })

  it('serves a file that looks like HTML as text/calendar, never as HTML', async () => {
    await call('alice', 'GET', '/api/views')
    const id = subscribe('alice')
    icalProxy.get.mockResolvedValue({ body: '<!doctype html><script>alert(1)</script>' })

    const handled = await handle(
      new Request(`http://localhost/api/ical-subscriptions/${id}/data`, {
        headers: { authorization: 'Bearer test-alice' },
      }),
    )
    expect(handled.status).toBe(200)
    expect(handled.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(handled.headers.get('x-content-type-options')).toBe('nosniff')
    expect(handled.headers.get('etag')).toBeNull()
  })

  it('answers 404, and fetches nothing, for the subscription of another user', async () => {
    await call('alice', 'GET', '/api/views')
    await call('bob', 'GET', '/api/views')
    const id = subscribe('alice')
    icalProxy.get.mockClear()

    const reply = await call('bob', 'GET', `/api/ical-subscriptions/${id}/data`)
    expect(reply.status).toBe(404)
    expect(icalProxy.get).not.toHaveBeenCalled()
  })
})

describe('app tokens', () => {
  it('creates, lists and revokes', async () => {
    const created = await call('alice', 'POST', '/api/app-tokens', { label: ' Thunderbird ' })
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      id: expect.any(Number),
      label: 'Thunderbird',
      token: expect.stringMatching(/^wcal_/),
      expiresAt: expect.stringMatching(/Z$/),
    })

    const list = await call('alice', 'GET', '/api/app-tokens')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({
      tokens: [
        {
          id: created.body.id,
          label: 'Thunderbird',
          createdAt: expect.any(String),
          expiresAt: created.body.expiresAt,
          lastUsedAt: null,
          expired: false,
        },
      ],
      limit: 10,
    })
    expect(JSON.stringify(list.body)).not.toContain(created.body.token)

    expect((await call('alice', 'DELETE', `/api/app-tokens/${created.body.id}`)).status).toBe(204)
    expect((await call('alice', 'GET', '/api/app-tokens')).body.tokens).toEqual([])
    expect((await call('alice', 'DELETE', `/api/app-tokens/${created.body.id}`)).status).toBe(404)
  })

  it('shows the secret nowhere but in the response that creates it', async () => {
    const created = await call('alice', 'POST', '/api/app-tokens', { label: 'phone' })
    const stored = JSON.stringify(db.prepare('SELECT * FROM app_tokens').all())
    expect(stored).not.toContain(created.body.token)
    expect(stored).not.toContain(created.body.token.slice(5))
  })

  it('refuses a bad label with the field named, and the 11th token with 409', async () => {
    const bad = await call('alice', 'POST', '/api/app-tokens', { label: '  ' })
    expect(bad.status).toBe(400)
    expect(bad.body.data.fields).toEqual([{ field: 'label', message: expect.any(String) }])

    for (let i = 0; i < MAX_APP_TOKENS_PER_USER; i += 1) {
      expect((await call('alice', 'POST', '/api/app-tokens', { label: `t${i}` })).status).toBe(201)
    }
    const full = await call('alice', 'POST', '/api/app-tokens', { label: 'one more' })
    expect(full.status).toBe(409)
    expect(full.body.data).toEqual({ code: 'limit_reached' })
    expect((await call('bob', 'POST', '/api/app-tokens', { label: 'mine' })).status).toBe(201)
  })

  it('hides the tokens of other users and does not let them be revoked', async () => {
    const created = await call('alice', 'POST', '/api/app-tokens', { label: 'alice only' })
    expect((await call('bob', 'GET', '/api/app-tokens')).body.tokens).toEqual([])
    expect((await call('bob', 'DELETE', `/api/app-tokens/${created.body.id}`)).status).toBe(404)
    expect((await call('alice', 'GET', '/api/app-tokens')).body.tokens).toHaveLength(1)
  })

  it("revoke-all removes only the caller's own tokens (security review 2026-11-01)", async () => {
    await call('alice', 'POST', '/api/app-tokens', { label: 'phone' })
    await call('alice', 'POST', '/api/app-tokens', { label: 'laptop' })
    const bobToken = await call('bob', 'POST', '/api/app-tokens', { label: 'bob only' })

    const all = await call('alice', 'DELETE', '/api/app-tokens')
    expect(all.status).toBe(200)
    expect(all.body).toEqual({ revoked: 2 })
    expect((await call('alice', 'GET', '/api/app-tokens')).body.tokens).toEqual([])
    expect((await call('bob', 'GET', '/api/app-tokens')).body.tokens).toHaveLength(1)
    expect((await call('bob', 'DELETE', `/api/app-tokens/${bobToken.body.id}`)).status).toBe(204)
  })

  it.each(['abc', '0', '-1', '1.5', '99999999999999999999'])(
    'answers 404 for the id %s',
    async (id) => {
      expect((await call('alice', 'DELETE', `/api/app-tokens/${id}`)).status).toBe(404)
    },
  )
})

describe('views', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await call('alice', 'POST', '/api/views', VIEW)
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      id: expect.any(Number),
      ...VIEW,
      isAdmin: false,
      ownerId: expect.any(Number),
    })

    expect((await call('alice', 'GET', '/api/views')).body).toEqual({ views: [created.body] })

    const updated = await call('alice', 'PUT', `/api/views/${created.body.id}`, {
      name: 'Renamed',
      calendars: [{ ref: 'ics:3' }],
    })
    expect(updated).toMatchObject({
      status: 200,
      body: {
        id: created.body.id,
        name: 'Renamed',
        icon: 'calendar',
        calendars: [{ ref: 'ics:3', color: null }],
      },
    })

    expect((await call('alice', 'DELETE', `/api/views/${created.body.id}`)).status).toBe(204)
    expect((await call('alice', 'GET', '/api/views')).body).toEqual({ views: [] })
    expect((await call('alice', 'DELETE', `/api/views/${created.body.id}`)).status).toBe(404)
    expect((await call('alice', 'PUT', `/api/views/${created.body.id}`, VIEW)).status).toBe(404)
  })

  it('answers 400 with a list of fields for a bad body', async () => {
    const reply = await call('alice', 'POST', '/api/views', {
      name: '',
      icon: 'rocket',
      calendars: [{ ref: 'nope' }],
    })
    expect(reply.status).toBe(400)
    expect(reply.body.data.fields.map((f: { field: string }) => f.field)).toEqual([
      'name',
      'icon',
      'calendars[0].ref',
    ])
  })

  it.each([
    ['malformed JSON', { raw: '{"name": ' }],
    ['plain text', { raw: 'name=Team', contentType: 'text/plain' }],
    ['a JSON list', { raw: '[]' }],
    ['JSON null', { raw: 'null' }],
    ['an empty body', { raw: '' }],
  ])('answers 400 for %s, never 500', async (_label, options) => {
    const reply = await call('alice', 'POST', '/api/views', undefined, options)
    expect(reply.status).toBe(400)
  })

  it('answers 404 for ids that cannot be rows, before it looks at the body', async () => {
    for (const id of ['abc', '0', '1e3']) {
      expect((await call('alice', 'PUT', `/api/views/${id}`, VIEW)).status).toBe(404)
      expect((await call('alice', 'DELETE', `/api/views/${id}`)).status).toBe(404)
    }
  })

  it('keeps users apart, ids of others are 404', async () => {
    const mine = await call('alice', 'POST', '/api/views', VIEW)
    const id = mine.body.id

    expect((await call('bob', 'GET', '/api/views')).body).toEqual({ views: [] })
    expect((await call('bob', 'PUT', `/api/views/${id}`, { ...VIEW, name: 'hijack' })).status).toBe(
      404,
    )
    expect((await call('bob', 'DELETE', `/api/views/${id}`)).status).toBe(404)
    expect((await call('alice', 'GET', '/api/views')).body.views).toEqual([mine.body])
  })

  it('shows admin views to everybody and changes them for nobody', async () => {
    const admin = Number(
      db
        .prepare(
          `INSERT INTO views (name, icon, is_admin, definition) VALUES ('Everyone', 'shield', 1, '[]')`,
        )
        .run().lastInsertRowid,
    )
    for (const user of ['alice', 'bob']) {
      expect((await call(user, 'GET', '/api/views')).body.views).toEqual([
        {
          id: admin,
          name: 'Everyone',
          icon: 'shield',
          calendars: [],
          isAdmin: true,
          ownerId: null,
        },
      ])
      expect((await call(user, 'PUT', `/api/views/${admin}`, VIEW)).status).toBe(404)
      expect((await call(user, 'DELETE', `/api/views/${admin}`)).status).toBe(404)
    }
  })

  it('answers 409 limit_reached for the 101st view', async () => {
    await call('alice', 'GET', '/api/views')
    const alice = db
      .prepare(`SELECT id FROM users WHERE oidc_sub = 'sub-alice'`)
      .pluck()
      .get() as number
    const insert = db.prepare(`INSERT INTO views (name, owner_id) VALUES ('v', ?)`)
    for (let i = 0; i < MAX_VIEWS_PER_USER; i += 1) insert.run(alice)

    const reply = await call('alice', 'POST', '/api/views', VIEW)
    expect(reply.status).toBe(409)
    expect(reply.body.data).toEqual({ code: 'limit_reached' })
  })
})

describe('filters', () => {
  const FILTER = { name: 'Standups', kind: 'text', value: 'standup' }

  it('creates, lists, updates and deletes', async () => {
    const created = await call('alice', 'POST', '/api/filters', FILTER)
    expect(created).toMatchObject({ status: 201, body: { id: expect.any(Number), ...FILTER } })
    expect((await call('alice', 'GET', '/api/filters')).body).toEqual({ filters: [created.body] })

    const updated = await call('alice', 'PUT', `/api/filters/${created.body.id}`, {
      name: 'Cancelled',
      kind: 'status',
      value: 'cancelled',
    })
    expect(updated.body).toEqual({
      id: created.body.id,
      name: 'Cancelled',
      kind: 'status',
      value: 'cancelled',
    })

    expect((await call('alice', 'DELETE', `/api/filters/${created.body.id}`)).status).toBe(204)
    expect((await call('alice', 'GET', '/api/filters')).body).toEqual({ filters: [] })
  })

  it('validates the status value and keeps users apart', async () => {
    const bad = await call('alice', 'POST', '/api/filters', {
      name: 'S',
      kind: 'status',
      value: 'busy',
    })
    expect(bad.status).toBe(400)
    expect(bad.body.data.fields).toEqual([{ field: 'value', message: expect.any(String) }])

    const mine = await call('alice', 'POST', '/api/filters', FILTER)
    expect((await call('bob', 'GET', '/api/filters')).body).toEqual({ filters: [] })
    expect((await call('bob', 'PUT', `/api/filters/${mine.body.id}`, FILTER)).status).toBe(404)
    expect((await call('bob', 'DELETE', `/api/filters/${mine.body.id}`)).status).toBe(404)
  })
})

describe('categories', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await call('alice', 'POST', '/api/categories', {
      name: 'Work',
      color: '#ABCDEF',
    })
    expect(created).toMatchObject({
      status: 201,
      body: { id: expect.any(Number), name: 'Work', color: '#abcdef', shared: false },
    })
    expect((await call('alice', 'GET', '/api/categories')).body).toEqual({
      categories: [created.body],
    })

    const updated = await call('alice', 'PUT', `/api/categories/${created.body.id}`, {
      name: 'Office',
    })
    expect(updated.body).toEqual({
      id: created.body.id,
      name: 'Office',
      color: null,
      shared: false,
    })

    expect((await call('alice', 'DELETE', `/api/categories/${created.body.id}`)).status).toBe(204)
    expect((await call('alice', 'GET', '/api/categories')).body).toEqual({ categories: [] })
  })

  it('answers 409 duplicate for the same name in another letter case', async () => {
    await call('alice', 'POST', '/api/categories', { name: 'Work' })
    const dup = await call('alice', 'POST', '/api/categories', { name: 'WORK' })
    expect(dup.status).toBe(409)
    expect(dup.body.data).toEqual({ code: 'duplicate' })
    expect((await call('bob', 'POST', '/api/categories', { name: 'Work' })).status).toBe(201)
  })

  it('shows shared categories to everybody as read-only', async () => {
    const shared = Number(
      db
        .prepare(
          `INSERT INTO categories (name, color, owner_id) VALUES ('Holiday', '#ff0000', NULL)`,
        )
        .run().lastInsertRowid,
    )
    const mine = await call('alice', 'POST', '/api/categories', { name: 'Work' })

    expect((await call('alice', 'GET', '/api/categories')).body.categories).toEqual([
      { id: shared, name: 'Holiday', color: '#ff0000', shared: true },
      mine.body,
    ])
    expect((await call('bob', 'GET', '/api/categories')).body.categories).toEqual([
      { id: shared, name: 'Holiday', color: '#ff0000', shared: true },
    ])
    for (const user of ['alice', 'bob']) {
      expect((await call(user, 'PUT', `/api/categories/${shared}`, { name: 'x' })).status).toBe(404)
      expect((await call(user, 'DELETE', `/api/categories/${shared}`)).status).toBe(404)
    }
    expect((await call('bob', 'DELETE', `/api/categories/${mine.body.id}`)).status).toBe(404)
  })
})

describe('calendar preferences', () => {
  const REF = 'dav:/caldav/sub-alice/work/'

  it('sets, merges, lists and resets', async () => {
    const first = await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, color: '#112233' })
    expect(first).toMatchObject({
      status: 200,
      body: { ref: REF, color: '#112233', visible: true },
    })

    const hidden = await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, visible: false })
    expect(hidden.body).toEqual({ ref: REF, color: '#112233', visible: false })

    const cleared = await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, color: null })
    expect(cleared.body).toEqual({ ref: REF, color: null, visible: false })

    expect((await call('alice', 'GET', '/api/calendar-prefs')).body).toEqual({
      prefs: [{ ref: REF, color: null, visible: false }],
    })

    expect(
      (await call('alice', 'DELETE', `/api/calendar-prefs?ref=${encodeURIComponent(REF)}`)).status,
    ).toBe(204)
    expect((await call('alice', 'GET', '/api/calendar-prefs')).body).toEqual({ prefs: [] })
    // resetting what is not set is quiet
    expect(
      (await call('alice', 'DELETE', `/api/calendar-prefs?ref=${encodeURIComponent(REF)}`)).status,
    ).toBe(204)
  })

  it('refuses a bad body, a missing ref and a repeated ref', async () => {
    expect((await call('alice', 'PUT', '/api/calendar-prefs', { ref: 'nope' })).status).toBe(400)
    expect(
      (await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, visible: 'yes' })).status,
    ).toBe(400)
    expect(
      (await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, color: 'red' })).status,
    ).toBe(400)
    expect((await call('alice', 'DELETE', '/api/calendar-prefs')).status).toBe(400)
    expect((await call('alice', 'DELETE', '/api/calendar-prefs?ref=')).status).toBe(400)
    expect((await call('alice', 'DELETE', '/api/calendar-prefs?ref=ics:1&ref=ics:2')).status).toBe(
      400,
    )
  })

  it("keeps a colour of a resource's calendar, which a view cannot name", async () => {
    const saved = await call('alice', 'PUT', '/api/calendar-prefs', {
      ref: 'res:5',
      color: '#b91c1c',
    })
    expect(saved).toMatchObject({ status: 200, body: { ref: 'res:5', color: '#b91c1c' } })
    expect((await call('alice', 'DELETE', '/api/calendar-prefs?ref=res:5')).status).toBe(204)
    for (const ref of ['res:', 'res:0', 'res:x', 'res:5/']) {
      expect(
        (await call('alice', 'PUT', '/api/calendar-prefs', { ref, color: '#b91c1c' })).status,
      ).toBe(400)
    }
    const view = await call('alice', 'POST', '/api/views', {
      name: 'Rooms',
      icon: 'calendar',
      calendars: [{ ref: 'res:5' }],
    })
    expect(view.status).toBe(400)
  })

  it('keeps users apart', async () => {
    await call('alice', 'PUT', '/api/calendar-prefs', { ref: REF, color: '#112233' })
    await call('bob', 'PUT', '/api/calendar-prefs', { ref: REF, visible: false })

    expect((await call('bob', 'GET', '/api/calendar-prefs')).body.prefs).toEqual([
      { ref: REF, color: null, visible: false },
    ])
    await call('bob', 'DELETE', `/api/calendar-prefs?ref=${encodeURIComponent(REF)}`)
    expect((await call('alice', 'GET', '/api/calendar-prefs')).body.prefs).toEqual([
      { ref: REF, color: '#112233', visible: true },
    ])
  })
})
