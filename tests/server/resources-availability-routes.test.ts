// @vitest-environment node
// The three read routes through the real frame: input checks and the answer shapes.
import type { Database } from 'better-sqlite3'
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import availabilityGet from '../../server/api/resources/availability.get'
import requestsGet from '../../server/api/resources/requests.get'
import updatesGet from '../../server/api/resources/updates.get'
import { getUserinfoClient } from '../../server/utils/api/userinfo-service'
import { setDb } from '../../server/utils/db'
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

let db: Database
let handle: (request: Request) => Promise<Response>

beforeEach(() => {
  db = openTestDb()
  setDb(db)
  const router = createRouter()
  router.add('/api/resources/availability', availabilityGet, 'get')
  router.add('/api/resources/requests', requestsGet, 'get')
  router.add('/api/resources/updates', updatesGet, 'get')
  handle = toWebHandler(createApp().use(router))
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ sub: 'sub-alice', groups: [] }))),
  )
  getUserinfoClient().clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  db.close()
})

const call = (path: string, who = 'alice') =>
  handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer test-${who}` } }),
  )

describe('resource read routes', () => {
  it('need a signed-in user', async () => {
    const response = await handle(new Request('http://localhost/api/resources/requests'))
    expect(response.status).toBe(401)
  })

  it('answer availability, never cached', async () => {
    const response = await call(
      '/api/resources/availability?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      from: '2026-12-01T00:00:00.000Z',
      to: '2026-12-02T00:00:00.000Z',
      resources: [],
    })
  })

  it('refuse bad availability input with 400', async () => {
    expect((await call('/api/resources/availability')).status).toBe(400)
    const wide = '/api/resources/availability?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z'
    expect((await call(wide)).status).toBe(400)
    const ids = '?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z&resource=a'
    expect((await call(`/api/resources/availability${ids}`)).status).toBe(400)
  })

  it('answer an empty queue for a user who manages nothing', async () => {
    const response = await call('/api/resources/requests')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ requests: [] })
  })

  it('check since and answer updates', async () => {
    expect((await call('/api/resources/updates')).status).toBe(400)
    expect((await call('/api/resources/updates?since=nope')).status).toBe(400)
    const response = await call('/api/resources/updates?since=2026-11-01T00:00:00Z')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ since: '2026-11-01T00:00:00.000Z', updates: [] })
  })
})
