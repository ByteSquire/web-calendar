// @vitest-environment node
// The admin frame: forged bodies, a lost group, an unreachable or incomplete identity provider all
// give 403 and never reach the handler; every mutation leaves an audit row; the rate limit gives 429.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, readBody, toWebHandler, type H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAuditEntries } from '../../server/db/audit-log'
import { createAdminLimiter } from '../../server/utils/api/admin-limit'
import { defineAdminHandler } from '../../server/utils/api/admin-handler'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
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

vi.mock('../../server/utils/api/config', () => ({
  apiConfig: () => ({
    tokenHashKey: 'test-hash-key',
    oidcIssuer: 'https://idm.test/oauth2/openid/web-calendar',
    adminGroup: 'calendar_admins',
  }),
}))

const reached = vi.fn()

const mutate = defineAdminHandler(async (event, { audit, user }) => {
  reached()
  const body = await readBody<{ name?: string; token?: string }>(event)
  audit('thing.create', `thing:${body?.name ?? ''}`, { name: body?.name, token: body?.token })
  return { ok: true, userKeys: Object.keys(user).sort() }
})

let db: Database
let now = 1_000_000
let handle: (request: Request) => Promise<Response>
let groups: unknown
let userinfoMode: 'ok' | 'down'

function mount(burst = 100) {
  const limiter = createAdminLimiter({ burst, refillPerSec: 1, now: () => now })
  const limited = defineAdminHandler(
    async (_event, { audit }) => {
      audit('ping')
      return { ok: true }
    },
    { limiter },
  )
  const router = createRouter()
  router.add('/api/admin/things', mutate, 'post')
  router.add('/api/admin/ping', limited, 'post')
  handle = toWebHandler(createApp().use(router))
}

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  now = 1_000_000
  groups = ['calendar_admins']
  userinfoMode = 'ok'
  reached.mockClear()
  mount()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (userinfoMode === 'down') throw new TypeError('fetch failed')
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      const name = auth.replace(/^Bearer test-/, '')
      void input
      const claims: Record<string, unknown> = { sub: `sub-${name}` }
      if (groups !== undefined) claims.groups = groups
      return new Response(JSON.stringify(claims), { status: 200 })
    }),
  )
  getUserinfoClient().clear()
  seedUserinfoEndpoint()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  db.close()
})

function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-alice',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
}

describe('the admin guard', () => {
  it('needs a signed-in caller', async () => {
    const response = await handle(
      new Request('http://localhost/api/admin/things', { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(401)
    expect(reached).not.toHaveBeenCalled()
  })

  it('lets a group member through, with no-store and without the stored flag', async () => {
    const response = await post('/api/admin/things', { name: 'a' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      userKeys: ['email', 'id', 'lastSeenAt', 'name', 'sub', 'timeZone', 'username'],
    })
  })

  it('ignores an isAdmin forged in the body', async () => {
    groups = ['staff']
    const response = await post('/api/admin/things', { isAdmin: true, is_admin: 1, admin: true })
    expect(response.status).toBe(403)
    expect(reached).not.toHaveBeenCalled()
    expect(listAuditEntries(db, {})).toEqual([])
  })

  it('ignores the stored is_admin flag once the group is gone', async () => {
    expect((await post('/api/admin/things', { name: 'a' })).status).toBe(200)
    db.prepare('UPDATE users SET is_admin = 1').run()
    groups = []
    getUserinfoClient().clear()
    expect((await post('/api/admin/things', { name: 'b' })).status).toBe(403)
    expect(reached).toHaveBeenCalledTimes(1)
  })

  it('refuses when userinfo is unreachable', async () => {
    userinfoMode = 'down'
    expect((await post('/api/admin/things')).status).toBe(403)
    expect(reached).not.toHaveBeenCalled()
  })

  it('refuses when the answer has no groups claim', async () => {
    groups = undefined
    expect((await post('/api/admin/things')).status).toBe(403)
    expect(reached).not.toHaveBeenCalled()
  })
})

describe('audit()', () => {
  it('writes a row per mutation, as the actor, with redacted details', async () => {
    await post(
      '/api/admin/things',
      { name: 'a', token: 'secret-value' },
      { 'x-request-id': 'req-42' },
    )
    await post('/api/admin/things', { name: 'b' })
    const rows = listAuditEntries(db, {})
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.actor_sub)).toEqual(['sub-alice', 'sub-alice'])
    expect(rows.map((row) => row.target)).toEqual(['thing:b', 'thing:a'])
    expect(rows[1]?.request_id).toBe('req-42')
    expect(rows[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[1]?.details).not.toContain('secret-value')
  })

  it('replaces an unsafe X-Request-Id', async () => {
    await post('/api/admin/ping', {}, { 'x-request-id': 'bad id <script>' })
    expect(listAuditEntries(db, {})[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('the rate limit', () => {
  it('answers 429 with Retry-After once the burst is used, per actor', async () => {
    mount(2)
    expect((await post('/api/admin/ping')).status).toBe(200)
    expect((await post('/api/admin/ping')).status).toBe(200)
    const limited = await post('/api/admin/ping')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('1')
    const other = await post('/api/admin/ping', {}, { authorization: 'Bearer test-bob' })
    expect(other.status).toBe(200)
    now += 1000
    expect((await post('/api/admin/ping')).status).toBe(200)
    expect(listAuditEntries(db, {})).toHaveLength(4)
  })
})
